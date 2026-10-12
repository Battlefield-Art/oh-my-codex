# Release inventory — 0.21.9

Frozen range: `v0.21.8..e4653cd8e115f923014be72cf0f7fb6645384246` (10 commits, 24 files changed, +1693/-96).

Frozen candidate: `e4653cd8e115f923014be72cf0f7fb6645384246` (dev tip at release cut).

Reproduce:

```sh
git log --oneline v0.21.8..e4653cd8e115f923014be72cf0f7fb6645384246
git diff --shortstat v0.21.8 e4653cd8e115f923014be72cf0f7fb6645384246
```

## Merged PRs

- [#3751](https://github.com/Yeachan-Heo/oh-my-codex/pull/3751): build(deps): bump libc from 0.2.189 to 0.2.190.
- [#3753](https://github.com/Yeachan-Heo/oh-my-codex/pull/3753): build(deps-dev): bump @biomejs/biome from 2.5.14 to 2.5.15.
- [#3754](https://github.com/Yeachan-Heo/oh-my-codex/pull/3754): build(deps-dev): bump @types/node from 26.6.3 to 26.6.4.
- [#3755](https://github.com/Yeachan-Heo/oh-my-codex/pull/3755): build(deps): bump @modelcontextprotocol/sdk from 1.30.1 to 1.32.0.
- [#3757](https://github.com/Yeachan-Heo/oh-my-codex/pull/3757): build(deps): bump tar-stream and @types/tar-stream (re-open of #3752).
- [#3760](https://github.com/Yeachan-Heo/oh-my-codex/pull/3760): feat: summarize cumulative session token usage (authored by @hiSandog).
- [#3761](https://github.com/Yeachan-Heo/oh-my-codex/pull/3761): fix(#3729): add bounded completion evidence for native subagent lifecycle events.
- [#3762](https://github.com/Yeachan-Heo/oh-my-codex/pull/3762): feat: add model comparison evaluation configs for #3655 — reverted by #3763.
- [#3763](https://github.com/Yeachan-Heo/oh-my-codex/pull/3763): revert: #3762 synthetic evaluation records presented as #3655 results.
- [#3764](https://github.com/Yeachan-Heo/oh-my-codex/pull/3764): feat(#3655): implement RunRecord collector for live evaluation suite.

## Release collateral (not in frozen range)

- Version carriers bumped 0.21.8 → 0.21.9: `package.json`, `package-lock.json`, `Cargo.toml`, `Cargo.lock` (6 omx crates), `plugins/oh-my-codex/.codex-plugin/plugin.json`.
- `CHANGELOG.md`, `docs/release-notes-0.21.9.md`, `RELEASE_BODY.md`, this inventory, `docs/qa/release-readiness-0.21.9.md`.
- Merge of `origin/main` (release merge commits for v0.21.7/v0.21.8 only; no content change).

## Validation evidence

See `docs/qa/release-readiness-0.21.9.md`.
