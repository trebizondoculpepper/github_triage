# Gemini CLI libraries and platform-specific adapters (#226)

Platform follow-up for the parent synthesis #20, written by an agent running in Claude Code (not in Gemini CLI) on macOS. It mirrors [claude-code.md](claude-code.md) (#225) and the Codex report (#224) so the three can be compared under the same headings. Research and documentation only: no runtime code, hooks, settings, MCP registrations, sessions or GitHub state were changed, no Gemini model turns were run, and no credentials were used.

## Summary

There are three distinct ways to integrate with Gemini CLI, and they must not be confused:

1. **Plain MCP tools** (the baseline in [mcp.md](../../design/mcp.md)). Gemini CLI is an MCP client (`gemini mcp add`, stdio/SSE/HTTP); a `github-triage-mcp` stdio server registered by the user is called by the model inside the user's own session. Nothing wakes or steers the session.
2. **Native SDK control.** There is **no official Gemini CLI SDK** on npm (`@google/gemini-cli-sdk` returns 404). `@google/genai` is a model SDK: it produces new model completions against the Gemini API and has no control over a CLI session. `@google/gemini-cli-core` is the CLI's internal engine, published but not documented as a stable embedding API. Several community `*/gemini-cli-sdk` packages exist; none is maintained by Google and none was assessed as fit.
3. **ACP controller-owned sessions** through `gemini --acp` (formerly `--experimental-acp`). Gemini CLI is itself the ACP agent; the ACP client (Zed, JetBrains, or any `@agentclientprotocol/sdk` client) spawns the process and owns the session. The agent advertises `loadSession: true` and implements `newSession`, `loadSession`, `prompt`, `cancel`, `setSessionMode` and `unstable_setSessionModel`.

**What is different from Claude Code:** Gemini CLI has hooks (`SessionStart`, `BeforeAgent`, `AfterAgent`, `Notification`, ...) that can add context to a turn, but no documented asynchronous or "rewake" hook and no inbox socket, so there is **no documented host route to wake an idle, user-owned interactive session**. `AfterAgent` with `decision: "deny"` re-prompts the agent, but only as a turn finishes, not while idle.

**Platform status (verified fact, material risk):** the upstream README and docs state that free individual and Google AI Pro/Ultra access "moved to Antigravity CLI on June 18, 2026"; Gemini CLI is now positioned for Gemini Code Assist Standard/Enterprise. It is still released weekly (0.68.0 on 2026-11-10).

**Recommendation.** Support Gemini CLI through the plain MCP server only, plus harness detection. Do not build a wake adapter: there is no host route to build it on. Do not adopt `@google/genai` or community SDKs. The ACP mode is suitable only for an explicitly requested, controller-owned disposable session (tests or a headless worker), driven by `@agentclientprotocol/sdk`.

## Libraries

Versions from `npm view <pkg> version license engines repository.url time.modified --json` and `npm search "gemini cli sdk"` on 2026-11-13.

| Package / repository                                                                          | Maintainer  | License    | Version (registry modified) | Runtime   | Role                                                   | Assessment                                                                                                                                               |
| --------------------------------------------------------------------------------------------- | ----------- | ---------- | --------------------------- | --------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@google/gemini-cli` ([repo](https://github.com/google-gemini/gemini-cli))                    | Google      | Apache-2.0 | 0.68.0 (2026-11-10)         | Node >=20 | The CLI host; also the ACP agent (`--acp`)             | Host, not a library. Dist-tags `latest` 0.68.0, `preview` 0.69.0-preview.0, `nightly`. Local install is older (0.37.0).                                  |
| `@google/gemini-cli-core`                                                                     | Google      | Apache-2.0 | 0.68.0 (2026-11-13)         | Node >=20 | Internal engine (tools, hooks, MCP client, sessions)   | Published but undocumented as an embedding API; moves weekly with the CLI. Not recommended as a dependency.                                              |
| `@google/genai` ([repo](https://github.com/googleapis/js-genai))                              | Google      | Apache-2.0 | 3.3.0 (2026-11-12)          | Node >=22 | Gemini model SDK                                       | Model completions only; no CLI session control. Out of scope.                                                                                            |
| `@google/gemini-cli-sdk`                                                                      | n/a         | n/a        | 404 (does not exist)        | n/a       | n/a                                                    | No official CLI SDK.                                                                                                                                     |
| Community `gemini-cli-sdk` packages (`@ramonmetzker/…` 0.52.7, `@wilhelm-tiger/…`, `@ketd/…`) | Individuals | not read   | 2026-03 to 2026-08          | Node      | Wrappers or forks around the CLI                       | Unofficial, single-maintainer, lagging the weekly CLI. Not assessed further; a name is not evidence of capability.                                       |
| `@agentclientprotocol/sdk`                                                                    | ACP org     | Apache-2.0 | 2.6.0 (2026-11-10)          | Node      | ACP client/agent library; bundled by Gemini CLI itself | The right library if triage ever drives `gemini --acp` as a client. `@zed-industries/agent-client-protocol` 0.4.5 (2025-10-10) is the stale predecessor. |
| `@modelcontextprotocol/server`                                                                | MCP project | Apache-2.0 | 2.4.0 (2026-10-23)          | Node >=20 | MCP server SDK                                         | Already chosen by [mcp.md](../../design/mcp.md).                                                                                                         |

No maintained library was found that attaches to a running Gemini CLI session. This is a bounded search, not a popularity survey.

## Capability matrix

Key: **S** supported (documented), **C** conditional, **U** unsupported, **?** unverified/undocumented. Surfaces: **CLI** = interactive terminal session owned by the user; **IDE/Desktop** = VS Code companion, Zed/JetBrains via ACP; **Headless** = `gemini -p`, ACP controller. "Who provides it" separates the library from the host.

| Capability                                      | CLI                                                                              | IDE/Desktop                                     | Headless (`-p` / ACP)                                                                                    | Who provides it                                              | Source                                                |
| ----------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| Tool/MCP connection                             | S (`gemini mcp add`, scopes user/project, `--trust`, include/exclude tools)      | C (ACP client may register its own MCP servers) | S (settings; ACP `mcpCapabilities` http/sse)                                                             | Host MCP client; triage supplies the server                  | CLI `--help` (local), acp-mode docs, bundle           |
| Identity/workspace resolution                   | C (`GEMINI_CLI=1` set for shell tools and stdio MCP servers; `agent-inbox.toml`) | ? (IDE env names seen in source only)           | C (controller chooses `cwd`)                                                                             | Triage resolver, not the library                             | core `shellExecutionService.js`, `mcp-client.js`      |
| Create session                                  | S                                                                                | S (ACP `newSession`)                            | S (`-p`; ACP `newSession`)                                                                               | Host                                                         | headless, acp-mode docs                               |
| History / resume                                | S (`--resume latest\|N\|UUID`, `--list-sessions`, `/resume`, checkpoints)        | C (ACP `loadSession`)                           | C (ACP `loadSession`; `-p` with `--resume` undocumented)                                                 | Host transcripts under `~/.gemini/tmp/<project_hash>/chats/` | session-management docs                               |
| Attach to an already-running user-owned session | U                                                                                | U                                               | U (`loadSession` loads history into the controller's process)                                            | None                                                         | session-management, acp-mode (inference from absence) |
| Events/subscriptions out of the session         | C (hooks, synchronous)                                                           | ?                                               | S (`stream-json`: `init`, `message`, `tool_use`, `tool_result`, `error`, `result`; ACP `session/update`) | Host hooks / output stream                                   | hooks reference, headless docs                        |
| Context on next turn                            | S (`BeforeAgent` / `SessionStart` `additionalContext`)                           | ?                                               | S (next prompt)                                                                                          | Host                                                         | hooks reference                                       |
| Wake an idle existing session                   | U (no async/rewake hook; `AfterAgent` deny re-prompts only at turn end)          | ?                                               | n/a (controller sends the next prompt)                                                                   | None documented                                              | hooks reference                                       |
| Queued input                                    | ? (not documented)                                                               | ?                                               | C (ACP: client sends next `prompt` after the turn)                                                       | Host                                                         | acp-mode docs                                         |
| Active-turn steering vs cancellation            | C (Esc cancels; steering undocumented)                                           | ?                                               | S cancellation only (ACP `cancel`)                                                                       | ACP for owned sessions only                                  | acp-mode docs                                         |
| Approvals/permissions                           | S (`--approval-mode default\|auto_edit\|yolo\|plan`, policy engine)              | S (ACP `session/request_permission`)            | S (`setSessionMode`; policy files)                                                                       | Host policy engine; ACP forwards                             | CLI `--help`, acp-mode docs                           |
| Reconnect/offline/cancellation, acks            | C (no hook survives the session; checkpoint catches up)                          | ?                                               | C (process exit ends the session; `loadSession` replays)                                                 | Triage must own checkpoints and acks                         | inference; mcp.md                                     |

A new model completion (`@google/genai`), a new process (`-p`, ACP), resumed history (`--resume`, `loadSession`), a notification received and a started agent turn are different outcomes. None of the Gemini routes starts a turn in the user's own running, idle process.

## Existing-session boundary

- **Native SDK adapter:** none exists. `@google/genai` is a model API; `gemini-cli-core` is internal.
- **ACP controller-owned session:** the ACP client owns it; triage would have to be that client. Acceptable only for disposable sessions.
- **Plain MCP tools:** run inside the user's session, initiated by the model. Correct for reads; cannot initiate anything.
- **Host wake routes:** none documented. The smallest adapter is therefore **context-on-next-turn**, not a wake: an opt-in `BeforeAgent` (or `SessionStart`) command hook, bound explicitly to repository, agent name (from `agent-inbox.toml`) and session (`GEMINI_SESSION_ID`, which the hook runner sets for hook commands per `hookRunner.js`), that adds a fixed "triage has N new events since checkpoint" notice when the user next prompts. It must batch all events since the checkpoint into one notice, suppress the agent's own writes, and advance the checkpoint (acknowledgment) only once the notice is emitted.

Trust boundary, unchanged: a notice carries no ticket text, acquires no claim and authorizes nothing. The agent runs ordinary triage and the claim rules; ticket content remains untrusted evidence, and all writes stay on the verified-write paths.

## Verification

Done on 2026-11-13, read-only, on macOS, from a Claude Code session (no Gemini host session was exercised):

- `gemini --version` → `0.37.0` (Homebrew install; the registry `latest` is 0.68.0, so local help may lag).
- `gemini --help` lists `-p/--prompt`, `-i/--prompt-interactive`, `-r/--resume`, `--list-sessions`, `--delete-session`, `-o/--output-format text|json|stream-json`, `--approval-mode`, `--policy`, `--acp`, `--experimental-acp` (deprecated), `--allowed-mcp-server-names`, `-w/--worktree`.
- `gemini mcp --help`: `add`, `remove`, `list`, `enable`, `disable`; `gemini mcp add --help`: `--scope user|project`, `--transport stdio|sse|http`, `--env`, `--header`, `--timeout`, `--trust`, `--include-tools`, `--exclude-tools`. `gemini mcp list` was not run (may start servers).
- `gemini hooks --help`: only `migrate` (from Claude Code).
- Source inspection of the published 0.68.0 tarballs (`npm pack`, not executed): hook event enum (`BeforeTool`, `AfterTool`, `BeforeAgent`, `Notification`, `AfterAgent`, `SessionStart`, `SessionEnd`, `PreCompress`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`); `GEMINI_CLI=1` exported to shell tools and stdio MCP servers; `GEMINI_SESSION_ID` exported to hook commands; ACP `initialize` returns `agentCapabilities.loadSession: true`, `mcpCapabilities {http, sse}`; ACP agent methods listed in [Summary](#summary).
- Environment variable **names** inside a live Gemini session: **not verified** (needs a Gemini host). `src/harness.ts` registers no Gemini detector today.
- Not run: any `gemini` prompt, ACP session, hook experiment or IDE check (would need credentials and paid turns). Recorded as unverified above.

## Recommended adapter

1. Ship the read-only MCP server (#25) and document a `gemini mcp add github-triage <cmd> --scope project` example after an installed-bin smoke on a Gemini host.
2. Add a Gemini harness detector on `GEMINI_CLI=1` once verified in a live session.
3. Optionally, later, the opt-in `BeforeAgent` next-turn notice described above. No wake adapter.
4. Do not depend on `@google/genai`, `gemini-cli-core` or community SDKs. Use `gemini --acp` with `@agentclientprotocol/sdk` only for a disposable-session test harness, gated on owner approval of cost and credentials.

### Disposable-session test plan

On a Gemini host with an approved account, in a scratch repository and a throwaway `GEMINI_CLI_HOME`: record `gemini --version`; register the MCP server with project scope and call one read tool; print env var names from a shell tool and from the MCP server process; install a `BeforeAgent` hook that only logs `GEMINI_SESSION_ID` and emits a fixed notice; create one matching issue and confirm the notice appears on the next user prompt and not before; repeat with the agent's own comment (no notice), a burst of five issues (one notice), the session closed during the event (catch-up on next start), and a second session in the same repository (no cross-notice). Then drive `gemini --acp` from an `@agentclientprotocol/sdk` client: `newSession`, `prompt`, `cancel`, `loadSession`. Record versions and timings only, no transcripts.

## Risks/unknowns

- Platform direction: individual access moved to Antigravity CLI on 2026-06-18. Antigravity CLI was not researched here and may need its own report.
- Weekly releases and a large gap between the local 0.37.0 and 0.68.0; flags and hook fields can change. Pin versions in any test.
- No documented idle wake, queued-input or active-turn steering in the interactive CLI.
- `GEMINI_SESSION_ID` and IDE env names come from source, not from user docs. `-p` combined with `--resume` is undocumented.
- `unstable_setSessionModel` and ACP session extras are explicitly unstable.

## Proposed follow-up tickets (not filed)

1. Add a Gemini CLI harness detector on `GEMINI_CLI=1`, with tests, after live verification.
2. Document a verified `gemini mcp add` example after the #25 installed-bin smoke.
3. Contract for an opt-in Gemini `BeforeAgent` next-turn notice (bindings, batching, own-write suppression, checkpoint-as-ack).
4. Run the disposable-session test plan on a Gemini host.
5. Research Antigravity CLI (`agy`) as a separate platform report.

## Sources

Accessed 2026-11-13.

- https://github.com/google-gemini/gemini-cli (README: release cadence, Antigravity transition notice)
- https://geminicli.com/docs/hooks/reference (hook events and output fields)
- https://geminicli.com/docs/cli/headless (`-p`, JSON and stream-json events, exit codes)
- https://geminicli.com/docs/cli/acp-mode (`--acp`, ACP methods)
- https://geminicli.com/docs/cli/session-management (session storage, `--resume`, `/resume`, checkpoints)
- https://www.npmjs.com/package/@google/gemini-cli, https://www.npmjs.com/package/@google/gemini-cli-core, https://www.npmjs.com/package/@google/genai, https://www.npmjs.com/package/@agentclientprotocol/sdk, https://www.npmjs.com/package/@modelcontextprotocol/server
- Published tarballs `@google/gemini-cli@0.68.0` and `@google/gemini-cli-core@0.68.0` (source read, not executed)
- Local: Gemini CLI 0.37.0 `--help`, `mcp --help`, `mcp add --help`, `hooks --help`, 2026-11-13
