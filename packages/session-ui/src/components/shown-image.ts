import type { ToolPart } from "@opencode-ai/sdk/v2"
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
  }
}
