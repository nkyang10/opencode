import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Switch } from "@opencode-ai/ui/switch"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import type { SessionCommentaryEvent } from "@opencode-ai/schema/session-commentary-event"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { fetchCommentary, fetchCommentaryVoices } from "@/utils/server"
import { optionLabel, unavailableHosts, voiceKey, voiceOptions, type VoiceCatalogue } from "@/utils/commentary-voices"
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
/**
 * Newest entries drawn. The store keeps everything the server sent; this only bounds the DOM.
 *
 * 15 rather than "everything": the narration is a running commentary, not a transcript, and its value is the
 * last thing it said. 200 lines of scrollback is a wall nobody reads.
 */
const RENDERED_ENTRIES = 15


export function CommentaryPanel(props: { sessionID: string | undefined }) {
  const language = useLanguage()
  const server = useServer()
  const sync = useSync()
  // The spoken-narration toggle, moved here from Settings (FU-122). It reads the same store the audio player
  // reads, so there is still one switch rather than two that can disagree.
  const commentary = useLayout().commentary
  let scroller: HTMLDivElement | undefined
  let atBottom = true

  // The sync store is written only by the event reducer, so the initial paint is kept here and merged with
  // whatever arrived over SSE. Entries are numbered per session, so merging on `seq` is exact and a line
  // that arrives live and is also in the initial payload is not shown twice.
  const [initial, setInitial] = createSignal<SessionCommentaryEvent.Entry[]>([])

  const sessionID = createMemo(() => props.sessionID)
  // The list is append-only, so an all-day session would otherwise put every line ever written into the DOM
  // at once. Only the newest RENDERED entries are drawn — the server keeps a longer history, and the scroll is
  // never silently short: the newest line is always the one at the bottom.
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
  const working = createMemo(() => (sessionID() ? sync().data.session_working(sessionID()!) : false))

  // `getRelativeTime` is pure, so "2 minutes ago" is computed once and then frozen for as long as the panel
  // does not re-render — which, for a panel nobody is touching, is forever, and a stale timestamp is worse
  // than an absolute one. One signal bumped once a minute re-renders the timestamps and nothing else. It has
  // to live inside the component: at module scope `onCleanup` has no scope to bind to and the interval would
  // outlive every panel.
  const [clock, setClock] = createSignal(Date.now())
  const ticker = setInterval(() => setClock(Date.now()), 60_000)
  onCleanup(() => clearInterval(ticker))

  const http = createMemo(() => server.current?.http)

  /**
   * s090: the voice picker, in the title bar next to the on/off switch.
   *
   * The list is fetched, never hardcoded: 322 voices and 17 aliases are a translation and maintenance surface
   * that would rot the moment a service changed, and the services are not even the same build. The fetch goes
   * through the server because the speech box answers a browser preflight with `405`.
   *
   * `unavailable` is kept separately from "no voices" so a service that is restarting reads as a service that
   * is restarting, rather than as one that has nothing to say.
   */
  const [catalogue, setCatalogue] = createSignal<VoiceCatalogue>({ default: { host: "", voice: "" }, sources: [] })
  const [unavailable, setUnavailable] = createSignal<string[]>([])
  createEffect(() => {
    const id = sessionID()
    const base = http()
    if (!id || !base) return
    void fetchCommentaryVoices({ server: base, sessionID: id }).then((next) => {
      setCatalogue(next)
      setUnavailable(unavailableHosts(next.sources))
    })
  })
  const picked = createMemo(() => {
    const host = commentary.host()
    const voice = commentary.voice()
    if (host === undefined || voice === undefined) return undefined
    return { host, voice }
  })
  // With nothing picked the server's config decides, so the picker shows *that* rather than looking unset.
  const choices = createMemo(() => voiceOptions({ sources: catalogue().sources, picked: picked(), fallback: catalogue().default }))

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

  /**
   * Auto-scroll to the newest line — including on a refresh, where fifteen lines arrive in one paint and the
   * view would otherwise sit at the top showing the oldest of them.
   *
   * `requestAnimationFrame`, not `queueMicrotask`: a microtask runs before the browser has laid the new rows
   * out, so `scrollHeight` can still be the pre-insert height and the scroll lands short. A frame runs after
   * layout, and re-arming once catches content that grew between the two (a slow first paint of a hidden tab).
   */
  createEffect(() => {
    entries().length
    if (!atBottom) return
    let again = 0
    const scroll = () => {
      const el = scroller
      if (!el) return
      const previous = el.scrollHeight
      el.scrollTop = previous
      // A second frame only if the content actually grew since we last measured it.
      if (el.scrollHeight !== previous && again < 3) {
        again++
        requestAnimationFrame(scroll)
      }
    }
    requestAnimationFrame(scroll)
  })

  return (
    <div class="size-full min-w-0 h-full flex flex-col">
      <div class="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-border-weaker-base">
        <Icon size="small" name="commentary" class="text-icon-weak" />
        <div class="text-12-medium text-text-strong">{language.t("session.commentary.title")}</div>
        {/* Narration on/off lives here rather than in Settings, for the reason it always did: it is the one
            commentary control you reach for while reading, and it is the switch that says whether this session
            is being narrated at all. Off by default — it is not free, and a reader who never asked should not
            pay for it. */}
        <Switch
          hideLabel
          data-action="commentary-enabled"
          checked={commentary.enabled()}
          title={language.t("settings.general.commentary.row.enabled.title")}
          onChange={(checked) => commentary.setEnabled(checked)}
        >
          {language.t("settings.general.commentary.row.enabled.title")}
        </Switch>
        {/* Sound is a mute, not a second switch. It is a modifier on the narration above rather than a peer of
            it, and two switches side by side implied the pair were independent — they are not: with narration
            off there is nothing to hear. An icon says that better than a switch does. */}
        <IconButtonV2
          type="button"
          variant="ghost-muted"
          size="small"
          // A mute button has to be readable as a toggle, not only as a glyph: at 20px the two icons differ by
          // a small mark, so the pressed state is what makes the current value obvious without inspecting it.
          state={commentary.audioEnabled() ? "rest" : "pressed"}
          aria-pressed={commentary.audioEnabled()}
          data-action="commentary-audio-enabled"
          aria-label={language.t("settings.general.commentary.row.audioEnabled.title")}
          title={language.t("settings.general.commentary.row.audioEnabled.title")}
          // A getter, not a value: an element built here once would read the flag once and never flip.
          icon={() => <Icon name={commentary.audioEnabled() ? "commentary-audio-on" : "commentary-audio-off"} />}
          onClick={() => commentary.setAudioEnabled(!commentary.audioEnabled())}
        />
        {/* The voice, beside the switch rather than behind it. `groupBy` is the endpoint, because the same
            name on two services is two different recordings and a flat list of names would hide that. The
            label is the audio row's own string, so a header control adds no locale work. */}
        <Show when={choices().options.length > 0}>
          <div class="min-w-0 max-w-[190px]" data-action="commentary-voice-picker">
            <SelectV2
              appearance="inline"
              options={choices().options}
              current={choices().selected}
              // `voiceKey`, not a local template: this is the string Kobalte puts in a
              // `[data-key="…"]` selector unescaped, and a newline in it throws.
              value={(option) => voiceKey(option.host, option.voice)}
              // The human description first: "Chinese (Hong Kong SAR)" is findable and meaningful, while
              // `zh-HK-HiuMaanNeural` is neither. The technical name is still shown underneath so it can be
              // copied, and the filter matches both.
              label={(option) => optionLabel(option, catalogue().sources.length)}
              filterable
              filterPlaceholder={language.t("session.commentary.voiceFilter.placeholder")}
              filterTerms={(option) => [
                ...(option.description ? [option.description] : []),
                ...option.aliases,
              ]}
              groupBy={(option) => option.host}
              aria-label={language.t("settings.general.commentary.row.audioVoice.title")}
              onSelect={(option) => option && commentary.setSpeech({ host: option.host, voice: option.voice })}
            />
          </div>
        </Show>
        {/* One line, and only when an endpoint could not be asked. A service that is restarting is not the
            same as a service with nothing to say, and a picker that quietly dropped half its list would look
            like the second. */}
        <Show when={unavailable().length > 0}>
          <div class="text-10-regular text-text-weak truncate" title={unavailable().join(", ")}>
            {(() => {
              const hosts = unavailable()
              return hosts.length === 1
                ? language.t("session.commentary.voice.unavailable", { host: hosts[0] ?? "" })
                : language.t("session.commentary.voice.unavailableMany", { hosts: hosts.join(", ") })
            })()}
          </div>
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
              <div
                data-slot="session-commentary-entry"
                data-kind={entry.kind ?? "narration"}
                class="flex flex-col gap-0.5"
              >
                <div class="text-10-regular text-text-weak">
                  {(() => {
                    // Read the ticker so this row re-renders on the minute, and nothing else about it changes.
                    void clock()
                    return getRelativeTime(new Date(entry.time).toISOString(), language.t)
                  })()}
                </div>
                {entry.kind && (
                  // The two non-narration lines are told apart because one of them is a request to the reader,
                  // not a statement about the work — "Done" and "Needs you" should not look alike.
                  <div class="text-10-medium text-text-strong bg-surface-raised-base w-fit px-1.5 py-0.5 rounded">
                    {entry.kind === "closing"
                      ? language.t("session.commentary.kind.closing")
                      : language.t("session.commentary.kind.prompt")}
                  </div>
                )}
                <div class="text-12-regular text-text-strong">{entry.text}</div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}
