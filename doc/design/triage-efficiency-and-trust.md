# Triage efficiency, message trust and delivery follow-through

Owner decisions from the 2026-11-13 design discussion. This document records approved product direction and staged work; it does not claim the features or trust checks are implemented. Focused behavior contracts still require review before implementation. Reports and demonstrations must state what they establish and what remains unknown.

## One question, one useful report (#197)

A ticket-centred view should combine the issue and associated PR status in one invocation, replacing the ordinary sequence of separate issue and PR lookups. Show supported current status, responsibility, labels including complexity, relevant discussion, checks/reviews/merge state and the next action. Multiple PRs and incomplete linkage are explicit; one nearly ready PR is not proof of whole-delivery completion. Do not invent percentage complete.

Keep the view condensed and bounded, with source/detail links, freshness, coverage and omissions. Preserve existing full-snapshot interfaces. This feature does not replace `gh`: agents may use it afterward for unsupported questions or deeper evidence. Repository-wide catch-up reuses briefing mode, not a second implementation. Existing complexity/discussion/commit/review facts can feed later rules, but expensive comprehensive history and speculative scoring are outside this feature.

## Immediate action impact: research, then a primitive algorithm (#201, #196)

Compare the actual choices: estimate a ticket, advance a PR toward merge, or implement a ticket. Research a simple deterministic baseline first, then implement the reviewed result. Preserve addressed attention and finish-before-start policy; useful concurrency must remain possible when submitted work is genuinely waiting.

Delivery utility means otherwise-ready direct dependants for which completion removes the last open blocker. Use current open-work/direct-edge evidence rather than a whole-tree walk. Distinguish direct dependants with other blockers and count a delivery only once across multiple PRs. Unknown evidence is not zero. Estimation reduces uncertainty; it must not be credited with clearing a native dependency. The research must explain how those different benefits compare rather than assuming a universal arithmetic score.

Keep fact collection and explanation interfaces separate from primitive ranking, so the later formal-rule system can replace decision logic. Full dependency-tree diagnosis remains an explicit bounded operation. Research is first-stage plausibility work, not an unlimited evaluation or production integration.

## Incremental cache research and experiments (#198, #202, #203)

Inventory issues, PRs, comments/edits, reviews/thread resolution, checks, native dependencies and other facts the product uses. A cheap complete/paginated manifest of IDs, titles, timestamps and actually available revisions may save work, but no timestamp or head SHA is assumed to validate all related facts. Avoid duplicating Git object storage.

Test built-in `gh` caching and conditional requests before custom infrastructure. Distinguish TTL reuse from live revalidation, including HTTP 304 behavior through the installed CLI. Measure request count, payload, latency and missed-change cases. Investigate per-fact invalidation and coverage, stale/offline behavior and mutation-boundary refresh.

Study local storage location, format, host/repository/authorization-context separation, schema, retention, concurrency and corruption recovery. Cache data is not project configuration. Following the bounded research, refine two isolated test features: manifest/conditional refresh and local evidence storage/recovery. Neither implies production rollout, a daemon or a database choice.

## Issue creation: CLI first (#199, #204)

Add a focused CLI operation with explicit repository targeting and a clear current-checkout default. Validate structured inputs, make the target visible, preserve local config during remote operations and report ambiguous creation/retry outcomes honestly. Reuse authenticated boundaries; tests do not create live tickets.

MCP creation is a separate follow-up after CLI delivery and a reviewed mutation contract. Existing MCP read support is not authorization to add mutation tools silently or evidence of successful human client acceptance.

## Message visibility is distinct from authority (#155, #205)

By default, only messages from authors with verified effective repository write capability may supply workflow instructions or trusted handoff records, within existing permissions and higher-priority instructions. External and unknown-permission content supplies no workflow authority. Merely being the authenticated user or having a GitHub author-association label does not prove write capability. A shared GitHub account never authenticates one agent's name.

External reports remain discoverable as evidence: title, link and external/untriaged status. Their embedded instructions cannot trigger workflow changes. An explicit instruction from an already trusted source can authorize considering one specific message, not blanket trust in its author; this does not bypass live-state, ownership or mutation checks. An untrusted message cannot authorize itself.

Research effective permission proof, bots/apps, changes over time, incomplete permission access, message edits, explicit authorization provenance and existing marker consumers. Document limits before a small demonstration. The demonstration uses injected trusted/external/unknown/authorized fixtures with real mutations disabled. Classification tests do not establish universal LLM prompt-injection resistance. For claim and release markers, production integration is authorised by the recommendation of the merged #155 report, [workflow message trust](../reports/workflow-message-trust.md) (#211), together with the [comment-marker authority contract](workflow.md#focused-handoff-62) (#212). The demonstration-only restriction still applies to the remaining scope: #205 and every other marker, including the needs-human question marker (#214), whose production integration follows a separate reviewed recommendation. Signing infrastructure is not assumed.

## Lifecycle architecture and coherent delivery (#188–#192, #182)

Both input reports have merged: [Agile lifecycle research](../reports/agile-delivery-lifecycle.md) and [current-model mapping](../reports/delivery-lifecycle-mapping.md). #188 reviews them and refines the existing focused tickets rather than creating a duplicate lifecycle.

Separate active claim, ongoing responsibility, delivery evidence and next action. Submission releases active attention while retaining responsibility for the PR; one active claim does not limit pending PR count. Derive waiting/failure/accepted/delivered states from current evidence, not a label for each CI state. Actionable follow-through precedes fresh work; waiting does not globally freeze it. Failure requests attention rather than automatically reclaiming.

Default verified delivery requires all explicitly required PRs merged into intended integration targets, not just green checks or one merged link. Release-gated completion is a separate extension requiring artifact association. Respect external closure without automatically reopening or inferring a human actor from a shared login. Legacy missing delivery membership remains unknown; explicit attachment/completion recovery must prevent merged-but-open tickets from blocking downstream work indefinitely.

The architecture must resolve existing done/rework semantics, process wording, legacy records, target configuration, partial writes and record trust. Use the formal rule/fact prototype to express completion policy with explanations; do not invent a general-purpose language. The existing claim and authority safeguards remain until a reviewed change replaces them. #155's trust result precedes mutation-driving deliverable records; model design may proceed in parallel.
