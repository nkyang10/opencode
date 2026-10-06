import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ServerLifecycle } from "@/server/lifecycle"
import { ActiveTurns } from "@/session/active-turns"

// The module reads Date.now() directly, so the clock is the only thing under test. Patching it here is
// what makes a window elapse deterministically — real sleeps would make this suite slow and flaky, and
// `bun:test` in this repo's pinned bun has no `setSystemTime`.
const realNow = Date.now
let clock = 0

function at(ms: number) {
  clock = ms
}

beforeEach(() => {
  clock = 0
  Date.now = () => clock
})

describe("ServerLifecycle", () => {
  afterEach(() => {
    ServerLifecycle.disarm()
    Date.now = realNow
  })

  test("no window is the resting state, and it says so with nulls rather than zeros", () => {
    at(0)
    expect(ServerLifecycle.info()).toEqual({ draining: false, remainingMs: null, reason: null, activeTurns: 0 })
  })

  test("arming reports a duration, not a timestamp, so a skewed client clock cannot change it", () => {
    at(0)
    const info = ServerLifecycle.arm(60_000, "deploy")
    expect(info.draining).toBe(true)
    expect(info.reason).toBe("deploy")
    expect(info.remainingMs).toBe(60_000)
  })

  test("remaining counts down on its own and never goes negative", () => {
    at(0)
    ServerLifecycle.arm(10_000, "deploy")
    at(4_000)
    expect(ServerLifecycle.remainingMs()).toBe(6_000)
    at(10_000)
    expect(ServerLifecycle.remainingMs()).toBe(0)
    // Past the deadline this reads as 0, not a negative number a client would render as a countdown —
    // and as NOT draining: a window that elapsed with no stop behind it must let input go back, or
    // every client holds forever with no route back (answering the poll proves the process is up;
    // a stop that is still coming shows up as the next poll failing).
    at(99_000)
    expect(ServerLifecycle.info().remainingMs).toBe(0)
    expect(ServerLifecycle.info().draining).toBe(false)
  })

  test("a later, longer window cannot push out one that is already running", () => {
    at(0)
    ServerLifecycle.arm(10_000, "deploy")
    at(2_000)
    // Someone asking for 60s must not extend a 10s window another caller already opened — otherwise a
    // stray request could silently double every reader's wait.
    ServerLifecycle.arm(60_000, "deploy-2")
    expect(ServerLifecycle.remainingMs()).toBe(8_000)
    expect(ServerLifecycle.info().reason).toBe("deploy")
  })

  test("a shorter window can still take over, which is how an impatient caller shortens a drain", () => {
    at(0)
    ServerLifecycle.arm(60_000, "deploy")
    at(1_000)
    ServerLifecycle.arm(5_000, "force")
    expect(ServerLifecycle.remainingMs()).toBe(5_000)
    expect(ServerLifecycle.info().reason).toBe("force")
  })

  test("disarm ends the window early — the case where the drain finished with nothing to wait for", () => {
    at(0)
    ServerLifecycle.arm(60_000, "deploy")
    ServerLifecycle.disarm()
    expect(ServerLifecycle.info()).toEqual({ draining: false, remainingMs: null, reason: null, activeTurns: 0 })
    expect(ServerLifecycle.remainingMs()).toBe(0)
  })

  test("an expired window does not block the next arm — the bug a live server found", () => {
    at(0)
    ServerLifecycle.arm(2_000, "impatient")
    at(5_000)
    // Elapsed: not draining any more, and reported as 0 rather than a negative.
    expect(ServerLifecycle.info().draining).toBe(false)
    expect(ServerLifecycle.info().remainingMs).toBe(0)
    // But the next caller must still get the window it asked for. Before the fix the stale deadline
    // compared as "earlier than now+8s", so this arm returned the old window and 8s never happened.
    const armed = ServerLifecycle.arm(8_000, "deploy")
    expect(armed.draining).toBe(true)
    expect(armed.remainingMs).toBe(8_000)
    expect(armed.reason).toBe("deploy")
  })

  test("the turn counter tracks what the drain waits for, and cannot go negative", () => {
    at(0)
    expect(ActiveTurns.active()).toBe(0)
    ActiveTurns.begin()
    ActiveTurns.begin()
    expect(ServerLifecycle.info().activeTurns).toBe(2)
    ActiveTurns.end()
    expect(ActiveTurns.active()).toBe(1)
    // A turn that ends twice (a defect, an old fiber's finalizer) must not push the count below zero
    // and turn "idle" into "-1 turns remaining".
    ActiveTurns.end()
    ActiveTurns.end()
    expect(ActiveTurns.active()).toBe(0)
  })

  test("a negative or absurd timeout cannot produce a negative window", () => {
    at(0)
    expect(ServerLifecycle.arm(-5, "bad").remainingMs).toBe(0)
    // A zero-length window is over the instant it exists, so it reads as "not draining" — which is
    // also why the signal handler re-arms the default rather than trusting it.
    expect(ServerLifecycle.arm(0, "now").draining).toBe(false)
  })
})