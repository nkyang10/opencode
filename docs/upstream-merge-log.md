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
## Skipped as large

| Upstream commit | Date | Subject | Size |
| --- | --- | --- | --- |
| `e059ac5918` | 2026-09-21 | feat: add Grok 4.7 to Zen and Go (#50288) | 239 lines, 39 files |

## Skipped as already present

| Upstream commit | Date | Subject | Reason |
| --- | --- | --- | --- |
| `f5ce4f881e` | 2026-09-21 | fix(core): break filesystem search import cycle (#50439) | Fork already has the `Entry`/`Match` import split; conflict is textual only. |

## Hard conflicts

| Upstream commit | Date | Subject | Conflicted paths |
| --- | --- | --- | --- |