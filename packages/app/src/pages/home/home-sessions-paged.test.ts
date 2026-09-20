import { describe, expect, test } from "bun:test"
import type { SessionV2Info } from "@opencode-ai/sdk/v2/client"
import { fetchHomeSessionPage, type HomeSessionPageSlice } from "@/context/global-sync/home-session-index"
import { mergeSessionPages } from "./home-sessions-paged"

const v2Info = (id: string, updated: number): SessionV2Info =>
  ({
    id,
    parentID: undefined,
    agent: "build",
    title: id,
    time: { created: updated, updated, archived: undefined },
    location: { workspaceID: "/home/mark/project", directory: "/home/mark/project" },
    projectID: "project",
    version: "0.0.0",
    cost: 0,
    tokens: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  }) as unknown as SessionV2Info

const sessionIn = (id: string, updated: number) => ({
  id,
  slug: id,
  projectID: "project",
  directory: "/home/mark/project",
  path: "",
  version: "0.0.0",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  title: id,
  time: { created: updated, updated },
})

describe("fetchHomeSessionPage", () => {
  test("returns the first page, next cursor and hasMore when a next cursor exists", async () => {
    let calledWith: { limit: number; order: "desc"; cursor?: string } | undefined
    const list = async (input: { limit: number; order: "desc"; cursor?: string }) => {
      calledWith = input
      return {
        data: {
          data: [v2Info("a", 3), v2Info("b", 2)],
          cursor: { next: "cursor-2", previous: undefined },
        },
      }
    }
    const slice = await fetchHomeSessionPage(list, 64)
    expect(calledWith).toEqual({ limit: 64, order: "desc" })
    expect(slice.sessions.map((s) => s.id)).toEqual(["a", "b"])
    expect(slice.nextCursor).toBe("cursor-2")
    expect(slice.hasMore).toBe(true)
  })

  test("passes the cursor and reports no more when next cursor is absent", async () => {
    let calledWith: { cursor?: string } | undefined
    const list = async (input: { cursor?: string }) => {
      calledWith = input
      return { data: { data: [v2Info("a", 1)], cursor: { next: undefined, previous: "cursor-1" } } }
    }
    const slice = await fetchHomeSessionPage(list, 64, "cursor-1")
    expect(calledWith!.cursor).toBe("cursor-1")
    expect(slice.hasMore).toBe(false)
  })

  test("drops archived and child sessions via parseHomeSessionIndex", async () => {
    const list = async () => ({
      data: {
        data: [
          v2Info("active", 5),
          { ...v2Info("archived", 4), time: { ...v2Info("archived", 4).time, archived: 9_999_999_999 } },
          { ...v2Info("child", 3), parentID: "parent-1" },
        ],
        cursor: { next: undefined, previous: undefined },
      },
    })
    const slice: HomeSessionPageSlice = await fetchHomeSessionPage(list, 64)
    expect(slice.sessions.map((s) => s.id)).toEqual(["active"])
  })
})

describe("mergeSessionPages", () => {
  test("dedupes by session id, keeps newest, sorts by updated desc", () => {
    const pages = [
      [sessionIn("a", 1), sessionIn("b", 2)],
      [sessionIn("b", 5), sessionIn("c", 3)],
    ]
    const merged = mergeSessionPages(pages)
    expect(merged.map((s) => s.id)).toEqual(["b", "c", "a"])
    expect(merged[0].time.updated).toBe(5)
  })
})
