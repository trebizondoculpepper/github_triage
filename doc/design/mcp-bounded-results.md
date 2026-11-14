# Bounded MCP read results

Documentation-first replacement response contract for #266, approved direction 13 November 2026. Supersedes the full structured-intake defaults in mcp.md when implemented. Runtime is unchanged by this document.

## Why

Actual Claude Code testing found default results around 65–72 KB. maxChars bounded text only; structuredContent still exceeded the client's default allowance, sometimes producing an error instead of evidence. A useful next-action view is a shortlist, not a full export. Fix response size independently of later caching.

## Whole-result boundary

The default and hard upper bound is 16,384 UTF-8 bytes for JSON.stringify of the entire returned CallToolResult, including content, structuredContent, notices and protocol-result fields controlled by the server. This conservative byte budget is not a claim of identical byte/token limits across clients; the actual-client retest remains required. An input maxChars can further reduce text but never raise this hard bound. Count duplicate evidence in both representations. Return structured summary plus minimal complementary text, not two copies of full intake. Build valid JSON from selected fields; never slice serialized JSON or return silent string truncation.

Select content by importance, then measure and prune optional detail deterministically until within budget. Reserve room for schema identity, target, freshness, source completeness, presentation omissions, next navigation and essential warnings. Bound titles/reasons/excerpts with a visible field-truncated notice. If essential metadata itself cannot fit, return a bounded isError result with stable OUTPUT_BUDGET_EXCEEDED, target, reason and recovery request; do not return a misleading partial success. This does not excuse runaway internal collection or change existing collection caps.

## Interface

Keep existing tool names and selection/identity/input validation. triage_briefing limit defaults to 10 (existing 1–100 accepted, but the byte cap still applies); rank all collected eligible actions before taking at most limit items. Retain addressed attention ordering, blended ranking and unknown/inspection versus executable distinctions. Return kind, target/title, short reason, evidence links and exact supported next command per action. Report total, shown and omitted; ten is a maximum, not a promise when individual entries consume the budget.

triage_issue defaults to a ticket-centered summary with state, labels/assessments, ownership, dependency counts, linked PR state and top actionable findings. It no longer implicitly exports the entire body/history in structuredContent. triage_dependencies defaults to direct upstream/downstream summary; explicit tree remains opt-in and is itself bounded, never silently reported as a complete tree after pruning.

Add strict optional detail arguments to issue: section = summary|body|discussion|pullRequests (default summary), offset integer >=0 default0, limit integer1–100 default10. Add offset/limit with the same defaults to dependencies, applied to a stable flattened relationship list after collection (not traversal depth); retain relation/depth/path so omitted subtrees cannot look complete. Issue discussion order is GitHub creation time then stable comment ID. PR rows use repository and numeric identity. Expose the next validated tool arguments when another page exists. Existing issue/dependency CLI commands remain available for full intake outside the MCP transport budget. An explicit request never bypasses the hard response cap.

Each new successful structured response uses schemaVersion:2, kind:mcp-read-result, tool, repository, subject (nullable for repository views), freshness, sourceCompleteness, presentation:{budgetBytes,bytes,returned,omitted,truncatedFields,next}, and data. data is a tool-specific registered summary schema, not the old full report with misleading missing fields. Expose the same version through advertised outputSchema. Version1 full-intake consumers must not receive a silently changed version1 object. No unbounded legacy full-result mode. bytes measures the final whole result including its own fixed-point value; tests verify the actual serialization. Text explicitly announces that the result is bounded and directs consumers to presentation metadata.

Source completeness and display completeness are separate: fully collected facts can produce omitted display rows. A limit alone must not mark collection failed; incomplete GitHub facts must not become complete because only a small summary is returned. Missing evidence is unknown, never approval or zero. Keep essential authority/eligibility warnings even when ordinary rows are omitted. No mutation or automatic claim/merge authorization is added.

## Focused requests and later cache

Follow-up calls re-read live facts under existing rules. Include observedAt and warn that pages can change between calls; offsets provide navigation, not a transactional snapshot. Snapshot IDs, shared cache persistence/invalidation, access binding, expiry and recovery belong to the existing incremental-cache research/experiments (#198/#202/#203). Do not block the bounded fix on that architecture or add a hidden cache now. Mutation prerequisites always require fresh verification.

## Acceptance and routing

#25 remains conditional for Claude Code until #266 is fixed and default briefing, issue and dependencies (including explicit tree) succeed in the real client without MAX_MCP_OUTPUT_TOKENS overrides. The workaround is temporary, not a default pass. Retain the prior #253 report as evidence, then append retest provenance rather than rewriting history.

Injected tests serialize whole results with large histories, Unicode, giant titles, many actions, warnings, partial collection, small maxChars and repeated pagination. Assert <=16,384 bytes, valid schema, deterministic selection, rank-before-limit, explicit omissions, unknown evidence and supported navigation. Confirm CLI full intake remains available. Actual Claude Code test records client/server revision and default settings; SDK-only tests do not establish host acceptance. No paid bulk trials or live mutations are required. Implementation follows this separate reviewed contract.
