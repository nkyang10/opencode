import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { ProjectV2 } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const here = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const elsewhere = Location.Ref.make({ directory: AbsolutePath.make("/other") })

// `create` stamps created = updated = Date.now(), so the rows are indistinguishable until their
// timestamps are set explicitly. That keeps the fixture independent of the clock and of how fast
// the inserts happen. `used` is the half that matters: it moves time_updated only, which is what
// makes creation order and last-activity order disagree.
const stamp = (id: SessionV2.ID, timeCreated: number, timeUpdated: number) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({ time_created: timeCreated, time_updated: timeUpdated })
      .where(eq(SessionTable.id, id))
      .run()
      .pipe(Effect.orDie)
  })

const used = (id: SessionV2.ID, timeUpdated: number) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({ time_updated: timeUpdated })
      .where(eq(SessionTable.id, id))
      .run()
      .pipe(Effect.orDie)
  })

const seed = Effect.fn("seed")(function* (count: number, directory = here) {
  const session = yield* SessionV2.Service
  const ids: SessionV2.ID[] = []
  for (let index = 0; index < count; index++) {
    const created = yield* session.create({ location: directory })
    yield* stamp(created.id, (index + 1) * 1_000, (index + 1) * 1_000)
    ids.push(created.id)
  }
  return ids
})

describe("SessionV2.list", () => {
  it.effect("orders by last activity, not by creation time", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const [first, second] = yield* seed(2)

      expect((yield* session.list({ order: "desc" })).map((item) => item.id)).toEqual([second, first])

      // The session created 1000ms earlier is now the most recently used one, so it leads even
      // though it is the older row. Created-time ordering would leave it last.
      yield* used(first, 5_000)
      expect((yield* session.list({ order: "desc" })).map((item) => item.id)).toEqual([first, second])
      expect((yield* session.list({ order: "asc" })).map((item) => item.id)).toEqual([second, first])
    }),
  )

  it.effect("keeps a just-used old session inside the first bounded page", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const ids = yield* seed(5)
      yield* used(ids[0], 9_000)

      const page = yield* session.list({ order: "desc", limit: 2 })

      expect(page.map((item) => item.id)).toEqual([ids[0], ids[4]])
    }),
  )

  it.effect("pages by last activity without gaps or repeats", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const ids = yield* seed(5)
      yield* used(ids[0], 9_000)

      const seen: string[] = []
      let anchor: SessionV2.ListAnchor | undefined
      for (;;) {
        const page = yield* session.list({ order: "desc", limit: 2, ...(anchor ? { anchor } : {}) })
        if (page.length === 0) break
        seen.push(...page.map((item) => item.id))
        if (page.length < 2) break
        const last = page.at(-1)!
        // The cursor is a wire value, so it carries epoch millis, not the in-process DateTime.
        anchor = { id: last.id, time: DateTime.toEpochMillis(last.time.updated), direction: "next" }
      }

      expect(seen).toEqual([ids[0], ids[4], ids[3], ids[2], ids[1]])
    }),
  )

  it.effect("walks back to the previous page of a last-activity anchor", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const ids = yield* seed(4)

      const second = yield* session.list({
        order: "desc",
        limit: 2,
        anchor: { id: ids[2], time: 3_000, direction: "next" },
      })
      const first = yield* session.list({
        order: "desc",
        limit: 2,
        // What the handler builds for the oldest row of a page: "give me what came before it".
        anchor: { id: second[0].id, time: DateTime.toEpochMillis(second[0].time.updated), direction: "previous" },
      })

      expect(second.map((item) => item.id)).toEqual([ids[1], ids[0]])
      expect(first.map((item) => item.id)).toEqual([ids[3], ids[2]])
    }),
  )

  it.effect("keeps last-activity ordering when filtered by directory", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const near = yield* seed(2, here)
      const far = yield* seed(1, elsewhere)
      // The /other session becomes the most recently used one overall, but must stay out of the
      // /project page; the /project session that leads it still leads that page.
      yield* used(far[0], 9_000)

      const page = yield* session.list({ directory: AbsolutePath.make("/project"), order: "desc" })

      expect(page.map((item) => item.id)).toEqual([near[1], near[0]])
    }),
  )
})
