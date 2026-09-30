import { describe, expect, test } from "bun:test"
import { commentaryShouldWatch } from "./commentary-watch"

const base = { isDesktop: true, panelOpened: true, latched: false, enabled: true, foregrounded: true }

describe("commentaryShouldWatch", () => {
  test("desktop follows the column's open state", () => {
    expect(commentaryShouldWatch({ ...base, panelOpened: true })).toBe(true)
    expect(commentaryShouldWatch({ ...base, panelOpened: false })).toBe(false)
  })

  test("mobile follows the latch, so leaving the tab does not stop the narration", () => {
    expect(commentaryShouldWatch({ ...base, isDesktop: false, panelOpened: false, latched: true })).toBe(true)
    expect(commentaryShouldWatch({ ...base, isDesktop: false, panelOpened: true, latched: false })).toBe(false)
  })

  test("the two platforms never leak into each other", () => {
    // A mobile latch must not narrate on a desktop where the column is closed, and a desktop column being
    // open must not narrate on a mobile that never latched.
    expect(commentaryShouldWatch({ ...base, panelOpened: false, latched: true })).toBe(false)
    expect(commentaryShouldWatch({ ...base, isDesktop: false, panelOpened: true, latched: false })).toBe(false)
  })

  test("neither platform narrates by default", () => {
    expect(commentaryShouldWatch({ ...base, panelOpened: false, latched: false })).toBe(false)
    expect(commentaryShouldWatch({ ...base, isDesktop: false, panelOpened: false, latched: false })).toBe(false)
  })

  // FU-122: audio is only wanted from the tab you are looking at, so a hidden window holds no lease at all
  // rather than narrating silently into a tab nobody is reading.
  test("a hidden window never holds a lease, on either platform", () => {
    expect(commentaryShouldWatch({ ...base, foregrounded: false })).toBe(false)
    expect(commentaryShouldWatch({ ...base, isDesktop: false, latched: true, foregrounded: false })).toBe(false)
  })

  test("the master switch still wins over everything", () => {
    expect(commentaryShouldWatch({ ...base, enabled: false })).toBe(false)
    expect(commentaryShouldWatch({ ...base, enabled: false, foregrounded: false, latched: true })).toBe(false)
  })
})
