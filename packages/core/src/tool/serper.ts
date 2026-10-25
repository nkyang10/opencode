export * as SerperSearch from "./serper"

import { Duration, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { collectBoundedResponseBody } from "./http-body"

export const URL = "https://google.serper.dev/search"
const Result = Schema.Struct({
  organic: Schema.optional(
    Schema.Array(
      Schema.Struct({
        title: Schema.String,
        link: Schema.String,
        snippet: Schema.optional(Schema.String),
      }),
    ),
  ),
})
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Result))

/** Shared by V1 and V2. Credentials never enter URLs, tool metadata, or model output. */
export const search = Effect.fn("SerperSearch.search")(function* (
  http: HttpClient.HttpClient,
  key: string | undefined,
  input: { query: string; numResults?: number; contextMaxCharacters?: number },
) {
  if (!key?.trim()) return yield* Effect.fail(new Error("Serper API key is not configured"))
  const num = Math.max(1, Math.min(20, Math.trunc(input.numResults ?? 8)))
  const request = yield* HttpClientRequest.post(URL).pipe(
    HttpClientRequest.setHeader("X-API-KEY", key.trim()),
    HttpClientRequest.bodyJson({ q: input.query, num }),
  )
  return yield* Effect.gen(function* () {
    const response = yield* HttpClient.filterStatusOk(http).execute(request)
    const body = yield* collectBoundedResponseBody(response, 256 * 1024, () => new Error("Serper response too large"))
    const result = yield* decode(body.toString("utf8"))
    const text = result.organic
      ?.slice(0, num)
      .filter((item) => /^https?:\/\//i.test(item.link))
      .map((item, index) => `${index + 1}. ${item.title}\n${item.link}\n${item.snippet ?? ""}`)
      .join("\n\n")
    return text?.slice(0, Math.max(1, Math.min(50_000, input.contextMaxCharacters ?? 10_000))) || undefined
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(25),
      orElse: () => Effect.fail(new Error("Serper request timed out")),
    }),
    Effect.mapError(() => new Error("Serper search failed. Check the server API key, quota, and connectivity.")),
  )
})
