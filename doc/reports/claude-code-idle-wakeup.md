# Waking an idle Claude Code agent on GitHub activity (#22)

Platform research for the parent #20, written by an agent running on Claude Code (CLI 2.1.322, macOS), as the ticket requires. Research only: no hooks, settings, watchers or services were installed or changed, and nothing was broadcast.

## Summary

Claude Code can start a turn in an **idle local session** without a human typing. The documented route is: a background **`asyncRewake` hook** that exits with code 2. Two further documented routes exist but are unverified here: **posting into the session's own inbox socket** from a child process, and **Channels**, which are a gated research preview. Every GitHub-native route Anthropic documents (GitHub Actions, cloud scheduled tasks with GitHub triggers, cloud auto-fix) either **starts a new session** or applies only to cloud sessions. None delivers into an existing local CLI session.

**Recommendation.** The smallest useful Claude Code adapter is a **session-started background waiter**. It is an `async` + `asyncRewake` hook that runs a shared GitHub change detector, for example the triage CLI with `--checkpoint`, and exits 2 with a short, fixed notice only when relevant work for this agent has appeared. The agent then runs the triage tool itself under the ordinary claim rules. The notice never contains issue text. A host without this adapter keeps ordinary on-demand triage.

## The four capabilities, kept apart

| Capability                      | What it means                        | Claude Code                                                                                                                                                    |
| ------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI notification to a human      | Tell a person something happened     | Yes, outbound only: `PushNotification`, Desktop OS notifications, Remote Control phone push. These do not wake the model.                                      |
| Context on the next turn        | Text added when the agent next acts  | Yes: `additionalContext` from `SessionStart`, `UserPromptSubmit`, `Stop` and others. Output from a plain async hook also waits for the next turn.              |
| Start a turn in an idle session | The model runs without anyone typing | Yes, by several routes (matrix below). End-to-end operation remains unverified for this project.                                                               |
| Interrupt an active turn        | Get the model's attention mid-turn   | Partial. Messages are queued and delivered between tool calls in the same turn. Nothing documented preempts a running tool call except a human pressing `Esc`. |

## Capability matrix

Docs read on 2026-11-12 under `https://code.claude.com/docs/en/`. Key: **S** documented as supported, **P** partial or conditional, **U** documented as unsupported, **?** not documented, Variants: CLI = interactive terminal (JetBrains runs this CLI in its terminal); `-p` = headless/SDK; Desktop; VS Code; Cloud = claude.ai/code.

| Mechanism                                                                               | CLI                               | `-p`                   | Desktop | VS Code | Cloud                     | Stability                        | Source                                |
| --------------------------------------------------------------------------------------- | --------------------------------- | ---------------------- | ------- | ------- | ------------------------- | -------------------------------- | ------------------------------------- |
| `asyncRewake` hook exits 2, waking an idle session                                      | S                                 | P (killed at teardown) | ?       | ?       | ?                         | GA (no label)                    | hooks.md                              |
| Stop hook `decision: "block"` keeps a turn going (capped at 8 in a row)                 | S                                 | ?                      | ?       | ?       | ?                         | GA                               | hooks.md                              |
| Hook `additionalContext` on the next turn                                               | S                                 | ?                      | ?       | ?       | ?                         | GA                               | hooks.md                              |
| Post to the session's own inbox socket from a child process, idle session starts a turn | S                                 | ?                      | P       | P       | P                         | GA (v2.1.224+)                   | cross-session-messaging.md            |
| Channel event (`notifications/claude/channel`)                                          | S                                 | P                      | ?       | ?       | ?                         | **Research preview**, gated      | channels.md, channels-reference.md    |
| MCP task result arriving while idle starts a turn                                       | S                                 | P                      | ?       | ?       | ?                         | **Public beta** (v2.1.304+)      | mcp.md                                |
| Ordinary MCP notifications (`list_changed` and so on) start a turn                      | ?                                 | ?                      | ?       | ?       | ?                         | n/a                              | mcp.md (refetches lists only)         |
| `/loop`, `CronCreate`, `ScheduleWakeup` fire between turns                              | S                                 | P                      | ?       | ?       | P                         | GA, session-scoped, 7-day expiry | scheduled-tasks.md                    |
| Monitor tool streams lines to the session                                               | S                                 | P (10 min cap)         | ?       | P       | ?                         | GA, 5–30 min watches             | tools-reference.md                    |
| Cloud scheduled task with GitHub or API trigger                                         | U (new session)                   | U                      | U       | U       | U (new session per event) | **Research preview**             | routines.md                           |
| GitHub Actions `@claude`                                                                | ? (a workflow run, not a session) |                        |         |         |                           | Action v1                        | github-actions.md                     |
| Cloud/Desktop PR auto-fix receives review and CI events                                 | P                                 | ?                      | P       | ?       | P                         | GA                               | claude-code-on-the-web.md, desktop.md |
| `claude -p --resume <id> "…"` from an external process                                  | ?                                 | S                      | ?       | ?       | P (`--cloud`)             | GA                               | headless.md                           |

Verified quotations:

- hooks.md: "Hook output is delivered on the next conversation turn. If the session is idle, the response waits until the next user interaction. Exception: an `asyncRewake` hook that exits with code 2 wakes Claude immediately even when the session is idle." Also: "Claude Code still enforces `timeout` on a hook you run with `asyncRewake`."
- cross-session-messaging.md: "When the receiving session is idle, Claude Code starts a new turn with the message." A hook or Bash command posting to its own session's socket counts as an "own-child" message, delivered when no `crossSessionInbound` value applies. On macOS this is verified by process evidence only while the poster is still running; otherwise it needs the exported `CLAUDE_CODE_MESSAGING_TOKEN`.
- channels.md: "Channels are in research preview. They require Anthropic authentication through claude.ai or a Console API key… Team and Enterprise organizations must explicitly enable them." A custom channel also needs `--dangerously-load-development-channels`.
- routines.md: "A GitHub trigger starts a new session automatically… Claude Code doesn't reuse sessions across events."
- mcp.md: "If Claude is idle when the result arrives, Claude starts on it unprompted." This refers to MCP tasks, which are in public beta.

## Verification boundary

A live idle-wake experiment was not repeated for this standalone project. The proposed hook behavior comes from the official host documentation; an end-to-end triage adapter remains subject to the verification plan below. The native host socket route is not demonstrated here; its documented existence does not establish a supported message protocol.

## Recommended adapter

```text
GitHub ──(gh GraphQL, polled)──> shared detector/filter ──> per-host adapter ──> agent turn
                                 (triage CLI, --checkpoint)    Claude Code: asyncRewake waiter
```

1. **Shared detector, host-neutral.** Reuse the triage CLI's existing `--since`/`--checkpoint` window and briefing rules. Filter to what this agent should act on: new pickable work, explicit attention for its persistent name (once #3 and #14 define it), and review or CI feedback on PRs it owns. A shared module serves every host. Polling `gh` is the portable floor: cheap (one briefing is 2 GraphQL requests, about 1.1 s, for this repository on 2026-11-12) and needing no inbound webhook.
2. **Claude Code adapter.** An `async`, `asyncRewake` hook, registered on `SessionStart` (and re-armed on `Stop`), that:
   - takes a per-project, per-agent lock so only one waiter runs;
   - polls the detector every few minutes, within the hook's `timeout`;
   - exits 2 with a fixed notice such as `github-triage: new items for <agent>; run the triage tool.` when there is something new, and exits 0 silently otherwise;
   - advances its own checkpoint only after a successful notice, so offline time is caught up at the next start.
3. **The agent's response is ordinary triage.** It runs the triage tool, applies the claim rules, and claims nothing automatically. Notification content is evidence, not authority.

Optional later upgrades, each behind its own evidence:

- **Inbox socket**, once its message format is documented or verified. It would deliver the notice without the hook-timeout restriction.
- **A Channel**, once Channels leave research preview. It would deliver the event itself and allow replies.
- **MCP tasks**, which could let a long-running triage tool call report back when idle, through the MCP server proposed in #19 and #25.

### Operating concerns

- **Lifecycle:** the waiter lives only as long as the session. When the session closes, nothing runs and nothing is lost: the checkpoint catches up on the next `SessionStart`. A machine-wide daemon is not needed for the baseline.
- **Duplicates and bursts:** one pending wake covers everything new since the checkpoint, so later events coalesce into it. Rate-limit wakes per session, for example a few per hour, and treat turning wakes off or debouncing them as ordinary user settings.
- **The agent's own writes:** the filter must ignore events whose actor is this agent (its comments, pushes and labels). Otherwise every claim comment would wake the agent that wrote it.
- **Routing:** route by persistent agent name and default role, read from the project's identity record once #14 defines it. Ownership is decided by `agent:` labels, not by who received the notice.
- **Rate limits:** polling uses the user's `gh` quota. Keep the interval in minutes and stop on a rate-limit response, as the dependency migration rules already require.
- **Permissions:** hooks run with the user's permissions. The waiter must only read GitHub and must never post or label.
- **Fallback:** without the hook (Desktop or VS Code untested, Bedrock, Vertex or Foundry for preview features, or wakes turned off), the agent uses on-demand triage, plus `/loop` or `ScheduleWakeup` if the user wants periodic checks within a session.

### Fit for the two workflows

- **Implementer triage:** a good fit. Waking on new pickable work or on review and CI feedback for its own PRs is exactly what the "Choosing work" rule needs. One limit: auto-fix-style review delivery is documented only for cloud and Desktop sessions.
- **Designer and human catch-up:** waking is less useful here, because catch-up starts when the human returns. The same detector's change summary since the checkpoint is the deliverable; outbound `PushNotification` to the human is the relevant capability, not waking the model.

## Limits and unknowns

- Desktop, VS Code and cloud behaviour for `asyncRewake` is not documented. JetBrains is assumed to match the CLI because it runs the CLI in a terminal; that is an inference.
- `-p` sessions kill async hooks at teardown, so the adapter is for interactive sessions.
- The message format for the inbox socket is not documented.
- Whether a Monitor watch wakes an idle session is implied but not stated. Watches are capped at 30 minutes in any case.
- Some docs were first read through a summarizing fetch. Every statement quoted above was then checked against the raw Markdown pages.

## Verification plan for the implementation ticket

1. In a scratch repository, install the waiter hook in project settings, start an interactive session, let it go idle, create a matching issue, and record the time until a turn starts and the notice text.
2. Repeat with the agent's own comment, which must not wake it; with a burst of five issues, which must give one wake; with a session closed during the event, which must catch up on the next start; and with two Stop events, which must leave one waiter.
3. Record the Claude Code version, the elapsed times and the number of `gh` requests. Desktop and VS Code each get a separate pass, or are marked unsupported.

## Sources

Accessed 2026-11-12.

- https://code.claude.com/docs/en/hooks.md
- https://code.claude.com/docs/en/cross-session-messaging.md
- https://code.claude.com/docs/en/env-vars.md (`CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`)
- https://code.claude.com/docs/en/channels.md and https://code.claude.com/docs/en/channels-reference.md
- https://code.claude.com/docs/en/mcp.md
- https://code.claude.com/docs/en/scheduled-tasks.md
- https://code.claude.com/docs/en/routines.md
- https://code.claude.com/docs/en/tools-reference.md
- https://code.claude.com/docs/en/interactive-mode.md
- https://code.claude.com/docs/en/headless.md
- https://code.claude.com/docs/en/github-actions.md
- https://code.claude.com/docs/en/claude-code-on-the-web.md
- https://code.claude.com/docs/en/desktop.md
- https://code.claude.com/docs/en/remote-control.md
- This session: Claude Code 2.1.322 on macOS. `CLAUDE_CODE_MESSAGING_SOCKET` is set and points at a live Unix socket, confirming the inbox socket exists in an interactive CLI session.
