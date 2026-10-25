import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillDiscovery } from "@opencode-ai/core/skill/discovery"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const urls = new Map<string, AbsolutePath[]>()
let pulls = 0
const discovery = Layer.succeed(
  SkillDiscovery.Service,
  SkillDiscovery.Service.of({
    pull: (url) => {
      pulls++
      return Effect.succeed(urls.get(url) ?? [])
    },
  }),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([SkillV2.node, AgentV2.node]), [[SkillDiscovery.node, discovery]]),
)

function write(directory: string, name: string, description: string) {
  return fs.writeFile(
    path.join(directory, name, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---
# ${name}`,
  )
}

describe("SkillV2", () => {
  it.live("registers sources and resolves later source precedence", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = path.join(tmp.path, "first")
          const second = path.join(tmp.path, "second")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(first, "review"), { recursive: true })
            await fs.mkdir(path.join(second, "review"), { recursive: true })
            await write(first, "review", "First")
            await write(second, "review", "Second")
            await fs.writeFile(path.join(first, "foo.md"), "---\nslash: true\n---\n# foo")
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => {
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(first) })
            editor.source({ type: "directory", path: AbsolutePath.make(second) })
            expect(editor.list()).toEqual([
              { type: "directory", path: AbsolutePath.make(first) },
              { type: "directory", path: AbsolutePath.make(second) },
            ])
          })

          expect(yield* skill.sources()).toEqual([
            { type: "directory", path: AbsolutePath.make(first) },
            { type: "directory", path: AbsolutePath.make(second) },
          ])
          expect(yield* skill.list()).toEqual([
            SkillV2.Info.make({
              name: "foo",
              slash: true,
              location: AbsolutePath.make(path.join(first, "foo.md")),
              content: "# foo",
              enabled: true,
            }),
            {
              name: "review",
              description: "Second",
              location: AbsolutePath.make(path.join(second, "review", "SKILL.md")),
              content: "# review",
              enabled: true,
            },
          ])
        }),
      ),
    ),
  )

  it.live("loads URL sources and filters skills for agents", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "deploy"), { recursive: true })
            await write(tmp.path, "deploy", "Deploy production")
          })
          pulls = 0
          urls.set("https://example.test/skills/", [AbsolutePath.make(tmp.path)])

          const agents = yield* AgentV2.Service
          yield* agents.transform((editor) =>
            editor.update(AgentV2.ID.make("reviewer"), (agent) => {
              agent.permissions.push({ action: "skill", resource: "deploy", effect: "deny" })
            }),
          )

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "url", url: "https://example.test/skills/" }))

          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect((yield* skill.list()).map((item) => item.name)).toEqual(["deploy"])
          expect(pulls).toBe(1)
          expect(SkillV2.available(yield* skill.list(), (yield* agents.get(AgentV2.ID.make("reviewer")))!)).toEqual([])
        }),
      ),
    ),
  )

  it.live("updates, enables/disables, and removes skills on disk", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "review"), { recursive: true })
            await write(tmp.path, "review", "Second")
          })

          const skill = yield* SkillV2.Service
          yield* skill.transform((editor) => editor.source({ type: "directory", path: AbsolutePath.make(tmp.path) }))

          const list = () => skill.list()

          expect((yield* list()).map((item) => item.name)).toEqual(["review"])

          const updated = yield* skill.update("review", "---\nname: review\ndescription: Edited\n---\n# Edited")
          expect(updated.content).toBe("# Edited")
          expect(updated.enabled).toBe(true)
          expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "review", "SKILL.md"), "utf8"))).toContain(
            "# Edited",
          )

          const body = yield* skill.update("review", "# Body-only edit")
          expect(body.content).toBe("# Body-only edit")
          expect(body.description).toBe("Edited")
          const saved = yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "review", "SKILL.md"), "utf8"))
          expect(saved).toContain("name: review")
          expect(saved).toContain("description: Edited")
          expect(saved).toContain("# Body-only edit")
          expect(yield* skill.update("review", "---\nname: renamed\n---\nWrong").pipe(Effect.flip)).toBeInstanceOf(
            SkillV2.InvalidError,
          )
          expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "review", "SKILL.md"), "utf8"))).toBe(
            saved,
          )

          expect(
            yield* skill.update("review", "---\ndescription: Missing name\n---\nWrong").pipe(Effect.flip),
          ).toBeInstanceOf(SkillV2.InvalidError)
          expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "review", "SKILL.md"), "utf8"))).toBe(
            saved,
          )

          const disabled = yield* skill.setEnabled("review", false)
          expect(disabled.enabled).toBe(false)
          expect(disabled.location.endsWith(".SKILL.md.disabled")).toBe(true)
          const disabledList = yield* list()
          expect(disabledList).toHaveLength(1)
          expect(disabledList[0].name).toBe("review")
          expect(disabledList[0].enabled).toBe(false)

          expect(SkillV2.available(disabledList, AgentV2.Info.empty(AgentV2.ID.make("build")))).toEqual([])
          const reenabled = yield* skill.setEnabled("review", true)
          expect(reenabled.enabled).toBe(true)
          expect(reenabled.location.endsWith("SKILL.md")).toBe(true)

          yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "flat.md"), "# Flat"))
          yield* skill.remove("review")
          expect((yield* list()).map((item) => item.name)).toEqual(["flat"])
          expect((yield* list()).map((item) => item.name)).toContain("flat")
          expect((yield* skill.setEnabled("flat", false)).name).toBe("flat")
          expect((yield* skill.setEnabled("flat", true)).name).toBe("flat")
          yield* skill.transform((editor) =>
            editor.source({
              type: "embedded",
              skill: SkillV2.Info.make({
                name: "embedded",
                location: AbsolutePath.make(path.join(tmp.path, "flat.md")),
                content: "Built in",
              }),
            }),
          )
          expect(yield* skill.setEnabled("embedded", false).pipe(Effect.flip)).toBeInstanceOf(SkillV2.InvalidError)
          expect(yield* skill.update("embedded", "Changed").pipe(Effect.flip)).toBeInstanceOf(SkillV2.InvalidError)
          expect(yield* skill.remove("embedded").pipe(Effect.flip)).toBeInstanceOf(SkillV2.InvalidError)
          expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "flat.md"), "utf8"))).toBe("# Flat")
        }),
      ),
    ),
  )
})
