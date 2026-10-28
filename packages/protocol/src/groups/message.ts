import { Session } from "@opencode-ai/schema/session"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidCursorError, MessageNotFoundError, SessionNotFoundError, UnknownError } from "../errors"

export const SessionMessagesQuery = Schema.Struct({
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)),
  ).annotate({
    description: "Maximum number of messages to return. When omitted, the endpoint returns its default page size.",
  }),
  order: Schema.optional(Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")])).annotate({
    description: "Message order for the first page. Use desc for newest first or asc for oldest first.",
  }),
  cursor: Schema.optional(
    Schema.String.annotate({
      description:
        "Opaque pagination cursor returned as cursor.previous or cursor.next in the previous response. Do not combine with order.",
    }),
  ),
  imagePreviews: Schema.optional(Schema.Literal("thumbnail")).annotate({
    description:
      "Send thumbnail instead of full bytes: inline image data URLs in completed tool results are replaced with the preview the tool attached, and structured.preview keeps only its description, which marks the image as previewed so the full image can be fetched on demand. Omitted, pages carry the full inline images.",
  }),
}).annotate({ identifier: "SessionMessagesQuery" })

export const SessionImageQuery = Schema.Struct({
  source: Schema.optional(Schema.Union([Schema.Literal("content"), Schema.Literal("attachments")])).annotate({
    description: "Which list of the completed tool result the index points into. Defaults to content.",
  }),
  index: Schema.optional(Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))).annotate({
    description: "Position of the image among the file items of that list, counting in order. Defaults to 0.",
  }),
}).annotate({ identifier: "SessionImageQuery" })

export const SessionImage = Schema.Struct({
  uri: Schema.String.annotate({ description: "The stored image as a data URL, exactly as the model receives it." }),
  mime: Schema.String.annotate({ description: "Media type of the stored image." }),
}).annotate({ identifier: "SessionImageResponse" })

export const MessageGroup = HttpApiGroup.make("server.message")
  .add(
    HttpApiEndpoint.get("session.messages", "/api/session/:sessionID/message", {
      params: { sessionID: Session.ID },
      query: SessionMessagesQuery,
      success: Schema.Struct({
        data: Schema.Array(SessionMessage.Message),
        cursor: Schema.Struct({
          previous: Schema.String.pipe(Schema.optional),
          next: Schema.String.pipe(Schema.optional),
        }),
      }).annotate({ identifier: "SessionMessagesResponse" }),
      error: [InvalidCursorError, SessionNotFoundError, UnknownError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.session.messages",
        summary: "Get session messages",
        description:
          "Retrieve projected messages for a session. Items keep the requested order across pages; use cursor.next or cursor.previous to move through the ordered timeline.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("session.image", "/api/session/:sessionID/message/:messageID/tool/:callID/image", {
      params: { sessionID: Session.ID, messageID: SessionMessage.ID, callID: Schema.String },
      query: SessionImageQuery,
      success: SessionImage,
      error: [SessionNotFoundError, MessageNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.session.image",
        summary: "Get the full image of a shown tool result",
        description:
          "Return the stored full image behind one file of a completed tool result, for clients that received the thumbnail preview instead. Responses are immutable and cached privately; this is not an asset route, and callers are expected to turn the data URL into a blob URL.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "messages",
      description: "Experimental message routes.",
    }),
  )
