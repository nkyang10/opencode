import { type Accessor, createMemo, For, Show } from "solid-js"
import { DateTime } from "luxon"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { SessionTabAvatarView } from "@/pages/layout/session-tab-avatar"
import { sessionTitle } from "@/utils/session-title"
import { sessionLastPrompt } from "@/utils/session-last-prompt"
import { useLanguage } from "@/context/language"
import { useServerSync } from "@/context/server-sync"
import type { ServerConnection } from "@/context/server"
import {
  HomeSessionStatusController,
  type HomeSessionRecord,
  type OpenSessionOptions,
} from "./home-sessions-controller"

export type HomeSessionsTableProps = {
  language: ReturnType<typeof useLanguage>
  records: () => HomeSessionRecord[]
  server: () => ServerConnection.Key
  serverName: () => string
  isOpenTab: (record: HomeSessionRecord) => boolean
  onOpenSession: (record: HomeSessionRecord, options?: OpenSessionOptions) => void
}

export function HomeSessionsTable(props: HomeSessionsTableProps) {
  const rows = createMemo(() =>
    [...props.records()].sort((a, b) => {
      const at = a.session.time.updated ?? a.session.time.created
      const bt = b.session.time.updated ?? b.session.time.created
      return bt - at
    }),
  )

  return (
    <div class="flex h-full min-w-0 flex-col gap-0.5 p-3">
      <div class="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto py-1">
        <For each={rows()}>
          {(record) => (
            <HomeSessionTableRow
              server={props.server}
              serverName={props.serverName}
              record={record}
              isOpenTab={props.isOpenTab}
              onOpen={props.onOpenSession}
            />
          )}
        </For>
        <Show when={rows().length === 0}>
          <div class="flex flex-1 items-center justify-center text-v2-text-text-faint [font-weight:440]">
            {props.language.t("home.sessions.empty")}
          </div>
        </Show>
      </div>
    </div>
  )
}

function HomeSessionTableRow(props: {
  server: Accessor<ServerConnection.Key>
  serverName: () => string
  record: HomeSessionRecord
  isOpenTab: (record: HomeSessionRecord) => boolean
  onOpen: (record: HomeSessionRecord, options?: OpenSessionOptions) => void
}) {
  const projectName = () => props.record.projectName
  const project = () => props.record.project
  const title = () => sessionTitle(props.record.session.title) || props.record.session.id
  const serverSync = useServerSync()
  const lastPrompt = createMemo(() => sessionLastPrompt(serverSync(), props.record.session.id))

  return (
    <HomeSessionStatusController
      server={props.server}
      record={props.record}
      isOpenTab={props.isOpenTab}
      render={(state) => (
        <button
          type="button"
          data-component="home-session-table-row"
          class={`
            flex min-w-0 cursor-pointer items-start rounded-[8px] border border-transparent px-2 py-2
            text-left transition-[background-color] duration-[120ms] hover:bg-v2-background-bg-layer-01
            focus-visible:outline-none focus-visible:[box-shadow:inset_0_0_0_0.5px_var(--v2-border-border-muted)]
          `}
          onClick={() => props.onOpen(props.record)}
        >
          <span class="mt-[2px] shrink-0">
            <SessionTabAvatarView
              project={project()}
              directory={props.record.session.directory}
              unread={state.unread()}
              loading={state.loading()}
            />
          </span>

          <span class="flex min-w-0 flex-1 flex-col gap-0.5 pl-2.5">
            <span class="flex min-w-0 items-start justify-between gap-3">
              <span
                class="min-w-0 text-v2-text-text-base"
                style={{ "-webkit-line-clamp": "2", display: "-webkit-box", "-webkit-box-orient": "vertical", overflow: "hidden" }}
                classList={{ "font-semibold": state.unread(), "[font-weight:440]": !state.unread() }}
              >
                {title()}
              </span>
              <span class="mt-[1px] shrink-0 [font-size:11px] leading-4 text-v2-text-text-faint [font-weight:440]">
                {DateTime.fromMillis(props.record.session.time.updated ?? props.record.session.time.created).toRelative()}
              </span>
            </span>

            <Show when={projectName()}>
              <span class="flex min-w-0 items-center gap-1 text-v2-text-text-secondary">
                <Show when={props.serverName()}>
                  <span class="truncate text-xs text-v2-text-text-faint [font-weight:440]">{props.serverName()}</span>
                  <span class="shrink-0 text-xs text-v2-text-text-faint"> / </span>
                </Show>
                <Icon name="folder" size="small" class="shrink-0 text-v2-text-text-faint" />
                <span class="truncate text-xs [font-weight:440]">
                  {projectName()}
                </span>
              </span>
            </Show>

            <Show when={lastPrompt()}>
              <span
                class="text-xs text-v2-text-text-faint [font-weight:440]"
                style={{ "-webkit-line-clamp": "2", display: "-webkit-box", "-webkit-box-orient": "vertical", overflow: "hidden" }}
                data-component="home-session-row-prompt"
              >
                {lastPrompt()}
              </span>
            </Show>
          </span>
        </button>
      )}
    />
  )
}
