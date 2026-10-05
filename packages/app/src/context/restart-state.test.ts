import { describe, expect, test } from "bun:test"
import { deadlineFrom, phaseAfterPoll, type LifecycleInfo } from "./restart-state"

const info = (draining: boolean, remainingMs: number | null = null): LifecycleInfo => ({
  draining,
  remainingMs,
  reason: null,
  activeTurns: 0,
})

describe("phaseAfterPoll", () => {
  test("a failed poll holds input — a daemon that died without draining is the case that must not look idle", () => {
    expect(phaseAfterPoll("idle", { ok: false })).toBe("reconnecting")
    expect(phaseAfterPoll("draining", { ok: false })).toBe("reconnecting")
  })

  test("404 means an old server, not an outage — its input is never held", () => {
    // The deploy that introduced the endpoint is newer than some servers the app talks to; a permanent
    // "reconnecting" on those would make the hold useless by being always on.
    expect(phaseAfterPoll("reconnecting", { ok: true, status: 404 })).toBe("idle")
    expect(phaseAfterPoll("draining", { ok: true, status: 404 })).toBe("idle")
  })

  test("a draining report wins over whatever came before", () => {
    expect(phaseAfterPoll("idle", { ok: true, status: 200, info: info(true, 45_000) })).toBe("draining")
    expect(phaseAfterPoll("reconnecting", { ok: true, status: 200, info: info(true, 45_000) })).toBe("draining")
  })

  test("a calm report ends the hold, from every phase", () => {
    for (const before of ["idle", "draining", "reconnecting"] as const) {
      expect(phaseAfterPoll(before, { ok: true, status: 200, info: info(false) })).toBe("idle")
    }
  })

  test("a 500 is an outage, not an old server", () => {
    expect(phaseAfterPoll("idle", { ok: true, status: 500 })).toBe("reconnecting")
  })
})

describe("deadlineFrom", () => {
  test("stamps the client's own clock with the reported duration", () => {
    expect(deadlineFrom(1_000, 45_000)).toBe(46_000)
  })

  test("a missing or negative duration reads as 'already elapsed', never as a future deadline", () => {
    expect(deadlineFrom(1_000, null)).toBe(1_000)
    expect(deadlineFrom(1_000, undefined)).toBe(1_000)
    expect(deadlineFrom(1_000, -5)).toBe(1_000)
  })
})
