export * as BrowserImagePreview from "./browser-image-preview"

import { SessionV1 } from "@opencode-ai/core/v1/session"

/**
 * v1 sibling of `packages/server/src/browser-image-preview.ts`: swaps the browser-facing copy of a shown image for the
 * small JPEG the tool attached in `state.metadata.preview`, so a timeline of screenshots does not drag every full
 * base64 image across the wire.
 *
 * Same constraints as the v2 helper:
 *
 * - The stored part is never rewritten. The provider request reads the full image out of the store, so the full URI has
 *   to survive there.
 * - Project only where a browser reads, never before an event is published. `EventV2` is durable and replayed, and a
 *   preview substituted at publish time would be all that anything rebuilt from replay ever sees.
 *
 * After the swap the preview travels once: `metadata.preview` keeps its describing fields but loses `uri`, and its
 * presence is what tells the client the displayed URI is a preview and the full bytes must be fetched on demand.
 */
export function previewMessages(messages: readonly SessionV1.WithParts[]) {
  return messages.map((message) => {
    const parts = swap(message.parts, (part) => (previewPart(part) as SessionV1.Part | undefined) ?? part)
    if (!parts) return message
    return { ...message, parts }
  })
}

/**
 * Same rule for an event envelope on its way to the browser. Untyped on purpose: the serializer is generic over the
 * event union and `message.part.updated` carries a part that never went through a schema.
 */
export function previewEvent(event: { type: string; properties: unknown }) {
  const properties = event.properties
  if (!isRecord(properties) || !isRecord(properties.part)) return event
  const part = previewPart(properties.part)
  if (!part) return event
  return { ...event, properties: { ...properties, part } }
}

/**
 * Same rule for the global stream, which wraps every instance event in a `{ directory, payload }` envelope. The cast is
 * safe because `previewEvent` only reads `properties` and spreads the object it was given, so `id` and friends survive.
 */
export function previewGlobalEvent(envelope: unknown) {
  if (!isRecord(envelope) || !isRecord(envelope.payload) || typeof envelope.payload.type !== "string") return envelope
  const projected = previewEvent(envelope.payload as { type: string; properties: unknown })
  if (projected === envelope.payload) return envelope
  return { ...envelope, payload: projected }
}

function previewPart(part: unknown): Record<string, unknown> | undefined {
  if (!isRecord(part) || part.type !== "tool") return undefined
  const state = part.state
  if (!isRecord(state) || state.status !== "completed" || !isRecord(state.metadata)) return undefined
  const preview = readPreview(state.metadata)
  if (!preview) return undefined
  const attachments = Array.isArray(state.attachments)
    ? swap(state.attachments, (item) =>
        isInlineImageFile(item) ? { ...item, url: preview.uri, mime: preview.mime } : item,
      )
    : undefined
  if (!attachments) return undefined
  return { ...part, state: { ...state, attachments, metadata: withoutPreviewUri(state.metadata, preview.description) } }
}

/** Reads `metadata.preview`, the metadata a shown-image tool attaches beside the full image. */
function readPreview(metadata: Readonly<Record<string, unknown>>): Preview | undefined {
  if (!isRecord(metadata.preview)) return undefined
  const preview = metadata.preview
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

/** The metadata map with the preview reduced to its description, so the bytes travel exactly once. */
function withoutPreviewUri(metadata: Readonly<Record<string, unknown>>, description: Preview["description"]) {
  const { preview: _omitted, ...rest } = metadata
  return { ...rest, preview: description }
}

type Preview = { readonly uri: string; readonly mime: string; readonly description: Record<string, unknown> }

function isInlineImageFile(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  if (typeof value.mime !== "string" || typeof value.url !== "string") return false
  return value.mime.startsWith("image/") && value.url.startsWith("data:image/")
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
