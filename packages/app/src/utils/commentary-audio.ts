/**
 * FE-029 / FU-122: speaking the commentary aloud.
 *
 * Plain TypeScript on purpose — this owns an `Audio` element and timers and has no reactive state, and
 * `packages/app` has no `.test.tsx`, so keeping the decision logic pure is what makes it testable at all.
 *
 * The rules it exists to enforce, in the order they bit us:
 *
 * - **Only new lines.** The store is re-populated with history whenever a panel mounts, so "play the list"
 *   would read the whole session aloud on every open. A per-session high-water mark on the monotonic `seq`
 *   is enough and cannot leak: it is seeded from the first entry seen, so a remount is silent.
 * - **Never overlap.** One `Audio` element, and `pump()` refuses to start anything while it is playing. The
 *   "no overlap" requirement is therefore mechanical rather than a timing hope.
 * - **A gap between clips**, measured from the previous clip's `ended` — not from when it was requested, so
 *   a slow fetch cannot eat it.
 * - **A rejected `play()` must release the lock.** Browsers block autoplay until the user has interacted
 *   with the page; if that rejection left the queue "playing" it would wedge silently forever. This is the
 *   single most likely first-run failure, so it is handled explicitly and tested.
 * - **No cache.** Every line is fetched fresh and the object URL is revoked, so a line is never replayed
 *   from disk and never re-spoken.
 */

export const DEFAULT_TTS_HOST = "192.168.1.162:8880"
export const DEFAULT_TTS_VOICE = "cantonese"
/** Silence between clips, measured from the previous clip ending. */
export const DEFAULT_GAP_MS = 400

export type SpeechOptions = {
  /**
   * `host:port`, exactly as the user supplies it. Rendered into `http://<host>/v1/audio/speech`. Accepted
   * as a function so an edit in Settings applies to the next line without rebuilding the player and losing
   * its queue and high-water mark.
   */
  host?: string | (() => string)
  voice?: string | (() => string)
  gapMs?: number
  fetch?: typeof globalThis.fetch
  /** Injected in tests; defaults to a real `Audio`. */
  createAudio?: () => HTMLAudioElement
  now?: () => number
  onError?: (message: string) => void
}

export type CommentaryClip = { sessionID: string; seq: number; text: string }

export function speechUrl(host: string) {
  const trimmed = host.trim().replace(/\/+$/, "")
  // A bare host:port is what the user configures; adding a scheme here would be the single most likely
  // misconfiguration, so it is defaulted rather than left to the user to type correctly.
  const base = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  return `${base}/v1/audio/speech`
}

export class CommentaryAudio {
  private readonly queue: CommentaryClip[] = []
  private readonly spoken = new Map<string, number>()
  private readonly complained = new Set<string>()
  private audio: HTMLAudioElement | undefined
  private playing = false
  private lastEndedAt = 0
  private gapTimer: ReturnType<typeof setTimeout> | undefined
  private readonly readHost: () => string
  private readonly readVoice: () => string
  private readonly gapMs: number
  private readonly doFetch: typeof globalThis.fetch
  private readonly createAudio: () => HTMLAudioElement
  private readonly now: () => number
  private readonly onError: ((message: string) => void) | undefined

  constructor(options: SpeechOptions = {}) {
    const resolve = (input: string | (() => string) | undefined, fallback: string) =>
      ((typeof input === "function" ? input() : input)?.trim() || fallback)
    this.readHost = () => resolve(options.host, DEFAULT_TTS_HOST)
    this.readVoice = () => resolve(options.voice, DEFAULT_TTS_VOICE)
    this.gapMs = options.gapMs ?? DEFAULT_GAP_MS
    this.doFetch = options.fetch ?? globalThis.fetch
    this.createAudio =
      options.createAudio ??
      (() => {
        const element = new Audio()
        element.preload = "auto"
        return element
      })
    this.now = options.now ?? (() => Date.now())
    this.onError = options.onError
  }

  /** True when this session's history has never been seen, i.e. the next entry is genuinely new. */
  private isNew(clip: CommentaryClip) {
    const mark = this.spoken.get(clip.sessionID)
    return mark === undefined || clip.seq > mark
  }

  /**
   * Offer a line. Returns whether it was accepted, which is what lets a caller assert "only new" without
   * reaching into the queue.
   */
  enqueue(clip: CommentaryClip) {
    if (!clip.text.trim()) return false
    if (!this.isNew(clip)) return false
    this.spoken.set(clip.sessionID, clip.seq)
    this.queue.push(clip)
    void this.pump()
    return true
  }

  /** Adopt the newest seq already in the store without speaking it — used when a panel loads history. */
  markSeen(sessionID: string, seq: number) {
    const mark = this.spoken.get(sessionID)
    if (mark === undefined || seq > mark) this.spoken.set(sessionID, seq)
  }

  get pending() {
    return this.queue.length
  }

  get isPlaying() {
    return this.playing
  }

  /** Drop anything queued and release the element. Used when audio is switched off or the tab is hidden. */
  stop() {
    this.queue.length = 0
    if (this.gapTimer !== undefined) {
      clearTimeout(this.gapTimer)
      this.gapTimer = undefined
    }
    if (this.audio) {
      this.audio.pause()
      this.release()
    }
  }

  private release() {
    this.playing = false
    if (this.audio) {
      this.audio.src = ""
      this.audio = undefined
    }
  }

  private async pump(ignoreGap = false): Promise<void> {
    if (this.playing) return
    if (this.queue.length === 0) return
    if (!ignoreGap && this.now() - this.lastEndedAt < this.gapMs) {
      // Arriving inside the gap must not strand the line: nothing else would re-pump it, because the
      // previous clip has already finished and scheduled nothing. Retry when the gap elapses.
      this.scheduleNext()
      return
    }

    const clip = this.queue.shift()!
    this.playing = true
    let url: string | undefined
    // Read once per clip so the request, the error message and the suppression key all name the same voice.
    const voice = this.readVoice()
    try {
      const response = await this.doFetch(speechUrl(this.readHost()), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: clip.text, voice }),
        // No cache, in the explicit sense the user asked for: a line is fetched once and played once.
        cache: "no-store",
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => "")
        this.complain(response.status, detail, voice)
        // Returning from inside the try skips the code after the try/finally, so the queue has to be
        // released and rescheduled here or the next line is stranded forever behind a failed fetch.
        this.lastEndedAt = this.now()
        this.playing = false
        this.scheduleNext()
        return
      }
      const blob = await response.blob()
      url = URL.createObjectURL(blob)
      await this.play(url, voice)
    } catch (error) {
      this.complain(0, error instanceof Error ? error.message : String(error), voice)
      // Only a clip that never reached `done()` (a failed fetch) needs stamping here; `done()` already
      // stamped it, and overwriting it would restart the gap and stall a clock that has not moved on.
      if (this.audio) this.lastEndedAt = this.now()
    } finally {
      if (url) URL.revokeObjectURL(url)
      if (!this.audio) this.playing = false
    }
    this.scheduleNext()
  }

  /** Re-pump after the remaining gap. Cleared by `stop()` so a disabled queue cannot resurrect itself. */
  private scheduleNext() {
    if (this.gapTimer !== undefined) clearTimeout(this.gapTimer)
    if (this.queue.length === 0) return
    const wait = Math.max(0, this.gapMs - (this.now() - this.lastEndedAt))
    this.gapTimer = setTimeout(() => {
      this.gapTimer = undefined
      // The gap was measured when the timer was scheduled, so it does not need measuring twice.
      void this.pump(true)
    }, wait)
  }

  /**
   * One bad voice would otherwise raise a toast every ten seconds, so each distinct failure is reported once
   * and then suppressed for the life of this instance.
   */
  private complain(status: number, detail: string, voice: string) {
    const key = `${status}:${voice}`
    if (this.complained.has(key)) return
    this.complained.add(key)
    this.onError?.(status === 400 ? `Speech: ${detail || "voice rejected"}` : `Speech: request failed (${status})`)
  }

  private play(url: string, voice: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const element = this.createAudio()
      this.audio = element
      const done = () => {
        this.lastEndedAt = this.now()
        this.release()
        // The gap is measured from the end, so the next clip cannot start yet. Without this timer the
        // queue would sit idle until the *next* line arrived — a queued line that never plays.
        this.scheduleNext()
        resolve()
      }
      element.onended = done
      element.onerror = () => {
        this.complain(0, "playback failed", voice)
        done()
      }
      element.src = url
      const started = element.play()
      // Autoplay rejection lands here. Releasing the lock is the whole point: leaving `playing` set would
      // wedge the queue with no visible symptom.
      if (started && typeof started.catch === "function") {
        started.catch(() => {
          this.complain(0, "autoplay blocked — click the page once to allow sound", voice)
          done()
        })
      }
    })
  }
}
