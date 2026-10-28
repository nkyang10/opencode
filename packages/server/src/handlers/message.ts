import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV2 } from "@opencode-ai/core/session"
import { Effect, Schema } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { BrowserImagePreview } from "../browser-image-preview"
import {
  InvalidCursorError,
  MessageNotFoundError,
  SessionNotFoundError,
  UnknownError,
} from "@opencode-ai/protocol/errors"

const DefaultMessagesLimit = 50

const Cursor = Schema.Struct({
  id: SessionMessage.ID,
  order: Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")]),
  direction: Schema.Union([Schema.Literal("previous"), Schema.Literal("next")]),
})

const decodeCursor = Schema.decodeUnknownSync(Cursor)

const cursor = {
  encode(message: SessionMessage.Message, order: "asc" | "desc", direction: "previous" | "next") {
    return Buffer.from(JSON.stringify({ id: message.id, order, direction })).toString("base64url")
  },
  decode(input: string) {
    return decodeCursor(JSON.parse(Buffer.from(input, "base64url").toString("utf8")))
  },
}

export const MessageHandler = HttpApiBuilder.group(Api, "server.message", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service

    return handlers
      .handle(
        "session.messages",
        Effect.fn(function* (ctx) {
          if (ctx.query.cursor && ctx.query.order !== undefined)
            return yield* new InvalidCursorError({ message: "Cursor cannot be combined with order" })
          const decoded = yield* Effect.try({
            try: () => (ctx.query.cursor ? cursor.decode(ctx.query.cursor) : undefined),
            catch: () => new InvalidCursorError({ message: "Invalid cursor" }),
          })
          const order = decoded?.order ?? ctx.query.order ?? "desc"
          const messages = yield* session
            .messages({
              sessionID: ctx.params.sessionID,
              limit: ctx.query.limit ?? DefaultMessagesLimit,
              order,
              cursor: decoded ? { id: decoded.id, direction: decoded.direction } : undefined,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.MessageDecodeError", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Effect.logError("failed to decode session message").pipe(
                  Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref }),
                    ),
                  ),
                )
              }),
            )
          const first = messages[0]
          const last = messages.at(-1)
          return {
            // Opt-in per page: only browsers that can fetch the full image later ask for thumbnails.
            data: ctx.query.imagePreviews === "thumbnail" ? BrowserImagePreview.previewMessages(messages) : messages,
            cursor: {
              previous: first ? cursor.encode(first, order, "previous") : undefined,
              next: last ? cursor.encode(last, order, "next") : undefined,
            },
          }
        }),
      )
      .handle(
        "session.image",
        Effect.fn(function* (ctx) {
          const message = yield* session.message({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID })
          const file = storedImage(message, ctx.params.callID, ctx.query.source ?? "content", ctx.query.index ?? 0)
          if (!file)
            return yield* new MessageNotFoundError({
              sessionID: ctx.params.sessionID,
              messageID: ctx.params.messageID,
              message: "No stored image behind that tool result",
            })
          // A completed tool result never changes, so the browser may keep the full image for as long as the message.
          return HttpServerResponse.jsonUnsafe(file, {
            headers: { etag: validator(file.uri), "cache-control": "private, immutable" },
          })
        }),
      )
  }),
)

/** The stored file behind one entry of a completed tool result, which is what a previewed client has to re-fetch. */
function storedImage(
  message: SessionMessage.Message | undefined,
  callID: string,
  source: "content" | "attachments",
  index: number,
) {
  if (message === undefined || message.type !== "assistant") return undefined
  const tool = message.content.find((item) => item.type === "tool" && item.id === callID)
  if (tool?.type !== "tool" || tool.state.status !== "completed") return undefined
  // Tool content is tagged, prompt attachments are not, so only content items have a `type` to check. The index counts
  // file items only, which is what a client sees as the attachment list of a tool result.
  const files = (source === "attachments" ? (tool.state.attachments ?? []) : tool.state.content).filter(
    (file) => !("type" in file) || file.type === "file",
  )
  const file = files[index]
  if (!file || ("type" in file && file.type !== "file")) return undefined
  if (!file.mime.startsWith("image/") || !file.uri.startsWith("data:image/")) return undefined
  return { uri: file.uri, mime: file.mime }
}

/** Weak validator over the data URL. The stored part is immutable, so any stable digest of it is enough. */
function validator(uri: string) {
  let digest = 0x811c9dc5
  for (let index = 0; index < uri.length; index++) {
    digest = Math.imul(digest ^ uri.charCodeAt(index), 0x01000193) >>> 0
  }
  return `W/"${uri.length.toString(16)}-${digest.toString(16)}"`
}
