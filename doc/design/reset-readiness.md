# Reset readiness and historical retry compatibility

Documentation-first contract for #276. Reuses delivery-lifecycle.md and its owner-clarification addendum; overrides the reset label-plan wording below when implemented. It does not change current runtime, authorize automatic stale-claim release, or relax maintainer/active-claim/open-PR prerequisites.

## Why

A deliberate reset to ready can currently leave status:incomplete too, because the plan removes only status:awaiting-review. The requested target must be unambiguous. However, changing the stored plan also changes the current retry identity; an implementation must not mistake a historical request for a brand-new override or replay expanded removals against someone else's later labels.

## Fresh reset plan

For reset --as ready, store remove:[status:awaiting-review,status:incomplete], add:[status:ready]. For --as incomplete, store remove:[status:awaiting-review,status:ready], add:[status:incomplete]. Arrays use that stable ordering. The explicit --as selects the desired readiness; this is not guessing which of two conflicting labels is right. Do not remove unrelated labels or any agent claim. Refuse all current claim/authority/open-PR/unknown-evidence failures before writing. Record first, verify the fold/current prerequisites, then apply the recorded individual label operations. Verify the final relevant-label set is exactly the target; unexpected concurrent changes are reported partial/diverged, never silently repaired.

## observedLabels

Document the existing optional reset-record field observedLabels:string[]. It captures the observed reset-relevant subset of labels before the plan is applied: status:ready, status:incomplete and status:awaiting-review, de-duplicated and sorted. It is an observation, not a request-defining choice. Writers emit only this subset; readers project older string arrays onto known relevant labels rather than treating unrelated names as authority. Absence on historical records remains meaningful unknown starting state. This is additive within delivery-record v1; no old record/comment is edited.

The stored plan plus observedLabels determines the recorded post-plan relevant set. Current relevant labels equal to that set mean the recorded label step completed. Otherwise, the plan is pending only when the current set is its recorded start or a permitted intermediate set after some recorded removals, before a new addition. Unexpected additions, a later different readiness, intervening responsibility changes, unreadable history or missing prerequisites forbid replay. Recheck before every resumed label write and verify after applying; there is no transactional GitHub guarantee.

## Preserve old request identity and plans

Before deriving a new reset identity, find an existing applicable reset request using stable op/agent/requested target semantics. Recognize both the legacy remove-only-awaiting-review plan and the corrected opposite-readiness-removal plan. Do not change historical opIds or reinterpret a stored plan with the new plan generator. observedLabels, reasons and timestamps remain non-defining observations/descriptions. Same --as against the same effective request is a retry, not a fresh reset merely because the generator now removes an additional label.

A recognized historical retry uses that record's exact original plan and its own starting observation when available. It must never silently add the new opposite-label removal to an old pending plan. If the old plan has completed but leaves both readiness labels, report the conflict and take no further action. This is not a completed corrected-plan invariant; it is a completed historical operation requiring a separate explicit correction.

For an old record without observedLabels, do not guess that a non-target state is a partial write. Conservatively recognize completed status only when the relevant labels are exactly its requested target; otherwise refuse label replay with an inspection/recovery explanation. Do not post a duplicate reset to get around that uncertainty. Preserve current later-record supersession checks and explicit maintainer authority for any new independent reset.

A legacy conflict can be corrected deliberately through the GitHub UI or the existing unsupported-operation gh fallback after inspection, for example gh issue edit N --repo owner/name --remove-label status:incomplete --add-label status:ready. Show the command appropriate to the explicitly intended target; never run it automatically. The operator must inspect current claims/responsibility and preserve unrelated labels. This contract adds no --force/--new flag and does not claim that retrying the old reset itself authorizes a larger plan. A later distinct reset is planned against its own effective history and fresh state under existing command semantics.

## Acceptance

Injected tests cover fresh ready/incomplete reset with the opposite or both labels; stable observedLabels emission; irrelevant-label preservation; failed removal/addition and verified partial results; corrected-plan retry; known legacy plan pending/completed/conflicting states; missing historical observedLabels; a later readiness change; responsibility supersession; active claim and open PR appearing before resume; and duplicate-record prevention after plan-generator changes. Both historical and corrected records still parse and fold. Readers do not report an expanded plan as successfully applied merely because the old target label is present. Update help, examples, schema notes and structured/text refusals alongside implementation. No live mutation is an acceptance test.
