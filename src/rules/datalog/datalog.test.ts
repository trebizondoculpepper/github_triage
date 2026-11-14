import { describe, it, expect } from "vite-plus/test";
import { evaluateDatalog } from "./datalog.js";
import type { Snapshot, Issue, Page, PullRequest } from "../../github/types.js";
import type { SubjectAssessments, MetricView } from "../../assessments.js";
const page = <T>(nodes: T[] = []): Page<T> => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});
const issue = (number: number, labels = ["status:ready"]): Issue => ({
  number,
  title: `Ticket ${number}`,
  body: "",
  url: `https://github.com/o/r/issues/${number}`,
  state: "OPEN",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  labels: page(labels.map((name) => ({ name }))),
  comments: page(),
  blockedBy: page(),
  blocking: page(),
  issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
  closedByPullRequestsReferences: page(),
});
const snap = (issues: Issue[], pullRequests: PullRequest[] = []): Snapshot => ({
  schemaVersion: 1,
  repository: "o/r",
  startedAt: "2026-01-01T00:00:00Z",
  fetchedAt: "2026-01-01T00:00:00Z",
  issues,
  pullRequests,
  dependencies: [],
  changed: [],
  since: null,
  warnings: [],
  rateLimit: null,
});
const metric = (
  size: MetricView["size"] = null,
  state: MetricView["state"] = size ? "current" : "unassessed",
): MetricView => ({ size, state, provenance: null });
const pair = (impact = metric(), complexity = metric()): SubjectAssessments => ({
  impact,
  complexity,
  unlocks: 999,
  unlocksUnknown: [],
});
describe("Datalog live policy", () => {
  it("chooses easy implementation, boosted assessment, then unfavorable work with matched reasons", () => {
    const a = issue(1),
      b = issue(2),
      c = issue(3);
    const result = evaluateDatalog(
      snap([a, b, c]),
      new Map([
        [a.url, pair(metric("L"), metric("S"))],
        [b.url, pair(metric("L"), metric())],
        [c.url, pair(metric("S"), metric("XL"))],
      ]),
      { role: "implementer", limit: 100 },
    );
    expect(result.items.map((r) => [r.target, r.kind, r.band])).toEqual([
      [a.url, "implement", 4],
      [b.url, "estimate-complexity", 5],
      [b.url, "implement", 6],
      [c.url, "implement", 7],
    ]);
    expect(result.items[0].why).toMatchObject({
      text: "Known easy win: impact L, complexity S.",
      ruleIds: ["D-EASY"],
      facts: { impact: "L", complexity: "S" },
    });
    expect(result.items[0].unlocks).toBe(0); // Ignores the legacy supplied unlock score.
  });
});

const pr = (n: number, checks: string[] = ["SUCCESS"]): PullRequest => ({
  ...issue(n, []),
  url: `https://github.com/o/r/pull/${n}`,
  headRefOid: `head${n}`,
  headRefName: "branch",
  baseRefName: "main",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  closingIssuesReferences: page(),
  reviewThreads: page(),
  reviews: page(),
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            state: "SUCCESS",
            contexts: page(
              checks.map((conclusion, i) => ({
                name: i === 0 ? "verify" : `test${i}`,
                conclusion,
              })),
            ),
          },
        },
      },
    ],
  },
});
const run = (
  issues: Issue[],
  as: Map<string, SubjectAssessments> = new Map(),
  opts: Partial<Parameters<typeof evaluateDatalog>[2]> = {},
  prs: PullRequest[] = [],
) => evaluateDatalog(snap(issues, prs), as, { role: "implementer", limit: 100, ...opts });
const implementations = (r: ReturnType<typeof run>) =>
  r.items.filter((x) => x.kind === "implement");
describe("Datalog evidence and action scenarios", () => {
  it("preserves every attention destination and puts addressed work first even when parked", () => {
    const a = issue(1, ["status:parked", "attention:other", "attention:me"]);
    expect(run([a], new Map(), { agent: "me" }).items[0]).toMatchObject({
      kind: "addressed-response",
      band: 1,
    });
  });
  it("denies pickup for any owner, blocker or question and still allows blocked assessments", () => {
    for (const tags of [
      ["status:ready", "agent:first", "agent:second"],
      ["status:ready", "question"],
    ])
      expect(implementations(run([issue(1, tags)]))).toHaveLength(0);
    const a = issue(1);
    a.issueDependenciesSummary = { blockedBy: 1, totalBlockedBy: 1, blocking: 0, totalBlocking: 0 };
    a.blockedBy = page([
      {
        ...issue(2),
        repository: { nameWithOwner: "o/r" },
        issueDependenciesSummary: {
          blockedBy: 0,
          totalBlockedBy: 0,
          blocking: 1,
          totalBlocking: 1,
        },
      },
    ]);
    expect(run([a], new Map([[a.url, pair()]])).items.map((x) => x.kind)).toEqual([
      "estimate-complexity",
    ]);
  });
  it("unknown native, label and closing coverage cannot permit implementation", () => {
    const a = issue(1);
    delete a.blockedBy;
    expect(implementations(run([a]))).toHaveLength(0);
    const b = issue(2);
    b.labels.pageInfo.hasNextPage = true;
    expect(implementations(run([b]))).toHaveLength(0);
    const c = issue(3);
    delete c.closedByPullRequestsReferences;
    const p = pr(4);
    p.closingIssuesReferences.pageInfo.hasNextPage = true;
    expect(implementations(run([c], new Map(), {}, [p]))).toHaveLength(0);
  });
  it("matches any allowed platform and treats unknown or mismatched platform as non-pickup", () => {
    const a = issue(1, ["status:ready", "platform:claude-code", "platform:codex"]);
    expect(implementations(run([a], new Map(), { platform: "codex" }))).toHaveLength(1);
    expect(implementations(run([a]))).toHaveLength(0);
    expect(implementations(run([a], new Map(), { platform: "other" }))).toHaveLength(0);
  });
  it("PR follow-up beats new work; running checks alone are waiting", () => {
    const a = issue(1),
      f = pr(2, ["FAILURE"]),
      p = pr(3, ["IN_PROGRESS"]);
    const result = run([a], new Map(), {}, [f, p]);
    expect(result.items[0]).toMatchObject({ target: f.url, kind: "pr-follow-up" });
    expect(result.items.some((x) => x.target === p.url)).toBe(false);
  });
  it("own linked PR follow-up precedes review opportunities, and incomplete evidence never permits merge advice", () => {
    const a = issue(1, ["agent:me"]),
      own = pr(3, ["FAILURE"]),
      other = pr(2, ["FAILURE"]);
    own.closingIssuesReferences = page([{ number: a.number, url: a.url }]);
    expect(run([a], new Map(), { agent: "me" }, [other, own]).items[0].target).toBe(own.url);
    const missing = pr(4);
    missing.reviewThreads.pageInfo.hasNextPage = true;
    expect(run([], new Map(), {}, [missing]).items).toHaveLength(0);
  });
  it("current-head clean PR yields consideration, never an approval", () => {
    const p = pr(1);
    const r = run([], new Map(), {}, [p]);
    expect(r.items[0].why.text).toContain("then consider merge");
    expect(r.items[0].why.facts.head).toBe("head1");
  });
  it("designer duties precede assessment and small complexity boosts impact assessment", () => {
    const a = issue(1, ["design:decision-needed"]),
      b = issue(2),
      c = issue(3);
    const result = run(
      [a, b, c],
      new Map([
        [b.url, pair(metric(), metric("S"))],
        [c.url, pair()],
      ]),
      { role: "designer" },
    );
    expect(result.items.map((x) => x.kind)).toEqual(["decide", "assess-impact", "assess-impact"]);
    expect(result.items[1].target).toBe(b.url);
  });
  it("explicit age order coalesces pickup bands and ignores urgency/value weights", () => {
    const a = issue(1, ["status:ready", "urgency:low"]),
      b = issue(2, ["status:ready", "urgency:high"]);
    a.createdAt = "2025-01-01T00:00:00Z";
    const as = new Map([
      [a.url, pair(metric("S"), metric("XL"))],
      [b.url, pair(metric("L"), metric("S"))],
    ]);
    expect(implementations(run([a, b], as, { order: "oldest" })).map((x) => x.target)).toEqual([
      a.url,
      b.url,
    ]);
    expect(implementations(run([a, b], as, { order: "newest" })).map((x) => x.target)).toEqual([
      b.url,
      a.url,
    ]);
  });
  it("disabled and unknown metrics do not create estimates or easy wins", () => {
    const a = issue(1);
    for (const state of ["disabled", "unknown"] as const) {
      const result = run([a], new Map([[a.url, pair(metric("L", state), metric("S", state))]]));
      expect(result.items.map((x) => x.band)).toEqual([6]);
    }
  });
  it("counts immediate distinct eligible dependents only, independently from supplied scores", () => {
    const a = issue(1),
      b = issue(2),
      c = issue(3, ["status:needs-design"]);
    for (const dependent of [b, c]) {
      dependent.issueDependenciesSummary = {
        blockedBy: 1,
        totalBlockedBy: 1,
        blocking: 0,
        totalBlocking: 0,
      };
      dependent.blockedBy = page([
        {
          ...a,
          repository: { nameWithOwner: "o/r" },
          issueDependenciesSummary: {
            blockedBy: 0,
            totalBlockedBy: 0,
            blocking: 2,
            totalBlocking: 2,
          },
        },
      ]);
    }
    a.blocking = page(
      [b, b, c].map((d) => ({
        ...d,
        repository: { nameWithOwner: "o/r" },
        issueDependenciesSummary: d.issueDependenciesSummary!,
      })),
    );
    a.issueDependenciesSummary = { blockedBy: 0, totalBlockedBy: 0, blocking: 2, totalBlocking: 3 };
    expect(implementations(run([a, b, c]))[0].unlocks).toBe(1);
  });
  it("numeric ties are stable and missing bindings never fall back to legacy explanations", () => {
    const a = issue(10),
      b = issue(2);
    expect(implementations(run([a, b])).map((x) => x.target)).toEqual([b.url, a.url]);
    expect(run([a]).items.every((x) => x.why.ruleIds.length > 0 && x.why.text.length > 0)).toBe(
      true,
    );
  });
  it("bounds scope, reports soft budget and honors cancellation", () => {
    expect(() => run(Array.from({ length: 501 }, (_, i) => issue(i)))).toThrow(
      "experimental-scope-exceeded",
    );
    let clock = 0;
    expect(
      run([issue(1)], new Map(), { now: () => (clock += 3000) }).decisionEngine.diagnostics[0],
    ).toContain("soft");
    const c = new AbortController();
    c.abort();
    expect(() => run([], new Map(), { signal: c.signal })).toThrow();
  });
});

it("coalesces equally ranked PR findings before limiting, preserving overridden rule identity", () => {
  const p = pr(1, ["FAILURE"]);
  p.reviewDecision = "CHANGES_REQUESTED";
  const result = run([], new Map(), {}, [p]);
  expect(result.items).toHaveLength(1);
  expect(result.total).toBe(1);
  expect(result.items[0].why.overriddenRuleIds).toContain("D-PR-REVIEW");
});

it("ignores closed retained claims when planning a new pickup", () => {
  const old = issue(1, ["agent:me"]);
  old.state = "CLOSED";
  const a = issue(2);
  const row = implementations(run([old, a], new Map(), { agent: "me" }))[0];
  expect(row.nextCommand).toContain("claim 2");
  expect(row.thenCommand).toBeNull();
});
it("returns rule-specific matched failed-check and incomplete-evidence bindings", () => {
  const failed = run([], new Map(), {}, [pr(1, ["FAILURE"])]).items[0];
  expect(failed.why.facts.failedChecks).toBe("verify:FAILURE");
  const a = issue(2);
  delete a.blockedBy;
  const inspection = run([a]).items.find((x) => x.kind === "inspect")!;
  expect(inspection.why.facts.uncertainty).toContain("native dependencies incomplete");
});

it("routes PR attention and designer duties to PR inspection", () => {
  for (const label of ["attention:me", "design:decision-needed", "design:documentation-needed"]) {
    const p = pr(1, ["IN_PROGRESS"]);
    p.labels = page([{ name: label }]);
    const row = run([], new Map(), { agent: "me", role: "designer" }, [p]).items[0];
    expect(row.nextCommand).toBe("pdb pr 1 --repo o/r");
  }
});
