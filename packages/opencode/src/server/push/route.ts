import { Push } from "@/push/push"
import { ServerAuth } from "@/server/auth"
import { authorizationRouterMiddleware } from "@/server/routes/instance/httpapi/middleware/authorization"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

// FE-004 push endpoints. Raw routes layered with the same auth-only router
// middleware as the login page: only an authenticated browser (oc_creds cookie)
// can register/unregister push subscriptions. GET /api/push/pubkey returns the
// public VAPID application-server key the client uses to subscribe; exposing it
// is harmless but we still gate it for consistency.

function jsonResponse(status: number, body: unknown) {
  return HttpServerResponse.jsonUnsafe(body, { status })
}

const authOnlyRouterLayer = authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.layer))

const pubKey = () =>
  Effect.gen(function* () {
    const push = yield* Push.Service
    return jsonResponse(200, { publicKey: push.pubKey() })
  })

const readBody = (request: HttpServerRequest.HttpServerRequest) =>
  request.text.pipe(Effect.orElseSucceed(() => ""))

const parseSubscription = (text: string) =>
  Effect.sync(() => {
    try {
      return JSON.parse(text) as Push.Subscription
    } catch {
      return undefined as Push.Subscription | undefined
    }
  })

const parseEndpoint = (text: string) =>
  Effect.sync(() => {
    try {
      return JSON.parse(text) as { endpoint?: string }
    } catch {
      return undefined as { endpoint?: string } | undefined
    }
  })

const subscribe = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const push = yield* Push.Service
    const sub = yield* parseSubscription(yield* readBody(request))
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      return jsonResponse(400, { error: "missing endpoint or keys" })
    }
    yield* push.subscribe(sub)
    return jsonResponse(200, { ok: true })
  })

const unsubscribe = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const push = yield* Push.Service
    const body = yield* parseEndpoint(yield* readBody(request))
    if (!body?.endpoint) return jsonResponse(400, { error: "missing endpoint" })
    yield* push.unsubscribe(body.endpoint)
    return jsonResponse(200, { ok: true })
  })

export const pushRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    yield* router.add("GET", "/api/push/pubkey", pubKey)
    yield* router.add("POST", "/api/push/subscribe", subscribe)
    yield* router.add("POST", "/api/push/unsubscribe", unsubscribe)
  }),
).pipe(Layer.provide(authOnlyRouterLayer))
