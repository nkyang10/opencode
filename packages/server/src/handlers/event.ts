import { EventV2 } from "@opencode-ai/core/event"
import { OpenCodeEvent } from "@opencode-ai/protocol/groups/event"
import { Effect, Schema, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { Api } from "../api"
import { BrowserImagePreview } from "../browser-image-preview"

const subscriberCapacity = 256

function eventData(data: unknown, imagePreviews: boolean): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(
      Schema.encodeUnknownSync(OpenCodeEvent)(imagePreviews ? BrowserImagePreview.previewEvent(data) : data),
    ),
  }
}

export const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    return handlers.handleRaw("event.subscribe", (ctx) =>
      Effect.gen(function* () {
        // Subscribed clients opt into previews per stream; the stored and replayed events keep the full image.
        const imagePreviews = ctx.query.imagePreviews === "thumbnail"
        const connected = {
          id: EventV2.ID.create(),
          type: "server.connected",
          data: {},
        }
        const output = Stream.unwrap(
          Effect.gen(function* () {
            // Acquiring the bounded stream installs its listener before readiness is observable.
            const live = yield* EventV2.allBounded(events, subscriberCapacity)
            return Stream.make(connected).pipe(Stream.concat(live))
          }),
        ).pipe(
          Stream.map((event) => eventData(event, imagePreviews)),
          Stream.pipeThroughChannel(Sse.encode()),
        )
        const heartbeat = Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))
        return HttpServerResponse.stream(
          output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
          {
            contentType: "text/event-stream",
            headers: {
              "Cache-Control": "no-cache, no-transform",
              "X-Accel-Buffering": "no",
              "X-Content-Type-Options": "nosniff",
            },
          },
        )
      }),
    )
  }),
)
