#!/usr/bin/env node
/** One read-only intake command. Contract: doc/github-triage-cli.md. */
import { realpathSync } from "node:fs";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { collect, currentRepository, ghQuery, IssueUnavailable } from "./github.js";
import {
  applyDependencyChange,
  dependencyChangeText,
  dependencyReport,
  dependencyText,
  ghRun,
  planDependencyChange,
} from "./dependencies.js";
import { compactBriefing, compactText } from "./compact.js";
import { prStatusText, pullRequestStatus } from "./prstatus.js";
import { doctorStaleHours, ticketDoctor, ticketDoctorText } from "./ticketdoctor.js";
import { applyPlan, claimText, planClaim, planNeedsHuman } from "./claims.js";
import { checkForUpdate, installedVersion, optOutEnv, updateAdvisory } from "./updates.js";
import { defaultStaleHours, teamText, teamView } from "./team.js";
import { ticketOwnership, ticketOwnershipText } from "./who.js";
import { migrationPlanText, planMigration } from "./migration.js";
import { briefing, textReport } from "./briefing.js";
import { pickupOrders } from "./ranking.js";
import type { PickupOrder } from "./ranking.js";
import { complexityGuidanceJson, complexityGuidanceText } from "./complexity.js";
import { runConfig } from "./configcli.js";
import type { ConfigRuntime } from "./configcli.js";
import { runSetup, terminalPrompt } from "./complexitysetup.js";
import type { SetupRuntime } from "./complexitysetup.js";
import { diagnoseComplexityConfig } from "./complexitydoctor.js";
import type { ComplexityDoctorRuntime } from "./complexitydoctor.js";
import type { GhRun } from "./dependencies.js";
import type { Query } from "./github.js";
import type { Snapshot } from "./types.js";

/** Parsed `deps` arguments: help, a migration plan, a native change, or a read. */
export type DepsArguments =
  | { help: true; repo?: undefined }
  | { help?: undefined; migrate: "plan"; file: string; repo?: string; json?: boolean }
  | {
      help?: undefined;
      action: "add" | "remove";
      number: number;
      on: number[];
      note: string;
      dryRun: boolean;
      repo?: string;
      json?: boolean;
    }
  | { help?: undefined; number: number; repo?: string; json?: boolean; tree?: boolean };

/** Injected services for `main`; tests replace the GitHub-facing ones. */
export interface Runtime {
  collect: typeof collect;
  currentRepository: typeof currentRepository;
  dependencyReport?: typeof dependencyReport;
  planDependencyChange?: typeof planDependencyChange;
  ghRun?: GhRun;
  planMigration?: typeof planMigration;
  migrationRuntime?: Parameters<typeof planMigration>[1];
  query?: Query;
  now?: () => Date;
  updateCheck?: typeof checkForUpdate;
  stderr?: (text: string) => void;
  /** Filesystem, git and working directory for `config`; tests never touch the real checkout. */
  config?: ConfigRuntime;
  /** Filesystem, git, GitHub field API and prompt for `setup complexity`. */
  setup?: SetupRuntime;
  /** Filesystem, git and GitHub field API for Ticket Doctor's configuration checks. */
  doctor?: ComplexityDoctorRuntime;
}

type Output = (text: string) => Promise<void>;

export const help = `Usage: github-triage [options]
       (from a source checkout: npm run triage -- [options])
Read-only LLM action briefing. Requires authenticated gh and Node 26+.
  deps N [--tree]       Read native upstream/downstream dependencies (deps --help)
  deps add|remove N --on M --note WHY [--dry-run]  Change native dependencies
  estimate --help       Complexity sizing guidance (XS..XXL); recording is not yet available
  pr N                  Why is pull request N not progressing? Every blocker at once
  claim N --agent NAME [--branch B] [--platform P] [--dry-run]  Claim an eligible ticket
  needs-human N --agent NAME --designer NAME --why TEXT --question TEXT... [--dry-run]
                        Record questions for a designer and mark the ticket decision-needed
  team [--stale-hours N]  Read-only: each agent's claims, linked PRs, activity and warnings
  who N [--stale-hours N]  Read-only: who is working on ticket N? Claims, PRs, activity,
                        handoff evidence and contradictions in one operation
  ticket-doctor [--stale-hours N] [--limit N]  Read-only consistency scan of all open tickets
                        and repository complexity configuration
  config get KEY | set KEY VALUE | list | help [KEY]  Repository settings in
                        .github/triage.json of this checkout (config help)
  setup complexity [--select ID | --create]  Discover native issue fields and map one
                        for complexity; creation is explicit (setup --help)
  --repo owner/name     Repository (default: current gh checkout)
  --json                Versioned structured output (from a checkout: npm run --silent triage)
  --issue N             Include full issue body/history, even if closed; diagnoses
                        transferred, missing or forbidden issues instead of failing
  --include-transferred With --issue: follow a transfer to the destination's intake
  --since ISO           Include changed issues/PRs in all states since timestamp
  --checkpoint PATH     Read last successful window; advance only after complete live output
  --cache PATH          Save full successful snapshot atomically
  --offline             Read explicit cache; no GitHub queries/checkpoint advancement
  --full                Expanded version-1 report
  --agent NAME          Your identity: attention:NAME first, then agent:NAME work
  --platform P          Your platform (e.g. claude-code); platform:* tickets need a match.
                        Without it, restricted tickets are inspection context, not pickup
  --order MODE          Pickup order only: impact (default: urgency, immediate unlocks,
                        incomplete first, oldest), or oldest/newest (creation time alone,
                        ignoring urgency/impact; both still shown). Never changes eligibility,
                        claims, addressed attention or the PR/owned-work groups above pickup
  --stale-hours N       Flag claims with no ticket/linked-PR activity for N hours (default 48)
  --max-chars N         Compact text budget (default 10000)
  --limit N             Next steps (default 5 compact, 10 expanded)
  --no-update-check     Skip the npm version check (also ${optOutEnv}=1)
  version               Show the installed version and the update check result
  --help                Show usage
Exit: 0 complete; 2 incomplete evidence; 1 invalid arguments/API/cache failure.
The briefing never changes GitHub; only deps add/remove, claim and needs-human do;
config set changes only the local .github/triage.json; setup complexity may
also create an owner-wide issue field, only after --create/confirmation. Hints require inspection.
`;
export const depsHelp = `Usage: github-triage deps N [--tree] [--json] [--repo owner/name]
       github-triage deps add N --on M [--on K] --note WHY [--dry-run] [--json]
       github-triage deps remove N --on M [--on K] --note WHY [--dry-run] [--json]
       github-triage deps migrate --plan FILE [--repo owner/name] [--json]
(From a source checkout, use npm run triage -- deps ...)
deps N reads native GitHub issue dependencies for issue N (read-only).
deps add/remove make N blocked (or no longer blocked) by each M, after fresh live checks:
refuses self-dependencies, pull requests, missing issues and cycles; an edge that already
exists (add) or is absent (remove) is a no-op. Posts one comment on N with the note.
Changes no labels.
  --tree                Follow blockers and dependants transitively; report cycles
  --on M                Blocker issue number (repeatable; add/remove only)
  --note WHY            Reason recorded in the comment (required for add/remove)
  --dry-run             Show the exact changes and comment; make none
  --json                Versioned structured output (from a checkout: npm run --silent triage)
  --repo owner/name     Repository (default: current gh checkout)
  --help                Show usage
deps migrate --plan reads only: it writes a report of how \`Depends on\` text and blocked:work
labels map to native dependencies. Record edges with deps add; automatic apply is deferred (#48).
Exit: 0 all done; 2 partly done (refused/skipped/failed items listed); 1 nothing done or
invalid arguments/API failure.
`;
export function depsArgumentsFor(args: string[]): DepsArguments {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      json: { type: "boolean" },
      tree: { type: "boolean" },
      help: { type: "boolean" },
      on: { type: "string", multiple: true },
      note: { type: "string" },
      "dry-run": { type: "boolean" },
      plan: { type: "string" },
    },
  });
  if (values.help) return { help: true };
  if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    throw new Error("--repo must be owner/name.");
  const number = (text: string | undefined): number | null =>
    /^[1-9]\d*$/.test(text ?? "") && Number.isSafeInteger(Number(text)) ? Number(text) : null;
  if (positionals[0] === "migrate") {
    const usage =
      "Usage: deps migrate --plan FILE [--repo owner/name] [--json] (read-only; automatic apply is deferred, #48)";
    if (positionals.length !== 1 || !values.plan || values.on || values.note || values.tree)
      throw new Error(usage);
    if (values["dry-run"]) throw new Error(`--plan never changes GitHub. ${usage}`);
    return { migrate: "plan", file: values.plan, repo: values.repo, json: values.json };
  }
  if (values.plan) throw new Error("--plan applies only to deps migrate.");
  if (positionals[0] === "add" || positionals[0] === "remove") {
    const usage = `Usage: deps ${positionals[0]} N --on M [--on K] --note WHY [--dry-run] [--json] [--repo owner/name]`;
    const target = number(positionals[1]);
    const parsed = (values.on ?? []).map(number);
    const on = parsed.filter((n): n is number => n !== null);
    if (
      positionals.length !== 2 ||
      !target ||
      !on.length ||
      on.length !== parsed.length ||
      values.tree
    )
      throw new Error(usage);
    if (!values.note?.trim()) throw new Error(`--note WHY is required. ${usage}`);
    return {
      action: positionals[0],
      number: target,
      on,
      note: values.note.trim(),
      dryRun: !!values["dry-run"],
      repo: values.repo,
      json: values.json,
    };
  }
  if (values.on || values.note || values["dry-run"])
    throw new Error("--on, --note and --dry-run apply only to deps add/remove.");
  if (
    positionals.length !== 1 ||
    !/^[1-9]\d*$/.test(positionals[0]) ||
    !Number.isSafeInteger(Number(positionals[0]))
  )
    throw new Error("Usage: deps N [--tree] [--json] [--repo owner/name]");
  return {
    repo: values.repo,
    json: values.json,
    tree: values.tree,
    number: Number(positionals[0]),
  };
}
/** Dry runs report the exit code the real run would give if every apply succeeded. */
const plannedExit = (changes: { status: string }[]): number => {
  const applying = changes.some((c) => c.status === "apply");
  const refused = changes.some((c) => c.status === "refused");
  return !applying ? (refused ? 1 : 0) : refused ? 2 : 0;
};
/**
 * Arguments for `claim` and `needs-human` (doc/design/workflow.md).
 */
export function workflowArgumentsFor(command: "claim" | "needs-human", args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      json: { type: "boolean" },
      "dry-run": { type: "boolean" },
      agent: { type: "string" },
      branch: { type: "string" },
      platform: { type: "string" },
      designer: { type: "string" },
      why: { type: "string" },
      question: { type: "string", multiple: true },
    },
  });
  const usage =
    command === "claim"
      ? "Usage: github-triage claim N --agent NAME [--branch BRANCH] [--platform P] [--dry-run] [--json]"
      : "Usage: github-triage needs-human N --agent NAME --designer NAME --why TEXT --question TEXT [--question TEXT...] [--dry-run] [--json]";
  const number =
    positionals.length === 1 && /^[1-9]\d*$/.test(positionals[0]) ? Number(positionals[0]) : null;
  const name = /^[A-Za-z0-9][\w.-]*$/;
  if (!number || !values.agent || !name.test(values.agent)) throw new Error(usage);
  if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    throw new Error("--repo must be owner/name.");
  const common = {
    number,
    agent: values.agent,
    repo: values.repo,
    json: values.json,
    dryRun: !!values["dry-run"],
  };
  if (command === "claim") {
    if (values.designer || values.why || values.question) throw new Error(usage);
    return { ...common, branch: values.branch, platform: values.platform };
  }
  const questions = (values.question ?? []).map((q) => q.trim()).filter(Boolean);
  if (!values.designer || !name.test(values.designer) || !values.why?.trim() || !questions.length)
    throw new Error(usage);
  if (values.branch || values.platform) throw new Error(usage);
  return { ...common, designer: values.designer, why: values.why.trim(), questions };
}
export function argumentsFor(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      json: { type: "boolean" },
      full: { type: "boolean" },
      agent: { type: "string" },
      "max-chars": { type: "string" },
      issue: { type: "string" },
      since: { type: "string" },
      checkpoint: { type: "string" },
      cache: { type: "string" },
      offline: { type: "boolean" },
      "include-transferred": { type: "boolean" },
      limit: { type: "string" },
      order: { type: "string" },
      platform: { type: "string" },
      "stale-hours": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    throw new Error("--repo must be owner/name.");
  const order = values.order ?? "impact";
  if (!isPickupOrder(order)) throw new Error(`--order must be one of ${pickupOrders.join(", ")}.`);
  if (values.platform !== undefined && !/^[\w.-]+$/.test(values.platform))
    throw new Error("--platform must be a platform name such as claude-code.");
  const staleHours =
    values["stale-hours"] === undefined ? undefined : Number(values["stale-hours"]);
  if (staleHours !== undefined && (!Number.isFinite(staleHours) || staleHours <= 0))
    throw new Error("--stale-hours must be a positive number.");
  const positive = (text: string, option: string): number => {
    if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text)))
      throw new Error(`${option} must be a positive integer.`);
    return Number(text);
  };
  if (
    values.since &&
    (!/^\d{4}-\d\d-\d\dT/.test(values.since) ||
      !/(?:Z|[+-]\d{2}:\d{2})$/.test(values.since) ||
      !Number.isFinite(Date.parse(values.since)))
  )
    throw new Error("--since must be an ISO timestamp with a time.");
  if (values.offline && values.since)
    throw new Error("--since requires a live fetch; offline data cannot verify changes.");
  if (values.offline && !values.cache) throw new Error("--offline requires --cache PATH.");
  return {
    ...values,
    issue: values.issue ? positive(values.issue, "--issue") : undefined,
    limit: positive(values.limit ?? (values.full ? "10" : "5"), "--limit"),
    maxChars: positive(values["max-chars"] ?? "10000", "--max-chars"),
    since: values.since ? new Date(values.since).toISOString() : undefined,
    order,
    staleHours,
  };
}
const isPickupOrder = (text: string): text is PickupOrder =>
  (pickupOrders as readonly string[]).includes(text);
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Structural check of a cached snapshot. Only the envelope is validated (as before the
 * TypeScript migration); the guard is the single narrowly accepted trust point for cache files.
 */
function isSnapshotEnvelope(data: unknown, repository: string | undefined): data is Snapshot {
  return !(
    !isRecord(data) ||
    data.schemaVersion !== 1 ||
    typeof data.repository !== "string" ||
    (repository && data.repository !== repository) ||
    !Number.isFinite(Date.parse(String(data.fetchedAt))) ||
    !Number.isFinite(Date.parse(String(data.startedAt))) ||
    ![data.issues, data.pullRequests, data.dependencies, data.changed, data.warnings].every(
      Array.isArray,
    )
  );
}
export async function cachedSnapshot(
  path: string,
  repository: string | undefined,
): Promise<Snapshot> {
  const data: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isSnapshotEnvelope(data, repository))
    throw new Error("Cache schema/repository is invalid or unsupported.");
  return data;
}
export async function checkpointSince(
  path: string,
  repository: string,
): Promise<string | undefined> {
  try {
    const data: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      !isRecord(data) ||
      data.schemaVersion !== 1 ||
      data.repository !== repository ||
      typeof data.through !== "string" ||
      !Number.isFinite(Date.parse(data.through))
    )
      throw new Error("Checkpoint schema/repository is invalid.");
    return data.through;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}
export async function main(
  args: string[],
  output: Output = (text) =>
    new Promise<void>((resolve, reject) =>
      process.stdout.write(text, (error) => (error ? reject(error) : resolve())),
    ),
  runtime: Runtime = { collect, currentRepository, dependencyReport },
): Promise<number> {
  // Version check (#51): runs alongside the command, bounded by a short timeout, and reports
  // only on stderr so JSON on stdout stays valid. --offline and opt-outs mean no network.
  const optOut = args.includes("--no-update-check") || !!process.env[optOutEnv];
  const rest = args.filter((a) => a !== "--no-update-check");
  const check = runtime.updateCheck ?? checkForUpdate;
  if (rest[0] === "version") {
    const installed = await installedVersion();
    const result = await check({ offline: rest.includes("--offline"), optOut, installed });
    await output(
      rest.includes("--json")
        ? JSON.stringify({ schemaVersion: 1, version: installed.version, check: result }, null, 2) +
            "\n"
        : `github-triage ${installed.version ?? "(unknown version)"}\nUpdate check: ${result.status}${"reason" in result && result.reason ? ` — ${result.reason}` : ""}${"available" in result && result.available ? ` (npm ${result.channel}: ${result.available})` : ""}\n`,
    );
    return 0;
  }
  // Help is instant; it should not wait on the network, so it is not an eligible invocation.
  const eligible = !rest.includes("--help") && !(rest[0] === "config" && rest[1] === "help");
  const pending = eligible
    ? Promise.resolve()
        .then(() => check({ offline: rest.includes("--offline"), optOut }))
        .catch(() => null)
    : Promise.resolve(null);
  try {
    return await run(rest, output, runtime);
  } finally {
    const advisory = updateAdvisory(
      (await pending) ?? { status: "unknown", reason: "", installed: null, channel: "" },
    );
    if (advisory) (runtime.stderr ?? ((t) => process.stderr.write(t)))(`${advisory}\n`);
  }
}

/** The command itself; `main` adds the version check around it. */
async function run(args: string[], output: Output, runtime: Runtime): Promise<number> {
  if (args[0] === "config") return runConfig(args.slice(1), output, runtime.config);
  if (args[0] === "setup")
    return runSetup(args.slice(1), output, {
      prompt: runtime.setup ? null : terminalPrompt(),
      ...runtime.setup,
    });
  if (args[0] === "ticket-doctor") {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        repo: { type: "string" },
        json: { type: "boolean" },
        "stale-hours": { type: "string" },
        limit: { type: "string" },
        cache: { type: "string" },
        offline: { type: "boolean" },
      },
    });
    if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
      throw new Error("--repo must be owner/name.");
    const staleHours =
      values["stale-hours"] === undefined ? doctorStaleHours : Number(values["stale-hours"]);
    if (!Number.isFinite(staleHours) || staleHours <= 0)
      throw new Error("--stale-hours must be a positive number.");
    const limit = values.limit === undefined ? 30 : Number(values.limit);
    if (!Number.isInteger(limit) || limit <= 0)
      throw new Error("--limit must be a positive integer.");
    if (values.offline && !values.cache) throw new Error("--offline requires --cache PATH.");
    const snapshot = values.offline
      ? await cachedSnapshot(values.cache ?? "", values.repo)
      : await runtime.collect(values.repo ?? (await runtime.currentRepository()), {});
    if (!values.offline && values.cache) await atomicJson(values.cache, snapshot);
    const report = ticketDoctor(snapshot, {
      staleHours,
      limit,
      now: runtime.now?.() ?? new Date(),
      offline: !!values.offline,
    });
    report.configuration = {
      complexity: await diagnoseComplexityConfig(
        snapshot.repository,
        { offline: !!values.offline },
        runtime.doctor,
      ),
    };
    await output(values.json ? JSON.stringify(report, null, 2) + "\n" : ticketDoctorText(report));
    return report.completeness.complete ? 0 : 2;
  }
  if (args[0] === "claim" || args[0] === "needs-human") {
    const values = workflowArgumentsFor(args[0], args.slice(1));
    const repository = values.repo ?? (await runtime.currentRepository());
    const query = runtime.query ?? ghQuery;
    // Read live immediately before changing; never act on a cached snapshot.
    const plan =
      "questions" in values
        ? await planNeedsHuman(repository, values, query)
        : await planClaim(repository, values, query);
    const result =
      values.dryRun || !plan.ok
        ? { ...plan, exitCode: plan.ok ? 0 : 1 }
        : await applyPlan(repository, plan, { run: runtime.ghRun ?? ghRun, query });
    await output(
      values.json
        ? JSON.stringify({ schemaVersion: 1, ...result }, null, 2) + "\n"
        : claimText(result, values.dryRun),
    );
    return result.exitCode;
  }
  if (args[0] === "team") {
    const { values } = parseArgs({
      args: args.slice(1),
      options: {
        repo: { type: "string" },
        json: { type: "boolean" },
        "stale-hours": { type: "string" },
        cache: { type: "string" },
        offline: { type: "boolean" },
      },
    });
    if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
      throw new Error("--repo must be owner/name.");
    const staleHours =
      values["stale-hours"] === undefined ? defaultStaleHours : Number(values["stale-hours"]);
    if (!Number.isFinite(staleHours) || staleHours <= 0)
      throw new Error("--stale-hours must be a positive number.");
    if (values.offline && !values.cache) throw new Error("--offline requires --cache PATH.");
    const snapshot = values.offline
      ? await cachedSnapshot(values.cache ?? "", values.repo)
      : await runtime.collect(values.repo ?? (await runtime.currentRepository()), {});
    if (!values.offline && values.cache) await atomicJson(values.cache, snapshot);
    const view = teamView(snapshot, {
      staleHours,
      now: runtime.now?.() ?? new Date(),
      offline: !!values.offline,
    });
    await output(values.json ? JSON.stringify(view, null, 2) + "\n" : teamText(view));
    return view.completeness.complete ? 0 : 2;
  }
  if (args[0] === "who") {
    const { values, positionals } = parseArgs({
      args: args.slice(1),
      allowPositionals: true,
      options: {
        repo: { type: "string" },
        json: { type: "boolean" },
        "stale-hours": { type: "string" },
        cache: { type: "string" },
        offline: { type: "boolean" },
      },
    });
    if (positionals.length !== 1 || !/^[1-9]\d*$/.test(positionals[0]))
      throw new Error("Usage: github-triage who N [--json] [--stale-hours N] [--repo owner/name]");
    if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
      throw new Error("--repo must be owner/name.");
    const staleHours =
      values["stale-hours"] === undefined ? defaultStaleHours : Number(values["stale-hours"]);
    if (!Number.isFinite(staleHours) || staleHours <= 0)
      throw new Error("--stale-hours must be a positive number.");
    if (values.offline && !values.cache) throw new Error("--offline requires --cache PATH.");
    const number = Number(positionals[0]);
    const snapshot = values.offline
      ? await cachedSnapshot(values.cache ?? "", values.repo)
      : await runtime.collect(values.repo ?? (await runtime.currentRepository()), {
          issue: number,
        });
    if (!values.offline && values.cache) await atomicJson(values.cache, snapshot);
    const report = ticketOwnership(snapshot, number, {
      staleHours,
      now: runtime.now?.() ?? new Date(),
      offline: !!values.offline,
    });
    await output(
      values.json ? JSON.stringify(report, null, 2) + "\n" : ticketOwnershipText(report),
    );
    return report.completeness.complete ? 0 : 2;
  }
  if (args[0] === "estimate") {
    const { values, positionals } = parseArgs({
      args: args.slice(1),
      allowPositionals: true,
      options: { help: { type: "boolean" }, json: { type: "boolean" } },
    });
    // Only the bundled guidance exists; never present recording as installed.
    if (!values.help || positionals.length)
      throw new Error(
        "Usage: github-triage estimate --help [--json] (recording estimates is not yet available)",
      );
    await output(values.json ? complexityGuidanceJson() : complexityGuidanceText());
    return 0;
  }
  if (args[0] === "pr") {
    const { values, positionals } = parseArgs({
      args: args.slice(1),
      allowPositionals: true,
      options: { repo: { type: "string" }, json: { type: "boolean" } },
    });
    if (positionals.length !== 1 || !/^[1-9]\d*$/.test(positionals[0]))
      throw new Error("Usage: github-triage pr N [--json] [--repo owner/name]");
    if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
      throw new Error("--repo must be owner/name.");
    const repository = values.repo ?? (await runtime.currentRepository());
    const report = await pullRequestStatus(
      repository,
      Number(positionals[0]),
      runtime.query ?? ghQuery,
    );
    await output(values.json ? JSON.stringify(report, null, 2) + "\n" : prStatusText(report));
    return report.completeness.complete ? 0 : 2;
  }
  if (args[0] === "deps") {
    const values = depsArgumentsFor(args.slice(1));
    if (values.help) {
      await output(depsHelp);
      return 0;
    }
    const repository = values.repo ?? (await runtime.currentRepository());
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("--repo must be owner/name.");
    if ("migrate" in values) {
      const plan = await (runtime.planMigration ?? planMigration)(
        repository,
        runtime.migrationRuntime,
      );
      await atomicJson(values.file, plan);
      await output(values.json ? JSON.stringify(plan, null, 2) + "\n" : migrationPlanText(plan));
      return 0;
    }
    if ("action" in values) {
      // Read live immediately before changing; never act on a cached snapshot.
      const plan = await (runtime.planDependencyChange ?? planDependencyChange)(repository, {
        action: values.action,
        number: values.number,
        on: values.on,
        note: values.note,
      });
      const result = values.dryRun
        ? {
            ...plan,
            dryRun: true,
            exitCode: plannedExit(plan.changes),
          }
        : await applyDependencyChange(plan, runtime.ghRun ?? ghRun);
      await output(
        values.json ? JSON.stringify(result, null, 2) + "\n" : dependencyChangeText(result),
      );
      return result.exitCode;
    }
    const report = await (runtime.dependencyReport ?? dependencyReport)(repository, values.number, {
      tree: !!values.tree,
    });
    await output(values.json ? JSON.stringify(report, null, 2) + "\n" : dependencyText(report));
    return 0;
  }
  const options = argumentsFor(args);
  if (options.help) {
    await output(help);
    return 0;
  }
  let snapshot: Snapshot;
  if (options.offline) snapshot = await cachedSnapshot(options.cache ?? "", options.repo);
  else {
    const repository = options.repo ?? (await runtime.currentRepository());
    const previous = options.checkpoint
      ? await checkpointSince(options.checkpoint, repository)
      : undefined;
    try {
      snapshot = await runtime.collect(repository, {
        issue: options.issue,
        since: options.since ?? previous,
      });
    } catch (error) {
      if (!(error instanceof IssueUnavailable)) throw error;
      const d = error.diagnosis;
      // Transferred-out work is excluded by default; only an explicit opt-in follows it.
      if (d.state === "moved" && options["include-transferred"]) {
        const rest = args.filter(
          (a, i) =>
            !["--repo", "--issue", "--cache", "--checkpoint"].includes(a) &&
            !["--repo", "--issue", "--cache", "--checkpoint"].includes(args[i - 1] ?? "") &&
            !/^--(repo|issue|cache|checkpoint)=/.test(a),
        );
        // Keep the origin identity visible: JSON gains transferredFrom, text a leading notice.
        const followed = async (text: string) =>
          output(
            options.json
              ? JSON.stringify({ ...JSON.parse(text), transferredFrom: d }, null, 2) + "\n"
              : `Followed transfer: ${d.url} -> ${String(d.destination.url)} (--include-transferred)\n${text}`,
          );
        return run(
          [...rest, "--repo", d.destination.repository, "--issue", String(d.destination.number)],
          followed,
          runtime,
        );
      }
      const report = { schemaVersion: 1, kind: "issue-unavailable", ...d };
      await output(
        options.json
          ? JSON.stringify(report, null, 2) + "\n"
          : `Issue #${d.number} in ${d.repository}: ${d.state.toUpperCase()}\n${d.detail}\n${d.state === "moved" ? `Destination: ${String(d.destination.url)} (use --include-transferred to read it)\n` : ""}Next: ${d.next}\n`,
      );
      return 2;
    }
    if (options.cache) await atomicJson(options.cache, snapshot);
  }
  if (options.issue && !snapshot.issues.some((issue) => issue.number === options.issue))
    throw new Error(`Issue #${options.issue} not in this cache. Refresh live with --issue.`);
  const expanded = briefing(
    snapshot,
    options.full
      ? options
      : {
          ...options,
          limit: Math.max(snapshot.issues.length + snapshot.pullRequests.length, 1) * 20,
        },
  );
  const compact = options.full ? null : compactBriefing(snapshot, options, expanded);
  const report = compact ?? expanded;
  const checkpoint = options.checkpoint
    ? {
        previousWindow: snapshot.since,
        establishesBaseline: !snapshot.since,
        nextThroughCandidate:
          !options.offline && report.completeness.complete ? snapshot.startedAt : null,
        policy:
          "Advance only after complete successful live output; offline/incomplete results never advance.",
      }
    : null;
  const checkpointText = checkpoint
    ? `Checkpoint: ${checkpoint.establishesBaseline ? "establishing current baseline" : `previous window ${checkpoint.previousWindow}`}; ${checkpoint.policy}\n`
    : "";
  await output(
    options.json
      ? JSON.stringify({ ...report, checkpoint }, null, 2) + "\n"
      : (compact ? compactText(compact, options.maxChars) : textReport(expanded)) + checkpointText,
  );
  if (!options.offline && options.checkpoint && report.completeness.complete)
    // Start time deliberately overlaps windows: updates arriving during collection are not lost.
    await atomicJson(options.checkpoint, {
      schemaVersion: 1,
      repository: snapshot.repository,
      through: snapshot.startedAt,
    });
  return report.completeness.complete ? 0 : 2;
}
/**
 * True when this module is the process entry point. npm installs bins as
 * symlinks (or shims), so compare real paths rather than the raw argv path.
 */
function isEntryPoint(entry: string | undefined): boolean {
  if (!entry) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isEntryPoint(process.argv[1])) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`triage: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
