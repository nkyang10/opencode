import { ServerAuth } from "@/server/auth"
import { authCookieHeader, clearAuthCookieHeader } from "@opencode-ai/server/middleware/authorization"
import { Effect, Option, Redacted } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as UrlParams from "effect/unstable/http/UrlParams"

// FE-001: landing page that replaces the bare Basic-auth prompt. The page
// accepts the same credentials as the server (OPENCODE_SERVER_USERNAME /
// OPENCODE_SERVER_PASSWORD), optionally persists them in a long-lived cookie
// ("save auth forever"), and redirects back to the originally requested path.

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

// Only relative paths are accepted as redirect targets (no open redirect).
function sanitizeReturnPath(raw: string | null | undefined): string {
  if (!raw) return ""
  if (raw.indexOf("://") !== -1 || raw.startsWith("//")) return ""
  return raw.startsWith("/") ? raw : "/"
}

export function loginPageHTML(opts: { error?: boolean; next?: string } = {}): string {
  const next = sanitizeReturnPath(opts.next)
  const error = opts.error ? "1" : ""
  const banner = opts.error
    ? `<div class="error" role="alert">Sign-in failed — check your username and password.</div>`
    : ""
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Sign in · opencode</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #fafafa; color: #161616; font: 15px/1.5 Inter, -apple-system, "Segoe UI", Roboto, sans-serif;
    padding: 16px;
  }
  .card {
    width: 100%; max-width: 360px; background: #ffffff; border: 1px solid #eeeeee;
    border-radius: 12px; padding: 28px 24px; box-shadow: 0 8px 24px rgba(0,0,0,.06);
  }
  .logo { font: 700 20px/1 "JetBrainsMono Nerd Font Mono", Menlo, monospace; letter-spacing: .5px; margin-bottom: 4px; color: #161616; }
  .logo span { color: #3b5cf6; }
  .sub { color: #3a3a3a; margin: 4px 0 22px; font-size: 13px; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 6px; color: #2e2e2e; }
  input[type="text"], input[type="password"] {
    width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #dddddd;
    background: #ffffff; color: #161616; font-size: 15px;
  }
  input:focus { outline: 2px solid #3b5cf6; outline-offset: 0; border-color: #3b5cf6; }
  .row { display: flex; align-items: center; justify-content: space-between; margin: 16px 0 20px; }
  .row label { margin: 0; font-weight: 400; font-size: 14px; display: flex; align-items: center; gap: 8px; color: #3a3a3a; }
  button {
    width: 100%; padding: 11px; border: 0; border-radius: 8px; background: #3b5cf6; color: #fff;
    font: 600 15px/1 inherit; cursor: pointer;
  }
  button:hover { background: #3250df; }
  .error {
    background: #fff1f2; border: 1px solid #f1484f; color: #c2272e; border-radius: 8px;
    padding: 10px 12px; font-size: 13px; margin-bottom: 6px;
  }
  .hint { color: #aeaeae; font-size: 12px; margin-top: 18px; }
  a { color: #3b5cf6; text-decoration: none; }
</style>
</head>
<body>
  <form class="card" method="post" action="/login">
    <div class="logo">openc<span>ode</span></div>
    <div class="sub">Sign in to continue to this opencode server.</div>
    ${banner}
    <input type="hidden" name="next" value="${escapeHtml(next)}" />
    <label for="username">Username</label>
    <input type="text" id="username" name="username" value="opencode" autocomplete="username" autocapitalize="none" spellcheck="false" required />
    <label for="password">Password</label>
    <input type="password" id="password" name="password" autocomplete="current-password" required />
    <div class="row">
      <label><input type="checkbox" name="remember" value="on" checked /> Save auth forever</label>
      <span class="hint" style="margin:0"><a href="/logout">Log out</a></span>
    </div>
    <button type="submit">Sign in</button>
    <p class="hint">Use the server credentials configured on the host
      (<code>OPENCODE_SERVER_USERNAME</code> / <code>OPENCODE_SERVER_PASSWORD</code>).</p>
  </form>
</body>
</html>`
}

export function loginPage(request: HttpServerRequest.HttpServerRequest) {
  const url = new URL(request.url, "http://localhost")
  const error = url.searchParams.get("error") === "1"
  const next = url.searchParams.get("next") ?? ""
  return Effect.succeed(HttpServerResponse.html(loginPageHTML({ error, next })))
}

export function loginSubmit(
  request: HttpServerRequest.HttpServerRequest,
  config: ServerAuth.Info,
) {
  return Effect.gen(function* () {
    const params = yield* request.urlParamsBody
    const read = (name: string) => Option.getOrElse(UrlParams.getFirst(params, name), () => "")
    const username = read("username")
    const password = read("password")
    const remember = ["on", "1", "true"].includes(read("remember"))
    const next = sanitizeReturnPath(read("next"))
    const credentials: ServerAuth.DecodedCredentials = {
      username,
      password: Redacted.make(password),
    }
    if (!ServerAuth.required(config) || ServerAuth.authorized(credentials, config)) {
      return HttpServerResponse.setHeader(
        HttpServerResponse.redirect(next || "/", { status: 302 }),
        "set-cookie",
        authCookieHeader(username, password, remember),
      )
    }
    const body = loginPageHTML({ error: true, next })
    return HttpServerResponse.setStatus(HttpServerResponse.html(body), 401)
  })
}

export function logout() {
  return Effect.succeed(
    HttpServerResponse.setHeader(
      HttpServerResponse.redirect("/login", { status: 302 }),
      "set-cookie",
      clearAuthCookieHeader(),
    ),
  )
}
