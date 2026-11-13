import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  collect,
  declaredDependencies,
  graphqlAnswer,
  pages,
  type IssueDiagnosis,
  type Query,
} from "./github.js";
import { clauseFor, hedged, listWideHedge, planMigration } from "./migration.js";
import { applyPlan, planClaim, planNeedsHuman } from "./claims.js";
import type { ClaimAccepted, ClaimPlan, ClaimRefusal } from "./claims.js";
import { teamText, teamView } from "./team.js";
import { ticketDoctor, ticketDoctorText } from "./ticketdoctor.js";
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
          // Source development runs through tsx (doc/design/typescript.md); Node 20 cannot run .ts.
          ["--import", "tsx", fileURLToPath(new URL("./cli.ts", import.meta.url)), "--json"],
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
          const code = await readFile(new URL(`./${name}.ts`, import.meta.url), "utf8");
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
// scripts/package-test.ts (npm run package-test), which builds first and runs in every CI job.
describe("release versions (doc/npm-releases.md)", () => {
  const sha = (n: number) => String(n).repeat(40).slice(0, 40);
  it("follows the contract's sequence: 0.0.x-next before 0.1.0, patch per main build, minor per release", async () => {
    const { chooseVersion } = await import("../scripts/release-version.js");
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
    const { chooseVersion } = await import("../scripts/release-version.js");
    const published = [{ version: "0.0.1-next.1", gitHead: sha(1) }];
    expect(chooseVersion({ channel: "next", sha: sha(1), published })).toMatchObject({
      version: null,
      alreadyPublished: "0.0.1-next.1",
    });
    // The same commit may still be promoted to an official release.
    expect(chooseVersion({ channel: "latest", sha: sha(1), published }).version).toBe("0.1.0");
  });
  it("moves to the following prerelease after a registry-lag conflict, never bumping a release", async () => {
    const { followingPrerelease } = await import("../scripts/release-version.js");
    expect(followingPrerelease("0.1.1-next.1")).toBe("0.1.2-next.1");
    expect(followingPrerelease("0.0.9-next.1")).toBe("0.0.10-next.1");
    expect(() => followingPrerelease("0.1.0")).toThrow();
  });
  it("orders prereleases before their release and ignores unrelated versions", async () => {
    const { chooseVersion, compare, parse } = await import("../scripts/release-version.js");
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
    const comment = accepted(first)
      .changes.find((c) => c.step === "comment")!
      .command.at(-1)!;
    const marker = comment.match(/<!-- github-triage:claim:[0-9a-f]+ -->/)![0];
    // Released and claimed again later: the old comment must not suppress the new one.
    const again = await claim({
      labels: ["status:ready"],
      repoLabels: ["agent:kavya"],
      comments: [marker],
    });
    expect(accepted(again).changes.map((c) => c.step)).toEqual(["labels", "comment"]);
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
    expect(accepted(stale).changes.map((c) => c.step)).toEqual(["comment"]);
    const repair = await claim({ labels: ["agent:kavya"], claims: [7] });
    expect(accepted(repair).changes.map((c) => c.step)).toEqual(["comment"]);
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
      expect(refused(plan).prerequisite).toBeTruthy();
    }
    const owned = await claim({ labels: ["status:ready", "agent:other"] });
    expect(refused(owned).recovery.join(" ")).not.toMatch(/agent:other/);
    const other = await claim({ labels: ["status:ready"], claims: [9] });
    expect(refused(other).recovery[0]).toMatch(/^manual \(release is #62/);
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
    expect(accepted(existing).changes.map((c) => c.step)).toEqual(["labels", "comment"]);
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
    const edit = accepted(blocked).changes.find((c) => c.step === "labels")!.command;
    expect(edit).not.toContain("status:needs-design");
    expect(edit.join(" ")).not.toContain("blocked:credential");
    expect(accepted(blocked).notes![0]).toMatch(/status:blocked kept/);
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
      expect(refused(plan).prerequisite).toContain(held);
    }
  });
  it("needs-human keeps blocked, drops the stale ready label, and addresses the designer", async () => {
    const plan = await planNeedsHuman(repo, ask, async () =>
      base(["status:ready", "status:blocked"]),
    );
    const edit = accepted(plan)
      .changes.find((c) => c.step === "labels")!
      .command.join(" ");
    expect(edit).toContain("--remove-label status:ready");
    expect(edit).toContain("--add-label attention:nicole");
    expect(edit).not.toContain("status:needs-design");
    expect(accepted(plan).notes![0]).toMatch(/status:blocked kept/);
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
    expect(refused(plan).recovery[0]).toBe(`github-triage deps 7 --repo ${repo}`);
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

describe("claim comment repair re-checks ownership", () => {
  it("reports a competing owner that appears while the missing claim comment is repaired", async () => {
    let reads = 0;
    const q = async () => {
      reads++;
      return {
        repository: {
          issueOrPullRequest: {
            __typename: "Issue",
            number: 7,
            title: "T7",
            url: `https://github.com/${repo}/issues/7`,
            state: "OPEN",
            updatedAt: time,
            labels: page(
              (reads > 1 ? ["agent:kavya", "agent:other"] : ["agent:kavya"]).map((name) => ({
                name,
              })),
            ),
            issueDependenciesSummary: { blockedBy: 0 },
            blockedBy: page([]),
            closedByPullRequestsReferences: page([]),
            comments: page([]),
            timelineItems: page([]),
          },
          claims: page([{ number: 7, title: "T7", url: issue(7).url }]),
          ownerLabel: { name: "agent:kavya" },
        },
      };
    };
    const plan = await planClaim(repo, { number: 7, agent: "kavya" }, q);
    expect(accepted(plan).changes.map((c) => c.step)).toEqual(["comment"]);
    const result = await applyPlan(repo, plan, { run: async () => {}, query: q });
    expect(result.exitCode).toBe(2);
    expect(result.conflict).toMatch(/agent:other/);
  });
});

describe("team view (#41, doc/design/diagnostics.md)", () => {
  const at = (hoursAgo: number) => new Date(Date.parse(time) - hoursAgo * 3_600_000).toISOString();
  const ticket = (
    n: number,
    labels: string[],
    hoursAgo = 1,
    extra: Partial<Issue> = {},
  ): Issue => ({
    ...issue(n, labels),
    updatedAt: at(hoursAgo),
    ...extra,
  });
  const build = () => {
    const prFor1 = pr();
    prFor1.number = 40;
    prFor1.url = `https://github.com/${repo}/pull/40`;
    prFor1.updatedAt = at(0.5);
    prFor1.closingIssuesReferences = page([{ number: 1, url: issue(1).url }]);
    prFor1.reviewThreads = page([
      { isResolved: false, isOutdated: false, comments: page([]) },
    ] as never);
    return snapshot(
      [
        ticket(1, ["agent:ana"], 1),
        ticket(2, ["agent:ana", "status:ready"], 100),
        ticket(3, ["agent:bo", "agent:ana", "meta"], 2, { title: "Umbrella: everything" }),
        ticket(4, ["agent:cy", "status:needs-design"], 3),
        // Comment text is not a claim; only labels are.
        ticket(5, ["status:ready"], 1, {
          comments: page([
            {
              body: "Picked up by dee",
              url: "u",
              author: { login: "x" },
              createdAt: at(1),
              updatedAt: at(1),
            },
          ]),
        } as Partial<Issue>),
      ],
      [prFor1],
    );
  };
  it("groups claims by agent with linked PR state and latest activity, from labels only", () => {
    const view = teamView(build(), { now: new Date(time) });
    expect(view.agents.map((a) => a.agent)).toEqual(["ana", "bo", "cy"]);
    const ana = view.agents[0];
    expect(ana.claims.map((c) => c.number)).toEqual([1, 2, 3]);
    expect(ana.claims[0].pullRequests[0]).toMatchObject({
      number: 40,
      verify: "SUCCESS",
      unresolvedThreads: 1,
    });
    expect(ana.claims[0].latestActivity!.source).toBe("PR #40 updated");
    expect(view.agents.flatMap((a) => a.claims).some((c) => c.number === 5)).toBe(false);
    expect(view.presence).toMatch(/^unknown/);
  });
  it("separates definite violations from candidates", () => {
    const view = teamView(build(), { now: new Date(time) });
    const ana = view.agents.find((a) => a.agent === "ana")!;
    expect(ana.warnings.filter((w) => w.certainty === "definite").map((w) => w.kind)).toEqual([
      "multiple-claims",
    ]);
    expect(view.conflicts).toEqual([{ number: 3, url: issue(3).url, agents: ["bo", "ana"] }]);
    const details = ana.warnings
      .filter((w) => w.certainty === "candidate")
      .map((w) => `#${w.ticket} ${w.detail}`);
    expect(
      details.some((d) => d.startsWith("#2 stale candidate: no evidenced activity for 100h")),
    ).toBe(true);
    expect(details).toContain("#2 claimed but still labelled status:ready");
    expect(details.some((d) => d.startsWith("#3 umbrella candidate"))).toBe(true);
    const cy = view.agents.find((a) => a.agent === "cy")!;
    expect(cy.warnings.map((w) => w.detail)).toEqual(["claimed while status:needs-design"]);
    expect(
      teamView(build(), { now: new Date(time), staleHours: 200 }).agents[0].warnings.some((w) =>
        /stale/.test(w.detail),
      ),
    ).toBe(false);
    const text = teamText(view);
    expect(text).toContain("WARNING: 3 active claims");
    expect(text).toContain("CONFLICT: also claimed by bo");
  });
  it("runs offline from a cache and validates its options", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-team-"));
    try {
      const cache = join(dir, "cache.json");
      await atomicJson(cache, build());
      let out = "";
      const runtime = {
        collect: async () => {
          throw new Error("no live collection");
        },
        currentRepository: async () => repo,
        now: () => new Date(time),
      };
      expect(
        await main(
          ["team", "--offline", "--cache", cache, "--json"],
          async (t) => void (out = t),
          runtime,
        ),
      ).toBe(0);
      expect(JSON.parse(out)).toMatchObject({
        kind: "team-view",
        schemaVersion: 1,
        freshness: { offline: true, ageSeconds: 0 },
      });
      expect(JSON.parse(out).freshness.liveVerification).toMatch(/^not performed/);
      let text = "";
      await main(["team", "--offline", "--cache", cache], async (t) => void (text = t), {
        ...runtime,
        now: () => new Date(Date.parse(time) + 3 * 3_600_000),
      });
      expect(text.split("\n")[0]).toMatch(
        /OFFLINE cache fetched .* \(3h 0m old\); ownership not verified live/,
      );
      for (const bad of [
        ["team", "--stale-hours", "0"],
        ["team", "--stale-hours", "x"],
        ["team", "--offline"],
      ])
        await expect(main(bad, async () => {}, runtime)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("pr status: why is a PR not progressing (#59)", () => {
  const head = "a".repeat(40);
  const run = (name: string, extra: Record<string, unknown> = {}) => ({
    __typename: "CheckRun",
    name,
    status: "COMPLETED",
    conclusion: "SUCCESS",
    detailsUrl: `https://ci/${name}`,
    startedAt: time,
    ...extra,
  });
  const codexComment = (sha: string, status = "completed", unresolved = false) => ({
    author: { login: "chatgpt-codex-connector" },
    createdAt: "2026-11-12T09:00:00Z",
    url: "https://c/1",
    body: `summary <!-- codex-review-state:v1 {"code_review":{"commit_sha":"${sha}","has_any_findings":${unresolved},"has_unresolved_findings":${unresolved},"status":"${status}"}} -->`,
  });
  const pull = (o: Record<string, any> = {}) => ({
    number: 12,
    title: "Fix",
    url: `https://github.com/${repo}/pull/12`,
    state: "OPEN",
    isDraft: false,
    merged: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    headRefOid: head,
    headRefName: "fix",
    baseRefName: "main",
    updatedAt: time,
    commits: {
      nodes: [
        {
          commit: {
            oid: head,
            statusCheckRollup: {
              contexts: { nodes: o.checks ?? [run("verify")], pageInfo: { hasNextPage: false } },
            },
          },
        },
      ],
    },
    reviews: { nodes: o.reviews ?? [] },
    reviewThreads: { nodes: o.threads ?? [], pageInfo: { hasNextPage: false } },
    comments: { nodes: o.comments ?? [] },
    closingIssuesReferences: { nodes: o.issues ?? [] },
    ...o.pr,
  });
  it("classifies checks: passed, pending, cancelled, failed, unknown", async () => {
    const { classifyCheck } = await import("./prstatus.js");
    expect(classifyCheck(run("a"))).toBe("passed");
    expect(classifyCheck(run("a", { status: "IN_PROGRESS", conclusion: null }))).toBe("pending");
    expect(classifyCheck({ context: "x", state: "PENDING" })).toBe("pending");
    expect(classifyCheck(run("a", { conclusion: "CANCELLED" }))).toBe("cancelled");
    expect(classifyCheck(run("a", { conclusion: "FAILURE" }))).toBe("failed");
    expect(classifyCheck(run("a", { conclusion: "WEIRD" }))).toBe("unknown");
  });
  it("lists every blocker at once, distinguishing missing, pending and cancelled verification", async () => {
    const { prStatus } = await import("./prstatus.js");
    const r = prStatus(
      repo,
      pull({
        checks: [
          run("unit", { conclusion: "FAILURE" }),
          run("mac", { conclusion: "CANCELLED", startedAt: null }),
        ],
        pr: { mergeable: "CONFLICTING", reviewDecision: "CHANGES_REQUESTED" },
        threads: [
          {
            isResolved: false,
            isOutdated: false,
            path: "src/a.js",
            line: 3,
            first: {
              totalCount: 2,
              nodes: [
                {
                  author: { login: "coderabbitai" },
                  body: "Bug here",
                  createdAt: time,
                  url: "https://t/1",
                },
              ],
            },
            latest: {
              nodes: [{ author: { login: "kavya" }, createdAt: time, url: "https://t/2" }],
            },
          },
        ],
      }),
      { now: new Date(time) },
    );
    expect(r.blockers).toEqual([
      `required check \`verify\` is missing on head ${head.slice(0, 7)}`,
      "check unit failed",
      "check mac cancelled without running (likely infrastructure, not a code defect): verification incomplete",
      "merge conflicts with the base branch",
      "changes requested",
      "1 unresolved review thread(s)",
    ]);
    expect(r.threads.unresolved[0]).toMatchObject({
      by: "coderabbitai",
      replies: 1,
      lastSpeaker: "kavya",
    });
    const pending = prStatus(
      repo,
      pull({ checks: [run("unit", { status: "QUEUED", conclusion: null })] }),
    );
    expect(pending.blockers[0]).toMatch(/not reported yet .*other checks still pending/);
  });
  it("tracks which commit each reviewer reviewed and whether Codex covered the head", async () => {
    const { prStatus } = await import("./prstatus.js");
    const reviews = [
      {
        author: { login: "codex" },
        state: "COMMENTED",
        submittedAt: "2026-11-12T08:00:00Z",
        commit: { oid: "b".repeat(40) },
      },
      {
        author: { login: "codex" },
        state: "COMMENTED",
        submittedAt: "2026-11-12T09:00:00Z",
        commit: { oid: head },
      },
      {
        author: { login: "rabbit" },
        state: "COMMENTED",
        submittedAt: "2026-11-12T07:00:00Z",
        commit: { oid: "c".repeat(40) },
      },
    ];
    const request = {
      author: { login: "kavya" },
      body: "@codex review",
      createdAt: "2026-11-12T10:00:00Z",
      url: "https://c/2",
    };
    const old = prStatus(
      repo,
      pull({ reviews, comments: [codexComment("b".repeat(40)), request] }),
    );
    expect(old.reviews.map((r) => [r.reviewer, r.current])).toEqual([
      ["codex", true],
      ["rabbit", false],
    ]);
    expect(old.blockers).toContain(
      "Codex's latest review is for an older commit; current head not yet covered",
    );
    expect(old.reviewRequest!.status).toBe("no reaction yet");
    const dirty = prStatus(
      repo,
      pull({ comments: [codexComment(head, "completed", true), request] }),
    );
    expect(dirty.blockers).toEqual(["Codex reports unresolved findings on the current head"]);
    expect(dirty.reviewRequest!.status).toBe("current head reviewed (Codex)");
    const running = prStatus(repo, pull({ comments: [codexComment(head, "running"), request] }));
    expect(running.reviewRequest!.status).toMatch(/in progress/);
  });
  it("an automatically started Codex review still running is a blocker without any request", async () => {
    const { prStatus } = await import("./prstatus.js");
    const auto = prStatus(repo, pull({ comments: [codexComment(head, "running")] }));
    expect(auto.reviewRequest).toBeNull();
    expect(auto.blockers).toEqual([
      "waiting for Codex's review of the current head to finish (running)",
    ]);
    expect(auto.verdict).toMatch(/^Blocked/);
  });
  it("text output shows each receipt's summary and source URL", async () => {
    const { prStatus, prStatusText } = await import("./prstatus.js");
    const receipt = {
      author: { login: "coderabbitai" },
      body: "Actionable comments posted: 2. Please fix the null check.",
      createdAt: "2026-11-12T11:00:00Z",
      url: "https://c/receipt",
    };
    const text = prStatusText(prStatus(repo, pull({ comments: [receipt] })));
    expect(text).toContain(
      "Receipt coderabbitai 2026-11-12T11:00:00Z: Actionable comments posted: 2. Please fix the null check. https://c/receipt",
    );
  });
  it("green evidence is only a merge consideration, and closed PRs report only their state", async () => {
    const { prStatus } = await import("./prstatus.js");
    const green = prStatus(
      repo,
      pull({
        comments: [codexComment(head)],
        issues: [
          {
            number: 5,
            url: issue(5).url,
            title: "T",
            state: "OPEN",
            labels: { nodes: [{ name: "agent:kavya" }] },
          },
        ],
      }),
    );
    expect(green.blockers).toEqual([]);
    expect(green.verdict).toMatch(/not approval/);
    expect(green.linkedIssues[0].owners).toEqual(["kavya"]);
    const merged = prStatus(
      repo,
      pull({ pr: { state: "MERGED", merged: true, mergeable: "UNKNOWN" }, checks: [] }),
    );
    expect(merged.blockers).toEqual(["pull request is merged"]);
  });
  it("runs through the injected query and validates arguments", async () => {
    let text = "";
    const runtime = {
      collect: async () => {
        throw new Error("no briefing");
      },
      currentRepository: async () => repo,
      query: (async () => ({ repository: { pullRequest: pull() } })) as Query,
    };
    expect(await main(["pr", "12", "--json"], async (t) => void (text = t), runtime)).toBe(0);
    expect(JSON.parse(text)).toMatchObject({ kind: "pr-status", schemaVersion: 1, blockers: [] });
    for (const bad of [["pr"], ["pr", "x"], ["pr", "1", "2"]])
      await expect(main(bad, async () => {}, runtime)).rejects.toThrow("Usage");
    const missing = {
      ...runtime,
      query: (async () => ({ repository: { pullRequest: null } })) as Query,
    };
    await expect(main(["pr", "99"], async () => {}, missing)).rejects.toThrow("unavailable");
  });
});

describe("version check (#51, doc/design/updates.md)", () => {
  const installed = (version: string | null, isInstalled = true) => ({
    version,
    installed: isInstalled,
  });
  const registry = (tags: Record<string, string> | Error, seen: string[] = []) =>
    (async (url: string) => {
      seen.push(String(url));
      if (tags instanceof Error) throw tags;
      return { ok: true, status: 200, json: async () => tags } as Response;
    }) as unknown as typeof fetch;
  it("advises only when npm's matching channel is newer, never a downgrade", async () => {
    const { checkForUpdate, updateAdvisory } = await import("./updates.js");
    const tags = { latest: "0.2.0", next: "0.2.3-next.1" };
    const stable = await checkForUpdate({
      installed: installed("0.1.0"),
      fetchImpl: registry(tags),
    });
    expect(stable).toMatchObject({ status: "newer", available: "0.2.0", channel: "latest" });
    expect(updateAdvisory(stable)).toBe(
      "github-triage 0.2.0 is available (installed 0.1.0). Update with: npm install -g @trebizondoculpepper/github-triage",
    );
    const pre = await checkForUpdate({
      installed: installed("0.2.1-next.1"),
      fetchImpl: registry(tags),
    });
    expect(pre).toMatchObject({
      status: "newer" as const,
      channel: "next",
      command: expect.stringMatching(/@next$/),
    });
    for (const v of ["0.2.0", "0.3.0"])
      expect(
        updateAdvisory(
          await checkForUpdate({ installed: installed(v), fetchImpl: registry(tags) }),
        ),
      ).toBeNull();
  });
  it("skips without any network call for checkouts, unknown versions, offline and opt-out", async () => {
    const { checkForUpdate } = await import("./updates.js");
    const seen: string[] = [];
    const cases = [
      { installed: installed("0.1.0", false) },
      { installed: installed(null) },
      { installed: installed("1.0.0-beta.1") },
      { installed: installed("0.1.0"), offline: true },
      { installed: installed("0.1.0"), optOut: true },
    ];
    for (const c of cases)
      expect(
        (await checkForUpdate({ ...c, fetchImpl: registry({ latest: "9.0.0" }, seen) })).status,
      ).toBe("skipped");
    expect(seen).toEqual([]);
  });
  it("treats registry failure as unknown, never as up to date, and sends only the package name", async () => {
    const { checkForUpdate } = await import("./updates.js");
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    expect(
      await checkForUpdate({ installed: installed("0.1.0"), fetchImpl: registry(timeout) }),
    ).toMatchObject({
      status: "unknown",
      reason: expect.stringMatching(/did not answer/),
    });
    expect(
      (await checkForUpdate({ installed: installed("0.1.0"), fetchImpl: registry({}) })).status,
    ).toBe("unknown");
    const seen: string[] = [];
    await checkForUpdate({
      installed: installed("0.1.0"),
      fetchImpl: registry({ latest: "0.1.0" }, seen),
    });
    expect(seen).toEqual([
      "https://registry.npmjs.org/-/package/@trebizondoculpepper%2fgithub-triage/dist-tags",
    ]);
  });
  it("prints the advisory on stderr after the command, keeping JSON stdout valid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-version-"));
    try {
      const cache = join(dir, "cache.json");
      await atomicJson(cache, snapshot([issue()], []));
      let out = "";
      const err: string[] = [];
      const runtime = {
        collect: async () => {
          throw new Error("offline only");
        },
        currentRepository: async () => repo,
        stderr: (t: string) => void err.push(t),
        updateCheck: async () => ({
          status: "newer" as const,
          installed: "0.1.0",
          available: "0.2.0",
          channel: "latest",
          command: "npm install -g @trebizondoculpepper/github-triage",
        }),
      };
      expect(
        await main(["--offline", "--cache", cache, "--json"], async (t) => void (out = t), runtime),
      ).toBe(0);
      expect(() => JSON.parse(out)).not.toThrow();
      expect(err.join("")).toMatch(/^github-triage 0\.2\.0 is available/);
      // Help does not wait on the network.
      let checked = 0;
      await main(["--help"], async () => {}, {
        ...runtime,
        updateCheck: (async () => (checked++, { status: "current" })) as never,
      });
      expect(checked).toBe(0);
      // --no-update-check is consumed before the command parses its own options.
      expect(
        await main(
          ["--no-update-check", "--offline", "--cache", cache, "--json"],
          async () => {},
          runtime,
        ),
      ).toBe(0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("pr status: truncation and requested-reviewer matching", () => {
  const head = "a".repeat(40);
  const base = (o: Record<string, any> = {}) => ({
    number: 12,
    title: "Fix",
    url: `https://github.com/${repo}/pull/12`,
    state: "OPEN",
    isDraft: false,
    merged: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    headRefOid: head,
    headRefName: "fix",
    baseRefName: "main",
    updatedAt: time,
    commits: {
      nodes: [
        {
          commit: {
            oid: head,
            statusCheckRollup: {
              contexts: {
                nodes: [
                  {
                    __typename: "CheckRun",
                    name: "verify",
                    status: "COMPLETED",
                    conclusion: "SUCCESS",
                    startedAt: time,
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      ],
    },
    reviews: { nodes: [], pageInfo: { hasPreviousPage: !!o.moreReviews } },
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
    comments: { nodes: o.comments ?? [], pageInfo: { hasPreviousPage: !!o.moreComments } },
    closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: !!o.moreIssues } },
  });
  it("reports truncated comments, reviews and linked issues as incomplete", async () => {
    const { prStatus } = await import("./prstatus.js");
    expect(prStatus(repo, base()).completeness.complete).toBe(true);
    const r = prStatus(repo, base({ moreComments: true, moreReviews: true, moreIssues: true }));
    expect(r.completeness.complete).toBe(false);
    expect(r.completeness.warnings).toHaveLength(3);
  });
  it("counts only the requested service as answering a review request", async () => {
    const { prStatus } = await import("./prstatus.js");
    const request = {
      author: { login: "kavya" },
      body: "@codex review",
      createdAt: "2026-11-12T10:00:00Z",
      url: "u1",
    };
    const codecov = {
      author: { login: "codecov[bot]" },
      body: "Coverage 90%",
      createdAt: "2026-11-12T11:00:00Z",
      url: "u2",
    };
    const unrelated = prStatus(repo, base({ comments: [request, codecov] }));
    expect(unrelated.reviewRequest!.status).toBe("no reaction yet");
    expect(unrelated.blockers).toContain("a review was requested and has had no reaction");
    const rabbit = {
      author: { login: "kavya" },
      body: "@coderabbitai review",
      createdAt: "2026-11-12T10:00:00Z",
      url: "u3",
    };
    const answer = {
      author: { login: "coderabbitai" },
      body: "Review complete",
      createdAt: "2026-11-12T11:00:00Z",
      url: "u4",
    };
    expect(prStatus(repo, base({ comments: [rabbit, answer] })).reviewRequest!.status).toBe(
      "a reviewer has posted since the request",
    );
  });
});

describe("Ticket Doctor v1 (#66, doc/design/diagnostics.md)", () => {
  const at = (hoursAgo: number) => new Date(Date.parse(time) - hoursAgo * 3_600_000).toISOString();
  const t = (n: number, labels: string[], extra: Partial<Issue> = {}): Issue => ({
    ...issue(n, labels),
    updatedAt: at(1),
    ...extra,
  });
  const blockedBy = (urls: string[]) => ({
    issueDependenciesSummary: {
      blockedBy: urls.length,
      totalBlockedBy: urls.length,
      blocking: 0,
      totalBlocking: 0,
    },
    blockedBy: page(
      urls.map((url) => ({
        ...issue(Number(url.split("/").pop())),
        url,
        repository: { nameWithOwner: repo },
        issueDependenciesSummary: {
          blockedBy: 0,
          totalBlockedBy: 0,
          blocking: 0,
          totalBlocking: 0,
        },
      })),
    ),
  });
  const build = () => {
    const prOpen = pr();
    prOpen.number = 90;
    prOpen.state = "OPEN";
    prOpen.closingIssuesReferences = page([{ number: 7, url: issue(7).url }]);
    return snapshot(
      [
        t(1, ["bug", "status:ready"]), // clean
        t(2, ["enhancement"]), // unclaimed, no readiness
        t(3, ["bug", "status:ready", "status:parked"]), // two readiness labels
        t(4, ["status:ready", "urgency:high", "urgency:low"]), // urgency conflict, no classification
        t(5, ["bug", "status:ready", "question"]), // design conflict
        t(6, ["bug", "agent:ana", "agent:bo"]), // two owners
        t(7, ["bug", "status:ready"]), // open PR
        t(8, ["bug", "status:blocked"]), // blocked without reason
        t(9, ["bug", "agent:ana", "status:ready"], { updatedAt: at(30) }), // leftover + stale (24h)
        t(10, ["bug", "status:ready"], { body: "Depends on #1." }), // drift
        t(11, ["bug", "status:ready"], blockedBy([issue(12).url]) as Partial<Issue>),
        t(12, ["bug", "status:ready"], blockedBy([issue(11).url]) as Partial<Issue>), // cycle 11<->12
      ],
      [prOpen],
    );
  };
  const report = (options = {}) => ticketDoctor(build(), { now: new Date(time), ...options });
  const kinds = (r: ReturnType<typeof report>, n: number) =>
    r.tickets.find((x) => x.number === n)?.findings.map((f) => `${f.certainty}:${f.kind}`) ?? [];
  it("finds each structured inconsistency with its certainty, and leaves clean tickets out", () => {
    const r = report();
    expect(kinds(r, 1)).toEqual([]);
    expect(kinds(r, 2)).toEqual(["definite:readiness-missing"]);
    expect(kinds(r, 3)).toEqual(["definite:readiness-conflict"]);
    expect(kinds(r, 4)).toEqual(["definite:urgency-conflict", "candidate:classification-missing"]);
    expect(kinds(r, 5)).toEqual(["definite:design-conflict"]);
    expect(kinds(r, 6)).toEqual(["definite:multiple-owners", "definite:agent-multiple-claims"]);
    expect(kinds(r, 7)).toEqual(["definite:ready-with-open-pr"]);
    expect(kinds(r, 8)).toEqual(["definite:blocked-without-reason"]);
    expect(kinds(r, 9)).toEqual([
      "definite:agent-multiple-claims",
      "candidate:leftover-readiness",
      "candidate:stale-agent-activity",
    ]);
    expect(kinds(r, 10)).toEqual(["candidate:dependency-drift"]);
    expect(kinds(r, 11)).toEqual(["definite:dependency-cycle"]);
    expect(kinds(r, 12)).toEqual(["definite:dependency-cycle"]);
  });
  it("uses its own 24h staleness default, configurable, and bounds output with omitted counts", () => {
    expect(kinds(report({ staleHours: 48 }), 9)).not.toContain("candidate:stale-agent-activity");
    const small = report({ limit: 2 });
    expect(small.tickets).toHaveLength(2);
    expect(small.omittedTickets).toBe(small.summary.tickets - 2);
    expect(small.tickets.every((x) => x.findings[0].certainty === "definite")).toBe(true);
    expect(ticketDoctorText(small)).toContain("more tickets; raise --limit to see them");
  });
  it("reports missing native evidence as unknown and runs offline from the CLI", async () => {
    const old = t(20, ["bug", "status:ready"]) as Partial<Issue>;
    delete old.blockedBy;
    const r = ticketDoctor(snapshot([old as Issue], []), { now: new Date(time) });
    expect(kinds(r, 20)).toEqual(["unknown:dependency-evidence-unknown"]);
    expect(r.completeness.complete).toBe(false);
    const dir = await mkdtemp(join(tmpdir(), "triage-doctor-"));
    try {
      const cache = join(dir, "cache.json");
      await atomicJson(cache, build());
      let out = "";
      const runtime = {
        collect: async () => {
          throw new Error("offline only");
        },
        currentRepository: async () => repo,
        now: () => new Date(time),
      };
      expect(
        await main(
          ["ticket-doctor", "--offline", "--cache", cache, "--json"],
          async (x) => void (out = x),
          runtime,
        ),
      ).toBe(0);
      expect(JSON.parse(out)).toMatchObject({
        kind: "ticket-doctor",
        schemaVersion: 1,
        scanned: 12,
        freshness: { offline: true },
      });
      let text = "";
      await main(
        ["ticket-doctor", "--offline", "--cache", cache],
        async (x) => void (text = x),
        runtime,
      );
      expect(text.split("\n")[0]).toMatch(/OFFLINE cache fetched .*not verified live/);
      for (const bad of [
        ["ticket-doctor", "--limit", "0"],
        ["ticket-doctor", "--stale-hours", "-1"],
        ["ticket-doctor", "--offline"],
      ])
        await expect(main(bad, async () => {}, runtime)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("Ticket Doctor review fixes", () => {
  it("reports every ticket on overlapping blocker cycles", async () => {
    const { blockerCycles } = await import("./ticketdoctor.js");
    // Blocked-by edges 1 -> 2, 1 -> 3, 2 -> 1, 3 -> 2: tickets 1, 2 and 3 are all on a cycle.
    const edges = new Map([
      ["1", ["2", "3"]],
      ["2", ["1"]],
      ["3", ["2"]],
      ["4", ["1"]],
    ]);
    expect(blockerCycles(edges)).toEqual([["1", "2", "3"]]);
    expect(blockerCycles(new Map([["5", ["5"]]]))).toEqual([["5"]]);
  });
  it("flags conflicting classification and awaiting-review without a PR; keeps absence unknown with partial labels", () => {
    const partialLabels = (names: string[]) => ({
      nodes: names.map((name) => ({ name })),
      pageInfo: { hasNextPage: true, endCursor: "x" },
    });
    const r = ticketDoctor(
      snapshot(
        [
          issue(30, ["bug", "enhancement", "status:ready"]),
          issue(32, ["bug", "status:awaiting-review", "agent:y"]),
          { ...issue(33, ["status:blocked"]), labels: partialLabels(["status:blocked"]) } as Issue,
          issue(34, ["bug", "status:ready"]),
        ],
        [],
      ),
      { now: new Date(time) },
    );
    const k = (n: number) =>
      r.tickets.find((t) => t.number === n)?.findings.map((f) => `${f.certainty}:${f.kind}`) ?? [];
    expect(k(30)).toEqual(["candidate:classification-conflict"]);
    expect(k(32)).toEqual(["candidate:awaiting-review-without-pr"]);
    expect(k(33)).toEqual([
      "unknown:labels-incomplete",
      "unknown:classification-missing",
      "unknown:blocked-without-reason",
    ]);
    expect(k(34)).toEqual([]);
    expect(r.completeness.complete).toBe(false);
  });
  it("does not flag ready tickets with open native blockers (ready when blockers close)", () => {
    const blocked = issue(35, ["bug", "status:ready"]);
    blocked.issueDependenciesSummary!.blockedBy = 1;
    blocked.issueDependenciesSummary!.totalBlockedBy = 1;
    blocked.blockedBy = page([
      {
        ...issue(36),
        repository: { nameWithOwner: repo },
        issueDependenciesSummary: {
          blockedBy: 0,
          totalBlockedBy: 0,
          blocking: 0,
          totalBlocking: 0,
        },
      },
    ]);
    expect(ticketDoctor(snapshot([blocked], []), { now: new Date(time) }).tickets).toEqual([]);
  });
});

describe("explicit publication helpers (#79)", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  type Fake = {
    main?: string;
    release?: string | null;
    ancestor?: (x: string, y: string) => boolean;
    dispatchFails?: boolean;
  };
  const fakeRunner = (f: Fake) => {
    const calls: string[] = [];
    const run = (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      if (cmd === "git" && args[0] === "rev-parse")
        return args[1] === "origin/main" ? (f.main ?? A) : (f.release ?? "");
      if (cmd === "git" && args[0] === "ls-remote")
        return f.release ? `${f.release}\trefs/heads/release` : "";
      if (cmd === "git" && args[0] === "merge-base") {
        if (!(f.ancestor ?? (() => true))(args[2], args[3])) throw new Error("not ancestor");
        return "";
      }
      if (cmd === "gh" && f.dispatchFails) throw new Error("dispatch failed");
      return "";
    };
    return { run, calls };
  };
  it("make-prerelease resolves main once and dispatches channel=next on main with that SHA", async () => {
    const { makePrerelease } = await import("../scripts/dispatch.js");
    const f = fakeRunner({ main: A });
    makePrerelease({}, f.run);
    expect(f.calls).toEqual([
      "git fetch --no-tags origin main",
      "git rev-parse origin/main",
      `gh workflow run publish.yml --ref main -f channel=next -f sha=${A}`,
    ]);
  });
  it("release fast-forwards release, then dispatches channel=latest on release; never forces", async () => {
    const { release } = await import("../scripts/dispatch.js");
    const f = fakeRunner({ main: A, release: B });
    const lines = release({}, f.run);
    expect(f.calls.filter((c) => c.startsWith("git push") || c.startsWith("gh"))).toEqual([
      `git push origin ${A}:refs/heads/release`,
      `gh workflow run publish.yml --ref release -f channel=latest -f sha=${A}`,
    ]);
    expect(f.calls.some((c) => c.includes("--force"))).toBe(false);
    expect(lines[0]).toMatch(/publishes nothing/);
    const already = fakeRunner({ main: A, release: A });
    release({}, already.run);
    expect(already.calls.some((c) => c.startsWith("git push"))).toBe(false);
  });
  it("refuses to rewrite release history", async () => {
    const { release } = await import("../scripts/dispatch.js");
    const f = fakeRunner({ main: A, release: B, ancestor: (x) => x !== B });
    expect(() => release({}, f.run)).toThrow(/refusing to rewrite release history/);
    expect(f.calls.some((c) => c.startsWith("git push") || c.startsWith("gh"))).toBe(false);
  });
  it("reports a failed dispatch with a retry for the same SHA, and retries never re-resolve main", async () => {
    const { release, makePrerelease } = await import("../scripts/dispatch.js");
    const f = fakeRunner({ main: A, release: B, dispatchFails: true });
    expect(() => release({}, f.run)).toThrow(
      new RegExp(`Promoted ${A}.*npm run release -- --sha ${A}`),
    );
    const retry = fakeRunner({ main: B, release: A });
    makePrerelease({ sha: A }, retry.run);
    expect(retry.calls).toEqual([
      "git fetch --no-tags origin main",
      `git merge-base --is-ancestor ${A} origin/main`,
      `gh workflow run publish.yml --ref main -f channel=next -f sha=${A}`,
    ]);
    const offMain = fakeRunner({ ancestor: () => false });
    expect(() => makePrerelease({ sha: A }, offMain.run)).toThrow(/not on origin\/main/);
  });
  it("validates arguments", async () => {
    const { parseArgs } = await import("../scripts/dispatch.js");
    expect(parseArgs([])).toEqual({});
    expect(parseArgs(["--help"])).toEqual({ help: true });
    expect(parseArgs(["--sha", A])).toEqual({ sha: A });
    for (const bad of [["--sha", "abc"], ["--sha"], ["--sha", A, "x"], ["--force"]])
      expect(() => parseArgs(bad)).toThrow();
  });
  it("the Publish workflow runs only on explicit dispatch and validates before building", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/publish.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).not.toMatch(/^\s*push:/m);
    expect(workflow).toMatch(/^\s*workflow_dispatch:/m);
    const validate = workflow.indexOf("Validate the request");
    expect(validate).toBeGreaterThan(0);
    expect(validate).toBeLessThan(workflow.indexOf("npm ci"));
    expect(workflow).toContain('"$GITHUB_SHA" != "$SHA"');
    expect(workflow).toContain("next:main|latest:release");
    // A queued request re-checks the live branch head right before publishing.
    const live = workflow.indexOf('git ls-remote origin "refs/heads/$GITHUB_REF_NAME"');
    expect(live).toBeGreaterThan(0);
    expect(live).toBeLessThan(workflow.indexOf("npm publish --provenance"));
  });
});

describe("post-write ownership check with incomplete labels", () => {
  it("reports ownership as unverified instead of confirming success", async () => {
    let reads = 0;
    const q = async () => {
      reads++;
      return {
        repository: {
          issueOrPullRequest: {
            __typename: "Issue",
            number: 7,
            title: "T7",
            url: `https://github.com/${repo}/issues/7`,
            state: "OPEN",
            updatedAt: time,
            labels: {
              nodes: (reads > 1 ? ["agent:kavya"] : ["status:ready"]).map((name) => ({ name })),
              pageInfo: { hasNextPage: reads > 1, endCursor: null },
            },
            issueDependenciesSummary: { blockedBy: 0 },
            blockedBy: page([]),
            closedByPullRequestsReferences: page([]),
            comments: page([]),
            timelineItems: page([]),
          },
          claims: page(reads > 1 ? [{ number: 7, title: "T7", url: issue(7).url }] : []),
          ownerLabel: { name: "agent:kavya" },
        },
      };
    };
    const result = await applyPlan(repo, await planClaim(repo, { number: 7, agent: "kavya" }, q), {
      run: async () => {},
      query: q,
    });
    expect(result.exitCode).toBe(2);
    expect(result.conflict).toMatch(/ownership is unverified/);
  });
});

describe("pr status: formal reviews and in-progress reviews", () => {
  it("counts a formal review by the requested service and blocks while Codex is running", async () => {
    const { prStatus } = await import("./prstatus.js");
    const head = "a".repeat(40);
    const pr = (comments: any[], reviews: any[]) => ({
      number: 12,
      title: "Fix",
      url: `https://github.com/${repo}/pull/12`,
      state: "OPEN",
      isDraft: false,
      merged: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
      headRefOid: head,
      headRefName: "fix",
      baseRefName: "main",
      updatedAt: time,
      commits: {
        nodes: [
          {
            commit: {
              oid: head,
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    {
                      __typename: "CheckRun",
                      name: "verify",
                      status: "COMPLETED",
                      conclusion: "SUCCESS",
                      startedAt: time,
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        ],
      },
      reviews: { nodes: reviews, pageInfo: { hasPreviousPage: false } },
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
      comments: { nodes: comments, pageInfo: { hasPreviousPage: false } },
      closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
    });
    const request = {
      author: { login: "kavya" },
      body: "@coderabbitai review",
      createdAt: "2026-11-12T10:00:00Z",
      url: "u",
    };
    const review = {
      author: { login: "coderabbitai" },
      state: "COMMENTED",
      submittedAt: "2026-11-12T11:00:00Z",
      url: "r",
      commit: { oid: head },
    };
    expect(prStatus(repo, pr([request], [review])).reviewRequest!.status).toBe(
      "a reviewer has posted since the request",
    );
    const codexReq = {
      author: { login: "kavya" },
      body: "@codex review",
      createdAt: "2026-11-12T10:00:00Z",
      url: "u",
    };
    const running = {
      author: { login: "chatgpt-codex-connector[bot]" },
      body: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${head}","status":"running"}} -->`,
      createdAt: "2026-11-12T10:05:00Z",
      url: "c",
    };
    expect(
      prStatus(repo, pr([codexReq, running], [])).blockers.some((b: string) =>
        b.startsWith("waiting for the requested review"),
      ),
    ).toBe(true);
  });
});

describe("pr status: required approvals, verify success and review scoping", () => {
  const head = "a".repeat(40);
  const make = (o: Record<string, any> = {}) => ({
    number: 12,
    title: "Fix",
    url: `https://github.com/${repo}/pull/12`,
    state: "OPEN",
    isDraft: false,
    merged: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: o.mergeState ?? "CLEAN",
    reviewDecision: o.decision ?? null,
    headRefOid: head,
    headRefName: "fix",
    baseRefName: "main",
    updatedAt: time,
    commits: {
      nodes: [
        {
          commit: {
            oid: head,
            statusCheckRollup: {
              contexts: {
                nodes: [
                  {
                    __typename: "CheckRun",
                    name: "verify",
                    status: "COMPLETED",
                    conclusion: o.verify ?? "SUCCESS",
                    startedAt: time,
                  },
                ],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      ],
    },
    reviews: { nodes: o.reviews ?? [], pageInfo: { hasPreviousPage: false } },
    reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
    comments: { nodes: o.comments ?? [], pageInfo: { hasPreviousPage: false } },
    closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
  });
  const marker = (sha: string, at: string) => ({
    author: { login: "chatgpt-codex-connector[bot]" },
    body: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${sha}","status":"completed","has_unresolved_findings":false}} -->`,
    createdAt: at,
    url: "m",
  });
  it("reports missing approvals, a merge block and a non-successful verify", async () => {
    const { prStatus } = await import("./prstatus.js");
    expect(prStatus(repo, make({ decision: "REVIEW_REQUIRED" })).blockers).toContain(
      "a required approving review is missing",
    );
    expect(prStatus(repo, make({ mergeState: "BLOCKED" })).blockers[0]).toMatch(
      /merging is blocked/,
    );
    expect(prStatus(repo, make({ verify: "SKIPPED" })).blockers[0]).toMatch(
      /concluded skipped.*must succeed/,
    );
  });
  it("blocks a branch whose merge state is outside the registered current states", async () => {
    const { prStatus } = await import("./prstatus.js");
    const behind = prStatus(repo, make({ mergeState: "BEHIND" }));
    expect(behind.blockers).toContain("branch is behind main: update it before merging");
    expect(behind.verdict).toMatch(/^Blocked/);
    expect(prStatus(repo, make({ mergeState: "UNSTABLE" })).blockers).toEqual([]);
  });
  it("reports receipts omitted by the presentation limit in JSON and text", async () => {
    const { prStatus, prStatusText } = await import("./prstatus.js");
    const bot = (i: number) => ({
      author: { login: "codecov[bot]" },
      body: `coverage ${i}`,
      createdAt: `2026-11-12T1${i}:00:00Z`,
      url: `c${i}`,
    });
    const r = prStatus(repo, make({ comments: [1, 2, 3, 4, 5].map(bot) }));
    expect(r.receipts.map((x: { url: string }) => x.url)).toEqual(["c3", "c4", "c5"]);
    expect(r.omittedReceipts).toBe(2);
    expect(prStatusText(r)).toContain("…2 earlier receipt(s) omitted");
    expect(prStatus(repo, make()).omittedReceipts).toBe(0);
  });
  it("does not let a Codex marker answer a CodeRabbit request, and accepts a current formal Codex review", async () => {
    const { prStatus } = await import("./prstatus.js");
    const rabbit = {
      author: { login: "kavya" },
      body: "@coderabbitai review",
      createdAt: "2026-11-12T11:00:00Z",
      url: "r",
    };
    const r = prStatus(repo, make({ comments: [marker(head, "2026-11-12T10:00:00Z"), rabbit] }));
    expect(r.reviewRequest!.status).toBe("no reaction yet");
    const stale = prStatus(
      repo,
      make({
        comments: [marker("b".repeat(40), "2026-11-12T10:00:00Z")],
        reviews: [
          {
            author: { login: "chatgpt-codex-connector" },
            state: "COMMENTED",
            submittedAt: "2026-11-12T12:00:00Z",
            url: "v",
            commit: { oid: head },
          },
        ],
      }),
    );
    expect(stale.blockers.some((b: string) => /older commit/.test(b))).toBe(false);
  });
});

describe("pr status: bot instructions are not review requests", () => {
  it("keeps the human request answered when the bot reply quotes the request syntax", async () => {
    const { prStatus } = await import("./prstatus.js");
    const head = "a".repeat(40);
    const pr = {
      number: 12,
      title: "Fix",
      url: `https://github.com/${repo}/pull/12`,
      state: "OPEN",
      isDraft: false,
      merged: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
      headRefOid: head,
      headRefName: "fix",
      baseRefName: "main",
      updatedAt: time,
      commits: {
        nodes: [
          {
            commit: {
              oid: head,
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    {
                      __typename: "CheckRun",
                      name: "verify",
                      status: "COMPLETED",
                      conclusion: "SUCCESS",
                      startedAt: time,
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        ],
      },
      reviews: { nodes: [], pageInfo: { hasPreviousPage: false } },
      reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
      comments: {
        nodes: [
          {
            author: { login: "kavya" },
            body: "@coderabbitai review",
            createdAt: "2026-11-12T10:00:00Z",
            url: "a",
          },
          {
            author: { login: "coderabbitai" },
            body: "Review done. To request another review, use `@coderabbitai review`.",
            createdAt: "2026-11-12T11:00:00Z",
            url: "b",
          },
        ],
        pageInfo: { hasPreviousPage: false },
      },
      closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false } },
    };
    const r = prStatus(repo, pr);
    expect(r.reviewRequest!.url).toBe("a");
    expect(r.reviewRequest!.status).toBe("a reviewer has posted since the request");
  });
});

describe("transferred issue inspection (#39, doc/design/diagnostics.md)", () => {
  const rest = (status: number | null, body: any) => async () => ({ status, body });
  it("distinguishes moved, pull request, missing, forbidden and unknown", async () => {
    const { locateIssue } = await import("./github.js");
    const moved = await locateIssue(
      "o/old",
      701,
      rest(200, {
        repository_url: "https://api.github.com/repos/o/new",
        number: 2,
        html_url: "https://github.com/o/new/issues/2",
      }),
    );
    expect(moved).toMatchObject({
      state: "moved",
      url: "https://github.com/o/old/issues/701",
      destination: { repository: "o/new", number: 2, url: "https://github.com/o/new/issues/2" },
    });
    const same = { repository_url: "https://api.github.com/repos/o/old", number: 5 };
    expect((await locateIssue("o/old", 5, rest(200, { ...same, pull_request: {} }))).state).toBe(
      "pull-request",
    );
    expect((await locateIssue("o/old", 5, rest(404, { status: "404" }))).state).toBe("missing");
    expect((await locateIssue("o/old", 5, rest(403, { status: "403" }))).state).toBe("forbidden");
    expect((await locateIssue("o/old", 5, rest(null, null))).state).toBe("unknown");
    // Missing or forbidden never claims a transfer.
    expect("destination" in (await locateIssue("o/old", 5, rest(404, {})))).toBe(false);
  });
  it("reports instead of failing, and follows a transfer only with --include-transferred", async () => {
    const { IssueUnavailable } = await import("./github.js");
    const diagnosis = {
      repository: "o/old",
      number: 701,
      url: "https://github.com/o/old/issues/701",
      state: "moved" as const,
      destination: { repository: "o/new", number: 2, url: "https://github.com/o/new/issues/2" },
      detail: "Transferred.",
      next: "x",
    };
    const seen: string[] = [];
    const runtime = {
      currentRepository: async () => "o/old",
      collect: async (repository: string, options: { issue?: number }) => {
        seen.push(`${repository}#${options.issue}`);
        if (repository === "o/old") throw new IssueUnavailable(diagnosis);
        return snapshot([issue(2)], []);
      },
    } as any;
    let out = "";
    const write = async (x: string) => void (out = x);
    expect(await main(["--repo", "o/old", "--issue", "701", "--json"], write, runtime)).toBe(2);
    expect(JSON.parse(out)).toMatchObject({ kind: "issue-unavailable", state: "moved" });
    expect(seen).toEqual(["o/old#701"]);
    const code = await main(
      ["--repo", "o/old", "--issue", "701", "--json", "--include-transferred"],
      write,
      runtime,
    );
    expect(code).toBe(0);
    expect(seen).toEqual(["o/old#701", "o/old#701", "o/new#2"]);
    expect(JSON.parse(out).transferredFrom).toMatchObject({ url: diagnosis.url });
  });
});

describe("addressed attention for --agent (#3, doc/design/briefings.md)", () => {
  it("orders attention to the viewer first, then owned work, then pickup; never a claim", async () => {
    const { compactBriefing, compactText } = await import("./compact.js");
    const addressed = issue(20, ["status:parked", "attention:reader", "origin:farhad", "agent:bo"]);
    const other = issue(21, ["attention:someone"]);
    const mine = issue(22, ["agent:reader"]);
    const ready = issue(23, ["status:ready"]);
    const data = snapshot([ready, mine, other, addressed], []);
    const expanded = briefing(data, { limit: 100, agent: "reader" }, new Date(time));
    const compact = compactBriefing(data, { limit: 10, agent: "reader" }, expanded);
    expect(compact.actions.items.slice(0, 2)).toEqual([addressed.url, mine.url]);
    expect(compact.actions.items.indexOf(ready.url)).toBeGreaterThan(1);
    expect(compact.sections.addressed.items).toEqual([addressed.url]);
    const subject = compact.subjects.find((s) => s.url === addressed.url)!;
    expect(subject.owners).toEqual(["agent:bo"]);
    expect(subject.findings[0].reason).toMatch(/raised by farhad.*does not claim/);
    expect(compactText(compact).indexOf("#20")).toBeLessThan(compactText(compact).indexOf("#22"));
    // Another agent's attention never addresses this viewer.
    expect(compact.sections.addressed.items).not.toContain(other.url);
  });
  it("says addressed filtering is unavailable without --agent", async () => {
    const { compactBriefing } = await import("./compact.js");
    const data = snapshot([issue(20, ["attention:reader"])], []);
    const compact = compactBriefing(
      data,
      { limit: 10 },
      briefing(data, { limit: 100 }, new Date(time)),
    );
    expect(compact.sections.addressed.items).toEqual([]);
    expect(compact.guidance).toMatch(/No --agent given/);
  });
});

describe("addressed attention in the expanded briefing (#3)", () => {
  it("is a registered rule, so --full keeps it for parked and other-owned work", () => {
    const addressed = issue(30, ["status:parked", "attention:reader", "agent:bo"]);
    const full = briefing(
      snapshot([addressed, issue(31)], []),
      { limit: 100, agent: "reader" },
      new Date(time),
    );
    expect(full.actions.items[0]).toMatchObject({
      rule: "addressed-attention",
      target: addressed.url,
    });
    const anonymous = briefing(snapshot([addressed], []), { limit: 100 }, new Date(time));
    expect(anonymous.actions.items.some((a) => a.rule === "addressed-attention")).toBe(false);
  });
});

describe("manual urgency overrides in general pickup (#43)", () => {
  it("orders high before unspecified before low, reports conflicts, and never changes eligibility", () => {
    const high = issue(50, ["status:ready", "urgency:high"]);
    const plain = issue(51, ["status:ready"]);
    const low = issue(52, ["status:ready", "urgency:low"]);
    const both = issue(53, ["status:ready", "urgency:high", "urgency:low"]);
    const claimedHigh = issue(54, ["status:ready", "urgency:high", "agent:bo"]);
    const r = briefing(
      snapshot([low, both, plain, high, claimedHigh], []),
      { limit: 100 },
      new Date(time),
    );
    expect(r.ready.items.map((i) => i.number)).toEqual([50, 53, 51, 52]);
    const pickup = r.actions.items
      .filter((a) => a.rule === "ready-unclaimed")
      .map((a) => a.target.split("/").pop());
    expect(pickup).toEqual(["50", "51", "53", "52"]);
    expect(
      r.actions.items.find((a) => a.rule === "ready-unclaimed" && a.target === high.url)!.reason,
    ).toMatch(/urgency:high override/);
    expect(
      r.actions.items.filter((a) => a.rule === "urgency-conflict").map((a) => a.target),
    ).toEqual([both.url]);
    // Urgency never makes claimed work pickable.
    expect(pickup).not.toContain("54");
  });
});

describe("TypeScript source boundary (#91, doc/design/typescript.md)", () => {
  it("keeps maintained first-party code in src/ and doc/reports/examples/ in TypeScript", async () => {
    const root = new URL("../", import.meta.url);
    // Generated output and dependencies are runtime artifacts, not handwritten source.
    // scripts/ may also hold JavaScript or shell helpers (owner decision on #91).
    const skipped = new Set(["node_modules", "dist"]);
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(new URL(dir, root), { withFileTypes: true })) {
        const path = `${dir}${entry.name}`;
        if (entry.isDirectory()) {
          if (!skipped.has(entry.name)) await walk(`${path}/`);
        } else if (/\.[cm]?js$/.test(entry.name)) found.push(path);
      }
    };
    for (const dir of ["src/", "doc/reports/examples/"]) await walk(dir);
    expect(found).toEqual([]);
  });
});

/** Narrow a claim plan to the variant a test expects, failing loudly otherwise. */
function accepted(plan: ClaimPlan): ClaimAccepted {
  if (!plan.ok) throw new Error(`expected an accepted plan, got ${plan.error}`);
  return plan;
}
function refused(plan: ClaimPlan): ClaimRefusal {
  if (plan.ok) throw new Error("expected a refused plan");
  return plan;
}
describe("transferred issue inspection when GraphQL fails (#39)", () => {
  it("diagnoses a failed read through REST, keeping the error when REST is not authoritative", async () => {
    const { collect } = await import("./github.js");
    const failing: Query = async () => {
      throw new Error("GitHub query failed.");
    };
    const forbidden = async (): Promise<IssueDiagnosis> => ({
      repository: "o/x",
      number: 3,
      url: "u",
      state: "forbidden",
      detail: "denied",
      next: "gh auth status",
    });
    await expect(collect("o/x", { issue: 3, locate: forbidden }, failing)).rejects.toMatchObject({
      diagnosis: { state: "forbidden" },
    });
    const unknown = async (): Promise<IssueDiagnosis> => ({
      repository: "o/x",
      number: 3,
      url: "u",
      state: "unknown",
      detail: "",
      next: "",
    });
    await expect(collect("o/x", { issue: 3, locate: unknown }, failing)).rejects.toThrow(
      "GitHub query failed.",
    );
    // Without --issue the original failure is unchanged.
    await expect(collect("o/x", {}, failing)).rejects.toThrow("GitHub query failed.");
  });
});
