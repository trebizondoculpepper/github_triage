# Designer impact estimation: approved direction

Product decision record for analysis #244 and delivery #245–#248. This records the owner’s intent; it is not the completed implementation contract or a claim that impact commands are shipped. #244 must audit the existing complexity implementation, write precise rubric/schema/commands/settings and land a reviewed contract first.

## Why mirror complexity?

The owner wants benefit and effort categories visible together so a high-benefit small change is an understandable easy-win candidate. Implementers assess complexity; designers assess impact/benefit. Both use XS, S, M, L, XL and XXL, with a justification and revisable repository-relative guidance. Impact may include the meaningful downstream value enabled by an outcome, not merely its direct effect.

Impact L / complexity S suggests an easy win; impact S / complexity L suggests limited benefit relative to substantial work; impact L / complexity L suggests valuable substantial work that may benefit from splitting. These are ordinal categories, not hours or numeric ratios. We do not divide category indexes or add downstream T-shirt labels. Unassessed stays absent, and incomplete evidence stays unknown.

## Reuse and separation

Reuse the existing estimation mechanics for a second metric: recognized labels, safe explicit creation/replacement, rationale/provenance, revisions, conflicts/invalid labels, unknown evidence, retry/partial-write reporting, role-shaped queues and shared CLI/MCP guidance. Preserve the assigned-size justification rule: disagreement alone permits reassessment without defending another agent’s decision. The analysis should recommend `impact:XS` through `impact:XXL`, while keeping complexity labels separate and untouched. No native fields or new setup/permission service.

Do not confuse three things: designer-assessed benefit; implementation complexity; and the tool’s computed immediate dependency-unlock utility. The last remains evidence from direct relationships and eligibility, not an estimate or transitive sum. A designer’s role is workflow responsibility, not additional cryptographic authentication. Do not add a generic assessment framework or expand into risk scoring.

## Staged delivery

1. #244: audit reuse, define impact guidance and precise interface/schema/settings, and obtain contract review.
2. #245: shared impact classification plus explicit record/revise behavior with safe labels/provenance.
3. #246: designer unassessed/stale-impact queue and versioned inline guidance.
4. #247: side-by-side impact/complexity display and shared read facts.
5. #248: a small, explainable ordinal easy-win heuristic within existing priorities.

Queue and display may proceed independently after recording/reader primitives. The heuristic waits for reviewed rules and paired facts. Preserve attention, urgency, finish-before-start, eligibility and explicit age-only ordering. Incomparable pairs and unknowns need deterministic documented fallback, not false precision. Do not hold the existing simple ranking release for complete backlog coverage, these enhancements, historical recalibration or a production formal-rule engine. Later formal rules should consume the same facts.

The detailed interface contract produced by #244 is [impact-estimation.md](impact-estimation.md).
