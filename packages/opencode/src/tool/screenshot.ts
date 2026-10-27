import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { imageDimensions } from "@opencode-ai/core/image/dimensions"
import { ScreenCapture } from "@opencode-ai/core/screen-capture/index"
import { ScreenCaptureSchema } from "@opencode-ai/core/screen-capture/schema"
import { ScreenshotStorage } from "@opencode-ai/core/screen-capture/storage"
import { captureText, isLikelyBlank, permissionResource, screenshotSlug } from "@opencode-ai/core/tool/screenshot"
import { Image } from "@/image/image"
import { PartID } from "@/session/schema"
import DESCRIPTION from "./screenshot.txt"

export const Parameters = ScreenCaptureSchema.Input

type Metadata = ScreenCaptureSchema.Metadata

export const ScreenshotTool = Tool.define<
  typeof Parameters,
  Metadata,
  ScreenCapture.Service | ScreenshotStorage.Service | Image.Service
>(
  "screenshot",
  Effect.gen(function* () {
    const capture = yield* ScreenCapture.Service
    const storage = yield* ScreenshotStorage.Service
    const image = yield* Image.Service

    const run = Effect.fn("ScreenshotTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const selector = params.window?.trim()
      if (params.target === "window" && !selector) {
        return yield* Effect.fail(
          new Error("window_not_found: target window requires a window id, app name, or title substring."),
        )
      }
      if (!Number.isInteger(params.delay_ms) || params.delay_ms < 0 || params.delay_ms > 10_000) {
        return yield* Effect.fail(new Error("delay_ms must be an integer between 0 and 10000."))
      }

      const input = { ...params, ...(selector ? { window: selector } : {}) }
      yield* ctx.ask({
        permission: "screenshot",
        patterns: [permissionResource(input)],
        always: ["*"],
        metadata: {
          action: input.action,
          target: input.target,
          display: input.display,
          window: input.window,
        },
      })

      if (params.action === "list") {
        const result = yield* capture.list({ x_display: params.x_display })
        return {
          title: "Displays and windows",
          output: result.text,
          metadata: {
            action: "list" as const,
            text: result.text,
            displays: result.displays,
            windows: result.windows,
            truncated: result.truncated,
            shown: false as const,
          },
        }
      }

      const result = yield* capture.capture(input)
      if (isLikelyBlank(result.data)) {
        return yield* Effect.fail(
          new Error(
            "blank_capture: uniform frame: this can happen on a locked screen, disconnected RDP session, protected window, or when X11 capture lacks permission",
          ),
        )
      }

      const raw = Buffer.from(result.data).toString("base64")
      const rawInput = {
        id: PartID.ascending(),
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        type: "file" as const,
        mime: result.mime,
        filename: "screenshot.png",
        url: `data:${result.mime};base64,${raw}`,
      }
      const normalized = yield* image.normalize(rawInput).pipe(
        Effect.catchIf(
          (error) => error instanceof Image.ResizerUnavailableError,
          () => Effect.succeed(rawInput),
        ),
      )
      const saved = yield* storage.write({ data: result.data, slug: screenshotSlug(input) })
      const base64 = normalized.url.slice(normalized.url.indexOf(";base64,") + ";base64,".length)
      const shownBytes = Buffer.from(base64, "base64")
      const parsed = imageDimensions(new Uint8Array(shownBytes))
      const shown = {
        width: parsed?.width ?? result.width,
        height: parsed?.height ?? result.height,
        bytes: shownBytes.length,
        mime: normalized.mime,
      }

      return {
        title: screenshotTitle(result),
        output: captureText(saved, result, shown),
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
          ...(shown.width !== result.width || shown.height !== result.height || shown.bytes !== saved.bytes
            ? { capturedFrom: { width: result.width, height: result.height, bytes: saved.bytes } }
            : {}),
          restored: result.restored,
          focusChanged: result.focusChanged,
          backend: result.backend,
          platform: result.platform,
          ...(params.caption === undefined ? {} : { caption: params.caption }),
          ...(result.others === undefined ? {} : { others: result.others }),
          shown: true as const,
          truncated: false as const,
        },
        attachments: [
          {
            type: "file" as const,
            mime: shown.mime,
            url: normalized.url,
            filename: saved.name,
          },
        ],
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.mapError(toError), Effect.orDie),
    }
  }),
)

function screenshotTitle(result: ScreenCaptureSchema.CaptureResult) {
  if (result.target === "window")
    return `Screenshot: ${result.window?.app || result.window?.title || result.window?.id || "window"}`
  return `Screenshot: display ${result.display ?? "primary"}`
}

function toError(error: unknown) {
  if (error instanceof Error) return error
  return new Error(String(error))
}

export * as Screenshot from "./screenshot"
