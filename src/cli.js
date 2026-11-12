#!/usr/bin/env node
/** One read-only intake command. Contract: doc/github-triage-cli.md. */
import { realpathSync } from "node:fs";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { collect, currentRepository } from "./github.js";
import {
  applyDependencyChange,
  dependencyChangeText,
  dependencyReport,
  dependencyText,
  ghRun,
  planDependencyChange,
} from "./dependencies.js";
import { compactBriefing, compactText } from "./compact.js";
import { migrationPlanText, planMigration } from "./migration.js";
import { briefing, textReport } from "./briefing.js";

export const help = `Usage: github-triage [options]
       (from a source checkout: npm run triage -- [options])
Read-only LLM action briefing. Requires authenticated gh and Node 20+.
  deps N [--tree]       Read native upstream/downstream dependencies (deps --help)
  deps add|remove N --on M --note WHY [--dry-run]  Change native dependencies
  --repo owner/name     Repository (default: current gh checkout)
  --json                Versioned structured output (from a checkout: npm run --silent triage)
  --issue N             Include full issue body/history, even if closed
  --since ISO           Include changed issues/PRs in all states since timestamp
  --checkpoint PATH     Read last successful window; advance only after complete live output
  --cache PATH          Save full successful snapshot atomically
  --offline             Read explicit cache; no GitHub queries/checkpoint advancement
  --full                Expanded version-1 report
  --agent NAME          Focus current work on explicit inbox owner
  --max-chars N         Compact text budget (default 10000)
  --limit N             Next steps (default 5 compact, 10 expanded)
  --help                Show usage
Exit: 0 complete; 2 incomplete evidence; 1 invalid arguments/API/cache failure.
The briefing never changes GitHub; only deps add/remove do. Hints require inspection.
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
/**
 * @param {string[]} args
 * @returns {{ action?: "add" | "remove", number?: number, on?: number[], note?: string, dryRun?: boolean, repo?: string, json?: boolean, tree?: boolean, help?: boolean }}
 */
export function depsArgumentsFor(args) {
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
  const number = (text) =>
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
    const on = (values.on ?? []).map(number);
    if (positionals.length !== 2 || !target || !on.length || on.includes(null) || values.tree)
      throw new Error(usage);
    if (!values.note?.trim()) throw new Error(`--note WHY is required. ${usage}`);
    return {
      action: positionals[0],
      number: target,
      on: /** @type {number[]} */ (on),
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
  return { ...values, number: Number(positionals[0]) };
}
/** Dry runs report the exit code the real run would give if every apply succeeded. */
const plannedExit = (changes) => {
  const applying = changes.some((c) => c.status === "apply");
  const refused = changes.some((c) => c.status === "refused");
  return !applying ? (refused ? 1 : 0) : refused ? 2 : 0;
};
export function argumentsFor(args) {
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
      limit: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    throw new Error("--repo must be owner/name.");
  const positive = (text, option) => {
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
  };
}
export async function atomicJson(path, value) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}
export async function cachedSnapshot(path, repository) {
  const data = JSON.parse(await readFile(path, "utf8"));
  if (
    data.schemaVersion !== 1 ||
    typeof data.repository !== "string" ||
    (repository && data.repository !== repository) ||
    !Number.isFinite(Date.parse(data.fetchedAt)) ||
    !Number.isFinite(Date.parse(data.startedAt)) ||
    ![data.issues, data.pullRequests, data.dependencies, data.changed, data.warnings].every(
      Array.isArray,
    )
  )
    throw new Error("Cache schema/repository is invalid or unsupported.");
  return data;
}
export async function checkpointSince(path, repository) {
  try {
    const data = JSON.parse(await readFile(path, "utf8"));
    if (
      data.schemaVersion !== 1 ||
      data.repository !== repository ||
      !Number.isFinite(Date.parse(data.through))
    )
      throw new Error("Checkpoint schema/repository is invalid.");
    return data.through;
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}
/**
 * @param {string[]} args
 * @param {(text: string) => Promise<void>} [output]
 * @param {{collect: typeof collect, currentRepository: typeof currentRepository, dependencyReport?: typeof dependencyReport, planDependencyChange?: typeof planDependencyChange, ghRun?: import("./dependencies.js").GhRun, planMigration?: typeof planMigration, migrationRuntime?: Record<string, any>}} [runtime]
 * @returns {Promise<number>}
 */
export async function main(
  args,
  output = (text) =>
    new Promise((resolve, reject) =>
      process.stdout.write(text, (error) => (error ? reject(error) : resolve())),
    ),
  runtime = { collect, currentRepository, dependencyReport },
) {
  if (args[0] === "deps") {
    const values = depsArgumentsFor(args.slice(1));
    if (values.help) {
      await output(depsHelp);
      return 0;
    }
    const repository = values.repo ?? (await runtime.currentRepository());
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("--repo must be owner/name.");
    if (values.migrate === "plan") {
      const plan = await (runtime.planMigration ?? planMigration)(
        repository,
        runtime.migrationRuntime,
      );
      await atomicJson(values.file, plan);
      await output(values.json ? JSON.stringify(plan, null, 2) + "\n" : migrationPlanText(plan));
      return 0;
    }
    if (values.action) {
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
  let snapshot;
  if (options.offline) snapshot = await cachedSnapshot(options.cache, options.repo);
  else {
    const repository = options.repo ?? (await runtime.currentRepository());
    const previous = options.checkpoint
      ? await checkpointSince(options.checkpoint, repository)
      : undefined;
    snapshot = await runtime.collect(repository, {
      issue: options.issue,
      since: options.since ?? previous,
    });
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
  const report = options.full ? expanded : compactBriefing(snapshot, options, expanded);
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
      : (options.full ? textReport(expanded) : compactText(report, options.maxChars)) +
          checkpointText,
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
 * @param {string | undefined} entry
 * @returns {boolean}
 */
function isEntryPoint(entry) {
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
    console.error(`triage: ${error.message}`);
    process.exitCode = 1;
  }
}
