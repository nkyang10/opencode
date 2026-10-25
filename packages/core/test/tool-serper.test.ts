import { expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { SerperSearch } from "@opencode-ai/core/tool/serper"
import { WebSearchTool } from "@opencode-ai/core/tool/websearch"
import { Config } from "@opencode-ai/core/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ConfigMigrateV1 } from "@opencode-ai/core/v1/config/migrate"

const key = "test-serper-secret"
const client = (
  status = 200,
  value: unknown = { organic: [{ title: "Wiki", link: "https://en.wikipedia.org/wiki/Effect", snippet: "Example" }] },
) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      expect(request.url).toBe(SerperSearch.URL)
      expect(request.headers["x-api-key"]).toBe(key)
      expect(request.url).not.toContain(key)
      if (request.body._tag !== "Uint8Array") throw new Error("Expected JSON body")
      expect(JSON.parse(new TextDecoder().decode(request.body.body))).toEqual({
        q: "site:wikipedia.org Effect",
        num: 8,
      })
      return HttpClientResponse.fromWeb(request, Response.json(value, { status }))
    }),
  )

test("recognizes the exact Serper configuration in V1, V2 and V1 migration", () => {
  const input = { search: { serper: { key } } }
  const legacy = Schema.decodeUnknownSync(ConfigV1.Info)(input)
  expect(legacy.search).toEqual(input.search)
  expect(Schema.decodeUnknownSync(Config.Info)(input).search).toEqual(input.search)
  expect(ConfigMigrateV1.migrate(legacy).search).toEqual(input.search)
  expect(() => Schema.decodeUnknownSync(Config.Info)({ search: { serper: { key: " " } } })).toThrow()
})

test("returns source links and snippets without credentials", async () => {
  const text = await Effect.runPromise(SerperSearch.search(client(), key, { query: "site:wikipedia.org Effect" }))
  expect(text).toContain("https://en.wikipedia.org/wiki/Effect")
  expect(text).toContain("Example")
  expect(text).not.toContain(key)
})

test("handles no results and rejects non-web result URLs", async () => {
  expect(
    await Effect.runPromise(
      SerperSearch.search(client(200, { organic: [] }), key, { query: "site:wikipedia.org Effect" }),
    ),
  ).toBeUndefined()
  expect(
    await Effect.runPromise(
      SerperSearch.search(client(200, { organic: [{ title: "bad", link: "javascript:bad" }] }), key, {
        query: "site:wikipedia.org Effect",
      }),
    ),
  ).toBeUndefined()
})

test("rejects missing credentials without sending and sanitizes provider errors", async () => {
  const failure = await Effect.runPromise(SerperSearch.search(client(), undefined, { query: "x" }).pipe(Effect.flip))
  expect(failure.message).toBe("Serper API key is not configured")
  for (const status of [401, 429, 500]) {
    const error = await Effect.runPromise(
      SerperSearch.search(client(status, { message: key }), key, { query: "site:wikipedia.org Effect" }).pipe(
        Effect.flip,
      ),
    )
    expect(error.message).toContain("Serper search failed")
    expect(error.message).not.toContain(key)
  }
})

test("the effective location configuration selects Serper without experimental flags", async () => {
  const configuration = Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            path: "/global/opencode.json",
            info: new Config.Info({ search: { serper: { key: "global-key" } } }),
          }),
          new Config.Document({
            type: "document",
            path: "/project/opencode.json",
            info: new Config.Info({ search: { serper: { key: "project-key" } } }),
          }),
        ]),
    }),
  )
  const value = await Effect.runPromise(
    Effect.gen(function* () {
      const settings = yield* WebSearchTool.ConfigService
      return { key: settings.serperApiKey, provider: settings.provider }
    }).pipe(Effect.provide(WebSearchTool.defaultConfigLayer.pipe(Layer.provide(configuration)))),
  )
  expect(value).toEqual({ key: "project-key", provider: "serper" })
})
