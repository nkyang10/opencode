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
