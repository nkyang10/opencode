import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { InstanceStore } from "@/project/instance-store"
import { Context, Effect, Layer } from "effect"
import { Stream } from "effect"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

// FE-019: Per-user RSS notification feed. A duplicate channel of the notifications
// opencode fires (session finished / error / question / permission), served on the
// same port as the web UI without any login. The feed is keyed by an un-brute-forceable
// random token (256-bit CSPRNG) that acts as the only credential, so the contents must
// stay non-sensitive: session tab title + tab URL only. The feed URL is surfaced on
// the Settings page (authed) for the user to copy.

export type RssKind = "finished" | "error" | "permission" | "question"

export type RssItem = {
  readonly id: string
  readonly kind: RssKind
  readonly title: string
  readonly url: string
  readonly ts: number
}

export function newToken() {
  return crypto.randomBytes(32).toString("hex")
}

export interface Interface {
  readonly feedUrl: (username: string) => string
  readonly feed: (token: string) => Effect.Effect<ReadonlyArray<RssItem> | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Rss") {}

const MAX_ITEMS = 20

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, "utf8")
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const session = yield* Session.Service
    const instanceStore = yield* InstanceStore.Service

    const dir = path.join(Global.Path.state, "rss")
    yield* Effect.tryPromise(() => fs.mkdir(path.join(dir, "feeds"), { recursive: true })).pipe(Effect.orDie)

    const tokensFile = () => path.join(dir, "tokens.json")
    const feedFile = (token: string) => path.join(dir, "feeds", `${token}.json`)

    // username -> token. One un-brute-forceable RSS URL per user; created lazily on
    // the first Settings-page request for that user.
    let tokens: Record<string, string> = yield* Effect.tryPromise(() =>
      readJson<Record<string, string>>(tokensFile(), {}),
    ).pipe(Effect.orDie)
    const persistTokens = () => fs.writeFile(tokensFile(), JSON.stringify(tokens, null, 2), "utf8")

    const cache = new Map<string, RssItem[]>()

    const loadFeed = (token: string) =>
      Effect.tryPromise(() => readJson<RssItem[]>(feedFile(token), [])).pipe(Effect.orDie)

    const append = (token: string, item: RssItem) =>
      Effect.gen(function* () {
        const existing = cache.get(token) ?? (yield* loadFeed(token))
        const next = [...existing, item].slice(-MAX_ITEMS)
        cache.set(token, next)
        yield* Effect.tryPromise(() => fs.writeFile(feedFile(token), JSON.stringify(next, null, 2), "utf8"))
      }).pipe(Effect.orDie)

    const appendToAll = (item: RssItem) =>
      Effect.forEach(Object.values(tokens), (token) =>
        append(token, item).pipe(Effect.catchCause(() => Effect.void)),
      )

    const sessionMeta = (directory: string, id: string) =>
      instanceStore.provide({ directory }, session.get(SessionID.make(id))).pipe(
        Effect.map((info) => ({
          title: info.title || `Session ${id.slice(0, 8)}`,
          child: Boolean(info.parentID),
        })),
        Effect.catchCause(() => Effect.succeed({ title: `Session ${id.slice(0, 8)}`, child: false })),
      )

    const eventUrl = (directory: string | undefined, id: string) =>
      directory
        ? `/${Buffer.from(directory).toString("base64url")}/session/${id}`
        : `/session/${id}`

    // Notifier: watch the process-wide event stream and append the same events the
    // push notifier / in-app notifications surface — session finished, error, question
    // and permission asked. Content is non-sensitive: session title + tab URL. Child
    // (sub-agent) sessions are skipped to match the in-app notification behavior.
    const notifier = events.all().pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.type === "session.status") {
            const data = event.data as { sessionID: string; status: { type: string } }
            if (!data?.sessionID || data.status?.type !== "idle") return
            const directory = String(event.location?.directory ?? "")
            const meta = yield* sessionMeta(directory, data.sessionID)
            if (meta.child) return
            yield* appendToAll({
              id: `${event.id}`,
              kind: "finished",
              title: meta.title,
              url: eventUrl(directory, data.sessionID),
              ts: Date.now(),
            })
            return
          }

          if (
            event.type === "session.error" ||
            event.type === "permission.v2.asked" ||
            event.type === "question.v2.asked"
          ) {
            const data = event.data as { sessionID: string }
            const id = data?.sessionID
            if (!id) return
            const kind: RssKind =
              event.type === "session.error"
                ? "error"
                : event.type === "permission.v2.asked"
                  ? "permission"
                  : "question"
            const directory = String(event.location?.directory ?? "")
            const meta = yield* sessionMeta(directory, id)
            if (meta.child) return
            yield* appendToAll({
              id: `${event.id}`,
              kind,
              title: meta.title,
              url: eventUrl(directory, id),
              ts: Date.now(),
            })
            return
          }
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("rss notifier error", { cause }))),
      ),
      Effect.forkScoped,
    )
    yield* notifier

    return Service.of({
      feedUrl: (username) => {
        let token = tokens[username]
        if (!token) {
          token = newToken()
          tokens = { ...tokens, [username]: token }
          void persistTokens().catch(() => {})
        }
        return `/rss/${token}`
      },
      feed: (token) => {
        if (!Object.values(tokens).includes(token)) return Effect.succeed(undefined)
        const cached = cache.get(token)
        if (cached) return Effect.succeed(cached)
        return loadFeed(token).pipe(Effect.map((items) => (cache.set(token, items), items)))
      },
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [EventV2.node, Session.node, InstanceStore.node],
})

export * as Rss from "./rss"
