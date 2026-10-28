/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { Global } from "../global"
import { AbsolutePath } from "../schema"
import { ScreenshotStorage } from "../screen-capture/storage"
import { SkillV2 } from "../skill"
import captureScreenshotContent from "./skill/capture-screenshot.md" with { type: "text" }
import customizeOpencodeContent from "./skill/customize-opencode.md" with { type: "text" }

export const CustomizeOpencodeContent = customizeOpencodeContent
export const CaptureScreenshotContent = captureScreenshotContent

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    const global = yield* Global.Service
    const screenshots = ScreenshotStorage.directory(global)
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-opencode",
            description:
              "Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself.",
            location: AbsolutePath.make("/builtin/customize-opencode.md"),
            content: CustomizeOpencodeContent,
          }),
        }),
      )
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "capture-screenshot",
            description:
              "Use when the user wants to see, capture or visually check something: the screen, an application window, a web page or a test artifact.",
            location: AbsolutePath.make("/builtin/capture-screenshot.md"),
            content: CaptureScreenshotContent.replaceAll("{{screenshots_dir}}", screenshots),
          }),
        }),
      )
    })
  }),
})
