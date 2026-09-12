import { describe, expect, test } from "bun:test"
import { movePull, PULL_THRESHOLD, RESET, shouldOpenPull, startPull } from "./drag-down-gesture"

describe("movePull", () => {
  test("arms on a steady downward pull", () => {
    const state = startPull()
    const next = movePull(state, 0, 12)
    expect(next).not.toBe(RESET)
    expect((next as { armed: boolean }).armed).toBe(true)
  })

  test("does not arm on small jitter", () => {
    const state = startPull()
    expect(movePull(state, 1, 6)).toBe(state)
  })

  test("does not arm on upward motion", () => {
    const next = movePull(startPull(), 0, -20)
    expect(next).toBe(RESET)
  })

  test("does not arm when horizontal movement dominates", () => {
    const next = movePull(startPull(), 40, 15)
    expect(next).toBe(RESET)
  })

  test("does not arm until pull exceeds arm distance", () => {
    const state = startPull()
    expect(movePull(state, 0, 8)).toBe(state)
  })
})

describe("shouldOpenPull", () => {
  test("opens only when armed and beyond threshold", () => {
    expect(shouldOpenPull({ armed: false, dy: 100 })).toBe(false)
    expect(shouldOpenPull({ armed: true, dy: PULL_THRESHOLD - 1 })).toBe(false)
    expect(shouldOpenPull({ armed: true, dy: PULL_THRESHOLD })).toBe(true)
  })
})
