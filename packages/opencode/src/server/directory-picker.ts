import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import path from "path"

export function validDirectoryName(name: string, windows = process.platform === "win32") {
  if (!name.trim() || name === "." || name === ".." || /[\\/\u0000-\u001F\u007F]/.test(name)) return false
  if (!windows) return true
  if (/[<>:"|?*]|[. ]$/.test(name)) return false
  return !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
}

export const roots = Effect.gen(function* () {
  if (process.platform !== "win32") return { windows: false, roots: ["/"] }
  const fs = yield* FSUtil.Service
  const candidates = Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`)
  const available = yield* Effect.forEach(
    candidates,
    (directory) => fs.isDir(directory).pipe(Effect.map((exists) => (exists ? directory : undefined))),
    { concurrency: 4 },
  )
  return { windows: true, roots: available.filter((directory) => directory !== undefined) }
})

export class InvalidDirectoryName extends Error {}

/** A single non-recursive mkdir: existing folders are never silently reused. */
export const create = Effect.fn("DirectoryPicker.create")(function* (parent: string, name: string) {
  if (!path.isAbsolute(parent) || !validDirectoryName(name))
    return yield* Effect.fail(new InvalidDirectoryName("Expected an absolute parent and one directory name"))
  const fs = yield* FSUtil.Service
  const directory = path.join(parent, name)
  yield* fs.makeDirectory(directory)
  return { directory }
})

export * as DirectoryPicker from "./directory-picker"
