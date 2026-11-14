# Development Diary Entry - 2026-11-14

## Context

- **Date**: 2026-11-14 00:12 UTC
- **Branch**: issue-245-impact-estimates
- **Contributors**: Claude Code (kavya_sabbagh) + owner

## Problem Statement

#245 is the first slice of the impact-assessment epic: record and revise designer impact T-shirt estimates using the existing complexity mechanics, as specified in the #245 scope of doc/design/impact-estimation.md (PR #268). The owner settled impact.enabled = true by default; complexity provenance trust is #269.

## Our Approach

Generalise rather than copy. A two-entry metric descriptor (src/metrics.ts) parameterises the label classifier, findings and suggestion table (src/complexitylabels.ts), the writer and provenance parser (src/estimate.ts) and a new trusted-provenance reader (src/assessments.ts). The complexity wrappers keep their names, so every existing caller is unchanged.

## Implementation

- `estimate N --metric impact`, marker `github-triage:impact-estimate v1`, kind `impact-estimate`, schemaVersion 1. Complexity queries, mutations, comments, text and JSON are byte-identical (checked against origin/main with a scenario script, and a golden regression test).
- Impact reads comment author/edit evidence and the issue's `lastEditedAt`. Only trusted markers (#215, through an injected `TrustDecision`) count for retry identity; an identical stale record is re-recorded.
- `impact.enabled` registered; Ticket Doctor gained impact-label-conflict/invalid/incomplete with `low`→S and `high`→L suggestions.

## Outcomes

- A lazy `import()` that broke an import cycle split the bundle into a chunk outside the package allowlist; package-test caught it. The CLI now injects the trust boundary instead.
- The snapshot collection does not select comment `__typename` or edit evidence, so the reader is a primitive for #247 rather than wired into reports yet.

## Next Steps

#247 (paired facts and display), #248 (blended policy), #246 (designer guidance and queue).
