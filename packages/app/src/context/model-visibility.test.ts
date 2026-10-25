import { expect, test } from "bun:test"
import { modelVisible } from "./model-visibility"

test.each(["opencode", "opencode-go"])("%s models default off, but explicit choices always win", (providerID) => {
  for (const latest of [true, false]) {
    for (const validRelease of [true, false]) {
      expect(modelVisible({ providerID, latest, validRelease })).toBe(false)
      expect(modelVisible({ providerID, latest, validRelease, visibility: "show" })).toBe(true)
      expect(modelVisible({ providerID, latest, validRelease, visibility: "hide" })).toBe(false)
    }
  }
})
test("other providers retain existing release-based defaults and saved choices", () => {
  expect(modelVisible({ providerID: "anthropic", latest: true, validRelease: true })).toBe(true)
  expect(modelVisible({ providerID: "anthropic", latest: false, validRelease: true })).toBe(false)
  expect(modelVisible({ providerID: "custom", latest: false, validRelease: false })).toBe(true)
  expect(modelVisible({ providerID: "custom", latest: true, validRelease: false, visibility: "hide" })).toBe(false)
})
