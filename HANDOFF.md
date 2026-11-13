# Handoff: standalone GitHub Triage

The owner moved GitHub triage development from `poker_blocks` to this standalone public Vite+ project on 2026-11-12, for a new LLM to continue it. Read this before claiming work. No implementation claim is reserved for the extracting agent.

## State and provenance

- Stable compact briefing implementation was merged in poker_blocks PR [#706](https://github.com/trebizondoculpepper/poker_blocks/pull/706), source main commit `7579093`. It implements the merged design PR #699 / issue #698.
- This extraction also includes the **unfinished native-dependency read slice**, begun on `issue-707-native-dependencies` in `/Users/salimfadhley/workspace/poker_blocks-triage`. It was not merged as a completed feature. The owner redirected work during that implementation. Its source is preserved directly under `src/`, not hidden in a stash or separate patch.
- Existing 22 tests pass; Vite+ checks and packaging pass. A live read of poker_blocks #675 with `deps --tree` and native briefing completed successfully before extraction. This is smoke evidence, not full acceptance of the dependency implementation.
- No claim/add/remove/migration command is implemented. No live dependency migration or retired-label deletion was run. Native edges added for the three sliced tickets were preserved by GitHub's issue transfer.
- No game code, game dependencies, personal credentials, identity configuration, private snapshots or cache/checkpoint data were copied. Runtime is plain JavaScript with Node built-ins and the user's `gh` session.

## Issue map

GitHub **transferred** these issues, preserving bodies/comments and redirecting old URLs. Old bare `#N` references in inherited text may still refer to poker_blocks. Follow this table or full URLs rather than interpreting them as new local numbers.

| New issue                                                           | Old poker_blocks issue | Status / next action                                                                                                                       |
| ------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [#1](https://github.com/trebizondoculpepper/github_triage/issues/1) | #700                   | Role-shaped briefing. Needs design; no role flag implemented.                                                                              |
| [#2](https://github.com/trebizondoculpepper/github_triage/issues/2) | #701                   | Claim/release/human-review mutations. Needs design, distinct from dependency mutation contract.                                            |
| [#3](https://github.com/trebizondoculpepper/github_triage/issues/3) | #705                   | Agent-addressed priority. Needs scope/design; explicit `--agent` focus already exists, but `--agent-name`/addressed-item semantics do not. |
| [#4](https://github.com/trebizondoculpepper/github_triage/issues/4) | #707                   | Finish/review native dependency read command and briefing draft already in source.                                                         |
| [#5](https://github.com/trebizondoculpepper/github_triage/issues/5) | #708                   | Add/remove dependency commands. Native blocker: #4.                                                                                        |
| [#6](https://github.com/trebizondoculpepper/github_triage/issues/6) | #709                   | Reviewed migration plan/resumable apply. Native blockers: #4 and #5.                                                                       |
| [#7](https://github.com/trebizondoculpepper/github_triage/issues/7) | #703                   | Closed umbrella/design/history; use #4–#6 for implementation and record final migration outcome here.                                      |
| [#8](https://github.com/trebizondoculpepper/github_triage/issues/8) | New                    | Cross-platform/runtime CI and built-artifact smoke tests.                                                                                  |
| [#9](https://github.com/trebizondoculpepper/github_triage/issues/9) | New                    | Required PR verify gate and safe fork contributions.                                                                                       |

Transfer dropped repository-specific labels; `status:ready`, `status:needs-design` and `meta` were recreated and restored. Native blockers were checked after transfer: #5 waits on #4; #6 waits on #4/#5. Readiness plus native blockers determines eligibility. The CI tickets can be worked independently.

## Start here

```sh
npm ci
npm run check
npm test
npm run build
node dist/cli.mjs --help
npm run --silent triage -- --repo trebizondoculpepper/github_triage --json
npm run triage -- deps 6 --repo trebizondoculpepper/github_triage --tree
```

Use explicit `--repo trebizondoculpepper/poker_blocks` for the original project's live evidence. The CLI defaults to the checkout it is run from, which is now this repository. No new login or API token is needed beyond existing authenticated `gh`.

## Native read work (#4)

Finished in the #4 pull request against [doc/issue-dependencies.md](doc/issue-dependencies.md): `deps N [--tree] [--json]` (with `deps --help`), injected through `main`'s runtime; pickup ranked by last-open-blocker count in both the action list and the ready list; caches without native fields reported as incomplete with unknown readiness; and injected-query tests for nested pagination, summary mismatches, missing evidence, two-direction walks and cycles, not-planned blockers, drift, ranking, old caches and the command line.

Still open by choice:

- `github.js` and `dependencies.js` import each other. This is safe because neither uses the other's exports at module load time; splitting them would change the module ownership recorded in `AGENTS.md`, so it needs its own documented refactor.
- `deps --tree` reads tickets one at a time with no size limit. That is fine for current graphs; add a bound if large graphs appear.

Avoid expanding this into implementing #5/#6 or applying a migration; those are separate tickets.

## Bootstrap and open source

The project is public at https://github.com/trebizondoculpepper/github_triage and licensed MIT. Vite+ 1.5.0 supplies formatting, lint/type checks, tests, packaging and pre-commit hooks. The CLI remains runnable without building (`src/cli.js`); `npm run build` creates `dist/cli.mjs`.

CI now runs checks, tests, build and smoke tests on Ubuntu, macOS and Windows with Node 26, the current LTS (#108), behind one aggregate `verify` check (#8). Required-check and fork-contribution rules are #9. npm distribution and releases are designed in [doc/npm-releases.md](doc/npm-releases.md) (#17) but not yet implemented: nothing has been published, and branch protection is not configured. No npm publication is authorized by the bootstrap.

`doc/poker-blocks-process.md` is the historical source project's workflow context, not an instruction to work unrelated game tickets. `AGENTS.md` is the standalone project's current agent guide; `CLAUDE.md` links to it.

## Existing game consumer

The original poker_blocks checkout retains its last merged stable CLI so existing agents' `npm run triage` commands keep working. The interrupted native-read edits were removed from that worktree only after byte-for-byte verification that every source file was preserved here. All new tooling work and transferred issues belong here. Replacing the game's stable embedded snapshot with an external launcher is a later consumer change, following that repository's documentation-first PR rules; this extraction did not change its live agent setup.
