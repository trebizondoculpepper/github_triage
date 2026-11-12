> Extracted from poker_blocks on 2026-11-12. Issue numbers in this inherited design refer to that repository; see [the handoff](../HANDOFF.md) for new issue numbers. Source paths `scripts/triage/` now mean `src/`. Target features may still be pending.

# Issue dependencies (#703)

Ticket dependencies are recorded as **GitHub's built-in issue dependencies** ("blocked by" / "blocking"). GitHub computes whether a ticket is blocked, so no agent has to remember to relabel a ticket when its last blocker closes. This page records that decision, the label meanings that follow from it, the triage CLI commands that read and write dependencies, and the one-time migration from `Depends on #N` text.

## Decision

The owner decided on 2026-11-12 (#703): use GitHub's dependency system as much as possible, so that blockers are calculated by GitHub.

- **Native dependencies are the single source of truth.** "Ticket A waits for ticket B" is recorded only as "A is blocked by B". `Depends on #N` text in an issue body is no longer authoritative. It is input to the migration and, afterwards, a drift warning (see "Drift").
- **`status:blocked` now means blocked for a reason other than a dependency**: a credential, testing, design input or similar, named by a `blocked:*` reason label. A ticket that waits only on other tickets keeps its ordinary readiness label, and GitHub shows it as Blocked.
- **`blocked:work` retires.** It said "waits on other work", which native dependencies now express.

## Evidence

Probes against this repository on 2026-11-12, with `gh` 2.102.0:

| Claim                                                  | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native dependencies are available here and were unused | `gh issue view 675 --json blockedBy,blocking` returned empty lists, although the #675 body says it depends on #673 and #674.                                                                                                                                                                                                                                                                                                                                                        |
| `gh` can write them without new credentials            | `gh issue edit --help` lists `--add-blocked-by`, `--remove-blocked-by`, `--add-blocking` and `--remove-blocking`, taking issue numbers or URLs. `gh issue edit 675 --add-blocked-by 674,673` succeeded.                                                                                                                                                                                                                                                                             |
| GitHub counts only **open** blockers                   | After that edit, #675's `issueDependenciesSummary` was `{blockedBy: 1, totalBlockedBy: 2}`, because #673 is closed and #674 is open. #524, given only its closed blocker #523, reported `{blockedBy: 0, totalBlockedBy: 1}`.                                                                                                                                                                                                                                                        |
| Search filters on the computed state                   | `gh issue list --search is:blocked` returned `[675]` but not #524. `--search "label:status:ready -is:blocked"` returned ready tickets. `is:blocking` returned `[674]`. `blocked-by:674` is **not** a working qualifier: it returned nothing.                                                                                                                                                                                                                                        |
| A pull request cannot be a blocker                     | GraphQL `addBlockedBy` with a PR's node ID failed with "Could not resolve to Issue node". `AddBlockedByInput` takes `issueId` and `blockingIssueId`, both issue IDs.                                                                                                                                                                                                                                                                                                                |
| REST surface                                           | [REST: issue dependencies](https://docs.github.com/en/rest/issues/issue-dependencies) lists `GET/POST …/issues/{n}/dependencies/blocked_by`, `DELETE …/blocked_by/{issue_id}` and `GET …/blocking`, paginated up to 100 per page. It warns that POST and DELETE may trigger secondary rate limits. The UI and `gh` usage are described in [Creating issue dependencies](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/creating-issue-dependencies). |
| Current labels                                         | 48 open tickets carry `status:blocked`, and 46 of them carry `blocked:work`. Only #480 (`blocked:credential`) and #328 (`blocked:testing`) are blocked for another reason.                                                                                                                                                                                                                                                                                                          |
| Current tool                                           | `scripts/triage/github.js` `declaredDependencies` parses `Depends on`, `Blocked by` and `Requires` sentences and dependency sections from body text. `scripts/triage/briefing.js` rules `ready-dependencies` and `dependencies` resolve those references, and the text briefing prints them as a flat "Declared dependencies" list.                                                                                                                                                 |

The #675 and #524 dependencies were real declared blockers, recorded as live evidence. Each ticket has a comment saying so.

**Limits.** Neither the GitHub documentation nor the probes establish a maximum number of blockers per ticket, or whether cross-repository blockers are allowed. The implementation must handle a refusal from GitHub (HTTP 422, or a GraphQL error) as a reported failure, not a silent skip.

**Alternatives considered.** Keeping `Depends on` text, made stricter, still needs parsing, can't be seen in GitHub's UI and can't be searched. Keeping `blocked:work` as a mirror of the native state needs a sync step that can fall behind; that was the problem the owner asked to remove.

## Label meanings

Every open ticket that isn't claimed still has exactly one readiness label. What changes is that a dependency no longer needs one of its own:

| Ticket state                                            | Labels                                                                          | GitHub state                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------- |
| Can start now                                           | `status:ready`                                                                  | not blocked                 |
| Will be ready once its blockers close                   | `status:ready`                                                                  | **Blocked** (open blockers) |
| Waits on a credential, testing, design input or similar | `status:blocked` plus one or more `blocked:*` reasons, and a comment saying why | either                      |
| Needs a design or answers first                         | `status:needs-design` (plus `question`)                                         | either                      |
| Deliberately deferred                                   | `status:parked`                                                                 | either                      |

**Pickable** means `status:ready`, no `agent:` label, and not `is:blocked`. Agents find candidates with:

```sh
gh issue list --search "label:status:ready -is:blocked"
```

then skip any carrying another agent's `agent:` label. `npm run triage` applies all three conditions for you.

When a blocker closes, its dependants become pickable **with no label change**. That is the automatic status update the owner asked for. `status:blocked` without at least one `blocked:*` reason label is a labelling error. Other `blocked:*` reasons can be added when needed; each is a label and needs the "why" comment.

## Triage CLI: dependency commands

These extend `npm run triage` ([contract](github-triage-cli.md)). The read command keeps that contract's read-only guarantees. Commands that change GitHub follow "Rules for commands that change tickets" below, which #701 reuses for claiming and flagging.

### `deps <N>`: show a ticket's dependencies (read-only)

```sh
npm run triage -- deps 675 [--tree] [--json]
```

- **Upstream:** each blocker with its state (open, closed as completed, closed as not planned), plus a verdict:
  - _pickable_;
  - _waiting on #…_;
  - _a blocker was closed as not planned_: a person should check whether the dependency still makes sense, since GitHub counts the blocker as closed.
- **Downstream:** the tickets this one blocks, and which of them it is the **last** open blocker for. Those become pickable when it closes.
- **Drift:** `#N` references in `Depends on` text that aren't recorded as native blockers.
- `--tree` follows the chain transitively, prints each ticket once and reports any cycle.

### `deps add` and `deps remove`: change dependencies

```sh
npm run triage -- deps add 675 --on 674 [--on 673] --note "why" [--dry-run]
npm run triage -- deps remove 675 --on 674 --note "why" [--dry-run]
```

- Validates first. It refuses a self-dependency, a pull request as a blocker (name the issue it closes instead), a blocker that doesn't exist, and an edge that would create a cycle; cycles are checked with a live upstream walk from the blocker. Adding an edge that already exists is a no-op, reported as such.
- It applies the change with `gh issue edit --add-blocked-by` or `--remove-blocked-by`, then posts one comment on the blocked ticket naming the change and the `--note`.
- It changes no labels. Being blocked is GitHub's job.

`gh issue edit` used directly is also acceptable. The CLI adds validation, cycle checks and the explanatory comment.

### Briefing changes

- **Pickup and "ready / unclaimed"** list only pickable tickets. Ready tickets that are still blocked appear as "ready when #… closes".
- **Unblock ranking:** order pickup by how many tickets would lose their last open blocker if this one were done, read from `blocking` and each dependant's `issueDependenciesSummary.blockedBy`. #700's roles use the same ranking.
- **Dependencies grouped by ticket:** replace the flat "Declared dependencies" URL list with per-ticket upstream and downstream lists.
- **Label checks:**
  - `status:blocked` with no `blocked:*` reason;
  - `blocked:work` still present after migration;
  - a native blocker closed as not planned;
  - drift between `Depends on` text and native blockers.
- Body-text parsing (`declaredDependencies`) is used only for migration and drift. It no longer decides readiness.

## Migration

A one-time migration converts existing `Depends on` text and `blocked:work` labels, in two steps. The plan step reads only. The apply step changes GitHub, and applies only a plan a person has reviewed.

```sh
npm run triage -- deps migrate --plan migration.json        # read-only: writes the plan and prints a summary
npm run triage -- deps migrate --apply migration.json [--dry-run]
```

### Plan (read-only)

For every open issue, the plan records:

- **Edges:** each reference `declaredDependencies` finds, resolved live.
  - An issue reference becomes a proposed edge, including a blocker that is already closed. Closed blockers keep their history and count in `totalBlockedBy`, and they don't block.
  - A pull request reference is mapped to the issues the PR closes (`closingIssuesReferences`). A merged PR that closes no issue is reported as already satisfied and dropped. An open PR that closes no issue goes to review.
  - Cross-repository references, missing targets and self-references go to review.
- **Labels:**
  - `blocked:work` with another `blocked:*` reason: remove `blocked:work` and keep `status:blocked`.
  - `blocked:work` alone: swap `status:blocked` for `status:ready`. Its open blockers keep it Blocked in GitHub, and it becomes pickable automatically when they close.
  - `blocked:work` alone, but **no** open edge found: review. The comments may name a blocker the parser missed, so the ticket is not made pickable automatically.
- **Status of each row:**
  - `apply` when the reference came from an explicit `Depends on`, `Blocked by` or `Requires` sentence or a dependency section, and resolved cleanly;
  - `review` otherwise, with the reason.

  Each row records the ticket's `updatedAt` at planning time.

The plan is a JSON file (versioned schema) plus a printed summary grouped into `apply` and `review`. The reviewer, who may be the owner, a designer agent or an implementer, edits the JSON: changing a row's status, removing an edge, or adding a missed one. Body text such as "optional", "coordinate with" or "after #N" is never treated as a blocker without review.

### Apply

- Rows with status `apply` only, in issue-number order, one at a time. It paces requests and stops on a secondary rate-limit response rather than retrying in a hurry.
- **Progress journal.** Apply keeps a journal file beside the plan (`<plan>.progress.json`). For each ticket it records each step as it completes (edges, then labels, then comment) and the ticket's `updatedAt` as GitHub reports it after the tool's own last write.
- **Change guard.** Before changing a ticket, it re-reads it live. The expected `updatedAt` is the journal's value if the ticket has a journal entry, otherwise the plan's. If the live value differs, someone else edited the ticket: it skips the ticket and reports that it changed since planning, or since the last partial apply.
- **Idempotent retry.** Re-applying the same plan resumes from the journal: completed steps are skipped, and existing edges and labels that already match are skipped. A run that changed labels but failed to post the comment therefore finishes by posting the comment, rather than tripping the change guard on its own edit.
- For each ticket it changes, it adds the edges, swaps the labels, then posts **one** comment listing the recorded blockers and label changes and linking #703.
- **It leaves issue bodies unchanged.** The old text stays as history, and `deps` reports any drift.
- It ends with a summary: applied, skipped (with reasons) and failed. Exit 2 if anything was skipped or failed.
- Once no open ticket carries `blocked:work`, whoever ran the migration deletes the label (`gh label delete blocked:work`) after confirming with the owner.

## Rules for commands that change tickets

These are shared with #701.

- **Read live first.** Recheck the ticket's current state immediately before changing it. Never act on a cached or offline snapshot.
- **`--dry-run`:** print exactly the changes and comments that would be made, and make none.
- **One explanatory comment per ticket changed.** No label or dependency changes silently.
- **No merging, closing, reviewing, claiming on someone else's behalf, or editing an issue body.**
- Workflow rules (label names, completed states, reason labels) live in the registered workflow policy in `scripts/triage/briefing.js`, not in per-command branches.
- **Exit codes:** 0 means all done; 2 means partly done, with skipped or failed items listed; 1 means nothing done (bad arguments, auth or API failure).
- **Tests** run through the injected `gh` boundary, with no GitHub credential, covering:
  - cycles and self-edges;
  - a PR given as a blocker;
  - a ticket changed since the plan was made;
  - an edge that already exists;
  - a blocker closed as not planned;
  - stopping on a rate limit;
  - the migration label rules.

## Implementation order

Codex implements this. Each step is one PR against this merged document:

1. `deps <N>` and the briefing changes (read-only).
2. `deps add` / `deps remove`.
3. `deps migrate --plan` and `--apply`. Then a reviewed live run of the migration, recorded on #703.

Until the migration has run, the briefing reads both stores: native dependencies decide readiness, and text-only references are reported as drift ("not yet migrated").
