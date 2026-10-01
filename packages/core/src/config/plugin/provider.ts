export * as ConfigProviderPlugin from "./provider"

import { define } from "../../plugin/internal"
import { Effect } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Config } from "../../config"
import { ModelContextSize } from "../../model-context-size"
import { ModelsDev } from "../../models-dev"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"

export const Plugin = define({
  id: "config-provider",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    // A catalog transform may not declare requirements, so the client is resolved once here and
    // handed to the transform's own effect rather than pulled from the ambient fiber.
    const http = yield* HttpClient.HttpClient
    const modelsDev = yield* ModelsDev.Service
    yield* ctx.integration.transform(
      Effect.fn(function* (integrations) {
        const files = (yield* config.entries()).filter((entry): entry is Config.Document => entry.type === "document")
        const configuredIntegrations = new Set(
          files.flatMap((file) =>
            Object.entries(file.info.providers ?? {}).flatMap(([id, provider]) =>
              provider.env === undefined ? [] : [id],
            ),
          ),
        )
        for (const file of files) {
          for (const [id, item] of Object.entries(file.info.providers ?? {})) {
            const integrationID = id
            if (!configuredIntegrations.has(id) && !integrations.get(integrationID)) continue
            integrations.update(integrationID, (integration) => {
              integration.name = item.name ?? integration.name
            })
            if (item.env !== undefined) {
              integrations.method.update({
                integrationID,
                method: { type: "env", names: [...item.env] },
              })
            }
          }
        }
      }),
    )

    yield* ctx.catalog.transform(
      Effect.fn(function* (catalog) {
        const entries = yield* config.entries()
        const files = entries.filter((entry): entry is Config.Document => entry.type === "document")
        const limits = ModelContextSize.catalogLimits(yield* modelsDev.get())
        const configuredDefault = Config.latest(entries, "model")
        if (configuredDefault !== undefined) {
          const model = ModelV2.parse(configuredDefault)
          catalog.model.default.set(model.providerID, model.modelID)
        }
        for (const file of files) {
          for (const [id, item] of Object.entries(file.info.providers ?? {})) {
            const providerID = id
            catalog.provider.update(providerID, (provider) => {
              if (item.name !== undefined) provider.name = item.name
              if (item.api !== undefined) provider.api = { ...item.api }
              if (item.request !== undefined) {
                Object.assign(provider.request.headers, item.request.headers)
                Object.assign(provider.request.body, item.request.body)
              }
            })
            for (const [id, config] of Object.entries(item.models ?? {})) {
              catalog.model.update(providerID, id, (model) => {
                if (config.family !== undefined) model.family = config.family
                if (config.name !== undefined) model.name = config.name
                if (config.api !== undefined) model.api = { ...model.api, ...config.api }
                if (config.capabilities !== undefined) {
                  model.capabilities = {
                    tools: config.capabilities.tools,
                    input: [...config.capabilities.input],
                    output: [...config.capabilities.output],
                  }
                }
                if (config.request !== undefined) {
                  Object.assign(model.request.headers, config.request.headers)
                  Object.assign(model.request.body, config.request.body)
                  if (config.request.variant !== undefined) model.request.variant = config.request.variant
                }
                if (config.variants !== undefined) {
                  for (const variant of config.variants) {
                    let existing = model.variants.find((item) => item.id === variant.id)
                    if (!existing) {
                      existing = {
                        id: variant.id,
                        headers: {},
                        body: {},
                      }
                      model.variants.push(existing)
                    }
                    Object.assign(existing.headers, variant.headers)
                    Object.assign(existing.body, variant.body)
                  }
                }
                if (config.cost !== undefined) {
                  model.cost = (Array.isArray(config.cost) ? config.cost : [config.cost]).map((cost) => ({
                    tier: cost.tier && { ...cost.tier },
                    input: cost.input,
                    output: cost.output,
                    cache: {
                      read: cost.cache?.read ?? 0,
                      write: cost.cache?.write ?? 0,
                    },
                  }))
                }
                if (config.disabled !== undefined) model.enabled = !config.disabled
                if (config.limit !== undefined) model.limit = { ...model.limit, ...config.limit }
              })

              // A config model with no `limit` keeps the `Model.Info.empty` default of 0, and 0 is not
              // a harmless placeholder: compaction bails on `context <= 0`, so such a session never
              // compacts and the context meter has no denominator. Ask the provider's own API once.
              // A limit the user wrote is never overwritten - only a missing one is filled.
              const record = catalog.provider.get(providerID)
              const baseURL = record?.provider.api.type === "aisdk" ? record.provider.api.url : undefined
              const auth = record && ModelContextSize.headers(record.provider)
              if (baseURL && auth) {
                const withClient = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                  effect.pipe(Effect.provideService(HttpClient.HttpClient, http))
                const fromProvider = yield* withClient(
                  ModelContextSize.fill({
                    baseURL,
                    headers: auth,
                    modelID: id,
                    current: catalog.model.get(providerID, id)?.limit.context ?? 0,
                  }),
                )
                // Still 0 means the id is an alias, not a model: nothing the provider lists can say
                // anything about it, and only a real request reveals what it points at.
                const context = yield* withClient(
                  ModelContextSize.resolveAlias({
                    baseURL,
                    headers: auth,
                    modelID: id,
                    current: fromProvider,
                    limits: limits,
                  }),
                )
                if (context > 0) {
                  catalog.model.update(providerID, id, (model) => {
                    model.limit.context = context
                  })
                }
              }
            }
          }
        }
      }),
    )
  }),
})
