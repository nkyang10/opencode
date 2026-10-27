# Agent image display and screenshots

Plan only; no runtime change. Baseline: `ef7d980` on `v2-ui-enhancements`. Written for the contributor who implements it: read [Handoff](#handoff) first, then ship one milestone per push.

## Goal

A user who drives opencode through the web UI from another device can ask "run the app, take a screenshot and show me" or "show me the VS Code window". The agent:

1. captures the full screen, one application window (also when it is covered or minimized) or a web page on the host;
2. shows the image in the chat, where the user can enlarge it and act on it;
3. inspects the same image itself when the model supports images.

Images travel as typed tool-result parts, never as base64 text, Markdown image links or host paths that a remote browser cannot open.

## Decisions

| Topic | Decision |
| --- | --- |
| Display | `show_image(path, caption?)` tool in both runtimes. Image results of every tool also render in the chat |
| Capture | Built-in `screenshot` tool: `list` displays and windows; capture the primary, one or all displays, or one window by id or app/title. Covered windows are captured without focus changes; minimized windows are restored without activation, captured and minimized again |
| Guidance | Built-in `capture-screenshot` skill: target choice, web-page recipes, headless hosts, privacy. It routes to `screenshot` and `show_image` |
| Storage | `<data>/screenshots/` (default `~/.local/share/opencode/screenshots/`), outside the project, 7-day retention. The chat keeps its own normalized copy. Project copies only on explicit request |
| Transport | `data:` URLs in tool attachments (existing convention); no new HTTP route |
| Model context | Shown images go to vision models; text-only models get a neutral note instead of the generic error |
| Permissions | `show_image` follows `read` and `external_directory`. `screenshot` has its own permission, default `ask`, patterns `screen`, `window:<app>` and `list` |
| Chat UI | Inline images for all tools. Click opens an image viewer (zoom, pan, gallery). Right-click, the ⋯ button or a long press opens image actions: Open, Open in new tab, Copy image, Save image, Copy path, Reveal in file manager, Attach to message, Go to message |
| Out of scope | Plugin tool attachments (upstream #21383), server media store, video recording, region picking, annotation |

## Guardrails

- Small independent commits; push each milestone to `v2-ui-enhancements`; merge into `dev` only on request; never hand-edit generated clients; never restart a live host.
- Paths refer to the connected host, not the browser device.
- No unauthenticated asset route, no credentials in URLs (for example the `auth_token` query), no reverse-proxy media folder.
- No new native or npm dependency for capture: spawn OS-provided or commonly installed tools through `AppProcess` (`packages/core/src/process.ts`) with timeouts and output caps.
- Every new UI string in every locale; reactive JSX props use getters; no app `*.test.tsx`.
- Timeline rendering changes need the production streaming benchmark before and after.
- No paid LLM calls in tests; use fixtures and fake providers. Capture tests use fake process runners or Xvfb, never a developer's real desktop in CI.

## Current state (verified at baseline; re-check line numbers)

Working:

- Tool results carry images. Legacy runtime: `Tool.ExecuteResult.attachments` (`packages/opencode/src/tool/tool.ts`), stored as `ToolPart.state.attachments` with `data:` URLs. Core (v2) runtime: tool `content` items `{ type: "file", uri, mime, name }` (`packages/core/src/tool/tool.ts`, `packages/schema/src/llm.ts`).
- Producers: `read` and `webfetch` in both runtimes; MCP `image` content and blob resources (`packages/opencode/src/session/tools.ts`).
- Normalization: photon resize to at most 2000x2000 and 5 MB base64, configurable through `attachment.image` (`packages/opencode/src/image/image.ts`, applied in `session/processor.ts`; `packages/core/src/image.ts`, applied in core `read`).
- Model lowering: legacy `MessageV2.toModelMessages` keeps media in tool results where the provider supports it, otherwise moves it into a synthetic user message; `ProviderTransform.unsupportedParts` turns images for text-only models into `ERROR: Cannot read ... Inform the user.` Core lowers per protocol (`packages/llm/src/protocols/*`; OpenAI Chat moves tool images into a following user message) and has no capability gating in `packages/core/src/session/runner/to-llm-message.ts`; capabilities live in `model.capabilities.input` (`packages/schema/src/model.ts`).
- Pruning only sets `time.compacted`; stored attachments remain but are no longer sent. ACP forwards tool images (`packages/opencode/src/acp/tool.ts`).
- The app maps core `file` content to `ToolPart.state.attachments` (`packages/app/src/utils/session-message.ts`) and selects the v1 protocol whenever `/global/health` is healthy (`packages/app/src/utils/server-protocol.ts`), so the legacy runtime serves the usual `opencode serve` / `opencode web` host.
- Reusable pieces: Kobalte wrappers `packages/ui/src/components/context-menu.tsx` and `dropdown-menu.tsx`; `ImagePreview` (plain dialog for user and composer images); the `writeClipboard` text helper with `execCommand` fallback (`packages/session-ui/src/components/message-part.tsx`); composer images (`ImageAttachmentPart` in `packages/app/src/context/prompt-state.ts`, `createPromptAttachmentsCore` in `packages/app/src/components/prompt-input/attachments.ts`); desktop-only `platform.revealPath` (`packages/app/src/context/platform.tsx`); the session-ui `DataProvider` with optional callbacks (`packages/session-ui/src/context/data.tsx`, created in `packages/app/src/pages/directory-layout.tsx`); photon (`packages/core/src/image/photon.ts`).
- Precedents: oversized tool output lives in `<data>/tool-output` with 7-day cleanup (`packages/opencode/src/tool/truncate.ts`, `packages/core/src/tool-output-store.ts`); default `external_directory` allow-lists are built in `packages/opencode/src/agent/agent.ts` and `packages/core/src/plugin/agent.ts` (tool output, `<tmp>/opencode`, skill and reference directories); the built-in `customize-opencode` skill shares `packages/core/src/plugin/skill/customize-opencode.md` between `packages/opencode/src/skill/index.ts` (a user skill with the same name overrides it) and `packages/core/src/plugin/skill.ts`; tools whose permission is denied for `*` are hidden (`Permission.disabled`, `packages/opencode/src/permission/index.ts`); permission config accepts any key (`StructWithRest`, `packages/core/src/v1/config/permission.ts`).
- The served UI's CSP allows `img-src 'self' data: https: blob:` and `connect-src * data: blob:` (`packages/opencode/src/server/shared/ui.ts`): no CSP change is needed.

Gaps:

1. The UI drops tool-result images: `ToolPartDisplay` in `message-part.tsx` never reads `state.attachments`. Upstream: anomalyco/opencode#21227, draft PR #39817.
2. No tool means "show this to the user"; `read` is inspection and is grouped into collapsed Explored activity.
3. No capture tool: nothing lists windows or handles covered or minimized windows, permissions, DPI scaling or multiple displays.
4. No storage convention: saving outside the project prompts for `external_directory`; saving inside pollutes the repository and opencode's session snapshots (`packages/opencode/src/snapshot/index.ts` adds untracked, non-ignored files).
5. Core sends images to text-only models; prune estimates count only text output.
6. `ImagePreview` has no zoom, gallery or actions.

Constraints:

- The app authenticates with an `Authorization: Basic` header, which a plain `<img src>` cannot send. `data:` URLs inside message payloads (already used for pasted images) need no route and work across devices.
- The Markdown sanitizer allows `<img>`; host paths in Markdown resolve against the web UI origin, and remote Markdown images are an exfiltration channel. Agents must not be taught Markdown image embedding.
- Clipboard image writes need a secure context (HTTPS or localhost), and `image/png` is the only image type every browser accepts ([MDN Clipboard.write](https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/write), [ClipboardItem.supports](https://developer.mozilla.org/en-US/docs/Web/API/ClipboardItem/supports_static)). `opencode web` over plain HTTP on a LAN address can still save images and copy text.
- OS capture permissions belong to the host process (terminal, desktop app, service), not to opencode. macOS prompts appear on the host screen, which a remote user cannot click.

## How other agents do it

| Agent / project | Mechanism | Lesson |
| --- | --- | --- |
| MCP specification | Tool result `{ type: "image", data, mimeType }`, optional `annotations.audience` and `priority` | Images are typed result blocks; audience separates user-facing and model-facing content |
| OpenAI Codex CLI | Built-in `view_image(path)` attaches a local image | A dedicated tool makes the capability discoverable; its wording controls use (openai/codex#12439) |
| Claude Code / Claude apps | `Read` returns images; screenshots through Playwright or Chrome DevTools MCP; claude.ai collapses MCP images by default (anthropics/claude-code#53256) | Do not hide the deliverable in a collapsed card |
| Cline / Roo Code | `browser_action` returns a screenshot after each action | Keep images structured; a Roo regression showed base64 as text (RooCodeInc/Roo-Code#8045) |
| Cursor | Browser tool; generated images saved to the project's `assets/` and shown inline | Deliverables belong in the project; captures are shown inline |
| Goose | `read_image` in the developer extension | Same local-image primitive |
| Playwright MCP | `browser_take_screenshot` returns image content and writes files; automatic output goes to `.playwright-mcp` in the workspace unless `--output-dir` is set; `--image-responses allow\|omit\|only` | Large images overflow context (#1185); artifacts in the repository risk accidental commits of private data (#1789) |
| Peekaboo, screencommander (macOS) | Window capture by id or title in the background; window server for minimized, hidden and other-Space windows; background restore of minimized windows | Background window capture works on macOS without stealing focus |
| xcap (Rust) | Screen and window capture on Windows, macOS and X11; Wayland only partially supported; its example skips minimized windows | Minimized windows and Wayland need explicit handling |
| opencode upstream | Requests #21227 and #41038; workaround #16234 (Caddy `/media` plus Markdown) | Confirms the gap; the workaround bypasses auth and must not be copied |

Common pattern: capture into a file, return it as a typed image block, render image blocks visibly with click-to-zoom, keep images within size and token budgets, and expose a clearly named tool so the model knows it can show images.

## Design

### 1. `show_image` tool (both runtimes)

- Input: `path` (host image, absolute or relative to the working directory) and optional `caption` (short; caption and alt text).
- Policy: the same path resolution, `read` permission patterns and `external_directory` rules as `read`. `Permission.disabled` maps `show_image` to `read`, so a fully denied `read` hides it. No network fetch; remote images go through `webfetch` or are downloaded first.
- Validation: sniff magic bytes; accept PNG, JPEG, GIF and WebP. Reject SVG, BMP, HEIC, AVIF and TIFF with a conversion hint. Refuse directories, missing files and files above a raw-size cap before reading them.
- Normalization inside the tool with the existing normalizer, so an oversized image fails explicitly instead of receiving the processor's silent "omitted" note, and reported dimensions are final.
- Result: one image attachment (legacy) or one `file` content item (core), marked `shown: true` in metadata, plus text such as `Shown to the user: test-results/home.png (PNG, 1280x720, 142 KB).` Metadata: `{ path, name, mime, width, height, bytes, caption, resizedFrom?, shown: true }`.
- Text-only models: decided at model-message conversion, because the model can change between turns. Keep the stored attachment for the UI, drop it from the model context and add "The image was shown to the user; the current model cannot view images, so do not describe it." instead of the generic `ERROR`.
- Description (always in the tool list, keep it short): use when the user should see an image (screenshot, rendered page, chart, generated asset); the user may be on another device and cannot open host files; use `read` when only the agent needs to inspect an image; never paste base64 or Markdown image links; save new captures under `{{screenshots_dir}}`; load the `capture-screenshot` skill for recipes.

### 2. `screenshot` tool (both runtimes)

Parameters:

| Name | Type | Default | Notes |
| --- | --- | --- | --- |
| `action` | `"capture"` or `"list"` | `capture` | `list` returns displays and windows |
| `target` | `"screen"` or `"window"` | `screen` | |
| `display` | `"primary"`, `"all"` or a number | `primary` | 1-based index from `list` |
| `window` | string | none | Required for `target: "window"`: an id from `list`, an app name or a title substring (case-insensitive) |
| `restore_minimized` | boolean | `true` | Allows a temporary restore of a minimized window |
| `delay_ms` | integer, 0 to 10000 | `0` | Wait before capturing, for example after launching an app |
| `x_display` | string | `DISPLAY` | Linux and WSL only, for example `:99` for Xvfb |
| `caption` | string | none | Caption and alt text in the chat |

Window matching: exact id, then exact app name (process name, macOS owner name, X11 `WM_CLASS`), then title substring. With several matches, capture the frontmost one and list the others with ids in the output. With none, fail with `window_not_found` and up to 10 candidates.

`list` output: displays first, then at most 50 windows front to back, skipping invisible, zero-size, tool and overlay windows:

```text
Displays: 1 (primary) 2560x1440 at 0,0 scale 2; 2 1920x1080 at 2560,0
Windows, front to back:
  0x03a00007  firefox  pid 4242  "Docs - Mozilla Firefox"  1280x900  display 1
  0x04200003  code     pid 3110  "app.ts - opencode"       1600x1000 display 2  minimized
```

Structured metadata repeats the data: `displays[]` (`index`, `primary`, bounds, `scale`) and `windows[]` (`id`, `app`, `pid`, `title`, bounds, `display`, `minimized`, `onCurrentDesktop`).

Capture result: the PNG is saved at full resolution in the screenshots directory; the normalized copy becomes the attachment (marked `shown: true`) and appears in the chat immediately, without a separate `show_image` call. Text: `Captured window "Docs - Mozilla Firefox" (firefox, pid 4242), 1280x900, shown to the user. Saved: <path>. The window was minimized; it was restored without focus and minimized again.` Metadata: `{ path, target, display?, window?: { id, app, pid, title }, width, height, bytes, restored, focusChanged, backend, platform }`.

Errors carry a stable code in the message and metadata, and each message says what the user can do:

| Code | Typical cause |
| --- | --- |
| `no_display` | Headless host; suggests a headless browser or Xvfb |
| `no_interactive_session` | Windows service or SSH session, macOS SSH session |
| `permission_required` | macOS Screen Recording or Accessibility; GNOME portal approval |
| `missing_dependency` | Linux tool missing; includes an install hint |
| `window_not_found` | No match; lists candidates |
| `window_not_capturable` | Wayland, elevated window, other virtual desktop, minimized with `restore_minimized: false` |
| `blank_capture` | Uniform frame: locked screen, disconnected RDP session, protected window, missing permission |
| `unsupported` | No backend for this platform or desktop |
| `timeout` | Backend exceeded about 15 s |

Behavior guarantees:

- Never take keyboard focus or change stacking where the platform allows it. If a fallback had to activate a window, reactivate the previous foreground window and report `focusChanged: true`.
- Restore the original window state (minimized, placement) in a finalizer, including on errors, timeouts and interruption.
- Blank check on the decoded image (sampled grid): a uniform frame fails with `blank_capture` and platform hints instead of showing a black image.
- Physical pixels: per-monitor DPI awareness on Windows, backing scale on macOS; the attachment is normalized afterwards.
- One capture at a time per host (mutex), because restores manipulate windows.

Permission and privacy: `ctx.ask({ permission: "screenshot", patterns: [pattern], always: [pattern] })` with `screen`, `window:<app>` (lowercase) or `list`. Default `ask` in both runtimes (legacy `agent.ts` defaults, core `plugin/agent.ts` ruleset); add `screenshot` to the permission config schema for discoverability. Users can allow per app (`"screenshot": { "*": "ask", "window:firefox": "allow" }`) or deny (`"screenshot": "deny"` hides the tool). `list` needs permission too, because window titles can be sensitive.

Availability: register the tool on Windows, macOS and WSL, and on Linux when `DISPLAY` or `WAYLAND_DISPLAY` is set or `Xvfb` / `xvfb-run` is on `PATH`. Elsewhere omit it to save tokens; the skill covers the headless-browser route.

Module layout:

- `packages/core/src/screen-capture/`: `index.ts` (Effect service `list` and `capture`, platform dispatch, mutex, timeout), `schema.ts` (parameters, displays, windows, results, error codes), `detect.ts` (platform, WSL, session type, desktop, available tools), `select.ts` (window matching), `blank.ts`, `storage.ts`, `x11.ts`, `windows.ts` with `windows.ps1`, `wsl.ts`, `macos.ts` with `macos.js` (JXA), `wayland.ts`. Scripts are imported as text, like the skill markdown.
- Thin tools: `packages/opencode/src/tool/screenshot.ts` with `screenshot.txt` (legacy registry) and `packages/core/src/tool/screenshot.ts` (core `builtins.ts`).
- UI: the shown-image card from `show_image`, titled with the window app or display.

Platform backends:

| Platform | List | Screen | Window | Needs |
| --- | --- | --- | --- | --- |
| Windows; WSL through `powershell.exe` with paths from `wslpath -w` | `EnumWindows`, `GetWindowText`, `GetWindowThreadProcessId`, `IsIconic`, `DwmGetWindowAttribute` (`DWMWA_EXTENDED_FRAME_BOUNDS`, `DWMWA_CLOAKED`), `IVirtualDesktopManager` | `EnumDisplayMonitors`, `CopyFromScreen` per display or virtual screen | `PrintWindow` with `PW_RENDERFULLCONTENT`, cropped to the frame bounds | Interactive desktop; Windows PowerShell 5.1+ with `Add-Type` C# |
| macOS | JXA `CGWindowListCopyWindowInfo` (owner, name, bounds, layer, on-screen flag) | `screencapture -x [-D n]`; displays from `NSScreen` | `screencapture -x -o -l <id>` (window server) | Screen Recording for the host process (window names are missing without it); Accessibility for restores |
| Linux X11 | `wmctrl -lpGx` or `_NET_CLIENT_LIST_STACKING` with `xprop` / `xwininfo` (`_NET_WM_STATE_HIDDEN`, `WM_CLASS`, `_NET_WM_PID`) | `xrandr --listmonitors`; `import -window root` with a crop, fallback `xwd`, `maim`, `scrot` | `import -window <id>` | `DISPLAY`; ImageMagick, x11-utils, xdotool, wmctrl |
| Linux Wayland | Sway and Hyprland IPC only | `grim [-o name]` (wlroots), `spectacle -b -n -f` or `-m` (KDE), screenshot portal (GNOME) | wlroots: `grim -g` of the visible window region; KDE: active window only; GNOME: none | Compositor-specific tools |

Windows notes: run `powershell.exe -NoProfile -NonInteractive -EncodedCommand <UTF-16LE base64>`; call `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` first; print JSON on stdout; write the PNG to a temporary name and rename it. `PrintWindow` with `PW_RENDERFULLCONTENT` is what Chromium and WebRTC use for covered windows ([Chromium snapshot_win.cc](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/snapshot/snapshot_win.cc), [WebRTC window_capturer_win_gdi.cc](https://webrtc.googlesource.com/src/+/bde80e3c0ec2be96189087cf36e254f9c4bfb144/modules/desktop_capture/win/window_capturer_win_gdi.cc)). Session 0, `UserInteractive == false` and OpenSSH sessions fail with `no_interactive_session`. `Add-Type` costs about 1 to 2 s per call; measure before optimizing.

Minimized windows (no platform API returns pixels for them directly, except the macOS window server: [Windows capture sample](https://github.com/microsoft/Windows.UI.Composition-Win32-Samples/blob/master/cpp/ScreenCaptureforHWND/README.md), [WebRTC](https://webrtc.googlesource.com/src/+/bde80e3c0ec2be96189087cf36e254f9c4bfb144/modules/desktop_capture/win/window_capturer_win_gdi.cc), [ScreenCaptureKit, WWDC22](https://developer.apple.com/videos/play/wwdc2022/10155/), [xcap](https://github.com/nashaofu/xcap)):

- Windows: save `GetWindowPlacement` and the foreground window; `ShowWindow(SW_SHOWNOACTIVATE)`; wait (at most 1 s) until the window is no longer iconic and its frame bounds are stable, then force a paint (`RedrawWindow`); capture; `ShowWindow(SW_SHOWMINNOACTIVE)` and `SetWindowPlacement`; reactivate the previous foreground window if it changed. The window flashes briefly; a hidden restore is an M10 experiment. Elevated windows can refuse the restore (UIPI) and fail with `window_not_capturable`.
- macOS: capture through the window server first; screencommander reports that it covers minimized, hidden and other-Space windows that ScreenCaptureKit cannot ([screencommander](https://github.com/0xSMW/screencommander)). If the frame is blank, un-minimize through Accessibility (`AXMinimized` false via System Events, no app activation), capture and minimize again, as Peekaboo does in the background ([Peekaboo](https://github.com/openclaw/Peekaboo)). Without Accessibility, fail with `permission_required`. Verify whether window-server frames of minimized windows can be stale.
- X11: iconified windows are unmapped and have no pixels. Try `xdotool windowmap --sync <id>`; if `xwininfo` does not report it viewable, save `xdotool getactivewindow` and use `xdotool windowactivate --sync`. Capture, `xdotool windowminimize <id>`, reactivate the saved window and report `focusChanged`. Covered windows are captured correctly only with a compositing manager; without one, add a warning.
- Wayland: no generic protocol captures or restores other clients' windows. Fail with `window_not_capturable` and suggest an X11 session, Xvfb or a headless browser.

### 3. Storage

Decision:

- Directory: `<Global.Path.data>/screenshots/`, by default `~/.local/share/opencode/screenshots/` (`$XDG_DATA_HOME/opencode/screenshots/`; opencode uses xdg-basedir on every OS). One flat folder; names `YYYYMMDD-HHmmss-<slug>-<4 hex>.png`, with an ASCII slug of at most 40 characters from the app or display. On POSIX the directory is created with mode 0700 and files with 0600; files are written to a temporary name and renamed.
- Writers: `screenshot` always; agent-driven captures (Playwright, headless Chromium) through the skill and the `show_image` description, which contain the absolute directory. `show_image` still accepts any readable path, for example `test-results/` inside the project.
- Allow-list `<data>/screenshots/*` in the default `external_directory` rules of both runtimes, next to the tool output and `<tmp>/opencode` entries, so shell writes and `show_image` reads there do not prompt.
- Retention: delete matching files older than 7 days at startup and at most hourly after writes, like `Truncate.cleanup`; never follow symlinks. The chat is unaffected: the session database stores its own normalized `data:` copy, so only Copy path, Reveal and re-reads by the agent need the file.
- Project copies only when the user asks (documentation images, bug-report assets, visual test baselines): the agent copies the file to the requested path with its shell tool, never creates `screenshots/` or similar folders on its own, and never stages or commits images unless asked.

Rationale:

- Repository hygiene and privacy: screen content is private and unrelated to the code. Files in the worktree show up in `git status`, are swept into opencode's session snapshots and review diffs, can trigger dev-server and test watchers, and are easy to commit by accident. Playwright MCP writes automatic artifacts to `.playwright-mcp` in the workspace; an issue about accidental commits of private browser data was closed with the advice to treat that folder like `.env` ([microsoft/playwright-mcp#1789](https://github.com/microsoft/playwright-mcp/issues/1789)). The default here avoids that problem instead of relying on `.gitignore`.
- Remote users never open these files: the chat renders the stored attachment, so the file location matters only on the host.
- `os.tmpdir()` (already allow-listed) is shared by all local users on Linux, cleared unpredictably and never cleaned on Windows. Screenshots are more sensitive than tool output, so the per-user data directory wins.
- Precedents: opencode keeps oversized tool output in `<data>/tool-output` with 7-day cleanup; Cursor saves generated images meant as project assets into `assets/` ([Cursor agent tools](https://cursor.com/docs/agent/overview#tools)), which matches "deliverables only on request".

### 4. Chat UI

Inline images:

- Generic media strip for every tool and both protocols: image attachments of completed tool parts below the tool row, in provider order; fixed thumbnail height (96 px; 64 px inside an expanded Explored group), width from the aspect ratio when known; `loading="lazy"`, `decoding="async"`; alt text from caption or filename.
- Shown-image card for `show_image` and `screenshot`: never grouped or muted, visible without expanding; preview up to 360 px tall (240 px at widths up to 640 px) with the aspect ratio reserved from metadata, so virtualized rows keep their height; caption, filename and `W×H`; a ⋯ button.
- Safety: only `data:image/(png|jpeg|gif|webp);base64,` renders inline. PDFs, SVGs and remote or unknown URLs become labeled chips; remote URLs never load automatically.
- User-message images use the same viewer and actions; composer previews keep `ImagePreview`.
- TUI: one line, `Image shown: <path> (W×H)` or `Screenshot: <app or display> (W×H)`.

Image viewer (click, Enter or Space on an image):

- New `ImageViewer` (`packages/ui/src/components/image-viewer.tsx`, CSS and story) on Kobalte Dialog.
- Opens fit to the viewport. Zoom 10 to 800% with the wheel or a trackpad pinch around the pointer, `+` and `-`, `0` for fit, `1` for 100%; double-click or double-tap toggles fit and 100%; drag or arrow keys pan when zoomed; from 200% use `image-rendering: pixelated` for pixel inspection.
- Gallery: all images of the current session in timeline order (user, tool and assistant file parts); `←` and `→` when not zoomed, side buttons, swipe at fit; counter such as `3 / 7`.
- Header: caption or filename, `W×H` and source (`screenshot · firefox`, `read · src/logo.png`, `You`). Toolbar: zoom out, zoom level, zoom in, fit, 100%, Save image, Copy image, ⋯ (all actions), Close. Up to 640 px wide: title, ⋯ and Close only.
- Esc closes; focus is trapped and returns to the source image; zoom level announced politely; `prefers-reduced-motion` disables zoom animation; only the current and adjacent images are decoded.

Image actions:

- Opened by right-click on any chat image (thumbnail, card or viewer), the ⋯ button (`DropdownMenu`), the keyboard (ContextMenu key or Shift+F10 on a focused image) or a long press on touch (verify Kobalte trigger support; the ⋯ button is the fallback). Shift+right-click keeps the native browser menu if the Kobalte trigger allows it; otherwise drop that behavior.
- One item list in `packages/session-ui/src/components/image-actions.tsx`, built on `packages/ui/src/components/context-menu.tsx` and `dropdown-menu.tsx`; pure helpers in `image-actions.ts` (data URL to Blob without `fetch`, PNG conversion, file names, availability rules).
- Platform-specific actions come from optional `DataProvider` callbacks (`onAttachImage`, `onOpenImageInNewTab`, `onRevealPath`); a missing callback hides its item, so session-ui stays platform-agnostic.

| Action | Shown when | Behavior |
| --- | --- | --- |
| Open | Always (not inside the viewer) | Opens the viewer at this image |
| Open in new tab | Browser app (callback present) | Opens a blob URL in a new tab and revokes it after 60 s; hidden in the desktop app |
| Copy image | Always; disabled with the reason when the page is not a secure context or `ClipboardItem` is missing | `navigator.clipboard.write` with `image/png`, converting other formats through a canvas; create the `ClipboardItem` synchronously with a Blob promise (Safari); toast on success or failure |
| Save image | Always | Download through `<a download>` named `<caption or tool>-<timestamp>.<ext>` on the browser device; the Electron desktop app shows its save dialog |
| Copy path | A host path is known (`show_image`, `screenshot`, `read`) | Copies the host path as text with `writeClipboard` (also works over HTTP) |
| Reveal in file manager | Desktop app with a local server (`platform.revealPath`) | Toast when the file no longer exists (retention) |
| Attach to message | A composer is available (callback present) | Adds the image to the current draft as an `ImageAttachmentPart` and focuses the composer, for follow-ups such as "what is wrong here?" |
| Go to message | Inside the viewer | Closes the viewer and scrolls to the source part |

Accessibility and localization: images are buttons labeled "Open image: <alt>"; viewer controls have labels and tooltips with shortcuts; menu items are keyboard reachable; strings go into all 62 locale files in `packages/ui/src/i18n`, and app-side strings into `packages/app/src/i18n` (its `parity.test.ts` checks key parity).

### 5. `capture-screenshot` skill

Shared content in `packages/core/src/plugin/skill/capture-screenshot.md`, registered like `customize-opencode` in `packages/opencode/src/skill/index.ts` and `packages/core/src/plugin/skill.ts`; `{{screenshots_dir}}` is replaced with the absolute directory at load; a user skill with the same name overrides it, and disabling it removes it. It loads on demand, which keeps per-request prompts small.

Description: "Use when the user wants to see, capture or visually check something: the screen, an application window, a web page or a test artifact."

Body:

1. Choose the target: desktop or app window → `screenshot` (run `action: "list"` first when the user names an app); web page → headless browser; existing artifacts (for example Playwright `test-results/`) → `show_image`; charts and diagrams → render to PNG, then `show_image`.
2. Web pages: the project's Playwright (`npx playwright screenshot --viewport-size=1280,800 <url> <file>`, `--full-page` when needed), otherwise headless Chrome or Chromium (`--headless=new --hide-scrollbars --window-size=1280,800 --screenshot=<file> <url>`), otherwise a configured Playwright or Chrome DevTools MCP server (its images render through M1). Wait until the page is ready; use 390x844 for mobile checks.
3. Save to `{{screenshots_dir}}/<timestamp>-<slug>.png`; never inside the repository unless the user asks for a project copy.
4. Headless hosts: web pages through a headless browser; desktop apps under `xvfb-run -a` or `Xvfb :99`, then `screenshot` with `x_display: ":99"`.
5. Privacy: capture the smallest target that answers the request (a window rather than the screen), avoid windows that show secrets, never put credentials on a command line, and say what the image contains.
6. After showing an image, tell the user what to look at; if the model cannot view images, say so instead of describing it.

### 6. Model context and budgets

- `data:` URLs; one image per `show_image` or `screenshot` call; parallel calls are allowed.
- Existing `attachment.image` limits. The original stays on disk; the chat and the model get the normalized copy.
- Vision gating at conversion time in both runtimes (see `show_image`).
- Later (M10): images count in prune estimates; measure image-heavy sessions; a media store only if the measurements justify it, and only behind the authenticated API.

## Milestones (each independently pushable)

### M0: plan

- Done in `ef7d980`; refined for handoff in the commit that adds this text.

### M1: inline tool-result images (UI only)

- Files: `packages/session-ui/src/components/tool-media.ts` (pure selection of ordered inline images and chips), `tool-media.tsx` and `tool-media.css`, `message-part.tsx` (render after the tool component in `ToolPartDisplay`; small thumbnails in expanded context groups), locale files. A click opens the existing `ImagePreview` until M2.
- Tests: `tool-media.test.ts` (order, MIME and URL filtering, PDF, SVG and remote chips, compacted parts still shown); Playwright `packages/app/e2e/regression/session-timeline-tool-images.spec.ts` with v1 and v2 fixtures for MCP-style and `read` images: preview opens and closes by mouse and keyboard; 1280 px and 390 px without horizontal overflow; row height stable after image load; answer and error typography unchanged.
- Benchmark: standard streaming fixture before and after, plus an image-history variant (10 turns with one PNG each) in `session-timeline-benchmark.fixture.ts`; `bun run test:stability`.
- Done when existing MCP screenshots and image reads are visible to the user without server changes.
- Commit: `feat(session-ui): render image attachments from tool results`.

### M2: image viewer and image actions (UI only)

- Files: `packages/ui/src/components/image-viewer.tsx`, `.css`, `.stories.tsx`; `packages/session-ui/src/components/image-actions.ts` and `image-actions.tsx`; `packages/session-ui/src/context/data.tsx` (optional callbacks); `message-part.tsx` (viewer and actions for user images, tool media and cards); `packages/app/src/pages/directory-layout.tsx` (wire callbacks to the active composer and `platform.revealPath`; use a session-level provider if the prompt context is not reachable there); locale files.
- Tests: helper unit tests (data URL decoding, conversion decision, file names, availability for insecure contexts, desktop and missing callbacks); Playwright `session-timeline-image-viewer.spec.ts`: open by click and Enter; zoom with buttons and keys; pan; previous and next across user and tool images; Esc returns focus; menu by right-click, ⋯ and Shift+F10; Copy image with clipboard permissions granted on localhost (read back `image/png`); Save image yields a download with the expected name; Attach to message adds a composer attachment; 390 px layout; timeline geometry unchanged when the viewer opens and closes.
- Commit: `feat(ui): add image viewer and image actions in chat`.

### M3: `show_image` in the legacy runtime (v1 protocol, usual `opencode web` host)

- Files: `packages/core/src/image/dimensions.ts` (shared PNG, JPEG, GIF and WebP header dimensions), `packages/opencode/src/tool/show-image.ts` and `show-image.txt`, `tool/registry.ts`, `permission/index.ts` (`disabled()` maps `show_image` to `read`), `session/message-v2.ts` (text-only note for `shown` attachments), a shown-image card in session-ui (reused by `screenshot`), the TUI line in `packages/tui/src/routes/session/index.tsx`, locale files.
- Tests: `packages/core/test/image-dimensions.test.ts`; `packages/opencode/test/tool/show-image.test.ts` (formats, rejections with hints, missing and directory paths, denied `read` pattern, external path asks, allow-listed path does not, oversize normalization and explicit failure, metadata); model-message conversion for Anthropic-style, OpenAI-compatible and text-only models; Playwright fixture for the card.
- Commit: `feat(opencode): add show_image tool for user-visible images`.

### M4: `show_image` in the core runtime and image capability gating

- Files: `packages/core/src/tool/show-image.ts` and `tool/builtins.ts` (reuse `ReadToolFileSystem` resolution and permissions and `Image.Service`); gating in `toLLMMessages(messages, model)` from `model.capabilities.input`, matching legacy behavior for unknown capabilities. Confirm which field carries tool metadata to the app (`state.metadata` or `structured`).
- Tests: `packages/core/test/tool-show-image.test.ts` mirroring M3; lowering tests for vision and text-only models; existing `read` and `websearch` suites unchanged.
- Commit: `feat(core): add show_image tool and image capability gating`.

### M5: screenshot storage and `capture-screenshot` skill

- Files: `packages/core/src/screen-capture/storage.ts`; the allow-list entry in `packages/opencode/src/agent/agent.ts` and `packages/core/src/plugin/agent.ts`; startup cleanup in both runtimes; `packages/core/src/plugin/skill/capture-screenshot.md` registered in both runtimes with `{{screenshots_dir}}` substitution (web pages and artifacts now; the desktop section lands with M6); `show_image` descriptions reference the directory; docs `packages/web/src/content/docs/tools.mdx` and `skills.mdx`.
- Tests: storage (names, modes, retention touches only matching files, symlinks ignored); skill listed, loadable, overridable and disable-able in both runtimes; request-capture test that the tool definition and skill summary reach the provider request; a path under `<data>/screenshots/` needs no `external_directory` prompt in either runtime.
- Manual smoke test with a real model: from a phone browser, ask for a screenshot of a local dev page.
- Commit: `feat: add screenshot storage and capture-screenshot skill`.

### M6: `screenshot` tool foundation and X11 backend

- Files: `packages/core/src/screen-capture/{index,schema,detect,select,blank,x11}.ts`; `packages/opencode/src/tool/screenshot.ts`, `screenshot.txt` and registry; `packages/core/src/tool/screenshot.ts` and `builtins.ts`; `screenshot: ask` defaults in both runtimes; the `screenshot` key in `packages/core/src/v1/config/permission.ts`; card reuse; TUI line; `permissions.mdx`; the skill's desktop section.
- Tests: unit tests with a fake process runner (matching and ambiguity, parsing fixtures for `wmctrl`, `xprop` and `xrandr`, restore bookkeeping including failures and timeouts, blank detection, error mapping, availability); an integration test gated by `OPENCODE_TEST_XVFB=1` (Xvfb with a test window: capture display and window, minimize, capture with restore, assert minimized again); permission patterns; `deny` hides the tool.
- Commit: `feat: add screenshot tool with X11 backend`.

### M7: Windows backend (and WSL)

- Files: `packages/core/src/screen-capture/windows.ts`, `windows.ps1`, `wsl.ts`.
- Tests: unit tests for command assembly, JSON parsing and error mapping; the manual matrix on Windows 10 and 11 and on WSL 2.
- Commit: `feat: add Windows screenshot backend`.

### M8: macOS backend

- Files: `packages/core/src/screen-capture/macos.ts` and `macos.jxa`; `packages/core/src/script.d.ts` declares the JXA helper as a text module.
- Tests: unit tests for command assembly, JXA payload construction, list parsing, window selection, minimized restore and re-minimize cleanup, and error mapping; the manual matrix with Screen Recording and Accessibility on and off.
- Commit: `feat: add macOS screenshot backend`.

### M9: Wayland backends

- Files: `packages/core/src/screen-capture/wayland.ts`.
- Tests: unit tests for detection and command selection; the manual matrix on GNOME, KDE Plasma and Sway or Hyprland.
- Commit: `feat: add Wayland screenshot backends`.

### M10: hardening (one commit per item)

- Prune estimates include images (dimension-based token estimate).
- Image-heavy measurements: session load time, event payload size, memory at 390 px; switch rendered images to blob URLs if memory is high.
- Windows restore without a visible flash (temporarily near-transparent layered window), only if reliable.
- Optional: honor MCP `annotations.audience`; plugin tool attachments (#21383).

### M11: deferred unless data justifies it

- Media store behind the authenticated API (fetch to blob URL).
- Built-in URL screenshot tool, if shell or MCP capture of web pages proves unreliable.
- Region capture, annotation, recordings.

## Validation

- Formats: PNG, JPEG, GIF (animated GIFs become one frame when resized), WebP; rejected: SVG, BMP, HEIC, AVIF, TIFF, PDF, zero-byte, truncated and renamed non-images.
- Paths: relative, absolute inside the project, under `<data>/screenshots/`, external (asks), denied `read` pattern, Windows drive and UNC paths, spaces and Unicode.
- Sizes: tiny, 1280x720, 2880x1800 Retina (resized), still over the byte limit after resizing (explicit failure), resizer unavailable.
- Models and protocols: Anthropic, OpenAI Responses, OpenAI-compatible chat, Gemini, Bedrock, text-only.
- Sessions: v1 and v2 protocols, reload and reconnect, compacted parts, child sessions, shared sessions.
- UI: 1280 px and 390 px, keyboard only, screen-reader labels, viewer zoom, pan and gallery, every action (HTTP and HTTPS origins, browser and desktop app), long captions, many images, light and dark themes.

Capture matrix (expected behavior; check each row on the platform's milestone):

| Scenario | Windows | macOS | X11 | Wayland |
| --- | --- | --- | --- | --- |
| Primary, one or all displays; mixed DPI | Yes | Yes (backing scale) | Yes (`xrandr` crop) | `grim`, Spectacle, portal |
| Foreground window | Yes | Yes | Yes | wlroots region, KDE active window |
| Covered window | Yes | Yes | With a compositor; otherwise a warning | `window_not_capturable` |
| Minimized window | Restore without activation, capture, minimize | Window server; Accessibility restore if blank | Map or activate, capture, minimize, focus restored | `window_not_capturable` |
| Other virtual desktop or Space | Best effort, blank check | Yes (window server) | `window_not_capturable` | `window_not_capturable` |
| Protected or capture-excluded window | `blank_capture` | `blank_capture` | n/a | n/a |
| Elevated window | `window_not_capturable` if the restore fails | n/a | n/a | n/a |
| Locked screen, disconnected RDP | `blank_capture` | `blank_capture` | n/a | n/a |
| Service or SSH session | `no_interactive_session` | `no_interactive_session` | `no_display` without `DISPLAY` | `no_display` |
| Missing permission or tool | n/a | `permission_required` | `missing_dependency` | `permission_required` or `missing_dependency` |
| Headless host | n/a | n/a | Xvfb through `x_display` | n/a |

Also check: focus and stacking unchanged after every capture; the original state is restored after a forced timeout; two concurrent calls serialize; Chromium, Electron (VS Code), UWP and full-screen apps on Windows.

## Risks

- Token cost and context growth: normalization limits, prune accounting (M10), clear `read` versus `show_image` wording.
- Payload and storage growth from base64: measure in M10 before any storage change.
- Sensitive screen content: `ask` by default, smallest-target guidance, per-user storage with short retention; images stay inside the existing session and provider trust boundary.
- Window manipulation side effects: brief flashes, focus changes on X11, failed restores; mitigated by finalizers, the mutex and reporting.
- OS permission friction for remote users: prompts appear on the host; errors must say exactly what to enable on the host.
- Platform drift: capture tools and permissions change between OS releases; keep backends isolated and covered by the manual matrix.
- Virtualized timeline jumps: fixed thumbnail height, reserved aspect ratio, the existing ResizeObserver measurement.
- Child sessions: images shown by a subagent appear only in its child session; the primary agent can show them again by path.

## Open questions (defaults apply until decided)

1. Windows minimized restore: ship the plain restore without activation (brief flash); adopt a hidden restore in M10 only if it proves reliable.
2. GNOME on Wayland: use the screenshot portal when a non-interactive capture succeeds; otherwise report `unsupported`.
3. `display: "all"` on macOS: one `screencapture -R` with the union of display bounds if that works on two displays; otherwise compose per-display captures with photon.

## Handoff

Before coding:

- Read `AGENTS.md` and `CONTRIBUTING.md` at the root, plus the guides for the packages you touch: `packages/opencode/AGENTS.md`, `packages/opencode/test/AGENTS.md`, `packages/opencode/src/session/llm/AGENTS.md`, `packages/core/src/tool/AGENTS.md` (tool architecture rules), `packages/llm/AGENTS.md`, `packages/schema/AGENTS.md`, `packages/ui/AGENTS.md` and `packages/session-ui/AGENTS.md` (localization rules), `packages/app/AGENTS.md`, `packages/app/e2e/AGENTS.md`, `packages/app/e2e/performance/AGENTS.md` with its `README.md`, and `packages/desktop/AGENTS.md` when wiring desktop actions.
- Re-verify "Current state" against the branch head; files move and line numbers drift.

Setup and commands:

- Bun 1.3.14 (`packageManager` in the root `package.json`): `bun install --frozen-lockfile` (add `--ignore-scripts` only if postinstall scripts fail in a sandbox). Playwright browsers: `cd packages/app && bunx playwright install chromium`.
- Never run tests from the root (its `test` script exits on purpose). Run per package and serially on small machines (4 GB sandboxes run out of memory with parallel suites):
  - `packages/ui`, `packages/session-ui`: `bun test src/<file>`, `bun run typecheck`
  - `packages/core`: `bun test test/<file>`, `bun run typecheck`
  - `packages/opencode`: `bun test test/<file>`, `bun run typecheck`
  - `packages/app`: `bun run typecheck`, `bun run typecheck:e2e`, `bunx playwright test e2e/regression/<spec>`, production build `bun run build`
  - root: `bun run lint` (oxlint)
- Benchmark for timeline-affecting milestones (M1 to M3): from `packages/app`, three runs before and three after on the same machine. The config builds and serves the production bundle; there are no pass/fail thresholds, so record medians (completion time, RAF gaps, long tasks, layout shifts) in the commit body and in Progress. Also run `bun run test:stability`.

```sh
PLAYWRIGHT_WORKERS=1 TIMELINE_HISTORY_TURNS=20 TIMELINE_DELTA_COUNT=20 TIMELINE_CPU_THROTTLE=1 \
  bunx playwright test --config e2e/performance/playwright.config.ts \
  e2e/performance/timeline/session-timeline-benchmark.spec.ts \
  -g "streams assistant text in v2 with review pane closed"
```

Definition of done for every milestone:

- Scope limited to the milestone; touched packages typecheck; new and affected tests pass; Playwright regressions for UI work; benchmark recorded when the timeline changes; every new string localized per `packages/ui/AGENTS.md`; user-visible behavior documented; Progress updated.
- Conventions: Solid reactive props through getters; no app `*.test.tsx`; Effect services and `AppProcess` for subprocesses; no new dependencies without discussion; generated SDKs and clients regenerated by their scripts, never edited by hand.
- Commit with the listed message, push to `v2-ui-enhancements`, do not merge into `dev` unless asked, do not restart a live host.

## References

- MCP tool results: <https://modelcontextprotocol.io/specification/2025-06-18/server/tools>
- Codex `view_image`: <https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/view_image_spec.rs>, <https://github.com/openai/codex/issues/12439>
- Claude MCP images collapsed: <https://github.com/anthropics/claude-code/issues/53256>
- Roo base64-as-text regression: <https://github.com/RooCodeInc/Roo-Code/issues/8045>
- Cursor: <https://cursor.com/docs/agent/tools/browser>, <https://cursor.com/docs/agent/overview#tools>
- Goose `read_image`: <https://goose-docs.ai/docs/mcp/developer-mcp>
- Playwright MCP: <https://github.com/microsoft/playwright-mcp>, <https://github.com/microsoft/playwright-mcp/issues/1185>, <https://github.com/microsoft/playwright-mcp/issues/1789>
- Upstream opencode: <https://github.com/anomalyco/opencode/issues/21227>, <https://github.com/anomalyco/opencode/issues/16234>
- Windows capture: <https://github.com/microsoft/Windows.UI.Composition-Win32-Samples/blob/master/cpp/ScreenCaptureforHWND/README.md>, <https://webrtc.googlesource.com/src/+/bde80e3c0ec2be96189087cf36e254f9c4bfb144/modules/desktop_capture/win/window_capturer_win_gdi.cc>, <https://chromium.googlesource.com/chromium/src/+/refs/heads/main/ui/snapshot/snapshot_win.cc>, <https://github.com/browser-use/windows-harness/blob/main/src/windows_harness/capture.py>
- macOS capture: <https://developer.apple.com/videos/play/wwdc2022/10155/>, <https://github.com/0xSMW/screencommander>, <https://github.com/openclaw/Peekaboo>
- Cross-platform library: <https://github.com/nashaofu/xcap>
- Clipboard: <https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/write>, <https://developer.mozilla.org/en-US/docs/Web/API/ClipboardItem/supports_static>

## Progress

- M0: plan written (`ef7d980`).
- M0 refinement: screenshot tool with window capture, storage decision, image viewer and actions, handoff notes.
- M1: inline tool-result images implemented (`25c352a`). `tool-media.ts` selects ordered inline
  `data:image/(png|jpeg|gif|webp);base64` attachments and downgrades PDF/SVG/remote/unknown attachments to chips;
  `tool-media-view.tsx` renders 96px thumbnails (64px inside an expanded context group) as siblings of the tool
  row, outside the collapsible, with click/Enter/Space opening the existing `ImagePreview`; `message-part.tsx`
  wires both `ToolPartDisplay` and `ContextToolGroup`. New keys `ui.toolMedia.openImage|image|file` exist in
  `en.ts` and all 61 non-English locales as explicit English source-copy fallbacks. Validation: 7 `tool-media`
  unit tests and 90 session-ui tests pass; session-ui, ui, app and app/e2e typechecks pass; app i18n parity
  passes (5 tests / 979 assertions); 9 new production-browser regressions pass (v1/v2 MCP + `read` images,
  preview mouse/keyboard, compacted parts, PDF/SVG/remote chips, 1280/390 no-overflow, row-height stability,
  answer/error typography). Production streaming (v2, review closed, 20 history turns, 20 deltas, throttle 1,
  minimal probes): initial content 368.9ms, completion 5095.3ms, progress frame-gap p95 16.7ms, no long tasks,
  row or markdown replacement. Image-history variant (one PNG per history turn): 366.3ms / 4900.8ms / 16.7ms.
  Single observations, not a performance guarantee. Environment limits observed, not introduced by M1: the
  `adverse` virtualization stability test fails on the pristine branch head too, and the app unit suite has the
  same 10 pre-existing solid-js `use` export failures (800 pass of 810) on the pristine head. Full
  `test:stability` is 42 pass / 1 pre-existing fail. Committed as `25c352a`; no merge, deploy or live-host restart performed.
- M2: image viewer and image actions implemented. `image-viewer.tsx` (+ CSS/story)
  is a Kobalte dialog gallery over the current session's inline images with fit/10-800% zoom (wheel/trackpad,
  `+`/`-`, `0`, `1`, double-click), pan/swipe, keyboard navigation, counter, W×H/source header, Save/Copy/⋯/Close
  toolbar, compact toolbar under 640px, reduced-motion, polite zoom announcements and focus return. `image-gallery.ts`
  keeps only `data:image/(png|jpeg|gif|webp);base64` items in timeline order and labels user images `You`;
  unsupported file parts stay as chips/fallback cards and are never loaded. `image-actions-helpers.ts` +
  `image-actions-menu.tsx` (split rather than the plan's same-basename `.ts`/`.tsx` pair, which the bundler resolves
  ambiguously) provide one action list by right-click, ⋯, ContextMenu/Shift+F10 and Kobalte long-press. Copy image is
  gated by MIME and secure context/`ClipboardItem`; Save only appears for inline images; Copy path/Reveal only for
  absolute host paths; Open in new tab only in the web app (validated blob URL via `<a>`); Attach only when a composer
  registered; Go to message inside the viewer. The viewer actions menu closes on the first Escape and returns focus to
  its trigger; the viewer ignores gallery/zoom keys while a menu is open; RTL swaps ArrowLeft/ArrowRight for
  previous/next and the icons auto-flip. The user-image ⋯ overlays the 58×46 (48×48 v1) thumbnail instead of adding
  26px. `ui.imageViewer.*` and `ui.imageActions.*` keys (including `source.you` and `attachFailed`) exist in `en.ts`
  and all 61 non-English locales as English fallbacks; app-side attach/open/reveal callbacks are wired in
  `directory-layout.tsx` (attach only with the v2 composer, new tab only in web, reveal only desktop+local). The
  legacy toast region stays mounted beside the v2 region because session-ui toasts use the legacy toaster.
  Validation: 115 session-ui + 27 ui unit tests, app i18n parity (5/979), all typechecks, 20/20 Playwright M1+M2
  regressions (v1/v2 viewer, zoom/pan, gallery order, menu by right-click/⋯/Shift+F10, two-stage Escape and menu key
  isolation, clipboard read-back, download name, attach and focus, 390px, user overlay/`You`, geometry unchanged).
  Full `test:stability` is 43 pass / 1 pre-existing `adverse` fail; a later repeat also flaked the
  `context-first-remove` motion check (passed 2/3 isolated repeats). The app unit suite is the same pre-existing
  800/810 with solid-js `use` errors. Production streaming (v2, review closed, 20 history turns, 20 deltas,
  throttle 1, minimal probes): baseline 392.3ms / 4909.1ms / 16.8ms p95; image-history 371.2ms / 4934.7ms / 16.8ms
  p95 (M1: 368.9 / 5095.3 / 16.7 and 366.3 / 4900.8 / 16.7), no long tasks, no row or markdown replacement. The
  default throttle-30 320-turn/160-delta benchmark also passes with zero geometry drift and zero blank samples.
  Known gaps: Electron Save relies on Chromium's default download prompt (confirmed in Electron's DownloadItem
  docs), not an explicit save IPC; v1 layout hides Attach because its composer does not register the handler. No merge,
  deploy or live-host restart performed.
- M3: `show_image` in the legacy runtime implemented. `packages/core/src/image/dimensions.ts`
  parses PNG/JPEG/GIF/WebP headers; `tool/show-image.ts` mirrors `read` path resolution, external-directory/read asks,
  rejects missing files, directories, SVG/BMP/TIFF/HEIC/AVIF and raw files over 20 MB, normalizes via `Image.Service`
  (falls back to the original only on `ResizerUnavailableError`, fails other normalizer errors explicitly), and returns
  `{ path, name, mime, width, height, bytes, caption?, resizedFrom?, shown: true, truncated: false }` with a data-URL
  attachment. Registered beside `read`; `Permission.disabled` maps `show_image` to `read`. `message-v2.ts` drops shown
  media and appends `SHOWN_IMAGE_TEXT_ONLY_NOTE` only when `model.capabilities.input.image === false`; vision and
  non-shown behavior is unchanged. The session-ui `shown-image-card` renders only completed `shown` parts with safe
  inline media (mock screenshot parts without `shown` stay tool media), outside the collapsible/context group, with
  caption/name, filename/W×H, 360px/240px preview caps, gallery open, actions menu and viewer metadata path/caption;
  generic `ToolMedia` is suppressed. TUI renders `Image shown: <path> (W×H)` in `theme.text`. Copy path now prefers
  `navigator.clipboard.writeText` with a textarea/`execCommand` fallback, fixing the empty-clipboard read-back. No new
  locale keys. Validation: core 5/5; opencode targeted 73/73 (show_image 15/15) + read/image 44/44; session-ui 126/126;
  TUI 3/3; app typecheck; 23/23 Playwright M1+M2+M3 regressions (v1/v2 tool images, viewer, shown card at 1280/390,
  actions/clipboard/download/viewer menu, geometry); `test:stability` 42 pass / 2 fails (known `adverse` + flaky
  `context-first-remove`). `packages/opencode` typecheck still reports only the two pre-existing `httpapi-*` test-layer
  errors. Production streaming medians of 3 (20 turns/20 deltas, throttle 1, minimal): review closed
  384.9ms / 4860.2ms / 16.7ms p95; image history 395.7ms / 5080.5ms / 16.7ms p95; no long tasks, no row/markdown
  replacement, zero 33/50ms gaps. M2 single observations were 392.3 / 4909.1 / 16.8 and 371.2 / 4934.7 / 16.8.
  Commit: `feat(opencode): add show_image tool for user-visible images`.
- M4: `show_image` in the core runtime and image capability gating implemented. `packages/core/src/tool/show-image.ts`
  and `show-image.txt` mirror the legacy contract with `LocationMutation`/`FSUtil` path resolution, external-directory
  then `read` asks, missing/directory/format/20 MB rejection hints, `Image.Service` normalization with explicit
  decode/size failures and `ResizerUnavailableError` fallback, final `{ path, name, mime, width, height, bytes,
  caption?, resizedFrom?, shown: true, truncated: false }`, and a text + image `file` content result. It is registered
  in `builtins.ts` through `Tool.withPermission(..., "read")`, so a wholly denied `read` hides it. The tool uses
  `LocationMutation` and `FSUtil` directly rather than `ReadToolFileSystem` because the reader maps unsupported formats
  to `BinaryFileError` instead of the requested conversion hints. `SessionRunnerModel` gained an optional
  `capabilities` method (with a shared catalog selection helper and optional `layerWith` seam); the runner resolves it
  beside the model, and `toLLMMessages(messages, model, capabilities)` drops shown `file` content and appends
  `SHOWN_IMAGE_TEXT_ONLY_NOTE` only when capabilities are known and `input` lacks `"image"`. Unknown capabilities,
  vision models and non-shown images keep media. The app now reads `metadata ?? structured ?? {}` in
  `session-message.ts` and the v2 reducer, bridging core `structured` metadata into the existing `ToolPart.state.metadata`
  used by the shown-image card. Validation: core targeted 129/129 (show_image 15, runner conversion/model 114), core
  typecheck; app targeted 9/9, app typecheck; full core suite 1159 pass / 16 fail, all unrelated environment checks
  (15 `cross-spawn` tests need the absent `node` binary, 1 `ProjectCopy` git-worktree force assertion in an untouched
  file). No benchmark or Playwright run: M4 changes no timeline/UI rendering. No merge, deploy or live-host restart
  performed. Commit: `feat(core): add show_image tool and image capability gating`.
- M5: screenshot storage and the `capture-screenshot` skill implemented. `packages/core/src/screen-capture/storage.ts`
  writes `<data>/screenshots/YYYYMMDD-HHmmss-<slug>-<4 hex>.png` (0700 directory/0600 files, temporary file plus
  rename), rejects symlinked directories/files during write and cleanup, and deletes matching files older than 7 days
  at startup and hourly through `cleanupNode`; the core server and both legacy app layers install cleanup.
  `<data>/screenshots/*` is allow-listed in the core and legacy agents. `capture-screenshot.md` is registered as a
  built-in in both runtimes before disk discovery, substitutes `{{screenshots_dir}}`, can be overridden by a same-name
  disk skill and hidden with a `permission.skill` deny. The `show_image` descriptions use the resolved directory; docs
  cover `show_image` and built-in skills. Validation: core targeted 34/34 (135 assertions across storage/skill/agent/
  show-image), core and server typechecks; legacy targeted 138 pass/1 skip (skill/agent/prompt/show-image), legacy skill
  rerun 20/20; `packages/opencode` typecheck still reports only the two pre-existing `httpapi-*` test-layer errors. No app
  change, benchmark or Playwright run; manual phone smoke not performed. Commit:
  `feat: add screenshot storage and capture-screenshot skill`.
- M6: `screenshot` tool foundation and X11 backend implemented. `packages/core/src/screen-capture/` adds the capture
  schema/service, X11 display/window selection, X11 parsing, blank-frame rejection, backend detection and a one-at-a-time
  capture mutex; `packages/core/src/tool/screenshot.ts` registers the core built-in, and `packages/opencode/src/tool/screenshot.ts`
  plus the legacy registry provide the same tool when an X11 backend is detected. `list` exposes displays and windows;
  `capture` saves the full-resolution PNG through M5 storage and returns a normalized `shown: true` attachment with
  `savedBytes` and optional `capturedFrom`. Permission defaults are `ask` in both runtimes, the config key is
  discoverable, and resources are `list`, `screen` or lowercased `window:<selector>`; `deny` hides the tool. The skill,
  tool and permission docs describe the X11 behavior and the shared shown-image card plus TUI line render screenshot
  metadata. Validation: core targeted 29/29 (101 assertions across X11/screenshot tool/agent), legacy targeted 149/149
  (302 assertions across screenshot tool/permission/agent/registry), TUI 8/8, session UI 12/12, and core, opencode, TUI and
  session-UI typechecks pass. No app Playwright run was needed. Real X11 and gated Xvfb integration checks were not
  performed: this headless host lacks `Xvfb`, `xvfb-run` and a test-window tool. Commit:
  `feat: add screenshot tool with X11 backend`.
- M7: Windows and WSL screenshot backends implemented. `Backend` is now the `X11Backend | WindowsBackend` union; native
  Windows reports backend `windows` and platform `win32`, while WSL reports backend `wsl` and platform `linux`. Detection
  selects `powershell.exe` on Windows, requires `powershell.exe` plus `wslpath` and a WSL environment marker on Linux, and
  prefers an explicit X11 display when one is available. Windows and WSL send a small `-EncodedCommand` bootstrap whose
  JSON stdin carries the embedded PowerShell source plus the operation, avoiding the Windows command-line length limit;
  PowerShell returns JSON on stdout and a coded JSON error on stderr. `ScreenCapture.available()` was added so the core
  tool is registered only when a backend is detected, matching the legacy registry. The generic blank-capture message no
  longer names only X11. Validation: core targeted 45/45 (157 assertions across Windows, detection, X11, screenshot tool,
  agent and location tools), legacy targeted 149/149 (302 assertions across screenshot, permission, agent and registry),
  and core plus opencode typechecks pass. Full core is 1203 pass / 16 fail, matching the unchanged environment baseline:
  15 cross-spawn tests plus one worktree assertion require the absent `node` binary. The manual Windows 10/11 and WSL 2
  matrices, and therefore PowerShell 5.1 runtime behavior, were not performed because this Linux host has no
  `powershell.exe`. Commit: `feat: add Windows screenshot backend`.
- M8: macOS screenshot backend implemented. `Backend` is now the `X11Backend | WindowsBackend | MacOSBackend` union, and
  `darwin` detection requires both `osascript` and `screencapture`. The backend runs JXA through
  `osascript -l JavaScript -e <loader>` with a JSON stdin payload containing the base64-encoded `macos.jxa` source, and
  uses `NSScreen`, `CGWindowListCopyWindowInfo`, and `screencapture` for list, screen, and window capture. Screens use
  `-D` for numbered displays and `-R` for the union bounds of all displays; windows use `-x -o -l <decimal window id>`
  and write PNGs through a temporary file that is removed in the finalizer. Offscreen/minimized windows are captured
  through the window server when possible, restored through Accessibility JXA only when the first PNG is blank, and
  re-minimized in a finalizer even if the second capture fails. The JXA helper is stored as `macos.jxa` (not `macos.js`)
  so TypeScript imports it as a text module without colliding with `macos.ts`. Validation: core targeted 58/58 (216
  assertions across macOS, detection, Windows, X11, screenshot tool, agent, and location tools), core typecheck, and full
  core 1216 pass / 16 fail matching the unchanged environment baseline (15 cross-spawn tests plus one worktree assertion
  require the absent `node` binary). The real macOS Screen Recording and Accessibility matrices were not performed because
  this Linux host has no `osascript` or `screencapture`. Commit: `feat: add macOS screenshot backend`.
