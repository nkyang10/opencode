import { Context, Deferred, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { SessionSchema } from "./schema"

export type State = { paused: boolean; waiting: boolean }

export interface Interface {
  readonly state: (sessionID: SessionSchema.ID) => Effect.Effect<State>
  readonly set: (sessionID: SessionSchema.ID, paused: boolean) => Effect.Effect<State>
  readonly awaitResume: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly clear: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

/** Process-owned execution control, shared by every Location and HTTP client. */
export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SessionPause") {}

const layer = Layer.sync(Service, () => {
  const entries = new Map<SessionSchema.ID, { gate: Deferred.Deferred<void>; waiting: boolean }>()
  const state = (sessionID: SessionSchema.ID): State => ({
    paused: entries.has(sessionID),
    waiting: entries.get(sessionID)?.waiting ?? false,
  })
  const set = (sessionID: SessionSchema.ID, paused: boolean) =>
    Effect.sync(() => {
      const entry = entries.get(sessionID)
      if (paused && !entry) entries.set(sessionID, { gate: Deferred.makeUnsafe<void>(), waiting: false })
      if (!paused && entry) {
        entries.delete(sessionID)
        Deferred.doneUnsafe(entry.gate, Effect.void)
      }
      return state(sessionID)
    })
  const awaitResume = (sessionID: SessionSchema.ID): Effect.Effect<void> =>
    Effect.suspend(() => {
      const entry = entries.get(sessionID)
      if (!entry) return Effect.void
      entry.waiting = true
      // Recheck after waking: another client may have requested a fresh pause.
      return Deferred.await(entry.gate).pipe(Effect.andThen(awaitResume(sessionID)))
    })
  return Service.of({
    state: (sessionID) => Effect.sync(() => state(sessionID)),
    set,
    awaitResume,
    clear: (sessionID) => set(sessionID, false).pipe(Effect.asVoid),
  })
})

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
export * as SessionPause from "./pause"
