# Manual MCP host smoke test (#25)

doc/design/mcp.md asks for at least one recorded smoke test with a real MCP host. That needs an authenticated `gh`, a host installation and a person to run it, so it is not automated. This is the procedure; the result is recorded as a comment on #25 (or a report under `doc/reports/`). Nothing here changes GitHub: all three tools are read-only.

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
npm install --global ./trebizondoculpepper-github-triage-<version>.tgz
github-triage-mcp --help
```

`--help` must print usage on stdout and exit 0. Do not use `npx -y github-triage-mcp`: the executable is not a separate npm package.

## 2. Check stdio framing without a host

Run the server with stdin closed after one request to confirm stdout carries only JSON-RPC (no banners or update notices):

```sh
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"manual","version":"0"}}}' \
  | github-triage-mcp --project /absolute/project/path
```

Expect exactly one JSON line whose `result.protocolVersion` is `2025-06-18` and `result.serverInfo.name` is `github-triage`. Any non-JSON line on stdout is a failure.

## 3. Register with the host

Use the generic stdio configuration (README):

```json
{ "command": "github-triage-mcp", "args": ["--project", "/absolute/project/path"] }
```

Add `"--agent", "NAME"` to focus reads. Register it through the host's own configuration mechanism; do not let any tool here write host configuration. Restart or reload the host.

## 4. Exercise the tools

In the host, without relying on a paid model turn where the host offers a direct tool-call or inspection view:

1. Confirm the host lists exactly `triage_briefing`, `triage_issue` and `triage_dependencies`.
2. Call `triage_briefing` with no arguments. Compare with `github-triage --repo owner/name` run at the same time: same repository, same findings modulo fetch time.
3. Call `triage_issue` with a known open issue number, then with a nonexistent number (expect an incomplete result with a diagnosis, not an error dump).
4. Call `triage_dependencies` with an issue that has native blockers, then with `tree: true`.
5. Call `triage_briefing` with an invalid `repo` such as `bad` (expect an argument validation error, no stack trace, no local paths).
6. Cancel a call mid-flight if the host supports it; confirm no `gh` process is left running (`ps aux | grep '[g]h api'`).

## 5. Record

Post on #25:

- Date (UTC), commit SHA, package version, Node version, OS.
- Host name and version; the protocol version it negotiated if the host shows it.
- For each call: pass/fail, whether the host displayed `content` text, `structuredContent`, or both, and whether structured content appeared to reach the model.
- Host-visible token usage for a briefing and an issue intake, if the host reports it (this is the measurement doc/reports/mcp-cli-comparison.md could only approximate).
- Anything that failed or that the host did not support, stated as a limitation rather than inferred compatibility.

Remove the host registration afterwards if it was added only for the test.
