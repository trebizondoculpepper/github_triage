# Development Diary Entry - 2026-11-13

## Context
- **Date**: 2026-11-13 12:55 UTC
- **Branch**: issue-25-mcp
- **Contributors**: Claude Code (kavya_sabbagh) + User

## Problem Statement
Issue #25 asks for the generic MCP interface alongside the CLI, following the merged contract in doc/design/mcp.md.

## Our Approach
Deliver the first buildable slice: a transport-neutral read service (`src/service.ts`) used by both the CLI briefing path and a new stdio MCP entry point (`src/mcp.ts`) built on the approved `@modelcontextprotocol/server` 2.4.0 and Zod 4. Three strict, read-only tools return the CLI's unchanged versioned JSON inside a schemaVersion 1 envelope.

## Implementation
The CLI's briefing presentation and unavailable-issue text moved into the service; `currentRepository` gained an optional `cwd` for `--project`. A second bin `github-triage-mcp` is built as a separate bundle so the archive allowlist stays exact. Tests drive a real SDK client over an in-memory transport for tool listing, CLI parity, strict validation, per-call selection under concurrency, sanitized errors, incomplete/denied evidence and cancellation. The installed-archive test now completes a stdio round trip with the globally installed MCP bin.

## Outcomes
All checks, tests, build and package test pass. Cancellation is detected around collection but not yet propagated into `gh` child processes.

## Next Steps
Remaining for #25: client roots and verified `agent-inbox.toml` identity lookup (`--harness`/`--entry`, maintained TOML parser), abort propagation to child processes, older-client negotiation tests, a recorded real-host smoke and the token/latency comparison.
