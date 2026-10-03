import { createEffect, createMemo, onCleanup, untrack } from "solid-js"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"
import { CommentaryAudio } from "@/utils/commentary-audio"
import { dismissToast, showToast } from "@/utils/toast"
import { authTokenFromCredentials } from "@/utils/server"

/**
 * FU-122: speaks new commentary lines for the foregrounded session.
 *
 * This lives in the session view rather than in the commentary panel on purpose. The panel unmounts when
 * you close it, and audio has to keep going; the store the SSE reducer writes does not. It is also what
 * makes "only the foregrounded tab" free: a tab that is not foregrounded holds no lease, so nothing arrives
 * here for it to speak.
 *
 * The queue itself is `CommentaryAudio` — a single `Audio` element, a gap measured from the previous clip's
 * end, and a per-session high-water mark so a panel remount never replays history. That module owns all the
 * hard parts; this file only decides *when* to offer it a line and when to shut up.
 */
export function CommentaryAudioPlayer(props: { sessionID: string | undefined }) {
  const layout = useLayout()
  const language = useLanguage()
  const server = useServer()
  const sync = useSync()

  const settings = () => layout.commentary
  const audioOn = createMemo(() => settings().enabled() && settings().audioEnabled())

  // s095: the "your browser wants a tap" prompt. One toast at a time, and it outlives a slow reader because
  // the line behind it is parked until they do: a prompt that timed out first would be a line nobody hears.
  let blockedToast: number | undefined
  const clearBlocked = () => {
    if (blockedToast === undefined) return
    dismissToast(blockedToast)
    blockedToast = undefined
  }

  console.log(`[audio] player created for session=${props.sessionID}`)
  const player = new CommentaryAudio({
    // The audio route is per-session, so the player has to know which one it is speaking for.
    sessionID: () => props.sessionID,
    // The route is authenticated like any other: without these it answers 401 and the line is never spoken.
    // The token is read lazily so a server switch is picked up.
    headers: (): Record<string, string> => {
      const http = server.current?.http
      if (!http?.password) return {}
      return {
        Authorization: `Basic ${authTokenFromCredentials({ username: http.username, password: http.password })}`,
      }
    },
    onError: (message) => showToast({ variant: "error", title: message }),
    // The button's own `onClick` IS the gesture, which is the only place a `play()` counts. It is also the
    // moment to wake the audio session, so this one tap covers the silent switch as well as the block.
    onGestureRequired: () => {
      clearBlocked()
      blockedToast = showToast({
        title: language.t("session.commentary.audioBlocked.title"),
        description: language.t("session.commentary.audioBlocked.description"),
        persistent: true,
        actions: [
          {
            label: language.t("session.commentary.audioBlocked.action"),
            onClick: () => {
              clearBlocked()
              player.resume()
            },
          },
        ],
      })
    },
  })

  const sessionID = createMemo(() => props.sessionID)

  console.log(`[audio] player mounted session=${props.sessionID} enabled=${settings().enabled()} audioEnabled=${settings().audioEnabled()}`)

  // Adopt the history ONCE, when audio is switched on for this session. Doing this reactively swallowed
  // the first real line: the baseline effect re-ran on the same tick the line arrived, marked it seen, and
  // the enqueue effect then correctly refused it.
  createEffect(() => {
    const id = sessionID()
    if (!id) return
    if (!audioOn()) return
    untrack(() => {
      const all = sync().data.commentary[id] ?? []
      console.log(`[audio] baseline: ${all.length} stored line(s), marking newest as seen`)
      const newest = all.at(-1)
      if (newest) {
        player.markSeen(id, newest.seq)
        console.log(`[audio] baseline: marked seq=${newest.seq} seen (history, will not be spoken)`)
      }
    })
  })

  createEffect(() => {
    const id = sessionID()
    const on = audioOn()
    if (!id || !on) return
    const all = sync().data.commentary[id] ?? []
    const newest = all.at(-1)
    console.log(`[audio] store changed: ${all.length} line(s), newest seq=${newest?.seq ?? "none"}`)
    if (!newest) return
    player.enqueue({ sessionID: id, seq: newest.seq, text: newest.text, audio: newest.audio })
  })

  // Turning audio off, or losing the foreground, must silence an in-flight clip rather than let it finish in
  // a tab nobody is looking at.
  createEffect(() => {
    console.log(`[audio] audio toggle is now ${audioOn() ? "ON" : "OFF"}`)
    // The prompt goes with it: a "tap to hear this" toast for a reader who just turned the sound off is a lie.
    if (!audioOn()) {
      player.stop()
      clearBlocked()
    }
  })
  onCleanup(() => {
    player.stop()
    clearBlocked()
  })

  return null
}
