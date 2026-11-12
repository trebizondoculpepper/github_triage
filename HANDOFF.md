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

## Native read work remaining (#4)

Review the draft against [doc/issue-dependencies.md](doc/issue-dependencies.md), originally merged in poker_blocks PR #704 before implementation. In particular:

- Add dedicated injected-query tests for native nested pagination, summary-count mismatches/missing evidence, two-direction transitive traversal/cycle reporting, not-planned blockers, last-open-blocker ranking, old-cache missing native fields, and command argument/error/exit behavior. Existing tests were adjusted for native fixtures but are not the full acceptance suite.
- Review compact/full readiness and dependency presentation, parked/hygiene behavior, ranking, data-size limits and text-budget edge cases; preserve source chronology and omission notices.
- Review the new `github.js` / `dependencies.js` circular import and simplify module ownership if warranted by a documented refactor; source execution and packaging smoke tests currently pass.
- Inject the dependency command entry point through `main`'s runtime boundary so CLI tests do not accidentally query live GitHub.
- Check how labels and native evidence interact before declaring a ticket “pickable”; dependencies alone are not the full workflow verdict. Keep closed-as-not-planned warnings explicit.
- Reconcile older inherited paragraphs describing text dependencies/read-only-only behavior with the later already merged dependency design. The newer dependency document is the agreed contract. Keep docs accurate about implemented versus planned commands.

Avoid expanding this handoff into implementing #5/#6 or applying a migration until #4 is properly reviewed. The owner wants a fresh LLM to continue the project.

## Bootstrap and open source

The project is public at https://github.com/trebizondoculpepper/github_triage and licensed MIT. Vite+ 1.5.0 supplies formatting, lint/type checks, tests, packaging and pre-commit hooks. The CLI remains runnable without building (`src/cli.js`); `npm run build` creates `dist/cli.mjs`.

The initial CI workflow is intentionally small: Ubuntu / Node 24, npm ci, check, test and build. #8/#9 cover making it a proven portable contributor gate. Package publication, release automation and branch protection have not been configured. No npm publication is authorized by the bootstrap.

`doc/poker-blocks-process.md` is the historical source project's workflow context, not an instruction to work unrelated game tickets. `AGENTS.md` is the standalone project's current agent guide; `CLAUDE.md` links to it.
