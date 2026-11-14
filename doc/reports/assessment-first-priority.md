# Assessment-first priority (#356)

Recommendation, 14 November 2026: **keep the current band order; no policy change.** Assessments already rank ahead of ordinary implementation, and they should stay behind known easy wins. No anti-starvation safeguard is needed for now.

## Current order

The default Datalog policy (`src/rules/datalog/policy.ts`) matches the approved contract in [blended-action-queues.md](../design/blended-action-queues.md) and the TypeScript rollback comparator (`src/blended.ts`) band for band:

1. Addressed attention (`D-ATTENTION`).
2. Actionable PR follow-up (`D-PR-*`).
3. Designer duties: decision, documentation, design review.
4. Known easy wins: impact L or larger and complexity XS/S, both current (`D-EASY`, `D-OWN-EASY`).
5. Assessments: implementer complexity estimates and designer impact assessments, cross-role boosts first (`D-COMPLEXITY-BOOST`, `D-IMPACT-BOOST`), then ordinary assessments and evidence inspection.
6. Ordinary implementation, own continuation and new design (`D-ORDINARY`, `D-OWN`, `D-DESIGN`).
7. Known unfavorable implementation.

So the open question is only whether band 5 should move above band 4.

## Scenarios

Each row is an executable fixture in `src/rules/datalog/assessment-priority.test.ts`, run against the real Datalog engine. The tests pin today's order, so any later policy change shows up as a reviewed diff. Because no change is recommended, the recommended order is the same as the current order.

| #   | Scenario                                                          | Current order (band)                                                | Recommended |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------- | ----------- |
| S1  | Ready PR versus estimate (impact L, complexity unknown)           | PR follow-up (2), estimate (5), implement (6)                       | Same        |
| S2  | High-impact unknown complexity versus ordinary M/M implementation | boosted estimate (5), then both implementations (6)                 | Same        |
| S3  | Designer: complexity S, unknown benefit, versus new design work   | boosted impact assessment (5), design (6)                           | Same        |
| S4  | Known easy win (L/S) versus unassessed ticket                     | easy win (4), estimate (5), implement (6)                           | Same        |
| S5  | Five unassessed tickets versus one easy win (XL/S)                | easy win (4), five estimates (5), five ordinary implementations (6) | Same        |
| S6  | Own active M/M claim versus estimate on an impact-L ticket        | estimate (5), continue own claim (6), implement (6)                 | Same        |
| S7  | Ticket blocked by another agent's claim, estimable                | estimate only (5); no implementation offered                        | Same        |

## Reasoning

- **Easy wins stay ahead of assessments.** An easy win is the outcome that assessment exists to find: both facts are already current and favourable. Putting estimates first would delay the one item whose benefit is already known in order to look for more items like it. Easy wins are also rare (two independent, current, favourable labels), so they cannot crowd assessments out.
- **Assessments stay ahead of ordinary work.** This already gives the owner's "estimation is quick and informs selection" its effect (S2, S3, S5). The cross-role boosts make sure the most informative assessments come first.
- **No starvation safeguard yet.** Assessments drain themselves: each one moves its ticket out of band 5, and estimation is quick. In S5 ordinary work waits behind the backlog estimates, but the known easy win does not. A cap on consecutive assessments would add state that the stateless engine does not have today. Revisit only if live use shows a steady inflow of unassessed tickets keeping band 6 empty for days.
- **Own claims (S6)** follow the contract rule that an existing claim uses its value band, so an estimate can show ahead of an ordinary claim. Estimating takes no claim, so this does not abandon the work. This report does not change that rule.

Kept as they are: cross-role boosts, finish-first PR handling, role, platform and claim eligibility, missing-evidence inspection, and the explicit `--order oldest|newest` age semantics. The same policy produces both the decision and the reason text; rendering work (#352, #353, #355) is separate.
