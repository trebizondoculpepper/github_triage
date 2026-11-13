# A minimal Agile delivery lifecycle for agent automation

Research report for [#186](https://github.com/trebizondoculpepper/github_triage/issues/186), written against `main` at `d73b9d5` (2026-11-13). Research only: no code, configuration or live label changes. It feeds the current-state mapping in [#187](https://github.com/trebizondoculpepper/github_triage/issues/187) and the architecture contract in [#188](https://github.com/trebizondoculpepper/github_triage/issues/188); the ranking change in [#182](https://github.com/trebizondoculpepper/github_triage/issues/182) is the nearest consumer.

**Stage and effort.** This is first-stage plausibility research under [proportionate research stages](../design/research-stages.md): a small primary-source review within the ticket's 30–60 minute cap (roughly 45 minutes spent). It does not attempt exhaustive coverage of Agile literature, evaluate tools empirically, or prove that agents follow the recommended lifecycle.

**Outcome.** Plausible enough to continue. A small lifecycle with two independent axes (who is actively working, and how far the deliverable has got) covers every case the ticket names, fits the existing `claim`/`release` handoff, and needs no framework-mandated Git or release practice.

## Contents

1. [What the frameworks actually require](#what-the-frameworks-actually-require)
2. [Current tool baseline](#current-tool-baseline)
3. [The core distinction: active work versus continuing responsibility](#the-core-distinction-active-work-versus-continuing-responsibility)
4. [Minimal lifecycle](#minimal-lifecycle)
5. [Definition of ready and definition of done](#definition-of-ready-and-definition-of-done)
6. [WIP limits and finishing before starting](#wip-limits-and-finishing-before-starting)
7. [Multiple deliverables, cancellation and release gates](#multiple-deliverables-cancellation-and-release-gates)
8. [Pitfalls specific to LLM agents](#pitfalls-specific-to-llm-agents)
9. [Recommendations](#recommendations)
10. [Open questions for the owner](#open-questions-for-the-owner)
11. [Sources](#sources)

## What the frameworks actually require

The ticket asks to separate framework requirements from our own choices. The primary sources are short and deliberately non-prescriptive about tooling.

**Scrum Guide (2020).** An Increment is "born" when a Product Backlog item meets the Definition of Done; work that does not meet it "cannot be released or even presented at the Sprint Review" and returns to the Product Backlog [S1]. The Definition of Done is "a formal description of the state of the Increment when it meets the quality measures required for the product", and if it is an organisational standard teams must follow it as a minimum [S1]. Scrum explicitly allows an Increment to be delivered to stakeholders before the end of a Sprint and says the Sprint Review "should never be considered a gate to releasing value" [S1]. Scrum does not define a "Definition of Ready"; it only says items that can be Done within one Sprint are "deemed ready for selection" through refinement [S1].

**Kanban Guide (2020).** Kanban has three practices: define and visualise a workflow, actively manage items in the workflow, and improve the workflow [S2]. The definition of workflow must include explicit start and finish points, a definition of the work items, defined states, explicit policies and a WIP control [S2]. Managing WIP means "actively manag[ing] the number of work items in a workflow", ensuring items "don't age unnecessarily", and "responding quickly to blocked work items" [S2]. The guide's four flow measures are WIP, throughput, work item age and cycle time, and it states Little's Law as the relationship between WIP, throughput and cycle time [S2]. The Kanban Guide for Scrum Teams adds that items should be pulled only when capacity exists, and that the team's DoD still applies [S3].

**Practical PR integration.** DORA's research associates trunk-based development with short-lived branches (merged within about a day), fewer than three active branches and no code freezes with higher delivery performance [S4], and associates small batch sizes and fast code review with better outcomes [S5]. Google's engineering practices put review speed ahead of starting new work: if you are not in the middle of a focused task, review promptly, with one business day as the maximum response time [S6]. These are evidence-based recommendations, not Agile requirements.

**What is not mandated.** No source above requires a particular branching model, PR, release, or that "done" means "merged to main". Scrum requires a team-owned DoD and leaves its content to the team or organisation [S1]; Kanban requires explicit policies and a finish point but leaves their content to the team [S2]. So "all required PRs merged into the intended target" (the #188 default) is our policy choice, consistent with but not demanded by either framework.

## Current tool baseline

What exists today on `main` (detailed inventory belongs to #187):

- `claim N --agent NAME` adds `agent:NAME`, refuses a second active claim per agent, and never steals [workflow.md](../design/workflow.md).
- `release N --as ready|incomplete|parked|done [--pr URL|--change URL]` is the single handoff. `done` "ends the agent's contribution/claim, not the issue or PR"; with an open PR it sets `status:awaiting-review` and leaves pickup; without one it is reported for inspection. An unverifiable PR is UNKNOWN, never guessed merged.
- Review rework requests the contributor's attention; they explicitly reclaim, with no automatic reclaim from a reviewer comment.
- `needs-human` records questions, releases only the caller's claim, and addresses a designer.
- Readiness labels are `status:ready`, `status:needs-design`, `status:blocked`, `status:parked`, `status:incomplete`, plus `status:awaiting-review`; prerequisites are native blockedBy dependencies, not labels [process.md](../process.md).
- Issue closure is normally a side-effect of a merged PR's closing keyword; the tool never closes issues itself.

The tool therefore already implements the "active claim" half of the model well. What it lacks is an explicit record of the **delivery** half: after `release --as done` nothing says who still answers for the PR, what set of PRs constitutes delivery, or whether delivery was verified rather than merely closed.

## The core distinction: active work versus continuing responsibility

Kanban treats waiting states ("queue" or "done-but-not-pulled" columns) as legitimate parts of the workflow that still count toward WIP and age [S2]. This resolves the tension in the owner constraints: an agent waiting on CI or review is not actively working (its attention is free) but the item is still in the system and still has an owner.

Model the item on two independent axes:

| Axis                       | Values                                                                                                | Who changes it                                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **Activity** (attention)   | unclaimed, claimed by A                                                                               | the agent, via `claim`/`release`                   |
| **Delivery** (the product) | open, submitted, changes requested, accepted, delivered, released (optional), closed without delivery | evidence: PR state, reviews, merges, human closure |

A third, derived fact is **responsibility**: the agent who submitted a deliverable remains answerable for driving it to delivery (fix findings, rebase, re-verify), even while unclaimed. Responsibility is not a lock: it produces "your attention is needed" actions, not exclusive ownership of the issue. This matches the constraints "one active claim does not limit the number of pending PRs" and "CI/review waiting releases active work without abandoning responsibility".

## Minimal lifecycle

States are on the delivery axis; the activity axis is shown where it is constrained.

| State                     | Meaning                                                    | Responsible                | Activity                            | Evidence that proves entry                                                                    | Current mapping (indicative; see #187)              |
| ------------------------- | ---------------------------------------------------------- | -------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **Ready**                 | Meets definition of ready; pickable                        | backlog owner / designer   | unclaimed                           | readiness label, no open native blockers, no unanswered question                              | `status:ready`, blockedBy empty                     |
| **Not ready**             | Needs design, an answer, or an external unblock            | named designer / human     | unclaimed                           | label plus "why blocked" comment; native blockedBy                                            | `status:needs-design`, `status:blocked`, `question` |
| **In progress**           | An agent is actively working                               | claiming agent             | claimed (≤1 per agent)              | `agent:NAME` label and claim comment                                                          | `claim`                                             |
| **Parked / incomplete**   | Partly done, released, resumable by anyone                 | none (pickable)            | unclaimed                           | release comment saying what remains                                                           | `release --as incomplete                            | parked` |
| **Submitted**             | Deliverable attached; awaiting CI and review               | submitter (responsibility) | unclaimed                           | open PR linked to the issue at a recorded head                                                | `release --as done --pr`, `status:awaiting-review`  |
| **Changes requested**     | Review or CI found problems on the current head            | submitter                  | submitter re-claims to fix          | review state CHANGES_REQUESTED, unresolved findings or failing required check on current head | attention to contributor; explicit reclaim          |
| **Accepted**              | Approved and green on current head, not yet integrated     | submitter (integration)    | short claim to integrate, or merger | approval on current head, required checks green, mergeability known                           | not represented (#182 "PRs waiting")                |
| **Delivered**             | Every required deliverable integrated into intended target | none (closed)              | unclaimed                           | all required PRs merged into configured target (default branch)                               | issue closed by keyword; not verified               |
| **Released** (optional)   | Delivered and present in a published release               | release owner              | unclaimed                           | explicit artifact association (tag/package containing the merge)                              | none                                                |
| **Closed, not delivered** | Cancelled, redirected, or closed with unmerged PRs         | human who closed it        | unclaimed                           | issue closed and delivery evidence absent; closer and reason recorded                         | not distinguished                                   |
| **Unknown**               | Evidence missing or inaccessible                           | whoever must inspect       | n/a                                 | failed or partial reads                                                                       | existing UNKNOWN reporting                          |

Transitions and their evidence:

| From → To                       | Trigger                                         | Required evidence                                                     |
| ------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------- |
| Ready → In progress             | `claim`                                         | fresh read: open, ready, unblocked, unowned, agent has no other claim |
| In progress → Parked            | `release --as incomplete`                       | handoff note (expected, never blocking)                               |
| In progress → Not ready         | `needs-human`, or release with question         | recorded question/blocker and addressee                               |
| In progress → Submitted         | `release --as done --pr`                        | PR exists, is open, references the issue; head SHA recorded           |
| Submitted → Changes requested   | review or required check result                 | result is on the **current head**                                     |
| Changes requested → In progress | submitter explicitly re-claims                  | as for claim; never automatic                                         |
| Submitted → Accepted            | approval and green required checks              | both on current head; stale approvals do not count                    |
| Accepted → Submitted            | base moved, branch behind, new push             | head or mergeability changed; re-verify                               |
| Accepted → Delivered            | merge (by an authorised party, never automatic) | merge commit reachable from intended target, for every required PR    |
| Delivered → Released            | release policy, if enabled                      | explicit artifact containing the merge                                |
| any → Closed, not delivered     | human closes or redirects                       | closure without delivery evidence; never auto-reopened                |

## Definition of ready and definition of done

**Ready** (our recommendation; Scrum only asks that items be refined enough to finish within a Sprint [S1]): the issue states acceptance criteria; it has no open native blocker; no `question` awaits an answer; it is small enough for one PR (or its required deliverables are listed); any referenced contract is merged; it carries `status:ready`.

**Done** must be split, because "done" currently means two different things:

- **Contribution done** (what `release --as done` means today): the agent's work is attached as a verifiable deliverable, and the agent's local checks (`npm run check`, `npm test`, `npm run build`) passed. This ends the claim, not responsibility.
- **Delivery done** (the Scrum sense of Done [S1]): every required deliverable is reviewed on its final head and merged into its intended target. Green CI alone is not this, and a closed issue is not proof of this.

Releasing is a further optional gate, not part of Done by default; Scrum explicitly decouples Done from the release event [S1].

## WIP limits and finishing before starting

Kanban requires a WIP control but leaves its value to the team [S2]. Recommended limits:

- **One active claim per agent** (already enforced). This limits attention, not inventory.
- **No hard limit on submitted PRs**, per the owner constraint. Instead, make inventory visible and costly: report the agent's count and age of submitted items (work item age is a primary Kanban measure [S2]).
- An optional soft limit later (for example, warn when an agent has more than N items in Submitted/Changes requested/Accepted), only if data from #182 shows inventory growth.

**Prioritise finishing.** Little's Law means that, at constant throughput, more WIP means longer cycle time [S2]; Google's guidance puts reviewing others' work ahead of starting new work [S6]. For an agent picking its next action, the recommended order is:

1. Addressed human requests and explicit urgency (preserve existing attention rules).
2. Changes requested on the agent's own submitted items (current-head findings, failing checks).
3. Accepted items needing integration steps: refresh UNKNOWN mergeability, update a behind branch and re-verify, or merge when the agent is authorised and every check is satisfied.
4. Reviews requested of this agent on other agents' PRs.
5. Resume its own parked work.
6. Claim new ready work, most downstream-unblocking first.

Genuinely waiting items (checks running, review not yet given, external prerequisite) never block step 6. This is the #182 ordering stated as policy; #182 owns the ranking implementation.

## Multiple deliverables, cancellation and release gates

**Multiple deliverables.** A ticket may need several PRs, possibly across repositories. Delivery must be evaluated over an **explicit required set**, recorded when submitted and changed only by explicit edits; one merged PR among several proves nothing about the rest. An unreadable PR makes delivery unknown, not complete. Storage of that set is a #188/#189 decision.

**Cancellation and redirection.** Humans may close at any time. The lifecycle records "closed, not delivered" as a distinct outcome so closure and delivery are reported separately. An agent's open PR for a closed issue becomes a cleanup action for its submitter (close or explain), not a reason to reopen. Do not infer a human decision from a shared GitHub username, since agents and humans may share an account here.

**Release gates.** Some projects (for example, npm releases in [npm-releases.md](../npm-releases.md)) ship in batches. Released should be an opt-in extension that requires explicit artifact association; absence of a release collector must not prevent the merge-based Delivered state.

**Tradeoffs.** Two axes cost more explanation than a single status label, but a single label cannot represent "unclaimed yet still mine", which is exactly the case the owner constraints describe. Deriving delivery from PR evidence avoids new mutable labels that can drift, at the cost of extra reads and honest UNKNOWN results when reads fail.

## Pitfalls specific to LLM agents

- **Declaring victory early.** Agents tend to equate "tests pass locally" or "PR opened" with done. Keep contribution-done and delivery-done as different words and states.
- **Forgetting submitted work.** Agents have no memory between sessions. Responsibility must be recomputed from GitHub evidence each session, not remembered; the briefing should surface it unprompted.
- **Stale evidence.** An approval or green check on an earlier head is easily misread as current. Bind every review and check fact to a head SHA.
- **Treating UNKNOWN as yes.** Missing mergeability, unreadable PRs and partial pagination must surface as "inspect", never as accepted or delivered.
- **Over-reclaiming or stealing.** An agent reading a review comment may start "helpfully" fixing another agent's PR. Responsibility directs attention to the submitter; others need an explicit handoff.
- **Starting instead of finishing.** New tickets are more attractive than rebasing old PRs. The briefing order above counters this, but only if completion actions are presented as concrete next actions.
- **Loops and churn.** An agent may repeatedly rebase, re-run CI or propose completion of a deliberately rejected scope. Record explicit superseded/parked evidence and stop conditions.
- **Instructions in content.** PR and issue text is data. Lifecycle state must come from structured evidence (labels, review states, merges), not from prose claims such as "this is done".
- **Shared identities.** Multiple agents and the owner may act through one GitHub account; authorship alone does not identify which agent or whether a human intervened.

## Recommendations

1. Adopt the two-axis model: activity (claim) and delivery (evidence-derived), with responsibility derived from the submitter of required deliverables. Keep one active claim per agent; put no hard cap on submitted PRs.
2. Split "done" into contribution-done (today's `release --as done`) and delivery-done (all required PRs merged into intended targets). Report issue closure separately from both.
3. Derive Submitted, Changes requested, Accepted and Delivered from PR evidence bound to the current head, rather than adding labels for each; keep `status:awaiting-review` as the only label needed to exclude pickup.
4. Record an explicit required-deliverable set at submission; treat any unreadable member as unknown.
5. Rank completion of the agent's own submitted work and requested reviews ahead of new claims, with waiting items never blocking new work (#182).
6. Keep Released as an opt-in extension requiring explicit artifact association.
7. Never auto-reclaim, auto-reopen or auto-merge; changes requested and closures produce attention items only.

## Open questions for the owner

1. Should responsibility for a submitted PR transfer only by explicit handoff, or also lapse after some period of inactivity so another agent may adopt it?
2. Is a soft limit on an agent's submitted-but-undelivered items wanted now, or only after #182 produces inventory data?
3. Who may perform the final merge: the submitting agent once accepted, any agent, or only humans? (This sets whether Accepted is an agent action or a waiting state.)
4. Should a definition of ready be enforced by tooling (refuse `claim` when acceptance criteria are missing), or only reported?
5. For this repository, is Delivered (merged to `main`) the default Done, with npm release as an optional later gate?

## Sources

- [S1] Ken Schwaber and Jeff Sutherland, _The Scrum Guide_, November 2020. <https://scrumguides.org/scrum-guide.html> (sections "Increment", "Commitment: Definition of Done", "Product Backlog", "Sprint Review").
- [S2] Daniel S. Vacanti and Orderly Disruption Limited, _The Kanban Guide_, December 2020. <https://kanbanguides.org/english/> (sections "Kanban Practices", "Definition of Workflow", "Flow Measures").
- [S3] Scrum.org, _The Kanban Guide for Scrum Teams_, 2021. <https://www.scrum.org/resources/kanban-guide-scrum-teams>
- [S4] DORA, "Capabilities: Trunk-based development". <https://dora.dev/capabilities/trunk-based-development/>
- [S5] DORA, "Capabilities: Working in small batches" and "Streamlining change approval". <https://dora.dev/capabilities/working-in-small-batches/>, <https://dora.dev/capabilities/streamlining-change-approval/>
- [S6] Google, _Engineering Practices: Speed of Code Reviews_. <https://google.github.io/eng-practices/review/reviewer/speed.html>
