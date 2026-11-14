# Presidential Daily Briefing

Presidential Daily Briefing turns GitHub issues, pull requests, review feedback and dependencies into a compact, evidence-linked action briefing. It helps coding agents and maintainers answer **“What should I do next to move this repository forward?”** without manually piecing together dozens of GitHub searches.

It is a global command-line tool: install it once with `-g`, not as a project dependency.

```sh
npm install -g @trebizondoculpepper/presidential-daily-briefing
```

## Why use it?

Finding work is more than listing open issues. A ready-looking ticket might still be blocked; a completed contribution might need another review fix; an old claim might need inspection. Repeatedly reconstructing that context wastes time and agent tokens, and makes important follow-ups easy to miss.

Presidential Daily Briefing collects the facts and applies explicit workflow rules so you can:

- Surface attention requests, PR follow-ups and active work before starting something new.
- Find eligible work and see which tickets would immediately unblock other work.
- Inspect a ticket, a dependency chain or a stalled PR in one operation.
- Catch inconsistent ticket state and see the evidence behind each finding.
- Get compact text for an agent or versioned JSON for other tools.

The same rules produce repeatable recommendations. Source links, freshness and missing-evidence notices let you check those recommendations rather than trust an unexplained score.

## Install

Install once globally and use the command across repositories. It does not need a separate npm installation in every project.

Requirements: **Node.js 26+**, npm and the [GitHub CLI](https://cli.github.com/). Presidential Daily Briefing reuses your authenticated `gh` session; it does not require a separate token store or hosted service.

```sh
npm install -g @trebizondoculpepper/presidential-daily-briefing

# Sign in if you have not already authenticated GitHub CLI.
gh auth login
gh auth status

pdb --help
```

Run `pdb` inside a repository checkout, or pass `--repo owner/repository` explicitly. Update the global installation with the same `npm install -g` command. Add `@next` to the package name only when you want a development prerelease.

This README describes the current repository version. Published releases may lag behind it; use your installed command's `--help` to confirm which features are available.

## Examples

### Find the next useful action

```sh
pdb --repo owner/repository
```

The briefing groups attention, PR follow-up, active work and eligible pickup. General pickup defaults to urgency and immediate-unlock impact; explicit age ordering is available for backlog cleanup:

```sh
pdb --repo owner/repository --agent your-agent-name
pdb --repo owner/repository --order oldest
```

`--agent` is an explicit workflow identity, not your GitHub login. It highlights attention addressed to that name and recorded ownership; it does not authenticate an agent or claim work.

### Inspect a ticket or a blocked PR

```sh
# Full ticket intake, including discussion and dependency evidence.
pdb --repo owner/repository --issue 42

# Native upstream/downstream dependency tree.
pdb deps 42 --repo owner/repository --tree

# Checks, review findings, conflicts and other PR blockers together.
pdb pr 17 --repo owner/repository
```

### Catch up and check repository health

```sh
pdb briefing --repo owner/repository --last 24h
pdb briefing --repo owner/repository --checkpoint ~/.config/pdb/owner-repository.json
pdb --repo owner/repository --since 2026-11-01T09:00:00Z
pdb ticket-doctor --repo owner/repository
pdb team --repo owner/repository
```

`briefing` reports owner attention, completed and disposed work, progress, blockers and current activity for a window (`--last`, `--since` or `--checkpoint`, default 24 hours). A checkpoint advances only after a complete live report is delivered; `--offline --cache PATH` replays a saved window and never advances one. Ticket Doctor reports inconsistencies without repairing them. Team activity reflects recorded claims and recent evidence; it does not prove an agent is online.

### Use structured output

```sh
pdb --repo owner/repository --json
```

Reports include completeness and collection timestamps. For briefing commands, exit `0` means complete evidence, `2` means incomplete evidence, and `1` means invalid arguments or an operation failure. Incomplete evidence never means approval or “nothing to do.”

### Preview a workflow update

```sh
pdb claim 42 --repo owner/repository \
  --agent your-agent-name --dry-run
```

### Hand over finished work

```sh
pdb submit 42 --repo owner/repository \
  --agent your-agent-name --pr https://github.com/owner/repository/pull/17 --dry-run
pdb complete 42 --repo owner/repository --agent your-agent-name --dry-run
```

`submit` records the pull requests the issue requires, then releases only your claim and sets `status:awaiting-review`; you stay responsible for following up on those PRs without holding a claim. `complete` later verifies delivery from fresh evidence before closing the issue.

Briefings and diagnostic commands are read-only. Explicit commands such as `claim`, `submit`, `complete`, `needs-human` and `deps add/remove` change GitHub; inspect their help and dry-run output before applying changes. Claiming means current work, with one active claim per agent.

## MCP server (read-only)

The package also installs `pdb-mcp`, a stdio MCP server exposing read-only tools over the same services as the CLI: `triage_briefing`, `triage_issue`, `triage_dependencies` and `triage_events`. Each returns readable text plus a versioned envelope; for the first three, `result` is the CLI's `--json` output. `triage_briefing` with `mode: "briefing"` (and `since` or `last`, default 24h) returns the repository-wide `briefing` report; it never reads or advances a checkpoint. It never changes GitHub. Contract: [doc/design/mcp.md](doc/design/mcp.md).

Polling is off by default. `pdb-mcp --repo owner/name --poll [--poll-interval-minutes N]` (default 30) polls that one repository only while the server runs and records deduplicated events (attention requested, review feedback, verification problems, PR follow-up candidates, newly eligible work) that `triage_events` reads with an opaque cursor. The first complete poll is a silent baseline; failed or incomplete polls never replace it. History holds at most 1,000 events or 24 hours, lives only in that process and is lost on exit; each polling process polls separately. Events are inspection candidates, not wake-ups, claims or approval. Contract: [doc/design/polling-events.md](doc/design/polling-events.md).

Generic stdio configuration (install globally first; nothing registers a host automatically):

```json
{ "command": "pdb-mcp", "args": ["--project", "/absolute/project/path"] }
```

`--repo owner/name` and `--agent NAME` set defaults; a tool's own `repo`/`agent` arguments win for that call. Without an agent, the server reads (never writes) the persisted `name` of an `[agents.KEY]` entry in the project's root `agent-inbox.toml`, chosen by `--entry KEY`, else `--harness NAME`, else the MCP client (Ori's `ori-SERVER` client selects `ori.SERVER`), else the harness detected from the environment. `selection.identitySource` reports which of `tool`, `startup`, `entry`, `harness`, `client`, `environment` decided; when none does, the read is unfocused (`unresolved`) and `selection.identityDiagnostic` says why and how to fix it. Client roots remain follow-up work (#25); no external identity service is required.

## Repository settings and sizing

Use the configuration commands from the target checkout instead of editing configuration files directly:

```sh
pdb config list
pdb config help
pdb estimate --help
pdb estimate --help --metric impact
```

Complexity is enabled by default, with bundled XS–XXL guidance. Sizes are repository labels `complexity:XS`–`complexity:XXL`: `estimate N --size S --rationale TEXT` creates the requested label if missing, replaces other size labels and records provenance in a comment, and the briefing's estimation queue reads the labels with no setup. Repository calibration remains repository-specific. Disable the feature with `pdb config set complexity.enabled false`.

See the [usage guide](doc/usage.md) for estimates, workflow mutations, caching and offline reports.

## Contribute

Maintained application code is TypeScript. From a source checkout:

```sh
npm ci
npm run pdb -- --repo owner/repository
npm run check
npm test
npm run build
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) for contribution requirements and the [design index](doc/design/README.md) for architectural contracts and planned capabilities. Tests use injected boundaries and fixtures rather than live GitHub credentials.

## License

[MIT](LICENSE).

Complexity is stored in repository labels (`complexity:XS`–`complexity:XXL`); no setup is needed. The native-field `setup complexity` command and the `complexity.fieldId` setting were removed (#153); an old configuration file that still contains the key keeps working, and `config list` shows how to drop it. See the [contract](doc/design/complexity-estimation.md). No field migration or separate field permissions are needed.

### Datalog queues

Datalog is the default read-only next-action engine. The default view is implementer; select designer explicitly for design work:

```sh
pdb --role implementer --json
pdb --role designer
```

Actions and their reasons are derived from the same bundled rules. Structured output includes engine/policy provenance, matched explanation bindings and diagnostics. An omitted role uses the implementer view and reports that choice; explicit roles win. This does not infer identity or change mutation safeguards. TypeScript remains available as an explicit rollback. Roll back with `pdb config set briefing.engine typescript`.

MCP reads the setting only from its explicitly selected matching project (`pdb-mcp --project /path/to/checkout`). A different requested repository does not inherit that project's setting. Full ticket intake and repository catch-up remain on their existing services. Invalid repository configuration or evaluator failure produces a diagnostic rather than a silently substituted Datalog result.

## Upgrading from GitHub Triage

The product and primary commands are now Presidential Daily Briefing, `pdb` and `pdb-mcp`. The old npm package was removed by its owner. If an old global copy remains installed locally, replace it after verifying the new package is available:

```sh
npm uninstall -g @trebizondoculpepper/github-triage
npm install -g @trebizondoculpepper/presidential-daily-briefing
pdb --help
```

Old executable names remain compatibility aliases in the new package. Existing `triage_*` MCP tool names, repository settings, `triage_role` and hidden workflow-receipt identifiers remain compatible. `PDB_NO_UPDATE_CHECK=1` is the primary update-check opt-out; `GITHUB_TRIAGE_NO_UPDATE_CHECK=1` is still accepted. Historical reports retain their original names and references.
