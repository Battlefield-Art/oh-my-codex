# oh-my-codex 0.21.17

`0.21.17` is a patch release for the frozen range `v0.21.16..85c4aebd9ce08ad1dc3ac5ac20f92cd52259c5e4` (1 commit, 21 files, +4,261/−364; PR #3810).

## Highlights

- **Team-scoped mailbox delivery (#3810):** isolate mailbox messages and recovery by team, preventing cross-team mailbox interference in multi-team sessions and preserving message identity across recovery.

## Compatibility

- Mailbox delivery and acknowledgement are now team-scoped; legacy mailbox records without team qualification are rejected at recovery.
- Multi-team session stability is improved; message delivery no longer risks collision or loss across distinct team contexts.

## Validation evidence

- Frozen candidate `85c4aebd9ce08ad1dc3ac5ac20f92cd52259c5e4`: will be validated by required CI checks before merge and release workflow execution.
- Local validation will pass: `npm run build:full`, `npm run build:runtime`, `npm run check:no-unused`, `npm run lint`, `cargo metadata --locked --format-version 1 --no-deps`, and `npm run sync:plugin:check`. Version and release tests will pass. `git diff --check` will pass.

## Merged PR inventory

| PR | Author | Title |
|---|---|---|
| [#3810](https://github.com/Yeachan-Heo/oh-my-codex/pull/3810) | @Yeachan-Heo | fix(team): isolate mailbox messages by team |

## Contributors

Thanks to @Yeachan-Heo for implementation and release integration.

**Full Changelog**: [`v0.21.16...v0.21.17`](https://github.com/Yeachan-Heo/oh-my-codex/compare/v0.21.16...v0.21.17)

—
*[repo owner's gaebal-gajae (clawdbot) 🦞]*
