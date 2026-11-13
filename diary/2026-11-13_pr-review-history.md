# Development Diary Entry - 2026-11-13

## Context

- **Date**: 2026-11-13 13:20 UTC
- **Branch**: issue-60-review-failures
- **Contributors**: Claude Code (kavya_sabbagh) + User

## Problem Statement

Issue #60: answer "why does this PR keep failing review?" in one operation, building on the #59 `pr N` diagnosis, without guessing at causes.

## Our Approach

Add an explicit `pr N --history` mode in `src/reviewhistory.ts`. It reuses `pullRequestStatus` for the current-head blockers and adds one bounded GraphQL query for commits, reviews, review threads (with `originalCommit`) and comments. Rounds are reviewed commits in commit order. Findings are classified only against earlier findings by reviewer, file and normalized title, and every class carries a basis string and related links.

## Implementation

`src/reviewhistory.ts` (new), `src/prstatus.ts` (exported `excerpt` and a shared `codexMarker` parser), `src/cli.ts` (`--history` flag, help), fixtures in `src/triage.test.ts`, docs in `doc/usage.md` and `doc/design/diagnostics.md`.

## Outcomes

Against the motivating PR #47 the mode reports 9 rounds, 8 with findings, 20 findings concentrated in `src/migration.js` across 8 rounds, and suggests a broader invariant/design review, which matches what the owner eventually did. Cost: two requests, about 5 kB text / 19 kB JSON. Author replies such as "Fixed in 375310d" are matched to PR commits as cited fixes.

## Next Steps

Feed `signal` into designer briefings and owner catch-up (needs per-PR collection policy), and expose the mode through MCP.
