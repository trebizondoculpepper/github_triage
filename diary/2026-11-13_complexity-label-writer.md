# Development Diary Entry - 2026-11-13

## Context

- **Date**: 2026-11-13 UTC
- **Branch**: issue-152-complexity-label-writer
- **Contributors**: Claude Code (kavya_sabbagh) + owner

## Problem Statement

Issue #152: switch complexity estimates from the native issue field to `complexity:XS`..`complexity:XXL` labels, together with the production read routes (briefing estimation queue and Ticket Doctor), per doc/design/complexity-estimation.md.

## Our Approach

Rewrite `estimate N` over the existing gh GraphQL boundary while keeping the #121 safeguards: v2 provenance marker (label-backed, no field IDs), paging back for provenance, re-read before writing, idempotent retries, partial-failure reporting and refusal on unknown evidence. Switch the briefing/MCP service to the #151 label reader and add the conflict finding to Ticket Doctor through the shared classifier.

## Implementation

- `src/estimate.ts`: creates only the requested missing label (reusing case-equivalent definitions untouched, settling create races by re-reading), adds it and removes other recognized size labels one at a time, verifies the final label set, then writes the provenance comment.
- `--replace OLD` became an optional guard, as the contract says a prior estimate never requires an override.
- `src/service.ts`, `src/briefing.ts`: label-backed estimation input/report; v1 field provenance is ignored on the label route.
- `src/ticketdoctor.ts`, `src/doctorplans.ts`: `complexity-label-conflict` finding with inspect/estimate suggestions; the field configuration diagnosis is no longer evaluated.

## Outcomes

- A live read-only briefing of this repository now shows the estimation queue as available with 28 unestimated tickets, where the field route reported it unavailable.
- Unrecognized `complexity:*` labels are refused rather than silently kept, since they would leave the ticket conflicting after the write.

## Next Steps

#153 deletes the retired field modules, `complexity.fieldId`, `setup complexity` and their help/tests.
