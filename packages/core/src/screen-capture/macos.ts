/// <reference path="../script.d.ts" />

export * as ScreenCaptureMacos from "./macos"

import { readFile, stat, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { Duration, Effect, Option, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess, type RunResult } from "../process"
import { imageDimensions } from "../image/dimensions"
import { isLikelyBlankPng } from "./blank"
import { orderFrontToBack, selectWindow, summarize } from "./select"
import {
  CaptureError,
  ErrorCode,
  type Bounds,
  type CaptureResult,
  type Display,
  type Input,
  type ListResult,
  type MacOSBackend,
  type Window,
} from "./schema"
import { formatList } from "./x11"
import macosScript from "./macos.jxa" with { type: "text" }

const LIST_OUTPUT_BYTES = 2 * 1024 * 1024
const JXA_OUTPUT_BYTES = 64 * 1024
const SCREENCAPTURE_OUTPUT_BYTES = 1024 * 1024
const MAX_CAPTURE_FILE_BYTES = 50 * 1024 * 1024
const ERROR_BYTES = 64 * 1024
const COMMAND_TIMEOUT = Duration.seconds(20)
const MAX_WINDOWS = 50
const MAX_OTHERS = 10
const MAX_CANDIDATES = 10

export const OSASCRIPT_LOADER =
  "ObjC.import('Foundation');" +
  "function readStdin(){var d=$.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;var s=$.NSString.alloc.initWithDataEncoding(d,$.NSUTF8StringEncoding);return s?s.js:JSON.stringify({operation:'unsupported',script:''})}" +
  "try{var request=JSON.parse(readStdin());var encoded=request.script;if(!encoded)throw new Error(JSON.stringify({code:'unsupported',reason:'missing macOS JXA script'}));var decoded=$.NSString.alloc.initWithDataEncoding($.NSData.alloc.initWithBase64Encoding(encoded),$.NSUTF8StringEncoding);if(!decoded)throw new Error(JSON.stringify({code:'unsupported',reason:'could not decode macOS JXA script'}));delete request.script;var handlers=eval(decoded.js);if(!handlers||typeof handlers[request.operation]!=='function')throw new Error(JSON.stringify({code:'unsupported',reason:'unsupported macOS screenshot operation'}));return JSON.stringify(handlers[request.operation](request))}catch(error){var message=error&&error.message?String(error.message):String(error);throw new Error(message)}"

const SCRIPT_BASE64 = Buffer.from(macosScript, "utf8").toString("base64")
const decodeErrorCode = Schema.decodeUnknownOption(ErrorCode)

type RawRecord = Record<string, unknown>

type ScreenCommand = {
  readonly args: readonly string[]
  readonly display: number | "all"
}

export function list(process: AppProcess.Interface, backend: MacOSBackend): Effect.Effect<ListResult, CaptureError> {
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
  backend: MacOSBackend,
  input: Input,
): Effect.Effect<CaptureResult, CaptureError> {
  return input.target === "window" ? captureWindow(process, backend, input) : captureScreen(process, backend, input)
}

export function osascriptArgs() {
  return ["-l", "JavaScript", "-e", OSASCRIPT_LOADER]
}

export function osascriptInput(input: Record<string, unknown>) {
  return { script: SCRIPT_BASE64, ...input }
}

export function screenArgs(selector: Input["display"], displays: ReadonlyArray<Display>): ScreenCommand | CaptureError {
  if (selector === "all") {
    const bounds = unionBounds(displays)
    if (bounds)
      return {
        args: ["-x", "-R", `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`, "-t", "png"],
        display: "all",
      }
  }

  const chosen =
    typeof selector === "number"
      ? displays.find((display) => display.index === selector)
      : displays.find((display) => display.primary) ?? displays[0]
  if (!chosen)
    return new CaptureError({
      code: typeof selector === "number" ? "unsupported" : "no_interactive_session",
      reason: typeof selector === "number" ? `display ${selector} was not found` : "No macOS displays are available.",
    })
  return { args: ["-x", "-D", String(chosen.index), "-t", "png"], display: selector === "all" ? "all" : chosen.index }
}

export function windowArgs(id: string) {
  return ["-x", "-o", "-l", decimalWindowId(id), "-t", "png"]
}

export function decimalWindowId(id: string) {
  try {
    return BigInt(id.trim()).toString()
  } catch {
    return id.trim()
  }
}

function collect(
  process: AppProcess.Interface,
  backend: MacOSBackend,
): Effect.Effect<{ displays: Display[]; windows: Window[] }, CaptureError> {
  return Effect.gen(function* () {
    const output = yield* invokeJXA(process, backend, { operation: "list" }, LIST_OUTPUT_BYTES)
    return normalizeList(output)
  })
}

function captureScreen(
  process: AppProcess.Interface,
  backend: MacOSBackend,
  input: Input,
): Effect.Effect<CaptureResult, CaptureError> {
  return Effect.gen(function* () {
    const collected = yield* collect(process, backend)
    const command = yield* Effect.succeed(screenArgs(input.display, collected.displays)).pipe(
      Effect.flatMap((result) => (result instanceof CaptureError ? Effect.fail(result) : Effect.succeed(result))),
    )
    const data = yield* captureToFile(process, backend, command.args)
    return yield* captureResult({ data, target: "screen", display: command.display })
  })
}

function captureWindow(
  process: AppProcess.Interface,
  backend: MacOSBackend,
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

    const args = windowArgs(window.id)
    const fallback = {
      target: "window" as const,
      display: window.display,
      window: { id: window.id, app: window.app, pid: window.pid, title: window.title },
      others: selected.match.others.slice(0, MAX_OTHERS).map(summarize),
    }
    const first = yield* captureToFile(process, backend, args)
    if (!window.minimized || !input.restore_minimized || !isLikelyBlankPng(first))
      return yield* captureResult({ data: first, ...fallback })

    const data = yield* Effect.acquireUseRelease(
      restoreWindow(process, backend, window.id, false).pipe(Effect.mapError(restoreFailure)),
      () => captureToFile(process, backend, args),
      () =>
        restoreWindow(process, backend, window.id, true).pipe(
          Effect.tapError((error) => Effect.logWarning("failed to re-minimize captured window", { error })),
          Effect.ignore,
        ),
    )
    return yield* captureResult({ data, ...fallback, restored: true })
  })
}

function restoreWindow(
  process: AppProcess.Interface,
  backend: MacOSBackend,
  id: string,
  minimized: boolean,
): Effect.Effect<boolean, CaptureError> {
  return invokeJXA(
    process,
    backend,
    { operation: "restore", id, minimized, restoreMinimized: !minimized },
    JXA_OUTPUT_BYTES,
  ).pipe(
    Effect.map((value) => booleanField(asRecord(value), "ok") ?? true),
    Effect.flatMap((ok) =>
      ok
        ? Effect.succeed(ok)
        : Effect.fail(new CaptureError({ code: "window_not_capturable", reason: "macOS could not change the minimized window state" })),
    ),
  )
}

function captureToFile(
  process: AppProcess.Interface,
  backend: MacOSBackend,
  args: ReadonlyArray<string>,
): Effect.Effect<Uint8Array, CaptureError> {
  const file = join(tmpdir(), `opencode-screenshot-${randomUUID()}.png`)
  return Effect.acquireUseRelease(
    Effect.succeed(file),
    (path) =>
      Effect.gen(function* () {
        const result = yield* process
          .run(ChildProcess.make(backend.screencapture, [...args, path], { extendEnv: true }), {
            timeout: COMMAND_TIMEOUT,
            maxOutputBytes: SCREENCAPTURE_OUTPUT_BYTES,
            maxErrorBytes: ERROR_BYTES,
          })
          .pipe(Effect.mapError(mapProcessError))
        if (result.exitCode !== 0) return yield* captureFailure(result)
        const info = yield* Effect.tryPromise({
          try: () => stat(path),
          catch: (cause) => captureReadError(cause),
        })
        if (!info.isFile())
          return yield* new CaptureError({ code: "unsupported", reason: "screencapture did not write a PNG file" })
        if (info.size <= 0)
          return yield* new CaptureError({ code: "unsupported", reason: "screencapture produced no image data" })
        if (info.size > MAX_CAPTURE_FILE_BYTES)
          return yield* new CaptureError({
            code: "unsupported",
            reason: "screenshot is larger than the 50 MB capture limit",
          })
        const bytes = yield* Effect.tryPromise({
          try: () => readFile(path),
          catch: (cause) => captureReadError(cause),
        })
        const data = new Uint8Array(bytes)
        if (!imageDimensions(data))
          return yield* new CaptureError({ code: "unsupported", reason: "screencapture did not produce a PNG image" })
        return data
      }),
    (path) =>
      Effect.ignore(
        Effect.tryPromise<void, CaptureError>({
          try: () => unlink(path),
          catch: (cause) => captureReadError(cause),
        }),
      ),
  )
}

function captureReadError(cause: unknown): CaptureError {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new CaptureError({ code: "unsupported", reason: `could not read the captured screenshot: ${detail}` })
}

function invokeJXA(
  process: AppProcess.Interface,
  backend: MacOSBackend,
  input: Record<string, unknown>,
  maxOutputBytes: number,
): Effect.Effect<unknown, CaptureError> {
  return Effect.gen(function* () {
    const result = yield* process
      .run(ChildProcess.make(backend.osascript, osascriptArgs(), { extendEnv: true }), {
        timeout: COMMAND_TIMEOUT,
        maxOutputBytes,
        maxErrorBytes: ERROR_BYTES,
        stdin: Buffer.from(JSON.stringify(osascriptInput(input)), "utf8"),
      })
      .pipe(Effect.mapError(mapProcessError))

    if (result.exitCode !== 0) return yield* jxaFailure(result)
    if (result.stdoutTruncated)
      return yield* new CaptureError({ code: "unsupported", reason: "macOS JXA output is larger than the capture limit" })
    return yield* parseJson(result.stdout.toString("utf8"), "osascript produced no JSON")
  })
}

function mapProcessError(error: AppProcess.AppProcessError): CaptureError {
  const detail = error.message
  if (detail.includes("Timed out")) return new CaptureError({ code: "timeout", reason: `${error.command} timed out` })
  if (/ENOENT|not found|command not found/i.test(detail))
    return new CaptureError({ code: "missing_dependency", reason: detail })
  if (/EPERM|EACCES|operation not permitted|access is denied/i.test(detail))
    return new CaptureError({ code: "permission_required", reason: detail })
  return new CaptureError({ code: "unsupported", reason: detail })
}

function captureFailure(result: RunResult): CaptureError {
  const combined = `${result.stderr.toString("utf8")}\n${result.stdout.toString("utf8")}`.trim()
  return new CaptureError({
    code: classifyCaptureFailure(combined),
    reason: `screencapture failed${combined ? `: ${combined}` : ""}`,
  })
}

function jxaFailure(result: RunResult): Effect.Effect<never, CaptureError> {
  const stderr = result.stderr.toString("utf8").trim()
  const combined = `${stderr}\n${result.stdout.toString("utf8")}`.trim()
  const record = jsonRecord(combined)
  const code = Option.getOrUndefined(decodeErrorCode(stringField(record, "code") ?? "")) ?? classifyJxaFailure(combined)
  const reason = stringField(record, "reason") || combined || "osascript failed"
  const candidates = arrayField(record?.candidates)
    .filter((candidate): candidate is string => typeof candidate === "string")
    .slice(0, MAX_CANDIDATES)
  return Effect.fail(new CaptureError({ code, reason, ...(candidates.length ? { candidates } : {}) }))
}

function classifyCaptureFailure(text: string): CaptureError["code"] {
  if (/cannot capture window|invalid window|bad window|no such window/i.test(text)) return "window_not_found"
  if (/screen recording|not allowed|operation not permitted|permission|denied/i.test(text)) return "permission_required"
  if (/no displays|no screen|could not create image|not available|not interactive/i.test(text))
    return "no_interactive_session"
  if (/not found|no such file|ENOENT/i.test(text)) return "missing_dependency"
  if (/window/i.test(text)) return "window_not_found"
  return "unsupported"
}

function classifyJxaFailure(text: string): CaptureError["code"] {
  if (/screen recording|accessibility|operation not permitted|permission|denied/i.test(text))
    return "permission_required"
  if (/console|no displays|not interactive|window server/i.test(text)) return "no_interactive_session"
  if (/window|id/i.test(text)) return "window_not_found"
  if (/not found|no such file|ENOENT/i.test(text)) return "missing_dependency"
  return "unsupported"
}

function restoreFailure(error: CaptureError): CaptureError {
  if (error.code === "permission_required" || error.code === "missing_dependency" || error.code === "timeout")
    return error
  return new CaptureError({
    code: "window_not_capturable",
    reason: error.reason,
    ...(error.candidates ? { candidates: error.candidates } : {}),
  })
}

function captureResult(input: {
  data: Uint8Array
  target: Input["target"]
  display?: number | "all"
  window?: { id: string; app?: string; pid?: number; title?: string }
  restored?: boolean
  others?: ReadonlyArray<string>
}): Effect.Effect<CaptureResult, CaptureError> {
  const dimensions = imageDimensions(input.data)
  if (!dimensions)
    return Effect.fail(new CaptureError({ code: "unsupported", reason: "screencapture did not produce a PNG image" }))
  return Effect.succeed({
    data: input.data,
    mime: "image/png",
    width: dimensions.width,
    height: dimensions.height,
    target: input.target,
    display: input.display,
    window: input.window,
    restored: input.restored ?? false,
    focusChanged: false,
    backend: "macos",
    platform: "darwin",
    others: input.others?.length ? input.others : undefined,
  })
}

function normalizeList(value: unknown): { displays: Display[]; windows: Window[] } {
  const record = asRecord(value)
  const displays = arrayField(record?.displays)
    .map((display, index) => displayInfo(display, index + 1))
    .filter((display): display is Display => display !== undefined)
  const windows = arrayField(record?.windows)
    .map(windowFromValue)
    .filter((window): window is Window => window !== undefined)
  return {
    displays: displays.length ? displays : [{ index: 1, name: "display", primary: true }],
    windows: orderFrontToBack(windows),
  }
}

function unionBounds(displays: ReadonlyArray<Display>): Bounds | undefined {
  const bounds = displays
    .map((display) => display.bounds)
    .filter((bounds): bounds is Bounds => bounds !== undefined && bounds.width > 0 && bounds.height > 0)
  if (!bounds.length) return undefined
  const minX = Math.min(...bounds.map((bounds) => bounds.x))
  const minY = Math.min(...bounds.map((bounds) => bounds.y))
  const maxX = Math.max(...bounds.map((bounds) => bounds.x + bounds.width))
  const maxY = Math.max(...bounds.map((bounds) => bounds.y + bounds.height))
  return { width: maxX - minX, height: maxY - minY, x: minX, y: minY }
}

function parseJson(text: string, emptyReason: string): Effect.Effect<unknown, CaptureError> {
  if (!text.trim()) return Effect.fail(new CaptureError({ code: "unsupported", reason: emptyReason }))
  const parsed = jsonRecord(text)
  if (parsed === undefined)
    return Effect.fail(new CaptureError({ code: "unsupported", reason: "macOS JXA produced malformed JSON" }))
  return Effect.succeed(parsed)
}

function jsonRecord(text: string): RawRecord | undefined {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  const decoded = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(text.slice(start, end + 1))
  if (Option.isNone(decoded)) return undefined
  return asRecord(decoded.value)
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
    name: stringField(record, "name") ?? `display-${index}`,
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
