# Development Diary Entry - 2026-11-13

## Context

- **Date**: 2026-11-13 UTC
- **Branch**: issue-32-polling
- **Contributors**: Claude Code (kavya_sabbagh) + owner

## Problem Statement

Issue #32: optional proactive polling and deterministic triage events inside the MCP server process, per the merged contract doc/design/polling-events.md.

## Our Approach

A new `src/polling.ts` holds a per-process `Watcher` for one explicitly resolved repository, a bounded `EventLog`, and `sharedCollect`, which coalesces simultaneous unfocused collections of the same repository. Facts come from the existing primitives: the registered `pull-requests` rule (for `pr-inspect-merge`), `prChecks`, `workflow` label sets and `pickupEligibility`. No detection logic is duplicated and nothing reads prose.

## Implementation

`github-triage-mcp --poll [--poll-interval-minutes N]` (default 30, minimum 1, interval requires `--poll`) starts the watcher after startup resolution. The first complete poll is a silent baseline. Repository-level warnings make a poll incomplete, so the baseline is not advanced. A subject whose own evidence is truncated keeps its baseline facts rather than being treated as absent. Event identity hashes repository, subject, kind, fact key (numeric IDs, URLs, head SHA) and a recurrence generation, so a fact that clears and recurs gets a new identity while repeated reads keep the same one. Failures back off exponentially with jitter, bounded at 60 minutes, and never retry before a known rate-limit reset. Each poll is bounded by a 10-minute abort, and polls never overlap. Stdin EOF/close or SIGINT/SIGTERM stops the timer and aborts collection, and timers are unref'd. The read-only `triage_events` tool takes an opaque cursor (process generation + sequence) and 1-100 items, and reports reset-required instead of skipping gaps. An injected `OperationOrigins` boundary suppresses only exact echoes and never reviewer feedback. In production it returns null, so origin stays unknown.

## Outcomes

16 new injected-clock tests cover interval, opt-in, overlap and coalescing, dedup and recurrence, restart, incomplete data, backoff and rate-limit resets, the poll timeout, cancellation, retention and gaps, echoes, subscribers, and a real SDK client. All 365 tests, check, build and package-test pass.

## Next Steps

No live poll was run against GitHub. Delivery adapters (#26-#29) and the shared backend (#42) stay separate. A real operation-origin source is needed before echo suppression does anything in production.
