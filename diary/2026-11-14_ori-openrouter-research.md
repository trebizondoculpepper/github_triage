# Development Diary Entry - 2026-11-14

## Context

- **Date**: 2026-11-14 UTC
- **Branch**: issue-24-ori-openrouter
- **Contributors**: Ori Code (vijay_larionova) + owner

## Problem Statement

Issue #24: research Ori / OpenRouter libraries, notifications and adapters for synthesis #20. Only an agent running in Ori may do it.

## Our Approach

About an hour of research, run from inside Ori Code. Sources: `--help` text, bundled skills and docs, strings from the installed binary for the daemon routes, `npm view`, and the Ori Harness guide. Two bounded live probes on a disposable headless session: `--resume`, and `POST /api/steering/send` in `queue` mode. The MCP results come from #255.

## Outcomes

- `--resume` continues a session.
- `steering/send` to an idle session hung, with nothing queued.
- Schedules, webhooks and workflows all start new runs.
- There is no Ori SDK or ACP; the OpenRouter SDKs build new agent loops.

Recommended adapter: an opt-in Ori schedule feature over the shared events service that starts a new headless run, never injecting into a user session.

## Next Steps

Three follow-ups proposed in the report, not filed: an idle-steering test in an attended session, a read-only schedule prototype, and upstream asks.
