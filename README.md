<p align="center">
  <a href="https://opencode.ai">
    <picture>
      <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
      <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
      <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="MarkCode logo">
    </picture>
  </a>
</p>
<p align="center">A mobile-first fork of <a href="https://github.com/anomalyco/opencode">opencode</a> — the open source AI coding agent.</p>

[![MarkCode Terminal UI](packages/web/src/assets/lander/screenshot.png)](https://opencode.ai)

**MarkCode** is a fork of [opencode](https://github.com/anomalyco/opencode), tuned for **mobile
multitasking** — run, monitor, and intervene in several agent sessions from a phone, with cookie-based
login and a **self-built Linux (aarch64) binary**.

> **This is a fork.** Everything not listed under
> ["What's different from upstream"](#whats-different-from-upstream) is stock opencode. For installation,
> the CLI, the desktop app, integrations, services, plugins, and full documentation, use upstream:
>
> - Site & docs: **https://opencode.ai**
> - Upstream repo: **https://github.com/anomalyco/opencode**

---

## What's different from upstream

MarkCode's changes over stock opencode (web UI + server layer):

### Mobile-first web UI
- **Home "Sessions" rows → mobile-first cards** — a 2-line-clamped title, a project line, and a
  last-prompt line replace the one-line, fixed-width-project strip.
- **Session rows show a last-prompt subtitle** (sidebar + Home Sessions tab), prefetched for every row.
- **Folder explorer on mobile** — open-project uses the rich tree explorer on phones too (was
  desktop-only), rooted at your last project, full-viewport.
- **Drag-down action menu** on the chat tab bar — thumb-reachable **Reload** + **Logout** without leaving
  the session.
- **Right-click / long-press menu on draft session tabs** — **Rename** + **Close Tab**.
- **Project picker rebuilt on Zag.js TreeView** — replaces the buggy `@pierre/trees` web component; keeps
  the path text-input and mid-level folder reveal.

### Auth & security
- **Login landing page + persistent cookie auth** — replaces the browser's Basic-auth dialog. "Save auth
  forever" sets a long-lived `oc_creds` cookie (survives iOS *Add to Home Screen*); redirect-back after
  login; `/logout`.

### Reliability
- **Foreground re-sync** — when the phone app returns to the foreground, the SSE stream self-heals and the
  open session re-fetches once, so messages emitted while backgrounded appear without tab-switching.
- **Project-selector crash fix** — `/file` + `/find/file` 500 handled with an FS fallback.
- **Slim live-reply fix** — seeded session summaries get a live assistant reply, not only after a reload.
- **Deploy toast also on a same-version restart** — the refresh prompt fires when the server drops and recovers,
  and dev builds carry a globally unique version so every build is distinguishable.

### Projects & folders
- **Every folder you open is a project** — a directory without a git repository is remembered server-side and
  listed next to your repositories, so picking one in the folder selector actually takes effect. Adding a
  folder no longer creates a `.git` in it. *(FE-020 — in the working tree, not yet built into a binary)*
- **Folder picker returns only what you picked** — confirming with nothing selected is not possible, the path
  box shows the absolute path, and clicking a row in the tree no longer triggers a filesystem-wide search.
  *(FE-020 — in the working tree, not yet built into a binary)*

### Home
- **Sessions list paginates** — both Home lists load 15 rows and fetch more on demand instead of scanning the
  whole table; the search scan only runs while the search box is focused.
- **Skills tab** — browse, edit, copy, enable/disable and delete the skills the agent can load.

### Mobile
- **Compact-and-start-new-session** places the fresh tab next to the original, renames the original
  `<title> [ended]` and closes its tab.
- **Enter inserts a newline on touch devices** (send button submits); desktop Enter still submits.

### Notifications
- **Per-user RSS feed** of finished sessions — the URL is in Settings ▸ Notifications, with a copyable
  dialog, so another device or a reader can follow along.

### Dev tooling
- **DEV title-bar dropdown** — the top-left button now offers **Home page** / **Refresh** / **Clear cache** /
  **Debug tools**, plus the project page's own **Log out** / **Settings** / **Help** items (same handlers and
  localized labels as the project sidebar, DEC-046).
- **Server-update refresh toast** — `/api/health` reports `{healthy, version}`; on a version change a
  persistent toast with a **Refresh** button appears.

### Build
- **Self-built Linux (aarch64) binary** — vendored source built with Bun, instead of the prebuilt upstream
  releases.

---

## Install & run

- **Standard install (upstream opencode):** see [opencode.ai](https://opencode.ai) — curl / brew / nix /
  scoop / choco / npm / pnpm / bun / git.
- **MarkCode web UI** — start the server with a password to enable the MarkCode login page:
  ```bash
  OPENCODE_SERVER_PASSWORD=<password> opencode web --port 4447 --hostname 0.0.0.0
  ```
- **Build the MarkCode Linux (aarch64) binary** from this repo:
  ```bash
  export PATH="$HOME/.bun/bin:$PATH"
  bun install
  bun ./packages/opencode/script/build.ts --single
  # → packages/opencode/dist/opencode-linux-arm64/bin/opencode
  ```

---

## Upstream

MarkCode is a fork; [opencode](https://github.com/anomalyco/opencode) is the source of truth for everything
else.
- Documentation: https://opencode.ai/docs
- Contributing (upstream): https://github.com/anomalyco/opencode/blob/dev/CONTRIBUTING.md
- Community: [Discord](https://discord.gg/opencode) · [X](https://x.com/opencode)

## License

MarkCode is distributed under the [MIT License](./LICENSE), © the opencode authors. This project is a fork of
[opencode](https://github.com/anomalyco/opencode).
