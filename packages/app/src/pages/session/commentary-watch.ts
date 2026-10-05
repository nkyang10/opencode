import { createEffect, onCleanup, type Accessor } from "solid-js"
import { setCommentaryWatch } from "@/utils/server"
import type { ServerConnection } from "@/context/server"

/**
 * FU-028 / FU-111: who holds the commentary lease.
 *
 * The server narrates a session only while a client holds a lease, so this one predicate decides whether
 * the feature spends money. It differs by platform because "watching" means different things:
 *
 * - **Desktop** — the narration column is beside the chat, so being on screen *is* watching. The column's
 *   open state is the signal, exactly as before.
 * * **Mobile** — the narration is one of three tabs, and a phone cannot show it beside the chat, so which
 *   tab is selected says nothing about whether the reader wants the lines. Sitting in the chat therefore
 *   counts as watching (s097). The previous version made it conditional on a **latch** — the first tap of
 *   the Commentary tab, held for the page visit — which was right about the tab and wrong about the cost:
 *   the tap was the *only* affordance the feature had, so anyone who had not found that tab got no lease,
 *   no lines, no hint and nothing to show that the feature existed. The cost that latch was protecting
 *   against is bounded already by the two terms above it: one `enabled` switch the reader sets
 *   deliberately, and one lease per session actually in front of them (there is no keep-alive, so a second
 *   agent tab is not mounted and does not narrate).
 *
 * `enabled` is the narration switch, which DEC-062 moved into the panel header (it used to be a Settings
 * row), and it is checked first because it is the only input that can be false while the panel is open.
 * It is a real off switch rather than a hidden button: the server narrates only
 * while some client holds a lease, so never asking is the same as not spending anything.
 *
 * `foregrounded` is FU-122's addition, and it is the one that changes what the lease MEANS. Audio is only
 * wanted from the tab you are actually looking at, and a backgrounded tab that kept its lease would go on
 * paying to narrate into the void — and, with two tabs open, their audio would interleave. So the same
 * predicate now governs both spending and speaking, which is the only way to stop those two drifting apart:
 * there is exactly one answer to "should this session be narrating right now".
 *
 * The latch that used to sit here is gone rather than kept as a spare input: with the mobile rule reduced to
 * "the three-tab layout is up", there is no state left for it to hold, and a field that no longer decides
 * anything is a second answer to the same question.
 *
 * Pure and exported so the whole policy is unit-testable; `packages/app` has no `.test.tsx`.
 */
export function commentaryShouldWatch(input: {
  isDesktop: boolean
  panelOpened: boolean
  enabled: boolean
  foregrounded: boolean
}): boolean {
  if (!input.enabled) return false
  // A hidden window gets no lease: it cannot be read, and with audio on it must not be heard either.
  if (!input.foregrounded) return false
  return input.isDesktop ? input.panelOpened : true
}

const HEARTBEAT_MS = 15_000

/**
 * Owns the lease for one session view: takes it while `watching()` is true, refreshes it on a heartbeat
 * shorter than the server's lease TTL, and releases it the moment watching stops, on unmount and on
 * `pagehide`. A tab that closes without releasing is dropped when the TTL expires, but releasing is what
 * stops a phone narrating in the background, so it is done explicitly.
 */
export function createCommentaryWatch(input: {
  sessionID: Accessor<string | undefined>
  http: Accessor<ServerConnection.HttpBase | undefined>
  watching: Accessor<boolean>
  /** The Settings switch. False means this device never holds a lease. */
  enabled: Accessor<boolean>
  /** Whether this document is visible. A hidden tab holds no lease (FU-122). */
  foregrounded: Accessor<boolean>
  /** The reader's narration preferences, re-sent on every heartbeat so an edit applies on the next tick. */
  instructions: Accessor<string>
  /**
   * The fixed closing phrase in the web UI's current language. Read on every heartbeat too, so switching the
   * UI language changes what the agent says when it finishes without a restart.
   */
  closing: Accessor<string>
  /**
   * s090: the voice the reader picked and the endpoint that owns it. Both undefined until a voice is chosen,
   * in which case the server's config decides — which is what every client sent before the picker existed.
   */
  voice: Accessor<string | undefined>
  host: Accessor<string | undefined>
}) {
  let heartbeat: number | undefined
  let held = false

  const call = (watching: boolean, instructions?: string) => {
    const id = input.sessionID()
    const base = input.http()
    if (!id || !base) return
    void setCommentaryWatch({
      server: base,
      sessionID: id,
      watching,
      instructions,
      closing: input.closing(),
      voice: input.voice(),
      host: input.host(),
    })
  }

  createEffect(() => {
    // Deliberately read the session, the server, the switch and the instructions here too: a lease is per
    // session and per server, and the instructions travel with it, so changing any of them re-takes it.
    const id = input.sessionID()
    const base = input.http()
    const watching = !!id && !!base && input.enabled() && input.foregrounded() && input.watching()
    const instructions = input.instructions()
    // Read here as well so a language change re-takes the lease with the new phrase.
    input.closing()
    // And the voice, so picking one in the panel header takes effect on the very next line rather than at the
    // next heartbeat. This is the whole of "active immediately": the lease is the only channel the server
    // reads a preference from, so re-taking it is the update. Read as bare statements purely to depend on them.
    input.voice()
    input.host()

    // Hand the lease back rather than waiting for the TTL. Without this the heartbeat from the previous
    // run kept refreshing a lease nobody was watching, so closing the panel or switching commentary off
    // would have kept the narration running for as long as the tab stayed open.
    if (!watching) {
      if (held) {
        call(false)
        held = false
        if (heartbeat !== undefined) window.clearInterval(heartbeat)
        heartbeat = undefined
      }
      return
    }

    call(true, instructions)
    held = true
    if (heartbeat !== undefined) window.clearInterval(heartbeat)
    heartbeat = window.setInterval(() => call(true, instructions), HEARTBEAT_MS)
  })

  onCleanup(() => {
    if (heartbeat !== undefined) window.clearInterval(heartbeat)
    call(false)
  })

  // `pagehide` is the one event that fires reliably on mobile when a tab is backgrounded or closed; a
  // fetch in flight is not guaranteed to complete, and the TTL would otherwise keep narrating.
  if (typeof window !== "undefined") {
    const release = () => call(false)
    window.addEventListener("pagehide", release)
    onCleanup(() => window.removeEventListener("pagehide", release))
  }

  return { release: () => call(false) }
}
