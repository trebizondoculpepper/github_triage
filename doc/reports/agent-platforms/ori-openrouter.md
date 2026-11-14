# Ori / OpenRouter libraries, notifications and agent adapters (#24)

This is the Ori follow-up for parent synthesis #20, in the series with the Claude Code (#225), Codex (#224), Gemini CLI (#226), GitHub Copilot (#227), Cursor (#228), Cline (#229), Goose (#230) and Pi (#231) reports, and it follows their structure. It is research and documentation only: no runtime code, feature, schedule, webhook, hook or settings change was made. The live MCP results are in the companion [Ori MCP acceptance report](ori-mcp-acceptance.md) (#255) and are not repeated here.

"Ori" means OpenRouter's agent runtime and launcher, `ori` (`@ori-runtime/cli`). It has two different roles, which this report keeps apart:

- **Ori Code**, Ori's own coding agent (`ori`, `ori code`, the built-in runtime harness `ori`). It runs turns in a shared per-user daemon.
- **Ori Harness**, a launcher (`ori claude`, `ori codex`, `ori opencode`, `ori pi`, …, 19 agents in this version) that starts _another_ agent CLI with OpenRouter credentials, or, through `ori harness setup <agent>` (Codex, Claude, Cursor, Droid, Pi), rewrites that agent's own config so it uses OpenRouter until `ori harness reset`. In both cases the agent is Claude Code, Codex and so on, and that client's own report applies to MCP, hooks and sessions. Ori adds credentials, the model catalog and organization guardrails, not an integration surface (documented, Ori Harness guide).

## Provenance

- **Researcher:** `vijay_larionova`, running **in Ori Code** 0.17.0-alpha+e81f15e (alpha channel), built-in harness `ori`, **no wrapped client**, interactive TUI session. The session model is shown by Ori as `~anthropic/claude-opus-latest`; the exact resolved model is not exposed. Live probes used separate headless `ori code -p` turns on `google/gemini-2.5-flash`.
- **Environment:** macOS 27.2 (arm64), Node v26.7.0, `gh` 2.103.3, research date 2026-11-13/14 (UTC), this repository at `origin/main` `6d07514`.
- **Target installed locally:** yes. `ori` 0.17.0-alpha+e81f15e at `~/.local/bin/ori`, a single bundled executable, with a running shared daemon (`ori code daemon serve`, protocol 1).
- **Evidence levels, marked per row:** _observed_ (exercised in a real Ori session or daemon), _documented_ (`ori --help` text, Ori's bundled skills, or openrouter.ai docs) or _source-inspected_ (strings in the bundled JavaScript of the installed binary; not a public repository). No credentials, session IDs, transcripts or identity files are reproduced.
- **Budget:** about one hour, following [the research-stage instructions](../../design/research-stages.md). The test-turn cost was under $0.05.

## Summary

Ori Code is an MCP **client** with a strong session runtime, and that runtime is driven through a local authenticated HTTP API on the daemon. The things a triage adapter needs exist as separate surfaces, but not all of them work today:

1. **Plain MCP tools: supported, observed.** A stdio server in `~/.ori/mcp.json`, `./.ori/mcp.json`, `./mcp.json`, or a file selected with `--config`/`ORI_MCP_CONFIG` is connected with clientInfo `ori-<server key>`, capabilities `{}` (no roots, sampling or elicitation) and only six inherited environment variables (MCP SDK `getDefaultEnvironment`) plus the entry's `env`. github-triage's `ori-KEY` → `ori.KEY` identity mapping works (#255).
2. **Session resume: supported, observed.** `ori code -p … --resume <sessionId>` continues an existing session, keeping its context, as a new headless turn. This is a new turn in the same session, not delivery into an attached TUI.
3. **Steering an existing session: conditional, source-inspected; live probe inconclusive.** The daemon exposes `POST /api/steering/send` (`{sessionId, text, mode: queue|steer|interrupt}`, returning `{delivered}`), `GET /api/steering/queued/:id` and `POST /api/steering/edit`. These are authenticated with the per-port daemon token. A `queue` message to an **idle** headless session hung for 10 s with no response and nothing queued. An unknown session got an immediate 400. So steering appears to target **in-flight** turns. Whether it can wake an idle attended TUI session is unverified.
4. **Events: supported, source-inspected.** `GET /api/events/stream[?sessionId=…]` streams the runtime event journal as NDJSON, and `GET /api/sessions/:id/events|history|conversation` read a session. These are observation surfaces, not delivery.
5. **Wake triggers: supported, documented.** Ori **features** can declare **schedules** (`defineSchedule`, cron, which fire a headless agent run) and **webhooks** (`/__ori/hooks/<feature>/<name>`, verified by the vault before the handler runs; the bundled docs give a GitHub `x-hub-signature-256` recipe). **Workflows** (`ctx.step`, durable `ctx.sleep`, `continueFrom`) chain checkpointed agent runs. All of these **start new runs**. None was found that appends to an existing user-owned session.
6. **MCP server-to-client delivery: unsupported.** Ori's client registers only the SDK defaults (cancelled/progress/ping handlers plus list-changed refresh). Server notifications such as `notifications/message` or `resources/updated` do not reach the model, and Ori itself does not send `notifications/cancelled` on interrupt (#255).
7. **No Ori SDK or ACP.** There is no public `@ori-runtime/*` npm package; the CLI is a bundled binary. No ACP implementation is present. OpenRouter's SDKs (`@openrouter/sdk`, `@openrouter/agent`) are model-provider and tool-loop libraries. They create **new** agent loops, and cannot attach to an Ori session.

**Recommendation.** Treat Ori Code like the other clients: plain MCP first, which is already accepted (#255). For notification, the smallest viable adapter is an **opt-in Ori feature schedule** that calls the shared triage events service (`triage_events` / `--poll` semantics) and, when there is something actionable, starts a **new headless run** with a bounded, untrusted-labelled summary. It must not inject into a user's session. Session-level wake (`--resume`, or `/api/steering/send` into an attended session) should stay a separate, explicitly approved follow-up until steering semantics for idle attended sessions are verified.

## Libraries

Versions from `ori --version`, `npm view <pkg> name version license time.modified repository.url` and openrouter.ai on 2026-11-14.

| Package / artifact                                                                   | Maintainer     | License    | Version (date)               | Runtime                                                                                                                     | Role                                                                   | Assessment                                                                      |
| ------------------------------------------------------------------------------------ | -------------- | ---------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `ori` binary (`@ori-runtime/cli`), installed via `openrouter.ai/labs/ori/install.sh` | OpenRouter     | not stated | 0.17.0-alpha+e81f15e (alpha) | single executable (Mach-O arm64 here; embeds a Bun runtime filesystem); macOS, Linux, WSL and Windows per the install guide | Host: Ori Code agent, launchers, daemon HTTP API, MCP client, features | The integration target. Not on npm (`@ori-runtime/cli` 404); no published SDK   |
| `@openrouter/sdk` (npm)                                                              | OpenRouterTeam | Apache-2.0 | 1.5.103 (2026-11-13)         | Node                                                                                                                        | OpenRouter API client                                                  | Model calls only; no session control. Not needed by triage                      |
| `@openrouter/agent` (npm)                                                            | OpenRouterTeam | Apache-2.0 | 1.2.1 (2026-11-12)           | Node                                                                                                                        | Agent/tool loop over OpenRouter                                        | Builds a **new** agent; cannot attach to an Ori session. Not an adapter for Ori |
| `ori` (npm)                                                                          | unrelated      | MIT        | 0.1.9 (2026-08-14)           | n/a                                                                                                                         | Unrelated package with the same name                                   | Do not use                                                                      |
| `@modelcontextprotocol/sdk` (bundled inside Ori)                                     | MCP project    | MIT        | bundled version not exposed  | in-binary                                                                                                                   | Ori's MCP client                                                       | Explains the six-variable environment and the default notification handlers     |

## Capability matrix

Surfaces: **Ori Code** (TUI and `ori code -p`, same daemon) and **Ori Harness launchers** (`ori claude` and others; capabilities are the wrapped client's, see its report).

| Capability                                      | Ori Code                                                                                                                                        | Evidence                                                            | Ori Harness launchers                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| Tool / MCP connection                           | **supported**: stdio and HTTP/OAuth; layered `mcp.json`; repository-file servers need attended approval                                         | observed (#255)                                                     | wrapped client's own MCP                                      |
| Identity / workspace resolution                 | **supported**: clientInfo `ori-KEY`. **No roots.** Server cwd is the **daemon's**, so `--project` is required (#271)                            | observed                                                            | wrapped client's markers; Ori adds OpenRouter session headers |
| Session creation                                | **supported**: `ori code -p`, TUI, schedules, workflows                                                                                         | observed/documented                                                 | wrapped client                                                |
| History / resume                                | **supported**: `--resume <id>`, `--merge-from`, `/api/sessions/:id/history`, fork points                                                        | observed (resume)                                                   | wrapped client                                                |
| Attach to an already running user-owned session | **conditional**: `/api/attach/session` exists for the daemon's own clients (TUI). Its contract for third parties is unverified                  | source-inspected                                                    | wrapped client                                                |
| Events / subscriptions                          | **supported**: `/api/events/stream` NDJSON journal, per-session filter                                                                          | source-inspected                                                    | n/a                                                           |
| Context on next turn                            | **conditional**: an MCP tool result only when the model calls it; `queue` steering mode exists                                                  | observed/source                                                     | wrapped client                                                |
| Wake an idle existing session                   | **unverified**: `steering/send` to an idle headless session hung with nothing queued. `--resume` starts a new turn in that session from outside | observed (probe)                                                    | wrapped client (hooks etc.)                                   |
| Queued input                                    | **conditional**: `mode: queue` and `GET /api/steering/queued/:id` exist; observed empty after the idle probe                                    | source-inspected                                                    | wrapped client                                                |
| Active-turn steering vs interrupt               | **supported in source**: `steer` and `interrupt` modes are distinct; `interrupt` and `/api/invoke/:id/cancel` cancel                            | source-inspected                                                    | wrapped client                                                |
| Approvals / permissions                         | **supported**: `--approvals self-drive                                                                                                          | manual`, interaction respond endpoint, repository-file MCP approval | documented                                                    | wrapped client + OpenRouter org guardrails |
| Reconnect / offline / cancellation / ack        | **conditional**: workflows resume after daemon restart; the daemon keeps MCP servers across turns; **no MCP `notifications/cancelled`**         | observed/documented                                                 | wrapped client                                                |
| MCP server → model notifications                | **unsupported**: only default SDK handlers are registered                                                                                       | source-inspected                                                    | wrapped client                                                |
| External trigger (webhook/cron)                 | **supported**: feature webhooks with vault-verified signatures (GitHub recipe documented) and cron schedules; both start new runs               | documented                                                          | n/a                                                           |

## Existing-session boundary

A **new completion**, a **new process**, a **resumed history**, a **notification receipt** and a **started agent turn** are different outcomes in Ori:

- Schedules, webhooks and workflow steps **start a new run**. A workflow step can `continueFrom` an earlier step's session, but only a session that workflow created.
- `ori code -p --resume <id>` **starts a new turn in an existing session**, with its history (observed). It runs headless, outside any attached TUI. The user sees it only when they next open the session.
- `POST /api/steering/send` addresses a session by ID with `queue`, `steer` or `interrupt`. The source shows it delivering into the harness's steering channel. The idle-session probe neither delivered nor queued, so **waking a user's idle attended session through steering is unverified** and must not be assumed.
- None of these is a "notification". The model learns about GitHub changes only through text in a turn, or through a tool result it requested.

Any adapter that writes into a user's session (`--resume`, steering) changes what that user's agent does next. Per #20 and the trust boundary, that needs explicit opt-in, a bound `(repo, agent, session)` triple, and labelling of ticket text as untrusted data. A wake must never claim work.

## Verification

| What                                               | How                                                                             | Result                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| MCP connection, identity, reads, cancellation, cwd | #255 checklist, real `ori code -p` turns                                        | conditional; see [acceptance report](ori-mcp-acceptance.md)                                    |
| MCP client environment and clientInfo              | `tee` wrapper on stdio; env names recorded                                      | six SDK variables + entry `env`; `ori-KEY`, capabilities `{}`                                  |
| Resume a disposable session                        | turn 1 "reply READY"; turn 2 with `--resume` asked for the previous reply       | **observed**: same session ID, reply `READY`                                                   |
| Steering an idle disposable session                | `POST /api/steering/send` `mode: queue` with the daemon token, 10 s timeout     | **inconclusive**: no response (curl timeout); `queued: []`; no new turn. Unknown session → 400 |
| Daemon routes and schemas                          | strings of the installed binary                                                 | routes listed above; steering modes `queue                                                     | steer | interrupt`; event stream NDJSON |
| Features: schedules, webhooks, workflows           | bundled Ori skills (`code-o-schedule`, `code-o-workflow`) and bundled docs text | documented; **not exercised** (no feature was installed)                                       |
| OpenRouter SDK packages                            | `npm view`                                                                      | versions above; no session-control API in their scope                                          |

Not run: attaching a third-party client to a running TUI session; steering during an in-flight turn; installing a feature schedule or webhook; Windows/Linux; Ori Harness launchers (each wrapped client needs its own platform agent).

**Disposable-session test plan for a follow-up** (owner approval needed, because it touches the daemon):

1. Start a disposable `ori code` TUI in a scratch directory.
2. From another shell, `POST /api/steering/send` with `mode: queue` while the TUI is idle, then during a deliberately long turn. Record `delivered`, `/api/steering/queued/:id`, and whether a turn starts.
3. Repeat with `steer`. Never use `interrupt` against a real user session.
4. Install a global test schedule (`ori features new … --kind schedule`) that calls `github-triage --json` read-only, trigger it with `ori schedules trigger`, and record that it ran as a new session.
5. Remove the feature and stop the scratch session.

## Recommended adapter

1. **Baseline (done):** `github-triage-mcp` as a stdio server in a project-local or `ORI_MCP_CONFIG` file, always with `--project`. One server key per logical agent (`ori.KEY` identity).
2. **Smallest notification adapter (proposal):** an opt-in **global Ori feature schedule** (or GitHub **webhook** feature) that:
   - reads the shared triage events service for an explicitly configured repository and agent, with a cursor kept by the feature;
   - deduplicates and batches events, and does nothing when none are actionable;
   - starts **one new headless run** whose prompt is a bounded summary, with ticket text labelled as untrusted data, and is told to run `triage_briefing` itself.

   The run must not use `--resume` or steering into a user session. It must not claim, label or write. It ignores events caused by the bound agent's own writes, using the existing own-write detection.

3. **Session wake (later, gated):** only after the test plan above verifies idle-session steering semantics, and with per-session opt-in.

Shared-contract requirements: explicit repository, agent and (if any) session binding; batching and deduplication by event ID; an acknowledgement or cursor advanced only after the run is accepted; fallback to on-demand `triage_briefing`. This fits both workflows: an implementer gets "something changed, run triage"; a designer catch-up uses the same feature with `mode: briefing`.

## Risks/unknowns

- Ori is **alpha** (0.17.0-alpha). Daemon routes, schemas and the `ori-KEY` client name are undocumented internals and may change. Only CLI flags and the documented feature kinds should be relied on.
- Daemon API authentication uses a per-port token file under `~/.ori/daemon/`. An adapter that uses it holds full control of the user's runtime. Do not do this without explicit approval.
- The steering behaviour for idle sessions is unknown (the probe hung). It could block a caller, which is another reason not to make it the baseline.
- Feature schedules arm under `ori code` (global) or `ori dev` (repository). Unattended runs spend the user's OpenRouter credit. A budget and an opt-in are needed.
- MCP servers persist across turns in the daemon, so a `--poll` server keeps polling between sessions (#255 Finding 3).
- Hosted Ori ("interns", Slack, dashboard) has a `routine` tool and different surfaces. These were not examined.

## Proposed follow-up tickets (not filed)

1. Verify idle versus in-flight `steering/send` semantics in a disposable attended session (the test plan above). Ori-only, needs owner approval.
2. Prototype a read-only global Ori schedule feature that runs `github-triage --json` and starts a new run when events are actionable. Ori-only, opt-in, budgeted.
3. Ask OpenRouter (upstream) for MCP `notifications/cancelled` on interrupt, a documented harness marker, and passing the turn's cwd (or roots) to MCP servers.

## Sources

Accessed 2026-11-13/14 (UTC).

- Ori Harness guide: https://openrouter.ai/docs/guides/ori/harness
- `ori --help`, `ori code --help`, `ori mcp --help`, `ori sessions --help`, `ori harness --help`, `ori code daemon status --json` (0.17.0-alpha+e81f15e)
- Bundled Ori skills `code-o-schedule` and `code-o-workflow`, and bundled feature-authoring docs (webhook verification recipes), as shipped with the installed version
- Installed binary strings: daemon routes (`/api/steering/*`, `/api/events/stream`, `/api/sessions/*`, `/api/attach/session`, `/__ori/hooks/…`), `SteeringModeSchema` (`queue|steer|interrupt`), MCP client construction (`ori-${serverName}`, `getDefaultEnvironment`)
- npm registry: `@openrouter/sdk`, `@openrouter/agent`, `ori`, `@ori-runtime/cli` (404)
- Live evidence: [ori-mcp-acceptance.md](ori-mcp-acceptance.md) (#255); trebizondoculpepper/agent-inbox#91 (Ori MCP client environment and clientInfo)
