# Source layout by capability

Status: proposed mapping for #335 stage 1. This is a documentation-only contract. It moves no files. The stage-2 move PRs and the stage-3 test split implement it.

## Goal and constraints

`src/` is currently flat: 66 files, plus `triage.test.ts` at 10,809 lines with 55 top-level suites. The owner wants contributors to find related behaviour and its tests together, and to see the formal rules in their own labelled area.

- One npm package. Use plain directories and ES modules: no TypeScript `namespace` declarations, no new packages, no workspaces.
- `src/cli.ts` and `src/mcp.ts` stay where they are as thin entry points. The `build`, `pdb`, `mcp` and `triage` scripts, CI's `npx tsx src/cli.ts`, and the published `dist/cli.mjs`, `dist/mcp.mjs` and `dist/datalog-*.mjs` do not change.
- No barrel `index.ts` files and no generic `shared/`, `utils/` or `common/` directory. A module imports the exact file it needs, using a relative `.js` specifier as it does today.
- Moves preserve behaviour: CLI and MCP schemas, persisted markers, configuration keys, output text and runtime dependencies stay as they are. Move PRs contain no new features and no semantic refactors.
- No new import cycles. The cycles that exist today are listed below. The moves keep them as they are and do not hide them, and breaking them is separate follow-up work.

## Target areas

| Directory            | Owns                                                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/github/`        | Collecting GitHub facts through `gh`, change windows, native dependency reads/writes and the migration plan; shared fact types                 |
| `src/briefing/`      | Briefing assembly, ranking, roles, compact presentation, catch-up, assessments, blended queues, the workflow guide and the shared read service |
| `src/workflow/`      | Claims, handoff, delivery records, deliverables, completion, responsibility, PR progress/review history and ownership diagnostics              |
| `src/estimation/`    | Complexity and impact sizing, size labels, metrics and the estimation queue                                                                    |
| `src/config/`        | Repository settings, local identity, harness detection, the local doctor, engine selection and the file lock                                   |
| `src/updates/`       | The npm version check and its daily cache                                                                                                      |
| `src/mcp/`           | MCP-only runtime support (event polling). The server entry stays at `src/mcp.ts`                                                               |
| `src/rules/datalog/` | The DataScript/Datalog policy, its evaluator boundary, type shim and rule tests                                                                |
| `src/testing/`       | Reusable test fixtures (fake `gh`, clocks, file systems, snapshot builders). Test-only; nothing outside a `*.test.ts` file imports it          |
| `src/acceptance/`    | Cross-feature acceptance and CLI/MCP parity suites that would be arbitrary to place under one area                                             |

The owner called the rules area "the Prolog area". The implementation is Datalog, so the directory is named accurately. A future real Prolog runtime would get its own `src/rules/prolog/`; nothing here implies one exists.

`src/language-policy.ts` stays at the root with a new `src/language-policy.test.ts`. It is a repository-wide policy, not a product capability, and `AGENTS.md` names this path. With the two entry points it is one of only three non-test source files left at the root.

## Module mapping

| Current file          | Destination                      | Notes                                                                                |
| --------------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| `cli.ts`              | `cli.ts` (unchanged)             | Entry point                                                                          |
| `mcp.ts`              | `mcp.ts` (unchanged)             | Entry point                                                                          |
| `language-policy.ts`  | `language-policy.ts` (unchanged) | Repository policy                                                                    |
| `github.ts`           | `github/github.ts`               |                                                                                      |
| `changes.ts`          | `github/changes.ts`              |                                                                                      |
| `dependencies.ts`     | `github/dependencies.ts`         | In a cycle with `github.ts`; both stay in one directory                              |
| `migration.ts`        | `github/migration.ts`            | `deps migrate --plan`                                                                |
| `types.d.ts`          | `github/types.d.ts`              | Shared GitHub fact types                                                             |
| `briefing.ts`         | `briefing/briefing.ts`           |                                                                                      |
| `compact.ts`          | `briefing/compact.ts`            |                                                                                      |
| `ranking.ts`          | `briefing/ranking.ts`            |                                                                                      |
| `roles.ts`            | `briefing/roles.ts`              |                                                                                      |
| `assessments.ts`      | `briefing/assessments.ts`        |                                                                                      |
| `blended.ts`          | `briefing/blended.ts`            | TypeScript blended queue; the Datalog engine is in `rules/datalog/`                  |
| `catchup.ts`          | `briefing/catchup.ts`            |                                                                                      |
| `catchupcli.ts`       | `briefing/catchupcli.ts`         |                                                                                      |
| `process.ts`          | `briefing/process.ts`            | Workflow guide generated from registered policy (#71)                                |
| `service.ts`          | `briefing/service.ts`            | Shared CLI/MCP read service                                                          |
| `claims.ts`           | `workflow/claims.ts`             |                                                                                      |
| `delivery.ts`         | `workflow/delivery.ts`           |                                                                                      |
| `deliverables.ts`     | `workflow/deliverables.ts`       |                                                                                      |
| `completion.ts`       | `workflow/completion.ts`         |                                                                                      |
| `responsibility.ts`   | `workflow/responsibility.ts`     |                                                                                      |
| `prstatus.ts`         | `workflow/prstatus.ts`           |                                                                                      |
| `reviewevidence.ts`   | `workflow/reviewevidence.ts`     | Beside `prstatus.ts`, which it imports types from                                    |
| `reviewhistory.ts`    | `workflow/reviewhistory.ts`      |                                                                                      |
| `team.ts`             | `workflow/team.ts`               |                                                                                      |
| `who.ts`              | `workflow/who.ts`                |                                                                                      |
| `ticketdoctor.ts`     | `workflow/ticketdoctor.ts`       |                                                                                      |
| `doctorplans.ts`      | `workflow/doctorplans.ts`        | Ticket Doctor repair plans                                                           |
| `estimate.ts`         | `estimation/estimate.ts`         |                                                                                      |
| `estimation.ts`       | `estimation/estimation.ts`       |                                                                                      |
| `complexity.ts`       | `estimation/complexity.ts`       |                                                                                      |
| `complexitylabels.ts` | `estimation/complexitylabels.ts` |                                                                                      |
| `impact.ts`           | `estimation/impact.ts`           |                                                                                      |
| `metrics.ts`          | `estimation/metrics.ts`          |                                                                                      |
| `config.ts`           | `config/config.ts`               |                                                                                      |
| `configcli.ts`        | `config/configcli.ts`            |                                                                                      |
| `identity.ts`         | `config/identity.ts`             |                                                                                      |
| `readidentity.ts`     | `config/readidentity.ts`         |                                                                                      |
| `harness.ts`          | `config/harness.ts`              |                                                                                      |
| `localdoctor.ts`      | `config/localdoctor.ts`          |                                                                                      |
| `engine-setting.ts`   | `config/engine-setting.ts`       |                                                                                      |
| `filelock.ts`         | `config/filelock.ts`             | Also used by `updates/updatecache.ts`; `updates → config` is an acceptable direction |
| `updates.ts`          | `updates/updates.ts`             |                                                                                      |
| `updatecache.ts`      | `updates/updatecache.ts`         |                                                                                      |
| `polling.ts`          | `mcp/polling.ts`                 |                                                                                      |
| `datalog.ts`          | `rules/datalog/datalog.ts`       | Evaluator boundary                                                                   |
| `datalog-policy.ts`   | `rules/datalog/policy.ts`        | The rules themselves                                                                 |
| `datascript.d.ts`     | `rules/datalog/datascript.d.ts`  |                                                                                      |

## Test mapping

Existing test files move with their subject:

| Current test                  | Destination                              |
| ----------------------------- | ---------------------------------------- |
| `assessments.test.ts`         | `briefing/assessments.test.ts`           |
| `blended.test.ts`             | `briefing/blended.test.ts`               |
| `catchup.test.ts`             | `briefing/catchup.test.ts`               |
| `completion.test.ts`          | `workflow/completion.test.ts`            |
| `deliverables.test.ts`        | `workflow/deliverables.test.ts`          |
| `delivery.test.ts`            | `workflow/delivery.test.ts`              |
| `impact.test.ts`              | `estimation/impact.test.ts`              |
| `engine-setting.test.ts`      | `config/engine-setting.test.ts`          |
| `polling.test.ts`             | `mcp/polling.test.ts`                    |
| `datalog.test.ts`             | `rules/datalog/datalog.test.ts`          |
| `finishfirst.test.ts`         | `acceptance/finishfirst.test.ts`         |
| `impactqueue.test.ts`         | `acceptance/impactqueue.test.ts`         |
| `mcpparity.test.ts`           | `acceptance/mcpparity.test.ts`           |
| `rename.test.ts`              | `acceptance/rename.test.ts`              |
| `benchmark-isolation.test.ts` | `acceptance/benchmark-isolation.test.ts` |

`triage.test.ts` is split by top-level suite (line numbers as of `7384969`). A suite that is too broad for one file moves as a whole first and is split later; it is never rewritten during the move.

| Destination                      | Suites                                                                                                                                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `github/github.test.ts`          | paginated facts and explicit dependency scope (202); intake evidence boundaries (389); plain JavaScript gh wrapper (499); GraphQL NOT_FOUND answers (1164); transferred issue inspection (4043, 4524)                                                                                |
| `github/dependencies.test.ts`    | native dependency read command (760); deps command line (914); deps add and deps remove (949)                                                                                                                                                                                        |
| `github/migration.test.ts`       | dependency migration (1226)                                                                                                                                                                                                                                                          |
| `briefing/briefing.test.ts`      | registered action analysis (321); native dependencies in the briefing (841); designer groups (3718); briefing attention covers open pull requests (3760); addressed attention (4107, 4140); manual urgency overrides (4157); briefing change evidence and comparison windows (10544) |
| `briefing/compact.test.ts`       | compact briefing contract (591)                                                                                                                                                                                                                                                      |
| `briefing/ranking.test.ts`       | next-action ranking (4186)                                                                                                                                                                                                                                                           |
| `briefing/roles.test.ts`         | role-shaped briefings (7325)                                                                                                                                                                                                                                                         |
| `briefing/process.test.ts`       | workflow guide in help and briefings (9323)                                                                                                                                                                                                                                          |
| `workflow/claims.test.ts`        | claim and needs-human (1604); review fixes (2016); claim ownership needs complete labels (2181); claim comment repair (2213); post-write ownership check (3680); release: coordinated handoff (7743)                                                                                 |
| `workflow/team.test.ts`          | team view (2251)                                                                                                                                                                                                                                                                     |
| `workflow/who.test.ts`           | who is working on a ticket (4557)                                                                                                                                                                                                                                                    |
| `workflow/prstatus.test.ts`      | pr status suites (2380, 3093, 3781, 3863, 3975)                                                                                                                                                                                                                                      |
| `workflow/reviewhistory.test.ts` | pr review history (8590)                                                                                                                                                                                                                                                             |
| `workflow/ticketdoctor.test.ts`  | Ticket Doctor v1 (3179); Ticket Doctor review fixes (3434)                                                                                                                                                                                                                           |
| `estimation/estimate.test.ts`    | estimate N records a size label (5663); bundled complexity guidance (4978)                                                                                                                                                                                                           |
| `estimation/estimation.test.ts`  | estimation queue and briefing visibility (6250); label-backed complexity classification (10315)                                                                                                                                                                                      |
| `config/config.test.ts`          | repository configuration service (4648); shared repository settings in TOML (5028); config commands (5495)                                                                                                                                                                           |
| `config/identity.test.ts`        | agent identity in root agent-inbox.toml (9491)                                                                                                                                                                                                                                       |
| `config/localdoctor.test.ts`     | local configuration doctor (8907)                                                                                                                                                                                                                                                    |
| `updates/updates.test.ts`        | version check (2610); daily cached version check (2732)                                                                                                                                                                                                                              |
| `acceptance/cli.test.ts`         | CLI freshness and local state safety (429); help names the installed command (1574)                                                                                                                                                                                                  |
| `acceptance/mcp.test.ts`         | read-only MCP adapter (6510)                                                                                                                                                                                                                                                         |
| `acceptance/scripts.test.ts`     | release versions (1184); explicit publication helpers (3581). These exercise `scripts/`; Vitest discovery stays `src/**/*.test.ts`                                                                                                                                                   |
| `language-policy.test.ts`        | TypeScript source boundary (4463)                                                                                                                                                                                                                                                    |

Helpers and fixtures defined at the top of `triage.test.ts` and used by more than one destination move to `src/testing/`, one file per kind of fixture (for example `testing/fakegh.ts`, `testing/snapshots.ts`). A helper used by only one destination moves with that suite. Assertions are not deleted or weakened; the total test count before and after each split PR is reported in its description.

## Existing import cycles

Measured over non-test modules at `7384969`:

1. `github ↔ dependencies`. Both go to `src/github/`, so the cycle stays inside one directory.
2. One strongly connected group: `assessments → claims`, `briefing → assessments`, `briefing → reviewevidence`, `reviewevidence → prstatus` (type only), `prstatus → briefing`, `claims → briefing` (the registered `workflow` definition), `delivery → claims`, `estimate → claims/delivery`, `complexitylabels → estimation → estimate`, `assessments → estimate`. After the moves it spans `briefing/`, `workflow/` and `estimation/`.

The moves must not add a cycle or merge further modules into this group. Each move PR checks the group's membership; a script or test can automate that. Breaking the group is follow-up work, for example by moving the registered `workflow` definition out of `briefing.ts` into `workflow/`, so `claims` no longer imports `briefing`. Each such change needs its own focused ticket.

## Delivery sequence

Stage 2 moves one area per PR. Leaves move first, so each PR touches only importers of the files it moves:

1. `updates/`, `rules/datalog/`, `mcp/`
2. `config/`
3. `github/`
4. `estimation/`
5. `workflow/`
6. `briefing/`

Each PR moves files with `git mv`, so history follows them, and updates relative imports in `src/` and `scripts/`, plus test imports. It changes nothing in `package.json`, `vite.config.ts`, `tsconfig.json` or CI unless a path there names a moved file. It updates documentation that names moved paths, including `AGENTS.md` "Architecture and scope". `npm run check`, `npm test`, `npm run build`, `npm run smoke` and `npm run package-test` must pass, and packaged help must be unchanged.

Stage 3 splits `triage.test.ts` per the mapping above, after the destination directories exist. It extracts `src/testing/` fixtures first, then moves suites one area per PR.

## Where new files belong

Put a new module in the area that owns its capability, beside its test. If it serves several areas, place it with the area whose contract it implements and import it from there; do not add a shared directory. A new top-level area needs an update to this document first.
