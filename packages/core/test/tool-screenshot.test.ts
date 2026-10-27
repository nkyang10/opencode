import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Image } from "@opencode-ai/core/image"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ScreenCapture } from "@opencode-ai/core/screen-capture/index"
import { ScreenshotStorage } from "@opencode-ai/core/screen-capture/storage"
import { CaptureError, type CaptureResult, type Input, type ListResult } from "@opencode-ai/core/screen-capture/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ScreenshotTool } from "@opencode-ai/core/tool/screenshot"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { createPng } from "./fixture/png"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_screenshot_tool_test")
const fixtureDir = await tmpdir()
const directory = fixtureDir.path
const screenshots = path.join(directory, ScreenshotStorage.DIRECTORY_NAME)

const assertions: PermissionV2.AssertInput[] = []
const listInputs: Array<Pick<Input, "x_display">> = []
const captureInputs: Input[] = []
let allow = true
let listResult: ListResult = emptyList()
let listError: CaptureError | undefined
let captureResult: CaptureResult = blankResult()
let captureError: CaptureError | undefined

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(allow ? Effect.void : Effect.fail(new PermissionV2.BlockedError({ rules: [] }))),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const unavailableImage = Layer.succeed(
  Image.Service,
  Image.Service.of({ normalize: () => Effect.fail(new Image.ResizerUnavailableError()) }),
)

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
)

const screenCapture = Layer.succeed(
  ScreenCapture.Service,
  ScreenCapture.Service.of({
    list: (input) =>
      Effect.sync(() => listInputs.push(input)).pipe(
        Effect.flatMap(() => (listError ? Effect.fail(listError) : Effect.succeed(listResult))),
      ),
    capture: (input) =>
      Effect.sync(() => captureInputs.push(input)).pipe(
        Effect.flatMap(() => (captureError ? Effect.fail(captureError) : Effect.succeed(captureResult))),
      ),
  }),
)

const suite = AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, ScreenshotTool.node]), [
  [PermissionV2.node, permission],
  [Image.node, unavailableImage],
  [Location.node, locationLayer],
  [Global.node, Global.layerWith({ data: directory })],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  [ScreenCapture.node, screenCapture],
])

const it = testEffect(suite)

afterAll(() => fixtureDir[Symbol.asyncDispose]())

beforeEach(async () => {
  assertions.length = 0
  listInputs.length = 0
  captureInputs.length = 0
  allow = true
  listError = undefined
  captureError = undefined
  listResult = emptyList()
  captureResult = blankResult()
  await fs.rm(screenshots, { recursive: true, force: true })
})

const call = (input: Record<string, unknown>, id = "call-screenshot") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "screenshot", input },
})

describe("ScreenshotTool registration", () => {
  it.effect("registers the screenshot tool and hides it when screenshot is denied", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect(yield* toolDefinitions(registry)).toMatchObject([{ name: "screenshot" }])
      expect(yield* toolDefinitions(registry, [{ action: "screenshot", resource: "*", effect: "deny" }])).toEqual([])
    }),
  )
})

describe("ScreenshotTool list", () => {
  it.effect("returns list output without image content", () =>
    Effect.gen(function* () {
      listResult = {
        text: "Displays:\n  1 (primary) 1920x1080 at 0,0\nWindows, front to back:\n  0x00a Firefox pid 111",
        displays: [{ index: 1, name: "eDP-1", primary: true, bounds: { width: 1920, height: 1080, x: 0, y: 0 } }],
        windows: [{ id: "0x00a", app: "Firefox", pid: 111, title: "Docs", bounds: { width: 1000, height: 600, x: 0, y: 0 }, display: 1, minimized: false }],
        truncated: false,
      }
      const registry = yield* ToolRegistry.Service
      const settled = yield* settleTool(registry, call({ action: "list", x_display: ":7" }))

      expect(settled.result).toEqual({ type: "text", value: listResult.text })
      expect(settled.output?.structured).toMatchObject({ action: "list", shown: false, windows: [{ id: "0x00a" }] })
      expect(listInputs).toEqual([{ x_display: ":7" }])
      expect(assertions).toMatchObject([{ action: "screenshot", resources: ["list"], save: ["*"], metadata: { action: "list" } }])
    }),
  )
})

describe("ScreenshotTool capture", () => {
  it.effect("saves the full-resolution PNG and returns a visible attachment", () =>
    Effect.gen(function* () {
      const data = createPng(2, 1, [
        [255, 0, 0, 255],
        [0, 255, 0, 255],
      ])
      captureResult = {
        data,
        mime: "image/png",
        width: 2,
        height: 1,
        target: "screen",
        display: 1,
        restored: false,
        focusChanged: false,
        backend: "x11",
        platform: "linux",
      }
      const registry = yield* ToolRegistry.Service
      const settled = yield* settleTool(registry, call({ target: "screen", caption: "Desktop" }))

      expect(settled.result.type).toBe("content")
      if (settled.result.type !== "content") return
      expect(settled.result.value).toHaveLength(2)
      expect(settled.result.value[1]).toMatchObject({ type: "file", mime: "image/png" })
      expect(settled.output?.structured).toMatchObject({
        action: "capture",
        mime: "image/png",
        target: "screen",
        width: 2,
        height: 1,
        bytes: data.length,
        backend: "x11",
        platform: "linux",
        caption: "Desktop",
        shown: true,
      })
      expect(listInputs).toEqual([])
      expect(captureInputs[0]).toMatchObject({ action: "capture", target: "screen", display: "primary", restore_minimized: true, delay_ms: 0 })
      expect(assertions).toMatchObject([
        { action: "screenshot", resources: ["screen"], save: ["*"], metadata: { action: "capture", target: "screen", display: "primary" } },
      ])

      const saved = yield* Effect.promise(() =>
        fs.readFile(path.join(screenshots, String((settled.output?.structured as { name?: string })?.name ?? ""))),
      )
      expect(saved.equals(Buffer.from(data))).toBe(true)
    }),
  )

  it.effect("rejects uniform frames without saving a file", () =>
    Effect.gen(function* () {
      captureResult = {
        ...blankResult(),
        data: createPng(3, 2, [128, 128, 128, 255]),
        width: 3,
        height: 2,
      }
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, call({ target: "screen" }))

      expect(result.type).toBe("error")
      if (result.type !== "error") return
      expect(result.value).toContain("blank_capture")
      expect(result.value).toContain("uniform frame")
      const saved = yield* Effect.promise(() => fs.readdir(screenshots).catch(() => []))
      expect(saved).toEqual([])
    }),
  )

  it.effect("validates the delay before asking permission", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, call({ target: "screen", delay_ms: 10001 }))

      expect(result).toEqual({ type: "error", value: "delay_ms must be an integer between 0 and 10000." })
      expect(assertions).toEqual([])
    }),
  )
})

describe("ScreenshotTool windows", () => {
  it.effect("requires a selector before asking permission", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, call({ target: "window" }))

      expect(result).toEqual({
        type: "error",
        value: "window_not_found: target window requires a window id, app name, or title substring.",
      })
      expect(assertions).toEqual([])
      expect(captureInputs).toEqual([])
    }),
  )

  it.effect("passes window_not_found candidates through as a tool failure", () =>
    Effect.gen(function* () {
      captureError = new CaptureError({
        code: "window_not_found",
        reason: "no window matched ghost",
        candidates: ["0x001 Firefox pid 111 \"Firefox\"", "0x002 Terminal"],
      })
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, call({ target: "window", window: "ghost" }))

      expect(result.type).toBe("error")
      if (result.type !== "error") return
      expect(result.value).toContain("window_not_found")
      expect(result.value).toContain('0x001 Firefox pid 111 "Firefox"')
      expect(captureInputs[0]?.window).toBe("ghost")
    }),
  )
})

function emptyList(): ListResult {
  return { text: "Displays:\n  none\nWindows, front to back:\n  none", displays: [], windows: [], truncated: false }
}

function blankResult(): CaptureResult {
  const data = createPng(2, 1, [20, 20, 20, 255])
  return {
    data,
    mime: "image/png",
    width: 2,
    height: 1,
    target: "screen",
    restored: false,
    focusChanged: false,
    backend: "x11",
    platform: "linux",
  }
}
