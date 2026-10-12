# oh-my-codex 0.21.9

`0.21.9` is a patch release for the frozen range `v0.21.8..e4653cd8e115f923014be72cf0f7fb6645384246` (10 commits, 24 files, +1693/−96): cumulative session token usage reporting, native subagent completion evidence, the astra-defaults live evaluation collector, and dependency refreshes.

## Highlights

- **Session token usage (#3760):** `omx session usage` reports each local Codex session's last cumulative token counters with filtering, sorting, and JSON output; see `docs/session-usage.md` (authored by @hiSandog).
- **Native subagent lifecycle evidence (#3761, fixes #3729):** native subagent Stop events now record bounded completion evidence (`completed_at`, `completion_source: "native_stop_event"`) in subagent tracking for doctor diagnostics.
- **Astra-defaults live evaluation collector (#3764, part of #3655):** RunRecord collector and `collect-astra-defaults` script with GPT-6 Sol control, GPT-6.1 Sol candidate, and Luna-uniform configs. No evaluation results are published; #3655 remains open.

## Fixes and compatibility

- Record typed completion evidence for native subagent Stop events (#3761, fixes #3729).
- #3762 was reverted by #3763 (net zero).
- Dependencies: `libc` 0.2.190 (#3751), `@biomejs/biome` 2.5.15 (#3753), `@types/node` 26.6.4 (#3754), `@modelcontextprotocol/sdk` 1.32.0 (#3755), `tar-stream` 3.2.2 / `@types/tar-stream` 3.1.5 (#3757).
- Patch release with no intentional breaking CLI or package-layout changes.

## Validation evidence

Frozen candidate green on dev CI; local build, typecheck, and full compiled test suite recorded.

Full readiness evidence: `docs/qa/release-readiness-0.21.9.md`.

## Contributors

Thanks to [@Yeachan-Heo](https://github.com/Yeachan-Heo), [@hiSandog](https://github.com/hiSandog), and [@gaebal-gajae](https://github.com/gaebal-gajae).

## Inventory

The reproducible range is recorded in `artifacts/release-0.21.9/inventory.md`.

**Full Changelog**: [`v0.21.8...v0.21.9`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.8...v0.21.9)
