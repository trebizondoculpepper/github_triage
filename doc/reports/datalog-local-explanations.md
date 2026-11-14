# Bounded local Datalog explanation trial

Date: 2026-11-14. Source: `67ed2ed`. Tracking: #308; informs #303 and #306.

## Result

The local DataScript experiment passes 12 scenario checks and produces both role queues from a frozen 43-ticket snapshot collected at 13:00:45 UTC. This establishes plausibility for deriving actions and their explanations together. It does not establish production readiness or prove that agents follow these explanations better.

The result is promising but mixed. Rule-specific reasons explain **why this action now** more clearly than generic eligibility text. Substantive explanations of **why the feature matters** still depend on the recorded impact rationale. Datalog cannot supply missing product judgment.

## Examples

For #26, the existing designer explanation was “Unclaimed design work; unlocks 0 otherwise-ready ticket(s) immediately.” The experimental short explanation is “A design contract is still missing. Impact M, complexity L.” Its optional detail includes the recorded benefit rationale about reducing manual polling through a verified Codex wake adapter. The short explanation is more specific about the missing action; the benefit rationale supplies the importance.

For #291, the experimental implementation reason is “Known easy win: impact L, complexity S.” For #293, the complexity-estimation reason is “High impact L, but effort is unassessed: estimate it to test whether this is a good-value implementation.” These distinguish delivering a known opportunity from gathering information about a promising one.

There is an important counterexample: #291's original guard already merged, leaving regression coverage. Its existing assessment still describes the original bug. Both evaluators can repeat that stale rationale. A precise rule explanation does not guarantee that its underlying assessment still describes the remaining scope.

Full explanations can be longer than the baseline. Prefer the short rule reason by default, with benefit detail available separately. This is qualitative inspection of a small sample, not a blinded comparison.

## Method and coverage

The maintained TypeScript runner is [run.ts](examples/datalog-local/run.ts). DataScript queries derive eligibility, candidate actions, priority bands, preferences and the selected explanation template from one rule catalog. TypeScript transacts query results, compares emitted sort keys and interpolates bindings. It does not invoke production action-selection or ordering functions.

Twelve synthetic checks cover easy wins, reciprocal assessment boosts, unfavorable work, incomplete blocker evidence, blocked-but-estimable tickets, claims, failed versus pending PR checks, addressed attention, duplicate-rule resolution, explanation bindings, platform matching and unknown assessments. The first query formulation produced missing eligibility results and duplicate explanations; explicit query phases corrected this, and the regression scenarios now pass. This is not evidence of a DataScript library defect.

The frozen snapshot contains 43 tickets, but only 32 have paired baseline subject records. The baseline supplies assessment facts and provenance references, not decisions or explanations. Missing paired assessment evidence remains unknown. Benefit text is retrieved from the exact referenced comment. The experiment does not independently revalidate author trust.

This subset omits urgency/direct-unlock tie policy, continuation of owned work, the full current-head review/responsibility model, configuration, MCP integration and installed-tool acceptance. The live snapshot does not replace synthetic PR scenarios. No mutation, default-setting change or model experiment was performed. Raw snapshots remain outside Git.

## Reproduce

Use the repository's installed development dependencies. Install the experimental engine outside the repository:

```sh
npm install --prefix /tmp/triage-datalog-engine --no-save datascript@1.8.1
npx tsx doc/reports/examples/datalog-local/run.ts \
  --engine-module /tmp/triage-datalog-engine/node_modules/datascript \
  --out /tmp/triage-datalog-result.json
```

This runs the synthetic checks without live GitHub access. The frozen comparison used the normal CLI cache and an offline designer briefing from that same cache. To collect a new equivalent pair (not recreate the historical snapshot), use the same source revision for both commands:

```sh
npm run --silent triage -- --repo OWNER/REPOSITORY \
  --cache /tmp/pdb-snapshot.json --json --no-update-check > /tmp/pdb-live-report.json
npm run --silent triage -- --repo OWNER/REPOSITORY \
  --offline --cache /tmp/pdb-snapshot.json --role designer \
  --agent YOUR_AGENT --platform codex --json --no-update-check > /tmp/pdb-baseline.json
npx tsx doc/reports/examples/datalog-local/run.ts \
  --engine-module /tmp/triage-datalog-engine/node_modules/datascript \
  --snapshot /tmp/pdb-snapshot.json --baseline /tmp/pdb-baseline.json \
  --agent YOUR_AGENT --platform codex \
  --out /tmp/pdb-comparison.json
```

Replace the repository and agent placeholders. Pass the same agent and platform to the baseline and trial; the trial records these explicit context values. Omit platform in both commands when the viewer platform is unknown. The historical snapshot used unknown platform; its result is a bounded observation, not a complete context/parity comparison. These collection commands read GitHub and save local files; the offline command does not fetch newer facts. A fresh collection will naturally differ from the historical 43-ticket input. The historical snapshot and baseline are intentionally not committed.

To evaluate an already frozen input, additionally pass `--snapshot PATH` and `--baseline PATH`, using the raw snapshot and its corresponding structured briefing. These must refer to the same collection; keep them unversioned. The engine path explicitly loads trusted local executable code.

## Recommendation

Proceed with the opt-in production evaluator in #303 and its integration/acceptance work. Preserve selected rule IDs and matched facts alongside concise explanations. Complete the missing policy coverage before claiming parity. Keep assessment freshness and remaining scope visible; do not describe this research runner as a shipped Datalog briefing feature.
