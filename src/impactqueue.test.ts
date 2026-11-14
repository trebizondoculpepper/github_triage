/**
 * Designer impact-estimation guidance and unassessed-work queue (#246): help rendered from the
 * one bundled definition, `assess-impact`/inspection actions in the #248 ranking, the designer
 * NEXT STEPS text and the `impactEstimation` object. Real collect() over a fake GraphQL
 * boundary, injected permissions, clock and filesystem; no live calls.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { main } from "./cli.js";
import type { CompactBriefing, ImpactEstimation } from "./compact.js";
import type { ComplexitySize } from "./estimation/complexity.js";
import { TOML_CONFIG_PATH } from "./config/config.js";
import type { ConfigFileSystem, GitRunner } from "./config/config.js";
import { provenanceComment } from "./estimation/estimate.js";
import { collect } from "./github/github.js";
import type { Query, Rest } from "./github/github.js";
import { impactGuidance, impactGuidanceSummary } from "./estimation/impact.js";
import { mcpHelp } from "./mcp.js";
import type { Issue, Page } from "./github/types.js";

const repo = "owner/name";
const time = "2026-11-14T10:00:00.000Z";
const recordedAt = "2026-11-14T09:00:00.000Z";
const root = "/repo";
const page = <T>(nodes: T[], more = false): Page<T> => ({
  nodes,
  pageInfo: { hasNextPage: more, endCursor: more ? "next" : null },
});
const url = (n: number) => `https://github.com/${repo}/issues/${n}`;
type Remote = Issue["comments"]["nodes"][number];

const impactMarker = (size: ComplexitySize, n: number, login = "maintainer"): Remote => ({
  body: provenanceComment({
    schemaVersion: 1,
    kind: "impact-estimate",
    storage: "labels",
    size,
    previous: [],
    rationale: "benefit",
    assumptions: [],
    references: [],
    estimator: null,
    revision: null,
    guidanceVersion: impactGuidance.guidanceVersion,
    recordedAt,
  }),
  url: `${url(n)}#issuecomment-${n}1`,
  author: { __typename: "User", login },
  createdAt: recordedAt,
  lastEditedAt: null,
  includesCreatedEdit: false,
  editor: null,
});
const issue = (
  n: number,
  labels: string[],
  extra: { comments?: Remote[]; created?: string; labelsTruncated?: boolean } = {},
): Issue => ({
  number: n,
  title: `Ticket ${n}`,
  body: "",
  url: url(n),
  state: "OPEN",
  stateReason: null,
  createdAt: extra.created ?? `2026-11-${String(n).padStart(2, "0")}T00:00:00Z`,
  updatedAt: time,
  issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
  blockedBy: page([]),
  blocking: page([]),
  labels: page(
    labels.map((name) => ({ name })),
    !!extra.labelsTruncated,
  ),
  comments: page(extra.comments ?? []),
});
/**
 * #1 complexity XS, impact unassessed (boosted); #2 invalid impact; #3 conflicting impact; #4
 * current trusted impact; #5 impact provenance by an author whose permission is unknown; #6
 * blocked and unassessed; #7 parked; #8 stale (label L, recorded S); #9 new design work; #10 a
 * decision blocking active work #11; #12 truncated labels.
 */
const fixture = (): Issue[] => [
  issue(1, ["status:ready", "complexity:XS"]),
  issue(2, ["status:ready", "impact:high"]),
  issue(3, ["status:ready", "impact:S", "impact:L"]),
  issue(4, ["status:ready", "impact:L"], { comments: [impactMarker("L", 4)] }),
  issue(5, ["status:ready", "impact:M"], { comments: [impactMarker("M", 5, "stranger")] }),
  {
    ...issue(6, ["status:ready"]),
    issueDependenciesSummary: { blockedBy: 1, totalBlockedBy: 1, blocking: 0, totalBlocking: 0 },
    blockedBy: page([
      {
        number: 4,
        title: "Ticket 4",
        url: url(4),
        state: "OPEN",
        repository: { nameWithOwner: repo },
        issueDependenciesSummary: {
          blockedBy: 0,
          totalBlockedBy: 0,
          blocking: 1,
          totalBlocking: 1,
        },
      },
    ]),
  },
  issue(7, ["status:parked"]),
  issue(8, ["status:ready", "impact:L"], { comments: [impactMarker("S", 8)] }),
  issue(9, ["status:needs-design", "impact:M"], { comments: [impactMarker("M", 9)] }),
  issue(10, ["design:decision-needed", "impact:M"], { comments: [impactMarker("M", 10)] }),
  issue(11, ["status:in-progress", "agent:other", "impact:M"], {
    comments: [impactMarker("M", 11)],
  }),
  issue(12, ["status:ready"], { labelsTruncated: true }),
];
const query =
  (issues: () => Issue[]): Query =>
  async (source) => ({
    repository: {
      issues: page(source.includes("issues(first") ? issues() : []),
      pullRequests: page([]),
    },
  });
/** Injected permissions: `maintainer` writes; everyone else is unknown (404). */
const permissions: Rest = async (path) => {
  const login = /collaborators\/([^/]+)\/permission/.exec(path)?.[1];
  return login === "maintainer"
    ? { status: 200, body: { role_name: "write", user: { login } } }
    : { status: 404, body: null };
};
const files = (config: string | null): ConfigFileSystem => ({
  readText: async (file) => (config && file === join(root, TOML_CONFIG_PATH) ? config : null),
  writeText: async () => undefined,
  rename: async () => undefined,
  remove: async () => undefined,
  makeDirectory: async () => undefined,
});
const git: GitRunner = async (args) =>
  args[0] === "rev-parse" ? `${root}\n` : `origin\thttps://github.com/${repo}.git (fetch)\n`;
const runtime = (config: string | null = null, issues: () => Issue[] = fixture) => ({
  collect: (repository: string, options = {}) =>
    collect(repository, options, query(issues), () => new Date(time)),
  currentRepository: async () => repo,
  now: () => new Date(time),
  estimation: { fs: files(config), git, cwd: root },
  // Historical TypeScript queue contract remains exercised through the explicit rollback.
  guide: { fs: files('schemaVersion = 1\n[briefing]\nengine = "typescript"\n'), git, cwd: root },
  rest: permissions,
  updateCheck: async () => ({ status: "skipped" as const, reason: "" }),
});
async function run(
  args: string[],
  config: string | null = null,
  issues: () => Issue[] = fixture,
): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await main(
    ["--repo", repo, "--agent", "me", "--no-update-check", ...args],
    async (t) => void (out = t),
    runtime(config, issues),
  );
  return { code, out };
}
const json = async (args: string[], config: string | null = null) =>
  JSON.parse((await run(["--json", ...args], config)).out) as CompactBriefing & {
    impactEstimation?: ImpactEstimation;
  };
const kinds = (report: CompactBriefing) =>
  (report.rankedActions?.items ?? []).map((i) => `${i.kind}#${Number(i.target.split("/").pop())}`);
const disabled = "schemaVersion = 1\n[impact]\nenabled = false\n";

describe("impact guidance in CLI and MCP help from one definition (#246)", () => {
  const offline = {
    collect: async (): Promise<never> => {
      throw new Error("guidance must not query GitHub");
    },
    currentRepository: async (): Promise<never> => {
      throw new Error("guidance must not resolve a repository");
    },
    updateCheck: async () => ({ status: "skipped" as const, reason: "" }),
  };
  const help = async (args: string[]) => {
    let out = "";
    const code = await main(["estimate", "--help", ...args], async (t) => void (out = t), offline);
    return { code, out };
  };

  it("renders impact text and JSON guidance without GitHub", async () => {
    const text = await help(["--metric", "impact"]);
    const data = await help(["--metric", "impact", "--json"]);
    expect([text.code, data.code]).toEqual([0, 0]);
    expect(JSON.parse(data.out)).toEqual({
      schemaVersion: 1,
      kind: "impact-guidance",
      ...JSON.parse(JSON.stringify(impactGuidance)),
    });
    expect(text.out).toContain(
      `Impact estimation guidance (version ${impactGuidance.guidanceVersion})`,
    );
    for (const band of impactGuidance.bands) expect(text.out).toContain(band.guidance);
    for (const line of impactGuidance.method) expect(text.out).toContain(line);
    expect(text.out).not.toContain("Complexity estimation guidance");
    // Repository-neutral: no ticket numbers bundled.
    expect(data.out).not.toMatch(/#\d+/);
  });

  it("keeps the default and explicit complexity guidance identical", async () => {
    const plain = await help([]);
    const explicit = await help(["--metric", "complexity"]);
    expect(explicit.out).toBe(plain.out);
    expect(plain.out).toContain("Complexity estimation guidance");
    expect(plain.out).toContain("estimate --help [--metric complexity|impact] [--json]");
    expect(JSON.parse((await help(["--json"])).out).kind).toBe("complexity-guidance");
  });

  it("refuses an unknown metric or stray argument in help", async () => {
    await expect(help(["--metric", "risk"])).rejects.toThrow(/--metric complexity\|impact/);
    await expect(help(["--metric"])).rejects.toThrow(/Usage/);
    await expect(help(["--metric", "impact", "--size", "L"])).rejects.toThrow(/Usage/);
  });

  it("puts the same definition in MCP help with runnable CLI commands", () => {
    expect(mcpHelp).toContain(impactGuidanceSummary());
    for (const band of impactGuidance.bands) expect(mcpHelp).toContain(band.guidance);
    expect(mcpHelp).toContain("pdb estimate --help --metric impact");
    expect(mcpHelp).toContain(
      "pdb estimate N --metric impact --size SIZE --rationale TEXT --repo owner/name",
    );
    // Help never contains shell comments.
    expect(impactGuidanceSummary()).not.toMatch(/(^|\s)#\s/m);
  });

  it("lists impact guidance in top-level help", async () => {
    let out = "";
    await main(["--help"], async (t) => void (out = t), offline);
    expect(out).toContain("estimate --help --metric impact");
  });
});

describe("designer impact queue through collect() (#246)", () => {
  it("ranks assessments and inspections after designer duties and before new design", async () => {
    const report = await json(["--role", "designer", "--limit", "20"]);
    expect(kinds(report)).toEqual([
      "decide#10",
      "assess-impact#1",
      "inspect-assessment#2",
      "inspect-assessment#3",
      "assess-impact#6",
      "assess-impact#8",
      "design#9",
    ]);
    const [, boosted] = report.rankedActions!.items;
    expect(boosted).toMatchObject({
      band: 5,
      role: "designer",
      reasonCodes: expect.arrayContaining(["cross-role-boost", "impact-unassessed"]),
      complexity: { state: "current", size: "XS" },
      impact: { state: "unassessed", size: null },
      nextCommand: `pdb estimate 1 --metric impact --size SIZE --rationale TEXT --repo ${repo}`,
      thenCommand: null,
    });
    // Blocked work is assessed under assumptions; it is never a pickup for the designer either.
    expect(report.rankedActions!.items.find((i) => i.target === url(6))?.kind).toBe(
      "assess-impact",
    );
  });

  it("inspects conflicting and invalid impact with the Ticket Doctor fix", async () => {
    const items = (await json(["--role", "designer", "--limit", "20"])).rankedActions!.items;
    expect(items.find((i) => i.target === url(2))).toMatchObject({
      kind: "inspect-assessment",
      impact: { state: "invalid", size: null },
      nextCommand: `pdb estimate 2 --metric impact --size SIZE --rationale TEXT --replace-invalid --repo ${repo}`,
      inspection: null,
    });
    const conflict = items.find((i) => i.target === url(3));
    expect(conflict?.nextCommand).toBe(
      `pdb estimate 3 --metric impact --size SIZE --rationale TEXT --repo ${repo}`,
    );
    expect(conflict?.reasonCodes).not.toContain("cross-role-boost");
  });

  it("reports impactEstimation counts, keeping unknowns separate and unqueued", async () => {
    const report = await json(["--role", "designer", "--limit", "3"]);
    expect(report.impactEstimation).toEqual({
      status: "available",
      guidanceVersion: impactGuidance.guidanceVersion,
      // #1, #6, #7 (parked), #8 (stale).
      eligible: 4,
      ranked: 3,
      shown: 1,
      offered: true,
      inspections: { ranked: 2, shown: 1 },
      conflicts: 1,
      invalid: 1,
      // #5 (provenance author unknown) and #12 (truncated labels): never queued.
      unknown: 2,
      guidance: "pdb estimate --help --metric impact",
      boundaries: expect.stringContaining("no claim"),
    });
    expect(report.rankedActions).toMatchObject({ total: 7, omitted: 4 });
    const all = await json(["--role", "designer", "--limit", "50"]);
    expect(kinds(all).some((k) => k.endsWith("#5") || k.endsWith("#12") || k.endsWith("#7"))).toBe(
      false,
    );
    // Ranked counts do not depend on the display limit.
    expect(all.impactEstimation).toMatchObject({ ranked: 3, shown: 3, eligible: 4 });
  });

  it("renders designer NEXT STEPS from the ranked actions with kind, assessments and command", async () => {
    const { out } = await run(["--role", "designer", "--limit", "3"]);
    const next = out.slice(out.indexOf("NEXT STEPS"), out.indexOf("\nDECISION NEEDED"));
    expect(next).toMatch(/^NEXT STEPS \(7; 4 omitted\)/);
    expect(next).toContain("- #10 Ticket 10 — decide (designer-duty)");
    expect(next).toContain("- #1 Ticket 1 — assess-impact (assessment, cross-role-boost");
    expect(next).toContain("impact unassessed · complexity XS");
    expect(next).toContain(
      `Next: pdb estimate 1 --metric impact --size SIZE --rationale TEXT --repo ${repo}`,
    );
    expect(next).toContain(
      "- Impact assessment: 4 eligible, 3 ranked, 1 shown; 1 conflicting, 1 invalid, 2 unknown. Guidance: pdb estimate --help --metric impact",
    );
    // Order in text matches the JSON ranking.
    expect(next.indexOf("#10 Ticket 10")).toBeLessThan(next.indexOf("#1 Ticket 1"));
    expect(next.indexOf("#1 Ticket 1")).toBeLessThan(next.indexOf("#2 Ticket 2"));
  });

  it("hides, never deletes, impact work when impact.enabled is false", async () => {
    const report = await json(["--role", "designer", "--limit", "20"], disabled);
    expect(kinds(report)).toEqual(["decide#10", "design#9"]);
    expect(report.impactEstimation).toMatchObject({
      status: "disabled",
      eligible: 0,
      ranked: 0,
      offered: false,
    });
    const bySubject = report.subjects.find((s) => s.number === 9);
    expect(bySubject?.labels).toContain("impact:M");
    expect(bySubject?.assessments?.impact.state).toBe("disabled");
    const { out } = await run(["--role", "designer"], disabled);
    expect(out).not.toContain("Impact assessment:");
    expect(out).toContain("NEXT STEPS (2)");
  });

  it("leaves non-designer views unchanged: no impactEstimation, legacy NEXT STEPS", async () => {
    for (const extra of [["--role", "implementer"], []]) {
      const report = await json(extra);
      expect("impactEstimation" in report).toBe(false);
      const { out } = await run(extra);
      expect(out).not.toContain("Impact assessment:");
      expect(out).not.toMatch(/— assess-impact/);
    }
  });

  it("reads an old cache without impact data: unassessed when labels are complete, else unknown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "impact-queue-"));
    try {
      const snapshot = await collect(
        repo,
        {},
        query(() => [
          issue(1, ["status:ready", "complexity:S"]),
          issue(2, ["status:ready"], { labelsTruncated: true }),
        ]),
        () => new Date(time),
      );
      // An older cache: comments carry no author type or edit evidence.
      const old = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
      for (const i of old.issues)
        for (const c of i.comments.nodes as Partial<Remote>[]) {
          delete c.author;
          delete c.editor;
        }
      const cache = join(dir, "cache.json");
      await writeFile(cache, JSON.stringify(old));
      const { out } = await run(["--offline", "--cache", cache, "--json", "--role", "designer"]);
      const report = JSON.parse(out) as CompactBriefing & { impactEstimation: ImpactEstimation };
      expect(kinds(report)).toEqual(["assess-impact#1"]);
      expect(report.impactEstimation).toMatchObject({ eligible: 1, ranked: 1, unknown: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
