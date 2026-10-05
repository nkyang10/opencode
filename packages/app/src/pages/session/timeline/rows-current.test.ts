import { describe, expect, mock, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import type { TimelineRow as TimelineRowModule } from "./rows"
import { normalizeSessionMessages } from "@/utils/session-message"

mock.module("@opencode-ai/session-ui/message-part", () => ({
  renderable: () => true,
  groupParts: (refs: Array<{ messageID: string; part: { id: string } }>) =>
    refs.map((ref) => ({
      type: "part" as const,
      key: ref.part.id,
      ref: { messageID: ref.messageID, partID: ref.part.id },
    })),
}))

const { Timeline, TimelineRow } = await import("./rows")

describe("current session timeline rows", () => {
  test("derives turns and tagged rows from chronological current messages", () => {
    const source = [
      { id: "msg_1", type: "user", text: "first", time: { created: 1 } },
      {
        id: "msg_2",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "answer" }],
        time: { created: 2, completed: 3 },
      },
      { id: "msg_3", type: "user", text: "second", time: { created: 4 } },
      {
        id: "msg_4",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "reasoning", text: "working" }],
        time: { created: 5 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const messages = new Map(normalized.messages.map((message) => [message.id, message]))

    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) => messages.get(messageID),
      (messageID) => normalized.parts.get(messageID) ?? [],
      true,
      "busy",
      true,
      normalized.messages.filter((message) => message.role === "user"),
    )

    expect(result.activeMessageID).toBe("msg_3")
    expect(result.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_1",
      "assistant-part:msg_1:msg_2:text:0",
      "turn-gap:msg_3",
      "user-message:msg_3",
      "assistant-part:msg_3:msg_4:reasoning:0",
    ])
  })

  test("renders a current shell message as a standalone turn", () => {
    const source = [
      {
        id: "msg_shell",
        type: "shell",
        shellID: "shell_1",
        command: "pwd",
        status: "exited",
        exit: 0,
        output: { output: "/repo", cursor: 5, size: 5, truncated: false },
        time: { created: 1, completed: 2 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const messages = new Map(normalized.messages.map((message) => [message.id, message]))

    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) => messages.get(messageID),
      (messageID) => normalized.parts.get(messageID) ?? [],
      true,
      "idle",
      true,
      normalized.messages.filter((message) => message.role === "user"),
    )

    expect(result.activeMessageID).toBe("msg_shell")
    expect(result.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_shell",
      "assistant-part:msg_shell:msg_shell:tool",
    ])
  })

  test("keeps a projected parent missing from the source page before newer turns", () => {
    const source = [
      { id: "msg_user_1", type: "user", text: "first question", time: { created: 1 } },
      {
        id: "msg_assistant_1",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "first answer" }],
        time: { created: 2, completed: 3 },
      },
      { id: "msg_user_2", type: "user", text: "second question", time: { created: 4 } },
      {
        id: "msg_assistant_2",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "second answer" }],
        time: { created: 5, completed: 6 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const messages = new Map(normalized.messages.map((message) => [message.id, message]))

    const result = Timeline.constructSessionMessageRows(
      source.slice(1),
      (messageID) => messages.get(messageID),
      (messageID) => normalized.parts.get(messageID) ?? [],
      true,
      "idle",
      true,
      normalized.messages.filter((message) => message.role === "user"),
    )

    expect(result.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_user_1",
      "assistant-part:msg_user_1:msg_assistant_1:text:0",
      "turn-gap:msg_user_2",
      "user-message:msg_user_2",
      "assistant-part:msg_user_2:msg_assistant_2:text:0",
    ])
  })

  test("renders an optimistic user turn and thinking before the protocol message arrives", () => {
    const source = [
      { id: "msg_z", type: "user", text: "existing", time: { created: 1 } },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const optimistic = {
      id: "msg_a",
      sessionID: "ses_1",
      role: "user" as const,
      time: { created: 2 },
      agent: "build",
      model: { modelID: "model", providerID: "provider" },
    }
    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) =>
        messageID === optimistic.id ? optimistic : normalized.messages.find((message) => message.id === messageID),
      () => [],
      true,
      "busy",
      true,
      [...normalized.messages.filter((message) => message.role === "user"), optimistic],
    )

    expect(result.activeMessageID).toBe(optimistic.id)
    expect(result.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_z",
      "turn-gap:msg_a",
      "user-message:msg_a",
      "thinking:msg_a",
    ])
  })

  test("removes a failed assistant error when the turn continues streaming", () => {
    const source = [
      { id: "msg_user", type: "user", text: "recover", time: { created: 1 } },
      {
        id: "msg_failed",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [],
        error: { type: "ProviderError", message: "temporary failure" },
        time: { created: 2, completed: 3 },
      },
      {
        id: "msg_recovery",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "streaming again" }],
        time: { created: 4 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const messages = new Map(normalized.messages.map((message) => [message.id, message]))

    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) => messages.get(messageID),
      (messageID) => normalized.parts.get(messageID) ?? [],
      true,
      "busy",
      true,
      normalized.messages.filter((message) => message.role === "user"),
    )

    expect(result.rows.map((row) => row._tag)).toEqual(["UserMessage", "AssistantPart"])
  })

  describe("turn in flight", () => {
    const source = [{ id: "msg_u", type: "user", text: "go", time: { created: 1 } }] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const rows = (status: "idle" | "busy" | "retry", pending?: string) => {
      const result = Timeline.constructSessionMessageRows(
        source,
        (messageID) => normalized.messages.find((message) => message.id === messageID),
        () => [],
        false,
        status,
        true,
        normalized.messages.filter((message) => message.role === "user"),
        pending,
      )
      return result.rows.map((row) => row._tag)
    }

    // A prompt the client just sent is in flight before the server has published any status, which
    // is the whole window where the user used to see nothing at all.
    test("shows the progress row for a submitted turn the server has not acknowledged", () => {
      expect(rows("idle", "msg_u")).toEqual(["UserMessage", "Thinking"])
      expect(rows("idle")).toEqual(["UserMessage"])
    })

    // A retry backoff is still the server working on the turn: the row must not blank out and read
    // as a dropped connection.
    test("shows the progress row while the server is retrying", () => {
      expect(rows("retry")).toEqual(["UserMessage", "Thinking", "Retry"])
      expect(rows("busy")).toEqual(["UserMessage", "Thinking"])
    })
  })

  // s100: a daemon stop leaves an assistant message with no completion and no error — the same
  // signal the server's resume endpoint reads. It must read as interrupted only on the last turn
  // while the session is idle: during a live turn the tail assistant is *also* incomplete, and a
  // graceful abort carries an error the existing "interrupted" divider already covers.
  describe("turn cut off by a daemon stop", () => {
    const base = { agent: "build", model: { id: "model", providerID: "provider" } }
    const rowsFor = (source: SessionMessageInfo[], status: "idle" | "busy" | "retry") => {
      const normalized = normalizeSessionMessages("ses_1", source)
      const result = Timeline.constructSessionMessageRows(
        source,
        (messageID) => normalized.messages.find((message) => message.id === messageID),
        () => [],
        true,
        status,
        true,
        normalized.messages.filter((message) => message.role === "user"),
      )
      return result.rows
    }
    const dividerLabels = (rows: TimelineRowModule.TimelineRow[]) =>
      rows
        .filter((row) => row._tag === "TurnDivider")
        .map((row) => (row as Extract<TimelineRowModule.TimelineRow, { _tag: "TurnDivider" }>).label)

    test("marks the last turn when its tail assistant never completed and the session is idle", () => {
      const source = [
        { id: "msg_u", type: "user", text: "go", time: { created: 1 } },
        {
          id: "msg_a",
          type: "assistant",
          ...base,
          content: [{ type: "text", text: "partial" }],
          time: { created: 2 },
        },
      ] satisfies SessionMessageInfo[]
      expect(dividerLabels(rowsFor(source, "idle"))).toEqual(["cut-off"])
    })

    test("marks nothing while the server is still working on the turn", () => {
      const source = [
        { id: "msg_u", type: "user", text: "go", time: { created: 1 } },
        {
          id: "msg_a",
          type: "assistant",
          ...base,
          content: [{ type: "text", text: "partial" }],
          time: { created: 2 },
        },
      ] satisfies SessionMessageInfo[]
      expect(dividerLabels(rowsFor(source, "busy"))).toEqual([])
      expect(dividerLabels(rowsFor(source, "retry"))).toEqual([])
    })

    test("marks nothing when the turn completed", () => {
      const source = [
        { id: "msg_u", type: "user", text: "go", time: { created: 1 } },
        {
          id: "msg_a",
          type: "assistant",
          ...base,
          content: [{ type: "text", text: "done" }],
          time: { created: 2, completed: 3 },
        },
      ] satisfies SessionMessageInfo[]
      expect(dividerLabels(rowsFor(source, "idle"))).toEqual([])
    })

    test("marks only the last turn — an older incomplete turn stays history", () => {
      const source = [
        { id: "msg_u1", type: "user", text: "first", time: { created: 1 } },
        {
          id: "msg_a1",
          type: "assistant",
          ...base,
          content: [{ type: "text", text: "partial" }],
          time: { created: 2 },
        },
        { id: "msg_u2", type: "user", text: "second", time: { created: 3 } },
        {
          id: "msg_a2",
          type: "assistant",
          ...base,
          content: [{ type: "text", text: "partial" }],
          time: { created: 4 },
        },
      ] satisfies SessionMessageInfo[]
      expect(dividerLabels(rowsFor(source, "idle"))).toEqual(["cut-off"])
    })
  })
})
