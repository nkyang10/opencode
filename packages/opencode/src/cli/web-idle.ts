export * as WebIdle from "./web-idle"

import { Duration, Effect } from "effect"
import { ActiveTurns } from "@/session/active-turns"
import { ServerMaintenance } from "@/server/maintenance"

// The fork's long-lived `web` server accumulates Bun/JSC heap high-water that a full GC never returns to
// the OS, so the only real reclaim is a fresh process. This module is that trigger for the default
// `opencode web` path: after a stretch of silence it asks `ServerMaintenance` to restart, which already
// knows how to hand the port to a replacement under a systemd unit or by spawning a detached child.

/** Idle window before a reclaim restart, when the config omits `server.webui.idleRestartSeconds`. */
export const DefaultIdleSeconds = 3 * 60 * 60

/** How often the monitor re-checks. Coarse on purpose: a memory reclaim is not latency-sensitive. */
export const CheckInterval = Duration.minutes(1)

export function shouldRestart(input: {
  lastActivity: number
  activeTurns: number
  now: number
  idleMs: number
}) {
  if (input.activeTurns > 0) return false
  // Never restarted before the first turn: a fresh server that has done no work has no heap to reclaim,
  // and restarting it would make a restarted server keep restarting forever.
  if (input.lastActivity === 0) return false
  return input.now - input.lastActivity >= input.idleMs
}

/** One idle check. Repeated by `Effect.repeat(Schedule.spaced(CheckInterval))` from the `web` command. */
export function check(idleSeconds: number) {
  return Effect.gen(function* () {
    const idle = yield* Effect.sync(
      () =>
        shouldRestart({
          lastActivity: ActiveTurns.lastActivity(),
          activeTurns: ActiveTurns.active(),
          now: Date.now(),
          idleMs: idleSeconds * 1000,
        }),
    )
    if (!idle) return
    process.stderr.write(`[webui] idle for over ${idleSeconds}s — restarting to reclaim memory\n`)
    ServerMaintenance.request(() => Promise.resolve(ActiveTurns.active()))
  })
}
