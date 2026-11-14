# Development Diary Entry - 2026-11-13

## Context

- **Date**: 2026-11-13 UTC
- **Branch**: issue-255-ori-mcp-acceptance
- **Contributors**: Ori Code (vijay_larionova) + owner

## Problem Statement

Issue #255: record whether the installed `github-triage-mcp` works in a real Ori client, for the per-client matrix of #25.

## Our Approach

Installed the packed archive of `origin/main` into a private npm prefix, rather than the stale global bin. Then drove headless `ori code -p --output jsonl` turns with only the test server loaded through `ORI_MCP_CONFIG`. A `tee` wrapper recorded both stdio directions and the server's environment variable names. Disposable identities were created with `config set --entry ori.<key>`.

## Outcomes

Conditional pass. `ori-<key>` clientInfo maps to `ori.<key>` with no environment marker. Ori forwards the bounded text, not `structuredContent`, so #266 does not affect it. Two conditions:

- Ori sends no `notifications/cancelled`.
- Servers start in the daemon's working directory, so without `--project` the default repository comes from an unrelated checkout. That contradicts doc/design/mcp.md; follow-up #271.

The Ori daemon also keeps server processes between turns, so each variant needs a fresh server key.

## Next Steps

#271 (refuse cwd fallback), #272 (smoke guide refresh). The OpenCode and Codex acceptances (#252, #254) remain for #25.
