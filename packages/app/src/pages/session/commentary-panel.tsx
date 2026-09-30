import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { Icon } from "@opencode-ai/ui/icon"
import type { SessionCommentaryEvent } from "@opencode-ai/schema/session-commentary-event"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { fetchCommentary } from "@/utils/server"
import { getRelativeTime } from "@/utils/time"

/**
 * FE-028: the live narration of what the agent is doing. Entries are written by the server
 * (`SessionCommentary`) and arrive over SSE; the initial paint comes from `GET /session/{id}/commentary`.
 *
 * This component is presentational. It used to own the lease itself — take it on mount, release on
 * unmount — which was right on desktop where this column *is* the watch signal, but wrong on mobile where
 * the panel is a tab: tapping back to the chat would have stopped the narration. The lease now belongs to
 * the session view via `createCommentaryWatch`, so the same component renders unchanged in both places.
 */
/** Newest entries drawn. The store keeps everything the server sent; this only bounds the DOM. */
const RENDERED_ENTRIES = 200

export function CommentaryPanel(props: { sessionID: string | undefined }) {
  const language = useLanguage()
  const server = useServer()
  const sync = useSync()
  let scroller: HTMLDivElement | undefined
  let atBottom = true

  // The sync store is written only by the event reducer, so the initial paint is kept here and merged with
  // whatever arrived over SSE. Entries are numbered per session, so merging on `seq` is exact and a line
  // that arrives live and is also in the initial payload is not shown twice.
  const [initial, setInitial] = createSignal<SessionCommentaryEvent.Entry[]>([])

  const sessionID = createMemo(() => props.sessionID)
  // The list is append-only, so an all-day session would otherwise put every line ever written into the DOM
  // at once. Only the newest RENDERED entries are drawn — the server keeps a longer history, and the count in
  // the header still reflects everything held, so a truncated scroll never looks like data loss.
  const entries = createMemo(() => {
    const id = sessionID()
    if (!id) return []
    const live = sync().data.commentary[id] ?? []
    if (initial().length === 0) return live.length > RENDERED_ENTRIES ? live.slice(-RENDERED_ENTRIES) : live
    const seen = new Set<number>()
    const merged = [...initial(), ...live]
      .filter((entry) => {
        if (seen.has(entry.seq)) return false
        seen.add(entry.seq)
        return true
      })
      .sort((a, b) => a.seq - b.seq)
    return merged.length > RENDERED_ENTRIES ? merged.slice(-RENDERED_ENTRIES) : merged
  })
  const total = createMemo(() => {
    const id = sessionID()
    if (!id) return 0
    return Math.max(initial().length, sync().data.commentary[id]?.length ?? 0)
  })
  const working = createMemo(() => (sessionID() ? sync().data.session_working(sessionID()!) : false))

  const http = createMemo(() => server.current?.http)

  const onScroll = () => {
    const el = scroller
    if (!el) return
    // Only auto-scroll when the reader is already at the bottom: yanking the view while someone has
    // scrolled up to re-read an earlier line is the fastest way to make a narration unreadable.
    atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  // The initial paint only. The lease is owned by the session view (see `commentary-watch.ts`), so this
  // component can be mounted and unmounted freely without ever stopping the narration.
  createEffect(() => {
    const id = sessionID()
    const base = http()
    if (!id || !base) return
    setInitial([])
    void fetchCommentary({ server: base, sessionID: id, limit: 50 }).then((rows) => {
      if (rows.length > 0) setInitial(rows)
    })
  })

  createEffect(() => {
    entries().length
    if (!atBottom) return
    queueMicrotask(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight
    })
  })

  return (
    <div class="size-full min-w-0 h-full flex flex-col">
      <div class="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-border-weaker-base">
        <Icon size="small" name="commentary" class="text-icon-weak" />
        <div class="text-12-medium text-text-strong">{language.t("session.commentary.title")}</div>
        <Show when={total() > 0}>
          <div class="text-12-regular text-text-weak">{total()}</div>
        </Show>
      </div>

      <Show
        when={entries().length > 0}
        fallback={
          <div class="flex-1 flex flex-col items-center justify-center text-center gap-2 px-6">
            <Show
              when={working()}
              fallback={
                <>
                  <div class="text-12-medium text-text-weak">{language.t("session.commentary.empty")}</div>
                  <div class="text-12-regular text-text-weak">{language.t("session.commentary.empty.description")}</div>
                </>
              }
            >
              <div class="flex items-center gap-2 text-12-regular text-text-weak">
                <span class="size-1.5 rounded-full bg-icon-weak animate-pulse" />
                {language.t("session.commentary.waiting")}
              </div>
            </Show>
          </div>
        }
      >
        <div
          ref={(el: HTMLDivElement) => {
            scroller = el
            makeEventListener(el, "scroll", onScroll, { passive: true })
          }}
          data-slot="session-commentary-list"
          class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3 px-3 py-3"
        >
          <For each={entries()}>
            {(entry) => (
              <div data-slot="session-commentary-entry" class="flex flex-col gap-0.5">
                <div class="text-10-regular text-text-weak">
                  {getRelativeTime(new Date(entry.time).toISOString(), language.t)}
                </div>
                <div class="text-12-regular text-text-strong">{entry.text}</div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
