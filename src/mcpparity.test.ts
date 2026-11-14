/**
 * CLI/MCP parity for blended role queues (#260, doc/design/mcp.md "Role views").
 *
 * Both front ends read the same fake GitHub boundary through the real collector, with the same
 * configuration, clock and identity, and must report identical role-shaped results.
 */
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vite-plus/test";
import { main } from "./cli.js";
import { TOML_CONFIG_PATH } from "./config.js";
import type { ConfigFileSystem, GitRunner } from "./config.js";
import { collect } from "./github.js";
import type { Query } from "./github.js";
import { createServer, envelope } from "./mcp.js";
import type { McpRuntime } from "./mcp.js";
import type { Issue, Page } from "./types.js";

const repo = "example/parity";
const time = "2026-11-12T10:00:00.000Z";
const clock = () => new Date(time);
const url = (n: number) => `https://github.com/${repo}/issues/${n}`;
const page = <T>(nodes: T[]): Page<T> => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});
const issue = (n: number, labels: string[], createdAt: string): Issue => ({
  number: n,
  title: `Ticket ${n}`,
  body: "",
  url: url(n),
  state: "OPEN",
  stateReason: null,
  createdAt,
  updatedAt: time,
  issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
  blockedBy: page([]),
  blocking: page([]),
  labels: page(labels.map((name) => ({ name }))),
  comments: page([]),
});
/** Easy win, cross-role boosts, conflicting labels, another agent's claim, design and parked work. */
const issues = (): Issue[] => [
  issue(1, ["status:ready", "impact:L", "complexity:S"], "2026-11-01T00:00:00Z"),
  issue(2, ["status:ready", "impact:XS", "complexity:XL"], "2026-10-01T00:00:00Z"),
  issue(3, ["status:ready", "impact:M", "complexity:M"], "2026-11-02T00:00:00Z"),
  issue(4, ["status:ready", "impact:XL"], "2026-11-03T00:00:00Z"),
  issue(5, ["status:needs-design", "complexity:XS"], "2026-11-04T00:00:00Z"),
  issue(6, ["status:ready", "complexity:S", "complexity:L"], "2026-11-05T00:00:00Z"),
  issue(7, ["status:ready"], "2026-09-01T00:00:00Z"),
  issue(8, ["status:ready", "agent:other", "impact:S"], "2026-11-07T00:00:00Z"),
  issue(9, ["status:parked", "impact:XL"], "2026-11-08T00:00:00Z"),
];
/** The fake gh GraphQL boundary: every query sees the same repository state. */
const query: Query = async (source) => ({
  repository: {
    issues: page(source.includes("issues(first") ? issues() : []),
    pullRequests: page([]),
  },
});
const root = "/repo";
const files = (config: string | null): ConfigFileSystem => ({
  readText: async (file) => (config && file === join(root, TOML_CONFIG_PATH) ? config : null),
  writeText: async () => undefined,
  rename: async () => undefined,
  remove: async () => undefined,
  makeDirectory: async () => undefined,
});
const git: GitRunner = async (args) =>
  args[0] === "rev-parse" ? `${root}\n` : `origin\thttps://github.com/${repo}.git (fetch)\n`;

const runtimeFor = (config: string | null): McpRuntime => {
  const fs = files(config);
  return {
    collect: (repository, options) => collect(repository, options, query, clock),
    currentRepository: async () => repo,
    dependencyReport: async () => {
      throw new Error("not used");
    },
    estimation: { fs, git, cwd: root },
    guide: { fs, git, cwd: root },
    now: clock,
    git,
    fs,
    env: {},
  };
};

interface Case {
  role: "implementer" | "designer";
  order: "impact" | "oldest";
  limit: number;
  config: string | null;
}

async function cliResult(c: Case): Promise<Record<string, unknown>> {
  let out = "";
  const code = await main(
    [
      "--repo",
      repo,
      "--agent",
      "me",
      "--role",
      c.role,
      "--order",
      c.order,
      "--limit",
      String(c.limit),
      "--json",
      "--no-update-check",
    ],
    async (text) => void (out += text),
    { ...runtimeFor(c.config), updateCheck: async () => ({ status: "disabled" }) as never },
  );
  expect(code).toBe(0);
  return JSON.parse(out) as Record<string, unknown>;
}

async function mcpResult(
  c: Case,
  omitLimit = false,
): Promise<{ result: Record<string, unknown>; text: string }> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer({ repo }, runtimeFor(c.config)).connect(serverSide);
  const client = new Client({ name: "parity", version: "1.0.0" });
  await client.connect(clientSide);
  try {
    const raw = await client.callTool({
      name: "triage_briefing",
      arguments: {
        agent: "me",
        role: c.role,
        order: c.order,
        ...(omitLimit ? {} : { limit: c.limit }),
      },
    });
    const parsed = envelope.parse(raw.structuredContent);
    expect(parsed.status).toBe("complete");
    const first: unknown = Array.isArray(raw.content) ? raw.content[0] : undefined;
    const text =
      typeof first === "object" && first !== null && "text" in first ? String(first.text) : "";
    return { result: parsed.result ?? {}, text };
  } finally {
    await client.close();
  }
}

const shared = ["actions", "role", "rankedActions", "estimation", "impactEstimation"] as const;
const kinds = (result: Record<string, unknown>): string[] =>
  ((result.rankedActions as { items: { kind: string; target: string }[] } | null)?.items ?? []).map(
    (i) => `${i.kind}#${i.target.split("/").pop()}`,
  );

describe("CLI and MCP report identical blended queues (#260)", () => {
  for (const role of ["implementer", "designer"] as const)
    for (const order of ["impact", "oldest"] as const)
      for (const limit of [20, 3])
        it(`${role}, order ${order}, limit ${limit}`, async () => {
          const c: Case = { role, order, limit, config: null };
          const cli = await cliResult(c);
          const mcp = await mcpResult(c);
          for (const key of shared) expect(mcp.result[key], key).toEqual(cli[key]);
          // The compared objects exist, not two equally absent fields.
          // impactEstimation is designer-only (#246); the implementer gets estimation (#259).
          const present = shared.filter((k) => role === "designer" || k !== "impactEstimation");
          for (const key of present) expect(cli[key], key).toBeTruthy();
          if (role === "implementer") expect(cli.impactEstimation).toBeUndefined();
          // The role queue is real, not two equally empty results.
          const ranked = cli.rankedActions as { total: number; omitted: number; items: unknown[] };
          expect(ranked.items.length).toBe(Math.min(limit, ranked.total));
          expect(ranked.omitted).toBe(ranked.total - ranked.items.length);
          // Assessments appear in ordinary role views without --estimate.
          const assessment = role === "implementer" ? "estimate-complexity" : "assess-impact";
          if (limit === 20) expect(kinds(cli).some((k) => k.startsWith(assessment))).toBe(true);
          // Rendered NEXT STEPS agree on order: every ranked target appears in both texts.
          for (const target of (cli.actions as { items: string[] }).items)
            expect(mcp.text).toContain(target);
        });

  it("keeps claim recovery commands and another agent's claim identical", async () => {
    const c: Case = { role: "implementer", order: "impact", limit: 20, config: null };
    const cli = await cliResult(c);
    const mcp = await mcpResult(c);
    const items = (mcp.result.rankedActions as { items: Record<string, unknown>[] }).items;
    expect(items[0]).toMatchObject({
      kind: "implement",
      nextCommand: `github-triage claim 1 --repo ${repo} --agent me`,
    });
    expect(kinds(mcp.result)).not.toContain("implement#8");
    expect(mcp.result.rankedActions).toEqual(cli.rankedActions);
  });

  it("agrees when a metric is disabled", async () => {
    const config = "schemaVersion = 1\n[complexity]\nenabled = false\n";
    const c: Case = { role: "implementer", order: "impact", limit: 20, config };
    const cli = await cliResult(c);
    const mcp = await mcpResult(c);
    for (const key of shared) expect(mcp.result[key], key).toEqual(cli[key]);
    expect(kinds(cli).some((k) => k.startsWith("estimate-complexity"))).toBe(false);
  });

  it("orders pickup by age under oldest in both front ends", async () => {
    const c: Case = { role: "implementer", order: "oldest", limit: 20, config: null };
    const pickup = (result: Record<string, unknown>) =>
      kinds(result).filter((k) => k.startsWith("implement#"));
    const cli = await cliResult(c);
    const mcp = await mcpResult(c);
    expect(pickup(mcp.result)).toEqual(pickup(cli));
    expect(pickup(cli)[0]).toBe("implement#7");
  });

  it("rejects role and order in briefing mode and unknown roles", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer({ repo }, runtimeFor(null)).connect(serverSide);
    const client = new Client({ name: "parity", version: "1.0.0" });
    await client.connect(clientSide);
    try {
      for (const args of [{ mode: "briefing", role: "implementer" }, { role: "owner" }]) {
        const result = await client.callTool({ name: "triage_briefing", arguments: args });
        expect(result.isError).toBe(true);
      }
      const { tools } = await client.listTools();
      const props = tools.find((t) => t.name === "triage_briefing")?.inputSchema.properties ?? {};
      expect(Object.keys(props)).toEqual(expect.arrayContaining(["role", "order"]));
    } finally {
      await client.close();
    }
  });

  it("leaves the MCP briefing unchanged without a role", async () => {
    const mcp = await mcpResult({ role: "implementer", order: "impact", limit: 5, config: null });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer({ repo }, runtimeFor(null)).connect(serverSide);
    const client = new Client({ name: "parity", version: "1.0.0" });
    await client.connect(clientSide);
    const plain = envelope.parse(
      (await client.callTool({ name: "triage_briefing", arguments: { agent: "me", limit: 5 } }))
        .structuredContent,
    );
    await client.close();
    expect(plain.result?.rankedActions).toBeNull();
    expect(mcp.result.rankedActions).not.toBeNull();
  });
});

it("uses ten MCP next actions when limit is omitted, matching the CLI default", async () => {
  const c: Case = { role: "implementer", order: "impact", limit: 10, config: null };
  const mcp = await mcpResult(c, true),
    cli = await cliResult(c);
  const ranked = mcp.result.rankedActions as { items: unknown[] };
  expect(ranked.items.length).toBe(10);
  expect(mcp.result.rankedActions).toEqual(cli.rankedActions);
});
