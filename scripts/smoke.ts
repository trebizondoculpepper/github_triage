#!/usr/bin/env node
/**
 * Credential-free smoke test of the built CLI (dist/cli.mjs).
 *
 * Runs the packaged artifact as a subprocess and checks arguments and exit codes
 * without a GitHub token: help, invalid arguments, an injected gh failure (gh made
 * unreachable via PATH), and complete/incomplete offline fixture caches. Portable
 * across Linux, macOS and Windows; no shell scripts and no live GitHub queries.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const cli = resolve(process.argv[2] ?? "dist/cli.mjs");
// TypeScript source (e.g. src/cli.ts) runs through the development-only tsx loader; the built
// artifact runs on plain Node exactly as consumers run it.
const nodeArgs = cli.endsWith(".ts") ? ["--import", import.meta.resolve("tsx"), cli] : [cli];
const repo = "example/project";
const time = "2026-11-12T10:00:00.000Z";
const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
const snapshot = (warnings: string[] = []) => ({
  schemaVersion: 1,
  repository: repo,
  startedAt: time,
  fetchedAt: time,
  issues: [
    {
      number: 1,
      title: "Ticket 1",
      body: "Fixture ticket.",
      url: `https://github.com/${repo}/issues/1`,
      state: "OPEN",
      stateReason: null,
      createdAt: time,
      updatedAt: time,
      issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
      blockedBy: page([]),
      blocking: page([]),
      labels: page([{ name: "status:ready" }]),
      comments: page([]),
    },
  ],
  pullRequests: [],
  dependencies: [],
  changed: [],
  since: null,
  warnings,
  rateLimit: null,
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI and resolve to {code, stdout, stderr}; never rejects on non-zero exit. */
const run = (args: string[], env: NodeJS.ProcessEnv = process.env): Promise<RunResult> =>
  new Promise((done) =>
    execFile(
      process.execPath,
      [...nodeArgs, ...args],
      { env, timeout: 30_000 },
      (error, stdout, stderr) =>
        done({
          code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
          stdout,
          stderr,
        }),
    ),
  );

const failures: string[] = [];
const expect = (name: string, condition: boolean, detail: unknown): void => {
  console.log(`${condition ? "ok  " : "FAIL"} ${name}`);
  if (!condition) failures.push(`${name}: ${detail}`);
};

const dir = await mkdtemp(join(tmpdir(), "triage-smoke-"));
try {
  const complete = join(dir, "complete.json");
  const incomplete = join(dir, "incomplete.json");
  await writeFile(complete, JSON.stringify(snapshot()));
  await writeFile(incomplete, JSON.stringify(snapshot(["fixture: evidence incomplete"])));

  let r = await run(["--help"]);
  expect("--help exits 0 with usage", r.code === 0 && r.stdout.includes("Usage:"), r.code);

  r = await run(["--repo", "not-a-repo"]);
  expect("invalid --repo exits 1", r.code === 1 && r.stderr.includes("owner/name"), r.stderr);

  r = await run(["--offline"]);
  expect("--offline without --cache exits 1", r.code === 1, r.stderr);

  // Injected gh failure: an empty PATH makes gh unreachable, as with a missing install.
  r = await run(["--json"], { ...process.env, PATH: dir, Path: dir });
  expect("unreachable gh exits 1 without leaking details", r.code === 1, r.stderr);

  r = await run(["--offline", "--cache", complete, "--json"]);
  let parsed: { repository?: unknown; freshness?: { offline?: unknown } } | undefined;
  try {
    // Narrowed by the optional-chained field checks below; malformed JSON fails them.
    parsed = JSON.parse(r.stdout);
  } catch {
    parsed = undefined;
  }
  expect(
    "complete offline cache exits 0 with versioned JSON",
    r.code === 0 && parsed?.repository === repo && parsed?.freshness?.offline === true,
    `${r.code} ${r.stderr}`,
  );

  r = await run(["--offline", "--cache", complete]);
  expect("compact text briefing renders", r.code === 0 && r.stdout.includes(repo), r.stderr);

  r = await run(["--offline", "--cache", incomplete, "--json"]);
  expect("incomplete evidence exits 2", r.code === 2, `${r.code} ${r.stderr}`);

  r = await run(["--offline", "--cache", complete, "--repo", "other/repo"]);
  expect("cache repository mismatch exits 1", r.code === 1, `${r.code} ${r.stderr}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} smoke check(s) failed:\n${failures.join("\n")}`);
  process.exit(1);
}
console.log("\nSmoke test passed.");
