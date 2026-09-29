import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"
import { latestTurnActivity, turnProducedOutput, turnStage } from "./turn-activity"

const assistant = (input: { id: string; created: number; completed?: number }): AssistantMessage => ({
  id: input.id,
  sessionID: "ses_1",
  role: "assistant",
  time: { created: input.created, completed: input.completed },
  parentID: "msg_1",
  modelID: "model",
  providerID: "provider",
  mode: "build",
  agent: "build",
  path: { cwd: "/repo", root: "/repo" },
  cost: 0,
  tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
})

const text = (input: { id: string; text: string; start: number; end?: number }): Part => ({
  id: input.id,
  sessionID: "ses_1",
  messageID: "msg_2",
  type: "text",
  text: input.text,
  time: { start: input.start, end: input.end },
})

const tool = (input: { id: string; start: number; end?: number }): Part => ({
  id: input.id,
  sessionID: "ses_1",
  messageID: "msg_2",
  type: "tool",
  callID: input.id,
  tool: "read",
  state:
    input.end === undefined
      ? { status: "running", input: {}, title: "read", metadata: {}, time: { start: input.start } }
      : {
          status: "completed",
          input: {},
          output: "ok",
          title: "read",
          metadata: {},
          time: { start: input.start, end: input.end },
        },
})

const activity = (messages: AssistantMessage[] | undefined, parts: Part[], observed?: number) =>
  latestTurnActivity({ messages, parts: () => parts, observed })

describe("latestTurnActivity", () => {
  test("reports nothing for a turn the model has not answered yet", () => {
    expect(activity([], [])).toEqual({ at: undefined, key: "" })
    expect(activity(undefined, [])).toEqual({ at: undefined, key: "" })
  })

  test("uses the assistant message creation before any part exists", () => {
    expect(activity([assistant({ id: "msg_2", created: 1_000 })], []).at).toBe(1_000)
  })

  test("prefers a tool end over its start and the message creation over both", () => {
    expect(
      activity([assistant({ id: "msg_2", created: 1_000 })], [tool({ id: "prb_1", start: 1_100, end: 4_000 })]).at,
    ).toBe(4_000)
    expect(
      activity(
        [assistant({ id: "msg_2", created: 1_000, completed: 9_000 })],
        [tool({ id: "prb_1", start: 1_100, end: 4_000 })],
      ).at,
    ).toBe(9_000)
  })

  test("uses a running tool start because it has no end yet", () => {
    expect(activity([assistant({ id: "msg_2", created: 1_000 })], [tool({ id: "prb_1", start: 1_100 })]).at).toBe(1_100)
  })

  test("a tool without a time falls back to the message creation", () => {
    const pending: Part = {
      id: "prb_1",
      sessionID: "ses_1",
      messageID: "msg_2",
      type: "tool",
      callID: "prb_1",
      tool: "question",
      state: { status: "pending", input: {}, raw: "{}" },
    }
    expect(activity([assistant({ id: "msg_2", created: 1_000 })], [pending]).at).toBe(1_000)
  })

  test("takes the latest stamp across every part of the turn", () => {
    const parts = [
      text({ id: "prt_1", text: "done", start: 1_200, end: 2_000 }),
      tool({ id: "prb_1", start: 3_000, end: 7_500 }),
    ]
    expect(activity([assistant({ id: "msg_2", created: 1_000 })], parts).at).toBe(7_500)
  })

  test("the key changes while a part streams, so the caller can stamp the update", () => {
    const message = assistant({ id: "msg_2", created: 1_000 })
    const streamed = activity([message], [text({ id: "prt_1", text: "he", start: 1_100 })])
    const grown = activity([message], [text({ id: "prt_1", text: "hello", start: 1_100 })])
    const unchanged = activity([message], [text({ id: "prt_1", text: "hello", start: 1_100 })])

    expect(streamed.at).toBe(1_100)
    expect(grown.key).not.toBe(streamed.key)
    expect(unchanged.key).toBe(grown.key)
  })

  test("the key changes when a tool starts or finishes", () => {
    const message = assistant({ id: "msg_2", created: 1_000 })
    const pending = activity([message], [tool({ id: "prb_1", start: 1_100 })])
    const done = activity([message], [tool({ id: "prb_1", start: 1_100, end: 2_000 })])
    expect(done.key).not.toBe(pending.key)
  })

  test("an observed arrival wins over a stale server stamp but never loses to a newer one", () => {
    const message = assistant({ id: "msg_2", created: 1_000 })
    expect(activity([message], [], 5_000).at).toBe(5_000)
    expect(activity([message], [tool({ id: "prb_1", start: 7_000 })], 5_000).at).toBe(7_000)
    expect(activity([], [], 5_000).key).toBe("")
  })
})

// The "waiting" stage and the rule behind it. These are the two things that were wrong in the first
// implementation: the threshold was 10s (too eager for a reasoning model's first token) and progress
// was measured as "an assistant message exists" — true for every real turn, because the server creates
// it the moment the turn starts.
describe("turn stage", () => {
  const base = { pending: false, producedOutput: false, silenceMs: 0, waitThreshold: 20_000 }

  test("sending while this client has submitted and the server has not answered", () => {
    expect(turnStage({ ...base, pending: true })).toBe("sending")
    // even a long silence does not outrank a submission the server has not acknowledged
    expect(turnStage({ ...base, pending: true, silenceMs: 90_000 })).toBe("sending")
  })

  test("waiting only after the threshold, and only with nothing produced", () => {
    expect(turnStage({ ...base, silenceMs: 19_000 })).toBe("thinking")
    expect(turnStage({ ...base, silenceMs: 20_000 })).toBe("waiting")
    expect(turnStage({ ...base, silenceMs: 59_000 })).toBe("waiting")
    // output beats silence: a long-running turn that said something is thinking, not waiting
    expect(turnStage({ ...base, producedOutput: true, silenceMs: 59_000 })).toBe("thinking")
  })
})

describe("turn produced output", () => {
  test("an open, empty assistant message has produced nothing", () => {
    expect(turnProducedOutput([])).toBe(false)
  })

  test("text and reasoning count once they carry content", () => {
    expect(turnProducedOutput([{ type: "text", text: "" } as never])).toBe(false)
    expect(turnProducedOutput([{ type: "text", text: "hi" } as never])).toBe(true)
    expect(turnProducedOutput([{ type: "reasoning", text: "thinking" } as never])).toBe(true)
  })

  test("a running tool is progress; a finished one is output", () => {
    expect(turnProducedOutput([{ type: "tool", state: { status: "running" } } as never])).toBe(false)
    expect(turnProducedOutput([{ type: "tool", state: { status: "pending" } } as never])).toBe(false)
    expect(turnProducedOutput([{ type: "tool", state: { status: "completed" } } as never])).toBe(true)
    expect(turnProducedOutput([{ type: "tool", state: { status: "error" } } as never])).toBe(true)
  })

  test("internal markers are not output", () => {
    expect(turnProducedOutput([{ type: "step-start" } as never])).toBe(false)
    expect(turnProducedOutput([{ type: "step-finish" } as never])).toBe(false)
    expect(turnProducedOutput([{ type: "patch", text: "diff" } as never])).toBe(false)
  })
})
