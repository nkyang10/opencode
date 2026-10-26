# Agent image display (screenshots in chat)

Baseline: `7f9e384803f6cff5d46d99decf7e3a02757dc47a` on `v2-ui-enhancements`. This commit is the plan only; no runtime change.

## Goal

A user driving opencode through the web UI from another device can ask: "run the app or tests, take a screenshot, and show me". The agent knows that it can (1) capture an image on the host, (2) present it in the chat, and (3) inspect the same image itself when the model supports images. The image travels as a typed part of the tool result next to the text output, never as base64 prose or as a host path the remote browser cannot open.

## Guardrails

- Same workflow as `v2-ui-enhancements`: small independent commits, push each milestone to `v2-ui-enhancements`, merge to `dev` only on request, no hand-edited generated clients, no live host restart.
- Paths refer to the connected host, not the browser device.
- No unauthenticated asset route, no credentials in URLs (for example the `auth_token` query), no reverse-proxy media folder.
- New UI strings need entries in every locale; reactive JSX props use getters; no app `*.test.tsx`.
- Timeline rendering changes need the production streaming benchmark before and after.
- No paid LLM calls in tests; use fixtures and fake providers.

## Current state (verified in code)

Already working:

- Tool results can carry images. Legacy runtime: `Tool.ExecuteResult.attachments` (`packages/opencode/src/tool/tool.ts`), stored as `ToolPart.state.attachments` with `data:` URLs. Core (v2) runtime: tool `content` items `{ type: "file", uri, mime, name }` (`packages/core/src/tool/tool.ts`, `packages/schema/src/llm.ts`).
- Producers: `read` and `webfetch` in both runtimes, MCP `image` content and blob resources (`packages/opencode/src/session/tools.ts`).
- Normalization: photon resize to at most 2000x2000 and 5 MB base64, configurable through `attachment.image` (`packages/opencode/src/image/image.ts`, applied in `session/processor.ts`; `packages/core/src/image.ts`, applied in core `read`).
- Model lowering: legacy `MessageV2.toModelMessages` keeps media inside tool results for providers that support it and otherwise moves it into a synthetic user message; `ProviderTransform.unsupportedParts` turns images for text-only models into `ERROR: Cannot read ... Inform the user.` Core lowers per protocol (`packages/llm/src/protocols/*`); OpenAI Chat moves tool images into a following user message.
- Pruning only sets `time.compacted`; stored attachments remain, but are no longer sent to the model.
- ACP already forwards tool image attachments (`packages/opencode/src/acp/tool.ts`).
- The app maps core tool `file` content to `ToolPart.state.attachments` (`packages/app/src/utils/session-message.ts`), so one renderer serves both protocols.
- The app selects the v1 protocol whenever `/global/health` is healthy (`packages/app/src/utils/server-protocol.ts`), so the legacy runtime serves the usual `opencode serve` / `opencode web` host.

Gaps:

1. The UI drops tool-result images. `ToolPartDisplay` in `packages/session-ui/src/components/message-part.tsx` never reads `state.attachments`; only user-message attachments render (with `ImagePreview`). Screenshots reach the model, not the user. Upstream: anomalyco/opencode#21227, draft PR #39817.
2. No tool means "show this to the user". `read` is inspection, is grouped into collapsed Explored activity, and its description only says images come back as attachments.
3. No capture guidance. On a remote or headless host the agent must choose a browser or screenshot command and a save location; saving outside the project triggers `external_directory` prompts. `Global.Path.tmp` (`os.tmpdir()/opencode`) is allow-listed by default for legacy agents.
4. Core has no equivalent of `unsupportedParts` (verify): images sent to a text-only model may be rejected by the provider.
5. Prune estimates count only text output, so screenshots never add pruning pressure.
6. Plugin tools cannot return attachments (upstream #21383); out of scope unless requested.

Constraints that shape the design:

- The app authenticates with an `Authorization: Basic` header. A plain `<img src="https://host/...">` cannot send it, so server-URL images would need an authenticated fetch-to-blob path. `data:` URLs inside message payloads (already used for pasted images) need no new route and work across devices.
- The Markdown sanitizer allows `<img>`. A Markdown image pointing at a host path resolves against the web UI origin and breaks; remote Markdown images are a known exfiltration channel. Agents must not be taught Markdown image embedding.

## How other agents do it

| Agent / standard | Mechanism | User display | Lesson |
| --- | --- | --- | --- |
| MCP specification | Tool result item `{ type: "image", data, mimeType }` with optional `annotations.audience` (`user`, `assistant`) and `priority` | Client decides | Images are typed result blocks; audience separates user-facing from model-facing content |
| OpenAI Codex CLI | Built-in `view_image(path)` attaches a local image to the turn | Inline in the TUI | A dedicated local-image tool makes the capability discoverable; its wording controls when the model uses it (openai/codex#12439) |
| Claude Code / Claude apps | `Read` returns images; screenshots through Playwright or Chrome DevTools MCP | MCP images collapsed by default in claude.ai (anthropics/claude-code#53256) | Do not hide the main deliverable behind a collapsed tool card |
| Cline / Roo Code | `browser_action` returns a screenshot and console logs after every action | Screenshot in chat | Roo regression showed base64 as text (RooCodeInc/Roo-Code#8045); keep images structured |
| Cursor | Built-in browser tool; generated images saved to `assets/` | Inline in chat | Capture to a file, then display inline |
| Goose | Developer extension `read_image` | Model inspection | Same local-image primitive |
| Playwright MCP | `browser_take_screenshot` returns image content and saves a file; `--image-responses allow\|omit\|only` | Client decides | Large images overflow context (microsoft/playwright-mcp#1185); enforce limits |
| opencode upstream | Requests #21227 and #41038; workaround #16234 (Caddy `/media` plus Markdown) | Not rendered | Confirms the gap; the workaround bypasses auth and should not be copied |

Common pattern: capture with shell or browser automation (or MCP) into a file; return it as a typed image block in the tool result; render image blocks visibly by default with click-to-zoom; keep images inside size and token budgets; expose a clearly named tool so the model knows it can show images.

## Design

### `show_image` tool (both runtimes)

- Input: `path` (image on the host, absolute or relative to the working directory) and optional `caption` (short; used as caption and alt text).
- Policy: same path resolution, `read` permission patterns and `external_directory` rules as `read`. No network fetch; remote images go through `webfetch` (rendered by M1) or are downloaded first.
- Validation: sniff magic bytes and accept PNG, JPEG, GIF and WebP only. Reject SVG, BMP, HEIC, AVIF and TIFF with a conversion hint. Refuse directories, missing files and files above a raw-size cap before reading them.
- Normalization: call the existing image normalizer inside the tool, so an oversized image fails explicitly instead of receiving the processor's silent "omitted" note, and the reported dimensions are final.
- Result: one image attachment (legacy) or one `file` content item (core) plus text such as `Shown to the user: screenshots/home.png (PNG, 1280x720, 142 KB).` Metadata / structured output: `{ path, name, mime, width, height, bytes, caption, resizedFrom? }`.
- Text-only models: decide at model-message conversion, because the model can change between turns. Keep the stored attachment for the UI, drop it from model context and add a neutral note ("The current model cannot view images; do not describe this image.") instead of the generic `ERROR`.
- Description (short, always in the tool list): use when the user should see an image (screenshot, rendered page, chart, generated asset); the user may be on another device and cannot open host files; use `read` when only the agent needs to inspect an image; never paste base64 or Markdown image paths; save captures in the allow-listed temp directory; load the `capture-screenshot` skill for capture recipes.

### UI

- Generic tool media (every tool, both protocols): render image attachments of completed tool parts below the tool row in provider order. Click or keyboard opens `ImagePreview`; alt text comes from caption or filename; `loading="lazy"` and `decoding="async"`.
- Layout: generic thumbnails use a fixed height with automatic width, so virtualized rows never change height on load; `show_image` reserves the aspect ratio from metadata. No horizontal overflow at 390 px.
- Safety: only `data:image/(png|jpeg|gif|webp);base64` renders inline. PDFs, SVGs and remote or unknown URLs become labeled chips; remote URLs are never loaded automatically.
- Context-grouped `read` images appear as small thumbnails only inside an expanded Explored group; they are not promoted.
- `show_image` renderer: never context-grouped or muted and visible without expanding; shows caption, filename and dimensions with actions to open at full size and download. Failures use the existing error card.
- TUI: a single line, `Image shown: <path> (WxH)`; the image itself is not rendered.

### Capture guidance: built-in `capture-screenshot` skill

Register it like the existing built-in `customize-opencode` skill: a user skill with the same name overrides it, and disabling it removes it from agent guidance. It loads on demand, which keeps per-request prompts small. Contents:

- Pick the target: a web page (dev server or preview URL), a test artifact (for example Playwright `test-results/`), a desktop application window, or a generated chart or diagram.
- Web: prefer the project's Playwright (`npx playwright screenshot --viewport-size=1280,800 <url> <file>`, add `--full-page` when needed); otherwise headless Chromium or Chrome (`--headless=new --hide-scrollbars --window-size=1280,800 --screenshot=<file> <url>`); otherwise a configured Playwright or Chrome DevTools MCP server, whose image results render through M1. Wait until the page is ready; use 390x844 for mobile checks.
- Desktop: Linux X11 `import -window root` or `scrot`, Wayland `grim`, macOS `screencapture -x` (needs Screen Recording permission), Windows PowerShell `CopyFromScreen`; on headless hosts use `xvfb-run`.
- Save as `<os tmp>/opencode/screenshots/<timestamp>-<slug>.png` (allow-listed) and keep captures out of the repository.
- Privacy: avoid capturing secrets and never put user credentials on a command line.
- Then call `show_image` and tell the user what to check.

### Storage, transport and context

- Keep `data:` URLs, the existing convention: no new route or auth surface, and it works from remote devices.
- Budgets: existing `attachment.image` limits; one image per `show_image` call; parallel calls are allowed.
- Later (M5): include image tokens in prune estimates and measure image-heavy session load and event payloads. Only if the measurements justify it, design a content-addressed media store served through the authenticated API (fetch to blob URL), never a public path.

## Milestones (each independently pushable)

### M0: plan

- This document. Commit: `docs: plan agent image display in chat`.

### M1: render tool-result images (UI only)

- Files: `packages/session-ui/src/components/tool-media.ts` (pure selection of ordered inline images and chips), `tool-media.tsx` and `tool-media.css` (thumbnail strip), `message-part.tsx` (render after the tool component in `ToolPartDisplay`; small thumbnails in expanded context groups), `packages/ui/src/i18n/*.ts`.
- Tests: session-ui unit tests for the selector (order, MIME and URL filtering, PDF/SVG/remote chips, compacted parts still displayed). Playwright regression `packages/app/e2e/regression/session-timeline-tool-images.spec.ts` with v1 and v2 fixtures for MCP-style and `read` images: preview opens and closes by mouse and keyboard; 1280 px and 390 px without overflow; row geometry stable after image load; answer and error typography unchanged.
- Benchmark: standard streaming fixture before and after, plus an image-history fixture (for example 10 turns with one PNG each).
- Acceptance: existing MCP screenshots and image reads become visible to the user, with no server change.
- Commit: `feat(session-ui): render image attachments from tool results`.

### M2: legacy runtime `show_image` (v1 protocol, usual `opencode web` host)

- Files: `packages/core/src/image/dimensions.ts` (pure PNG/JPEG/GIF/WebP header dimensions shared by both runtimes), `packages/opencode/src/tool/show-image.ts` and `show-image.txt`, `tool/registry.ts`, `session/message-v2.ts` (text-only model handling), a dedicated session-ui renderer, the TUI line and locale strings.
- Tests: dimension parser; tool tests for accepted formats, rejections with hints, missing and directory paths, a denying `read` pattern, an external path that asks, the temp directory without a prompt, oversize normalization and explicit failure, metadata; model-message conversion for an Anthropic-style provider, an OpenAI-compatible provider and a text-only model; Playwright fixture for the renderer.
- Commit: `feat(opencode): add show_image tool for user-visible images`.

### M3: core runtime parity (v2 protocol)

- Files: `packages/core/src/tool/show-image.ts` and `tool/builtins.ts`, reusing `ReadToolFileSystem` resolution and permissions and `Image.Service`; image capability gating for tool-result and user images in `session/runner/to-llm-message.ts` after confirming it is missing. Verify which field carries tool metadata to the app (`state.metadata` or `structured`).
- Tests: core tool tests mirroring M2; runner lowering tests for vision and text-only models; existing `read` and `websearch` suites unchanged.
- Commit: `feat(core): add show_image tool and image capability gating`.

### M4: agent awareness and capture skill

- Files: built-in `capture-screenshot` skill (legacy `skill/index.ts` pattern and core embedded skill source), final tool descriptions, temp-directory allow-list parity in core, docs in `packages/web/src/content/docs/tools.mdx` and `skills.mdx`.
- Tests: skill listed, loadable, overridable and disable-able in both runtimes; request-capture test that the tool definition and skill summary reach the provider request; a capture path nested under the temp directory needs no `external_directory` prompt.
- Manual smoke checklist for the user with a real model: ask from a phone browser for a screenshot of a local dev page.
- Commit: `feat: teach agents to capture and show screenshots`.

### M5: hardening

- Prune estimates include images (dimension-based token estimate).
- Image-heavy measurements: session load time, event payload size, memory with 390 px device emulation.
- Optional: honor MCP `annotations.audience` (user-only images displayed but not sent; assistant-only images sent but not promoted).
- Optional: plugin tool attachments (#21383).
- One commit per item.

### M6: deferred unless M5 data justifies it

- Media store behind the authenticated API.
- Built-in URL screenshot tool, if shell or MCP capture proves unreliable.

## Validation matrix

- Formats: PNG, JPEG, GIF (animated GIFs become one frame when resized), WebP; rejected: SVG, BMP, HEIC, AVIF, TIFF, PDF, zero-byte, truncated and renamed non-images.
- Paths: relative, absolute inside the project, nested under the temp allow-list, external (asks), denied `read` pattern, Windows drive and UNC paths, spaces and Unicode.
- Sizes: tiny, 1280x720, 2880x1800 Retina (resized), still over the byte limit after resizing (explicit failure), resizer unavailable.
- Models and protocols: Anthropic, OpenAI Responses, OpenAI-compatible chat, Gemini, Bedrock, text-only.
- Sessions: v1 and v2 protocols, reload and reconnect, compacted parts, child sessions, shared sessions.
- UI: 1280 px and 390 px, keyboard, screen-reader labels, preview, download, long captions, many images, light and dark themes.

## Risks

- Token cost and context growth: normalization limits, prune accounting (M5), clear `read` versus `show_image` wording.
- Payload and storage growth from base64: measure in M5 before any storage change.
- Sensitive content in screenshots: it stays inside the existing session and provider trust boundary; the skill sets privacy rules and permissions still apply.
- Virtualized timeline jumps: fixed thumbnail height, reserved aspect ratio and the existing ResizeObserver measurement.
- Child sessions: images shown by a subagent appear only in its child session; the primary agent can show them again by path.

## Open questions

1. Tool name `show_image`, or `view_image` / `attach_image`?
2. Send shown images to vision models by default (proposed), or display them to the user only?
3. Built-in skill (proposed), or documentation only?

## Progress

- M0: plan written.