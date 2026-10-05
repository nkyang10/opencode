// Process-global count of prompt turns owned by this process (s100).
//
// The drain needs one fact: is anything still running? `SessionStatus` cannot answer it — it is
// `InstanceState`-keyed per directory, and the server command runs with no ambient instance, so there
// is no handle to enumerate the runners of every project. This counter is the same fact flattened:
// every turn that enters `SessionPrompt.loop` bumps it, and `Effect.ensuring` brings it back down on
// success, failure or interruption.
//
// It deliberately counts *joined waiters* too: when a second `prompt()` joins an already-running turn,
// it awaits the same runner, and its `begin()` keeps the count above zero until that awaiter is
// satisfied. For a drain that is the safer lie — a client still waiting on a result is still a reason
// not to exit.
//
// Known gap, recorded in the s100 session: a standalone `SessionPrompt.shell` (the Runner's shell
// path) is not counted; shells started while the window is open are covered by the deadline itself,
// not by the early exit.

export * as ActiveTurns from "./active-turns"

let count = 0

export const begin = () => {
  count += 1
}

export const end = () => {
  count = Math.max(0, count - 1)
}

export const active = () => count