# Immediate action impact: estimation, PR completion and implementation (#201)

Research report. It changes no code, labels, claims or ranking. It recommends a small primitive for #196 and states what #182 and #188 should decide. The spike was kept to about one hour of agent time, as `doc/design/research-stages.md` asks for initial plausibility work.

## Contents

- [The question](#the-question)
- [Evidence and cost](#evidence-and-cost)
- [Inventory of current calculations](#inventory-of-current-calculations)
- [The three action types compared](#the-three-action-types-compared)
- [Recommended baseline](#recommended-baseline)
- [Worked examples](#worked-examples)
- [Counterexamples](#counterexamples)
- [Implementation recommendation for #196](#implementation-recommendation-for-196)
- [Limits](#limits)
- [Open questions for the owner](#open-questions-for-the-owner)

## The question

An implementer can usually do one of three things next: estimate a ticket, move a pull request toward merge, or implement a ticket. Which one has the most immediate effect on delivery, using only facts the tool already collects, without walking the whole dependency graph and without inventing numbers?

The ticket fixes several constraints, and this report keeps them:

- Finish-before-start (#182) and addressed attention are policy tiers. A score never moves an item across them.
- Immediate delivery utility counts only otherwise-ready direct dependants for which the candidate is the last open native blocker.
- Estimation reduces uncertainty. It clears no native blocker, so it is never credited with unlocks.
- Delivery impact is deduplicated across PRs, and a PR that is one of several contributions is not credited as the last required completion.
- Missing facts are unknown, not zero.
- Only current open-work evidence and direct edges are used.

## Evidence and cost

One live run of the default briefing on this repository (`npx tsx src/cli.ts --repo trebizondoculpepper/github_triage --json`, 2026-11-13 18:16 UTC) reported `requestCount: 2`, `durationMs: 1404`, complete evidence, 37 open issues and 1 open PR, and a 77 KB JSON document. The two requests are the paged `issues` and `pullRequests` collections (`src/github.ts:478-484`). Each issue already carries `issueDependenciesSummary`, `blockedBy(first:100)` and `blocking(first:100)`, and each blocking node carries its own `issueDependenciesSummary` (`src/dependencies.ts:10-13`). Each PR carries `closingIssuesReferences(first:100)`, and each issue carries `closedByPullRequestsReferences(first:10)` (`src/github.ts:280-282`).

So every input the recommended baseline needs is already in the snapshot. The baseline costs **no extra requests**: it is a pass over open issues and their direct `blocking` edges, `O(open issues × direct dependants)`, with dependants looked up by URL in the snapshot. By contrast #196 measured `deps 749 --tree --json` on Poker Blocks at 85.6 s, 165 nodes and about 425 KB, against 1.18 s and 3.2 KB for the direct form. Those are single-run observations, not guarantees; the 2-request figure above is likewise one run on a small repository, and request count grows with page count (50 items per page).

## Inventory of current calculations

| Calculation                   | Where                                               | What it does                                                                                                                                                | Verdict                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `immediateUnlocks`            | `src/ranking.ts:178-199`                            | Distinct open dependants whose only open native blocker is this ticket, that are in the snapshot, have complete native evidence and are otherwise eligible. | **Correct; reuse as the unlock primitive.** It already deduplicates by URL, requires the dependant's own summary to agree (`blockedBy === 1`) and applies the shared non-blocker gates. Gap: it ignores `blocking.pageInfo.hasNextPage`, and dependants it cannot see are silently dropped (see below). |
| `otherwiseEligible`           | `src/ranking.ts:129-153`                            | Every pickup gate except native blockers: open, unclaimed, ready/incomplete label, no prerequisite label, no open closing PR, platform.                     | **Correct; reuse.** It is private today; the primitive needs it, or `immediateUnlocks` as is.                                                                                                                                                                                                           |
| `pickupEligibility`           | `src/ranking.ts:156-170`                            | `otherwiseEligible` plus complete native evidence and zero open blockers; three-valued (eligible/unknown/ineligible).                                       | **Correct; reuse** as the implement-candidate filter.                                                                                                                                                                                                                                                   |
| `closingPrEvidence`           | `src/ranking.ts:98-119`                             | Open closing PRs proven from either side of the link, with `complete: false` when absence cannot be proven.                                                 | **Correct; reuse** for the PR-to-issue mapping and to count how many open PRs contribute to one issue.                                                                                                                                                                                                  |
| `orderingPolicy.impact`       | `src/ranking.ts:219-229`                            | Lexicographic keys: urgency band, unlock count, `status:incomplete` first, oldest, number.                                                                  | **Correct; reuse the shape** (ordered keys, no weighted score) inside each tier.                                                                                                                                                                                                                        |
| `rankPickup` reasons          | `src/ranking.ts:237-279`                            | Builds a readable reason listing every fact used.                                                                                                           | **Reuse the pattern.**                                                                                                                                                                                                                                                                                  |
| `unblocks`                    | `src/dependencies.ts:64-69`                         | Counts open dependants whose summary says one open blocker. No eligibility, no snapshot check.                                                              | **Not a delivery-utility measure.** It counts dependants that still need design, are claimed or are absent. Fine as a labelled upper bound; it is what the non-role briefing sorts by (`src/briefing.ts:562-563`, `src/compact.ts:192`). Do not reuse as impact.                                        |
| PR findings                   | `src/briefing.ts:410-500`                           | Failed checks (95), review findings (95), conflicts (90), `pr-inspect-merge` when clean (80, `:472-492`), pending (50), verification needed (60).           | **Correct as facts; reuse.** They decide whether a PR has an actionable next step. Fixed priorities are fine for classification but are not delivery impact.                                                                                                                                            |
| `followUpRules` / PR sections | `src/roles.ts:73-78`, `src/roles.ts:172-206`        | PR FOLLOW-UP holds failed checks, findings, conflicts, inspect-merge; everything else is PRS WAITING. Sorted mine first, then rule priority, then number.   | **Reuse the split**, with #182's correction: green PRs with `UNKNOWN`/`BEHIND` merge state need a "refresh/update branch" action, not waiting. No unlock impact is shown on PRs today.                                                                                                                  |
| `prStatus` blockers           | `src/prstatus.ts:336-411`                           | One PR's full current blocker list, no single verdict.                                                                                                      | **Correct; detail view only.** It costs a request per PR, so the ranking uses snapshot findings and leaves `pr N` for the chosen PR.                                                                                                                                                                    |
| Role order                    | `src/roles.ts:320-347`                              | Implementer: addressed, PR follow-up, own work, PRs waiting, pickup, possible pickup, unblock candidates, stale claims, pending design.                     | **Correct tiering; reuse.** It already encodes finish-before-start except for review opportunities, which share the PR FOLLOW-UP tier with own PRs.                                                                                                                                                     |
| Addressed attention           | `src/briefing.ts:319-330`, `src/compact.ts:117-123` | `attention:NAME` for the viewer; priority 200; never cut by budget.                                                                                         | **Correct; a policy tier, not an input to impact.**                                                                                                                                                                                                                                                     |
| Estimation queue              | `src/estimation.ts:126-238`, sort at `:222-224`     | Unestimated and stale tickets, blocked included, oldest first; implementation eligibility kept alongside; presented after other work unless `--estimate`.   | **Correct; reuse.** It already states that estimating "does not unblock or re-rank" (`:137`).                                                                                                                                                                                                           |
| Design pickup                 | `src/roles.ts:258-279`                              | Uses `immediateUnlocks` for design tickets.                                                                                                                 | **Correct**, and evidence that the primitive generalises beyond implementation pickup.                                                                                                                                                                                                                  |

## The three action types compared

|                       | Advance a PR toward merge                                                                                                     | Implement a ticket                                              | Estimate a ticket                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| What it changes       | Can close the linked issue on merge, which can clear a native blocker.                                                        | Produces a PR later; clears nothing now.                        | Records a size; reduces uncertainty. Clears nothing.                                                                      |
| Distance to an unlock | One step (fix, refresh, merge), if this is the last required deliverable.                                                     | At least two steps: implement, then the whole PR path.          | None. It never unlocks.                                                                                                   |
| Impact measure        | Deduplicated `immediateUnlocks` of the linked issue(s), only when this PR is the last open contribution; otherwise "partial". | `immediateUnlocks` of the ticket, labelled as "when delivered". | No unlock count. State only the facts it informs: whether the ticket is implementation-eligible and its own unlock count. |
| Gate                  | Actionable follow-up finding; ownership respected; never merge authority.                                                     | `pickupEligibility === eligible`; one active claim.             | Queue state unestimated or stale; complexity enabled.                                                                     |
| Policy position       | Ahead of new implementation (finish-before-start).                                                                            | After actionable PR work.                                       | After implementation unless the viewer asked to estimate.                                                                 |

The comparison follows from distance to effect, not from a weight. An actionable PR step is closer to delivery than any new implementation, so even a PR with zero unlocks precedes new pickup; that is #182's rule, not a number. Estimation is compared on a different axis. Its justification is that a known size makes later choices and splitting cheaper, which matters most for tickets that are about to be picked up or that hold up others. So the baseline orders the estimation queue by those facts but never prints an unlock count for it.

## Recommended baseline

A pure function over an injected snapshot, returning one ranked list of candidates for one viewer.

### Inputs

- Open issues and open PRs from the existing snapshot, with their labels, native summaries and direct `blockedBy`/`blocking` edges, closing references both ways, and PR findings from the existing analysis rules.
- The viewer's agent name (for `agent:` and `attention:` labels) and explicit platform, when given.
- The estimation report entries, when complexity is enabled.
- Explicit delivery evidence when it exists (the #189 required-deliverable records). Today none exists, so this input is absent and the result says so.

### Eligibility filters

- **PR candidate:** open PR with an actionable follow-up finding (`followUpRules`, plus #182's refresh/update action once it lands). Waiting PRs are excluded and never block other tiers. Another agent's PR is offered only as a review opportunity, never as fix or merge work.
- **Own active work:** an open issue carrying the viewer's `agent:` label.
- **Implement candidate:** `pickupEligibility(...).status === "eligible"`. Unknown eligibility goes to an inspect list, never pickup.
- **Estimate candidate:** estimation entry with state `unestimated` or `stale`. Conflicting and unknown sizes stay inspection items.

### Facts per candidate

- `unlocks`: `immediateUnlocks` of the issue. For a PR, this is **not** a simple union of each linked issue's `immediateUnlocks`, which requires `blockedBy === 1` (`src/ranking.ts:189-196`) and so misses a dependant whose remaining blockers are all completed together by the same PR. For example, PR #20 completes #5 and #6, which are jointly the only open blockers of #7, so merging #20 unlocks #7, but each issue alone reports zero. Evaluate PR unlocks against the whole set: a dependant counts when every one of its open native blockers is in the set of issues the PR completes, and the dependant is otherwise eligible. This applies only with complete native evidence for the dependant and the completion gate below; deduplicate by dependant URL. This needs a set-aware variant of `immediateUnlocks`, recommended for #196.
- `unlockEvidence`: `complete`, or `partial` with reasons: `blocking` truncated (`pageInfo.hasNextPage`), dependants absent from the snapshot (cross-repository or not collected), dependants without native evidence. Unknown dependants are listed, never counted and never treated as zero.
- For a PR, `completion`:
  - `last-required` only when explicit delivery evidence says this PR is the last open required deliverable of the issue.
  - `sole-open-pr-unverified` when it is the only open closing PR of a linked issue and the closing references are **exhaustive**, but no deliverable record exists. Its unlocks are shown but marked unverified. Exhaustive means the issue's own `closedByPullRequestsReferences` is complete (not truncated), or no open PR's `closingIssuesReferences` is truncated. `closingPrEvidence(...).complete` is **not** sufficient: it becomes true as soon as one open closing PR is found, which proves presence (safe for excluding pickup), not cardinality. A visible PR whose sibling may be hidden by truncation is therefore `unknown`, not sole.
  - `partial` when another open PR also closes the same issue. Unlocks are reported once, against the issue, as "shared, needs all of #a, #b", and credited to no single PR.
  - `unknown` when closing evidence is incomplete, including when one closing PR is visible but the references are not exhaustive. This needs a cardinality-aware helper (or an `exhaustive` flag on `closingPrEvidence`), recommended for #196.
- For an estimate: `implementation` eligibility and the ticket's own `unlocks`, both reported as context, not as estimation impact.

### Ordering

Tiers first, fixed by policy:

1. Addressed attention (unbounded).
2. Actionable follow-up on the viewer's own PRs.
3. The viewer's own claimed issue.
4. Review opportunities on other agents' PRs (see open question 1).
5. Implement new eligible pickup.
6. Estimate (moves to just after tier 1 when the viewer passes `--estimate`).

Within a tier, lexicographic keys in the `orderingPolicy` style:

- PR tiers: urgency band; `last-required` before `sole-open-pr-unverified` before `partial`/`unknown`; number of definite unlocks; existing finding priority (failed checks and findings before inspect-merge); oldest; number.
- Implement tier: exactly the existing `orderingPolicy.impact`.
- Estimate tier: implementation-eligible first; then the ticket's own definite unlocks; then oldest; number. This keeps the existing oldest-first queue as the final tie-break.

### Reasons

Each row lists the facts in the order they were used, for example: `Your PR #12 (tier 2: own PR follow-up): failed check verify; closes #7, the only open closing PR (no deliverable record: completion unverified); #7 is the last open blocker of #9 and #10, both otherwise ready (unlock evidence complete).`

## Worked examples

All examples use injected snapshots; the numbers are invented fixture data.

**A. PR beats new pickup with more unlocks.** Viewer owns PR #20 (failed `verify`) closing #5; #5 unlocks nothing. Pickup #30 unlocks 3. Order: #20 then #30. Reason: tier 2 precedes tier 5 by policy; the unlock counts are shown but do not cross tiers.

**B. Two own PRs.** PR #21 closes #6, which is the last blocker of ready #8 and #9. PR #22 closes #7, which unlocks nothing. Same urgency, both `sole-open-pr-unverified`. Order: #21 (2 unlocks), then #22.

**C. Shared delivery.** PRs #23 and #24 both close #11, which unlocks #12. Both PRs show `partial; #11 needs #23 and #24; would unlock #12 when both merge`. #12 is counted once in any total, and neither PR outranks a `sole-open-pr-unverified` PR with one unlock.

**D. Implement order is unchanged.** Pickup #40 (`urgency:high`, 0 unlocks) and #41 (2 unlocks): #40 first, as `orderingPolicy.impact` does today.

**E. Estimation.** Queue holds #50 (blocked by #51, unlocks 4 when delivered) and #52 (eligible now, unlocks 0). Order: #52 first, because it is the one that can be picked up next. #50's row says `blocked by 1 open issue; unlocks 4 when delivered; estimating it unlocks nothing`.

**F. Nothing actionable on PRs.** The viewer's PR #25 has checks running. It goes to the waiting list; pickup #30 is the top action.

## Counterexamples

What the baseline must not do:

1. **Counting a dependant that still has another blocker.** #60 is blocked by #61 and #62. Neither #61 nor #62 gets credit for #60.
2. **Counting a dependant that is not otherwise ready.** #63 is blocked only by #64 but has `status:needs-design` or an `agent:` label. #64 gets no credit. `unblocks()` would count it; `immediateUnlocks` correctly does not.
3. **Double-counting across PRs.** Crediting #12 to both #23 and #24 (example C) would report 2 unlocks for one ticket.
4. **Calling a partial PR the completion.** Merging #23 alone does not close the delivery of #11 when #24 is also required. Credit is withheld until delivery evidence or the other PR resolves it.
5. **Fabricated estimation unlocks.** Printing "unlocks 4" against estimating #50 would claim that sizing clears a blocker. The 4 belongs to delivering #50.
6. **Unknown read as zero.** #65's `blocking` list is truncated at 100, or its dependant #66 is in another repository and absent from the snapshot. The count must say "at least N; M unknown", not N.
7. **Score crossing a tier.** A pickup with 10 unlocks still follows the viewer's actionable PR with 0, and an addressed attention item precedes both.
8. **Waiting work freezing pickup.** A PR waiting on checks or review is not a candidate and does not stop tier 5.
9. **Full traversal.** Counting grandchildren that become ready only after two merges is transitive reach. It is out of scope; if ever shown, it must be labelled optional and bounded.

## Implementation recommendation for #196

- Add one pure TypeScript module (for example `src/impact.ts`) exporting `immediateImpact(snapshot, viewer)` that reuses `immediateUnlocks`, `pickupEligibility`, `closingPrEvidence`, the PR findings and the estimation entries. It collects nothing and makes no requests.
- Extend `immediateUnlocks`, or wrap it, to return the unknown remainder: truncated `blocking`, absent dependants and dependants without native evidence.
- Keep fact collection and presentation separate from the later formal-rule engine (#188/#191): the module produces facts and ordered keys, and the role sections present them. A future rule engine can consume the same facts.
- Test with injected snapshots covering every example and counterexample above, and assert that the function makes zero `gh` calls.
- Present the PR unlock and completion facts in PR FOLLOW-UP rows and the estimation context in the estimation queue. No production integration is done here.

## Limits

- No deliverable records exist yet (#189). Until they do, "this PR completes the issue" is at best `sole-open-pr-unverified`. A merged PR may not close its issue, and a closed issue may not be delivered.
- Merging is never implied. The ranking says what to work on; `pr N` and the existing merge rules decide whether a merge is allowed.
- Unlock counts are direct and immediate only. They say nothing about value, size or downstream depth.
- `blocking(first:100)` and `closedByPullRequestsReferences(first:10)` can truncate. The baseline reports truncation; it does not page further.
- Cross-repository dependants are absent from a single-repository snapshot and are reported as unknown.
- The cost figures are one run each on small repositories.
- The estimation comparison is a judgement, not a measurement. Nothing here measures how much an estimate improves later choices.

## Open questions for the owner

1. Should review opportunities on other agents' PRs sit with the viewer's own PR follow-up (as the implementer role does today) or below the viewer's own claimed work, as the #186 report's order suggests?
2. Until deliverable records exist, should `sole-open-pr-unverified` unlocks be shown on PR rows at all, or only once #189 makes completion verifiable?
3. Should the estimation queue prefer implementation-eligible tickets first (this report's recommendation), or keep plain oldest-first?
