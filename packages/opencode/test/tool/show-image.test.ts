import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import fs from "node:fs/promises"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { imageDimensions } from "@opencode-ai/core/image/dimensions"
import { Config } from "@/config/config"
import { Image } from "@/image/image"
import { Permission } from "../../src/permission"
import { SessionID, MessageID } from "../../src/session/schema"
import { ShowImageTool } from "../../src/tool/show-image"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import {
  disposeAllInstances,
  provideInstance,
  testInstanceStoreLayer,
  TestInstance,
  tmpdirScoped,
} from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"

const MAX_RAW_BYTES = 20 * 1024 * 1024

afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const layer = (config = TestConfig.layer()) =>
  LayerNode.compile(
    LayerNode.group([Agent.node, FSUtil.node, CrossSpawnSpawner.node, Truncate.node, Image.node]),
    [[Config.node, config]],
  )

const it = testEffect(Layer.mergeAll(layer(), testInstanceStoreLayer))
const tiny = testEffect(
  Layer.mergeAll(
    layer(
      TestConfig.layer({
        get: () => Effect.succeed({ attachment: { image: { max_base64_bytes: 1 } } }),
      }),
    ),
    testInstanceStoreLayer,
  ),
)

const init = Effect.fn("ShowImageToolTest.init")(function* () {
  const info = yield* ShowImageTool
  return yield* info.init()
})

const run = Effect.fn("ShowImageToolTest.run")(function* (
  args: Tool.InferParameters<typeof ShowImageTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const exec = Effect.fn("ShowImageToolTest.exec")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ShowImageTool>,
  next: Tool.Context = ctx,
) {
  return yield* provideInstance(dir)(run(args, next))
})

const failed = Effect.fn("ShowImageToolTest.failed")(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
  const exit = yield* effect.pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected show_image to fail")
})

const fail = Effect.fn("ShowImageToolTest.fail")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ShowImageTool>,
  next: Tool.Context = ctx,
) {
  return yield* failed(exec(dir, args, next))
})

const put = Effect.fn("ShowImageToolTest.put")(function* (p: string, content: string | Uint8Array) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

const full = (p: string) => (process.platform === "win32" ? FSUtil.normalizePath(p) : p)
const glob = (p: string) =>
  process.platform === "win32" ? FSUtil.normalizePathPattern(p) : p.replaceAll("\\", "/")

const asks = () => {
  const items: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    },
  }
}

const fixtures = [
  {
    label: "PNG",
    mime: "image/png",
    file: "image.png",
    data: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
      "base64",
    ),
  },
  {
    label: "JPEG",
    mime: "image/jpeg",
    file: "image.jpg",
    data: Buffer.from(
      "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
      "base64",
    ),
  },
  {
    label: "GIF",
    mime: "image/gif",
    file: "image.gif",
    data: Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
  },
  {
    label: "WEBP",
    mime: "image/webp",
    file: "image.webp",
    data: Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64"),
  },
] as const

function dataBytes(url: string) {
  return new Uint8Array(Buffer.from(url.slice(url.indexOf(";base64,") + ";base64,".length), "base64"))
}

describe("tool.show_image supported formats", () => {
  for (const fixture of fixtures) {
    it.instance(`shows a ${fixture.label} image`, () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const file = path.join(test.directory, fixture.file)
        yield* put(file, fixture.data)

        const result = yield* run({ path: file })

        expect(result.title).toBe(fixture.file)
        expect(result.output).toContain(`Shown to the user: ${fixture.file} (${fixture.label}, 1x1,`)
        expect(result.output).toMatch(/\d+(?:\.\d+)? (?:B|KB|MB)\)\.$/)
        expect(result.attachments).toHaveLength(1)
        expect(result.attachments?.[0]).toMatchObject({
          type: "file",
          mime: fixture.mime,
          filename: fixture.file,
        })
        expect(result.attachments?.[0].url.startsWith(`data:${fixture.mime};base64,`)).toBe(true)
        expect(imageDimensions(dataBytes(result.attachments![0].url))).toEqual({
          mime: fixture.mime,
          width: 1,
          height: 1,
        })
        expect(result.metadata).toMatchObject({
          path: full(file),
          name: fixture.file,
          mime: fixture.mime,
          width: 1,
          height: 1,
          bytes: dataBytes(result.attachments![0].url).length,
          shown: true,
          truncated: false,
        })
        expect(result.metadata.resizedFrom).toBeUndefined()
      }),
    )
  }

  it.instance("passes the caption through to metadata", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "captioned.png")
      yield* put(file, fixtures[0].data)

      const result = yield* run({ path: file, caption: "Rendered page" })

      expect(result.metadata.caption).toBe("Rendered page")
      expect(result.output).not.toContain("Rendered page")
    }),
  )

  it.instance("resizes oversized images and reports the original dimensions", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const test = yield* TestInstance
      const file = path.join(test.directory, "wide.png")
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 2_200 * 10 * 4 }, () => 255)), 2_200, 10)
      const original = Buffer.from(source.get_bytes())
      yield* put(file, original)
      source.free()

      const result = yield* run({ path: file })

      expect(result.metadata.resizedFrom).toEqual({ width: 2_200, height: 10, bytes: original.length })
      expect(result.metadata.width).toBeLessThanOrEqual(2_000)
      expect(result.metadata.height).toBeLessThanOrEqual(2_000)
      const final = imageDimensions(dataBytes(result.attachments![0].url))
      expect(final?.width).toBe(result.metadata.width)
      expect(final?.height).toBe(result.metadata.height)
      expect(result.output).toContain(`(${result.metadata.mime === "image/png" ? "PNG" : "JPEG"}, ${result.metadata.width}x${result.metadata.height},`)
    }),
  )
})

describe("tool.show_image rejections", () => {
  it.instance("rejects unsupported image formats with a conversion hint", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const cases = [
        ["image.svg", new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), "SVG"],
        ["image.bmp", new Uint8Array([0x42, 0x4d, 0x00, 0x00]), "BMP"],
        ["image.tiff", new Uint8Array([0x49, 0x49, 0x2a, 0x00, 0x00]), "TIFF"],
        [
          "image.heic",
          new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00, 0x00]),
          "HEIC",
        ],
        [
          "image.avif",
          new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0x00, 0x00]),
          "HEIC",
        ],
        ["image.bin", new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a]), undefined],
      ] as const

      for (const [name, data, label] of cases) {
        const file = path.join(test.directory, name)
        yield* put(file, data)
        const err = yield* failed(run({ path: file }))

        expect(err.message).toContain("Unsupported image format")
        expect(err.message).toContain("Convert it to PNG, JPEG, GIF or WebP first.")
        if (label) expect(err.message).toContain(label)
      }
    }),
  )

  it.instance("rejects directories", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const dir = path.join(test.directory, "images")
      yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))

      const err = yield* failed(run({ path: dir }))
      expect(err.message).toContain(`Cannot show a directory: ${full(dir)}.`)
      expect(err.message).toContain("Use read to list it")
    }),
  )

  it.instance("rejects missing files", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "missing.png")

      const err = yield* failed(run({ path: file }))
      expect(err.message).toContain(`File not found: ${full(file)}.`)
      expect(err.message).toContain("Check the path, or use glob/read to find it.")
    }),
  )

  it.instance("rejects raw files over the size limit before reading", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const file = path.join(test.directory, "huge.png")
      yield* Effect.promise(async () => {
        const handle = await fs.open(file, "w")
        await handle.truncate(MAX_RAW_BYTES + 1)
        await handle.close()
      })

      const err = yield* failed(run({ path: file }))
      expect(err.message).toContain("over the 20 MB limit")
      expect(err.message).toContain("Resize it below 20 MB")
    }),
  )

  tiny.live("fails explicitly when the normalizer cannot fit the image", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const file = path.join(dir, "tiny-limit.png")
      yield* put(file, fixtures[0].data)

      const err = yield* fail(dir, { path: file })
      expect(err.message).toContain("Could not normalize image tiny-limit.png")
    }),
  )

  it.live("rejects a read pattern denied by agent rules", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const file = path.join(dir, "secret.png")
      yield* put(file, fixtures[0].data)

      const err = yield* provideInstance(dir)(
        Effect.gen(function* () {
          const agent = yield* Agent.Service
          const info = yield* agent.get("build")
          if (!info) throw new Error("build agent not found")
          const ruleset = Permission.merge(info.permission, Permission.fromConfig({ read: { "*.png": "deny" } }))
          const next = {
            ...ctx,
            ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
              Effect.sync(() => {
                for (const pattern of req.patterns) {
                  const rule = Permission.evaluate(req.permission, pattern, ruleset)
                  if (rule.action === "deny") {
                    throw new PermissionV1.DeniedError({ ruleset })
                  }
                }
              }),
          }

          return yield* failed(run({ path: file }, next))
        }),
      )
      expect(err).toBeInstanceOf(PermissionV1.DeniedError)
    }),
  )
})

describe("tool.show_image permissions", () => {
  it.live("asks for external_directory when the image is outside the project", () =>
    Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      const dir = yield* tmpdirScoped({ git: true })
      const file = path.join(outer, "outside.png")
      yield* put(file, fixtures[0].data)

      const { items, next } = asks()
      yield* exec(dir, { path: file }, next)

      const ext = items.find((item) => item.permission === "external_directory")
      expect(ext).toBeDefined()
      expect(ext!.patterns).toContain(glob(path.join(outer, "*")))
    }),
  )

  it.live("does not ask for external_directory inside the project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      const file = path.join(dir, "inside.png")
      yield* put(file, fixtures[0].data)

      const { items, next } = asks()
      yield* exec(dir, { path: file }, next)

      expect(items.find((item) => item.permission === "external_directory")).toBeUndefined()
      const read = items.find((item) => item.permission === "read")
      expect(read).toBeDefined()
      expect(read!.patterns).toEqual([path.join("inside.png")])
    }),
  )

  it.instance("hides show_image when read is fully denied", () =>
    Effect.gen(function* () {
      expect(
        Permission.disabled(["show_image"], [{ permission: "read", pattern: "*", action: "deny" }]).has("show_image"),
      ).toBe(true)
      expect(
        Permission.disabled(["show_image"], [{ permission: "read", pattern: "*.png", action: "deny" }]).has("show_image"),
      ).toBe(false)
    }),
  )
})
