# Development Diary Entry - 2026-11-14

## Context

- **Date**: 2026-11-14 UTC
- **Branch**: fix/266-mcp-output-budget (on docs/266-mcp-bounded-implementation)
- **Contributors**: Claude Code (kavya_sabbagh) + User

## Problem Statement

Issue #266: the default MCP reads were too large for Claude Code's default output limit (about 65–72 KB) because `maxChars` limited only the text, while `structuredContent` carried the full CLI report. The bounded-response contract (doc/design/mcp-bounded-results.md, PR #274) was already merged.

## Our Approach

We opened a docs-only PR first. It sources Claude Code's documented limit (10,000-token warning, 25,000-token default, `MAX_MCP_OUTPUT_TOKENS`) and records the decisions the contract left open: the exact version-2 envelope, the registered data per tool, the pruning order and how `triage_events` is handled. It also documents `MAX_MCP_OUTPUT_TOKENS` as a temporary workaround. We did not adopt an unbounded `detail: "full"` mode, because the contract rules it out.

## Implementation

`src/mcp/bounded.ts` measures the whole serialized CallToolResult against 16,384 bytes. When a result is too large, it first shortens long non-URL strings and records each in `truncatedFields`. If that is not enough, it drops rows from the lowest-priority list first and records each list's count in `omitted`. Containers keep their `total`/`omitted` counters consistent. `presentation.bytes` is computed as a fixed point. When the essential fields alone cannot fit, the result is an `OUTPUT_BUDGET_EXCEEDED` error, never a partial success. `src/mcp/views.ts` selects the data for each view: briefing fields keep their CLI names and values, issue sections are paged, and dependencies become a flattened relationship list with relation, depth and path. `triage_events` keeps its version-1 envelope and re-reads a smaller page when its result is too large, so cursors stay exact.

## Outcomes

On the same synthetic fixture, sizes went from 79,446 to 16,180 bytes (default briefing), 135,993 to 3,638 (issue summary) and 155,997 to 16,029 (dependency tree). CLI parity tests now compare a prefix whenever the budget shortened a list. A setback: a `git stash` with untracked paths failed partway through measuring the before sizes and reset `src/mcp.ts`; we re-applied the edits from the scripted changes.

## Next Steps

Re-run the real Claude Code acceptance with default settings (no `MAX_MCP_OUTPUT_TOKENS`) and append its provenance to doc/reports/agent-platforms/claude-code-mcp-acceptance.md.
