import { describe, expect, mock, test } from "bun:test"
import { CommentaryAudio, audioBlobFromBase64 } from "./commentary-audio"

/** A fake Audio whose playback is driven by the test, so `ended` and rejections are deterministic. */
class FakeAudio {
  static instances: FakeAudio[] = []
  onended: (() => void) | undefined
  onerror: (() => void) | undefined
  src = ""
  preload = ""
  paused = true
  private result: "ok" | "reject" = "ok"
  pause() {
    this.paused = true
  }
  play() {
    if (this.result === "reject") return Promise.reject(new Error("autoplay blocked"))
    this.paused = false
    return Promise.resolve()
  }
  /** Simulate the clip finishing. */
  finish() {
    this.paused = true
    this.onended?.()
  }
  rejectPlayback() {
    this.result = "reject"
  }
  constructor() {
    FakeAudio.instances.push(this)
  }
}

type FetchStub = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
const asFetch = (fn: FetchStub) => fn as unknown as typeof globalThis.fetch

const okResponse = () =>
  new Response(JSON.stringify(btoa("fake-mp3-bytes")), { status: 200, headers: { "content-type": "application/json" } })
const errorResponse = (status: number, body: string) => new Response(body, { status })

/** Every clip carries the hash the server pre-rendered for it; `noAudio` models a line the server could not speak. */
const hash = (seq: number) => seq.toString(16).padStart(32, "0")
/** A line the server rendered audio for. */
const clip = (seq: number, sessionID = "s1", text = `line ${seq}`, audio: string | undefined = hash(seq)) => ({
  sessionID,
  seq,
  text,
  ...(audio === undefined ? {} : { audio }),
})
/** A line the server could not synthesize: same shape the event carries, with no hash at all. */
const textOnly = (seq: number, sessionID = "s1", text = `line ${seq}`) => ({ sessionID, seq, text })

function setup(options: { fetch?: typeof globalThis.fetch; onError?: (m: string) => void; gapMs?: number } = {}) {
  FakeAudio.instances = []
  let clock = 1_000
  const audio = new CommentaryAudio({
    sessionID: () => "s1",
    fetch: options.fetch ?? asFetch(() => Promise.resolve(okResponse())),
    createAudio: () => new FakeAudio() as unknown as HTMLAudioElement,
    now: () => clock,
    gapMs: options.gapMs,
    onError: options.onError,
  })
  return { audio, tick: (ms: number) => (clock += ms) }
}

const settle = () => new Promise((r) => setTimeout(r, 0))
/** The fetch -> blob -> play chain is several microtasks; give it room without guessing. */
const settleChain = () => new Promise((r) => setTimeout(r, 15))

describe("audioBlobFromBase64", () => {
  test("decodes the proxy's base64 into bytes the Audio element can play", () => {
    const blob = audioBlobFromBase64(btoa("abc"))
    expect(blob.type).toBe("audio/mpeg")
    expect(blob.size).toBe(3)
  })
})

describe("CommentaryAudio queue", () => {
  test("plays a new line and speaks it once", async () => {
    const { audio } = setup()
    expect(audio.enqueue(clip(1))).toBe(true)
    await settle()
    expect(FakeAudio.instances).toHaveLength(1)
    expect(FakeAudio.instances[0]!.src).toContain("blob:")
  })

  test("never speaks the same line twice", async () => {
    const { audio } = setup()
    expect(audio.enqueue(clip(1))).toBe(true)
    await settle()
    // A panel remount replays the store; the same seq must be refused.
    expect(audio.enqueue(clip(1))).toBe(false)
    expect(audio.enqueue(clip(1))).toBe(false)
    expect(FakeAudio.instances).toHaveLength(1)
  })

  test("refuses history the panel loaded, via markSeen", async () => {
    const { audio } = setup()
    audio.markSeen("s1", 7)
    expect(audio.enqueue(clip(3))).toBe(false)
    expect(audio.enqueue(clip(8))).toBe(true)
    await settle()
  })

  test("does not overlap: the second clip waits for the first to end", async () => {
    const { audio } = setup({ gapMs: 1 })
    audio.enqueue(clip(1))
    audio.enqueue(clip(2))
    await settle()
    // Only one element exists — the second is still queued behind it.
    expect(FakeAudio.instances).toHaveLength(1)
    expect(audio.pending).toBe(1)
    expect(audio.isPlaying).toBe(true)
    FakeAudio.instances[0]!.finish()
    await new Promise((r) => setTimeout(r, 20))
    expect(FakeAudio.instances).toHaveLength(2)
  })

  test("holds a gap after a clip ends, measured from the end", async () => {
    const { audio, tick } = setup({ gapMs: 400 })
    audio.enqueue(clip(1))
    await settle()
    audio.enqueue(clip(2))
    FakeAudio.instances[0]!.finish()
    await settle()
    // Still inside the gap: the second clip must not start yet.
    expect(FakeAudio.instances).toHaveLength(1)
    tick(400)
    // The re-pump is a real timer sized by the remaining gap, so let it actually fire.
    await new Promise((r) => setTimeout(r, 450))
    expect(FakeAudio.instances).toHaveLength(2)
  })

  test("a rejected line does not wedge the queue", async () => {
    const onError = mock((_message: string) => {})
    let calls = 0
    const { audio } = setup({
      onError,
      gapMs: 1,
      fetch: asFetch(() => {
        calls++
        return Promise.resolve(calls === 1 ? errorResponse(400, "unknown voice") : okResponse())
      }),
    })
    audio.enqueue(clip(1))
    audio.enqueue(clip(2))
    // The first line fails; what matters is that the lock is released, the queue drains, and the next
    // line still reaches playback. This is the case that used to strand the queue forever.
    await new Promise((r) => setTimeout(r, 40))
    expect(onError).toHaveBeenCalledTimes(1)
    expect(audio.pending).toBe(0)
    expect(FakeAudio.instances).toHaveLength(1)
    expect(audio.isPlaying).toBe(true)
  })

  test("reports a missing audio file once, not on every line", async () => {
    const onError = mock((_message: string) => {})
    const { audio } = setup({ onError, fetch: asFetch(() => Promise.resolve(errorResponse(404, "no stored audio"))) })
    audio.enqueue(clip(1))
    await settle()
    audio.enqueue(clip(2))
    await settle()
    audio.enqueue(clip(3))
    await settle()
    expect(onError).toHaveBeenCalledTimes(1)
    // Three different files, one condition: still one toast, because three toasts is not information.
    expect(onError.mock.calls[0]![0]).toContain("no stored audio")
  })

  test("an autoplay rejection releases the lock instead of wedging forever", async () => {
    const onError = mock((_message: string) => {})
    const { audio } = setup({ onError, gapMs: 1 })
    audio.enqueue(clip(1))
    await settleChain()
    // The browser refuses to start playback.
    FakeAudio.instances[0]!.rejectPlayback()
    FakeAudio.instances[0]!.onended?.()
    await settleChain()
    expect(audio.isPlaying).toBe(false)
    // And the queue still works afterwards — a wedged queue here is the failure that matters.
    audio.enqueue(clip(2))
    await new Promise((r) => setTimeout(r, 40))
    expect(FakeAudio.instances.length).toBe(2)
    expect(audio.isPlaying).toBe(true)
  })

  test("stop() clears the queue and releases the element", async () => {
    const { audio } = setup()
    audio.enqueue(clip(1))
    await settle()
    audio.enqueue(clip(2))
    audio.stop()
    expect(audio.pending).toBe(0)
    expect(audio.isPlaying).toBe(false)
  })

  test("ignores empty text", () => {
    const { audio } = setup()
    expect(audio.enqueue(clip(1, "s1", "   "))).toBe(false)
    expect(audio.pending).toBe(0)
  })

  test("keeps separate high-water marks per session", async () => {
    const { audio } = setup()
    expect(audio.enqueue(clip(5, "a"))).toBe(true)
    expect(audio.enqueue(clip(2, "b"))).toBe(true)
    await settle()
    // A low seq in another session is still new for that session.
    expect(audio.enqueue(clip(1, "b"))).toBe(false)
    expect(audio.enqueue(clip(1, "a"))).toBe(false)
  })

  test("fetches the audio the server rendered for that line, addressed by its hash", async () => {
    const seen: Array<{ url: string; cache?: string; method?: string }> = []
    const fetchMock = asFetch((input, init) => {
      seen.push({ url: String(input), cache: init?.cache, method: init?.method })
      return Promise.resolve(okResponse())
    })
    const audio = new CommentaryAudio({
      sessionID: () => "s9",
      fetch: fetchMock,
      createAudio: () => new FakeAudio() as unknown as HTMLAudioElement,
    })
    audio.enqueue(clip(1, "s9", "hello there"))
    await settleChain()
    // The server synthesized this when the line was written, so the browser only fetches the file. There is
    // no request body and nowhere for a speech host to be smuggled in.
    expect(seen[0]!.url).toBe(`/session/s9/commentary/audio/${hash(1)}`)
    expect(seen[0]!.method).toBeUndefined()
    expect(seen[0]!.cache).toBe("no-store")
  })

  test("a line the server could not speak is skipped silently, not reported", async () => {
    let calls = 0
    const errors: string[] = []
    const audio = new CommentaryAudio({
      sessionID: () => "s1",
      fetch: asFetch(() => {
        calls++
        return Promise.resolve(okResponse())
      }),
      createAudio: () => new FakeAudio() as unknown as HTMLAudioElement,
      onError: (message) => errors.push(message),
    })
    // `audio: undefined` is the shape the server sends for text it could not synthesize. The text is already
    // on screen, so a toast would be noise about something the reader did not ask for.
    expect(audio.enqueue(textOnly(1))).toBe(true)
    await settleChain()
    expect(calls).toBe(0)
    expect(errors).toEqual([])
  })

  test("a text-only line does not block the next line's audio", async () => {
    const seen: string[] = []
    const { audio, tick } = setup({
      gapMs: 400,
      fetch: asFetch((input) => {
        seen.push(String(input))
        return Promise.resolve(okResponse())
      }),
    })
    audio.enqueue(textOnly(1))
    audio.enqueue(clip(2, "s1", "has audio"))
    // Skipping a line still counts as occupying the slot, so the normal gap applies — the queue has to move
    // past it rather than stopping on it.
    tick(400)
    await new Promise((r) => setTimeout(r, 450))
    expect(seen).toEqual([`/session/s1/commentary/audio/${hash(2)}`])
  })

  test("no session means no request at all", async () => {
    let calls = 0
    const audio = new CommentaryAudio({
      sessionID: () => undefined,
      fetch: asFetch(() => {
        calls++
        return Promise.resolve(okResponse())
      }),
      createAudio: () => new FakeAudio() as unknown as HTMLAudioElement,
    })
    audio.enqueue(clip(1, "s1", "hi"))
    await settleChain()
    expect(calls).toBe(0)
  })
})

  // The audio route is an ordinary authenticated route: a browser call without the credential comes back 401 and
  // the line is silently never spoken. This is the exact failure a user hit, so it is pinned.

describe("auth", () => {
  test("sends the auth header the audio route requires", async () => {
    const seen: Array<{ headers: Record<string, string> }> = []
    const audio = new CommentaryAudio({
      sessionID: () => "s1",
      headers: () => ({ Authorization: "Basic dGVzdA==" }),
      fetch: asFetch((_input, init) => {
        seen.push({ headers: (init?.headers ?? {}) as Record<string, string> })
        return Promise.resolve(okResponse())
      }),
      createAudio: () => new FakeAudio() as unknown as HTMLAudioElement,
    })
    audio.enqueue(clip(1, "s1", "hello"))
    await settleChain()
    expect(seen[0]!.headers.Authorization).toBe("Basic dGVzdA==")
  })

  // The browser's own login (/login, `#username` / `#password`) hands out a session cookie, not Basic
  // credentials, so `server.current.http.password` is empty there and `headers()` contributes nothing. The
  // cookie is still what authenticates the proxy — verified 200 cookie-only vs 401 with no credentials at
  // all — but only if the request is allowed to carry it. Pinned because `credentials` defaults quietly and
  // the failure would be a 401 that only shows up in that one login mode.
  test("sends the session cookie even when there is no Basic credential to add", async () => {
    const seen: Array<RequestInit | undefined> = []
    const audio = new CommentaryAudio({
      sessionID: () => "s1",
      headers: () => ({}),
      fetch: asFetch((_input, init) => {
        seen.push(init)
        return Promise.resolve(okResponse())
      }),
      createAudio: () => new FakeAudio() as unknown as HTMLAudioElement,
    })
    audio.enqueue(clip(1, "s1", "hello"))
    await settleChain()
    expect(seen[0]!.credentials).toBe("include")
    expect(seen[0]!.cache).toBe("no-store")
  })
})
