import { afterEach, describe, expect } from "bun:test"
import { Config, Effect, Layer } from "effect"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { MessageTable, PartTable, SessionMessageTable } from "@opencode-ai/core/session/sql"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
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
  { disableListenLog: true, disableLogger: true },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)
const it = testEffect(Layer.mergeAll(appLayer, httpApiLayer))

/** The full frame the tool stored, and the small JPEG the browser was served in its place. */
const FULL = "data:image/png;base64,RkVMTF9mdWxsX2ZyYW1l"
const PREVIEW = "data:image/jpeg;base64,cHJldmlldw"
const CALL = "tool-call-1"
const DESCRIPTION = { mime: "image/jpeg", width: 8, height: 6, bytes: 1024 }

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  if (response.status !== 200) return response.text.pipe(Effect.flatMap((text) => Effect.die(new Error(text))))
  return response.json.pipe(Effect.map((value) => value as T))
}

function requestJson<T>(path: string, init?: RequestInit) {
  return request(path, init).pipe(Effect.flatMap(json<T>))
}

const createSession = (title: string) => Session.use.create({ title })

/**
 * One v2 assistant message holding a completed shown-image tool result. Written straight to the table because producing
 * this through the tool would need a model run, and the route under test only reads it back.
 */
const insertV2ToolMessage = (sessionID: SessionIDType) =>
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
            content: [
              {
                type: "tool",
                id: CALL,
                name: "show-image",
                state: {
                  status: "completed",
                  input: {},
                  content: [
                  // A text item ahead of the image, so the route is exercised on its rule that the index counts file
                  // items rather than raw content positions.
                  { type: "text", text: "Shown to the user." },
                  { type: "file", uri: FULL, mime: "image/png" },
                ],
                  structured: { preview: { ...DESCRIPTION, uri: PREVIEW } },
                },
                time: { created: 1 },
              },
            ],
          } as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
        },
      ])
      .run()
      .pipe(Effect.orDie)
    return id
  })

/** The v1 twin of `insertV2ToolMessage`, where the image is a file attachment on the tool part. */
const insertV1ToolMessage = (sessionID: SessionIDType) =>
  Effect.gen(function* () {
    const messageID = MessageID.ascending()
    const partID = PartID.ascending()
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
      .values([
        {
          id: partID,
          message_id: messageID,
          session_id: sessionID,
          time_created: 1,
          data: {
            type: "tool",
            callID: CALL,
            tool: "show-image",
            state: {
              status: "completed",
              input: {},
              output: "shown",
              title: "",
              metadata: { preview: { ...DESCRIPTION, uri: PREVIEW } },
              time: { start: 1, end: 2 },
              attachments: [{ id: partID, sessionID, messageID, type: "file", mime: "image/png", url: FULL }],
            },
          } as NonNullable<(typeof PartTable.$inferInsert)["data"]>,
        },
      ])
      .run()
      .pipe(Effect.orDie)
    return messageID
  })

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("shown image HttpApi", () => {
  it.instance(
    "serves a v2 client the full image it was previewed for",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession("v2 shown image")
        const messageID = yield* insertV2ToolMessage(session.id)
        const image = `/api/session/${session.id}/message/${messageID}/tool/${CALL}/image`

        const page = yield* requestJson<
          { data: { content: { state: { content: { uri?: string }[]; structured: { preview?: unknown } } }[] }[] }
        >(`/api/session/${session.id}/message?imagePreviews=thumbnail`, { headers })
        expect(page.data[0]?.content[0]?.state.content[1]?.uri).toBe(PREVIEW)
        expect(page.data[0]?.content[0]?.state.structured.preview).toEqual(DESCRIPTION)

        const response = yield* request(`${image}?source=content&index=0`, { headers })
        expect(response.status).toBe(200)
        expect(yield* response.json).toEqual({ uri: FULL, mime: "image/png" })
        expect(response.headers["cache-control"]).toBe("private, immutable")
        expect(response.headers["etag"]).toStartWith("W/")

        expect((yield* request(`${image}?source=content&index=1`, { headers })).status).toBe(404)
        const wrongCall = yield* request(`/api/session/${session.id}/message/${messageID}/tool/other-call/image`, {
          headers,
        })
        expect(wrongCall.status).toBe(404)
      }),
    { git: true },
  )

  it.instance(
    "serves a v1 client the full image it was previewed for",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const headers = { "x-opencode-directory": test.directory }
        const session = yield* createSession("v1 shown image")
        const messageID = yield* insertV1ToolMessage(session.id)
        const image = `/session/${session.id}/message/${messageID}/tool/${CALL}/image`

        const page = yield* requestJson<{ parts: { state: { attachments: { url: string }[] } }[] }[]>(
          `/session/${session.id}/message?imagePreviews=thumbnail`,
          { headers },
        )
        expect(page[0]?.parts[0]?.state.attachments[0]?.url).toBe(PREVIEW)

        const response = yield* request(`${image}?index=0`, { headers })
        expect(response.status).toBe(200)
        expect(yield* response.json).toEqual({ uri: FULL, mime: "image/png" })
        expect(response.headers["cache-control"]).toBe("private, immutable")

        expect((yield* request(`${image}?index=1`, { headers })).status).toBe(404)
      }),
    { git: true },
  )
})
