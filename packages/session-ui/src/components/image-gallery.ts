import type { Message, Part, ToolPart } from "@opencode-ai/sdk/v2"
import type { ImageViewerItem } from "@opencode-ai/ui/image-viewer"
import { absolutePath } from "./image-actions-helpers"
import { attached, kind } from "./message-file"
import { isInlineImageUrl, toolMedia, type ToolMediaItem } from "./tool-media"

export type ImageGalleryLabels = {
  image: string
  attachment: string
  you?: string
}

export type ImageGalleryInput = {
  sessionID: string
  messages: Message[]
  parts: { [messageID: string]: Part[] }
  labels: ImageGalleryLabels
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return
  if (!value) return
  return value
}

export function toolImagePath(part: ToolPart): string | undefined {
  if (part.state.status !== "completed" && part.state.status !== "running" && part.state.status !== "pending") return
  const input = part.state.input
  if (!input) return
  return stringValue(input.filePath) ?? stringValue(input.file_path) ?? stringValue(input.path) ?? stringValue(input.name)
}

export function toolImageSource(part: ToolPart, fallback?: string): string {
  const path = toolImagePath(part)
  if (path) return `${part.tool} · ${path}`
  if (fallback) return `${part.tool} · ${fallback}`
  return part.tool
}

export function toolImageViewerItem(
  part: ToolPart,
  media: ToolMediaItem,
  labels: Pick<ImageGalleryLabels, "image">,
): ImageViewerItem {
  const metadata = part.state.status === "completed" ? part.state.metadata : undefined
  const width = typeof metadata === "object" && metadata ? metadata.width : undefined
  const height = typeof metadata === "object" && metadata ? metadata.height : undefined
  return {
    src: media.url,
    alt: media.filename ?? labels.image,
    filename: media.filename,
    mime: media.mime,
    width: typeof width === "number" ? width : undefined,
    height: typeof height === "number" ? height : undefined,
    source: toolImageSource(part, media.filename),
    path: absolutePath(toolImagePath(part)),
    messageID: part.messageID,
    partID: part.id,
  }
}

export function userImageViewerItem(
  part: Part,
  messageID: string,
  labels: ImageGalleryLabels,
): ImageViewerItem | undefined {
  if (part.type !== "file") return
  if (kind(part) !== "image") return
  if (!attached(part)) return
  if (!isInlineImageUrl(part.url)) return
  return {
    src: part.url,
    alt: part.filename ?? labels.image,
    filename: part.filename,
    mime: part.mime,
    source: labels.you ?? labels.attachment,
    path: absolutePath(part.filename),
    messageID,
    partID: part.id,
  }
}

export function assistantImageViewerItem(
  part: Part,
  messageID: string,
  labels: ImageGalleryLabels,
): ImageViewerItem | undefined {
  if (part.type !== "file") return
  if (kind(part) !== "image") return
  if (!isInlineImageUrl(part.url)) return
  return {
    src: part.url,
    alt: part.filename ?? labels.image,
    filename: part.filename,
    mime: part.mime,
    source: part.filename ?? labels.image,
    messageID,
    partID: part.id,
  }
}

export function sessionImageGallery(input: ImageGalleryInput): ImageViewerItem[] {
  const messages = [...input.messages].sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
  const seen = new Set<string>()
  const items: ImageViewerItem[] = []

  const add = (item: ImageViewerItem | undefined) => {
    if (!item?.src || !isInlineImageUrl(item.src) || seen.has(item.src)) return
    seen.add(item.src)
    items.push(item)
  }

  for (const message of messages) {
    if (message.sessionID !== input.sessionID) continue
    const parts = input.parts[message.id] ?? []
    for (const part of parts) {
      if (part.type === "file") {
        add(
          message.role === "user"
            ? userImageViewerItem(part, message.id, input.labels)
            : assistantImageViewerItem(part, message.id, input.labels),
        )
        continue
      }
      if (part.type !== "tool") continue
      for (const media of toolMedia(part)) {
        if (media.kind !== "image") continue
        add(toolImageViewerItem(part, media, input.labels))
      }
    }
  }

  return items
}
