export * as BrowserImagePreview from "./browser-image-preview"

import { SessionMessage } from "@opencode-ai/core/session/message"

/**
 * Swaps the browser-facing copy of a tool image for the small preview the tool attached, so a timeline of screenshots
 * does not drag every full base64 image across the wire.
 *
 * Two constraints keep this honest:
 *
 * - The stored message is never rewritten. The model reads the full image from the store
 *   (`packages/core/src/session/runner/to-llm-message.ts` lowers `file.uri` straight into the provider request), so the
 *   full URI has to survive there.
 * - Project only where a browser reads, never before an event is published. `EventV2` is durable and replayed, and a
 *   preview substituted at publish time would be all that anything rebuilt from replay ever sees.
 *
 * After the swap the preview travels once: `structured.preview` keeps its describing fields but loses `uri`, and its
 * presence is what tells the client the displayed URI is a preview and the full bytes must be fetched on demand.
 */
export function previewMessages(messages: readonly SessionMessage.Message[]) {
  return messages.map(previewMessage)
}

/**
 * Same rule for an event envelope (`{ type, data }`) on its way to the browser. Untyped on purpose: the SSE serializer
 * is generic over the event union, and only the tool payloads that carry `content` are touched.
 */
export function previewEvent(event: unknown): unknown {
  if (!isRecord(event) || !isRecord(event.data)) return event
  const data = event.data
  if (!Array.isArray(data.content) || !isRecord(data.structured)) return event
  const preview = readPreview(data.structured)
  if (!preview) return event
  const content = swap(data.content, (item) => {
    if (!isInlineImageFile(item)) return item
    return { ...item, uri: preview.uri, mime: preview.mime }
  })
  if (!content) return event
  return { ...event, data: { ...data, content, structured: withoutPreviewUri(data.structured, preview.description) } }
}

function previewMessage(message: SessionMessage.Message) {
  if (message.type !== "assistant") return message
  const content = swap(message.content, (item) => {
    if (item.type !== "tool") return item
    const tool = previewTool(item)
    return tool ?? item
  })
  if (!content) return message
  return { ...message, content }
}

function previewTool(tool: SessionMessage.AssistantTool) {
  if (tool.state.status !== "completed") return undefined
  const preview = readPreview(tool.state.structured)
  if (!preview) return undefined
  const content = swap(tool.state.content, (item) => {
    if (item.type !== "file") return item
    if (!isInlineImage(item)) return item
    return { ...item, uri: preview.uri, mime: preview.mime }
  })
  const attachments = tool.state.attachments
    ? swap(tool.state.attachments, (item) =>
        isInlineImage(item) ? { ...item, uri: preview.uri, mime: preview.mime } : item,
      )
    : undefined
  if (!content && !attachments) return undefined
  return {
    ...tool,
    state: {
      ...tool.state,
      ...(content ? { content } : {}),
      ...(attachments ? { attachments } : {}),
      structured: withoutPreviewUri(tool.state.structured, preview.description),
    },
  }
}

/** Reads `structured.preview`, the metadata a shown-image tool attaches beside the full image. */
function readPreview(structured: Readonly<Record<string, unknown>>): Preview | undefined {
  if (!isRecord(structured.preview)) return undefined
  const preview = structured.preview
  if (typeof preview.uri !== "string" || !preview.uri.startsWith("data:image/")) return undefined
  if (typeof preview.mime !== "string" || !preview.mime.startsWith("image/")) return undefined
  return { uri: preview.uri, mime: preview.mime, description: { mime: preview.mime, ...sizeOf(preview) } }
}

function sizeOf(preview: Readonly<Record<string, unknown>>) {
  return Object.fromEntries(
    Object.entries({ width: preview.width, height: preview.height, bytes: preview.bytes }).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
    ),
  )
}

/** The `structured` map with the preview reduced to its description, so the bytes travel exactly once. */
function withoutPreviewUri(structured: Readonly<Record<string, unknown>>, description: Preview["description"]) {
  const { preview: _omitted, ...rest } = structured
  return { ...rest, preview: description }
}

type Preview = { readonly uri: string; readonly mime: string; readonly description: Record<string, unknown> }

/** The untyped sibling of `isInlineImage`, for event payloads that have not been through a schema. */
function isInlineImageFile(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || value.type !== "file") return false
  if (typeof value.mime !== "string" || typeof value.uri !== "string") return false
  return isInlineImage({ mime: value.mime, uri: value.uri })
}

function isInlineImage(item: { readonly mime: string; readonly uri: string }) {
  return item.mime.startsWith("image/") && item.uri.startsWith("data:image/")
}

/** Maps and returns the array only when something actually changed, so untouched parts keep their identity. */
function swap<T>(items: readonly T[], replace: (item: T) => T) {
  const next = items.map(replace)
  if (next.every((item, index) => item === items[index])) return undefined
  return next
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
