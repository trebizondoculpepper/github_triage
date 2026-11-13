# Codex libraries and platform-specific adapters (#224)

Platform follow-up for the parent synthesis #20, written by a Claude Code agent doing desk research on macOS with the Codex CLI 0.167.2 installed but **not running as the host**. It builds on [codex-idle-wakeup.md](../codex-idle-wakeup.md) (#21) and records only what is new or changed: the library inventory, the per-surface session-control matrix and the existing-session boundary. It follows the structure of the Claude Code sibling report (#225). Research and documentation only: no runtime code, hooks, settings, MCP registrations, sessions, daemons or GitHub state were changed, no message was queued and no model turns were run.

## Summary

There are four distinct ways to integrate with Codex, and they must not be confused:

1. **Plain MCP tools** (the baseline in [mcp.md](../../design/mcp.md)). Codex is an MCP client; a `github-triage-mcp` stdio server registered with `codex mcp add <name> -- <command>` is called by the model inside the user's own session. Nothing wakes or steers the session.
2. **Native SDK control** through the official `@openai/codex-sdk` (Apache-2.0). The SDK spawns the `codex` CLI and exchanges JSONL events over stdio. `startThread()`/`run()`/`runStreamed()` and `resumeThread(id)` give controller-owned threads; resuming loads persisted history (`~/.codex/sessions`) into the SDK's own process. It does not attach to a running interactive session.
3. **App-server controller** (`codex app-server`, experimental command, JSON-RPC over stdio, Unix socket or WebSocket, plus a local daemon). Its protocol has the richest lifecycle: `thread/resume`, `thread/loaded/list`, `turn/start`, `turn/steer`, `turn/interrupt`, `thread/unsubscribe`, and an experimental server-side queue (`thread/queue/*`). The client that connects owns approvals, auth and event handling for what it drives.
4. **ACP controller-owned sessions** through `@agentclientprotocol/codex-acp` (Apache-2.0), which starts its own App Server and translates ACP. The ACP client (an editor such as Zed) owns the session. It adds a `_session/steering` extension whose outcomes (`injected`, `startedNewTurn`, `promptRequired`) are a useful vocabulary, but only for sessions that client owns.

**What changed since #21:** Codex differs from Claude Code in one material way: the host itself ships a CLI route into an existing session by ID, `codex queue --thread <UUID> --message ... [--resume]`, backed by the app-server daemon and an (experimental) server-side queue. No library adds attachment beyond that. The SDK and ACP adapter both own their sessions. The registry now has `@openai/codex` and `@openai/codex-sdk` at 0.169.0 while this machine has CLI 0.167.2, so release cadence is near-daily and versions must be pinned and capability-checked.

**Recommendation.** Keep the plain MCP server as the Codex integration. As a later opt-in slice, prototype the #21 adapter that shells out to the installed `codex queue` with an explicitly bound session UUID and a fixed notice, treating success as `queued`, never as `observed`. Do not adopt `@openai/codex-sdk` or `codex-acp` for notification: they start or resume their own sessions (a new process and, for any prompt, a paid model turn) and would not reach the user's running agent. Consider a direct app-server client only if `codex queue` proves insufficient, since that makes triage the owner of approvals and auth.

## Libraries

Versions from `npm view <pkg> version license engines repository.url time.modified maintainers --json` on 2026-11-13.

| Package / repository                                                                        | Maintainer                          | License    | Version (registry modified) | Runtime                           | Role                                                      | Assessment                                                                                                                |
| ------------------------------------------------------------------------------------------- | ----------------------------------- | ---------- | --------------------------- | --------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `@openai/codex` ([repo](https://github.com/openai/codex))                                   | OpenAI                              | Apache-2.0 | 0.169.0 (2026-11-13)        | Node >=16 (wrapper of Rust build) | The CLI host, including `queue`, `app-server`, `mcp`      | Host, not a library. Local install is 0.167.2, two releases behind.                                                       |
| `@openai/codex-sdk` ([source](https://github.com/openai/codex/tree/main/sdk/typescript))    | OpenAI                              | Apache-2.0 | 0.169.0 (2026-11-13)        | Node >=18                         | Official TypeScript SDK; spawns `codex`, JSONL over stdio | Official and permissively licensed. Owns its threads; `resumeThread` reloads history. Version tracks the CLI.             |
| Codex App Server protocol (`codex app-server generate-ts` / `generate-json-schema`)         | OpenAI                              | Apache-2.0 | Ships with the CLI          | Any JSON-RPC client               | Generated bindings, not a published npm package           | The authoritative lifecycle surface. Command is marked experimental; some methods (queue) need `experimentalApi`.         |
| `@agentclientprotocol/codex-acp` ([repo](https://github.com/agentclientprotocol/codex-acp)) | ACP org (Zed contributors)          | Apache-2.0 | 2.6.0 (2026-11-12)          | Node; bundles `@openai/codex`     | ACP agent over the App Server                             | Maintained and active; has a `preview` channel from `main`. Successor of `@zed-industries/codex-acp` 0.16.0 (2026-06-23). |
| `@agentclientprotocol/sdk`                                                                  | ACP org                             | Apache-2.0 | 2.6.0 (2026-11-10)          | Node                              | ACP client/agent library                                  | Only useful if triage became an ACP client. Not recommended.                                                              |
| `@modelcontextprotocol/server`                                                              | MCP project (incl. Anthropic staff) | Apache-2.0 | 2.4.0 (2026-10-23)          | Node >=20                         | MCP server SDK                                            | Already chosen by [mcp.md](../../design/mcp.md); host-neutral.                                                            |

No maintained community library was found that attaches to a running Codex TUI session beyond the host's own `queue`/daemon route. Python and other-language SDKs were not surveyed (TypeScript project; bounded search).

## Capability matrix

Key: **S** supported (documented), **C** conditional, **U** unsupported, **?** unverified/undocumented. Surfaces: **CLI** = interactive `codex` TUI owned by the user; **IDE/Desktop** = Codex IDE extension and Desktop app (`codex app`); **Headless** = `codex exec`, `@openai/codex-sdk`, an app-server client, `codex-acp`. "Who provides it" separates the library from the host.

| Capability                                      | CLI                                                                                  | IDE/Desktop                                       | Headless (exec/SDK/app-server/ACP)                                                         | Who provides it                                              | Source                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | --------------------------------------------------------- |
| Tool/MCP connection                             | S (`codex mcp add NAME -- CMD`, `--url` for streamable HTTP, `--env`)                | C (shared `~/.codex/config.toml`, UI not checked) | S (SDK `config` overrides; ACP "client-provided MCP servers")                              | Host MCP client; triage supplies the server                  | CLI `--help` (local); codex-acp README                    |
| Identity/workspace resolution                   | C (env markers + `agent-inbox.toml`; markers unverified on a Codex host)             | ?                                                 | C (controller sets `workingDirectory`/`cwd`; SDK may replace env)                          | Triage resolver, not the library                             | [identity.md](../../design/identity.md), `src/harness.ts` |
| Create session                                  | S                                                                                    | S                                                 | S (`startThread()`, `thread/start`, ACP `session/new`)                                     | Library over host                                            | SDK README; app-server schema (local)                     |
| History / resume                                | S (`codex resume [ID                                                                 | --last]`, `codex fork`)                           | C                                                                                          | S (`resumeThread(id)`, `codex exec resume`, `thread/resume`) | Host session store; library passes IDs                    | CLI `--help` (local); SDK README |
| Attach to an already-running user-owned session | C (`codex queue --thread` reaches a thread via the daemon; TUI ownership unverified) | ? (shared daemon not established)                 | C (app-server client on the same daemon: `thread/loaded/list`, `thread/resume`); SDK/ACP U | Host daemon only                                             | CLI `--help`; app-server schema; #21                      |
| Events/subscriptions out of the session         | C (hooks)                                                                            | ?                                                 | S (SDK `runStreamed()` events; app-server notifications until `thread/unsubscribe`)        | Host hooks / SDK stream / app-server                         | hooks docs; SDK README; app-server README                 |
| Context on next turn                            | S (hook model-visible context)                                                       | ?                                                 | S (next prompt)                                                                            | Host                                                         | hooks docs (#21)                                          |
| Wake an idle existing session                   | C (`codex queue --resume`; failed resume still exits 0)                              | ?                                                 | C (app-server `turn/start` on a loaded thread; ACP steer `startedNewTurn` for owned ones)  | Host only                                                    | CLI `--help` (local); codex-acp steering.md               |
| Queued input                                    | C (`codex queue`; server queue `thread/queue/*` is experimental)                     | ?                                                 | C (experimental `thread/queue/add`, `thread/queue/changed` notification)                   | Host / app-server                                            | app-server schema with and without `--experimental`       |
| Active-turn steering vs cancellation            | C (typed input; cancellation by the user)                                            | ?                                                 | S `turn/steer` vs `turn/interrupt`; ACP `_session/steering` vs `session/cancel`; SDK ?     | App-server/ACP for owned or loaded threads                   | app-server schema; codex-acp steering.md                  |
| Approvals/permissions                           | S (interactive approvals, sandbox modes)                                             | S                                                 | S (approval request/response messages; `--sandbox`, `--approve-for-me` in exec)            | Host engine; controller must answer                          | app-server schema; `codex exec --help` (local)            |
| Reconnect/offline/cancellation, acks            | C (queue exit code is not an ack; daemon may be absent)                              | ?                                                 | C (`thread/unsubscribe`/disconnect stops delivery; reload via `thread/read`)               | Triage must own checkpoints and acks                         | #21; app-server README                                    |

A new model completion, a new process, resumed history, a notification received and a started agent turn are different outcomes. `codex queue` produces a queued message (and optionally a resume attempt); only an observed `turn/started` on that thread is a started turn. SDK `resumeThread` produces resumed history in a new process.

## Existing-session boundary

- **Native SDK adapter:** spawns its own `codex` process per run. Good for a disposable-session test harness or an explicitly requested headless triage worker; never for notifying the user's running agent.
- **App-server controller:** the only library-level route that can see threads loaded in a shared daemon. Using it makes triage an app-server client responsible for approvals, auth, and event handling on whatever it touches, and many useful methods are experimental. Not the first slice.
- **ACP controller-owned session:** the editor owns it; triage would have to be the ACP client. Out of scope, but its steering outcome vocabulary is worth reusing for adapter results.
- **Plain MCP tools:** run inside the user's session, initiated by the model. Correct for reads; cannot initiate anything.
- **Host wake route:** `codex queue --thread <UUID>`. The smallest adapter is the #21 one: opt-in, bound explicitly to repository, agent name (from `agent-inbox.toml`, entry `codex`) and a registered session UUID (never a session name, which may be duplicated), with a per-recipient lock, coalescing of all events since the checkpoint into one fixed notice with an opaque batch ID, a rate limit, suppression of the agent's own writes, and results reported as `unsupported` / `queued` / `observed` / `failed` / `unknown`. The checkpoint (acknowledgment) advances only when the agent inspects the batch through ordinary triage.

Trust boundary, unchanged: a queued notice is fixed text with no ticket content, acquires no claim and authorizes nothing. The agent runs ordinary triage and the claim rules; ticket content remains untrusted evidence, and all writes stay on the verified-write paths. Never use `--dangerously-bypass-approvals-and-sandbox` or `--approve-for-me` in any adapter.

## Verification

Done on 2026-11-13, read-only, on macOS from a **Claude Code** session (so this is not a Codex host):

- `codex --version` → `codex-cli 0.167.2` (`/opt/homebrew/bin/codex`).
- `codex --help` lists `exec`, `mcp`, `app-server` (experimental), `remote-control` (experimental), `resume`, `fork`, `queue`, `archive`, `doctor`, `features`. No `mcp-server` subcommand is listed in this build, so Codex-as-MCP-server is not assumed.
- `codex mcp --help` lists `list`, `get`, `add`, `remove`, `login`, `logout`; `codex mcp add --help` shows `<NAME> (--url <URL> | -- <COMMAND>...)`, `--env KEY=VALUE` (stdio only) and `--bearer-token-env-var`. `codex mcp list` was not run because it reads live configuration.
- `codex resume --help`: `[SESSION_ID] [PROMPT]`, `--last`, `--all`; UUIDs take precedence over names.
- `codex exec --help`: subcommands `resume`, `fork`, `review`; flags include `--json`, `--ephemeral`, `--sandbox`, `--approve-for-me`, `--dangerously-bypass-approvals-and-sandbox`, `--output-schema`.
- `codex queue --help`: `--thread` (UUID or exact name), `--message`, `--resume` ("A failed resume produces a warning and the command still succeeds"), `--remote ws://|wss://|unix://`, `--remote-auth-token-env`. Unchanged from #21.
- `codex app-server --help`: `--listen stdio:// (default) | unix:// | unix://PATH | ws://IP:PORT | off`; subcommands `daemon` (`start`, `stop`, `restart`, `bootstrap`, `version`, remote-control toggles), `proxy`, `generate-ts`, `generate-json-schema`.
- `codex app-server generate-json-schema --out <scratch>` (offline, writes schema files only): the stable schema contains `thread/start`, `thread/resume`, `thread/fork`, `thread/loaded/list`, `thread/read`, `thread/unsubscribe`, `thread/status/changed`, `thread/queue/changed`, `turn/start`, `turn/steer`, `turn/interrupt`, `turn/started`, `turn/completed`; adding `--experimental` adds `thread/queue/add|list|update|delete|reorder|start` among others.
- `codex features list` (reads flags only): `hooks` stable/true, `daemon_auto_start` stable/true.
- Environment variable **names** matching `CODEX`/`OPENAI` in this shell: none. That is expected because the host is Claude Code. The Codex markers in `src/harness.ts` (`CODEX_THREAD_ID`, `CODEX_SANDBOX`, `CODEX_MANAGED_BY_NPM`, `CODEX_CI`) remain **unverified** here; the SDK README independently shows `CODEX_THREAD_ID` used as a thread ID, which supports it as a session-binding candidate.
- Registry metadata via `npm view` for the packages in [Libraries](#libraries); READMEs for the SDK, `codex-acp` and app-server read from GitHub `main`.
- **Not run:** any Codex session, `codex exec`, SDK or ACP thread (would spend model turns), `codex queue`, daemon start, IDE/Desktop checks. A Codex host is needed for all of these; they are recorded as unverified above.

## Recommended adapter

1. Ship the read-only MCP server (#25) and document a Codex `codex mcp add github-triage -- github-triage-mcp --project /abs/path` example after an installed-bin smoke on a real Codex host.
2. Later, as an opt-in, the #21 `codex queue` adapter over the shared events service, with the bindings in [Existing-session boundary](#existing-session-boundary). Capability-check `codex queue --help` and record the version at startup; report `unsupported` if absent.
3. Do not depend on `@openai/codex-sdk` or `codex-acp` for notification. The SDK is the right choice for a disposable-session test harness (Apache-2.0, no licence blocker, but costs model turns).
4. Only if queue proves insufficient, evaluate a minimal app-server client that uses `thread/loaded/list` to observe and `turn/started` to confirm delivery, without answering approvals.

### Disposable-session test plan

In a scratch repository with a throwaway `CODEX_HOME` and an explicit model budget: register the MCP server, start an interactive `codex` session and record its UUID; let it idle; run `codex queue --thread <UUID> --message <fixed notice>` with and without `--resume`; record whether a turn starts and how long it takes. Repeat with the session busy (expect queuing, no interruption), the daemon stopped (expect warning and exit 0, classify `unknown`), the session closed (catch-up on next start), a five-event burst (one notice), the agent's own comment (no notice) and a second session in the same repository (no cross-delivery). Confirm Codex env marker names in that session. Repeat against the IDE extension and Desktop app or mark them unsupported. Record CLI version, timings and `gh` request counts; capture no credentials or transcripts.

## Risks/unknowns

- `app-server` and `remote-control` are marked experimental; queue methods need `experimentalApi`. Release cadence is roughly daily (0.167.2 local vs 0.169.0 registry), so behaviour can shift between minor versions.
- Whether `codex queue` reaches a thread owned by an interactive TUI (rather than a daemon-loaded thread) is unverified; #21 also left this open.
- `codex queue` exit status is not delivery evidence; a failed resume still succeeds.
- IDE extension and Desktop app session ownership, daemon sharing and env markers are undocumented here.
- The SDK may replace the child environment (`env` option), so harness detection inside SDK-driven sessions needs its own check.
- ACP `_session/steering` is a pre-standard extension (proposal ACP PR #1261).

## Proposed follow-up tickets (not filed)

1. Verify Codex env markers (`CODEX_THREAD_ID` and others in `src/harness.ts`) on a real Codex CLI, IDE and Desktop host, and consider `CODEX_THREAD_ID` as an optional session-binding signal.
2. Document a verified `codex mcp add github-triage -- ...` example after the #25 installed-bin smoke.
3. Contract for the opt-in `codex queue` adapter (bindings, lock, rate limit, own-write suppression, result states, checkpoint-as-ack).
4. Run the disposable-session test plan above on a Codex host.
5. Spike: read-only app-server observer (`thread/loaded/list`, `turn/started`) to turn `queued` into `observed`, only if item 4 shows the need.

## Sources

Accessed 2026-11-13.

- https://github.com/openai/codex/blob/main/sdk/typescript/README.md (SDK spawns the CLI, JSONL, `startThread`, `runStreamed`, `resumeThread`, `~/.codex/sessions`, `CODEX_THREAD_ID` example, `env` override)
- https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md (`experimentalApi`, `thread/unsubscribe`, read-state notifications)
- https://www.npmjs.com/package/@openai/codex and https://www.npmjs.com/package/@openai/codex-sdk
- https://github.com/agentclientprotocol/codex-acp (README; `docs/steering.md` for `_session/steering` outcomes) and https://www.npmjs.com/package/@agentclientprotocol/codex-acp
- https://www.npmjs.com/package/@zed-industries/codex-acp (superseded)
- https://www.npmjs.com/package/@agentclientprotocol/sdk and https://www.npmjs.com/package/@modelcontextprotocol/server
- https://github.com/agentclientprotocol/agent-client-protocol/pull/1261 (steering standardization proposal, cited by codex-acp)
- Developer commands, hooks and app-server documentation as listed in [codex-idle-wakeup.md](../codex-idle-wakeup.md)
- Local: Codex CLI 0.167.2 `--help` output, `codex features list`, and offline `codex app-server generate-json-schema` (with and without `--experimental`), 2026-11-13
