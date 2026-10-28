import type { ToolPart } from "@opencode-ai/sdk/v2"

export type ToolMediaItem = {
  kind: "image" | "chip"
  key: string
  url: string
  mime: string
  filename?: string
}

const INLINE_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,/i

export function isInlineImageUrl(url: string) {
  return INLINE_IMAGE.test(url)
}

export function toolMedia(part: ToolPart | undefined): ToolMediaItem[] {
  if (!part || part.state.status !== "completed") return []
  const attachments = part.state.attachments
  if (!attachments) return []

  return attachments.map((file, index) => ({
    kind: INLINE_IMAGE.test(file.url) ? "image" : "chip",
    key: file.id || `${index}`,
    url: file.url,
    mime: file.mime,
    filename: file.filename,
  }))
}
