import { describe, expect, test } from "bun:test"
import type { QuestionRequest } from "@opencode-ai/sdk/v2/client"
import { sessionPendingQuestions } from "./directory-sync"

const question = (id: string, sessionID: string): QuestionRequest =>
  ({
    id,
    sessionID,
    questions: [{ id, question: "pick", multiple: false, options: ["a", "b"] }],
  }) as unknown as QuestionRequest

describe("sessionPendingQuestions", () => {
  test("keeps items for the session and drops others", () => {
    const result = sessionPendingQuestions(
      [question("q2", "s1"), question("q3", "s2"), question("q1", "s1")],
      "s1",
    )
    expect(result.map((q) => q.id)).toEqual(["q1", "q2"])
  })

  test("drops items without an id and normalizes undefined input", () => {
    expect(sessionPendingQuestions(undefined, "s1")).toEqual([])
    expect(sessionPendingQuestions([{ ...question("q1", "s1"), id: "" }], "s1")).toEqual([])
  })
})
