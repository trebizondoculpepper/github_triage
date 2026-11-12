#!/usr/bin/env node
/** One read-only intake command. Contract: doc/github-triage-cli.md. */
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { collect, currentRepository } from "./github.js";
import { dependencyReport, dependencyText } from "./dependencies.js";
import { compactBriefing, compactText } from "./compact.js";
import { briefing, textReport } from "./briefing.js";

export const help = `Usage: npm run triage -- [options]
Read-only LLM action briefing. Requires authenticated gh and Node 20+.
  deps N [--tree]       Read native upstream/downstream dependencies (deps --help)
  --repo owner/name     Repository (default: current gh checkout)
  --json                Versioned structured output (use npm run --silent triage)
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
No GitHub mutations. Question/dependency hints require inspection, not blind action.
`;
export const depsHelp = `Usage: npm run triage -- deps N [--tree] [--json] [--repo owner/name]
Read-only native GitHub issue dependencies for issue N.
  --tree                Follow blockers and dependants transitively; report cycles
  --json                Versioned structured output (use npm run --silent triage)
  --repo owner/name     Repository (default: current gh checkout)
  --help                Show usage
Exit: 0 report printed; 1 invalid arguments/API failure.
No GitHub mutations. deps add/remove and migrate are not implemented yet.
`;
/**
 * @param {string[]} args
 * @returns {{ number?: number, repo?: string, json?: boolean, tree?: boolean, help?: boolean }}
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
    },
  });
  if (values.help) return { help: true };
  if (
    positionals.length !== 1 ||
    !/^[1-9]\d*$/.test(positionals[0]) ||
    !Number.isSafeInteger(Number(positionals[0]))
  )
    throw new Error("Usage: deps N [--tree] [--json] [--repo owner/name]");
  if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    throw new Error("--repo must be owner/name.");
  return { ...values, number: Number(positionals[0]) };
}
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
 * @param {{collect: typeof collect, currentRepository: typeof currentRepository, dependencyReport?: typeof dependencyReport}} [runtime]
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
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`triage: ${error.message}`);
    process.exitCode = 1;
  }
}
