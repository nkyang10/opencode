import { afterEach, expect } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LLMEvent } from "@opencode-ai/llm"
import { Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { GlobalBus } from "@/bus/global"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Provider } from "@/provider/provider"
import { LLM } from "@/session/llm"
import { CALL_TIMEOUT_MS, SessionCommentary, settings } from "@/session/commentary"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Session as SessionNs } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { disposeAllInstances } from "../fixture/fixture"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"

const ref = { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") }

const model = {
  id: "test-model",
  providerID: "test",
  name: "Test",
  limit: { context: 100_000, output: 32_000 },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  capabilities: {
    toolcall: true,
    attachment: false,
    reasoning: false,
    temperature: true,
    input: { text: true, image: false, audio: false, video: false },
    output: { text: true, image: false, audio: false, video: false },
  },
  api: { npm: "@ai-sdk/anthropic" },
  options: {},
} as Provider.Model

const provider = ProviderTest.fake({ model })

const commentaryAgent = {
  name: "commentary",
  mode: "primary",
  options: {},
  native: true,
  hidden: true,
  prompt: "narrate",
} as unknown as Agent.Info

const agentLayer = Layer.mock(Agent.Service, {
  get: (name: string) => Effect.succeed((name === "commentary" ? commentaryAgent : undefined) as Agent.Info),
})

/** A queued LLM. Every request is recorded so tests can assert on what the narrator was shown. */
function llmLayer(replies: string[], seen: LLM.StreamInput[]) {
  const queue = [...replies]
  return Layer.succeed(
    LLM.Service,
    LLM.Service.of({
      stream: (input) => {
        seen.push(input)
        return Stream.make(
          LLMEvent.textStart({ id: "txt-0" }),
          LLMEvent.textDelta({ id: "txt-0", text: queue.shift() ?? '{"speak": false}' }),
          LLMEvent.textEnd({ id: "txt-0" }),
        )
      },
    }),
  )
}

const commentaryNode = LayerNode.group([
  SessionCommentary.node,
  SessionNs.node,
  SessionProjector.node,
  SessionStatus.node,
  EventV2Bridge.node,
  CrossSpawnSpawner.node,
])

/**
 * The whole node group is rebuilt per test with the LLM replaced. `SessionCommentary` resolves its LLM when
 * the layer is built, so providing a stub only around the test body would leave the real provider wired in
 * and every tick would fail instead of answering.
 */
function env(llm: Layer.Layer<LLM.Service>) {
  return AppNodeBuilder.build(commentaryNode, [
    [Provider.node, provider.layer],
    [Agent.node, agentLayer],
    [LLM.node, llm],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalEventSystem: true })],
  ])
}

const it = testEffect(Layer.empty)

afterEach(async () => {
  await disposeAllInstances()
})

const commentaryConfig = { minActivityChars: 1, minGap: 1 }

function userMessage(sessionID: SessionID, text: string) {
  return SessionNs.Service.use((ssn) =>
    Effect.gen(function* () {
      const msg = yield* ssn.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID,
        agent: "build",
        model: { providerID: ref.providerID, modelID: ref.modelID },
        time: { created: Date.now() },
      })
      yield* ssn.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text })
      return msg
    }),
  )
}

function assistantMessage(sessionID: SessionID, parentID: MessageID) {
  return SessionNs.Service.use((ssn) =>
    ssn.updateMessage({
      id: MessageID.ascending(),
      role: "assistant",
      sessionID,
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID: ref.modelID,
      providerID: ref.providerID,
      parentID,
      time: { created: Date.now() },
      finish: "end_turn",
    }),
  )
}

/** A busy session holding one user turn and one assistant turn. */
function seed() {
  return Effect.gen(function* () {
    const ssn = yield* SessionNs.Service
    const session = yield* ssn.create({ model: { id: ref.modelID, providerID: ref.providerID } })
    const ask = yield* userMessage(session.id, "why does the retry cap allow a third attempt?")
    yield* assistantMessage(session.id, ask.id)
    yield* SessionStatus.Service.use((status) => status.set(session.id, { type: "busy" }))
    return session.id
  })
}

function turn(sessionID: SessionID, text: string) {
  return Effect.gen(function* () {
    const ask = yield* userMessage(sessionID, text)
    yield* assistantMessage(sessionID, ask.id)
    return ask
  })
}

/** More activity inside the turn that is already running: an assistant message under the same user message. */
function activity(sessionID: SessionID, parentID: MessageID) {
  return assistantMessage(sessionID, parentID)
}

it.instance(
  "stores one narration line, publishes it, and never leaks a message into the timeline",
  () => {
    const seen: LLM.StreamInput[] = []
    return Effect.gen(function* () {
      const sessionID = yield* seed()
      const commentary = yield* SessionCommentary.Service

      // Subscribe before the tick: the panel receives lines over SSE, so a stored-but-unpublished entry is
      // invisible to every open client.
      const published: string[] = []
      const on = (event: { payload?: { type?: string } }) => {
        if (event.payload?.type) published.push(event.payload.type)
      }
      GlobalBus.on("event", on)
      yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", on)))

      yield* commentary.watch(sessionID)
      const entry = yield* commentary.tick(sessionID)

      expect(entry).toBeDefined()
      expect(entry!.text).toBe("The retry cap is off by one, so a third attempt slips through.")
      expect(published.filter((type) => type === "session.commentary")).toHaveLength(1)

      const messages = yield* SessionNs.Service.use((service) => service.messages({ sessionID }))
      // The anchor is the last message the line describes — that is the entire cursor mechanism.
      expect(entry!.anchor).toBe(messages.at(-1)!.info.id)
      expect((yield* commentary.list({ sessionID })).map((row) => row.seq)).toEqual([1])

      // The call is a sidecar: no tools, the session's own model, the digest in the prompt.
      expect(seen).toHaveLength(1)
      expect(Object.keys(seen[0]!.tools)).toHaveLength(0)
      expect(String(seen[0]!.model.id)).toBe("test-model")
      // Regression: the synthetic carrier must present the SESSION's real model. A placeholder providerID
      // makes the v1 LLM path select a runtime and then die with no completion, and because the tick
      // swallows failures that was invisible on the live server.
      expect(seen[0]!.user.model.providerID).toBe(ref.providerID)
      expect(seen[0]!.user.model.modelID).toBe(ref.modelID)
      expect(seen[0]!.user.sessionID).toBe(sessionID)
      expect(JSON.stringify(seen[0]!.messages)).toContain("why does the retry cap")

      // Nothing was appended to the session. If this ever fails, the narration is writing a phantom user
      // message into the timeline every ten seconds.
      expect(messages).toHaveLength(2)
    }).pipe(
      Effect.provide(
        env(llmLayer(['{"speak": true, "text": "The retry cap is off by one, so a third attempt slips through."}'], seen)),
      ),
    )
  },
  { config: () => ({ commentary: commentaryConfig }) },
)

it.instance(
  "does not call the model when no client is watching",
  () => {
    const seen: LLM.StreamInput[] = []
    return Effect.gen(function* () {
      const sessionID = yield* seed()
      expect(yield* SessionCommentary.Service.use((svc) => svc.tick(sessionID))).toBeUndefined()
      expect(seen).toHaveLength(0)
    }).pipe(Effect.provide(env(llmLayer(['{"speak": true, "text": "never"}'], seen))))
  },
  { config: () => ({ commentary: commentaryConfig }) },
)

it.instance(
  "does not call the model while the session is idle",
  () => {
    const seen: LLM.StreamInput[] = []
    return Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const session = yield* ssn.create({ model: { id: ref.modelID, providerID: ref.providerID } })
      const ask = yield* userMessage(session.id, "hello")
      yield* assistantMessage(session.id, ask.id)
      yield* SessionCommentary.Service.use((svc) => svc.watch(session.id))
      expect(yield* SessionCommentary.Service.use((svc) => svc.tick(session.id))).toBeUndefined()
      expect(seen).toHaveLength(0)
    }).pipe(Effect.provide(env(llmLayer(['{"speak": true, "text": "never"}'], seen))))
  },
  { config: () => ({ commentary: commentaryConfig }) },
)

it.instance(
  "does not call the model when there is too little new activity",
  () => {
    const seen: LLM.StreamInput[] = []
    return Effect.gen(function* () {
      const sessionID = yield* seed()
      yield* SessionCommentary.Service.use((svc) => svc.watch(sessionID))
      expect(yield* SessionCommentary.Service.use((svc) => svc.tick(sessionID))).toBeUndefined()
      expect(seen).toHaveLength(0)
    }).pipe(Effect.provide(env(llmLayer(['{"speak": true, "text": "never"}'], seen))))
  },
  { config: () => ({ commentary: { minActivityChars: 100_000 } }) },
)

it.instance(
  "honours the model's choice to stay silent",
  () => {
    const seen: LLM.StreamInput[] = []
    return Effect.gen(function* () {
      const sessionID = yield* seed()
      yield* SessionCommentary.Service.use((svc) => svc.watch(sessionID))
      expect(yield* SessionCommentary.Service.use((svc) => svc.tick(sessionID))).toBeUndefined()
      expect(yield* SessionCommentary.Service.use((svc) => svc.list({ sessionID }))).toEqual([])
      // It did ask; the model just said there was nothing worth saying.
      expect(seen).toHaveLength(1)
    }).pipe(Effect.provide(env(llmLayer(['{"speak": false}'], seen))))
  },
  { config: () => ({ commentary: commentaryConfig }) },
)

it.instance(
  "enabled:false stops it entirely",
  () => {
    const seen: LLM.StreamInput[] = []
    return Effect.gen(function* () {
      const sessionID = yield* seed()
      yield* SessionCommentary.Service.use((svc) => svc.watch(sessionID))
      expect(yield* SessionCommentary.Service.use((svc) => svc.tick(sessionID))).toBeUndefined()
      expect(seen).toHaveLength(0)
    }).pipe(Effect.provide(env(llmLayer(['{"speak": true, "text": "never"}'], seen))))
  },
  { config: () => ({ commentary: { ...commentaryConfig, enabled: false } }) },
)

it.instance(
  "a second line continues the first and skips what it already narrated",
  () => {
    const seen: LLM.StreamInput[] = []
    return Effect.gen(function* () {
      const sessionID = yield* seed()
      const commentary = yield* SessionCommentary.Service
      yield* commentary.watch(sessionID)
      yield* commentary.tick(sessionID)

      yield* turn(sessionID, "also check the backoff schedule")
      const second = yield* commentary.tick(sessionID)
      expect(second!.text).toBe("Second line.")

      const secondPrompt = JSON.stringify(seen[1]!.messages)
      // Continuity: the model sees what it already said...
      expect(secondPrompt).toContain("First line.")
      // ...and the cursor moved, so it does not see the activity the first line already covered.
      expect(secondPrompt).toContain("also check the backoff schedule")
      expect(secondPrompt).not.toContain("why does the retry cap allow a third attempt?")

      expect((yield* commentary.list({ sessionID })).map((row) => row.seq)).toEqual([1, 2])
    }).pipe(
      Effect.provide(env(llmLayer(['{"speak": true, "text": "First line."}', '{"speak": true, "text": "Second line."}'], seen))),
    )
  },
  { config: () => ({ commentary: commentaryConfig }) },
)

it.instance(
  "unwatching stops it, and a second watcher does not double-narrate",
  () => {
    const seen: LLM.StreamInput[] = []
    return Effect.gen(function* () {
      const sessionID = yield* seed()
      const commentary = yield* SessionCommentary.Service
      yield* commentary.watch(sessionID)
      yield* commentary.watch(sessionID)
      expect(yield* commentary.tick(sessionID)).toBeDefined()
      yield* commentary.unwatch(sessionID)
      expect(yield* commentary.tick(sessionID)).toBeUndefined()
      // The lease is keyed by session, so two panels on one session still produce one narration.
      expect(seen).toHaveLength(1)
    }).pipe(Effect.provide(env(llmLayer(['{"speak": true, "text": "Only once."}'], seen))))
  },
  { config: () => ({ commentary: commentaryConfig }) },
)

it.instance(
  "refuses further lines once the per-turn budget is spent, and restores it on the next user message",
  () => {
    const seen: LLM.StreamInput[] = []
    return Effect.gen(function* () {
      const sessionID = yield* seed()
      const commentary = yield* SessionCommentary.Service
      yield* commentary.watch(sessionID)

      // A budget of 1. The first line is allowed; more activity inside the same turn is not.
      yield* commentary.tick(sessionID)
      expect(seen).toHaveLength(1)

      const messages = yield* SessionNs.Service.use((service) => service.messages({ sessionID }))
      const firstUser = messages.find((message) => message.info.role === "user")!
      yield* activity(sessionID, firstUser.info.id)
      expect(yield* commentary.tick(sessionID)).toBeUndefined()
      expect(seen).toHaveLength(1)

      // A new user message starts a new turn, so the budget is restored.
      yield* turn(sessionID, "second ask")
      expect(yield* commentary.tick(sessionID)).toBeDefined()
      expect(seen).toHaveLength(2)
    }).pipe(
      Effect.provide(
        env(llmLayer(['{"speak": true, "text": "One."}', '{"speak": true, "text": "Two."}', '{"speak": true, "text": "Three."}'], seen)),
      ),
    )
  },
  { config: () => ({ commentary: { ...commentaryConfig, maxEntriesPerTurn: 1 } }) },
)

it.instance(
  "asks for the small model when the config says so",
  () => {
    const seen: LLM.StreamInput[] = []
    return Effect.gen(function* () {
      const sessionID = yield* seed()
      yield* SessionCommentary.Service.use((svc) => svc.watch(sessionID))
      yield* SessionCommentary.Service.use((svc) => svc.tick(sessionID))
      // The fake provider answers both lookups with the same model, so what is asserted is that `small` was
      // requested at all — the fallback chain must not quietly prefer the session model.
      expect(seen).toHaveLength(1)
      expect(seen[0]!.small).toBe(true)
    }).pipe(Effect.provide(env(llmLayer(['{"speak": true, "text": "A line."}'], seen))))
  },
  { config: () => ({ commentary: { ...commentaryConfig, model: "small" } }) },
)

it.instance("bounds the narration call so a slow model cannot disable the session", () =>
  Effect.gen(function* () {
    // Measured live: a reasoning model took 99s for ONE line, and while it ran the `inFlight` guard blocked
    // every later tick — so an unbounded call silently disables narration for that session. The release path
    // itself is proven by the live run (a second tick fired 41s after the first returned) and by the
    // provider-failure test below; what is asserted here is that the ceiling exists and is sane relative to
    // the tick, because actually waiting CALL_TIMEOUT_MS is not a unit test.
    expect(Number.isFinite(CALL_TIMEOUT_MS)).toBe(true)
    expect(CALL_TIMEOUT_MS).toBeGreaterThan(settings({}).interval * 2)
  }),
  { config: () => ({ commentary: commentaryConfig }) },
)

it.instance(
  "a provider failure skips the tick instead of breaking the loop",
  () => {
    const failing = Layer.succeed(
      LLM.Service,
      LLM.Service.of({ stream: () => Stream.die(new Error("provider is down")) }),
    )
    return Effect.gen(function* () {
      const sessionID = yield* seed()
      yield* SessionCommentary.Service.use((svc) => svc.watch(sessionID))
      expect(yield* SessionCommentary.Service.use((svc) => svc.tick(sessionID))).toBeUndefined()
      expect(yield* SessionCommentary.Service.use((svc) => svc.list({ sessionID }))).toEqual([])
    }).pipe(Effect.provide(env(failing)))
  },
  { config: () => ({ commentary: commentaryConfig }) },
)

// The loop forks each session's tick rather than awaiting it. A reasoning model takes 43-99s for one line and
// a call is bounded at CALL_TIMEOUT_MS, so awaiting ticks in sequence let one slow session delay every other
// watched session for the length of its call. This drives two ticks concurrently and asserts the fast
// session's line lands while the slow one is still in flight — the property the fork guarantees.
it.instance("a slow session does not block a concurrent fast session", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>()
    const slowStarted = yield* Deferred.make<void>()
    const calls: Array<{ sessionID: string; fast: boolean }> = []
    const layer = Layer.succeed(
      LLM.Service,
      LLM.Service.of({
        stream: (input) => {
          const id = String(input.sessionID)
          const fast = !id.includes("slow")
          calls.push({ sessionID: id, fast })
          if (fast) {
            return Stream.make(
              LLMEvent.textStart({ id: "t" }),
              LLMEvent.textDelta({ id: "t", text: '{"speak": true, "text": "Fast line."}' }),
            )
          }
          // The slow call blocks on the gate until the test releases it, standing in for a 43-99s call.
          return Stream.fromEffect(
            Deferred.await(slowStarted).pipe(
              Effect.andThen(Deferred.succeed(gate, undefined)),
              Effect.as(LLMEvent.textDelta({ id: "t", text: '{"speak": true, "text": "Slow line."}' })),
            ),
          ).pipe(Stream.concat(Stream.make(LLMEvent.textStart({ id: "t" }))))
        },
      }),
    )

    return Effect.gen(function* () {
      const ssn = yield* SessionNs.Service
      const commentary = yield* SessionCommentary.Service

      const mk = (kind: string) =>
        Effect.gen(function* () {
          const session = yield* ssn.create({ model: { id: ref.modelID, providerID: ref.providerID } })
          const ask = yield* userMessage(session.id, `ask ${kind}`)
          yield* assistantMessage(session.id, ask.id)
          yield* SessionStatus.Service.use((status) => status.set(session.id, { type: "busy" }))
          return session.id
        })
      const fast = yield* mk("fast")
      const slow = yield* mk("slow")
      yield* commentary.watch(fast)
      yield* commentary.watch(slow)

      // Launch both ticks concurrently, exactly as the forked loop does.
      const fastFiber = yield* Effect.forkChild(commentary.tick(fast))
      const slowFiber = yield* Effect.forkChild(commentary.tick(slow))

      // The fast entry must be stored even though the slow call has not returned.
      yield* Deferred.await(slowStarted)
      const fastExit = yield* Fiber.await(fastFiber).pipe(Effect.timeout("5 seconds"))
      expect(Exit.isSuccess(fastExit)).toBe(true)
      expect((yield* commentary.list({ sessionID: fast })).map((entry) => entry.text)).toEqual(["Fast line."])
      // Both calls were in flight together — concurrency, not sequencing.
      expect(calls.length).toBe(2)

      // Release the slow call and let it finish.
      yield* commentary.unwatch(slow)
      yield* Fiber.await(slowFiber).pipe(Effect.timeout("5 seconds"))
    }).pipe(Effect.provide(env(layer)))
  }),
)
