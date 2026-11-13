# Blended action queue design

The owner replaced estimation-last with a single role-shaped action queue. Confidence in advancing delivery motivates finishing PRs, implementing known easy wins, improving confidence through assessments, and deprioritizing known expensive low-benefit work. High impact boosts missing complexity assessment; low complexity boosts missing impact assessment. Wrote a documentation-first contract with explicit ordinal thresholds, unknown/disabled/claim handling, stable ties, explicit age-sort compatibility and injected acceptance scenarios. Runtime is unchanged. Existing impact tickets are reused; implementation requires reviewed contracts and fresh verification.

Tracking: #258 contract review, #248 shared policy, #259 implementer, #246 designer, #260 installed acceptance. Required check, 574 tests and both builds passed (12 existing lint warnings, no errors). Source smoke help passed.
