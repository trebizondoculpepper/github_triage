# Manual MCP host smoke test (#25)

doc/design/mcp.md asks for at least one recorded smoke test with a real MCP host. That needs an authenticated `gh`, a host installation and a person to run it, so it is not automated. This is the procedure; the result is recorded as a comment on #25 (or a report under `doc/reports/`). Nothing here changes GitHub: all four tools are read-only.

## Preconditions

- Node 26 or later; `gh auth status` succeeds for an account that can read the target repository.
- A local checkout of the target repository (used as `--project`).
- The host under test (for example Claude Code, Codex CLI or another stdio MCP client), with its version noted.

## 1. Install the exact archive

From this repository on the commit under test:

```sh
npm ci
npm run build
npm pack
npm install --global ./trebizondoculpepper-pdb-<version>.tgz
pdb-mcp --help
```

`--help` must print usage on stdout and exit 0. Do not use `npx -y pdb-mcp`: the executable is not a separate npm package.

## 2. Check stdio framing without a host

Run the server with stdin closed after one request to confirm stdout carries only JSON-RPC (no banners or update notices):

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}' \
  | pdb-mcp --project /absolute/project/path
```

Expect exactly one JSON line whose `result.serverInfo.name` is `pdb` and whose `result.protocolVersion` is `2025-06-18`: the server echoes a supported requested version, and answers an unsupported one with its own latest (`2025-11-25` from package 0.1.0). Any non-JSON line on stdout is a failure.

Real hosts negotiate their own version, so record what they use rather than expecting a fixed value. Observed: Ori 0.17.0-alpha sends `initialize` at `2025-11-25` ([Ori report](reports/agent-platforms/ori-mcp-acceptance.md)); Claude Code 2.1.325 sends `server/discover` at `2026-07-28` with no `initialize` ([Claude Code report](reports/agent-platforms/claude-code-mcp-acceptance.md)).

## 3. Register with the host

Use the generic stdio configuration (README):

```json
{ "command": "pdb-mcp", "args": ["--project", "/absolute/project/path"] }
```

Add `"--agent", "NAME"` to focus reads. Always pass `--project` (or `--repo`): some hosts start servers in an unrelated working directory (#271). Register it through the host's own configuration mechanism; do not let any tool here write host configuration. Restart or reload the host.

Host notes:

- **Ori:** the server key becomes the identity entry (`ori-KEY` → `[agents."ori.KEY"]`). Ori's daemon can reuse a running server for a key it has started before, so use a fresh key whenever you change `args`. Ori starts a server declared in the repository's `./.ori/mcp.json` only after an operator approves it in an attended run, so for headless checks (`ori mcp test KEY`, `ori code -p`) put the configuration in a file outside the repository and select it with `ORI_MCP_CONFIG` or `--config`.
- **Claude Code:** see its report for the MCP output limit (#266) and project-scope approval.

## 4. Exercise the tools

In the host, without relying on a paid model turn where the host offers a direct tool-call or inspection view:

1. Confirm the host lists exactly `triage_briefing`, `triage_issue`, `triage_dependencies` and `triage_events`. `triage_events` reports disabled status unless the server was started with `--poll`.
2. Call `triage_briefing` with no arguments. Compare with `pdb --repo owner/name` run at the same time: same repository, same findings modulo fetch time.
3. Call `triage_issue` with a known open issue number, then with a nonexistent number (expect an incomplete result with a diagnosis, not an error dump).
4. Call `triage_dependencies` with an issue that has native blockers, then with `tree: true`.
5. Call `triage_briefing` with an invalid `repo` such as `bad` (expect an argument validation error, no stack trace, no local paths). Some hosts (Ori) reject it against the advertised input schema before the server sees it; record which side rejected it.
6. Identity: with no `--agent` and no tool `agent`, call `triage_briefing` and record `selection.agent`, `selection.identitySource`, `selection.entry` and `selection.identityDiagnostic`. With a root `agent-inbox.toml` entry for this host (for Ori, `[agents."ori.SERVER"]` where SERVER is the configured server key; for Claude Code, `[agents.claude]`), expect that entry's `name` with source `client` (Ori) or `environment`. Then pass `agent` explicitly and expect source `tool`. Confirm `agent-inbox.toml` is unchanged afterwards (`git status --ignored` and its modification time): the server never writes identity. Without a matching entry, expect `unresolved` with an unfocused read and a diagnostic, not an error.
7. Cancel a call mid-flight if the host supports it. Check whether the host actually sent `notifications/cancelled` (Ori 0.17.0-alpha does not, so the call runs to completion), and confirm no `gh` process is left running once the call has ended (`ps aux | grep '[g]h api'`).

## 5. Record

Post on #25 (or add a report under `doc/reports/agent-platforms/`):

- Date (UTC), commit SHA, package version, Node version, OS.
- Host name and version; the protocol version it negotiated if the host shows it.
- The identity source and diagnostic observed in step 4.6 (entry keys and names only; no paths).
- For each call: pass/fail, whether the host displayed `content` text, `structuredContent`, or both, and whether structured content appeared to reach the model.
- Host-visible token usage for a briefing and an issue intake, if the host reports it (this is the measurement doc/reports/mcp-cli-comparison.md could only approximate).
- Anything that failed or that the host did not support, stated as a limitation rather than inferred compatibility.

Remove the host registration afterwards if it was added only for the test.
