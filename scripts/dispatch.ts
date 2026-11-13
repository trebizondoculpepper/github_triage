/**
 * Explicit publication requests (#79, doc/npm-releases.md "Explicit operations").
 *
 * Both helpers resolve the source commit once and pass its full SHA to the Publish workflow,
 * which refuses to publish if the dispatched branch has moved since. A retry reuses the same
 * SHA (`-- --sha SHA`) and never re-resolves main, so it cannot pick up newer work.
 *
 * - make-prerelease: dispatch channel=next on main.
 * - release: fast-forward `release` to the commit (never force), then dispatch channel=latest
 *   on release. The push alone publishes nothing.
 */
import { execFileSync } from "node:child_process";

const SHA = /^[0-9a-f]{40}$/;

export type Runner = (command: "git" | "gh", args: string[]) => string;
export type Kind = "prerelease" | "release";
export interface DispatchOptions {
  help?: boolean;
  sha?: string;
}

export const defaultRunner: Runner = (command, args) =>
  execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export const helpText: Record<Kind, string> = {
  prerelease: `Usage: npm run make-prerelease [-- --sha SHA]
Explicitly publish a prerelease of origin/main to npm "next" (doc/npm-releases.md, #79).
Resolves origin/main once and dispatches the Publish workflow on main with that full SHA.
The workflow verifies the commit, refuses if main moved since, chooses the next -next.1
version from publication history, and changes only the "next" dist-tag.
  --sha SHA   Retry a request for exactly this commit (no re-resolution of main)
Requires: gh authenticated with permission to dispatch workflows; NPM_PUBLISH=true.
(Named make-prerelease, not prerelease: npm would run a "prerelease" script automatically
before every "npm run release".)`,
  release: `Usage: npm run release [-- --sha SHA]
Explicitly publish an official release of origin/main to npm "latest" (doc/npm-releases.md).
Resolves origin/main once, fast-forwards the release branch to it (never a force push; the
push publishes nothing), then dispatches the Publish workflow on release with that full SHA.
The workflow verifies the commit, refuses if release moved since, publishes the next minor
version, and creates the matching vX.Y.Z tag and GitHub release.
  --sha SHA   Retry for exactly this commit: promotes it if needed, then dispatches again
Requires: gh authenticated with push and workflow-dispatch permission; NPM_PUBLISH=true.`,
};

export function parseArgs(args: string[]): DispatchOptions {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const i = args.indexOf("--sha");
  if (i >= 0) {
    const sha = args[i + 1];
    if (!SHA.test(sha ?? "")) throw new Error("--sha needs a full 40-character commit SHA.");
    if (args.length !== 2) throw new Error("Only --sha SHA or --help are accepted.");
    return { sha };
  }
  if (args.length) throw new Error(`Unknown arguments: ${args.join(" ")}`);
  return {};
}

const dispatch = (run: Runner, ref: string, channel: string, sha: string): string =>
  run("gh", [
    "workflow",
    "run",
    "publish.yml",
    "--ref",
    ref,
    "-f",
    `channel=${channel}`,
    "-f",
    `sha=${sha}`,
  ]);

/** Resolve origin/main's head once, or validate a retry SHA is on main. */
function selectCommit(run: Runner, sha: string | undefined): string {
  run("git", ["fetch", "--no-tags", "origin", "main"]);
  if (!sha) return run("git", ["rev-parse", "origin/main"]);
  try {
    run("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);
  } catch {
    throw new Error(`${sha} is not on origin/main.`);
  }
  return sha;
}

/** Returns the lines reported to the user. */
export function makePrerelease(
  { sha }: DispatchOptions = {},
  run: Runner = defaultRunner,
): string[] {
  const commit = selectCommit(run, sha);
  try {
    dispatch(run, "main", "next", commit);
  } catch {
    throw new Error(
      `Could not dispatch the Publish workflow for ${commit}. Nothing was published. Retry with: npm run make-prerelease -- --sha ${commit}`,
    );
  }
  return [
    `Requested a prerelease of ${commit} on npm "next". The Publish workflow verifies and publishes it.`,
    `If main has moved before the workflow starts, it refuses; request again. Watch: gh run list --workflow publish.yml`,
  ];
}

export function release({ sha }: DispatchOptions = {}, run: Runner = defaultRunner): string[] {
  const commit = selectCommit(run, sha);
  const lines: string[] = [];
  let current = "";
  if (run("git", ["ls-remote", "--heads", "origin", "release"])) {
    run("git", ["fetch", "--no-tags", "origin", "release"]);
    current = run("git", ["rev-parse", "origin/release"]);
  }
  if (current !== commit) {
    if (current) {
      try {
        run("git", ["merge-base", "--is-ancestor", current, commit]);
      } catch {
        throw new Error(
          `origin/release (${current}) is not an ancestor of ${commit}; refusing to rewrite release history.`,
        );
      }
    }
    run("git", ["push", "origin", `${commit}:refs/heads/release`]);
    lines.push(`Promoted ${commit} to release (this push publishes nothing).`);
  } else lines.push(`release already points at ${commit}.`);
  try {
    dispatch(run, "release", "latest", commit);
  } catch {
    throw new Error(
      `${lines.join(" ")} Could not dispatch the Publish workflow, so nothing was published. Retry the same commit with: npm run release -- --sha ${commit}`,
    );
  }
  lines.push(
    `Requested an official release of ${commit} on npm "latest", with its tag and GitHub release. Watch: gh run list --workflow publish.yml`,
  );
  return lines;
}

/** CLI entry shared by scripts/release.ts and scripts/make-prerelease.ts. */
export function main(
  kind: Kind,
  argv: string[] = process.argv.slice(2),
  run: Runner = defaultRunner,
): number {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log(helpText[kind]);
      return 0;
    }
    const lines = kind === "release" ? release(options, run) : makePrerelease(options, run);
    for (const line of lines) console.log(line);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
