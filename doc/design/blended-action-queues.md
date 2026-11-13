# Blended role action queues

Owner-approved direction, 13 November 2026. This is the documentation-first implementation contract for the next-action views, not a claim that this policy has shipped. It supersedes the fixed implementation-before-estimation policy in complexity-estimation.md and the fixed own-work/pickup ordering in briefings.md. The earlier simple ranking baseline in PR #251 remains an independent deliverable; this change replaces its assessment-last portion when implemented. Repository catch-up `briefing` remains a history view, not this scheduler.

## Why

Recommend the action most likely to advance delivery with the evidence available. Finishing selected work usually has high confidence of benefit. Known easy wins have favorable benefit and complexity. Assessments improve confidence about other work. Known expensive, low-benefit work should not crowd those actions out. One role-shaped queue should blend kinds of work rather than hide assessment in a separate section. This is a deterministic first version, not an optimal scheduling claim or a production formal-rule engine.

## Shared facts and action model

Reuse collected issue/PR facts, current complexity and impact assessments, native direct-unlock evidence, identity, platform and existing eligibility predicates. Do not add another collector, full dependency-tree fetch, stored priority label, risk metric or weighted score. Use the reviewed impact contract from #244 and shared readers from #245/#247; never infer a valid impact label merely because it resembles a proposed name.

Each candidate has a stable action ID (repository + subject + action kind), subject URL, action kind, responsible role, actionable/inspection/waiting status, reason codes, supporting facts/evidence, evidence completeness, urgency and a concrete next command. Kinds include addressed-response, PR-follow-up, continue-implementation, implement, estimate-complexity, assess-impact and existing designer decision/documentation/review/design actions. Preserve existing reported identity versus verified GitHub-author distinctions. Roles select suitable work, not new authority. CLI and MCP consume the same policy result.

Only executable candidates enter the main queue. Waiting checks, missing permissions and unknown implementation eligibility remain visible bounded context with next inspection steps, never executable pickup. A blocked ticket can still be assessed conditionally; assessment does not clear its blockers, reserve it or acquire a claim. Other agents' active work cannot become a second implementation claim. Platform restrictions and unknown scope remain explicit. No automatic writes, claims, interruptions or merges.

## Default order

First match wins; lower numbered bands rank earlier:

1. Attention addressed to the viewer, irrespective of urgency or assessment.
2. Actionable delivery follow-up: own PRs before other-agent review opportunities. Pending CI is waiting, not actionable follow-up; green checks suggest merge consideration subject to existing fresh review/permission rules, never approval.
3. For designers, decisions blocking active work, agreed decisions needing documentation, then design review, retaining those distinct reasons and groups. These existing unblock duties precede discretionary new work.
4. Known easy-win implementation: impact L/XL/XXL and complexity XS/S, both current and valid. Implementers only; all implementation eligibility rules still apply.
5. Confidence-improving assessment: implementer complexity estimation and designer impact assessment. Cross-role signal first: impact L/XL/XXL with absent/stale complexity boosts complexity assessment; complexity XS/S with absent/stale impact boosts impact assessment. Remaining unassessed/stale work follows within this band. Known conflicting, invalid or incomplete assessment evidence produces an inspection action, not a fabricated assessment value; inspection shares this band without receiving a speculative cross-role boost.
6. Ordinary eligible implementation/continuation for implementers and ordinary new design for designers.
7. Known unfavorable implementation: impact XS/S and complexity L/XL/XXL. Both facts must be current and valid; this is low priority, not forbidden work. Designers can still act on a separately recorded design/splitting need using existing design rules.

M is the middle category on either scale. Other fully assessed pairs and tickets missing either value are ordinary implementation, unless another band applies. Never infer missing impact is low, missing complexity is high, or lack of labels means complete evidence. Re-estimation needs the existing meaningful-staleness test, not every new commit. A current assessment is not automatically queued again solely because the pair is unfavorable.

An existing own implementation claim uses its applicable value band, but remains visibly owned. If a different action is preferred, show the exact supported handoff/parking command and the one-active-claim restriction. This recommendation does not authorize abandoning a claim or performing a second implementation in parallel. Claim-free review/assessment can remain actionable under existing commands. Do not interrupt an already running tool.

Within each discretionary band use existing urgency high/unspecified/low (conflicting labels are unspecified with a diagnostic), proven immediate-unlock lower bound descending, own continuation before otherwise-equal new implementation, incomplete before unstarted, creation time ascending, then repository/subject numeric identity/action kind. Cross-role boost precedes those keys within band 5. Assessment is not credited with immediately unblocking implementation: its immediate-unlock score is zero unless a separate reviewed rule proves an actual eligibility change; show the ticket's potential unlock context separately. Unknown counts remain lower bounds, never definite zero. Urgency does not leapfrog addressed attention, delivery follow-up or other bands; a future explicit override requires a new contract.

Explicit --order oldest/newest retains age-only ordering for implementation pickup, ignoring urgency/value/unlock weighting there while keeping metadata visible. To avoid a hidden value sort across pickup, coalesce implementation bands 4/6/7 for unclaimed pickup at the ordinary implementation position (band 6), then sort by requested creation time and stable identity. Claimed work retains its existing separate visibility; attention, PR, designer duties and assessment bands remain intact. Help must state this precise scope. --estimate remains an explicit focused complexity-assessment view, not required to discover estimation in the default queue.

## Output and compatibility

The normal implementer and designer NEXT STEPS list contains the blended executable actions with kind, concise why, paired assessments/unknowns and next command. Separate sections may provide detail but must not be the only place assessments appear. Limits apply after ranking, with total/omitted counts. An assessment displaced by the display limit is omitted, not semantically unavailable. Remove the misleading available-queue-but-offered:false implication; distinguish eligibility, included-in-ranked-queue and shown-in-bounded-output.

Preserve existing schema versions and fields as compatibility projections. Add a `rankedActions` object to compact/expanded role reports: `{policyVersion: 1, total, omitted, items}`. Each item carries `id`, `kind`, `target`, `role`, `band`, `reasonCodes`, `evidence` (URLs), `nextCommand` (string or null with an inspection reason), `complexity` and `impact` (each `{state: current|unassessed|stale|conflict|invalid|unknown|disabled, size: XS|S|M|L|XL|XXL|null}`), `unlocks` (proven lower-bound integer), and `unlocksUnknown` (reason strings). Stable IDs concatenate repository, subject URL and registered action kind; no agent names or fixture-specific cases in policy. `total` counts executable/inspection actions before limits, `omitted = total - items.length`; waiting items stay in existing context sections. Existing `actions` and `role.next` retain their documented target-only shape as stable first-occurrence target projections of the blended ranking; repeated targets are not repeated in those legacy arrays. CLI NEXT STEPS renders `rankedActions`, not the legacy target projection. The additive object is the authoritative action-kind-aware interface for new consumers. Retain existing estimation objects, add `eligible`, `ranked` and `shown` counts, and document `offered` as true when at least one assessment enters the ranked queue, regardless of truncation. No incompatible removal or silent field-type change. Group linked PR/ticket evidence; suppress duplicate implementation while a PR is open. A ticket normally contributes at most one viewer-appropriate assessment action; genuinely distinct actions retain distinct IDs and reasons. Rendered CLI and MCP results must agree on order, facts and omissions. Registered help/process guidance must describe the same policy and readiness boundaries.

Complexity disabled suppresses complexity assessment and easy-win/unfavorable classification requiring it; impact disabled similarly suppresses impact assessment/classification. Ordinary eligible work remains available. Do not introduce a hard requirement to assess all work before implementation. No network lookup of missing assessments during sorting. Owner catch-up remains unchanged.

## Required scenario suite

Use injected snapshots, clock and filesystem; no live mutations or paid bulk trials. Assert action kind/order, reason codes, evidence and omissions, not exact prose.

- Addressed low-urgency work precedes every high-value candidate.
- Actionable PR follow-up precedes easy-win implementation; running CI does not starve it.
- Impact L/complexity S implementation precedes a complexity estimate with only impact XL known.
- Impact XL/unknown complexity becomes a boosted implementer estimate, ahead of ordinary implementation.
- Complexity XS/unknown impact becomes a boosted designer assessment, below an active-work-blocking decision and above ordinary new design.
- Unboosted assessment precedes ordinary implementation; fully assessed XL-complexity/XS-impact implementation is last.
- Missing, conflicting, invalid, stale and truncated evidence do not produce easy wins or unfavorable classifications.
- Blocked work may be assessed under assumptions but cannot be implementation pickup.
- Active claims, open PRs and platform restrictions preserve their eligibility and navigation rules.
- Equal candidates have stable deterministic ties; unknown direct-unlock evidence is shown as a lower bound.
- Explicit oldest puts an older unfavorable pickup before a newer easy win; labels remain visible.
- Disabled metrics suppress only their relevant assessments/value bands, with ordinary work still offered.
- CLI/MCP agree; small limits show omissions; assessment remains in the ranked queue even when not shown.

## Delivery sequence

Review/land this contract under #258 and the impact interface contract #244 first. Shared policy is #248; implementer integration #259; designer integration #246; installed acceptance #260. Implement the shared candidate/policy layer with injected scenarios; wire implementer and designer views separately against that shared result; then verify installed CLI/MCP parity and real repository assessment visibility. Reuse #246 for designer queue foundations and #248 for the easy-win policy rather than build a competing scheduler. Do not bundle production changes into this documentation PR. Tomorrow's trial depends on those implementation/review steps; this document alone does not ship it.
