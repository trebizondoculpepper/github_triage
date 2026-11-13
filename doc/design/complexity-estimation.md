# Repository-relative complexity: initial guidance and rollout

Owner-approved architecture, merged in PR #114. Focused implementation tickets are design-ready; native blockers and current ownership still govern pickup. The first delivery is complexity only: optional T-shirt estimation using bundled guidance, native GitHub storage and CLI/MCP help. Repository-history recalibration is also deferred until estimates exist. Designer escalation, automatic splitting and new ranking weights are not decided here. No fields, labels or runtime features are created by this document.

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

Store stable reference tickets and a guidance version in repository-specific calibration. Initially use this bundled structural rubric when a repository lacks anchors, stating that local calibration is incomplete. Do not hard-code this repository's ticket numbers into implementation rules or use its anchors as another repository's benchmarks. A later maintenance feature can review calibration against actual delivered scope and surprises, not waiting time, review count or an agent's personal speed. Initial delivery does not require historical estimates, repository anchors or that maintenance feature. Scope changes can justify re-estimation; unchanged commits do not require repeated estimates.

## Repository setup and configuration diagnostics

Use [repository configuration](repository-configuration.md), mediated by `config get/set/list/help`; agents do not edit the configuration file. Complexity defaults to enabled. Disabling it is an explicit repository opt-out and suppresses its estimation queue and field diagnostics, without deleting stored estimates or mappings.

Setup first reads the effective enablement state. When enabled, discover compatible fields and prompt the operator to reuse/select or create one; explain its actual ownership and visibility before a shared change. Never silently create a field just because the default is enabled. Unattended execution must supply an explicit selection/creation decision, or return an actionable setup-required result without hanging. Persist the selected field through the same configuration service after verifying compatibility. A failed local save after remote creation reports the created identifier and recovery rather than claiming complete setup or duplicating it on retry.

Read-only Ticket Doctor reports missing mapping, inaccessible/deleted field, incompatible type/options or unsupported native API capability when enabled. Show evidence, distinguish unavailable from absent, and provide implemented setup/config recovery syntax. Local doctor may reuse the validator but does not create a second owner for configuration rules. Unestimated tickets are normal queue candidates, not configuration errors. Missing mapping does not disable other triage capabilities.

GitHub currently documents issue-field definitions at user/organization scope, not repository-owned definitions. Setup offers only verified supported scopes: repository settings and calibration remain repository-specific, and the prompt must explain any owner-wide effect. If repository-owned fields are unavailable, say so; do not silently substitute labels or a Project field.

## Native storage and repository meaning

Use native GitHub fields, never size labels as a silent fallback. The initial field is Complexity (single-select, XS through XXL). GitHub's [issue-field documentation](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/managing-issue-fields) describes customizable single-select fields for user/organization-owned repositories. Definitions live at the account/organization level; the repository profile supplies calibration and field-ID mapping. Shared vocabulary does not imply cross-repository size equivalence. A GitHub Project board is not required for the repository-relative concept.

Select field IDs explicitly, confirm options/visibility/read-write API support, and report unsupported or inaccessible configuration clearly. Do not automatically alter account-wide options or private/public visibility. No Project-field copy or label duplicate becomes a competing source of truth. The bounded native-field discovery/setup slice must establish actual API capability before implementation promises a write path.

Record rationale, assumptions, evidence/reference tickets, estimator identity when available, repository revision and guidance version alongside the native values through an explicit, documented provenance mechanism. Preserve other agents' estimates; a stale read must not silently overwrite a newer result. Expose partial results honestly if recording the native complexity value and its provenance requires multiple remote steps. Missing identity does not authorize inventing a name or changing local identity files.

## Estimation as implementer work

Keep separate eligibility for implementation and estimation. Native blockers prevent implementation pickup but do not, by themselves, prevent sizing. Estimate conditionally: “M if blocker B supplies the documented API; waiting excluded.” If the unresolved choice changes scope materially, report alternatives or inability to size confidently. Do not clear blockers, claim readiness, reserve implementation or split tickets merely by recording an estimate.

Normal work selection advances attention/PR follow-up, active contributions and eligible implementation first; estimation/refinement is useful when there is no higher-value work available, or on explicit request. The estimation queue includes unestimated and meaningfully stale estimates, including blocked tickets. It must not inherit the implementation-ready-only filter. Claim/concurrency semantics for the estimate operation need a focused workflow contract; do not silently acquire a second active contribution.

## Help and MCP guidance

Bundle the initial complexity rubric with the estimation capability. Estimation --help and the equivalent MCP-discoverable help/guidance surface expose the same defaults, examples, meaning of blocked-ticket assumptions and native-field prerequisites. A short tool description points to full local guidance without a general documentation search. Never present proposed commands as installed or misuse stderr/text on MCP protocol stdout.

Use one versioned guidance definition shared by the renderers; do not maintain separate CLI/MCP prose. Rules-system overrides are a future extension: no custom rule language, per-repository executable policy or mandatory designer escalation is required for the initial capability. Repository reference anchors can vary while the initial structural default remains discoverable.

## Focused delivery slices

The repository configuration epic supplies the typed/migratable storage service and `config get/set/list/help`. Complexity delivery then comprises bundled sizing/help guidance, native-field discovery and prompted setup, Ticket Doctor configuration checks, recording estimates, and an optional estimation queue with compact visibility. Each slice has its own justification, acceptance and dependency links; reviewed architecture must land before behavior changes.

Repository recalibration is separately deferred until estimates exist. It can compare estimated and delivered scope within a repository and propose revised guidance/benchmarks for review, without silently rewriting historical estimates. Designer escalation, automatic splitting and new ranking weights are not part of these slices.

## Delivery tracking

- [115](https://github.com/trebizondoculpepper/github_triage/issues/115) — Epic: repository configuration mediated by the triage tool
- [116](https://github.com/trebizondoculpepper/github_triage/issues/116) — Repository configuration: typed storage, defaults and schema migrations
- [117](https://github.com/trebizondoculpepper/github_triage/issues/117) — Repository configuration: config get, set, list and help
- [118](https://github.com/trebizondoculpepper/github_triage/issues/118) — Complexity estimation: bundle XS–XXL guidance and expose it through help
- [119](https://github.com/trebizondoculpepper/github_triage/issues/119) — Complexity setup: discover a native field and prompt before configuring it
- [120](https://github.com/trebizondoculpepper/github_triage/issues/120) — Ticket Doctor: diagnose repository complexity configuration
- [121](https://github.com/trebizondoculpepper/github_triage/issues/121) — Complexity estimation: record a size with rationale and assumptions
- [122](https://github.com/trebizondoculpepper/github_triage/issues/122) — Complexity estimation: optional implementer queue and briefing visibility
- [123](https://github.com/trebizondoculpepper/github_triage/issues/123) — Deferred: recalibrate repository complexity guidance from recorded estimates
