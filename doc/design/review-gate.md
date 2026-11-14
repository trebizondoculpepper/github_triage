# Either-provider automated review gate

Owner instruction, 2026-11-14, for this repository's merge/release workflow. This replaces the earlier requirement to wait specifically for CodeRabbit. It does not permit bypassing CI, substantive findings, ownership or merge protection, and does not turn review output into general authority.

## Qualifying evidence

Current means the reviewed full commit SHA matches the live PR head. Codex qualifies when its authenticated integration's completed review state/receipt covers that head with no unresolved findings. CodeRabbit qualifies when its integration has actually completed a passing/clean review of that head, with substantive findings resolved. A review can be represented by a completed provider receipt rather than a formal GitHub APPROVED state, but a generic success check with no attributable current review is insufficient. Do not trust a copied receipt posted by another user, a reported agent name or mere mentions of provider names.

The gate is `verify(current head) passed AND (Codex current clean OR CodeRabbit current passing) AND no unresolved substantive findings AND ordinary merge prerequisites hold`. A pending, skipped, rate-limited, error or stale second provider does not block the OR condition. A known outstanding substantive finding from either provider still blocks; a clean response from the other is not a waiver. Review-thread closure must reflect an actual fix or an explained disposition with follow-up, never a claim that unimplemented runtime work is already fixed. Human explicit decisions remain authoritative under the project's existing process.

A new head requires current coverage again. Recheck the live SHA/checks/findings before merge and bind the merge request to that SHA. Do not force/admin merge around protected required checks. Release validation runs against the selected merged source and remains independent of review receipts for earlier commits.

## Scope and rollout

AGENTS.md and doc/process.md apply this instruction immediately for maintainers/agents on this repository. Triage PR-status output is advice, not a merge permission oracle. Its currently Codex-specific stale/pending blockers may need a focused follow-up to honor a declared either-provider policy. Such product behavior must use registered policy and verified provider evidence, not a special case for this repository or an automatic assumption about every consumer's review requirements. Unknown/missing policy remains explicit. Keep current schemas and useful failure evidence, and test both alternatives, stale receipts, neutral quota skips and outstanding cross-provider findings before runtime adoption.

Publication is still explicit only: build/main pushes never publish. An owner request to release authorizes selecting verified merged main, fast-forward promotion and publication through the existing helper, followed by registry/tag/release verification. It does not authorize merging an unreviewed PR or republishing identical source as a new version.
