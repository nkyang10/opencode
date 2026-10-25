# V2 UI enhancements

Baseline: `fda7b9fee39b41896761fbe98b2e5a83427666c4` on `dev`.

## Guardrails

- Small independent commits; no unrelated refactoring, generated-client edits, or live deployment.
- Publish milestones to `v2-ui-enhancements`, never overwrite the friend's `dev` work.
- Test shared domain logic and run affected-package type checks; report unverified platform behavior.
- Preserve remote-server semantics: filesystem paths refer to the connected server, not the browser device.

## Milestones / acceptance

1. **Refresh notification** — show only after a healthy server reports a different nonempty version. Preserve the last healthy version through outages and missing version responses. Never notify on first connection or same-version recovery.
2. **Path input and roots** — accept POSIX, drive, UNC and local `file:` URLs without corrupting slashes. Show a selectable POSIX root; show actual server drives under a Windows computer root. File-mode browsing must remain confined to its supplied base.
3. **Open with new subdirectory** — separate secondary action alongside Open; ask for one directory name, validate server-side, create under the selected parent, then open only after success. Never silently create on normal Open.
4. **Active configuration** — Settings v2 > Admin shows the actual global config file selected by server precedence and a way to reveal its location. Do not guess `opencode.json` when JSONC or an override is active. Clarify global versus merged project config.
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
