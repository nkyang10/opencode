import { afterEach, describe, expect } from "bun:test"
import { Config, Effect, Layer } from "effect"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { MessageTable, PartTable, SessionMessageTable } from "@opencode-ai/core/session/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { make } from "@opencode-ai/core/image/photon"
import { BrowserImagePreview } from "../../src/server/browser-image-preview"
import { Workspace } from "../../src/control-plane/workspace"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Session } from "@/session/session"
import { MessageID, PartID, type SessionID as SessionIDType } from "../../src/session/schema"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

/**
 * M12a baseline. This is the measurement the plan asked for before anything was built: what a timeline of shown
 * screenshots costs the browser with and without the `imagePreviews=thumbnail` projection, on both protocols, plus the
 * bytes of one `message.part.updated` frame. It is the reference M12f re-measures.
 *
 * Skipped unless `OPENCODE_MEASURE_SHOWN_IMAGE=1` because it generates real frames:
 *
 *     OPENCODE_MEASURE_SHOWN_IMAGE=1 bun test test/server/browser-image-preview-measure.test.ts
 *
 * Frames are synthetic PNGs of screenshot size, three distinct images cycled over twenty tool results; the byte counts
 * are dominated by base64 and the projection is per part, so cycling does not move the numbers. Generation cost itself is
 * measured by `script/bench-shown-image-preview.ts`. Time to first timeline paint needs a built app and a browser and is
 * recorded separately.
 */
const measure = process.env.OPENCODE_MEASURE_SHOWN_IMAGE === "1"
const IMAGES = Number(process.env.OPENCODE_MEASURE_IMAGES ?? 20)
const LIMITS = { autoResize: true, maxWidth: 2_000, maxHeight: 2_000, maxBase64Bytes: 5 * 1024 * 1024 }
const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  LayerNode.group([InstanceStore.node, Project.node, Session.node, Workspace.node, Database.node, Ripgrep.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: false },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

const bytes = (value: string) => Buffer.byteLength(value, "utf8")

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

/** Twenty shown-image tool results, each carrying the full frame and the preview the tool would have attached. */
const buildFrames = async () => {
  const photon = await import("@silvia-odwyer/photon-node")
  const normalize = await Effect.runPromise(make)
  const stills = [1_280, 1_600, 2_048].map((width) => {
    const height = Math.round((width * 9) / 16)
    const rgba = new Uint8Array(width * height * 4)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4
        const blockX = x >> 3
        const blockY = y >> 3
        const jitter = ((blockX * 7 + blockY * 13 + blockX * blockY) % 41) - 20
        const band = Math.floor(y / 48) % 2 === 0 ? 246 : 236
        rgba[offset] = band - Math.floor((x / width) * 12) + jitter
        rgba[offset + 1] = band - Math.floor((y / height) * 18) + jitter
        rgba[offset + 2] = band + 4 + jitter
        rgba[offset + 3] = 255
      }
    }
    const image = new photon.PhotonImage(rgba, width, height)
    const png = Buffer.from(image.get_bytes())
    image.free()
    return png
  })
  const built = await Promise.all(
    stills.map(async (png, index) => {
      const normalized = await Effect.runPromise(
        normalize(
          `shot-${index}.png`,
          {
            uri: `file:///shot-${index}.png`,
            content: png.toString("base64"),
            mime: "image/png",
            encoding: "base64" as const,
          },
          { ...LIMITS, preview: true },
        ),
      )
      if (!("preview" in normalized) || !normalized.preview) throw new Error("fixture produced no preview")
      return {
        uri: `data:${normalized.mime};base64,${normalized.content}`,
        mime: normalized.mime,
        preview: normalized.preview,
      }
    }),
  )
  return Array.from({ length: IMAGES }, (_, index) => built[index % built.length])
}

const createSession = (title: string) => Session.use.create({ title })

const insertV2ToolMessages = (sessionID: SessionIDType, frames: Awaited<ReturnType<typeof buildFrames>>) =>
  Effect.gen(function* () {
    const id = SessionMessage.ID.create()
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionMessageTable)
      .values([
        {
          id,
          session_id: sessionID,
          type: "assistant",
          seq: 1,
          time_created: 1,
          data: {
            time: { created: 1 },
            agent: "build",
            model: {
              id: ModelV2.ID.make("model"),
              providerID: ProviderV2.ID.make("provider"),
              variant: ModelV2.VariantID.make("default"),
            },
            content: frames.map((frame, index) => ({
              type: "tool" as const,
              id: `call-${index}`,
              name: "show-image",
              state: {
                status: "completed" as const,
                input: {},
                content: [
                  { type: "text" as const, text: "Shown to the user." },
                  { type: "file" as const, uri: frame.uri, mime: frame.mime },
                ],
                structured: {
                  preview: {
                    uri: frame.preview.uri,
                    mime: frame.preview.mime,
                    width: frame.preview.width,
                    height: frame.preview.height,
                    bytes: frame.preview.bytes,
                  },
                },
              },
              time: { created: 1 },
            })),
          } as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
        },
      ])
      .run()
      .pipe(Effect.orDie)
    return id
  })

const insertV1ToolParts = (sessionID: SessionIDType, frames: Awaited<ReturnType<typeof buildFrames>>) =>
  Effect.gen(function* () {
    const messageID = MessageID.ascending()
    const { db } = yield* Database.Service
    yield* db
      .insert(MessageTable)
      .values([
        {
          id: messageID,
          session_id: sessionID,
          time_created: 1,
          data: {
            role: "assistant",
            time: { created: 1 },
            parentID: MessageID.ascending(),
            modelID: ModelV2.ID.make("model"),
            providerID: ProviderV2.ID.make("provider"),
            mode: "build",
            agent: "build",
            path: { cwd: "/", root: "/" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          } as NonNullable<(typeof MessageTable.$inferInsert)["data"]>,
        },
      ])
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(PartTable)
      .values(
        frames.map((frame, index) => {
          const partID = PartID.ascending()
          return {
            id: partID,
            message_id: messageID,
            session_id: sessionID,
            time_created: 1,
            data: {
              type: "tool",
              callID: `call-${index}`,
              tool: "show-image",
              state: {
                status: "completed",
                input: {},
                output: "shown",
                title: "",
                metadata: {
                  preview: {
                    uri: frame.preview.uri,
                    mime: frame.preview.mime,
                    width: frame.preview.width,
                    height: frame.preview.height,
                    bytes: frame.preview.bytes,
                  },
                },
                time: { start: 1, end: 2 },
                attachments: [{ id: partID, sessionID, messageID, type: "file", mime: frame.mime, url: frame.uri }],
              },
            } as NonNullable<(typeof PartTable.$inferInsert)["data"]>,
          }
        }),
      )
      .run()
      .pipe(Effect.orDie)
    return messageID
  })

/** One `message.part.updated` frame as the serializer writes it, measured before and after projection. */
function eventFrame(frame: Awaited<ReturnType<typeof buildFrames>>[number], directory: string) {
  const part = {
    id: "part-1",
    sessionID: "ses_measure",
    messageID: "msg_measure",
    type: "tool",
    callID: "call-1",
    tool: "show-image",
    state: {
      status: "completed",
      input: {},
      output: "shown",
      title: "",
      metadata: {
        preview: {
          uri: frame.preview.uri,
          mime: frame.preview.mime,
          width: frame.preview.width,
          height: frame.preview.height,
          bytes: frame.preview.bytes,
        },
      },
      time: { start: 1, end: 2 },
      attachments: [
        {
          id: "part-1",
          sessionID: "ses_measure",
          messageID: "msg_measure",
          type: "file",
          mime: frame.mime,
          url: frame.uri,
        },
      ],
    },
  }
  const envelope = { directory, payload: { type: "message.part.updated", properties: { part } } }
  return { full: JSON.stringify(envelope), preview: JSON.stringify(BrowserImagePreview.previewGlobalEvent(envelope)) }
}

const measurePage = (path: string, headers: Record<string, string>) =>
  Effect.gen(function* () {
    const started = performance.now()
    const response = yield* request(path, { headers })
    const text = yield* response.text
    if (response.status !== 200)
      return yield* Effect.die(new Error(`${path} -> ${response.status} ${text.slice(0, 400)}`))
    return { bytes: bytes(text), ms: performance.now() - started, text }
  })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe.skipIf(!measure)("shown image payload measurement (M12a)", () => {
  it.instance(
    "records message-page and event-frame bytes with and without previews",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const frames = yield* Effect.promise(buildFrames)
        const full = frames.reduce((total, frame) => total + bytes(frame.uri), 0)
        const previews = frames.reduce((total, frame) => total + bytes(frame.preview.uri), 0)
        console.log(
          `fixture frames=${IMAGES} full=${full}B preview=${previews}B ratio=${(full / previews).toFixed(1)}x`,
        )

        const v2 = yield* createSession("v2 measurement")
        yield* insertV2ToolMessages(v2.id, frames)
        const v2Full = yield* measurePage(`/api/session/${v2.id}/message`, headers)
        const v2Preview = yield* measurePage(`/api/session/${v2.id}/message?imagePreviews=thumbnail`, headers)
        expect(v2Full.text.includes(frames[0].uri)).toBe(true)
        expect(v2Preview.text.includes(frames[0].uri)).toBe(false)
        expect(v2Preview.bytes).toBeLessThan(v2Full.bytes)
        console.log(
          `v2 page full=${v2Full.bytes}B (${v2Full.ms.toFixed(1)}ms) preview=${v2Preview.bytes}B (${v2Preview.ms.toFixed(1)}ms) saved=${(((v2Full.bytes - v2Preview.bytes) / v2Full.bytes) * 100).toFixed(1)}%`,
        )

        const v1 = yield* createSession("v1 measurement")
        yield* insertV1ToolParts(v1.id, frames)
        const v1Full = yield* measurePage(`/session/${v1.id}/message`, headers)
        const v1Preview = yield* measurePage(`/session/${v1.id}/message?imagePreviews=thumbnail`, headers)
        expect(v1Full.text.includes(frames[0].uri)).toBe(true)
        expect(v1Preview.text.includes(frames[0].uri)).toBe(false)
        expect(v1Preview.bytes).toBeLessThan(v1Full.bytes)
        console.log(
          `v1 page full=${v1Full.bytes}B (${v1Full.ms.toFixed(1)}ms) preview=${v1Preview.bytes}B (${v1Preview.ms.toFixed(1)}ms) saved=${(((v1Full.bytes - v1Preview.bytes) / v1Full.bytes) * 100).toFixed(1)}%`,
        )

        const frame = eventFrame(frames[0], test.directory)
        expect(frame.preview.length).toBeLessThan(frame.full.length)
        console.log(
          `v1 event frame full=${bytes(frame.full)}B preview=${bytes(frame.preview)}B saved=${(((frame.full.length - frame.preview.length) / frame.full.length) * 100).toFixed(1)}%`,
        )
      }),
    { git: true },
  )
})
