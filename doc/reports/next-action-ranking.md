# Next-action ranking for implementers (#44)

Research report and recommendation. Nothing here changes the briefing, labels, claims or anyone's authority to act. The chosen contract still needs its own reviewed documentation PR, and implementation is #45.

## The question

An implementer asks one thing: **what could I do next to move the project forward?** The answer should be one short ranked list of concrete actions, each with its reason and evidence. Today the agent gets several lists (next steps, review, available, decisions, dependencies, hygiene) and has to reconcile them by hand.

## Baseline being evaluated

From the designer intake on #44 and the agreed rules on #1, #2, #14 and in `AGENTS.md`:

1. Explicit attention addressed to me.
2. Actionable PR follow-up.
3. Work I own.
4. Eligible pickup, ranked by immediate last-open-blocker impact. `status:incomplete` wins ties. Oldest-first and newest-first are alternative modes.

Throughout, a ready-to-merge candidate is not approval. Pending CI is a wait status. Stale ownership does not grant authority to release a claim. Unknown readiness does not make a ticket eligible.

## Evidence: how the current briefing ranks

The current briefing gives each rule one fixed priority and sorts every finding by it, then by unblock count, then by **target URL as text**. The priorities are: ownership conflict 100; PR review findings and failed checks 95; readiness inconsistency and PR conflicts 90; native evidence unknown 85; claimed-but-ready 85; PR merge consideration 80; attention label 75; native-dependency findings 65; PR verification needed 60; PR merge state 55; PR pending 50; ready-unclaimed 40; question candidate 35; dependency drift 25.

Live snapshots of two public repositories, taken on 2026-11-12 with `--cache` and replayed with `--offline --full --json --limit 1000`:

|                                 | github_triage                                            | poker_blocks                                                                                                    |
| ------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Open issues / PRs               | 27 / 0                                                   | 87 / 3                                                                                                          |
| Collection cost                 | 2 GraphQL requests, 1.2 s                                | 3 requests, 2.9 s                                                                                               |
| Findings (distinct subjects)    | 27 (27)                                                  | 171 (79)                                                                                                        |
| Position of first pickup action | **18th**                                                 | **112th**                                                                                                       |
| What ranks above it             | 17 `attention-label` findings, all `status:needs-design` | 43 `blocker-explanation` and 43 `retired-blocker-label` findings on the same 43 tickets, 21 attention labels, … |

What this shows:

1. **Attention labels are not attention addressed to me.** `status:needs-design` is attention for designers, but it ranks above every pickup for everyone. On github_triage all ten default next steps were `needs-design` tickets an implementer cannot act on, and #44, the one ticket that unblocks another, was 18th.
2. **Hygiene drowns work.** On poker_blocks the pre-migration label findings (two per ticket) fill positions 25 to 111. They are real, but they are cleanup for one person running the migration (#6), not the next action for every implementer.
3. **Ties are broken by URL text.** Pickup order is `541, 550, 552, …` only because the numbers have the same width. `…/issues/100` sorts before `…/issues/14`. Ties are not broken by age, and `status:incomplete` is never preferred.
4. **Eligibility the tool cannot see.** github_triage offers #9, #14 and #35, which are claimed in "Picked up by" comments, and #21, #23 and #24, which are restricted to other agent platforms in their bodies. Neither fact is machine-readable today.
5. **Every agent posts as the same GitHub user.** All 23 comments on github_triage and 220 of 226 on poker_blocks are by `trebizondoculpepper`. Authorship therefore cannot identify "my" PR or claim. Only `agent:` labels can, and poker_blocks uses them (5 labels) while github_triage uses none.
6. **Ticket and PR duplicated.** A ready issue with an open closing PR (poker_blocks #674) appears both as pickup and through its PR.

## Alternatives

### A. Weighted score (one number per subject)

For example: `score = 40·attention + 30·failing-own-PR + 10·unblocks + 5·importance + 0.1·age-days`.

- **For:** compact; easy to add signals; aging can stop starvation.
- **Against:** it is not explainable. "Why is this above that?" becomes arithmetic. Weights interact: three hygiene findings on one ticket outscore a single failing check, which is how the current fixed priorities already misbehave. Results also swing when one weight changes, and a stable order needs constant calibration that nothing in the project measures. It invites quietly overriding the agreed ordering.

### B. Ordered tiers, then keys within a tier (lexicographic)

Each subject gets one tier from explicit rules. Inside a tier, rows are ordered by a short, configurable list of keys.

- **For:** directly expresses the agreed baseline. Each row's reason is the tier name plus the key that won. It is deterministic and testable with small fixtures, and changing the order is a visible, reviewable edit to a list.
- **Against:** a lower tier can starve. In practice that is acceptable for this domain: if my PR is failing, it should come before new pickup. Starvation inside the pickup tier is handled by an age tie-breaker.

### C. Tiers plus bounded aging across tiers

Promote an old item by at most one tier after N days.

- **Against:** it silently reorders the agreed baseline, and age is already a within-tier key. Not recommended. If wanted, implement it as an explicit "stale" tier (see open questions), not as hidden promotion.

### D. Ask an LLM to rank

Excluded by the ticket: do not run a model on every refresh to rank structured facts.

## Recommendation: ordered tiers (B)

### Algorithm

```text
input: snapshot, viewer (agent name, optional), role (implementer by default), mode (impact | oldest | newest)

subjects = one row per open PR, plus one per open issue WITHOUT an open closing PR
           (an issue with an open PR is represented by its PR; reasons merge)

for each subject, compute eligibility facts:
  mine       = viewer in agent: labels of the issue (or of the PR's closing issues)
  claimed    = any agent: label present
  ready      = has status:ready or status:incomplete, not parked
  blocked    = native blockedBy > 0, or native evidence unknown  (unknown is not eligible)
  restricted = an explicit eligibility label excludes this viewer (see open question 2)

tier (first match wins):
  T1 attention-for-me    explicit attention addressed to viewer (#3/#14 mechanism)
  T2 my-pr-needs-work    mine PR with failing checks, unresolved threads, conflicts, or requested changes
  T3 my-pr-mergeable     mine PR, current head verify passed, no open findings  ("consider merge; not approval")
  T4 my-claim            mine issue without a PR (continue, or record a disposition)
  T5 pr-needs-review     other PR with no review yet / unresolved findings, if role reviews
  T6 pickup              ready, unclaimed, not blocked, not restricted, no open PR
  W  waiting             PR checks pending; ready but natively blocked ("ready when #… closes")
  H  hygiene             label/dependency inconsistencies, capped (default 3), never above T6
  — excluded             needs-design / question (designer and catch-up views), parked, others' claims

within a tier, sort by keys (default, configurable list):
  T2..T5: severity (failing > conflicts > findings), then oldest first
  T6:     last-open-blocker count desc, importance desc (#43, when it exists),
          status:incomplete first, then created ascending (mode=oldest) or descending (mode=newest)
  always: issue/PR number ascending as the final, numeric tie-breaker

output: the first N rows (default 5), each with tier, reason, winning key, evidence URLs and a detail command;
        followed by counts of waiting, hygiene and excluded rows, never silently dropped
```

### Inputs and defaults

| Input       | Default        | Notes                                                                                 |
| ----------- | -------------- | ------------------------------------------------------------------------------------- |
| `viewer`    | `--agent NAME` | Without it, tiers T1 to T4 are empty and the list starts at review or pickup          |
| `role`      | implementer    | Designer or catch-up views use the same subjects with a different tier table (#1)     |
| `mode`      | `impact`       | `oldest` or `newest` change only the T6 age key                                       |
| tier table  | as above       | A list in the registered workflow policy, so a change to the order is a reviewed diff |
| hygiene cap | 3              | Remaining hygiene is counted with a drill-down command                                |
| limit       | 5              | Unchanged from today's compact view                                                   |

### Explanations

Each row says why it is where it is, for example:

- `T2 my-pr-needs-work: verify failed on 4f3c2a1 (macos, node 24)`
- `T6 pickup: last open blocker for #45 (1 dependant); created 2026-11-12`
- `W waiting: verify pending on 9c1d70f`

## Representative examples

A prototype of this algorithm was run on the same snapshots. It is a scratch script, not shipped; the rules are exactly the pseudocode above, without T1 because no addressed-attention mechanism exists yet.

**github_triage, generic implementer:** 10 actionable rows.

1. #44 pickup: last open blocker for #45.
2. #6, #9, #14, #17, #20, #21, #23, #24, #35 pickup, oldest first.

The 17 `needs-design` rows move to the designer view. #9, #14, #35 (claimed in comments) and #21, #23, #24 (platform-restricted) still appear, because those facts are not labels. See open questions 1 and 2.

**poker_blocks, generic implementer:** 11 actionable rows instead of 171.

1. #763 PR needs work: 1 unresolved thread.
2. #702 and #762 PRs to consider merging (not approval).
3. Pickup: #541, #550, #552, #580 (2026-11-11), then #627, #629, #759.

#674, already linked to an open PR, appears once, through that PR. The 86 pre-migration hygiene findings collapse to 3 plus a count.

**poker_blocks, viewer `markus_kovacs`:** that agent's PR #762 rises to T3 and #763 to T2, both above other agents' PRs. Pickup is unchanged.

## Acceptance fixtures for #45

Each is a small injected snapshot, with the expected order asserted exactly:

1. A failing own PR outranks any pickup, regardless of how much the pickup unblocks.
2. Pending checks put a PR in W, not T2 or T3, and never ranked as merge-ready.
3. A `needs-design` ticket never appears in the implementer list; it is counted as excluded.
4. A ready issue with an open closing PR appears once, as the PR.
5. Natively blocked ready work appears in W as "ready when #N closes", never in T6.
6. Unknown native evidence makes a ticket ineligible (W, with a refresh hint).
7. Pickup tie-breakers apply in order: last-blocker count, importance, incomplete, age, number. `#100` vs `#14` sorts numerically.
8. `mode=newest` reverses only the age key.
9. 50 hygiene findings show as 3 rows plus "47 more", and never above pickup.
10. Without `--agent`, T1 to T4 are empty and the output says so. With it, claims by other agents are excluded.
11. Another agent's claim is never offered, even when it is old. Staleness is reported, not treated as release.
12. Output is stable across runs for the same snapshot.

## Integration with related tickets

- **#1 role views:** this is the implementer row of a shared tier table. Designer and catch-up roles reuse the same subjects and eligibility facts with their own tables, so the briefing has one ranking engine, not two.
- **#2 claim commands:** claims must become `agent:` labels (or another machine-readable record) for T4, T6 exclusion and finding 5 to work. Comment-only claims are invisible to any algorithm.
- **#14 identity:** the viewer name comes from the resolved agent identity; T1 needs the addressed-attention mechanism.
- **#41 team view:** shows T2 to T4 for every agent instead of one viewer.
- **#43 importance:** an optional T6 key after last-blocker count. It is never a tier, so importance cannot outrank a failing own PR.

## Open questions

1. **Machine-readable claims.** Should agents always apply `agent:` labels when claiming, as poker_blocks does, so the tool can see claims? Until then, comment claims are invisible (finding 4). This belongs with #2 and #14.
2. **Platform or role restrictions.** #21, #23 and #24 are restricted to named platforms in prose. Should that be a label (for example `platform:claude-code`), or remain human judgement?
3. **A stale tier.** Should own claims or PRs with no activity for N days get an explicit "stale: record a disposition" row in T4, rather than any automatic release? Release authority stays with the claim rules.
4. **Hygiene ownership.** Should hygiene rows be shown only to the agent running the relevant migration or cleanup ticket, rather than capped for everyone?

## Limits

- Two repositories, one day, one owner account. The ranking quality claims are about ordering behaviour on real data, not measured productivity.
- The prototype omits T1 (no addressed-attention data yet) and reviewer-role details (T5 depends on #1).
- Collection cost is unchanged: ranking uses facts the briefing already collects.

## Reproducing

```sh
node src/cli.js --repo trebizondoculpepper/poker_blocks --cache poker.json --json --full > /dev/null
node src/cli.js --offline --cache poker.json --full --json --limit 1000   # current ranking, as analysed above
```

The snapshots are public data, regenerated rather than committed; counts will drift as the repositories change.
