# Upstream Merge Log

- Source: `upstream/dev` at `0610a81fc3` (2026-10-27)
- Target: `dev`
- Merge base: `9a53565790` (2026-09-19)
- Strategy: apply `feat`, `fix`, `perf`, and `refactor` commits chronologically, oldest first. Skip commits changing more than 500 lines or 20 files. Stop and record a hard conflict instead of resolving it automatically.
- Started: 2026-10-28

## Applied

| Upstream commit | Date | Subject | Result |
| --- | --- | --- | --- |
| `ae93d4afb3` | 2026-09-19 | fix(console): use v2 desktop downloads (#49931) | clean |
| `fee476bb90` | 2026-09-19 | refactor(console): redirect desktop downloads (#49984) | clean |
| `45ad8dc38a` | 2026-09-20 | fix(stats): paginate sync aggregates (#50198) | clean |
| `d870e22c70` | 2026-09-20 | fix(stats): retry transient query failures (#50205) | clean |
| `8bf288ecb1` | 2026-09-20 | fix(opencode): bump togetherai so streams report usage (#50264) | clean |
| `c10134729d` | 2026-09-20 | fix(opencode): hoist Bedrock tool images except Claude, Nova, and Llama 4 (#50272) | clean |
| `cf494c2029` | 2026-09-21 | fix(console): forward client IP to inference | clean |
| `70a24697ea` | 2026-09-21 | fix(console): authenticate inference proxy | clean |
| `ba341c6cac` | 2026-09-21 | fix(core): resolve npm package entrypoint to a file under Node (#50413) | clean |
| `3a35b45db8` | 2026-09-22 | feat(openai): allow GPT-6 Sol and Luna with Codex (#50704) | clean |
| `fe51b0b19a` | 2026-09-22 | fix(console): restrict legacy access to Black (#50716) | clean |
| `610df0b566` | 2026-09-24 | fix(gemini): switch thinking default logic (#50841) | clean |
| `82d4c89031` | 2026-09-23 | fix(opencode): redact credentials in debug config (#50956) | clean |
| `0f549842ee` | 2026-09-24 | fix(stats): attribute Hy4 preview traffic to Tencent (#51050) | clean |
| `6df0d5d951` | 2026-09-24 | fix(stats): use capability fallbacks in comparison radar (#51161) | clean |
| `16c56fe5ec` | 2026-09-24 | fix(ci): use GPT-6 Luna for issue automation (#51261) | clean |
## Skipped as large

| Upstream commit | Date | Subject | Size |
| --- | --- | --- | --- |
| `e059ac5918` | 2026-09-21 | feat: add Grok 4.7 to Zen and Go (#50288) | 239 lines, 39 files |
| `1b4a6dbc65` | 2026-09-23 | feat(go): add Space Bunny promotion (#50572) | 281 lines, 61 files |
| `1d6c3c0e29` | 2026-09-24 | feat(go): add GPT 6 Luna to Go pages (#50947) | 169 lines, 21 files |
| `543c686c0d` | 2026-09-26 | fix(go): make DeepSeek $60 allowance permanent (#51364) | 122 lines, 21 files |
## Skipped as already present

| Upstream commit | Date | Subject | Reason |
| --- | --- | --- | --- |
| `f5ce4f881e` | 2026-09-21 | fix(core): break filesystem search import cycle (#50439) | Verified: all six `Entry`/`Match` hunks are present and the runtime `../filesystem` import is gone. Fork uses `FindInput`/`GlobInput`/`GrepInput` instead of upstream's type-only `FileSystem` import, so the upstream import is unnecessary. Core typecheck and 29 filesystem/search tests pass. |

## Skipped needing skipped prerequisite

| Upstream commit | Date | Subject | Reason |
| --- | --- | --- | --- |
| `0027387dc5` | 2026-09-24 | fix(go): include DeepSeek V4 Flash in chart (#51032) | File is unchanged locally; context depends on skipped large Go-page commits. |

## Hard conflicts

| Upstream commit | Date | Subject | Conflicted paths |
| --- | --- | --- | --- |
| `29f07e0c69` | 2026-09-25 | refactor(core): share a browser opener across opencode and tui (#51414) | packages/opencode/src/cli/cmd/web.ts |
