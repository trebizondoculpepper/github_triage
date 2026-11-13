# Delivery lifecycle: claims, responsibility and verified completion

Architecture contract for [#188](https://github.com/trebizondoculpepper/github_triage/issues/188). It reviews the [Agile lifecycle research](../reports/agile-delivery-lifecycle.md) (#186, PR #195) and the [current-model mapping](../reports/delivery-lifecycle-mapping.md) (#187, PR #200), reconciles them with the owner decisions in [triage efficiency and trust](triage-efficiency-and-trust.md#lifecycle-architecture-and-coherent-delivery-188192-182) and the [comment-marker authority contract](workflow.md#focused-handoff-62) (#212, #214), and refines the focused implementation tickets #189–#192 and the ranking ticket #182.

Status: proposed contract. Nothing here is implemented by this document. Commands, record kinds, fields and derived states below are interface contracts for the named tickets, not claims about current behaviour. Until each ticket ships, the existing [claims and handoff](workflow.md) contract and its safeguards remain in force. Merging this document does not close #189–#192 or #182.

## Contents

1. [Decisions at a glance](#decisions-at-a-glance)
2. [State axes and the responsibility relation](#state-axes-and-the-responsibility-relation)
3. [Invariants](#invariants)
4. [Delivery evidence model](#delivery-evidence-model)
5. [Records: storage, versioning and authority](#records-storage-versioning-and-authority)
6. [Transitions and commands](#transitions-and-commands)
7. [Default completion policy](#default-completion-policy)
8. [Outcomes other than a merged PR](#outcomes-other-than-a-merged-pr)
9. [Rule and fact interface](#rule-and-fact-interface)
10. [Partial failures, retries and concurrency](#partial-failures-retries-and-concurrency)
11. [Source compatibility and migration](#source-compatibility-and-migration)
12. [Scenario matrix](#scenario-matrix)
13. [Rollout and focused-ticket criteria](#rollout-and-focused-ticket-criteria)
14. [Release-required completion (separate extension)](#release-required-completion-separate-extension)
15. [Resolution of the report questions](#resolution-of-the-report-questions)

## Decisions at a glance

| ID  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Two independent axes, **activity** (the claim) and **delivery** (derived from evidence), plus a **responsibility** relation between an agent and each submitted deliverable. Issue **closure** is reported as a third, separate fact. No label per CI or review state.                                                                                                                                                                                                                           |
| D2  | Delivery is stored as an append-only set of **delivery records** (hidden comment markers, `github-triage:delivery v1`). Records name _which_ deliverables are required and who is responsible; they never state that delivery happened. Delivery is always evaluated from live evidence.                                                                                                                                                                                                         |
| D3  | A new `submit` transition replaces `release --as done` for PR-based work. It verifies and records the required deliverables first, then releases only the caller's active claim and sets the coarse `status:awaiting-review` marker. Responsibility survives the release.                                                                                                                                                                                                                        |
| D4  | Default completion: every required deliverable is a PR merged into its intended integration target, which defaults to the target repository's GitHub default branch read live. No configuration key is added now.                                                                                                                                                                                                                                                                                |
| D5  | A new explicit `complete` operation re-evaluates delivery from fresh evidence and, only when the policy predicate holds, records the evidence and closes the issue as completed. This deliberately replaces the "the tool never closes issues" rule for this one operation. The tool still never reopens, never merges and never closes on inference.                                                                                                                                            |
| D6  | Follow-up on a submitted PR the agent is responsible for, whether it submitted it or received it by `deliverables handoff` (answer review threads, fix findings and failing checks on that PR's branch, update a behind branch, re-verify) is responsibility work and needs no claim. New scope, a new or replaced deliverable, or work on the issue beyond the submitted PRs still requires `claim --rework`, which the responsible agent may take (see [Rework authority](#rework-authority)). |
| D7  | `status:awaiting-review` stays as the coarse "submitted, not pickable" marker. It is never read as a delivery state. Delivery state comes only from the evaluator.                                                                                                                                                                                                                                                                                                                               |
| D8  | Legacy v1 `done` handoffs are **legacy contribution-done** with unknown membership. They are never upgraded by inference; `deliverables attach --legacy` (no claim needed, write-permission author, visible record) is the explicit recovery.                                                                                                                                                                                                                                                    |
| D9  | Mutation-driving delivery records follow the #212 authority rule from day one: verified current write/maintain/admin `User` author and editor; bots and apps never; unknown grants nothing. Agent names stay reported, not authenticated.                                                                                                                                                                                                                                                        |
| D10 | Completion policy is written as rule records over registered facts, in the convention of the [rules spike](../reports/examples/rules-spike/rules.ts). TypeScript collects and validates facts and enforces transitions. No new language and no production Datalog engine are introduced.                                                                                                                                                                                                         |
| D11 | Release-gated completion is a separate opt-in extension with explicit artifact association. Nothing in the merge-based baseline waits for it.                                                                                                                                                                                                                                                                                                                                                    |
| D12 | "One ticket, one PR" remains the default process rule. A multi-PR required set is the explicit exception for work that cannot be split, cross-repository work being the expected case. Coordinating/local ticket topologies are not mandated.                                                                                                                                                                                                                                                    |

## State axes and the responsibility relation

### Activity axis (unchanged)

`unclaimed` or `claimed by A`, stored as the `agent:NAME` label with its claim comment, governed entirely by the existing [claims contract](workflow.md#one-active-contribution). One active claim per agent. A claim means "working on this now".

### Responsibility relation (new, #190)

`responsible(agent, issue, deliverable)` holds when the newest trusted delivery record for that deliverable on that issue names the agent as responsible and the deliverable has not been detached. It is routing, not a reservation:

- It is created by `submit`, `deliverables attach` or `deliverables attach --legacy`, and changed only by an explicit `deliverables handoff` record. It does not expire, and no other agent takes it over automatically.
- It never blocks another agent from reviewing, and never grants merge, close or claim authority.
- It directs attention: findings, failures, merge-readiness and cleanup of that deliverable are addressed to the responsible agent in briefings, `who`, `team`, Ticket Doctor and polling.
- An agent may be responsible for any number of deliverables while holding at most one active claim.
- On the shared GitHub account the responsible agent is a reported name. It routes attention; it does not prove which agent or person acts.

### Delivery axis (derived, per deliverable then per ticket)

Per deliverable, recomputed on every read from live evidence bound to the current head:

| Deliverable state   | Evidence                                                                                                                                                                                                                                            |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `draft`             | PR is open and draft.                                                                                                                                                                                                                               |
| `waiting`           | Open, not draft; checks pending or review not yet given on the current head; no actionable finding.                                                                                                                                                 |
| `changes-requested` | On the current head: failing required check, `CHANGES_REQUESTED`, unresolved review thread, or merge conflict.                                                                                                                                      |
| `accepted`          | On the current head: required checks green, approval (or the repository's existing review receipt) bound to the current head, no unresolved findings. Mergeability may still need refresh or a branch update; that is an action, not a wait (#182). |
| `merged`            | Merged, and the merge base branch equals the deliverable's intended target in the intended repository.                                                                                                                                              |
| `merged-off-target` | Merged into some other branch. Not delivered.                                                                                                                                                                                                       |
| `closed-unmerged`   | Closed without merge. Not delivered.                                                                                                                                                                                                                |
| `unknown`           | Unreadable, truncated, permission-denied or rate-limited evidence. Never treated as any other state.                                                                                                                                                |

Per ticket, aggregated over the trusted required set (see [completion policy](#default-completion-policy)):

| Ticket delivery | Meaning                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none`          | No trusted delivery record and no legacy handoff.                                                                                                                   |
| `legacy`        | Only a legacy v1 `done` handoff exists; membership unknown.                                                                                                         |
| `submitted`     | Required set recorded; every member positively observed not yet merged into its target; none unknown.                                                               |
| `partial`       | At least one member `merged`, at least one positively observed not merged into its target (open, draft, `closed-unmerged` or `merged-off-target`); none unknown.    |
| `delivered`     | Membership known and complete, every member `merged` (or a verified direct commit).                                                                                 |
| `attested`      | A trusted non-code outcome record exists **and applies** (see [attestation applicability](#attestation-applicability)); reported separately from verified delivery. |
| `unknown`       | Any member `unknown` (`memberUnknown(t)`), any unverified record that would affect membership, or truncated record history (`recordsUnknown(t)`).                   |

**Verdict precedence.** The ticket verdict is the first that holds in this order: `unknown` > `delivered` > `attested` > `partial` > `submitted` > `legacy` > `none`. `unknown` takes precedence over every other verdict: when any member or record is unknown, the ticket is never reported `partial`, `submitted`, `delivered` or `attested`, even if other members are positively merged or open. Every negative verdict (`partial`, `submitted`, and any "not merged", "closed unmerged" or "wrong target" explanation) requires positive evidence of that negative state; absence of evidence is `unknown`, never a negative.

### Closure (reported, never inferred)

`open`, `closed-completed`, `closed-not-planned`, `closed-duplicate`, `closed-other`, from the issue `state` and `stateReason`. Closure and delivery are always reported side by side. A closed issue is never evidence of delivery, and an open issue never blocks reporting that delivery holds. Who closed it is reported as the GitHub actor only, never as "a human".

## Invariants

1. One active claim per agent; never stolen; never reacquired automatically (unchanged).
2. Responsibility is created, transferred or ended only by an explicit trusted record. No expiry, no adoption by inactivity, no inference from PR authorship or the GitHub login.
3. Delivery is never stored as a fact. Records list required membership and targets; the evaluator decides from live evidence each time.
4. Missing, truncated, unreadable or unverified evidence yields `unknown`, never `delivered`, `attested`, `partial`, `submitted` or "not delivered". Every negative fact (not merged, closed unmerged, merged off target) is derived only from positive evidence of that state. This includes a recognized delivery record from a trusted or authority-unknown author whose payload is malformed or whose version is unsupported: it sets `recordsUnknown(t)` and is never skipped.
5. One merged PR proves nothing about the others. Issue closure proves nothing about delivery. Green checks are not acceptance and acceptance is not delivery.
6. The tool never merges, never reopens, and closes an issue only through `complete` after the predicate holds on fresh evidence.
7. Membership and target changes are explicit, append-only and visible in history. A removal is a record, never an edit or a deletion.
8. Records drive writes only with authority per #212. Records without authority remain visible as evidence.
9. Repository identities are opaque `owner/name` strings from evidence. No issue-number, repository or named-agent special cases.
10. Read surfaces (briefing, Doctor, `who`, `team`, MCP, polling) are read-only and share one evaluator.

## Delivery evidence model

### Deliverable identity

A deliverable is one of:

- `pr`: `{kind: "pr", repository: "owner/name", number, nodeId}`. The repository is always explicit, including for the ticket's own repository.
- `commit`: `{kind: "commit", repository, oid}` for an accepted direct commit (less preferred, per [workflow](workflow.md#focused-handoff-62)).

Each required entry also records `target` (`{repository, branch}`), `responsible` (reported agent name), and, for PRs, the `headOid` observed at attach time for provenance. The observed head is history, not a freshness proof; acceptance always uses the live current head.

### Facts read per deliverable (targeted reads by recorded identity, never a repository-wide scan)

- PR: `state`, `isDraft`, `merged`, `mergedAt`, `mergeCommit.oid`, `baseRefName`, `baseRepository.nameWithOwner`, `headRefOid`, `mergeable`, `mergeStateStatus`, check rollup on the head, reviews with `commit.oid`, unresolved threads, `closingIssuesReferences` (for link consistency only).
- Commit: reachability from the target branch head via the compare API (`identical` or `behind` means contained).
- Target default: `defaultBranchRef.name` of the target repository, read live when the record omits an explicit branch.

### Link checks at attach time

- The PR exists and is readable; its base repository equals the recorded target repository.
- Its base branch equals the intended target, or `--target` names it explicitly. A PR targeting a different branch without an explicit target is refused (`TARGET_MISMATCH`), with the explicit-target command in the recovery.
- A missing closing reference to the issue is a warning, not a refusal: cross-repository PRs often cannot close the issue, and membership is what the record says.

## Records: storage, versioning and authority

**Storage.** Hidden comment markers on the issue, the same mechanism as claim and release records, so no new service, credential or daemon is needed. Marker prefix `<!-- github-triage:delivery v1 ` followed by JSON. Each comment carries exactly one record:

```json
{
  "v": 1,
  "op": "submit | attach | legacy-attach | detach | retarget | handoff | attest | complete",
  "opId": "<stable hash of repository, issue, op, deliverables, agent, claimedAt or issuedAt>",
  "repository": "owner/name",
  "issue": 123,
  "agent": "reported-name",
  "deliverables": [
    {
      "kind": "pr",
      "repository": "owner/name",
      "number": 45,
      "nodeId": "PR_x",
      "target": { "repository": "owner/name", "branch": null },
      "headOid": "abc123"
    }
  ],
  "responsible": "reported-name",
  "membership": "complete | open",
  "reason": "text, required for detach, retarget, handoff and attest",
  "plan": { "remove": ["agent:reported-name"], "add": ["status:awaiting-review"] },
  "issuedAt": "2026-11-13T00:00:00Z"
}
```

`branch: null` means "the target repository's default branch, read live". The repository and issue are inside the payload so a copied record fails on another issue (replay binding from the #155 report). `membership: "complete"` asserts the listed set is the whole required set; `open` means more deliverables are expected and the ticket cannot evaluate as delivered until a later record closes membership.

**Folding.** The current required set is the in-order fold of trusted records: `submit`/`attach`/`legacy-attach` add, `detach` removes, `retarget` changes a target, `handoff` changes `responsible`. A comment is a **recognized delivery record** when its body carries the `<!-- github-triage:delivery ` marker prefix. Every recognized record is classified before folding, and no recognized record is ever silently skipped:

| Recognized record                                                                            | Treatment                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trusted author, `v: 1`, payload parses and validates                                         | Folded.                                                                                                                                                                                                                                                                                 |
| Trusted author, payload unparsable or fails schema validation                                | Not folded, and `recordsUnknown(t)` becomes true: the record may have changed membership, so the fold is incomplete. Reported as "malformed delivery record by LOGIN"; mutations that depend on the fold refuse `RECORD_MALFORMED`; `complete` and any `delivered` verdict are blocked. |
| Trusted author, marker or `v` names a version this reader does not support (`v2`…)           | Not folded, and `recordsUnknown(t)` becomes true, reported as "unsupported delivery record version N by LOGIN"; mutations refuse `RECORD_UNSUPPORTED`. A future version is never guessed at or downgraded.                                                                              |
| Author authority unknown (permission lookup failed, rate-limited, editor history unreadable) | Not folded, and `recordsUnknown(t)` becomes true, regardless of whether the payload parses. Mutations refuse `MARKER_UNVERIFIED` as in #212; read surfaces report `unknown` rather than refusing.                                                                                       |
| Author verified **without** authority (no write/maintain/admin, bot or app)                  | Listed as "unverified record by LOGIN, ignored" and excluded. It does not make the fold unknown: an untrusted author could never have changed trusted membership, so excluding it is a decision, not missing evidence. Its parse state is irrelevant.                                   |

Authority is decided first, so a malformed or future-version comment from a verified non-writer is simply ignored and cannot be used to block completion. Only comments without the marker prefix are outside the fold. This is invariant 4 applied to records: anything that might have been trusted membership but cannot be read counts as missing evidence. The mapping report's "unparsable records skipped" wording is superseded by this table.

**Authority.** Exactly the [#212 rule](workflow.md#focused-handoff-62): author and any editor must be a `User` with current write, maintain or admin permission from the collaborator-permission endpoint; per-run cache only; bots and apps never. Trust is computed through an injected `TrustDecision` boundary so #205's demonstration result can replace the implementation without changing callers. Until #205's reviewed recommendation lands, production uses the #212 rule, never an anyone-can-comment assumption.

**Versioning.** Delivery records are a new record kind at `v: 1`; release records stay `v: 1` and are unchanged. Readers refuse future versions (`RECORD_UNSUPPORTED`) instead of guessing, and a trusted future-version record makes `recordsUnknown(t)` true (see Folding). Read schemas (`pr-status`, `ticket-doctor`, briefing JSON, MCP) gain additive `delivery`, `responsibility` and `closure` fields within their current `schemaVersion`; no existing field changes meaning.

## Transitions and commands

All commands use the existing refusal shape (stable error ID, facts, failed prerequisite, recovery commands) and text/JSON parity. None is exposed through MCP until a separate reviewed mutation contract.

| Transition                                           | Command                                                                                           | Preconditions (fresh reads)                                                                                                                                                                              | Writes, in order                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Ready → In progress                                  | `claim N --agent A` (unchanged)                                                                   | as today                                                                                                                                                                                                 | as today                                                                                                         |
| In progress → Parked / Ready                         | `release N --as incomplete\|parked\|ready` (unchanged)                                            | as today                                                                                                                                                                                                 | as today                                                                                                         |
| In progress → Submitted                              | `submit N --agent A --pr URL [--pr URL…] [--target owner/name:branch] [--membership open]`        | caller holds the claim; every PR readable, open or merged, in the stated target repository and branch; records trusted                                                                                   | 1. delivery record (`submit`, carrying the label plan) 2. remove `agent:A`, add `status:awaiting-review`         |
| Add or remove a required deliverable                 | `deliverables N attach\|detach --agent A --pr URL --reason TEXT`                                  | caller holds the claim **or** is responsible on a trusted record; detach requires a reason                                                                                                               | one delivery record                                                                                              |
| Legacy attachment (no claim, no responsibility)      | `deliverables N attach --legacy --agent A --pr URL [--pr URL…] [--membership open] --reason TEXT` | see [Legacy attachment](#legacy-attachment)                                                                                                                                                              | one `legacy-attach` delivery record; no label writes, no claim                                                   |
| Change target                                        | `deliverables N retarget --agent A --pr URL --target owner/name:branch --reason TEXT`             | as attach                                                                                                                                                                                                | one delivery record                                                                                              |
| Transfer responsibility                              | `deliverables N handoff --agent A --to B --reason TEXT`                                           | caller responsible                                                                                                                                                                                       | one delivery record                                                                                              |
| Submitted → Changes requested → Accepted             | none (derived)                                                                                    | evaluator only                                                                                                                                                                                           | none                                                                                                             |
| Follow-up on a responsible PR                        | none (ordinary pushes and replies, D6)                                                            | caller responsible; work confined to that PR's branch                                                                                                                                                    | none by the tool                                                                                                 |
| Changes requested → In progress (substantive rework) | `claim N --rework --agent A` (kept)                                                               | no claim held by A or another agent; A holds a [rework authority](#rework-authority) record; otherwise as today (claim-time and authority checks)                                                        | as today; `status:awaiting-review` is removed, records untouched                                                 |
| Accepted → Merged                                    | merge outside the tool, by whoever existing policy authorises                                     | existing merge authorisation, fresh head, protection and review checks                                                                                                                                   | none by the tool                                                                                                 |
| Merged → Delivered, issue closed                     | `complete N --agent A`                                                                            | fresh evaluation: `delivered` holds; records trusted; issue open                                                                                                                                         | 1. delivery record (`complete`, evidence snapshot) 2. close issue `completed` 3. remove `status:awaiting-review` |
| Delivered, issue already closed                      | `complete N --agent A`                                                                            | as above; issue closed by anyone                                                                                                                                                                         | 1. `complete` record only; never reopen, never re-close                                                          |
| Non-code outcome                                     | `deliverables N attest --agent A --reason TEXT [--evidence URL]`                                  | caller holds the claim or is responsible; records trusted; [attestation applies](#attestation-applicability) on fresh evidence, otherwise refused `ATTEST_NOT_APPLICABLE` naming the outstanding members | one `attest` record; then `complete` may close with delivery `attested`                                          |

### Legacy attachment

A v1 `done` handoff creates no responsibility, the ticket is unclaimed, `claim --rework` requires an open PR (src/claims.ts:723-730), and pickup excludes `status:awaiting-review` tickets. Ordinary `attach` is therefore unreachable for the S1 case, so `attach --legacy` is the explicit recovery path:

- **Author.** The comment author must be a `User` with current write, maintain or admin permission (#215, the #212 rule through `TrustDecision`); unknown permission refuses `MARKER_UNVERIFIED`. The `--agent` name is reported, not authenticated.
- **No claim, no prior record.** It needs neither a claim nor an existing responsibility record, and it never creates a claim, writes an `agent:` label or changes `status:awaiting-review`.
- **Eligibility.** The issue has a trusted v1 `done` release record and no trusted delivery record yet (otherwise ordinary `attach` applies; refusal `LEGACY_NOT_APPLICABLE`). It refuses `CLAIM_HELD` if any agent other than the caller holds an active `agent:` claim on the issue: that agent owns the work and must attach or release it. A claim held by the caller is allowed but the ordinary `attach` is suggested.
- **Visibility.** It appends one record with `op: "legacy-attach"`, naming the attaching agent, the authenticated GitHub login of the author (from evidence), the cited v1 release record's comment id, and a mandatory `reason`. Briefings, Doctor and history display it as "legacy attachment by AGENT (LOGIN)". Ordinary link checks (`TARGET_MISMATCH`, `EVIDENCE_INCOMPLETE`) apply; merged PRs are accepted.
- **Responsibility.** The record names the attaching agent as `responsible`, so later `detach`, `retarget` and `handoff` follow the ordinary rules. Membership defaults to `complete` only when stated; `--membership open` keeps the ticket undeliverable until a later record closes it.

**Who may run `complete`.** Any agent with write authority, not only the responsible agent: completion is a factual check, the predicate is the gate, and the S1 case shows waiting for a specific agent can block downstream work indefinitely. The responsible agent is the one the briefing addresses.

**Merge authority** is unchanged. The tool does not merge and grants nobody new merge powers. #182 may rank "inspect and merge when eligible" for the responsible agent only where existing policy already authorises that agent, with fresh head, protection and ownership checks.

### Rework authority

The existing `claim --rework` prerequisite (src/claims.ts:723-730) accepts only the caller's own v1 `done` handoff. That would strand an agent who received responsibility by `deliverables handoff`: it has no `submit` or `done` record of its own, ordinary pickup excludes `status:awaiting-review` tickets, and D6 requires `claim --rework` for replacement or new scope. #190 therefore widens the prerequisite. `claim N --rework --agent A` is authorised by any one of these trusted records on the issue:

- A's own v1 `done` release record (unchanged).
- A's own `submit`, `attach` or `legacy-attach` delivery record, provided A is still `responsible` for at least one deliverable it recorded (a later handoff away removes this authority).
- A `handoff` delivery record whose `to` names A, provided it is the newest responsibility record (`submit`, `attach`, `legacy-attach` or `handoff`) for that deliverable and no later `handoff` moves responsibility away from A. A stale handoff, superseded by a later transfer, never authorises.

Every qualifying record must pass the [authority rule](#records-storage-versioning-and-authority) (#212, #215): author and any editor a `User` with current write, maintain or admin permission, through `TrustDecision`. When the permission of the qualifying record's author is unknown, or `recordsUnknown(t)` is true for the deliverable, `claim --rework` refuses `MARKER_UNVERIFIED`; it never falls back to an older record. All other claim checks stay: single active claim per agent, refusal when another agent holds a claim on the issue, the claim-time freshness checks, and the shared-account caveat that `--agent` is a reported name. On success `status:awaiting-review` is removed and delivery records are untouched; responsibility is unchanged.

The same responsibility rule governs every other prerequisite that names a single agent. `attach`, `detach`, `retarget`, `handoff` and `attest` accept the caller when it holds the claim or is `responsible` on the current fold, which already includes a trusted inbound handoff; the original submitter loses these rights once it hands responsibility away. `complete` is not tied to the submitter: any agent may run it when the fresh evaluation is `delivered`.

## Default completion policy

A ticket is **delivered** when all of the following hold on fresh evidence:

1. The trusted required set is non-empty and its membership is `complete`.
2. Every member is `merged` into its intended target (PR), or contained in the target branch (commit).
3. No member, record or record author is `unknown`, and the record history read was complete.

`attested` is a separate success outcome for trusted non-code records. It is reported as attested, never as verified delivery, and holds only when the attestation applies (below). When any member or record is unknown the verdict is `unknown` ([precedence](#delivery-axis-derived-per-deliverable-then-per-ticket)) and the explanation names the evidence to re-read. Otherwise everything else is not delivered, with the failing clause and the positively observed state of each outstanding member named in the explanation.

### Attestation applicability

An attestation satisfies delivery only when, on fresh evidence, either the trusted required set is empty and its membership is `complete`, or every required member is itself resolved (`mergedIntoTarget`), with no member or record unknown. An attestation never stands in for an outstanding required deliverable:

- `attest` with any required member not resolved is refused `ATTEST_NOT_APPLICABLE`, naming each outstanding member and the recovery (`deliverables detach --reason` or deliver it first). With membership `open` it is refused the same way, naming the open membership. With an unknown member or `recordsUnknown(t)` it refuses `EVIDENCE_INCOMPLETE` or the record refusal, never `ATTEST_NOT_APPLICABLE` on guessed state.
- Applicability is re-evaluated on every read, not frozen at attest time. An attestation recorded before members were attached does not count while any of those members is outstanding; the ticket evaluates from its required set as usual, and `attested` returns only when the set again satisfies the rule. Release is not part of the default (D11). For this repository the default target is therefore the default branch, `main` at the time of writing, read live.

## Outcomes other than a merged PR

| Outcome                                   | Handling                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct commit                             | `commit` deliverable verified by containment in the target branch. Accepted, less preferred; reported as such.                                                                                                                                                                |
| Non-code (research decision, admin task)  | `attest` record by a trusted author with a reason and optional evidence link, accepted only when [attestation applies](#attestation-applicability). Ticket delivery `attested`. Research and design tickets that produce a docs PR use the ordinary PR path, not attestation. |
| Required PR closed unmerged               | Ticket not delivered. Recovery is explicit: `detach` with a reason (and attach a replacement if any), never silent removal.                                                                                                                                                   |
| PR merged into another branch             | `merged-off-target`; not delivered. Recovery: merge onward to the target, or `retarget` with a reason when the other branch really is intended.                                                                                                                               |
| Issue closed `NOT_PLANNED` or `DUPLICATE` | Closure reported as not delivered. Never reopened. Open required PRs become cleanup attention for their responsible agent (close or explain). No record is required to respect the closure.                                                                                   |
| Issue closed `COMPLETED` without delivery | Reported as a discrepancy ("closed, delivery not verified") in Doctor for tickets with a delivery record only. Not evidence of unauthorised closure, never reversed.                                                                                                          |
| Cancellation by an agent                  | Agents do not cancel tickets. They release, park or raise `needs-human`. A closure by the shared account is reported as an actor login, not as a human decision.                                                                                                              |

## Rule and fact interface

Policy is data; collection and enforcement are TypeScript. The convention follows the [rules spike](../reports/examples/rules-spike/rules.ts) and its [report](../reports/rules-language-spike.md): registered facts each carry a TypeScript test, an EDN clause and an English phrase; rules are records `{id, modality, action, when, reason}` that only name facts.

**Facts** (registered; each has an `unknown` companion that the evaluator sets when evidence is missing):

| Fact                                       | Meaning                                                                                                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `required(t, d)`                           | trusted fold lists `d` as required for ticket `t`                                                                                                                           |
| `membershipComplete(t)`                    | the fold's latest membership statement is `complete`                                                                                                                        |
| `mergedIntoTarget(d)`                      | `d` merged (or contained) in its intended target                                                                                                                            |
| `notYetMerged(d)`                          | positively observed open or draft (not merged, not closed)                                                                                                                  |
| `mergedOffTarget(d)`                       | positively observed merged elsewhere                                                                                                                                        |
| `closedUnmerged(d)`                        | positively observed closed without merge                                                                                                                                    |
| `findingOnHead(d)`                         | failing check, changes requested, unresolved thread or conflict, current head                                                                                               |
| `acceptedOnHead(d)`                        | green and approved on the current head                                                                                                                                      |
| `evidenceUnknown(d)` / `recordsUnknown(t)` | unreadable, missing or unverified evidence (set whenever none of `mergedIntoTarget`, `notYetMerged`, `mergedOffTarget`, `closedUnmerged` is positively established for `d`) |
| `memberUnknown(t)`                         | some required member of `t` has `evidenceUnknown`                                                                                                                           |
| `responsible(a, d)`                        | trusted responsibility                                                                                                                                                      |
| `attestRecord(t)`                          | a trusted `attest` record exists                                                                                                                                            |
| `attested(t)`                              | `attestRecord(t)` and the attestation applies (derived, below)                                                                                                              |
| `issueOpen(t)`, `closedNotPlanned(t)`      | closure facts                                                                                                                                                               |

**Completion predicates** (Datalog-style, stratified negation; `undelivered` and `partial` hold only from positive `outstanding` evidence and never when `unknown(T)`, and `delivered` additionally requires every member `mergedIntoTarget` because any member with no positive state is `evidenceUnknown`; the compiled TypeScript evaluator is normative, the EDN form is the cross-check used by tests):

```text
% Negative member states come only from positive evidence.
outstanding(D)  :- notYetMerged(D).
outstanding(D)  :- mergedOffTarget(D).
outstanding(D)  :- closedUnmerged(D).
memberUnknown(T):- required(T, D), evidenceUnknown(D).
unknown(T)      :- memberUnknown(T).
unknown(T)      :- recordsUnknown(T).
undelivered(T)  :- required(T, D), outstanding(D), not unknown(T).
hasMember(T)    :- required(T, _).
delivered(T)    :- hasMember(T), membershipComplete(T), not unknown(T),
                   not undelivered(T).
attestApplies(T):- membershipComplete(T), not unknown(T), not undelivered(T).
attested(T)     :- attestRecord(T), attestApplies(T).
partial(T)      :- required(T, D), mergedIntoTarget(D), undelivered(T).
```

**Action rules** (records, examples; #182 owns their ordering):

| ID  | Modality   | Action      | When                                                               | Reason                                                                         |
| --- | ---------- | ----------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| L1  | `must`     | `follow_up` | `responsible(viewer, d)`, `findingOnHead(d)`                       | Fix findings on your own submitted PR before new work.                         |
| L2  | `must`     | `integrate` | `responsible(viewer, d)`, `acceptedOnHead(d)`                      | Refresh, update or merge an accepted PR where authorised.                      |
| L3  | `may`      | `complete`  | `delivered(t)`, `issueOpen(t)`                                     | Delivery verified; record completion so dependants unblock.                    |
| L4  | `inspect`  | `complete`  | `unknown(t)` (`memberUnknown(t)` or `recordsUnknown(t)`)           | Delivery evidence is unknown; re-read it before deciding.                      |
| L5  | `must_not` | `complete`  | `undelivered(t)` (positive `outstanding(d)`, not `unknown(t)`)     | A required deliverable is observed open, closed unmerged or merged off target. |
| L5a | `must_not` | `complete`  | `unknown(t)`                                                       | Delivery cannot be verified; re-read the unknown evidence.                     |
| L6  | `must`     | `cleanup`   | `responsible(viewer, d)`, `closedNotPlanned(t)`, `notYetMerged(d)` | Close or explain your PR for a ticket closed as not planned.                   |
| L7  | `inspect`  | `attach`    | legacy handoff, no trusted delivery record                         | Required deliverables were never recorded.                                     |

**Boundaries.** `collectDeliveryFacts(issue, records, gh, trust, clock)` returns facts plus coverage and omissions. `evaluateDelivery(facts)` is pure and returns `{delivery, perDeliverable, because, overrides}`. `complete` calls the same evaluator and refuses when it does not return `delivered` or `attested`; an `unknown` verdict refuses with recovery to re-read the named evidence, never to merge or detach. Authority (the `TrustDecision`) is an input to fact collection, never a fact the policy can override.

## Partial failures, retries and concurrency

- **Record first.** `submit` and `complete` post their record before any label or state write, as release does today. The record carries the planned label and close operations, so a retry completes exactly the recorded plan or refuses with `DELIVERY_DIVERGED` when the observed state contradicts it. Changes made by others are never reverted.
- **`opId`** makes retries idempotent: a trusted record with the same `opId` means the record step is done.
- **Per-member read failures** at attach leave that member out of the record and refuse the command with `EVIDENCE_INCOMPLETE`; nothing is recorded as verified on a partial read. At evaluation time they make the member `unknown`.
- **`complete` races.** If the issue is closed by someone else between the record and the close, the close step is skipped and reported. If evaluation changes between the check and the write (a member reverted or detached), the next run reports the discrepancy; the record stores the evidence snapshot (merge commit per member) so the decision is auditable.
- **Concurrent attachments** append separate records and fold in comment order; two writers never edit one shared record.
- **Truncated comment history** makes `recordsUnknown(t)` true.
- Every mutation result enumerates applied, skipped and failed steps; one command is not a GitHub transaction.

## Source compatibility and migration

| Current source                                                                                          | Maps to                                                                                                                                                                                                                | Status                                                                                                    |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `release --as done --pr URL` (open PR)                                                                  | Legacy contribution-done. After #190, it is accepted for one deprecation period and prints the equivalent `submit` command; it writes a release record only, never a delivery record.                                  | Deprecated in favour of `submit`. Removal needs a later reviewed change.                                  |
| `release --as done` without PR, or `--change URL`                                                       | Legacy contribution-done "for inspection" (unchanged behaviour). Recovery: `deliverables attach` (PR or commit) or `attest`.                                                                                           | Kept; help points to `submit`/`attest`.                                                                   |
| `release --as ready\|incomplete\|parked`                                                                | Unchanged activity transitions. `--as parked` still writes `status:incomplete`; its help names the distinction from the `status:parked` hold label.                                                                    | Kept.                                                                                                     |
| v1 release record (`done`)                                                                              | Still authorises `claim --rework` as today. Never yields delivery membership; the PR URL in its prose is never parsed.                                                                                                 | Kept, read-only.                                                                                          |
| `claim --rework`                                                                                        | Substantive rework (D6). Accepts a trusted v1 `done` record by the caller, or a trusted delivery record making the caller currently responsible, including an inbound handoff ([Rework authority](#rework-authority)). | Kept.                                                                                                     |
| `status:awaiting-review`                                                                                | Coarse "submitted, not pickable" marker (D7). Set by `submit`, removed by `complete` and by `claim --rework`.                                                                                                          | Kept; documentation stops calling it a review state.                                                      |
| `agent:NAME`                                                                                            | Active claim only. Never used to express responsibility.                                                                                                                                                               | Kept.                                                                                                     |
| `linkedMine` (`agent:` on PR or issue)                                                                  | Extended with `responsible(viewer, d)` from trusted records (#192 for reads, #182 for sections).                                                                                                                       | Extended.                                                                                                 |
| Doctor `awaiting-review-without-pr`, `ready-with-open-pr`                                               | Replaced by delivery-aware checks that name the merged or closed PR and address the responsible agent, or suggest `deliverables attach` for legacy tickets (#192).                                                     | Superseded when #192 ships.                                                                               |
| Rule spike R2 (`mine ∧ hasOpenPr`)                                                                      | Replaced by L1/L2 over `responsible`.                                                                                                                                                                                  | Superseded in the spike when #182 integrates.                                                             |
| process.md "One ticket, one PR"                                                                         | Default kept (D12); multi-PR required sets are the explicit exception.                                                                                                                                                 | Wording amended when #190 ships.                                                                          |
| process.md step 5 ("merge once verify passes") and step 7 ("After merging: remove your `agent:` label") | Become: submit (releasing the claim), follow up as the responsible agent, merge only where authorised, then `complete`.                                                                                                | Amended in the #190 PR together with the command, so prose never names a command that does not exist yet. |
| "The tool never closes or reopens issues"                                                               | Narrowed: `complete` may close after verified delivery; nothing reopens.                                                                                                                                               | Amended by this contract; effective when #191 ships.                                                      |

**Migration.** No bulk or live migration is performed by any ticket. Legacy tickets are handled one at a time:

1. An open `status:awaiting-review` ticket with only a v1 handoff evaluates `legacy`; Doctor (#192) offers `deliverables N attach --legacy --pr URL --reason TEXT` naming linked closing PRs as **candidates**, never as inferred membership.
2. An author with current write/maintain/admin permission attaches explicitly through [legacy attachment](#legacy-attachment), with no claim and no prior responsibility (membership `complete` only when they know the set); it is refused while another agent holds an active claim. Then `complete` verifies.
3. Closed historical tickets without delivery records are out of Doctor's drift scope by default; Doctor checks only tickets with a delivery record, or an explicitly bounded `--since` window, so history does not flood the report.
4. Any future bulk attachment tool requires its own reviewed plan and a dry run; it is not part of #189–#192.

## Scenario matrix

S1–S11 are the mapping report's fixtures; S12 onward are added here. Each becomes an injected fixture in the owning ticket.

| ID  | Setup                                                                                              | Expected                                                                                                                                                                                                                                      | Owner            |
| --- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| S1  | v1 `done` with PR (now merged, no closing keyword); issue open, awaiting-review; dependant blocked | `legacy`; Doctor names the merged PR as an attach candidate; a write-permission author runs `attach --legacy` (no claim, visible `legacy-attach` record naming them), then `complete` closes the issue `completed` and the dependant unblocks | #189, #191, #192 |
| S2  | A submits #X, claims #Y; #X PR gets changes requested                                              | L1 addressed to A; A fixes on the PR branch without dropping #Y (D6); no reclaim                                                                                                                                                              | #190, #182       |
| S3  | Two required PRs in R1 and R2; R1 merged, R2 open                                                  | `partial`, R2 named; `complete` refused even if R1 closed the issue                                                                                                                                                                           | #191             |
| S4  | Required PR merged into a feature branch                                                           | `merged-off-target`; not delivered; recovery names onward merge or `retarget`                                                                                                                                                                 | #191             |
| S5  | Issue closed `NOT_PLANNED` with an open required PR                                                | closure reported not delivered; L6 cleanup to the responsible agent; no reopen                                                                                                                                                                | #192             |
| S6  | Direct commit                                                                                      | `commit` deliverable; delivered when contained in the target branch                                                                                                                                                                           | #189, #191       |
| S7  | `submit` with a PR from another repository or a different base branch                              | refused `TARGET_MISMATCH` unless `--target` states it; missing closing link is a warning                                                                                                                                                      | #189, #190       |
| S8  | Required PR unreadable                                                                             | member `unknown`; ticket `unknown`; `complete` refused                                                                                                                                                                                        | #191             |
| S9  | Accepted PR, mergeability UNKNOWN or BEHIND                                                        | L2 integration action ranked ahead of pickup                                                                                                                                                                                                  | #182             |
| S10 | Delivery record by an author without write permission                                              | shown as "unverified record by LOGIN, ignored"; fold excludes it                                                                                                                                                                              | #189             |
| S11 | `submit` record posted, label write failed                                                         | retry completes the recorded plan or refuses `DELIVERY_DIVERGED`                                                                                                                                                                              | #190             |
| S12 | Delivery record author permission lookup errors                                                    | mutations refused `MARKER_UNVERIFIED`; reads report `unknown`                                                                                                                                                                                 | #189             |
| S13 | Record copied from another issue                                                                   | rejected by repository/issue binding                                                                                                                                                                                                          | #189             |
| S14 | `detach` of the only unmerged member without a reason                                              | refused; with a reason, recorded and visible in history                                                                                                                                                                                       | #189             |
| S15 | Membership `open`, all listed members merged                                                       | not delivered; explanation names open membership                                                                                                                                                                                              | #191             |
| S16 | Issue closed `COMPLETED` by the shared account, required PR open                                   | Doctor discrepancy "closed, delivery not verified", actor reported as login; no reopen                                                                                                                                                        | #192             |
| S17 | `complete` while someone else closes the issue                                                     | record kept, close skipped and reported                                                                                                                                                                                                       | #191             |
| S18 | Agent responsible for three waiting PRs claims new work                                            | allowed; no hard or soft limit; inventory and age shown                                                                                                                                                                                       | #190, #192       |
| S19 | Two agent names on the shared account; B runs `handoff` for A's deliverable                        | refused unless B is the responsible name; names reported, not authenticated                                                                                                                                                                   | #189             |
| S20 | Non-code ticket attested (no required members, membership complete)                                | delivery `attested`, reported separately; `complete` may close                                                                                                                                                                                | #191             |
| S21 | `claim --rework` after a `submit`                                                                  | allowed for the submitter; awaiting-review removed; records unchanged                                                                                                                                                                         | #190             |
| S22 | Truncated comment history                                                                          | `recordsUnknown`; nothing delivered or refused as "not delivered"                                                                                                                                                                             | #189, #191       |
| S23 | Trusted delivery record whose JSON payload is malformed or fails validation                        | `recordsUnknown`, reported "malformed delivery record by LOGIN"; mutations refuse `RECORD_MALFORMED`; `complete` refused; never `delivered`                                                                                                   | #189, #191       |
| S24 | Trusted delivery record with an unsupported future version                                         | `recordsUnknown`; mutations refuse `RECORD_UNSUPPORTED`; `complete` refused; never `delivered`                                                                                                                                                | #189, #191       |
| S25 | Delivery record (parsable or not) whose author permission is unknown                               | `recordsUnknown`; mutations refuse `MARKER_UNVERIFIED`; reads `unknown`; `complete` refused                                                                                                                                                   | #189, #191       |
| S26 | Malformed or future-version record by a verified non-writer                                        | listed as "unverified record by LOGIN, ignored"; fold unaffected; does not block `complete`                                                                                                                                                   | #189             |
| S27 | `attach --legacy` while another agent holds an active claim on the issue                           | refused `CLAIM_HELD`; no record written                                                                                                                                                                                                       | #189             |
| S28 | `attach --legacy` by an author without write permission, or on an issue with no v1 `done` record   | refused `MARKER_UNVERIFIED` / `LEGACY_NOT_APPLICABLE`; no record written                                                                                                                                                                      | #189             |
| S29 | A submits #X, then `deliverables handoff --to B`; changes need a replacement PR                    | B runs `claim --rework`: allowed on the trusted current handoff; awaiting-review removed; B responsible, A not                                                                                                                                | #190             |
| S30 | A hands #X to B, then B hands it to C; B runs `claim --rework` (or A does)                         | refused: the handoff to B is stale and A's submit is superseded; only C qualifies                                                                                                                                                             | #190             |
| S31 | A hands #X to B; the handoff author's permission lookup fails                                      | B's `claim --rework` refused `MARKER_UNVERIFIED`; no fallback to an older record                                                                                                                                                              | #190             |
| S32 | Two required PRs: one merged into target, the other unreadable (permission denied or rate-limited) | ticket `unknown`, not `partial`; L4/L5a, no L5; `complete` refused; recovery says to re-read the unreadable PR (retry, check access), never "merge it"                                                                                        | #191             |
| S33 | `attest` while a required PR is open                                                               | refused `ATTEST_NOT_APPLICABLE`, naming the open PR with `detach --reason` or delivery as recovery; no record written                                                                                                                         | #189             |
| S34 | `attest` recorded with an empty complete set; later a PR is attached and is open                   | attestation no longer applies; ticket `submitted`; `complete` refused until the PR merges or is detached                                                                                                                                      | #189, #191       |
| S35 | `attest` with an empty, complete set, or after every required member merged                        | accepted; delivery `attested`; `complete` may close                                                                                                                                                                                           | #189, #191       |

## Rollout and focused-ticket criteria

Order: this contract → #189 → (#190 ‖ #191) → #192, with #182 consuming #190's responsibility facts. Each ticket stays `status:needs-design` until this document merges, then becomes ready subject to its native prerequisites. Each lands behind no flag: new commands are additive and old commands keep working, so there is no switch-over moment.

**#189 deliverable records.** Implement the `github-triage:delivery v1` record kind, its fold, and `deliverables attach | detach | retarget | handoff | attest`; the deliverable identity and target model; attach-time link checks (S7); #212 authority with the injected `TrustDecision` (S10, S12, S13, S19); replay binding; append-only concurrency; the recognized-record classification (malformed, unsupported version, unknown authority all set `recordsUnknown`; `RECORD_MALFORMED`, `RECORD_UNSUPPORTED`); [legacy attachment](#legacy-attachment) (`attach --legacy`, `legacy-attach` record, `CLAIM_HELD`, `LEGACY_NOT_APPLICABLE`); attestation applicability (`ATTEST_NOT_APPLICABLE`). Fixtures S1 (legacy-attach half), S6, S7, S10, S12–S14, S19, S22–S28, S33–S35. No completion, ranking or Doctor changes.

**#190 submit and responsibility.** Implement `submit` (record first, then release the caller's claim and set `status:awaiting-review`), `opId` retry and `DELIVERY_DIVERGED` (S11); `responsible` facts; `claim --rework` accepting a trusted `submit` or a current inbound `handoff` per [Rework authority](#rework-authority), with `MARKER_UNVERIFIED` on unknown authority (S21, S29–S31); deprecation notice on `release --as done --pr`; the process.md step 5/7 and one-PR wording amendments; command help and JSON schemas. Fixtures S2 (routing half), S11, S18, S21, S29–S31. No evaluator or closing.

**#191 completion.** Implement `collectDeliveryFacts`, the pure `evaluateDelivery` from the rule records above (TypeScript normative, EDN cross-check in tests), and `complete` with its write order, race handling and evidence snapshot. Fixtures S1 (completion half), S3, S4, S6, S8, S15, S17, S20, S22–S25 (`complete` refused when `recordsUnknown`), S32, S34, S35. Release-required evaluation is excluded.

**#192 diagnostics and reads.** Add `delivery`, `responsibility` and `closure` to briefing JSON, `pr`, `who`, `team`, Ticket Doctor and the MCP read tools with parity; replace the two legacy Doctor checks; legacy attach candidates; drift scoped to recorded deliveries or a bounded window (S16); closure discrepancies and cleanup attention (S5). Optional polling kinds (`delivered`, `closed-not-delivered`, `responsibility-attention`) are a separate enhancement. Fixtures S1 (Doctor half), S5, S16, S18 (display).

**#182 ranking.** Order actions per the #186 report, using L1/L2/L6 over `responsible` instead of `agent:` only; current-head acceptance in the briefing; UNKNOWN/BEHIND as integration actions (S9); waiting never blocks pickup. Merge stays limited to existing authorisation. #182 does not define delivery states; it consumes #191's evaluator output when available and the `responsible` facts from #190.

**#155 / #205 authority.** No new scope here. #189–#191 consume the merged #212 rule through `TrustDecision`; #205's demonstration may later replace that implementation, and per-message authorisation records never authorise delivery membership on their own.

## Release-required completion (separate extension)

Not part of the baseline and not scheduled by this contract. If wanted, a future ticket would add a registered config key (for example `delivery.requireRelease`, default false), a `release` association record naming an artifact (tag, GitHub release or package version) and the deliverables it contains, and a fact `releasedContaining(d)` verified by tag containment. A GitHub release or tag is never equated with npm publication ([npm releases](../npm-releases.md)); publication evidence would need its own collector. Absence of the extension never blocks `delivered`.

## Resolution of the report questions

The ticket and its final comment ask for these to be resolved concretely in this review; none needed a further owner decision.

| Question                                 | Resolution                                                                                                                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #186 Q1 Responsibility transfer or lapse | Explicit `handoff` only. No inactivity lapse (owner: no automatic expiry or takeover).                                                                                                                                                           |
| #186 Q2 Soft limit on pending PRs        | None now. Inventory count and age are shown (#192); revisit with #182 data.                                                                                                                                                                      |
| #186 Q3 Who merges                       | Unchanged existing authorisation with fresh head and protection checks; no new merge powers.                                                                                                                                                     |
| #186 Q4 Definition of ready enforcement  | Not added; out of scope per the ticket.                                                                                                                                                                                                          |
| #186 Q5 Default done for this repository | Merged to the default branch (`main`); npm release optional and separate.                                                                                                                                                                        |
| #187 Q1 Rework without a claim           | D6: follow-up on one's own submitted PR needs no claim; substantive rework keeps `claim --rework`.                                                                                                                                               |
| #187 Q2 `status:awaiting-review`         | D7: kept as coarse marker.                                                                                                                                                                                                                       |
| #187 Q3 Integration target               | Default branch read live; explicit per-deliverable `--target`; no config key now.                                                                                                                                                                |
| #187 Q4 Legacy tickets                   | D8: explicit `deliverables attach --legacy` by a write-permission author, no claim needed, with Doctor naming candidates.                                                                                                                        |
| #187 Q5 One ticket, one PR               | D12: default kept; multi-PR sets are the explicit exception.                                                                                                                                                                                     |
| Coordinating/local tickets               | Evaluated, not mandated. Cross-repository PRs attach directly to the one ticket. A per-repository local ticket remains an ordinary ticket linked by native dependencies; making it a deliverable kind is deferred until a concrete need appears. |
