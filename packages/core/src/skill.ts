export * as SkillV2 from "./skill"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema, Types } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { AgentV2 } from "./agent"
import { ConfigMarkdown } from "./config/markdown"
import { FSUtil } from "./fs-util"
import { PermissionV2 } from "./permission"
import { AbsolutePath } from "./schema"
import { SkillDiscovery } from "./skill/discovery"
import { State } from "./state"

export const DirectorySource = Skill.DirectorySource
export type DirectorySource = Skill.DirectorySource

export const UrlSource = Skill.UrlSource
export type UrlSource = Skill.UrlSource

export const EmbeddedSource = Skill.EmbeddedSource
export type EmbeddedSource = Skill.EmbeddedSource

export const Source = Skill.Source
export type Source = typeof Source.Type

export const Info = Skill.Info
export type Info = Skill.Info

export const available = (skills: ReadonlyArray<Info>, agent: AgentV2.Info) =>
  skills.filter((skill) => PermissionV2.evaluate("skill", skill.name, agent.permissions).effect !== "deny")

const Frontmatter = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  slash: Schema.Boolean.pipe(Schema.optional),
})
const decodeFrontmatter = Schema.decodeUnknownOption(Frontmatter)

const DISABLED_SUFFIX = ".disabled"

// A skill is "disabled" (marker-file rename) when its on-disk file name has
// been renamed to a hidden `.disabled` variant, e.g. `SKILL.md` ->
// `.SKILL.md.disabled`. Such files are no longer discovered by the agent but
// still surface in management UIs so they can be re-enabled.
const isDisabledSkillPath = (filepath: string) => path.basename(filepath).startsWith(".") && filepath.endsWith(DISABLED_SUFFIX)

export type Data = {
  sources: Types.DeepMutable<Source>[]
}

export type Draft = {
  source: (source: Source) => void
  list: () => readonly Source[]
}

export interface Interface extends State.Transformable<Draft> {
  readonly sources: () => Effect.Effect<Source[]>
  readonly list: () => Effect.Effect<Info[]>
  readonly update: (name: string, content: string) => Effect.Effect<Info, InvalidError | Error>
  readonly setEnabled: (name: string, enabled: boolean) => Effect.Effect<Info, InvalidError | Error>
  readonly remove: (name: string) => Effect.Effect<void, InvalidError | Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Skill") {}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("SkillV2.InvalidError", {
  name: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `Skill "${this.name}" cannot be modified: ${this.reason}`
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* SkillDiscovery.Service
    const fs = yield* FSUtil.Service

    const state = State.create<Data, Draft>({
      initial: () => ({ sources: [] }),
      draft: (draft) => ({
        source: (source) => {
          if (draft.sources.some((item) => Source.equals(item, source))) return
          draft.sources.push(source as Types.DeepMutable<Source>)
        },
        list: () => draft.sources as Source[],
      }),
    })

    const load = Effect.fn("SkillV2.load")(function* (source: Source) {
      const skills: Info[] = []
      if (source.type === "embedded") return [source.skill]
      const directories = source.type === "directory" ? [source.path] : yield* discovery.pull(source.url)
      for (const directory of directories) {
        const files = yield* fs
          .glob("{*.md,**/SKILL.md,**/.*.disabled}", {
            cwd: directory,
            absolute: true,
            include: "file",
            symlink: true,
            dot: true,
          })
          .pipe(Effect.catch(() => Effect.succeed([] as string[])))
      for (const filepath of files.toSorted()) {
        const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (!content) continue
        const disabled = isDisabledSkillPath(filepath)
        const markdown = ConfigMarkdown.parseOption(content)
        if (!markdown) continue
        const frontmatter = decodeFrontmatter(markdown.data).valueOrUndefined
        if (!frontmatter) continue
        const name =
          frontmatter.name !== undefined
            ? frontmatter.name
            : path.dirname(filepath) === directory
              ? path.basename(filepath, disabled ? ".disabled" : ".md")
              : undefined
        if (!name) continue
        skills.push({
          name,
          description: frontmatter.description,
          slash: frontmatter.slash,
          location: AbsolutePath.make(filepath),
          content: markdown.content,
          enabled: !disabled,
        })
      }
      }
      return skills
    })

    // QUESTION(Dax): Should local skill sources invalidate on filesystem watch
    // events, following the reload policy chosen for other context sources?
    const cache = new Map<string, Info[]>()
    const list = Effect.fn("SkillV2.list")(function* () {
      const skills = new Map<string, Info>()
      for (const source of state.get().sources) {
        const key = Source.key(source)
        const loaded = cache.get(key) ?? (yield* load(source))
        cache.set(key, loaded)
        for (const skill of loaded) skills.set(skill.name, skill)
      }
      return Array.from(skills.values())
    })

    const get = Effect.fn("SkillV2.get")(function* (name: string) {
      const info = (yield* list()).find((item) => item.name === name)
      if (!info) return yield* new InvalidError({ name, reason: "Skill not found." })
      return info
    })

    const activePath = Effect.fn("SkillV2.activePath")(function* (info: Info) {
      const current = info.location
      if (current.startsWith("<")) {
        return yield* new InvalidError({ name: info.name, reason: "Embedded skill cannot be edited." })
      }
      if (isDisabledSkillPath(current)) {
        const directory = path.dirname(current)
        const name = path.basename(current, DISABLED_SUFFIX).replace(/^\./, "")
        return path.join(directory, name)
      }
      return current
    })

    const disabledPath = (info: Info) => {
      const current = info.location
      const directory = path.dirname(current)
      const name = path.basename(current).replace(/^\./, "")
      return path.join(directory, `.${name}${DISABLED_SUFFIX}`)
    }

    const refresh = Effect.fn("SkillV2.refresh")(function* (name: string) {
      cache.clear()
      return yield* get(name)
    })

    const update = Effect.fn("SkillV2.update")(function* (name: string, content: string) {
      const info = yield* get(name)
      const target = yield* activePath(info)
      if (info.enabled === false && info.location !== target) {
        // Re-enable (restore original name) while writing new content.
        yield* fs.rename(info.location, target)
      }
      yield* fs.writeFileString(target, content)
      return yield* refresh(name)
    })

    const setEnabled = Effect.fn("SkillV2.setEnabled")(function* (name: string, enabled: boolean) {
      const info = yield* get(name)
      if (info.enabled === enabled) return info
      if (info.enabled) {
        const target = disabledPath(info)
        yield* fs.rename(info.location, target)
      } else {
        const target = yield* activePath(info)
        yield* fs.rename(info.location, target)
      }
      return yield* refresh(name)
    })

    const remove = Effect.fn("SkillV2.remove")(function* (name: string) {
      const info = yield* get(name)
      if (info.location.startsWith("<")) {
        return yield* new InvalidError({ name, reason: "Embedded skill cannot be deleted." })
      }
      yield* fs.remove(info.location, { force: true })
      cache.clear()
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      sources: Effect.fn("SkillV2.sources")(function* () {
        return state.get().sources
      }),
      list,
      update,
      setEnabled,
      remove,
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [SkillDiscovery.node, FSUtil.node] })
