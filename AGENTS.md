- To regenerate the legacy JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- After changing the public Protocol or Server `HttpApi`, run `bun run generate` from `packages/client`. Do not edit `src/generated` or `src/generated-effect` directly.
- Keep runtime dependencies directed from Schema to Core and Protocol, then from Core and Protocol to Server. Client runtime code may depend on Schema and Protocol but never Core or Server; `sdk-next` composes Client, Core, and Server.
- The default branch in this repo is `dev`. `origin` is `https://github.com/nkyang10/opencode.git`. Do not add extra local branches.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.

## This fork

UI customizations live in `packages/app`. That includes the project-picker directory selector and every later change in that package. A run or deploy that does not build this checkout's `packages/app` is not this fork.

Do not fetch `https://app.opencode.ai`. A normal run is one CLI binary. It serves the page and does the work on port 4446. The page is `packages/app` baked into that binary by `packages/opencode/script/build.ts`. There is no second dev server and no official website.

- Do not pass `--skip-embed-web-ui`.
- Do not set `OPENCODE_DISABLE_EMBEDDED_WEB_UI` on a CLI `web` process. Desktop main sets it because Electron serves its own renderer from local `packages/app`. That does not allow skipping the app build.
- If 4446 is already taken, stop the process listening there and start again.

From `packages/opencode`, with `OPENCODE_REQUIRE_EMBEDDED_WEB_UI=1`:

```
bun run script/build.ts --single
```

The log line `Building Web UI to embed in the binary` means this checkout's app was baked in. Then:

```
packages\opencode\dist\opencode-windows-x64\bin\opencode.exe web --port 4446 --hostname 127.0.0.1
```

Open `http://127.0.0.1:4446`.

A source run (`bun`, process name `bun`) writes `logs/debug/opencode.log`. A compiled binary writes `logs/deploy/opencode.log`. Startup creates both folders when this repo is found. `logs/` is gitignored, so those files are not committed. `OPENCODE_LOG_DIR` still overrides the active folder.

Windows deploy uses `script/build-windows-installer.cmd` from the repo root. That one command builds this checkout: it stops a CLI already on port 4446, compiles `opencode.exe` from local `packages/opencode` with `packages/app` embedded, compiles the background CLI from local `packages/cli`, builds the Windows app from that same app, and writes the NSIS installer plus `opencode.exe` into `package-dist`. Pass `-SyncGh` only when GitHub must replace the checkout first.

- The portable CLI step must run `packages/opencode/script/build.ts --single` with `OPENCODE_REQUIRE_EMBEDDED_WEB_UI=1`. The log line `Building Web UI to embed in the binary` means `packages/app` was baked in. Without that embed, `opencode web` has no page.
- Linux has no local installer script. On a Linux machine, the same `packages/opencode/script/build.ts --single` command with `OPENCODE_REQUIRE_EMBEDDED_WEB_UI=1` embeds `packages/app`. `--single` on Windows builds Windows only. GitHub publish jobs run only for `anomalyco/opencode`, so this fork does not publish Linux artifacts by pushing `dev`.
- The desktop window comes from `electron-vite` of local `packages/app`, not from the sidecar embed.
- `packages/desktop/scripts/prepare.ts` may download a prebuilt CLI on the dev channel. Copy the locally compiled CLI back over that download before packaging. Do not ship the downloaded CLI.
- Put published files in `package-dist`. The installer creates `logs/debug` and `logs/deploy`. `deploy-log-dir.txt` and `OPENCODE_LOG_DIR` point the published binary at `logs/deploy`. Source runs use `logs/debug`.

### Settings UI: there are TWO settings surfaces — keep both in sync

There are **two** parallel settings UIs in `packages/app`, and a feature added to one is NOT
automatically in the other:

- **v1 ("legacy"):** `packages/app/src/components/settings-general.tsx` — still the default `/settings`
  page. Uses `SettingsRow` / `TextField` from `@opencode-ai/ui`.
- **v2 ("new interface designs"):** `packages/app/src/components/settings-v2/general.tsx` — rendered when
  the user enables the "New interface designs" toggle (the lazy `import("@/components/settings-v2")` in
  `settings-general.tsx`). Uses `SettingsRowV2` / `TextInputV2` from `@opencode-ai/ui/v2`.

**Gap found (2026-09-25):** the per-user **RSS feed URL** row was added only to v1's Notifications section
(`RssFeedRow`, `settings-general.tsx:646`, i18n `settings.general.notifications.rss.*`). The v2
`NotificationsSection` (`settings-v2/general.tsx`) only had agent/permissions/errors and was missing the
RSS row, so it did NOT appear in the redesigned settings. **Fixed** by porting the row into
`settings-v2/general.tsx` (fetches `/api/rss/url`, prefixed with `window.location.origin`). The v2 row is a
single **"Copy RSS URL"** `ButtonV2` (fixed label; the URL is never the button label). v1 still uses a
read-only copyable `TextField`.

Rule: when touching a notifications/settings row, check BOTH `settings-general.tsx` and
`settings-v2/general.tsx` and keep them in sync.

### Linux deploy for this fork (web UI on :4447)

This fork serves its web UI on **port 4447** (NOT the upstream default 4446). Source-of-truth scripts
live in `fork-root/scripts/` (one level above the `opencode/` clone):

- `deploy-web-4447.sh` — one-shot rebuild + redeploy. Kills whatever listens on `:4447`, runs
  `build-linux.sh`, then `run-web.sh 4447`. Safe to re-run; writes a pidfile `testing/.web-4447.pid`.
- `build-linux.sh` — compiles the fork (pins **bun 1.3.14**) into
  `opencode/packages/opencode/dist/opencode-linux-arm64/bin/opencode`.
- `run-web.sh` — `setsid nohup <binary> web --port 4447 --hostname 0.0.0.0`, working dir `testing/`.
  If `OPENCODE_SERVER_PASSWORD` is set, any URL redirects to `/login` (FE-001 login page); the server
  otherwise stays open.

Gate: whenever a change touches `packages/app` (the web UI), the embedded app must be REBUILT into the
binary or the running server serves stale assets. Deploy log: `fork-root/testing/deploy-4447.log`;
server log: `fork-root/testing/web-4447.log`.

**RSS origin (2026-09-26):** the feed's `originOf` in `packages/opencode/src/server/rss/route.ts` now uses
`HttpServerRequest.toURL(request)` (honors the request **Host** header / `x-forwarded-proto`), so the `<link>`
entries echo the origin the reader actually used (verified: `Host: 192.168.1.249:4447` → links on that origin;
was hard-coded to `http://localhost` before). The copy button still builds the URL from `window.location.origin`.

**v2 copy button (2026-09-26):** clicking the "Copy RSS URL" row `ButtonV2` in `settings-v2/general.tsx` now
copies the URL via `copyToClipboard()` (which falls back to a temp `textarea` + `document.execCommand("copy")`
because `navigator.clipboard` is `undefined` in non-secure plain-HTTP LAN contexts) and **opens `DialogRssV2`**
(a confirmation dialog, open already in "Copied!" state, with a selectable URL textarea, a "Copy URL" button,
and a "Done" button to dismiss). The `rssCopied` signal also flips the row button to "Copied!" for ~1.5s.

**Settings v2 responsive nav (2026-09-26, DEC-043):** `settings-v2/dialog-settings-v2.tsx` switches the
`TabsV2` `orientation` prop from a `matchMedia("(max-width: 639px)")` signal — `vertical` (left category column)
on wide screens, `horizontal` on narrow ones, where the categories render as a scrollable tab strip **on top** and
the key/value content gets the full dialog width. Kobalte holds `orientation` as a context accessor, so the flip
updates `data-orientation`, `aria-orientation` and arrow-key direction together (no remount, no lost tab state);
the `TabsV2` component in `packages/ui` is unchanged. The nav list content was flattened to `.settings-v2-nav` >
`.settings-v2-nav-group` (×2) + `.settings-v2-nav-footer`; on narrow screens the groups become `display: contents`,
and the section titles + app-name/version footer are hidden (they do not fit a strip). New CSS is scoped under
`.settings-v2[data-variant="settings"][data-orientation="horizontal"]` in `settings-v2.css`, plus a
`max-width: 639px` header/body padding reduction (40px → 16px). The old `144px` side-nav media block was deleted.

**Admin settings are server-global and live in the config file (2026-09-27, FE-023 / FE-024):** the
settings-v2 dialog has an **Admin** tab (`settings-v2/admin.tsx`, registered in
`dialog-settings-v2.tsx` next to Models) whose rows write the **global** config file
(`~/.config/opencode/opencode.json(c)`), not per-browser state like every other settings row. There is no new
write path: it uses `PATCH /global/config` → `Config.updateGlobal` (`src/config/config.ts:656-680`), which
deep-merges into the first existing of `opencode.jsonc` / `opencode.json` / `config.json` and preserves
comments when the file is `.jsonc`. Three rules keep this honest:

- **Patch only the changed leaf.** A patch deep-merges, but arrays are **replaced** — sending the whole
  `server` object would overwrite `server.cors`.
- **A config write disposes every open instance** (`handlers/global.ts:78-82`), so the rows save on an explicit
  Save, never on blur.
- **The port is read once at start** (`cli/network.ts` → `server.ts:startWithPortFallback`), so a saved port
  cannot apply live. `GET /global/webui` (`Webui.DefaultPort` = 4446, the Admin default) reports the configured
  port next to the one the listener bound, and the tab turns the difference into a "restart to apply" line. A
  live re-listen is the natural follow-up — the only existing precedent is the TUI worker RPC
  (`cli/tui/worker.ts` `server()`, which stops the old listener and listens again).
- `server.webui.autoStart` (FE-024) makes the **TUI process** bind the web server at startup
  (`cli/web-autostart.ts`, called from the TUI via the worker's `webuiAutoStart` RPC — no second process).
  It is **opt-in**, and the wildcard address is only used when `OPENCODE_SERVER_PASSWORD` is set; without a
  password it falls back to `127.0.0.1` and says so, because `web --hostname 0.0.0.0` unsecured exposes the
  agent to the whole LAN.
- There is **no user or role model** in this server (one shared Basic credential), so "admin" means "any
  authenticated browser" — it can already `PATCH /global/config`, dispose instances and trigger an upgrade.
- The v1 settings page is **dead code** (its "new interface designs" toggle is past its sunset date and
  `useSettingsDialog()` hard-codes v2). The Admin tab is v2-only on purpose; do not "fix" that by editing
  `settings-general.tsx`.

**Project identity = git, not path (2026-09-26, DEC-045 / FE-020):** a project id is derived from git
(`ProjectV2.resolve`: remote-url hash → id cached in `<git-common-dir>/opencode` → **first root commit sha**).
A directory with no repository resolves to the shared `global` project, which is why it used to vanish from the
server-truth Home project list when picked in the folder selector. It is now remembered by
`Project.recordOpenedDirectory`, called from the **`project/current` handler** — i.e. when a client *opens* a
directory (Home ▸ Add project, a tab, a session) — and announced as `project.directories.updated` on the
**global** bus when the row is new. Recording it in `fromDirectory` instead is wrong: browsing the directory
picker lists directories, and each of those requests resolves a project too, so every browsed folder
(`/usr`, `/boot`, `/proc`, …) became a "project" — only the live test caught that. Record the directory that was
**requested**, not `ProjectV2.resolve`'s `data.directory` (for a repository-less directory that field is `/`).
On the app side the list is a **query** (`[scope, "project-folder"]`) whose result backs the `folder` store slice
as a getter, and `mergeProjectFolders` (`packages/app/src/pages/home/home-project-folders.ts`) feeds the Home
list of **every** server, not only the focused one. Three traps: `ProjectDirectories.create` in `packages/core`
**cannot** take an `EventV2.node` dependency (module-init cycle, `Cannot access 'node' before initialization`) —
the engine layer publishes instead; `POST /project/git/init` on a non-repo directory repoints the **global**
project's own `worktree`, so nothing calls it for folders any more; and `GET /project/{projectID}/directories` is
**not in the generated v2 client** (it is not part of the default protocol API) while the v1 compat layer answers
`project.directories` with `worktree.list()` — the current instance's *sandbox worktrees*, a different set — so
the app calls that route itself via `fetchProjectDirectories` (`packages/app/src/utils/server.ts`, same Basic auth
as the SDK clients, same precedent as the `/api/rss/url` route). Folder rows have no project id, hence no
"Edit project". Background: `50-projects/p003-opencode-fork/README.md` → `## FE-020`.

**Last deploy (2026-09-27 07:28 UTC):** rebuilt + redeployed :4447 via `deploy-web-4447.sh --detach` — version
`1.1.20260927072837`, server **pid 3654762** on :4447 (`/api/health` `{"healthy":true,...}`, HTTP 401 before auth,
`/login` 200). Carries **FE-021** (`5d6b47a`, committed + pushed): the "Thinking" row shows
`· <since last model output> / <since your prompt>` with a tooltip naming both numbers and the absolute clock
time of the last output (DEC-047). Verified present in the served bundle (`assets/index-BFF1n-Mg.js` contains
`session.thinking.elapsed` and `since the last model output`) and in the binary; **not yet visually confirmed by
the user** (ide FU-085). Also in this binary: **FE-020** (`c1f1b58`) and the **DEV-menu utility items**
(DEC-046, `titlebar.tsx` — still uncommitted, ide FU-081).

**Reminders that outlive a deploy:** the build compiles the whole checkout, so whatever is in the tree ships with
it — check `git status` before building, because an in-flight session's edits land in the binary too. And a
deploy kills the listener the running session is using; use `--detach` and expect the tab to reconnect.

**Previous deploy (2026-09-26):** rebuilt + redeployed :4447 with the reviewed Settings v2 responsive nav
(`71c73a0`, binary via `build-linux.sh`, version `1.1.20260926102413`, server pid 2999326 on :4447, `/login`
healthy — HTTP 401 before auth is expected). Playwright-measured: desktop 1280px unchanged (nav 240px left /
panel 740px); 390px phone → strip 358×45 on top, panel 358px full width, key/value row 286px (was ~134px),
ArrowRight moves between tabs. **FE-020 is code-complete in the working tree and is NOT in this build.**

### Version stamping: `OPENCODE_VERSION` is the one input every surface reads

The fork's user-facing version is `1.<MAJOR>.<YYYYMMDDHHMMSS>` (DEC-042), and **one environment variable
carries it into every surface**: the binary's reported version, the desktop About box, the desktop updater,
and the `VITE_APP_VERSION` the embedded web UI shows in Settings.

**…and `OPENCODE_UPSTREAM_VERSION` is a second, narrower one (DEC-054, 2026-09-28).** A user-facing version is
also a *wire* value: `session/llm/request.ts` sends `User-Agent: opencode/<version>` on every provider request,
and OpenCode's Zen free tier gates on it — HTTP **426** `OpenCode 1.18.0 or newer is required to use the free
tier` (`anomalyco/opencode#50451`). `1.<MAJOR>.<ts>` reads as `1.1.x`, i.e. **older than 1.18.0**, so the fork
was locked out of every free model. The wire therefore carries a separate constant,
`UPSTREAM_VERSION = "1.18.31"` in `packages/script/src/index.ts`, exposed as `Script.upstream`, stamped as
`OPENCODE_UPSTREAM_VERSION` by `script/build.ts`, `script/build-node.ts` and `packages/cli/script/build.ts`, and
read at runtime as `UpstreamVersion` (`packages/core/src/installation/version.ts`; it falls back to
`InstallationVersion` in an unstamped source run). **Bump `UPSTREAM_VERSION` when merging upstream**, or the
fork under-claims its base — a stale value still passes the gate, so it fails safe. `OPENCODE_UPSTREAM_VERSION` in
the environment overrides the constant for a one-off build; `build-linux.sh` only overrides `OPENCODE_VERSION` and
`OPENCODE_CHANNEL`, so it reaches the build through the inherited environment. `packages/core/src/models-dev.ts`
still sends the *fork* version to `models.opencode.ai` on purpose — no gate in evidence on that service.

- **The Linux web deploy does it today.** `build-linux.sh` derives the version from
  `packages/script/release.ts --channel dev --json` and passes it as
  `OPENCODE_VERSION=$VERSION OPENCODE_CHANNEL=mark-dev` to `script/build.ts --single`. Note
  `OPENCODE_CHANNEL` must stay `mark-dev`: it is the SQLite filename suffix (DEC-037/FU-058's warning).
- **Desktop packaging is the gap.** `packages/desktop/electron.vite.config.ts:98` already reads
  `process.env.OPENCODE_VERSION` and `packages/desktop/scripts/prepare.ts` drives `app.getVersion()` from the
  same value, but **nothing in this fork sets it** — only upstream has an installer pipeline, and it is not
  reachable from here. So a desktop build made without the variable silently reports an empty version in About
  and the embedded web UI, and the updater cannot compare versions.
- **Therefore, when packaging the desktop by hand, set it the same way the web build does:**

  ```sh
  # from packages/opencode, with bun 1.3.14 pinned
  VERSION=$(cd packages/script && bun release.ts --channel dev --json | sed -n 's/^  "version": "\([^"]*\)",$/\1/p')
  OPENCODE_VERSION="$VERSION" OPENCODE_CHANNEL=mark-dev <your packaging command>
  ```

  A packaged build is verifiable: `./<binary> --version` must print exactly the string you passed, and
  Settings in the packaged app must show `v$VERSION`.
- **Why it is only a document and not a script (FU-074, decided 2026-09-28):** a packaging script for a
  platform this box does not build would be untested, and an untested release script is worse than a
  documented requirement. Revisit when a desktop build actually has to be produced here.

## Branch Names

Use a short branch name of at most three words, separated by hyphens. Do not use slashes or type prefixes such as `feat/` or `fix/`.

Examples: `session-recovery`, `fix-scroll-state`, `regenerate-sdk`.

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected package or area when helpful, e.g. `core`, `opencode`, `tui`, `app`, `desktop`, `sdk`, or `plugin`.

Examples: `fix(tui): simplify thinking toggle styling`, `docs: update contributing guide`, `chore(sdk): regenerate types`.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.
- In Effect generators, bind services to named variables before calling methods. Do not use nested service yields such as `yield* (yield* Foo.Service).bar()`.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Imports

- Never alias imports. Do not use `import { foo as bar } from "..."` or renamed imports like `resolve as pathResolve`.
- Never use star imports. Do not use `import * as Foo from "..."` or `import type * as Foo from "..."`.
- If a namespace-style value is needed, import the module's own exported namespace by name, for example `import { Project } from "@opencode-ai/core/project"`, then reference `Project.ID`.
- Prefer dynamic imports for heavy modules that are only needed in selected code paths, especially in startup-sensitive entrypoints. Destructure dynamic import bindings near the top of the narrowest scope that needs them so they read like normal imports. Avoid inline chains such as `await import("./module").then((mod) => mod.value())` or `(await import("./module")).value()`. Keep branch-specific imports inside the branch that needs them to preserve lazy loading.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept like `requireConfig` or `readMetadata`.
- Do not return `Effect` from helpers unless they actually perform effectful work. Synchronous parsing, validation, and option building should stay synchronous.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption` over manual `JSON.parse` wrapped in `Effect.try` when parsing untrusted JSON strings.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible, you shouldn't be using globalThis.\* at all unless it's the only option.
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly.

## V2 Session Core

- Keep durable prompt admission separate from model execution. `SessionV2.prompt(...)` admits one durable `session_input` row before scheduling advisory `SessionExecution.wake(sessionID)` unless `resume: false` requests admit-only behavior. The serialized runner promotes admitted inputs into visible user messages at safe boundaries.
- Reusing a Session ID adopts the existing Session. Reusing a prompt message ID reconciles an exact retry only when Session, prompt, and delivery mode match; conflicting reuse fails. Historical projected prompts lazily synthesize promoted inbox records during exact retry.
- Keep `SessionExecution` process-global and Session-ID based. Its local implementation owns the process-local Session coordinator and discovers placement through `SessionStore` plus `LocationServiceMap.get(session.location)` only when a drain starts; no layer should take a Session ID. V2 interruption targets the active process-local ownership chain for that Session; idle or missing interruption is a no-op.
- Keep `SessionRunner`, model resolution, tool registry, permissions, and filesystem Location-scoped. Omitted `Location.workspaceID` means implicit-local placement; explicit workspace identity remains reserved for future placement semantics.
- Preserve one explicit `llm.stream(request)` call per provider turn and reload projected history before durable continuation. Do not bridge through legacy `SessionPrompt.loop(...)` or delegate orchestration to an in-memory tool loop.
- Keep local Session drains process-local until clustering is implemented. `SessionRunCoordinator` joins explicit same-Session resumes, coalesces prompt wakeups, and allows different Sessions to run concurrently. Advisory wakes drain eligible durable inbox rows only; post-crash continuation recovery requires a separate explicit design before it may retry provider work. A drain has no durable identity or transcript boundary.
- Keep delivery vocabulary explicit. Prompts steer by default and promote at the next safe provider-turn boundary while the current drain requires continuation. An explicit `queue` input remains pending until the Session would otherwise become idle; promote one queued input at that boundary, then reevaluate continuation before promoting another. Promoting any new user input resets the selected agent's provider-turn allowance; a batch of steers resets it once.
- Keep EventV2 replay owner claims separate from clustered Session execution ownership.
- Keep the System Context algebra, registry, and built-ins in `src/system-context`; keep Context Source producers with their observed domains, and keep Session History selection plus Context Epoch persistence Session-owned.

**The "Changed files" group is collapsed by default (2026-09-27, FE-025 / DEC-052):** the timeline's
`DiffSummary` row (`packages/app/src/pages/session/timeline/message-timeline.tsx`) renders **one 44px line** —
`N Changed files` + the turn's `+added −deleted` split + a chevron — and the file list is inside a
`<Show when={open()}>`, so a turn with 10 changed files occupies **44px instead of ~440px** (measured
44px collapsed vs 393px expanded for 12 files). Three things to know before touching it:

- **The header is the toggle** (`role="button" tabIndex="0" aria-expanded` + Enter/Space, mirroring the composer
  todo dock at `composer/session-todo-dock.tsx:110-215`). Its chevron rotates on
  `[data-component="session-turn-diffs-group"][data-expanded]` — a *different* `data-slot`
  (`session-turn-diffs-chevron`, plural) from the per-file one (`session-turn-diff-chevron`, singular), which
  still keys off `[data-slot="accordion-item"][data-expanded]`. Do not merge them.
- **The open flag is persisted, per session, as ONE boolean** (`SessionView.diffSummaryOpen` in
  `context/layout.tsx`, beside `todoCollapsed`). **Absent means collapsed**, so no `migrate` branch and no
  `layout.v6` bump. Accepted consequence: opening one turn's list leaves every other turn's list in the same
  session open too, because they all read the same flag. Per-row independence (a `string[]` of open
  `userMessageID`s, like the Review panel's `reviewOpen`) is the documented alternative if that is ever
  complained about. `MessageTimeline` already has `useSessionKey()` so no prop is threaded.
- **The header must stay 44px tall in both states.** `--sticky-accordion-offset: 44px` on the inner `Accordion`
  exists because of it, and the first file row sits 50px below the header's top (measured) — a shorter header
  would let the per-file sticky headers overlap, a taller one would leave a gap.
- `Show all` and `+N more files` became real `<button type="button">`s (they were a bare `<span onClick>` and
  `<div onClick>`), and `Show all`'s `opacity: 0` is now also lifted by `:focus-visible` — it used to be
  invisible to keyboard **and** touch users. **`Show all` lives in the header, so its handler must
  `stopPropagation()`** or clicking it also collapses the group. Note `Show all` stays rendered while the group
  is collapsed (it is a header control); only `+N more files` and the file list are behind the toggle.
- The row's **content is unchanged and adds no i18n key**: the count is `ui.sessionTurn.diffs.changed`
  (plural) and the totals come from `<DiffChanges changes={props.diffs}>` (the whole array), which **sums**
  across every file, so the tally is the *turn* total. `additions`/`deletions` are required
  `Schema.Finite` (`packages/schema/src/file-diff.ts`), and `DiffChanges` renders nothing when the sum is 0, so
  a rename-only or binary turn legitimately shows no tally. The `+12 −4` split is deliberate — a single
  "N lines changed" would need a new plural key in **`packages/ui/src/i18n/` (66 locales)**.
  `diffSummaryOverflow` / `diffSummaryVisible` were extracted to
  `timeline/diff-summary-state.ts` because `packages/app` has **no** `*.test.tsx`, so only pure logic is
  unit-testable.
