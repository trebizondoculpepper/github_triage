# Opt-in Datalog evaluator (#303)

Added a separate read-only DataScript evaluator over collected GitHub facts and paired trusted assessment readings. Bundled clauses select actions, infer eligibility/denials, bands, assessment boosts and sort keys, and join rule-owned explanation text. The adapter does not use legacy candidate selection, classification or ranking. Direct-unlock lower bounds are derived from raw direct relationships rather than the supplied legacy assessment score.

Pinned DataScript 1.8.1, retained its unmodified dependency notice and included the upstream tagged license and source link in the package. Explicit bounds, cancellation checkpoints, a soft runtime diagnostic and engine/rule provenance accompany results. Configuration/CLI/MCP selection remains the separate #304 integration. TypeScript remains the normal engine until that opt-in exists.

Scenario coverage includes PR/implementation/assessment competition, reciprocal boosts, unknown completeness, blocked estimates, platform/owner multiplicity, age ordering, head-specific PR follow-up, numeric ties and scope/cancellation. No live settings or mutation safeguards changed.
