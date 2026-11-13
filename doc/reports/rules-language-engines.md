# Reusable rules engines for triage (#73)

Research completed 2026-11-13. No production code, package dependencies, configuration or live workflow changed. Sources/registry metadata were read on that date. This answers engine selection; #74 owns the isolated feasibility spike and #75 requires a later reviewed production contract.

## Recommendation

**Reuse a query engine plus a thin triage-specific rule layer for the spike, with DataScript as the leading candidate.** Compare it against the existing registered-JavaScript approach before choosing a production dependency. Do not write a new general Datalog compiler. A query evaluator alone does not supply must/may/must-not semantics, readable explanations, unknown-evidence handling, project overrides, safe ranking or conflict analysis.

DataScript actually executed the ready/incomplete/unclaimed/known-blockers example on Node 20. The measured cost is small at this scale. The larger question is whether EDN query strings plus a policy layer improve maintainability over explicit JS predicates. A zero-new-dependency evaluator remains a legitimate “simplify/reject the language” outcome.

## Candidates and maintenance evidence

Published-version dates are npm publication timestamps, **not proof that a project is actively maintained or abandoned**. Unpacked size excludes transitive dependencies, compression, compiled policies and bundle overhead. ESM usability below distinguishes an ESM application importing CommonJS from a native ESM package.

| Candidate    | Observed npm release                           | License / unpacked size / direct dependencies                                                                        | Plain JS and fit                                                                                                                                                                       |
| ------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DataScript   | 1.8.1, 2026-08-15                              | EPL per registry metadata; 469,919 bytes; zero runtime dependencies                                                  | JS artifact imported from ESM in the experiment; no compiler/runtime service needed by consumers. Leading lightweight Datalog query candidate.                                         |
| Datalogia    | 0.9.2, 2024-10-31                              | No license field or repository link in inspected registry/package metadata; 199,098 bytes; three direct dependencies | Native ESM import succeeds. Promising small query/rule API, but license/provenance/maintenance need resolving before adoption.                                                         |
| OPA Wasm SDK | @open-policy-agent/opa-wasm 1.10.0, 2024-11-08 | Apache-2.0; 972,961 bytes; two direct dependencies                                                                   | JS host runs compiled Rego Wasm; external OPA compilation step and policy artifact are additional costs. Mature policy ecosystem, larger operational fit than this narrow spike needs. |
| Cedar Wasm   | @cedar-policy/cedar-wasm 4.14.0, 2026-10-19    | Apache-2.0; 13,545,292 bytes; registry declares no direct dependencies                                               | Official Node-compatible entry point loads Wasm. Strong authorization model; a comparatively large artifact and an action-ranking/explanation layer are still required.                |

Primary registry records: [DataScript](https://registry.npmjs.org/datascript), [Datalogia](https://registry.npmjs.org/datalogia), [OPA SDK](https://registry.npmjs.org/@open-policy-agent%2Fopa-wasm), [Cedar](https://registry.npmjs.org/@cedar-policy%2Fcedar-wasm). Use pinned versions and inspect license files before any production distribution. DataScript’s EPL is not the same license as this MIT repository; preserve applicable notices and review distribution obligations rather than assume “zero dependencies” implies no licensing work.

## Capability comparison

**DataScript:** documented Datalog queries, reusable/recursive rules and aggregates; JS query/rule inputs are EDN strings. The experiment verifies bound negation and rejection of an unbound negative query, not a complete stratification/termination analysis. Return stable rule IDs and evidence bindings from our wrapper; the query result is not a built-in human proof tree. Sorting the selected actions can remain a deterministic policy step rather than inventing an order extension inside Datalog. [Primary README](https://github.com/tonsky/datascript), [JS usage](https://github.com/tonsky/datascript/wiki/Getting-started).

**Datalogia:** the published source exposes Rule, and/or/not clauses and variables. Import was tested, but recursive-negation safety, aggregation, deterministic ordering and complete provenance were not established by this research. Its shipped README example has undefined/typo variables, so it cannot be copied as a verified minimal example. Absence of a verified license/source lineage is a selection blocker, not a claim that no license exists anywhere. [Published package metadata/source entry](https://registry.npmjs.org/datalogia/0.9.2).

**OPA:** the official SDK loads precompiled Rego policies; the documented build uses OPA to produce a Wasm artifact. Rego has richer policy/collection facilities, but JS SDK execution does not by itself generate English, an obligations model or proof explanations. Compilation, supported built-ins, undefined results and explainability must be checked for the exact target. Do not bring a general policy deployment pipeline into the first POC merely because it can express more. [SDK and build example](https://github.com/open-policy-agent/npm-opa-wasm), [Wasm target](https://www.openpolicyagent.org/docs/wasm), [Rego language](https://www.openpolicyagent.org/docs/policy-language).

**Cedar:** permit/forbid with forbid precedence and determining policy diagnostics align with action eligibility. A “required next action” and total order are application-layer concepts, not simply permit/deny. Cedar deliberately skips policies that evaluate with an error; triage must inspect diagnostics and never turn missing prerequisite evidence into an actionable permission. The published package documents its Node-specific Wasm entry point. No Cedar performance claim was measured here. [Authorization algorithm](https://docs.cedarpolicy.com/auth/authorization.html), [official package README](https://www.npmjs.com/package/@cedar-policy/cedar-wasm).

None of the inspected candidates establishes every requested feature out of the box. In particular, must/may/must-not and their priorities, explainable grouping, static contradictory-policy detection, safe overrides and English generation remain part of the bounded triage layer. Unknown-evidence semantics must be explicit, regardless of engine.

## Working DataScript example

The repository contains an **isolated research example**, `doc/reports/examples/rules-engine-evaluation.mjs`; it is not imported by runtime code. Reproduce without adding project dependencies:

```sh
mkdir /tmp/triage-rule-example
cd /tmp/triage-rule-example
npm init -y
npm install --ignore-scripts datascript@1.8.1
# Copy doc/reports/examples/rules-engine-evaluation.mjs here from this repository.
node rules-engine-evaluation.mjs
```

Its essential query is:

```js
import ds from "datascript";
const db = ds.init_db([
  [1, "open", true],
  [1, "complete", true],
  [1, "status", "ready"],
  [2, "open", true],
  [2, "status", "ready"], // No completeness evidence.
]);
const eligible = ds.q(
  `[:find ?t :where
  [?t "open" true] [?t "complete" true]
  (or [?t "status" "ready"] [?t "status" "incomplete"])
  (not [?t "blocked" true]) (not [?t "claimed" true])
  (not [?t "restricted" true])]`,
  db,
);
// [[1]]; ticket 2 is not proven eligible.
```

Here complete is a deliberately explicit fixture fact. A production adapter must derive completeness separately for all prerequisite dimensions (blockers, claims, questions/platform), not set one optimistic boolean from a successful top-level HTTP response. Excluded-from-eligible is also not “forbidden”: classify unknown evidence as inspect/unknown in the wrapper. Closed-world negation is safe only within known-complete fact scopes.

The full example asserts six cases: ready, blocked, incomplete, unknown completeness, claimed and restricted; a reusable ready rule produces the same result. It also captures the evaluator’s diagnostic for an unsafe unbound negation. It does **not** implement the proposed language or prove general contradictory-rule detection.

## Measured evidence and limits

On macOS arm64, Node 20.20.2, DataScript 1.8.1: 500 synthetic tickets / 1,766 facts / 267 eligible; database construction 4.26 ms; 100 warm queries after ten warm-ups: median 1.15 ms, p95 1.83 ms. Node 26.7.0 also passed the smoke assertions. These are a local synthetic microbenchmark, not GitHub latency, a full language benchmark or an inter-engine performance comparison. Dependency-byte figures are unpacked package metadata, not memory/transfer measurements. Cold import, memory, Windows/Linux, bundler output and real-snapshot cost remain #74 measurements.

## Recommended next spike

1. Use the agreed dozen decision scenarios, including incomplete evidence, explicit attention, own PR follow-up, eligible incomplete work, platform restrictions and impact versus explicit age modes.
2. Represent rules as small data records with stable id, factual conditions, action type and explanation template. Compile that same record to evaluator inputs and English; do not maintain independent authoritative prose.
3. Implement only a few must/may/must-not actions and one ordering policy. Reject user-supplied functions and unrestricted query predicates. Extract evidence with each derivation; handle unknown separately.
4. Compare DataScript-backed evaluation with straightforward registered JS over the **same** fixtures. The candidate needs to justify added syntax, licensing and packaging overhead.
5. Deliberately conflicting rule fixtures must produce an explicit conflict/diagnostic or documented unsupported result, not a silent invented winner. General satisfiability is not promised.
6. Apply the owner’s five criteria: correctness, common-source explanations, easy changes, practical cost and better maintenance. Recommend adopt, simplify or reject before #75. Agent rules-versus-reasons adherence is separate #78, not inferred from engine correctness.
