export * as ScreenshotStorage from "./storage"

import path from "path"
import { randomBytes } from "node:crypto"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { makeGlobalNode } from "../effect/app-node"

export const DIRECTORY_NAME = "screenshots"
export const RETENTION = Duration.days(7)
export const MAX_SLUG_LENGTH = 40
export const FILE_PATTERN = /^\d{8}-\d{6}-[a-z0-9-]{1,40}(?:-[0-9a-f]{4})?\.png$/

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("ScreenshotStorage.StorageError", {
  operation: Schema.Literals(["ensure-dir", "write", "rename", "cleanup"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause)
    const action = {
      "ensure-dir": "prepare the screenshots directory",
      write: "write a screenshot",
      rename: "rename a screenshot",
      cleanup: "clean up screenshots",
    }[this.operation]
    return `Failed to ${action}${detail ? `: ${detail}` : ""}`
  }
}

export type Error = StorageError

export const Saved = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  bytes: Schema.Number,
})
export type Saved = typeof Saved.Type

export interface Interface {
  readonly write: (input: {
    readonly data: Uint8Array
    readonly slug: string
    readonly now?: Date
  }) => Effect.Effect<Saved, Error>
  readonly cleanup: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ScreenshotStorage") {}

export const directory = (global: Global.Interface) => path.join(global.data, DIRECTORY_NAME)

export const glob = (global: Global.Interface) => path.join(directory(global), "*")

export const slug = (input: string) => {
  const sanitized = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "")
  return sanitized || "screenshot"
}

const pad = (value: number, length = 2) => String(value).padStart(length, "0")

export const filename = (input: { readonly date: Date; readonly slug: string; readonly suffix?: string }) => {
  const date = input.date
  const stamp = [
    pad(date.getFullYear(), 4),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("")
  const suffix = (input.suffix ?? randomBytes(2).toString("hex")).toLowerCase()
  return `${stamp}-${slug(input.slug)}-${suffix}.png`
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const screenshots = directory(global)
    const parent = path.dirname(screenshots)

    const ensureDirectory = Effect.fn("ScreenshotStorage.ensureDirectory")(function* () {
      const entries = yield* fs.readDirectoryEntries(parent).pipe(Effect.catch(() => Effect.succeed([])))
      const existing = entries.find((entry) => entry.name === DIRECTORY_NAME)
      if (existing && existing.type !== "directory")
        return yield* new StorageError({
          operation: "ensure-dir",
          cause: new Error(`${screenshots} exists but is not a directory (${existing.type})`),
        })
      yield* fs
        .makeDirectory(screenshots, { recursive: true, mode: 0o700 })
        .pipe(Effect.mapError((cause) => new StorageError({ operation: "ensure-dir", cause })))
      if (process.platform !== "win32")
        yield* fs
          .chmod(screenshots, 0o700)
          .pipe(Effect.mapError((cause) => new StorageError({ operation: "ensure-dir", cause })))
    })

    const write = Effect.fn("ScreenshotStorage.write")(function* (input: {
      readonly data: Uint8Array
      readonly slug: string
      readonly now?: Date
    }) {
      yield* ensureDirectory()
      const name = filename({ date: input.now ?? new Date(), slug: input.slug })
      const target = path.join(screenshots, name)
      const temp = path.join(screenshots, `.tmp-${randomBytes(4).toString("hex")}`)
      const removeTemp = fs.remove(temp).pipe(Effect.catch(() => Effect.void))

      yield* fs.writeFile(temp, input.data, { flag: "wx", mode: 0o600 }).pipe(
        Effect.mapError((cause) => new StorageError({ operation: "write", cause })),
        Effect.tapError(() => removeTemp),
      )
      yield* fs.rename(temp, target).pipe(
        Effect.mapError((cause) => new StorageError({ operation: "rename", cause })),
        Effect.tapError(() => removeTemp),
      )
      if (process.platform !== "win32")
        yield* fs.chmod(target, 0o600).pipe(
          Effect.mapError((cause) => new StorageError({ operation: "write", cause })),
          Effect.tapError(() => fs.remove(target).pipe(Effect.catch(() => Effect.void))),
        )

      return { path: target, name, bytes: input.data.byteLength }
    })

    const cleanup = Effect.fn("ScreenshotStorage.cleanup")(function* () {
      const parentEntries = yield* fs.readDirectoryEntries(parent).pipe(Effect.catch(() => Effect.succeed([])))
      const existing = parentEntries.find((entry) => entry.name === DIRECTORY_NAME)
      if (existing && existing.type !== "directory") return
      const entries = yield* fs.readDirectoryEntries(screenshots).pipe(Effect.catch(() => Effect.succeed([])))
      const cutoff = Date.now() - Duration.toMillis(RETENTION)
      for (const entry of entries) {
        if (entry.type !== "file" || !FILE_PATTERN.test(entry.name)) continue
        const file = path.join(screenshots, entry.name)
        const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.void))
        const modified = info?.mtime.pipe(
          Option.map((date) => date.getTime()),
          Option.getOrElse(() => 0),
        )
        if (modified !== undefined && modified < cutoff) yield* fs.remove(file).pipe(Effect.catch(() => Effect.void))
      }
    })

    return Service.of({ write, cleanup })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [FSUtil.node, Global.node] })

/** Runs retention scanning once globally rather than once per active Location. */
export const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Service
    yield* store.cleanup().pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.forkScoped)
  }),
)

export const cleanupNode = makeGlobalNode({
  name: "screenshot-cleanup",
  layer: Layer.merge(layer, cleanupLayer.pipe(Layer.provide(layer))),
  deps: [FSUtil.node, Global.node],
})
