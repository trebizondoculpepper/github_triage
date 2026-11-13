# Repository-relative complexity, risk and useful work

Design discussion and delivery proposal. The owner agreed to T-shirt complexity sizes, a simple Low/Medium/High risk scale, native GitHub storage and bundled help guidance. Estimation is optional preparation, including for blocked tickets. Designer escalation, automatic splitting and new ranking weights are not decided here. No fields, labels or runtime features are created by this document.

## Default complexity guidance

Use XS, S, M, L, XL and XXL as ordered categories, not hours or arithmetic ratios. A repository owns its calibration: the same M need not mean the same scope in another repository. Estimate the complete deliverable, including integration, tests and necessary documentation, assuming stated prerequisites are satisfied. Exclude time waiting for those prerequisites.

| Size | Initial structural guidance                                                               | Illustrative anchor from this repository    |
| ---- | ----------------------------------------------------------------------------------------- | ------------------------------------------- |
| XS   | Small presentation/constant change; no new behavior, interface or I/O                     | PR #56: installed-command help wording      |
| S    | One bounded behavior in one implementation module using existing contracts                | PR #15: symlinked executable entry guard    |
| M    | A contained capability across a few modules with bounded integration/testing              | PR #86: update checking and CLI integration |
| L    | Significant lifecycle/integration change with interacting failure paths                   | PR #77: claims and question routing         |
| XL   | Systematic change across many modules or the toolchain                                    | PR #103: strict TypeScript migration        |
| XXL  | System-wide change affecting several foundational contracts with substantial consequences | No calibrated historical anchor yet         |

These are proposed retrospective anchors, not measured effort or elapsed-time facts. Module/line counts are clues, not the decision rule: #77 touched few implementation modules but had ownership races and recovery behavior; tests/docs do not inflate size just because they add files. Compare behavioral scope, module reach, changed contracts, external interactions and validation complexity. Choose the highest clearly triggered band and explain departures from nearby anchors. Missing information is not automatically XXL.

Store stable reference tickets and a guidance version in repository-specific calibration. Initially use this bundled structural rubric when a repository lacks anchors, stating that local calibration is incomplete. Do not hard-code this repository's ticket numbers into implementation rules or use its anchors as another repository's benchmarks. Review calibration against actual delivered scope and surprises, not waiting time, review count or an agent's personal speed. Scope changes can justify re-estimation; unchanged commits do not require repeated estimates.

## Simple risk guidance

Use exactly three assessed values:

| Risk   | Initial guidance                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Low    | Presentation-only change with no credential, authentication or security-boundary effect                                                    |
| Medium | Ordinary functional/integration behavior with failure consequences, without the High criteria below                                        |
| High   | Direct interaction with credentials, authentication services or security-sensitive behavior where an error could introduce a vulnerability |

Assess the changed behavior and boundary, not just the presence of an existing authenticated client. A very small authentication edit can still be High risk. A broad behavior-preserving migration can be XL without being High under this security-focused rubric. Low is not a claim that mistakes are impossible. Record a concise reason and uncertainty; if not assessed, leave the field unset rather than defaulting to Medium or Low. Further risk-policy expansion is a separate decision.

## Native storage and repository meaning

Use native GitHub fields, never size/risk labels as a silent fallback. Proposed field names are Complexity (single-select, XS through XXL) and Risk (single-select, Low/Medium/High). GitHub's [issue-field documentation](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/managing-issue-fields) describes customizable single-select fields for user/organization-owned repositories. Definitions live at the account/organization level; the repository profile supplies calibration and field-ID mapping. Shared vocabulary does not imply cross-repository size equivalence. A GitHub Project board is not required for the repository-relative concept.

Select field IDs explicitly, confirm options/visibility/read-write API support, and report unsupported or inaccessible configuration clearly. Do not automatically alter account-wide options or private/public visibility. No Project-field copy or label duplicate becomes a competing source of truth. The bounded native-field discovery/setup slice must establish actual API capability before implementation promises a write path.

Record rationale, assumptions, evidence/reference tickets, estimator identity when available, repository revision and guidance version alongside the native values through an explicit, documented provenance mechanism. Preserve other agents' estimates; a stale read must not silently overwrite a newer result. Size and risk updates are distinct remote steps unless the verified API provides a transaction; expose partial results honestly. Missing identity does not authorize inventing a name or changing local identity files.

## Estimation as implementer work

Keep separate eligibility for implementation and estimation. Native blockers prevent implementation pickup but do not, by themselves, prevent sizing. Estimate conditionally: “M if blocker B supplies the documented API; waiting excluded.” If the unresolved choice changes scope materially, report alternatives or inability to size confidently. Do not clear blockers, claim readiness, reserve implementation or split tickets merely by recording an estimate.

Normal work selection advances attention/PR follow-up, active contributions and eligible implementation first; estimation/refinement is useful when there is no higher-value work available, or on explicit request. The estimation queue includes unestimated and meaningfully stale estimates, including blocked tickets. It must not inherit the implementation-ready-only filter. Claim/concurrency semantics for the estimate operation need a focused workflow contract; do not silently acquire a second active contribution.

## Help and MCP guidance

Bundle the initial complexity and risk rubric with the estimation capability. Estimation --help and the equivalent MCP-discoverable help/guidance surface expose the same defaults, examples, meaning of blocked-ticket assumptions and native-field prerequisites. A short tool description points to full local guidance without a general documentation search. Never present proposed commands as installed or misuse stderr/text on MCP protocol stdout.

Use one versioned guidance definition shared by the renderers; do not maintain separate CLI/MCP prose. Rules-system overrides are a future extension: no custom rule language, per-repository executable policy or mandatory designer escalation is required for the initial capability. Repository reference anchors can vary while the initial structural default remains discoverable.

## Unlocking utility and easy wins: proposal

Keep three distinct inputs: estimated complexity, assessed risk and measured immediate-unlock utility. Utility reuses doc/design/briefings.md: count distinct otherwise-ready dependants for which this ticket is the last open native blocker; missing evidence does not count as confirmed benefit. Blocked tickets can have estimates, but cannot enter eligible implementation pickup merely because their apparent utility is high.

First display the three factors and evidence without changing default ordering. A subsequent optional easy-wins view can highlight eligible low-risk XS/S work with positive immediate unlocks, sorting by utility and then smaller size. Unassessed risk/size is not implicitly favorable. A more general compound score remains a proposal: coefficients are policy choices, not measured effort ratios, and all inputs/reasons must stay visible. Do not adopt arbitrary numeric T-shirt multipliers as if M were objectively twice S.

Any agreed ranking extension stays inside general pickup and existing urgency bands. Addressed attention, PR follow-up and active work retain their lifecycle priority. Explicit oldest/newest ordering excludes these new weights while keeping metadata visible. Do not build designer escalation or automatic splitting in this slice.

## Proposed focused delivery tickets

1. **Default guidance and help:** finalize/bundle one versioned complexity/risk rubric and repository calibration structure; expose equivalent CLI/MCP guidance. No remote writes or ranking changes.
2. **Native-field discovery and configuration:** verify API read/write behavior, resolve field IDs/options/visibility for a repository, and return actionable setup diagnostics. No automatic account-wide field mutation or label fallback.
3. **Record an estimate:** validate native values; save complexity/risk plus explicit rationale/assumptions/provenance; handle partial writes and concurrent estimates. No readiness/claim changes as a side effect.
4. **Estimation queue:** surface unsized/stale tickets, including blocked work, as a distinct implementer activity; clarify one-active-contribution handling. No compulsory estimate gate on implementation.
5. **Briefing visibility:** show complexity, risk, utility and unknowns compactly, reusing current eligibility and utility evidence. No score or default order change.
6. **Optional easy-wins ordering:** independently review the transparent candidate band/score and safeguards after the data is available. No dependency on finishing the general rules engine.

These are proposed slices, not filed implementation tickets or claims of readiness. Pitch/approve them individually before delivery. The owner deliberately deferred designer rules; do not turn these estimates into an unagreed escalation gate.
