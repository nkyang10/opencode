import { createEffect, createMemo, onCleanup, untrack } from "solid-js"
import { useLayout } from "@/context/layout"
import { useSync } from "@/context/sync"
import { CommentaryAudio } from "@/utils/commentary-audio"
import { showToast } from "@/utils/toast"

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
  const sync = useSync()

  const settings = () => layout.commentary
  const audioOn = createMemo(() => settings().enabled() && settings().audioEnabled())

  // Read lazily so editing the host or voice in Settings applies to the next line, without rebuilding the
  // player and losing its queue and its high-water mark.
  const player = new CommentaryAudio({
    host: () => settings().audioHost(),
    voice: () => settings().audioVoice(),
    onError: (message) => showToast({ variant: "error", title: message }),
  })

  const sessionID = createMemo(() => props.sessionID)

  // Adopt the history ONCE, when audio is switched on for this session. Doing this reactively swallowed
  // the first real line: the baseline effect re-ran on the same tick the line arrived, marked it seen, and
  // the enqueue effect then correctly refused it.
  createEffect(() => {
    const id = sessionID()
    if (!id) return
    if (!audioOn()) return
    untrack(() => {
      const newest = (sync().data.commentary[id] ?? []).at(-1)
      if (newest) player.markSeen(id, newest.seq)
    })
  })

  createEffect(() => {
    const id = sessionID()
    if (!id || !audioOn()) return
    const newest = (sync().data.commentary[id] ?? []).at(-1)
    if (!newest) return
    // `enqueue` refuses anything at or below the high-water mark, so this fires once per new line.
    player.enqueue({ sessionID: id, seq: newest.seq, text: newest.text })
  })

  // Turning audio off, or losing the foreground, must silence an in-flight clip rather than let it finish in
  // a tab nobody is looking at.
  createEffect(() => {
    if (!audioOn()) player.stop()
  })
  onCleanup(() => player.stop())

  return null
}
