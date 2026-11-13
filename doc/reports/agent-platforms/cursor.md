# Cursor libraries and platform-specific adapters (#228)

Platform follow-up for the parent synthesis #20, in the series with the Claude Code (#225), Codex (#224), Gemini CLI and GitHub Copilot (#227) reports, whose structure it follows. Research and documentation only: no runtime code, hooks, settings, MCP registrations, chats, cloud agents or GitHub state were changed, and no model turns were run.

## Provenance

- **Researcher:** `kavya_sabbagh`, a Claude Code agent (Anthropic Claude model; exact model and harness version not recorded here). The research was done from Claude Code, **not from Cursor**. Nothing below shows that Cursor itself was exercised.
- **Environment:** macOS (Darwin 27.2.0), Node via `npx`, research date 2026-11-13, repository at `origin/main` on that date.
- **Target installed locally:** Cursor CLI `2026.01.09-6d4aaf8` (`~/.local/bin/cursor-agent`). The Cursor editor (`cursor` launcher) is **not installed**. The `~/.local/bin/agent` on this machine is a different vendor's CLI (a symlink into `~/.grok`), so **`agent` must not be assumed to mean Cursor**. That matters for any adapter that shells out.
- **Evidence levels:** CLI help output is _locally inspected_. Everything about the editor, ACP behaviour, cloud agents, hooks and `@cursor/sdk` is _documented or source-inspected only_. Nothing was fixture-tested or exercised in a real Cursor session.

## Summary

Cursor has five separate surfaces, and they must not be confused:

1. **Editor agent plus plain MCP tools.** The Cursor editor (a VS Code fork) reads `mcpServers` from `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (user) and supports stdio, SSE and streamable HTTP. The model calls the `github-triage-mcp` server inside the user's own chat. Nothing wakes or steers that chat. Extensions can also register servers with `vscode.cursor.mcp.registerServer()`, but that API is only mentioned in the docs, not specified.
2. **Cursor CLI (`cursor-agent`, documented as `agent`).** This is an interactive TUI or a headless runner (`-p --output-format stream-json`). It shares the same `mcp.json` files and has `mcp list|list-tools|enable|disable|login`. Its chats are its own: `create-chat`, `--resume [chatId]`, `resume`, `ls`. Prefixing a message with `&` hands the chat off to a cloud agent.
3. **ACP server (`cursor-agent acp`).** This command is hidden from default help but present in the local build. It is native, so no third-party adapter is needed. The documented methods are `initialize`, `authenticate` (`cursor_login`), `session/new`, `session/load`, `session/prompt`, `session/update`, optional `session/cancel`, and `session/request_permission`, which **blocks tools until the client answers**. Cursor also adds extensions such as `cursor/ask_question`. The ACP client owns the session.
4. **Cloud agents REST API** (`https://api.cursor.com/v1/agents`, Basic or Bearer API key). It can launch an agent and add a follow-up run (`POST /v1/agents/{id}/runs`, with `delivery: "steer"` for a running turn). It also offers run status and SSE streams, cancel, archive and delete. **v1 has no webhooks**, which the docs say are "coming soon"; the legacy v0 API had them. These agents run on Cursor's VMs, cost money, and are a different conversation from the user's editor chat.
5. **`@cursor/sdk`** (official, public beta since 2026-04-29, Node >=22.13, **proprietary licence**: "© Anysphere Inc. All rights reserved", governed by Cursor's Terms of Service). Its API is `Agent.create({ local | cloud })`, `Agent.resume(id)`, `agent.send()`, `run.stream()`, `run.cancel()` and the optional local-only `run.steer()`. It manages agents it created (`agent-<uuid>` local, `bc-<uuid>` cloud). The docs say nothing about attaching it to an editor chat or a CLI chat. By default the local runtime **runs tools without asking for approval**.

**What is new compared with the other platforms:**

- Cursor ships ACP natively, which is different from Codex (third-party `codex-acp`).
- Cursor offers a vendor REST API with a `steer` delivery mode, but only for cloud agents.
- Cursor has a `stop` hook whose `followup_message` is auto-submitted as the next user message. This is the only documented host route by which something outside the model starts another turn in a session the user already has open. It only fires when a turn ends, so it is a continuation, not a wake of an idle chat.
- No surface documents attaching to an editor chat that is already open.

**Recommendation.** Keep the plain MCP server as the Cursor integration, documented through `.cursor/mcp.json`. Do not adopt `@cursor/sdk` (proprietary licence, its own sessions, approval-free by default), the cloud API (paid, separate sessions, credentials) or ACP (triage would become the client that owns permissions) for notification. If a nudge is wanted later, the smallest opt-in slice is a `stop`-hook script that runs read-only triage and returns a fixed notice only when the bound agent has unacknowledged events. It reaches only a session that is already working and never an idle one. Mark idle wake-up of a Cursor editor chat as **unsupported**.

## Libraries

Versions from `npm view <pkg> name version license time.modified repository.url maintainers --json` on 2026-11-13. The `@cursor/sdk` licence comes from `LICENSE.md` in the packed 1.3.1 tarball.

| Package / repository                                                                    | Maintainer                        | License                                  | Version (registry modified)  | Runtime                    | Role                                                       | Assessment                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------- | ---------------------------- | -------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cursor CLI ([docs](https://cursor.com/docs/cli/overview))                               | Anysphere (Cursor)                | Proprietary                              | Local `2026.01.09-6d4aaf8`   | Self-updating native build | The host; includes `acp`, `mcp`, `create-chat`, `--resume` | Host, not a library. The local build is about ten months old, so newer flags (`--mode`, `--trust`, `--worktree`, `worker`, `sandbox`) in the current reference are not in this build.      |
| `@cursor/sdk` ([docs](https://cursor.com/docs/sdk/typescript))                          | Anysphere staff (npm maintainers) | Proprietary ("All rights reserved", ToS) | 1.3.1 (2026-11-03)           | Node >=22.13, ESM          | Official TypeScript SDK; local or cloud agents             | Official, but **public beta and not open source**. Manages only agents it created. Approval-free by default. Usage is billed. Not recommended as a dependency of this open-source project. |
| Cloud Agents API v1 ([endpoints](https://cursor.com/docs/cloud-agent/api/endpoints))    | Anysphere                         | Service ToS                              | v1 (no webhooks yet)         | HTTPS                      | REST launch / follow-up / steer / stream / cancel          | Only for cloud agents. Needs a user or service-account API key. Out of scope for credential-free triage.                                                                                   |
| `@agentclientprotocol/sdk`                                                              | ACP org                           | Apache-2.0                               | 2.6.0 (2026-11-10)           | Node                       | ACP client/agent library                                   | Only useful if triage became an ACP client of `cursor-agent acp`. Not recommended.                                                                                                         |
| `@blowmage/cursor-agent-acp` ([repo](https://github.com/blowmage/cursor-agent-acp-npm)) | Community (one maintainer)        | MIT                                      | 0.7.1 (2026-01-21)           | Node                       | Third-party ACP wrapper around the CLI                     | Superseded by native `cursor-agent acp`; idle since January. Do not adopt.                                                                                                                 |
| `cursor-agent-acp`                                                                      | Community (one maintainer)        | Apache-2.0                               | 0.1.1 (2025-09-03)           | Node                       | Early ACP wrapper                                          | Stale. Do not adopt.                                                                                                                                                                       |
| `@modelcontextprotocol/server`                                                          | MCP project                       | Apache-2.0                               | 2.4.0 (2026-10-23, per #224) | Node >=20                  | MCP server SDK                                             | Already chosen by [mcp.md](../../design/mcp.md); works with any host.                                                                                                                      |

`@cursor-ai/sdk` and `cursor-agent-sdk` do not exist on npm (404). `@cursor/february` is an old private-alpha name and is not current. No maintained library was found that attaches to an open Cursor editor chat. Python and other-language SDKs were not surveyed, because this is a TypeScript project and the search was bounded.

## Capability matrix

Key: **S** supported (documented), **C** conditional, **U** unsupported, **?** unverified or undocumented.

Surfaces:

- **Editor** is the Cursor desktop agent chat owned by the user.
- **CLI** is the interactive `cursor-agent` TUI.
- **Headless** covers `cursor-agent -p`, `cursor-agent acp`, `@cursor/sdk` local agents, and cloud agents (through the API or the SDK).

| Capability                                      | Editor                                                                                                              | CLI                                                                            | Headless (print / ACP / SDK / cloud)                                                                                    | Who provides it                                     | Source                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------- |
| Tool/MCP connection                             | S (`mcp.json`, stdio/SSE/HTTP, `${workspaceFolder}`); C extension `registerServer`                                  | S (same `mcp.json`; `mcp enable`, `--approve-mcps`)                            | S (ACP uses project/user `mcp.json`, not team servers; SDK inline `mcpServers`; cloud: inline or dashboard)             | Host MCP client; triage supplies the server         | MCP docs; ACP docs; SDK docs; local help |
| Identity/workspace resolution                   | ? (no Cursor detector in `src/harness.ts`; hook env `CURSOR_PROJECT_DIR`, `CURSOR_VERSION` exist only inside hooks) | ? (no env marker for the CLI process is documented)                            | C (the controller sets `--workspace`, `local.cwd` or the cloud repo)                                                    | Triage resolver; needs explicit `--entry`           | `src/harness.ts`; hooks docs             |
| Create session                                  | S (UI)                                                                                                              | S (`create-chat` prints an ID)                                                 | S (ACP `session/new`, `Agent.create`, `POST /v1/agents`)                                                                | Host / library                                      | local help; ACP; SDK; API                |
| History / resume                                | S (UI)                                                                                                              | S (`--resume [chatId]`, `resume`, `ls`)                                        | S (ACP `session/load`; `Agent.resume(id)` from a checkpoint or the cloud; follow-up runs)                               | Host session store                                  | local help; ACP; SDK                     |
| Attach to an already-running user-owned session | U (none documented)                                                                                                 | U (`--resume` starts a new process on stored history; it is not an attachment) | U for editor/CLI chats. Cloud agents: S only for agents the caller created or can access by ID                          | None for local chats                                | SDK docs (silent); API docs              |
| Events/subscriptions out of the session         | C (hooks: `afterAgentResponse`, `stop`, `postToolUse`)                                                              | ? (hook support in the CLI is not documented beyond `workspaceOpen`)           | S (ACP `session/update`; SDK `run.stream()`; API SSE `/stream`); no v1 webhooks                                         | Host hooks / protocol stream                        | hooks docs; ACP; SDK; API                |
| Context on next turn                            | S (`sessionStart` and `postToolUse` `additional_context`)                                                           | ?                                                                              | S (the next prompt)                                                                                                     | Host                                                | hooks docs                               |
| Wake an idle existing session                   | U (the `stop` hook only continues a turn that is just ending)                                                       | U                                                                              | C (cloud: `POST /v1/agents/{id}/runs` on an `IDLE` agent; ACP/SDK: a prompt to a session the caller owns)               | Host API, for owned agents only                     | API docs; hooks docs                     |
| Queued input                                    | ? (UI queueing not documented for automation)                                                                       | ?                                                                              | U/C (API: one active run; a new run while one is active needs `steer`)                                                  | Host                                                | API docs                                 |
| Active-turn steering vs cancellation            | ? (user-only)                                                                                                       | ? (user-only)                                                                  | C (API `delivery: "steer"` vs `.../cancel`; SDK `run.steer?()` local-only vs `run.cancel()`; ACP `session/cancel` only) | Host / SDK, for owned runs                          | API; SDK; ACP docs                       |
| Approvals/permissions                           | S (MCP approval by default; Run Modes / Auto-review; admin policy)                                                  | S (interactive; `--force`, `--sandbox`)                                        | C (ACP: the client must answer `session/request_permission`; SDK local: **no prompts by default**; cloud: isolated VM)  | Host engine; the controller must answer or restrict | MCP; ACP; SDK docs                       |
| Reconnect/offline/cancellation, acks            | ?                                                                                                                   | ?                                                                              | C (API run states incl. `EXPIRED`, `CANCELLED`; cancel is terminal; SDK `Agent.getRun`)                                 | Triage must own checkpoints and acks                | API; SDK docs                            |

These are different outcomes and must be reported separately:

- A `stop` `followup_message` is a **started turn in an already-active session**, because the hook fires as that session's turn ends.
- `--resume`, `session/load` and `Agent.resume` produce **resumed history in a new process**.
- A cloud follow-up run is a **paid model turn in a separate cloud session**.
- A `session/update` or SSE event is **notification receipt**, not delivery to the user's agent.

## Existing-session boundary

- **Native SDK adapter (`@cursor/sdk`):** manages only the agents it creates or resumes by ID. Local agents run tools with no approval unless sandboxing, Auto-review, hooks or tool lists restrict them. It could at most serve as a disposable-session test harness. Even then, its licence and billing argue against it.
- **Cloud API:** gives real steer and follow-up semantics, but on a separate VM conversation. It reaches the user's editor chat only if the user deliberately works in that cloud agent, for example after a `&` hand-off, and is driven by credentials. Out of scope for a credential-free triage service.
- **ACP controller-owned session:** `cursor-agent acp` is native and clean. Triage would have to become the ACP client, answer `session/request_permission` (or tools block) and own authentication. It never reaches the editor chat. Out of scope.
- **Plain MCP tools:** run inside the user's editor or CLI chat and are started by the model. Correct for reads, but they cannot start anything.
- **Host hook route (smallest adapter):**
  - **Mechanism:** an opt-in `stop` hook in `.cursor/hooks.json`. It runs a read-only triage query bound explicitly to the repository and an agent entry (`agent-inbox.toml`, entry `cursor`, chosen with `--entry` because there is no Cursor harness detector). It may also bind to the hook's `conversation_id`.
  - **Output:** a fixed `followup_message` with an opaque batch ID, only when events are unacknowledged. It coalesces the batch, suppresses the agent's own writes and respects `loop_limit`. It returns nothing otherwise.
  - **Acknowledgement:** the checkpoint advances only when the agent inspects the batch through ordinary triage.
  - **Result states:** `unsupported` / `continued` / `none` / `failed`.
  - **Limit:** it cannot wake an idle chat, and whether it works in the CLI is unverified.

**Trust boundary, unchanged:**

- The follow-up text is fixed, carries no ticket content, acquires no claim and authorizes nothing.
- Ticket content remains untrusted evidence, and every write stays on the verified-write paths.
- An adapter must never use `--force`/`--yolo`, `--approve-mcps`, `--sandbox disabled` or SDK local agents without sandboxing.

## Verification

Done on 2026-11-13, read-only, on macOS from a **Claude Code** session (so this is not a Cursor host):

- `cursor-agent --version` printed `2026.01.09-6d4aaf8`. The symlink points to `~/.local/share/cursor-agent/versions/2026.01.09-6d4aaf8/`. `cursor` (the editor launcher) is not installed. `~/.local/bin/agent` resolves to another vendor's CLI, not Cursor.
- `cursor-agent --help` shows these flags: `--api-key` (or `CURSOR_API_KEY`), `-p/--print`, `--output-format text|json|stream-json`, `--stream-partial-output`, `-c/--cloud`, `--resume [chatId]`, `--model`, `-f/--force`, `--sandbox enabled|disabled`, `--approve-mcps` (headless only), `--browser` and `--workspace`. It lists these commands: `login` (`NO_OPEN_BROWSER`), `logout`, `mcp`, `status|whoami`, `models`, `update`, `create-chat`, `generate-rule`, `agent`, `ls`, `resume`, and the shell-integration commands.
- `cursor-agent help acp` printed "Start the Cursor Agent as an ACP (Agent Client Protocol) server". The command is present but hidden from default help. It was **not started**.
- `cursor-agent mcp --help` listed `login <id>` (for `.cursor/mcp.json` or `~/.cursor/mcp.json`), `list`, `list-tools <id>`, `enable <id>` and `disable <id>`. `mcp list` was **not run**, because it reads live config and may start servers.
- `create-chat --help`, `resume --help` and `ls --help` showed no options beyond help.
- Environment variable **names** matching `CURSOR` in this shell: none, which is expected outside Cursor. The documented names are `CURSOR_API_KEY` and `CURSOR_AUTH_TOKEN` (ACP auth), `NO_OPEN_BROWSER`, `CURSOR_WORKER_LABELS_FILE`, and, inside hooks only, `CURSOR_PROJECT_DIR`, `CURSOR_VERSION`, `CLAUDE_PROJECT_DIR`, `CURSOR_USER_EMAIL`, `CURSOR_TRANSCRIPT_PATH`, `CURSOR_CODE_REMOTE` and `CURSOR_PLUGIN_ROOT`. None of these is a documented marker for detecting the harness in an editor terminal or a CLI child process, so they are **unverified** as harness signals.
- `npm view` for the packages in [Libraries](#libraries). `npm pack @cursor/sdk@1.3.1` into the scratchpad, used to read `LICENSE.md` and `engines` only. Nothing was installed and no code was run.
- **Not run:** any Cursor chat, `-p` run, ACP session, SDK agent or cloud agent (each would spend model turns or need credentials), `mcp list`, hooks, and editor checks (the editor is not installed). These are recorded as unverified above.

## Recommended adapter

1. Ship the read-only MCP server (#25) and document a Cursor `.cursor/mcp.json` stdio example (`"command": "github-triage-mcp", "args": ["--project", "${workspaceFolder}"]`) after an installed-bin smoke on a real Cursor host.
2. Add `cursor` as a selectable entry with explicit `--entry`, and no automatic detection until markers are verified.
3. Optionally, later, the `stop`-hook continuation adapter described in [Existing-session boundary](#existing-session-boundary). Idle wake-up stays unsupported.
4. Do not depend on `@cursor/sdk`, the cloud API or ACP for notification.

### Disposable-session test plan

1. In a scratch repository with a throwaway Cursor profile and an explicit model budget, register the MCP server in `.cursor/mcp.json`.
2. Confirm `cursor-agent mcp list-tools github-triage` and one read-only tool call from the CLI and the editor.
3. Record which `CURSOR_*` names appear in an editor terminal and in a CLI child process.
4. Install a `stop` hook that only logs its stdin fields (`conversation_id`, status) and returns no follow-up. Check that it fires in the editor and in the CLI.
5. Then return a fixed `followup_message` once, and record whether a new turn starts and whether `loop_limit` holds.
6. Repeat with an idle chat (expect nothing), a five-event burst (expect one notice), the agent's own comment (expect no notice) and two chats in one repository (expect no cross-delivery).
7. Record versions, timings and `gh` request counts. Capture no credentials, transcripts or conversation IDs.

## Risks/unknowns

- The ACP command is hidden and its version history is undocumented. `session/resume`/attach is not documented. Unanswered permission requests block tools.
- `@cursor/sdk` is beta and proprietary, approval-free by default, and has no documented way to answer `request` events.
- Cloud API v1 has no webhooks. Its stream and run semantics may still change.
- Whether hooks fire in the CLI (other than `workspaceOpen`) is undocumented. The local CLI is ten months behind the current reference.
- `vscode.cursor.mcp.registerServer()` is only named in the docs, so its signature and stability are unknown.
- Name clash: `agent` is not a safe executable name. Adapters must resolve `cursor-agent` explicitly.
- Release cadence is high, so CLI help should be checked at startup.

## Proposed follow-up tickets (not filed)

1. Verify Cursor environment markers (editor terminal, CLI child process, hooks) on a real host and decide whether to register a `cursor` harness detector.
2. Document a verified `.cursor/mcp.json` example after the #25 installed-bin smoke.
3. Contract for an opt-in `stop`-hook continuation adapter (bindings, own-write suppression, `loop_limit`, result states, checkpoint as acknowledgement).
4. Run the disposable-session test plan above on a Cursor host.
5. Optional: check whether hooks fire in the CLI and what `cursor-agent acp` returns from `initialize` (capability negotiation), using a fixture client that never sends `session/prompt`.

## Sources

Accessed 2026-11-13.

- https://cursor.com/docs/context/mcp (`mcp.json` locations and shape, transports, interpolation, approvals, `vscode.cursor.mcp.registerServer()`)
- https://cursor.com/docs/cli/reference/parameters (CLI commands and flags, hidden `acp`, `CURSOR_API_KEY`, `CURSOR_WORKER_LABELS_FILE`)
- https://cursor.com/docs/cli/acp (`agent acp`, methods, `session/request_permission`, `cursor/*` extensions, no team MCP servers)
- https://cursor.com/docs/agent/hooks (events per surface, `additional_context`, `stop` `followup_message`, `loop_limit`, hook environment variables, `conversation_id`)
- https://cursor.com/docs/cloud-agent/api/endpoints (v1 agents and runs, `delivery: "steer"`, status values, streams, cancel, no v1 webhooks)
- https://cursor.com/docs/sdk/typescript and https://cursor.com/blog/typescript-sdk (`@cursor/sdk` API, beta, Node >=22.13, default no-approval local runtime)
- https://cursor.com/changelog/cli-jan-16-2026 (CLI hand-off to cloud agents with `&`) and https://cursor.com/changelog/cli-feb-18-2026 (plan hand-off)
- https://www.npmjs.com/package/@cursor/sdk, https://www.npmjs.com/package/@blowmage/cursor-agent-acp, https://www.npmjs.com/package/cursor-agent-acp, https://www.npmjs.com/package/@agentclientprotocol/sdk
- Local: `cursor-agent` 2026.01.09-6d4aaf8 `--help`, `help acp`, `mcp --help`, `create-chat|resume|ls --help`; `@cursor/sdk` 1.3.1 tarball `LICENSE.md` and `package.json`, 2026-11-13
