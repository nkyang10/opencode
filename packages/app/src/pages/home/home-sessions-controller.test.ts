import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { buildHomeSessionRecords } from "./home-session-records"

const session = (id: string, directory: string, projectID = "project"): Session => ({
  id,
  slug: id,
  projectID,
  directory,
  path: "",
  version: "0.0.0",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  title: id,
  time: { created: 1, updated: 1 },
})

describe("home session records", () => {
  test("maps sessions to records when the project list is fed from server projects", () => {
    const records = buildHomeSessionRecords({
      sessions: () => [session("one", "/home/mark/project"), session("two", "/home/mark/project")],
      projectDirectories: () => ["/other/project", "/home/mark/project"],
      projects: () => [{ worktree: "/home/mark/project", expanded: false, id: "project", sandboxes: [] }],
      projectByID: () => new Map(),
    })

    expect(records.map((record) => record.session.id)).toEqual(["one", "two"])
    expect(records[0].project.worktree).toBe("/home/mark/project")
  })

  test("drops sessions when the project list is empty (fresh device failure mode)", () => {
    const records = buildHomeSessionRecords({
      sessions: () => [session("one", "/home/mark/project")],
      projectDirectories: () => [],
      projects: () => [],
      projectByID: () => new Map(),
    })

    expect(records).toEqual([])
  })
})
