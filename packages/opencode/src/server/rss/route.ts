import { Rss } from "@/rss/rss"
import { ServerAuth } from "@/server/auth"
import { authorizationRouterMiddleware } from "@/server/routes/instance/httpapi/middleware/authorization"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

// FE-019: RSS feed routes.
//
//  GET /rss/:token  — PUBLIC by token. No login / session required; the token is the
//                     only credential. Returns RSS 2.0 XML or 404 for an unknown token.
//  GET /api/rss/url — AUTH-gated (same layer as the push routes and login page). Returns
//                     { url } so the authenticated Settings page can surface the private
//                     feed URL for the current user to copy.
//
// Services are resolved while the router layer is constructed (inside HttpRouter.use's
// Effect.gen) and captured into the handler closures, matching the login/SPA and push
// routes: requesting services from inside the raw handlers has no service environment.

const xmlEscape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")

const KIND_LABEL: Record<Rss.RssKind, string> = {
  finished: "Session finished",
  error: "Error",
  permission: "Permission required",
  question: "Question",
}

const rssDocument = (origin: string, items: ReadonlyArray<Rss.RssItem>) => {
  const itemTags = items
    .map((item) => {
      const pubDate = new Date(item.ts).toUTCString()
      return `<item>
    <title>${xmlEscape(item.title)}</title>
    <link>${xmlEscape(origin + item.url)}</link>
    <description>${xmlEscape(KIND_LABEL[item.kind])}</description>
    <guid isPermaLink="false">${xmlEscape(item.id)}</guid>
    <pubDate>${xmlEscape(pubDate)}</pubDate>
  </item>`
    })
    .join("\n  ")
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>OpenCode notifications</title>
    <link>${xmlEscape(origin)}/</link>
    <description>Session finished, error, permission and question notifications from OpenCode.</description>
    <ttl>1</ttl>
    ${itemTags}
  </channel>
</rss>`
}

const originOf = (request: HttpServerRequest.HttpServerRequest) => {
  const url = new URL(request.url, "http://localhost")
  return url.origin
}

const authOnlyRouterLayer = authorizationRouterMiddleware.layer.pipe(Layer.provide(ServerAuth.Config.layer))

export const rssFeedRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const rss = yield* Rss.Service

    const feed = (request: HttpServerRequest.HttpServerRequest) =>
      Effect.gen(function* () {
        const params = yield* HttpRouter.params
        const token = params["token"]
        if (!token) return HttpServerResponse.text("Not found", { status: 404 })
        const items = yield* rss.feed(token)
        if (!items) return HttpServerResponse.text("Not found", { status: 404 })
        const origin = originOf(request)
        const body = rssDocument(origin, items)
        return HttpServerResponse.text(body, {
          status: 200,
          headers: {
            "Content-Type": "application/rss+xml; charset=utf-8",
            "Cache-Control": "no-store",
          },
        })
      })

    yield* router.add("GET", "/rss/:token", feed)
  }),
)

export const rssUrlRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const rss = yield* Rss.Service
    const config = yield* ServerAuth.Config
    const username = config.username

    const url = () => Effect.succeed(HttpServerResponse.jsonUnsafe({ url: rss.feedUrl(username) }))

    yield* router.add("GET", "/api/rss/url", () => url())
  }),
).pipe(Layer.provide(authOnlyRouterLayer), Layer.provide(ServerAuth.Config.layer))
