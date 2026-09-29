import { afterEach, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionCommentaryTable } from "@opencode-ai/core/session/sql"
import { Config, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { Project } from "@/project/project"
import { InstanceBootstrap as InstanceBootstrapService } from "@/project/bootstrap-service"
import { InstanceStore } from "@/project/instance-store"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { SessionCommentary } from "@/session/commentary"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session } from "@/session/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)

const appLayer = AppNodeBuilder.build(
  LayerNode.group([InstanceStore.node, Project.node, Session.node, Database.node, Ripgrep.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)

const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)

const it = testEffect(
  Layer.mergeAll(
    appLayer,
    servedRoutes.pipe(
      Layer.provide(layerWebSocketConstructorGlobal),
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
)

function request(path: string, init?: RequestInit) {
  const url = new URL(path, "http://localhost")
  return HttpClientRequest.fromWeb(new Request(url, init)).pipe(
    HttpClientRequest.setUrl(url.pathname),
    HttpClient.execute,
  )
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  if (response.status !== 200) return response.text.pipe(Effect.flatMap((text) => Effect.die(new Error(text))))
  return response.json.pipe(Effect.map((value) => value as T))
}

const requestJson = <T,>(path: string, init?: RequestInit) => request(path, init).pipe(Effect.flatMap(json<T>))

function createSession() {
  return Session.use.create({ model: { id: ref.modelID, providerID: ref.providerID } })
}

function addText(sessionID: SessionID, text: string) {
  return Session.Service.use((service) =>
    Effect.gen(function* () {
      const info = yield* service.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID,
        agent: "build",
        model: { providerID: ref.providerID, modelID: ref.modelID },
        time: { created: Date.now() },
      })
      yield* service.updatePart({
        id: PartID.ascending(),
        sessionID,
        messageID: info.id,
        type: "text",
        text,
      })
      return info
    }),
  )
}

function insertEntry(sessionID: SessionID, seq: number, text: string, anchor: MessageID) {
  return Database.Service.use((database) =>
    database.db
      .insert(SessionCommentaryTable)
      .values([{ session_id: sessionID, seq, time: seq, text, anchor }])
      .run()
      .pipe(Effect.orDie),
  )
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

it.instance(
  "lists stored entries oldest first and honours the limit",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* createSession()
      yield* insertEntry(session.id, 1, "first", MessageID.make("msg_00000000000000000000000001"))
      yield* insertEntry(session.id, 2, "second", MessageID.make("msg_00000000000000000000000002"))
      yield* insertEntry(session.id, 3, "third", MessageID.make("msg_00000000000000000000000003"))

      const all = yield* requestJson<SessionCommentary.Entry[]>(
        `/session/${session.id}/commentary`,
        { headers: { "x-opencode-directory": test.directory } },
      )
      expect(all.map((entry) => entry.text)).toEqual(["first", "second", "third"])

      // The limit takes the newest entries; the panel is showing the tail of a long run.
      const limited = yield* requestJson<Array<{ text: string }>>(
        `/session/${session.id}/commentary?limit=2`,
        { headers: { "x-opencode-directory": test.directory } },
      )
      expect(limited.map((entry) => entry.text)).toEqual(["second", "third"])
    }),
  { config: () => ({ commentary: { enabled: false } }) },
)

it.instance(
  "watch takes a lease, unwatch releases it, and both are idempotent",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* createSession()
      const headers = { "x-opencode-directory": test.directory }

      const watched = yield* requestJson<boolean>(`/session/${session.id}/commentary/watch`, { method: "POST", headers })
      expect(watched).toBe(true)
      // A second panel on the same session refreshes the same lease rather than adding a reference.
      expect(yield* requestJson<boolean>(`/session/${session.id}/commentary/watch`, { method: "POST", headers })).toBe(true)

      expect(yield* requestJson<boolean>(`/session/${session.id}/commentary/unwatch`, { method: "POST", headers })).toBe(
        true,
      )
      expect(yield* requestJson<boolean>(`/session/${session.id}/commentary/unwatch`, { method: "POST", headers })).toBe(
        true,
      )
    }),
  { config: () => ({ commentary: { enabled: false } }) },
)

it.instance(
  "returns not found for a session that does not exist",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const missing = SessionID.descending()
      const headers = { "x-opencode-directory": test.directory }

      const list = yield* request(`/session/${missing}/commentary`, { headers })
      expect(list.status).toBe(404)

      const watch = yield* request(`/session/${missing}/commentary/watch`, { method: "POST", headers })
      expect(watch.status).toBe(404)
    }),
  { config: () => ({ commentary: { enabled: false } }) },
)

it.instance(
  "a bad limit is a bad request rather than a silently ignored query",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const session = yield* createSession()
      const response = yield* request(`/session/${session.id}/commentary?limit=nope`, {
        headers: { "x-opencode-directory": test.directory },
      })
      expect(response.status).toBe(400)
    }),
  { config: () => ({ commentary: { enabled: false } }) },
)
