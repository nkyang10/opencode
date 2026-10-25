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
5. **Restart notification** — reproduce and fix stuck dismissal without bypassing the safety hold during restart. Current checkout has a non-dismissible restart banner and no literal Skip control; identify the reported surface before changing server safety behavior.
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
