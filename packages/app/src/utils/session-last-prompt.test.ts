import { describe, expect, test } from "bun:test"
import { sessionLastPrompt } from "./session-last-prompt"

type TestMessage = { id: string; role: "user" | "assistant"; time: { created: number } }
type TestPart = { type: string; text?: string; synthetic?: boolean; ignored?: boolean }

const sync = (input: {
  message?: TestMessage[]
  part?: Record<string, TestPart[]>
}) => ({
  session: {
    data: {
      message: input.message ? { "s1": input.message } : {},
      part: input.part ?? {},
    },
  },
})

const partFor = (messages: TestMessage[], parts: TestPart[]) => {
  const part: Record<string, TestPart[]> = {}
  for (const message of messages) part[message.id] = parts
  return part
}

describe("sessionLastPrompt", () => {
  test("returns undefined when the session has no messages", () => {
    expect(sessionLastPrompt(sync({}), "s1")).toBeUndefined()
  })

  test("returns the text of the last user message", () => {
    const messages = [
      { id: "m1", role: "user", time: { created: 1 } },
      { id: "m2", role: "assistant", time: { created: 2 } },
    ] as TestMessage[]
    const result = sessionLastPrompt(
      sync({ message: messages, part: partFor(messages, [{ type: "text", text: "Hello world" }]) }),
      "s1",
    )
    expect(result).toBe("Hello world")
  })

  test("skips non-text parts and ignores the body of later assistant messages", () => {
    const messages = [
      { id: "m1", role: "user", time: { created: 1 } },
      { id: "m2", role: "assistant", time: { created: 2 } },
    ] as TestMessage[]
    const result = sessionLastPrompt(
      sync({
        message: messages,
        part: partFor(messages, [
          { type: "tool", text: "ignored" },
          { type: "text", text: "First prompt" },
        ]),
      }),
      "s1",
    )
    expect(result).toBe("First prompt")
  })

  test("skips synthetic and ignored text parts", () => {
    const messages = [{ id: "m1", role: "user", time: { created: 1 } }] as TestMessage[]
    const result = sessionLastPrompt(
      sync({
        message: messages,
        part: partFor(messages, [
          { type: "text", text: "synthetic", synthetic: true },
          { type: "text", text: "ignored", ignored: true },
          { type: "text", text: "Real prompt" },
        ]),
      }),
      "s1",
    )
    expect(result).toBe("Real prompt")
  })

  test("returns undefined when the last user message has no text part", () => {
    const messages = [{ id: "m1", role: "user", time: { created: 1 } }] as TestMessage[]
    const result = sessionLastPrompt(
      sync({ message: messages, part: partFor(messages, [{ type: "tool", text: "not text" }]) }),
      "s1",
    )
    expect(result).toBeUndefined()
  })

  test("picks the last user message even when an assistant message is newer", () => {
    const messages = [
      { id: "m1", role: "user", time: { created: 1 } },
      { id: "m2", role: "assistant", time: { created: 2 } },
      { id: "m3", role: "user", time: { created: 3 } },
    ] as TestMessage[]
    const result = sessionLastPrompt(
      sync({
        message: messages,
        part: {
          m1: [{ type: "text", text: "First prompt" }],
          m2: [{ type: "text", text: "Assistant reply" }],
          m3: [{ type: "text", text: "Second prompt" }],
        },
      }),
      "s1",
    )
    expect(result).toBe("Second prompt")
  })

  test("normalizes whitespace and trims the prompt", () => {
    const messages = [{ id: "m1", role: "user", time: { created: 1 } }] as TestMessage[]
    const result = sessionLastPrompt(
      sync({ message: messages, part: partFor(messages, [{ type: "text", text: "  Fix\n   the bug " }]) }),
      "s1",
    )
    expect(result).toBe("Fix the bug")
  })
})
