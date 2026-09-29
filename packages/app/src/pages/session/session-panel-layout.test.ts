import { describe, expect, test } from "bun:test"
import { sessionPanelLayout } from "./session-panel-layout"

describe("sessionPanelLayout", () => {
  test("keeps one V2 owner while changing panel geometry", () => {
    expect(sessionPanelLayout({ review: false, terminal: false, files: false })).toEqual({
      visible: false,
      stacked: false,
    })
    expect(sessionPanelLayout({ review: false, terminal: true, files: false })).toEqual({
      visible: true,
      stacked: false,
    })
    expect(sessionPanelLayout({ review: true, terminal: true, files: false })).toEqual({
      visible: true,
      stacked: true,
    })
  })
})

  // FE-028: without this the commentary toggle sets the store and lights the button while the side panel
  // is never mounted, so nothing appears.
  test("a commentary-only view is visible", () => {
    expect(sessionPanelLayout({ review: false, terminal: false, files: false, commentary: true })).toEqual({
      visible: true,
      stacked: false,
    })
  })

  test("commentary does not change the stacking rule", () => {
    expect(sessionPanelLayout({ review: true, terminal: true, files: false, commentary: true }).stacked).toBe(true)
  })
