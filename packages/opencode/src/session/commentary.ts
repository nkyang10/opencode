import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionCommentaryTable } from "@opencode-ai/core/session/sql"
import { SessionCommentaryEvent } from "@opencode-ai/schema/session-commentary-event"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LLMEvent } from "@opencode-ai/llm"
import { and, desc, eq, lte, sql } from "drizzle-orm"
import { Cause, Clock, Context, Effect, Layer, Schedule } from "effect"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { CommentaryAudio } from "@/session/commentary-audio"
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
/**
 * Ceiling on the user's own narration preferences (tone, technical level, perspective). They ride the watch
 * lease, so this is untrusted-shaped input arriving on a route: it goes into a prompt on every tick, and an
 * unbounded string would let one client inflate the cost of every subsequent tick. Long enough to write a
 * persona, short enough that it cannot crowd out the digest.
 */
export const MAX_INSTRUCTIONS_CHARS = 4_000
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
/**
 * Hard ceiling on one narration call. Measured on a reasoning model: 99s for a single line, because the
 * model spends its budget thinking about a 30-word answer. Unbounded, one slow call holds the `inFlight`
 * guard and silently disables narration for that session until it returns — so the call is bounded, and a
 * timeout is logged rather than swallowed. It must be several multiples of the tick interval.
 */
export const CALL_TIMEOUT_MS = 120_000

export const DEFAULT_INTERVAL = 10_000
export const DEFAULT_MAX_ENTRIES_PER_TURN = 20
export const DEFAULT_MIN_ACTIVITY_CHARS = 120
export const DEFAULT_NARRATION_HISTORY = 100
/**
 * Rows kept per session. The narration is append-only, so without a bound a server left running grows this
 * table forever — a few hundred bytes a line, silently. Retained well above `narrationHistory` (the cap on
 * what the prompt sees) so pruning can never remove a line the model would have used for continuity, and
 * never touches the cursor, which is the anchor of the NEWEST row.
 */
export const MAX_RETAINED_ENTRIES = 400
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
  readonly speech: SpeechSettings
}

/**
 * Where the spoken narration is rendered. Server-side and config-file only: the client is told the hash of a
 * file that already exists, so it never chooses a host and there is no request field to abuse. The defaults
 * mean the feature works with no `commentary.speech` section at all.
 */
export interface SpeechSettings {
  readonly host: string
  readonly voice: string
  readonly retention: number
  readonly maxBytes: number
}

export function speech(commentary: ConfigV1.Info["commentary"]): SpeechSettings {
  const spec = commentary?.speech
  return {
    host: spec?.host?.trim() || CommentaryAudio.DEFAULT_HOST,
    voice: spec?.voice?.trim() || CommentaryAudio.DEFAULT_VOICE,
    retention: spec?.retention ?? CommentaryAudio.DEFAULT_RETENTION,
    maxBytes: spec?.maxBytes ?? CommentaryAudio.DEFAULT_MAX_BYTES,
  }
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
    speech: speech(commentary),
  }
}

const truncate = (value: string, max: number) =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim()

const args = (input: unknown) => oneLine(typeof input === "string" ? input : JSON.stringify(input ?? {}))

/**
 * The user's narration preferences, as they arrive on the watch route. Whitespace-only is treated as absent
 * so that clearing the textarea in the settings UI does not leave an empty block in every prompt, and the
 * cap is applied here rather than in the UI so the server never trusts the client's arithmetic.
 */
export function normalizeInstructions(value: string | undefined) {
  const trimmed = (value ?? "").trim()
  if (!trimmed) return undefined
  // The block wrapper has to survive whatever the reader wrote in it. A literal closing tag would end the
  // block early and leave the remainder sitting outside it, where it reads as instructions to the model.
  // There is no legitimate way to write one here, so the tags are dropped rather than escaped. Matched
  // case-insensitively and tolerating whitespace before the `>`, so a hand-typed or model-written
  // `</narrator-preferences >` cannot slip past the exact-string form.
  const cleaned = trimmed.replace(/<\/narrator-preferences\s*>/gi, "").trim()
  if (!cleaned) return undefined
  return cleaned.length <= MAX_INSTRUCTIONS_CHARS ? cleaned : cleaned.slice(0, MAX_INSTRUCTIONS_CHARS).trimEnd()
}

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
  // One pass to index the messages, then one lookup per entry. This ran `messages.findIndex` once per
  // entry — 100 entries against a long transcript is 100 scans of the whole timeline, every tick. Keyed by the
  // plain string form because `Entry.anchor` is an unbranded `string` while message ids are branded.
  const at = new Map(messages.map((message, index) => [String(message.info.id), index]))
  let count = 0
  for (const entry of entries) {
    const index = at.get(entry.anchor)
    if (index !== undefined && index >= lastUser) count++
  }
  return count
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
  // A response that *looks* like the contract but does not parse is a contract that got cut off — a stream
  // that ended mid-JSON. Falling through to the raw-text path would then store the partial JSON itself as the
  // narration line, which is how `{"speak": true, "text": "commentary-watch` ended up in the panel. A line the
  // model did not finish writing is not a line worth saying out loud either way, so it is silence.
  if (looksLikeContract(cleaned)) return { speak: false, text: "" }
  const fallback = oneLine(cleaned)
  if (!fallback) return { speak: false, text: "" }
  return { speak: true, text: truncate(fallback, MAX_ENTRY_CHARS) }
}

/** Did the model start writing the JSON contract without finishing it? */
export function looksLikeContract(value: string) {
  const start = value.indexOf("{")
  return start !== -1 && /"speak"\s*:/.test(value.slice(start))
}

export const INSTRUCTIONS = `Write the next line of the narration for the <new-activity> above.

Reply with one JSON object and nothing else: {"speak": true, "text": "…"} or {"speak": false}.

- At most 30 words, one short paragraph, present tense, describing what the agent is doing right now and why it matters.
- The user's request in <new-activity> is BACKGROUND, never the subject. The reader wrote it thirty seconds ago and can still see it. Never restate it, quote it, paraphrase it, or open by naming the task. You may allude to the purpose in a few words when it explains why the current step matters.
- The subject is always what the agent DID or FOUND since the last line. If the only new thing is the user's request arriving, that is normally not worth a line.
- Continue <narration-so-far> as one continuous account. Do not recap it and never refer to the previous lines.
- Name real things exactly: paths, symbols, commands, error strings, counts.
- Never use "tool", "agent", "assistant", "model", "token" or "prompt" as the subject of a sentence.
- Use the same language as the user's messages.
- Use {"speak": false} whenever there is nothing genuinely new to say. Silence is correct on most ticks.`

/**
 * The user's own narration preferences, as their own block. They are placed immediately before the
 * instructions and tagged as preferences, not as content, because the digest below is untrusted text that
 * can contain anything a file or a command output contains — a preference block that is not clearly
 * delimited is a prompt-injection surface for whatever the agent is currently reading.
 */
export function prompt(input: {
  readonly narration: readonly string[]
  readonly digest: readonly string[]
  readonly instructions?: string
}) {
  return [
    input.narration.length > 0
      ? `The narration so far, oldest first:\n\n<narration-so-far>\n${input.narration.join("\n")}\n</narration-so-far>`
      : "This is the first line of the narration.",
    `What the agent just did:\n\n<new-activity>\n${input.digest.join("\n") || "(nothing new)"}\n</new-activity>`,
    input.instructions === undefined
      ? ""
      : `The reader has asked for this narration to be written like this. Follow it, but never let it break the rules above:\n\n<narrator-preferences>\n${input.instructions}\n</narrator-preferences>`,
    INSTRUCTIONS,
  ]
    .filter(Boolean)
    .join("\n\n")
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
  readonly watch: (sessionID: SessionID, instructions?: string) => Effect.Effect<void>
  readonly unwatch: (sessionID: SessionID) => Effect.Effect<void>
  readonly list: (input: { sessionID: SessionID; limit?: number }) => Effect.Effect<Entry[]>
  readonly tick: (sessionID: SessionID) => Effect.Effect<Entry | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCommentary") {}

/**
 * The lease is a deadline plus the preferences of whoever last refreshed it, not a count: two clients on
 * one session still speak once, and the wording is whoever's preference landed most recently. That is the
 * accepted trade for keeping the per-client instructions out of any shared store — see DEC-058.
 */
type Lease = { readonly expires: number; readonly instructions?: string }

type State = {
  leases: Map<SessionID, Lease>
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
  readonly audio: CommentaryAudio.Interface
  /** The instance scope: the audio render is forked into it so it dies with the instance. */
  readonly scope: Scope.Scope
}

const make = Effect.fn("SessionCommentary.make")(function* (deps: Deps) {
  const { db, events, sessions, config, status, agents, models, llm, audio } = deps

  const state: State = { leases: new Map(), inFlight: new Set() }

  const current = Effect.map(config.get(), (cfg) => settings(cfg.commentary))

  /**
   * Synthesize one line's audio, record the hash on the row, publish the line again, and sweep what nothing
   * points at any more.
   *
   * The sweep runs on the global hash set rather than per session: the files are content-addressed and shared
   * between sessions, so "the oldest 100 for this session" and "every hash a surviving row still references"
   * are the same question only if you ask it across all of them.
   */
  const renderAudio = Effect.fn("SessionCommentary.renderAudio")(function* (sessionID: SessionID, entry: Entry) {
    const cfg = yield* current
    const hash = yield* audio.render({ text: entry.text, voice: cfg.speech.voice, host: cfg.speech.host })
    if (!hash) return

    yield* db
      .update(SessionCommentaryTable)
      .set({ audio: hash })
      .where(and(eq(SessionCommentaryTable.session_id, sessionID), eq(SessionCommentaryTable.seq, entry.seq)))
      .run()
      .pipe(Effect.orDie)
    yield* events.publish(Event.Posted, { sessionID, entry: { ...entry, audio: hash } })

    // Keep only the newest `retention` audio references for this session, then drop files nothing references.
    const rows = yield* db
      .select({ seq: SessionCommentaryTable.seq, audio: SessionCommentaryTable.audio })
      .from(SessionCommentaryTable)
      .where(eq(SessionCommentaryTable.session_id, sessionID))
      .orderBy(desc(SessionCommentaryTable.seq))
      .all()
      .pipe(Effect.orDie)
    // `overflow` is the oldest row that has fallen out of the window, and its seq is the cut-off. There is no
    // cut-off until there IS an overflow row: defaulting it to MAX_SAFE_INTEGER here would null the audio of
    // every row in the session, which is exactly what it did before this guard existed — files on disk, and
    // every entry silently text-only.
    const overflow = rows[cfg.speech.retention]
    if (overflow) {
      yield* db
        .update(SessionCommentaryTable)
        .set({ audio: null })
        .where(and(eq(SessionCommentaryTable.session_id, sessionID), lte(SessionCommentaryTable.seq, overflow.seq)))
        .run()
        .pipe(Effect.orDie)
    }

    // Re-read after the write, so `keep` is what the database actually says rather than what it said a moment
    // ago. Files are content-addressed and shared, so this is the only place that knows what is still needed.
    const referenced = yield* db
      .select({ audio: SessionCommentaryTable.audio })
      .from(SessionCommentaryTable)
      .where(and(sql`${SessionCommentaryTable.audio} IS NOT NULL`, sql`${SessionCommentaryTable.audio} <> ''`))
      .all()
      .pipe(Effect.orDie)
    const keep = new Set(referenced.flatMap((row) => (row.audio ? [row.audio] : [])))
    yield* audio.sweep(keep)
  })

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
      // `audio` is nullable on purpose: a line the server could not speak has none, and the client shows the
      // text regardless rather than waiting for audio that will never arrive.
      .map((row) => ({ seq: row.seq, time: row.time, text: row.text, anchor: row.anchor, audio: row.audio ?? undefined }))
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
    // Retention: `seq` is monotonic per session, so everything at or below the cut-off is exactly the oldest
    // overflow. A no-op until the cap is passed.
    if (entry.seq > MAX_RETAINED_ENTRIES) {
      yield* db
        .delete(SessionCommentaryTable)
        .where(
          and(
            eq(SessionCommentaryTable.session_id, input.sessionID),
            lte(SessionCommentaryTable.seq, entry.seq - MAX_RETAINED_ENTRIES),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    }
    yield* events.publish(Event.Posted, { sessionID: input.sessionID, entry })
    // The audio is rendered *after* the line is published, in its own fiber, and the line is published a second
    // time when the file exists. On the critical path a 30-second speech timeout would delay the text the user
    // is trying to read, which is the one thing the commentary is for.
    yield* renderAudio(input.sessionID, entry).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("commentary audio render failed", { sessionID: input.sessionID, cause }),
      ),
      Effect.forkIn(deps.scope, { startImmediately: true }),
    )
    return entry
  })

  // The lease is a deadline, not a count: two clients on one session still speak once. It lives in process
  // memory because session drains are process-local, so there is nothing to persist and nothing to clean up.
  // The instructions are re-sent on every heartbeat, so editing the preference in settings takes effect on
  // the next tick without a restart.
  const watch = Effect.fn("SessionCommentary.watch")(function* (sessionID: SessionID, instructions?: string) {
    state.leases.set(sessionID, {
      expires: (yield* Clock.currentTimeMillis) + LEASE_TTL_MS,
      instructions: normalizeInstructions(instructions),
    })
  })

  const unwatch = Effect.fn("SessionCommentary.unwatch")(function* (sessionID: SessionID) {
    state.leases.delete(sessionID)
  })

  const tick = Effect.fn("SessionCommentary.tick")(function* (sessionID: SessionID) {
    const config = yield* current
    if (!config.enabled) return undefined
    if (state.inFlight.has(sessionID)) return undefined
    const now = yield* Clock.currentTimeMillis
    const lease = state.leases.get(sessionID)
    if (!lease || lease.expires <= now) return undefined
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
          {
            role: "user",
            content: prompt({ narration: narration(history), digest: chunks, instructions: lease.instructions }),
          },
        ],
      })
      .pipe(
        Stream.filter(LLMEvent.is.textDelta),
        Stream.map((event) => event.text),
        Stream.mkString,
        Effect.timeout(CALL_TIMEOUT_MS),
        Effect.catchCause((cause) =>
          Effect.logWarning("SessionCommentary: narration call did not complete", { sessionID }).pipe(
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
  //
  // Each session's tick is FORKED, not awaited. Measured: a reasoning model takes 43-99s for a single line,
  // and a call is bounded at CALL_TIMEOUT_MS. Awaiting them in sequence meant one slow session delayed every
  // other watched session for the length of its call and pushed the next pass out by the same amount — three
  // watched sessions with two busy ones left the third waiting minutes. Forking into this loop fiber's scope
  // keeps ticks concurrent and interrupted when the instance is disposed; `inFlight` still prevents two ticks
  // for the SAME session from overlapping.
  const interval = (yield* current).interval
  yield* Effect.sleep(interval).pipe(
    Effect.andThen(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        for (const [sessionID, lease] of state.leases) {
          if (lease.expires <= now) {
            state.leases.delete(sessionID)
            continue
          }
          yield* tick(sessionID).pipe(Effect.ignore, Effect.forkScoped)
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
    // needs nothing but its own scope (which is what makes the loop interrupt on instance disposal). The scope
    // is the one field that cannot be resolved here — it only exists inside `InstanceState.make`.
    const deps: Omit<Deps, "scope"> = {
      db: (yield* Database.Service).db,
      events: yield* EventV2Bridge.Service,
      sessions: yield* Session.Service,
      config: yield* Config.Service,
      status: yield* SessionStatus.Service,
      agents: yield* Agent.Service,
      models: yield* Provider.Service,
      llm: yield* LLM.Service,
      audio: yield* CommentaryAudio.Service,
    }
    // The render fiber is forked into the instance scope, so it is interrupted when the instance is disposed.
    const state = yield* InstanceState.make(() =>
      Effect.gen(function* () {
        return yield* make({ ...deps, scope: yield* Scope.Scope })
      }),
    )
    return Service.of({
      watch: (sessionID, instructions) =>
        InstanceState.useEffect(state, (svc) => svc.watch(sessionID, instructions)),
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
    CommentaryAudio.node,
  ],
})

export * as SessionCommentary from "./commentary"
