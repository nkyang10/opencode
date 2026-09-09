import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { Session } from "@/session/session"
import { SessionID } from "@/session/schema"
import { InstanceStore } from "@/project/instance-store"
import { Context, Effect, Layer } from "effect"
import { Stream } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import webpush from "web-push"

// FE-004: Web Push for iOS. When a session reaches its finished "idle" state the
// server pushes a notification to every registered browser, so the user is told
// to come back and check the result even when the tab/app is in the background
// (iOS suspends background tabs, so this must come from the server; standards:
// RFC 8030 + RFC 8291, VAPID auth).

export interface Subscription {
  endpoint: string
  expirationTime?: number | null
  keys: { p256dh: string; auth: string }
}

export interface Interface {
  readonly pubKey: () => string
  readonly subscribe: (sub: Subscription) => Effect.Effect<void>
  readonly unsubscribe: (endpoint: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Push") {}

const stateFile = () => path.join(Global.Path.state, "push", "subscriptions.json")
const keyFile = () => path.join(Global.Path.state, "push", "vapid.json")

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

    const subDir = path.join(Global.Path.state, "push")
    yield* Effect.tryPromise(() => fs.mkdir(subDir, { recursive: true })).pipe(Effect.orDie)

    // VAPID keys: generate once and persist at the process level, otherwise
    // existing subscriptions break on the next boot (VapidPkHashMismatch).
    let keys = yield* Effect.tryPromise(() => readJson<webpush.VapidKeys | null>(keyFile(), null)).pipe(Effect.orDie)
    if (!keys?.publicKey || !keys?.privateKey) {
      keys = webpush.generateVAPIDKeys()
      yield* Effect.tryPromise(() => fs.writeFile(keyFile(), JSON.stringify(keys, null, 2), "utf8")).pipe(Effect.orDie)
    }
    webpush.setVapidDetails("mailto:opencode@localhost", keys.publicKey, keys.privateKey)

    let subscriptions: Subscription[] = yield* Effect.tryPromise(
      () => readJson<Subscription[]>(stateFile(), []),
    ).pipe(Effect.orDie)
    const persist = () => fs.writeFile(stateFile(), JSON.stringify(subscriptions, null, 2), "utf8")

    const sessionMeta = (directory: string, id: string) =>
      instanceStore.provide({ directory }, session.get(SessionID.make(id))).pipe(
        Effect.map((info) => ({
          title: info.title || `Session ${id.slice(0, 8)}`,
          child: Boolean(info.parentID),
        })),
        Effect.catchCause(() => Effect.succeed({ title: `Session ${id.slice(0, 8)}`, child: false })),
      )

    // Notifier: watch the process-wide event stream for finished sessions and
    // push a notification to every registered browser. Child (sub-agent) sessions
    // are skipped to match the in-app notification behavior.
    const notifier = events.all().pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.type !== "session.status") return
          const data = event.data as { sessionID: string; status: { type: string } }
          if (!data?.sessionID || data.status?.type !== "idle") return
          if (!subscriptions.length) return

          const directory = String(event.location?.directory ?? "")
          const meta = yield* sessionMeta(directory, data.sessionID)
          if (meta.child) return

          const url = directory
            ? `/${Buffer.from(directory).toString("base64url")}/session/${data.sessionID}`
            : `/session/${data.sessionID}`
          const payload = JSON.stringify({ title: meta.title, body: "An OpenCode session finished.", url })

          for (const sub of subscriptions) {
            yield* Effect.tryPromise(() =>
              webpush.sendNotification(sub, payload, { TTL: 60, urgency: "high" }),
            ).pipe(Effect.catchCause((cause) => Effect.logWarning("push send failed", { cause })))
          }
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("push notifier error", { cause }))),
      ),
      Effect.forkScoped,
    )
    yield* notifier

    return Service.of({
      pubKey: () => keys.publicKey,
      subscribe: (sub) =>
        Effect.sync(() => {
          if (!subscriptions.some((s) => s.endpoint === sub.endpoint)) {
            subscriptions = [...subscriptions, { ...sub, expirationTime: sub.expirationTime ?? null }]
            void persist().catch(() => {})
          }
        }),
      unsubscribe: (endpoint) =>
        Effect.sync(() => {
          subscriptions = subscriptions.filter((s) => s.endpoint !== endpoint)
          void persist().catch(() => {})
        }),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [EventV2.node, Session.node, InstanceStore.node],
})

export * as Push from "./push"
