# Project identity: agreed direction and compatibility blocker

Scope: #3/#38, local setup/doctor #64, MCP #25. Persistent agent names are distinct from harnesses and sessions. Use explicit --agent NAME / --agent=NAME where supplied. Default triage view is triage_role; never reinterpret mailbox role="agent" as designer/implementer.

## Resolution contract

MCP: explicit project/tool selection, then a single applicable client workspace root, then a configured server project default. Never silently choose one of several projects or Ori daemon cwd. Resolve harness from explicit override or a registry of verified client names; Ori-prefixed names must be recognized before embedded names like codex. CLI: explicit agent, explicit harness/entry, then verified environment detection; inherited Ori markers must not override a more specific child harness signal. No arbitrary first/only-agent fallback when it would borrow identity. Unknown identity still permits unfocused reads with an explicit notice; mutations requiring identity refuse with exact selection guidance.

Inspect Agent Inbox’s implementation rather than copy an assumed schema. Reuse its project identity file in place without credentials exposure or destructive rewrite. If absent, planned setup generates a random human-like name once, persists it, records triage_role and establishes Git exclusion; repeat setup preserves identity. Global CLI installation does not mean global agent identity. No service connection is required for local lookup.

For Ori, each separately configured MCP server entry gets a distinct persistent name, reused across restarts. A process/session ID is not that name. Full server-entry identity must be explicitly available or unresolved; never claim the same-harness case is solved by harness metadata alone. Multiple designers coordinate; no automatically elected leader. Explicit --role affects one presentation, not stored identity.

## Actual source inspection: do not mark writes ready

Inspected sibling Agent Inbox commit `8c74488f8db2590902c81bb72c5ab68ffb830820` on 2026-11-13. In src/agent_inbox/client.py, write_project merges settings but _render_project explicitly emits only name, role, token and wake. write_config reconstructs an entry. Therefore the current writer can **drop triage_role**; arbitrary unknown-key preservation is not established. Do not promise safe shared-file writing or auto-repair until compatible preservation is implemented/verified upstream. No Agent Inbox changes are part of this PR.

In mcp_client.py, engine_for_client recognizes exact ori plus substring rules for other engines; this inspected revision does not establish the ori-SERVER prefix behavior reported in #38. Treat actual supported client signals as tested evidence and provide explicit overrides. The current writer also emits engine table keys directly; safe quoted per-server keys and distinct-entry lookup require verified interoperability before triage setup writes them.

Next design/engineering action: produce compatibility fixtures that round-trip triage_role, existing credentials/unknown keys and distinct Ori entries through both tools’ writers; coordinate the fix in Agent Inbox before enabling shared writes. Until then explicit --agent supports useful triage; doctor reports the limitation. This is an engineering compatibility blocker, not an unanswered owner preference. SDK-specific tool schemas and client smoke tests remain #25’s focused MCP contract.
