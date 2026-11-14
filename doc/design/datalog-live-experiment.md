# Datalog decisions and explanations

Owner-approved direction, 2026-11-14. Contract for #302–#306 and default adoption #327–#328; runtime behavior is shipped only by the linked implementation. The goal is to try a real role queue whose recommendations and why narration come from one Datalog policy, not to build a general workflow language or prove agent adherence first.

## Owner adoption decision (#327)

After the bounded comparison, the owner explicitly chose Datalog as the default next-action engine because its matched-rule explanations are clearer. The owner also confirmed that uncertain inspection work belongs in the foreground queue. These are product policy decisions, not evidence of better throughput or agent adherence. On the same frozen 43-ticket input, the implementer top ten matched and shared actions retained relative order; Datalog added three foreground inspections. Preserve those inspections as inspection, never implementation permission.

The normal CLI/MCP next-action view uses Datalog when no engine setting is stored. An explicit `briefing.engine=typescript` remains the rollback, and explicit engine settings always win. With Datalog selected, an explicit supported role wins; if no role is requested, use the **implementer presentation** and report that role as a default. This is a view default, not an inferred identity, ownership claim or authority grant. `--role designer` / MCP `role: designer` selects the designer queue. Unsupported explicitly supplied roles receive exact supported-role guidance rather than being replaced. No identity-file migration is required for this default.

Repository settings still apply only to a verified matching checkout. Without such a checkout, use the registered repository default (now Datalog), report that selection source and do not inherit another project's explicit setting. Full ticket intake and repository catch-up remain on their existing services and report that scope accurately. Evaluator failure still yields a bounded diagnostic and a real rollback path, never a silently substituted TypeScript decision. Malformed configuration must preserve the configuration service's repair guidance; a rollback command that cannot parse the broken document is not a repair.

## Why and what changes

The production TypeScript workflow/ranking modules currently choose actions, and role/render templates supply much of the why text. The #74 DataScript prototype matches rules but still calls TypeScript decide/order afterwards. The #154 scenarios also retain the historical estimation-last policy. Merely exposing those artifacts behind a switch would not meet this requirement.

The owner initially chose a narrow opt-in DataScript experiment despite the earlier report's recommendation to defer it. Preserve that report as dated evidence; this later choice is to learn from a real trial, not a claim that the library won the old benchmark. Reuse the tested DataScript 1.8.1 initially, pin it in the lockfile and verify its actual EPL license/notice and packaging obligations before shipping. npm metadata inspected on 2026-11-14 identifies version 1.8.1 and about 470 KB unpacked; dependency size is a trade-off, not a new acceptance benchmark. TypeScript wrappers and intentionally selected Datalog clauses follow the language policy.

## First slice and exclusions

Cover the blended implementer/designer next-action views and their current documented policy: addressed attention; own/other actionable PR follow-up versus waiting; designer decision/documentation/review duties; known easy wins; confidence-building assessments and cross-role boosts; ordinary work; known unfavorable work; urgency/direct-unlock ties and explicit age-only pickup. Preserve ownership, platform, evidence and open-PR restrictions. All of these must be derived by the experimental policy rather than calling legacy rank/classify/role handlers for the answer.

Normal catch-up history briefing, full ticket/dependency/PR intake, polling event production and mutation/refusal enforcement stay on their existing services. No auto-claim, merge, issue closure, new wake mechanism, production custom rules or paid/bulk model study. Existing mutation guards still verify live facts even if an experimental recommendation disagrees. Such a disagreement is recorded as a defect/limitation, never permission to bypass the guard.

## Configuration and rollback

Register repository setting briefing.engine with enum typescript|datalog and default datalog. Supported use is `pdb config set briefing.engine datalog`, get/list/help via the existing registry, rollback `pdb config set briefing.engine typescript`. Config files are not edited directly by agents. No global/machine setting, user EDN, executable config, inline arbitrary query or custom rule override in this first slice. No configuration schema bump is needed solely for an additive validated key; preserve existing migration rules and reject invalid values.

Resolve the setting only for a verified checkout of the selected repository through existing project/config resolution. MCP uses its explicit selected project/repository binding; a tool call for a different repo must not inherit a daemon/other project's experimental setting. Without a matching local settings context use the documented normal repository default, reporting that selection source in metadata. A selected datalog engine that cannot be read/validated or whose evaluator fails yields a bounded error/inspection result and the rollback command, not silent TypeScript output labelled Datalog. The effective role is explicit implementer/designer or the documented implementer view default; unsupported explicit roles give exact --role guidance. Report the effective role and whether it came from the request or default. Repository catch-up mode ignores the next-action engine setting and reports its own scope accurately.

Load/initialize the engine only when selected. Runtime packaging must include the dependency or a verified bundled artifact/notice; ordinary installed consumers need no dev dependencies. Prove disabled mode still works without initializing the experimental evaluator. Do not require a new service or authentication mechanism.

## Facts, policy and evaluator boundary

Normalize the already collected snapshot into stable subject/agent/repository IDs, labels and their completeness, native direct edges and summaries, PR state/head/check/review/link evidence and completeness, trusted responsibility observations, resolved platform/role, current assessment sizes/states, creation time and requested order. This mechanical adapter must not supply preselected action kinds, legacy eligibility verdicts, pre-ranked candidates, easy-win flags, or TypeScript-computed final bands/boosts/unlock scores. Existing permission/record integrity and GitHub fact readers remain verified input boundaries; do not silently recast their safety checks as part of the new read-only policy.

Represent known-false and unknown distinctly. Derive absence-based facts only with the relevant complete input relation. Missing labels/edges/claims/closing links cannot become proof of readiness. Multi-valued labels, owners, platforms, PR references, reasons and evidence must use explicit cardinality-many schema; the earlier prototype found a real lost-value bug without it.

One versioned bundled policy artifact contains Datalog clauses plus stable rule IDs, action names, modality/precedence, why phrases and fact-binding labels. Its checksum includes the clauses, ordering/narrative metadata and database schema. Datalog queries derive eligibility, permits/denials/inspection, effective conflict precedence, role-relevant candidate kinds, first-matching bands, cross-role boosts and all policy-dependent sort keys. Denials override permissions in Datalog and the effective result identifies the overridden rule IDs. Derive direct unlock lower bounds from raw collected direct relationships and dependent readiness conditions; do not credit assessment with completing a blocker, count distant descendants or turn missing coverage into zero.

For example, an easy-win predicate requires current impact and complexity plus the L/XL/XXL and XS/S buckets. Eligibility is a separate required derived relation before that ticket can be offered for implementation:

```clojure
[(easy-win ?t)
 [?t "impact-state" "current"]
 [?t "complexity-state" "current"]
 (or [?t "impact-size" "L"] [?t "impact-size" "XL"] [?t "impact-size" "XXL"])
 (or [?t "complexity-size" "XS"] [?t "complexity-size" "S"])]
```

DataScript relations do not themselves imply an ordered array. The engine must emit the band and every policy sort key plus a declarative comparison descriptor. TypeScript may execute a fixed numeric/code-point lexicographic comparator over those emitted keys; it must not choose band precedence, urgency weights, boosts or alternate ordering in code. Explicit oldest/newest pickup coalescing and ignored weights follow blended-action-queues.md, derived by the policy rather than a hidden legacy sorter. Mechanical serialization, fixed query phases, query execution and ID-to-source-link lookup are allowed; calling the old decide/order/classify path to repair experimental results is not.

## Why must come from the same inference

The fired-rule relation joins the rule ID to its bundled why phrase and the actual matched fact/evidence bindings. Return the selected narrative parts with the decision, including blocking/overridden rules where relevant. A renderer may interpolate those engine-selected parts and format links, but must not choose an independent why template from roles.ts/compact.ts or invent an explanation after a TypeScript decision. No model-generated paraphrasing is needed.

Keep language short and specific, for example `Easy win: impact L, complexity S [D-EASY]` or `Assess complexity: impact XL, complexity unknown [D-ASSESS-C]`. For every shown why, acceptance must recover the fired rule and the facts actually used. Changing a rule's predicate/narrative source updates behavior and narration together. A missing explanation binding is a visible engine diagnostic, not a trigger for old canned prose.

## Results, coverage and failures

Reuse rankedActions and legacy target projections without changing existing field meanings. Add decisionEngine:{requested,used,policyVersion,rulesHash,coverage,diagnostics}; used must reflect what actually ran. Experimental action rows add ruleIds and why:{text,ruleIds,facts,overriddenRuleIds}, with bounded selected fact bindings and source links, not the whole database. Keep existing stable reasonCodes only when emitted by the policy metadata. Compatibility projections and row limiting are mechanical transformations of the derived order, not additional policy evaluations. Preserve current JSON schemas additively; the separately versioned bounded MCP envelope in #266 remains a different implementation.

The first evaluator accepts at most 500 subjects and 50000 normalized datoms. Above that, return experimental-scope-exceeded with the TypeScript rollback command; never trim the database and claim a complete verdict. Measure evaluation time and report a soft two-second budget overrun as an experimental diagnostic. Check cancellation before/after synchronous evaluation and between query phases; do not claim a hard timeout or preemptive cancellation that the implementation cannot provide. No arbitrary caller rules are accepted. If cyclic/conflicting unsupported inference, missing required evidence or engine failure prevents a conclusion, show unknown/inspection or a bounded explicit error; no hidden native-engine fallback.

## Compact presentation for both engines (#305)

Normal compact next-action output defaults to ten rows; preserve explicit --limit and existing validation/budget constraints. Rank before limiting. Omit empty role sections and zero-emitted/zero-omitted text counters. Do not repeat generic read-only/not-authority/full-history boilerplate in every row. Keep action-specific reasons, actual nonzero omission counts, source freshness, genuine unknown/conflict/safety warnings and useful next commands, consolidated once where possible. Do not hide a real limitation simply to make output smaller.

Do not append the workflow guide by default in compact next-action output: processGuide defaults false when unset. Preserve explicit true/false repository values and --guide/--no-guide precedence, and keep the dedicated process/help command available. Update registered defaults and generated help together. This changes presentation in both engines; rollback to typescript restores the default decision engine, not the old noisy footer. Explicit full intake remains available. JSON retains empty arrays/zero counters required by existing schemas; compact text cleanup alone does not solve #266's whole-result size defect. CLI and MCP text share the same policy-derived reasons and compact rules.

## Acceptance and delivery

#303 updates current-policy fixtures and the evaluator. Cover PR/implementation/unestimated competition; known easy win before a promising estimate; both cross-role boosts; designer active-work decisions; waiting PR versus actionable PR; addressed attention; other claims; native blockers; multiple labels/owners/platforms; unknown provenance/evidence; disabled metrics; numeric stable ties; direct unlock unknowns; explicit oldest/newest; deny-over-permit and overlapping rules. Assert both derived action/order and explanation rule/fact bindings. Historical #74/#154 fixtures remain dated evidence; any adopted fixture is reconciled against current contracts before becoming the new oracle.

#304 wires config and shared CLI/MCP read service, startup/selected-project isolation, installed dependency and truthful errors/engine metadata. #305 renders compact output and guide defaults independently after this contract. #306 runs credential-free package/role parity, then one bounded read-only repository snapshot through both engines. Compare the same frozen facts and expected scenarios, report differences instead of forcing parity by calling TypeScript decisions, trace every why, record runtime/harness/source provenance and rollout/rollback commands. Use temporary config with supported commands for tests; after acceptance, install the verified source build globally for the owner's trial. The later owner adoption decision authorizes the registered Datalog default; do not overwrite explicit engine selections or alter unrelated settings.

Local trial output is doc/reports/datalog-live-trial.md. Plausible behavior on a few realistic scenarios and an honest installed trial is enough to evaluate the first experiment; no mandatory bulk model trials, exhaustive benchmark, custom-rule framework. Default adoption is now explicitly approved above. #75's broader default/override design and #78's agent-adherence study remain independent future work. This documentation phase does not close implementation or acceptance tickets.
