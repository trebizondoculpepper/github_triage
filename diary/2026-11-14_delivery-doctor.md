# Development Diary Entry - 2026-11-14

## Context

- **Date**: 2026-11-14 UTC
- **Branch**: feat/192-delivery-drift
- **Contributors**: Claude Code (kavya_sabbagh) + User

## Problem Statement

Issue #192 asks Ticket Doctor and the shared read surfaces to explain delivery evidence, responsibility and drift. The ticket is large (six surfaces); this session delivers the Ticket Doctor slice.

## Our Approach

Reuse the existing fold (`readDeliveryFold`), the live collector (`collectDeliveryFacts`) and the evaluator (`evaluateDelivery`) rather than add a second interpretation. A new async `diagnoseDelivery` in `src/deliverydoctor.ts` produces per-ticket facts; `ticketDoctor` stays synchronous and turns them into findings when given them. The fold now records the structured transfer on a `HANDOFF_STALE` rejection so the Doctor need not replay again.

## Implementation

`src/deliverydoctor.ts`, `src/ticketdoctor.ts` (delivery findings, supersession of the two label-only review checks), `src/doctorplans.ts` (complete, delivery dry-run, fresh handoff, legacy attach and attest steps), `src/cli.ts` (wiring through the per-run permission cache), `src/delivery.ts` (transfer detail), tests in `src/deliverydoctor.test.ts`.

## Outcomes

Unknown evidence stays unknown at every step: offline or without a permission boundary, records are reported unverified and the old label checks still run. Tickets without records produce byte-identical reports.

## Next Steps

Closed-issue drift (S5, S16, S68) with a bounded read; delivery, responsibility and closure in briefing JSON, `pr`, `who`, `team` and MCP with parity.
