import type { ImageViewerItem } from "@opencode-ai/ui/image-viewer"

const COPYABLE_IMAGE = /^image\/(png|jpeg|gif|webp)$/i
const CONVERT_TO_PNG = /^image\/(jpeg|gif|webp)$/i

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
}

export type ImageActionTarget = ImageViewerItem

export type ImageActionPlatform = "browser" | "desktop"

export type ImageCopyDisabledReason = "insecure-context" | "clipboard-unavailable" | "unsupported-image"

export type ImageActionAvailability = {
  open: boolean
  openInNewTab: boolean
  copyImage: boolean
  copyImageDisabledReason?: ImageCopyDisabledReason
  saveImage: boolean
  copyPath: boolean
  revealInFileManager: boolean
  attachToMessage: boolean
  goToMessage: boolean
}

export type ImageActionAvailabilityInput = {
  target: ImageViewerItem
  platform?: ImageActionPlatform
  secureContext?: boolean
  hasClipboardItem?: boolean
  canOpenInNewTab?: boolean
  canRevealPath?: boolean
  canAttachImage?: boolean
  inViewer?: boolean
}

export type PngConversionDecision = {
  copyable: boolean
  convert: boolean
  reason?: ImageCopyDisabledReason
}

export function dataUrlMime(dataUrl: string): string | undefined {
  if (!dataUrl.startsWith("data:")) return
  const comma = dataUrl.indexOf(",")
  if (comma === -1) return
  const header = dataUrl.slice(5, comma)
  const mime = header.split(";")[0]
  return mime || undefined
}

function base64ToBytes(value: string) {
  const binary = atob(value.replace(/\s/g, ""))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export function dataUrlToBlob(dataUrl: string): Blob {
  if (!dataUrl.startsWith("data:")) throw new Error("Not a data URL")
  const comma = dataUrl.indexOf(",")
  if (comma === -1) throw new Error("Invalid data URL")
  const header = dataUrl.slice(5, comma)
  const data = dataUrl.slice(comma + 1)
  const params = header.split(";")
  const mime = params[0] || "application/octet-stream"
  const isBase64 = params.some((param) => param.toLowerCase() === "base64")
  const bytes = isBase64 ? base64ToBytes(data) : new TextEncoder().encode(decodeURIComponent(data))
  return new Blob([bytes], { type: mime })
}

export function imageMime(target: Pick<ImageViewerItem, "src" | "mime">): string {
  return target.mime || dataUrlMime(target.src) || ""
}

export function isCopyableImage(target: Pick<ImageViewerItem, "src" | "mime">): boolean {
  if (!target.src.startsWith("data:")) return false
  return COPYABLE_IMAGE.test(imageMime(target))
}

export function shouldConvertToPng(mime: string): boolean {
  return CONVERT_TO_PNG.test(mime)
}

export function pngConversionDecision(target: Pick<ImageViewerItem, "src" | "mime">): PngConversionDecision {
  if (!isCopyableImage(target)) return { copyable: false, convert: false, reason: "unsupported-image" }
  return { copyable: true, convert: shouldConvertToPng(imageMime(target)) }
}

export function extensionForMime(mime: string): string {
  return EXTENSIONS[mime.toLowerCase()] ?? "png"
}

export function absolutePath(value: string | undefined): string | undefined {
  if (!value) return
  if (value.startsWith("//")) return
  if (value.startsWith("/")) return value
  if (/^[A-Za-z]:[\\/]/.test(value)) return value
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return
}

export function isPathKnown(target: Pick<ImageViewerItem, "path">): boolean {
  return typeof target.path === "string" && !!absolutePath(target.path)
}

function basename(value: string) {
  const parts = value.split(/[\\/]/)
  return parts[parts.length - 1] ?? value
}

function stripExtension(value: string) {
  const index = value.lastIndexOf(".")
  if (index <= 0) return value
  return value.slice(0, index)
}

function fileTimestamp(timestamp: number) {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, "0")
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "-",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("")
}

function safeFileBase(value: string) {
  const cleaned = value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80)
    .toLowerCase()
  return cleaned || "image"
}

export function imageFileName(target: ImageViewerItem, timestamp = Date.now()): string {
  const base = target.caption
    ? target.caption
    : target.filename
      ? stripExtension(basename(target.filename))
      : target.source
        ? target.source.split("·")[0]?.trim() || "image"
        : "image"
  return `${safeFileBase(stripExtension(base))}-${fileTimestamp(timestamp)}.${extensionForMime(imageMime(target))}`
}

export function imageActionAvailability(input: ImageActionAvailabilityInput): ImageActionAvailability {
  const platform = input.platform ?? "browser"
  const copyable = isCopyableImage(input.target)
  const secure = input.secureContext ?? true
  const hasClipboardItem = input.hasClipboardItem ?? true
  const copyImageDisabledReason = !copyable
    ? "unsupported-image"
    : !secure
      ? "insecure-context"
      : !hasClipboardItem
        ? "clipboard-unavailable"
        : undefined

  return {
    open: !input.inViewer,
    openInNewTab: platform !== "desktop" && !!input.canOpenInNewTab,
    copyImage: copyable,
    copyImageDisabledReason,
    saveImage: copyable,
    copyPath: isPathKnown(input.target),
    revealInFileManager: platform === "desktop" && !!input.canRevealPath && isPathKnown(input.target),
    attachToMessage: !!input.canAttachImage,
    goToMessage: !!input.inViewer && !!input.target.messageID,
  }
}
