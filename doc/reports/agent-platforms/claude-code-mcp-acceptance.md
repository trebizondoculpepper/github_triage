# Claude Code MCP acceptance (#253)

Real-client acceptance of the installed `github-triage-mcp` server in Claude Code, for the per-client matrix of parent #25. Recorded on 2026-11-13 (UTC). All GitHub calls were read-only; no issue, claim or label was changed.

**Verdict: conditional.** Every required check passed in a real Claude Code client, with one condition: with Claude Code's default MCP output limit, the default `triage_briefing`, a full `triage_issue` intake and `triage_dependencies tree: true` are not delivered to the model (see Finding 1). With `MAX_MCP_OUTPUT_TOKENS` raised they are delivered in full, but as `structuredContent` JSON rather than the bounded text.

## Provenance

| Item                | Value                                                                                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target client       | Claude Code CLI `2.1.325 (Claude Code)`, non-interactive `claude -p`, model alias `haiku` (resolved `claude-haiku-5-5`) for the test turns                                                                                                                                |
| Researcher          | A separate Claude Code 2.1.325 session on model Claude Opus 5.5 (`claude-opus-5-5`) drove the runs from Bash. The researcher's own MCP servers were not involved: `--strict-mcp-config` loaded only the test server                                                       |
| OS / runtime        | macOS 27.2 (Darwin 27.2.0, arm64), Node v26.7.0, authenticated `gh`                                                                                                                                                                                                       |
| Package             | `@trebizondoculpepper/github-triage` 0.1.0, source `52466e8`; `src/` and `package.json` are unchanged through `origin/main` `3d3389c`                                                                                                                                     |
| Executable          | Global bin `/opt/homebrew/bin/github-triage-mcp` → `lib/node_modules/@trebizondoculpepper/github-triage/dist/mcp.mjs`. Used because it is current: `cmp` shows its `dist/mcp.mjs` and `dist/cli.mjs` are byte-identical to `npm ci && npm run build` of the source above  |
| Negotiated protocol | `2026-07-28`. Claude Code sent `server/discover` (no `initialize`), then `subscriptions/listen`, `tools/list`, `tools/call`; clientInfo `claude-code` 2.1.325, advertising `roots`. Server answered `supportedVersions: ["2026-07-28"]`, serverInfo `github-triage` 0.1.0 |

## Results

| Check                                               | Result      | Evidence                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup and discovery                               | supported   | init event: server `triage` status `connected`; tools `triage_briefing`, `triage_dependencies`, `triage_events`, `triage_issue`                                                                                                                                                                                   |
| `triage_briefing` (default, actions)                | conditional | Default limit: `result (67,886 characters) exceeds maximum allowed tokens`; the model got only an error and a path to a saved file. `maxChars: 1000` did not help (67,866 characters). With `MAX_MCP_OUTPUT_TOKENS=60000`: delivered, `kind: briefing`, `status: complete`                                        |
| `triage_issue` 253                                  | conditional | Same limit (71.6 KB); delivered with the raised limit, `status: complete`                                                                                                                                                                                                                                         |
| `triage_issue` 999999                               | supported   | `status: incomplete`, `kind: issue-unavailable`, state `missing`; no error dump                                                                                                                                                                                                                                   |
| `triage_dependencies` 25                            | supported   | `status: complete`; open blockers #252–#255, closed #19, #38, #70                                                                                                                                                                                                                                                 |
| `triage_dependencies` 25, `tree: true`              | conditional | 64.9 KB, delivered only with the raised limit; `complete`, no cycles                                                                                                                                                                                                                                              |
| Invalid `repo: "bad"`                               | supported   | `is_error`, `Input validation error: ... repo must be owner/name`; no stack trace or paths                                                                                                                                                                                                                        |
| Repository briefing (`mode: briefing`, `last: 24h`) | supported   | `kind: repository-briefing`, `status: complete`, about 27 KB, within the default limit                                                                                                                                                                                                                            |
| Persistent name and `triage_role`                   | supported   | Identity created with `github-triage config set identity.triage_role implementer --entry claude` and `config set identity.name acc_claude_probe --entry claude` in a disposable Git directory. No arguments: `agent: acc_claude_probe`, `identitySource: environment`, `entry: claude`, `triageRole: implementer` |
| Detection from the client's own markers             | supported   | Rerun with every `CLAUDE*` variable removed from the parent environment: the client re-set `CLAUDECODE=1` and `CLAUDE_CODE_ENTRYPOINT=sdk-cli` for the server, and selection was again `environment` / `claude`                                                                                                   |
| Project override (`--project`)                      | supported   | Every run selected the disposable project with `--project`; the repository resolved from its `origin` remote                                                                                                                                                                                                      |
| Startup `--repo` and `--entry`                      | supported   | `identitySource: entry`, `entry: claude`, role `implementer`                                                                                                                                                                                                                                                      |
| Startup `--agent`                                   | supported   | `agent: override_probe`, `identitySource: startup`, `entry: null`, `triageRole: null`                                                                                                                                                                                                                             |
| Tool `agent` argument                               | supported   | `agent: tool_probe`, `identitySource: tool` over a startup `--agent`                                                                                                                                                                                                                                              |
| Missing identity                                    | supported   | No `agent-inbox.toml`: `identitySource: unresolved`, unfocused read, diagnostic `There is no agent-inbox.toml at the project root. Pass agent, or start the server with --agent NAME, --entry KEY or --harness NAME; ...`                                                                                         |
| Ambiguous identity                                  | supported   | Entries `claude` and `claude.review`: `unresolved`, `entry: null`, diagnostic `Several logical agent entries use the claude harness, so no entry is chosen. Candidate entries: claude, claude.review. ...`                                                                                                        |
| Identity file read-only                             | supported   | Modification times of both disposable `agent-inbox.toml` files were unchanged after all runs                                                                                                                                                                                                                      |
| Cancellation                                        | supported   | SIGINT to `claude -p` during a 30-day repository briefing: the client sent `notifications/cancelled` (`requestId: 2`, `reason: AbortError: user-cancel`). The server sent no response for that ID. No `github-triage-mcp` or `gh api` child of the test was left                                                  |
| Protocol cleanliness                                | supported   | Tee of both directions: 0 non-JSON lines on stdin or stdout, empty stderr                                                                                                                                                                                                                                         |
| Parallel tool calls                                 | supported   | The model issued `triage_briefing` and `triage_issue` together in one turn; both returned                                                                                                                                                                                                                         |

Content shape: in every delivered result the model saw the JSON envelope (`{"schemaVersion":1,"kind":...,"selection":...}`), not the bounded `content` text. The model received `structuredContent` when it was present.

## Findings

1. **Default reads exceed Claude Code's MCP output limit.** `maxChars` bounds only the text content. `structuredContent` carries the full result (66–72 KB for an action briefing or issue intake), and Claude Code measures and forwards the structured result. With default settings, an agent's first `triage_briefing` call returns nothing usable. Workaround: set `MAX_MCP_OUTPUT_TOKENS` (for example 60000) in the environment that launches Claude Code. Proposed fix: bound or summarise `structuredContent`, or offer a compact mode, so default calls fit.
2. **The smoke guide is out of date for this client.** `doc/mcp-host-smoke-test.md` expects exactly three tools, but the server also exposes `triage_events`. It also describes an `initialize` handshake at `2025-06-18`, whereas Claude Code 2.1.325 negotiates `2026-07-28` through `server/discover`.
3. **Startup `--agent` drops the role.** With `--agent NAME`, `triageRole` is `null`, even when a `claude` entry with a role exists. This may be intended, because `--agent` is not an entry key. If so, it should be documented.
4. **Project-scope registration needs interactive approval.** `claude mcp add --scope project` writes `.mcp.json` and reports `Pending approval (run claude to approve)`. A headless `-p` run therefore needs `--mcp-config` or a prior interactive approval.
5. **Large results are saved under `~/.claude/projects/` even with `--no-session-persistence`.** Over-limit results are written to a `tool-results` file. The researcher deleted that test directory afterwards.

## Reproducible checklist

The checklist uses a scratch directory `$S` and the bin `github-triage-mcp` on `PATH`, built as in `doc/mcp-host-smoke-test.md`. It needs no user or project Claude settings and no `claude mcp add`.

```sh
# 1. Disposable project and identity, using the project's own commands
mkdir -p "$S/proj" && cd "$S/proj" && git init -q
git remote add origin https://github.com/trebizondoculpepper/github_triage.git
github-triage config set identity.triage_role implementer --entry claude
github-triage config set identity.name acc_claude_probe --entry claude

# 2. Disposable MCP config
printf '{"mcpServers":{"triage":{"type":"stdio","command":"github-triage-mcp","args":["--project","%s"]}}}\n' "$S/proj" > "$S/mcp.json"

# 3. Real client, triage tools only, no built-in tools
export MAX_MCP_OUTPUT_TOKENS=60000   # omit once to reproduce Finding 1
claude -p --mcp-config "$S/mcp.json" --strict-mcp-config --tools "" \
  --allowedTools mcp__triage__triage_briefing mcp__triage__triage_issue mcp__triage__triage_dependencies \
  --no-session-persistence --model haiku --output-format stream-json --verbose \
  "Call triage_briefing once with no arguments. Reply with the selection fields."
```

Variants:

- Prompts: `triage_issue` 253 and 999999, `triage_dependencies` 25 with and without `tree`, `triage_briefing` with `repo: "bad"`, and `mode: "briefing"`.
- Missing identity: a second Git directory without `agent-inbox.toml`.
- Ambiguous identity: add `--entry claude.review` with `config set`.
- Overrides: add `"--agent","NAME"` or `"--repo",...,"--entry","claude"` to `args`, or pass `agent` in the prompt.
- Protocol and cancellation: wrap the command in a script that `tee`s stdin and stdout, send SIGINT to `claude` during a `last: 30d` repository briefing, then check for leftover processes with `pgrep -fl 'gh api|github-triage-mcp'`.

Read the init event's `tools` and `mcp_servers` and each `tool_result` from the stream. Record only selection fields and status lines.
