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
