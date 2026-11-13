import { describe, expect, it } from "vite-plus/test";
import { catchUp, catchUpJson, catchUpText } from "./catchup.js";
import { changeSubject, resolveWindow } from "./changes.js";
import type { ChangeEvidence, EvidenceIssue, EvidencePullRequest } from "./changes.js";
import type { Comment, Issue, Page, PullRequest, Snapshot } from "./types.js";

const repo = "example/project";
const t0 = "2026-11-13T09:00:00.000Z";
const clock = () => new Date(t0);
const window = resolveWindow({ last: "24h" }, clock);
const inside = (h: number) => new Date(Date.parse(t0) - h * 3_600_000).toISOString();
const old = "2026-10-01T00:00:00.000Z";
const page = <T>(nodes: T[], more = false): Page<T> => ({
  nodes,
  pageInfo: { hasNextPage: more, endCursor: null },
});
const url = (kind: "issues" | "pull", n: number) => `https://github.com/${repo}/${kind}/${n}`;
const comment = (
  n: number,
  id: number,
  body: string,
  at: string,
  login = "shared-owner",
): Comment => ({
  body,
  url: `${url("issues", n)}#issuecomment-${id}`,
  author: { login },
  createdAt: at,
});
const issue = (n: number, labels: string[] = [], extra: Partial<Issue> = {}): Issue => ({
  number: n,
  title: `Ticket ${n}`,
  body: "",
  url: url("issues", n),
  state: "OPEN",
  stateReason: null,
  createdAt: old,
  updatedAt: old,
  issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
  blockedBy: page([]),
  blocking: page([]),
  labels: page(labels.map((name) => ({ name }))),
  comments: page([]),
  closedByPullRequestsReferences: page([]),
  ...extra,
});
const pr = (
  n: number,
  closes: number[],
  conclusion = "SUCCESS",
  extra: Partial<PullRequest> = {},
): PullRequest => ({
  ...issue(n),
  url: url("pull", n),
  title: `Change ${n}`,
  headRefOid: `sha${n}`,
  headRefName: `b${n}`,
  baseRefName: "main",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  closingIssuesReferences: page(closes.map((c) => ({ number: c, url: url("issues", c) }))),
  reviewThreads: page([]),
  reviews: page([]),
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            state: conclusion,
            contexts: page([
              conclusion === "PENDING"
                ? { name: "verify", status: "IN_PROGRESS", conclusion: null }
                : { name: "verify", status: "COMPLETED", conclusion },
            ]),
          },
        },
      },
    ],
  },
  ...extra,
});
const evidence = (subjects: ChangeEvidence["subjects"], complete = true): ChangeEvidence => ({
  schemaVersion: 1,
  window,
  scope: { includes: ["issues", "pull-requests"], excludes: ["releases"] },
  coverage: [
    { source: "issues", complete, pages: 1, nodes: 1, omission: complete ? null : "page cap" },
    { source: "pull-requests", complete: true, pages: 1, nodes: 1, omission: null },
  ],
  complete,
  subjects,
  cost: { requests: 2, maxPagesPerSource: 20 },
});
const snap = (
  issues: Issue[],
  prs: PullRequest[],
  changeEvidence?: ChangeEvidence,
  warnings: string[] = [],
): Snapshot => ({
  schemaVersion: 1,
  repository: repo,
  startedAt: t0,
  fetchedAt: "2026-11-13T09:00:05.000Z",
  issues,
  pullRequests: prs,
  dependencies: [],
  changed: [],
  since: window.from,
  ...(changeEvidence ? { changeEvidence } : {}),
  warnings,
  rateLimit: null,
});

// Change subjects, normalized through the slice 1 code so the fixture shapes stay real.
const mergedPr = changeSubject(
  "pull-request",
  {
    ...pr(20, [10]),
    state: "MERGED",
    mergedAt: inside(2),
    closedAt: inside(2),
    updatedAt: inside(1),
  } as EvidencePullRequest,
  window,
);
const completedIssue = changeSubject(
  "issue",
  {
    ...issue(10),
    state: "CLOSED",
    stateReason: "COMPLETED",
    closedAt: inside(2),
    updatedAt: inside(2),
    closedByPullRequestsReferences: page([
      { number: 20, url: url("pull", 20), repository: { nameWithOwner: repo } },
    ]),
  } as EvidenceIssue,
  window,
);
const notPlanned = changeSubject(
  "issue",
  {
    ...issue(11),
    state: "CLOSED",
    stateReason: "NOT_PLANNED",
    closedAt: inside(3),
    updatedAt: inside(3),
  } as EvidenceIssue,
  window,
);
// Closed long ago, commented today: not a new completion.
const oldClosure = changeSubject(
  "issue",
  {
    ...issue(12),
    state: "CLOSED",
    stateReason: "COMPLETED",
    closedAt: old,
    updatedAt: inside(4),
  } as EvidenceIssue,
  window,
);
const opened = changeSubject(
  "issue",
  { ...issue(13), createdAt: inside(5), updatedAt: inside(5) } as EvidenceIssue,
  window,
);
const subjects = [mergedPr, completedIssue, notPlanned, oldClosure, opened];

const current = () => {
  const claimed = issue(30, ["agent:ana", "status:ready"], {
    comments: page([
      // Two agents share one GitHub login; the agent comes from the record, not the login.
      comment(
        30,
        1,
        "Claimed by `ana` with `github-triage claim`.\n<!-- github-triage:claim:aaaa -->",
        inside(6),
      ),
    ]),
  });
  const claimedNew = issue(31, ["agent:bo"], {
    createdAt: inside(7),
    comments: page([
      comment(
        31,
        2,
        "Claimed by `bo` with `github-triage claim`.\n<!-- github-triage:claim:bbbb -->",
        inside(6),
      ),
    ]),
  });
  // An old answered question: question-shaped comment but no current workflow evidence.
  const answered = issue(32, ["status:ready"], {
    comments: page([comment(32, 3, "Should we use X?", old), comment(32, 4, "Yes, decided.", old)]),
  });
  // A current question predating the window, blocking another issue.
  const question = issue(33, ["design:decision-needed", "question"], {
    createdAt: old,
    blocking: page([
      {
        number: 31,
        title: "x",
        url: url("issues", 31),
        state: "OPEN",
        repository: { nameWithOwner: repo },
        issueDependenciesSummary: {
          blockedBy: 1,
          totalBlockedBy: 1,
          blocking: 0,
          totalBlocking: 0,
        },
      },
    ]),
    comments: page([
      comment(33, 5, "design:decision-needed — which storage format should we keep?", old),
    ]),
  });
  const candidate = issue(34, ["status:needs-design"]);
  const failing = pr(40, [30], "FAILURE");
  const waiting = pr(41, [], "PENDING", {
    reviews: page([
      {
        body: "Looks good",
        url: `${url("pull", 41)}#review-1`,
        author: { login: "shared-owner" },
        createdAt: inside(1),
        state: "APPROVED",
      },
      {
        body: "One nit",
        url: `${url("pull", 41)}#review-2`,
        author: { login: "shared-owner" },
        createdAt: inside(2),
        state: "COMMENTED",
      },
    ]),
  });
  return snap(
    [claimed, claimedNew, answered, question, candidate],
    [failing, waiting],
    evidence(subjects),
  );
};

describe("repository catch-up aggregation (#169)", () => {
  it("covers all five sections with qualified, attributed rows", () => {
    const report = catchUp(current(), { now: clock, limit: 100 });
    expect(report).toMatchObject({
      schemaVersion: 1,
      kind: "repository-briefing",
      attentionStatus: "recorded",
    });
    expect(Object.keys(report.sections)).toEqual([
      "attention",
      "completed",
      "progress",
      "blockers",
      "activity",
    ]);

    // Attention: the recorded decision predates the window and is still first; the needs-design
    // label is a candidate; the old answered question is not resurrected.
    const attention = report.sections.attention.items;
    expect(attention.map((r) => [r.subject.number, r.kind])).toEqual([
      [33, "recorded"],
      [34, "candidate"],
    ]);
    expect(attention[0]!.description).toContain("which storage format");
    expect(attention[0]!.description).toContain("Blocks #31");
    expect(attention.some((r) => r.subject.number === 32)).toBe(false);

    // Completed: the merged PR and the issue it natively closed are one row, both reasons kept;
    // not-planned is a disposition; the old closure with a new comment is not a completion.
    const completed = report.sections.completed.items;
    expect(completed.map((r) => [r.subject.number, r.kind])).toEqual([
      [20, "completed"],
      [11, "disposed"],
    ]);
    expect(completed[0]!.related).toMatchObject([{ number: 10, relation: "closes" }]);
    expect(completed[0]!.reasons).toHaveLength(2);
    expect(report.summary).toMatchObject({
      pullRequestsMerged: 1,
      issuesCompleted: 1,
      disposed: 1,
    });

    // Progress: distinct reviews stay separate; GitHub actor is not an agent; shared login
    // with two reported agents stays two agents; old closure is an updated-only observation.
    const progress = report.sections.progress.items;
    const reviews = progress.filter((r) => r.kind === "review");
    expect(reviews).toHaveLength(2);
    expect(reviews[0]!.attribution[0]).toMatchObject({
      agent: null,
      certainty: "unknown",
      githubActor: "shared-owner",
    });
    const claims = progress.filter((r) => r.kind === "claim");
    expect(new Set(claims.map((r) => r.attribution[0]!.agent))).toEqual(new Set(["ana", "bo"]));
    expect(claims.every((r) => r.attribution[0]!.githubActor === "shared-owner")).toBe(true);
    expect(claims[0]!.attribution[0]!.certainty).toBe("reported");
    expect(progress.find((r) => r.subject.number === 12)).toMatchObject({
      kind: "updated",
      uncertainty: "unknown",
    });
    expect(progress.find((r) => r.subject.number === 13)?.kind).toBe("opened");

    // Blockers: failure and waiting are distinct kinds; onset is unknown.
    const blockers = report.sections.blockers.items;
    expect(blockers.find((r) => r.subject.number === 40)?.kind).toBe("failed-checks");
    expect(blockers.find((r) => r.subject.number === 41)?.kind).toBe("waiting");
    expect(blockers.every((r) => r.description.includes("Onset unknown"))).toBe(true);
    expect(report.summary).toMatchObject({ blockers: 1, waiting: 1 });

    // Activity: grouped by agent; issue + linked PR once; old work is ongoing, not new.
    expect(report.activityGroups.map((g) => g.agent)).toEqual(["ana", "bo", null]);
    const ana = report.sections.activity.items.find((r) => r.subject.number === 30)!;
    expect(ana.related).toMatchObject([{ number: 40 }]);
    expect(ana.description).toContain("ongoing (not new)");
    expect(ana.next).toContain("Fix failing checks");
    expect(
      report.sections.activity.items.find((r) => r.subject.number === 31)!.description,
    ).toContain("started in window");
    expect(report.sections.activity.items.some((r) => r.subject.number === 40)).toBe(false);
    expect(report.checkpoint.candidate).toBe(t0);
  });

  it("deduplicates by subject and event identity, never by title, and orders stably", () => {
    const twin = changeSubject(
      "issue",
      {
        ...issue(14),
        title: "Ticket 13",
        createdAt: inside(5),
        updatedAt: inside(5),
      } as EvidenceIssue,
      window,
    );
    const data = current();
    data.changeEvidence = evidence([...subjects, opened, twin].reverse());
    const a = catchUp(data, { now: clock, limit: 100 });
    const openedRows = a.sections.progress.items.filter((r) => r.kind === "opened");
    expect(openedRows.map((r) => r.subject.number)).toEqual([13, 14]);
    const shuffled = {
      ...data,
      issues: [...data.issues].reverse(),
      pullRequests: [...data.pullRequests].reverse(),
    };
    shuffled.changeEvidence = evidence([...subjects, twin]);
    expect(catchUpJson(catchUp(shuffled, { now: clock, limit: 100 }))).toBe(catchUpJson(a));
    const times = a.sections.progress.items.map((r) => Date.parse(r.at!));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
  });

  it("never presents unavailable or incomplete history as no changes", () => {
    const legacy = catchUp(snap([], []), { now: clock });
    expect(legacy.completeness).toMatchObject({ complete: false, history: "unavailable" });
    expect(legacy.attentionStatus).toBe("none-evidenced");
    expect(legacy.checkpoint.candidate).toBeNull();
    const text = catchUpText(legacy);
    expect(text).toContain("not evidence of no change");
    expect(text).not.toMatch(/0 PR\(s\) merged/);

    const partial = catchUp(snap([], [], evidence([], false), ["Open issues truncated"]), {
      now: clock,
    });
    expect(partial.completeness.history).toBe("incomplete");
    expect(partial.attentionStatus).toBe("unknown");
    expect(catchUpText(partial)).toContain("Owner attention: UNKNOWN");

    const quiet = catchUp(snap([], [], evidence([])), { now: clock });
    expect(quiet.completeness.complete).toBe(true);
    expect(catchUpText(quiet)).toContain("None in collected evidence");
  });

  it("treats a baseline as current state only", () => {
    const baseline = resolveWindow({ checkpoint: { through: null } }, clock);
    const data = current();
    data.changeEvidence = { ...evidence([]), window: baseline, coverage: [] };
    const report = catchUp(data, { now: clock });
    expect(report.completeness.history).toBe("baseline");
    expect(report.sections.progress.total).toBe(0);
    expect(report.sections.activity.items.every((r) => r.description.includes("ongoing"))).toBe(
      true,
    );
    expect(catchUpText(report)).toContain("No previous comparison window");
  });

  it("bounds rows and text, keeping omission and window notices", () => {
    const report = catchUp(current(), { now: clock, limit: 1 });
    expect(report.omissions).toMatchObject({ attention: 1, completed: 1 });
    const text = catchUpText(report, 1000);
    expect(text.length).toBeLessThanOrEqual(1001);
    expect(text).toContain("Window ");
    expect(text).toContain("Omitted rows: attention 1");
    expect(() => catchUp(current(), { now: clock, limit: 0 })).toThrow("--limit");
    expect(() => catchUpText(report, 999)).toThrow("--max-chars");
  });

  it("highlights attention addressed to the viewer without filtering history", () => {
    const data = current();
    data.issues.push(issue(35, ["attention:ana", "origin:bo"]));
    const report = catchUp(data, { now: clock, agent: "ana", limit: 100 });
    expect(report.sections.attention.items[0]!.subject.number).toBe(35);
    expect(report.sections.attention.items[0]!.attribution).toMatchObject([
      { agent: "bo", relation: "origin", certainty: "reported" },
    ]);
    expect(report.sections.progress.total).toBe(
      catchUp(current(), { now: clock, limit: 100 }).sections.progress.total,
    );
  });

  it("keeps the whole text, header and footer included, within every allowed budget", () => {
    const long = (n: number) => `Collection warning ${n}: ${"x".repeat(900)}`;
    for (const count of [0, 1, 5, 40])
      for (const budget of [1000, 1200, 2500, 10000, 40000]) {
        const warnings = Array.from({ length: count }, (_, n) => long(n));
        const data = snap(current().issues, current().pullRequests, evidence(subjects), warnings);
        const report = catchUp(data, { now: clock, limit: 100 });
        const text = catchUpText(report, budget);
        expect(text.length, `${count} warnings at ${budget}`).toBeLessThanOrEqual(budget);
        expect(text).toContain("Window ");
        expect(text).toContain("Scope: ");
        expect(text).toMatch(/Omitted rows|No rows omitted/);
        if (count)
          expect(text).toContain(`INCOMPLETE: ${report.completeness.warnings.length} collection`);
      }
  });

  it("offers a checkpoint candidate for a complete baseline only", () => {
    const baseline = resolveWindow({ checkpoint: { through: null } }, clock);
    const data = current();
    data.changeEvidence = { ...evidence([]), window: baseline };
    expect(catchUp(data, { now: clock }).checkpoint.candidate).toBe(baseline.through);

    data.changeEvidence = { ...evidence([], false), window: baseline };
    expect(catchUp(data, { now: clock }).checkpoint.candidate).toBeNull();
    const failed = snap(current().issues, [], { ...evidence([]), window: baseline }, ["truncated"]);
    expect(catchUp(failed, { now: clock }).checkpoint.candidate).toBeNull();
  });

  it("groups a merged PR only with the exact issue that links back to it", () => {
    const other = "https://github.com/other/repo/issues/10";
    const crossPr = changeSubject(
      "pull-request",
      {
        ...pr(20, []),
        closingIssuesReferences: page([{ number: 10, url: other }]),
        state: "MERGED",
        mergedAt: inside(2),
        closedAt: inside(2),
        updatedAt: inside(1),
      } as EvidencePullRequest,
      window,
    );
    // Local #10 links back to PR #20 by number, but the PR closes other/repo#10.
    let report = catchUp(snap([], [], evidence([crossPr, completedIssue])), {
      now: clock,
      limit: 100,
    });
    const rows = report.sections.completed.items;
    expect(rows.map((r) => r.subject.number).sort()).toEqual([10, 20]);
    expect(rows.find((r) => r.subject.number === 20)!.related).toMatchObject([{ url: other }]);

    // Issue #10 is completed and only carries a dependency link numbered 20, not closed-by.
    const dependent = changeSubject(
      "issue",
      {
        ...issue(10),
        state: "CLOSED",
        stateReason: "COMPLETED",
        closedAt: inside(2),
        updatedAt: inside(2),
        blocking: page([
          {
            number: 20,
            title: "x",
            url: url("issues", 20),
            state: "OPEN",
            repository: { nameWithOwner: repo },
            issueDependenciesSummary: {
              blockedBy: 0,
              totalBlockedBy: 0,
              blocking: 0,
              totalBlocking: 0,
            },
          },
        ]),
      } as EvidenceIssue,
      window,
    );
    report = catchUp(snap([], [], evidence([mergedPr, dependent])), { now: clock, limit: 100 });
    expect(report.sections.completed.items.map((r) => r.subject.number).sort()).toEqual([10, 20]);
  });
});
