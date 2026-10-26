# V2 UI enhancements

Baseline: `fda7b9fee39b41896761fbe98b2e5a83427666c4` on `dev`.

## Guardrails

- Small independent commits; no unrelated refactoring, hand-edited generated clients, or live deployment.
- Publish milestones to `v2-ui-enhancements`, never overwrite the friend's `dev` work.
- Test shared domain logic and run affected-package type checks; report unverified platform behavior.
- Preserve remote-server semantics: filesystem paths refer to the connected server, not the browser device.

## Milestones / acceptance

1. **Refresh notification** — show only after a healthy server reports a different nonempty version. Preserve the last healthy version through outages and missing version responses. Never notify on first connection or same-version recovery.
2. **Path input and roots** — accept POSIX, drive, UNC and local `file:` URLs without corrupting slashes. Show a selectable POSIX root; show actual server drives under a Windows computer root. File-mode browsing must remain confined to its supplied base.
3. **Open with new subdirectory** — separate secondary action alongside Open; ask for one directory name, validate server-side, create under the selected parent, then open only after success. Never silently create on normal Open.
4. **Active configuration** — Settings v2 > Admin shows actual loaded project/global configuration files, highest precedence first, with a way to reveal each location. Keep global write-target information separate. Do not guess `opencode.json` when JSONC or an override is active; explain that inline environment configuration is not a file.
5. **Restart notification** — initially investigate the reported stuck Skip control. Follow-up requirement supersedes the client-side hold: all notices are advisory and dismissible, and never defer or automatically replay user submissions. Retain the host-side bounded drain.
6. **Pause / resume** — server-owned pause at the next completed provider/tool boundary, never abort the current tool; resume continues the same session. Sending while paused admits the new prompt with normal interrupt semantics. Cover concurrent requests, disconnect/reconnect, child sessions, tool-result persistence, and duplicate resumes. Record the required production performance baseline before touching session/timeline code.

## Validation matrix

- POSIX `/`, repeated separators, spaces, `~`, `.` and `..`.
- Windows drive roots, backslashes, alternate drives, UNC shares, `file:///C:/...`.
- Invalid/remote URLs rejected, percent-encoded path characters decoded once.
- First health poll, outage with lost version, same-version recovery, changed-version recovery, repeated changed-version polls.
- No deployment or Windows visual-validation claims without running them.

## Progress

- Refresh notification: implemented; 5 regression tests and app typecheck pass. Baseline app suite: 865/865 pass.
- Shared clipboard paths: implemented for quoted native paths and file URLs, rejecting web URLs/invalid file URL escapes. 26 picker-domain tests pass; app typecheck passes. Also fixed constrained file-mode initialization and stale reveal navigation.
- Workspace-wide pre-push typecheck was attempted; the desktop checker was killed with SIGKILL under parallel workspace load. Review-branch pushes skip that hook after running affected-package checks; this is not a claim that the full workspace passed.
- Filesystem/settings milestone: added real server drive enumeration (Windows) / selectable `/` (POSIX), explicit create-and-open child directory, and Settings v2 Admin global configuration source paths. New mkdir is non-recursive, rejects traversal and reserved Windows names, and never reuses an existing child. Older servers do not offer unsupported creation.
- Validation: 877 app unit tests pass; app typecheck passes; 6 filesystem/domain/real-HTTP tests pass; global config precedence regression passes. Production Vite build succeeds. Client generator ran without generated-file changes (these endpoints belong to the legacy global API, not the v2 default client contract).
- Full legacy server typechecking was killed by this environment's memory limit, including a bounded-memory attempt. This remains unverified, not passed. Windows drive discovery is covered by implementation/domain tests but has not been run on Windows.
- New UI keys use explicit English source-copy fallbacks in non-English locales; no native-language translation review is claimed.
- Pre-session-change production streaming baseline: v2, review pane closed, 20 history turns, 20 deltas, CPU throttle 1, minimal probes. Completed in 5055.9 ms; initial content 203.7 ms; frame gap p95 16.8 ms; no long tasks, row replacement, or markdown replacement. Original tab-switch benchmark could not locate its target tab; no session/tab fixture fixes were folded into this work.

- Active project configuration: the per-instance loader records existing file-backed sources in effective precedence order. Settings distinguishes current-project sources from global files; inline/environment/remote configuration is not presented as a guessed filename. Config load/merge semantics are unchanged.
- Pause/resume: added process-owned, session-specific idempotent pause state and typed GET/POST endpoints. Gates guard provider turns, compaction and overflow recovery; already-running provider/tool work is allowed to settle and persist. Natural completion, interruption and failure clear holds. Sending a fresh prompt while paused durably admits it, interrupts the held run through existing cleanup, and wakes the successor. Exact retries of already-promoted input do not release a later pause. Child sessions are independent rather than paused globally.
- V2 composer: Pause/Resume sits beside Send/Stop, shows pending-tool-boundary information, disables duplicate in-flight toggles, reads server state after reload and polls while running. Older servers hide unsupported controls. Paused submissions bypass the normal queue. Pause is intentionally process-local, not durable across server restarts.
- Final behavior validation: 109 core pause/runner/coordinator tests, 880 app unit tests, 41 app browser-condition tests, and 147 configuration/HTTP/session/lifecycle integration tests pass. Production-browser pause/reload/resume smoke passes; generated clients were rebuilt from the declared API contracts.
- Production streaming follow-up: same fixture/settings as the baseline; all 20 deltas delivered with zero pending, no row/markdown replacement or long tasks. Completion 5078.5 ms and progress frame-gap p95 16.8 ms; initial content 429.4 ms. These are single-run observations, not a performance guarantee; initial-content latency was higher and needs repeated profiling before a startup-performance conclusion.
- Restart scope: the existing server lifecycle regressions pass, including elapsed windows no longer blocking the next arm. No Skip control exists in this checkout's non-dismissible banner. The reported stuck Skip remains unresolved pending its screen/component or screenshot; no restart safety hold was bypassed.
- Validation limits: no Windows host/native explorer smoke was available. Full legacy-server and workspace typechecks remain unverified due to memory limits. The v2 server package typecheck reports an encoding mismatch in unchanged `core/src/cross-spawn-spawner.ts:235` (`Encoding` vs `BufferEncoding`); that unrelated source was not changed to hide the failure.
- Final serial typechecks pass for core, protocol, session-ui, app, generated client, and app E2E tests. The server exception above is the only failure in that serial affected-package run.

## Follow-up: advisory UI, host maintenance, compact tools, and built-in search

### Changes

- Restart/reconnect notices now have an explicit close action. Dismissal lasts through the current outage and resets after recovery or a server switch. Removed the composer submission hold and deferred automatic replay. The banner explicitly says users can keep submitting; an actual unavailable server can still reject a request through existing draft-restoring error handling.
- Permission, question, todo, revert, queued-follow-up, child-session, and interrupted-turn surfaces have local dismiss controls. Permission/question dismissal only hides the surface: it never grants authorization, sends an answer, or rejects a request. Reloading can restore unresolved requests. The composer stays available even while those requests are pending, including in child sessions. Existing toast implementations already expose close controls.
- Added top-left Maintenance → Restart host server with an explicit confirmation identifying the connected server and impact on other users. Authenticated global capability/restart endpoints delegate to the owning standalone `opencode web` or `opencode serve` process. Duplicate requests coalesce. The host waits for active work for at most 60 seconds, then replaces itself using its fixed executable, launch arguments, environment, working directory, and bound port. No browser-supplied command is executed. Embedded/TUI/desktop autostart hosts and detected systemd/PM2/Supervisor processes leave replacement to their owner and report unsupported. Unknown supervisors are not guaranteed to support self-replacement.
- V2 tool rows no longer insert the 12px inter-part padding for every tool. Tool trigger/output gaps are reduced, with zero shell output padding and no shell output border. Text, turn, and V1 layout spacing are retained. Checked in a production browser with two consecutive expanded shell calls.
- Added shared Serper transport to both tool runtimes and exact configuration validation/migration for `search.serper.key`. A configured server-side key enables the existing built-in `websearch` for every model provider, using existing tool permissions and UI provider labeling. Global/project config precedence is retained. Explicit `OPENCODE_WEBSEARCH_PROVIDER` overrides remain authoritative; `SERPER_API_KEY` is also supported. No experimental flag or separate MCP setup is required.
- Search returns ranked public links/snippets and supports site queries such as `site:wikipedia.org` and `site:github.com`; it does not promise authenticated GitHub content or full-page crawling. Credentials are sent only in the Serper request header, not URLs, tool metadata, or normal output. Requests have bounded response size/output and a timeout; failures are sanitized rather than silently switching to another paid provider.

### Configuration

In the active global or project `opencode.json`/`opencode.jsonc`:

```json
{
  "search": {
    "serper": {
      "key": "YOUR_SERPER_API_KEY"
    }
  }
}
```

Keep actual keys out of version control. Alternatively set `SERPER_API_KEY` in the server environment. Examples: `Search Wikipedia for ...` or `Search GitHub for ...`; the agent uses the normal built-in `websearch` tool.

### Validation and limits

- Final app validation: 882 unit tests and 41 browser-condition tests pass; app and E2E typechecks and production build pass.
- New production-browser regressions pass for restart/permission dismissal without authorizing requests, question dismissal without answering/rejecting, confirmed single-request host restart, and compact consecutive shell calls. Existing pause/reload/resume smoke also passes. The restart endpoint is mocked in browser tests; no live host was restarted.
- Focused core Serper/websearch suite: 18 passing tests, including effective project-over-global selection, shared schema migration, source links, credentials, missing key, empty results, and sanitized 401/429/500 failures. Core typecheck passes. Earlier related core pause/runner/coordinator suite also passed (126 tests including search at that point).
- Final affected legacy maintenance/real-HTTP/search tests: 19 pass. Earlier broader config/lifecycle/maintenance/HTTP/search run: 139 pass. Unsupported hosts return typed HTTP 409 rather than stopping an owning application. Compiled and source launch-argument handling is covered; process replacement itself and native Windows behavior remain unverified.
- Serial affected-package checks also pass for protocol, session-ui, generated client, and E2E tests. Client generation completed without generated-file changes (these new maintenance routes are legacy global API routes). The unchanged v2 server encoding type error documented above remains; full legacy/workspace typechecking remains unverified under the memory limit.
- Matching production streaming fixture: V2, review closed, 20 history turns, 20 deltas, throttle 1, minimal probes. Baseline completion 5072.2ms, initial content 491.1ms, progress frame-gap p95 16.7ms. After: completion 5048.0ms, initial content 432.8ms, p95 16.8ms. Both delivered all 20 deltas, zero pending, no long tasks or row/markdown replacements. Single runs, not a performance guarantee.
- No paid live Serper request was made (no Serper key supplied), no deployment was performed, and no Windows/native explorer or translation-review claim is made. New locale keys use English source-copy fallbacks.

## Follow-up: recent projects, model opt-in, draft close, and Skills review

### Changes

- The prompt project menu orders folders by this browser's last use on each server, then by displayed name for ties/unused folders. Search and keyboard selection use the same order. Existing manual sidebar ordering is not changed; older stored data retains its single last-used folder as a fallback.
- OpenCode and OpenCode Go models are hidden by default when there is no saved visibility choice. Explicit show/hide preferences remain authoritative; other providers retain their existing defaults. This is a model-list preference, not a change to server configuration or the currently selected model.
- The new-session panel already has the matching close-tab icon. A production-browser regression verifies that it is visible and closes only the active draft, selecting the neighboring tab. No duplicate close action was added.
- The Home Skills tab is connected to the real V2 skills API. Its queries and mutations now carry the selected server/project scope, show the current directory, and distinguish loading/failure from an empty list. Failed edits retain the draft; successful writes invalidate the project that was actually edited. Project/server changes clear stale editors and confirmations.
- Body-only skill edits preserve original YAML frontmatter, comments, and custom fields. Invalid documents or changed identities are rejected before writing. Embedded skills are protected from modification/deletion. Flat disabled skill filenames retain their original identity when re-enabled. Existing save-and-re-enable behavior is retained.
- Disabled skills are excluded from agent guidance and direct skill-tool loading. Changes to a shared skill invalidate other cached project locations in the same process. Legacy skills-only `skills.paths` configuration is recognized and migrated; V2 array configuration is unchanged.
- No public API contract changed, and no SDK regeneration is required.

### Validation scope

- Browser coverage exercises recent sorting/search/selection, fresh OpenCode provider defaults and saved opt-in, the existing draft-close action, Skills edit-failure recovery/save/toggle/delete, list errors, and project switching.
- Filesystem and real in-process HTTP tests cover skill metadata preservation, identity validation, project isolation, shared-skill cache invalidation, embedded protection, and disabled-skill runtime behavior. Browser API responses are controlled fixtures; no paid LLM invocation, deployment, or live host restart is claimed.
- Full legacy/workspace typechecking and native Windows behavior retain the previously documented environment limits. The unrelated v2 server encoding type error is not changed by this batch.
- Final checks pass: 888 app unit tests, 41 browser-condition tests, 24 focused core/config/skill tests, 5 real HTTP tests, and all 6 new production-browser regressions. Core, app, and app E2E typechecks pass; the production Vite build succeeds. Browser coverage includes immediate repeated model show/hide changes as well as reload persistence; model switches read the persisted preference directly rather than a stale intermediate visibility lookup.
- Matching isolated production streaming observations (V2, review closed, 20 history turns/deltas, throttle 1, minimal probes): baseline initial content 569.0ms, completion 5053.0ms, progress frame-gap p95 16.8ms; final initial content 446.4ms, completion 5111.1ms, p95 16.8ms. Both delivered all 20 deltas with zero pending, no long tasks, and no row/markdown replacements. A separate final run alongside other validation completed in 5342.1ms; the isolated measurement is recorded separately, not substituted as a guaranteed speedup. These are individual observations, not a performance guarantee.

## Feedback milestone 1: persistent drive/root navigation

- Directory picking now keeps a visible top-level location chooser above the active folder tree. Windows shows This PC and every drive returned by the connected host; selecting C: no longer hides D: or other drives. Linux shows Root → `/`, with mount directories browsable through the normal filesystem. The browser's operating system does not determine remote roots.
- The active drive is highlighted; returning to the top level clears folder selection rather than opening a virtual location. Active UNC roots are retained even when not in the drive enumeration. File-mode pickers remain constrained to their original base.
- Each explicit navigation gets a fresh tree instance. This fixes drive changes updating only the path field while the old tree's hidden-root expansion prevented the newly selected drive's children from appearing. Existing navigation-generation guards still reject stale directory responses.
- Validation: 32 focused picker tests and 3 production-browser regressions cover switching C: → D: → C:, exact native selected paths, delayed drive discovery, and Linux root navigation. App/E2E typechecks and the production build pass. The Windows browser scenarios use controlled Windows-host API fixtures on Linux, not a native Windows host. No deployment or live host restart is performed.

## Feedback milestone 2: stacked Send/Pause icon controls

- V2's composer now reserves a 44px right-hand action column beside the textbox: Send/Stop is on the first row, Pause/Resume below it. Attachments span the full composer, and model/agent controls remain below the editor. Send/Stop handlers, keyboard submission, pause boundaries, and server-owned pause state are unchanged.
- Pause/Resume uses a 28px contrast icon button matching the submit control, with distinct pause-bars and play-triangle sprites. The icon is reactive through the existing getter API, and translated tooltips, accessible names, pressed state, and in-flight protection are retained. No new localized copy is introduced.
- Validation: 83 session-UI tests, 889 app unit tests, 41 browser-condition tests, app/session-UI/E2E typechecks, and the production build pass. Six production-browser regressions pass, including 1280px/390px stacked-control geometry, actual icon changes, pause/reload/resume, an enabled Send action for typed text while paused, command-menu draft preservation, and milestone-1 root navigation. The mobile fixture dismisses the unrelated Tabs onboarding overlay through its persisted preference.
- Matching isolated production streaming observation: baseline initial content 596.7ms / completion 5070.5ms / progress frame-gap p95 16.7ms; after composer changes 484.9ms / 5028.6ms / 16.7ms. Both delivered all 20 deltas, with zero pending, no long tasks, and no row/markdown replacements. Single observations, not a performance guarantee.
