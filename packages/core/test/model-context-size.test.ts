import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { ModelContextSize } from "@opencode-ai/core/model-context-size"

describe("ModelContextSize.contextSize", () => {
  test("reads the vLLM field", () => {
    expect(ModelContextSize.contextSize({ id: "general", max_model_len: 1048576 })).toBe(1048576)
  })

  test("reads the other names in common use", () => {
    expect(ModelContextSize.contextSize({ context_length: 200000 })).toBe(200000)
    expect(ModelContextSize.contextSize({ context_window: 128000 })).toBe(128000)
    expect(ModelContextSize.contextSize({ max_context_length: 32000 })).toBe(32000)
    expect(ModelContextSize.contextSize({ max_input_tokens: 1000000 })).toBe(1000000)
  })

  // The failure that motivated the feature: a hosted proxy's entry carries no context field at all,
  // so a missing number must stay missing rather than become a guess.
  test("returns undefined for an entry that does not report one", () => {
    expect(ModelContextSize.contextSize({ id: "opencode-go-default", object: "model", created: 1, owned_by: "x" })).toBe(
      undefined,
    )
  })

  test("rejects values that are not a usable context size", () => {
    expect(ModelContextSize.contextSize({ max_model_len: 0 })).toBe(undefined)
    expect(ModelContextSize.contextSize({ max_model_len: -1 })).toBe(undefined)
    expect(ModelContextSize.contextSize({ max_model_len: Number.NaN })).toBe(undefined)
    expect(ModelContextSize.contextSize({ max_model_len: "1048576" })).toBe(undefined)
    expect(ModelContextSize.contextSize(undefined)).toBe(undefined)
    expect(ModelContextSize.contextSize(null)).toBe(undefined)
  })
})

describe("ModelContextSize.modelsPayload", () => {
  test("reads the three shapes providers answer with", () => {
    expect(ModelContextSize.modelsPayload({ data: [{ id: "a" }] })).toEqual([{ id: "a" }])
    expect(ModelContextSize.modelsPayload({ models: [{ id: "b" }] })).toEqual([{ id: "b" }])
    expect(ModelContextSize.modelsPayload([{ id: "c" }])).toEqual([{ id: "c" }])
  })

  // Observed live on 2026-09-30: the rtx gateway answers HTTP 200 with this body while down.
  test("treats a proxy error body as no models", () => {
    expect(ModelContextSize.modelsPayload({ error: "proxy_error", detail: "Remote end closed connection" })).toEqual([])
  })
})

describe("ModelContextSize.contextSizes", () => {
  test("indexes by id and skips entries without a size", () => {
    const sizes = ModelContextSize.contextSizes({
      data: [
        { id: "general", max_model_len: 1048576 },
        { id: "go-default", object: "model" },
        { max_model_len: 4096 },
      ],
    })
    expect([...sizes]).toEqual([["general", 1048576]])
  })
})

describe("ModelContextSize.resolve", () => {
  // A value the user configured is a deliberate choice. Overwriting it is the one thing this must
  // never do, so the rule is pinned here rather than only at the call site.
  test("never replaces a context size that is already set", () => {
    const sizes = new Map([["general", 1048576]])
    expect(ModelContextSize.resolve({ current: 500000, modelID: "general", sizes })).toBe(500000)
  })

  test("fills a zero context size from the provider's report", () => {
    const sizes = new Map([["general", 1048576]])
    expect(ModelContextSize.resolve({ current: 0, modelID: "general", sizes })).toBe(1048576)
  })

  test("leaves a zero context size alone when the provider says nothing", () => {
    expect(ModelContextSize.resolve({ current: 0, modelID: "go-default", sizes: new Map() })).toBe(0)
    expect(
      ModelContextSize.resolve({ current: 0, modelID: "other", sizes: new Map([["general", 1048576]]) }),
    ).toBe(0)
  })
})

describe("ModelContextSize.headers", () => {
  test("bears the provider's own key when the record carries none", () => {
    expect(
      ModelContextSize.headers({ api: { settings: { apiKey: "secret" } }, request: { headers: {} } }),
    ).toEqual({ Authorization: "Bearer secret" })
  })

  test("prefers auth the provider record already holds", () => {
    expect(
      ModelContextSize.headers({
        api: { settings: { apiKey: "secret" } },
        request: { headers: { "x-api-key": "explicit" } },
      }),
    ).toEqual({ "x-api-key": "explicit" })
  })

  test("sends no invented credential when there is none", () => {
    expect(ModelContextSize.headers({ api: { settings: {} }, request: { headers: { A: "b" } } })).toBe(undefined)
  })
})

describe("ModelContextSize.fill", () => {
  // A real server, not a stubbed client: the point of these is the once-only caching, which a mock
  // would have to re-implement and could agree with by construction.
  const withServer = async (body: unknown, run: (baseURL: string, calls: () => number) => Promise<void>) => {
    let calls = 0
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        calls++
        if (new URL(request.url).pathname !== "/models") return new Response("not found", { status: 404 })
        return Response.json(body)
      },
    })
    try {
      await run(server.url.toString(), () => calls)
    } finally {
      server.stop(true)
    }
  }

  const ask = (baseURL: string, modelID: string, current: number, headers: Record<string, string> | undefined = {}) =>
    Effect.runPromise(
      ModelContextSize.fill({ baseURL, headers, modelID, current }).pipe(Effect.provide(FetchHttpClient.layer)),
    )

  const askWithoutAuth = (baseURL: string, modelID: string, current: number) =>
    Effect.runPromise(
      ModelContextSize.fill({ baseURL, headers: undefined, modelID, current }).pipe(
        Effect.provide(FetchHttpClient.layer),
      ),
    )

  test("asks the provider once and reuses the answer, including a refusal", async () => {
    await withServer({ data: [{ id: "general", max_model_len: 1048576 }] }, async (baseURL, calls) => {
      expect(await ask(baseURL, "general", 0)).toBe(1048576)
      expect(calls()).toBe(1)
      // A second caller, and a model the provider never mentioned, must not re-hit the API.
      expect(await ask(baseURL, "general", 0)).toBe(1048576)
      expect(await ask(baseURL, "unknown-model", 0)).toBe(0)
      expect(calls()).toBe(1)
    })
  })

  test("never calls out for a model that already has a context size", async () => {
    await withServer({ data: [{ id: "general", max_model_len: 1048576 }] }, async (baseURL, calls) => {
      expect(await ask(baseURL, "general", 500000)).toBe(500000)
      expect(calls()).toBe(0)
    })
  })

  // Observed live on 2026-09-30 against the rtx gateway: HTTP 200 carrying an error object.
  test("survives a provider that answers with an error body", async () => {
    await withServer({ error: "proxy_error", detail: "Remote end closed connection" }, async (baseURL, calls) => {
      expect(await ask(baseURL, "general", 0)).toBe(0)
      expect(calls()).toBe(1)
    })
  })

  test("does not call out without a base URL to call", async () => {
    expect(await ask("", "general", 0)).toBe(0)
  })

  // The catalog draft cannot see an env-var or integration credential, so a provider without one
  // in-band must not be called at all - a pointless request on every catalog build.
  test("does not call out without a credential to call with", async () => {
    await withServer({ data: [{ id: "general", max_model_len: 1048576 }] }, async (baseURL, calls) => {
      expect(await askWithoutAuth(baseURL, "general", 0)).toBe(0)
      expect(calls()).toBe(0)
    })
  })
})
