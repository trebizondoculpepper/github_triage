# Development Diary Entry - 2026-11-14

## Context

- **Date**: 2026-11-14 UTC
- **Branch**: feat/190-submit
- **Contributors**: Claude Code (kavya_sabbagh) + User

## Problem Statement

Issue #190 asks for the `submit` transition of the delivery lifecycle: record the implementation PRs as required deliverables, release only the caller's claim and set `status:awaiting-review`, while the caller keeps delivery responsibility.

## Our Approach

`submit` reuses the `deliverables` planner in `src/deliverables.ts` rather than adding a parallel module: the same live issue read, record fold, authority checks, attach-time link checks, opId derivation and the apply loop that re-reads and re-plans before every write. Only the submit-specific prerequisites, the recorded label plan and the retry rules are new.

## Implementation

- `src/deliverables.ts`: `submit` action (record with `op: "submit"`, membership, `responsible` and label plan, then the label edit), `submitArguments`, `submitHelp`; refusals `NOT_CLAIMED`, `TICKET_CLOSED`, `PR_CLOSED_UNMERGED`, `SUBMIT_NEEDS_PR`, `DELIVERY_DIVERGED` on top of the existing record and link refusals.
- `src/cli.ts`: `submit N` command and top-level help line.
- Tests in `src/deliverables.test.ts`: success, dry run, refusals, partial label write retry, divergence and an interleaved record race.
- README, `doc/github-triage-cli.md` and `doc/process.md` steps 5 and 7.

## Outcomes

A retry completes the recorded plan only while the caller's claim label remains; once it is gone the plan is complete and labels changed by others are never restored, mirroring `release`. Intervening records refuse `DELIVERY_DIVERGED`.

## Follow-up in the same PR
`claim --rework` now takes its authority from the delivery records when any trusted record exists (ticket responsibility only, `MARKER_UNVERIFIED` on unknown records, no v1 fallback) and posts a `membership open` record after the claim. `src/claims.ts` receives that decision through an injected callback, which avoids an import cycle with `src/deliverables.ts`. `release --as done --pr` prints the deprecation note that the contract's source-compatibility table requires.

## Next Steps
None for #190; Ticket Doctor and read surfaces stay with #192.
