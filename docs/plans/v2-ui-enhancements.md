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
