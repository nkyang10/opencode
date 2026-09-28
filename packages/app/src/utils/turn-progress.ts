import { createSignal, type Accessor, type Setter } from "solid-js"
import { ScopedKey, type ServerScope } from "@/utils/server-scope"

export type TurnProgress = {
  sessionID: string
  messageID: string
}

// A turn this client submitted and the server has not acknowledged yet. The optimistic `busy`
// status covers the common case, but it is skipped for sessions that run in a sandbox worktree and
// it is only ever as fresh as the last status event, so the timeline keeps its own record: from the
// submit keystroke until the server says it has picked the turn up. Signal-backed (like the rest of
// the client state) so reading it inside a memo subscribes the timeline.
const accessors = new Map<string, Accessor<TurnProgress | undefined>>()
const setters = new Map<string, Setter<TurnProgress | undefined>>()

function accessor(id: string) {
  const existing = accessors.get(id)
  if (existing) return existing
  const [current, set] = createSignal<TurnProgress | undefined>()
  accessors.set(id, current)
  setters.set(id, set)
  return current
}

const prefix = (scope: ServerScope) => `${scope}\u0000`

export const TurnProgressState = {
  begin(scope: ServerScope, sessionID: string, messageID: string) {
    const id = ScopedKey.from(scope, sessionID)
    accessor(id)
    setters.get(id)?.({ sessionID, messageID })
  },
  settle(scope: ServerScope, sessionID: string) {
    setters.get(ScopedKey.from(scope, sessionID))?.(undefined)
  },
  read(scope: ServerScope, sessionID: string) {
    return accessor(ScopedKey.from(scope, sessionID))()
  },
  hasPending(scope: ServerScope) {
    return pending(scope).length > 0
  },
  // The status watchdog's answer to a submission the server never picked up: a session it does not
  // list as running cannot still be waiting to acknowledge, so the record has to go or the row would
  // sit on "Sending" forever.
  settleUnacknowledged(scope: ServerScope, isRunning: (sessionID: string) => boolean) {
    for (const id of pending(scope)) {
      if (isRunning(id.sessionID)) continue
      setters.get(ScopedKey.from(scope, id.sessionID))?.(undefined)
    }
  },
}

function pending(scope: ServerScope) {
  const start = prefix(scope)
  const result: TurnProgress[] = []
  for (const [id, current] of accessors) {
    if (!id.startsWith(start)) continue
    const value = current()
    if (value) result.push(value)
  }
  return result
}
