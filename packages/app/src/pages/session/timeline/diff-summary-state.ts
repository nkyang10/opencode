import type { SummaryDiff } from "./timeline-row"

const MAX_FILES = 10

// The timeline "N Changed files" group caps how many file rows it lists. The two controls that lift the cap
// ("Show all" in the header, "+N more files" under the list) only exist while there is an overflow, so both
// derive from this.
export function diffSummaryOverflow(diffs: SummaryDiff[]) {
  return Math.max(0, diffs.length - MAX_FILES)
}

export function diffSummaryVisible(diffs: SummaryDiff[], showAll: boolean) {
  return showAll ? diffs : diffs.slice(0, MAX_FILES)
}
