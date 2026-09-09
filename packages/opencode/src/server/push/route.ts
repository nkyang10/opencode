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
//
// Push.Service is resolved while the router layer is constructed (inside
// HttpRouter.use's Effect.gen) and captured into the handler closures, matching
// the login/SPA routes. Requesting services from inside the raw handlers has no
// service environment to draw from.

function jsonResponse(status: number, body: unknown) {
  return HttpServerResponse.jsonUnsafe(body, { status })
}

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

const pubKey = (push: Push.Interface) => () =>
  Effect.succeed(jsonResponse(200, { publicKey: push.pubKey() }))

const subscribe =
  (push: Push.Interface) => (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const sub = yield* parseSubscription(yield* readBody(request))
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
        return jsonResponse(400, { error: "missing endpoint or keys" })
      }
      yield* push.subscribe(sub)
      return jsonResponse(200, { ok: true })
    })

const unsubscribe =
  (push: Push.Interface) => (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const body = yield* parseEndpoint(yield* readBody(request))
      if (!body?.endpoint) return jsonResponse(400, { error: "missing endpoint" })
      yield* push.unsubscribe(body.endpoint)
      return jsonResponse(200, { ok: true })
    })

const authOnlyRouterLayer = authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.layer))

export const pushRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const push = yield* Push.Service
    yield* router.add("GET", "/api/push/pubkey", pubKey(push))
    yield* router.add("POST", "/api/push/subscribe", subscribe(push))
    yield* router.add("POST", "/api/push/unsubscribe", unsubscribe(push))
  }),
).pipe(Layer.provide(authOnlyRouterLayer))
