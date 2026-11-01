import { describe, expect, test } from "bun:test"
import { WebIdle } from "../../src/cli/web-idle"

const HOUR = 60 * 60 * 1000
const IDLE = 3 * HOUR

describe("WebIdle.shouldRestart", () => {
  test("restarts once the last turn is older than the idle window", () => {
    const last = 10 * HOUR
    expect(WebIdle.shouldRestart({ lastActivity: last, activeTurns: 0, now: last + IDLE, idleMs: IDLE })).toBe(true)
  })

  test("holds off until the idle window has fully elapsed", () => {
    const last = 10 * HOUR
    expect(WebIdle.shouldRestart({ lastActivity: last, activeTurns: 0, now: last + IDLE - 1, idleMs: IDLE })).toBe(false)
  })

  test("never restarts a server that has not run a turn yet, so a restart does not loop", () => {
    expect(WebIdle.shouldRestart({ lastActivity: 0, activeTurns: 0, now: 100 * HOUR, idleMs: IDLE })).toBe(false)
  })

  test("waits while a turn is active even past the window", () => {
    expect(WebIdle.shouldRestart({ lastActivity: 0, activeTurns: 1, now: 100 * HOUR, idleMs: IDLE })).toBe(false)
  })
})
