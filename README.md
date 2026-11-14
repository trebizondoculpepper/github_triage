# GitHub Triage

GitHub Triage turns GitHub issues, pull requests, review feedback and dependencies into a compact, evidence-linked action briefing. It helps coding agents and maintainers answer **“What should I do next to move this repository forward?”** without manually piecing together dozens of GitHub searches.

## Why use it?

Finding work is more than listing open issues. A ready-looking ticket might still be blocked; a completed contribution might need another review fix; an old claim might need inspection. Repeatedly reconstructing that context wastes time and agent tokens, and makes important follow-ups easy to miss.

GitHub Triage collects the facts and applies explicit workflow rules so you can:

- Surface attention requests, PR follow-ups and active work before starting something new.
- Find eligible work and see which tickets would immediately unblock other work.
- Inspect a ticket, a dependency chain or a stalled PR in one operation.
- Catch inconsistent ticket state and see the evidence behind each finding.
- Get compact text for an agent or versioned JSON for other tools.

The same rules produce repeatable recommendations. Source links, freshness and missing-evidence notices let you check those recommendations rather than trust an unexplained score.

## Install

Install once globally and use the command across repositories. It does not need a separate npm installation in every project.

Requirements: **Node.js 26+**, npm and the [GitHub CLI](https://cli.github.com/). GitHub Triage reuses your authenticated `gh` session; it does not require a separate token store or hosted service.

```sh
npm install -g @trebizondoculpepper/github-triage

# Sign in if you have not already authenticated GitHub CLI.
gh auth login
gh auth status

github-triage --help
```

Run `github-triage` inside a repository checkout, or pass `--repo owner/repository` explicitly. Update the global installation with the same `npm install -g` command. Add `@next` to the package name only when you want a development prerelease.

This README describes the current repository version. Published releases may lag behind it; use your installed command's `--help` to confirm which features are available.

## Examples

### Find the next useful action

```sh
github-triage --repo owner/repository
```

The briefing groups attention, PR follow-up, active work and eligible pickup. General pickup defaults to urgency and immediate-unlock impact; explicit age ordering is available for backlog cleanup:

```sh
github-triage --repo owner/repository --agent your-agent-name
github-triage --repo owner/repository --order oldest
```

`--agent` is an explicit workflow identity, not your GitHub login. It highlights attention addressed to that name and recorded ownership; it does not authenticate an agent or claim work.

### Inspect a ticket or a blocked PR

```sh
# Full ticket intake, including discussion and dependency evidence.
github-triage --repo owner/repository --issue 42

# Native upstream/downstream dependency tree.
github-triage deps 42 --repo owner/repository --tree

# Checks, review findings, conflicts and other PR blockers together.
github-triage pr 17 --repo owner/repository
```

### Catch up and check repository health

```sh
github-triage briefing --repo owner/repository --last 24h
github-triage briefing --repo owner/repository --checkpoint ~/.config/github-triage/owner-repository.json
github-triage --repo owner/repository --since 2026-11-01T09:00:00Z
github-triage ticket-doctor --repo owner/repository
github-triage team --repo owner/repository
```

`briefing` reports owner attention, completed and disposed work, progress, blockers and current activity for a window (`--last`, `--since` or `--checkpoint`, default 24 hours). A checkpoint advances only after a complete live report is delivered; `--offline --cache PATH` replays a saved window and never advances one. Ticket Doctor reports inconsistencies without repairing them. Team activity reflects recorded claims and recent evidence; it does not prove an agent is online.

### Use structured output

```sh
github-triage --repo owner/repository --json
```

Reports include completeness and collection timestamps. For briefing commands, exit `0` means complete evidence, `2` means incomplete evidence, and `1` means invalid arguments or an operation failure. Incomplete evidence never means approval or “nothing to do.”

### Preview a workflow update

```sh
github-triage claim 42 --repo owner/repository \
  --agent your-agent-name --dry-run
```

### Hand over finished work

```sh
github-triage submit 42 --repo owner/repository \
  --agent your-agent-name --pr https://github.com/owner/repository/pull/17 --dry-run
github-triage complete 42 --repo owner/repository --agent your-agent-name --dry-run
```

`submit` records the pull requests the issue requires, then releases only your claim and sets `status:awaiting-review`; you stay responsible for following up on those PRs without holding a claim. `complete` later verifies delivery from fresh evidence before closing the issue.

Briefings and diagnostic commands are read-only. Explicit commands such as `claim`, `submit`, `complete`, `needs-human` and `deps add/remove` change GitHub; inspect their help and dry-run output before applying changes. Claiming means current work, with one active claim per agent.

## MCP server (read-only)

The package also installs `github-triage-mcp`, a stdio MCP server exposing read-only tools over the same services as the CLI: `triage_briefing`, `triage_issue`, `triage_dependencies` and `triage_events`. Each returns readable text plus a versioned envelope; for the first three, `result` is the CLI's `--json` output. `triage_briefing` with `mode: "briefing"` (and `since` or `last`, default 24h) returns the repository-wide `briefing` report; it never reads or advances a checkpoint. It never changes GitHub. Contract: [doc/design/mcp.md](doc/design/mcp.md).

Polling is off by default. `github-triage-mcp --repo owner/name --poll [--poll-interval-minutes N]` (default 30) polls that one repository only while the server runs and records deduplicated events (attention requested, review feedback, verification problems, PR follow-up candidates, newly eligible work) that `triage_events` reads with an opaque cursor. The first complete poll is a silent baseline; failed or incomplete polls never replace it. History holds at most 1,000 events or 24 hours, lives only in that process and is lost on exit; each polling process polls separately. Events are inspection candidates, not wake-ups, claims or approval. Contract: [doc/design/polling-events.md](doc/design/polling-events.md).

Generic stdio configuration (install globally first; nothing registers a host automatically):

```json
{ "command": "github-triage-mcp", "args": ["--project", "/absolute/project/path"] }
```

`--repo owner/name` and `--agent NAME` set defaults; a tool's own `repo`/`agent` arguments win for that call. Without an agent, the server reads (never writes) the persisted `name` of an `[agents.KEY]` entry in the project's root `agent-inbox.toml`, chosen by `--entry KEY`, else `--harness NAME`, else the MCP client (Ori's `ori-SERVER` client selects `ori.SERVER`), else the harness detected from the environment. `selection.identitySource` reports which of `tool`, `startup`, `entry`, `harness`, `client`, `environment` decided; when none does, the read is unfocused (`unresolved`) and `selection.identityDiagnostic` says why and how to fix it. Client roots remain follow-up work (#25); no external identity service is required.

## Repository settings and sizing

Use the configuration commands from the target checkout instead of editing configuration files directly:

```sh
github-triage config list
github-triage config help
github-triage estimate --help
github-triage estimate --help --metric impact
```

Complexity is enabled by default, with bundled XS–XXL guidance. Sizes are repository labels `complexity:XS`–`complexity:XXL`: `estimate N --size S --rationale TEXT` creates the requested label if missing, replaces other size labels and records provenance in a comment, and the briefing's estimation queue reads the labels with no setup. Repository calibration remains repository-specific. Disable the feature with `github-triage config set complexity.enabled false`.

See the [usage guide](doc/usage.md) for estimates, workflow mutations, caching and offline reports.

## Contribute

Maintained application code is TypeScript. From a source checkout:

```sh
npm ci
npm run triage -- --repo owner/repository
npm run check
npm test
npm run build
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) for contribution requirements and the [design index](doc/design/README.md) for architectural contracts and planned capabilities. Tests use injected boundaries and fixtures rather than live GitHub credentials.

## License

[MIT](LICENSE).

Complexity is stored in repository labels (`complexity:XS`–`complexity:XXL`); no setup is needed. The native-field `setup complexity` command and the `complexity.fieldId` setting were removed (#153); an old configuration file that still contains the key keeps working, and `config list` shows how to drop it. See the [contract](doc/design/complexity-estimation.md). No field migration or separate field permissions are needed.
