// Pure state machine for the restart window (s100) — kept free of Solid so the
// decisions are unit-testable without a DOM. `context/restart.tsx` is the thin
// reactive shell around it.
//
// The phase that matters most is the one nobody announces: a daemon that died
// without draining. The spec's countdown only exists when the server can say
// so; the hold must also exist when it cannot.

export type Phase = "idle" | "draining" | "reconnecting"

export type LifecycleInfo = {
  draining: boolean
  remainingMs: number | null
  reason: string | null
  activeTurns: number
}

export type PollOutcome = { ok: false } | { ok: true; status: number; info?: LifecycleInfo }

/**
 * The window travels as a duration, never as a server timestamp: the client stamps
 * `now + remainingMs` against its own clock, so a skewed device still counts the right
 * seconds (DEC-060's reasoning — derive the number where it is known).
 */
export function deadlineFrom(now: number, remainingMs: number | null | undefined) {
  return now + Math.max(0, remainingMs ?? 0)
}

export function phaseAfterPoll(phase: Phase, outcome: PollOutcome): Phase {
  if (!outcome.ok) return "reconnecting"
  // An old server has no such route. That is not an outage — it is a server that
  // can never announce a window, so its input must not be held forever.
  if (outcome.status === 404) return "idle"
  // Anything else that is not a healthy answer (a 500, a gateway error) is an outage
  // wearing a status code: hold, exactly as if the fetch had failed.
  if (outcome.status < 200 || outcome.status >= 300) return "reconnecting"
  if (outcome.info?.draining) return "draining"
  return "idle"
}
