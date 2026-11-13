/**
 * `github-triage briefing`: the repository catch-up command (#170, slice 3 of
 * doc/design/briefing-mode.md). Argument validation, the checkpoint and cache files and the
 * offline mode live here; window resolution is `changes.ts`, collection `github.ts` and the
 * report `catchup.ts`. GitHub is only read. The checkpoint is written last, only after the
 * complete live report was delivered, and only to that report's candidate (the window end T0).
 */
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { abbreviate, catchUp, catchUpJson, catchUpLimits, catchUpText } from "./catchup.js";
import type { CatchUpReport } from "./catchup.js";
import { parseDuration, parseSince, resolveWindow } from "./changes.js";
import type { ComparisonWindow, WindowRequest } from "./changes.js";
import type { collect } from "./github.js";
import type { Snapshot } from "./types.js";

/** A checkpoint path for text output: long paths keep their start and end; --json has it whole. */
export const checkpointLabel = (path: string): string =>
  path.length <= 80 ? path : `${abbreviate(path, 80)} (path truncated; see --json)`;

/** Filesystem boundary of the briefing command; tests inject failures per phase. */
export interface BriefingFiles {
  /** Recorded `through` of a valid checkpoint, undefined when the file is missing. */
  checkpointSince: (path: string, repository: string) => Promise<string | undefined>;
  cachedSnapshot: (path: string, repository: string | undefined) => Promise<Snapshot>;
  atomicJson: (path: string, value: unknown) => Promise<void>;
  /** Where a path really lands; defaults to the real filesystem (`fileIdentity`). */
  identity?: (path: string) => Promise<FileIdentity>;
}
/** Resolved destination of a path: absolute, symlink-free, and the inode when it exists. */
export interface FileIdentity {
  resolved: string;
  real: string;
  inode?: { dev: number; ino: number };
}

/**
 * Resolve `path` absolutely, through symlinks of the file or of its nearest existing ancestor.
 * When the file does not exist, the nearest existing ancestor is realpath-ed and the missing
 * components (already normalised by `resolve`) are re-appended, so two paths that differ only by
 * a symlinked ancestor above a missing directory still compare equal.
 */
export async function fileIdentity(
  path: string,
  realpathOf: (path: string) => Promise<string> = realpath,
): Promise<FileIdentity> {
  const resolved = resolve(path);
  let real = resolved;
  let inode: FileIdentity["inode"];
  try {
    real = await realpathOf(resolved);
    const info = await stat(real);
    inode = { dev: info.dev, ino: info.ino };
  } catch {
    const missing: string[] = [];
    let ancestor = resolved;
    for (;;) {
      const parent = dirname(ancestor);
      missing.unshift(basename(ancestor));
      if (parent === ancestor) break;
      ancestor = parent;
      try {
        real = join(await realpathOf(ancestor), ...missing);
        break;
      } catch {
        // Keep walking up to the nearest existing ancestor.
      }
    }
  }
  return { resolved, real, inode };
}

/** True when the two identities name the same destination file. */
export function sameDestination(a: FileIdentity, b: FileIdentity): boolean {
  if (a.resolved === b.resolved || a.real === b.real) return true;
  // Hard links, and case-insensitive filesystems where the paths differ only by case.
  return (
    a.inode !== undefined &&
    b.inode !== undefined &&
    a.inode.dev === b.inode.dev &&
    a.inode.ino === b.inode.ino
  );
}
/** The requested window cannot be resolved (e.g. it starts after T0); nothing was collected. */
export class WindowRefusal extends Error {}

/**
 * Resolve one anchor T0 and collect a live snapshot with that change window. Shared by the CLI
 * and the read-only MCP briefing mode (#171); a future start is rejected before collection.
 */
export async function collectBriefing(
  collector: typeof collect,
  repository: string,
  request: WindowRequest,
  now: () => Date,
  signal?: AbortSignal,
): Promise<{ window: ComparisonWindow; snapshot: Snapshot }> {
  let window: ComparisonWindow;
  try {
    window = resolveWindow(request, now);
  } catch (error) {
    throw new WindowRefusal(error instanceof Error ? error.message : String(error));
  }
  const snapshot = await collector(repository, {
    changeWindow: window,
    ...(signal ? { signal } : {}),
  });
  return { window, snapshot };
}

export interface BriefingRuntime {
  collect: typeof collect;
  currentRepository: () => Promise<string>;
  now?: () => Date;
  stderr?: (text: string) => void;
  files: BriefingFiles;
}

export const briefingUsage =
  "Usage: github-triage briefing [--repo owner/name] [--last DURATION | --since ISO | --checkpoint PATH] [--agent NAME] [--json] [--limit N] [--max-chars N] [--cache PATH] [--no-update-check]\n       github-triage briefing --offline --cache PATH [--repo owner/name] [--agent NAME] [--json] [--limit N] [--max-chars N]";

export const briefingHelp = `${briefingUsage}
(From a source checkout, use npm run triage -- briefing ...)
Read-only repository catch-up: what changed in a window, and what needs attention now.
Five sections: owner attention (always first), completed/disposed, progress, blockers/risks,
current activity. History sections use the window; the others are current observations.
Window (choose at most one; default --last 24h):
  --last DURATION       Fixed elapsed UTC duration: positive integer + m, h or d (90m, 24h, 7d)
  --since ISO           Start time with a timezone, e.g. 2026-11-13T09:00:00Z
  --checkpoint PATH     Start at the time recorded in PATH (a missing file establishes a
                        baseline). Advanced to this run's collection start only after a
                        complete live report was delivered; never on incomplete, failed,
                        cancelled or offline runs. Use one file per repository and reader
Options:
  --repo owner/name     Repository (default: current gh checkout)
  --agent NAME          Viewer: highlights attention addressed to NAME; never filters history
  --json                Versioned report (schemaVersion 1, kind repository-briefing)
  --limit N             Rows per section, ${catchUpLimits.limit.min}-${catchUpLimits.limit.max} (default ${catchUpLimits.limit.default})
  --max-chars N         Text budget, ${catchUpLimits.maxChars.min}-${catchUpLimits.maxChars.max} (default ${catchUpLimits.maxChars.default})
  --cache PATH          Save the collected evidence, with its window, atomically
  --offline             Read --cache PATH only: no GitHub or update calls, the recorded window,
                        no checkpoint; --last, --since and --checkpoint are refused
  --no-update-check     Skip the npm version check
  --help                Show usage
Scope: issues and pull requests (reviews, checks, workflow labels, claims, native links).
Not covered: releases, npm publication, deployments, file diffs, transient label history.
A merged PR is not proof of a release. Agent names are reported attribution, not
authenticated identity. Missing evidence is reported as unknown, never as no change.
Example: github-triage briefing --repo owner/name --checkpoint ~/.config/github-triage/owner-name.json
Exit: 0 complete; 2 incomplete or unavailable evidence; 1 invalid arguments, operational
failure or checkpoint write failure (stderr says how to recover).
`;

export interface BriefingArguments {
  help?: boolean;
  repo?: string;
  agent?: string;
  json: boolean;
  limit: number;
  maxChars: number;
  cache?: string;
  offline: boolean;
  last?: string;
  since?: string;
  checkpoint?: string;
}

/** Validate every briefing argument before any file or GitHub read. */
export function briefingArgumentsFor(args: string[]): BriefingArguments {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        repo: { type: "string" },
        agent: { type: "string" },
        json: { type: "boolean" },
        limit: { type: "string" },
        "max-chars": { type: "string" },
        cache: { type: "string" },
        offline: { type: "boolean" },
        last: { type: "string" },
        since: { type: "string" },
        checkpoint: { type: "string" },
        help: { type: "boolean" },
      },
    });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${briefingUsage}`);
  }
  const { values } = parsed;
  if (values.help) return { help: true, json: false, offline: false, limit: 0, maxChars: 0 };
  if (values.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    throw new Error("--repo must be owner/name.");
  if (values.agent !== undefined && !/^[A-Za-z0-9][\w.-]*$/.test(values.agent))
    throw new Error("--agent must be an agent name such as kavya_sabbagh.");
  const bounded = (
    text: string | undefined,
    option: string,
    range: { default: number; min: number; max: number },
  ) => {
    if (text === undefined) return range.default;
    const n = Number(text);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(n) || n < range.min || n > range.max)
      throw new Error(`${option} must be an integer from ${range.min} to ${range.max}.`);
    return n;
  };
  const limit = bounded(values.limit, "--limit", catchUpLimits.limit);
  const maxChars = bounded(values["max-chars"], "--max-chars", catchUpLimits.maxChars);
  const sources = (["last", "since", "checkpoint"] as const).filter((k) => values[k] !== undefined);
  if (sources.length > 1)
    throw new Error(
      `Choose one window source; got ${sources.map((k) => `--${k}`).join(" and ")}.\n${briefingUsage}`,
    );
  if (values.offline) {
    if (!values.cache) throw new Error("--offline requires --cache PATH.");
    if (sources.length)
      throw new Error(
        `--${sources[0]} needs a live read; offline mode reports only the window recorded in the cache.`,
      );
  }
  if (values.checkpoint !== undefined && !values.checkpoint.trim())
    throw new Error("--checkpoint needs a file path.");
  if (values.cache !== undefined && !values.cache.trim())
    throw new Error("--cache needs a file path.");
  // Syntax only here; a start after the collection anchor is rejected by resolveWindow.
  if (values.last !== undefined) parseDuration(values.last);
  if (values.since !== undefined) parseSince(values.since);
  return {
    repo: values.repo,
    agent: values.agent,
    json: !!values.json,
    limit,
    maxChars,
    cache: values.cache,
    offline: !!values.offline,
    last: values.last,
    since: values.since,
    checkpoint: values.checkpoint,
  };
}

/** A local file problem, reported without stack traces or unrelated paths. */
class FileRefusal extends Error {
  constructor(
    readonly file: "checkpoint" | "cache",
    readonly path: string,
    readonly reason: string,
    readonly next: string,
  ) {
    super(`${file} ${path}: ${reason}`);
  }
}
const describe = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return `filesystem error ${code}`;
  if (error instanceof SyntaxError) return "not valid JSON";
  return error instanceof Error ? error.message : String(error);
};

/** Run `briefing`; returns the exit code. */
export async function runBriefing(
  args: string[],
  output: (text: string) => Promise<void>,
  runtime: BriefingRuntime,
): Promise<number> {
  const options = briefingArgumentsFor(args);
  if (options.help) {
    await output(briefingHelp);
    return 0;
  }
  const stderr = runtime.stderr ?? ((text: string) => void process.stderr.write(text));
  const now = runtime.now ?? (() => new Date());
  try {
    return await deliver(options, output, runtime, now, stderr);
  } catch (error) {
    if (!(error instanceof FileRefusal)) throw error;
    const refusal = {
      schemaVersion: 1,
      kind: "repository-briefing-refusal",
      file: error.file,
      path: error.path,
      reason: error.reason,
      next: error.next,
      checkpointAdvanced: false,
    };
    if (options.json) await output(JSON.stringify(refusal, null, 2) + "\n");
    else
      stderr(
        `triage: briefing refused: ${error.file} ${error.path}: ${error.reason}\nNext: ${error.next}\n`,
      );
    return 1;
  }
}

async function deliver(
  options: BriefingArguments,
  output: (text: string) => Promise<void>,
  runtime: BriefingRuntime,
  now: () => Date,
  stderr: (text: string) => void,
): Promise<number> {
  const files = runtime.files;
  if (!options.offline && options.cache !== undefined && options.checkpoint !== undefined) {
    // Before any read or write: a shared file would let the cache overwrite the checkpoint.
    const identify = files.identity ?? fileIdentity;
    const [cache, checkpoint] = await Promise.all([
      identify(options.cache),
      identify(options.checkpoint),
    ]);
    if (sameDestination(cache, checkpoint))
      throw new FileRefusal(
        "cache",
        options.cache,
        `--cache and --checkpoint resolve to the same file (${checkpoint.real}); the cache would overwrite the checkpoint`,
        "Give --cache and --checkpoint different file paths, for example --cache briefing-cache.json; nothing was read or written.",
      );
  }
  let snapshot: Snapshot;
  if (options.offline) {
    const cache = options.cache!;
    try {
      snapshot = await files.cachedSnapshot(cache, options.repo);
    } catch (error) {
      throw new FileRefusal(
        "cache",
        cache,
        describe(error),
        `Refresh it live: github-triage briefing${options.repo ? ` --repo ${options.repo}` : ""} --cache ${cache}`,
      );
    }
  } else {
    const repository = options.repo ?? (await runtime.currentRepository());
    let checkpoint: { through: string | null } | undefined;
    if (options.checkpoint !== undefined) {
      try {
        checkpoint = {
          through: (await files.checkpointSince(options.checkpoint, repository)) ?? null,
        };
      } catch (error) {
        // Never silently reset a cursor: the caller decides whether to replace the file.
        throw new FileRefusal(
          "checkpoint",
          options.checkpoint,
          describe(error),
          `Inspect or move the file, or run once with --since ISO --repo ${repository}; a missing file starts a new baseline.`,
        );
      }
    }
    // One anchor T0 before collection; a future checkpoint or --since is rejected here.
    ({ snapshot } = await collectBriefing(
      runtime.collect,
      repository,
      { last: options.last, since: options.since, checkpoint },
      now,
    ));
    if (options.cache) {
      try {
        await files.atomicJson(options.cache, snapshot);
      } catch (error) {
        throw new FileRefusal(
          "cache",
          options.cache,
          `write failed (${describe(error)})`,
          `Choose a writable --cache path, or omit --cache; no checkpoint was advanced.`,
        );
      }
    }
  }
  const built = catchUp(snapshot, { agent: options.agent, limit: options.limit, now });
  const complete = built.checkpoint.candidate !== null;
  const offlineAge = Math.max(0, now().getTime() - Date.parse(snapshot.fetchedAt));
  const report: CatchUpReport & {
    offline: { cachedAt: string; ageMinutes: number; notice: string } | null;
  } = options.offline
    ? {
        ...built,
        offline: {
          cachedAt: snapshot.fetchedAt,
          ageMinutes: Math.floor(offlineAge / 60_000),
          notice:
            "Offline: recorded cache evidence and its recorded window; no GitHub or update calls. Offline runs cannot advance live checkpoints.",
        },
        checkpoint: {
          policy:
            "Offline runs never advance a checkpoint; run live with --checkpoint PATH to advance one.",
          candidate: null,
        },
      }
    : {
        ...built,
        offline: null,
        checkpoint: options.checkpoint
          ? {
              ...built.checkpoint,
              policy: `${built.checkpoint.policy} Requested checkpoint: ${options.checkpoint}.`,
            }
          : built.checkpoint,
      };
  const notices = options.offline
    ? [
        `OFFLINE: cache from ${snapshot.fetchedAt} (${report.offline!.ageMinutes} min old); recorded window only; cannot advance live checkpoints.`,
      ]
    : options.checkpoint
      ? [
          complete
            ? `Checkpoint ${checkpointLabel(options.checkpoint)}: candidate ${built.checkpoint.candidate}, written only after this report is delivered.`
            : `Checkpoint ${checkpointLabel(options.checkpoint)}: NOT advanced (incomplete evidence); rerun to retry the same window.`,
        ]
      : [];
  const text = options.json ? catchUpJson(report) : catchUpText(report, options.maxChars, notices);
  // Invariant: a checkpoint only advances past text that showed the window it replaces.
  if (!options.json && !/^Window /m.test(text))
    throw new Error(
      "Internal error: briefing text lost its comparison window; no checkpoint was advanced.",
    );
  await output(text);
  if (!options.offline && options.checkpoint && complete) {
    try {
      await files.atomicJson(options.checkpoint, {
        schemaVersion: 1,
        repository: snapshot.repository,
        through: built.checkpoint.candidate,
      });
    } catch (error) {
      // The report is already on stdout; never append a second JSON object there.
      stderr(
        `triage: checkpoint ${options.checkpoint} was not advanced (${describe(error)}). The previous checkpoint, if any, still applies; rerun the same command to retry.\n`,
      );
      return 1;
    }
  }
  return complete ? 0 : 2;
}
