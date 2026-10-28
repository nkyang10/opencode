// @ts-ignore Bun's static file import is embedded by `bun build --compile`; some consumers also declare *.wasm.
import photonWasm from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" }
import { Effect } from "effect"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { FileSystem } from "../filesystem"
import { DecodeError, ResizerUnavailableError, SizeError } from "../image"
import type { Preview } from "../image"

const JPEG_QUALITIES = [80, 85, 70, 55, 40]
const PREVIEW_MAX_EDGE = 640
const PREVIEW_TARGET_BASE64_BYTES = 96 * 1024
// Below this the full image is already cheaper than a preview would be.
const PREVIEW_MIN_BASE64_BYTES = 32 * 1024
// A resize of something this large is not the "already in memory, one small resize" the preview is budgeted for.
const PREVIEW_MAX_SOURCE_EDGE = 8192

export const make = Effect.gen(function* () {
  ;(globalThis as typeof globalThis & { __OPENCODE_PHOTON_WASM_PATH?: string }).__OPENCODE_PHOTON_WASM_PATH =
    path.isAbsolute(photonWasm) ? photonWasm : fileURLToPath(new URL(photonWasm, import.meta.url))
  const loadPhoton = yield* Effect.cached(
    Effect.tryPromise({
      try: () => import("@silvia-odwyer/photon-node"),
      catch: () => new ResizerUnavailableError(),
    }),
  )
  return Effect.fn("Image.Photon.normalize")(function* (
    resource: string,
    content: FileSystem.Content & { readonly encoding: "base64" },
    limits: {
      readonly autoResize: boolean
      readonly maxWidth: number
      readonly maxHeight: number
      readonly maxBase64Bytes: number
      readonly preview: boolean
    },
  ) {
    const photon = yield* loadPhoton
    const decoded = yield* Effect.try({
      try: () => photon.PhotonImage.new_from_byteslice(Buffer.from(content.content, "base64")),
      catch: () => new DecodeError({ resource }),
    })
    try {
      const width = decoded.get_width()
      const height = decoded.get_height()
      const bytes = Buffer.byteLength(content.content, "utf-8")
      const preview = limits.preview
        ? yield* Effect.try({
            try: () => buildPreview(photon, decoded, width, height, bytes),
            catch: () => undefined,
          }).pipe(Effect.orElseSucceed(() => undefined))
        : undefined
      if (width <= limits.maxWidth && height <= limits.maxHeight && bytes <= limits.maxBase64Bytes)
        return preview ? { ...content, preview } : content
      if (!limits.autoResize)
        return yield* new SizeError({
          resource,
          width,
          height,
          bytes,
          maxWidth: limits.maxWidth,
          maxHeight: limits.maxHeight,
          maxBytes: limits.maxBase64Bytes,
        })
      const scale = Math.min(1, limits.maxWidth / width, limits.maxHeight / height)
      const sizes = Array.from({ length: 32 }).reduce<Array<{ width: number; height: number }>>((acc) => {
        const previous = acc.at(-1) ?? {
          width: Math.max(1, Math.round(width * scale)),
          height: Math.max(1, Math.round(height * scale)),
        }
        const next =
          acc.length === 0
            ? previous
            : {
                width: previous.width === 1 ? 1 : Math.max(1, Math.floor(previous.width * 0.75)),
                height: previous.height === 1 ? 1 : Math.max(1, Math.floor(previous.height * 0.75)),
              }
        return acc.some((item) => item.width === next.width && item.height === next.height) ? acc : [...acc, next]
      }, [])
      for (const size of sizes) {
        const resized = photon.resize(decoded, size.width, size.height, photon.SamplingFilter.Lanczos3)
        try {
          const encoders: Array<readonly [mime: string, encode: () => Uint8Array]> = [
            ["image/png", () => resized.get_bytes()],
            ...JPEG_QUALITIES.map((quality) => ["image/jpeg", () => resized.get_bytes_jpeg(quality)] as const),
          ]
          for (const [mime, encode] of encoders) {
            const candidate = Buffer.from(encode()).toString("base64")
            if (Buffer.byteLength(candidate, "utf-8") <= limits.maxBase64Bytes)
              return {
                ...content,
                content: candidate,
                encoding: "base64" as const,
                mime,
                ...(preview ? { preview } : {}),
              }
          }
        } finally {
          resized.free()
        }
      }
      return yield* new SizeError({
        resource,
        width,
        height,
        bytes,
        maxWidth: limits.maxWidth,
        maxHeight: limits.maxHeight,
        maxBytes: limits.maxBase64Bytes,
      })
    } finally {
      decoded.free()
    }
  })
})

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
