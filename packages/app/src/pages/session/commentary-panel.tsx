import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { Icon } from "@opencode-ai/ui/icon"
import type { SessionCommentaryEvent } from "@opencode-ai/schema/session-commentary-event"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { fetchCommentary, setCommentaryWatch } from "@/utils/server"
import { getRelativeTime } from "@/utils/time"

/**
 * FE-028: the live narration of what the agent is doing. Entries are written by the server
 * (`SessionCommentary`) and arrive over SSE; the initial paint comes from `GET /session/{id}/commentary`.
 *
 * Mounting this component is also what takes the lease: while it is on screen the server keeps a
 * narration running, and when it unmounts the lease expires within `LEASE_TTL_MS`. That is why the watch
 * heartbeat lives here rather than in the store — visibility of the panel *is* the signal.
 */
export function CommentaryPanel(props: { sessionID: string | undefined }) {
  const language = useLanguage()
  const server = useServer()
  const sync = useSync()
  let scroller: HTMLDivElement | undefined
  let heartbeat: number | undefined
  let atBottom = true

  // The sync store is written only by the event reducer, so the initial paint is kept here and merged with
  // whatever arrived over SSE. Entries are numbered per session, so merging on `seq` is exact and a line
  // that arrives live and is also in the initial payload is not shown twice.
  const [initial, setInitial] = createSignal<SessionCommentaryEvent.Entry[]>([])

  const sessionID = createMemo(() => props.sessionID)
  const entries = createMemo(() => {
    const id = sessionID()
    if (!id) return []
    const live = sync().data.commentary[id] ?? []
    if (initial().length === 0) return live
    const seen = new Set<number>()
    return [...initial(), ...live]
      .filter((entry) => {
        if (seen.has(entry.seq)) return false
        seen.add(entry.seq)
        return true
      })
      .sort((a, b) => a.seq - b.seq)
  })
  const working = createMemo(() => (sessionID() ? sync().data.session_working(sessionID()!) : false))

  const http = createMemo(() => server.current?.http)

  const watch = (watching: boolean) => {
    const id = sessionID()
    const base = http()
    if (!id || !base) return
    void setCommentaryWatch({ server: base, sessionID: id, watching })
  }

  const onScroll = () => {
    const el = scroller
    if (!el) return
    // Only auto-scroll when the reader is already at the bottom: yanking the view while someone has
    // scrolled up to re-read an earlier line is the fastest way to make a narration unreadable.
    atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  createEffect(() => {
    const id = sessionID()
    const base = http()
    if (!id || !base) return
    watch(true)
    // The initial paint; anything after this arrives over SSE.
    setInitial([])
    void fetchCommentary({ server: base, sessionID: id, limit: 50 }).then((rows) => {
      if (rows.length > 0) setInitial(rows)
    })
    // 15s heartbeat against a 45s lease: one dropped request (a sleeping phone, a tunnel hiccup) must not
    // end the narration, and the TTL is the backstop for a tab that closes without releasing.
    heartbeat = window.setInterval(() => watch(true), 15_000)
    onCleanup(() => {
      if (heartbeat !== undefined) window.clearInterval(heartbeat)
      watch(false)
      const release = () => watch(false)
      window.addEventListener("pagehide", release, { once: true })
      onCleanup(() => window.removeEventListener("pagehide", release))
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
        <Show when={entries().length > 0}>
          <div class="text-12-regular text-text-weak">{entries().length}</div>
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
