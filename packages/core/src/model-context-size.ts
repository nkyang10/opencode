export * as ModelContextSize from "./model-context-size"

import { Cause, Duration, Effect } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

/**
 * Context-window sizes are not part of any provider's `/models` contract, so each API spells the
 * field differently. vLLM (`max_model_len`) is verified; the rest are the names in common use by
 * OpenAI-compatible proxies. Order is a preference, not a requirement.
 */
const CONTEXT_FIELDS = ["max_model_len", "context_length", "context_window", "max_context_length", "max_input_tokens"]

type ModelLimit = { readonly limit?: { readonly context?: number } | undefined }

/** Narrows untrusted JSON to something with readable properties, without asserting past `unknown`. */
function record(value: unknown) {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined
}

/** Reads a context size off one `/models` entry. Returns undefined when the entry does not carry one. */
export function contextSize(entry: unknown) {
  const fields = record(entry)
  if (!fields) return undefined
  for (const field of CONTEXT_FIELDS) {
    const value = fields[field]
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue
    return Math.trunc(value)
  }
  return undefined
}

/**
 * Pulls the model array out of a `/models` payload. Providers answer with `data` (OpenAI), `models`
 * (Ollama) or a bare array. An error body - a proxy that is down replies `{"error":"proxy_error"}` -
 * has none of those and so yields no models, which reads as "this provider does not say".
 */
export function modelsPayload(json: unknown) {
  if (Array.isArray(json)) return json
  const fields = record(json)
  if (!fields) return []
  if (Array.isArray(fields.data)) return fields.data
  if (Array.isArray(fields.models)) return fields.models
  return []
}

/** Indexes a `/models` payload by model id, keeping only the ids that report a context size. */
export function contextSizes(json: unknown) {
  const sizes = new Map<string, number>()
  for (const entry of modelsPayload(json)) {
    const id = record(entry)?.id
    if (typeof id !== "string") continue
    const size = contextSize(entry)
    if (size !== undefined) sizes.set(id, size)
  }
  return sizes
}

/**
 * A model whose context size is unknown must not be given a guess: the number is the compaction
 * trigger, so a fabricated 128k would truncate a session that actually holds 1M tokens. Only a
 * value the provider itself reported is allowed to fill the gap.
 */
export function resolve(input: { current: number; modelID: string; sizes: ReadonlyMap<string, number> }) {
  if (input.current > 0) return input.current
  const size = input.sizes.get(input.modelID)
  if (size === undefined || size <= 0) return input.current
  return size
}

/**
 * Filled on the first answer and then reused, so a provider is asked once per server process. The
 * empty result is stored too, which is what makes a provider that publishes no context size stop
 * being asked. The catalog transform is serialized behind a single semaphore
 * (`State.create` -> `semaphore.withPermit(materialize())`), so two callers cannot race this cache.
 *
 * `Effect.cached` is not used here: in effect 4.0.0-beta.83 it only memoizes when the inner effect it
 * returns is hoisted once and reused, and re-running its outer effect silently rebuilds the cache.
 */
const answered = new Map<string, ReadonlyMap<string, number>>()

const request = (baseURL: string, headers: Record<string, string>) =>
  Effect.gen(function* () {
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const url = `${baseURL.replace(/\/+$/, "")}/models`
    const text = yield* HttpClientRequest.get(url).pipe(
      HttpClientRequest.setHeaders(headers),
      http.execute,
      Effect.flatMap((response) => response.text),
    )
    return JSON.parse(text) as unknown
  }).pipe(
    // A provider that is down, slow, or answers with HTML must not hold up a catalog build.
    Effect.timeout(Duration.seconds(5)),
    Effect.map(contextSizes),
    Effect.catchCause((cause) =>
      Effect.as(
        Effect.logWarning("model context size: provider gave no answer", { baseURL, cause: Cause.pretty(cause) }),
        new Map<string, number>(),
      ),
    ),
    Effect.tap((sizes) => Effect.sync(() => answered.set(baseURL, sizes))),
  )

/**
 * Fills a missing context size from the provider's own API, at most once per provider per server
 * process. The cache is keyed on the base URL and deliberately outlives any single instance: the
 * catalog transform runs once per open directory and again on every reload, so a per-instance cache
 * would re-hit the network for each one.
 */
export function fill(input: {
  readonly baseURL: string | undefined
  readonly headers: Record<string, string> | undefined
  readonly modelID: string
  readonly current: number
}): Effect.Effect<number, never, HttpClient.HttpClient> {
  if (input.current > 0 || !input.baseURL || !input.headers) return Effect.succeed(input.current)
  const cached = answered.get(input.baseURL)
  if (cached) return Effect.succeed(resolve({ current: input.current, modelID: input.modelID, sizes: cached }))
  return Effect.map(request(input.baseURL, input.headers), (sizes) =>
    resolve({ current: input.current, modelID: input.modelID, sizes }),
  )
}

/**
 * The auth a `/models` probe should carry, or undefined when the provider record holds no credential
 * to carry. A provider whose key lives in an env var or an integration is deliberately skipped rather
 * than called unauthenticated: the catalog draft cannot see those credentials, and a provider that
 * publishes no context size would answer with an error anyway. Hosted providers get their limits from
 * the models.dev catalog and never reach here.
 */
export function headers(provider: {
  readonly api: { readonly settings?: Record<string, unknown> }
  readonly request: { readonly headers: Record<string, string> }
}) {
  const existing = provider.request.headers
  if (existing.Authorization || existing["x-api-key"]) return existing
  const key = provider.api.settings?.apiKey
  if (typeof key !== "string" || !key) return undefined
  return { ...existing, Authorization: `Bearer ${key}` }
}

/**
 * Context sizes the catalog already knows, keyed by bare model id.
 *
 * The same model id can appear under several providers, and when those disagree the size is not
 * knowable from the id alone, so a conflicting id is dropped rather than resolved by iteration order.
 */
export function catalogLimits(catalog: Record<string, { models?: Record<string, ModelLimit | undefined> }>) {
  const agreed = new Map<string, number>()
  const conflicting = new Set<string>()
  for (const provider of Object.values(catalog)) {
    for (const [modelID, model] of Object.entries(provider.models ?? {})) {
      const size = model?.limit?.context
      if (typeof size !== "number" || size <= 0) continue
      const seen = agreed.get(modelID)
      if (seen === undefined) agreed.set(modelID, size)
      else if (seen !== size) conflicting.add(modelID)
    }
  }
  for (const modelID of conflicting) agreed.delete(modelID)
  return agreed
}

/**
 * Headers the gateway uses to name the model that actually served the request. `x-zen-model` is set by
 * OpenCode's own Zen service and already forwarded by its inference proxy, so it is a first-party
 * value rather than one gateway's private invention; the upstream id is the fallback.
 */
const RESOLVED_HEADERS = ["x-zen-model", "x-opencode-upstream-model-id"]

const aliases = new Map<string, string | undefined>()

const askAlias = (baseURL: string, headers: Record<string, string>, modelID: string) =>
  Effect.gen(function* () {
    const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
    const request = yield* HttpClientRequest.post(`${baseURL.replace(/\/+$/, "")}/chat/completions`).pipe(
      HttpClientRequest.setHeaders(headers),
      HttpClientRequest.bodyJson({ model: modelID, messages: [{ role: "user", content: "hi" }], max_tokens: 1 }),
    )
    const response = yield* http.execute(request)
    // Drain the body so the socket is released; the answer is in the headers.
    yield* response.text.pipe(Effect.ignore)
    const named = response.headers
    return RESOLVED_HEADERS.map((name) => named[name]).find((value) => !!value)
  }).pipe(
    Effect.timeout(Duration.seconds(20)),
    Effect.catchCause((cause) =>
      Effect.as(
        Effect.logWarning("model context size: could not resolve the alias", {
          baseURL,
          modelID,
          cause: Cause.pretty(cause),
        }),
        undefined,
      ),
    ),
    Effect.tap((resolved) => Effect.sync(() => aliases.set(`${baseURL}::${modelID}`, resolved))),
  )

/**
 * Resolves a model id that is an **alias** rather than a model. A gateway entry like
 * `opencode-go-default` is a routing name: it has no context size of its own and no catalog entry, and
 * only a real request reveals what it points at. The answer is the resolved model's catalog size, so
 * the number still comes from a source that knows it rather than from a guess.
 *
 * Only reached when the context size is still 0 after the `/models` probe. That is the right trigger:
 * every id the catalog knows already arrived with a limit from the models.dev plugin, so anything still
 * at 0 is an alias - and an alias is the only thing that costs a request.
 */
export function resolveAlias(input: {
  readonly baseURL: string | undefined
  readonly headers: Record<string, string> | undefined
  readonly modelID: string
  readonly current: number
  readonly limits: ReadonlyMap<string, number>
}): Effect.Effect<number, never, HttpClient.HttpClient> {
  if (input.current > 0 || !input.baseURL || !input.headers) return Effect.succeed(input.current)
  const baseURL = input.baseURL
  const auth = input.headers
  return Effect.gen(function* () {
    const key = `${baseURL}::${input.modelID}`
    const cached = aliases.get(key)
    if (cached !== undefined) return input.limits.get(cached) ?? input.current
    const resolved = yield* askAlias(baseURL, auth, input.modelID)
    if (!resolved) return input.current
    const size = input.limits.get(resolved)
    if (size === undefined) {
      yield* Effect.logWarning("model context size: the alias resolved to a model the catalog does not describe", {
        modelID: input.modelID,
        resolved,
      })
      return input.current
    }
    yield* Effect.logInfo("resolved a model alias to its context size", {
      modelID: input.modelID,
      resolved,
      context: size,
    })
    return size
  })
}

