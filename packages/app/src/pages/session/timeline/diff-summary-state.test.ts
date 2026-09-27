import { describe, expect, test } from "bun:test"
import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import { diffSummaryOverflow, diffSummaryVisible } from "./diff-summary-state"

const files = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    file: `src/${index}.ts`,
    additions: 1,
    deletions: 1,
  })) satisfies SnapshotFileDiff[]

describe("diffSummaryOverflow", () => {
  test("is zero until the list passes the ten file cap", () => {
    expect(diffSummaryOverflow([])).toBe(0)
    expect(diffSummaryOverflow(files(1))).toBe(0)
    expect(diffSummaryOverflow(files(10))).toBe(0)
  })

  test("counts the files hidden by the cap", () => {
    expect(diffSummaryOverflow(files(11))).toBe(1)
    expect(diffSummaryOverflow(files(12))).toBe(2)
    expect(diffSummaryOverflow(files(25))).toBe(15)
  })
})

describe("diffSummaryVisible", () => {
  test("caps the list and preserves input order", () => {
    const diffs = files(12)
    const visible = diffSummaryVisible(diffs, false)

    expect(visible).toHaveLength(10)
    expect(visible).toEqual(diffs.slice(0, 10))
  })

  test("returns every file once the overflow control lifted the cap", () => {
    const diffs = files(12)

    expect(diffSummaryVisible(diffs, true)).toEqual(diffs)
    expect(diffSummaryVisible(diffs, true)).toHaveLength(diffSummaryOverflow(diffs) + 10)
  })

  test("passes short lists through untouched in both states", () => {
    const diffs = files(4)

    expect(diffSummaryVisible(diffs, false)).toEqual(diffs)
    expect(diffSummaryVisible(diffs, true)).toEqual(diffs)
  })
})
