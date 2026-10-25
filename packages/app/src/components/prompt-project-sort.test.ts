import { expect, test } from "bun:test"
import { sortPromptProjects } from "./prompt-project-sort"

test("orders recent projects first and breaks unused/tied entries by displayed folder name", () => {
  const projects = [
    { worktree: "/zebra" },
    { worktree: "/alpha" },
    { worktree: "/beta", lastUsed: 10 },
    { worktree: "/omega", lastUsed: 20 },
  ]
  expect(sortPromptProjects(projects).map((project) => project.worktree)).toEqual([
    "/omega",
    "/beta",
    "/alpha",
    "/zebra",
  ])
  expect(projects[0].worktree).toBe("/zebra")
})
test("keeps projects with the same folder name on different servers distinct", () => {
  const projects = [
    { worktree: "/repo", server: { key: "a", name: "A" }, lastUsed: 1 },
    { worktree: "/repo", server: { key: "b", name: "B" }, lastUsed: 2 },
    { worktree: "/folder", name: "Custom name" },
  ]
  expect(sortPromptProjects(projects).map((project) => project.server?.key)).toEqual(["b", "a", undefined])
})
