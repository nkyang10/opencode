export const PULL_THRESHOLD = 56
const ARM_DISTANCE = 10
const AXIS_FACTOR = 1.5

export interface DragPullState {
  armed: boolean
  dy: number
}

export const RESET = Symbol("drag-pull-reset")

export function startPull(): DragPullState {
  return { armed: false, dy: 0 }
}

export function movePull(state: DragPullState, dx: number, dy: number): DragPullState | typeof RESET {
  if (state.armed) return { armed: true, dy }

  if (dy > ARM_DISTANCE && dy > AXIS_FACTOR * Math.abs(dx)) return { armed: true, dy }
  if (Math.abs(dx) > ARM_DISTANCE || dy <= 0) return RESET
  return state
}

export function shouldOpenPull(state: DragPullState) {
  return state.armed && state.dy >= PULL_THRESHOLD
}
