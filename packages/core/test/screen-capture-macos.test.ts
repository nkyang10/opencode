import { describe, expect, test } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import { ScreenCaptureMacos } from "@opencode-ai/core/screen-capture/macos"
import { CaptureError, type Input, type MacOSBackend } from "@opencode-ai/core/screen-capture/schema"
import { createPng } from "./fixture/png"

const OSASCRIPT = "/usr/bin/osascript"
const SCREENCAPTURE = "/usr/sbin/screencapture"

const backend: MacOSBackend = {
  kind: "macos",
  osascript: OSASCRIPT,
  screencapture: SCREENCAPTURE,
}

const input = (overrides: Partial<Input> = {}): Input => ({
  action: "capture",
  target: "screen",
  display: "primary",
  restore_minimized: true,
  delay_ms: 0,
  ...overrides,
})

const PNG = createPng(2, 1, [
  [255, 0, 0, 255],
  [0, 255, 0, 255],
])
const BLANK_PNG = createPng(2, 1, [255, 0, 0, 255])

const LIST = {
  displays: [
    {
      index: 1,
      name: "Built-in Retina",
      primary: true,
      bounds: { width: 1920, height: 1080, x: 0, y: 0 },
      scale: 2,
    },
    {
      index: 2,
      name: "LG UltraFine",
      primary: false,
      bounds: { width: 1200, height: 800, x: 1920, y: 100 },
      scale: 1,
    },
  ],
  windows: [
    {
      id: "0x10",
      app: "firefox",
      pid: 101,
      title: "Alpha Project",
      bounds: { width: 1000, height: 600, x: 100, y: 100 },
      display: 1,
      minimized: false,
    },
    {
      id: "0x20",
      app: "terminal",
      pid: 102,
      title: "Terminal",
      bounds: { width: 800, height: 600, x: 2000, y: 200 },
      display: 2,
      minimized: false,
    },
    {
      id: "0x30",
      app: "Code",
      pid: 103,
      title: "Beta Project",
      bounds: { width: 700, height: 500, x: 300, y: 200 },
      display: 1,
      minimized: false,
    },
  ],
}

type RawRecord = Record<string, unknown>
type Call = {
  readonly command: string
  readonly args: readonly string[]
  readonly stdin?: string
  readonly path?: string
}
type Response = {
  readonly stdout?: Buffer
  readonly stderr?: Buffer
  readonly exitCode?: number
  readonly file?: Buffer
}

const jsonResponse = (value: unknown): Response => ({ stdout: Buffer.from(JSON.stringify(value), "utf8") })
const jxaError = (value: unknown): Response => ({
  stdout: Buffer.alloc(0),
  stderr: Buffer.from(`Execution error: Error: ${JSON.stringify(value)}`, "utf8"),
  exitCode: 1,
})

const fakeProcess = (
  calls: Call[],
  respondJxa: (request: RawRecord) => Response,
  respondScreencapture: (index: number) => Response,
) => {
  let screenCount = 0
  return AppProcess.Service.of({
    run: (command: ChildProcess.Command, options?: AppProcess.RunOptions) =>
      Effect.sync(() => {
        if (command._tag !== "StandardCommand") throw new Error("unexpected command tag " + command._tag)
        if (options?.stdin !== undefined) {
          const stdin = Buffer.from(options.stdin as Uint8Array).toString("utf8")
          calls.push({ command: command.command, args: command.args, stdin })
          return processResult(command.command, command.args, respondJxa(JSON.parse(stdin) as RawRecord))
        }

        const path = command.args.at(-1)!
        const response = respondScreencapture(screenCount)
        screenCount += 1
        if ((response.exitCode ?? 0) === 0 && response.file) writeFileSync(path, response.file)
        calls.push({ command: command.command, args: command.args, path })
        return processResult(command.command, command.args, response)
      }),
  } as unknown as AppProcess.Interface)
}

function processResult(command: string, args: readonly string[], response: Response) {
  const stdout = response.stdout ?? Buffer.alloc(0)
  return {
    command,
    args,
    exitCode: response.exitCode ?? 0,
    output: stdout,
    stdout,
    stderr: response.stderr ?? Buffer.alloc(0),
    outputTruncated: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  }
}

function record(value: string): RawRecord {
  const parsed = JSON.parse(value) as unknown
  expect(parsed).toBeObject()
  return parsed as RawRecord
}

function listWithMinimizedFirst(): RawRecord {
  return { ...LIST, windows: [{ ...LIST.windows[0]!, minimized: true }, ...LIST.windows.slice(1)] }
}

function jxaResponses(request: RawRecord): Response {
  if (request.operation === "list") return jsonResponse(LIST)
  if (request.operation === "restore") return jsonResponse({ ok: true, focusChanged: false })
  return jsonResponse({})
}

describe("ScreenCapture macOS backend", () => {
  test("invokes osascript with the embedded JXA script and lists displays and windows", async () => {
    const calls: Call[] = []
    const result = await Effect.runPromise(
      ScreenCaptureMacos.list(fakeProcess(calls, jxaResponses, () => ({ file: PNG })), backend),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBe(OSASCRIPT)
    expect(calls[0]?.args).toEqual(ScreenCaptureMacos.osascriptArgs())

    const payload = record(calls[0]?.stdin ?? "")
    expect(payload).toMatchObject({ operation: "list" })
    expect(Buffer.from(String(payload.script), "base64").toString("utf8")).toContain("CGWindowListCopyWindowInfo")

    expect(result.displays.map((display) => display.name)).toEqual(["Built-in Retina", "LG UltraFine"])
    expect(result.windows.map((window) => window.id)).toEqual(["0x10", "0x20", "0x30"])
    expect(result.text).toContain("1 (primary) 1920x1080 at 0,0 scale 2")
    expect(result.text).toContain('0x10  firefox  pid 101  "Alpha Project"  1000x600  display 1')
  })

  test("captures the primary display through screencapture and cleans up the temp file", async () => {
    const calls: Call[] = []
    const result = await Effect.runPromise(
      ScreenCaptureMacos.capture(
        fakeProcess(calls, jxaResponses, () => ({ file: PNG })),
        backend,
        input(),
      ),
    )

    expect(result).toMatchObject({
      mime: "image/png",
      width: 2,
      height: 1,
      target: "screen",
      display: 1,
      backend: "macos",
      platform: "darwin",
      restored: false,
      focusChanged: false,
    })
    expect(calls.map((call) => call.command)).toEqual([OSASCRIPT, SCREENCAPTURE])
    expect(calls[1]?.args).toEqual(["-x", "-D", "1", "-t", "png", calls[1]!.path!])
    expect(existsSync(calls[1]!.path!)).toBe(false)
  })

  test("captures a numbered display and all displays through one screencapture command", async () => {
    const numbered: Call[] = []
    const numberedResult = await Effect.runPromise(
      ScreenCaptureMacos.capture(fakeProcess(numbered, jxaResponses, () => ({ file: PNG })), backend, input({ display: 2 })),
    )
    expect(numberedResult).toMatchObject({ display: 2 })
    expect(numbered[1]?.args).toEqual(["-x", "-D", "2", "-t", "png", numbered[1]!.path!])

    const all: Call[] = []
    const allResult = await Effect.runPromise(
      ScreenCaptureMacos.capture(fakeProcess(all, jxaResponses, () => ({ file: PNG })), backend, input({ display: "all" })),
    )
    expect(allResult).toMatchObject({ display: "all" })
    expect(all[1]?.args).toEqual(["-x", "-R", "0,0,3120,1080", "-t", "png", all[1]!.path!])
  })

  test("selects windows by id, app, title, and reports other matches", async () => {
    const cases = [
      { selector: "0x10", id: "0x10" },
      { selector: "Firefox", id: "0x10" },
      { selector: "terminal", id: "0x20" },
      { selector: "Project", id: "0x10" },
    ] as const

    for (const testCase of cases) {
      const calls: Call[] = []
      const result = await Effect.runPromise(
        ScreenCaptureMacos.capture(
          fakeProcess(calls, jxaResponses, () => ({ file: PNG })),
          backend,
          input({ target: "window", window: testCase.selector }),
        ),
      )

      expect(result.window?.id).toBe(testCase.id)
      expect(calls.map((call) => call.command)).toEqual([OSASCRIPT, SCREENCAPTURE])
      expect(calls[1]?.args).toEqual([
        "-x",
        "-o",
        "-l",
        ScreenCaptureMacos.decimalWindowId(testCase.id),
        "-t",
        "png",
        calls[1]!.path!,
      ])
    }
  })

  test("reports other matches when a window selector is ambiguous", async () => {
    const calls: Call[] = []
    const result = await Effect.runPromise(
      ScreenCaptureMacos.capture(
        fakeProcess(calls, jxaResponses, () => ({ file: PNG })),
        backend,
        input({ target: "window", window: "Project" }),
      ),
    )

    expect(result.window?.id).toBe("0x10")
    expect(result.others).toEqual(['0x30 Code pid 103 "Beta Project"'])
  })

  test("fails before invoking screencapture when a minimized window cannot be restored", async () => {
    const calls: Call[] = []
    const error = await Effect.runPromise(
      ScreenCaptureMacos.capture(
        fakeProcess(
          calls,
          (request) => (request.operation === "list" ? jsonResponse(listWithMinimizedFirst()) : jsonResponse({ ok: true })),
          () => ({ file: PNG }),
        ),
        backend,
        input({ target: "window", window: "0x10", restore_minimized: false }),
      ).pipe(Effect.catch((failure) => Effect.succeed(failure))),
    )

    expect(error).toBeInstanceOf(CaptureError)
    if (!(error instanceof CaptureError)) return
    expect(error.code).toBe("window_not_capturable")
    expect(calls).toHaveLength(1)
  })

  test("restores a blank minimized window, captures it, and re-minimizes it", async () => {
    const calls: Call[] = []
    const screens = [BLANK_PNG, PNG]
    const result = await Effect.runPromise(
      ScreenCaptureMacos.capture(
        fakeProcess(
          calls,
          (request) => {
            if (request.operation === "list") return jsonResponse(listWithMinimizedFirst())
            if (request.operation === "restore") return jsonResponse({ ok: true, focusChanged: false })
            return jsonResponse({})
          },
          (index) => ({ file: screens[index] ?? PNG }),
        ),
        backend,
        input({ target: "window", window: "0x10" }),
      ),
    )

    expect(result.restored).toBe(true)
    expect(result.window?.id).toBe("0x10")
    const restores = calls
      .filter((call) => call.command === OSASCRIPT)
      .map((call) => record(call.stdin ?? ""))
      .filter((payload) => payload.operation === "restore")
    expect(restores.map((payload) => payload.minimized)).toEqual([false, true])
    expect(restores[0]).toMatchObject({ id: "0x10" })
    expect(calls.filter((call) => call.command === SCREENCAPTURE)).toHaveLength(2)
  })

  test("reports permission_required when restoring a minimized window lacks Accessibility", async () => {
    const calls: Call[] = []
    const error = await Effect.runPromise(
      ScreenCaptureMacos.capture(
        fakeProcess(
          calls,
          (request) => {
            if (request.operation === "list") return jsonResponse(listWithMinimizedFirst())
            return jxaError({
              code: "permission_required",
              reason: "macOS Accessibility permission is required to restore a minimized window.",
            })
          },
          () => ({ file: BLANK_PNG }),
        ),
        backend,
        input({ target: "window", window: "0x10" }),
      ).pipe(Effect.catch((failure) => Effect.succeed(failure))),
    )

    expect(error).toBeInstanceOf(CaptureError)
    if (!(error instanceof CaptureError)) return
    expect(error.code).toBe("permission_required")
    expect(calls.filter((call) => call.command === SCREENCAPTURE)).toHaveLength(1)
    expect(
      calls
        .filter((call) => call.command === OSASCRIPT)
        .map((call) => record(call.stdin ?? ""))
        .filter((payload) => payload.operation === "restore"),
    ).toHaveLength(1)
  })

  test("maps embedded osascript JSON errors to CaptureError codes", async () => {
    const calls: Call[] = []
    const error = await Effect.runPromise(
      ScreenCaptureMacos.list(
        fakeProcess(
          calls,
          () =>
            jxaError({
              code: "permission_required",
              reason: "macOS Screen Recording permission is required for screenshot capture.",
            }),
          () => ({ file: PNG }),
        ),
        backend,
      ).pipe(Effect.catch((failure) => Effect.succeed(failure))),
    )

    expect(error).toBeInstanceOf(CaptureError)
    if (!(error instanceof CaptureError)) return
    expect(error.code).toBe("permission_required")
    expect(error.reason).toContain("Screen Recording permission")
  })

  test("maps screencapture no-display failures to no_interactive_session", async () => {
    const calls: Call[] = []
    const error = await Effect.runPromise(
      ScreenCaptureMacos.capture(
        fakeProcess(calls, jxaResponses, () => ({
          exitCode: 1,
          stderr: Buffer.from("could not create image from display", "utf8"),
        })),
        backend,
        input(),
      ).pipe(Effect.catch((failure) => Effect.succeed(failure))),
    )

    expect(error).toBeInstanceOf(CaptureError)
    if (!(error instanceof CaptureError)) return
    expect(error.code).toBe("no_interactive_session")
  })

  test("fails unsupported when screencapture writes an empty file", async () => {
    const calls: Call[] = []
    const error = await Effect.runPromise(
      ScreenCaptureMacos.capture(fakeProcess(calls, jxaResponses, () => ({ file: Buffer.alloc(0) })), backend, input()).pipe(
        Effect.catch((failure) => Effect.succeed(failure)),
      ),
    )

    expect(error).toBeInstanceOf(CaptureError)
    if (!(error instanceof CaptureError)) return
    expect(error.code).toBe("unsupported")
    expect(error.reason).toContain("no image data")
  })
})
