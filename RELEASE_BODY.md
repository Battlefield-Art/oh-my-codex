# oh-my-codex 0.21.11

`0.21.11` is a patch release for the frozen range `v0.21.10..7e0b5f2330b9d85c5fdb9709ec0104e099836f4c` (3 commits, 2 files, +68/−5): native agent TOMLs no longer retain stale inherited model providers.

## Highlights

- **Fresh provider inheritance (#3781, fixes #3779):** native agent TOMLs omit `model_provider` when it only mirrors the root `config.toml` default, so changing the provider no longer leaves stale agent configuration or requires `omx setup --force`. Explicit per-agent model overrides remain supported.

## Fixes and compatibility

- Avoid baking inherited root `model_provider` values into native agent TOMLs; preserve explicit per-agent overrides (#3781, fixes #3779).
- Patch release with no intentional breaking CLI or package-layout changes.

## Validation evidence

Frozen candidate green on dev CI; local build, typecheck, and relevant tests recorded.

Full readiness evidence: `docs/qa/release-readiness-0.21.11.md`.

## Merged PR inventory

| PR | Author | Title |
|---|---|---|
| [#3781](https://github.com/Yeachan-Heo/oh-my-codex/pull/3781) | @Yeachan-Heo | fix: do not bake model_provider into agent TOMLs for default inheritance (fixes #3779) |

## Contributors

Thanks to [@Yeachan-Heo](https://github.com/Yeachan-Heo) and [@gaebal-gajae](https://github.com/gaebal-gajae) (co-author).

## Inventory

The reproducible range is recorded in `artifacts/release-0.21.11/inventory.md`.

**Full Changelog**: [`v0.21.10...v0.21.11`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.10...v0.21.11)
