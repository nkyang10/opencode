import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Catalog } from "@opencode-ai/core/catalog"
import { Config } from "@opencode-ai/core/config"
import { ConfigProviderPlugin } from "@opencode-ai/core/config/plugin/provider"
import { Integration } from "@opencode-ai/core/integration"
import { ModelContextSize } from "@opencode-ai/core/model-context-size"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { ModelV2 } from "@opencode-ai/core/model"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(PluginTestLayer)

type CatalogShape = Parameters<typeof ModelContextSize.catalogLimits>[0]

// The stub is the catalog `catalogLimits` reads. It is cast to the service type because the fixture
// does not carry the full ModelsDev.Provider contract, and this test is about the limit lookup, not
// about catalog decoding.
const stubModelsDev = (data: CatalogShape) =>
  ModelsDev.Service.of({
    get: () => Effect.succeed(data as unknown as Record<string, ModelsDev.Provider>),
    refresh: () => Effect.void,
  })

const addPlugin = Effect.fn(function* (config: Config.Interface, catalog: CatalogShape) {
  const plugin = yield* PluginV2.Service
  const host = yield* PluginHost.make(plugin)
  yield* ConfigProviderPlugin.Plugin.effect(host).pipe(
    Effect.provideService(Config.Service, config),
    Effect.provideService(ModelsDev.Service, stubModelsDev(catalog)),
  )
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

function withEnv<A, E, R>(vars: Record<string, string | undefined>, effect: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
      Object.entries(vars).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      return previous
    }),
    effect,
    (previous) =>
      Effect.sync(() =>
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }),
      ),
  )
}

function request(headers: Record<string, string>, variant?: string) {
  return {
    headers,
    variant,
  }
}

const decode = Schema.decodeUnknownSync(Config.Info)

describe("ConfigProviderPlugin.Plugin", () => {
  it.effect("keeps configured model variant bodies unchanged", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.opencode
      const modelID = ModelV2.ID.make("alpha-gpt-next")
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  opencode: {
                    api: { type: "aisdk", package: "@ai-sdk/openai", url: "https://opencode.test/v1" },
                    models: {
                      "alpha-gpt-next": {
                        variants: [
                          {
                            id: "high",
                            body: {
                              reasoningEffort: "high",
                              reasoningSummary: "auto",
                              include: ["reasoning.encrypted_content"],
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              }),
            }),
          ]),
      })

      yield* addPlugin(config, {})

      const model = required(yield* catalog.model.get(providerID, modelID))
      expect(model.variants).toMatchObject([
        {
          id: "high",
          body: {
            reasoningEffort: "high",
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
        },
      ])
    }),
  )

  it.effect("keeps layered model variant bodies unchanged", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = ProviderV2.ID.opencode
      const modelID = ModelV2.ID.make("alpha-gpt-next")
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  opencode: {
                    api: { type: "aisdk", package: "@ai-sdk/openai", url: "https://opencode.test/v1" },
                  },
                },
              }),
            }),
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  opencode: {
                    models: {
                      "alpha-gpt-next": {
                        variants: [{ id: "high", body: { reasoningEffort: "high" } }],
                      },
                    },
                  },
                },
              }),
            }),
          ]),
      })

      yield* addPlugin(config, {})

      const model = required(yield* catalog.model.get(providerID, modelID))
      expect(model.variants[0]).toMatchObject({
        id: "high",
        body: { reasoningEffort: "high" },
      })
    }),
  )

  it.effect("loads configured providers and applies later model overrides", () =>
    withEnv({ CUSTOM_API_KEY: "secret" }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const integrations = yield* Integration.Service
        const providerID = ProviderV2.ID.make("custom")
        const modelID = ModelV2.ID.make("chat")
        const config = Config.Service.of({
          entries: () =>
            Effect.succeed([
              new Config.Document({
                type: "document",
                info: decode({
                  model: "custom/first",
                  providers: {
                    custom: {
                      name: "Configured",
                      env: ["CUSTOM_API_KEY"],
                      api: { type: "native", settings: {} },
                      request: request({ first: "first", shared: "first" }),
                      models: {
                        chat: {
                          name: "First",
                          capabilities: { tools: true, input: ["text"], output: ["text"] },
                          disabled: true,
                          limit: { context: 100, output: 50 },
                          cost: { input: 1, output: 2 },
                          request: request({ first: "first", shared: "first" }, "retained"),
                          variants: [
                            {
                              id: "fast",
                              headers: { first: "first", shared: "first" },
                            },
                          ],
                        },
                      },
                    },
                  },
                }),
              }),
              new Config.Document({
                type: "document",
                info: decode({
                  model: "custom/default",
                  providers: {
                    custom: {
                      api: { type: "aisdk", package: "custom-sdk", url: "https://example.test" },
                      request: request({ last: "last", shared: "last" }),
                      models: {
                        default: {
                          name: "Default",
                        },
                        chat: {
                          api: { id: "api-chat" },
                          name: "Last",
                          limit: { output: 75 },
                          request: request({ last: "last", shared: "last" }),
                          variants: [
                            {
                              id: "fast",
                              headers: { last: "last", shared: "last" },
                            },
                            {
                              id: "slow",
                              headers: { slow: "slow" },
                            },
                          ],
                        },
                      },
                    },
                  },
                }),
              }),
              new Config.Document({
                type: "document",
                info: decode({
                  providers: {
                    custom: { name: "Renamed" },
                  },
                }),
              }),
            ]),
        })

        yield* addPlugin(config, {})

        const provider = required(yield* catalog.provider.get(providerID))
        const model = required(yield* catalog.model.get(providerID, modelID))
        expect((yield* catalog.model.default())?.id).toBe(ModelV2.ID.make("default"))
        expect(provider.name).toBe("Renamed")
        expect((yield* integrations.get(Integration.ID.make("custom")))?.methods).toContainEqual({
          type: "env",
          names: ["CUSTOM_API_KEY"],
        })
        expect((yield* integrations.get(Integration.ID.make("custom")))?.name).toBe("Renamed")
        expect(provider.disabled).toBeUndefined()
        expect(provider.api).toEqual({ type: "aisdk", package: "custom-sdk", url: "https://example.test" })
        expect(provider.request.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.api.id).toBe(ModelV2.ID.make("api-chat"))
        expect(model.name).toBe("Last")
        expect(model.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] })
        expect(model.enabled).toBe(false)
        expect(model.limit).toEqual({ context: 100, output: 75 })
        expect(model.cost).toEqual([{ input: 1, output: 2, cache: { read: 0, write: 0 }, tier: undefined }])
        expect(model.request.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.request.variant).toBe("retained")
        expect(model.variants.map((variant) => variant.id)).toEqual([
          ModelV2.VariantID.make("fast"),
          ModelV2.VariantID.make("slow"),
        ])
        expect(model.variants[0]?.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.variants[1]?.headers).toEqual({ slow: "slow" })
      }),
    ),
  )

  // End to end through the real plugin: a config model with no `limit` block against a gateway that
  // answers like vLLM. A real Bun server, because the wiring under test is the request itself.
  describe("filling a missing context size from the provider API", () => {
    const withGateway = <A, E, R>(
      models: unknown,
      resolved: string | undefined,
      use: (url: string, seen: () => (string | undefined)[]) => Effect.Effect<A, E, R>,
    ) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const seen: (string | undefined)[] = []
          const server = Bun.serve({
            port: 0,
            fetch: (request) => {
              const path = new URL(request.url).pathname
              seen.push(request.headers.get("authorization") ?? undefined)
              if (path === "/v1/models") return Response.json(models)
              // An alias answers with no size of its own; the model it served is named in a header,
              // which is how OpenCode's Zen service reports a resolved routing name.
              if (path === "/v1/chat/completions") {
                return Response.json(
                  { id: "x", object: "chat.completion", model: "resolved", choices: [], usage: {} },
                  { headers: resolved ? { "x-zen-model": resolved } : {} },
                )
              }
              return new Response("not found", { status: 404 })
            },
          })
          return { server, seen }
        }),
        ({ server, seen }) => use(`${server.url.toString()}v1`, () => seen),
        ({ server }) => Effect.sync(() => server.stop(true)),
      )

    const providerID = ProviderV2.ID.make("gateway")
    const modelID = ModelV2.ID.make("general")

    const configFor = (url: string, model: Record<string, unknown>) =>
      Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  gateway: {
                    api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url, settings: { apiKey: "k" } },
                    models: { general: model },
                  },
                },
              }),
            }),
          ]),
      })

    it.effect("fills a zero context size from the gateway's own report", () =>
      withGateway({ data: [{ id: "general", max_model_len: 1048576 }] }, undefined, (url, seen) =>
        Effect.gen(function* () {
          const catalog = yield* Catalog.Service
          yield* addPlugin(configFor(url, { name: "Gateway" }), {})
          expect(required(yield* catalog.model.get(providerID, modelID)).limit.context).toBe(1048576)
          expect(seen()).toEqual(["Bearer k"])
        }),
      ),
    )

    it.effect("never overwrites a context size the config already set", () =>
      withGateway({ data: [{ id: "general", max_model_len: 1048576 }] }, undefined, (url, seen) =>
        Effect.gen(function* () {
          const catalog = yield* Catalog.Service
          yield* addPlugin(configFor(url, { name: "Gateway", limit: { context: 500000, output: 32000 } }), {})
          expect(required(yield* catalog.model.get(providerID, modelID)).limit.context).toBe(500000)
          expect(seen()).toEqual([])
        }),
      ),
    )

    it.effect("resolves an alias through the model its response names", () =>
      // The live `ocgo` case: `/v1/models` says nothing, the id is not a model at all, and the
      // resolved model is described by the catalog.
      withGateway({ data: [{ id: "general", object: "model" }] }, "space-bunny-free", (url, seen) =>
        Effect.gen(function* () {
          const catalog = yield* Catalog.Service
          yield* addPlugin(configFor(url, { name: "Gateway" }), {
            opencode: { models: { "space-bunny-free": { limit: { context: 1048576 } } } },
          })
          expect(required(yield* catalog.model.get(providerID, modelID)).limit.context).toBe(1048576)
          // one /v1/models, then one completion - and the credential rides both
          expect(seen()).toEqual(["Bearer k", "Bearer k"])
        }),
      ),
    )

    it.effect("stays at zero when the alias resolves to a model the catalog does not describe", () =>
      withGateway({ data: [{ id: "general", object: "model" }] }, "unlisted-model", (url, seen) =>
        Effect.gen(function* () {
          const catalog = yield* Catalog.Service
          yield* addPlugin(configFor(url, { name: "Gateway" }), {
            opencode: { models: { "space-bunny-free": { limit: { context: 1048576 } } } },
          })
          expect(required(yield* catalog.model.get(providerID, modelID)).limit.context).toBe(0)
          expect(seen().length).toBe(2)
        }),
      ),
    )

    it.effect("leaves the context size at zero when nothing can answer", () =>
      withGateway({ data: [{ id: "general", object: "model" }] }, undefined, (url, seen) =>
        Effect.gen(function* () {
          const catalog = yield* Catalog.Service
          yield* addPlugin(configFor(url, { name: "Gateway" }), {})
          expect(required(yield* catalog.model.get(providerID, modelID)).limit.context).toBe(0)
          // /v1/models, then the alias probe which gets no name back
          expect(seen().length).toBe(2)
        }),
      ),
    )
  })
})
