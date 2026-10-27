export * as ShowImageTool from "./show-image"

import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { basename } from "node:path"
import { pathToFileURL } from "node:url"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Image } from "../image"
import { imageDimensions } from "../image/dimensions"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { ScreenshotStorage } from "../screen-capture/storage"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import DESCRIPTION from "./show-image.txt"

export const name = "show_image"

const MAX_RAW_BYTES = 20 * 1024 * 1024

const MIME_LABELS = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/gif": "GIF",
  "image/webp": "WEBP",
} as const

export const Input = Schema.Struct({
  path: Schema.String.annotate({ description: "The absolute or relative path to the image file to show" }),
  caption: Schema.optional(Schema.String).annotate({
    description: "Optional short caption shown with the image",
  }),
})
export type Input = typeof Input.Type

export const Metadata = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  mime: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  bytes: Schema.Number,
  caption: Schema.optional(Schema.String),
  resizedFrom: Schema.optional(
    Schema.Struct({
      width: Schema.Number,
      height: Schema.Number,
      bytes: Schema.Number,
    }),
  ),
  shown: Schema.Literal(true),
  truncated: Schema.Literal(false),
})
export type Metadata = typeof Metadata.Type

export const Output = Schema.Struct({
  text: Schema.String,
  content: Schema.Struct({
    base64: Schema.String,
    mime: Schema.String,
    name: Schema.String,
  }),
  metadata: Metadata,
})
export type Output = typeof Output.Type

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const mutation = yield* LocationMutation.Service
    const image = yield* Image.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description: DESCRIPTION.replaceAll("{{screenshots_dir}}", ScreenshotStorage.directory(global)),
            input: Input,
            output: Output,
            structured: Metadata,
            toStructuredOutput: ({ output }) => output.metadata,
            toModelOutput: ({ output }) => [
              { type: "text", text: output.text },
              {
                type: "file",
                data: output.content.base64,
                mime: output.content.mime,
                name: output.content.name,
              },
            ],
            execute: (input, context) =>
              Effect.gen(function* () {
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                const target = yield* mutation.resolve({ path: input.path, kind: "file" })
                const external = target.externalDirectory
                if (external)
                  yield* permission.assert({
                    ...LocationMutation.externalDirectoryPermission(external),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                yield* permission.assert({
                  action: "read",
                  resources: [target.resource],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })

                const canonical = target.canonical
                const name = basename(canonical)
                const stat = yield* fs.stat(canonical).pipe(
                  Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)),
                )
                if (!stat)
                  return yield* new ToolFailure({
                    message: `File not found: ${canonical}. Check the path, or use glob/read to find it.`,
                  })
                if (stat.type === "Directory")
                  return yield* new ToolFailure({
                    message: `Cannot show a directory: ${canonical}. Use read to list it, then show an image file.`,
                  })

                const rawBytes = Number(stat.size)
                if (rawBytes > MAX_RAW_BYTES)
                  return yield* new ToolFailure({
                    message: `Cannot show this image: ${name} is ${humanSize(rawBytes)} (${rawBytes} bytes), over the 20 MB limit. Resize it below 20 MB and try again.`,
                  })

                const bytes = yield* fs.readFile(canonical)
                const original = imageDimensions(bytes)
                if (!original) {
                  const label = unsupportedFormat(bytes)
                  return yield* new ToolFailure({
                    message: label
                      ? `Unsupported image format: ${label}. Convert it to PNG, JPEG, GIF or WebP first.`
                      : "Unsupported image format. Convert it to PNG, JPEG, GIF or WebP first.",
                  })
                }

                const content: FileSystem.Content & { readonly encoding: "base64" } = {
                  uri: pathToFileURL(canonical).href,
                  name,
                  content: Buffer.from(bytes).toString("base64"),
                  encoding: "base64",
                  mime: original.mime,
                }
                const normalized = yield* image.normalize(target.resource, content).pipe(
                  Effect.catchTag("Image.ResizerUnavailableError", () => Effect.succeed(content)),
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Could not normalize image ${name}: ${error.message}` }),
                  ),
                )

                const finalBytes = Buffer.from(normalized.content, "base64")
                const final = imageDimensions(finalBytes)
                if (!final)
                  return yield* new ToolFailure({ message: `The normalized image could not be read: ${name}.` })

                const resized =
                  final.width !== original.width ||
                  final.height !== original.height ||
                  finalBytes.length !== bytes.length
                return {
                  text: `Shown to the user: ${name} (${MIME_LABELS[final.mime]}, ${final.width}x${final.height}, ${humanSize(finalBytes.length)}).`,
                  content: {
                    base64: normalized.content,
                    mime: final.mime,
                    name,
                  },
                  metadata: {
                    path: canonical,
                    name,
                    mime: final.mime,
                    width: final.width,
                    height: final.height,
                    bytes: finalBytes.length,
                    ...(input.caption !== undefined ? { caption: input.caption } : {}),
                    ...(resized
                      ? { resizedFrom: { width: original.width, height: original.height, bytes: bytes.length } }
                      : {}),
                    shown: true as const,
                    truncated: false as const,
                  },
                }
              }).pipe(
                Effect.mapError((error) =>
                  error instanceof ToolFailure ? error : new ToolFailure({ message: `Unable to show ${input.path}` }),
                ),
              ),
          }),
          "read",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

function unsupportedFormat(bytes: Uint8Array) {
  if (bytes.length === 0) return
  const text = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase()
  if (text.startsWith("<svg") || text.startsWith("<?xml")) return "SVG"
  if (startsWith(bytes, [0x42, 0x4d])) return "BMP"
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return "TIFF"
  const brand = ascii(bytes, 8, 4)
  if (ascii(bytes, 4, 4) === "ftyp" && ["heic", "heix", "hevc", "mif1", "avif", "avis"].includes(brand))
    return "HEIC or AVIF"
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]) {
  return prefix.every((value, index) => bytes[index] === value)
}

function ascii(bytes: Uint8Array, offset: number, length: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + length)).toLowerCase()
}

function humanSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const node = makeLocationNode({
  name: "tool/show-image",
  layer,
  deps: [ToolRegistry.node, FSUtil.node, Global.node, LocationMutation.node, Image.node, PermissionV2.node],
})
