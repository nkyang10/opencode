import type { TextPart } from "@opencode-ai/sdk/v2/client"

export function sessionLastPrompt(
  sync: {
    session: {
      data: {
        message: Record<string, { id: string; role: string; time: { created: number } }[] | undefined>
        part: Record<string, readonly { type: string; text?: string; synthetic?: boolean; ignored?: boolean }[] | undefined>
      }
    }
  },
  sessionID: string,
): string | undefined {
  const messages = sync.session.data.message[sessionID] ?? []
  if (messages.length === 0) return undefined

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== "user") continue

    const parts = sync.session.data.part?.[message.id] ?? []
    const textPart = parts.find(
      (part) => part.type === "text" && !part.synthetic && !part.ignored && typeof part.text === "string",
    )
    if (!textPart?.text) continue

    return textPart.text.replace(/\s+/g, " ").trim()
  }

  return undefined
}
