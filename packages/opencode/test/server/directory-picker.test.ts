import { expect, test } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { DirectoryPicker } from "@/server/directory-picker"
import { tmpdir } from "../fixture/fixture"
import path from "path"

test("rejects traversal, separators and control characters as directory names", () => {
  for (const name of ["", " ", ".", "..", "../escape", "a/b", "a\\b", "bad\u0000name", "bad\nname"]) {
    expect(DirectoryPicker.validDirectoryName(name, false)).toBeFalse()
    expect(DirectoryPicker.validDirectoryName(name, true)).toBeFalse()
  }
  expect(DirectoryPicker.validDirectoryName("my project", false)).toBeTrue()
  expect(DirectoryPicker.validDirectoryName("my project", true)).toBeTrue()
})

test("rejects reserved Windows names without imposing Windows rules on POSIX", () => {
  for (const name of ["CON", "nul.txt", "com1", "LPT9.log", "folder.", "folder ", "a:b", "a?b"]) {
    expect(DirectoryPicker.validDirectoryName(name, true)).toBeFalse()
    expect(DirectoryPicker.validDirectoryName(name, false)).toBeTrue()
  }
  expect(DirectoryPicker.validDirectoryName("console", true)).toBeTrue()
  expect(DirectoryPicker.validDirectoryName("company.txt", true)).toBeTrue()
})

test("creates one child and rejects duplicates without altering the existing folder", async () => {
  await using tmp = await tmpdir()
  const create = (parent: string, name: string) =>
    Effect.runPromise(DirectoryPicker.create(parent, name).pipe(Effect.provide(LayerNode.compile(FSUtil.node))))
  const created = await create(tmp.path, "new project")
  expect(created.directory).toBe(path.join(tmp.path, "new project"))
  await expect(create(tmp.path, "new project")).rejects.toBeDefined()
  await expect(create(tmp.path, "../escape")).rejects.toBeDefined()
  await expect(create(path.join(tmp.path, "missing"), "child")).rejects.toBeDefined()
  await expect(create("relative", "child")).rejects.toBeDefined()
})

test("reports the real POSIX root", async () => {
  if (process.platform === "win32") return
  expect(await Effect.runPromise(DirectoryPicker.roots.pipe(Effect.provide(LayerNode.compile(FSUtil.node))))).toEqual({
    windows: false,
    roots: ["/"],
  })
})
