import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { SkillPlugin } from "@opencode-ai/core/plugin/skill"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ScreenshotStorage } from "@opencode-ai/core/screen-capture/storage"
import { SkillV2 } from "@opencode-ai/core/skill"
import { testEffect } from "../lib/effect"
import { tmpdir } from "../fixture/tmpdir"
import { host } from "./host"

const it = testEffect(AppNodeBuilder.build(SkillV2.node))
const withGlobal = <A, E, R>(effect: Effect.Effect<A, E, R>, global = Global.make()) =>
  effect.pipe(Effect.provideService(Global.Service, Global.Service.of(global)))
const plugin = (skill: SkillV2.Interface) =>
  SkillPlugin.Plugin.effect(host({ skill: { ...skill, reload: skill.reload } }))

describe("SkillPlugin.Plugin", () => {
  it.effect("registers both built-in skills", () =>
    withGlobal(
      Effect.gen(function* () {
        const skill = yield* SkillV2.Service
        yield* plugin(skill)

        expect(yield* skill.list()).toContainEqual(
          expect.objectContaining({
            name: "customize-opencode",
            description: expect.stringContaining("opencode's own configuration"),
          }),
        )
        expect(yield* skill.list()).toContainEqual(
          expect.objectContaining({
            name: "capture-screenshot",
            description:
              "Use when the user wants to see, capture or visually check something: the screen, an application window, a web page or a test artifact.",
          }),
        )
      }),
    ),
  )

  it.effect("loads capture-screenshot with the resolved screenshots directory", () =>
    withGlobal(
      Effect.gen(function* () {
        const global = Global.make()
        const skill = yield* SkillV2.Service
        yield* plugin(skill)

        const capture = (yield* skill.list()).find((item) => item.name === "capture-screenshot")
        if (!capture) throw new Error("expected capture-screenshot skill")
        expect(capture.description).toBe(
          "Use when the user wants to see, capture or visually check something: the screen, an application window, a web page or a test artifact.",
        )
        expect(capture.content).toContain(ScreenshotStorage.directory(global))
        expect(capture.content).toContain(`mkdir -p "${ScreenshotStorage.directory(global)}"`)
        expect(capture.content).toContain(`${ScreenshotStorage.directory(global)}/<timestamp>-<slug>.png`)
        expect(capture.content).not.toContain("{{screenshots_dir}}")
      }),
    ),
  )

  it.effect("hides capture-screenshot when the agent denies that skill", () =>
    withGlobal(
      Effect.gen(function* () {
        const skill = yield* SkillV2.Service
        yield* plugin(skill)
        const agent = AgentV2.Info.make({
          ...AgentV2.Info.empty(AgentV2.ID.make("build")),
          permissions: [{ action: "skill", resource: "capture-screenshot", effect: "deny" }],
        })

        const available = SkillV2.available(yield* skill.list(), agent)
        expect(available.map((item) => item.name)).toContain("customize-opencode")
        expect(available.map((item) => item.name)).not.toContain("capture-screenshot")
      }),
    ),
  )

  it.live("lets a directory skill with the same name override the built-in", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        const global = Global.make({ data: tmp.path })
        return withGlobal(
          Effect.gen(function* () {
            yield* Effect.promise(async () => {
              await fs.mkdir(path.join(tmp.path, "capture"), { recursive: true })
              await fs.writeFile(
                path.join(tmp.path, "capture", "SKILL.md"),
                "---\nname: capture-screenshot\ndescription: Custom capture\n---\n# Custom capture",
              )
            })
            const skill = yield* SkillV2.Service
            yield* plugin(skill)
            yield* skill.transform((editor) => editor.source({ type: "directory", path: AbsolutePath.make(tmp.path) }))

            const capture = (yield* skill.list()).find((item) => item.name === "capture-screenshot")
            if (!capture) throw new Error("expected capture-screenshot skill")
            expect(capture.description).toBe("Custom capture")
            expect(capture.content).toBe("# Custom capture")
          }),
          global,
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )
})
