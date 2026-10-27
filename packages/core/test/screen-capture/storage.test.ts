import { describe, expect } from "bun:test"
import path from "node:path"
import { Duration, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { ScreenshotStorage } from "@opencode-ai/core/screen-capture/storage"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/tmpdir"

const it = testEffect(Layer.empty)

const withStorage = <A, E, R>(
  body: (input: {
    readonly root: string
    readonly global: Global.Interface
    readonly store: ScreenshotStorage.Interface
    readonly fs: FSUtil.Interface
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const global = Global.make({ data: tmp.path })
      const layer = AppNodeBuilder.build(LayerNode.group([ScreenshotStorage.node, FSUtil.node]), [
        [Global.node, Global.layerWith({ data: tmp.path })],
      ])
      return Effect.gen(function* () {
        return yield* body({
          root: tmp.path,
          global,
          store: yield* ScreenshotStorage.Service,
          fs: yield* FSUtil.Service,
        })
      }).pipe(Effect.provide(layer))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

describe("ScreenshotStorage naming", () => {
  it.live("builds local-time filenames with a sanitized slug and suffix", () =>
    Effect.sync(() => {
      const date = new Date(2026, 0, 2, 3, 4, 5)
      expect(ScreenshotStorage.filename({ date, slug: "My App: Test", suffix: "a1b2" })).toBe(
        "20260102-030405-my-app-test-a1b2.png",
      )
      expect(ScreenshotStorage.FILE_PATTERN.test("20260102-030405-my-app-test-a1b2.png")).toBe(true)
      expect(ScreenshotStorage.FILE_PATTERN.test(ScreenshotStorage.filename({ date, slug: "hello" }))).toBe(true)
      expect(ScreenshotStorage.slug("日本語")).toBe("screenshot")
      expect(ScreenshotStorage.slug("!!!")).toBe("screenshot")
      expect(ScreenshotStorage.slug("  Trailing -- dashes  ")).toBe("trailing-dashes")
      expect(ScreenshotStorage.slug("a".repeat(80)).length).toBeLessThanOrEqual(ScreenshotStorage.MAX_SLUG_LENGTH)
      expect(ScreenshotStorage.MAX_SLUG_LENGTH).toBe(40)
    }),
  )
})

describe("ScreenshotStorage write", () => {
  it.live("writes a private, uniquely named file without leaving a temp file", () =>
    withStorage(({ root, global, store, fs }) =>
      Effect.gen(function* () {
        const data = Uint8Array.from([1, 2, 3, 4, 5])
        const saved = yield* store.write({ data, slug: "Hello World", now: new Date(2026, 0, 2, 3, 4, 5) })
        const dir = ScreenshotStorage.directory(global)

        expect(saved.name).toMatch(ScreenshotStorage.FILE_PATTERN)
        expect(saved.name.startsWith("20260102-030405-hello-world-")).toBe(true)
        expect(saved.path).toBe(path.join(dir, saved.name))
        expect(saved.bytes).toBe(data.byteLength)
        expect(yield* fs.readFile(saved.path)).toEqual(data)

        const entries = yield* fs.readDirectoryEntries(dir)
        expect(entries.map((entry) => entry.name)).toEqual([saved.name])
        expect(entries.some((entry) => entry.name.startsWith(".tmp-"))).toBe(false)

        if (process.platform !== "win32") {
          expect((yield* fs.stat(dir)).mode & 0o777).toBe(0o700)
          expect((yield* fs.stat(saved.path)).mode & 0o777).toBe(0o600)
        }
      }),
    ),
  )

  it.live("rejects a screenshots symlink instead of following it", () =>
    withStorage(({ root, store, fs }) =>
      Effect.gen(function* () {
        const outside = path.join(root, "outside")
        yield* fs.makeDirectory(outside, { recursive: true })
        yield* fs.symlink(outside, path.join(root, ScreenshotStorage.DIRECTORY_NAME))

        const error = yield* store.write({ data: Uint8Array.from([1]), slug: "symlink" }).pipe(Effect.flip)
        expect(error).toBeInstanceOf(ScreenshotStorage.StorageError)
        expect(error.operation).toBe("ensure-dir")
        expect(yield* fs.readDirectoryEntries(outside)).toEqual([])
      }),
    ),
  )
})

describe("ScreenshotStorage cleanup", () => {
  it.live("removes only expired files that match the screenshot pattern", () =>
    withStorage(({ global, store, fs }) =>
      Effect.gen(function* () {
        const dir = ScreenshotStorage.directory(global)
        const old = path.join(dir, "20260101-000000-old-a1b2.png")
        const recent = path.join(dir, "20260101-000000-new-b2c3.png")
        const unrelated = path.join(dir, "notes.txt")
        const directory = path.join(dir, "20260101-000000-dir-c3d4.png")
        const link = path.join(dir, "20260101-000000-link-d4e5.png")
        const target = path.join(dir, "target.png")

        yield* fs.makeDirectory(dir, { recursive: true })
        yield* fs.writeFile(old, Uint8Array.from([1]))
        yield* fs.writeFile(recent, Uint8Array.from([2]))
        yield* fs.writeFile(unrelated, Uint8Array.from([3]))
        yield* fs.writeFile(target, Uint8Array.from([4]))
        yield* fs.makeDirectory(directory)
        yield* fs.symlink(target, link)

        const expired = new Date(Date.now() - Duration.toMillis(ScreenshotStorage.RETENTION) - 1_000)
        yield* fs.utimes(old, expired, expired)
        yield* fs.utimes(unrelated, expired, expired)

        yield* store.cleanup()

        expect(yield* fs.exists(old)).toBe(false)
        expect(yield* fs.exists(recent)).toBe(true)
        expect(yield* fs.exists(unrelated)).toBe(true)
        expect(yield* fs.exists(directory)).toBe(true)
        expect(yield* fs.exists(link)).toBe(true)
        expect(yield* fs.exists(target)).toBe(true)
      }),
    ),
  )

  it.live("succeeds when the screenshots directory does not exist", () => withStorage(({ store }) => store.cleanup()))

  it.live("does not follow a screenshots directory symlink during cleanup", () =>
    withStorage(({ root, store, fs }) =>
      Effect.gen(function* () {
        const outside = path.join(root, "outside")
        const old = path.join(outside, "20260101-000000-old-a1b2.png")
        yield* fs.makeDirectory(outside, { recursive: true })
        yield* fs.writeFile(old, Uint8Array.from([1]))
        const expired = new Date(Date.now() - Duration.toMillis(ScreenshotStorage.RETENTION) - 1_000)
        yield* fs.utimes(old, expired, expired)
        yield* fs.symlink(outside, path.join(root, ScreenshotStorage.DIRECTORY_NAME))

        yield* store.cleanup()

        expect(yield* fs.exists(old)).toBe(true)
      }),
    ),
  )
})
