import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { ConfigAttachments } from "@opencode-ai/core/config/attachments"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Image } from "@opencode-ai/core/image"
import { imageDimensions } from "@opencode-ai/core/image/dimensions"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ShowImageTool } from "@opencode-ai/core/tool/show-image"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const MAX_RAW_BYTES = 20 * 1024 * 1024

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

const sessionID = SessionV2.ID.make("ses_show_image_tool_test")
const fixtureDir = await tmpdir()
const directory = await fs.realpath(fixtureDir.path)
const assertions: PermissionV2.AssertInput[] = []
let allow = true
let configEntries: Config.Entry[] = []

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => {
        assertions.push(input)
      }).pipe(Effect.andThen(allow ? Effect.void : Effect.fail(new PermissionV2.BlockedError({ rules: [] })))),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed(configEntries) }))
const imageLayer = AppNodeBuilder.build(Image.node, [[Config.node, config]])
const unavailableImage = Layer.succeed(
  Image.Service,
  Image.Service.of({ normalize: () => Effect.fail(new Image.ResizerUnavailableError()) }),
)
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
)

const suite = (image: Layer.Layer<Image.Service>) =>
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, ShowImageTool.node]), [
    [PermissionV2.node, permission],
    [Image.node, image],
    [Location.node, locationLayer],
    [Global.node, Global.layerWith({ data: path.join(directory, ".data") })],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ])

const it = testEffect(suite(imageLayer))
const itWithoutResizer = testEffect(suite(unavailableImage))

afterAll(() => fixtureDir[Symbol.asyncDispose]())

beforeEach(() => {
  assertions.length = 0
  allow = true
  configEntries = []
})

const call = (input: ShowImageTool.Input, id = "call-show-image") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "show_image", input },
})

const put = (file: string, data: string | Uint8Array) =>
  Effect.promise(() => fs.writeFile(path.join(directory, file), data))

const dataBytes = (url: string) =>
  new Uint8Array(Buffer.from(url.slice(url.indexOf(";base64,") + ";base64,".length), "base64"))

describe("ShowImageTool supported formats", () => {
  for (const fixture of fixtures) {
    it.effect(`shows a ${fixture.label} image`, () =>
      Effect.gen(function* () {
        yield* put(fixture.file, fixture.data)
        const registry = yield* ToolRegistry.Service
        const input = { path: fixture.file }
        const result = yield* executeTool(registry, call(input))

        expect(yield* toolDefinitions(registry)).toMatchObject([{ name: "show_image" }])
        expect(result).toEqual({
          type: "content",
          value: [
            {
              type: "text",
              text: expect.stringMatching(
                new RegExp(`^Shown to the user: ${fixture.file} \\(${fixture.label}, 1x1, \\d+ B\\)\\.$`),
              ),
            },
            {
              type: "file",
              uri: `data:${fixture.mime};base64,${fixture.data.toString("base64")}`,
              mime: fixture.mime,
              name: fixture.file,
            },
          ],
        })

        const settled = yield* settleTool(registry, call(input, `call-settle-${fixture.file}`))
        expect(settled.output?.structured).toEqual({
          path: path.join(directory, fixture.file),
          name: fixture.file,
          mime: fixture.mime,
          width: 1,
          height: 1,
          bytes: fixture.data.length,
          shown: true,
          truncated: false,
        })
        expect(settled.output?.content).toMatchObject([
          { type: "text", text: expect.stringContaining(`Shown to the user: ${fixture.file}`) },
          { type: "file", mime: fixture.mime, name: fixture.file },
        ])
      }),
    )
  }

  it.effect("passes the caption through to metadata without adding it to the output text", () =>
    Effect.gen(function* () {
      yield* put("captioned.png", fixtures[0].data)
      const registry = yield* ToolRegistry.Service
      const settled = yield* settleTool(registry, call({ path: "captioned.png", caption: "Rendered page" }))

      expect(settled.output?.structured).toMatchObject({ caption: "Rendered page" })
      expect(settled.result.type).toBe("content")
      if (settled.result.type !== "content") return
      expect(settled.result.value).toHaveLength(2)
      const text = settled.result.value[0]
      expect(text?.type).toBe("text")
      if (text?.type === "text") expect(text.text).not.toContain("Rendered page")
      expect(settled.result.value[1]).toMatchObject({ type: "file", mime: "image/png", name: "captioned.png" })
    }),
  )
})

describe("ShowImageTool rejections", () => {
  it.effect("rejects unsupported image formats with a conversion hint", () =>
    Effect.gen(function* () {
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

      for (const [file, data, label] of cases) {
        yield* put(file, data)
        const registry = yield* ToolRegistry.Service
        const result = yield* executeTool(registry, call({ path: file }, `call-${file}`))

        expect(result.type).toBe("error")
        if (result.type !== "error") continue
        expect(result.value).toContain("Unsupported image format")
        expect(result.value).toContain("Convert it to PNG, JPEG, GIF or WebP first.")
        if (label) expect(result.value).toContain(label)
      }
    }),
  )

  it.effect("rejects directories", () =>
    Effect.gen(function* () {
      const target = path.join(directory, "images")
      yield* Effect.promise(() => fs.mkdir(target, { recursive: true }))
      const canonical = yield* Effect.promise(() => fs.realpath(target))
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ path: "images" }))).toEqual({
        type: "error",
        value: `Cannot show a directory: ${canonical}. Use read to list it, then show an image file.`,
      })
    }),
  )

  it.effect("rejects missing files", () =>
    Effect.gen(function* () {
      const target = path.join(directory, "missing.png")
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ path: "missing.png" }))).toEqual({
        type: "error",
        value: `File not found: ${target}. Check the path, or use glob/read to find it.`,
      })
    }),
  )

  it.effect("rejects raw files over the size limit before reading", () =>
    Effect.gen(function* () {
      const target = path.join(directory, "huge.png")
      yield* Effect.promise(async () => {
        const handle = await fs.open(target, "w")
        await handle.truncate(MAX_RAW_BYTES + 1)
        await handle.close()
      })
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, call({ path: "huge.png" }))

      expect(result.type).toBe("error")
      if (result.type !== "error") return
      expect(result.value).toContain(`${MAX_RAW_BYTES + 1} bytes`)
      expect(result.value).toContain("over the 20 MB limit")
      expect(result.value).toContain("Resize it below 20 MB")
    }),
  )

  it.effect("fails explicitly when the normalizer cannot fit the image", () =>
    Effect.gen(function* () {
      yield* put("tiny-limit.png", fixtures[0].data)
      configEntries = [
        new Config.Document({
          type: "document",
          info: new Config.Info({
            attachments: new ConfigAttachments.Info({
              image: new ConfigAttachments.Image({ max_base64_bytes: 1 }),
            }),
          }),
        }),
      ]
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, call({ path: "tiny-limit.png" }))

      expect(result.type).toBe("error")
      if (result.type !== "error") return
      expect(result.value).toContain("Could not normalize image tiny-limit.png")
      expect(result.value).toContain("/1 bytes")
    }),
  )

  it.effect("hides show_image when read is fully denied", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service

      expect(yield* toolDefinitions(registry, [{ action: "read", resource: "*", effect: "deny" }])).toEqual([])
      expect(
        yield* toolDefinitions(registry, [{ action: "read", resource: "*.png", effect: "deny" }]),
      ).toMatchObject([{ name: "show_image" }])
    }),
  )
})

describe("ShowImageTool permissions", () => {
  it.effect("asks for external_directory before read for an external path", () =>
    Effect.gen(function* () {
      const outside = yield* Effect.acquireRelease(Effect.promise(() => tmpdir()), (tmp) =>
        Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const external = path.join(outside.path, "outside.png")
      yield* Effect.promise(() => fs.writeFile(external, fixtures[0].data))
      const canonicalDirectory = yield* Effect.promise(() => fs.realpath(outside.path))
      const canonical = path.join(canonicalDirectory, "outside.png")
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ path: external }))).toMatchObject({ type: "content" })
      expect(assertions).toEqual([
        {
          ...LocationMutation.externalDirectoryPermission({
            action: "external_directory",
            directory: canonicalDirectory,
            resource: path.join(canonicalDirectory, "*").replaceAll("\\", "/"),
            save: path.join(canonicalDirectory, "*").replaceAll("\\", "/"),
          }),
          sessionID,
          agent: toolIdentity.agent,
          source: { type: "tool", messageID: toolIdentity.assistantMessageID, callID: "call-show-image" },
        },
        {
          action: "read",
          resources: [canonical.replaceAll("\\", "/")],
          save: ["*"],
          sessionID,
          agent: toolIdentity.agent,
          source: { type: "tool", messageID: toolIdentity.assistantMessageID, callID: "call-show-image" },
        },
      ])
    }),
  )

  it.effect("does not ask for external_directory inside the location", () =>
    Effect.gen(function* () {
      yield* put("inside.png", fixtures[0].data)
      const registry = yield* ToolRegistry.Service

      expect(yield* executeTool(registry, call({ path: "inside.png" }))).toMatchObject({ type: "content" })
      expect(assertions).toMatchObject([
        { sessionID, action: "read", resources: ["inside.png"], save: ["*"] },
      ])
      expect(assertions.some((item) => item.action === "external_directory")).toBe(false)
    }),
  )
})

describe("ShowImageTool normalization", () => {
  itWithoutResizer.effect("returns the original image when the resizer is unavailable", () =>
    Effect.gen(function* () {
      yield* put("fallback.png", fixtures[0].data)
      const registry = yield* ToolRegistry.Service
      const settled = yield* settleTool(registry, call({ path: "fallback.png" }))

      expect(settled.result).toEqual({
        type: "content",
        value: [
          {
            type: "text",
            text: expect.stringContaining("Shown to the user: fallback.png (PNG, 1x1,"),
          },
          {
            type: "file",
            uri: `data:image/png;base64,${fixtures[0].data.toString("base64")}`,
            mime: "image/png",
            name: "fallback.png",
          },
        ],
      })
      expect(settled.output?.structured).toMatchObject({
        mime: "image/png",
        width: 1,
        height: 1,
        bytes: fixtures[0].data.length,
      })
      expect(settled.output?.structured).not.toHaveProperty("resizedFrom")
    }),
  )

  it.effect("resizes oversized images and reports the original dimensions", () =>
    Effect.gen(function* () {
      const photon = yield* Effect.promise(() => import("@silvia-odwyer/photon-node"))
      const source = new photon.PhotonImage(new Uint8Array(Array.from({ length: 2_200 * 10 * 4 }, () => 255)), 2_200, 10)
      const original = Buffer.from(source.get_bytes())
      source.free()
      yield* put("wide.png", original)

      const registry = yield* ToolRegistry.Service
      const settled = yield* settleTool(registry, call({ path: "wide.png" }))
      const metadata = settled.output?.structured as ShowImageTool.Metadata

      expect(metadata.resizedFrom).toEqual({ width: 2_200, height: 10, bytes: original.length })
      expect(metadata.width).toBeLessThanOrEqual(2_000)
      expect(metadata.height).toBeLessThanOrEqual(2_000)
      expect(metadata.bytes).toBeLessThan(original.length)
      expect(settled.result.type).toBe("content")
      if (settled.result.type !== "content") return
      const media = settled.result.value[1]
      expect(media?.type).toBe("file")
      if (media?.type !== "file") return
      const final = imageDimensions(dataBytes(media.uri))
      expect(final?.width).toBe(metadata.width)
      expect(final?.height).toBe(metadata.height)
      expect(final?.mime ?? "").toBe(metadata.mime)
      const text = settled.result.value[0]
      expect(text?.type).toBe("text")
      if (text?.type === "text") {
        expect(text.text).toContain(`${metadata.width}x${metadata.height}`)
        expect(text.text).toMatch(/\((?:PNG|JPEG|GIF|WEBP),/)
      }
    }),
  )
})
