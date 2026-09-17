import { createSignal, For, Show } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useLanguage } from "@/context/language"
import { showToast } from "@/utils/toast"
import type { HomeSkillsController } from "./home-skills-controller"

export type HomeSkillsProps = {
  skills: HomeSkillsController
  language: ReturnType<typeof useLanguage>
}

export function HomeSkills(props: HomeSkillsProps) {
  const editing = createSignal<{ name: string; content: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null)

  async function copySkill(content: string) {
    try {
      await navigator.clipboard.writeText(content)
      showToast({ variant: "success", title: props.language.t("home.skills.copy") })
    } catch {
      // ignore clipboard failures
    }
  }

  return (
    <div class="flex h-full min-w-0 flex-col gap-0.5 p-3">
      <div class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto py-1">
        <For each={props.skills.skills()}>
          {(skill) => (
            <SkillRow
              name={skill.name}
              location={skill.location}
              content={skill.content}
              enabled={skill.enabled ?? true}
              editing={editing[0]()?.name === skill.name}
              editingContent={editing[0]()?.content ?? ""}
              onEditContent={(content) => editing[1]({ name: skill.name, content })}
              onToggle={(enabled) => {
                if (props.skills.enabled.isPending) return
                props.skills.enabled.mutate({ name: skill.name, enabled })
              }}
              onCopy={() => copySkill(skill.content)}
              onOpenEditor={() => editing[1]({ name: skill.name, content: skill.content })}
              onCancelEditor={() => editing[1](null)}
              onSave={(content) => {
                if (props.skills.update.isPending) return
                props.skills.update.mutate({ name: skill.name, content })
                editing[1](null)
              }}
              onRequestDelete={() => setConfirmDelete(skill.name)}
              onConfirmDelete={() => {
                if (props.skills.remove.isPending) return
                setConfirmDelete(null)
                props.skills.remove.mutate({ name: skill.name })
              }}
              confirmDelete={confirmDelete() === skill.name}
              onCancelDelete={() => setConfirmDelete(null)}
              t={props.language.t}
            />
          )}
        </For>
        <Show when={props.skills.skills().length === 0 && !props.skills.loading}>
          <div class="flex flex-1 flex-col items-center justify-center gap-1 text-center text-v2-text-text-faint [font-weight:440]">
            <span>{props.language.t("home.skills.empty")}</span>
            <span class="text-xs">{props.language.t("home.skills.empty.description")}</span>
          </div>
        </Show>
      </div>
    </div>
  )
}

function SkillRow(props: {
  name: string
  location: string
  content: string
  enabled: boolean
  editing: boolean
  editingContent: string
  onEditContent: (content: string) => void
  onToggle: (enabled: boolean) => void
  onCopy: () => void
  onOpenEditor: () => void
  onCancelEditor: () => void
  onSave: (content: string) => void
  onRequestDelete: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
  confirmDelete: boolean
  t: ReturnType<typeof useLanguage>["t"]
}) {
  return (
    <div
      data-component="home-skill-row"
      class={`
        flex min-w-0 flex-col rounded-[8px] border border-transparent px-2 py-2
        transition-[background-color] duration-[120ms] hover:bg-v2-background-bg-layer-01
        focus-visible:outline-none focus-visible:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]
      `}
    >
      <div class="flex min-w-0 items-center justify-between gap-3">
        <div class="flex min-w-0 flex-col gap-1">
          <span class="min-w-0 truncate text-v2-text-text-base" classList={{ "opacity-50": !props.enabled }}>
            {props.name}
          </span>
          <span
            class="min-w-0 truncate text-xs text-v2-text-text-faint [font-weight:440]"
            classList={{ "opacity-50": !props.enabled }}
          >
            {props.location}
          </span>
        </div>

        <span class="flex shrink-0 items-center gap-1">
          <IconButton
            data-component="home-skill-edit"
            title={props.t("home.skills.edit")}
            onClick={props.onOpenEditor}
            icon="edit"
          />
          <IconButton
            data-component="home-skill-copy"
            title={props.t("home.skills.copy")}
            onClick={props.onCopy}
            icon="copy"
          />
          <IconButton
            data-component="home-skill-toggle"
            title={props.enabled ? props.t("home.skills.disabled") : props.t("home.skills.enabled")}
            onClick={() => props.onToggle(!props.enabled)}
            icon="eye"
            classList={{ "home-skill-disabled": !props.enabled }}
          />
          <Show
            when={!props.confirmDelete}
            fallback={
              <span class="flex items-center gap-1">
                <button
                  data-component="home-skill-delete-confirm"
                  type="button"
                  class="cursor-pointer rounded-[6px] bg-v2-state-bg-danger px-2 py-1 text-[11px] text-v2-text-text-inverse"
                  onClick={props.onConfirmDelete}
                >
                  {props.t("home.skills.delete.confirm", { name: props.name })}
                </button>
                <IconButton
                  data-component="home-skill-delete-cancel"
                  title={props.t("home.skills.cancel")}
                  onClick={props.onCancelDelete}
                  icon="close"
                />
              </span>
            }
          >
            <IconButton
              data-component="home-skill-delete"
              title={props.t("home.skills.delete")}
              onClick={props.onRequestDelete}
              icon="trash"
            />
          </Show>
        </span>
      </div>

      <Show when={props.editing}>
        <div class="mt-2 flex flex-col gap-2">
          <textarea
            data-component="home-skill-editor"
            value={props.editingContent}
            onInput={(event) => props.onEditContent(event.currentTarget.value)}
            spellcheck={false}
            class="h-40 w-full resize-none rounded-[8px] border border-v2-border-border-base bg-v2-background-bg-base p-2 font-mono text-xs outline-none focus:border-v2-border-border-focus"
          />
          <span class="flex items-center gap-2">
            <button
              data-component="home-skill-save"
              type="button"
              class="cursor-pointer rounded-[6px] bg-v2-state-bg-info px-3 py-1 text-[11px] text-v2-text-text-inverse"
              onClick={() => props.onSave(props.editingContent)}
            >
              {props.t("home.skills.save")}
            </button>
            <button
              type="button"
              class="cursor-pointer rounded-[6px] px-3 py-1 text-[11px] text-v2-text-text-muted"
              onClick={props.onCancelEditor}
            >
              {props.t("home.skills.cancel")}
            </button>
          </span>
        </div>
      </Show>
    </div>
  )
}
