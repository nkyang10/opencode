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
 * - **Mobile** — the narration is a tab, and a phone cannot show the tab and the chat at once. Tapping
 *   back to the chat would therefore stop the narration, which is the opposite of what someone reading a
 *   transcript on their phone wants. So the user's first visit to the tab latches it for the rest of the
 *   page visit: they can read the conversation and the lines keep accumulating.
 *
 * `enabled` is the Settings switch, and it is checked first because it is the only input that can be false
 * while the panel is open. It is a real off switch rather than a hidden button: the server narrates only
 * while some client holds a lease, so never asking is the same as not spending anything.
 *
 * The latch is deliberately NOT persisted (it lives in the non-persisted `sessionViewState`), otherwise
 * every session you ever opened would narrate forever — the cost that the latch exists to avoid.
 *
 * Pure and exported so the whole policy is unit-testable; `packages/app` has no `.test.tsx`.
 */
export function commentaryShouldWatch(input: {
  isDesktop: boolean
  panelOpened: boolean
  latched: boolean
  enabled: boolean
}): boolean {
  if (!input.enabled) return false
  return input.isDesktop ? input.panelOpened : input.latched
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
  /** The reader's narration preferences, re-sent on every heartbeat so an edit applies on the next tick. */
  instructions: Accessor<string>
}) {
  let heartbeat: number | undefined
  let held = false

  const call = (watching: boolean, instructions?: string) => {
    const id = input.sessionID()
    const base = input.http()
    if (!id || !base) return
    void setCommentaryWatch({ server: base, sessionID: id, watching, instructions })
  }

  createEffect(() => {
    // Deliberately read the session, the server, the switch and the instructions here too: a lease is per
    // session and per server, and the instructions travel with it, so changing any of them re-takes it.
    const id = input.sessionID()
    const base = input.http()
    const watching = !!id && !!base && input.enabled() && input.watching()
    const instructions = input.instructions()

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
