import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"

const later = (a: number | undefined, b: number | undefined) => (b !== undefined && (a === undefined || b > a) ? b : a)

const partTime = (part: Part) => {
  if (part.type === "tool") {
    if (!("time" in part.state)) return undefined
    const time = part.state.time
    return "end" in time ? later(time.start, time.end) : time.start
  }
  if (part.type === "text" || part.type === "reasoning") return later(part.time?.start, part.time?.end)
  return undefined
}

// The server stamps a part when it is created, not on every token, so the server stamps alone would
// keep reporting the start of a long stream. `key` is a fingerprint of the whole turn that also
// changes when a part grows in place, which is what lets the caller notice an in-flight update and
// hand the time it actually arrived back in as `observed`.
export function latestTurnActivity(input: {
  messages: AssistantMessage[] | undefined
  parts: (messageID: string) => Part[]
  observed?: number
}) {
  const key: (string | number)[] = []
  let at = input.observed
  for (const message of input.messages ?? []) {
    key.push(message.id, message.time.created, message.time.completed ?? 0)
    at = later(at, later(message.time.created, message.time.completed))
    for (const part of input.parts(message.id)) {
      const time = partTime(part)
      key.push(part.id, part.type, "text" in part ? part.text.length : 0, time ?? 0)
      at = later(at, time)
    }
  }
  return { at, key: key.join(" ") }
}

// Whether the turn has produced anything the user can see. The server creates the assistant message
// the moment a turn starts, so "an assistant message exists" says nothing about progress — a slow
// model can hold an open, empty assistant message for a minute. A *running* tool counts as progress
// (the agent is working, not waiting on the model); a finished one counts as output.
export function turnProducedOutput(parts: Part[]) {
  return parts.some((part) => {
    if (part.type === "text" || part.type === "reasoning") return !!part.text?.length
    if (part.type === "tool") return part.state.status === "completed" || part.state.status === "error"
    return false
  })
}

export type TurnStage = "sending" | "waiting" | "thinking"

// Which of the three things the turn-progress row should say. Split out from the component so the
// decision is testable: the v1 event schema requires `time.completed` on an assistant message, so no
// browser fixture can represent the state this exists for — an open, still-empty assistant message —
// and the first implementation got that wrong silently (it treated "an assistant message exists" as
// progress, which is true for every real turn, so the waiting stage never appeared).
export function turnStage(input: {
  pending: boolean
  producedOutput: boolean
  silenceMs: number
  waitThreshold: number
}): TurnStage {
  if (input.pending) return "sending"
  if (!input.producedOutput && input.silenceMs >= input.waitThreshold) return "waiting"
  return "thinking"
}
