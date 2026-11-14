# Development Diary Entry - 2026-11-14

## Context

- **Date**: 2026-11-14 UTC
- **Branch**: issue-260-parity
- **Contributors**: Claude Code (kavya_sabbagh) + User

## Problem Statement

Issue #260 asks for installed acceptance of the blended role queues and CLI/MCP action parity. The MCP `triage_briefing` tool had no `role` argument, so MCP never returned `rankedActions`, the designer queue or `impactEstimation`.

## Our Approach

Contract first: PR #288 records additive `role` and `order` arguments in doc/design/mcp.md, which previously excluded role flags from the MCP baseline. The implementation passes both through the shared read service so CLI and MCP call the same `presentBriefing` with the same options.

## Implementation

`src/mcp.ts` validates `role` against the role registry and `order` against `pickupOrders`, and rejects both in briefing mode. `src/service.ts` forwards them. `src/mcpparity.test.ts` runs the CLI `main()` and an in-memory MCP client through the real `collect()` with one fake GraphQL boundary, for both roles, both order modes, a small limit, and a disabled metric. `scripts/package-test.ts` installs the packed archive, puts a credential-free fake `gh` on PATH (POSIX only) and checks the installed CLI and installed MCP server report identical queues; `GITHUB_TRIAGE_PACKAGE_LIVE_REPO=owner/name` adds a read-only live run with revision and executable provenance.

## Outcomes

- Parity holds for `actions`, `role`, `rankedActions`, `estimation` and `impactEstimation`.
- The first installed comparison failed because the checkout was not a Git repository: configuration was unknown and the CLI and MCP diagnostics differed only by MCP's local-path redaction. A real checkout with an origin remote fixes the fixture; the redaction is intended.
- Role views make the v1 MCP result larger (live: about 79 KB without role, 117-119 KB with), mostly through `subjects`. The 16 KB bound belongs to #266, not this change.

## Next Steps

#266 bounded results should apply to role views; Windows lacks the fake-gh installed parity check.
