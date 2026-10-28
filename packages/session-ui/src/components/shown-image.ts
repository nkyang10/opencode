import type { ToolPart } from "@opencode-ai/sdk/v2"
import type { ShownImageAddress } from "@opencode-ai/ui/image-viewer"
import { toolMedia } from "./tool-media"

export type ShownImage = {
  key: string
  url: string
  mime: string
  filename?: string
  name?: string
  caption?: string
  path?: string
  width?: number
  height?: number
  bytes?: number
  /** Where the server keeps the full frame, when `url` is only the preview it served in its place. */
  full?: ShownImageAddress
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return
  if (!value) return
  return value
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number") return
  if (!Number.isFinite(value)) return
  if (value <= 0) return
  return value
}

function nonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number") return
  if (!Number.isFinite(value)) return
  if (value < 0) return
  return value
}

function basename(path: string | undefined): string | undefined {
  if (!path) return
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.at(-1)
}

export function shownImage(part: ToolPart | undefined): ShownImage | undefined {
  if (!part || part.state.status !== "completed") return
  const metadata = part.state.metadata
  if (!metadata || metadata.shown !== true) return

  const image = toolMedia(part).find((item) => item.kind === "image")
  if (!image) return

  const filename = stringValue(image.filename)
  const path = stringValue(metadata.path)
  const name = stringValue(metadata.name) ?? filename ?? basename(path)
  const caption = stringValue(metadata.caption)

  return {
    key: image.key,
    url: image.url,
    mime: image.mime,
    filename,
    name,
    caption,
    path,
    width: positiveNumber(metadata.width),
    height: positiveNumber(metadata.height),
    bytes: nonNegativeNumber(metadata.bytes),
    full: previewedImageAddress(part, image.index),
  }
}

/**
 * Address of the full frame behind a tool image, when the server's browser projection served a preview in its place.
 *
 * That projection keeps `preview` as a description and strips its `uri`, because the preview itself is what travelled in
 * place of the full image, so a `preview` without a uri is the marker. `index` is the position among the file items of
 * the tool result, which is where the server keeps it.
 */
export function previewedImageAddress(part: ToolPart, index: number): ShownImageAddress | undefined {
  if (part.state.status !== "completed") return
  const metadata = part.state.metadata
  const preview = typeof metadata === "object" && metadata ? (metadata as Record<string, unknown>).preview : undefined
  if (!preview || typeof preview !== "object" || Array.isArray(preview) || "uri" in preview) return
  if (!part.sessionID || !part.messageID || !part.callID) return
  return { sessionID: part.sessionID, messageID: part.messageID, callID: part.callID, index }
}
