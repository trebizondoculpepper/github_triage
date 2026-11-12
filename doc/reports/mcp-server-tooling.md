# MCP server tooling for GitHub Triage (#19)

Research report and recommendation only. Nothing here is implemented, and no package, configuration or publication changes are made. Implementation follows a reviewed design contract under #25.

## Summary

Use the **official MCP TypeScript SDK, v2 line: `@modelcontextprotocol/server`**, served over **stdio** from a second entry point next to the existing CLI. It is the reference implementation of the protocol, works from plain JavaScript ESM, runs on Node 20+, which matches this package's `engines`, and gives us schema validation, structured output, cancellation and in-process testing without writing any protocol code. The third-party frameworks either wrap the older v1 SDK or bring web-framework, CLI or agent-platform dependencies that a local triage tool does not need. No language rewrite is needed or justified.

Start with three read-only tools (`triage_briefing`, `triage_issue`, `triage_dependencies`) that call the same `collect` / `briefing` / `compactBriefing` / `dependencyReport` functions as the CLI and return the CLI's existing versioned JSON. Mutation tools wait for the #2 and #5 contracts.

## Requirements taken from #19 and #25

- An established library, not a handwritten protocol.
- Fits the current runtime: plain JavaScript ES modules run directly with Node, Node 20+ (`package.json` `engines`), Vite+ for checks, tests and packing, distributed through npm with a `bin`.
- Local stdio transport, using the user's existing `gh` authentication. The MCP layer adds no new credentials.
- Input and output schemas, explicit errors, cancellation, and tests through injected boundaries.
- A small dependency footprint, compatibility with the hosts agents use, and stable APIs rather than previews.
- Shares collection and workflow logic with the CLI; MCP does not change anyone's authority to act.

## Candidates

All facts were read from the npm registry (`npm view`) and the projects' repositories and documentation on 2026-11-12.

|                      | Official SDK v2 `@modelcontextprotocol/server`                                                       | Official SDK v1 `@modelcontextprotocol/sdk`                                         | `fastmcp` (punkpeye)                                                                          | `mcp-framework` (QuantGeekDev)                                             | `@mastra/mcp`                                                                | `mcp-handler` (Vercel Labs)           |
| -------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------- |
| Latest version, date | 2.4.0, 2026-10-23                                                                                    | 1.32.2, 2026-10-23                                                                  | 4.26.2, 2026-11-11                                                                            | 0.2.22, 2026-04-16                                                         | 2.8.0, 2026-11-12                                                            | 2.4.0, 2026-11-12                     |
| Status               | Current stable line; implements the 2026-07-28 MCP spec                                              | Previous line; bug and security fixes for at least six months after v2 (2026-07-27) | Maintained wrapper                                                                            | Pre-1.0; last release seven months ago                                     | Part of the Mastra agent framework                                           | Next.js and Vercel route handler      |
| License              | Apache-2.0 for new code, existing code MIT                                                           | MIT                                                                                 | MIT                                                                                           | MIT (GitHub; npm metadata has none)                                        | Apache-2.0                                                                   | Apache-2.0                            |
| Node                 | ≥20                                                                                                  | ≥18                                                                                 | not declared                                                                                  | ≥18.19                                                                     | ≥22.13                                                                       | ≥20                                   |
| Runtime dependencies | `@modelcontextprotocol/core`, `zod` ^4.2                                                             | 17, including `express`, `hono`, `cors`, `jose`, `ajv`                              | 14, including the **v1** SDK (^1.24.3), `hono`, `yargs`, `execa`, `mcp-proxy`, swagger parser | Includes `typescript`, `commander`, `prompts`, `jsonwebtoken`; peer v1 SDK | v2 SDK packages plus `tsx`, `json-schema-to-typescript`; peer `@mastra/core` | Peer `next`, OpenTelemetry, v2 server |
| Local stdio          | `serveStdio(factory)`                                                                                | `StdioServerTransport`                                                              | Yes                                                                                           | Yes                                                                        | Yes                                                                          | No (HTTP route handler)               |
| Input/output schemas | Standard Schema (Zod v4, Valibot, ArkType); `outputSchema` validated before results leave the server | Zod 3/4                                                                             | Standard Schema                                                                               | Zod 3                                                                      | Zod 4                                                                        | Inherits v2                           |
| Fit here             | **Best**: smallest dependency set of the maintained options, current spec, no framework              | Works, but is the line being retired; heavier dependency tree                       | Convenient API, but stacks on v1 and adds HTTP, CLI and proxy dependencies                    | Class-and-scaffold style aimed at TypeScript projects; slower releases     | Ties us to an agent platform and Node 22.13                                  | Wrong shape for a local CLI           |

Unpacked sizes (npm `dist.unpackedSize`): v2 server 7.0 MB plus `zod` 6.1 MB; v1 SDK 4.5 MB plus 17 dependencies; fastmcp 2.5 MB plus its dependencies. Install size was not measured as a full tree; the dependency lists are the more meaningful comparison.

### What the official v2 SDK provides that we need

From the SDK documentation (`docs/servers/tools.md`, `docs/servers/logging-progress-cancellation.md`, `docs/serving/stdio.md`, `docs/testing.md`):

- **Tools with schemas.** `server.registerTool(name, { description, inputSchema, outputSchema }, handler)`. Arguments that fail the input schema come back as an `isError: true` result and the handler never runs. `structuredContent` is validated against `outputSchema` before it leaves the server, and the derived JSON Schema is advertised in `tools/list`.
- **Errors.** A handler failure is a normal tool result with `isError: true`, which the model can read; protocol failures are separate. This matches the CLI's practice of returning plain error messages that never echo `gh` arguments or response bodies.
- **Cancellation.** `ctx.mcpReq.signal` is an `AbortSignal`, aborted when the client sends `notifications/cancelled` or the connection closes. `collect` already takes an injected query function, so threading a signal through to `execFile` is a small change.
- **Progress and logging** on `ctx.mcpReq`, optional.
- **stdio.** `serveStdio(() => server)` owns the transport and serves older clients from the same factory by default. stdout is the protocol channel, so all diagnostics must go to stderr. The current CLI writes reports to stdout, so the MCP entry point must never call the CLI's `output` default.
- **Testing.** A real `Client` can drive the server in-process (`InMemoryTransport.createLinkedPair()` or an in-process handler), with no port or socket. Together with the existing injected `gh` query and clock, MCP tests need no credentials.

Plain JavaScript: the SDK ships compiled ESM, and Zod schemas are ordinary JavaScript values. Nothing requires TypeScript sources or a build step to run, so `node src/mcp.js` would work like `node src/cli.js`.

### Stable versus preview

The v2 line is the documented stable release. Notifications such as `tools/list_changed` are stable but only tell a connected client that lists changed. Neither the SDK nor the protocol says that a notification wakes an idle model or interrupts an active turn. That is the subject of #20 to #24, and this report assumes nothing about it.

## Recommended tool surface

All read-only, returning the same versioned JSON the CLI produces (`--json`), as `structuredContent`, plus a short text rendering in `content`. All take an optional `repo` (`owner/name`).

| Tool                  | Serves                                     | CLI equivalent                                                                                             |
| --------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `triage_briefing`     | Implementer triage and designer catch-up   | `triage [--json] [--since ISO] [--agent NAME] [--limit N]` (compact schema 2; `full: true` gives schema 1) |
| `triage_issue`        | Full intake for one ticket                 | `triage --issue N --json`                                                                                  |
| `triage_dependencies` | Native blockers, dependants, drift, cycles | `deps N [--tree] --json`                                                                                   |

Deliberately left out of the first slice: `--cache`, `--offline` and `--checkpoint` (file paths chosen by the client are a filesystem-safety question for the design), role views (#1), agent-addressed attention (#3), and every mutation (#2 claiming and flagging, #5 dependency edits, #6 migration). Mutation tools, when they come, should be separate tools with MCP's `destructiveHint`/`readOnlyHint` annotations, and follow the "Rules for commands that change tickets" in `doc/issue-dependencies.md`.

### Design points for #25

- **Project selection.** Default to the repository of the server's working directory, as the CLI does through `gh repo view`. Hosts usually start a local server in the project directory. An explicit `repo` argument overrides this, validated as `owner/name`, as the CLI does today.
- **Agent identity.** Identity design is still open (#3, #14). Until it is settled, accept an explicit `agent` argument, as `--agent` does now, and do not read `agent-inbox.toml` implicitly.
- **Authentication.** Reuse the user's existing `gh` session through `execFile`, unchanged. The MCP layer never sees or passes a token.
- **Read and mutation separation.** One server can expose both later, but read tools must stay free of side effects, as the CLI contract already requires.
- **Discovery and context overhead.** Three tools with short descriptions keep `tools/list` small. Most context cost comes from results: a live run on 2026-11-12 against this repository (23 open issues, 5 PRs) gave compact text of 7.7 KB, compact JSON of 44 KB and full JSON of 82 KB, from 2 GraphQL requests in about 1.1 s. Compact JSON is about six times the size of compact text, so `triage_briefing` should return the compact text in `content` and the compact JSON only in `structuredContent`. The design should check which hosts pass `structuredContent` to the model, since that decides the actual token cost.
- **Shared logic.** Move the CLI's `main` orchestration into a function both entry points call, with the same injected `gh`, clock and filesystem boundaries, so the two cannot drift.

## Proposed packaging (not applied)

Add a second `bin`, for example `"github-triage-mcp": "src/mcp.js"`, and the dependencies `@modelcontextprotocol/server` and `zod`. Hosts then configure `npx -y github-triage-mcp` or a local path, for example in Claude Code with `claude mcp add github-triage -- npx -y github-triage-mcp`. Publication and naming belong to #17, and nothing here changes `package.json`. The fix in #11/PR #15 for running through npm's symlinked bin applies to the new entry point too.

## How to measure it

Compare MCP against the CLI on the two primary workflows, using the same repository state (a recorded `--cache` snapshot for repeatable runs, plus one live run):

1. **Implementer triage**: "what should I pick up next, and which PRs need me?"
2. **Designer catch-up**: "what changed since my last checkpoint, and what needs my attention?"

For each, record:

- **Latency**: wall-clock time from request to result, and `metrics.durationMs`.
- **Calls**: MCP tool calls and `gh` GraphQL requests (`metrics.requestCount`), against the CLI shell commands an agent runs for the same answer.
- **Size**: bytes of `content` and `structuredContent`, and tokens counted by the host or the model API.
- **Correctness**: the MCP JSON must equal the CLI JSON for the same snapshot. That is a parity test in CI, not a manual check.

No speed claim is made from the choice of protocol alone. Any benefit has to show up in those numbers.

## Open questions

1. Which hosts pass `structuredContent` to the model, and which only `content`? This decides whether to return compact text, JSON, or both.
2. Should the MCP server accept a cache or checkpoint path from the client, or keep its own per-project state? This touches filesystem safety and #3's catch-up design.
3. Is Zod (6 MB unpacked) acceptable as a runtime dependency, or should the design use another Standard Schema library? Zod is what the SDK's own examples and peer ranges use.
4. Should v1 be supported for hosts that only speak older protocol revisions? `serveStdio` already serves older clients from the same factory by default, so probably not; confirm during the host smoke tests in #25.
5. How agent identity reaches the server: argument, environment, or the per-project inbox file once #14 settles it.

## Follow-up implementation proposal (bounded)

Under #25, after its design contract merges:

1. Extract the CLI orchestration into shared functions with injected boundaries. No behaviour change, proved by the existing tests.
2. Add `src/mcp.js` with the three read-only tools on `@modelcontextprotocol/server` over `serveStdio`.
3. Tests: an in-process `Client` calls each tool against the injected fake `gh`; parity tests show MCP `structuredContent` equals CLI `--json` output for the same snapshot; schema rejection and `isError` paths; cancellation aborts the `gh` call.
4. A smoke test with the MCP Inspector or a real host against this repository, recorded on the PR.
5. Documentation of installation and host configuration. Publication stays with #17.

## Sources

Accessed 2026-11-12.

- npm registry metadata via `npm view` for `@modelcontextprotocol/server`, `@modelcontextprotocol/core`, `@modelcontextprotocol/sdk`, `fastmcp`, `mcp-framework`, `@mastra/mcp`, `mcp-handler`, `zod`.
- MCP TypeScript SDK repository README: https://github.com/modelcontextprotocol/typescript-sdk
- SDK releases (v2.4.0 and 1.32.2, 2026-10-23): https://github.com/modelcontextprotocol/typescript-sdk/releases
- SDK docs, tools: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/tools.md
- SDK docs, logging, progress and cancellation: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/logging-progress-cancellation.md
- SDK docs, notifications: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/servers/notifications.md
- SDK docs, serving over stdio: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md
- SDK docs, testing: https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/testing.md
- fastmcp repository: https://github.com/punkpeye/fastmcp
- mcp-framework repository: https://github.com/QuantGeekDev/mcp-framework
- Local measurement: `node src/cli.js --repo trebizondoculpepper/github_triage` (compact text, `--json`, `--full --json`, `--cache` metrics), 2026-11-12, on the #4 branch.
