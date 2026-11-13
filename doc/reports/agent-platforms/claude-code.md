# Claude Code libraries and platform-specific adapters (#225)

See also the [review addendum](claude-code-review-addendum.md) (#253), which corrects and confirms parts of this report from a live MCP run.

Platform follow-up for the parent synthesis #20, written by an agent running in Claude Code (CLI 2.1.325, macOS). It builds on [claude-code-idle-wakeup.md](../claude-code-idle-wakeup.md) (#22) and records only what is new or changed: the library inventory, the per-surface session-control matrix and the existing-session boundary. Research and documentation only: no runtime code, hooks, settings, MCP registrations, sessions or GitHub state were changed, and no model turns were paid for.

## Summary

There are three distinct ways to integrate with Claude Code, and they must not be confused:

1. **Plain MCP tools** (the baseline in [mcp.md](../../design/mcp.md)). Claude Code is an MCP client; a `github-triage-mcp` stdio server registered by the user is called by the model inside the user's own session. No library beyond the official MCP SDK is needed, and nothing wakes or steers the session.
2. **Native SDK control** through the official Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, Python `claude-agent-sdk`). The SDK spawns and owns its own Claude Code process. It can create, resume (`resume`/`continue`) and fork sessions from the transcript on disk, stream input, interrupt and answer permission requests, but only for sessions it drives. Resuming a session ID loads history into a new process; it does not attach to a running interactive session.
3. **ACP controller-owned sessions** through `@agentclientprotocol/claude-agent-acp`, an Apache-2.0 adapter built on the Agent SDK. The ACP client (an editor such as Zed) owns the session. Same boundary as the SDK.

**What changed since #22:** nothing in the libraries offers attachment to an already-running, user-owned CLI session. The only documented host routes into a live idle session remain host features, not libraries: an `asyncRewake` hook, the session's own inbox socket (`CLAUDE_CODE_MESSAGING_SOCKET`), Channels (research preview) and MCP task results (public beta).

**Recommendation.** Keep the plain MCP server as the Claude Code integration and add, as an opt-in later slice, the `asyncRewake` waiter hook proposed in #22 over the shared triage events service. Do not adopt the Agent SDK or the ACP adapter for notification: they start or resume their own sessions (a new process and, for any prompt, a paid model turn) and would not reach the user's running agent. The SDK remains a good fit for a separate, explicitly requested "headless triage worker" and for disposable-session tests.

## Libraries

Versions from `npm view <pkg> version license engines repository.url maintainers time.modified --json` on 2026-11-13.

| Package / repository                                                                                      | Maintainer                          | License                                        | Version (registry modified)    | Runtime      | Role                                                  | Assessment                                                                                                                              |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------- | ------------------------------ | ------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `@anthropic-ai/claude-code`                                                                               | Anthropic                           | "SEE LICENSE IN README.md" (proprietary terms) | 2.1.325 (2026-11-13)           | Node >=22    | The CLI host itself                                   | Host, not a library. Version matches the local CLI.                                                                                     |
| `@anthropic-ai/claude-agent-sdk` ([repo](https://github.com/anthropics/claude-agent-sdk-typescript))      | Anthropic                           | "SEE LICENSE IN README.md"                     | 0.3.325 (2026-11-13)           | Node >=18.14 | Official TypeScript SDK; spawns a bundled Claude Code | Official; minor version tracks the CLI build. Licence terms need owner review before bundling.                                          |
| `claude-agent-sdk` (PyPI, [repo](https://github.com/anthropics/claude-agent-sdk-python))                  | Anthropic                           | MIT (per repo, not re-verified)                | 0.2.182 (`pip index versions`) | Python       | Official Python SDK, `ClaudeSDKClient`                | Not relevant to a TypeScript project except for comparison.                                                                             |
| `@agentclientprotocol/claude-agent-acp` ([repo](https://github.com/agentclientprotocol/claude-agent-acp)) | ACP org (Zed contributors)          | Apache-2.0                                     | 0.107.0 (2026-11-13)           | Node >=22    | ACP agent over the Agent SDK                          | Maintained and active; v2 protocol labelled experimental. Successor of the stale `@zed-industries/claude-code-acp` 0.16.2 (2026-03-26). |
| `@agentclientprotocol/sdk`                                                                                | ACP org                             | Apache-2.0                                     | 2.6.0 (2026-11-10)             | Node         | ACP client/agent library                              | Only useful if triage itself became an ACP client. Not recommended.                                                                     |
| `@modelcontextprotocol/server`                                                                            | MCP project (incl. Anthropic staff) | Apache-2.0                                     | 2.4.0 (2026-10-23)             | Node >=20    | MCP server SDK                                        | Already chosen by [mcp.md](../../design/mcp.md). `@modelcontextprotocol/sdk` 1.32.2 (MIT) is the v1 line.                               |

No maintained community library was found that attaches to a running Claude Code CLI session; adapters searched (ACP, the SDKs) all own their sessions. This is a bounded search, not a popularity survey.

## Capability matrix

Key: **S** supported (documented), **C** conditional, **U** unsupported, **?** unverified/undocumented. Surfaces: **CLI** = interactive terminal session owned by the user; **IDE/Desktop** = VS Code, JetBrains (runs the CLI), Desktop app; **Headless** = `claude -p`, Agent SDK, ACP adapter. "Who provides it" separates the library from the host.

| Capability                                      | CLI                                                                              | IDE/Desktop                           | Headless (SDK/ACP)                                                        | Who provides it                             | Source                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------- |
| Tool/MCP connection                             | S (`claude mcp add`, `.mcp.json`, `--mcp-config`)                                | C (shared config; per-app UI differs) | S (`mcpServers` option; ACP "client MCP servers")                         | Host MCP client; triage supplies the server | mcp.md, CLI `--help` (local)                               |
| Identity/workspace resolution                   | C (env markers + `agent-inbox.toml`, see Verification)                           | ? (markers not checked)               | C (the controller chooses `cwd`; env inherited)                           | Triage resolver, not the library            | [identity.md](../../design/identity.md), `src/harness.ts`  |
| Create session                                  | S                                                                                | S                                     | S (`query()`, ACP `session/new`)                                          | Library over host                           | agent-sdk/sessions                                         |
| History / resume                                | S (`--resume`, `--continue`, `--fork-session`)                                   | C                                     | S (`resume`, `continue`, `forkSession`; ACP `session/resume` with replay) | Host transcript files; library passes IDs   | agent-sdk/sessions; ACP README                             |
| Attach to an already-running user-owned session | U                                                                                | U                                     | U (resume starts a new process on the same history)                       | None                                        | agent-sdk/sessions (inference from absence; no attach API) |
| Events/subscriptions out of the session         | C (hooks)                                                                        | ?                                     | S (message stream; hooks callbacks)                                       | Host hooks / SDK stream                     | hooks.md, agent-sdk                                        |
| Context on next turn                            | S (hook `additionalContext`)                                                     | ?                                     | S (next prompt)                                                           | Host                                        | hooks.md                                                   |
| Wake an idle existing session                   | C (`asyncRewake` exit 2; inbox socket; MCP task result, beta; Channels, preview) | ?                                     | n/a (controller just sends the next prompt)                               | Host only                                   | #22 report                                                 |
| Queued input                                    | S (messages typed mid-turn are delivered between tool calls)                     | ?                                     | S (streaming input mode)                                                  | Host / SDK                                  | #22, agent-sdk streaming input                             |
| Active-turn steering vs cancellation            | C: steering by queued message, cancellation by Esc only                          | ?                                     | S `interrupt()`; ACP `session/cancel`                                     | SDK/ACP for owned sessions only             | agent-sdk, ACP README                                      |
| Approvals/permissions                           | S (interactive prompts, settings rules)                                          | S                                     | S (`canUseTool`, `permissionMode`; ACP permission requests)               | Host engine; library forwards               | agent-sdk                                                  |
| Reconnect/offline/cancellation, acks            | C (hook dies with session; checkpoint catches up)                                | ?                                     | C (process exit ends stream; resume from transcript)                      | Triage must own checkpoints and acks        | #22, mcp.md                                                |

A new model completion, a new process, resumed history, a notification received and a started agent turn are different outcomes. Only the host routes in "Wake an idle existing session" start a turn in the user's own process; SDK `resume` produces resumed history in a new process.

## Existing-session boundary

- **Native SDK adapter:** owns its process. Useful to run triage-driven work in a disposable session, never to notify the user's running agent.
- **ACP controller-owned session:** the editor owns it; triage would have to be the ACP client, which duplicates the editor. Out of scope.
- **Plain MCP tools:** run inside the user's session, initiated by the model. Correct for reads; cannot initiate anything.
- **Host wake routes:** the only way into a running idle session. The smallest adapter is the #22 waiter: an opt-in `async` + `asyncRewake` hook bound explicitly to repository, agent name (from `agent-inbox.toml`) and the current session (`CLAUDE_CODE_SESSION_ID` presence), with a per-session lock, coalescing of all events since the checkpoint into one wake, a rate limit, suppression of the agent's own writes, and a checkpoint (acknowledgment) advanced only after the wake is delivered.

Trust boundary, unchanged: a wake carries a fixed notice with no ticket text, acquires no claim and authorizes nothing. The agent runs ordinary triage and the claim rules; ticket content remains untrusted evidence, and all writes stay on the verified-write paths.

## Verification

Done on 2026-11-13, read-only, on macOS in this Claude Code session:

- `claude --version` → `2.1.325 (Claude Code)`.
- `claude --help` lists `--resume`, `--continue`, `--fork-session`, `--input-format` (with `--print`), `--output-format stream-json`, `--mcp-config` and `--from-pr`. `claude mcp --help` lists `add`, `add-json`, `add-from-claude-desktop`, `get`, `list`, `login`, `logout`, `remove`, `reset-project-choices`. `claude mcp list` was not run because it may start configured servers.
- Environment variable **names** present in a Bash tool call (values not read): `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `AI_AGENT`. The two signals in `src/harness.ts` are confirmed. `CLAUDE_CODE_SESSION_ID` is a candidate for explicit session binding; the others are undocumented here and must not be relied on without docs.
- Registry metadata for the packages in [Libraries](#libraries) via `npm view`; Python via `pip index versions claude-agent-sdk`.
- No hooks configured in user settings (checked key names only); none were added.
- Not run: SDK or ACP sessions (would spend model turns), any wake experiment, IDE/Desktop marker checks. These are recorded as unverified above.

## Recommended adapter

1. Ship the read-only MCP server (#25) and document a Claude Code `claude mcp add` example after an installed-bin smoke.
2. Later, as an opt-in, the `asyncRewake` waiter from #22 over the shared events service, with the bindings listed in [Existing-session boundary](#existing-session-boundary).
3. Do not depend on the Agent SDK or ACP adapter for notification. Use the Agent SDK only for a disposable-session test harness, gated on owner approval of its licence and cost.

### Disposable-session test plan

In a scratch repository and a throwaway `CLAUDE_CONFIG_DIR`: register the MCP server, start an interactive session, let it idle; install the waiter in project settings; create one matching issue and record time to turn start and the notice; repeat with the agent's own comment (no wake), a burst of five issues (one wake), the session closed during the event (catch-up on next start), and a second session in the same repository (no cross-wake). Record CLI version, timings and `gh` request counts. Repeat in VS Code and Desktop or mark unsupported.

## Risks/unknowns

- Agent SDK and CLI licences are "SEE LICENSE IN README.md", not an OSI licence; bundling needs owner review.
- `asyncRewake` behaviour in IDE/Desktop is undocumented; hooks die with the session and are killed at `-p` teardown.
- The inbox socket message format is undocumented; Channels are research preview and gated; MCP tasks are public beta.
- The ACP v2 protocol is experimental. The Agent SDK minor version moves with every CLI build, so pinning is required.
- Env markers other than the two in `src/harness.ts` are observed, not documented.

## Proposed follow-up tickets (not filed)

1. Add `CLAUDE_CODE_SESSION_ID` as an optional session-binding signal to the harness detector, with tests, once its semantics are confirmed in the env-vars docs.
2. Document a verified `claude mcp add github-triage ...` example after the #25 installed-bin smoke.
3. Contract for the opt-in Claude Code waiter hook (bindings, lock, rate limit, own-write suppression, checkpoint-as-ack).
4. Run the disposable-session test plan above on CLI, then VS Code and Desktop.
5. Owner decision: whether the proprietary Agent SDK licence is acceptable for a dev-only test harness.

## Sources

Accessed 2026-11-13 unless noted.

- https://code.claude.com/docs/en/agent-sdk/sessions.md (resume, continue, fork; sessions stored per machine; V2 session API removed in TS SDK 0.3.142)
- https://code.claude.com/docs/en/agent-sdk/typescript.md and https://code.claude.com/docs/en/agent-sdk/python.md (options, `interrupt`, `canUseTool`)
- https://github.com/anthropics/claude-agent-sdk-typescript and https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk
- https://github.com/agentclientprotocol/claude-agent-acp and https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp
- https://www.npmjs.com/package/@zed-industries/claude-code-acp (superseded)
- https://www.npmjs.com/package/@modelcontextprotocol/server
- Hooks, cross-session messaging, Channels, MCP and scheduled-task sources as listed in [claude-code-idle-wakeup.md](../claude-code-idle-wakeup.md) (accessed 2026-11-12)
- Local: Claude Code 2.1.325 `--help` output and environment variable names, 2026-11-13
