# Repository-relative complexity using labels

## Why and scope

Owner decision: complexity is stored only in repository issue labels. This avoids account-wide native-field setup and field-specific authorization. No one uses the earlier field backend: remove it without migration, dual-backend configuration or compatibility machinery. Complexity remains enabled by default, with an explicit repository opt-out. This contract supersedes field-storage/setup requirements in the earlier complexity tickets and PR #114; it does not claim the replacement implementation is shipped yet.

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

## Label representation and collection

Recognized sizes are `complexity:XS`, `complexity:S`, `complexity:M`, `complexity:L`, `complexity:XL`, `complexity:XXL`. Create canonical uppercase suffixes and compare existing names case-insensitively, matching GitHub label identity. Use a shared registered classifier in estimation, briefings and Ticket Doctor, not copied per-command logic. Only these six size labels are managed; unrelated labels remain untouched.

With complete label evidence: no recognized size is unestimated, one is estimated, and more than one is a conflict requiring inspection. Incomplete or inaccessible labels mean unknown, never unestimated. A conflict is not resolved by choosing the largest, smallest or newest label. Ordinary read-only commands never create labels or change ticket state. Native issue fields and provenance comments are not competing authorities for current size; the recognized label set is authoritative. The provenance can be stale when a manual label change disagrees with it.

## Recording and revising an estimate

Keep the explicit `estimate N --size SIZE --rationale TEXT [--assumption TEXT]...` operation. Require a justification for the newly assigned size. An agent may disagree with another estimate and replace it; it need not explain or defend the prior agent's reasoning. Do not require a separate change-reason argument or mandatory agreement from the previous estimator. If an optional expected-old-value guard is retained, it is an explicit caller choice, never required merely because a prior estimate exists.

The operation reads fresh repository/ticket labels, ensures the requested repository label exists, applies it and removes other recognized complexity size labels from that ticket. Create only the requested missing label during this explicit write; no separate setup or complete pre-created label set is required. Reuse existing definitions without silently changing their colors/descriptions. An already-exists race is handled by fresh verification. Preserve all unrelated labels and never replace the complete label collection from a stale snapshot.

Explicit recording may replace a conflicting set: history records all observed previous sizes, the assigned size, rationale, assumptions, available estimator attribution, guidance version, repository revision and timestamp. No responsibility for another agent's earlier judgment is implied. Read-only conflict detection itself never repairs anything. Use the established provenance-comment mechanism with an intentionally versioned label-backed record, not field IDs. Identical retries return the existing stored provenance; same-size updates with a materially different rationale can record a new assessment.

Label creation, label changes and the comment can be separate remote operations. Report partial completion precisely, verify the resulting label set and avoid destructive rollback. A concurrent contradictory size or unreadable final state is conflict/unknown, not successful completion; do not promise an atomic GitHub transaction or absolute compare-and-swap guarantee. Retries re-read facts and avoid duplicate comments where recorded evidence establishes the same completed operation. Never acquire a claim, clear blockers, change readiness or reserve future implementation as a side effect.

## Permissions and diagnostics

Reuse the authenticated GitHub boundary. Applying labels and creating a missing repository label still require the appropriate GitHub permissions. Report denied/unknown access with the requested operation and useful recovery; no account-level native-field permissions or automatic credential refresh is required. Missing size-label definitions are normal until the first explicit estimate, not a repository setup defect.

Keep general local Doctor diagnostics for runtime, authentication and checkout, and keep the unresolved local-identity reconciliation (#64) independent. Remove the complexity field/mapping/creation-permission Doctor work (#150). Ticket Doctor may report conflicting recognized size labels and incomplete label evidence through the shared classifier, without repairing them or making unestimated tickets errors. (#178) Ticket Doctor also reports `complexity-label-invalid` for any `complexity:*` label outside XS–XXL (case-insensitive) as a judgment plan. A registered suggestion table maps common suffixes (for example `huge`→XL) to a suggested size, labelled as a suggestion and never applied; unmapped suffixes ask for a size, and truncated labels make the finding unknown and inspection-only. The suggested fix is `estimate N --size <SIZE> --rationale <RATIONALE> --replace-invalid --repo owner/name`: the explicit flag removes the invalid labels while recording the chosen size, with the usual re-read, unknown-on-truncation and partial-failure safeguards, and the provenance lists the invalid labels it observed and replaced. Without the flag, estimate refuses and names it.

## Estimation as implementer work

Keep separate eligibility for implementation and estimation. Open native blockers prevent implementation pickup but do not by themselves prevent sizing. Estimate the full deliverable conditionally on stated prerequisites, excluding waiting. Materially unknown scope is reported as alternatives or unknown rather than a fabricated size.

Preserve the optional queue and `--estimate` view. With complexity enabled, it contains known-unestimated and meaningfully stale assessments; include blocked tickets while preserving their implementation-ineligible status. Explain conflicts as inspection candidates, distinct from ordinary unestimated work. Disabled complexity suppresses the queue without deleting labels or history. Read sizes from the ordinary collected labels: no extra native-field queries, field mapping, owner-wide discovery or account setup.

Default work selection keeps addressed attention, actionable PR follow-up, current contributions and eligible implementation ahead of optional estimation. The queue/record operation acquires no claim. This change does not add size-weighted pickup scores, mandatory estimates, automatic splitting or designer escalation. Explicit oldest/newest ordering retains its existing semantics and all relevant metadata stays visible within output budgets.

## Help, configuration and output

Keep one versioned XS–XXL guidance definition shared by CLI and MCP surfaces; update its storage/prerequisite text to labels. Preserve `complexity.enabled`; remove `complexity.fieldId` and native-field setup options/routes from the registered configuration/command surface. No backend selector or field conversion is introduced. Old unused keys are unsupported configuration with a clear command-mediated correction if encountered, not an automatic migration project. Review schema versions when removing public field-backed properties: introduce the appropriate new version for breaking shapes rather than silently change an existing schema. CLI/MCP share evidence and semantics; do not advertise unimplemented mutation tools.

Read-only output distinguishes estimated/unestimated/stale/conflicting/unknown as applicable, with complete label evidence and omission notices. Refresh README, usage, command help, error recovery, installed archive smoke and fixtures alongside their behavior slices. No field-specific scopes, setup command or retired integration is a user prerequisite.

## Focused delivery and future work

The shared label classifier/read-side slice (#151) can be implemented and tested independently, but it must not activate label-backed queue/briefing reads while the writer still uses fields. Keep the existing read route until #152 switches both production reads and writes to labels together, consuming the prepared classifier/reader. Do not introduce a user-visible backend selector, dual active authority or migration. Remove obsolete field modules, configuration and help only after both read/write replacements are delivered, so intermediate main remains buildable. Each ticket has its own Why, acceptance and native implementation dependencies. This documentation must merge before behavior changes.

Historical recalibration (#123) stays deferred until labels and estimates provide sufficient repository-specific examples. Guidance defaults work without historical benchmarks. Closed field-era tickets remain delivery history and are superseded by the replacement tickets; no issue is reopened merely to erase completed work. No field migration or compatibility backend is in scope.

## Replacement delivery tracking

- #151: shared label classification and queue/briefing reads.
- #152: explicit label-backed recording and current-size justification.
- #153: remove retired field modules, settings, diagnostics and help after the read/write replacements.
- #154: independent scenario-based rule plausibility suite.

Field-era work remains closed history; #150 is retired rather than implemented. General Doctor cleanup #64 remains separate.

Delivered by #153: the `setup complexity` command, native field discovery/classification, the field-backed estimation input and v1 provenance parser, and the field-era Ticket Doctor configuration checks are deleted. `complexity.fieldId` is no longer a registered key. A stored value is ignored rather than refused, reported as a `config-retired-key` finding in the estimation report and as `retired` in `config list`, and dropped by the next `config set`, which is the command-mediated correction. Configuration schema version 1 is unchanged and no migration is registered. The briefing estimation object drops its always-null `fieldId` and the field-only statuses (`setup-required`, `missing`, `incompatible`, `inaccessible`, `unsupported`).
