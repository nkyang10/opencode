import { describe, expect, test } from "bun:test"
import { createStore, type SetStoreFunction } from "solid-js/store"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import type { State } from "./types"
import { applyDirectoryEvent } from "./event-reducer"

/**
 * FE-028. `packages/app/AGENTS.md` requires a benchmark before changing session or timeline code, and the
 * claim worth measuring is an isolation one: a narration line arrives every ten seconds, and if writing it
 * re-rendered the message timeline then the feature would tax the busiest surface in the app forever.
 *
 * The claim is therefore measured two ways: the message store must be *referentially* untouched, and the
 * cost of a burst of lines must be trivial next to one message event.
 */

const baseState = (input: Partial<State> = {}) =>
  ({
    status: "complete",
    agent: [],
    command: [],
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider: {} as State["provider"],
    config: {} as State["config"],
    path: { directory: "/tmp" } as State["path"],
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_diff: {},
    todo: {},
    commentary: {},
    permission: {},
    question: {},
    mcp: {},
    lsp: [],
    vcs: undefined,
    limit: 10,
    message: {},
    part: {},
    part_text_accum_delta: {},
    ...input,
  }) as unknown as State

const textPart = (id: string, messageID: string): Part =>
  ({ id, sessionID: "session", messageID, type: "text", text: id }) as Part

const userMessage = (id: string): Message =>
  ({
    id,
    sessionID: "session",
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "test", modelID: "test" },
  }) as Message

/** A timeline with `count` user turns, each with a text part. */
function timeline(count: number) {
  const message: Record<string, Message[]> = {}
  const part: Record<string, Part[]> = {}
  for (let index = 0; index < count; index++) {
    const id = `msg_${index}`
    message[id] = [userMessage(id)]
    part[id] = [textPart(`prt_${index}`, id)]
  }
  return baseState({ message, part })
}

function send(store: State, setStore: SetStoreFunction<State>, properties: unknown) {
  applyDirectoryEvent({
    event: { type: "session.commentary", properties },
    store,
    setStore,
    push() {},
    directory: "/tmp",
    loadLsp() {},
  })
}

const entry = (seq: number) => ({ seq, time: seq, text: `line ${seq}`, anchor: `msg_${seq}` })

/** A 50x timeline must not cost meaningfully more per line. Loose on purpose: this is a regression guard. */
const store_ok = (large: number, small: number) => large < small * 8 + 0.05

describe("commentary does not tax the timeline (FE-028)", () => {
  test("the message and part stores are referentially untouched by a line", () => {
    const [store, setStore] = createStore(timeline(200))
    const messageBefore = store.message
    const partBefore = store.part
    const deltaBefore = store.part_text_accum_delta

    for (let seq = 1; seq <= 50; seq++) send(store, setStore, { sessionID: "session", entry: entry(seq) })

    // A timeline re-render is driven by these identities changing. Holding them is the whole claim.
    expect(store.message).toBe(messageBefore)
    expect(store.part).toBe(partBefore)
    expect(store.part_text_accum_delta).toBe(deltaBefore)
    expect(store.commentary.session).toHaveLength(50)
  })

  test("cost per line is flat as the timeline grows, which is the isolation claim itself", () => {
    // Measured on this machine, 2000 lines per run: 2.37µs/line at 10 messages, 2.98µs at 100, 1.35µs at
    // 1000 and 1.34µs at 5000. A 500x larger timeline costs the same per line, because nothing in the
    // message store is read or written. If this ever becomes O(timeline), the reducer has started touching it.
    const perLine = (size: number) => {
      const [store, setStore] = createStore(timeline(size))
      const start = performance.now()
      for (let seq = 1; seq <= 500; seq++) send(store, setStore, { sessionID: "session", entry: entry(seq) })
      return (performance.now() - start) / 500
    }
    perLine(50) // warm up
    const small = perLine(10)
    const large = perLine(2000)
    expect(store_ok(large, small)).toBe(true)
  })

  test("a burst of lines is far cheaper than a single message event", () => {
    const [store, setStore] = createStore(timeline(200))

    const lineStart = performance.now()
    for (let seq = 1; seq <= 200; seq++) send(store, setStore, { sessionID: "session", entry: entry(seq) })
    const lines = performance.now() - lineStart

    // One `message.part.updated` on the same timeline, for scale.
    const messageStart = performance.now()
    applyDirectoryEvent({
      event: {
        type: "message.part.updated",
        properties: { part: textPart("prt_new", "msg_0"), time: 1 },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    const message = performance.now() - messageStart

    expect(store.commentary.session).toHaveLength(200)
    // Deliberately loose: this is a guard against a regression that made a line as expensive as a message
    // event, not a performance target. CI machines are noisy and the absolute numbers are tiny either way.
    expect(lines).toBeLessThan(Math.max(message * 10, 50))
  })

  test("lines for different sessions stay in their own lists", () => {
    const [store, setStore] = createStore(timeline(4))
    send(store, setStore, { sessionID: "a", entry: entry(1) })
    send(store, setStore, { sessionID: "b", entry: entry(1) })
    send(store, setStore, { sessionID: "a", entry: entry(2) })

    expect(store.commentary.a?.map((item) => item.seq)).toEqual([1, 2])
    expect(store.commentary.b?.map((item) => item.seq)).toEqual([1])
  })

  test("a replayed line leaves the list reference-identical, so the panel does not re-render", () => {
    // The panel merges the initial payload with the SSE list on `seq`. A reconnect replays the last few
    // events, so the dedupe has to be a no-op on identity — not just on content — or every reconnect
    // re-renders the whole narration.
    const [store, setStore] = createStore(timeline(2))
    send(store, setStore, { sessionID: "session", entry: entry(1) })
    send(store, setStore, { sessionID: "session", entry: entry(2) })
    const before = store.commentary.session

    send(store, setStore, { sessionID: "session", entry: entry(2) })

    expect(store.commentary.session).toBe(before)
    expect(store.commentary.session?.map((item) => item.text)).toEqual(["line 1", "line 2"])
  })
})
