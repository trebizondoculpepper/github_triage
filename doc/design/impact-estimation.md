# Designer impact estimation: interface contract

Analysis and contract for #244. It turns the owner-approved direction in [impact-estimation-direction.md](impact-estimation-direction.md) (PR #251) into the interfaces that #245–#248 implement, aligned with the blended queue policy in [blended-action-queues.md](blended-action-queues.md) (PR #261, #258). It describes proposed behavior; nothing here is shipped by this document. The rule throughout is to mirror the complexity mechanics in [complexity-estimation.md](complexity-estimation.md) and `src/estimation/complexity.ts`, `src/estimation/complexitylabels.ts`, `src/estimation/estimate.ts`, `src/estimation/estimation.ts`, not to build a second system.

## Contents

1. [Reuse audit](#reuse-audit)
2. [Terminology: three different things](#terminology-three-different-things)
3. [Impact guidance (rubric)](#impact-guidance-rubric)
4. [Labels](#labels)
5. [Recording and revising](#recording-and-revising)
6. [Provenance record and versioning](#provenance-record-and-versioning)
7. [Who records, and authority](#who-records-and-authority)
8. [Reading: states, staleness and unknowns](#reading-states-staleness-and-unknowns)
9. [Invalid labels and Ticket Doctor](#invalid-labels-and-ticket-doctor)
10. [Configuration](#configuration)
11. [The unassessed-work queue](#the-unassessed-work-queue)
12. [Side-by-side display](#side-by-side-display)
13. [Easy-win heuristic placement](#easy-win-heuristic-placement)
14. [Acceptance scenarios](#acceptance-scenarios)
15. [Delivery scope per ticket](#delivery-scope-per-ticket)

## Reuse audit

Every complexity mechanism has an impact counterpart. The implementation generalises the existing modules over a small registered metric descriptor rather than copying them. The descriptor is data, not a framework: `{metric: "complexity" | "impact", labelPrefix, labelColor, marker, provenanceKind, provenanceSchemaVersion, guidance, enabledKey, invalidFindingKinds, suggestionTable}`. Exactly two descriptors are registered; no third metric, risk score or generic assessment engine is in scope.

| Complexity mechanism (today)                                                             | Impact counterpart                                                                  | Reuse                                                    |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `COMPLEXITY_SIZES`, `complexityGuidance` (`src/estimation/complexity.ts`)                | Same six sizes; separate `impactGuidance` definition with its own `guidanceVersion` | Share the size list and the renderer; new guidance data  |
| `complexityLabelName`, `complexityLabelSize`, `isComplexityLabel`                        | Same functions over prefix `impact:`                                                | Parameterise by descriptor                               |
| `classifyComplexityLabels`, `labelSizeReading` (`src/estimation/complexitylabels.ts`)    | Same classification over the impact prefix                                          | Parameterise by descriptor                               |
| `INVALID_SIZE_SUGGESTIONS`, `suggestedSize`                                              | Same shared table plus impact-only extras (below)                                   | Shared table, descriptor adds extras                     |
| `LabelDoctorFinding` kinds `complexity-label-*`                                          | `impact-label-conflict`, `impact-label-invalid`, `impact-labels-incomplete`         | Same finding builder, kind from descriptor               |
| `runEstimate`: fresh re-read, create missing label only, add/remove individually, verify | Same operation with `--metric impact`                                               | Same function, descriptor selects prefix/marker/guidance |
| `--replace SIZE` optional guard, `--replace-invalid`                                     | Identical flags and semantics                                                       | Unchanged                                                |
| v2 provenance comment (`github-triage:complexity-estimate v2`)                           | `github-triage:impact-estimate v1`                                                  | Same writer/parser shape, separate marker                |
| Idempotent retry, partial-write reporting, no rollback                                   | Identical                                                                           | Unchanged                                                |
| `sizeReport` staleness and queue (`src/estimation/estimation.ts`)                        | Same staleness tests against impact provenance and guidance version                 | Parameterise by descriptor                               |
| `complexity.enabled` (`src/config/config.ts`)                                            | `impact.enabled`                                                                    | Same registered-key mechanism                            |
| CLI/MCP help from one guidance definition                                                | Same renderer, second definition                                                    | Unchanged pattern                                        |

Not reused: `immediateUnlocks`, `UnlockImpact`, `compareImpact` and `--order impact` in `src/ranking.ts`. Those compute dependency-unlock utility, which is a different fact (next section).

## Terminology: three different things

The word "impact" already exists in the code and help with a different meaning. This contract fixes the vocabulary so implementers do not merge the concepts.

- **Impact estimate** (this contract): a designer's judged benefit category, `impact:XS`..`impact:XXL`. Stored in labels. Ordinal. May include meaningful downstream benefit as a judgment.
- **Complexity estimate**: an implementer's judged effort category, `complexity:XS`..`complexity:XXL`. Unchanged.
- **Unlock utility**: the computed, proven lower bound of immediate dependants that become otherwise eligible (`immediateUnlocks`, JSON `unlocks` / `unlocksUnknown`). Evidence, not an estimate, never summed transitively.

The existing `--order impact` value and the internal `UnlockImpact`/`impactText` names keep working for compatibility; no CLI value is renamed. User-facing text written by #247 says "unlocks at least N" for unlock utility and "impact L" only for the label-backed estimate. New JSON uses `impact` only for the estimate (as `rankedActions` already specifies) and `unlocks` for utility. Renaming internal identifiers is optional cleanup inside #247, never a breaking change to `--order impact`.

## Impact guidance (rubric)

One bundled, versioned definition `impactGuidance` (`guidanceVersion: 1`), shape identical to `ComplexityGuidance` so the same renderer serves CLI help, JSON and MCP. Repository-relative calibration, ordinal categories, no hours or ratios. Estimate the benefit of the completed outcome assuming stated prerequisites are delivered, including meaningful downstream value it enables, as a judgment. Do not count dependants, add their labels or copy the unlock count. Missing information is not XS and not M.

| Size | Structural guidance                                                                                            |
| ---- | -------------------------------------------------------------------------------------------------------------- |
| XS   | Cosmetic or wording improvement; no user or contributor would change how they work                             |
| S    | Removes a minor friction or edge case for some users; local benefit                                            |
| M    | Noticeably improves one common workflow, or unblocks a contained capability                                    |
| L    | Materially improves a core workflow for most users, or enables a planned capability others depend on           |
| XL   | Changes what the product can do for its main audience, or is the prerequisite for a major line of planned work |
| XXL  | Foundational: the project's direction or several major capabilities depend on it                               |

Dimensions to consider: reach (who benefits), frequency (how often), depth (how much better per use), enablement (planned work this makes possible) and risk reduced for users or contributors. Choose the highest clearly triggered band and explain it. Repository anchors are optional calibration data, as for complexity; the bundled guidance names no ticket numbers. Bump `guidanceVersion` on any semantic change; an older recorded version makes the estimate stale.

## Labels

Recognized labels: `impact:XS`, `impact:S`, `impact:M`, `impact:L`, `impact:XL`, `impact:XXL`. Canonical spelling is a lowercase prefix and uppercase suffix; existing names compare case-insensitively, matching GitHub label identity. Only these six are managed. Complexity labels and unrelated labels are never touched by an impact write, and impact labels are never touched by a complexity write (cross-metric isolation). New label colour: a fixed constant distinct from `COMPLEXITY_LABEL_COLOR`; existing definitions are reused unchanged. No native GitHub fields, no setup command and no pre-created label set: a missing `impact:*` definition is normal until the first explicit record.

## Recording and revising

One command, extended rather than duplicated:

```
pdb estimate N --metric impact --size SIZE --rationale TEXT [--assumption TEXT]...
         [--reference REF]... [--agent NAME] [--replace SIZE] [--replace-invalid] [--json]
```

`--metric` accepts `complexity` (default, so every existing invocation is unchanged) or `impact`. The MCP surface, when it gains mutation, uses the same argument; no mutation tool is advertised before it exists. The JSON result keeps `kind` per metric: `complexity-estimate` (unchanged) or `impact-estimate`.

The behavior is the complexity contract verbatim, applied to the impact prefix:

- Read fresh repository and ticket labels immediately before writing. Truncated labels refuse as unknown.
- Create only the requested missing `impact:SIZE` label; reuse existing definitions; resolve an already-exists race by re-verification.
- Add the requested label and remove other recognized impact labels individually; never replace the label collection from a snapshot.
- Require a rationale for the assigned size only. Disagreement alone permits replacement; no change reason, no defence of the previous assessor's reasoning, no consent from them. `--replace OLD` is an optional caller guard.
- Without `--replace-invalid`, refuse when invalid `impact:*` labels are present and name the flag. With it, remove them while recording, and list them in provenance.
- Verify the final label set. A concurrent contradictory size or unreadable result is conflict/unknown, not success.
- Label creation, label changes and the comment are separate operations: report applied/skipped/failed precisely, never roll back, and let an identical retry complete without duplicating the comment.
- Never claim, release, unblock, change readiness, change role labels or dependencies, split or re-rank. Assessing a blocked ticket is allowed; it stays implementation-ineligible.

## Provenance record and versioning

Marker `<!-- github-triage:impact-estimate v1 {json} -->`, encoded with the existing comment-safe JSON escaping. The payload mirrors complexity v2 field-for-field so one parser shape serves both:

```json
{
  "schemaVersion": 1,
  "kind": "impact-estimate",
  "storage": "labels",
  "size": "L",
  "previous": ["S"],
  "rationale": "…",
  "assumptions": [],
  "references": [],
  "estimator": "reported agent name or null",
  "revision": "git HEAD or null",
  "guidanceVersion": 1,
  "recordedAt": "2026-11-14T00:00:00.000Z",
  "replacedInvalid": ["impact:high"]
}
```

`replacedInvalid` is present only when `--replace-invalid` removed labels. The human-readable body says "Impact estimate: L (was S)" and ends with "The label impact:L is the current benefit estimate; this comment records why. Estimating does not claim, unblock or re-rank this ticket." Versioning: `schemaVersion` and the marker version change together on any incompatible payload change; the parser accepts only known versions and ignores malformed payloads, never trusting them. A complexity parser never accepts an impact marker and vice versa. Identical retry detection compares size, rationale, estimator, assumptions and references, as for complexity (`isThisAssessment` in src/estimation/estimate.ts). Replaced labels are not part of identity: a successful write removes them, so a retry cannot observe them. Unlike complexity, an impact record counts as identical only when it is also not `stale`: its `guidanceVersion` equals the current guidance version and no description edit is later than its `recordedAt`. Otherwise an identical re-record writes a new provenance comment with a fresh `recordedAt`, which clears the stale state; the assessor need not change the rationale. A retry after such a re-record sees the fresh record and is unchanged, so no comment is duplicated. The label is authoritative for the current size; provenance can be stale and is evidence of why, not a competing authority.

## Who records, and authority

The designer role is workflow responsibility, not authority. Role selects which queue offers the assessment; it does not gate the command. Any caller may run `estimate --metric impact`, exactly as any caller may record complexity today. `--agent` is a reported name, recorded as `estimator`, never authenticated and never inferred from the GitHub login; absent means null.

Write authority is GitHub's: adding/removing labels and creating a missing label require the caller's existing repository permissions. Denied or unknown permission is reported with the attempted operation and recovery, through the existing authenticated `gh` boundary. No new credentials, scopes or permission service.

Provenance read authority follows the #215 rule (#212 through `TrustDecision`, as in [delivery-lifecycle.md](delivery-lifecycle.md)). Because provenance influences what the queue offers (staleness), the impact reader counts a provenance comment as "recorded" only when its author and, if the comment was edited, its last editor are each a `User` with current write, maintain or admin permission, as `commentAuthority` in src/workflow/claims.ts already decides for claim markers. A record from an untrusted author or editor (bot, app, read-only user) stays visible as evidence but is treated as no recorded rationale. A record whose author or editor permission is unknown, or that was edited by someone who cannot be established, makes the assessment state unknown, never current. The label itself needs no trust check: label writes already require repository write permission. #245 applies this through the injected `TrustDecision` and the per-run permission cache; it reuses the existing collection, adding no per-comment queries beyond that cache. Applying the same trust check to complexity provenance is a separate parity question, not part of this contract.

## Reading: states, staleness and unknowns

The shared reader returns, per ticket and per metric, one paired state, which is exactly the `rankedActions` vocabulary from blended-action-queues.md. This vocabulary applies only inside new properties (`assessments` on report subjects, and `rankedActions` items); it never replaces the existing `EstimateState` values (`estimated`, `unestimated`, `stale`, `conflicting`, `unknown`) carried by `complexity.state` and the estimation report (see [Side-by-side display](#side-by-side-display) for the mapping):

| State        | Condition (complete label evidence unless stated)                                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `current`    | Exactly one recognized label, trusted provenance agrees on size and guidance version, no later edit                          |
| `stale`      | One recognized label, but recorded size differs, guidance version is older, or the description was edited after `recordedAt` |
| `unassessed` | No recognized and no invalid label                                                                                           |
| `conflict`   | Two or more recognized labels                                                                                                |
| `invalid`    | At least one `impact:*` label with an unrecognized suffix (takes precedence over `conflict`)                                 |
| `unknown`    | Labels truncated, comment history incomplete, or provenance author/editor permission unknown                                 |
| `disabled`   | `impact.enabled` is false                                                                                                    |

A label with no pdb provenance (set by hand) is `current` with the reason "no recorded rationale", matching complexity today. `size` is non-null only for `current` and `stale`. The existing classifier lumps invalid into `conflicting`, and the existing `complexity.state` keeps doing so; only the new paired projection separates them, using the classifier's `unrecognized` list, for both metrics. Missing evidence is `unknown` or `unassessed`, never a default size. Changes to dependants do not make an impact estimate stale automatically: no graph traversal.

## Invalid labels and Ticket Doctor

Ticket Doctor consumes the same descriptor-parameterised finding builder and reports, without repairing:

- `impact-label-conflict`: several recognized impact labels; inspection, no size chosen.
- `impact-label-invalid`: an `impact:*` label outside XS–XXL, as a judgment plan. Suggestions come from the shared suffix table (`tiny`→XS … `massive`→XXL) plus impact-only extras `low`→S, `high`→L, labelled as suggestions and never applied. Unmapped suffixes ask for a size. Suggested fix: `estimate N --metric impact --size <SIZE> --rationale <RATIONALE> --replace-invalid --repo owner/name`.
- `impact-labels-incomplete`: truncated labels; unknown, inspection-only.

Unassessed tickets are never Doctor errors. With `impact.enabled` false, impact findings are suppressed. Complexity findings are unchanged.

## Configuration

Register `impact.enabled` (boolean) beside `complexity.enabled`, through the existing config layer, `config set/list` and help. Default: enabled, mirroring complexity, with explicit repository opt-out. Disabling suppresses impact assessment actions, impact-dependent value bands (easy win, unfavorable, cross-role boosts that need impact) and impact Doctor findings; it deletes no labels or provenance, and display shows `disabled`. Configuration schema version 1 is unchanged (additive key). No backend selector, field ID or migration.

## The unassessed-work queue

Impact assessment is not an always-last list. Per blended-action-queues.md it is a ranked action of kind `assess-impact`, role `designer`, in band 5 (confidence-improving assessment):

- Candidates: open tickets whose impact state is `unassessed` or `stale`. Blocked tickets are included under stated assumptions and remain implementation-ineligible. `conflict` and `invalid` produce an inspection action in band 5 with the Ticket Doctor fix as `nextCommand`, never a boost. `unknown` is reported in context with its reason and omission count, not queued as executable.
- Cross-role boost: complexity `current` XS or S with impact `unassessed`/`stale` sorts first within band 5. Remaining assessments follow, then the standard within-band keys (urgency, immediate-unlock score, incomplete before unstarted, creation time, identity). Per blended-action-queues.md an assessment's immediate-unlock score is zero, because assessing does not change any ticket's eligibility; the ticket's proven unlock count is shown as context only and never sorts assessments.
- Above it for designers: addressed attention (1), actionable delivery follow-up (2), and existing unblock duties (3): decisions blocking active work, agreed decisions needing documentation, design review. Below it: ordinary new design (6).
- Assessment acquires no claim. `nextCommand` is `pdb estimate N --metric impact --size <SIZE> --rationale <RATIONALE> --repo owner/name`.
- Expanded/compact designer reports add an `impactEstimation` object shaped like the existing estimation object (`status`, `eligible`, `ranked`, `shown`, `offered`, conflicts and unknown counts, guidance version). Existing objects keep their schema versions.

A focused designer view equivalent to `--estimate` is not required; it may be added in #246 only if it reuses the same queue result.

## Side-by-side display

Shared read facts, computed once per snapshot from collected labels and comments, feed both queue and display.

**Existing fields are unchanged.** Compact report subjects already expose `complexity` as an `EstimateEntry | null` (`src/estimation/estimation.ts`: `number`, `title`, `url`, `createdAt`, `size`, `state`, `recorded`, `implementation`, `reasons`), with `state` in `estimated | unestimated | stale | conflicting | unknown`, and `null` when estimation is disabled or the subject is not an open issue. The expanded and compact reports expose the same entries through the `estimation` object (`queue.items`, `conflicts`, `entries`). Its name, type, fields, state values and null semantics stay exactly as they are, on the CLI JSON and on MCP results that return the same report.

**New property: `assessments`.** Each compact and expanded report subject gains one new, separately named property holding the paired view:

```json
"assessments": {
  "impact":     {"state": "unassessed", "size": null, "provenance": null},
  "complexity": {"state": "current", "size": "S", "provenance": "https://github.com/owner/name/issues/7#issuecomment-1"},
  "unlocks": 2,
  "unlocksUnknown": []
}
```

`state` uses the paired vocabulary above, `size` is non-null only for `current` and `stale`, and `provenance` is the newest trusted provenance comment URL or null. `rankedActions` items carry the same `complexity`/`impact` pair at top level as already contracted in blended-action-queues.md; that object is itself new, so those keys collide with nothing.

`assessments` was chosen over a sibling `impact: EstimateEntry` field because it is the smaller, clearer additive change. Mirroring `EstimateEntry` for impact would either copy a vocabulary that cannot express `invalid` or `disabled`, or give two same-shaped fields different state meanings; it would also duplicate per-ticket queue fields (`implementation`, `recorded`) the paired view does not need. One new object keeps the old vocabulary in the old field and the new vocabulary in the new one, and puts both metrics side by side for presentation.

Mapping from the paired state to the existing `complexity.state`, for consumers reconciling the two (the existing field is computed as today, not from this table):

| `assessments.*.state` | Existing `EstimateState`                                           |
| --------------------- | ------------------------------------------------------------------ |
| `current`             | `estimated`                                                        |
| `stale`               | `stale`                                                            |
| `unassessed`          | `unestimated`                                                      |
| `conflict`            | `conflicting`                                                      |
| `invalid`             | `conflicting` (the existing classifier does not separate it)       |
| `unknown`             | `unknown`                                                          |
| `disabled`            | no entry: `complexity` is `null` and estimation `status: disabled` |

A paired `stale` is computed with trusted provenance (#215) and may therefore differ from the existing field's staleness in edge cases such as untrusted provenance; the existing field is not changed to match.

Text renders one fixed order, impact first because it is the benefit question: `impact L · complexity S · unlocks at least 2`. Non-current states render as words: `impact unassessed`, `impact stale (was L)`, `impact conflict`, `impact invalid`, `impact unknown`, `impact disabled`. Existing text renderings of complexity (for example `(size unknown)` in compact text) may be replaced by this line, since text is not a schema. Detail views link the newest trusted provenance comment for each metric.

Because `assessments`, `impactEstimation` and `rankedActions` are new properties and no existing field changes name, type, state values or null semantics, the change is additive and no schema version bump is needed. If an implementation finds it must change an existing field's shape, it introduces a new schema version instead. No extra collection: labels and comments already arrive in the snapshot.

## Easy-win heuristic placement

No new ordering is invented; the heuristic is exactly the band rules of blended-action-queues.md, applied to the paired states above, implemented once in the shared policy (#248):

- **Band 4, known easy win** (implementers only): impact `current` L/XL/XXL and complexity `current` XS/S, and every existing implementation eligibility rule passes.
- **Band 5, assessment**: cross-role boosts first (impact `current` L/XL/XXL with complexity `unassessed`/`stale` boosts `estimate-complexity`; complexity `current` XS/S with impact `unassessed`/`stale` boosts `assess-impact`), then unboosted assessments and inspections.
- **Band 6, ordinary**: everything else eligible, including any pair involving M, any pair with a non-current state, and L/L-type tradeoffs.
- **Band 7, known unfavorable**: impact `current` XS/S and complexity `current` L/XL/XXL. Low priority, not forbidden.

Only `current` qualifies for bands 4 and 7 and for a boost source; `stale`, `conflict`, `invalid`, `unknown`, `unassessed` and `disabled` never do. There is no ratio, index arithmetic or downstream-label sum. Incomparable pairs (for example L/L against S/XS) fall to band 6 and are ordered by the shared within-band keys, which is the deterministic fallback. Explicit `--order oldest|newest` coalesces bands 4/6/7 for unclaimed pickup into band 6 and sorts by age, as the blended contract states. Each item's `reasonCodes` record why it is in its band (for example `easy-win`, `unfavorable`, `cross-role-boost`, `impact-unassessed`). Until #248 ships, the existing simple ranking (#196/#182) remains the behavior and must not wait for impact.

## Acceptance scenarios

Injected snapshots, clock, filesystem and `TrustDecision`; no live writes. Assert states, kinds, order, reason codes and omissions, not prose.

- Recording `impact:L` over `impact:S` removes S, keeps `complexity:M` and `bug`, writes one v1 comment; an identical retry writes nothing new.
- A failure after the label change but before the comment reports partial; the retry adds only the comment.
- `impact:high` refuses without `--replace-invalid`; with it, records and lists `impact:high` in `replacedInvalid`.
- A complexity write never touches impact labels, and vice versa.
- Truncated labels make impact `unknown`; untrusted-author provenance means no recorded rationale; unknown-permission provenance means `unknown`.
- Ticket Doctor reports `impact-label-invalid` with suggestion L for `impact:high`, and nothing for unassessed tickets.
- `impact.enabled=false` yields `disabled` everywhere, no `assess-impact` actions, no easy-win or unfavorable bands, ordinary work still offered.
- Display shows L/S, S/L and L/L contrasts with the right bands (4, 7, 6 respectively), and unlock utility separately.
- Complexity XS with impact unassessed boosts `assess-impact` below an active-work-blocking decision and above ordinary new design.
- Old caches/fixtures without impact data read as `unassessed` only when label evidence is complete, otherwise `unknown`.

## Delivery scope per ticket

- **#245, record and read primitives.** Metric descriptor; impact label helpers and classifier through the shared parameterised functions; `impactGuidance` v1 data; `estimate --metric impact` with all recording rules; `impact-estimate v1` provenance writer/parser; trusted-provenance reader producing the paired states; `impact.enabled` config key; Ticket Doctor impact findings and suggestion extras. Tests: races, changed labels, failed comment, missing permission, retries, cross-metric isolation, trust outcomes. No queue or display changes beyond what Doctor needs.
- **#246, designer guidance and queue integration.** Render `impactGuidance` in CLI and MCP help from the one definition; `assess-impact` candidates and inspection actions registered with the #248 shared policy; designer NEXT STEPS rendering; `impactEstimation` report object. Tests: role/help parity, absent/conflict/invalid/unknown labels, disabled, output bounds, old cache compatibility. Implementer integration is #259; installed parity is #260.
- **#247, side-by-side facts and display.** One shared paired-facts reader per snapshot (both metrics plus unlock utility) used by queue and display; the new `assessments` property on compact and expanded report subjects (CLI JSON and MCP), text rendering, provenance links, vocabulary separation from unlock utility. Existing `complexity` and `estimation` fields stay byte-compatible. Presentation only; no scoring. Tests: label isolation, omission budgets, fixture/schema parity (existing `complexity` entries unchanged, including `conflicting` for invalid labels), L/S, S/L and L/L.
- **#248, shared blended policy.** Bands 4, 5 (with both cross-role boosts), 6 and 7 as above, on top of the existing bands and keys, with `rankedActions` and reason codes, consumed by #246 and #259. Pure comparator over injected facts (the paired states from `assessments`, never the legacy `EstimateState`); no collection inside it; existing `actions`/`role.next` keep their target-only shape. Tests: the blended scenario suite plus the paired-state edge cases in this document.

#245 lands first. #247 depends on #245. #248 depends on #247 (and the existing #258 contract). #246 depends on #245 and #248.
