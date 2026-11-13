# Single-operation diagnosis and doctors

All features here are read-only. Share collectors and evidence records; retrieve detail in bounded requests, report missing pages/logs, and keep concise text/JSON. Never rerun CI, request reviews, clear threads, release claims or merge as an implicit diagnosis action. Stable findings carry scope, rule ID, facts, uncertainty, links and supported next commands.

## #59: why is a PR not progressing?

One operation accepts repo and PR, returning current head/fetch window, required check outcomes, bounded failure detail, reviewer findings and later replies, unresolved threads, review status/reviewed SHA, conflicts, linked issues and explicit ownership. Distinguish pending, cancelled, failed, missing and unknown checks. No steps/logs is not a demonstrated code defect. Review receipts may be comments, not formal review objects. A request without reaction differs from a running or completed review. Show simultaneous blockers, not a blanket merge verdict. Green evidence is inspection/merge consideration only. Version the result if compatibility requires it.

## #60: repeated review cycles

An explicit deeper mode extends #59 with review rounds matched to commits, fixes/responses, reopened/resolved findings and recurring themes. Distinguish repeated defects, possible regressions, newly discovered old gaps and duplicate/stale findings. Do not infer causation or abandonment from count alone. Return candidate next actions: targeted fixes, broader invariant/design review, split scope or defer; explain uncertainty and value evidence. Do not run an LLM each background refresh or automatically change scope. A bounded signal feeds designer/owner views, with detail on demand.

Implementation defaults (routine, under this contract): the mode is `pr N --history`; classification uses reviewer + file + normalized finding title only; the inspection threshold is 3 rounds with findings; result shape and bounds are documented in `doc/usage.md`. Wiring the signal into designer briefings and owner catch-up is a follow-up that consumes `signal` without new collection.

## #41 / #61: team and ticket ownership

Team view lists explicit named-agent claims, linked PR state, latest ticket/PR activity, stale/multiple-claim candidates. Ticket lookup answers “who is working on this?” using the same records plus release/done/handoff evidence. Source-link contradictory label/comment history, without treating comment text as an authoritative claim parser. Origin/attention are not ownership. Recorded ownership, recent activity, and live presence are distinct. Without a supported presence source, say online/availability unknown. No presence service is a prerequisite; no shared-login attribution or automatic release. #61 owns focused lookup; #41 owns team aggregation.

## #64: local configuration doctor

Diagnose intended project, selected harness/server entry, TOML parse/identity/name, triage_role, supported role, Git ignored versus already tracked configuration, and missing runtime/gh access as separate checks. No repairs, login, identity creation, role writes, hooks or Git tracking changes. Return actionable in-band results, especially for hosts discarding stderr. Missing/ambiguous detection is explicit. Reuse identity resolution; compatibility blockers in identity.md remain real limitations. Can diagnose unavailable configuration without requiring the Agent Inbox service.

## #66: Ticket Doctor v1

Scan all open project tickets for missing/conflicting classification/readiness, conflicting urgency/design evidence, multiple claims/owners, leftover claim after handoff, stale agent activity, ready/open-PR mismatch, dependency cycles/drift/missing explanations, and unresolved identity references. Group by ticket, label definite versus candidate versus unknown, and bound output with omitted counts. Prioritize cheap structured checks; do not require perfect coverage of all prose.

For Ticket Doctor, stale-agent default is **24 hours**, configurable, and explicitly separate from the general briefing’s two-day default. Latest linked-PR commits/comments/reviews count. A human assignee is not automatically an agent; apply no agent timeout to humans merely because they share an account. Missing activity is unknown; no automatic reclaim. Classification gaps in an external bug report are triage work, not evidence it is invalid.

## #67: Ticket Doctor v2

Add deterministic correction plans and exact commands to v1, never execution. Examples: stale claim release candidate; ready/open-PR awaiting-review suggestion; merged-PR leftover-claim release; multiple claim dispositions; high/low/remove-both urgency alternatives; missing blocker explanation; cycle path and possible edge removals. Definite mechanics can yield one suggestion; semantic choices remain explicit alternatives. Use only delivered command syntax, with manual/inspection fallback when a mutation is not implemented. No invented auto-repair engine.

## Acceptance

Fixtures cover current versus stale SHA, cancelled/no-log CI, multiple blockers, meaningful resolved feedback versus bot noise, incomplete history, duplicate issue/PR rows, comment-only ownership, missing presence, malformed configuration, distinct triage/mail roles, Git-tracked identity files, stale agent versus human assignment, and correction-command parser validity. Show request/output costs. Each ticket is a separate implementation slice; #67 depends on #66 and #60 reuses #59 without requiring unrelated deferred work.

## #39: transferred issue inspection

Use `--include-transferred` to opt into transferred-out work in recommendations; default excludes it from actionable local work. Explicit `--issue N` always diagnoses its transfer when GitHub supplies authoritative transfer/redirect evidence, showing original and destination URLs. Do not silently take destination ownership or infer transfer from a missing/forbidden response. Missing, inaccessible and moved are distinct; if evidence cannot distinguish them, report unavailable/unknown with a next inspection command. Preserve origin repository and destination identity in JSON and cross-repository links. Inject redirects/transfer evidence in tests; no live transfer or automatic issue rewrite. Document bounded fallback reads rather than generic GraphQL failure alone.
