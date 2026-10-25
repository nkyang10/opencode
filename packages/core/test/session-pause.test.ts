import { expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionPause } from "@opencode-ai/core/session/pause"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(SessionPause.node))
const id = SessionSchema.ID.make("ses_pause_test")
const other = SessionSchema.ID.make("ses_pause_other")

it.effect("pauses idempotently and releases exactly one waiting continuation", () =>
  Effect.gen(function* () {
    const pause = yield* SessionPause.Service
    yield* pause.set(id, true)
    yield* pause.set(id, true)
    let continued = 0
    const run = yield* pause.awaitResume(id).pipe(Effect.andThen(Effect.sync(() => continued++)), Effect.forkChild)
    yield* Effect.yieldNow
    expect(yield* pause.state(id)).toEqual({ paused: true, waiting: true })
    expect(continued).toBe(0)
    yield* pause.set(id, false)
    yield* pause.set(id, false)
    yield* Fiber.join(run)
    expect(continued).toBe(1)
    expect(yield* pause.state(id)).toEqual({ paused: false, waiting: false })
  }),
)

it.effect("one session's pause never blocks another", () =>
  Effect.gen(function* () {
    const pause = yield* SessionPause.Service
    yield* pause.set(id, true)
    yield* pause.awaitResume(other)
    expect(yield* pause.state(id)).toEqual({ paused: true, waiting: false })
    expect(yield* pause.state(other)).toEqual({ paused: false, waiting: false })
    yield* pause.clear(id)
  }),
)

it.effect("a fresh pause after resume holds the next continuation", () =>
  Effect.gen(function* () {
    const pause = yield* SessionPause.Service
    yield* pause.set(id, true)
    const first = yield* pause.awaitResume(id).pipe(Effect.forkChild)
    yield* Effect.yieldNow
    yield* pause.set(id, false)
    yield* Fiber.join(first)
    yield* pause.set(id, true)
    let continued = false
    const second = yield* pause.awaitResume(id).pipe(
      Effect.andThen(
        Effect.sync(() => {
          continued = true
        }),
      ),
      Effect.forkChild,
    )
    yield* Effect.yieldNow
    expect(continued).toBeFalse()
    expect(yield* pause.state(id)).toEqual({ paused: true, waiting: true })
    yield* pause.clear(id)
    yield* Fiber.join(second)
    expect(continued).toBeTrue()
  }),
)

it.effect("interrupt cleanup clears a paused waiter rather than stranding it", () =>
  Effect.gen(function* () {
    const pause = yield* SessionPause.Service
    yield* pause.set(id, true)
    const run = yield* pause.awaitResume(id).pipe(Effect.ensuring(pause.clear(id)), Effect.forkChild)
    yield* Effect.yieldNow
    yield* Fiber.interrupt(run)
    expect(yield* pause.state(id)).toEqual({ paused: false, waiting: false })
    yield* pause.awaitResume(id)
  }),
)
