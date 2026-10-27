import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { afterEach, beforeEach, describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ScreenCapture } from "@opencode-ai/core/screen-capture/index"
import { ScreenshotStorage } from "@opencode-ai/core/screen-capture/storage"
import {
  CaptureError,
  type CaptureResult,
  type Input,
  type ListResult,
} from "@opencode-ai/core/screen-capture/schema"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Config } from "@/config/config"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Image } from "@/image/image"
import { MessageID, SessionID } from "../../src/session/schema"
import { ScreenshotTool } from "../../src/tool/screenshot"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import {
  disposeAllInstances,
  provideInstance,
  testInstanceStoreLayer,
  TestInstance,
} from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { createPng } from "../../../core/test/fixture/png"

afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_screenshot_test"),
  messageID: MessageID.make("msg_screenshot_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const asks: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
const listInputs: Array<Pick<Input, "x_display">> = []
const captureInputs: Input[] = []
const writeInputs: Array<{ data: Uint8Array; slug: string }> = []
let listResult: ListResult = emptyList()
let listError: CaptureError | undefined
let captureResult: CaptureResult = nonBlankResult()
let captureError: CaptureError | undefined

const screenCapture = Layer.succeed(
  ScreenCapture.Service,
  ScreenCapture.Service.of({
    available: () => Effect.succeed(true),
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

const storage = Layer.succeed(
  ScreenshotStorage.Service,
  ScreenshotStorage.Service.of({
    write: (input) =>
      Effect.sync(() => {
        writeInputs.push({ data: input.data, slug: input.slug })
        return { path: `/screenshots/${input.slug}.png`, name: `${input.slug}.png`, bytes: input.data.byteLength }
      }),
    cleanup: () => Effect.void,
  }),
)

const layer = LayerNode.compile(
  LayerNode.group([
    Agent.node,
    FSUtil.node,
    CrossSpawnSpawner.node,
    Truncate.node,
    Image.node,
    ScreenCapture.node,
    ScreenshotStorage.node,
  ]),
  [
    [Config.node, TestConfig.layer()],
    [ScreenCapture.node, screenCapture],
    [ScreenshotStorage.node, storage],
  ],
)

const it = testEffect(Layer.mergeAll(layer, testInstanceStoreLayer))

beforeEach(() => {
  asks.length = 0
  listInputs.length = 0
  captureInputs.length = 0
  writeInputs.length = 0
  listError = undefined
  captureError = undefined
  listResult = emptyList()
  captureResult = nonBlankResult()
})

const init = Effect.fn("ScreenshotToolTest.init")(function* () {
  const info = yield* ScreenshotTool
  return yield* Tool.init(info)
})

const run = Effect.fn("ScreenshotToolTest.run")(function* (
  args: Record<string, unknown>,
  next: Tool.Context = { ...ctx, ask: askRecorder() },
) {
  const tool = yield* init()
  return yield* tool.execute(args as never, next)
})

const exec = Effect.fn("ScreenshotToolTest.exec")(function* (
  args: Record<string, unknown>,
  next: Tool.Context = { ...ctx, ask: askRecorder() },
) {
  const test = yield* TestInstance
  return yield* provideInstance(test.directory)(run(args, next))
})

const failed = Effect.fn("ScreenshotToolTest.failed")(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
  const exit = yield* effect.pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected screenshot to fail")
})

const fail = Effect.fn("ScreenshotToolTest.fail")(function* (args: Record<string, unknown>) {
  return yield* failed(exec(args))
})

describe("tool.screenshot list", () => {
  it.instance("returns display and window text without attachments", () =>
    Effect.gen(function* () {
      listResult = {
        text: "Displays:\n  1 (primary) 1920x1080 at 0,0\nWindows, front to back:\n  0x00a Firefox pid 111",
        displays: [{ index: 1, name: "eDP-1", primary: true, bounds: { width: 1920, height: 1080, x: 0, y: 0 } }],
        windows: [
          {
            id: "0x00a",
            app: "Firefox",
            pid: 111,
            title: "Docs",
            bounds: { width: 1000, height: 600, x: 0, y: 0 },
            display: 1,
            minimized: false,
          },
        ],
        truncated: false,
      }

      const result = yield* exec({ action: "list", x_display: ":7" })

      expect(result.title).toBe("Displays and windows")
      expect(result.output).toBe(listResult.text)
      expect(result.attachments).toBeUndefined()
      expect(result.metadata).toMatchObject({ action: "list", shown: false, windows: [{ id: "0x00a" }] })
      expect(listInputs).toEqual([{ x_display: ":7" }])
      expect(asks).toMatchObject([{ permission: "screenshot", patterns: ["list"], always: ["*"] }])
    }),
  )
})

describe("tool.screenshot capture", () => {
  it.instance("stores the PNG and returns a visible attachment", () =>
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

      const result = yield* exec({ target: "screen", caption: "Desktop" })

      expect(result.attachments).toHaveLength(1)
      expect(result.attachments?.[0]).toMatchObject({ type: "file", mime: "image/png", filename: "screen-primary.png" })
      expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
      expect(result.metadata).toMatchObject({
        action: "capture",
        mime: "image/png",
        target: "screen",
        width: 2,
        height: 1,
        savedBytes: data.byteLength,
        backend: "x11",
        platform: "linux",
        caption: "Desktop",
        shown: true,
      })
      expect(captureInputs[0]).toMatchObject({
        action: "capture",
        target: "screen",
        display: "primary",
        restore_minimized: true,
        delay_ms: 0,
      })
      expect(writeInputs[0]?.slug).toBe("screen-primary")
      expect(Buffer.from(writeInputs[0]?.data ?? []).equals(data)).toBe(true)
      expect(asks).toMatchObject([{ permission: "screenshot", patterns: ["screen"], always: ["*"] }])
    }),
  )

  it.instance("uses a window resource and passes the selector through", () =>
    Effect.gen(function* () {
      captureResult = {
        ...captureResult,
        target: "window",
        window: { id: "0x00a", app: "firefox" },
      }

      const result = yield* exec({ target: "window", window: "Firefox" })

      expect(result.metadata).toMatchObject({
        action: "capture",
        target: "window",
        window: { id: "0x00a", app: "firefox" },
      })
      expect(ScreenshotStorage.slug(writeInputs[0]?.slug ?? "")).toBe("window-firefox")
      expect(captureInputs[0]).toMatchObject({ target: "window", window: "Firefox" })
      expect(asks).toMatchObject([{ permission: "screenshot", patterns: ["window:firefox"] }])
    }),
  )
})

describe("tool.screenshot failures", () => {
  it.instance("rejects uniform frames before saving", () =>
    Effect.gen(function* () {
      captureResult = {
        ...captureResult,
        data: createPng(3, 2, [128, 128, 128, 255]),
        width: 3,
        height: 2,
      }

      const error = yield* fail({ target: "screen" })

      expect(error.message).toContain("blank_capture")
      expect(error.message).toContain("uniform frame")
      expect(writeInputs).toEqual([])
    }),
  )

  it.instance("requires a window selector before asking permission", () =>
    Effect.gen(function* () {
      const error = yield* fail({ target: "window" })

      expect(error.message).toBe(
        "window_not_found: target window requires a window id, app name, or title substring.",
      )
      expect(asks).toEqual([])
      expect(captureInputs).toEqual([])
    }),
  )

  it.instance("validates delay before asking permission", () =>
    Effect.gen(function* () {
      const error = yield* fail({ target: "screen", delay_ms: 10001 })

      expect(error.message).toBe("delay_ms must be an integer between 0 and 10000.")
      expect(asks).toEqual([])
    }),
  )

  it.instance("passes capture error candidates through", () =>
    Effect.gen(function* () {
      captureError = new CaptureError({
        code: "window_not_found",
        reason: "no window matched ghost",
        candidates: ['0x001 Firefox pid 111 "Firefox"', "0x002 Terminal"],
      })

      const error = yield* fail({ target: "window", window: "ghost" })

      expect(error.message).toContain("window_not_found")
      expect(error.message).toContain('0x001 Firefox pid 111 "Firefox"')
      expect(captureInputs[0]?.window).toBe("ghost")
    }),
  )
})

function askRecorder() {
  return (request: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
    Effect.sync(() => {
      asks.push(request)
    })
}

function emptyList(): ListResult {
  return { text: "Displays:\n  none\nWindows, front to back:\n  none", displays: [], windows: [], truncated: false }
}

function nonBlankResult(): CaptureResult {
  return {
    data: createPng(2, 1, [
      [255, 0, 0, 255],
      [0, 255, 0, 255],
    ]),
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
