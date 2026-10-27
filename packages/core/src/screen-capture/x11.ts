export * as ScreenCaptureX11 from "./x11"

import { Duration, Effect, Option } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "../process"
import { imageDimensions } from "../image/dimensions"
import { orderFrontToBack, sameWindowId, selectWindow, summarize } from "./select"
import {
  CaptureError,
  type Bounds,
  type CaptureResult,
  type Display,
  type Input,
  type ListResult,
  type Window,
  type X11Backend,
} from "./schema"

const LIST_OUTPUT_BYTES = 2 * 1024 * 1024
const CAPTURE_OUTPUT_BYTES = 25 * 1024 * 1024
const ERROR_BYTES = 64 * 1024
const MAX_WINDOWS = 50
const MAX_OTHERS = 10
const PROPERTY_WINDOW_LIMIT = 200
const COMMAND_TIMEOUT = Duration.seconds(15)
const TOOL_TYPES = new Set([
  "DOCK",
  "TOOLTIP",
  "NOTIFICATION",
  "DROPDOWN_MENU",
  "POPUP_MENU",
  "COMBO",
  "MENU",
  "UTILITY",
])

type Detail = {
  app?: string
  pid?: number
  title?: string
  minimized?: boolean
  currentDesktop?: boolean
  windowType?: string
}

type Collected = {
  readonly displays: ReadonlyArray<Display>
  readonly windows: ReadonlyArray<Window & Detail>
  readonly activeID?: string
}

type RestoreResult = { ok: boolean; focusChanged: boolean }

export function list(process: AppProcess.Interface, backend: X11Backend, display: string) {
  return Effect.gen(function* () {
    const collected = yield* collect(process, backend, display)
    const ordered = orderFrontToBack(collected.windows.filter(listable), collected.activeID)
    const shown = ordered.slice(0, MAX_WINDOWS)
    const truncated = ordered.length > shown.length
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
  backend: X11Backend,
  display: string,
  input: Input,
): Effect.Effect<CaptureResult, CaptureError> {
  return input.target === "window" ? captureWindow(process, backend, display, input) : captureScreen(process, backend, display, input)
}

export function parseDisplays(text: string): Display[] {
  const displays: Display[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\S+)\s+connected\s+(primary\s+)?(?:(\d+)x(\d+)\+(-?\d+)\+(-?\d+))?/.exec(line)
    if (!match) continue
    const width = Number(match[3] ?? 0)
    const height = Number(match[4] ?? 0)
    const x = Number(match[5] ?? 0)
    const y = Number(match[6] ?? 0)
    displays.push({
      index: displays.length + 1,
      name: match[1] ?? `screen-${displays.length + 1}`,
      primary: match[2] !== undefined,
      bounds: width > 0 && height > 0 ? { width, height, x, y } : undefined,
    })
  }
  if (displays.length > 0 && !displays.some((display) => display.primary)) displays[0] = { ...displays[0]!, primary: true }
  return displays
}

export function parseWindows(text: string): Window[] {
  const windows: Window[] = []
  for (const line of text.split(/\r?\n/)) {
    const start = /^(\s*)(0x[0-9a-fA-F]+):?\s+(.*)$/.exec(line)
    if (!start) continue
    if ((start[1]?.length ?? 0) > 4) continue
    const id = start[2]
    if (!id || id === "0x0") continue
    const rest = start[3] ?? ""
    const geometry = /(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/.exec(rest)
    if (!geometry) continue
    const quoted = Array.from((rest.slice(0, geometry.index) ?? "").matchAll(/"((?:[^"\\]|\\.)*)"/g)).map((match) => match[1] ?? "")
    const bounds = {
      width: Number(geometry[1] ?? 0),
      height: Number(geometry[2] ?? 0),
      x: Number(geometry[3] ?? 0),
      y: Number(geometry[4] ?? 0),
    }
    if (bounds.width <= 0 || bounds.height <= 0) continue
    const title = unescapeX11(quoted.at(-1) ?? "")
    windows.push({ id, title: title || undefined, bounds, minimized: false })
  }
  return windows
}

export function parseWindowProps(id: string, text: string): Detail {
  const classes = quotedValues(text.match(/WM_CLASS(?:\([^)]*\))?\s*=\s*(.+)/)?.[1] ?? "")
  const title = text.match(/^WM_NAME(?:\([^)]*\))?\s*=\s*"((?:[^"\\]|\\.)*)"/m)?.[1]
  const states = new Set(
    Array.from(text.matchAll(/_NET_WM_STATE(?:\([^)]*\))?\s*=\s*(.+)/g)).flatMap((match) => atomValues(match[1] ?? "")),
  )
  const desktop = text.match(/_NET_WM_DESKTOP(?:\([^)]*\))?\s*=\s*(-?\d+)/)?.[1]
  const windowType = atomValues(text.match(/_NET_WM_WINDOW_TYPE(?:\([^)]*\))?\s*=\s*(.+)/)?.[1] ?? "")[0]
  const pid = Number(text.match(/_NET_WM_PID(?:\([^)]*\))?\s*=\s*(\d+)/)?.[1])
  return {
    ...(classes.length > 0 ? { app: classes.at(-1) } : {}),
    ...(title === undefined ? {} : { title: unescapeX11(title) }),
    ...(Number.isFinite(pid) && pid > 0 ? { pid } : {}),
    ...(states.has("_NET_WM_STATE_HIDDEN") ? { minimized: true } : {}),
    ...(desktop === undefined ? {} : { currentDesktop: desktop === "-1" || desktop === "0" }),
    ...(windowType === undefined ? {} : { windowType }),
  }
}

export function importArgs(target: CaptureTarget) {
  const args = target.kind === "window" ? ["-window", target.id] : ["-window", "root"]
  if (target.kind === "root" && target.crop)
    args.push("-crop", `${target.crop.width}x${target.crop.height}+${target.crop.x}+${target.crop.y}`, "+repage")
  return ["-silent", ...args, "png:-"]
}

export function xwdArgs(target: CaptureTarget) {
  return target.kind === "window" ? ["-silent", "-id", target.id] : ["-silent", "-root"]
}

export function formatList(displays: ReadonlyArray<Display>, windows: ReadonlyArray<Window>, truncated: boolean) {
  const displayLines = displays.length
    ? displays.map((display) =>
        [
          display.index,
          display.primary ? "(primary)" : undefined,
          display.bounds
            ? `${display.bounds.width}x${display.bounds.height} at ${display.bounds.x},${display.bounds.y}`
            : "unknown bounds",
          display.scale ? `scale ${display.scale}` : undefined,
        ]
          .filter(Boolean)
          .join(" "),
      )
    : ["none"]
  const windowLines = windows.length
    ? windows.map((window) =>
        [
          window.id,
          window.app,
          window.pid === undefined ? undefined : `pid ${window.pid}`,
          window.title ? JSON.stringify(window.title) : undefined,
          window.bounds ? `${window.bounds.width}x${window.bounds.height}` : undefined,
          window.display === undefined ? undefined : `display ${window.display}`,
          window.minimized ? "minimized" : undefined,
        ]
          .filter(Boolean)
          .join("  "),
      )
    : ["none"]
  const suffix = truncated ? ["  ... (showing first 50 windows)"] : []
  return [
    "Displays:",
    ...displayLines.map((line) => `  ${line}`),
    "Windows, front to back:",
    ...windowLines.map((line) => `  ${line}`),
    ...suffix,
  ].join("\n")
}

const command = (display: string, bin: string, args: ReadonlyArray<string>) =>
  ChildProcess.make(bin, [...args], { env: { DISPLAY: display }, extendEnv: true })

function run(
  process: AppProcess.Interface,
  display: string,
  bin: string,
  args: ReadonlyArray<string>,
  options: { readonly maxOutputBytes?: number; readonly stdin?: Uint8Array } = {},
): Effect.Effect<AppProcess.RunResult, CaptureError> {
  return Effect.gen(function* () {
    const result = yield* process
      .run(command(display, bin, args), {
        timeout: COMMAND_TIMEOUT,
        maxOutputBytes: options.maxOutputBytes ?? LIST_OUTPUT_BYTES,
        maxErrorBytes: ERROR_BYTES,
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      })
      .pipe(Effect.mapError(mapProcessError))
    if (result.exitCode === 0) return result
    return yield* new CaptureError({ code: classifyFailure(stderrText(result)), reason: failureReason(bin, result) })
  })
}

function tryRun(process: AppProcess.Interface, display: string, bin: string, args: ReadonlyArray<string>) {
  return run(process, display, bin, args).pipe(Effect.as(true), Effect.catch(() => Effect.succeed(false)))
}

function mapProcessError(error: AppProcess.AppProcessError): CaptureError {
  const detail = error.message
  if (detail.includes("Timed out")) return new CaptureError({ code: "timeout", reason: `${error.command} timed out` })
  if (detail.includes("ENOENT") || detail.includes("not found"))
    return new CaptureError({ code: "missing_dependency", reason: detail })
  return new CaptureError({ code: "unsupported", reason: detail })
}

function stderrText(result: AppProcess.RunResult) {
  return `${result.stderr.toString("utf8")}\n${result.stdout.toString("utf8")}`
}

function failureReason(bin: string, result: AppProcess.RunResult) {
  const detail = stderrText(result).trim()
  return `${bin} failed${detail ? `: ${detail}` : ""}`
}

function classifyFailure(text: string): CaptureError["code"] {
  if (/can'?t open display|cannot open display|unable to open display/i.test(text)) return "no_display"
  if (/bad\s*window|no such window|window is not/i.test(text)) return "window_not_found"
  if (/authorization required|cannot connect|permission denied/i.test(text)) return "permission_required"
  if (/command not found|no such file or directory|ENOENT/i.test(text)) return "missing_dependency"
  return "unsupported"
}

function collect(
  process: AppProcess.Interface,
  backend: X11Backend,
  display: string,
): Effect.Effect<Collected, CaptureError> {
  return Effect.gen(function* () {
    const displays = backend.xrandr ? yield* readDisplays(process, display) : defaultDisplays()
    const tree = yield* run(process, display, "xwininfo", ["-root", "-tree", "-display", display])
    const activeID = backend.xprop ? yield* readActiveWindow(process, display) : Option.none<string>()
    const raw = parseWindows(tree.stdout.toString("utf8"))
    const props = backend.xprop ? yield* readWindowProps(process, display, raw) : new Map<string, Detail>()
    const windows = assignDisplays(
      raw.map((window) => ({ ...window, ...(props.get(window.id) ?? {}) })),
      displays,
    )
    return { displays, windows, activeID: Option.getOrUndefined(activeID) }
  })
}

function readDisplays(process: AppProcess.Interface, display: string): Effect.Effect<Display[], CaptureError> {
  return run(process, display, "xrandr", ["--query", "--display", display]).pipe(
    Effect.map((result) => {
      const displays = parseDisplays(result.stdout.toString("utf8"))
      return displays.length ? displays : defaultDisplays()
    }),
    Effect.catch(() => Effect.succeed(defaultDisplays())),
  )
}

function defaultDisplays(): Display[] {
  return [{ index: 1, name: "screen", primary: true }]
}

function readActiveWindow(
  process: AppProcess.Interface,
  display: string,
): Effect.Effect<Option.Option<string>, CaptureError> {
  return run(process, display, "xprop", ["-root", "_NET_ACTIVE_WINDOW", "-display", display]).pipe(
    Effect.map((result) => {
      const id = result.stdout.toString("utf8").match(/0x[0-9a-fA-F]+/)?.[0]
      return id === undefined ? Option.none<string>() : Option.some(id)
    }),
    Effect.catch(() => Effect.succeed(Option.none<string>())),
  )
}

function readWindowProps(
  process: AppProcess.Interface,
  display: string,
  windows: ReadonlyArray<Window>,
): Effect.Effect<Map<string, Detail>, CaptureError> {
  return Effect.gen(function* () {
    const props = new Map<string, Detail>()
    for (const window of windows.slice(0, PROPERTY_WINDOW_LIMIT)) {
      const result = yield* run(
        process,
        display,
        "xprop",
        [
          "-id",
          window.id,
          "WM_CLASS",
          "_NET_WM_STATE",
          "_NET_WM_WINDOW_TYPE",
          "_NET_WM_PID",
          "_NET_WM_DESKTOP",
          "-display",
          display,
        ],
      ).pipe(Effect.map((result) => parseWindowProps(window.id, result.stdout.toString("utf8"))))
      props.set(window.id, result)
    }
    return props
  })
}

function assignDisplays(windows: ReadonlyArray<Window & Detail>, displays: ReadonlyArray<Display>): (Window & Detail)[] {
  return windows.map((window) => ({ ...window, display: displayFor(window, displays) }))
}

function displayFor(window: Window, displays: ReadonlyArray<Display>) {
  const bounds = window.bounds
  if (!bounds) return displays[0]?.index ?? 1
  const center = { x: bounds.x + Math.floor(bounds.width / 2), y: bounds.y + Math.floor(bounds.height / 2) }
  return (
    displays.find(
      (display) =>
        display.bounds &&
        center.x >= display.bounds.x &&
        center.x < display.bounds.x + display.bounds.width &&
        center.y >= display.bounds.y &&
        center.y < display.bounds.y + display.bounds.height,
    )?.index ??
    displays.find((display) => display.primary)?.index ??
    displays[0]?.index ??
    1
  )
}

function listable(window: Window & Detail) {
  if (!window.bounds || window.bounds.width <= 0 || window.bounds.height <= 0) return false
  return !window.windowType || !TOOL_TYPES.has(window.windowType)
}

function captureScreen(
  process: AppProcess.Interface,
  backend: X11Backend,
  display: string,
  input: Input,
): Effect.Effect<CaptureResult, CaptureError> {
  return Effect.gen(function* () {
    const displays = backend.xrandr ? yield* readDisplays(process, display) : defaultDisplays()
    const bounds = yield* screenBounds(input.display, displays)
    const data = yield* capturePng(process, backend, display, { kind: "root", crop: bounds })
    return yield* captureResult({
      data,
      display: screenDisplay(input.display, displays, bounds),
      target: "screen",
    })
  })
}

function screenBounds(
  selector: Input["display"],
  displays: ReadonlyArray<Display>,
): Effect.Effect<Bounds | undefined, CaptureError> {
  if (selector === "all") return Effect.succeed(undefined)
  const chosen =
    typeof selector === "number"
      ? displays.find((display) => display.index === selector)
      : displays.find((display) => display.primary) ?? displays[0]
  if (typeof selector === "number" && !chosen)
    return Effect.fail(new CaptureError({ code: "unsupported", reason: `display ${selector} was not found` }))
  return Effect.succeed(chosen?.bounds)
}

function captureWindow(
  process: AppProcess.Interface,
  backend: X11Backend,
  display: string,
  input: Input,
): Effect.Effect<CaptureResult, CaptureError> {
  return Effect.gen(function* () {
    const selector = input.window?.trim()
    if (!selector)
      return yield* new CaptureError({ code: "window_not_found", reason: "target window requires a window selector" })
    const collected = yield* collect(process, backend, display)
    const selected = selectWindow(collected.windows, selector, collected.activeID)
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

    const restore = window.minimized
      ? yield* restoreWindow(process, display, window.id, collected.activeID)
      : { ok: true, focusChanged: false }
    if (!restore.ok)
      return yield* new CaptureError({ code: "window_not_capturable", reason: "window could not be restored for capture" })

    const data = yield* capturePng(process, backend, display, { kind: "window", id: window.id })
    if (window.minimized) yield* minimizeWindow(process, display, window.id, restore.focusChanged, collected.activeID)
    return yield* captureResult({
      data,
      target: "window",
      display: window.display,
      window: { id: window.id, app: window.app, pid: window.pid, title: window.title },
      restored: window.minimized,
      focusChanged: restore.focusChanged,
      others: selected.match.others.slice(0, MAX_OTHERS).map(summarize),
    })
  })
}

type CaptureTarget = { kind: "root"; crop?: Bounds } | { kind: "window"; id: string }

function capturePng(
  process: AppProcess.Interface,
  backend: X11Backend,
  display: string,
  target: CaptureTarget,
): Effect.Effect<Uint8Array, CaptureError> {
  return Effect.gen(function* () {
    if (backend.capture === "import") {
      const result = yield* run(process, display, "import", importArgs(target), { maxOutputBytes: CAPTURE_OUTPUT_BYTES })
      return yield* pngBytes(result.stdout, result.stdoutTruncated)
    }

    const xwd = yield* run(process, display, "xwd", xwdArgs(target), { maxOutputBytes: CAPTURE_OUTPUT_BYTES })
    if (xwd.stdout.length === 0) return yield* new CaptureError({ code: "unsupported", reason: "xwd produced no data" })
    const converter = backend.converter ?? "convert"
    const converted = yield* process
      .run(command(display, converter, ["xwd:-", "png:-"]), {
        timeout: COMMAND_TIMEOUT,
        maxOutputBytes: CAPTURE_OUTPUT_BYTES,
        maxErrorBytes: ERROR_BYTES,
        stdin: xwd.stdout,
      })
      .pipe(Effect.mapError(mapProcessError))
    if (converted.exitCode !== 0)
      return yield* new CaptureError({
        code: classifyFailure(stderrText(converted)),
        reason: failureReason(converter, converted),
      })
    return yield* pngBytes(converted.stdout, converted.stdoutTruncated)
  })
}

function pngBytes(bytes: Buffer, truncated: boolean): Effect.Effect<Uint8Array, CaptureError> {
  if (truncated)
    return Effect.fail(new CaptureError({ code: "unsupported", reason: "screenshot is larger than the 25 MB capture limit" }))
  if (bytes.length === 0)
    return Effect.fail(new CaptureError({ code: "unsupported", reason: "capture command produced no image data" }))
  return Effect.succeed(new Uint8Array(bytes))
}

function screenDisplay(selector: Input["display"], displays: ReadonlyArray<Display>, bounds?: Bounds) {
  if (selector === "all") return "all" as const
  if (typeof selector === "number") return selector
  return bounds ? displays.find((display) => display.bounds === bounds)?.index : displays.find((display) => display.primary)?.index
}

function captureResult(input: {
  data: Uint8Array
  target: Input["target"]
  display?: number | "all"
  window?: { id: string; app?: string; pid?: number; title?: string }
  restored?: boolean
  focusChanged?: boolean
  others?: ReadonlyArray<string>
}): Effect.Effect<CaptureResult, CaptureError> {
  const dimensions = imageDimensions(input.data)
  if (!dimensions)
    return Effect.fail(new CaptureError({ code: "unsupported", reason: "capture command did not produce a PNG image" }))
  return Effect.succeed({
    data: input.data,
    mime: "image/png",
    width: dimensions.width,
    height: dimensions.height,
    target: input.target,
    display: input.display,
    window: input.window,
    restored: input.restored ?? false,
    focusChanged: input.focusChanged ?? false,
    backend: "x11",
    platform: "linux",
    others: input.others?.length ? input.others : undefined,
  })
}

function restoreWindow(
  process: AppProcess.Interface,
  display: string,
  id: string,
  activeID?: string,
): Effect.Effect<RestoreResult, CaptureError> {
  return Effect.gen(function* () {
    const restored =
      (yield* tryRun(process, display, "xdotool", ["windowstate", "--remove", "_NET_WM_STATE_HIDDEN", id])) ||
      (yield* tryRun(process, display, "xdotool", ["windowmap", id]))
    if (restored) return { ok: true, focusChanged: false }
    const activated = yield* tryRun(process, display, "xdotool", ["windowactivate", "--sync", id])
    return {
      ok: activated,
      focusChanged: activated && activeID !== undefined && !sameWindowId(activeID, id),
    }
  })
}

function minimizeWindow(
  process: AppProcess.Interface,
  display: string,
  id: string,
  focusChanged: boolean,
  activeID?: string,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    yield* run(process, display, "xdotool", ["windowminimize", id]).pipe(
      Effect.tapError((error) => Effect.logWarning("failed to re-minimize captured window", { error })),
      Effect.ignore,
    )
    if (!focusChanged || !activeID) return
    yield* run(process, display, "xdotool", ["windowactivate", "--sync", activeID]).pipe(Effect.ignore)
  })
}

function quotedValues(text: string) {
  return Array.from(text.matchAll(/"((?:[^"\\]|\\.)*)"/g)).map((match) => unescapeX11(match[1] ?? ""))
}

function atomValues(text: string) {
  return text
    .split(",")
    .map((value) => value.trim().match(/_NET_[A-Z0-9_]+/)?.[0])
    .filter((value): value is string => value !== undefined)
}

function unescapeX11(value: string) {
  return value.replace(/\\(.)/g, "$1")
}
