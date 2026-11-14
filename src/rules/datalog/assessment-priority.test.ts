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
// Scenario fixtures for #356 (assessment-first priority). They pin TODAY's
// default-engine order so a later policy change shows up as a reviewed diff.
const order = (
  issues: Issue[],
  as: Array<[Issue, SubjectAssessments]>,
  opts: Partial<Parameters<typeof evaluateDatalog>[2]> = {},
  prs: PullRequest[] = [],
) =>
  evaluateDatalog(snap(issues, prs), new Map(as.map(([i, a]) => [i.url, a])), {
    role: "implementer",
    limit: 100,
    ...opts,
  }).items.map((x) => `${x.target.split("/").slice(-2).join("/")} ${x.kind} b${x.band}`);
const blockedBy = (a: Issue, b: Issue): void => {
  a.issueDependenciesSummary = { blockedBy: 1, totalBlockedBy: 1, blocking: 0, totalBlocking: 0 };
  a.blockedBy = page([
    {
      ...b,
      repository: { nameWithOwner: "o/r" },
      issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 1, totalBlocking: 1 },
    },
  ]);
};
describe("assessment-first scenarios (#356), current order", () => {
  it("S1 ready PR versus estimate", () => {
    const a = issue(1);
    expect(order([a], [[a, pair(metric("L"))]], {}, [pr(2)])).toEqual([
      "pull/2 pr-follow-up b2",
      "issues/1 estimate-complexity b5",
      "issues/1 implement b6",
    ]);
  });
  it("S2 high-impact unknown complexity versus ordinary implementation", () => {
    const a = issue(1),
      b = issue(2);
    expect(
      order(
        [a, b],
        [
          [a, pair(metric("L"))],
          [b, pair(metric("M"), metric("M"))],
        ],
      ),
    ).toEqual([
      "issues/1 estimate-complexity b5",
      "issues/1 implement b6",
      "issues/2 implement b6",
    ]);
  });
  it("S3 small-complexity unknown benefit versus new design work (designer)", () => {
    const a = issue(1),
      d = issue(2, ["status:needs-design"]);
    expect(
      order(
        [a, d],
        [
          [a, pair(metric(), metric("S"))],
          [d, pair(metric("M"), metric("M"))],
        ],
        { role: "designer" },
      ),
    ).toEqual(["issues/1 assess-impact b5", "issues/2 design b6"]);
  });
  it("S4 known easy win versus unassessed ticket", () => {
    const a = issue(1),
      b = issue(2);
    expect(
      order(
        [a, b],
        [
          [a, pair(metric("L"), metric("S"))],
          [b, pair()],
        ],
      ),
    ).toEqual([
      "issues/1 implement b4",
      "issues/2 estimate-complexity b5",
      "issues/2 implement b6",
    ]);
  });
  it("S5 large unassessed backlog versus one known easy win", () => {
    const easy = issue(1),
      backlog = [2, 3, 4, 5, 6].map((n) => issue(n));
    expect(
      order(
        [easy, ...backlog],
        [
          [easy, pair(metric("XL"), metric("S"))],
          ...backlog.map((b) => [b, pair()] as [Issue, SubjectAssessments]),
        ],
      ),
    ).toEqual([
      "issues/1 implement b4",
      "issues/2 estimate-complexity b5",
      "issues/3 estimate-complexity b5",
      "issues/4 estimate-complexity b5",
      "issues/5 estimate-complexity b5",
      "issues/6 estimate-complexity b5",
      "issues/2 implement b6",
      "issues/3 implement b6",
      "issues/4 implement b6",
      "issues/5 implement b6",
      "issues/6 implement b6",
    ]);
  });
  it("S6 already active implementation versus estimate", () => {
    const own = issue(1, ["agent:me"]),
      b = issue(2);
    expect(
      order(
        [own, b],
        [
          [own, pair(metric("M"), metric("M"))],
          [b, pair(metric("L"))],
        ],
        { agent: "me" },
      ),
    ).toEqual([
      "issues/2 estimate-complexity b5",
      "issues/1 continue-implementation b6",
      "issues/2 implement b6",
    ]);
  });
  it("S7 blocked but estimable ticket", () => {
    const a = issue(1),
      blocker = issue(2, ["agent:other"]);
    blockedBy(a, blocker);
    expect(
      order(
        [a, blocker],
        [
          [a, pair(metric("L"))],
          [blocker, pair(metric("M"), metric("M"))],
        ],
      ),
    ).toEqual(["issues/1 estimate-complexity b5"]);
  });
});
