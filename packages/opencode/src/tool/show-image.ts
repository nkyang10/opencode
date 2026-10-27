import { Effect, Schema } from "effect"
import * as path from "path"
import * as Tool from "./tool"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { imageDimensions } from "@opencode-ai/core/image/dimensions"
import { InstanceState } from "@/effect/instance-state"
import { Image } from "@/image/image"
import { PartID } from "@/session/schema"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./show-image.txt"

const MAX_RAW_BYTES = 20 * 1024 * 1024

const MIME_LABELS = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/gif": "GIF",
  "image/webp": "WEBP",
} as const

export const Parameters = Schema.Struct({
  path: Schema.String.annotate({ description: "The absolute or relative path to the image file to show" }),
  caption: Schema.optional(Schema.String).annotate({
    description: "Optional short caption shown with the image",
  }),
})

type Metadata = {
  path: string
  name: string
  mime: string
  width: number
  height: number
  bytes: number
  caption?: string
  resizedFrom?: { width: number; height: number; bytes: number }
  shown: true
  truncated: false
}

export const ShowImageTool = Tool.define<
  typeof Parameters,
  Metadata,
  FSUtil.Service | Image.Service
>(
  "show_image",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const image = yield* Image.Service

    const unsupported = (bytes: Uint8Array) => {
      if (bytes.length === 0) return
      const text = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase()
      if (text.startsWith("<svg") || text.startsWith("<?xml")) return "SVG"
      if (startsWith(bytes, [0x42, 0x4d])) return "BMP"
      if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "TIFF"
      const brand = String.fromCharCode(...bytes.subarray(8, 12)).toLowerCase()
      if (String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp" && ["heic", "heix", "hevc", "mif1", "avif", "avis"].includes(brand))
        return "HEIC or AVIF"
    }

    const run = Effect.fn("ShowImageTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const instance = yield* InstanceState.context
      let filepath = params.path
      if (!path.isAbsolute(filepath)) {
        filepath = path.resolve(instance.directory, filepath)
      }
      if (process.platform === "win32") {
        filepath = FSUtil.normalizePath(filepath)
      }
      const name = path.basename(filepath)

      const stat = yield* fs.stat(filepath).pipe(
        Effect.catchIf(
          (err) => "reason" in err && err.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      )

      yield* assertExternalDirectoryEffect(ctx, filepath, { kind: "file" })

      yield* ctx.ask({
        permission: "read",
        patterns: [path.relative(instance.worktree, filepath)],
        always: ["*"],
        metadata: {},
      })

      if (!stat) {
        return yield* Effect.fail(
          new Error(`File not found: ${filepath}. Check the path, or use glob/read to find it.`),
        )
      }

      if (stat.type === "Directory") {
        return yield* Effect.fail(
          new Error(`Cannot show a directory: ${filepath}. Use read to list it, then show an image file.`),
        )
      }

      const rawBytes = Number(stat.size)
      if (rawBytes > MAX_RAW_BYTES) {
        return yield* Effect.fail(
          new Error(
            `Cannot show this image: ${name} is ${humanSize(rawBytes)} (${rawBytes} bytes), over the 20 MB limit. Resize it below 20 MB and try again.`,
          ),
        )
      }

      const bytes = yield* fs.readFile(filepath)
      const original = imageDimensions(bytes)
      if (!original) {
        const label = unsupported(bytes)
        return yield* Effect.fail(
          new Error(
            label
              ? `Unsupported image format: ${label}. Convert it to PNG, JPEG, GIF or WebP first.`
              : "Unsupported image format. Convert it to PNG, JPEG, GIF or WebP first.",
          ),
        )
      }

      const input = {
        id: PartID.ascending(),
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        type: "file" as const,
        mime: original.mime,
        filename: name,
        url: `data:${original.mime};base64,${Buffer.from(bytes).toString("base64")}`,
      }
      const normalized = yield* image.normalize(input).pipe(
        Effect.catchIf(
          (error) => error instanceof Image.ResizerUnavailableError,
          () => Effect.succeed(input),
        ),
        Effect.catch((error) => Effect.fail(new Error(`Could not normalize image ${name}: ${error.message}`))),
      )

      const base64 = normalized.url.slice(normalized.url.indexOf(";base64,") + ";base64,".length)
      const finalBytes = new Uint8Array(Buffer.from(base64, "base64"))
      const final = imageDimensions(finalBytes)
      if (!final) {
        return yield* Effect.fail(new Error(`The normalized image could not be read: ${name}.`))
      }

      const resized =
        final.width !== original.width || final.height !== original.height || finalBytes.length !== bytes.length
      const output = `Shown to the user: ${name} (${MIME_LABELS[final.mime]}, ${final.width}x${final.height}, ${humanSize(finalBytes.length)}).`

      return {
        title: name,
        output,
        metadata: {
          path: filepath,
          name,
          mime: final.mime,
          width: final.width,
          height: final.height,
          bytes: finalBytes.length,
          ...(params.caption !== undefined ? { caption: params.caption } : {}),
          ...(resized
            ? { resizedFrom: { width: original.width, height: original.height, bytes: bytes.length } }
            : {}),
          shown: true as const,
          truncated: false as const,
        },
        attachments: [
          {
            type: "file" as const,
            mime: final.mime,
            url: normalized.url,
            filename: name,
          },
        ],
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

function startsWith(bytes: Uint8Array, prefix: readonly number[]) {
  return prefix.every((value, index) => bytes[index] === value)
}

function humanSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export * as ShowImage from "./show-image"
