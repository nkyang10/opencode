// The restart window (s100 / item 1 of ide `40-knowledge/session-interruption-recovery.md`).
//
// A deploy used to `kill` the daemon and `kill -9` two seconds later, which is a hard kill: whatever
// the agent was doing simply stops, and the transcript keeps a half-written assistant message with no
// completion time. Nothing in the UI could say so — the reader saw a finished-looking answer.
//
// This module is the fact that lets the server say it out loud, and lets it drain instead of being
// cut. It is deliberately **process-global**, not `InstanceState`: the window belongs to the process,
// while `InstanceState` is keyed per directory and would give every project its own answer.
//
// Two design points that are load-bearing, not decoration:
//
// - `remainingMs` travels instead of a deadline timestamp. The client stamps its own local deadline as
//   `Date.now() + remainingMs`, so a device with a skewed clock still counts the right number of
//   seconds. Same reasoning as DEC-060: derive the number where it is known.
// - Arming the window never blocks the caller. `arm()` is safe to call from a signal handler, from the
//   deploy script through HTTP, or twice in a row.

export * as ServerLifecycle from "./lifecycle"

const DefaultTimeoutMs = 60_000

let deadline: number | undefined
let armedBy: string | undefined

export type Info = {
  /** True while the window is armed — the server is about to stop. */
  draining: boolean
  /**
   * Milliseconds left before the window closes, or `null` when no window is armed.
   * Never negative: a window that already elapsed reads as `0`, which is what a client
   * should show while it waits for the server to come back.
   */
  remainingMs: number | null
  /** What armed the window, for the log line and for support. */
  reason: string | null
}

/**
 * Arm (or re-arm) the window. While a window is **open**, a later request can only take over by being
 * *shorter*: someone asking for 60 s must not push out a 60 s window someone else already opened, or a
 * stray request could silently double every reader's wait.
 *
 * An **expired** window is not a window. It stays visible as `draining` (this process really is still up
 * and still supposed to stop — unblocking input now and dying a second later is the worse lie), but it
 * must not block the next arm. Found by arming a window on a live server after a previous one had
 * elapsed and watching the new arm be silently ignored.
 */
export function arm(timeoutMs = DefaultTimeoutMs, reason = "requested") {
  const now = Date.now()
  const requested = now + Math.max(0, timeoutMs)
  if (deadline !== undefined && deadline > now) {
    if (deadline <= requested) return info()
    deadline = requested
    armedBy = reason
    return info()
  }
  deadline = requested
  armedBy = reason
  return info()
}

/** Close the window early — the drain finished, so there is nothing left to wait for. */
export function disarm() {
  deadline = undefined
  armedBy = undefined
}

export function info(): Info {
  if (deadline === undefined) return { draining: false, remainingMs: null, reason: null }
  return {
    draining: true,
    remainingMs: Math.max(0, deadline - Date.now()),
    reason: armedBy ?? null,
  }
}

/** How long is left, for a drain loop that wants to sleep until the window closes. */
export function remainingMs() {
  if (deadline === undefined) return 0
  return Math.max(0, deadline - Date.now())
}

export function reason() {
  return armedBy
}

export { DefaultTimeoutMs }