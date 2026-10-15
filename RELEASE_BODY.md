# oh-my-codex 0.21.13

`0.21.13` is a patch release for the frozen range `v0.21.12..51fa7eed6877b91706629174a2deeff83d1ce08f` (6 commits, 10 files, +576/−52).

## Highlights

- **Bound hook-spawned HUD reconciliation (#3787):** reconciliation processes started by hooks now have a timeout, preventing a hung child from blocking later reconciliation. Fixes #3785.
- **Dependency updates:** update `serde_json` from 1.0.151 to 1.0.154 (#3795) and `@types/node` from 26.6.4 to 26.6.5 (#3796).

## Fixes and compatibility

- Bound hook-spawned reconciliation processes to prevent indefinite waits (#3787, fixes #3785).
- No CLI command, protocol, or package-layout changes are included.

## Validation evidence

Frozen candidate `51fa7eed6877b91706629174a2deeff83d1ce08f` is green on dev CI. Local build, typecheck, and relevant test results are recorded in `docs/qa/release-readiness-0.21.13.md`.

Full readiness evidence: `docs/qa/release-readiness-0.21.13.md`.

## Merged PR inventory

| PR | Author | Title |
|---|---|---|
| [#3787](https://github.com/Yeachan-Heo/oh-my-codex/pull/3787) | @Yeachan-Heo | fix(hud): bound hook-spawned reconcile processes with timeout (Fixes #3785) |
| [#3795](https://github.com/Yeachan-Heo/oh-my-codex/pull/3795) | @dependabot | build(deps): bump serde_json from 1.0.151 to 1.0.154 |
| [#3796](https://github.com/Yeachan-Heo/oh-my-codex/pull/3796) | @dependabot | build(deps-dev): bump @types/node from 26.6.4 to 26.6.5 |

## Contributors

Thanks to @Yeachan-Heo and @dependabot.

## Inventory

The reproducible range is recorded in `artifacts/release-0.21.13/inventory.md`.

**Full Changelog**: [`v0.21.12...v0.21.13`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.12...v0.21.13)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
