# Rules language feasibility spike (#74)

Spike completed 2026-11-13, following the plan in [rules-language-engines.md](rules-language-engines.md) (#73). No runtime code, package dependency, configuration or live workflow changed. The spike lives in [examples/rules-spike/](examples/rules-spike/); DataScript was installed in an isolated scratch directory for the independent verification below; it is not a project runtime dependency. The wrappers have been migrated to TypeScript under #91; intentionally ancillary Datalog clauses remain. The independent timing table below records the original pre-migration run, not a newly measured TypeScript result.

## Later owner experiment direction

On 2026-11-14 the owner chose an opt-in live Datalog trial, documented in [datalog-live-experiment.md](../design/datalog-live-experiment.md) (#302–#306). The recommendation and measurements below remain historical evidence. The new experiment must replace the prototype's TypeScript decision-combination/order steps and update estimation-last fixtures; this report does not claim that work is delivered.

## Recommendation

**Simplify: adopt the rule-records layer, reject DataScript for now.** Rules as small data records over a registered fact table give the benefits the owner asked for (one source compiled to English, explicit must/may/must-not, explained overrides, static conflict diagnostics) evaluated by plain registered JavaScript. DataScript produced identical decisions on every scenario, but only after declaring every array-backed attribute `:db.cardinality/many`: without that schema it silently kept only the last label, owner or platform and allowed pickup the JS evaluator forbade (found in review; the multi-valued scenario now guards it). It also added a second clause language, an EPL-licensed dependency and a slower end-to-end evaluator invocation in this experiment, including datom/database construction, while the selected rules in this narrow slice are conjunctions of named facts that the registered evaluator can handle directly. This does not measure isolated query-engine overhead or establish that every production workflow rule has this form. Revisit a Datalog engine only if #75 needs recursive or join-heavy rules (for example, transitive dependency reasoning inside rules), which the selected scenarios did not require.

## What was built

- **Fact table** (`FACTS` in `rules.ts`): each named fact (`claimedByOther`, `blocked`, `evidenceUnknown`, `restricted`, …) has a JS test, a DataScript clause and an English phrase in one record. Rules cannot contain functions or free-form queries; they only name facts.
- **Rule records** (`RULES`): `{ id, modality: must | may | must_not | inspect, action, when: [fact, optionally negated], reason }`. Eleven records express the slice of the agreed workflow exercised by the scenarios.
- **Order clause** (`ORDER`): declarative keys for pickup order (dependants unblocked, incomplete first, oldest, number), also compiled to English.
- **Two evaluators** compiled from the same records: registered JS, and DataScript (one query per rule over ticket datoms).
- **Decision combination**: per ticket and action, `must_not` wins and the overridden rules are listed (`because` / `overrides`), so an explanation shows, for example, that R5 (native blocker) overrode R9 (ready and unclaimed).
- **Static checks** (`checkRules`): unknown facts, rules that can never apply, and contradictory pairs (identical conditions, `must_not` against `may`/`must` for the same action). Deliberately conflicting fixtures produce explicit diagnostics rather than a silent winner. Overlapping (non-identical) conditions are resolved at run time by `must_not` precedence and reported as overrides; general satisfiability is not attempted.

## Scenarios

Both evaluators agree, and match the expected outcome, on all thirteen scenarios (the twelve below plus a multi-valued parity check): plain ready ticket; unknown blocker evidence (inspect, not eligible); partial labels (inspect); attention plus an outstanding question (must respond; the question forbids implementation/pickup); own open PR (must follow up, not pick up); another agent's claim; incomplete before unstarted; platform restriction; unknown viewer platform (inspect); native blocker despite `status:ready`; impact before age; outstanding design decision. In the modeled blocker/label evidence, unknown never becomes eligibility: R9 requires `not evidenceUnknown`, and R10 turns it into an inspect action. Attention alone is not a pickup prohibition: the multi-value fixture’s ready ticket 20 both requests a response and remains eligible. Attention does not reserve work; the separate question/design prerequisite caused the prohibition in the earlier fixture.

## Against the owner's five criteria

| Criterion                  | Rule records + JS                                                          | Rule records + DataScript                                                 |
| -------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Correctness                | All 13 selected scenarios, not full workflow acceptance                    | Identical on all 13 (needs a cardinality schema) and 500 tickets          |
| Common-source explanations | English guide, reasons and override explanations compiled from the records | Same (the layer, not the engine, provides them)                           |
| Easy changes               | Add or edit a record; new facts need one JS test                           | Same, plus an EDN clause per fact that must stay equivalent to the JS one |
| Practical cost             | No dependency; independent measurement below                               | 468 KB EPL dependency; end-to-end measurement below                       |
| Better maintenance         | One language (JS) for facts                                                | Two clause languages to keep in step; EPL notice obligations              |

### Independent verification and measurement limits

Re-ran the unchanged spike on 2026-11-13 in a scratch directory with DataScript 1.8.1 on macOS arm64. Both Node versions passed all thirteen scenario assertions and the 500-ticket parity assertion. Each measured row uses the existing harness: five warm-ups, fifty timed invocations, 500 synthetic tickets and eleven rules.

| Node    | Registered evaluator median / p95 | DataScript median / p95 |
| ------- | --------------------------------- | ----------------------- |
| 26.7.0  | 0.60 / 0.76 ms                    | 9.74 / 12.10 ms         |
| 20.20.2 | 0.47 / 0.74 ms                    | 10.66 / 12.36 ms        |

These are total evaluator-invocation times. `evaluateDataScript` constructs datoms, a connection/database and queries on each invocation; `evaluateJs` directly evaluates records against the provided objects. The comparison is useful for this implementation choice, not an isolated query benchmark or general DataScript performance claim. Imports occur before the timing loop; cold-import latency is not measured and the earlier unsupported cold-import figure is removed. No GitHub collection or agent adherence is measured.

Reproduce from the repository root in a POSIX shell (downloads only into scratch/tool caches):

```sh
rules_scratch=$(mktemp -d)
cp doc/reports/examples/rules-spike/rules.ts doc/reports/examples/rules-spike/run.ts "$rules_scratch/"
npm install --prefix "$rules_scratch" --ignore-scripts --no-save datascript@1.8.1 tsx@4.23.15
"$rules_scratch/node_modules/.bin/tsx" "$rules_scratch/run.ts"
```

The runner uses the locally installed Node; record it with the output. Absolute timing varies by machine/load. This current TypeScript reproduction preserves the original assertions; the historical Node 20 measurement is evidence, not an old-runtime support requirement.

## Limits and what #75 must decide

This spike does **not** establish full conformance to the merged briefing/lifecycle contract. It does not model urgency bands, explicit oldest/newest ordering, cross-ticket one-active-claim enforcement, open/closed ticket state, or completeness of ownership/PR evidence. It checks only the stated blocker/label completeness model, selected pickup rules and simplified default ordering. Those missing cases remain requirements to evaluate before production adoption; passing thirteen selected scenarios is not proof that all five owner criteria are satisfied across the entire workflow.

- The fact table is the policy surface: facts are code, rules are data. Projects overriding rules would edit records only; adding facts remains a reviewed code change.
- The contradiction check is pairwise and syntactic. It catches identical-condition conflicts and unknown or impossible rules, not every overlapping case; run-time `must_not` precedence plus visible overrides covers the rest.
- English is mechanical ("when X and not (Y)"); readable but not polished. Templates per fact could improve it without changing the model.
- Agent adherence to rules versus reasons is #78, not shown here.
