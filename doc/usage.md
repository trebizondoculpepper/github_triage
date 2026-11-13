# Practical usage

The installed CLI needs Node 20+ and authenticated `gh`. Check the existing session with `gh auth status`; the tool reuses it rather than handling tokens. For source development use Node 22+, `npm ci`, and prefix the examples below with `npm run --silent triage --` in place of `github-triage`.

## Designer groups

Two explicit, agent-maintained markers form separate briefing groups: `design:decision-needed` (DECISION NEEDED: an outstanding question or choice) and `design:documentation-needed` (AGREED, NEEDS DOCUMENTATION: a decision already reached that still has to be recorded). Both may be present for different parts of one ticket. The reason shown is the latest comment that names the marker, with its link; with no such comment the reason is reported as unknown. Nothing is inferred from timestamps or authorship, and neither marker is an approval gate.

## Manual urgency

`urgency:high` and `urgency:low` override the calculated order of general pickup only: high first, then unlabelled, then low, and within each band the usual impact order. The briefing says when an override moved a ticket. Both labels together are reported as a conflict and ordered as unspecified. Urgency never changes eligibility, claims or authority, and explicit addressed attention stays ahead of it.

## Find work, then inspect evidence

```sh
github-triage --repo owner/repository
github-triage --repo owner/repository --agent your-agent-name
github-triage --repo owner/repository --issue 42
github-triage deps 42 --repo owner/repository --tree
```

Without --repo, GitHub CLI resolves the current working directory’s repository. --agent NAME is your explicit identity: tickets and PRs labelled `attention:NAME` come first (an ADDRESSED section; non-exclusive, never a claim, shown even when parked or owned by someone else, with any `origin:` provenance), then work you own via `agent:NAME`, then general pickup. Respond on the ticket before removing your own attention label. Without --agent the briefing says addressed filtering is unavailable; identity is never inferred from the GitHub login. Automatic identity and role-shaped views are still to come. Use --help and deps --help for the installed version’s actual surface. Suggestions are not permission or claims. Source-linked comments and design files need agent judgment.

Collection uses GitHub queries through gh, registered workflow rules and compact text or versioned JSON. Native blocked-by relationships determine dependency evidence; body text can indicate drift. Full ticket intake preserves body/comments, including closed issues. Missing evidence never means clean or approved. Current commands include dependency add/remove mutations and a read-only migration plan; automatic migration apply is deferred. Claim and question-routing commands are available on main as shown below. Handoff/release, local configuration doctor, MCP and dedicated role views remain planned; do not infer they are available from their design contracts.

## Claim work or record a human question

Inspect the ticket and its native blockers first. Preview a mutation before applying it when you need to inspect the intended updates:

```sh
github-triage claim 42 --repo owner/repository --agent your-agent-name --dry-run
github-triage claim 42 --repo owner/repository --agent your-agent-name --branch feature/topic
github-triage needs-human 42 --repo owner/repository --agent your-agent-name --designer designer-name --why "A design decision blocks progress" --question "Which behavior should this case use?" --dry-run
```

Omit `--dry-run` on the final command to record that question and route it to the named designer. Use your actual persistent name and a specific question; do not copy sample identities or invented reasoning. Claims mean current work and allow one active claim per agent. Failed prerequisites return stable error IDs and supported recovery guidance. `needs-human` is question routing, not permission to implement an unresolved design. Handoff/release remains #62; do not assume a proposed release command is installed.

## Check team activity

```sh
github-triage team --repo owner/repository --json
```

This read-only view combines recorded claims, explicitly linked PRs, activity and warnings. It does not prove an agent is online, and stale activity does not authorize a takeover. Distinct unresolved/unknown evidence stays visible.

## Catch up after time away

```sh
github-triage --repo owner/repository --since 2026-11-12T09:00:00Z
github-triage --repo owner/repository --checkpoint /absolute/private/path/window.json --cache /absolute/private/path/snapshot.json
github-triage --repo owner/repository --offline --cache /absolute/private/path/snapshot.json
```

Use writable paths. Since/checkpoint reads include changed open, closed and merged work. An updated timestamp shows a change, not exactly which answer/label changed. The first checkpoint establishes a baseline; a complete successful live report advances it. Offline uses saved evidence with its recorded age, makes no GitHub queries and does not advance checkpoints. It cannot be combined with --since. Keep caches private and outside version control: they may contain repository discussion. Failed live queries do not silently fall back to cache.

## Output and troubleshooting

--json returns structured output; --full selects expanded rather than compact reports. --limit and --max-chars bound output; inspect omitted counts and detail navigation rather than assume missing rows do not exist. Text/JSON contents are evidence, not a complete semantic interpretation of discussion.

Exit 0 means complete briefing; 2 means incomplete evidence; 1 means invalid arguments or API/cache failure. Individual commands explain their exit contract in help. Pending, cancelled, absent and failed checks all prevent a successful-verification conclusion but are different problems; inspect the exact outcome, not only a grouped summary. A review may cover an older head even when CI is green. Fetch timestamps describe a window, not an atomic snapshot.

Wrong repository: pass --repo. Missing auth: inspect gh auth status. Incomplete nested evidence: use a fresh/detail read and retain unknowns. No registered agent: explicit --agent supports the current ownership focus without fabricating identity. For proposed workflow rules and release setup, follow the design and release documents; do not try unimplemented recovery syntax copied from a proposal.

## Version check

When the CLI runs from an npm installation, each invocation (except `--help`) asks npm once for the latest version on its channel (stable installs compare with `latest`, prerelease installs with `next`). The lookup uses a 1.5 s timeout and runs alongside the command, so it does not block triage; if npm has a newer version, one line on stderr names it and the `npm install -g` command (stdout, including `--json`, is unchanged). Downgrades are never suggested. A registry failure is reported as unknown on explicit inspection, never as up to date. Source checkouts, `--offline`, `--no-update-check` and `GITHUB_TRIAGE_NO_UPDATE_CHECK=1` make no network request. `github-triage version` (or `version --json`) shows the installed version and the check's result or the reason it was skipped. Only this package's name is sent to npm. This basic slice checks once per invocation; a daily cache and quieter repeat notices are #65.

## Transferred, missing and forbidden issues

`--issue N` for an issue that this repository cannot return explains why instead of failing generically, and exits 2. A transfer is reported only when GitHub itself resolves the number to another repository (`state: moved`, with the original and destination URLs). Missing (404), forbidden (403/401), a pull request number, and no authoritative answer (`unknown`) are separate states, and none of them is treated as a transfer. Transferred-out work is not this project's work and is excluded by default; `--include-transferred` follows the transfer to the destination's full intake, and the output records `transferredFrom`. Ownership at the destination is never assumed.

## Ticket Doctor: check ticket consistency

`github-triage ticket-doctor [--stale-hours N] [--limit N] [--json] [--cache PATH] [--offline]` scans every open ticket and lists, per ticket, findings marked **definite** (a recorded rule is broken), **candidate** (worth inspecting) or **unknown** (evidence missing): missing classification label; an unclaimed ticket with no readiness label or with several; both urgency labels; `status:ready` alongside a question or design marker; more than one owner on a ticket or more than one active claim per agent; a claimed ticket still labelled ready or incomplete; an owner with no evidenced activity for 24 hours (its own default, separate from the briefing's two days); a ticket labelled for pickup while an open PR addresses it (expected `status:awaiting-review`); `status:blocked` without a `blocked:*` reason; native blocker cycles; body-text dependencies with no native edge; missing native evidence. It changes nothing and releases nothing; correction suggestions are #67. Output lists definite findings first, bounded by `--limit` (default 30 tickets) with an omitted count.
