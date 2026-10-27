export * as ScreenshotTool from "./screenshot"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { Image } from "../image"
import { imageDimensions } from "../image/dimensions"
import { PermissionV2 } from "../permission"
import { ScreenCapture } from "../screen-capture"
import { ScreenCaptureBlank } from "../screen-capture/blank"
import { ScreenCaptureSchema } from "../screen-capture/schema"
import { ScreenshotStorage } from "../screen-capture/storage"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import DESCRIPTION from "./screenshot.txt"

export const name = "screenshot"

export const Input = ScreenCaptureSchema.Input
export type Input = Schema.Schema.Type<typeof Input>

const Content = Schema.Struct({
  base64: Schema.String,
  mime: Schema.String,
  name: Schema.String,
})

const Output = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("capture"),
    text: Schema.String,
    content: Content,
    metadata: ScreenCaptureSchema.CaptureMetadata,
  }),
  Schema.Struct({
    action: Schema.Literal("list"),
    text: Schema.String,
    metadata: ScreenCaptureSchema.ListMetadata,
  }),
])
type Output = typeof Output.Type

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const capture = yield* ScreenCapture.Service
    const storage = yield* ScreenshotStorage.Service
    const image = yield* Image.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description: DESCRIPTION,
            input: Input,
            output: Output,
            structured: ScreenCaptureSchema.Metadata,
            toStructuredOutput: ({ output }) => output.metadata,
            toModelOutput: ({ output }) =>
              output.action === "capture"
                ? [
                    { type: "text", text: output.text },
                    { type: "file", data: output.content.base64, mime: output.content.mime, name: output.content.name },
                  ]
                : [{ type: "text", text: output.text }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                const selector = input.window?.trim()
                if (input.target === "window" && !selector)
                  return yield* new ToolFailure({
                    message: "window_not_found: target window requires a window id, app name, or title substring.",
                  })
                if (!Number.isInteger(input.delay_ms) || input.delay_ms < 0 || input.delay_ms > 10_000)
                  return yield* new ToolFailure({
                    message: "delay_ms must be an integer between 0 and 10000.",
                  })

                yield* permission.assert({
                  action: name,
                  resources: [permissionResource(input)],
                  save: ["*"],
                  metadata: {
                    action: input.action,
                    target: input.target,
                    display: input.display,
                    window: input.window,
                  },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })

                if (input.action === "list") {
                  const result = yield* capture.list({ x_display: input.x_display })
                  return {
                    action: "list" as const,
                    text: result.text,
                    metadata: {
                      action: "list" as const,
                      text: result.text,
                      displays: result.displays,
                      windows: result.windows,
                      truncated: result.truncated,
                      shown: false as const,
                    },
                  } satisfies Output
                }

                const result = yield* capture.capture(input)
                if (isLikelyBlank(result.data))
                  return yield* new ToolFailure({
                    message:
                      "blank_capture: uniform frame: this can happen on a locked screen, disconnected RDP session, protected window, or when X11 capture lacks permission",
                  })

                const rawContent: FileSystem.Content & { readonly encoding: "base64" } = {
                  uri: `screenshot:${input.target}`,
                  name: "screenshot.png",
                  content: Buffer.from(result.data).toString("base64"),
                  encoding: "base64",
                  mime: result.mime,
                }
                const normalized = yield* image.normalize("screenshot", rawContent).pipe(
                  Effect.catchTag("Image.ResizerUnavailableError", () => Effect.succeed(rawContent)),
                )
                const saved = yield* storage.write({ data: result.data, slug: screenshotSlug(input) })
                const shownBytes = Buffer.from(normalized.content, "base64")
                const parsed = imageDimensions(new Uint8Array(shownBytes))
                const shown = {
                  width: parsed?.width ?? result.width,
                  height: parsed?.height ?? result.height,
                  bytes: shownBytes.length,
                  mime: normalized.mime,
                }
                const resized = shown.width !== result.width || shown.height !== result.height || shown.bytes !== saved.bytes
                return {
                  action: "capture" as const,
                  text: captureText(saved, result, shown),
                  content: {
                    base64: normalized.content,
                    mime: shown.mime,
                    name: saved.name,
                  },
                  metadata: {
                    action: "capture" as const,
                    path: saved.path,
                    name: saved.name,
                    mime: shown.mime,
                    target: result.target,
                    ...(result.display === undefined ? {} : { display: result.display }),
                    ...(result.window === undefined ? {} : { window: result.window }),
                    width: shown.width,
                    height: shown.height,
                    bytes: shown.bytes,
                    savedBytes: saved.bytes,
                    ...(resized
                      ? { capturedFrom: { width: result.width, height: result.height, bytes: saved.bytes } }
                      : {}),
                    restored: result.restored,
                    focusChanged: result.focusChanged,
                    backend: result.backend,
                    platform: result.platform,
                    ...(input.caption === undefined ? {} : { caption: input.caption }),
                    ...(result.others === undefined ? {} : { others: result.others }),
                    shown: true as const,
                    truncated: false as const,
                  },
                } satisfies Output
              }).pipe(Effect.mapError(toToolFailure)),
          }),
          name,
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export function permissionResource(input: Input) {
  if (input.action === "list") return "list"
  if (input.target === "window") return `window:${input.window?.trim().toLowerCase() ?? ""}`
  return "screen"
}

export function screenshotSlug(input: Input) {
  const parts: string[] = [input.target]
  if (input.target === "window" && input.window) parts.push(input.window)
  if (input.target === "screen") parts.push(String(input.display))
  return parts.join("-")
}

export function isLikelyBlank(data: Uint8Array) {
  return ScreenCaptureBlank.isLikelyBlankPng(data)
}

export function captureText(
  saved: ScreenshotStorage.Saved,
  result: ScreenCaptureSchema.CaptureResult,
  shown: { readonly width: number; readonly height: number; readonly bytes: number; readonly mime: string },
) {
  const lines = [
    `Saved and shown to the user: ${saved.path} (${mimeLabel(shown.mime)}, ${shown.width}x${shown.height}, ${humanSize(shown.bytes)}).`,
    result.target === "window"
      ? `Window: ${result.window?.id ?? "unknown"}${result.window?.app ? ` (${result.window.app})` : ""}${
          result.window?.title ? ` "${result.window.title}"` : ""
        }${result.display === undefined ? "" : ` on display ${result.display}`}.`
      : `Screen: display ${result.display ?? "primary"}.`,
  ]
  if (shown.width !== result.width || shown.height !== result.height || shown.bytes !== saved.bytes) {
    lines.push(
      `Full-resolution PNG saved: ${result.width}x${result.height}, ${humanSize(saved.bytes)}. The shown image was normalized.`,
    )
  }
  if (result.restored)
    lines.push(
      `Restored minimized window for capture and re-minimized it${result.focusChanged ? " after changing focus" : ""}.`,
    )
  if (result.others?.length) lines.push(`Other matches: ${result.others.join(", ")}.`)
  return lines.join("\n")
}

function mimeLabel(mime: string) {
  if (mime === "image/png") return "PNG"
  if (mime === "image/jpeg") return "JPEG"
  if (mime === "image/gif") return "GIF"
  if (mime === "image/webp") return "WEBP"
  return mime
}

function humanSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function toToolFailure(error: unknown) {
  if (error instanceof ToolFailure) return error
  if (error instanceof PermissionV2.BlockedError)
    return new ToolFailure({ message: "permission_required: screenshot capture is denied by the current permissions." })
  if (error instanceof ScreenCaptureSchema.CaptureError) return new ToolFailure({ message: error.message })
  if (error instanceof ScreenshotStorage.StorageError) return new ToolFailure({ message: error.message })
  if (error instanceof Image.DecodeError || error instanceof Image.SizeError)
    return new ToolFailure({ message: error.message })
  return new ToolFailure({ message: `Unable to capture the screen${error instanceof Error ? `: ${error.message}` : ""}` })
}

export const node = makeLocationNode({
  name: "tool/screenshot",
  layer,
  deps: [ToolRegistry.node, ScreenCapture.node, ScreenshotStorage.node, Image.node, PermissionV2.node],
})
