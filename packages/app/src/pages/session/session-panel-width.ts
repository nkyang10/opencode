// The review pane has no width of its own: it takes whatever the chat panel
// leaves behind. Instead of capping the chat panel at a fraction of the window
// (which forces the review pane to grow with the monitor), reserve a fixed
// minimum for the review pane and let the chat panel take everything else.
export const SESSION_PANEL_WIDTH_MIN = 450
export const REVIEW_PANE_WIDTH_MIN = 480
export const REVIEW_PANE_WIDTH_MIN_SPLIT = 800

// FE-028: the commentary column sits beside the review pane, so when it is open its width is reserved on
// top of the review minimum. Passing it in (rather than reading the store here) keeps this pure and
// testable, which matters because `packages/app` has no `.test.tsx`.
export function sessionPanelWidthMax(input: { available: number; split: boolean; commentary?: number }) {
  const pane = (input.split ? REVIEW_PANE_WIDTH_MIN_SPLIT : REVIEW_PANE_WIDTH_MIN) + (input.commentary ?? 0)
  return Math.max(SESSION_PANEL_WIDTH_MIN, input.available - pane)
}

// `available` is undefined until the layout row is first measured; render the
// stored width untouched until then to avoid a first-frame snap.
export function clampSessionPanelWidth(input: {
  width: number
  available: number | undefined
  split: boolean
  commentary?: number
}) {
  if (input.available === undefined) return input.width
  return Math.min(
    input.width,
    sessionPanelWidthMax({ available: input.available, split: input.split, commentary: input.commentary }),
  )
}
