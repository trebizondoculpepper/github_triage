# Rules plausibility scenarios (#154)

Bounded research, completed 2026-11-13 in roughly one hour of agent time. No production ranking, briefing, configuration or dependency changed. The suite extends the isolated rule-record spike from [rules-language-spike.md](rules-language-spike.md) (#74) and lives beside it in [examples/rules-spike/](examples/rules-spike/).

The ticket names `doc/design/rule-scenario-plausibility.md` as its contract; that document does not exist on `main` or in any open PR, so the scenarios below follow the ticket's acceptance criteria and the merged contracts they cite: action groups and pickup ordering in [briefings.md](../design/briefings.md), claims and done handoff in [workflow.md](../design/workflow.md), and estimation eligibility in [complexity-estimation.md](../design/complexity-estimation.md). If that document lands with different definitions, the fixtures should be reconciled with it.

## What this is, and what it is not

This is a **deterministic engine check**: given complete synthetic facts, do the rule records choose a plausible next action and explain it? It says nothing about whether an LLM agent reading the compiled guidance would act the same way. That adherence question is the separate repeated A/B study #78, with its own model and budget decision. No model was called here and no statistical claim is made.

## Reproduce

From the repository root, with no credentials, network or extra dependencies:

```sh
npx tsx doc/reports/examples/rules-spike/plausibility-run.ts   # outcomes, readable examples, exit 1 on failure
npx vp test run doc/reports/examples                            # the same scenarios as vitest cases
npm run check                                                   # type-checks the examples (tsc -p doc/reports/examples)
```

`npm test` also runs the scenarios: the vitest include now covers `doc/reports/examples/**/*.test.ts`.

## What was added

- `plausibility.ts`: seven facts (`prActionable`, `prWaiting`, `myContribution`, `statusConflict`, `urgencyConflict`, `complexityOn`, `estimated`), four actions (`continue`, `estimate`, `wait`, `fix_labels`) and eight rule records P1–P8. The spike's R1 and R3–R11 are reused unchanged; R2 is replaced by P1/P2 (see the finding below). An evaluator combines hits with the spike's own `decide` (must_not wins, overrides listed), then orders offered work by briefing action group: respond, PR follow-up, own active work, pickup, then optional estimation. Offered work is consolidated to one item per subject (a ticket record includes its linked PR, so the pair is one subject): the item takes the subject's first matching group, lists later permitted actions as `alsoActions`, and carries the union of their reasons, facts and overrides. Every decision is still kept for explanations. Pickup uses the briefing order: urgency band, immediate unlocks, incomplete before unstarted, oldest, number; explicit `oldest`/`newest` modes replace all of that weighting.
- `rules.ts`: `decide` and `Hit` are exported, `checkRules` accepts a fact table, and the four new actions have English phrases. The DataScript evaluator and the original #74 harness are untouched.
- Scenarios are a frozen data array declared before any evaluation. Each carries complete ticket facts and expectations: the exact set of offered work, a partial order (`[a, b]` means a before b), an exact pickup order where ordering is the point, forbidden actions that must not appear anywhere in the offered plan, the exact inspect set, explanation checks on rule IDs, condition facts, modality and overrides, and checks on the actions and reasons a consolidated item carries. A generic check in every scenario fails if any subject is offered twice; reverting to the unconsolidated plan makes S2 and S4 fail it. No check compares English text.

## Per-scenario outcomes

All 13 pass, and the extended rule set has no static diagnostics.

| ID  | Scenario                              | Key assertions                                                                                                                                                                 | Result |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| S1  | Actionable versus waiting PR          | Actionable own PR is `must follow_up` (P1) before pickup; waiting PR is only `inspect wait` (P2), never follow-up or pickup                                                    | Pass   |
| S2  | Addressed attention                   | Low-urgency addressed ticket is offered once, as `respond` (R1) carrying its pickup reason (R9), before high-urgency pickup; other-agent attention offers no respond           | Pass   |
| S3  | Ready vs blocked, unknown, claimed    | Own claim `continue` (P3) before pickup; blocked (R5 overrides R9), unknown blockers (inspect R10) and another's claim (R4) never offered                                      | Pass   |
| S4  | Optional estimation of blocked work   | Blocked unestimated ticket is offered `may estimate` (P7) but not pickup; the ready unestimated ticket is offered once, as pickup carrying P7; estimated ticket not re-offered | Pass   |
| S5  | Disabled complexity                   | Same tickets with complexity off: no estimation anywhere, explained by P8 `must_not` on `!complexityOn`                                                                        | Pass   |
| S6a | Explicit oldest ordering              | Old low-urgency before incomplete before new high-urgency high-impact: `[30, 32, 31]`                                                                                          | Pass   |
| S6b | Explicit newest ordering              | `[31, 32, 30]`                                                                                                                                                                 | Pass   |
| S6c | Default impact ordering, same tickets | `[31, 32, 30]` (urgency, then the unspecified band before low)                                                                                                                 | Pass   |
| S7  | Urgency then utility                  | High urgency first, then most immediate unlocks, then age; a low-urgency ticket unlocking five stays last: `[42, 40, 41, 43]`                                                  | Pass   |
| S8  | Label conflicts                       | Both urgency labels rank in the unspecified band and raise `inspect fix_labels` (P6); ready plus awaiting-review forbids pickup (P4 overrides R9)                              | Pass   |
| S9  | Incomplete label evidence             | Incomplete label evidence is inspect-only (R10); `status:incomplete` work is eligible and ranks before unstarted                                                               | Pass   |
| S10 | Post-done PR follow-up                | Released claim with a recorded contribution and actionable PR is still `must follow_up` before high-urgency pickup; another agent's PR is not offered                          | Pass   |
| S11 | Deliberately conflicting rules        | Two `contradiction` diagnostics; at run time R5 visibly overrides R9 and X1, and X2 visibly overrides R1                                                                       | Pass   |

## Readable examples

Abridged from the runner's output. `[...]` lists the deciding rules' conditions, `!` marking negation.

S1, actionable versus waiting PR (#1 own claim with an actionable PR, #2 post-done contribution with a waiting PR, #3 plain ready):

```text
offered, in order:
  1:follow_up must because P1 [myContribution,prActionable]
  3:pick_up may because R9 [pickupLabel,!claimed,!evidenceUnknown,!platformUnknown]
not offered:
  1:pick_up must_not because R6 [hasOpenPr]
  2:pick_up must_not because R6 [hasOpenPr]
  2:wait inspect because P2 [myContribution,prWaiting]
```

S4, optional estimation with complexity enabled (#20 ready, #21 blocked and unestimated, #22 blocked and estimated):

```text
offered, in order:
  20:pick_up (also estimate) may because R9,P7 [pickupLabel,!claimed,!evidenceUnknown,!platformUnknown,complexityOn,!estimated]
  21:estimate may because P7 [complexityOn,!estimated]
not offered:
  21:pick_up must_not because R5 [blocked] overrides R9
  22:pick_up must_not because R5 [blocked] overrides R9
```

S11, deliberately conflicting rules (X1 `may pick_up` when blocked; X2 `must_not respond` when addressed):

```text
static diagnostic: contradiction R1/X2
static diagnostic: contradiction R5/X1
offered, in order:
  81:pick_up may because R9 [...]
not offered:
  80:pick_up must_not because R5 [blocked] overrides R9,X1
  81:respond must_not because X2 [addressed] overrides R1
```

## Implausible outcome found

The #74 rule R2 (`must follow_up` when you hold the claim and a PR is open) is implausible in two ways, and `baselineFinding()` asserts both against the unmodified spike rules:

- A **waiting** PR (pending review or CI) on your claimed ticket becomes mandatory follow-up work, ranking it above real pickup. Briefings say waiting is not actionable.
- A **post-done** PR, where the done handoff released the claim, offers nothing at all, so actionable review feedback on your own PR is invisible.

P1/P2 replace R2 in the plausibility rule set, keyed on `myContribution` (claim or recorded handoff contributor, never the shared login) and the PR's actionable/waiting state.

## Honest gaps

- The PR state (`actionable`/`waiting`) and the contributor list are given facts. Deriving them from reviews, check runs and handoff records is production evidence work that this suite does not test.
- Static diagnostics only catch identical-condition contradictions. A conflict between overlapping rules with different actions (for example a stray `must follow_up` on a waiting PR alongside P2's `inspect wait`) is neither diagnosed nor resolved; both decisions would appear.
- `decide` resolves conflicts only per (ticket, action). A deliberately conflicting `must_not respond` silently removes addressed attention from the plan; it is visible as an override and a diagnostic, but nothing protects attention the way briefings require ("keep directed attention visible regardless of role or urgency").
- Not modelled: designer/review groups, stale claims, platform scenarios beyond the #74 ones, contribution-done without a PR (an inspection case in workflow.md), urgency of addressed attention beyond S2, distant descendants and dependants still needing design when counting unlocks (`unblocks` is a given number), and the one-active-claim rule when several `continue` items appear.
- The new facts have no DataScript clauses, so the DataScript parity check from #74 does not cover them. That matches the #74 recommendation to drop DataScript.
- Fixtures were written by the same agent that wrote the rules, so they test plausibility against that agent's reading of the contracts. An independent fixture author, or reconciliation with the missing design document, would strengthen them.
