# Claude Code platform review addendum (#253)

Reviewed on 2026-11-13 against `origin/main` commit `3d3389c`. This addendum supplements `doc/reports/agent-platforms/claude-code.md` (#225), which remains intact apart from a one-line pointer. Line references are to that file at this commit. The evidence comes from the live acceptance run in [claude-code-mcp-acceptance.md](claude-code-mcp-acceptance.md), where the installed `github-triage-mcp` server ran under a real Claude Code 2.1.325 client.

The main recommendation still holds. The plain MCP server is the right Claude Code integration, and the Agent SDK and ACP adapter are not notification routes. The corrections below sharpen the MCP setup advice and the session-binding notes without changing that recommendation.

## Confirmations

- **MCP configuration flow (lines 38, 67).** `--mcp-config FILE --strict-mcp-config` loads only the given server; the init event reported `triage` as `connected`. `claude mcp add --scope project NAME -- CMD ARGS` writes `.mcp.json` in the project. `claude mcp get` reports scope, command and approval state (the server was still pending approval, so it was not started), and `claude mcp remove --scope project` removes the entry. None of these steps changed the user-level `mcpServers` in `~/.claude.json`.
- **Harness signals (line 68).** The MCP server process itself, not only a Bash tool call, receives `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT`. The client sets both: with every `CLAUDE*` variable removed from the launching environment, the server still saw `CLAUDECODE=1` and `CLAUDE_CODE_ENTRYPOINT=sdk-cli` under `claude -p`. Detection in `src/harness.ts` selected the `claude` entry.
- **`CLAUDE_CODE_SESSION_ID` (lines 58, 68, 93).** It is present in the MCP server environment and equals the client's `session_id` (compared by truncated hash; no IDs recorded). It is therefore usable as a session-binding signal for an MCP server or a hook.
- **`--resume` and `--fork-session` (lines 10, 41, 51).** `claude -p --resume ID` started a new process with the earlier history: it recalled a word from the first turn. Its MCP server saw the same session ID as the original. Adding `--fork-session` kept the history but produced a new session ID, which the server also saw. This confirms the report: resume loads history into a new process and does not attach to a running one.
- **Existing-session boundary (line 42).** Nothing observed offers attachment to a running session; every `-p` run, resumed or forked, was its own process.

## Corrections

### Medium: default MCP reads do not fit Claude Code's tool-output limit

Line 10 presents plain MCP tools as working without qualification, and line 75 proposes documenting a `claude mcp add` example after the installed-bin smoke. With default settings, the default action `triage_briefing` (about 67 KB), a full `triage_issue` intake (about 72 KB) and `triage_dependencies` with `tree: true` (about 65 KB) all exceed Claude Code's MCP output limit. The model receives an error and a path to a saved file instead of the result. Claude Code forwards `structuredContent`, so the server's `maxChars` text bound does not help.

Correction: the integration is conditional. Any documented example must set `MAX_MCP_OUTPUT_TOKENS` (60000 worked) until the server bounds its structured output. The repository briefing mode (about 27 KB) and single-level dependencies fit the default limit.

### Low: project-scope registration needs interactive approval

Line 94's proposed `claude mcp add github-triage ...` example should say which scope it uses. With project scope, Claude Code reports `Pending approval (run claude to approve)`, so a headless `claude -p` does not load the server until someone approves it interactively. Correction: document `--mcp-config` for headless and test use, and project or local scope with the approval step for interactive use.

### Low: the server environment differs from the Bash-tool environment

Line 68 lists the names seen in a Bash tool call. The MCP server process under `claude -p` did not receive `CLAUDE_CODE_CHILD_SESSION` or `AI_AGENT`, and it did receive `CLAUDE_PROJECT_DIR`, which line 68 does not list. The two variables in `src/harness.ts` are present in both environments. Correction: when citing environment evidence, name the process that observed it (a Bash tool, a hook or an MCP server), and do not assume the same set holds for the others.

### Low: a session ID does not identify a single process

Line 58 proposes binding a waiter to "the current session (`CLAUDE_CODE_SESSION_ID` presence)". Because `--resume` reuses the session ID in a new process, two processes can carry the same ID: the original interactive one and a resumed `-p` one. Correction: a session-bound waiter should treat the ID as a binding key and still hold the per-session lock the report already proposes. It should not assume one process per ID.

## Still unverified

- The value of `CLAUDE_CODE_ENTRYPOINT` in interactive, IDE and Desktop sessions. Only `sdk-cli` (`claude -p`) was observed. Detection uses presence, so this does not affect current behavior.
- `claude mcp list`, which was again not run because it may start configured servers.
- Hooks, `asyncRewake`, Channels, MCP tasks, Agent SDK and ACP sessions, and any wake experiment, none of which were exercised.
- Licences and package metadata, which were not re-audited.
- Client roots: Claude Code advertised a `roots` capability (`listChanged: true`), but roots were not used. Optional root discovery remains #256.

## Review environment and limits

The review ran as a Claude Code 2.1.325 session on model Claude Opus 5.5 (`claude-opus-5-5`), on macOS 27.2 with Node v26.7.0. The target client was a separate `claude -p` process from the same 2.1.325 installation, using the `haiku` alias (`claude-haiku-5-5`) for a small number of short, read-only turns. Disposable Git directories, MCP config files and identity files lived in a scratch directory. No user or project Claude settings were changed and no user-scope MCP registration was made. The test sessions that Claude Code persisted were deleted afterwards. No GitHub writes were made. The original author's harness and model are taken from the report's own statement and were not independently established.
