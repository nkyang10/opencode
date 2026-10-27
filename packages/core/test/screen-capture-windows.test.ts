import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import { ScreenCaptureWindows } from "@opencode-ai/core/screen-capture/windows"
import { ScreenCaptureWsl } from "@opencode-ai/core/screen-capture/wsl"
import { CaptureError, type Input, type WindowsBackend } from "@opencode-ai/core/screen-capture/schema"
import { createPng } from "./fixture/png"

const NATIVE_PROGRAM = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const WSL_PROGRAM = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"

const backend = (transport: "native" | "wsl" = "native"): WindowsBackend => ({
  kind: "windows",
  transport,
  program: transport === "wsl" ? WSL_PROGRAM : NATIVE_PROGRAM,
  ...(transport === "wsl" ? { wslpath: "/usr/bin/wslpath" } : {}),
})

const input = (overrides: Partial<Input> = {}): Input => ({
  action: "capture",
  target: "screen",
  display: "primary",
  restore_minimized: true,
  delay_ms: 0,
  ...overrides,
})

const PNG_BASE64 = createPng(2, 1, [
  [255, 0, 0, 255],
  [0, 255, 0, 255],
]).toString("base64")

const LIST = {
  displays: [
    { index: 1, name: "DISPLAY1", primary: true, bounds: { width: 1920, height: 1080, x: 0, y: 0 } },
    { index: 2, name: "DISPLAY2", primary: false, bounds: { width: 1200, height: 800, x: 1920, y: 0 } },
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
      currentDesktop: true,
    },
    {
      id: "0x20",
      app: "terminal",
      pid: 102,
      title: "Terminal",
      bounds: { width: 800, height: 600, x: 2000, y: 100 },
      display: 2,
      minimized: false,
      currentDesktop: true,
    },
    {
      id: "0x30",
      app: "Code",
      pid: 103,
      title: "Beta Project",
      bounds: { width: 700, height: 500, x: 300, y: 200 },
      display: 1,
      minimized: false,
      currentDesktop: true,
    },
  ],
  active: "0x20",
}

type Call = { readonly command: string; readonly args: readonly string[]; readonly stdin: string }
type Response = { stdout: Buffer; stderr?: Buffer; exitCode?: number }
type RawRecord = Record<string, unknown>

const jsonResponse = (value: unknown): Response => ({ stdout: Buffer.from(JSON.stringify(value), "utf8") })
const errorResponse = (value: unknown): Response => ({
  stdout: Buffer.alloc(0),
  stderr: Buffer.from(JSON.stringify(value), "utf8"),
  exitCode: 1,
})

const fakeProcess = (calls: Call[], respond: (request: unknown) => Response) =>
  AppProcess.Service.of({
    run: (command: ChildProcess.Command, options?: AppProcess.RunOptions) =>
      Effect.sync(() => {
        if (command._tag !== "StandardCommand") throw new Error("unexpected command tag " + command._tag)
        const stdin = Buffer.from(options?.stdin as Uint8Array).toString("utf8")
        calls.push({ command: command.command, args: command.args, stdin })
        const response = respond(JSON.parse(stdin))
        return processResult(command.command, command.args, response)
      }),
  } as unknown as AppProcess.Interface)

function processResult(command: string, args: readonly string[], response: Response) {
  const stdout = response.stdout
  const stderr = response.stderr ?? Buffer.alloc(0)
  return {
    command,
    args,
    exitCode: response.exitCode ?? 0,
    output: stdout,
    stdout,
    stderr,
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

describe("ScreenCapture Windows backend", () => {
  test("runs powershell through an encoded command and sends the PowerShell source as stdin JSON", async () => {
    const calls: Call[] = []
    await Effect.runPromise(ScreenCaptureWindows.list(fakeProcess(calls, () => jsonResponse(LIST)), backend()))

    expect(calls[0]?.command).toBe(NATIVE_PROGRAM)
    expect(calls[0]?.args).toEqual(ScreenCaptureWindows.powershellArgs())
    expect(calls[0]?.args).toContain("-EncodedCommand")

    const payload = record(calls[0]?.stdin ?? "")
    expect(payload).toMatchObject({ operation: "list" })
    expect(Buffer.from(String(payload.script), "base64").toString("utf8")).toContain("OpenCodeScreenCapture")
  })

  test("lists displays and front-to-back windows", async () => {
    const calls: Call[] = []
    const result = await Effect.runPromise(
      ScreenCaptureWindows.list(
        fakeProcess(calls, () => jsonResponse(LIST)),
        backend(),
      ),
    )

    expect(result.displays.map((display) => display.name)).toEqual(["DISPLAY1", "DISPLAY2"])
    expect(result.windows.map((window) => window.id)).toEqual(["0x20", "0x10", "0x30"])
    expect(result.windows[0]).toMatchObject({ app: "terminal", pid: 102, title: "Terminal", display: 2 })
    expect(result.text).toContain("0x20  terminal  pid 102")
  })

  test("captures the selected screen display through PowerShell", async () => {
    const calls: Call[] = []
    const result = await Effect.runPromise(
      ScreenCaptureWindows.capture(
        fakeProcess(calls, () => jsonResponse({ data: PNG_BASE64, target: "screen", display: 1 })),
        backend(),
        input({ display: 2 }),
      ),
    )

    expect(result).toMatchObject({
      mime: "image/png",
      width: 2,
      height: 1,
      target: "screen",
      display: 1,
      backend: "windows",
      platform: "win32",
      restored: false,
      focusChanged: false,
    })
    expect(record(calls[0]?.stdin ?? "")).toMatchObject({ operation: "capture", target: "screen", display: 2 })
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
        ScreenCaptureWindows.capture(
          fakeProcess(calls, (request) => {
            const payload = request as RawRecord
            if (payload.operation === "list") return jsonResponse(LIST)
            return jsonResponse({
              data: PNG_BASE64,
              target: "window",
              display: 1,
              window: LIST.windows.find((window) => window.id === testCase.id),
              restored: false,
              focusChanged: false,
            })
          }),
          backend(),
          input({ target: "window", window: testCase.selector }),
        ),
      )

      expect(result.window?.id).toBe(testCase.id)
      expect(calls).toHaveLength(2)
      expect(record(calls[1]?.stdin ?? "")).toMatchObject({ operation: "capture", target: "window", id: testCase.id })
    }
  })

  test("reports other matches when a window selector is ambiguous", async () => {
    const calls: Call[] = []
    const result = await Effect.runPromise(
      ScreenCaptureWindows.capture(
        fakeProcess(calls, (request) => {
          const payload = request as RawRecord
          if (payload.operation === "list") return jsonResponse(LIST)
          return jsonResponse({ data: PNG_BASE64, target: "window", window: LIST.windows[0], display: 1 })
        }),
        backend(),
        input({ target: "window", window: "Project" }),
      ),
    )

    expect(result.window?.id).toBe("0x10")
    expect(result.others).toEqual(['0x30 Code pid 103 "Beta Project"'])
  })

  test("fails before invoking PowerShell when a minimized window cannot be restored", async () => {
    const calls: Call[] = []
    const error = await Effect.runPromise(
      ScreenCaptureWindows.capture(
        fakeProcess(calls, () =>
          jsonResponse({
            ...LIST,
            windows: [{ ...LIST.windows[0]!, minimized: true }, ...LIST.windows.slice(1)],
          }),
        ),
        backend(),
        input({ target: "window", window: "0x10", restore_minimized: false }),
      ).pipe(Effect.catch((failure) => Effect.succeed(failure))),
    )

    expect(error).toBeInstanceOf(CaptureError)
    if (!(error instanceof CaptureError)) return
    expect(error.code).toBe("window_not_capturable")
    expect(calls).toHaveLength(1)
  })

  test("maps PowerShell JSON stderr to CaptureError codes", async () => {
    const calls: Call[] = []
    const error = await Effect.runPromise(
      ScreenCaptureWindows.capture(
        fakeProcess(calls, (request) => {
          const payload = request as RawRecord
          if (payload.operation === "list") return jsonResponse(LIST)
          return errorResponse({
            code: "window_not_found",
            reason: "the window is no longer available",
            candidates: ["0x10 firefox \"Alpha Project\""],
          })
        }),
        backend(),
        input({ target: "window", window: "0x10" }),
      ).pipe(Effect.catch((failure) => Effect.succeed(failure))),
    )

    expect(error).toBeInstanceOf(CaptureError)
    if (!(error instanceof CaptureError)) return
    expect(error.code).toBe("window_not_found")
    expect(error.candidates).toEqual(['0x10 firefox "Alpha Project"'])
  })

  test("WSL reuses the PowerShell backend and reports the wsl backend", async () => {
    const calls: Call[] = []
    const result = await Effect.runPromise(
      ScreenCaptureWsl.capture(
        fakeProcess(calls, () => jsonResponse({ data: PNG_BASE64, target: "screen", display: 1 })),
        backend("wsl"),
        input(),
      ),
    )

    expect(result).toMatchObject({ backend: "wsl", platform: "linux", display: 1 })
    expect(calls[0]?.command).toBe(WSL_PROGRAM)
    expect(record(calls[0]?.stdin ?? "")).toMatchObject({ operation: "capture", target: "screen", display: "primary" })
  })
})
