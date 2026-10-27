/// <reference path="../powershell.d.ts" />
export * as ScreenCaptureWindows from "./windows"

import { Duration, Effect, Option, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess, type RunResult } from "../process"
import { imageDimensions } from "../image/dimensions"
import { orderFrontToBack, selectWindow, summarize } from "./select"
import {
  CaptureError,
  ErrorCode,
  type Bounds,
  type CaptureResult,
  type Display,
  type Input,
  type ListResult,
  type Window,
  type WindowsBackend,
} from "./schema"
import { formatList } from "./x11"
import windowsScript from "./windows.ps1" with { type: "text" }

const LIST_OUTPUT_BYTES = 2 * 1024 * 1024
const CAPTURE_OUTPUT_BYTES = 35 * 1024 * 1024
const ERROR_BYTES = 64 * 1024
const COMMAND_TIMEOUT = Duration.seconds(30)
const MAX_WINDOWS = 50
const MAX_OTHERS = 10
const MAX_CANDIDATES = 10

export const BOOTSTRAP =
  "[Console]::InputEncoding=[Text.Encoding]::UTF8;$p=[Console]::In.ReadToEnd()|ConvertFrom-Json;$s=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p.script));$b=[ScriptBlock]::Create($s);& $b $p"

const SCRIPT_BASE64 = Buffer.from(windowsScript, "utf8").toString("base64")
const ENCODED_BOOTSTRAP = Buffer.from(BOOTSTRAP, "utf16le").toString("base64")
const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const decodeErrorCode = Schema.decodeUnknownOption(ErrorCode)

type RawRecord = Record<string, unknown>

type ListOutput = {
  readonly displays: Display[]
  readonly windows: Window[]
  readonly active?: string
}

type CaptureOutput = {
  readonly data: string
  readonly display?: number | "all"
  readonly window?: RawRecord
  readonly restored: boolean
  readonly focusChanged: boolean
}

export function list(process: AppProcess.Interface, backend: WindowsBackend): Effect.Effect<ListResult, CaptureError> {
  return Effect.gen(function* () {
    const collected = yield* collect(process, backend)
    const shown = collected.windows.slice(0, MAX_WINDOWS)
    const truncated = collected.windows.length > shown.length
    return {
      text: formatList(collected.displays, shown, truncated),
      displays: collected.displays,
      windows: shown,
      truncated,
    } satisfies ListResult
  })
}

export function capture(
  process: AppProcess.Interface,
  backend: WindowsBackend,
  input: Input,
): Effect.Effect<CaptureResult, CaptureError> {
  return input.target === "window" ? captureWindow(process, backend, input) : captureScreen(process, backend, input)
}

export function powershellArgs() {
  return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", ENCODED_BOOTSTRAP]
}

export function powershellInput(input: Record<string, unknown>) {
  return { script: SCRIPT_BASE64, ...input }
}

function collect(
  process: AppProcess.Interface,
  backend: WindowsBackend,
): Effect.Effect<{ displays: Display[]; windows: Window[] }, CaptureError> {
  return Effect.gen(function* () {
    const output = yield* invoke(process, backend, { operation: "list" }, LIST_OUTPUT_BYTES)
    const parsed = normalizeList(output)
    return { displays: parsed.displays, windows: orderFrontToBack(parsed.windows, parsed.active) }
  })
}

function captureScreen(
  process: AppProcess.Interface,
  backend: WindowsBackend,
  input: Input,
): Effect.Effect<CaptureResult, CaptureError> {
  return Effect.gen(function* () {
    const output = yield* invoke(
      process,
      backend,
      { operation: "capture", target: "screen", display: input.display },
      CAPTURE_OUTPUT_BYTES,
    )
    const parsed = yield* decodeCapture(output)
    return yield* captureResult(backend, parsed, {
      target: "screen",
      display: parsed.display ?? (input.display === "all" ? "all" : typeof input.display === "number" ? input.display : undefined),
    })
  })
}

function captureWindow(
  process: AppProcess.Interface,
  backend: WindowsBackend,
  input: Input,
): Effect.Effect<CaptureResult, CaptureError> {
  return Effect.gen(function* () {
    const selector = input.window?.trim()
    if (!selector)
      return yield* new CaptureError({ code: "window_not_found", reason: "target window requires a window selector" })

    const collected = yield* collect(process, backend)
    const selected = selectWindow(collected.windows, selector)
    if (!selected.ok)
      return yield* new CaptureError({
        code: "window_not_found",
        reason: `no window matched ${selector}`,
        candidates: selected.candidates,
      })

    const window = selected.match.selected
    if (window.minimized && !input.restore_minimized)
      return yield* new CaptureError({
        code: "window_not_capturable",
        reason: "window is minimized and restore_minimized is false",
      })

    const output = yield* invoke(
      process,
      backend,
      { operation: "capture", target: "window", id: window.id, restoreMinimized: input.restore_minimized },
      CAPTURE_OUTPUT_BYTES,
    )
    const parsed = yield* decodeCapture(output)
    return yield* captureResult(backend, parsed, {
      target: "window",
      display: parsed.display ?? window.display,
      window: captureWindowInfo(parsed.window, window),
      restored: parsed.restored,
      focusChanged: parsed.focusChanged,
      others: selected.match.others.slice(0, MAX_OTHERS).map(summarize),
    })
  })
}

function invoke(
  process: AppProcess.Interface,
  backend: WindowsBackend,
  input: Record<string, unknown>,
  maxOutputBytes: number,
): Effect.Effect<unknown, CaptureError> {
  return Effect.gen(function* () {
    const result = yield* process
      .run(command(backend), {
        timeout: COMMAND_TIMEOUT,
        maxOutputBytes,
        maxErrorBytes: ERROR_BYTES,
        stdin: Buffer.from(JSON.stringify(powershellInput(input)), "utf8"),
      })
      .pipe(Effect.mapError(mapProcessError))

    if (result.exitCode !== 0) return yield* powerShellFailure(result, backend)
    if (result.stdoutTruncated)
      return yield* new CaptureError({ code: "unsupported", reason: "PowerShell output is larger than the capture limit" })
    return yield* parseJson(result.stdout.toString("utf8"), "PowerShell produced no JSON")
  })
}

function command(backend: WindowsBackend) {
  return ChildProcess.make(backend.program, powershellArgs(), { extendEnv: true })
}

function mapProcessError(error: AppProcess.AppProcessError): CaptureError {
  const detail = error.message
  if (detail.includes("Timed out")) return new CaptureError({ code: "timeout", reason: `${error.command} timed out` })
  if (/ENOENT|not found|command not found/i.test(detail))
    return new CaptureError({ code: "missing_dependency", reason: detail })
  if (/EPERM|EACCES|access is denied/i.test(detail)) return new CaptureError({ code: "permission_required", reason: detail })
  return new CaptureError({ code: "unsupported", reason: detail })
}

function powerShellFailure(result: RunResult, backend: WindowsBackend): Effect.Effect<never, CaptureError> {
  const stderr = result.stderr.toString("utf8").trim()
  const combined = `${stderr}\n${result.stdout.toString("utf8")}`.trim()
  const record = errorRecord(stderr) ?? errorRecord(combined)
  const code = Option.getOrUndefined(decodeErrorCode(stringField(record, "code") ?? "")) ?? classifyFailure(combined)
  const reason = stringField(record, "reason") || combined || `${backend.program} failed`
  const candidates = arrayField(record?.candidates)
    .filter((candidate): candidate is string => typeof candidate === "string")
    .slice(0, MAX_CANDIDATES)
  return Effect.fail(new CaptureError({ code, reason, ...(candidates.length ? { candidates } : {}) }))
}

function errorRecord(text: string) {
  if (!text) return undefined
  const decoded = decodeJson(text)
  return Option.isSome(decoded) ? asRecord(decoded.value) : undefined
}

function classifyFailure(text: string): CaptureError["code"] {
  if (/no interactive|session 0|service session|no monitors|no display/i.test(text)) return "no_interactive_session"
  if (/access is denied|permission|protected|drm/i.test(text)) return "permission_required"
  if (/window|hwnd|handle/i.test(text)) return "window_not_found"
  if (/not found|no such file|ENOENT/i.test(text)) return "missing_dependency"
  return "unsupported"
}

function parseJson(text: string, emptyReason: string): Effect.Effect<unknown, CaptureError> {
  if (!text.trim()) return Effect.fail(new CaptureError({ code: "unsupported", reason: emptyReason }))
  const decoded = decodeJson(text)
  if (Option.isNone(decoded))
    return Effect.fail(new CaptureError({ code: "unsupported", reason: "PowerShell produced malformed JSON" }))
  return Effect.succeed(decoded.value)
}

function normalizeList(value: unknown): ListOutput {
  const record = asRecord(value)
  const displays = arrayField(record?.displays)
    .map((display, index) => displayInfo(display, index + 1))
    .filter((display): display is Display => display !== undefined)
  const windows = arrayField(record?.windows)
    .map(windowFromValue)
    .filter((window): window is Window => window !== undefined)
  return {
    displays: displays.length ? displays : [{ index: 1, name: "monitor", primary: true }],
    windows,
    active: stringField(record, "active"),
  }
}

function decodeCapture(value: unknown): Effect.Effect<CaptureOutput, CaptureError> {
  const record = asRecord(value)
  const data = stringField(record, "data")?.replace(/\s+/g, "")
  if (!data) return Effect.fail(new CaptureError({ code: "unsupported", reason: "PowerShell did not return image data" }))
  return Effect.succeed({
    data,
    display: displayOutput(record?.display),
    window: asRecord(record?.window),
    restored: booleanField(record, "restored") ?? false,
    focusChanged: booleanField(record, "focusChanged") ?? false,
  })
}

function captureResult(
  backend: WindowsBackend,
  output: CaptureOutput,
  fallback: {
    target: Input["target"]
    display?: number | "all"
    window?: { id: string; app?: string; pid?: number; title?: string }
    restored?: boolean
    focusChanged?: boolean
    others?: ReadonlyArray<string>
  },
): Effect.Effect<CaptureResult, CaptureError> {
  const bytes = Buffer.from(output.data, "base64")
  const data = new Uint8Array(bytes)
  const dimensions = imageDimensions(data)
  if (!dimensions)
    return Effect.fail(new CaptureError({ code: "unsupported", reason: "PowerShell did not produce a PNG image" }))

  return Effect.succeed({
    data,
    mime: "image/png",
    width: dimensions.width,
    height: dimensions.height,
    target: fallback.target,
    display: output.display ?? fallback.display,
    window: fallback.window,
    restored: output.restored || fallback.restored === true,
    focusChanged: output.focusChanged || fallback.focusChanged === true,
    backend: backend.transport === "wsl" ? "wsl" : "windows",
    platform: backend.transport === "wsl" ? "linux" : "win32",
    others: fallback.others?.length ? fallback.others : undefined,
  })
}

function captureWindowInfo(
  value: RawRecord | undefined,
  fallback: Window,
): { id: string; app?: string; pid?: number; title?: string } {
  const app = stringField(value, "app") ?? fallback.app
  const pid = numberField(value, "pid") ?? fallback.pid
  const title = stringField(value, "title") ?? fallback.title
  return {
    id: stringField(value, "id") ?? fallback.id,
    ...(app ? { app } : {}),
    ...(pid === undefined ? {} : { pid }),
    ...(title ? { title } : {}),
  }
}

function windowFromValue(value: unknown): Window | undefined {
  const record = asRecord(value)
  const id = stringField(record, "id")
  if (!id) return undefined
  return {
    id,
    app: stringField(record, "app"),
    pid: numberField(record, "pid"),
    title: stringField(record, "title"),
    bounds: boundsField(record?.bounds),
    display: numberField(record, "display"),
    minimized: booleanField(record, "minimized") ?? false,
    currentDesktop: booleanField(record, "currentDesktop"),
  }
}

function displayInfo(value: unknown, index: number): Display | undefined {
  const record = asRecord(value)
  return {
    index: numberField(record, "index") ?? index,
    name: stringField(record, "name") ?? `monitor-${index}`,
    primary: booleanField(record, "primary") ?? false,
    bounds: boundsField(record?.bounds),
    scale: numberField(record, "scale"),
  }
}

function boundsField(value: unknown): Bounds | undefined {
  const record = asRecord(value)
  const width = numberField(record, "width")
  const height = numberField(record, "height")
  const x = numberField(record, "x")
  const y = numberField(record, "y")
  if (width === undefined || height === undefined || x === undefined || y === undefined) return undefined
  return { width, height, x, y }
}

function displayOutput(value: unknown): number | "all" | undefined {
  if (value === "all") return "all"
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
  return undefined
}

function asRecord(value: unknown): RawRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as RawRecord
}

function arrayField(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function stringField(record: RawRecord | undefined, key: string) {
  const value = record?.[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberField(record: RawRecord | undefined, key: string) {
  const value = record?.[key]
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function booleanField(record: RawRecord | undefined, key: string) {
  const value = record?.[key]
  return typeof value === "boolean" ? value : undefined
}
