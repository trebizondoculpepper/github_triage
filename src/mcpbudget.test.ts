/**
 * Whole-result budget for MCP reads (#266, doc/design/mcp-bounded-results.md).
 *
 * A realistic large synthetic repository (bodies, long histories, Unicode, a giant title, many
 * actions) is read through the real collector presentation and a real SDK client. Every test
 * measures the serialized CallToolResult as the client receives it, not just the text.
 */
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vite-plus/test";
import { main } from "./cli.js";
import { boundedEnvelope, budgetBytes, budgetErrorCode, resultBytes } from "./mcp/bounded.js";
import { boundedResult } from "./mcp/bounded.js";
import { flattenRelationships } from "./mcp/views.js";
import { parityDifference, parsePath } from "./mcp/parity.js";
import { createServer } from "./mcp.js";
import type { McpRuntime } from "./mcp.js";
import type { DependencyReport } from "./github/dependencies.js";

const repo = "example/large";
const time = "2026-11-12T10:00:00.000Z";
const clock = () => new Date(time);
const page = (nodes: unknown[], hasNextPage = false) => ({
  nodes,
  pageInfo: { hasNextPage, endCursor: null },
});
const statuses = ["status:ready", "status:incomplete", "status:needs-design", "status:blocked"];
const url = (n: number) => `https://github.com/${repo}/issues/${n}`;
const unicode = "Ünïcödé — 日本語のテキスト 🚀 ";

/** About the sizes the #266 report measured: 140 issues, long bodies and comment histories. */
const issues = (count = 140) =>
  Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    const giant = n === 7;
    return {
      number: n,
      title: giant ? `Giant title ${unicode.repeat(80)}` : `Synthetic ticket ${n}: ${unicode}`,
      body:
        n === 3
          ? Array.from(
              { length: 900 },
              (_, l) => `Line ${l + 1}: ${unicode}acceptance detail.`,
            ).join("\n")
          : `## Goal\n${unicode}\n\n${"Context sentence. ".repeat(40)}`,
      url: url(n),
      state: "OPEN",
      stateReason: null,
      createdAt: `2026-10-${String((n % 28) + 1).padStart(2, "0")}T00:00:00Z`,
      updatedAt: time,
      issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
      blockedBy: page([]),
      blocking: page([]),
      labels: page([
        { name: statuses[n % statuses.length] },
        ...(n % 3 ? [{ name: `impact:${["S", "M", "L"][n % 3]}` }] : []),
      ]),
      comments: page(
        Array.from({ length: n === 3 ? 120 : n % 5 }, (_, c) => ({
          author: { login: `agent${c % 4}` },
          body: `Progress note ${c} on #${n}. ${unicode}${"Detail. ".repeat(n === 3 ? 60 : 15)}`,
          createdAt: `2026-11-${String((c % 10) + 1).padStart(2, "0")}T00:00:00Z`,
          url: `${url(n)}#issuecomment-${n * 1000 + c}`,
        })),
      ),
    };
  });

const snapshot = () => ({
  schemaVersion: 1,
  repository: repo,
  startedAt: time,
  fetchedAt: time,
  issues: issues(),
  pullRequests: [],
  dependencies: [],
  changed: [],
  since: null,
  warnings: [],
  rateLimit: null,
});

/** A dependency tree of 120 tickets: #25 blocked by a chain and blocking a wide fan-out. */
const dependencyTree = (): DependencyReport => {
  const node = (n: number) => ({
    number: n,
    title: `Dependency ticket ${n} ${unicode}`,
    url: url(n),
    state: "OPEN",
    stateReason: null,
    repository: { nameWithOwner: repo },
    issueDependenciesSummary: { blockedBy: 1, totalBlockedBy: 1, blocking: 0, totalBlocking: 0 },
  });
  const facts = (n: number, up: number[], down: number[]) => ({
    number: n,
    url: url(n),
    title: `Dependency ticket ${n} ${unicode}`,
    known: true,
    summary: {
      blockedBy: up.length,
      totalBlockedBy: up.length,
      blocking: down.length,
      totalBlocking: down.length,
    },
    upstream: up.map(node),
    downstream: down.map((d) => ({ ...node(d), lastOpenBlocker: true })),
    drift: [],
    verdict: up.length ? `Waiting on ${up.map(url).join(", ")}` : "No open native blockers.",
  });
  const nodes = [
    facts(
      25,
      [26, 27, 28],
      Array.from({ length: 40 }, (_, i) => 100 + i),
    ),
  ];
  for (const n of [26, 27, 28]) nodes.push(facts(n, [n + 10], [25]));
  for (const n of [36, 37, 38]) nodes.push(facts(n, [], [n - 10]));
  for (let i = 0; i < 40; i++)
    nodes.push(facts(100 + i, [25], [200 + i * 2, 201 + i * 2].slice(0, 2)));
  for (let i = 0; i < 80; i++) nodes.push(facts(200 + i, [100 + Math.floor(i / 2)], []));
  return {
    schemaVersion: 1,
    repository: repo,
    startedAt: time,
    fetchedAt: time,
    tree: true,
    nodes,
    cycles: [],
    guidance: "Native relationships are authoritative.",
  };
};

const runtime = (): McpRuntime => ({
  currentRepository: async () => repo,
  collect: (async (_r: string, options?: { issue?: number }) => {
    const base = snapshot();
    return options?.issue
      ? { ...base, issues: base.issues.filter((item) => item.number === options.issue) }
      : base;
  }) as unknown as McpRuntime["collect"],
  dependencyReport: (async (_r: string, n: number, o?: { tree?: boolean }) => {
    const report = dependencyTree();
    return o?.tree
      ? report
      : { ...report, tree: false, nodes: report.nodes.filter((x) => x.number === n) };
  }) as McpRuntime["dependencyReport"],
  now: clock,
});

const connect = async (rt: McpRuntime = runtime()) => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer({ repo }, rt).connect(serverSide);
  const client = new Client({ name: "budget", version: "1.0.0" });
  await client.connect(clientSide);
  return client;
};

const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const raw = await client.callTool({ name, arguments: args });
  const bytes = resultBytes(raw);
  const structured = boundedEnvelope.parse(raw.structuredContent);
  const first = Array.isArray(raw.content) ? raw.content[0] : undefined;
  const text = first && "text" in first ? String(first.text) : "";
  return { raw, bytes, structured, text };
};

describe("bounded MCP results (#266)", () => {
  const defaults: [string, string, Record<string, unknown>][] = [
    ["default briefing", "triage_briefing", {}],
    ["designer role briefing", "triage_briefing", { role: "designer", limit: 100 }],
    ["briefing with small maxChars", "triage_briefing", { maxChars: 1000 }],
    ["repository briefing", "triage_briefing", { mode: "briefing", limit: 100 }],
    ["issue summary", "triage_issue", { number: 3 }],
    ["issue body", "triage_issue", { number: 3, section: "body", limit: 100 }],
    ["issue discussion", "triage_issue", { number: 3, section: "discussion", limit: 100 }],
    ["giant-title issue", "triage_issue", { number: 7 }],
    ["direct dependencies", "triage_dependencies", { number: 25 }],
    ["dependency tree", "triage_dependencies", { number: 25, tree: true, limit: 100 }],
  ];

  it.each(defaults)(
    "%s fits the whole-result budget with an exact byte count",
    async (_, name, args) => {
      const client = await connect();
      try {
        const { raw, bytes, structured, text } = await call(client, name, args);
        expect(raw.isError).toBeFalsy();
        expect(bytes).toBeLessThanOrEqual(budgetBytes);
        // The server's own measure is of the same final serialization.
        expect(structured.presentation.bytes).toBe(bytes);
        expect(structured.schemaVersion).toBe(2);
        expect(structured.freshness).not.toBeNull();
        expect(structured.sourceCompleteness).not.toBeNull();
        expect(text).toMatch(/^Bounded MCP result/m);
        if (typeof args.maxChars === "number")
          expect(text.length).toBeLessThanOrEqual(args.maxChars);
      } finally {
        await client.close();
      }
    },
  );

  it("reports the sizes measured before and after (#266 table)", async () => {
    const client = await connect();
    try {
      const sizes = Object.fromEntries(
        await Promise.all(
          defaults.map(async ([label, name, args]) => [
            label,
            (await call(client, name, args)).bytes,
          ]),
        ),
      );
      // Printed for the PR record; the assertion is the budget.
      console.log(JSON.stringify(sizes));
      for (const size of Object.values(sizes)) expect(size).toBeLessThanOrEqual(budgetBytes);
    } finally {
      await client.close();
    }
  });

  it("ranks before limiting and reports omissions explicitly", async () => {
    const client = await connect();
    try {
      const { structured } = await call(client, "triage_briefing", {});
      const data = structured.data as {
        rankedActions: { total: number; omitted: number; items: unknown[] };
        subjects: unknown[];
      };
      const shown = data.rankedActions.items.length;
      expect(shown).toBeGreaterThan(0);
      expect(shown).toBeLessThanOrEqual(10);
      expect(data.rankedActions.total).toBeGreaterThan(10);
      expect(data.rankedActions.omitted).toBe(data.rankedActions.total - shown);
      // Subject rows are dropped before ranked actions, and the drop is counted.
      expect(structured.presentation.omitted["subjects"]).toBeGreaterThan(0);
      expect(structured.presentation.returned["rankedActions.items"]).toBe(shown);
    } finally {
      await client.close();
    }
  });

  it("selects deterministically: identical calls return identical results", async () => {
    const client = await connect();
    try {
      const a = await call(client, "triage_briefing", { role: "designer" });
      const b = await call(client, "triage_briefing", { role: "designer" });
      expect(a.raw).toEqual(b.raw);
    } finally {
      await client.close();
    }
  });

  it("pages issue discussion without gaps or repeats, in creation then comment-ID order", async () => {
    const client = await connect();
    try {
      const seen: string[] = [];
      let args: Record<string, unknown> | null = {
        number: 3,
        section: "discussion",
        limit: 100,
      };
      for (let guard = 0; args && guard < 50; guard++) {
        const { structured, bytes } = await call(client, "triage_issue", args);
        expect(bytes).toBeLessThanOrEqual(budgetBytes);
        const data = structured.data as { total: number; rows: { url: string }[] };
        expect(data.total).toBe(120);
        seen.push(...data.rows.map((row) => row.url));
        args = structured.presentation.next?.arguments ?? null;
        if (args) expect(structured.presentation.next?.tool).toBe("triage_issue");
      }
      expect(seen).toHaveLength(120);
      expect(new Set(seen).size).toBe(120);
      const ordered = [...seen].sort((a, b) => {
        const id = (u: string) => Number(/(\d+)$/.exec(u)?.[1]);
        const day = (u: string) => (id(u) - 3000) % 10;
        return day(a) - day(b) || id(a) - id(b);
      });
      expect(seen).toEqual(ordered);
    } finally {
      await client.close();
    }
  });

  it("pages the dependency tree with relation, depth and path, never claiming the page is whole", async () => {
    const client = await connect();
    try {
      const all = flattenRelationships(
        JSON.parse(JSON.stringify(dependencyTree())) as Record<string, unknown>,
        25,
      );
      const seen: unknown[] = [];
      let args: Record<string, unknown> | null = { number: 25, tree: true, limit: 100 };
      for (let guard = 0; args && guard < 50; guard++) {
        const { structured } = await call(client, "triage_dependencies", args);
        const data = structured.data as { total: number; relationships: unknown[] };
        expect(data.total).toBe(all.length);
        seen.push(...data.relationships);
        args = structured.presentation.next?.arguments ?? null;
      }
      expect(seen).toEqual(all);
      expect(all.some((row) => row.depth === 2 && row.path.length === 3)).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("marks shortened fields visibly and keeps URLs whole", async () => {
    const client = await connect();
    try {
      const { structured, text } = await call(client, "triage_briefing", {});
      const giant = JSON.stringify(structured.data);
      expect(giant).not.toContain(unicode.repeat(80));
      if (structured.presentation.truncatedFields.length)
        expect(text).toMatch(/field\(s\) shortened/);
      for (const link of giant.match(/https:\/\/github\.com\/[^"]*/g) ?? [])
        expect(link).not.toContain("… [truncated]");
    } finally {
      await client.close();
    }
  });

  it("keeps the source completeness separate from display omissions", async () => {
    const rt = runtime();
    const collect = rt.collect;
    rt.collect = (async (...args: Parameters<McpRuntime["collect"]>) => ({
      ...(await collect(...args)),
      warnings: ["Comment history for #3 could not be fully paginated."],
    })) as McpRuntime["collect"];
    const client = await connect(rt);
    try {
      const { structured, text } = await call(client, "triage_briefing", {});
      expect(structured.status).toBe("incomplete");
      expect(structured.sourceCompleteness?.complete).toBe(false);
      expect(structured.sourceCompleteness?.warnings.join(" ")).toMatch(/could not be fully/);
      expect(text).toMatch(/^INCOMPLETE evidence/);
      // And a complete collection with omitted rows is still complete.
      const full = await call(await connect(), "triage_briefing", {});
      expect(full.structured.sourceCompleteness?.complete).toBe(true);
      expect(Object.keys(full.structured.presentation.omitted).length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it("reports unknown native dependency evidence as incomplete", async () => {
    const rt = runtime();
    rt.dependencyReport = (async () => {
      const report = dependencyTree();
      return {
        ...report,
        nodes: report.nodes.map((node, i) => (i === 1 ? { ...node, known: false } : node)),
      };
    }) as McpRuntime["dependencyReport"];
    const client = await connect(rt);
    try {
      const { structured, text } = await call(client, "triage_dependencies", {
        number: 25,
        tree: true,
      });
      expect(structured.status).toBe("incomplete");
      expect(structured.sourceCompleteness?.complete).toBe(false);
      expect(text).toMatch(/^INCOMPLETE evidence/);
    } finally {
      await client.close();
    }
  });

  it("returns OUTPUT_BUDGET_EXCEEDED rather than a partial success when essentials cannot fit", () => {
    const result = boundedResult({
      tool: "triage_briefing",
      view: "briefing",
      status: "complete",
      repository: repo,
      subject: null,
      selection: {
        repository: repo,
        agent: null,
        identitySource: "unresolved",
        entry: null,
        triageRole: null,
        identityDiagnostic: null,
      },
      freshness: { fetchedAt: time },
      sourceCompleteness: { complete: false, warnings: ["w"] },
      // An essential, unprunable field larger than the whole budget.
      data: { rows: [1, 2, 3], essential: { note: "x ".repeat(10_000) } },
      protectedPaths: ["essential"],
      lists: () => [{ path: ["rows"] }],
      text: () => [],
      notices: [],
      maxChars: 10_000,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error?.code).toBe(budgetErrorCode);
    expect(result.structuredContent.data).toBeNull();
    expect(resultBytes(result)).toBeLessThanOrEqual(budgetBytes);
    expect(result.structuredContent.sourceCompleteness?.complete).toBe(false);
  });

  it("drops truncatedFields paths with the rows that pruning removes", () => {
    const long = "r".repeat(350);
    const result = boundedResult({
      tool: "triage_briefing",
      view: "briefing",
      status: "complete",
      repository: repo,
      subject: null,
      selection: {
        repository: repo,
        agent: null,
        identitySource: "unresolved",
        entry: null,
        triageRole: null,
        identityDiagnostic: null,
      },
      freshness: { fetchedAt: time },
      sourceCompleteness: { complete: true, warnings: [] },
      data: {
        rankedActions: { total: 1, omitted: 0, items: [{ kind: "implement", why: long }] },
        subjects: Array.from({ length: 100 }, (_, i) => ({
          number: i,
          findings: Array.from({ length: 5 }, () => ({ reason: long })),
        })),
      },
      lists: () => [{ path: ["subjects"] }, { path: ["rankedActions", "items"] }],
      text: () => [],
      notices: [],
      maxChars: 10_000,
    });
    expect(result.isError).toBeUndefined();
    const { presentation, data } = result.structuredContent;
    expect((data as { rankedActions: { items: unknown[] } }).rankedActions.items).toHaveLength(1);
    const kept = (data as { subjects: unknown[] }).subjects.length;
    expect(presentation.truncatedFields).toHaveLength(1 + kept * 5);
    for (const path of presentation.truncatedFields) {
      const index = /^subjects\[(\d+)\]/.exec(path)?.[1];
      if (index !== undefined) expect(Number(index)).toBeLessThan(kept);
    }
    expect(resultBytes(result)).toBeLessThanOrEqual(budgetBytes);
  });

  it("returns dependencies for a requested issue that is not a shortlisted subject", async () => {
    const rt = runtime();
    rt.collect = (async () => ({
      ...snapshot(),
      issues: [
        {
          ...issues(1)[0],
          number: 1,
          state: "CLOSED",
          stateReason: "COMPLETED",
          labels: page([]),
          comments: page([]),
        },
      ],
    })) as unknown as McpRuntime["collect"];
    const client = await connect(rt);
    try {
      const { structured } = await call(client, "triage_issue", { number: 1 });
      const data = structured.data as { dependencies: { known: boolean; verdict: string } | null };
      expect(data.dependencies).not.toBeNull();
      expect(data.dependencies?.known).toBe(true);
      expect(data.dependencies?.verdict).toMatch(/No open native blockers/);
    } finally {
      await client.close();
    }
  });

  it("refuses a page that cannot return its first row instead of repeating an empty page", async () => {
    const rt = runtime();
    const giant = `https://example.com/${"a".repeat(20_000)}`;
    rt.collect = (async () => ({
      ...snapshot(),
      issues: [{ ...issues(1)[0], number: 1, body: `intro\n${giant}\nafter` }],
    })) as unknown as McpRuntime["collect"];
    const client = await connect(rt);
    try {
      const first = await call(client, "triage_issue", { number: 1, section: "body", limit: 100 });
      expect(first.structured.status).toBe("complete");
      expect(first.structured.presentation.next?.arguments).toMatchObject({ offset: 1 });
      const stuck = await call(client, "triage_issue", { number: 1, section: "body", offset: 1 });
      expect(stuck.raw.isError).toBe(true);
      expect(stuck.structured.error?.code).toBe(budgetErrorCode);
      expect(stuck.structured.error?.message).toMatch(/first row/);
      expect(stuck.bytes).toBeLessThanOrEqual(budgetBytes);
    } finally {
      await client.close();
    }
  });

  it("bounds every result that echoes a 20,000-character agent name, and says so", async () => {
    const agent = `a${"b".repeat(19_999)}`;
    const failing = runtime();
    failing.collect = (async () => {
      throw new Error("network down");
    }) as unknown as McpRuntime["collect"];
    for (const [rt, name, args] of [
      [failing, "triage_briefing", { agent }],
      [runtime(), "triage_briefing", { agent }],
      [runtime(), "triage_issue", { number: 3, agent }],
    ] as const) {
      const client = await connect(rt);
      try {
        const raw = await client.callTool({ name, arguments: args });
        expect(resultBytes(raw), name).toBeLessThanOrEqual(budgetBytes);
        const structured = boundedEnvelope.parse(raw.structuredContent);
        expect(structured.status).toBe("error");
        expect(structured.error?.message).toMatch(/Echoed input longer than 280 characters/);
        expect((structured.selection.agent ?? "").length).toBeLessThanOrEqual(280);
      } finally {
        await client.close();
      }
    }
    // Invalid input is rejected by the SDK before collection, within the budget too.
    const client = await connect();
    try {
      const raw = await client
        .callTool({ name: "triage_briefing", arguments: { agent: `-${agent}` } })
        .catch((error: unknown) => ({ thrown: String(error) }));
      expect(JSON.stringify(raw).length).toBeLessThanOrEqual(budgetBytes);
    } finally {
      await client.close();
    }
  });

  it("bounds triage_events when it echoes an over-long startup agent", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer({ repo, agent: "c".repeat(20_000) }, runtime()).connect(serverSide);
    const client = new Client({ name: "budget", version: "1.0.0" });
    await client.connect(clientSide);
    try {
      const raw = await client.callTool({ name: "triage_events", arguments: {} });
      expect(resultBytes(raw)).toBeLessThanOrEqual(budgetBytes);
      const first = Array.isArray(raw.content) ? raw.content[0] : undefined;
      expect(first && "text" in first ? String(first.text) : "").toMatch(/Startup agent longer/);
    } finally {
      await client.close();
    }
  });

  it("checks nested shortened lists by path for CLI parity", () => {
    expect(parsePath("role.sections[0].items")).toEqual(["role", "sections", 0, "items"]);
    const cli = { queue: { total: 2, omitted: 0, items: ["A", "B"] }, note: "x" };
    const prefix = { queue: { total: 2, omitted: 1, items: ["A"] }, note: "x" };
    const wrong = { queue: { total: 2, omitted: 1, items: ["C"] }, note: "x" };
    const drift = { queue: { total: 2, omitted: 1, items: ["A"] }, note: "y" };
    const omitted = { "estimation.queue.items": 1 };
    expect(parityDifference("estimation", prefix, cli, omitted)).toBeNull();
    expect(parityDifference("estimation", wrong, cli, omitted)).toMatch(/not a prefix/);
    expect(parityDifference("estimation", drift, cli, omitted)).toMatch(/differs/);
    expect(parityDifference("estimation", prefix, cli, { "estimation.queue.items": 2 })).toMatch(
      /omitted 2/,
    );
    const role = { next: ["n1", "n2"], sections: [{ total: 3, omitted: 1, items: ["s1", "s2"] }] };
    const shortRole = { next: ["n1"], sections: [{ total: 3, omitted: 2, items: ["s1"] }] };
    expect(
      parityDifference("role", shortRole, role, { "role.next": 1, "role.sections[0].items": 1 }),
    ).toBeNull();
  });

  it("keeps mixed-direction edges of a dependency tree, once each", () => {
    // 25 is blocked by 26; 26 also blocks 30, a sibling the root never reaches upstream-only.
    const ref = (n: number) => ({ number: n, url: url(n), title: `T${n}`, state: "OPEN" });
    const report = {
      tree: true,
      nodes: [
        { number: 25, url: url(25), upstream: [ref(26)], downstream: [] },
        { number: 26, url: url(26), upstream: [], downstream: [ref(25), ref(30)] },
        { number: 30, url: url(30), upstream: [ref(26)], downstream: [] },
      ],
    };
    const rows = flattenRelationships(report, 25);
    expect(rows.map((r) => `${r.relation}:${r.path.join(">")}`)).toEqual([
      "blockedBy:25>26",
      "blocking:25>26>30",
    ]);
  });

  it("budgets a live-shaped default briefing: many warnings, estimation queue and denials", async () => {
    // Sanitised shape of the live repository where the default briefing failed (#266 retest):
    // ~60 open issues, unestimated work filling the estimation queue, platform denials and a long
    // list of collection warnings.
    const rt = runtime();
    rt.collect = (async () => ({
      ...snapshot(),
      issues: issues(60).map((item, i) => ({
        ...item,
        labels: page([
          { name: i % 2 ? "status:ready" : "status:incomplete" },
          ...(i % 3 === 0 ? [{ name: "platform:windows" }] : []),
          ...(i % 4 === 0 ? [{ name: "complexity:S" }, { name: "complexity:L" }] : []),
        ]),
      })),
      warnings: Array.from(
        { length: 300 },
        (_, i) => `Warning ${i}: comment history for #${i} was not fully collected; ${unicode}`,
      ),
    })) as unknown as McpRuntime["collect"];
    const client = await connect(rt);
    try {
      for (const args of [{}, { role: "designer" }]) {
        const { raw, bytes, structured } = await call(client, "triage_briefing", args);
        expect(raw.isError, JSON.stringify(structured.error)).toBeFalsy();
        expect(bytes).toBeLessThanOrEqual(budgetBytes);
        expect(structured.status).toBe("incomplete");
        expect(structured.sourceCompleteness?.complete).toBe(false);
        const omitted = structured.presentation.omitted["sourceCompleteness.warnings"] ?? 0;
        expect((structured.sourceCompleteness?.warnings.length ?? 0) + omitted).toBe(300);
        if (omitted) expect(structured.sourceCompleteness?.warningsOmitted).toBe(omitted);
        const ranked = (structured.data as { rankedActions: { items: unknown[] } }).rankedActions;
        expect(ranked.items.length).toBeGreaterThan(0);
      }
    } finally {
      await client.close();
    }
  });

  it("keeps full intake available through the CLI", async () => {
    let out = "";
    const code = await main(
      ["--repo", repo, "--issue", "3", "--json", "--no-update-check"],
      async (t) => void (out += t),
      {
        ...runtime(),
        stderr: () => {},
        updateCheck: async () => ({ status: "disabled" }) as never,
      },
    );
    expect(code).toBe(0);
    const report = JSON.parse(out) as { detail: { body: string; comments: { nodes: unknown[] } } };
    expect(report.detail.comments.nodes).toHaveLength(120);
    expect(report.detail.body.split("\n")).toHaveLength(900);
  });
});
