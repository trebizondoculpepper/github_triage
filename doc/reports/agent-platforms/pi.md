# Pi coding agent libraries and platform-specific adapters (#231)

Platform follow-up for the parent synthesis #20 and the last in the series with the Claude Code (#225), Codex (#224), Gemini CLI (#226), GitHub Copilot (#227), Cursor (#228), Cline (#229) and Goose (#230) reports, whose structure it follows. Research and documentation only: no runtime code, extensions, settings, sessions or GitHub state were changed, and no model turns were run.

"Pi" here means the **Pi coding agent** (`pi` CLI) by Mario Zechner, formerly `badlogic/pi-mono` and published as `@mariozechner/pi-coding-agent`, now **`earendil-works/pi`** and `@earendil-works/pi-coding-agent`. The ticket names "Pi coding agent", "Pi SDK/extensions/RPC" and ACP adapters, which match this project and no other; it was not ambiguous enough to need an owner question. Unrelated name collisions are listed under [Libraries](#libraries).

## Provenance

- **Researcher:** `kavya_sabbagh`, a Claude Code agent (Anthropic Claude model; exact model and harness version not recorded here). The research was done from Claude Code, **not from Pi**. Nothing below shows that Pi itself was exercised.
- **Environment:** macOS (Darwin 27.2.0), Node v26.7.0, research date 2026-11-13, this repository at `origin/main` `33971fc`; upstream `earendil-works/pi` read at `main` `97d539c` (shallow clone) on the same date.
- **Target installed locally:** none. `pi` is not on `PATH`. No Pi binary was executed, so version, `--help`, MCP/extension configuration, session modes and environment variable names are **unverified locally**; they are taken from upstream docs and source.
- **Evidence levels:** everything below is _documented_ (`packages/coding-agent/docs` in the upstream repository) or _source-inspected_ (the upstream repository, the `pi-acp` README and registry metadata). Nothing was fixture-tested or exercised in a real Pi session.

## Summary

The project moved: `gh api repos/badlogic/pi-mono` resolves to **`earendil-works/pi`** (MIT; latest release v1.5.2, 2026-11-10), and the npm package `@mariozechner/pi-coding-agent` (last 0.73.1) is deprecated with "please use @earendil-works/pi-coding-agent instead going forward". The current package needs Node >=22.19.0. Pi is a terminal coding agent with four entry points over the same `AgentSession` core: interactive TUI, `--mode json` (print-style JSONL events, then exit), `--mode rpc` (long-lived JSONL command/event subprocess) and an in-process TypeScript SDK.

The most important change from older write-ups that described Pi as "no MCP by design": **Pi now ships built-in MCP client support** (stdio and streamable HTTP, OAuth; SSE rejected), added as a built-in extension alongside codemode and tool search (CHANGELOG, issue #10040). Servers come from `~/.pi/agent/mcp.json`, project `.pi/mcp.json` (only after project trust), `pi mcp add|remove|list|login|logout` or `pi.registerMcpServer()`; `--no-mcp` disables it for one run.

Integration routes, which must not be confused:

1. **Plain MCP tools** (the baseline in [mcp.md](../../design/mcp.md)). A `github-triage-mcp` stdio server registered in `mcp.json` is called by the model inside the user's session. Nothing wakes or steers it.
2. **In-process extensions** (TypeScript modules loaded by `jiti` from `~/.pi/agent/extensions`, project `.pi/extensions` after trust, or Pi packages). This is Pi's hook system and is unusually powerful: an extension subscribes to session, agent, turn, tool and input events, can block or rewrite tool calls, and can **inject into the running session** with `pi.sendMessage(..., { deliverAs: "steer" | "followUp" | "nextTurn", triggerTurn })` or `pi.sendUserMessage()`. With `triggerTurn: true` on an idle session it starts a model turn. This is the only documented route by which code can reach a session the user already has open, and it works only because the code runs inside that Pi process, installed by the user.
3. **RPC mode, controller-owned.** `pi --mode rpc` speaks JSONL on stdio: `prompt` (disposition `started`/`queued`/`handled`), `steer`, `follow_up`, `abort`, `clear_queue`, `new_session`, `switch_session`, `fork`, `clone`, `get_state`, `get_messages`, compaction and model commands, plus an extension-UI sub-protocol. The exported `RpcClient` wraps it. The controller spawns the process and owns its session; RPC cannot attach to a TUI another process is running.
4. **SDK, controller-owned.** `createAgentSession()` / `AgentSessionRuntime` from `@earendil-works/pi-coding-agent` embeds the agent in Node or Bun with sessions, events, steering and `SessionManager` persistence. Same ownership rule as RPC.
5. **ACP.** There is **no official ACP server** in Pi (no ACP mention in the coding-agent docs or source; the only hit is an experimental `apps/p2` prototype note). The community **`pi-acp`** (svkozak, MIT, 0.0.34) is an ACP stdio adapter that spawns `pi --mode rpc` and bridges it, focused on Zed; it maps ACP `session/load` to Pi session files via `~/.pi/pi-acp/session-map.json`. It is a controller-owned session like RPC, self-described as "MVP-style".

**Recommendation.** Support Pi through the plain MCP server first (a `mcp.json` stdio entry or `pi mcp add github-triage -- <cmd>`). Add harness detection on `AI_AGENT=pi` / `PI_CODING_AGENT=true` after verifying which variables reach an MCP server process. If the owner wants notification, the smallest adapter is an **opt-in Pi extension** that only uses `deliverAs: "nextTurn"` with a bounded, ticket-text-free notice, never `triggerTurn`. Use RPC (`RpcClient`) only for a disposable-session test harness. Do not depend on `pi-acp`.

## Libraries

Versions from `npm view <pkg> version license time.modified repository.url` and `gh release list -R earendil-works/pi` on 2026-11-13.

| Package / repository                                                         | Maintainer                                                  | License    | Version (date)                      | Runtime                                       | Role                                                 | Assessment                                                                                                                  |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------- | ----------------------------------- | --------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `earendil-works/pi` ([repo](https://github.com/earendil-works/pi))           | Earendil Works (Mario Zechner; formerly `badlogic/pi-mono`) | MIT        | v1.5.2 (2026-11-10)                 | Node >=22.19.0; macOS, Linux, Windows, Termux | Monorepo: CLI host, SDK, RPC, MCP client             | The host. Frequent releases (1.5.0, 1.5.1, 1.5.2 in eight days).                                                            |
| `@earendil-works/pi-coding-agent` (npm)                                      | same                                                        | MIT        | 1.5.2 (2026-11-10)                  | Node >=22.19.0                                | `pi` binary, SDK (`createAgentSession`), `RpcClient` | Right library for an RPC/SDK test harness. Spawns paid model turns when prompted.                                           |
| `@earendil-works/pi-mcp` (npm)                                               | same                                                        | MIT        | 1.5.2 (2026-11-10)                  | Node                                          | Pi's MCP client (stdio, streamable HTTP, OAuth)      | Host-side; triage only supplies the server. Stdio servers inherit `process.env` unless `inheritEnv: false` (source).        |
| `@earendil-works/pi-agent-core`, `pi-ai`, `pi-tui` (npm)                     | same                                                        | MIT        | 1.5.2 (2026-11-10)                  | Node                                          | Agent loop, multi-provider LLM API, TUI              | Building blocks; not session delivery.                                                                                      |
| `@mariozechner/pi-coding-agent` (npm)                                        | Mario Zechner                                               | MIT        | 0.73.1 (2026-05-07), **deprecated** | Node >=20.6.0                                 | Old package name                                     | Do not use; older guidance that targets it is stale.                                                                        |
| `pi-acp` ([repo](https://github.com/svkozak/pi-acp), npm)                    | svkozak (community)                                         | MIT        | 0.0.34 (2026-09-24)                 | Node; `@agentclientprotocol/sdk` ^0.26.0      | ACP stdio server that spawns `pi --mode rpc`         | Community, pre-1.0, Zed-centred, pinned to an old ACP SDK. Controller-owned sessions only. Not recommended as a dependency. |
| `pi-mcp-adapter` ([repo](https://github.com/nicobailon/pi-mcp-adapter), npm) | nicobailon (community)                                      | MIT        | 7.0.1 (2026-11-04)                  | Node                                          | Pi extension that adds MCP                           | Predates/overlaps the built-in MCP support; unnecessary now.                                                                |
| `@agentclientprotocol/sdk`                                                   | ACP org                                                     | Apache-2.0 | see goose.md (2.6.0)                | Node                                          | ACP client library                                   | Only relevant if `pi-acp` were used.                                                                                        |
| `@modelcontextprotocol/server`                                               | MCP project                                                 | Apache-2.0 | see [mcp.md](../../design/mcp.md)   | Node >=20                                     | MCP server SDK                                       | Already chosen.                                                                                                             |
| `@mariozechner/pi` (npm)                                                     | Mario Zechner                                               | MIT        | 0.70.6                              | Node                                          | "CLI tool for managing vLLM deployments on GPU pods" | **Not the coding agent.** Name collision.                                                                                   |

No maintained adapter was found that attaches an external process to an already-running Pi TUI session. This is a bounded search, not a popularity survey.

## Capability matrix

Key: **S** supported (documented), **C** conditional, **U** unsupported, **?** unverified/undocumented. Surfaces: **CLI/TUI** = interactive `pi` owned by the user (including its extensions); **IDE (ACP)** = an ACP client such as Zed through community `pi-acp`; **Headless** = `--mode json`, `--mode rpc`, the SDK. Pi has no first-party desktop or IDE app. "Who provides it" separates the library from the host.

| Capability                                      | CLI/TUI                                                                                                                                                                         | IDE (ACP via `pi-acp`)                                     | Headless (json / RPC / SDK)                                      | Who provides it                                        | Source                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Tool/MCP connection                             | S (`mcp.json`, `pi mcp add`, `/mcp`; project file only after trust)                                                                                                             | S (same Pi config; ACP `mcpServers` handling ?)            | S (same; `--no-mcp` disables)                                    | Host MCP client (`pi-mcp`); triage supplies the server | mcp.md, CHANGELOG                                                             |
| Identity/workspace resolution                   | C (`AI_AGENT=pi`, `PI_CODING_AGENT=true` set at startup and inherited; `PI_SESSION_ID`/`PI_SESSION_FILE` documented only for bash/powershell tool commands)                     | C (same, via spawned `pi --mode rpc`)                      | C (RPC sets the markers; SDK embedding does not)                 | Triage resolver, not the library                       | environment-variables.md; `cli/setup.ts`, `rpc-entry.ts`, `pi-mcp` `stdio.ts` |
| Create session                                  | S (`pi`, `/new`)                                                                                                                                                                | S (ACP `session/new`)                                      | S (RPC `new_session`; SDK `createAgentSession`)                  | Host                                                   | sessions.md, rpc-commands.md, sdk.md                                          |
| History / resume                                | S (`--continue`, `--resume`, `--session`, `--fork`, `/resume`, `/tree`; JSONL under `~/.pi/agent/sessions/`)                                                                    | C (`session/load` via `pi-acp` session map)                | S (RPC `switch_session`, `fork`, `clone`; SDK `SessionManager`)  | Host; `pi-acp` adds mapping                            | sessions.md, session-format.md, pi-acp README                                 |
| Attach to an already-running user-owned session | C (only from an extension running inside that process)                                                                                                                          | U (`pi-acp` spawns its own process)                        | U (RPC/SDK own their process; no attach command)                 | Host extension API                                     | extensions.md; rpc.md                                                         |
| Events/subscriptions out of the session         | S in-process (extension `pi.on` for session, agent, turn, message, tool, input events)                                                                                          | S (ACP `session/update` from RPC events)                   | S (RPC/JSON event stream; SDK `subscribe`)                       | Host                                                   | extensions.md, json.md, sdk.md                                                |
| Context on next turn                            | S (extension `sendMessage` `deliverAs: "nextTurn"`; `before_agent_start`/`context` handlers)                                                                                    | ?                                                          | S (controller sends it)                                          | Host extension API                                     | extensions.md                                                                 |
| Wake an idle existing session                   | C (extension `sendMessage({ triggerTurn: true })` or `sendUserMessage` starts a turn; must be user-installed)                                                                   | U from outside                                             | S only for the controller's own session                          | Host extension API                                     | extensions.md                                                                 |
| Queued input                                    | S (steer and follow-up queues; `set_steering_mode`, `set_follow_up_mode`)                                                                                                       | ? (depends on `pi-acp` mapping)                            | S (RPC `steer`, `follow_up`, `clear_queue`)                      | Host                                                   | rpc-commands.md                                                               |
| Active-turn steering vs cancellation            | S (steer delivered after current tool calls, before next LLM call; `ctx.abort()`)                                                                                               | C (ACP `session/cancel` → `abort`; steer ?)                | S (`steer`, `abort`, `abort_bash`, `abort_retry`)                | Host                                                   | rpc-commands.md, extensions.md                                                |
| Approvals/permissions                           | C (**no built-in per-tool approval**: "it does not ask for approval before every tool call"; an extension `tool_call` handler can block; project trust gates project resources) | C (`pi-acp` permission mapping ?)                          | C (same; extension UI requests forwarded over RPC)               | Host plus user extensions                              | security.md, extensions.md, rpc-extension-ui.md                               |
| Reconnect/offline/cancellation, acks            | C (no extension survives the process; triage checkpoint catches up)                                                                                                             | C (`session/load` reattaches to the file, not the process) | C (orderly shutdown on stdin EOF/SIGTERM; restart = new process) | Triage must own checkpoints and acks                   | rpc.md; inference; mcp.md                                                     |

A new model completion (`pi-ai`), a new process (`--mode json`, `--mode rpc`, `pi-acp`), resumed history (`--resume`, `switch_session`, `session/load`), a notification received (an extension event) and a started agent turn (`triggerTurn`, `sendUserMessage`, RPC `prompt` with disposition `started`) are different outcomes.

## Existing-session boundary

- **Native SDK/RPC adapter:** controller-owned only. Acceptable for disposable sessions and tests. Two processes opening the same session file concurrently is undocumented and must be assumed unsafe.
- **ACP (`pi-acp`):** controller-owned; a reconnect reloads the session file into a new RPC process, not into the user's TUI.
- **Plain MCP tools:** run inside the user's session, initiated by the model. Correct for reads; cannot initiate anything.
- **Extensions:** the one route into a running user-owned session, and the most dangerous. An extension runs with the user's full permissions, can start turns and can rewrite tool calls. A triage extension must therefore be opt-in, user-installed (never auto-installed through project `.pi/extensions`, which is in any case gated by project trust), and notify-only: on `session_start` or `agent_settled` it checks the triage events service for the bound repository and agent (`agent-inbox.toml`) and session (`ctx.sessionManager` / session ID), batches since the checkpoint, suppresses the agent's own writes, and queues one short `deliverAs: "nextTurn"` notice ("triage has N new events; run triage") with `display: true`, acknowledging only after it is appended. It must not use `triggerTurn`, `steer` or `sendUserMessage` by default.

Trust boundary, unchanged: a notice carries no ticket text, acquires no claim and authorizes nothing. The agent runs ordinary triage and the claim rules; ticket content remains untrusted evidence, and all writes stay on the verified-write paths.

## Verification

Done on 2026-11-13, read-only, on macOS, from a Claude Code session (no Pi host session was exercised):

- `which pi` → not found. **Unverified locally:** `pi --version`, `pi --help`, `pi mcp --help`, MCP/extension config, environment variable names in a live session or MCP server process.
- `gh api repos/badlogic/pi-mono` → resolves to `earendil-works/pi`, MIT; `gh release list` → v1.5.2 Latest (2026-11-10).
- `npm view @mariozechner/pi-coding-agent deprecated` → points to `@earendil-works/pi-coding-agent`; registry checks as in [Libraries](#libraries).
- Shallow clone of `earendil-works/pi` at `97d539c` into the scratchpad (read, not built or executed). Confirmed in source: `AI_AGENT=pi` and `PI_CODING_AGENT=true` set in `packages/coding-agent/src/cli/setup.ts` and `rpc-entry.ts`; `PI_SESSION_ID` referenced in `core/tools/bash.ts`; `packages/mcp/src/transports/stdio.ts` passes `{ ...process.env, ...env }` to stdio servers unless `inheritEnv: false`; no ACP implementation in `packages/`.
- `pi-acp` README read via the GitHub API (spawns `pi --mode rpc`; session map file).
- `src/harness.ts` registers no Pi detector today (Claude Code, Codex and Ori only).
- Not run: any `pi` command, RPC session, extension, `pi-acp` or MCP connection (none installed; would also need provider credentials and paid turns).

## Recommended adapter

1. Ship the read-only MCP server (#25) and document a Pi `mcp.json` stdio example (`pi mcp add github-triage -- <cmd>`) after an installed-bin smoke on a Pi host.
2. Add a Pi harness detector on `AI_AGENT=pi` / `PI_CODING_AGENT=true`, after verifying in a live session that they reach the MCP server process (source says they should, via env inheritance). Session ID for MCP servers is not documented; do not rely on it.
3. Optionally, an opt-in notify-only Pi extension as described above, using `deliverAs: "nextTurn"` only. Its contract goes in a separate docs PR first.
4. Use `RpcClient` (or `--mode rpc --no-session`) only for a disposable-session test harness, gated on owner approval of cost and credentials. Do not adopt `pi-acp`.

### Disposable-session test plan

On a Pi host with an approved provider account, in a scratch repository with a throwaway `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR`: record `pi --version`; `pi mcp add` the triage server and call one read tool; print environment variable names (not values) from the MCP server process and from a bash tool command; load a test extension that logs only event names and the session ID for `session_start`/`agent_settled`; queue a `nextTurn` notice and confirm it appears only on the next user prompt and starts no turn. Separately, in `pi --mode rpc --no-session`, record `prompt` dispositions while idle and during a run, `steer` delivery between tool calls and the next model call, and `abort`. Record versions and timings only, no transcripts.

## Risks/unknowns

- Project and package move (`badlogic/pi-mono` → `earendil-works/pi`, `@mariozechner/*` → `@earendil-works/*`) and fast releases; pin versions in any test. `@mariozechner/pi` is an unrelated GPU-pod tool.
- Older guidance that says Pi has no MCP is stale; built-in MCP is recent and its env propagation is unverified on a live host.
- Extensions run with full user permissions and can start turns; any triage extension widens the trust surface and must stay notify-only and opt-in.
- Pi has no per-tool approval by default, so an MCP write tool would run without a prompt; keep the triage MCP server read-only as planned.
- `pi-acp` is community, pre-1.0 and pinned to an old ACP SDK; ACP support for MCP passthrough and permissions is unverified.
- Concurrent access to one session file from two processes is undocumented.

## Proposed follow-up tickets (not filed)

1. Add a Pi harness detector (`AI_AGENT=pi`, `PI_CODING_AGENT=true`) with tests, after live verification.
2. Document a verified Pi `mcp.json` example after the #25 installed-bin smoke.
3. Contract (docs-only) for an opt-in notify-only Pi extension (`nextTurn` only, bindings, batching, own-write suppression, checkpoint-as-ack).
4. Run the disposable-session test plan on a Pi host, including RPC steer/abort checks.

## Sources

Accessed 2026-11-13. Upstream paths are in https://github.com/earendil-works/pi at `97d539c`, under `packages/coding-agent/docs/` unless noted.

- https://github.com/earendil-works/pi (README, LICENSE, releases v1.5.0–v1.5.2); https://github.com/badlogic/pi-mono (redirect)
- `mcp.md` (built-in MCP, config files, `pi mcp`), `packages/coding-agent/CHANGELOG.md` (MCP added, `--no-mcp`)
- `rpc.md`, `rpc-commands.md`, `rpc-extension-ui.md`, `json.md`, `cli.md`, `cli-integration.md` (modes, commands, dispositions, steer/follow-up/abort)
- `sdk.md` (`createAgentSession`, `SessionManager`, `AgentSessionRuntime`)
- `extensions.md` (events, `sendMessage` `deliverAs`/`triggerTurn`, `sendUserMessage`, `tool_call` blocking)
- `sessions.md`, `session-format.md` (continue/resume/fork, storage)
- `environment-variables.md` (`AI_AGENT`, `PI_CODING_AGENT`, `PI_SESSION_ID`, `PI_SESSION_FILE`), `security.md` (no per-call approval, project trust)
- Source: `packages/coding-agent/src/cli/setup.ts`, `packages/coding-agent/src/rpc-entry.ts`, `packages/coding-agent/src/core/tools/bash.ts`, `packages/mcp/src/transports/stdio.ts`, `packages/mcp/package.json`
- https://www.npmjs.com/package/@earendil-works/pi-coding-agent, https://www.npmjs.com/package/@earendil-works/pi-mcp, https://www.npmjs.com/package/@mariozechner/pi-coding-agent, https://www.npmjs.com/package/@mariozechner/pi
- https://github.com/svkozak/pi-acp and https://www.npmjs.com/package/pi-acp (README: architecture, session map, limitations)
- https://github.com/nicobailon/pi-mcp-adapter and https://www.npmjs.com/package/pi-mcp-adapter
