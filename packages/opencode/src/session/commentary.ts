import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionCommentaryTable } from "@opencode-ai/core/session/sql"
import { SessionCommentaryEvent } from "@opencode-ai/schema/session-commentary-event"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LLMEvent } from "@opencode-ai/llm"
import { desc, eq } from "drizzle-orm"
import { Cause, Clock, Context, Effect, Layer, Schedule } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { LLM } from "@/session/llm"
import { MessageID, SessionID } from "@/session/schema"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"

export const Entry = SessionCommentaryEvent.Entry
export type Entry = SessionCommentaryEvent.Entry

export const Event = SessionCommentaryEvent

/**
 * Every ceiling the service enforces on the model. Deliberately not one config knob per cap: the point of
 * the caps is that a single `bash` result can never cost more than the narration itself, and a knob per cap
 * is the obvious way to lose that.
 */
export const MAX_ENTRY_CHARS = 240
export const MAX_DIGEST_CHARS = 12_000
export const MAX_ARGS_CHARS = 160
export const MAX_RESULT_CHARS = 200
export const MAX_USER_CHARS = 400
export const MAX_SUBTASK_CHARS = 120
export const MAX_ASSISTANT_CHARS = 960
export const NARRATION_CHARS = 24_000
/** A call that starts less than this after the previous one returns would run the model back to back. */
export const MIN_GAP_MS = 10_000
/** Long enough that one dropped heartbeat (a sleeping phone, a tunnel hiccup) cannot end the narration. */
export const LEASE_TTL_MS = 45_000

export const DEFAULT_INTERVAL = 10_000
export const DEFAULT_MAX_ENTRIES_PER_TURN = 20
export const DEFAULT_MIN_ACTIVITY_CHARS = 120
export const DEFAULT_NARRATION_HISTORY = 100
/** With no stored entry there is no cursor, so the first narration is seeded from the tail of the session. */
export const SEED_MESSAGES = 6

export interface Settings {
  readonly enabled: boolean
  readonly interval: number
  readonly model: "session" | "small"
  readonly maxEntriesPerTurn: number
  readonly minActivityChars: number
  readonly narrationHistory: number
  readonly minGap: number
}

export function settings(commentary: ConfigV1.Info["commentary"]): Settings {
  return {
    enabled: commentary?.enabled ?? true,
    interval: commentary?.interval ?? DEFAULT_INTERVAL,
    model: commentary?.model ?? "session",
    maxEntriesPerTurn: commentary?.maxEntriesPerTurn ?? DEFAULT_MAX_ENTRIES_PER_TURN,
    minActivityChars: commentary?.minActivityChars ?? DEFAULT_MIN_ACTIVITY_CHARS,
    narrationHistory: commentary?.narrationHistory ?? DEFAULT_NARRATION_HISTORY,
    minGap: commentary?.minGap ?? MIN_GAP_MS,
  }
}

const truncate = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim()

const args = (input: unknown) => oneLine(typeof input === "string" ? input : JSON.stringify(input ?? {}))

function errorText(error: { readonly name: string; readonly data: unknown }) {
  const data = error.data
  if (data && typeof data === "object" && "message" in data && typeof data.message === "string") return data.message
  return error.name
}

const toolResult = (part: SessionV1.ToolPart) => {
  if (part.state.status === "completed") return truncate(oneLine(part.state.output), MAX_RESULT_CHARS)
  if (part.state.status === "error") return `error: ${truncate(oneLine(part.state.error), MAX_RESULT_CHARS)}`
  if (part.state.status === "running") return "running"
  return "pending"
}

/**
 * One line per meaningful part. Reasoning, `step-*`, `snapshot`, `patch` and synthetic text are excluded on
 * purpose: reasoning is the bulkiest text in a turn and is usually hidden from the user, and the narrated
 * result of a thought is the tool call that follows it.
 */
export function serializeMessage(message: SessionV1.WithParts): string[] {
  if (message.info.role === "user") {
    const text = oneLine(
      message.parts
        .map((part) => {
          if (part.type === "text" && !part.synthetic) return part.text
          if (part.type === "file") return `[attached ${part.mime}: ${part.filename ?? part.url}]`
          return ""
        })
        .filter(Boolean)
        .join(" "),
    )
    return text ? [`user: ${truncate(text, MAX_USER_CHARS)}`] : []
  }
  if (message.info.role !== "assistant") return []
  const lines: string[] = []
  if (message.info.error) lines.push(`error: ${truncate(errorText(message.info.error), MAX_RESULT_CHARS)}`)
  for (const part of message.parts) {
    if (part.type === "text") {
      if (part.synthetic) continue
      const text = oneLine(part.text)
      if (text) lines.push(`assistant: ${truncate(text, MAX_ASSISTANT_CHARS)}`)
      continue
    }
    if (part.type === "tool") {
      lines.push(`call ${part.tool}(${truncate(args(part.state.input), MAX_ARGS_CHARS)})`)
      lines.push(`  -> ${toolResult(part)}`)
      continue
    }
    if (part.type === "subtask") {
      lines.push(`subtask ${part.agent}: ${truncate(oneLine(part.prompt), MAX_SUBTASK_CHARS)}`)
    }
  }
  return lines
}

/** Trims from the front, so the newest activity always survives the cap. Never returns empty for non-empty input. */
export function trimFront(chunks: readonly string[], max: number) {
  const kept: string[] = []
  let total = 0
  for (let index = chunks.length - 1; index >= 0; index--) {
    const chunk = chunks[index]!
    const next = total + chunk.length + 1
    if (next > max && kept.length > 0) break
    kept.unshift(chunk)
    total = next
  }
  return kept
}

export function digest(messages: readonly SessionV1.WithParts[]) {
  return trimFront(messages.flatMap(serializeMessage), MAX_DIGEST_CHARS)
}

export function narration(entries: readonly Entry[], max = NARRATION_CHARS) {
  return trimFront(
    entries.map((entry) => entry.text),
    max,
  )
}

/** The cursor is the anchor of the newest stored entry, which is why it is never persisted separately. */
export function cursorOf(entries: readonly Entry[]) {
  return entries.at(-1)?.anchor
}

export function sliceFrom(messages: readonly SessionV1.WithParts[], anchor: string | undefined) {
  if (anchor === undefined) return messages.slice(-SEED_MESSAGES)
  const index = messages.findIndex((message) => message.info.id === anchor)
  if (index === -1) return messages.slice(-SEED_MESSAGES)
  return messages.slice(index + 1)
}

/**
 * Entries belonging to the turn that is running now. A stored entry belongs to the current turn when it
 * anchored at or after the most recent user message, so a new prompt resets the budget without any extra
 * bookkeeping — the anchor is already there.
 */
export function entriesInCurrentTurn(messages: readonly SessionV1.WithParts[], entries: readonly Entry[]) {
  const lastUser = messages.findLastIndex((message) => message.info.role === "user")
  if (lastUser === -1) return entries.length
  const floor = messages[lastUser]!.info.id
  const boundary = messages.findIndex((message) => message.info.id === floor)
  return entries.filter((entry) => {
    const at = messages.findIndex((message) => message.info.id === entry.anchor)
    return at === -1 ? false : at >= boundary
  }).length
}

/**
 * `{"speak":false}` / `{"speak":true,"text":"…"}`, parsed defensively. Anything unparseable counts as
 * speech: a model that ignored the format still produced something worth showing, and dropping it silently
 * is the worse failure. A `WAIT` sentinel was rejected because it cannot be told apart from a model that
 * genuinely wrote the word "wait".
 */
export function parse(raw: string): { speak: boolean; text: string } {
  const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
  const start = cleaned.indexOf("{")
  if (start !== -1) {
    let depth = 0
    for (let index = start; index < cleaned.length; index++) {
      if (cleaned[index] === "{") depth++
      if (cleaned[index] !== "}") continue
      depth--
      if (depth !== 0) continue
      try {
        const value = JSON.parse(cleaned.slice(start, index + 1)) as { speak?: unknown; text?: unknown }
        if (value.speak === false) return { speak: false, text: "" }
        if (typeof value.text !== "string" || !value.text.trim()) return { speak: false, text: "" }
        return { speak: true, text: truncate(oneLine(value.text), MAX_ENTRY_CHARS) }
      } catch {
        // fall through to the raw-text path
      }
      break
    }
  }
  const fallback = oneLine(cleaned)
  if (!fallback) return { speak: false, text: "" }
  return { speak: true, text: truncate(fallback, MAX_ENTRY_CHARS) }
}

export const INSTRUCTIONS = `Write the next line of the narration for the <new-activity> above.

Reply with one JSON object and nothing else: {"speak": true, "text": "…"} or {"speak": false}.

- At most 30 words, one short paragraph, present tense, describing what the agent is doing right now and why it matters.
- Continue <narration-so-far> as one continuous account. Do not recap it and never refer to the previous lines.
- Name real things exactly: paths, symbols, commands, error strings, counts.
- Never use "tool", "agent", "assistant", "model", "token" or "prompt" as the subject of a sentence.
- Use the same language as the user's messages.
- Use {"speak": false} whenever there is nothing genuinely new to say. Silence is correct on most ticks.`

export function prompt(input: { readonly narration: readonly string[]; readonly digest: readonly string[] }) {
  return [
    input.narration.length > 0
      ? `The narration so far, oldest first:\n\n<narration-so-far>\n${input.narration.join("\n")}\n</narration-so-far>`
      : "This is the first line of the narration.",
    `What the agent just did:\n\n<new-activity>\n${input.digest.join("\n") || "(nothing new)"}\n</new-activity>`,
    INSTRUCTIONS,
  ].join("\n\n")
}

/**
 * A fresh user message per tick, carrying a generated id. It is never persisted: `llm.stream` outside the
 * session runner publishes nothing, which is the same property `SessionPrompt.ensureTitle` relies on. If a
 * `message.updated` event ever appears for one of these ids the narration is leaking into the timeline.
 *
 * The `model` MUST be the session's real model, not a placeholder. The v1 LLM path reads `user.model` for
 * provider resolution and usage attribution, so a fabricated `providerID` selects a runtime and then dies
 * with no completion — and because the tick swallows failures, that used to be invisible.
 */
export function syntheticUser(session: Session.Info, now: number) {
  return {
    id: MessageID.ascending(),
    sessionID: session.id,
    role: "user" as const,
    time: { created: now },
    agent: "commentary",
    model: { providerID: session.model!.providerID, modelID: session.model!.id },
  } as unknown as SessionV1.User
}

export interface Interface {
  readonly watch: (sessionID: SessionID) => Effect.Effect<void>
  readonly unwatch: (sessionID: SessionID) => Effect.Effect<void>
  readonly list: (input: { sessionID: SessionID; limit?: number }) => Effect.Effect<Entry[]>
  readonly tick: (sessionID: SessionID) => Effect.Effect<Entry | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCommentary") {}

type State = {
  leases: Map<SessionID, number>
  inFlight: Set<SessionID>
}

type Deps = {
  readonly db: Database.Interface["db"]
  readonly events: EventV2.Interface
  readonly sessions: Session.Interface
  readonly config: Config.Interface
  readonly status: SessionStatus.Interface
  readonly agents: Agent.Interface
  readonly models: Provider.Interface
  readonly llm: LLM.Interface
}

const make = Effect.fn("SessionCommentary.make")(function* (deps: Deps) {
  const { db, events, sessions, config, status, agents, models, llm } = deps

  const state: State = { leases: new Map(), inFlight: new Set() }

  const current = Effect.map(config.get(), (cfg) => settings(cfg.commentary))

  const list = Effect.fn("SessionCommentary.list")(function* (input: { sessionID: SessionID; limit?: number }) {
    const rows = yield* db
      .select()
      .from(SessionCommentaryTable)
      .where(eq(SessionCommentaryTable.session_id, input.sessionID))
      .orderBy(desc(SessionCommentaryTable.seq))
      .limit(input.limit ?? 50)
      .all()
      .pipe(Effect.orDie)
    return rows
      .map((row) => ({ seq: row.seq, time: row.time, text: row.text, anchor: row.anchor }))
      .reverse()
  })

  const append = Effect.fn("SessionCommentary.append")(function* (input: {
    sessionID: SessionID
    text: string
    anchor: MessageID
  }) {
    const newest = yield* db
      .select({ seq: SessionCommentaryTable.seq })
      .from(SessionCommentaryTable)
      .where(eq(SessionCommentaryTable.session_id, input.sessionID))
      .orderBy(desc(SessionCommentaryTable.seq))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    const entry: Entry = {
      seq: (newest?.seq ?? 0) + 1,
      time: yield* Clock.currentTimeMillis,
      text: input.text,
      anchor: input.anchor,
    }
    yield* db
      .insert(SessionCommentaryTable)
      .values([
        {
          session_id: input.sessionID,
          seq: entry.seq,
          time: entry.time,
          text: entry.text,
          anchor: input.anchor,
        },
      ])
      .run()
      .pipe(Effect.orDie)
    yield* events.publish(Event.Posted, { sessionID: input.sessionID, entry })
    return entry
  })

  // The lease is a deadline, not a count: two clients on one session still speak once. It lives in process
  // memory because session drains are process-local, so there is nothing to persist and nothing to clean up.
  const watch = Effect.fn("SessionCommentary.watch")(function* (sessionID: SessionID) {
    state.leases.set(sessionID, (yield* Clock.currentTimeMillis) + LEASE_TTL_MS)
  })

  const unwatch = Effect.fn("SessionCommentary.unwatch")(function* (sessionID: SessionID) {
    state.leases.delete(sessionID)
  })

  const tick = Effect.fn("SessionCommentary.tick")(function* (sessionID: SessionID) {
    const config = yield* current
    if (!config.enabled) return undefined
    if (state.inFlight.has(sessionID)) return undefined
    const now = yield* Clock.currentTimeMillis
    if ((state.leases.get(sessionID) ?? 0) <= now) return undefined
    if ((yield* status.get(sessionID)).type === "idle") return undefined

    const session = yield* sessions.get(sessionID)
    if (!session.model) return undefined
    const messages = yield* sessions.messages({ sessionID })
    if (messages.length === 0) return undefined

    const history = yield* list({ sessionID, limit: config.narrationHistory })
    const newest = history.at(-1)
    if (newest !== undefined && now - newest.time < config.minGap) return undefined
    const since = sliceFrom(messages, cursorOf(history))
    if (since.length === 0) return undefined
    const chunks = digest(since)
    if (chunks.join("\n").length < config.minActivityChars) return undefined
    if (entriesInCurrentTurn(messages, history) >= config.maxEntriesPerTurn) return undefined
    const anchor = since.at(-1)!.info.id
    const agent = yield* agents.get("commentary")
    if (!agent) return undefined

    state.inFlight.add(sessionID)
    const text = yield* llm
      .stream({
        agent,
        user: syntheticUser(session, now),
        sessionID,
        model:
          config.model === "small"
            ? ((yield* models.getSmallModel(session.model.providerID)) ??
              (yield* models.getModel(session.model.providerID, session.model.id)))
            : yield* models.getModel(session.model.providerID, session.model.id),
        small: config.model === "small",
        system: [],
        tools: {},
        retries: 1,
        messages: [
          { role: "user", content: prompt({ narration: narration(history), digest: chunks }) },
        ],
      })
      .pipe(
        Stream.filter(LLMEvent.is.textDelta),
        Stream.map((event) => event.text),
        Stream.mkString,
        Effect.catchCause((cause) =>
          Effect.logWarning("SessionCommentary: narration call failed", { sessionID }).pipe(
            Effect.andThen(Effect.logDebug(Cause.pretty(cause))),
            Effect.andThen(Effect.succeed("")),
          ),
        ),
        Effect.ensuring(Effect.sync(() => state.inFlight.delete(sessionID))),
      )

    if (!text) return undefined
    const parsed = parse(text)
    if (!parsed.speak) return undefined
    return yield* append({ sessionID, text: parsed.text, anchor })
  }, Effect.catchCause(() => Effect.succeed(undefined)))

  // The 10s loop: the only timer in the engine, so every per-session failure is swallowed and the lease is
  // a deadline rather than a count (two clients on one session still speak once). `Effect.repeat` runs its
  // effect immediately, so the first pass is delayed by one interval — a freshly opened instance must not
  // spend a model call before anyone has had a chance to open the panel. The interval is read once here,
  // so changing `commentary.interval` needs the instance to restart.
  const interval = (yield* current).interval
  yield* Effect.sleep(interval).pipe(
    Effect.andThen(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        for (const [sessionID, expires] of state.leases) {
          if (expires <= now) {
            state.leases.delete(sessionID)
            continue
          }
          yield* tick(sessionID).pipe(Effect.ignore)
        }
      }).pipe(Effect.ignore),
    ),
    Effect.repeat(Schedule.spaced(interval)),
    Effect.forkScoped,
  )

  return Service.of({ watch, unwatch, list, tick })
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // House pattern: resolve the services once here and close over the values, so the per-instance closure
    // needs nothing but its own scope (which is what makes the loop interrupt on instance disposal).
    const deps: Deps = {
      db: (yield* Database.Service).db,
      events: yield* EventV2Bridge.Service,
      sessions: yield* Session.Service,
      config: yield* Config.Service,
      status: yield* SessionStatus.Service,
      agents: yield* Agent.Service,
      models: yield* Provider.Service,
      llm: yield* LLM.Service,
    }
    const state = yield* InstanceState.make(() => make(deps))
    return Service.of({
      watch: (sessionID) => InstanceState.useEffect(state, (svc) => svc.watch(sessionID)),
      unwatch: (sessionID) => InstanceState.useEffect(state, (svc) => svc.unwatch(sessionID)),
      list: (input) => InstanceState.useEffect(state, (svc) => svc.list(input)),
      tick: (sessionID) => InstanceState.useEffect(state, (svc) => svc.tick(sessionID)),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [
    Database.node,
    EventV2Bridge.node,
    Session.node,
    Config.node,
    SessionStatus.node,
    Agent.node,
    Provider.node,
    LLM.node,
  ],
})

export * as SessionCommentary from "./commentary"
