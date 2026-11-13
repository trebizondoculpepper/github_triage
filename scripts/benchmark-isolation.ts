/**
 * Isolation for scripts/mcp-benchmark.ts: deterministic in-memory local boundaries and guards
 * that fail loudly if a benchmark run touches real local state (subprocesses, the real
 * checkout, the real home directory).
 */
import { createRequire, syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import type { ConfigFileSystem, GitRunner } from "../src/config.js";

/** Synthetic checkout root; never a real path on the measuring machine. */
export const SYNTHETIC_ROOT = "/synthetic/checkout";

/** Fake git: the synthetic checkout with a single GitHub remote for `repository`. */
export const fakeGit =
  (repository: string): GitRunner =>
  async (args) => {
    const command = args.join(" ");
    if (command === "rev-parse --show-toplevel") return `${SYNTHETIC_ROOT}\n`;
    if (command === "remote -v")
      return `origin\thttps://github.com/${repository}.git (fetch)\norigin\thttps://github.com/${repository}.git (push)\n`;
    throw new Error(`benchmark isolation: unexpected git ${command}`);
  };

/** Empty, read-only in-memory filesystem: no configuration file exists; writes are refused. */
export const emptyFileSystem: ConfigFileSystem = {
  readText: async () => null,
  writeText: async (path) => {
    throw new Error(`benchmark isolation: unexpected write ${path}`);
  },
  rename: async (from) => {
    throw new Error(`benchmark isolation: unexpected rename ${from}`);
  },
  remove: async (path) => {
    throw new Error(`benchmark isolation: unexpected remove ${path}`);
  },
  makeDirectory: async (path) => {
    throw new Error(`benchmark isolation: unexpected mkdir ${path}`);
  },
};

const SPAWNERS = [
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
] as const;

/**
 * Replace every child_process entry point with one that throws, including for ESM named
 * imports. Must run before the modules under test are imported. Returns a restore function.
 */
export function forbidSubprocesses(): () => void {
  const childProcess = createRequire(import.meta.url)("node:child_process") as Record<
    string,
    unknown
  >;
  const saved = SPAWNERS.map((name) => [name, childProcess[name]] as const);
  for (const name of SPAWNERS)
    childProcess[name] = () => {
      throw new Error(`benchmark isolation: subprocess via child_process.${name} is forbidden`);
    };
  syncBuiltinESMExports();
  return () => {
    for (const [name, original] of saved) childProcess[name] = original;
    syncBuiltinESMExports();
  };
}

/** Local paths that must never appear in benchmark output. */
export const localPaths = (): string[] =>
  [process.cwd(), homedir()].filter((path) => path && path !== "/");

/** Throw if `text` contains any local path; `label` names the output in the error. */
export function assertNoLocalPaths(
  label: string,
  text: string,
  paths: readonly string[] = localPaths(),
): void {
  for (const path of paths)
    if (text.includes(path))
      throw new Error(`benchmark isolation: ${label} contains local path ${path}`);
}
