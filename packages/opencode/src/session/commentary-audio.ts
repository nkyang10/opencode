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
/** Files kept per session. Each line is 12-41 KB, so this is a few MB of narration. */
export const DEFAULT_RETENTION = 100
/** Ceiling across every session. */
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024

const RENDER_TIMEOUT = "30 seconds"
/** A 2000-char line is ~40 KB of audio; anything far past that is a wrong endpoint, not speech. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

/** 32 hex chars is 128 bits — no plausible number of lines collides, and it stays a legal path segment. */
export const HASH_PATTERN = /^[0-9a-f]{32}$/

/**
 * The identity of a piece of audio. The voice is part of it so that changing the voice invalidates the store
 * instead of replaying what the previous voice said for the same words.
 *
 * SHA-256 rather than `Bun.hash`: that is a 64-bit wyhash, which would only yield 16 hex characters — half
 * the width this format promises — and content addressing is exactly the place a weak hash is expensive.
 */
export const hashFor = (voice: string, text: string) =>
  new Bun.CryptoHasher("sha256").update(`${voice}\n${text}`).digest("hex").slice(0, 32)

export const directory = () => path.join(Global.Path.data, "commentary-audio")

const file = (hash: string) => path.join(directory(), `${hash}.mp3`)

export interface Interface {
  /**
   * Render `text` and return its hash, or `undefined` when there is no audio for it. Never fails the caller:
   * a line that cannot be spoken is a line that stays text-only.
   */
  readonly render: (input: { text: string; voice?: string; host?: string }) => Effect.Effect<string | undefined>
  /** The stored bytes, or `undefined` when the hash is unknown, malformed, or the file has been swept. */
  readonly read: (hash: string) => Effect.Effect<Uint8Array | undefined>
  /**
   * Drop stored audio nothing points at any more. `keep` is the set of hashes still referenced by surviving
   * commentary rows; anything else on disk is unreachable and is removed.
   */
  readonly sweep: (keep: ReadonlySet<string>) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode-ai/CommentaryAudio") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const http = yield* HttpClient.HttpClient

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
      const hash = hashFor(voice, input.text)
      const target = file(hash)
      const existing = yield* fs.exists(target).pipe(Effect.catchCause(() => Effect.succeed(false)))
      // Content-addressed, so an existing file is the right answer for this exact text and voice.
      if (existing) return hash

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
        return undefined
      }
      if (fetched.status !== 200) {
        yield* Effect.logWarning("commentary audio service refused", { status: fetched.status })
        return undefined
      }
      const declared = Number(fetched.headers["content-length"] ?? "")
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
        yield* Effect.logWarning("commentary audio too large", { bytes: declared })
        return undefined
      }
      const audio = yield* fetched.arrayBuffer.pipe(
        Effect.map((buffer) => new Uint8Array(buffer)),
        Effect.catchCause(() => Effect.succeed(new Uint8Array(0))),
      )
      if (audio.byteLength === 0 || audio.byteLength > MAX_RESPONSE_BYTES) {
        yield* Effect.logWarning("commentary audio empty or oversized", { bytes: audio.byteLength })
        return undefined
      }

      yield* fs.makeDirectory(directory(), { recursive: true }).pipe(Effect.catchCause(() => Effect.void))
      yield* fs
        .writeFile(target, audio)
        .pipe(Effect.catchCause((cause) => Effect.logWarning("commentary audio write failed", { cause: Cause.pretty(cause) })))
      return hash
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

  const sweep: Interface["sweep"] = (keep) =>
    Effect.gen(function* () {
      const present = yield* fs
        .readDirectory(directory())
        .pipe(Effect.catchCause(() => Effect.succeed([] as Array<string>)))
      // Content addressing means two rows can share a file, so `keep` — the hashes surviving rows still point
      // at — is what decides. Unlinking anything still in it would break playback for the row that has it.
      const orphans = present.filter((name) => name.endsWith(".mp3") && !keep.has(name.slice(0, -".mp3".length)))
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

  return Service.of({ render, read, sweep })
})

export const layer = Layer.effect(Service, make)

export const defaultLayer = layer

export const node = LayerNode.make({ service: Service, layer, deps: [filesystem, httpClient] })

export * as CommentaryAudio from "./commentary-audio"
