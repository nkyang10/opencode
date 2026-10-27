export * as ScreenCaptureWayland from "./wayland"

import { Duration, Effect, Option, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess, type RunResult } from "../process"
import { imageDimensions } from "../image/dimensions"
import { formatList } from "./x11"
import { orderFrontToBack, summarize } from "./select"
import {
  CaptureError,
  type Bounds,
  type CaptureResult,
  type Display,
  type Input,
  type ListResult,
  type WaylandBackend,
  type Window,
} from "./schema"

const LIST_OUTPUT_BYTES = 4 * 1024 * 1024
const CAPTURE_OUTPUT_BYTES = 50 * 1024 * 1024
const ERROR_BYTES = 64 * 1024
const COMMAND_TIMEOUT = Duration.seconds(20)
const MAX_WINDOWS = 50
const MAX_CANDIDATES = 10

type RawRecord = Record<string, unknown>

type ScreenCommand = {
  readonly args: readonly string[]
  readonly display: number | "all"
}

type CollectedWindows = {
  readonly windows: Window[]
  readonly active?: string
}

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

export function list(process: AppProcess.Interface, backend: WaylandBackend): Effect.Effect<ListResult, CaptureError> {
  return Effect.gen(function* () {
    const displays = yield* listDisplays(process, backend)
    const windows = yield* listWindows(process, backend, displays)
    const shown = windows.windows.slice(0, MAX_WINDOWS)
    const truncated = windows.windows.length > shown.length
    return {
      text: formatList(displays, shown, truncated),
      displays,
      windows: shown,
      truncated,
    } satisfies ListResult
  })
}

export function capture(
  process: AppProcess.Interface,
  backend: WaylandBackend,
  input: Input,
): Effect.Effect<CaptureResult, CaptureError> {
  return Effect.gen(function* () {
    if (input.target === "window") return yield* unsupportedWindow(process, backend, input)

    const displays = yield* listDisplays(process, backend)
    const command = yield* Effect.succeed(grimArgs(input.display, displays)).pipe(
      Effect.flatMap((result) => (result instanceof CaptureError ? Effect.fail(result) : Effect.succeed(result))),
    )
    const data = yield* captureStdout(process, backend, command.args)
    return yield* captureResult({ data, target: "screen", display: command.display })
  })
}

export function listArgs(backend: WaylandBackend) {
  return backend.compositor === "sway" ? ["-t", "get_outputs"] : ["monitors", "-j"]
}

export function windowListArgs(backend: WaylandBackend) {
  return backend.compositor === "sway" ? ["-t", "get_tree"] : ["clients", "-j"]
}

export function grimArgs(selector: Input["display"], displays: ReadonlyArray<Display>): ScreenCommand | CaptureError {
  if (selector === "all") {
    const bounds = unionBounds(displays)
    if (bounds)
      return {
        args: ["-g", `${bounds.width}x${bounds.height}+${bounds.x}+${bounds.y}`],
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
      reason: typeof selector === "number" ? `display ${selector} was not found` : "No Wayland outputs are available.",
    })
  return { args: ["-o", chosen.name], display: selector === "all" ? "all" : chosen.index }
}

function unsupportedWindow(
  process: AppProcess.Interface,
  backend: WaylandBackend,
  input: Input,
): Effect.Effect<never, CaptureError> {
  return Effect.gen(function* () {
    const displays = yield* listDisplays(process, backend)
    const collected = yield* listWindows(process, backend, displays)
    const selector = input.window?.trim()
    const candidates = collected.windows.slice(0, MAX_CANDIDATES).map(summarize)
    return yield* new CaptureError({
      code: selector ? "window_not_capturable" : "window_not_found",
      reason: selector
        ? "Wayland does not expose a generic protocol for capturing another client window. Use an X11 session, Xvfb, or a headless browser."
        : "target window requires a window selector",
      ...(candidates.length ? { candidates } : {}),
    })
  })
}

function listDisplays(
  process: AppProcess.Interface,
  backend: WaylandBackend,
): Effect.Effect<Display[], CaptureError> {
  return Effect.gen(function* () {
    const output = yield* runJson(process, backend, backend.lister, listArgs(backend), LIST_OUTPUT_BYTES)
    const displays =
      backend.compositor === "sway" ? normalizeSwayDisplays(output) : normalizeHyprlandDisplays(output)
    if (!displays.length)
      return yield* new CaptureError({ code: "no_interactive_session", reason: "No Wayland outputs are available." })
    return displays
  })
}

function listWindows(
  process: AppProcess.Interface,
  backend: WaylandBackend,
  displays: ReadonlyArray<Display>,
): Effect.Effect<CollectedWindows, CaptureError> {
  return Effect.gen(function* () {
    const output = yield* runJson(process, backend, backend.lister, windowListArgs(backend), LIST_OUTPUT_BYTES)
    const collected =
      backend.compositor === "sway" ? normalizeSwayWindows(output, displays) : normalizeHyprlandWindows(output, displays)
    return { ...collected, windows: orderFrontToBack(collected.windows, collected.active) }
  })
}

function captureStdout(
  process: AppProcess.Interface,
  backend: WaylandBackend,
  args: ReadonlyArray<string>,
): Effect.Effect<Uint8Array, CaptureError> {
  return Effect.gen(function* () {
    const data = yield* runBytes(process, backend, backend.program, args, CAPTURE_OUTPUT_BYTES)
    if (data.length === 0)
      return yield* new CaptureError({ code: "unsupported", reason: "grim produced no image data" })
    if (!imageDimensions(new Uint8Array(data)))
      return yield* new CaptureError({ code: "unsupported", reason: "grim did not produce a PNG image" })
    return new Uint8Array(data)
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
    return Effect.fail(new CaptureError({ code: "unsupported", reason: "grim did not produce a PNG image" }))
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
    backend: "wayland",
    platform: "linux",
    others: input.others?.length ? input.others : undefined,
  })
}

function runJson(
  process: AppProcess.Interface,
  backend: WaylandBackend,
  program: string,
  args: ReadonlyArray<string>,
  maxOutputBytes: number,
): Effect.Effect<unknown, CaptureError> {
  return Effect.gen(function* () {
    const result = yield* run(process, backend, program, args, maxOutputBytes)
    const decoded = decodeJson(result.stdout.toString("utf8"))
    if (Option.isNone(decoded))
      return yield* new CaptureError({ code: "unsupported", reason: `${program} produced malformed JSON` })
    return decoded.value
  })
}

function runBytes(
  process: AppProcess.Interface,
  backend: WaylandBackend,
  program: string,
  args: ReadonlyArray<string>,
  maxOutputBytes: number,
): Effect.Effect<Buffer, CaptureError> {
  return run(process, backend, program, args, maxOutputBytes).pipe(Effect.map((result) => result.stdout))
}

function run(
  process: AppProcess.Interface,
  backend: WaylandBackend,
  program: string,
  args: ReadonlyArray<string>,
  maxOutputBytes: number,
): Effect.Effect<RunResult, CaptureError> {
  return Effect.gen(function* () {
    const result = yield* process
      .run(
        ChildProcess.make(program, [...args], {
          env: { WAYLAND_DISPLAY: backend.display },
          extendEnv: true,
        }),
        { timeout: COMMAND_TIMEOUT, maxOutputBytes, maxErrorBytes: ERROR_BYTES },
      )
      .pipe(Effect.mapError(mapProcessError))
    if (result.exitCode !== 0) return yield* commandFailure(program, result)
    if (result.stdoutTruncated)
      return yield* new CaptureError({ code: "unsupported", reason: `${program} output is larger than the capture limit` })
    return result
  })
}

function mapProcessError(error: AppProcess.AppProcessError): CaptureError {
  const detail = error.message
  if (detail.includes("Timed out")) return new CaptureError({ code: "timeout", reason: `${error.command} timed out` })
  if (/ENOENT|not found|command not found/i.test(detail))
    return new CaptureError({ code: "missing_dependency", reason: detail })
  if (/EPERM|EACCES|operation not permitted|permission denied|access is denied/i.test(detail))
    return new CaptureError({ code: "permission_required", reason: detail })
  return new CaptureError({ code: "unsupported", reason: detail })
}

function commandFailure(program: string, result: RunResult): Effect.Effect<never, CaptureError> {
  const combined = `${result.stderr.toString("utf8")}\n${result.stdout.toString("utf8")}`.trim()
  const code = classifyFailure(combined)
  return Effect.fail(new CaptureError({ code, reason: `${program} failed${combined ? `: ${combined}` : ""}` }))
}

function classifyFailure(text: string): CaptureError["code"] {
  if (/permission|denied|not authorized|locked|authentication agent/i.test(text)) return "permission_required"
  if (/no outputs?|invalid output|no displays?|no screen|not available/i.test(text)) return "no_interactive_session"
  if (/not found|no such file|ENOENT|command not found/i.test(text)) return "missing_dependency"
  return "unsupported"
}

function normalizeSwayDisplays(value: unknown): Display[] {
  return arrayField(value)
    .map((item, index): Display | undefined => {
      const record = asRecord(item)
      const bounds = objectBounds(asRecord(record?.rect))
      if (!bounds) return undefined
      return {
        index: index + 1,
        name: stringField(record, "name") ?? `output-${index + 1}`,
        primary: booleanField(record, "primary") ?? booleanField(record, "active") ?? index === 0,
        bounds,
        scale: numberField(record, "scale"),
      }
    })
    .filter((display): display is Display => display !== undefined)
}

function normalizeHyprlandDisplays(value: unknown): Display[] {
  return arrayField(value)
    .map((item, index): Display | undefined => {
      const record = asRecord(item)
      const bounds = flatBounds(record)
      if (!bounds) return undefined
      return {
        index: index + 1,
        name: stringField(record, "name") ?? `output-${index + 1}`,
        primary:
          booleanField(record, "primary") ?? booleanField(record, "focused") ?? booleanField(record, "active") ?? index === 0,
        bounds,
        scale: numberField(record, "scale"),
      }
    })
    .filter((display): display is Display => display !== undefined)
}

function normalizeSwayWindows(value: unknown, displays: ReadonlyArray<Display>): CollectedWindows {
  const records: RawRecord[] = []
  collectSwayWindows(value, records)
  const active = records.find((record) => booleanField(record, "focused"))
  const windows = records
    .map((record): Window | undefined => {
      const id = idField(record, "id")
      if (!id) return undefined
      const properties = asRecord(record.window_properties)
      const app = stringField(record, "app_id") ?? stringField(properties, "class") ?? stringField(properties, "instance")
      const title = stringField(record, "name") ?? stringField(properties, "title")
      const bounds = objectBounds(asRecord(record.rect))
      return {
        id,
        app,
        pid: numberField(record, "pid"),
        title,
        bounds,
        display: displayForBounds(bounds, displays),
        minimized: booleanField(record, "minimized") ?? false,
      }
    })
    .filter((window): window is Window => window !== undefined)
  return { windows, active: active ? idField(active, "id") : undefined }
}

function normalizeHyprlandWindows(value: unknown, displays: ReadonlyArray<Display>): CollectedWindows {
  const records = arrayField(value).map(asRecord).filter((record): record is RawRecord => record !== undefined)
  const active = records.find((record) => booleanField(record, "focused"))
  const windows = records
    .map((record): Window | undefined => {
      const id = idField(record, "address") ?? idField(record, "id")
      if (!id) return undefined
      const at = pointField(record.at)
      const size = pointField(record.size)
      const bounds = at && size ? { x: at[0], y: at[1], width: size[0], height: size[1] } : undefined
      return {
        id,
        app: stringField(record, "class"),
        pid: numberField(record, "pid"),
        title: stringField(record, "title"),
        bounds,
        display: displayForBounds(bounds, displays),
        minimized: booleanField(record, "hidden") ?? !(booleanField(record, "mapped") ?? true),
      }
    })
    .filter((window): window is Window => window !== undefined)
  return { windows, active: active ? idField(active, "address") ?? idField(active, "id") : undefined }
}

function collectSwayWindows(value: unknown, out: RawRecord[]) {
  if (Array.isArray(value)) {
    for (const item of value) collectSwayWindows(item, out)
    return
  }
  const record = asRecord(value)
  if (!record) return
  if ((record.type === "con" || record.type === "floating_con" || record.window_properties) && (idField(record, "id") || record.name || record.app_id))
    out.push(record)
  for (const child of arrayField(record.nodes)) collectSwayWindows(child, out)
  for (const child of arrayField(record.floating_nodes)) collectSwayWindows(child, out)
}

function displayForBounds(bounds: Bounds | undefined, displays: ReadonlyArray<Display>) {
  if (!displays.length) return undefined
  if (!bounds) return displays.find((display) => display.primary)?.index ?? displays[0]?.index
  const x = bounds.x + Math.floor(bounds.width / 2)
  const y = bounds.y + Math.floor(bounds.height / 2)
  const hit = displays.find(
    (display) =>
      display.bounds &&
      x >= display.bounds.x &&
      x < display.bounds.x + display.bounds.width &&
      y >= display.bounds.y &&
      y < display.bounds.y + display.bounds.height,
  )
  return hit?.index ?? displays.find((display) => display.primary)?.index ?? displays[0]?.index
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

function objectBounds(value: RawRecord | undefined): Bounds | undefined {
  const width = numberField(value, "width")
  const height = numberField(value, "height")
  const x = numberField(value, "x")
  const y = numberField(value, "y")
  if (width === undefined || height === undefined || x === undefined || y === undefined) return undefined
  return { width, height, x, y }
}

function flatBounds(value: RawRecord | undefined): Bounds | undefined {
  const width = numberField(value, "width")
  const height = numberField(value, "height")
  const x = numberField(value, "x")
  const y = numberField(value, "y")
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

function idField(record: RawRecord | undefined, key: string) {
  const value = record?.[key]
  if (typeof value === "string" && value.length > 0) return value
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return undefined
}

function numberField(record: RawRecord | undefined, key: string) {
  const value = record?.[key]
  return numberValue(value)
}

function numberValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function pointField(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined
  const first = numberValue(value[0])
  const second = numberValue(value[1])
  return first !== undefined && second !== undefined ? [first, second] : undefined
}

function booleanField(record: RawRecord | undefined, key: string) {
  const value = record?.[key]
  return typeof value === "boolean" ? value : undefined
}
