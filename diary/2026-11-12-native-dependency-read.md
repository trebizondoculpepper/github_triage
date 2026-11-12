# Development Diary Entry - 2026-11-12

## Context

- **Date**: 2026-11-12 20:10 UTC
- **Branch**: issue-4-native-deps
- **Contributors**: Claude Code + User

## Problem Statement

Finish #4, the first slice of the native GitHub dependency work: the read-only `deps N` command and the briefing's readiness changes, against the already merged contract in `doc/issue-dependencies.md`. The draft arrived unfinished from poker_blocks, with a HANDOFF.md list of remaining acceptance work. It was chosen because it is the only available ticket that unblocks others (#5, and with it #6).

## Our Approach

Review the draft against the contract and the handoff list, fix the gaps found, and add the missing injected-query acceptance tests rather than rewrite working code.

## Implementation

- `src/cli.js`: `deps` goes through `main`'s runtime boundary so tests cannot reach live GitHub; added `depsArgumentsFor` and `deps --help`.
- `src/dependencies.js`: the tree walk is a simple queue that reads each ticket once; removed an unreachable cycle check; cycle detection reports each blocked-by cycle once; injected clock; `unblocks` is the single definition of "last open blocker for".
- `src/briefing.js`: the ready list is ordered by unblock count, as the contract requires (only actions were before); tickets without native evidence add a completeness warning, so old caches are incomplete rather than silently "unblocked".
- `src/compact.js`: reuses `unblocks` instead of a duplicate.
- Ten new tests through a fake dependency graph served by the injected query.
- Docs: marked the body-text dependency paragraph in `doc/github-triage-cli.md` as superseded for readiness; updated HANDOFF.md.

## Outcomes

- Checks, 32 tests and the build pass. Live read-only `deps 6 --tree` here and `deps 675 --tree` on poker_blocks give correct upstream/downstream and last-blocker results.
- A live poker_blocks check looked like a missing downstream edge; it was `head` truncating output, confirmed against a direct GraphQL query.
- The old-cache case was a real gap: a cache from before native fields reported "complete".

## Next Steps

- #5 (`deps add` / `deps remove`) becomes pickable once this merges.
- The `github.js` / `dependencies.js` mutual import is left as is; a split needs a documented module-ownership change.
