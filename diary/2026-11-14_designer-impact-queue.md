# Development Diary Entry - 2026-11-14

## Context
- **Date**: 2026-11-14 UTC
- **Branch**: issue-246-impact-guidance
- **Contributors**: Claude Code (kavya_sabbagh) + owner

## Problem Statement
#246, the last slice of the impact-assessment epic: impact guidance in CLI and MCP help from one definition, designer `assess-impact` actions in the #248 ranking, the designer NEXT STEPS list and the `impactEstimation` report object.

## Our Approach
Reuse everything #245/#247/#248 shipped. The `assess-impact` candidates already existed in `roleCandidates`; this slice only gives impact inspection actions the Ticket Doctor fix as their command, renders the ranking in designer text, and summarises it as counts. The complexity guidance renderer was generalised so both metrics share it byte-for-byte.

## Implementation
- `src/complexity.ts`: shared `guidanceText`; `src/impact.ts`: text, JSON and MCP-summary renderers.
- `estimate --help --metric impact [--json]`; `github-triage-mcp --help` carries the impact summary.
- `src/compact.ts`: designer-only `impactEstimation`; ranking computed once unbounded so counts survive the display limit; designer NEXT STEPS renders `rankedActions`.
- Tests in `src/impactqueue.test.ts` through `main`/`collect()` with injected permissions, plus package-test checks.

## Outcomes
Non-designer output is byte-identical (the parity tests still pass untouched). The MCP server has no role views, so the designer queue is CLI-only until #260 checks parity.

## Next Steps
#259 (implementer view and legacy projections) and #260 (installed parity).
