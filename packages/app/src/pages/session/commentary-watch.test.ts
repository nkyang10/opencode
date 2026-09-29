import { describe, expect, test } from "bun:test"
import { commentaryShouldWatch } from "./commentary-watch"

const on = { enabled: true }

describe("commentaryShouldWatch", () => {
  test("desktop follows the column's open state", () => {
    expect(commentaryShouldWatch({ ...on, isDesktop: true, panelOpened: true, latched: false })).toBe(true)
    expect(commentaryShouldWatch({ ...on, isDesktop: true, panelOpened: false, latched: true })).toBe(false)
  })

  test("mobile follows the latch, so leaving the tab does not stop the narration", () => {
    expect(commentaryShouldWatch({ ...on, isDesktop: false, panelOpened: false, latched: true })).toBe(true)
    expect(commentaryShouldWatch({ ...on, isDesktop: false, panelOpened: true, latched: false })).toBe(false)
  })

  test("the two platforms never leak into each other", () => {
    // A mobile latch must not narrate on a desktop where the column is closed, and a desktop column being
    // open must not narrate on a mobile that never latched.
    expect(commentaryShouldWatch({ ...on, isDesktop: true, panelOpened: false, latched: true })).toBe(false)
    expect(commentaryShouldWatch({ ...on, isDesktop: false, panelOpened: true, latched: false })).toBe(false)
  })

  test("neither platform narrates by default", () => {
    expect(commentaryShouldWatch({ ...on, isDesktop: true, panelOpened: false, latched: false })).toBe(false)
    expect(commentaryShouldWatch({ ...on, isDesktop: false, panelOpened: false, latched: false })).toBe(false)
  })

  test("the switch wins over everything else", () => {
    // Every combination that would otherwise narrate must be silenced by the switch, because the server
    // spends a model call on the lease. A settings row that only hid the panel would leave this spending.
    const enabled: Parameters<typeof commentaryShouldWatch>[0] = {
      isDesktop: true,
      panelOpened: true,
      latched: true,
      enabled: true,
    }
    expect(commentaryShouldWatch(enabled)).toBe(true)
    expect(commentaryShouldWatch({ ...enabled, enabled: false })).toBe(false)
    expect(commentaryShouldWatch({ ...enabled, isDesktop: false, enabled: false })).toBe(false)
    expect(commentaryShouldWatch({ ...enabled, panelOpened: false, enabled: false })).toBe(false)
  })
})
