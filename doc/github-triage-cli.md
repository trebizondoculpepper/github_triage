> Extracted from poker_blocks on 2026-11-12. Issue numbers in this inherited design refer to that repository; see [the handoff](../HANDOFF.md) for new issue numbers. Source paths `scripts/triage/` now mean `src/`. Target features may still be pending.

# Read-only GitHub action briefing CLI (#626)

## Current design handoff

[Consolidated owner decisions](design/README.md) define proposed briefings, ranking, identity, handoff, diagnostics and update checks. Those focused contracts supersede conflicting historical proposals below for their stated scope; they do not claim implementation or adopt all proposed process policies.

## Purpose and ownership

`npm run triage` gives an LLM a single current briefing for this repository: suggested next actions, evidence, ready/unclaimed work, active owners, design/question/blocker context, PR checks/review findings, label inconsistencies and known dependency states. `--json` produces the same versioned structured information; `--issue N` includes the full issue body/comments and linked PR information for intake. This is a plain JavaScript ES-module CLI under `scripts/triage/`, launched as `node scripts/triage/cli.js` by npm and never imported into production. It needs no TypeScript loader, build step or GitHub SDK. The user explicitly authorized implementation after this design merges. (Historical: the source has since moved to TypeScript under `src/`, run in development via `tsx` and shipped as the built `dist/cli.mjs`; see [the TypeScript contract](design/typescript.md), #91.)

The collector invokes the authenticated `gh api graphql` via argument arrays, without a shell. It does not handle/read/print tokens, request new credentials or send content to an LLM service. All GitHub operations are queries. No claim, comment, label edit, issue creation, review submission or merge occurs. This tool recommends inspection/action; it is not authority to bypass process, documentation-first or review requirements.

## Evidence and initial scope

Existing `doc/process.md` defines readiness labels, `agent:` ownership, dependencies and review/merge requirements. #626 records the owner's one-shot intake/triage request. Manual `gh issue list/view` and `gh pr list/checks` currently require many separate calls and interpretation. There is no repository triage utility at the source audit `3be61a8`.

A live GraphQL probe on 2026-11-12 confirmed repository issue/comment/label connections, issue `stateReason`, PR closing references, review threads, mergeability/review decision and head-commit status-check rollup/context fields. Reuse these factual API fields and paginate connections; no GitHub SDK or third-party summarization dependency is necessary. Stable registered analysis rules express workflow policy separately from retrieval/formatting, consistent with the project's no-special-cases rule.

The first implementation is one coherent read-only collector/action briefing, not an autonomous agent. Other human workflows or tracker integrations can follow separately. Deterministic hints never claim to reliably resolve natural-language questions or establish design approval.

## Inputs and commands

- `npm run triage` refreshes open issues and PRs and prints a compact text briefing, highest-priority suggested actions first. Repository defaults to `gh repo view` for the checkout; `--repo owner/name` overrides it.
- `--json` emits schema-versioned JSON without progress/debug noise on stdout. Use `npm run --silent triage -- --json` to suppress npm’s own command banner.
- `--issue N` additionally fetches that issue even when closed and includes unabridged body/comments plus related open PR evidence; it never automatically claims it.
- `--since <ISO timestamp>` includes changed issues and PRs (including closed/merged) since that time. Without it, the briefing describes current state, not an invented “since yesterday”.
- `--checkpoint <path>` compares with the last successful checkpoint time and advances it only after a complete successful live report is produced. A missing checkpoint establishes a baseline explicitly; it is not a claim to have observed all history. Supplied `--since` is explicit and takes precedence.
- `--cache <path>` writes the successful fetched snapshot atomically. `--offline` requires an explicit cache path and labels its original fetch time/age and missing live verification. Never silently fall back to stale cache on an API error. Checkpoints do not advance from an offline or incomplete result.
- `--limit N` bounds displayed/listed actions per section (default 10); output includes total/omitted counts and stable issue/PR URLs. Full raw history is available through `--issue`, not silently guessed from a truncated summary. `--help` documents flags and exit behavior.

Default text should fit a useful intake response rather than dump every comment. JSON includes compact issue/PR context (body/latest-comment excerpts, source URLs, owners, labels, timestamps, docs links, dependency and PR relations), actions and warnings. Detail mode includes full issue history. Text truncation is marked; structured output names omitted context and a detail command. No critical action disappears without an omitted-count indicator. Raw snapshot caching is separate from this compact presentation schema.

## Collection and freshness

Capture repository, request start/fetch time and source endpoints; describe the fetch as a window, not an atomic GitHub snapshot. Fetch every page of open issues/PRs and their comments. Page nested labels, review threads, head checks and closing references or report explicit completeness warnings; unknown is never clean/passing. Review-thread comments may be represented by their linked first comment plus omitted count, but the thread's resolved/outdated state must be preserved. Query failure, permission failure or rate-limit exhaustion is a nonzero exit with a concise diagnostic; no empty-success result. Available rate-limit metadata belongs in JSON. Errors must not echo an environment/token or arbitrary request secrets.

For `--since`/checkpoints, fetch updated issue/PR connections in descending update order across all states until the cutoff; this includes closed/merged work, not just still-open items. An update timestamp indicates the object changed, not which label/comment changed. Report exact relabel/answer history only if actually observed; the initial version reports updated/current facts with evidence. Use server-provided cursors and never assume page order from issue number. Fixed text clipping is not evidence of an unanswered question.

**Superseded for readiness by [Issue dependencies](issue-dependencies.md) (#703):** native blocked-by relationships now decide readiness, and the body-text rules below apply only to migration and drift reporting. Dependencies come from an explicit `Depends on #N` or cross-repository URL list in the issue body, not every issue reference. Support bullet lists in a clearly marked dependencies section. Resolve referenced issue/PR states, deduplicate lookups, preserve cross-repository scope and distinguish CLOSED/COMPLETED, CLOSED/NOT_PLANNED and MERGED PRs. An optional prerequisite, prose mention or linked epic is not automatically a blocker. Human-written ambiguity remains a warning. All declared blockers closed is a **candidate to verify**, not proof the required behavior was implemented or the architecture merged.

## Workflow analysis and next actions

Use a registry of named rule handlers over normalized facts and a declarative workflow policy (readiness labels, owner prefix and expected CI check names). The generic runner invokes handlers uniformly; do not add issue-number special cases, a table keyed by object identity, or a giant branch chain on status labels. Identity handles only locate evidence/relations. Each action has rule ID, priority, target URL, concise reason, suggested next step and evidence URLs. Multiple true findings remain visible; a blanket “merge” verdict never replaces failed or unknown checks.

Initial rules cover:

- open PRs with failed/pending/absent checks, conflicts/out-of-date state, review changes requested or unresolved review threads; clean/current verified PRs become **inspect and consider merge** candidates, never auto-merges;
- ready unclaimed issues, active claims and multiple-owner conflicts;
- unclaimed issues with missing/multiple readiness labels, and ready labels left on claimed work;
- blocked issues whose explicit prerequisites appear satisfied, or whose blocker explanation is absent; parked work remains deliberately parked, not pickup advice;
- needs-design/question/human-review labels and **candidate** question/review comments, including later reply context so a question mark is never declared unanswered just by regex;
- issue scope/dependency/documentation links for intake. Missing extracted docs links means “not found in this text”, not “architecture missing”.

The registry may emit heuristic findings only with an explicit uncertainty label. Semantic reconciliation of historical versus superseding answers remains the consuming LLM's job, with full linked history available. No special casing of named agents; an optional current-agent filter can compare supplied ownership configuration uniformly. CI conclusions and check names are interpreted through registered policy; CodeRabbit/Codex advisory findings still need inspection as described in process, and required `verify` cannot be inferred from some unrelated green job.

## Verification and rollout

First merge this document and the canonical architecture/process pointers, then implement in a separate PR. Tests must cover primary and nested pagination/completeness, declared versus incidental dependencies, cross-repository references, closed-unplanned versus merged status, missing/failed/pending head checks, unresolved threads, competing owners/readiness contradictions, question candidates with later replies, deterministic ordering, cache repo/schema mismatch/offline age, checkpoint failure safety and unknown/error reporting. Use injected gh query/clock/filesystem boundaries; tests must not need a GitHub credential. Run a real read-only report against this repository and inspect its suggested actions and full-ticket mode before delivery. No gameplay changes or generation keys are involved.

## Running the implementation

```sh
npm run triage
npm run --silent triage -- --json
npm run --silent triage -- --issue 677 --json
npm run triage -- --checkpoint /tmp/poker-triage-checkpoint.json --cache /tmp/poker-triage-cache.json
npm run triage -- --offline --cache /tmp/poker-triage-cache.json
```

Requires Node 26+ (the current LTS) and an already authenticated `gh`. All API requests run through that existing gh installation/session, including its existing host/account credential handling; the CLI never calls `gh auth login`, reads a token itself or asks the user to reauthenticate. The cache contains repository issue/comment data; keep it outside git. Offline mode always uses its recorded timestamp, does not poll GitHub or advance a checkpoint, and cannot be combined with `--since`. Primary issues/PRs and comment history are paginated fully; unusually large nested PR/label connections are explicitly incomplete with exit 2 rather than silently certified for merge. Review thread previews retain total/omitted comment metadata. No background daemon is installed: invoke the command whenever the agent needs a new briefing, or use an external caller to poll it.

## Development-process use and feedback

[One-command GitHub briefing in the process guide](poker-blocks-process.md#one-command-github-briefing-626) is the operating workflow: session orientation, full-ticket intake, live ownership/head recheck, checkpoint polling, explicit offline/error handling and evidence-backed improvements. Start there when using the tool to decide an agent's next action. The CLI contract describes available facts and limitations; the process guide explains how to act on them.

## Compact briefing refinement (#698)

**Target change, based on live use.** The 2026-11-12 run recorded on #692 took 12.8 seconds, produced about 113 KB JSON / 22 KB text at limit10, elevated parked #616 through its question label, and showed #555's superseded comment beside a newer edited body. These are observed workflow problems, not a request for speculative automation or natural-language certainty. A live GraphQL probe confirmed `lastEditedAt` plus comment created/updated timestamps for chronology.

The default `npm run triage` becomes a concise project briefing, with **schemaVersion 2** compact JSON under `--json`. Preserve the expanded schemaVersion-1 view behind explicit `--full`; raw cache/checkpoint schemas remain compatible. `--issue N` still supplies the requested complete issue history rather than silently truncating that intake. No GitHub mutation or external LLM is introduced.

The compact view has a project count summary, prioritized deduplicated next steps, small grouped sections (review, available/current work, decisions, dependency candidates and label hygiene), current PR/check state, and a separate deferred/parked list. A subject's scope, ownership and source context appears once, with sections referring to its URL rather than duplicating full body/comments/reviews. Count findings separately from distinct tickets. Default limit is five next steps, with up to three entries per group and explicit total/omitted counts and drill-down commands. Text defaults to a 10,000-character budget (`--max-chars` overrides); trim whole rows/sections with an omission notice, never cut a command/link or claim there are no more findings. Full/detail views intentionally remain explicit expanded intake. Compact JSON is bounded by those section/context limits, not silently clipped into invalid JSON.

Use registered rule metadata to separate recommendations from background context and hygiene. Parked work may show ownership/label inconsistencies but must not generate active question, prerequisite-ready or pickup advice just because an old question label/comment exists. Raw question-mark candidates remain in inspection context, not asserted unresolved decisions. Group findings per target so one issue does not occupy every next-action slot. Hygiene stays visible separately from work selection.

`--agent <agent-name>` optionally focuses pickup/continuation recommendations on that configured owner label. Show current owned work before suggesting another claim; do not suggest taking another agent's ticket. PR review remains available with owner/linked-ticket evidence and the instruction to coordinate before changing someone else's branch. No named agent is special-cased, and no agent identity is guessed from the shared GitHub login.

Source context records the current body edit timestamp (GitHub `lastEditedAt`, or creation time when never edited) and latest comment timestamps independently. If the body was edited after the latest comment, warn that the older comment may be superseded; do not present it as the “latest decision”. If the comment is newer, that still does not prove it supersedes the body. Show short excerpts and URLs plus an explicit instruction to reconcile both; missing timestamps mean unknown chronology. Full intake retains both. This is a deterministic chronology cue, not semantic contradiction detection or a claim that every edit changes a decision.

Bound independent comment/dependency requests to four concurrent gh queries, preserving deterministic output ordering and fail-closed completeness/checkpoint behavior. Report request count and collection duration when available; older cached snapshots may lack those metrics. Do not cache known-closed prerequisites forever or skip fresh evidence to make a timing claim.

Verification uses the #692 examples as generic fixtures (never hard-coded issue rules), output-size/omission and deduplication tests, parked-plus-question exclusion, chronology with missing/edited timestamps, agent claim conflicts/focus, bounded request concurrency/error behavior and expanded/detail compatibility. Run real current status, full ticket, checkpoint and offline modes, compare output size and collection time with the recorded baseline, and inspect that useful review/work/blocker evidence remains. The owner assigned this improvement to the CLI's owner; the implementation proceeds in #692 after these docs merge rather than handing it back to another agent.

## Issue dependencies (#703)

Ticket dependencies are GitHub's built-in "blocked by" relationships, and readiness comes from GitHub's computed Blocked state, not from `Depends on` text. [Issue dependencies](issue-dependencies.md) defines the `deps` commands, the briefing changes, the one-time migration, and the rules shared by commands that change tickets. Those commands are the first exception to this tool being read-only. The briefing itself stays read-only.

## Submit (#190)

`github-triage submit N --agent NAME [--pr URL...] [--target owner/name:branch] [--membership open] [--dry-run] [--json]` implements the `submit` transition of the [delivery lifecycle](design/delivery-lifecycle.md#transitions-and-commands). It reads the issue, its full comment history and each named PR live, then writes one `github-triage:delivery v1` record (`op: "submit"`, membership `complete` unless `--membership open`, the caller as `responsible`, and the label plan) before removing only the caller's `agent:NAME` and adding `status:awaiting-review`. The caller becomes ticket-responsible and stays responsible for the submitted PRs after the claim is released; responsibility is not a claim and never counts against the one-active-claim rule.

Preconditions are checked on fresh reads: the caller holds the claim (`NOT_CLAIMED`), the issue is open (`TICKET_CLOSED`), the authenticated account and every delivery record pass the authority rule (`MARKER_UNVERIFIED`, `RECORD_MALFORMED`, `RECORD_UNSUPPORTED`, `EVIDENCE_INCOMPLETE` for a truncated history), every PR is readable (`EVIDENCE_INCOMPLETE`), open or merged (`PR_CLOSED_UNMERGED`) and targets the intended repository and branch (`TARGET_MISMATCH` unless `--target` states it). `--pr` may be omitted only to finish a rework claim whose `membership open` record (reason `rework claim`) was written by the caller as ticket-responsible agent; the record then resubmits the current required set and closes membership (`SUBMIT_NEEDS_PR` otherwise).

A retry of the same command finds the posted record by its operation identity and never posts a second one. While the caller's claim label remains it completes the recorded label plan, after re-checking that the issue is open; if a later delivery record intervened it refuses `DELIVERY_DIVERGED`. Once the claim label is gone the plan is complete, and labels changed by others afterwards are never restored. Each write is preceded by a fresh read and re-plan, and the result lists every step as done or failed with exit `0`, `2` (partly done, conflict or unverified) or `1` (refused). `release --as done --pr` keeps working for one deprecation period, as the contract's source-compatibility table requires: it still writes a release record only, never a delivery record, and now adds a note naming the equivalent `submit` command. No other `release` path changes.

## Rework authority (#190)

`claim N --rework --agent NAME` follows [Rework authority](design/delivery-lifecycle.md#rework-authority). While the issue has no trusted delivery record, the existing v1 rule applies unchanged (the caller's own `done` handoff as the latest release, `status:awaiting-review` and an open PR). Once any trusted delivery record exists, only the ticket-responsible agent on the trusted fold may claim rework, whether it submitted, received a ticket handoff or was reassigned. No open PR is needed, `status:awaiting-review` is removed if present, and a v1 handoff never authorises again (`NOT_RESPONSIBLE`, with handoff, reassign and reset recoveries). An unverifiable, malformed, unsupported or truncated record history refuses `MARKER_UNVERIFIED` and never falls back to the v1 rule. A closed issue is refused `TICKET_CLOSED`. All other claim checks are unchanged. After the claim, one delivery record `membership open` (reason `rework claim`) is posted, so the ticket reads as submitted rather than delivered and `complete` stays refused. A retry of the same claim posts that record if it is missing and never posts it twice. The claimant finishes with `submit`, with new `--pr` or none to resubmit the current set. Authority is re-evaluated on every attempt.
