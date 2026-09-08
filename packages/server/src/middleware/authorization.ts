import { ServerAuth } from "../auth"
import { UnauthorizedError } from "@opencode-ai/protocol/errors"
import { Authorization } from "@opencode-ai/protocol/middleware/authorization"
export { Authorization } from "@opencode-ai/protocol/middleware/authorization"
import { hasPtyConnectTicketURL } from "@opencode-ai/protocol/groups/pty"
import { Effect, Encoding, Layer, Redacted } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

const AUTH_TOKEN_QUERY = "auth_token"
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

function emptyCredential() {
  return { username: "", password: Redacted.make("") }
}

function decodeCredential(input: string) {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return { username: header.slice(0, separator), password: Redacted.make(header.slice(separator + 1)) }
      },
    }),
  )
}

// -- Landing-page auth (FE-001): a persistent auth cookie so the login survives
// iOS "Add to Home Screen" shortcuts and restarts. Value is the same
// base64(user:pass) token used by the Basic `Authorization` header.
export const AUTH_COOKIE = "oc_creds"
export const AUTH_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60

export function parseCookies(request: HttpServerRequest.HttpServerRequest): ReadonlyMap<string, string> {
  const header = request.headers.cookie ?? ""
  const cookies = new Map<string, string>()
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
  }
  return cookies
}

export function cookieAuthToken(request: HttpServerRequest.HttpServerRequest): string | null {
  return parseCookies(request).get(AUTH_COOKIE) ?? null
}

export function authCookieHeader(username: string, password: string, remember: boolean): string {
  const token = Buffer.from(`${username}:${password}`).toString("base64")
  const maxAge = remember ? `; Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}` : ""
  return `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax${maxAge}`
}

export function clearAuthCookieHeader(): string {
  return `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

// The landing page / logout endpoints are reachable without credentials.
export function isLoginPath(method: string, pathname: string): boolean {
  return method === "GET" && (pathname === "/login" || pathname === "/logout") || method === "POST" && pathname === "/login"
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  const url = new URL(request.url, "http://localhost")
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  const cookie = cookieAuthToken(request)
  if (cookie) return decodeCredential(cookie)
  return Effect.succeed(emptyCredential())
}

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const config = yield* ServerAuth.Config
    if (!ServerAuth.required(config)) return Authorization.of((effect) => effect)
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        // Browsers cannot set headers on WebSocket upgrades, so a ticketed PTY connect skips
        // credential checks here; the connect handler consumes and validates the ticket.
        if (hasPtyConnectTicketURL(new URL(request.url, "http://localhost"))) return yield* effect
        const credential = yield* credentialFromRequest(request)
        if (ServerAuth.authorized(credential, config)) return yield* effect
        yield* HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
        )
        return yield* new UnauthorizedError({ message: "Authentication required" })
      }),
    )
  }),
)
