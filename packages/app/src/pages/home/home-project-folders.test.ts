import { expect, test } from "bun:test"
import type { Project } from "@opencode-ai/sdk/v2/client"
import { isPlainFolder, mergeProjectFolders } from "./home-project-folders"

const project = (id: string, worktree: string, sandboxes: string[] = []): Project => ({
  id,
  worktree,
  vcs: "git",
  sandboxes,
  time: { created: 0, updated: 0 },
})

test("lists directories that are not a repository alongside the projects", () => {
  const merged = mergeProjectFolders([project("repo", "/home/mark/ide")], ["/home/mark/Desktop", "/scratch/notes"])
  expect(merged.map((item) => item.worktree)).toEqual([
    "/home/mark/ide",
    "/home/mark/Desktop",
    "/scratch/notes",
  ])
  expect(merged.map((item) => isPlainFolder(item))).toEqual([false, true, true])
  // The folder rows keep the shape the project rows are built from.
  expect(merged[1]).toEqual({ worktree: "/home/mark/Desktop", expanded: false })
})

test("does not list a directory twice when the server already knows it as a project", () => {
  const merged = mergeProjectFolders(
    [project("repo", "/home/mark/ide", ["/home/mark/ide/packages"])],
    ["/home/mark/ide", "/home/mark/ide/", "/home/mark/ide/packages", "/home/mark/Desktop", "/home/mark/Desktop/"],
  )
  expect(merged.map((item) => item.worktree)).toEqual(["/home/mark/ide", "/home/mark/Desktop"])
})

test("keeps the project rows untouched and marks them as not plain folders", () => {
  const rows = [project("repo", "/home/mark/ide")]
  const merged = mergeProjectFolders(rows, [])
  expect(merged[0]).toEqual({ ...rows[0], expanded: false })
  expect(isPlainFolder(merged[0])).toBeFalse()
})

test("ignores blank folder records", () => {
  expect(mergeProjectFolders([], ["", "/home/mark/Desktop"])).toEqual([
    { worktree: "/home/mark/Desktop", expanded: false },
  ])
})
