# Rules language feasibility spike (#74)

Spike completed 2026-11-13, following the plan in [rules-language-engines.md](rules-language-engines.md) (#73). No runtime code, package dependency, configuration or live workflow changed. The spike lives in [examples/rules-spike/](examples/rules-spike/); DataScript is installed only for the run (`npm install --ignore-scripts --no-save datascript@1.8.1`, then `npx tsx doc/reports/examples/rules-spike/run.ts`; the examples became TypeScript in #91).

## Recommendation

**Simplify: adopt the rule-records layer, reject DataScript for now.** Rules as small data records over a registered fact table give the benefits the owner asked for (one source compiled to English, explicit must/may/must-not, explained overrides, static conflict diagnostics) evaluated by plain registered JavaScript. DataScript produced identical decisions on every scenario, but only after declaring every array-backed attribute `:db.cardinality/many`: without that schema it silently kept only the last label, owner or platform and allowed pickup the JS evaluator forbade (found in review; the multi-valued scenario now guards it). It also added a second clause language, an EPL-licensed dependency and roughly 16x the evaluation time, while every rule the workflow needs is a conjunction of named facts that JS evaluates trivially. Revisit a Datalog engine only if #75 needs recursive or join-heavy rules (for example, transitive dependency reasoning inside rules), which none of the twelve scenarios required.

## What was built

- **Fact table** (`FACTS` in `rules.mjs`): each named fact (`claimedByOther`, `blocked`, `evidenceUnknown`, `restricted`, …) has a JS test, a DataScript clause and an English phrase in one record. Rules cannot contain functions or free-form queries; they only name facts.
- **Rule records** (`RULES`): `{ id, modality: must | may | must_not | inspect, action, when: [fact, optionally negated], reason }`. Eleven records express the slice of the agreed workflow exercised by the scenarios.
- **Order clause** (`ORDER`): declarative keys for pickup order (dependants unblocked, incomplete first, oldest, number), also compiled to English.
- **Two evaluators** compiled from the same records: registered JS, and DataScript (one query per rule over ticket datoms).
- **Decision combination**: per ticket and action, `must_not` wins and the overridden rules are listed (`because` / `overrides`), so an explanation shows, for example, that R5 (native blocker) overrode R9 (ready and unclaimed).
- **Static checks** (`checkRules`): unknown facts, rules that can never apply, and contradictory pairs (identical conditions, `must_not` against `may`/`must` for the same action). Deliberately conflicting fixtures produce explicit diagnostics rather than a silent winner. Overlapping (non-identical) conditions are resolved at run time by `must_not` precedence and reported as overrides; general satisfiability is not attempted.

## Scenarios

Both evaluators agree, and match the expected outcome, on all thirteen scenarios (the twelve below plus a multi-valued parity check): plain ready ticket; unknown blocker evidence (inspect, not eligible); partial labels (inspect); explicit attention (must respond, must not implement or pick up); own open PR (must follow up, not pick up); another agent's claim; incomplete before unstarted; platform restriction; unknown viewer platform (inspect); native blocker despite `status:ready`; impact before age; outstanding design decision. Missing evidence never becomes eligibility: R9 requires `not evidenceUnknown`, and R10 turns it into an inspect action.

## Against the owner's five criteria

| Criterion                  | Rule records + JS                                                          | Rule records + DataScript                                                 |
| -------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Correctness                | All 13 scenarios                                                           | Identical on all 13 (needs a cardinality schema) and 500 tickets          |
| Common-source explanations | English guide, reasons and override explanations compiled from the records | Same (the layer, not the engine, provides them)                           |
| Easy changes               | Add or edit a record; new facts need one JS test                           | Same, plus an EDN clause per fact that must stay equivalent to the JS one |
| Practical cost             | No dependency; 500 tickets × 11 rules: median 0.56 ms                      | 468 KB EPL dependency; cold import ~17 ms; median 9.7 ms                  |
| Better maintenance         | One language (JS) for facts                                                | Two clause languages to keep in step; EPL notice obligations              |

Measured on macOS arm64, Node 26.7.0; a local synthetic benchmark, not GitHub latency. Node 20 was not available on this machine for a second run; #73 already confirmed DataScript imports on Node 20.

## Limits and what #75 must decide

- The fact table is the policy surface: facts are code, rules are data. Projects overriding rules would edit records only; adding facts remains a reviewed code change.
- The contradiction check is pairwise and syntactic. It catches identical-condition conflicts and unknown or impossible rules, not every overlapping case; run-time `must_not` precedence plus visible overrides covers the rest.
- English is mechanical ("when X and not (Y)"); readable but not polished. Templates per fact could improve it without changing the model.
- Agent adherence to rules versus reasons is #78, not shown here.
