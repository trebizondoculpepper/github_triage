# Scenario-based rules plausibility suite

## Why and stage

Before bulk agent experiments, establish whether the executable rule definitions give plausible answers to concrete “what should I do next?” situations. The owner explicitly requested scenarios combining PR follow-up, eligible implementation and unestimated work. This tests the decision system first; it does not establish that an LLM obeys guidance or that explanations improve adherence.

Use the existing isolated TypeScript rule-record spike in `doc/reports/examples/rules-spike/` as the starting point. Extend only the facts/actions needed by this bounded suite. Do not build a general language, replace production ranking, add a mandatory Datalog dependency or require a full experimental platform. Reuse the records as the source for evaluation, rule IDs, reasons and generated guidance. Keep the original evaluator comparison/report truthful about which cases it actually covers.

## Fixtures and expected decisions

Each fixture supplies a synthetic repository/viewer, explicit collection completeness, tickets/PRs with facts, enabled configuration, an ordinary user request and a fixed clock. Expected outcomes are declared before execution. Use stable synthetic IDs; no live claims, labels, GitHub writes, credentials or paid model calls.

| ID  | Situation                                                                                          | Required outcome                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| P1  | Actionable own PR feedback, ready/unblocked implementation and an unestimated ticket               | PR follow-up before implementation; implementation before optional estimation.                                      |
| P2  | PR only waiting for CI, a ready/unblocked ticket and unestimated work                              | Recommend implementation; waiting is not an actionable PR fix.                                                      |
| P3  | Attention addressed to the viewer plus actionable PR/general work                                  | Addressed attention first; attention is not exclusive ownership.                                                    |
| P4  | No actionable PR, active contribution or eligible implementation; known-unestimated blocked ticket | Offer conditional estimation, retain implementation-blocked status, acquire no claim.                               |
| P5  | Same as P4 with complexity disabled                                                                | No estimation recommendation; do not delete labels/history.                                                         |
| P6  | Ready label but an open native blocker; another fully known eligible ticket                        | Do not recommend pickup of the blocked ticket; known eligible implementation can proceed.                           |
| P7  | Missing blocker/label evidence plus a known eligible alternative                                   | Unknown is not eligibility; prefer the known eligible alternative and retain inspection guidance.                   |
| P8  | Another agent claims a ready-looking ticket                                                        | Do not recommend taking that claim; show ownership evidence and available alternatives if any.                      |
| P9  | Explicit oldest-first with an older low-urgency ticket and newer high-impact/high-urgency ticket   | Sort eligible pickup by creation time, then ID; keep urgency/impact visible but unused for ordering.                |
| P10 | Default pickup with high/unspecified/low urgency and immediate-unlock evidence                     | Respect urgency bands and immediate otherwise-ready unlock utility within bands; no hypothetical downstream count.  |
| P11 | Two recognized complexity labels                                                                   | Report conflict/inspection; never select a size or repair labels in a read-only answer.                             |
| P12 | No size label, once with complete labels and once with incomplete labels                           | Complete means unestimated; incomplete means unknown and not a confirmed unestimated queue item.                    |
| P13 | Contribution marked done but new actionable linked-PR feedback appears                             | Surface follow-up despite contribution completion; do not equate done with merged/accepted.                         |
| P14 | Deliberately contradictory identical-condition permission/prohibition rules                        | Produce the declared conflict diagnostic and visible precedence explanation; never silently hide the contradiction. |

Use case subsets with explicit prerequisites when a fixture depends on a labels-only implementation. Engine fixtures themselves model those facts directly, so this suite does not depend on the label-storage implementation merging. Where multiple actions are equally valid, assert the declared eligible set/partial order and deterministic tie-break rather than invent a unique human preference.

## Assertions and explanations

Check allowed/forbidden actions, top recommendation, ordering, evidence completeness and any required conflict/unknown result. A prohibited pickup appearing anywhere as an actionable recommendation is a failure even if the top answer is correct. Assert that blocked estimation does not change implementation eligibility, claims or source state.

For explanations, check referenced rule IDs and supporting fact IDs/values, the stated required/forbidden/inspect modality, visible overridden rules where relevant, and absence of unsupported conclusions. Test exact semantic fields and reproducible generated guidance, not incidental English phrasing. One short human-readable example per major scenario group helps a reviewer judge plausibility without a model grader. Merely printing a plausible paragraph without asserting the decision is insufficient.

## Delivery and budget

Deliver credential-free fixtures, an executable TypeScript runner/assertions, reproducible commands and a report under `doc/reports/` with per-scenario outcomes, representative explanations and honest gaps. A passing subset is a partial result, not a claim that all workflow rules are formalized. Record elapsed agent time and stop at roughly one hour for this initial plausibility/preparation stage; return artifacts/gaps rather than expand into production or bulk testing.

No repeated model trials, dollar spending or statistical claims are required or authorized by this suite. Later rules-alone versus rules-with-reasons trials remain #78's separate evaluation stage and require their own model/harness and spending decision. The larger feasibility/practicality study must not block this lower-bar plausibility exercise.
