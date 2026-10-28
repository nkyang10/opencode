import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Config } from "@/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { MessageV2 } from "@/session/message-v2"
import photonWasm from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" }
import { Context, Effect, Layer, Schema } from "effect"
import path from "node:path"
import { fileURLToPath } from "node:url"

const MAX_BASE64_BYTES = 5 * 1024 * 1024
const MAX_WIDTH = 2000
const MAX_HEIGHT = 2000
const AUTO_RESIZE = true
const JPEG_QUALITIES = [80, 85, 70, 55, 40]
const PREVIEW_MAX_EDGE = 640
const PREVIEW_TARGET_BASE64_BYTES = 96 * 1024
// Below this the full image is already cheaper than a preview would be.
const PREVIEW_MIN_BASE64_BYTES = 32 * 1024
// A resize of something this large is not the "already in memory, one small resize" the preview is budgeted for.
const PREVIEW_MAX_SOURCE_EDGE = 8192

/**
 * A small JPEG of the same image, generated while it is already decoded. Only the browser copy uses it: the stored
 * attachment and the model request keep the full image.
 */
export interface Preview {
  readonly uri: string
  readonly mime: string
  readonly width: number
  readonly height: number
  readonly bytes: number
}
export class ResizerUnavailableError extends Schema.TaggedErrorClass<ResizerUnavailableError>()(
  "ImageResizerUnavailableError",
  {},
) {
  override get message() {
    return "Image resizer is unavailable"
  }
}

export class InvalidDataUrlError extends Schema.TaggedErrorClass<InvalidDataUrlError>()("ImageInvalidDataUrlError", {
  url: Schema.String,
}) {
  override get message() {
    return "Image URL must be a base64 data URL"
  }
}

export class DecodeError extends Schema.TaggedErrorClass<DecodeError>()("ImageDecodeError", {}) {
  override get message() {
    return "Image could not be decoded"
  }
}

export class SizeError extends Schema.TaggedErrorClass<SizeError>()("ImageSizeError", {
  bytes: Schema.Number,
  max: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  max_width: Schema.Number,
  max_height: Schema.Number,
}) {
  override get message() {
    return `Image ${this.width}x${this.height} with base64 size ${this.bytes} exceeds configured limits and could not be resized below ${this.max_width}x${this.max_height}/${this.max} bytes`
  }
}

export type Error = ResizerUnavailableError | InvalidDataUrlError | DecodeError | SizeError

export interface Interface {
  readonly normalize: (
    input: SessionV1.FilePart,
    options?: { readonly preview?: boolean },
  ) => Effect.Effect<SessionV1.FilePart & { readonly preview?: Preview }, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Image") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const loadPhoton = yield* Effect.cached(
      Effect.sync(() => {
        // Patched photon-node reads this during module init so Bun compiled binaries use the embedded wasm path.
        ;(globalThis as typeof globalThis & { __OPENCODE_PHOTON_WASM_PATH?: string }).__OPENCODE_PHOTON_WASM_PATH =
          path.isAbsolute(photonWasm) ? photonWasm : fileURLToPath(new URL(photonWasm, import.meta.url))
      }).pipe(
        Effect.andThen(() => Effect.tryPromise(() => import("@silvia-odwyer/photon-node"))),
        Effect.tapError((error) => Effect.logWarning("failed to load photon", { error })),
        Effect.mapError(() => new ResizerUnavailableError()),
      ),
    )

    const normalize = Effect.fn("Image.normalize")(function* (
      input: SessionV1.FilePart,
      options?: { readonly preview?: boolean },
    ) {
      const image = (yield* config.get()).attachment?.image
      const info = {
        autoResize: image?.auto_resize ?? AUTO_RESIZE,
        maxWidth: image?.max_width ?? MAX_WIDTH,
        maxHeight: image?.max_height ?? MAX_HEIGHT,
        maxBase64Bytes: image?.max_base64_bytes ?? MAX_BASE64_BYTES,
      }
      if (!input.url.startsWith("data:") || !input.url.includes(";base64,"))
        return yield* new InvalidDataUrlError({ url: input.url })

      const base64 = input.url.slice(input.url.indexOf(";base64,") + ";base64,".length)
      const bytes = Buffer.byteLength(base64, "utf8")

      const photon = yield* loadPhoton

      const decoded = yield* Effect.try({
        try: () => photon.PhotonImage.new_from_byteslice(Buffer.from(base64, "base64")),
        catch: () => new DecodeError(),
      }).pipe(Effect.tapError((error) => Effect.logWarning("failed to decode image", { error })))

      try {
        const originalWidth = decoded.get_width()
        const originalHeight = decoded.get_height()
        const preview = options?.preview
          ? yield* Effect.try({
              try: () => buildPreview(photon, decoded, originalWidth, originalHeight, bytes),
              catch: () => undefined,
            }).pipe(Effect.orElseSucceed(() => undefined))
          : undefined
        if (originalWidth <= info.maxWidth && originalHeight <= info.maxHeight && bytes <= info.maxBase64Bytes)
          return preview ? { ...input, preview } : input
        if (!info.autoResize)
          return yield* new SizeError({
            bytes,
            max: info.maxBase64Bytes,
            width: originalWidth,
            height: originalHeight,
            max_width: info.maxWidth,
            max_height: info.maxHeight,
          })

        const scale = Math.min(1, info.maxWidth / originalWidth, info.maxHeight / originalHeight)
        for (const size of Array.from({ length: 32 }).reduce<Array<{ width: number; height: number }>>((acc) => {
          const previous = acc.at(-1) ?? {
            width: Math.max(1, Math.round(originalWidth * scale)),
            height: Math.max(1, Math.round(originalHeight * scale)),
          }
          const next =
            acc.length === 0
              ? previous
              : {
                  width: previous.width === 1 ? 1 : Math.max(1, Math.floor(previous.width * 0.75)),
                  height: previous.height === 1 ? 1 : Math.max(1, Math.floor(previous.height * 0.75)),
                }
          return acc.some((item) => item.width === next.width && item.height === next.height) ? acc : [...acc, next]
        }, [])) {
          const resized = photon.resize(decoded, size.width, size.height, photon.SamplingFilter.Lanczos3)
          const candidate = [
            { data: Buffer.from(resized.get_bytes()).toString("base64"), mime: "image/png" },
            ...JPEG_QUALITIES.map((quality) => ({
              data: Buffer.from(resized.get_bytes_jpeg(quality)).toString("base64"),
              mime: "image/jpeg",
            })),
          ]
            .map((item) => ({ ...item, bytes: Buffer.byteLength(item.data, "utf8") }))
            .find((item) => item.bytes <= info.maxBase64Bytes)
          resized.free()

          if (candidate) {
            yield* Effect.logInfo("using resized image", {
              from_mime: input.mime,
              to_mime: candidate.mime,
              from: `${originalWidth}x${originalHeight}`,
              to: `${size.width}x${size.height}`,
            })
            return {
              ...input,
              mime: candidate.mime,
              url: `data:${candidate.mime};base64,${candidate.data}`,
              ...(preview ? { preview } : {}),
            }
          }
        }

        return yield* new SizeError({
          bytes,
          max: info.maxBase64Bytes,
          width: originalWidth,
          height: originalHeight,
          max_width: info.maxWidth,
          max_height: info.maxHeight,
        })
      } finally {
        decoded.free()
      }
    })

    return Service.of({ normalize })
  }),
)

type Photon = Awaited<typeof import("@silvia-odwyer/photon-node")>
type PhotonImage = ReturnType<Photon["PhotonImage"]["new_from_byteslice"]>

/**
 * One small JPEG from an image that is already decoded, so the browser does not have to carry the full frame. Returns
 * `undefined` when a preview is not worth its cost; a preview is never worth failing a tool result over, so callers
 * treat a throw the same way.
 */
function buildPreview(
  photon: Photon,
  decoded: PhotonImage,
  width: number,
  height: number,
  base64Bytes: number,
): Preview | undefined {
  if (base64Bytes < PREVIEW_MIN_BASE64_BYTES) return undefined
  if (Math.max(width, height) > PREVIEW_MAX_SOURCE_EDGE) return undefined
  const scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(width, height))
  const size = {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
  const resized = photon.resize(decoded, size.width, size.height, photon.SamplingFilter.Lanczos3)
  try {
    let smallest: Preview | undefined
    for (const quality of JPEG_QUALITIES) {
      const data = Buffer.from(resized.get_bytes_jpeg(quality)).toString("base64")
      const candidate: Preview = {
        uri: `data:image/jpeg;base64,${data}`,
        mime: "image/jpeg",
        width: size.width,
        height: size.height,
        bytes: Buffer.byteLength(data, "utf-8"),
      }
      if (candidate.bytes <= PREVIEW_TARGET_BASE64_BYTES) return candidate
      smallest = candidate
    }
    // Even the lowest quality is over budget, and the smallest frame still beats sending the full image.
    return smallest
  } finally {
    resized.free()
  }
}

export const node = LayerNode.make({ service: Service, layer: layer, deps: [Config.node] })

export * as Image from "./image"
