#!/usr/bin/env node
/**
 * Output-size and wall-time comparison of the CLI and the MCP adapter (#25, doc/design/mcp.md).
 *
 * Credential-free and offline: both interfaces run in this process over the same injected,
 * synthetic snapshot (no gh, no GitHub, no tokens). Every local boundary is injected too: the
 * workflow-guide and estimation settings read an empty in-memory filesystem and a fake git that
 * reports a synthetic checkout of the synthetic repository, so nothing depends on the machine
 * running the script. Subprocesses are forbidden for the whole run, and every measured output is
 * checked for the real working directory and home directory; either guard fails the run. The CLI is driven through `main` with an
 * injected runtime; the MCP server through the official SDK client over an in-memory transport.
 * Token counts are an approximation (characters / 4, rounded up), not a model tokenizer.
 *
 * Usage: npx tsx scripts/mcp-benchmark.ts [--issues N] [--runs N] [--json]
 */
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { McpRuntime } from "../src/mcp.js";
import {
  assertNoLocalPaths,
  emptyFileSystem,
  fakeGit,
  forbidSubprocesses,
  SYNTHETIC_ROOT,
} from "./benchmark-isolation.js";

// Before the modules under test load, so their child_process bindings are the throwing ones.
forbidSubprocesses();
const { main } = await import("../src/cli.js");
const { createServer } = await import("../src/mcp.js");

const { values } = parseArgs({
  options: {
    issues: { type: "string", default: "40" },
    runs: { type: "string", default: "25" },
    json: { type: "boolean" },
  },
});
const issueCount = Number(values.issues);
const runs = Number(values.runs);
const repo = "example/project";
const time = "2026-11-12T10:00:00.000Z";
const clock = () => new Date(time);
const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
const statuses = ["status:ready", "status:incomplete", "status:needs-design", "status:blocked"];

/** Deterministic synthetic repository: N open issues with bodies, labels and a few comments. */
const snapshot = (since: string | null = null) => ({
  schemaVersion: 1,
  repository: repo,
  startedAt: time,
  fetchedAt: time,
  issues: Array.from({ length: issueCount }, (_, i) => {
    const n = i + 1;
    return {
      number: n,
      title: `Synthetic ticket ${n}: improve component ${n % 7}`,
      body: `## Goal\nImprove component ${n % 7}.\n\n## Acceptance\n- Behaviour A\n- Behaviour B\n\n${"Context sentence. ".repeat(20)}`,
      url: `https://github.com/${repo}/issues/${n}`,
      state: "OPEN",
      stateReason: null,
      createdAt: time,
      updatedAt: time,
      issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
      blockedBy: page([]),
      blocking: page([]),
      labels: page([{ name: statuses[n % statuses.length] }]),
      comments: page(
        Array.from({ length: n % 4 }, (_, c) => ({
          author: { login: `agent${c}` },
          body: `Progress note ${c} on #${n}. ${"Detail. ".repeat(10)}`,
          createdAt: time,
          url: `https://github.com/${repo}/issues/${n}#issuecomment-${n * 10 + c}`,
        })),
      ),
    };
  }),
  pullRequests: [],
  dependencies: [],
  changed: since ? [{ number: 1, kind: "issue", updatedAt: time }] : [],
  since,
  warnings: [],
  rateLimit: null,
});

const local = { cwd: SYNTHETIC_ROOT, fs: emptyFileSystem, git: fakeGit(repo) };
const runtime: McpRuntime = {
  currentRepository: async () => repo,
  collect: (async (_r: string, options?: { since?: string }) =>
    snapshot(options?.since ?? null)) as unknown as McpRuntime["collect"],
  dependencyReport: (async () => {
    throw new Error("dependencies are not part of this benchmark");
  }) as McpRuntime["dependencyReport"],
  now: clock,
  guide: local,
  // Label-backed estimation reads only local configuration; it has no GitHub boundary.
  estimation: local,
};

const cli = async (args: string[]): Promise<string> => {
  let out = "";
  await main([...args, "--no-update-check"], async (t) => void (out += t), {
    ...runtime,
    stderr: () => {},
  });
  return out;
};

const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await createServer({ repo }, runtime).connect(serverSide);
const client = new Client({ name: "benchmark", version: "1.0.0" });
await client.connect(clientSide);
const mcp = (name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args });

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};
const timed = async (f: () => Promise<unknown>): Promise<number> => {
  await f(); // warm-up, excluded
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await f();
    samples.push(performance.now() - start);
  }
  return median(samples);
};
const tokens = (chars: number): number => Math.ceil(chars / 4);

interface Row {
  scenario: string;
  output: string;
  chars: number;
  approxTokens: number;
  medianMs: number;
}
const rows: Row[] = [];
const add = (scenario: string, output: string, text: string, ms: number) => {
  assertNoLocalPaths(`${scenario} / ${output}`, text);
  rows.push({
    scenario,
    output,
    chars: text.length,
    approxTokens: tokens(text.length),
    medianMs: ms,
  });
};

const scenarios: { name: string; cli: string[]; tool: string; args: Record<string, unknown> }[] = [
  { name: "briefing", cli: ["--repo", repo], tool: "triage_briefing", args: {} },
  {
    name: "implementer intake (issue 3, agent)",
    cli: ["--repo", repo, "--issue", "3", "--agent", "ana"],
    tool: "triage_issue",
    args: { number: 3, agent: "ana" },
  },
  {
    name: "since catch-up",
    cli: ["--repo", repo, "--since", "2026-11-11T00:00:00Z"],
    tool: "triage_briefing",
    args: { since: "2026-11-11T00:00:00Z" },
  },
];

for (const s of scenarios) {
  const cliText = await cli(s.cli);
  add(s.name, "CLI text", cliText, await timed(() => cli(s.cli)));
  const cliJson = await cli([...s.cli, "--json"]);
  const cliMs = await timed(() => cli([...s.cli, "--json"]));
  add(s.name, "CLI --json (as printed, indented)", cliJson, cliMs);
  // The CLI pretty-prints; minified is the like-for-like comparison with structuredContent.
  add(s.name, "CLI --json (minified)", JSON.stringify(JSON.parse(cliJson)), cliMs);
  const result = await mcp(s.tool, s.args);
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  const content = first && "text" in first ? String(first.text) : "";
  const ms = await timed(() => mcp(s.tool, s.args));
  add(s.name, "MCP content text", content, ms);
  add(s.name, "MCP structuredContent", JSON.stringify(result.structuredContent), ms);
  add(s.name, "MCP full result (both)", JSON.stringify(result), ms);
}
await client.close();

if (values.json) {
  console.log(JSON.stringify({ issueCount, runs, node: process.version, rows }, null, 2));
} else {
  console.log(
    `Synthetic issues: ${issueCount}; timed runs per row: ${runs}; Node ${process.version}`,
  );
  console.log("| Scenario | Output | Characters | ~Tokens (chars/4) | Median ms |");
  console.log("|---|---|---:|---:|---:|");
  for (const r of rows)
    console.log(
      `| ${r.scenario} | ${r.output} | ${r.chars} | ${r.approxTokens} | ${r.medianMs.toFixed(2)} |`,
    );
}
