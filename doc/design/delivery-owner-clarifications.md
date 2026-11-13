# Delivery command owner clarifications

Documentation-first addendum for #189/#190 and PR #263, approved 14 November 2026. Overrides contradictory defaults in delivery-lifecycle.md when implemented; does not claim current commands already comply. Reuse the existing member identities, target-containment evaluator and append-only receipt model.

## Correcting commit evidence

A legacy commit attached through --commit must be detachable. detach, retarget and deliverable-scoped handoff accept exactly one of --pr or --commit. --commit uses the existing canonical commit identity/validation and explicit repository disambiguation; resolve a short input to the verified full OID before matching. Never select a member by a fuzzy prefix or detach all matches. Preserve the same responsibility, trust, member existence, fresh-history and append-only checks as PR operations. retarget for a commit changes its intended target, not a Git ref; handoff transfers responsibility for that member, not ownership of the commit. Never invent PR base semantics for commits. Unknown or ambiguous identity refuses with a useful exact recovery; successful retry is idempotent. No rewriting old records. Existing v1 member kind already represents commits; selectors do not require a new record version.

## Legacy membership is open until explicitly confirmed

attach --legacy defaults to membership open. --membership complete is an explicit statement that the listed required-deliverable set is complete; use the existing membership confirmation operation for later sealing. Membership completeness is not proof of delivery. Multiple attachments do not imply completion and the first PR does not imply the entire deliverable set. submit's separately documented normal default is unchanged. Preserve recorded historic membership as history; do not reinterpret old complete records just because the command default changes.

## Handoff and active claims

Ordinary ticket-responsibility handoff refuses CLAIM_HELD if any agent holds an active claim, including another agent. Keep existing scope authority, predecessor binding and first-valid-transfer replay checks. This guard is checked before append and again on re-read; races remain visible and are not claimed atomic. Deliverable-scoped transfers retain the existing scope rules; this decision specifically resolves ticket-level handoff. Do not silently broaden an ordinary command into a maintainer bypass.

A deliberate manual override remains a distinct future design path requiring explicit authority, reason and visible provenance. Current reassign/reset active-claim guards remain intact. Until that path is separately reviewed, recovery is supported explicit claim release/handoff by the authorized actor or direct human administrative action; never fabricate a --force command. Human closure is respected and never automatically reversed.

Ticket Doctor reports possible stale claims after its configured inactivity threshold and gives supported inspect/release commands, actor restrictions and activity evidence. Missing activity is not proof of abandonment. No automatic release, reassignment or reopening. Optional automatic reclamation is deferred, not required to deliver this first version.

## Off-target PRs are progress evidence

An explicit intended --target can differ from an attached PR's current base. Accept the readable PR with that intended target and display the mismatch as progress, not completed delivery. Without an explicit target, retain normal target-resolution/ambiguity safeguards; never silently infer that a feature-branch base is the desired final delivery target. Matching intended repository, authority and identity validation still apply.

No new progress-only membership flag is needed: the existing required member with separate intended target and observed PR facts can represent this. The open PR is not delivered; a merge into an intermediate branch remains merged-off-target only when live containment positively proves the merge commit absent from the intended target. If containment is unreadable/inconclusive the verdict is unknown, never a guessed negative. If subsequently retargeted and merged into the intended branch, or merged onward so its merge commit is positively contained, the existing fresh containment rule can recognize delivery. Merely attaching, base equality or an intermediate merge never proves completion. This preserves the merged-PR compare rule and all-required-members completion semantics, including stacked PRs, partial deliveries and force-pushed/deleted targets.

## Refusal names and acceptance

NOT_RESPONSIBLE is acceptable for an actor lacking the required effective responsibility. NOT_REQUIRED is acceptable for a correction requiring a current required member that is absent. Keep current authority/unknown checks ahead of a conclusive negative and provide failed prerequisite, observed facts and exact supported recovery. Do not rename unrelated established codes.

Injected scenarios must cover PR/commit selectors and ambiguous IDs; commit detach/retarget/handoff; repeat and partial writes; legacy omitted/open/explicit complete; multiple members; another agent's active claim; transfer races; Doctor unknown activity/no mutation; explicit mismatched base with intended target; intermediate merge absent/present/unknown containment; and refusal to complete any open/unknown required set. No live mutations in tests. Update CLI help, schema examples and shared diagnostic readers with the runtime changes after this contract merges. This addendum does not expose new MCP mutation tools.

## Related decisions

Impact estimation defaults on with explicit opt-out, confirmed on #245 and the merged impact contract; complexity-history author trust is separate #269 and current size labels remain authoritative. Signing is deferred: future developers may each authorize an agent group with a dedicated automation key. If explicitly enabled in a future approved version, bootstrap can reuse an approved key or generate one and offer public-key publication. The private key stays local/outside Git; key discoverability is not repository trust. No key operations or signing implementation are authorized now (#240/#241). These decisions must not block current lifecycle work.
