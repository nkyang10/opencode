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
 *   from browser cache and never re-spoken.
 * - **The audio is played, not synthesized.** The server rendered it when the line was written and addressed
 *   it by content hash, so this module only fetches `GET /session/{id}/commentary/audio/<hash>`. It never
 *   chooses a host and never talks to a speech service: there is nothing here to steer.
 */

/** Silence between clips, measured from the previous clip ending. */
export const DEFAULT_GAP_MS = 400

export type SpeechOptions = {
  gapMs?: number
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  /** The session whose stored audio is being played. */
  sessionID?: () => string | undefined
  /**
   * Auth headers for the audio route. It is a normal authenticated route, so a browser call without them
   * comes back 401 — the same credential every other fetch in the app already sends.
   */
  headers?: () => Record<string, string>
  /** Injected in tests; defaults to a real `Audio`. */
  createAudio?: () => HTMLAudioElement
  now?: () => number
  onError?: (message: string) => void
}

export type CommentaryClip = { sessionID: string; seq: number; text: string; audio?: string }

/**
 * Decode the proxy's base64 payload into a Blob the `Audio` element can play. Done by hand rather than via
 * `atob` + `Uint8Array` gymnastics because a byte array is what the Blob needs and the base64 may carry
 * characters `atob` would need padding for.
 */
export function audioBlobFromBase64(encoded: string) {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: "audio/mpeg" })
}

export class CommentaryAudio {
  private readonly queue: CommentaryClip[] = []
  private readonly spoken = new Map<string, number>()
  private readonly complained = new Set<number>()
  private audio: HTMLAudioElement | undefined
  private playing = false
  private lastEndedAt = 0
  private gapTimer: ReturnType<typeof setTimeout> | undefined
  private readonly gapMs: number
  private readonly doFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  private readonly createAudio: () => HTMLAudioElement
  private readonly now: () => number
  private readonly onError: ((message: string) => void) | undefined
  private readonly sessionID: () => string | undefined
  private readonly extraHeaders: () => Record<string, string>

  constructor(options: SpeechOptions = {}) {
    this.gapMs = options.gapMs ?? DEFAULT_GAP_MS
    // Called as a free function, never as `this.doFetch(...)`. Storing `globalThis.fetch` in a field and
    // invoking it as a method makes `this` the player, and Chrome rejects that with
    // "TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation" — the request never leaves the
    // page, and every test that injects a fake fetch is blind to it because a plain function does not care
    // what `this` is. Wrapping keeps the injectable seam for tests and a correct call in production.
    this.doFetch = options.fetch ?? ((input, init) => fetch(input, init))
    this.createAudio =
      options.createAudio ??
      (() => {
        const element = new Audio()
        element.preload = "auto"
        return element
      })
    this.now = options.now ?? (() => Date.now())
    this.onError = options.onError
    this.sessionID = options.sessionID ?? (() => undefined)
    this.extraHeaders = options.headers ?? (() => ({}))
  }

  /** True when this session's history has never been seen, i.e. the next entry is genuinely new. */
  private isNew(clip: CommentaryClip) {
    const mark = this.spoken.get(clip.sessionID)
    return mark === undefined || clip.seq > mark
  }

  /**
   * Offer a line. Returns whether it was accepted, which is what lets a caller assert "only new" without
   * reaching into the queue.
   *
   * The high-water mark is advanced only when a line actually has audio. A line arrives as text first and is
   * republished with its audio hash a moment later; if the text-only pass consumed the seq, the audio pass
   * would be refused as "history" and the line would never be spoken. A text-only line still gets enqueued
   * (and skipped in `pump`), but it must not eat the slot its own audio is about to fill.
   */
  enqueue(clip: CommentaryClip) {
    const mark = this.spoken.get(clip.sessionID)
    const fresh = this.isNew(clip)
    console.log(
      `[audio] enqueue seq=${clip.seq} audio=${clip.audio ?? "none"} mark=${mark ?? "none"} fresh=${fresh}`,
    )
    if (!clip.text.trim()) {
      console.log(`[audio] enqueue seq=${clip.seq} REJECTED: empty text`)
      return false
    }
    if (!fresh) {
      console.log(`[audio] enqueue seq=${clip.seq} REJECTED: not newer than the high-water mark`)
      return false
    }
    if (clip.audio) this.spoken.set(clip.sessionID, clip.seq)
    this.queue.push(clip)
    console.log(`[audio] enqueue seq=${clip.seq} ACCEPTED, queue=${this.queue.length}`)
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

  /**
   * Fetch the audio the server already rendered for this line. The hash is content-addressed, so the bytes
   * for this URL never change — hence `no-store` rather than an expiry the server could get wrong, and
   * `no-store` wins over the route's own `immutable` hint for the same reason.
   */
  private fetchAudio(hash: string) {
    const id = this.sessionID()
    if (!id) return Promise.resolve(new Response("no session", { status: 400 }))
    const url = `/session/${id}/commentary/audio/${hash}`
    console.log(`[audio] FETCH ${url}`)
    return this.doFetch(url, {
      headers: this.extraHeaders(),
      // The route is authenticated, and this app has two login modes: the SDK holds Basic credentials, or
      // the browser holds a session cookie from /login. `same-origin` is the default and does send the
      // cookie, but saying it keeps the credential story readable instead of accidental.
      credentials: "include",
      cache: "no-store",
    })
  }

  private async pump(ignoreGap = false): Promise<void> {
    if (this.playing) {
      if (this.queue.length > 0) console.log(`[audio] pump: busy, ${this.queue.length} waiting`)
      return
    }
    if (this.queue.length === 0) return
    if (!ignoreGap && this.now() - this.lastEndedAt < this.gapMs) {
      console.log(
        `[audio] pump: inside the gap, ${this.gapMs - (this.now() - this.lastEndedAt)}ms left for ${this.queue.length} clip(s)`,
      )
      // Arriving inside the gap must not strand the line: nothing else would re-pump it, because the
      // previous clip has already finished and scheduled nothing. Retry when the gap elapses.
      this.scheduleNext()
      return
    }

    const clip = this.queue.shift()!
    this.playing = true
    let url: string | undefined
    console.log(`[audio] pump: taking seq=${clip.seq} audio=${clip.audio ?? "none"}`)
    try {
      // A line with no stored audio is a line the server could not speak. It is not an error to report —
      // the text is already on screen — so it is skipped silently and the queue moves on.
      if (!clip.audio) {
        console.log(`[audio] seq=${clip.seq} SKIPPED: the server rendered no audio for this line`)
        this.lastEndedAt = this.now()
        this.playing = false
        this.scheduleNext()
        return
      }
      const response = await this.fetchAudio(clip.audio)
      console.log(`[audio] FETCH returned ${response.status} for seq=${clip.seq}`)
      if (!response.ok) {
        const detail = await response.text().catch(() => "")
        console.error(
          `[audio] EXCEPTION: fetching audio for seq=${clip.seq} returned ${response.status}`,
          new Error(`audio route ${response.status}: ${detail || "(empty body)"}`),
        )
        this.complain(response.status, detail)
        // Returning from inside the try skips the code after the try/finally, so the queue has to be
        // released and rescheduled here or the next line is stranded forever behind a failed fetch.
        this.lastEndedAt = this.now()
        this.playing = false
        this.scheduleNext()
        return
      }
      const encoded = await response.json().catch(() => "")
      if (typeof encoded !== "string" || !encoded) {
        console.error(
          `[audio] EXCEPTION: seq=${clip.seq} route answered ${response.status} with no audio`,
          new Error(`audio route ${response.status}: payload was ${typeof encoded}, not a base64 string`),
        )
        this.complain(response.status, "audio route returned no audio")
        this.lastEndedAt = this.now()
        this.playing = false
        this.scheduleNext()
        return
      }
      const blob = audioBlobFromBase64(encoded)
      url = URL.createObjectURL(blob)
      console.log(`[audio] seq=${clip.seq} blob ${blob.size} bytes -> ${url}`)
      await this.play(url)
    } catch (error) {
      console.error(
        `[audio] EXCEPTION: pump failed for seq=${clip.seq}`,
        error instanceof Error ? error : new Error(String(error)),
      )
      this.complain(0, error instanceof Error ? error.message : String(error))
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
   * Every clip is a different file, so suppressing per clip would mean a toast per line. The condition is
   * what repeats — audio is unavailable — not the file, so the key is the status alone and the first message
   * carries the detail.
   */
  private complain(status: number, detail: string) {
    if (this.complained.has(status)) return
    this.complained.add(status)
    this.onError?.(status === 404 ? `Speech: ${detail || "audio is missing"}` : `Speech: request failed (${status})`)
  }

  private play(url: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const element = this.createAudio()
      this.audio = element
      // `play()` resolving only means the browser accepted the request. If the media never loads, that
      // promise has already settled and nothing else will ever report a problem — which is exactly how a
      // Content Security Policy block turned into a completely silent feature.
      let watchdog: ReturnType<typeof setTimeout> | undefined
      const done = () => {
        if (watchdog) clearTimeout(watchdog)
        this.lastEndedAt = this.now()
        this.release()
        // The gap is measured from the end, so the next clip cannot start yet. Without this timer the
        // queue would sit idle until the *next* line arrived — a queued line that never plays.
        this.scheduleNext()
        resolve()
      }
      element.onended = () => {
        console.log(`[audio] onended after ${element.duration?.toFixed(2)}s`)
        done()
      }
      element.onerror = () => {
        const code = element.error?.code
        const meaning =
          code === 3
            ? "MEDIA_ERR_DECODE — the bytes are not decodable audio"
            : code === 4
              ? "MEDIA_ERR_SRC_NOT_SUPPORTED — the browser refused the source (a CSP block on blob: looks like this)"
              : `media error code ${code ?? "unknown"}`
        console.error(`[audio] EXCEPTION: media element failed — ${meaning}`, element.error ?? "")
        this.complain(0, "playback failed")
        done()
      }
      element.addEventListener("loadedmetadata", () =>
        console.log(`[audio] loadedmetadata duration=${element.duration?.toFixed(2)}s`),
      )
      element.addEventListener("canplay", () => {
        console.log(`[audio] canplay — the media actually loaded`)
        clearTimeout(watchdog)
      })
      element.addEventListener("stalled", () => console.log(`[audio] stalled`))
      // `play()` resolving only means the browser accepted the request. If the media never loads, the promise
      // has already settled and nothing else will ever report a problem — which is exactly how a Content
      // Security Policy block produced a completely silent feature.
      watchdog = setTimeout(() => {
        if (element.readyState < 2) {
          console.error(
            `[audio] EXCEPTION: play() was accepted but the media never loaded (readyState=${element.readyState}, networkState=${element.networkState})`,
            new Error(
              `audio never loaded: readyState ${element.readyState}, networkState ${element.networkState}. If the source is a blob: URL this is a Content Security Policy block on media-src.`,
            ),
          )
        }
      }, 8000)
      element.src = url
      console.log(`[audio] play() called`)
      const started = element.play()
      // Autoplay rejection lands here. Releasing the lock is the whole point: leaving `playing` set would
      // wedge the queue with no visible symptom.
      if (started && typeof started.then === "function") {
        started.then(
          () =>
            console.log(
              `[audio] play() accepted — waiting for the media itself (this is where a blob: CSP block shows up)`,
            ),
          (error: unknown) =>
            console.log(`[audio] play() REJECTED: ${error instanceof Error ? error.message : String(error)}`),
        )
        started.catch(() => {
          this.complain(0, "autoplay blocked — click the page once to allow sound")
          done()
        })
      }
    })
  }
}
