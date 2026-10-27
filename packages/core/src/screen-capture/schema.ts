export * as ScreenCaptureSchema from "./schema"

import { Effect, Schema } from "effect"

export const ErrorCode = Schema.Literals([
  "no_display",
  "no_interactive_session",
  "permission_required",
  "missing_dependency",
  "window_not_found",
  "window_not_capturable",
  "blank_capture",
  "unsupported",
  "timeout",
])
export type ErrorCode = typeof ErrorCode.Type

export class CaptureError extends Schema.TaggedErrorClass<CaptureError>()("ScreenCapture.CaptureError", {
  code: ErrorCode,
  reason: Schema.String,
  candidates: Schema.optional(Schema.Array(Schema.String)),
}) {
  override get message() {
    const candidates = this.candidates?.length ? ` Candidates: ${this.candidates.join(", ")}.` : ""
    return `${this.code}: ${this.reason}${candidates}`
  }
}

export const Action = Schema.Literals(["capture", "list"])
export const Target = Schema.Literals(["screen", "window"])
export const DisplaySelector = Schema.Union([
  Schema.Literals(["primary", "all"]),
  Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
])

export const Input = Schema.Struct({
  action: Action.pipe(Schema.withDecodingDefault(Effect.succeed("capture" as const))).annotate({
    description: 'Use "list" to inspect displays and windows, or "capture" to take a screenshot',
  }),
  target: Target.pipe(Schema.withDecodingDefault(Effect.succeed("screen" as const))).annotate({
    description: "Capture the screen or one window",
  }),
  display: DisplaySelector.pipe(Schema.withDecodingDefault(Effect.succeed("primary" as const))).annotate({
    description: 'Screen target: "primary", "all", or a 1-based display index from list',
  }),
  window: Schema.optional(Schema.String).annotate({
    description: "Required for target window: window id, app name, or case-insensitive title substring",
  }),
  restore_minimized: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))).annotate({
    description: "Temporarily restore a minimized window, capture it, then minimize it again",
  }),
  delay_ms: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))).annotate({
    description: "Wait before capturing, for example after launching an app (0-10000 ms)",
  }),
  x_display: Schema.optional(Schema.String).annotate({
    description: "X11 display override, for example :99 for Xvfb. Linux and WSL only",
  }),
  caption: Schema.optional(Schema.String).annotate({ description: "Optional short caption and alt text" }),
})
export type Input = typeof Input.Type

export const Bounds = Schema.Struct({
  width: Schema.Number,
  height: Schema.Number,
  x: Schema.Number,
  y: Schema.Number,
})
export type Bounds = typeof Bounds.Type

export const Display = Schema.Struct({
  index: Schema.Number,
  name: Schema.String,
  primary: Schema.Boolean,
  bounds: Schema.optional(Bounds),
  scale: Schema.optional(Schema.Number),
})
export type Display = typeof Display.Type

export const Window = Schema.Struct({
  id: Schema.String,
  app: Schema.optional(Schema.String),
  pid: Schema.optional(Schema.Number),
  title: Schema.optional(Schema.String),
  bounds: Schema.optional(Bounds),
  display: Schema.optional(Schema.Number),
  minimized: Schema.Boolean,
  currentDesktop: Schema.optional(Schema.Boolean),
})
export type Window = typeof Window.Type

export const Content = Schema.Struct({
  base64: Schema.String,
  mime: Schema.String,
  name: Schema.String,
})
export type Content = typeof Content.Type

const CaptureWindow = Schema.Struct({
  id: Schema.String,
  app: Schema.optional(Schema.String),
  pid: Schema.optional(Schema.Number),
  title: Schema.optional(Schema.String),
})

const ResizedFrom = Schema.Struct({
  width: Schema.Number,
  height: Schema.Number,
  bytes: Schema.Number,
})

export const CaptureMetadata = Schema.Struct({
  action: Schema.Literal("capture"),
  path: Schema.String,
  name: Schema.String,
  mime: Schema.String,
  target: Target,
  display: Schema.optional(Schema.Union([Schema.Number, Schema.Literal("all")])),
  window: Schema.optional(CaptureWindow),
  width: Schema.Number,
  height: Schema.Number,
  bytes: Schema.Number,
  savedBytes: Schema.Number,
  capturedFrom: Schema.optional(ResizedFrom),
  restored: Schema.Boolean,
  focusChanged: Schema.Boolean,
  backend: Schema.Literals(["x11", "wayland", "windows", "wsl", "macos"]),
  platform: Schema.Literals(["linux", "darwin", "win32", "unknown"]),
  caption: Schema.optional(Schema.String),
  others: Schema.optional(Schema.Array(Schema.String)),
  shown: Schema.Literal(true),
  truncated: Schema.Literal(false),
})
export type CaptureMetadata = typeof CaptureMetadata.Type

export const ListMetadata = Schema.Struct({
  action: Schema.Literal("list"),
  text: Schema.String,
  displays: Schema.Array(Display),
  windows: Schema.Array(Window),
  truncated: Schema.Boolean,
  shown: Schema.Literal(false),
})
export type ListMetadata = typeof ListMetadata.Type

export const Metadata = Schema.Union([CaptureMetadata, ListMetadata])
export type Metadata = typeof Metadata.Type

export const Output = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("capture"),
    text: Schema.String,
    content: Content,
    metadata: CaptureMetadata,
  }),
  Schema.Struct({
    action: Schema.Literal("list"),
    text: Schema.String,
    metadata: ListMetadata,
  }),
])
export type Output = typeof Output.Type

export const ListResult = Schema.Struct({
  text: Schema.String,
  displays: Schema.Array(Display),
  windows: Schema.Array(Window),
  truncated: Schema.Boolean,
})
export type ListResult = typeof ListResult.Type

export const CaptureResult = Schema.Struct({
  data: Schema.Uint8Array,
  mime: Schema.Literal("image/png"),
  width: Schema.Number,
  height: Schema.Number,
  target: Target,
  display: Schema.optional(Schema.Union([Schema.Number, Schema.Literal("all")])),
  window: Schema.optional(CaptureWindow),
  restored: Schema.Boolean,
  focusChanged: Schema.Boolean,
  backend: Schema.Literal("x11"),
  platform: Schema.Literal("linux"),
  others: Schema.optional(Schema.Array(Schema.String)),
})
export type CaptureResult = typeof CaptureResult.Type

export const Backend = Schema.Struct({
  kind: Schema.Literal("x11"),
  display: Schema.String,
  capture: Schema.Literals(["import", "xwd"]),
  converter: Schema.optional(Schema.String),
  xrandr: Schema.Boolean,
  xprop: Schema.Boolean,
  xdotool: Schema.Boolean,
})
export type Backend = typeof Backend.Type
