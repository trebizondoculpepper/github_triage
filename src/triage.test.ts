import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  argumentsFor,
  atomicJson,
  cachedSnapshot,
  checkpointSince,
  depsArgumentsFor,
  main,
} from "./cli.js";
import {
  applyDependencyChange,
  completeNative,
  isRateLimit,
  RateLimitError,
  dependencyReport,
  dependencyText,
  planDependencyChange,
} from "./dependencies.js";
import { briefing, dependencyDone, textReport } from "./briefing.js";
import { collect, declaredDependencies, graphqlAnswer, pages, type Query } from "./github.js";
import { clauseFor, hedged, listWideHedge, planMigration } from "./migration.js";
import { applyPlan, planClaim, planNeedsHuman } from "./claims.js";
import type { Issue, Page, PullRequest, Snapshot } from "./types.js";

const repo = "example/project";
const time = "2026-11-12T10:00:00.000Z";
const page = <T>(nodes: T[], more = false, cursor: string | null = null): Page<T> => ({
  nodes,
  pageInfo: { hasNextPage: more, endCursor: cursor },
});
const issue = (number = 1, labels = ["status:ready"]): Issue => ({
  number,
  title: `Ticket ${number}`,
  body: "Use [design](doc/game-architecture.md).",
  url: `https://github.com/${repo}/issues/${number}`,
  state: "OPEN",
  stateReason: null,
  createdAt: time,
  updatedAt: time,
  issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
  blockedBy: page([]),
  blocking: page([]),
  labels: page(labels.map((name) => ({ name }))),
  comments: page([]),
});
const pr = (): PullRequest => ({
  ...issue(4, []),
  url: `https://github.com/${repo}/pull/4`,
  headRefOid: "abc123",
  headRefName: "feature",
  baseRefName: "main",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  closingIssuesReferences: page([{ number: 1, url: issue().url }]),
  reviewThreads: page([]),
  reviews: page([]),
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            state: "SUCCESS",
            contexts: page([{ name: "verify", status: "COMPLETED", conclusion: "SUCCESS" }]),
          },
        },
      },
    ],
  },
});
const snapshot = (issues = [issue()], prs: PullRequest[] = [pr()]): Snapshot => ({
  schemaVersion: 1,
  repository: repo,
  startedAt: time,
  fetchedAt: time,
  issues,
  pullRequests: prs,
  dependencies: [],
  changed: [],
  since: null,
  warnings: [],
  rateLimit: null,
});
const brief = (data: Snapshot) => briefing(data, { limit: 100 }, new Date(time));

describe("paginated facts and explicit dependency scope", () => {
  it("walks all cursors and rejects repeating cursors", async () => {
    const cursors: (string | undefined)[] = [];
    expect(
      await pages(async (cursor) => {
        cursors.push(cursor);
        return cursor ? page([2]) : page([1], true, "next");
      }),
    ).toEqual([1, 2]);
    expect(cursors).toEqual([undefined, "next"]);
    await expect(pages(async () => page([1], true, "same"))).rejects.toThrow("did not advance");
  });
  it("distinguishes declared, incidental and cross-repository references", () => {
    const refs = declaredDependencies(
      "Epic #99 and evidence #77.\nDepends on #2 and https://github.com/other/repo/pull/3.\n## Dependencies\n- #5\n## Notes\n- #6",
      repo,
    );
    expect(refs.map((ref) => `${ref.repository}#${ref.number}`)).toEqual([
      "other/repo#3",
      `${repo}#2`,
      `${repo}#5`,
    ]);
  });
  it("accepts an explicit declaration after a sentence and ignores subsequent prose links", () => {
    expect(
      declaredDependencies(
        "Owner asks for work. **Depends on:** #2. See #99 for an unrelated example.",
        repo,
      ).map((ref) => ref.number),
    ).toEqual([2]);
  });
  it("never equates a closed unplanned issue or unknown reference with completed work", () => {
    const ref = { repository: repo, number: 2, url: "url", available: true, state: "CLOSED" };
    expect(dependencyDone({ ...ref, stateReason: "NOT_PLANNED" })).toBe(false);
    expect(dependencyDone(ref)).toBe(false);
    expect(dependencyDone({ ...ref, stateReason: "COMPLETED" })).toBe(true);
    expect(dependencyDone({ ...ref, state: "MERGED" })).toBe(true);
  });
  it("collects primary pages, all comment pages, a closed prerequisite and since changes", async () => {
    const first = issue();
    first.body = "Depends on #8.";
    first.issueDependenciesSummary!.totalBlockedBy = 1;
    first.blockedBy = page([
      {
        ...issue(8),
        state: "CLOSED",
        stateReason: "COMPLETED",
        repository: { nameWithOwner: repo },
        issueDependenciesSummary: {
          blockedBy: 0,
          totalBlockedBy: 0,
          blocking: 0,
          totalBlocking: 0,
        },
      },
    ]);
    first.comments = page(
      [{ body: "A question?", url: "comment1", author: null }],
      true,
      "comments2",
    );
    const calls: string[] = [];
    const query: Query = async (source, vars) => {
      calls.push(source);
      if (source.includes("issueOrPullRequest(number") && source.includes("comments(first"))
        return {
          repository: {
            issueOrPullRequest: {
              comments: page([{ body: "Answered", url: "comment2", author: { login: "owner" } }]),
            },
          },
        };
      if (source.includes("issueOrPullRequest(number"))
        return {
          repository: {
            issueOrPullRequest: {
              title: "Completed",
              state: "CLOSED",
              stateReason: "COMPLETED",
              url: "dependency",
            },
          },
        };
      if (source.includes("pullRequests(first")) return { repository: { pullRequests: page([]) } };
      if (source.includes("states:OPEN"))
        return {
          repository: { issues: vars.cursor ? page([issue(2)]) : page([first], true, "issues2") },
        };
      return { repository: { issues: page([{ ...issue(9), state: "CLOSED" }]) } };
    };
    const data = await collect(repo, { since: time }, query, () => new Date(time));
    expect(data.issues).toHaveLength(2);
    expect(data.issues[0]!.comments.nodes.map((comment) => comment.body)).toEqual([
      "A question?",
      "Answered",
    ]);
    expect(data.dependencies[0]?.stateReason).toBe("COMPLETED");
    expect(data.changed[0]?.state).toBe("CLOSED");
    expect(calls.some((source) => source.includes("after:$cursor"))).toBe(true);
  });
  it("reports incomplete nested PR evidence rather than claiming merge readiness", async () => {
    const pull = pr();
    pull.reviewThreads.pageInfo = { hasNextPage: true, endCursor: "next" };
    const data = await collect(
      repo,
      {},
      async (source) => ({
        repository: {
          issues: page([]),
          pullRequests: page(source.includes("pullRequests(first") ? [pull] : []),
        },
      }),
      () => new Date(time),
    );
    expect(data.warnings[0]).toContain("review threads");
    expect(brief(data).actions.items.some((item) => item.rule === "pr-inspect-merge")).toBe(false);
  });
});

describe("registered action analysis", () => {
  it("shows ownership conflicts, stale ready labels and absent readiness", () => {
    const data = brief(snapshot([issue(1, ["agent:a", "agent:b", "status:ready"]), issue(2, [])]));
    expect(data.actions.items.map((item) => item.rule)).toEqual(
      expect.arrayContaining(["ownership-conflict", "claimed-ready", "readiness-inconsistent"]),
    );
    expect(data.ready.total).toBe(0);
  });
  it("gives parked work no pickup action, and closed full-detail issues no active actions", () => {
    const closed = { ...issue(2), state: "CLOSED" };
    const data = brief(snapshot([issue(1, ["status:parked"]), closed], []));
    expect(data.actions.total).toBe(0);
    expect(data.parked.total).toBe(1);
  });
  it("flags questions as candidates while retaining later answers in full detail", () => {
    const one = issue();
    one.comments.nodes = [
      { body: "Should this be blue?", url: "question", author: null },
      { body: "Use blue. Resolved.", url: "answer", author: null },
    ];
    const data = briefing(snapshot([one], []), { limit: 100, issue: 1 }, new Date(time));
    const candidate = data.actions.items.find((item) => item.rule === "question-candidate")!;
    expect(candidate.uncertainty).toBe("candidate");
    expect(candidate.next).toContain("already be answered");
    expect(data.detail!.comments.nodes.at(-1)!.body).toContain("Resolved");
  });
  it("requires the actual verify check and does not infer success from another green job", () => {
    const pull = pr();
    pull.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes[0]!.name = "unrelated";
    const findings = brief(snapshot([], [pull])).actions.items;
    expect(findings.some((item) => item.rule === "pr-inspect-merge")).toBe(false);
    expect(findings.some((item) => item.rule === "pr-verification-needed")).toBe(true);
  });
  it("failed CI, unresolved/outdated reviews and pending checks prevent merge candidates", () => {
    const pull = pr();
    pull.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes.push(
      { name: "lint", conclusion: "FAILURE" },
      { name: "slow", status: "IN_PROGRESS" },
    );
    pull.reviewThreads.nodes.push({
      isResolved: false,
      isOutdated: true,
      comments: page([{ body: "Fix this", url: "finding", author: null }]),
    });
    const findings = brief(snapshot([], [pull])).actions.items.map((item) => item.rule);
    expect(findings).toEqual(
      expect.arrayContaining(["pr-failed-checks", "pr-review-findings", "pr-pending"]),
    );
    expect(findings).not.toContain("pr-inspect-merge");
  });
  it("clean checks are only a source-linked inspection candidate with head identity", () => {
    const data = brief(snapshot([], [pr()]));
    expect(data.actions.items.find((item) => item.rule === "pr-inspect-merge")?.uncertainty).toBe(
      "candidate",
    );
    expect(data.pullRequests[0]?.headRefOid).toBe("abc123");
    expect(data.actions.items[0]?.next).toContain("not approval");
  });
  it("keeps stable ordering and reports omitted actions instead of silently hiding them", () => {
    const source = snapshot([issue(3), issue(2), issue(1)], []);
    const a = briefing(source, { limit: 1 }, new Date(time));
    expect(a.actions.total).toBe(3);
    expect(a.actions.omitted).toBe(2);
    expect(textReport(a)).toContain("2 more omitted");
    expect(a).toEqual(briefing(source, { limit: 1 }, new Date(time)));
  });
});

describe("intake evidence boundaries", () => {
  it("flags ready work with unresolved native prerequisites without claiming it", () => {
    const one = issue();
    one.body = "Depends on #8.";
    const data = snapshot([one], []);
    one.issueDependenciesSummary!.blockedBy = 1;
    one.issueDependenciesSummary!.totalBlockedBy = 1;
    one.blockedBy = page([
      {
        ...issue(8),
        repository: { nameWithOwner: repo },
        issueDependenciesSummary: {
          blockedBy: 0,
          totalBlockedBy: 0,
          blocking: 0,
          totalBlocking: 0,
        },
      },
    ]);
    const finding = brief(data).actions.items.find(
      (item) => item.rule === "ready-prerequisites-unverified",
    );
    expect(finding?.uncertainty).toBe("candidate");
    expect(finding?.evidence).toContain(`https://github.com/${repo}/issues/8`);
  });
  it("does not label an arbitrary issue link as architectural evidence", () => {
    const one = issue();
    one.body = "See https://github.com/example/project/issues/9 and doc/game-architecture.md.";
    const data = brief(snapshot([one], []));
    expect(data.ready.items[0]?.documentation).toEqual(["doc/game-architecture.md"]);
  });
  it("does not propose merge when mergeability is unknown", () => {
    const pull = pr();
    pull.mergeable = "UNKNOWN";
    expect(
      brief(snapshot([], [pull])).actions.items.some((item) => item.rule === "pr-inspect-merge"),
    ).toBe(false);
  });
});

describe("CLI freshness and local state safety", () => {
  it("validates options before collecting and requires explicit offline cache", () => {
    expect(() => argumentsFor(["--offline"])).toThrow("requires");
    expect(() => argumentsFor(["--repo", "bad"])).toThrow("owner/name");
    expect(() => argumentsFor(["--since", "yesterday"])).toThrow("ISO");
    expect(() => argumentsFor(["--limit", "0"])).toThrow("positive");
    expect(() => argumentsFor(["--offline", "--cache", "x", "--since", time])).toThrow(
      "live fetch",
    );
  });
  it("labels old cached snapshots offline, preserves checkpoint and rejects repository mismatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-test-"));
    try {
      const cache = join(dir, "cache.json"),
        checkpoint = join(dir, "checkpoint.json");
      await atomicJson(cache, snapshot());
      await atomicJson(checkpoint, { schemaVersion: 1, repository: repo, through: time });
      let rendered = "";
      expect(
        await main(
          ["--offline", "--cache", cache, "--checkpoint", checkpoint, "--json"],
          async (text) => {
            rendered = text;
          },
        ),
      ).toBe(0);
      expect(JSON.parse(rendered).freshness.offline).toBe(true);
      expect(await checkpointSince(checkpoint, repo)).toBe(time);
      await expect(cachedSnapshot(cache, "wrong/repo")).rejects.toThrow("invalid");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
  it("advances only after complete successful output, using start of collection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-test-"));
    try {
      const checkpoint = join(dir, "checkpoint.json");
      const data = snapshot();
      data.fetchedAt = "2026-11-12T10:05:00.000Z";
      const runtime = { collect: async () => data, currentRepository: async () => repo };
      await expect(
        main(
          ["--checkpoint", checkpoint],
          async () => {
            throw new Error("broken stdout");
          },
          runtime,
        ),
      ).rejects.toThrow("broken stdout");
      expect(await checkpointSince(checkpoint, repo)).toBeUndefined();
      expect(await main(["--checkpoint", checkpoint], async () => {}, runtime)).toBe(0);
      expect(await checkpointSince(checkpoint, repo)).toBe(time);
      data.warnings.push("incomplete");
      expect(await main(["--checkpoint", checkpoint], async () => {}, runtime)).toBe(2);
      expect(JSON.parse(await readFile(checkpoint, "utf8")).through).toBe(time);
      await expect(
        main(["--checkpoint", checkpoint], async () => {}, {
          ...runtime,
          collect: async () => {
            throw new Error("API unavailable");
          },
        }),
      ).rejects.toThrow("API unavailable");
      expect(await checkpointSince(checkpoint, repo)).toBe(time);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("plain JavaScript gh wrapper", () => {
  it.skipIf(process.platform === "win32")(
    "runs directly with Node and reuses the inherited gh session without login",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "triage-gh-test-"));
      try {
        const log = join(dir, "calls");
        const response = JSON.stringify({
          data: { repository: { issues: page([]), pullRequests: page([]) } },
        });
        const fake = `#!/bin/sh
[ "$TRIAGE_TEST_SESSION" = "already-configured" ] || exit 98
echo "$1" >> "$TRIAGE_TEST_LOG"
case "$1" in
repo) printf '%s\\n' 'example/project' ;;
api) printf '%s\\n' '${response}' ;;
*) exit 99 ;;
esac
`;
        await writeFile(join(dir, "gh"), fake, { mode: 0o700 });
        const { stdout } = await promisify(execFile)(
          process.execPath,
          [fileURLToPath(new URL("./cli.js", import.meta.url)), "--json"],
          {
            env: {
              ...process.env,
              PATH: `${dir}:${process.env.PATH}`,
              TRIAGE_TEST_SESSION: "already-configured",
              TRIAGE_TEST_LOG: log,
            },
          },
        );
        expect(JSON.parse(stdout).repository).toBe(repo);
        expect((await readFile(log, "utf8")).trim().split("\n")).toEqual(["repo", "api", "api"]);
        for (const name of ["cli", "github", "briefing"]) {
          const code = await readFile(new URL(`./${name}.js`, import.meta.url), "utf8");
          expect(code).not.toMatch(/(?:from|import)\s+["'][^"']+\.ts["']/);
        }
      } finally {
        await rm(dir, { recursive: true });
      }
    },
  );
});

describe("compact briefing contract", () => {
  it("deduplicates targets, separates parked questions and preserves full detail", async () => {
    const { compactBriefing, compactText, sourceContext } = await import("./compact.js");
    const parked = issue(7, ["status:parked", "question"]);
    const mine = issue(8, ["agent:reader"]);
    mine.lastEditedAt = "2026-11-12T12:00:00Z";
    mine.comments = page([
      { body: "old question?", url: `${mine.url}#comment`, author: null, createdAt: time },
    ]);
    const data = snapshot([parked, mine, issue()], [pr()]);
    const expanded = briefing(data, { limit: 100, issue: 8 }, new Date(time));
    const compact = compactBriefing(data, { limit: 5, agent: "reader" }, expanded);
    expect(compact.schemaVersion).toBe(2);
    expect(new Set(compact.actions.items).size).toBe(compact.actions.items.length);
    expect(compact.actions.items).not.toContain(parked.url);
    expect(compact.sections.deferred.items).toContain(parked.url);
    expect(compact.sections.current.items).toContain(mine.url);
    expect(compact.detail?.comments.nodes[0].body).toBe("old question?");
    expect(sourceContext(mine).chronology).toContain("superseded");
    expect(sourceContext(parked).chronology).toContain("Unknown");
    const noDetail = { ...compact, detail: null };
    expect(compactText(noDetail, 1500).length).toBeLessThanOrEqual(1500);
    expect(compactText(noDetail, 1500)).toContain("omitted");
  });
  it("bounds independent requests, retains order and propagates failure", async () => {
    const { concurrentMap } = await import("./github.js");
    let active = 0;
    let peak = 0;
    const results = await concurrentMap([1, 2, 3, 4, 5, 6, 7], async (n: number) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return n * 2;
    });
    expect(peak).toBe(4);
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14]);
    await expect(
      concurrentMap([1], async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
  });
});

/** A fake repository of native edges served through the injected gh query boundary. */
type Graph = {
  states?: Record<number, { state?: string; stateReason?: string | null; body?: string }>;
  pullRequests?: Record<number, number[]>;
  edges: [blocked: number, blocker: number][];
  pageSize?: number;
};
const graphQuery = (graph: Graph) => {
  const calls: { number: number; cursor?: string }[] = [];
  const url = (n: number) => `https://github.com/${repo}/issues/${n}`;
  const state = (n: number) => graph.states?.[n]?.state ?? "OPEN";
  const blockersOf = (n: number) => graph.edges.filter(([a]) => a === n).map(([, b]) => b);
  const dependantsOf = (n: number) => graph.edges.filter(([, b]) => b === n).map(([a]) => a);
  const summary = (n: number) => ({
    blockedBy: blockersOf(n).filter((b) => state(b) === "OPEN").length,
    totalBlockedBy: blockersOf(n).length,
    blocking: dependantsOf(n).filter(() => state(n) === "OPEN").length,
    totalBlocking: dependantsOf(n).length,
  });
  const node = (n: number) => ({
    number: n,
    title: `Ticket ${n}`,
    state: state(n),
    stateReason: graph.states?.[n]?.stateReason ?? null,
    url: url(n),
    repository: { nameWithOwner: repo },
    issueDependenciesSummary: summary(n),
  });
  const size = graph.pageSize ?? 100;
  const connection = (numbers: number[], cursor?: string) => {
    const start = cursor ? Number(cursor) : 0;
    const more = start + size < numbers.length;
    return page(
      numbers.slice(start, start + size).map(node),
      more,
      more ? String(start + size) : null,
    );
  };
  const query: Query = async (source, variables) => {
    const number = Number(variables.number);
    const cursor = variables.cursor as string | undefined;
    calls.push({ number, cursor });
    if (source.includes("issueOrPullRequest")) {
      if (graph.pullRequests?.[number])
        return {
          repository: {
            issueOrPullRequest: {
              __typename: "PullRequest",
              number,
              url: `https://github.com/${repo}/pull/${number}`,
              closingIssuesReferences: page(graph.pullRequests[number].map((n) => ({ number: n }))),
            },
          },
        };
      const known = number in (graph.states ?? {}) || graph.edges.flat().includes(number);
      return {
        repository: {
          issueOrPullRequest: known
            ? { __typename: "Issue", number, url: url(number), state: state(number) }
            : null,
        },
      };
    }
    if (!(number in (graph.states ?? {})) && !graph.edges.flat().includes(number))
      return { repository: { issue: null } };
    if (cursor) {
      const field = /blockedBy\(first:100,after/.test(source) ? "blockedBy" : "blocking";
      const numbers = field === "blockedBy" ? blockersOf(number) : dependantsOf(number);
      return { repository: { issue: { [field]: connection(numbers, cursor) } } };
    }
    return {
      repository: {
        issue: {
          ...node(number),
          body: graph.states?.[number]?.body ?? "",
          updatedAt: time,
          labels: page([]),
          blockedBy: connection(blockersOf(number)),
          blocking: connection(dependantsOf(number)),
        },
      },
    };
  };
  return { query, calls, url };
};
const clock = () => new Date(time);

describe("native dependency read command", () => {
  it("follows nested blockedBy and blocking pages until the summary totals match", async () => {
    const edges: [number, number][] = [2, 3, 4].map((b) => [1, b]);
    edges.push([5, 1], [6, 1]);
    const { query, calls } = graphQuery({ edges, pageSize: 2 });
    const report = await dependencyReport(repo, 1, {}, query, clock);
    expect(report.nodes[0].upstream.map((n) => n.number)).toEqual([2, 3, 4]);
    expect(report.nodes[0].downstream.map((n) => n.number)).toEqual([5, 6]);
    expect(calls.filter((call) => call.cursor)).toHaveLength(1);
  });
  it("rejects missing native evidence and a page total that disagrees with the summary", async () => {
    const item = issue();
    await expect(
      completeNative({ ...item, blockedBy: undefined } as unknown as Issue, repo),
    ).rejects.toThrow("Native dependency evidence missing");
    item.issueDependenciesSummary!.totalBlockedBy = 2;
    await expect(completeNative(item, repo, async () => ({}))).rejects.toThrow(
      "count changed or is incomplete",
    );
  });
  it("reports a missing issue or pull request as unavailable rather than empty", async () => {
    const { query } = graphQuery({ edges: [[1, 2]] });
    await expect(dependencyReport(repo, 99, {}, query, clock)).rejects.toThrow(
      "pull requests cannot be native blockers",
    );
  });
  it("walks both directions once each and reports only blocked-by cycles", async () => {
    // 1 <- 2 <- 3 <- 1 is a cycle; 4 is merely downstream of 1.
    const { query, calls } = graphQuery({
      edges: [
        [1, 2],
        [2, 3],
        [3, 1],
        [4, 1],
      ],
    });
    const single = await dependencyReport(repo, 1, {}, query, clock);
    expect(single.nodes.map((n) => n.number)).toEqual([1]);
    expect(single.cycles).toEqual([]);
    calls.length = 0;
    const tree = await dependencyReport(repo, 4, { tree: true }, query, clock);
    expect(tree.nodes.map((n) => n.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(calls.map((c) => c.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
    expect(tree.cycles).toHaveLength(1);
    expect(new Set(tree.cycles[0]).size).toBe(3);
    expect(dependencyText(tree)).toContain("CYCLE:");
  });
  it("does not call an ordinary reverse relationship a cycle", async () => {
    const { query } = graphQuery({ edges: [[2, 1]] });
    const tree = await dependencyReport(repo, 1, { tree: true }, query, clock);
    expect(tree.nodes).toHaveLength(2);
    expect(tree.cycles).toEqual([]);
  });
  it("gives verdicts for waiting, not-planned blockers, last-open-blocker dependants and drift", async () => {
    const { query, url } = graphQuery({
      states: {
        1: { body: "Depends on #2 and #9." },
        3: { state: "CLOSED", stateReason: "NOT_PLANNED" },
      },
      edges: [
        [1, 2],
        [5, 1],
        [6, 1],
        [6, 7],
        [8, 3],
      ],
    });
    const waiting = (await dependencyReport(repo, 1, {}, query, clock)).nodes[0];
    expect(waiting.verdict).toBe(`Waiting on ${url(2)}`);
    expect(waiting.downstream.map((n) => [n.number, n.lastOpenBlocker])).toEqual([
      [5, true],
      [6, false],
    ]);
    expect(waiting.drift.map((ref) => ref.number)).toEqual([9]);
    const notPlanned = (await dependencyReport(repo, 8, {}, query, clock)).nodes[0];
    expect(notPlanned.verdict).toContain("closed as not planned");
    const free = (await dependencyReport(repo, 7, {}, query, clock)).nodes[0];
    expect(free.verdict).toContain("No open native blockers");
  });
});

describe("native dependencies in the briefing", () => {
  const blocking = (from: Issue, dependants: number[]) => {
    from.issueDependenciesSummary!.blocking = dependants.length;
    from.issueDependenciesSummary!.totalBlocking = dependants.length;
    from.blocking = page(
      dependants.map((n) => ({
        ...issue(n),
        repository: { nameWithOwner: repo },
        issueDependenciesSummary: {
          blockedBy: 1,
          totalBlockedBy: 1,
          blocking: 0,
          totalBlocking: 0,
        },
      })),
    );
  };
  it("ranks pickup by the number of dependants left without an open blocker", () => {
    const low = issue(1);
    const high = issue(2);
    const blocked = issue(3);
    blocking(high, [3, 4]);
    blocked.issueDependenciesSummary!.blockedBy = 1;
    blocked.issueDependenciesSummary!.totalBlockedBy = 1;
    const report = brief(snapshot([low, high, blocked], []));
    expect(report.ready.items.map((i) => i.number)).toEqual([2, 1]);
    const pickup = report.actions.items.filter((a) => a.rule === "ready-unclaimed");
    expect(pickup.map((a) => a.target)).toEqual([high.url, low.url]);
  });
  it("marks a cache without native fields incomplete instead of treating tickets as unblocked", async () => {
    const old = issue() as Partial<Issue>;
    delete old.blockedBy;
    delete old.blocking;
    delete old.issueDependenciesSummary;
    const report = brief(snapshot([old as Issue], []));
    expect(report.completeness.complete).toBe(false);
    expect(report.completeness.warnings[0]).toContain("native dependency evidence missing");
    expect(report.ready.items).toEqual([]);
    expect(report.actions.items.map((a) => a.rule)).toContain("native-evidence-unknown");
    const dir = await mkdtemp(join(tmpdir(), "triage-old-cache-"));
    try {
      const cache = join(dir, "cache.json");
      await atomicJson(cache, snapshot([old as Issue], []));
      expect(await main(["--offline", "--cache", cache, "--json"], async () => {})).toBe(2);
      // Many old tickets: compact text bounds the warnings; JSON keeps every one.
      const many = Array.from({ length: 40 }, (_, i) => ({
        ...old,
        number: i + 1,
        url: issue(i + 1).url,
      }));
      await atomicJson(cache, snapshot(many as Issue[], []));
      let text = "";
      let json = "";
      await main(
        ["--offline", "--cache", cache, "--max-chars", "2000"],
        async (t) => void (text = t),
      );
      await main(["--offline", "--cache", cache, "--json"], async (t) => void (json = t));
      expect(text.match(/^INCOMPLETE: /gm)).toHaveLength(6);
      expect(text).toContain("35 more warning(s) omitted");
      expect(JSON.parse(json).completeness.warnings).toHaveLength(40);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("deps command line", () => {
  it("validates arguments and prints its own help", async () => {
    expect(depsArgumentsFor(["7", "--tree"])).toMatchObject({ number: 7, tree: true });
    for (const bad of [[], ["0"], ["1", "2"], ["x"], ["1", "--repo", "nope"], ["1", "--bogus"]])
      expect(() => depsArgumentsFor(bad)).toThrow();
    let text = "";
    expect(await main(["deps", "--help"], async (t) => void (text = t))).toBe(0);
    expect(text).toMatch(/^Usage: .*deps N/);
  });
  it("reads through the injected runtime and never collects the full briefing", async () => {
    const { query } = graphQuery({ edges: [[1, 2]] });
    let text = "";
    const runtime = {
      collect: async () => {
        throw new Error("briefing collection must not run");
      },
      currentRepository: async () => repo,
      dependencyReport: (r: string, n: number, o?: { tree?: boolean }) =>
        dependencyReport(r, n, o, query, clock),
    };
    expect(await main(["deps", "1", "--json"], async (t) => void (text = t), runtime)).toBe(0);
    const report = JSON.parse(text);
    expect(report).toMatchObject({ schemaVersion: 1, repository: repo, startedAt: time });
    expect(report.nodes[0].upstream[0].number).toBe(2);
    await expect(
      main(["deps", "1"], async () => {}, {
        ...runtime,
        dependencyReport: async () => {
          throw new Error("GitHub query failed.");
        },
      }),
    ).rejects.toThrow("GitHub query failed.");
  });
});

describe("deps add and deps remove", () => {
  const writes = () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => void calls.push(args);
    return { calls, run };
  };
  const add = (on: number[], number = 1) => ({ action: "add" as const, number, on, note: "why" });
  it("refuses self-edges, pull requests, missing issues and cycles, and no-ops existing edges", async () => {
    // 2 is already a blocker of 1; 3 is blocked by 1, so 1 <- 3 would close a cycle.
    const { query } = graphQuery({
      states: { 4: {} },
      edges: [
        [1, 2],
        [3, 1],
      ],
      pullRequests: { 9: [4] },
    });
    const plan = await planDependencyChange(repo, add([1, 2, 3, 9, 77, 4]), query);
    const byBlocker = Object.fromEntries(plan.changes.map((c) => [c.blocker, c]));
    expect(byBlocker[1].status).toBe("refused");
    expect(byBlocker[2]).toMatchObject({ status: "noop", reason: "Already a native blocker." });
    expect(byBlocker[3].status).toBe("refused");
    expect(byBlocker[3].reason).toContain("cycle");
    expect(byBlocker[9].reason).toContain("pull request");
    expect(byBlocker[9].reason).toContain("#4");
    expect(byBlocker[77].reason).toContain("does not exist");
    expect(byBlocker[4]).toMatchObject({
      status: "apply",
      command: ["issue", "edit", "1", "--repo", repo, "--add-blocked-by", "4"],
    });
  });
  it("detects a cycle through a longer upstream chain", async () => {
    // 4 <- 3 <- 2 <- 1: making 1 blocked by 4 closes 1 -> 4 -> 3 -> 2 -> 1.
    const { query } = graphQuery({
      edges: [
        [2, 1],
        [3, 2],
        [4, 3],
      ],
    });
    const plan = await planDependencyChange(repo, add([4]), query);
    expect(plan.changes[0].status).toBe("refused");
    expect(plan.changes[0].reason.split(" -> ")).toHaveLength(5);
  });
  it("applies each edge, posts one comment naming the note, and changes no labels", async () => {
    const { query } = graphQuery({ states: { 1: {}, 4: {}, 5: {} }, edges: [] });
    const { calls, run } = writes();
    const result = await applyDependencyChange(
      await planDependencyChange(repo, add([4, 5]), query),
      run,
    );
    expect(result.exitCode).toBe(0);
    expect(calls.map((c) => c.slice(0, 2).join(" "))).toEqual([
      "issue edit",
      "issue edit",
      "issue comment",
    ]);
    expect(calls[2].at(-1)).toContain("#4, #5");
    expect(calls[2].at(-1)).toContain("Why: why");
    expect(calls.flat().some((arg) => /^--(?:add|remove)-label$/.test(arg))).toBe(false);
  });
  it("reports partial failure with exit 2 and comments only on what changed", async () => {
    const { query } = graphQuery({ states: { 1: {}, 4: {}, 5: {} }, edges: [] });
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      if (args.includes("5")) throw new Error("gh issue edit failed.");
    };
    const result = await applyDependencyChange(
      await planDependencyChange(repo, add([4, 5]), query),
      run,
    );
    expect(result.exitCode).toBe(2);
    expect(result.changes.map((c) => c.status)).toEqual(["done", "failed"]);
    expect(calls.at(-1)?.at(-1)).toContain("dependency: #4.");
    // The reported comment is the one posted, not the planned one naming #5 too.
    expect(result.comment).toBe(calls.at(-1)?.at(-1));
    expect(result.commentCommand).toEqual(calls.at(-1));
    expect(result.commentStatus).toBe("posted");
  });
  it("stops all further writes, including the comment, after a rate limit", async () => {
    const { query } = graphQuery({ states: { 1: {}, 4: {}, 5: {}, 6: {} }, edges: [] });
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      if (args.includes("5")) throw new RateLimitError("gh issue edit was rate limited by GitHub.");
    };
    const result = await applyDependencyChange(
      await planDependencyChange(repo, add([4, 5, 6]), query),
      run,
    );
    expect(result.changes.map((c) => c.status)).toEqual(["done", "failed", "skipped"]);
    expect(calls).toHaveLength(2);
    expect(result.commentStatus).toContain("rate limit");
    expect(result.rateLimited).toBe(true);
    expect(result.exitCode).toBe(2);
    expect(isRateLimit("gh: You have exceeded a secondary rate limit. (HTTP 403)")).toBe(true);
    expect(isRateLimit("gh: Could not resolve to an issue")).toBe(false);
  });
  it("exits 1 when nothing could be done and 0 for a pure no-op, with no comment either way", async () => {
    const { query } = graphQuery({ edges: [[1, 2]] });
    const { calls, run } = writes();
    const refused = await applyDependencyChange(
      await planDependencyChange(repo, add([1]), query),
      run,
    );
    const noop = await applyDependencyChange(
      await planDependencyChange(repo, add([2]), query),
      run,
    );
    expect([refused.exitCode, noop.exitCode]).toEqual([1, 0]);
    expect(calls).toEqual([]);
  });
  it("does not confuse a same-numbered blocker in another repository with a local one", async () => {
    const { query } = graphQuery({ states: { 1: {}, 5: {} }, edges: [] });
    const crossRepo: Query = async (source, variables) => {
      const data = (await query(source, variables)) as {
        repository: { issue?: Record<string, unknown> };
      };
      const issue = data.repository.issue as
        | { number: number; blockedBy?: unknown; issueDependenciesSummary?: Record<string, number> }
        | undefined;
      if (issue?.number === 1 && issue.blockedBy && !variables.cursor) {
        issue.blockedBy = page([
          {
            ...issue,
            number: 5,
            url: "https://github.com/other/repo/issues/5",
            repository: { nameWithOwner: "other/repo" },
          },
        ]);
        issue.issueDependenciesSummary = {
          blockedBy: 1,
          totalBlockedBy: 1,
          blocking: 0,
          totalBlocking: 0,
        };
      }
      return data;
    };
    const remove = await planDependencyChange(
      repo,
      { action: "remove", number: 1, on: [5], note: "x" },
      crossRepo,
    );
    expect(remove.changes[0].status).toBe("noop");
    const addLocal = await planDependencyChange(repo, add([5]), crossRepo);
    expect(addLocal.changes[0].status).toBe("apply");
  });
  it("matches local blockers when --repo casing differs from GitHub's canonical name", async () => {
    const { query } = graphQuery({ edges: [[1, 2]] });
    const plan = await planDependencyChange(
      repo.toUpperCase(),
      { action: "remove", number: 1, on: [2], note: "x" },
      query,
    );
    expect(plan.changes[0].status).toBe("apply");
  });
  it("removes only existing edges", async () => {
    const { query } = graphQuery({ states: { 3: {} }, edges: [[1, 2]] });
    const plan = await planDependencyChange(
      repo,
      { action: "remove", number: 1, on: [2, 3], note: "done differently" },
      query,
    );
    expect(plan.changes.map((c) => c.status)).toEqual(["apply", "noop"]);
    expect(plan.changes[0].command).toContain("--remove-blocked-by");
  });
  it("dry run prints the exact commands and comment and calls no write", async () => {
    const { query } = graphQuery({ states: { 1: {}, 4: {} }, edges: [] });
    const { calls, run } = writes();
    let text = "";
    const runtime = {
      collect: async () => {
        throw new Error("briefing collection must not run");
      },
      currentRepository: async () => repo,
      planDependencyChange: (r: string, request: Parameters<typeof planDependencyChange>[1]) =>
        planDependencyChange(r, request, query),
      ghRun: run,
    };
    const code = await main(
      ["deps", "add", "1", "--on", "4", "--note", "needs the parser", "--dry-run"],
      async (t) => void (text = t),
      runtime,
    );
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(text).toContain("DRY RUN");
    expect(text).toContain(`gh issue edit 1 --repo ${repo} --add-blocked-by 4`);
    expect(text).toContain("Why: needs the parser");
  });
  it("validates add/remove arguments", () => {
    expect(depsArgumentsFor(["add", "1", "--on", "2", "--on", "3", "--note", " x "])).toMatchObject(
      {
        action: "add",
        number: 1,
        on: [2, 3],
        note: "x",
        dryRun: false,
      },
    );
    for (const bad of [
      ["add", "1", "--note", "x"],
      ["add", "1", "--on", "2"],
      ["add", "1", "--on", "2", "--note", "  "],
      ["add", "1", "--on", "abc", "--note", "x"],
      ["remove", "--on", "2", "--note", "x"],
      ["add", "1", "--on", "2", "--note", "x", "--tree"],
      ["7", "--on", "2"],
    ])
      expect(() => depsArgumentsFor(bad)).toThrow();
  });
});

describe("GraphQL NOT_FOUND answers", () => {
  it("treats NOT_FOUND-only errors as a valid null answer and anything else as failure", () => {
    const missing = JSON.stringify({
      data: { repository: { issueOrPullRequest: null } },
      errors: [{ type: "NOT_FOUND", message: "Could not resolve" }],
    });
    expect(graphqlAnswer(missing)).toEqual({ repository: { issueOrPullRequest: null } });
    const forbidden = JSON.stringify({
      data: { repository: null },
      errors: [{ type: "NOT_FOUND" }, { type: "FORBIDDEN" }],
    });
    expect(graphqlAnswer(forbidden)).toBeNull();
    expect(graphqlAnswer(JSON.stringify({ data: {}, errors: [] }))).toBeNull();
    expect(graphqlAnswer("not json")).toBeNull();
    expect(graphqlAnswer(undefined)).toBeNull();
  });
});

// The installed-bin check (#11) runs against the real packed archive in
// scripts/package-test.mjs (npm run package-test), which builds first and runs in every CI job.
describe("release versions (doc/npm-releases.md)", () => {
  const sha = (n: number) => String(n).repeat(40).slice(0, 40);
  it("follows the contract's sequence: 0.0.x-next before 0.1.0, patch per main build, minor per release", async () => {
    const { chooseVersion } = await import("../scripts/release-version.mjs");
    const history: { version: string; gitHead: string }[] = [];
    const step = (channel: "next" | "latest", n: number) => {
      const { version } = chooseVersion({ channel, sha: sha(n), published: history });
      history.push({ version: version!, gitHead: sha(n) });
      return version;
    };
    expect([step("next", 1), step("next", 2)]).toEqual(["0.0.1-next.1", "0.0.2-next.1"]);
    expect(step("latest", 3)).toBe("0.1.0");
    expect([step("next", 4), step("next", 5)]).toEqual(["0.1.1-next.1", "0.1.2-next.1"]);
    expect(step("latest", 6)).toBe("0.2.0");
    expect(step("next", 7)).toBe("0.2.1-next.1");
  });
  it("recognises a commit already published on the channel instead of assigning another version", async () => {
    const { chooseVersion } = await import("../scripts/release-version.mjs");
    const published = [{ version: "0.0.1-next.1", gitHead: sha(1) }];
    expect(chooseVersion({ channel: "next", sha: sha(1), published })).toMatchObject({
      version: null,
      alreadyPublished: "0.0.1-next.1",
    });
    // The same commit may still be promoted to an official release.
    expect(chooseVersion({ channel: "latest", sha: sha(1), published }).version).toBe("0.1.0");
  });
  it("moves to the following prerelease after a registry-lag conflict, never bumping a release", async () => {
    const { followingPrerelease } = await import("../scripts/release-version.mjs");
    expect(followingPrerelease("0.1.1-next.1")).toBe("0.1.2-next.1");
    expect(followingPrerelease("0.0.9-next.1")).toBe("0.0.10-next.1");
    expect(() => followingPrerelease("0.1.0")).toThrow();
  });
  it("orders prereleases before their release and ignores unrelated versions", async () => {
    const { chooseVersion, compare, parse } = await import("../scripts/release-version.mjs");
    expect(compare(parse("0.1.0-next.1")!, parse("0.1.0")!)).toBeLessThan(0);
    expect(compare(parse("0.0.9-next.1")!, parse("0.1.0")!)).toBeLessThan(0);
    expect(parse("1.0.0-beta.1")).toBeNull();
    const published = [{ version: "1.0.0-beta.1" }, { version: "0.3.0" }];
    expect(chooseVersion({ channel: "next", sha: sha(9), published }).version).toBe("0.3.1-next.1");
  });
});

describe("dependency migration", () => {
  /** A small live repository: issues with labels, bodies and native edges; PRs by number. */
  type Fake = {
    issues: Record<
      number,
      { body?: string; labels?: string[]; state?: string; blockedBy?: number[] }
    >;
    prs?: Record<number, { merged: boolean; closes: number[] }>;
  };
  const live = (fake: Fake) => {
    let clock = 0;
    const meta = Object.fromEntries(
      Object.keys(fake.issues).map((n) => [n, { updatedAt: `2026-11-12T10:00:0${clock}.000Z` }]),
    );
    const touch = (n: number) => {
      clock++;
      meta[n].updatedAt = `2026-11-12T11:${String(clock).padStart(2, "0")}:00.000Z`;
    };
    const state = (n: number) => fake.issues[n]?.state ?? "OPEN";
    const issueNode = (n: number) => {
      const i = fake.issues[n];
      const blockers = i.blockedBy ?? [];
      return {
        ...issue(n, i.labels ?? []),
        body: i.body ?? "",
        state: state(n),
        updatedAt: meta[n].updatedAt,
        issueDependenciesSummary: {
          blockedBy: blockers.filter((b) => state(b) === "OPEN").length,
          totalBlockedBy: blockers.length,
          blocking: 0,
          totalBlocking: 0,
        },
        blockedBy: page(
          blockers.map((b) => ({
            ...issue(b),
            state: state(b),
            repository: { nameWithOwner: repo },
            issueDependenciesSummary: {
              blockedBy: 0,
              totalBlockedBy: 0,
              blocking: 0,
              totalBlocking: 0,
            },
          })),
        ),
      };
    };
    const query: Query = async (source, variables) => {
      const n = Number(variables.number);
      if (source.includes("issueOrPullRequest")) {
        const pr = fake.prs?.[n];
        if (pr)
          return {
            repository: {
              issueOrPullRequest: {
                __typename: "PullRequest",
                number: n,
                url: `https://github.com/${repo}/pull/${n}`,
                state: pr.merged ? "MERGED" : "OPEN",
                merged: pr.merged,
                closingIssuesReferences: page(
                  pr.closes.map((c) => ({
                    number: c,
                    url: issue(c).url,
                    state: state(c),
                    repository: { nameWithOwner: repo },
                  })),
                ),
              },
            },
          };
        return {
          repository: {
            issueOrPullRequest: fake.issues[n]
              ? {
                  __typename: "Issue",
                  number: n,
                  url: issue(n).url,
                  state: state(n),
                  stateReason: null,
                }
              : null,
          },
        };
      }
      return { repository: { issue: fake.issues[n] ? issueNode(n) : null } };
    };
    const snapshotNow = async () =>
      snapshot(
        Object.keys(fake.issues)
          .map(Number)
          .filter((n) => state(n) === "OPEN")
          .map(issueNode) as Issue[],
        [],
      );
    const writes: string[][] = [];
    const run = async (args: string[]) => {
      writes.push(args);
      const n = Number(args[2]);
      const i = fake.issues[n];
      if (args[1] === "edit") {
        for (let k = 3; k < args.length; k++) {
          if (args[k] === "--add-blocked-by") (i.blockedBy ??= []).push(Number(args[k + 1]));
          if (args[k] === "--add-label") (i.labels ??= []).push(args[k + 1]);
          if (args[k] === "--remove-label")
            i.labels = (i.labels ?? []).filter((l) => l !== args[k + 1]);
        }
      }
      touch(n);
    };
    return { query, run, writes, snapshotNow, touch, meta };
  };
  const plan = (env: ReturnType<typeof live>) =>
    planMigration(repo, { query: env.query, collect: env.snapshotNow as never, now: clock });

  it("plans edges from explicit text and routes doubtful references to review", async () => {
    const env = live({
      issues: {
        1: {
          body: "Depends on #2 and #3; coordinate #4.",
          labels: ["status:blocked", "blocked:work"],
        },
        2: {},
        3: { state: "CLOSED" },
        4: {},
        5: {
          body: "Depends on #5, #99 and https://github.com/other/repo/issues/1.",
          blockedBy: [2],
        },
        6: { body: "Requires #2.", blockedBy: [2] },
        7: { body: "Depends on #20 and #21." },
        8: { body: "Depends on #22." },
        20: {},
      },
      prs: { 21: { merged: true, closes: [] }, 22: { merged: false, closes: [] } },
    });
    const p = await plan(env);
    const t = (n: number) => p.tickets.find((x) => x.number === n);
    expect(t(1)!.edges.map((e) => [e.blocker, e.status])).toEqual([
      [2, "apply"],
      [3, "apply"],
      [4, "review"],
    ]);
    // Full URLs are parsed before #N references.
    expect(t(5)!.edges.map((e) => [e.blocker, e.status, e.reason])).toEqual([
      [1, "review", "Cross-repository reference."],
      [5, "review", "Self-reference."],
      [99, "review", "#99 does not exist."],
    ]);
    expect(t(6)).toBeUndefined();
    expect(t(7)!.edges.map((e) => [e.blocker, e.status])).toEqual([
      [20, "apply"],
      [21, "satisfied"],
    ]);
    expect(t(8)!.edges[0]).toMatchObject({ status: "review", reason: "PR #22 closes no issue." });
    expect(t(1)!.labels).toMatchObject({
      status: "apply",
      remove: ["blocked:work", "status:blocked"],
      add: ["status:ready"],
    });
    expect(p.summary).toMatchObject({ apply: 4, review: 5, satisfied: 1 });
  });
  it("maps a pull request reference to the issues it closes", async () => {
    const env = live({
      issues: { 1: { body: "Depends on #30." }, 9: {} },
      prs: { 30: { merged: false, closes: [9] } },
    });
    const p = await plan(env);
    expect(p.tickets[0].edges).toMatchObject([{ blocker: 9, source: "pr #30", status: "apply" }]);
  });
  it("applies the label rules for blocked:work", async () => {
    const env = live({
      issues: {
        1: { labels: ["status:blocked", "blocked:work", "blocked:testing"] },
        2: { labels: ["status:blocked", "blocked:work"], body: "Depends on #9." },
        3: { labels: ["status:blocked", "blocked:work"], body: "Depends on #9." },
        9: { state: "CLOSED" },
      },
    });
    // #2 and #3 depend only on a closed blocker.
    const p = await plan(env);
    const labels = Object.fromEntries(p.tickets.map((t) => [t.number, t.labels]));
    expect(labels[1]).toMatchObject({ status: "apply", remove: ["blocked:work"], add: [] });
    expect(labels[2]).toMatchObject({ status: "review", remove: [], add: [] });
  });
  it("scopes hedged wording to the clause naming the reference", () => {
    const text = "Depends on #541's revised mission merging first, after research #543.";
    expect(clauseFor(text, 541)).not.toMatch(/after/);
    expect(clauseFor(text, 543)).toMatch(/after/);
  });
  it("keeps a local edge when another repository's issue has the same number", async () => {
    const env = live({
      issues: { 1: { body: "Depends on #2 and https://github.com/other/repo/issues/2." }, 2: {} },
    });
    const p = await plan(env);
    expect(p.tickets[0].edges.map((e) => [e.blocker, e.status])).toEqual([
      [2, "review"],
      [2, "apply"],
    ]);
  });
  it("sends a PR reference to review when its closing issues are incomplete, and judges hedging by the PR's clause", async () => {
    const env = live({
      issues: { 1: { body: "Depends on #30; coordinate #31." }, 9: {}, 10: {} },
      prs: { 30: { merged: false, closes: [9] }, 31: { merged: false, closes: [10] } },
    });
    const p = await plan(env);
    expect(p.tickets[0].edges.map((e) => [e.blocker, e.status])).toEqual([
      [9, "apply"],
      [10, "review"],
    ]);
    const base = env.query;
    const truncated: Query = async (source, variables) => {
      const data = (await base(source, variables)) as any;
      const node = data.repository?.issueOrPullRequest;
      if (node?.__typename === "PullRequest")
        node.closingIssuesReferences.pageInfo.hasNextPage = true;
      return data;
    };
    const q = await planMigration(repo, {
      query: truncated,
      collect: env.snapshotNow as never,
      now: clock,
    });
    expect(q.tickets[0].edges[0]).toMatchObject({ status: "review" });
    expect(q.tickets[0].edges[0].reason).toContain("incomplete");
  });
  it("reviews issues a referenced PR closes in other repositories", async () => {
    const env = live({
      issues: { 1: { body: "Depends on #30." }, 9: {} },
      prs: { 30: { merged: true, closes: [9] } },
    });
    const base = env.query;
    const external: Query = async (source, variables) => {
      const data = (await base(source, variables)) as any;
      const node = data.repository?.issueOrPullRequest;
      if (node?.__typename === "PullRequest")
        node.closingIssuesReferences.nodes.push({
          number: 4,
          url: "https://github.com/other/repo/issues/4",
          state: "OPEN",
          repository: { nameWithOwner: "other/repo" },
        });
      return data;
    };
    const p = await planMigration(repo, {
      query: external,
      collect: env.snapshotNow as never,
      now: clock,
    });
    expect(p.tickets[0].edges.map((e) => [e.blocker, e.status])).toEqual([
      [9, "apply"],
      [4, "review"],
    ]);
  });
  it("sends the blocked:work label row to review when labels are incomplete", async () => {
    const env = live({
      issues: { 1: { labels: ["status:blocked", "blocked:work"], body: "Depends on #2." }, 2: {} },
    });
    const partial = async () => {
      const snap = await env.snapshotNow();
      snap.issues[0].labels.pageInfo.hasNextPage = true;
      return snap;
    };
    const p = await planMigration(repo, {
      query: env.query,
      collect: partial as never,
      now: clock,
    });
    expect(p.tickets[0].labels).toMatchObject({ status: "review" });
    expect(p.tickets[0].labels!.reason).toContain("incomplete");
  });
  it("treats a qualifier covering the whole list as hedging every reference", () => {
    for (const text of [
      "Depends on #1, #2 and #3 (all optional).",
      "Depends on #1, #2, #3, ideally.",
      "Depends on #1 and #2; both are optional.",
    ])
      for (const n of [1, 2])
        expect(listWideHedge(text) || hedged.test(clauseFor(text, n))).toBe(true);
    for (const text of [
      "Depends on #518 and #519; coordinate #493 and #510.",
      "Depends on #541's revised mission merging first, after research #543.",
      "Depends on #1 and #2.",
    ])
      expect(listWideHedge(text)).toBe(false);
  });
  it("keeps a leading qualifier across a comma-separated list", async () => {
    const env = live({
      issues: { 1: { body: "## Dependencies\n- Optional: #2, #3\n- #4" }, 2: {}, 3: {}, 4: {} },
    });
    const p = await plan(env);
    expect(p.tickets[0].edges.map((e) => [e.blocker, e.status])).toEqual([
      [2, "review"],
      [3, "review"],
      [4, "apply"],
    ]);
    expect(clauseFor("Depends on #1, optionally #2, #3.", 3)).toMatch(/optionally/);
    expect(clauseFor("Depends on #1, optionally #2, #3.", 1)).not.toMatch(/optionally/);
    const markdown =
      "Depends on #2; optionally #3, `#4`, **#5**, [#6](https://github.com/example/project/issues/6).";
    for (const n of [4, 5, 6]) expect(clauseFor(markdown, n)).toMatch(/optionally/);
    expect(clauseFor(markdown, 2)).not.toMatch(/optionally/);
  });
  it("judges each reference by its own clause when numbers repeat across repositories", async () => {
    const env = live({
      issues: {
        1: { body: "Depends on https://github.com/other/repo/issues/2; optionally #2." },
        2: {},
      },
    });
    const p = await plan(env);
    expect(p.tickets[0].edges.map((e) => [e.blocker, e.status, !!e.crossRepository])).toEqual([
      [2, "review", true],
      [2, "review", false],
    ]);
  });
  it("reports a ticket with an incomplete label list even without visible blocked:work, with warnings", async () => {
    const env = live({ issues: { 1: { labels: ["status:blocked"] } } });
    const partial = async () => {
      const snap = await env.snapshotNow();
      snap.issues[0].labels.pageInfo.hasNextPage = true;
      snap.warnings = [`${snap.issues[0].url}: labels exceed 100; label analysis incomplete.`];
      return snap;
    };
    const p = await planMigration(repo, {
      query: env.query,
      collect: partial as never,
      now: clock,
    });
    expect(p.tickets[0].labels).toMatchObject({ status: "review" });
    expect(p.warnings).toHaveLength(1);
  });
  it("validates migrate arguments; apply is not offered", async () => {
    expect(depsArgumentsFor(["migrate", "--plan", "p.json"])).toMatchObject({
      migrate: "plan",
      file: "p.json",
    });
    for (const bad of [
      ["migrate"],
      ["migrate", "--apply", "p.json"],
      ["migrate", "--plan", "a", "--dry-run"],
      ["7", "--plan", "a"],
    ])
      expect(() => depsArgumentsFor(bad)).toThrow();
  });
});

describe("help names the installed command (#53)", () => {
  it("leads with github-triage and mentions the checkout form only as an alternative", async () => {
    let main_ = "";
    let deps = "";
    await main(["--help"], async (t) => void (main_ = t));
    await main(["deps", "--help"], async (t) => void (deps = t));
    for (const text of [main_, deps]) {
      expect(text).toMatch(/^Usage: github-triage /);
      expect(text.split("\n").filter((l) => /^\s*npm run triage/.test(l))).toEqual([]);
    }
  });
});

describe("claim and needs-human (doc/design/workflow.md)", () => {
  type Ticket = {
    typename?: string;
    state?: string;
    labels?: string[];
    blockedBy?: number;
    openPrs?: number[];
    comments?: (string | { body: string; createdAt: string })[];
    labelledAt?: string;
    claims?: number[];
    repoLabels?: string[];
    afterWriteOwners?: string[];
    failRecheck?: boolean;
  };
  const fake = (t: Ticket) => {
    let reads = 0;
    const query: Query = async (_source, variables) => {
      reads++;
      if (t.failRecheck && reads > 1) throw new Error("GitHub query failed.");
      const has = (name: unknown) =>
        (t.repoLabels ?? []).includes(String(name)) ? { name } : null;
      // After the first read, simulate the claim having been written (unless overridden).
      const labels =
        reads > 1
          ? [...(t.labels ?? []), ...(t.afterWriteOwners ?? ["agent:kavya"])]
          : (t.labels ?? []);
      return {
        repository: {
          issueOrPullRequest:
            t.typename === "missing"
              ? null
              : t.typename === "PullRequest"
                ? { __typename: "PullRequest", number: 7, url: `https://github.com/${repo}/pull/7` }
                : {
                    __typename: "Issue",
                    number: 7,
                    title: "Ticket 7",
                    url: `https://github.com/${repo}/issues/7`,
                    state: t.state ?? "OPEN",
                    updatedAt: time,
                    labels: page(labels.map((name) => ({ name }))),
                    issueDependenciesSummary: { blockedBy: t.blockedBy ?? 0 },
                    blockedBy: page(
                      t.blockedBy ? [{ number: 3, url: issue(3).url, state: "OPEN" }] : [],
                    ),
                    closedByPullRequestsReferences: page(
                      (t.openPrs ?? []).map((n) => ({
                        number: n,
                        url: `https://github.com/${repo}/pull/${n}`,
                        state: "OPEN",
                      })),
                    ),
                    comments: page(
                      (t.comments ?? []).map((c) => (typeof c === "string" ? { body: c } : c)),
                    ),
                    timelineItems: page(
                      t.labelledAt
                        ? [{ createdAt: t.labelledAt, label: { name: "agent:kavya" } }]
                        : [],
                    ),
                  },
          claims: page(
            (t.claims ?? []).map((n) => ({ number: n, title: `Ticket ${n}`, url: issue(n).url })),
          ),
          ownerLabel: has(variables.label),
          questionLabel: has(variables.question),
          decisionLabel: has(variables.decision),
          needsDesignLabel: has(variables.needsDesign),
          attentionLabel: has(variables.attention),
        },
      };
    };
    const writes: string[][] = [];
    const run = async (args: string[]) => void writes.push(args);
    return { query, run, writes };
  };
  const at = (hoursAgo: number) => new Date(Date.parse(time) - hoursAgo * 3_600_000).toISOString();
  const claim = (t: Ticket, extra = {}) =>
    planClaim(repo, { number: 7, agent: "kavya", ...extra }, fake(t).query);

  it("claims an eligible ticket: creates the agent label if needed, swaps readiness, comments once", async () => {
    const env = fake({ labels: ["status:ready"] });
    const plan = await planClaim(repo, { number: 7, agent: "kavya", branch: "issue-7" }, env.query);
    const result = await applyPlan(repo, plan, env);
    expect(result.exitCode).toBe(0);
    expect(env.writes.map((w) => w.slice(0, 2).join(" "))).toEqual([
      "label create",
      "issue edit",
      "issue comment",
    ]);
    expect(env.writes[1]).toEqual([
      "issue",
      "edit",
      "7",
      "--repo",
      repo,
      "--add-label",
      "agent:kavya",
      "--remove-label",
      "status:ready",
    ]);
    expect(env.writes[2].at(-1)).toMatch(/branch `issue-7`[\s\S]*<!-- github-triage:claim:/);
  });
  it("comments on every new acquisition, and on retry repairs only a missing comment", async () => {
    const first = await claim({ labels: ["status:ready"], repoLabels: ["agent:kavya"] });
    const comment = first.changes!.find((c) => c.step === "comment")!.command.at(-1)!;
    const marker = comment.match(/<!-- github-triage:claim:[0-9a-f]+ -->/)![0];
    // Released and claimed again later: the old comment must not suppress the new one.
    const again = await claim({
      labels: ["status:ready"],
      repoLabels: ["agent:kavya"],
      comments: [marker],
    });
    expect(again.changes!.map((c) => c.step)).toEqual(["labels", "comment"]);
    // Labelled now, comment posted after the label was added: complete.
    const done = await claim({
      labels: ["agent:kavya"],
      claims: [7],
      comments: [{ body: marker, createdAt: at(1) }],
      labelledAt: at(2),
    });
    expect(done).toMatchObject({ ok: true, noop: true, changes: [] });
    // Labelled now, but the only claim comment predates this labelling: post it again.
    const stale = await claim({
      labels: ["agent:kavya"],
      claims: [7],
      comments: [{ body: marker, createdAt: at(5) }],
      labelledAt: at(2),
    });
    expect(stale.changes!.map((c) => c.step)).toEqual(["comment"]);
    const repair = await claim({ labels: ["agent:kavya"], claims: [7] });
    expect(repair.changes!.map((c) => c.step)).toEqual(["comment"]);
  });
  it("refuses with stable error IDs, facts and recovery commands", async () => {
    const cases: [Ticket, Record<string, string>, string][] = [
      [{ typename: "missing" }, {}, "TICKET_NOT_FOUND"],
      [{ typename: "PullRequest" }, {}, "NOT_AN_ISSUE"],
      [{ state: "CLOSED", labels: ["status:ready"] }, {}, "TICKET_CLOSED"],
      [{ labels: ["status:ready", "agent:other"] }, {}, "OWNED_BY_OTHER"],
      [{ labels: ["status:ready"], claims: [9] }, {}, "OTHER_ACTIVE_CLAIM"],
      [{ labels: ["status:needs-design"] }, {}, "NOT_READY"],
      [{ labels: ["status:ready", "question"] }, {}, "NOT_READY"],
      [{ labels: [] }, {}, "NOT_READY"],
      [{ labels: ["status:ready"], blockedBy: 1 }, {}, "BLOCKED"],
      [{ labels: ["status:ready"], openPrs: [12] }, {}, "HAS_OPEN_PR"],
      [{ labels: ["status:ready", "platform:ori"] }, {}, "PLATFORM_UNKNOWN"],
      [{ labels: ["status:ready", "platform:ori"] }, { platform: "codex" }, "PLATFORM_MISMATCH"],
    ];
    for (const [t, extra, id] of cases) {
      const plan = await claim(t, extra);
      expect(plan).toMatchObject({ ok: false, error: id });
      expect(plan.prerequisite).toBeTruthy();
    }
    const owned = await claim({ labels: ["status:ready", "agent:other"] });
    expect(owned.recovery!.join(" ")).not.toMatch(/agent:other/);
    const other = await claim({ labels: ["status:ready"], claims: [9] });
    expect(other.recovery![0]).toMatch(/^manual \(release is #62/);
    expect(
      (await claim({ labels: ["status:incomplete", "platform:ori"] }, { platform: "ori" })).ok,
    ).toBe(true);
  });
  it("reports a competing claim found after writing instead of resolving it", async () => {
    const env = fake({
      labels: ["status:ready"],
      repoLabels: ["agent:kavya"],
      afterWriteOwners: ["agent:kavya", "agent:other"],
    });
    const result = await applyPlan(
      repo,
      await planClaim(repo, { number: 7, agent: "kavya" }, env.query),
      env,
    );
    expect(result.exitCode).toBe(2);
    expect(result.conflict).toMatch(/agent:other/);
    expect(env.writes.some((w) => w.includes("--remove-label") && w.includes("agent:other"))).toBe(
      false,
    );
  });
  it("declares every GraphQL variable it uses (the fake does not parse queries)", async () => {
    let source = "";
    await planClaim(repo, { number: 7, agent: "kavya" }, async (q, v) => {
      source = q;
      return fake({ labels: ["status:ready"] }).query(q, v);
    });
    const declared = new Set([...source.matchAll(/\$(\w+):/g)].map((m) => m[1]));
    const used = new Set([...source.matchAll(/\$(\w+)\b(?!:)/g)].map((m) => m[1]));
    for (const name of used) expect(declared.has(name), `$${name} is declared`).toBe(true);
  });
  it("finds existing labels by exact name, and keeps completed writes when the re-check fails", async () => {
    // Exact-name lookup: an existing label is never scheduled for creation.
    const existing = await claim({ labels: ["status:ready"], repoLabels: ["agent:kavya"] });
    expect(existing.changes!.map((c) => c.step)).toEqual(["labels", "comment"]);
    const env = fake({ labels: ["status:ready"], repoLabels: ["agent:kavya"], failRecheck: true });
    const result = await applyPlan(
      repo,
      await planClaim(repo, { number: 7, agent: "kavya" }, env.query),
      env,
    );
    expect(result.exitCode).toBe(2);
    expect(result.steps!.map((s) => s.status)).toEqual(["done", "done"]);
    expect(result.conflict).toMatch(/could not be re-checked/);
  });
  it("records questions first, then marks decision-needed and releases only the caller's claim", async () => {
    const env = fake({
      labels: ["status:ready", "agent:kavya", "agent:other"],
      repoLabels: ["question", "status:needs-design"],
    });
    const plan = await planNeedsHuman(
      repo,
      {
        number: 7,
        agent: "kavya",
        designer: "nicole",
        why: "Contract is ambiguous.",
        questions: ["Which file?", "Which default?"],
      },
      env.query,
    );
    const result = await applyPlan(repo, plan, env);
    expect(result.exitCode).toBe(0);
    expect(env.writes.map((w) => w.slice(0, 2).join(" "))).toEqual([
      "issue comment",
      "label create",
      "label create",
      "issue edit",
    ]);
    expect(env.writes[0].at(-1)).toMatch(
      /^### Questions for the designer\n\nDesigner: `nicole` · Raised by: `kavya`\n\n\*\*Why:\*\* Contract is ambiguous\.\n\n1\. Which file\?\n2\. Which default\?/,
    );
    expect(env.writes.slice(1, 3).map((w) => w[2])).toEqual([
      "design:decision-needed",
      "attention:nicole",
    ]);
    const edit = env.writes[3];
    for (const l of [
      "question",
      "design:decision-needed",
      "status:needs-design",
      "attention:nicole",
    ])
      expect(edit).toContain(l);
    expect(edit.join(" ")).toContain("--remove-label status:ready");
    expect(edit.join(" ")).toContain("--remove-label agent:kavya");
    expect(edit.join(" ")).not.toContain("agent:other");
  });
  it("changes nothing when the questions comment fails, and keeps a deliberate blocked state", async () => {
    const env = fake({
      labels: ["status:ready"],
      repoLabels: ["question", "design:decision-needed", "status:needs-design"],
    });
    const plan = await planNeedsHuman(
      repo,
      { number: 7, agent: "kavya", designer: "nicole", why: "x", questions: ["q"] },
      env.query,
    );
    const failing = async (args: string[]) => {
      if (args[1] === "comment") throw new Error("gh issue comment failed.");
      env.writes.push(args);
    };
    const result = await applyPlan(repo, plan, { run: failing, query: env.query });
    expect(result.exitCode).toBe(1);
    expect(env.writes).toEqual([]);
    const blocked = await planNeedsHuman(
      repo,
      { number: 7, agent: "kavya", designer: "nicole", why: "x", questions: ["q"] },
      fake({
        labels: ["status:blocked", "blocked:credential"],
        repoLabels: ["question", "design:decision-needed"],
      }).query,
    );
    const edit = blocked.changes!.find((c) => c.step === "labels")!.command;
    expect(edit).not.toContain("status:needs-design");
    expect(edit.join(" ")).not.toContain("blocked:credential");
    expect(blocked.notes![0]).toMatch(/status:blocked kept/);
  });
  it("validates arguments, and a dry run writes nothing", async () => {
    for (const bad of [
      ["claim", "7"],
      ["claim", "x", "--agent", "a"],
      ["claim", "7", "--agent", "a", "--why", "w"],
      ["needs-human", "7", "--agent", "a", "--designer", "d", "--why", "w"],
      ["needs-human", "7", "--agent", "a", "--why", "w", "--question", "q"],
    ])
      await expect(main(bad, async () => {})).rejects.toThrow("Usage");
    const env = fake({ labels: ["status:ready"] });
    let text = "";
    const code = await main(
      ["claim", "7", "--agent", "kavya", "--dry-run", "--repo", repo],
      async (t) => void (text = t),
      {
        collect: async () => {
          throw new Error("no briefing");
        },
        currentRepository: async () => repo,
        query: env.query,
        ghRun: env.run,
      },
    );
    expect(code).toBe(0);
    expect(env.writes).toEqual([]);
    expect(text).toContain("DRY RUN");
    expect(text).toContain("--add-label agent:kavya");
  });
});

describe("claim and needs-human review fixes", () => {
  const base = (labels: string[]) => ({
    repository: {
      issueOrPullRequest: {
        __typename: "Issue",
        number: 7,
        title: "T7",
        url: `https://github.com/${repo}/issues/7`,
        state: "OPEN",
        updatedAt: time,
        labels: page(labels.map((name) => ({ name }))),
        issueDependenciesSummary: { blockedBy: 0 },
        blockedBy: page([] as { number: number; url: string; state: string }[]),
        closedByPullRequestsReferences: page(
          [] as { number: number; url: string; state: string }[],
        ),
        comments: page([] as { body: string }[]),
      },
      claims: page([] as { number: number; title?: string; url?: string }[]),
      ownerLabel: { name: "agent:kavya" },
      questionLabel: { name: "question" },
      decisionLabel: { name: "design:decision-needed" },
      needsDesignLabel: { name: "status:needs-design" },
      attentionLabel: { name: "attention:nicole" },
    },
  });
  const ask = { number: 7, agent: "kavya", designer: "nicole", why: "w", questions: ["q"] };
  it("refuses to claim a blocked or parked ticket even when a stale ready label remains", async () => {
    for (const held of ["status:blocked", "status:parked"]) {
      const plan = await planClaim(repo, { number: 7, agent: "kavya" }, async () =>
        base(["status:ready", held]),
      );
      expect(plan).toMatchObject({ ok: false, error: "NOT_READY" });
      expect(plan.prerequisite).toContain(held);
    }
  });
  it("needs-human keeps blocked, drops the stale ready label, and addresses the designer", async () => {
    const plan = await planNeedsHuman(repo, ask, async () =>
      base(["status:ready", "status:blocked"]),
    );
    const edit = plan.changes!.find((c) => c.step === "labels")!.command.join(" ");
    expect(edit).toContain("--remove-label status:ready");
    expect(edit).toContain("--add-label attention:nicole");
    expect(edit).not.toContain("status:needs-design");
    expect(plan.notes![0]).toMatch(/status:blocked kept/);
  });
  it("needs-human refuses before posting when labels are incomplete", async () => {
    const data = base(["status:ready"]);
    data.repository.issueOrPullRequest.labels.pageInfo.hasNextPage = true;
    expect(await planNeedsHuman(repo, ask, async () => data)).toMatchObject({
      ok: false,
      error: "EVIDENCE_INCOMPLETE",
    });
  });
  it("re-check reports a lost claim and a concurrent second claim by the same agent", async () => {
    const lost = async () => base(["status:ready"]);
    const r1 = await applyPlan(repo, await planClaim(repo, { number: 7, agent: "kavya" }, lost), {
      run: async () => {},
      query: lost,
    });
    expect(r1.exitCode).toBe(2);
    expect(r1.conflict).toMatch(/no longer recorded/);
    let n = 0;
    const second = async () => {
      const d = base(n++ ? ["agent:kavya"] : ["status:ready"]);
      if (n > 1) d.repository.claims = page([{ number: 7 }, { number: 9 }]);
      return d;
    };
    const r2 = await applyPlan(repo, await planClaim(repo, { number: 7, agent: "kavya" }, second), {
      run: async () => {},
      query: second,
    });
    expect(r2.exitCode).toBe(2);
    expect(r2.conflict).toMatch(/now also claims #9/);
  });
  it("recovery commands put the subcommand first, and displayed commands are shell-quoted", async () => {
    const blocked = base(["status:ready"]);
    blocked.repository.issueOrPullRequest.issueDependenciesSummary.blockedBy = 1;
    const plan = await planClaim(repo, { number: 7, agent: "kavya" }, async () => blocked);
    expect(plan.recovery![0]).toBe(`github-triage deps 7 --repo ${repo}`);
    const { shellQuote } = await import("./claims.js");
    expect(shellQuote("$(rm -rf x)")).toBe("'$(rm -rf x)'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("--add-label")).toBe("--add-label");
  });
});

describe("claim ownership needs complete labels", () => {
  it("refuses before trusting an existing or competing claim when labels are incomplete", async () => {
    const data = (labels: string[]) => ({
      repository: {
        issueOrPullRequest: {
          __typename: "Issue",
          number: 7,
          title: "T7",
          url: `https://github.com/${repo}/issues/7`,
          state: "OPEN",
          updatedAt: time,
          labels: {
            nodes: labels.map((name) => ({ name })),
            pageInfo: { hasNextPage: true, endCursor: "x" },
          },
          issueDependenciesSummary: { blockedBy: 0 },
          blockedBy: page([]),
          closedByPullRequestsReferences: page([]),
          comments: page([]),
          timelineItems: page([]),
        },
        claims: page([{ number: 7, title: "T7", url: issue(7).url }]),
        ownerLabel: { name: "agent:kavya" },
      },
    });
    for (const labels of [["agent:kavya"], ["status:ready"]]) {
      const plan = await planClaim(repo, { number: 7, agent: "kavya" }, async () => data(labels));
      expect(plan).toMatchObject({ ok: false, error: "EVIDENCE_INCOMPLETE" });
    }
  });
});
