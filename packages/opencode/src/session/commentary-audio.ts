import { filesystem, httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Cause, Context, Effect, Layer } from "effect"
import * as FileSystem from "effect/FileSystem"
import * as HttpBody from "effect/unstable/http/HttpBody"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import path from "node:path"
import { speechBaseUrl } from "@/server/routes/instance/httpapi/handlers/speech-target"

/**
 * FU-122: the spoken narration, rendered once on the server and addressed by content hash.
 *
 * The alternative — synthesizing when the browser is about to play a line — makes the reader wait for the
 * speech service, and turns a speech-box outage into a silent line. Rendering at narration time costs a file
 * per line and buys instant playback, a line that survives the service being down, and a `host` that is config
 * rather than a field in a request body.
 *
 * **The one thing to be careful about** is that the name is content-addressed, so two commentary rows can
 * legitimately share one file. `sweep` must therefore unlink a file only once no surviving row references its
 * hash, or it breaks playback for the row that still points at it.
 */

export const DEFAULT_HOST = "192.168.1.162:8880"
export const DEFAULT_VOICE = "cantonese"
/**
 * Files kept per session, which is also how many entries the panel shows. The narration is a running
 * commentary rather than a transcript, so keeping the audio for a hundred lines nobody will read was paying
 * disk for nothing. Beyond the window a row's `audio` is cleared and its file unlinked.
 */
export const DEFAULT_RETENTION = 15
/** Ceiling across every session. */
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024

const RENDER_TIMEOUT = "30 seconds"
/** A 2000-char line is ~40 KB of audio; anything far past that is a wrong endpoint, not speech. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
/**
 * A voice catalogue is JSON text: 322 voices with 23 aliases is ~100 KB. Anything past this is not a
 * catalogue, and reading it into memory because a host said so is the wrong trade.
 */
const MAX_CATALOGUE_BYTES = 2 * 1024 * 1024
const CATALOGUE_TIMEOUT = "8 seconds"
/** Long enough that a picker opened twice in a session does not re-fetch, short enough to notice a restart. */
export const CATALOGUE_TTL_MS = 600_000

/** 32 hex chars is 128 bits — no plausible number of lines collides, and it stays a legal path segment. */
export const HASH_PATTERN = /^[0-9a-f]{32}$/

/**
 * The identity of a piece of audio. The voice is part of it so that changing the voice invalidates the store
 * instead of replaying what the previous voice said for the same words, and the **endpoint** is part of it
 * because two builds of one service answer the same voice name with different audio — measured: `cantonese`
 * on `:8880` is untagged 48 kbps and on `:8881` is 64 kbps with an ID3 tag. Hashing the voice alone would
 * serve one endpoint's recording of a line the other endpoint was asked to speak.
 *
 * The host is part of the string rather than a separate argument so the *shape* of the identity is one
 * thing: `host \n voice \n text`. Every render passes the endpoint it actually used, so the same words
 * spoken by two builds are two files. Files written before the picker existed keep playing because a row
 * stores the hash it was given — the formula only decides what a *new* render looks for.
 *
 * SHA-256 rather than `Bun.hash`: that is a 64-bit wyhash, which would only yield 16 hex characters — half
 * the width this format promises — and content addressing is exactly the place a weak hash is expensive.
 */
export const hashFor = (voice: string, text: string, host?: string) =>
  new Bun.CryptoHasher("sha256").update(`${host ?? ""}\n${voice}\n${text}`).digest("hex").slice(0, 32)

export const directory = () => path.join(Global.Path.data, "commentary-audio")

const file = (hash: string) => path.join(directory(), `${hash}.mp3`)

/** One voice as one endpoint describes it. `aliases` are the other names the same endpoint accepts. */
export interface VoiceInfo {
  readonly name: string
  readonly locale?: string
  readonly friendly?: string
  readonly aliases: readonly string[]
}

/**
 * One endpoint's answer. `error` is set instead of `voices` when that endpoint could not be asked, which is
 * information the picker shows rather than a reason to fail the whole request — one of two speech boxes
 * being down must not empty the list of the other.
 */
export interface VoiceSource {
  readonly host: string
  readonly voices: readonly VoiceInfo[]
  readonly error?: string
}

/**
 * Fold whatever shape a service uses into one list.
 *
 * The two builds disagree, and both shapes are in the wild: the Azure-compatible one sends
 * `{data: [{name, locale, …}], aliases: {cantonese: "zh-HK-HiuMaanNeural", …}}` with no per-entry aliases,
 * while the newer one sends `aliases` **on the entry** and a flat alias map. Reading only the top-level map
 * would lose the new build's 17 names, and reading only the entry would lose the old one's 23 — so both are
 * read, and an alias is kept only if it is not already a voice's own name.
 */
type VoiceEntry = {
  readonly locale?: string
  readonly friendly?: string
  readonly aliases: Set<string>
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)

export function parseVoices(body: unknown): VoiceInfo[] {
  if (!body || typeof body !== "object") return []
  const data = (body as { data?: unknown }).data
  const entries = Array.isArray(data) ? data : []
  const byName = new Map<string, VoiceEntry>()
  for (const candidate of entries) {
    if (!candidate || typeof candidate !== "object") continue
    const info = candidate as { name?: unknown; locale?: unknown; friendly_name?: unknown; friendlyName?: unknown; aliases?: unknown }
    const name = text(info.name)
    if (!name) continue
    const existing = byName.get(name)
    if (existing) {
      // A duplicate name in one response: keep the first record's fields and merge the aliases, so a list
      // that repeats a voice does not silently drop half of its names.
      if (Array.isArray(info.aliases)) {
        for (const alias of info.aliases) {
          const value = text(alias)
          if (value) existing.aliases.add(value)
        }
      }
      continue
    }
    const aliases = new Set<string>()
    if (Array.isArray(info.aliases)) {
      for (const alias of info.aliases) {
        const value = text(alias)
        if (value) aliases.add(value)
      }
    }
    byName.set(name, {
      locale: text(info.locale),
      friendly: text(info.friendly_name) ?? text(info.friendlyName),
      aliases,
    })
  }
  // The flat map is alias -> real name, which is the inverse of what the entry form carries. An alias naming a
  // voice the endpoint never listed is ignored rather than invented: a picker offering a name the service will
  // reject is worse than one missing a name.
  const flat = (body as { aliases?: unknown }).aliases
  if (flat && typeof flat === "object" && !Array.isArray(flat)) {
    for (const [alias, target] of Object.entries(flat)) {
      if (typeof target !== "string") continue
      const entry = byName.get(target)
      const name = text(alias)
      if (!entry || !name || name === target) continue
      entry.aliases.add(name)
    }
  }
  return [...byName].map(([name, entry]) => ({
    name,
    ...(entry.locale ? { locale: entry.locale } : {}),
    ...(entry.friendly ? { friendly: entry.friendly } : {}),
    aliases: [...entry.aliases].sort(),
  }))
}

export interface Interface {
  /**
   * Render `text` and return its hash, or `undefined` when there is no audio for it. Never fails the caller:
   * a line that cannot be spoken is a line that stays text-only.
   *
   * The hash is held in the in-flight guard until `release` is called, so a global retention sweep cannot
   * delete the file between the write and the row commit. The caller must call `release` once the row is
   * committed.
   */
  readonly render: (input: { text: string; voice?: string; host?: string }) => Effect.Effect<string | undefined>
  /**
   * What each endpoint says it can speak, for the client's voice picker. One bad endpoint must not empty the
   * picker, so every host is reported independently and a failure is reported *as data* (`error`) rather than
   * as a failed effect.
   */
  readonly voices: (input: {
    hosts: readonly string[]
    /** Bypass the cache. A picker the reader just opened after the service moved wants the truth. */
    refresh?: boolean
  }) => Effect.Effect<Array<VoiceSource>>
  /** Release an in-flight render guard once the row referencing it has been committed. */
  readonly release: (hash: string) => Effect.Effect<void>
  /** The stored bytes, or `undefined` when the hash is unknown, malformed, or the file has been swept. */
  readonly read: (hash: string) => Effect.Effect<Uint8Array | undefined>
  /** Whether a file for this hash is actually on disk. Used to find rows pointing at nothing. */
  readonly exists: (hash: string) => Effect.Effect<boolean>
  /**
   * Drop stored audio nothing points at any more. `keep` is the set of hashes still referenced by surviving
   * commentary rows; anything else on disk — unless it is still being rendered — is unreachable and removed.
   */
  readonly sweep: (keep: ReadonlySet<string>) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode-ai/CommentaryAudio") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const http = yield* HttpClient.HttpClient

  // Hashes currently being rendered. A file is on disk, then committed to its row a moment later; a global
  // retention sweep in that window would otherwise think the file is orphaned and delete it before the row
  // ever points at it, breaking playback permanently. `sweep` unions this in, so a file is never removed
  // while its render is in flight.
  const rendering = new Set<string>()

  const render: Interface["render"] = (input) =>
    Effect.gen(function* () {
      const voice = input.voice?.trim() || DEFAULT_VOICE
      const base = speechBaseUrl(input.host)
      // A host the guard refuses is a configuration error, not a transient one: say so once, and leave the
      // line text-only rather than retrying it on every tick.
      if (!base) {
        yield* Effect.logWarning("commentary audio host refused", { host: input.host })
        return undefined
      }
      const hash = hashFor(voice, input.text, input.host?.trim() || undefined)
      const target = file(hash)
      const existing = yield* fs.exists(target).pipe(Effect.catchCause(() => Effect.succeed(false)))
      // Content-addressed, so an existing file is the right answer for this exact text and voice.
      if (existing) return hash

      rendering.add(hash)
      const written = yield* Effect.gen(function* () {
        const fetched = yield* http
          .execute(
            HttpClientRequest.post(`${base}/v1/audio/speech`, {
              headers: new Headers({ "content-type": "application/json" }),
              body: HttpBody.jsonUnsafe({ input: input.text, voice }),
            }),
          )
          .pipe(
            Effect.timeout(RENDER_TIMEOUT),
            Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause))),
          )

        if (typeof fetched === "string") {
          yield* Effect.logWarning("commentary audio render failed", { cause: fetched })
          return false
        }
        if (fetched.status !== 200) {
          yield* Effect.logWarning("commentary audio service refused", { status: fetched.status })
          return false
        }
        const declared = Number(fetched.headers["content-length"] ?? "")
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
          yield* Effect.logWarning("commentary audio too large", { bytes: declared })
          return false
        }
        const audio = yield* fetched.arrayBuffer.pipe(
          Effect.map((buffer) => new Uint8Array(buffer)),
          Effect.catchCause(() => Effect.succeed(new Uint8Array(0))),
        )
        if (audio.byteLength === 0 || audio.byteLength > MAX_RESPONSE_BYTES) {
          yield* Effect.logWarning("commentary audio empty or oversized", { bytes: audio.byteLength })
          return false
        }

        yield* fs.makeDirectory(directory(), { recursive: true }).pipe(Effect.catchCause(() => Effect.void))
        yield* fs.writeFile(target, audio).pipe(
          Effect.catchCause((cause) => Effect.logWarning("commentary audio write failed", { cause: Cause.pretty(cause) })),
        )
        return true
      })
      return written ? hash : undefined
    })

  const read: Interface["read"] = (hash) =>
    Effect.gen(function* () {
      // The hash arrives in a URL path segment, so it is checked against the exact shape before it is ever
      // joined onto a directory. Anything else is a 404, not a filesystem probe.
      if (!HASH_PATTERN.test(hash)) return undefined
      const target = file(hash)
      const present = yield* fs.exists(target).pipe(Effect.catchCause(() => Effect.succeed(false)))
      if (!present) return undefined
      return yield* fs.readFile(target).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    })

  const exists: Interface["exists"] = (hash) =>
    Effect.gen(function* () {
      if (!HASH_PATTERN.test(hash)) return false
      return yield* fs.exists(file(hash)).pipe(Effect.catchCause(() => Effect.succeed(false)))
    })

  const sweep: Interface["sweep"] = (keep) =>
    Effect.gen(function* () {
      const present = yield* fs
        .readDirectory(directory())
        .pipe(Effect.catchCause(() => Effect.succeed([] as Array<string>)))
      // Content addressing means two rows can share a file, so `keep` — plus whatever is still being rendered
      // right now — is what decides. Unlinking anything in either set would break playback for the row that
      // has it, or for the render that is a file-write away from committing it.
      const protected_ = new Set<string>([...keep, ...rendering])
      const orphans = present.filter((name) => name.endsWith(".mp3") && !protected_.has(name.slice(0, -".mp3".length)))
      let removed = 0
      for (const name of orphans) {
        const unlinked = yield* fs
          .remove(path.join(directory(), name))
          .pipe(Effect.as(true), Effect.catchCause(() => Effect.succeed(false)))
        if (unlinked) removed++
      }
      if (removed) yield* Effect.log("commentary audio swept", { removed })
      return removed
    })

  const release: Interface["release"] = (hash) =>
    Effect.sync(() => {
      rendering.delete(hash)
    })

  /**
   * The catalogue for one endpoint, cached by host. A restart of the speech service changes what it can
   * speak, so the TTL is minutes rather than the life of the process, and `refresh` exists for the reader who
   * just watched the picker show a voice that has since gone.
   *
   * A **failure** is cached for a tenth of that, and the reason is that this is the one endpoint anyone
   * restarts: measured on 2026-10-01, `:8881` refused connections for ~90 s and then answered. Caching a
   * refusal for ten minutes would have kept the picker empty long after the service came back.
   */
  const CATALOGUE_ERROR_TTL_MS = CATALOGUE_TTL_MS / 10
  const catalogue = new Map<string, { at: number; ttl: number; source: VoiceSource }>()

  const oneHost = (host: string, refresh: boolean) =>
    Effect.gen(function* () {
      const base = speechBaseUrl(host)
      if (!base) return { host, voices: [], error: "host refused" } satisfies VoiceSource
      const cached = catalogue.get(host)
      if (!refresh && cached && Date.now() - cached.at < cached.ttl) return cached.source

      const source: VoiceSource = yield* Effect.gen(function* () {
        const fetched = yield* http
          .execute(HttpClientRequest.get(`${base}/v1/audio/voices`))
          .pipe(
            Effect.timeout(CATALOGUE_TIMEOUT),
            Effect.catchCause((cause) => Effect.succeed(Cause.pretty(cause) as string)),
          )
        if (typeof fetched === "string") return { host, voices: [], error: fetched } satisfies VoiceSource
        if (fetched.status !== 200) {
          return { host, voices: [], error: `status ${fetched.status}` } satisfies VoiceSource
        }
        const declared = Number(fetched.headers["content-length"] ?? "")
        if (Number.isFinite(declared) && declared > MAX_CATALOGUE_BYTES) {
          return { host, voices: [], error: `catalogue too large (${declared} bytes)` } satisfies VoiceSource
        }
        const text = yield* fetched.text.pipe(Effect.catchCause(() => Effect.succeed("")))
        if (text.length > MAX_CATALOGUE_BYTES) {
          return { host, voices: [], error: "catalogue too large" } satisfies VoiceSource
        }
        let body: unknown
        try {
          body = JSON.parse(text)
        } catch {
          return { host, voices: [], error: "not json" } satisfies VoiceSource
        }
        const voices = parseVoices(body)
        // An endpoint that answers 200 with nothing usable is a failure the reader must see, or the picker
        // would show an empty group and look like the service has no voices.
        if (voices.length === 0) return { host, voices: [], error: "no voices in catalogue" } satisfies VoiceSource
        return { host, voices } satisfies VoiceSource
      })

      catalogue.set(host, {
        at: Date.now(),
        ttl: source.error ? CATALOGUE_ERROR_TTL_MS : CATALOGUE_TTL_MS,
        source,
      })
      if (source.error) yield* Effect.logWarning("commentary voices unavailable", { host, error: source.error })
      return source
    })

  const voices: Interface["voices"] = (input) =>
    Effect.forEach(input.hosts, (host) => oneHost(host, input.refresh === true), { concurrency: "unbounded" })

  return Service.of({ render, voices, read, exists, sweep, release })
})

export const layer = Layer.effect(Service, make)

export const defaultLayer = layer

export const node = LayerNode.make({ service: Service, layer, deps: [filesystem, httpClient] })

export * as CommentaryAudio from "./commentary-audio"
