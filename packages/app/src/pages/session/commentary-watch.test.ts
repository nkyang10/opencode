import { describe, expect, test } from "bun:test"
import { commentaryShouldWatch } from "./commentary-watch"

const base = { isDesktop: true, panelOpened: true, enabled: true, foregrounded: true }

describe("commentaryShouldWatch", () => {
  test("desktop follows the column's open state", () => {
    expect(commentaryShouldWatch({ ...base, panelOpened: true })).toBe(true)
    expect(commentaryShouldWatch({ ...base, panelOpened: false })).toBe(false)
  })

  // s097: the whole point of the change. The three cases are one report — a phone, sitting on the Session
  // tab, and no commentary. The middle one is the regression this suite exists for; the outer two are its
  // neighbours, because "always" is only right if the other two gates still hold.
  test("mobile narrates from the chat tab, with no tap and no open column", () => {
    expect(commentaryShouldWatch({ ...base, isDesktop: false, panelOpened: false })).toBe(true)
    expect(commentaryShouldWatch({ ...base, isDesktop: false, panelOpened: true })).toBe(true)
    // A fresh browser has `enabled: false`, so "always" never means "by default".
    expect(commentaryShouldWatch({ ...base, isDesktop: false, panelOpened: false, enabled: false })).toBe(false)
  })

  // The cost the mobile rule now leans on: a session only narrates while it is the one in front. There is no
  // keep-alive in the router, so a second agent tab is unmounted rather than quietly narrating too.
  test("a session in front of a hidden window still gets nothing", () => {
    expect(commentaryShouldWatch({ ...base, isDesktop: false, panelOpened: false, foregrounded: false })).toBe(
      false,
    )
  })

  test("the two platforms never leak into each other", () => {
    // A mobile session in front must not narrate on a desktop where the column is closed.
    expect(commentaryShouldWatch({ ...base, panelOpened: false })).toBe(false)
    // And a closed desktop column must not be overridden by the mobile rule.
    expect(commentaryShouldWatch({ ...base, isDesktop: true, panelOpened: false, enabled: true })).toBe(false)
  })

  // FU-122: audio is only wanted from the tab you are looking at, so a hidden window holds no lease at all
  // rather than narrating silently into a tab nobody is reading.
  test("a hidden window never holds a lease, on either platform", () => {
    expect(commentaryShouldWatch({ ...base, foregrounded: false })).toBe(false)
    expect(commentaryShouldWatch({ ...base, isDesktop: false, foregrounded: false })).toBe(false)
  })

  test("the master switch still wins over everything", () => {
    expect(commentaryShouldWatch({ ...base, enabled: false })).toBe(false)
    expect(commentaryShouldWatch({ ...base, enabled: false, foregrounded: false })).toBe(false)
    expect(commentaryShouldWatch({ ...base, enabled: false, panelOpened: true, isDesktop: false })).toBe(false)
  })
})