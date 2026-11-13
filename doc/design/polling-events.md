# Optional polling and domain events

Contract for #32, after baseline MCP #25. TypeScript implementation only. This document does not start a watcher. Detection is independent of notification/wake-up delivery; shared daemon, SQLite and web UI #42 remain deferred.

## Enablement and lifecycle

Disabled by default. Opt in for one resolved repository when launching `github-triage-mcp --poll --repo owner/repo`; `--poll-interval-minutes N` defaults to **30**, accepts positive integers with a minimum of 1 minute, and requires polling enabled. These are planned MCP-server startup options, not ordinary CLI flags. An explicit unambiguous configured project may supply the repo; do not watch every root or every repository a tool call happens to inspect.

Start the first bounded collection after initialization and target resolution. The first complete observation establishes a baseline and emits no historical change events. Status explains this baseline rule. Subsequent polls compare against the last complete successful observation. Failed/incomplete observations do not replace it or create synthetic disappearances/resolutions. On process restart establish a new baseline; do not pretend to know what happened while offline.

Only this MCP process owns the timer. Disconnect/EOF/shutdown stops scheduling and cancels or bounds outstanding collection. No detached process, install hook, webhook, service deployment or post-exit promise. Disable by restarting without `--poll`; status is inspectable, not a hidden configuration mutation. No project configuration file dependency is required in this first slice.

One in-flight collector per watched repository. Coalesce simultaneous compatible reads and polls through the shared service where completeness requirements match; never downgrade a fresh read to an undisclosed old polling cache. Schedule the next ordinary poll after completion, avoid overlap, and bound subprocess duration/concurrency. Multiple server processes can still duplicate polling; measure that cost rather than solve #42 prematurely.

Honor GitHub rate-limit/reset evidence and bounded exponential backoff with jitter on failures. Do not retry before a server-specified retry/reset time; retain the last successful baseline and expose delayed/stale status. A backoff expiration is permission to retry collection, not evidence the project is unchanged. Read-only polling never resets claim inactivity.

## Initial deterministic event set

Use normalized facts and registered workflow rules, not an LLM or comment-text interpretation each cycle.

| Kind                 | Trigger relative to complete baseline                                                       | Qualification                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| attention-requested  | New explicit attention destination on a subject                                             | Addressed name is destination, not owner/reservation                                                        |
| review-feedback      | Newly observed review finding/thread or changes-requested review ID                         | Review evidence link and reviewed/current SHA; not “substantive” guessed from arbitrary prose               |
| verification-problem | Current-head check enters failure/cancelled/unknown verification, or conflicts become known | Keep failing, cancelled/incomplete and pending distinct; unchanged pending checks are not repeated failures |
| pr-follow-up-ready   | Shared policy transitions an open PR into verified review/merge consideration               | Evidence is a candidate for inspection, never merge approval                                                |
| work-became-eligible | Previously known ineligible work becomes eligible under the implemented shared policy       | Complete readiness/platform/native blocker evidence; last-blocker transition cannot infer missing facts     |

If an underlying policy is not implemented, omit that event detector and declare the unsupported capability. Do not simulate future ranking or question semantics in a second ad hoc implementation. Clearing a label or adding an answer comment alone does not prove a question resolved. A verified eligible transition can represent work progressing without claiming semantic certainty about an answer.

Each event has its own supporting fact identity. Suppress repeated unchanged evidence across polls, not distinct reviewer findings on the same PR. A new PR head invalidates prior current-head readiness even if the PR remains open. A failed fetch cannot manufacture an eligible transition. Include first-seen evidence observed after baseline even if GitHub's event timestamp predates the polling instant; distinguish event time from observation time.

## Event schema and relevance

Use a versioned domain record: `schemaVersion`, stable opaque `eventId`, repository, subject number/kind/URL, event kind, observation time, optional source event time, evidence URLs/IDs, current/reviewed SHA where relevant, concise factual reason, destination names, optional confidently known origin, and explicit completeness/uncertainty. Events contain no credentials or unbounded issue/comment bodies.

Derive deduplication identity from repository + subject + event kind + relevant fact version/transition generation. Do not hash timestamps from every poll into a new event. Changed evidence produces a new identity; repeated reads do not. Preserve two separate occurrences of a state transition that genuinely cleared and recurred. Use numeric IDs/normalized facts, not title wording, as stable anchors.

Routing uses persistent agent names, separate from harness/session IDs and shared GitHub login. Multiple destinations remain valid. Unknown origin stays unknown; never drop an event merely because the same GitHub account authored it. Suppress a known originating agent's own mechanical updates only when reliable operation identity establishes an exact echo; preserve later reviewer feedback and other destinations. Events do not clear attention, claim, release, close or merge anything.

## Bounded queue and on-demand access

Keep a process-local ring of at most 1,000 domain events and 24 hours of history for the watched repo; prune by both bounds. No SQLite or persistent per-agent mailbox. A cursor contains an opaque process-generation and sequence. Restart, expired/evicted cursor or unknown generation returns `resetRequired: true`, with fresh briefing/explicit-since guidance. Never silently skip a gap and report a complete catch-up.

Add one read-only tool in this follow-up: `triage_events`, with optional opaque `cursor` and integer `limit` 1–100 (default 20). It reads the configured watched repository; no per-call arbitrary watch target. Results include version, repository, watcher status, baseline/last-attempt/last-success/next-due times, backoff/collection completeness, event items, next cursor, omissions/gap status and supported detector kinds. Reuse the MCP envelope/error conventions with kind events. Reading is nondestructive: consumers maintain independent cursors, so one agent cannot consume another's events. Polling disabled returns an explicit disabled status and ordinary briefing guidance.

Also publish typed in-process events to future delivery adapters, which may coalesce a burst into one notice. No custom MCP notification, changed-tools-list signal or generic resource update is presented as a model wake-up. A host adapter can later use verified platform delivery and acknowledge observation. Queue access, delivery receipt and actual agent action are different facts. If no adapter exists, event history remains available on demand while the process lives.

A disconnected/restarted agent can use ordinary `triage_briefing(since=...)` for material change evidence. No baseline means no invented “since last visit” history. A complete GitHub catch-up may recover facts but must not claim to reconstruct every transient review/check transition missed offline.

## Acceptance and sequencing

Implement after the merged contract and baseline MCP, without waiting for all host adapters. Use injected clock, GitHub, operation-origin and process-local storage boundaries. Test disabled/default interval/invalid values; first baseline; unchanged snapshot; each detector; incomplete fetch; errors/rate-limit/backoff; overlap/concurrent read; restart; eviction/gap; independent cursors; duplicate/burst evidence; own-write echo versus reviewer feedback; missing identity; cancellation/exit. No live watcher, LLM calls or GitHub writes are needed for tests.

Verify event-read schema and stdout framing with a real SDK client. Measure request count, memory bounds and a single fake-clock poll sequence. Prove no polling occurs before opt-in or after shutdown. Document the per-process duplicate-polling limitation and loss of history after exit. Then #32 is ready as a focused implementation; #26–#29 delivery and #42 shared backend stay separate.
