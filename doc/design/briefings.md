# Three briefing policies and shared ranking

Owner-confirmed contract for #1/#40/#43/#45. Use shared normalized facts and declarative tier/key policies, not separate collectors or opaque weighted scores. The research in ../reports/next-action-ranking.md is evidence, not authority over later owner decisions.

## Identity, relevance and eligibility

`--agent NAME` and `--agent=NAME` select the same explicit persistent identity. Role chooses presentation, not authority. Without resolved identity, say that addressed/owned filtering is unavailable; do not attribute via the shared GitHub login. Still return useful generic review/pickup context.

`origin:NAME` is informational provenance. `attention:NAME` requests a response, permits multiple destinations, never reserves work and never changes a claim. An addressed agent clears only its own destination after a substantive response; reading or acknowledging receipt is insufficient. Other agents can inspect/respond or claim otherwise-eligible unclaimed work while a destination is offline.

Eligible implementation pickup is open, unclaimed, `status:ready` or `status:incomplete`, with complete native blocker evidence, no open blockers, no outstanding question/design prerequisite and no known platform mismatch. An issue with an open closing PR is represented as PR follow-up, not duplicate pickup. The absence of an open closing PR must be proven: by every open PR's closing references being complete, or by the issue's own complete `closedByPullRequestsReferences`; otherwise eligibility is unknown (#162). Pickup, design pickup, polling and Ticket Doctor share this one rule (`closingPrEvidence`). Never infer availability from stale activity. Unknown eligibility goes to inspection/waiting with a reason.

`platform:codex`, `platform:claude-code`, `platform:opencode`, `platform:ori` represent explicit restrictions. Multiple platform labels are an allowed-set; the viewer must match one. No platform label means unrestricted. Unknown viewer platform means restricted tickets are inspection context, not confirmed pickup. This does not restrict non-exclusive attention visibility.

## Implementer: advance implementation

First matching action group: (1) attention explicitly addressed to the viewer, (2) actionable PR follow-up, (3) own active work, (4) eligible pickup. Keep directed attention visible regardless of role or urgency. Group linked ticket/PR work once and retain all relevant reasons.

PR follow-up distinguishes review/rework, failing checks/conflicts, current verified merge consideration, and waiting. Show own follow-up before unassigned/other review opportunities; do not make shared-login authorship proof of ownership. Pending/queued CI is waiting. Cancelled checks are incomplete verification, distinct from test failures. Review receipts/comments count as evidence; state reviewed SHA versus current head. A new head needs fresh coverage or an explicit stale-review notice. Green/current evidence suggests inspection/merge consideration, never approval. Closed-unmerged PRs need inspection, not an awaiting-merge claim.

## Designer: unblock active work before new design

Show addressed attention first; then decisions holding up active work/PRs; agreed decisions needing documentation; design-document/PR review; new design work ranked by immediate otherwise-ready work it can unlock. The distinct groups are maintained explicitly with `design:decision-needed` and `design:documentation-needed`, plus a concise reason. Both markers can be valid for different explained parts of a ticket; missing explanation/contradictory resolution is unknown, not inferred from chronology. Agent judgment can revise/reopen a question.

Include a minimal implementation-PR summary near the bottom. Evidence of repeated review cycles may elevate a candidate for design input; comment count alone does not prove a design flaw. Implementers receive only a short pending-design note. Do not automatically fetch/quote linked design sections; agents can read local files. File-overlap PR history is deferred. Explicit epic/sibling context is optional when it materially explains the next action, not a broad search requirement.

## Owner catch-up: what can I do to advance the story?

Lead with actionable human decisions, answers, access and interventions, stating what each blocks. Say explicitly when no human action is needed. Then material changes/completions/releases since the comparison window; risks/stalls/repeated review cycles; finally lower-priority current-work and next-outcome summaries. Separate reported claims/activity from confirmed presence. Exclude routine bot/commit chatter unless material. Name the time window/baseline; never invent “since last visit” history. Reuse since/checkpoint observations across open/closed/merged states. This is a presentation use case, not a new privileged identity.

The concrete repository-wide catch-up interface and bounded source coverage are defined in [briefing-mode.md](briefing-mode.md) (#163). That mode is distinct from the next-action view; its first slice reports issue/PR evidence and explicitly does not audit releases/deployments.

## Pickup ordering and manual urgency

Default impact mode sorts: urgency high, unspecified, low; then distinct immediate dependants that become otherwise eligible when this ticket (their last open native blocker) completes; incomplete before unstarted; oldest creation time; numeric issue identity. Do not count distant descendants, dependants still needing design, or unknown eligibility as definite impact. Both urgency labels are a conflict: report it and use the unspecified band pending correction. Urgency applies to general pickup, not above addressed attention or lifecycle groups.

Impact has one definition, shared by pickup ranking, role views and the non-role action order (#208). A truncated or uncollected `blocking` list, or a possible unlock that cannot be resolved (absent from the snapshot, in another repository, or lacking its own native evidence), makes impact unknown. So does a dependant whose only open native blocker is this ticket but whose other eligibility is unknown (for example a platform restriction with no viewer platform, or truncated closing-PR evidence): its unknown-eligibility reasons propagate into the impact's unknown reasons and it is not counted, so the result is never a definite zero. Reasons and JSON report unknown impact (`unlocksUnknown`, a list of reasons, empty when the count is complete) and the count is shown as a lower bound ("unlocks at least N"). Orderings compare only the proven lower bound, so unknown impact never outranks a larger known count and never ranks below zero; equal lower bounds tie and fall through to the next key.

Explicit oldest/newest modes replace **all pickup weighting**, including urgency, impact and incomplete preference: creation time ascending/descending, then numeric identity. Keep metadata visible; it is excluded only from ordering. Eligibility and role/action groups remain intact. Help must describe this scope. Default impact and explicit sorts must not secretly behave as the research report’s age-only tie-breaker.

Stale claim signals are configurable, default two days for briefings. Latest ticket or explicitly linked-PR commit/comment/review activity resets the clock. Bot inclusion is delegated to the simplest documented implementation. Ordinary read-only triage runs do not reset GitHub activity. Missing evidence is unknown; never auto-release.

## Acceptance examples

Addressed low-urgency work precedes high-urgency pickup; a ready ticket/open PR appears once; incomplete versus ready ties prefer incomplete in impact mode; two dependants with another open blocker contribute zero immediate unlocks; old low-urgency work precedes newer high-urgency work in oldest mode; unknown platform/native evidence cannot become pickup; #14/#100 ties use numeric identity. Pending CI is not failing work or merge-ready. All views return concise reasons, evidence, omission counts and detail navigation; hygiene is capped below actionable work.
