# Codex idle-agent notifications and wake-up

Research for #21, accessed 2026-11-13. Recommendation for #20/#26; not an implementation contract or evidence of a successful live wake.

## Recommendation

Prototype an opt-in adapter around the installed `codex queue` command, bound to one explicitly registered session UUID and project. Keep event collection in #32 and the generic MCP interface in #25. Use boundary hooks as a fallback for next-turn delivery. Do not build a second app-server controller merely to send a notification.

The important distinction is **event detected → signal queued → turn started → event inspected**. None implies the next. Notifications neither claim tickets nor grant authority to work.

## Current platform evidence

The official [developer commands reference](https://learn.chatgpt.com/docs/developer-commands) documents:

```sh
codex queue --thread <SESSION_UUID> --message "Triage events available; inspect the project briefing."
```

`--resume` additionally attempts to load a session through a running local daemon or selected remote server. A failed resume can still produce a successful command exit. Therefore queue success is not a delivery acknowledgment. Use a UUID rather than a potentially duplicate session name. This is a developer surface: capability-check the installed command and record its version rather than promising universal availability.

The official [hooks documentation](https://learn.chatgpt.com/docs/hooks) supports lifecycle checks and model-visible context. Synchronous Stop hooks can request continuation; waiting in one holds the session. Background hooks can supply context at safe points, but completing one while idle does not start a new turn. Non-managed hooks require review and trust; changed definitions require renewed trust. A written hook is not necessarily an active hook.

The official [app-server protocol](https://learn.chatgpt.com/docs/app-server) offers `thread/resume`, `turn/start`, `turn/steer`, and `turn/interrupt`. These distinguish reopening history, starting generation, adding input to active work, and cancellation. An external controller can own this lifecycle, but would also own approvals, authentication, connections and event processing. Default stdio is simpler than its experimental WebSocket transport for a dedicated controller. Do not assume an arbitrary MCP notification invokes these methods.

| Harness                                        | Practical route                                                          | Remaining verification                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Local CLI, compatible queue command and daemon | Queue an opt-in signal to the registered UUID; optionally request resume | Idle versus busy behavior, daemon absence, acknowledgment                            |
| Desktop / IDE session                          | Test queue against the actual host-owned session first                   | Shared daemon/session ownership and visible delivery are not established by CLI help |
| Integration owning an app-server session       | Controller starts a turn when idle; leaves active work alone by default  | Approval handling, reconnect, identity and event acknowledgment                      |
| Hosted / managed session                       | Host-supported integration or next-turn briefing                         | Local CLI availability does not establish remote session reachability                |
| MCP-only connection                            | On-demand briefing, possibly host-specific context notices               | No generic idle-wake guarantee established                                           |

No desktop automation, terminal keystroke injection, private database edits or active-turn interruption is recommended.

## Reproducible local inspection

On this machine, `codex --version` reports **0.167.2**. `codex queue --help` confirms `--thread`, `--message`, `--resume`, `--remote` and the warning that failed resume still succeeds. `codex app-server --help` confirms stdio, Unix and WebSocket transports. These commands only inspected capabilities; no message was queued and no model run was started.

The sibling Agent Inbox checkout at commit `8c74488f8db2590902c81bb72c5ab68ffb830820` already contains a useful reference:

- `src/agent_inbox/session_wake.py`: explicit project/address/session binding, absolute CLI executable, validated UUID, duplicate tracking, coalescing, rate limiting and a `codex_queue` backend.
- `src/agent_inbox/hookconfig.py`: short boundary checks; explicitly rejects a held Codex Stop waiter because it blocks the session. Its comment that Codex lacks asynchronous hooks should not be copied as a current general capability claim: current official docs support background hooks, which still cannot initiate an idle turn.
- `src/agent_inbox/session_hook.py`: validates session/transcript identity and separates root/child contexts.

This is source inspection, not proof that those paths are configured or functioning here. Reuse the design lessons; do not copy mailbox configuration, tokens or session IDs into this repository. The merged identity compatibility report and `doc/design/identity.md` remain prerequisites for routing decisions.

## Proposed adapter boundary

The detector supplies an immutable event ID, repository, subject URL, category, observation time, evidence completeness and originating identity when known. The adapter resolves the persistent recipient name to a locally approved project/session binding. Ambiguity produces an actionable unsupported result, never a guessed session or a replacement agent name.

Keep a durable per-recipient cursor and pending batch. Deduplicate event IDs; coalesce bursts into one notice carrying an opaque batch ID. A fixed notice asks the agent to fetch trusted tool output; never paste arbitrary issue text into a user-message channel as instructions. Ignore an originating agent’s own mechanical updates when confidently attributable, while retaining subsequent reviewer feedback. Unknown origin is not permission to drop an event.

Report `unsupported`, `queued`, `observed`, `failed` and `unknown` distinctly. A timeout after submission is unknown: retrying blindly can duplicate work. Inspection acknowledges a batch; process exit alone does not. Offline events remain available for catch-up in the ordinary briefing. Keep active work running and schedule inspection at a safe boundary; interrupt/cancel requires a separate explicit policy.

This benefits implementers through prompt review feedback and newly available work. Designers get a compact decision/owner-attention digest rather than every GitHub change. Disabling wake leaves ordinary CLI/MCP triage usable. No SQLite daemon or shared-backend lifecycle is required for this first adapter; #42 remains deferred.

## Bounded verification before #26 implementation approval

Use a disposable repository and dedicated opt-in session with an explicit model budget. Record CLI/host versions, transport and session ownership. Test idle loaded session, busy turn, unloaded session, absent daemon, duplicate burst, disconnected/restarted host, expired binding and two recipients. Inspect that the intended session receives exactly one batch and acknowledges it; verify another project/session remains untouched. Capture no credentials or private transcripts.

Test process success plus resume warning separately from a real completed turn. Verify that queued events do not interrupt active work or silently grant new permissions. Demonstrate fallback when queue is unsupported. Desktop, IDE and hosted support remain unverified until their own cases pass. Research is complete; live end-to-end verification is explicitly pending a bounded prototype, not reported as a successful wake.
