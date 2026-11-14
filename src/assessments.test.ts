/**
 * Side-by-side impact and complexity (#247): the shared paired-facts reader, the additive
 * `assessments` property on compact and expanded subjects (CLI JSON and MCP), text rendering,
 * provenance links, request bound and byte-compatibility of the legacy `complexity`/`estimation`.
 *
 * Every read goes through the real `collect()` over a fake GraphQL boundary and an injected REST
 * permission boundary; nothing here reaches GitHub.
 */
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { assessmentsText, readSnapshotAssessments } from "./assessments.js";
import { briefing } from "./briefing.js";
import { main } from "./cli.js";
import { compactBriefing } from "./compact.js";
import type { CompactBriefing } from "./compact.js";
import { collectLabelEstimationInput } from "./complexitylabels.js";
import { TOML_CONFIG_PATH } from "./config.js";
import type { ConfigFileSystem, GitRunner } from "./config.js";
import { markerTrust } from "./delivery.js";
import { provenanceComment } from "./estimate.js";
import { collect, permissionLookup } from "./github.js";
import type { Query, Rest } from "./github.js";
import { complexityMetric, impactMetric } from "./metrics.js";
import { presentBriefing, readBriefing } from "./service.js";
import type { ComplexitySize } from "./complexity.js";
import type { Issue, Page } from "./types.js";

const repo = "owner/name";
const time = "2026-11-14T10:00:00.000Z";
const recordedAt = "2026-11-14T09:00:00.000Z";
const root = "/repo";
const page = <T>(nodes: T[], more = false): Page<T> => ({
  nodes,
  pageInfo: { hasNextPage: more, endCursor: more ? "next" : null },
});
const url = (n: number) => `https://github.com/${repo}/issues/${n}`;
const commentUrl = (n: number, id: number) => `${url(n)}#issuecomment-${id}`;

type Remote = Issue["comments"]["nodes"][number];
const marker = (
  metric: "impact" | "complexity",
  size: ComplexitySize,
  n: number,
  id: number,
  login = "maintainer",
): Remote => ({
  body: provenanceComment(
    metric === "impact"
      ? {
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
          guidanceVersion: impactMetric.guidance.guidanceVersion,
          recordedAt,
        }
      : {
          schemaVersion: 2,
          kind: "complexity-estimate",
          storage: "labels",
          size,
          previous: [],
          rationale: "contained",
          assumptions: [],
          references: [],
          estimator: null,
          revision: null,
          guidanceVersion: complexityMetric.guidance.guidanceVersion,
          recordedAt,
        },
  ),
  url: commentUrl(n, id),
  author: { __typename: "User", login },
  createdAt: recordedAt,
  lastEditedAt: null,
  includesCreatedEdit: false,
  editor: null,
});
const issue = (n: number, labels: string[], comments: Remote[] = []): Issue => ({
  number: n,
  title: `Ticket ${n}`,
  body: "",
  url: url(n),
  state: "OPEN",
  stateReason: null,
  createdAt: time,
  updatedAt: time,
  issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
  blockedBy: page([]),
  blocking: page([]),
  labels: page(["status:ready", ...labels].map((name) => ({ name }))),
  comments: page(comments),
});
const sided = (n: number, impact: ComplexitySize, complexity: ComplexitySize): Issue =>
  issue(
    n,
    [`impact:${impact}`, `complexity:${complexity}`],
    [marker("impact", impact, n, n * 10 + 1), marker("complexity", complexity, n, n * 10 + 2)],
  );
/** L/S, S/L and L/L contrasts, invalid labels, unassessed, and an unverifiable author. */
const fixture = (): Issue[] => [
  sided(1, "L", "S"),
  sided(2, "S", "L"),
  sided(3, "L", "L"),
  issue(4, ["impact:high", "complexity:huge"]),
  issue(5, []),
  issue(6, ["impact:M"], [marker("impact", "M", 6, 61, "stranger")]),
  issue(7, ["impact:XS"], [marker("impact", "XS", 7, 71, "maintainer")]),
];

/** The real collector over a fake GraphQL boundary; records every query source. */
function collector(issues: () => Issue[], sources: string[] = []) {
  const query: Query = async (source) => {
    sources.push(source);
    return {
      repository: {
        issues: page(source.includes("issues(first") ? issues() : []),
        pullRequests: page([]),
      },
    };
  };
  return (repository: string, options = {}) =>
    collect(repository, options, query, () => new Date(time));
}
/** Injected permissions: `maintainer` writes; everyone else is unknown (404). */
function permissions(calls: string[] = []): Rest {
  return async (path) => {
    calls.push(path);
    const login = /collaborators\/([^/]+)\/permission/.exec(path)?.[1];
    return login === "maintainer"
      ? { status: 200, body: { role_name: "write", user: { login } } }
      : { status: 404, body: null };
  };
}
const files = (config: string | null = null): ConfigFileSystem => ({
  readText: async (file) => (config && file === join(root, TOML_CONFIG_PATH) ? config : null),
  writeText: async () => undefined,
  rename: async () => undefined,
  remove: async () => undefined,
  makeDirectory: async () => undefined,
});
const git: GitRunner = async (args) =>
  args[0] === "rev-parse" ? `${root}\n` : `origin\thttps://github.com/${repo}.git (fetch)\n`;
const estimation = (config: string | null = null) => ({ fs: files(config), git, cwd: root });

async function cliJson(rest: Rest | undefined, extra: string[] = []): Promise<CompactBriefing> {
  let out = "";
  await main(
    ["--repo", repo, "--json", "--no-update-check", "--limit", "10", ...extra],
    async (t) => void (out = t),
    {
      collect: collector(fixture),
      currentRepository: async () => repo,
      now: () => new Date(time),
      estimation: estimation(),
      ...(rest ? { rest } : {}),
    },
  );
  return JSON.parse(out) as CompactBriefing;
}
const byNumber = (report: { subjects: CompactBriefing["subjects"] }, n: number) =>
  report.subjects.find((s) => s.number === n);

describe("collection supplies the provenance trust evidence (#247)", () => {
  it("adds author type and edit history to the existing comment selections, no new request", async () => {
    const sources: string[] = [];
    const snapshot = await collector(fixture, sources)(repo);
    const issues = sources.find((s) => s.includes("issues(first"));
    expect(issues).toContain(
      "comments(first:100){nodes{body url author{__typename login} createdAt updatedAt lastEditedAt includesCreatedEdit editor{__typename login}}",
    );
    // The same issues and pull-requests queries as before: two requests for one page each.
    expect(sources).toHaveLength(2);
    expect(snapshot.issues[0]?.comments.nodes[0]?.author?.__typename).toBe("User");
  });
});

describe("side-by-side assessments (#247)", () => {
  it("shows L/S, S/L and L/L with provenance links and unlocks, in CLI JSON", async () => {
    const report = await cliJson(permissions());
    const pair = (n: number) => {
      const a = byNumber(report, n)?.assessments;
      return a && [a.impact.state, a.impact.size, a.complexity.state, a.complexity.size];
    };
    expect(pair(1)).toEqual(["current", "L", "current", "S"]);
    expect(pair(2)).toEqual(["current", "S", "current", "L"]);
    expect(pair(3)).toEqual(["current", "L", "current", "L"]);
    expect(byNumber(report, 1)?.assessments).toEqual({
      impact: { state: "current", size: "L", provenance: commentUrl(1, 11) },
      complexity: { state: "current", size: "S", provenance: commentUrl(1, 12) },
      unlocks: 0,
      unlocksUnknown: [],
    });
  });

  it("keeps invalid, unassessed and unknown visible, never a default size", async () => {
    const report = await cliJson(permissions());
    const a4 = byNumber(report, 4)?.assessments;
    expect([a4?.impact.state, a4?.complexity.state]).toEqual(["invalid", "invalid"]);
    // The legacy field is unchanged: an invalid label is still `conflicting` there.
    expect(byNumber(report, 4)?.complexity?.state).toBe("conflicting");
    const a5 = byNumber(report, 5)?.assessments;
    expect([a5?.impact, a5?.complexity]).toEqual([
      { state: "unassessed", size: null, provenance: null },
      { state: "unassessed", size: null, provenance: null },
    ]);
    // A provenance author whose permission cannot be established: unknown, not current.
    expect(byNumber(report, 6)?.assessments?.impact).toEqual({
      state: "unknown",
      size: null,
      provenance: null,
    });
  });

  it("isolates the metrics: an impact label never changes complexity, and vice versa", async () => {
    const report = await cliJson(permissions());
    const s7 = byNumber(report, 7);
    expect(s7?.assessments?.impact.size).toBe("XS");
    expect(s7?.assessments?.complexity.state).toBe("unassessed");
    expect(s7?.complexity?.state).toBe("unestimated");
    // A complexity marker never supplies impact provenance.
    expect(byNumber(report, 2)?.assessments?.impact.provenance).toBe(commentUrl(2, 21));
  });

  it("asks for each distinct marker author's permission at most once per run", async () => {
    const calls: string[] = [];
    await cliJson(permissions(calls));
    expect(calls.sort()).toEqual([
      `repos/${repo}/collaborators/maintainer/permission`,
      `repos/${repo}/collaborators/stranger/permission`,
    ]);
  });

  it("makes no permission request without a REST boundary or offline; provenance is unknown", async () => {
    const report = await cliJson(undefined);
    expect(byNumber(report, 1)?.assessments?.impact.state).toBe("unknown");
    // Hand-set labels without provenance need no trust: still current.
    expect(byNumber(report, 4)?.assessments?.impact.state).toBe("invalid");
  });

  it("reads old caches without edit history as unknown, never current", async () => {
    const snapshot = await collector(fixture)(repo);
    for (const item of snapshot.issues)
      item.comments.nodes = item.comments.nodes.map(({ body, url, author, createdAt }) => ({
        body,
        url,
        author: author && { login: author.login },
        createdAt,
      }));
    const map = await readSnapshotAssessments(snapshot, {
      impact: "available",
      complexity: "available",
      trust: markerTrust(permissionLookup(repo, permissions())),
    });
    expect(map.get(url(1))?.impact.state).toBe("unknown");
    expect(map.get(url(5))?.impact.state).toBe("unassessed");
  });

  it("is unknown on truncated labels and disabled by impact.enabled = false", async () => {
    const truncated = issue(8, ["impact:L"]);
    truncated.labels.pageInfo.hasNextPage = true;
    const map = await readSnapshotAssessments(
      { issues: [truncated], pullRequests: [] },
      { impact: "disabled", complexity: "available" },
    );
    expect(map.get(url(8))?.impact.state).toBe("disabled");
    expect(map.get(url(8))?.complexity.state).toBe("unknown");
    let out = "";
    await main(["--repo", repo, "--json", "--no-update-check"], async (t) => void (out = t), {
      collect: collector(fixture),
      currentRepository: async () => repo,
      now: () => new Date(time),
      estimation: estimation("schemaVersion = 1\n[impact]\nenabled = false\n"),
      rest: permissions(),
    });
    const report = JSON.parse(out) as CompactBriefing;
    expect(byNumber(report, 1)?.assessments?.impact.state).toBe("disabled");
    expect(byNumber(report, 1)?.assessments?.complexity.size).toBe("S");
  });

  it("renders the fixed text order with unlock utility kept separate", async () => {
    let text = "";
    await main(
      ["--repo", repo, "--no-update-check", "--limit", "10"],
      async (t) => void (text = t),
      {
        collect: collector(fixture),
        currentRepository: async () => repo,
        now: () => new Date(time),
        estimation: estimation(),
        rest: permissions(),
      },
    );
    expect(text).toContain("impact L · complexity S · unlocks at least 0");
    expect(text).toContain("impact S · complexity L · unlocks at least 0");
    expect(text).toContain("impact L · complexity L · unlocks at least 0");
    expect(text).toContain("impact invalid · complexity invalid");
    expect(text).toContain("impact unknown · complexity unassessed");
    expect(
      assessmentsText({
        impact: { state: "stale", size: "L", provenance: null },
        complexity: { state: "conflict", size: null, provenance: null },
        unlocks: 2,
        unlocksUnknown: ["dependants not collected"],
      }),
    ).toBe(
      "impact stale (was L) · complexity conflict · unlocks at least 2 (dependants incomplete)",
    );
  });

  it("links provenance in the issue detail view and adds assessments to expanded subjects", async () => {
    let text = "";
    const runtime = {
      collect: collector(fixture),
      currentRepository: async () => repo,
      now: () => new Date(time),
      estimation: estimation(),
      rest: permissions(),
    };
    await main(
      ["--repo", repo, "--no-update-check", "--issue", "1"],
      async (t) => void (text = t),
      runtime,
    );
    expect(text).toContain(
      `Provenance: impact ${commentUrl(1, 11)}; complexity ${commentUrl(1, 12)}`,
    );
    let full = "";
    await main(
      ["--repo", repo, "--no-update-check", "--full", "--json"],
      async (t) => void (full = t),
      runtime,
    );
    const expanded = JSON.parse(full) as ReturnType<typeof briefing>;
    const ready = expanded.ready.items.find((item) => item.number === 3);
    expect(ready?.assessments?.impact.size).toBe("L");
    // Unlock utility is the same count pickup ranking uses.
    expect(ready?.assessments?.unlocks).toBe(ready?.unlocks.length);
    let fullText = "";
    await main(
      ["--repo", repo, "--no-update-check", "--full"],
      async (t) => void (fullText = t),
      runtime,
    );
    expect(fullText).toContain("impact L · complexity L · unlocks at least 0");
  });

  it("returns the same assessments through the MCP read service", async () => {
    const read = await readBriefing(
      {
        collect: collector(fixture),
        dependencyReport: async () => {
          throw new Error("unused");
        },
        now: () => new Date(time),
        estimation: estimation(),
        rest: permissions(),
      },
      { repository: repo, limit: 10, maxChars: 10000 },
    );
    if (read.kind !== "report") throw new Error("expected a report");
    const report = read.report as CompactBriefing;
    expect(byNumber(report, 1)?.assessments?.complexity.provenance).toBe(commentUrl(1, 12));
  });

  it("keeps every shown row whole under a small text budget", async () => {
    const snapshot = await collector(fixture)(repo);
    const presented = await presentBriefing(
      snapshot,
      { limit: 10, maxChars: 1200 },
      estimation(),
      new Date(time),
      undefined,
      markerTrust(permissionLookup(repo, permissions())),
    );
    const lines = presented.text.split("\n");
    expect(presented.text).toContain("More context omitted by text budget");
    lines.forEach((line, i) => {
      if (/^- #\d+ Ticket \d+/.test(line)) expect(lines[i + 1]).toMatch(/^ {2}impact /);
    });
  });
});

describe("legacy complexity and estimation stay byte-compatible (#247)", () => {
  it("produces the same `complexity` and `estimation` JSON with and without assessments", async () => {
    const snapshot = await collector(fixture)(repo);
    const options = { limit: 10, maxChars: 10000 };
    const input = await collectLabelEstimationInput(repo, estimation());
    const wide = { ...options, estimation: input, limit: 2000 };
    const legacyExpanded = briefing(snapshot, wide, new Date(time));
    const legacy = compactBriefing(snapshot, options, legacyExpanded);
    const presented = await presentBriefing(
      snapshot,
      options,
      estimation(),
      new Date(time),
      undefined,
      markerTrust(permissionLookup(repo, permissions())),
    );
    const report = presented.report as CompactBriefing;
    expect(JSON.stringify(report.estimation)).toBe(JSON.stringify(legacy.estimation));
    const strip = (subjects: CompactBriefing["subjects"]) =>
      JSON.stringify(subjects.map(({ assessments: _a, ...rest }) => rest));
    expect(strip(report.subjects)).toBe(strip(legacy.subjects));
    expect(report.subjects.every((s) => s.assessments !== null)).toBe(true);
    expect(report.schemaVersion).toBe(2);
  });
});
