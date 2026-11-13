import { describe, expect, it } from "vite-plus/test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
import {
  CONFIG_PATH,
  ConfigError,
  githubRepositories,
  loadConfig,
  nodeFileSystem,
  parseConfig,
  resolveRepositoryTarget,
  settingFor,
  updateConfig,
  type ConfigFileSystem,
  type ConfigSchema,
  type GitRunner,
} from "./config.js";
import { briefing, dependencyDone, textReport } from "./briefing.js";
import { complexityGuidance } from "./complexity.js";
import { classifyField } from "./complexitysetup.js";
import { MAX_COMMENT_PAGES, parseProvenance, provenanceComment } from "./estimate.js";
import type { EstimateProvenance } from "./estimate.js";
import { complexityConfigText, diagnoseComplexityConfig } from "./complexitydoctor.js";
import {
  collect,
  declaredDependencies,
  ghQueryWith,
  graphqlAnswer,
  pages,
  type IssueDiagnosis,
  type Query,
} from "./github.js";
import { clauseFor, hedged, listWideHedge, planMigration } from "./migration.js";
import { applyPlan, planClaim, planNeedsHuman, planRelease } from "./claims.js";
import type { ClaimAccepted, ClaimPlan, ClaimRefusal } from "./claims.js";
import { teamText, teamView } from "./team.js";
import { ticketOwnership, ticketOwnershipText } from "./who.js";
import { ticketDoctor, ticketDoctorText } from "./ticketdoctor.js";
import { localDoctor, localDoctorExitCode, localDoctorText } from "./localdoctor.js";
import type { Issue, Page, PullRequest, Snapshot } from "./types.js";

const repo = "example/project";
const time = "2026-11-12T10:00:00.000Z";
/** Split a command as a POSIX shell would: single quotes, whitespace, and `#` comments. */
const shellWords = (command: string): string[] => {
  const words: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) throw new Error(`Unterminated quote: ${command}`);
      word = (word ?? "") + command.slice(i + 1, end);
      i = end;
    } else if (ch === "\\") {
      word = (word ?? "") + (command[i + 1] ?? "");
      i++;
    } else if (/\s/.test(ch)) {
      if (word !== null) words.push(word);
      word = null;
    } else if (ch === "#" && word === null) break;
    else word = (word ?? "") + ch;
  }
  if (word !== null) words.push(word);
  return words;
};
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
    "terminates the running gh child process when a read is aborted",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "triage-gh-abort-"));
      const path = process.env.PATH;
      try {
        const pidFile = join(dir, "pid");
        // The fake gh records its pid, then replaces itself with a long sleep.
        await writeFile(join(dir, "gh"), `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`, {
          mode: 0o700,
        });
        process.env.PATH = `${dir}:${path}`;
        const controller = new AbortController();
        const pending = ghQueryWith(controller.signal)("query{viewer{login}}", {}).then(
          () => "resolved",
          (error: unknown) => error,
        );
        let pid = 0;
        for (let i = 0; i < 200 && !pid; i++) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          pid = Number((await readFile(pidFile, "utf8").catch(() => "")).trim());
        }
        expect(pid).toBeGreaterThan(0);
        controller.abort();
        expect(await pending).toMatchObject({ name: "AbortError" });
        let alive = true;
        for (let i = 0; i < 200 && alive; i++) {
          try {
            process.kill(pid, 0);
            await new Promise((resolve) => setTimeout(resolve, 25));
          } catch {
            alive = false;
          }
        }
        expect(alive).toBe(false);
        // An already aborted signal never starts gh at all.
        await rm(pidFile);
        await expect(ghQueryWith(controller.signal)("query{viewer{login}}", {})).rejects.toThrow();
        await expect(readFile(pidFile, "utf8")).rejects.toThrow();
      } finally {
        process.env.PATH = path;
        await rm(dir, { recursive: true });
      }
    },
  );

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
          // Source development runs through tsx (doc/design/typescript.md).
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
  /** A recorded release handoff comment, as `release` writes it. */
  const doneBy = (
    agent: string,
    createdAt = "2026-11-12T10:00:00Z",
    outcome = "done",
    claimedAt: string | null = "2026-11-12T09:00:00Z",
  ) => ({
    body: `Handoff.\n\n<!-- github-triage:release:0123456789abcdef ${JSON.stringify({ v: 1, agent, outcome, target: "status:awaiting-review", remove: [], retained: [], claimedAt })} -->`,
    createdAt,
  });
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
    expect(refused(other).recovery[0]).toMatch(
      /^github-triage release 9 --agent kavya --as incomplete/,
    );
    expect(
      (await claim({ labels: ["status:incomplete", "platform:ori"] }, { platform: "ori" })).ok,
    ).toBe(true);
  });
  it("every suggested command keeps --repo executable: no shell comment swallows it", async () => {
    const plans = [
      await claim({ labels: ["status:ready"], claims: [9] }, { branch: "issue-7" }),
      await claim({ labels: ["status:ready"], blockedBy: 1 }),
      await claim({ labels: ["status:ready", "platform:ori"] }),
      await claim({
        labels: ["status:awaiting-review"],
        openPrs: [70],
        comments: [doneBy("kavya")],
      }),
      await claim({ labels: ["status:ready"], openPrs: [70], comments: [doneBy("kavya")] }),
    ];
    const commands = plans.flatMap((p) => refused(p).recovery);
    expect(commands.filter((c) => c.startsWith("github-triage ")).length).toBeGreaterThan(5);
    for (const c of commands) {
      expect(c).not.toMatch(/(^|\s)#/);
      const words = shellWords(c);
      if (words[0] !== "github-triage" && words[0] !== "gh") continue;
      expect(words.indexOf("--repo"), c).toBeGreaterThan(0);
      expect(words[words.indexOf("--repo") + 1], c).toBe(repo);
    }
    // The alternatives to the active claim are separate entries, each a whole command.
    const alternatives = refused(plans[0]).recovery.filter((c) => c.includes("release 9"));
    expect(alternatives.map((c) => shellWords(c)[5])).toEqual(["--as", "--as", "--as"]);
    expect(alternatives.map((c) => shellWords(c)[6])).toEqual(["incomplete", "ready", "done"]);
  });
  describe("review rework reclaim (doc/design/workflow.md: explicit reclaim)", () => {
    const waiting = (extra: Partial<Ticket> = {}): Ticket => ({
      labels: ["status:awaiting-review"],
      openPrs: [70],
      comments: [doneBy("kavya")],
      ...extra,
    });
    it("refuses rework authorised only by a handoff with an unknown claim time", async () => {
      const plan = await claim(
        waiting({ comments: [doneBy("kavya", "2026-11-12T10:00:00Z", "done", null)] }),
        { rework: true },
      );
      expect(plan).toMatchObject({ ok: false, error: "REWORK_NOT_AUTHORISED" });
    });
    it("refuses a plain claim on awaiting review but offers the explicit --rework reclaim", async () => {
      const plan = await claim(waiting());
      expect(plan).toMatchObject({ ok: false, error: "NOT_READY" });
      expect(refused(plan).recovery[0]).toBe(
        `github-triage claim 7 --agent kavya --rework --repo ${repo}`,
      );
    });
    it("reclaims the caller's own awaiting-review issue: claims and leaves review state", async () => {
      const env = fake({ ...waiting(), repoLabels: ["agent:kavya"] });
      const plan = await planClaim(repo, { number: 7, agent: "kavya", rework: true }, env.query);
      const result = await applyPlan(repo, plan, env);
      expect(result.exitCode).toBe(0);
      expect(env.writes[0]).toEqual([
        "issue",
        "edit",
        "7",
        "--repo",
        repo,
        "--add-label",
        "agent:kavya",
        "--remove-label",
        "status:awaiting-review",
      ]);
      expect(env.writes[1].at(-1)).toMatch(/for review rework/);
    });
    it("is ownership-safe: refuses without the caller's own latest done handoff and an open PR", async () => {
      const cases: Ticket[] = [
        waiting({ comments: [doneBy("other")] }),
        waiting({ comments: [doneBy("kavya", "2026-11-12T09:00:00Z"), doneBy("other")] }),
        waiting({ comments: [doneBy("kavya", undefined, "incomplete")] }),
        waiting({ comments: [] }),
        waiting({ openPrs: [] }),
        waiting({ labels: ["status:ready"] }),
        waiting({ labels: ["status:awaiting-review", "agent:other"] }),
      ];
      for (const t of cases) {
        const plan = await claim(t, { rework: true });
        expect(plan.ok, JSON.stringify(t)).toBe(false);
        expect(["REWORK_NOT_AUTHORISED", "OWNED_BY_OTHER"]).toContain(refused(plan).error);
      }
      // Another agent is never offered the rework reclaim.
      const other = await planClaim(repo, { number: 7, agent: "nicole" }, fake(waiting()).query);
      expect(refused(other).recovery.join(" ")).not.toMatch(/--rework/);
    });
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
        doctor: {
          git: async () => {
            throw new Error("no checkout");
          },
        },
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

describe("designer groups: decision needed vs agreed-needs-documentation (#40)", () => {
  it("groups explicit markers separately with source reasons; unknown without one", async () => {
    const { compactBriefing, compactText } = await import("./compact.js");
    const decide = issue(40, ["design:decision-needed"]);
    decide.comments = page([
      {
        body: "design:decision-needed: which flag name?",
        url: `${decide.url}#c1`,
        author: null,
        createdAt: time,
      },
    ]);
    const record = issue(41, ["design:documentation-needed"]);
    const both = issue(42, ["design:decision-needed", "design:documentation-needed"]);
    const data = snapshot([decide, record, both], []);
    const expanded = briefing(data, { limit: 100 }, new Date(time));
    const rules = (n: number) =>
      expanded.actions.items
        .filter((a) => a.target.endsWith(`/${n}`) && a.rule.startsWith("design-"))
        .map((a) => `${a.uncertainty}:${a.rule}`);
    expect(rules(40)).toEqual(["factual:design-decision-needed"]);
    expect(
      expanded.actions.items.find(
        (a) => a.rule === "design-decision-needed" && a.target === decide.url,
      )!.evidence,
    ).toContain(`${decide.url}#c1`);
    expect(rules(41)).toEqual(["unknown:design-documentation-needed"]);
    expect(rules(42).sort()).toEqual([
      "unknown:design-decision-needed",
      "unknown:design-documentation-needed",
    ]);
    const compact = compactBriefing(data, { limit: 10 }, expanded);
    expect(compact.sections["decision-needed"].items).toEqual([decide.url, both.url]);
    expect(compact.sections["documentation-needed"].items).toEqual([record.url, both.url]);
    const text = compactText(compact, 50000);
    expect(text).toContain("DECISION NEEDED (2;");
    expect(text).toContain("AGREED, NEEDS DOCUMENTATION (2;");
    expect(text).toContain(`which flag name?" Source: ${decide.url}#c1 Next:`);
    expect(text.match(/Source: /g)).toHaveLength(1);
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
    // Conflicting labels order as unspecified; ties then use creation time and number.
    expect(r.ready.items.map((i) => i.number)).toEqual([50, 51, 53, 52]);
    const pickup = r.actions.items
      .filter((a) => a.rule === "ready-unclaimed")
      .map((a) => a.target.split("/").pop());
    expect(pickup).toEqual(["50", "51", "53", "52"]);
    expect(
      r.actions.items.find((a) => a.rule === "ready-unclaimed" && a.target === high.url)!.reason,
    ).toMatch(/urgency high/);
    expect(
      r.actions.items.filter((a) => a.rule === "urgency-conflict").map((a) => a.target),
    ).toEqual([both.url]);
    // Urgency never makes claimed work pickable.
    expect(pickup).not.toContain("54");
  });
});

describe("next-action ranking (#45, doc/design/briefings.md acceptance examples)", () => {
  const at = (item: Issue, createdAt: string): Issue => ({ ...item, createdAt });
  const blocks = (from: Issue, dependants: Issue[]): void => {
    from.issueDependenciesSummary!.blocking = dependants.length;
    from.issueDependenciesSummary!.totalBlocking = dependants.length;
    from.blocking = page(
      dependants.map((d) => ({
        number: d.number,
        title: d.title,
        url: d.url,
        state: d.state,
        repository: { nameWithOwner: repo },
        issueDependenciesSummary: d.issueDependenciesSummary!,
      })),
    );
  };
  const blockedBy = (item: Issue, count: number): Issue => {
    item.issueDependenciesSummary!.blockedBy = count;
    item.issueDependenciesSummary!.totalBlockedBy = count;
    return item;
  };
  const compact = async (data: Snapshot, options: Parameters<typeof briefing>[1]) => {
    const { compactBriefing } = await import("./compact.js");
    const expanded = briefing(data, { ...options, limit: 1000 }, new Date(time));
    return compactBriefing(data, options, expanded);
  };
  const numbers = (urls: string[]) => urls.map((url) => Number(url.split("/").pop()));

  it("addressed low-urgency work precedes high-urgency pickup", async () => {
    const addressed = issue(10, ["status:ready", "urgency:low", "attention:reader"]);
    const urgent = issue(11, ["status:ready", "urgency:high"]);
    const r = await compact(snapshot([urgent, addressed], []), { limit: 5, agent: "reader" });
    expect(numbers(r.actions.items).slice(0, 2)).toEqual([10, 11]);
  });
  it("a ready ticket with an open closing PR appears once, as PR follow-up", async () => {
    const r = await compact(snapshot([issue(1)], [pr()]), { limit: 5 });
    expect(r.sections.available.items).toEqual([]);
    expect(r.actions.items).toEqual([pr().url]);
  });
  it("awaiting review is a consistent readiness state but never implementation pickup (#62)", () => {
    const waiting = issue(22, ["status:awaiting-review"]);
    const r = brief(snapshot([waiting], []));
    expect(r.ready.items.map((i) => i.number)).toEqual([]);
    expect(r.actions.items.some((a) => a.rule === "readiness-inconsistent")).toBe(false);
  });
  it("prefers released incomplete work over unstarted work on an impact tie", () => {
    const ready = issue(20, ["status:ready"]);
    const incomplete = issue(21, ["status:incomplete"]);
    const r = brief(snapshot([ready, incomplete], []));
    expect(r.ready.items.map((i) => i.number)).toEqual([21, 20]);
    expect(r.actions.items.some((a) => a.rule === "readiness-inconsistent")).toBe(false);
  });
  it("counts only dependants that become otherwise eligible, not ones with another blocker", () => {
    const shared = issue(30);
    const lastBlocker = issue(31);
    const twoBlockers = [blockedBy(issue(32), 2), blockedBy(issue(33), 2)];
    const unlocked = blockedBy(issue(34), 1);
    const needsDesign = blockedBy(issue(35, ["status:ready", "status:needs-design"]), 1);
    blocks(shared, [...twoBlockers, needsDesign]);
    blocks(lastBlocker, [unlocked]);
    const r = brief(snapshot([shared, lastBlocker, ...twoBlockers, unlocked, needsDesign], []));
    const ranked = r.ready.items.map((i) => [i.number, i.unlocks]);
    expect(ranked).toEqual([
      [31, [34]],
      [30, []],
    ]);
  });
  it("does not count a dependant whose own native dependency evidence is missing", () => {
    const blocker = issue(36);
    const unknown = blockedBy(issue(37), 1);
    delete (unknown as Partial<Issue>).blockedBy;
    blocks(blocker, [unknown]);
    const r = brief(snapshot([blocker, unknown], []));
    expect(r.ready.items.map((i) => [i.number, i.unlocks])).toEqual([[36, []]]);
  });
  it("oldest mode orders by creation time alone, keeping urgency and impact visible", () => {
    const oldLow = at(issue(40, ["status:ready", "urgency:low"]), "2026-01-01T00:00:00Z");
    const newHigh = at(issue(41, ["status:ready", "urgency:high"]), "2026-06-01T00:00:00Z");
    const data = snapshot([newHigh, oldLow], []);
    const oldest = briefing(data, { limit: 100, order: "oldest" }, new Date(time));
    expect(oldest.ready.items.map((i) => i.number)).toEqual([40, 41]);
    expect(oldest.ready.items[1].urgency).toBe("high");
    expect(oldest.ready.items[0].rankReason).toMatch(/oldest-first .*urgency low/);
    const newest = briefing(data, { limit: 100, order: "newest" }, new Date(time));
    expect(newest.ready.items.map((i) => i.number)).toEqual([41, 40]);
    expect(brief(data).ready.items.map((i) => i.number)).toEqual([41, 40]);
  });
  it("unknown platform or native evidence never becomes pickup", () => {
    const restricted = issue(50, ["status:ready", "platform:codex", "platform:ori"]);
    const missing = issue(51) as Partial<Issue>;
    delete missing.blockedBy;
    const data = snapshot([restricted, missing as Issue], []);
    const unknown = brief(data);
    expect(unknown.ready.total).toBe(0);
    expect(unknown.actions.items.find((a) => a.target === restricted.url)?.rule).toBe(
      "pickup-unverified",
    );
    const match = briefing(data, { limit: 100, platform: "ori" }, new Date(time));
    expect(match.ready.items.map((i) => i.number)).toEqual([50]);
    const mismatch = briefing(data, { limit: 100, platform: "claude-code" }, new Date(time));
    expect(mismatch.ready.total).toBe(0);
    expect(mismatch.actions.items.some((a) => a.rule === "pickup-unverified")).toBe(false);
  });
  it("breaks exact ties by numeric identity, not text (#14 before #100)", () => {
    const r = brief(snapshot([issue(100), issue(14)], []));
    expect(r.ready.items.map((i) => i.number)).toEqual([14, 100]);
  });
  it("treats pending CI as waiting, behind own work and pickup", async () => {
    const waiting = pr();
    waiting.closingIssuesReferences = page([]);
    waiting.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes = [
      { name: "verify", status: "IN_PROGRESS" },
    ];
    const r = await compact(snapshot([issue(2, ["agent:reader"]), issue(3)], [waiting]), {
      limit: 5,
      agent: "reader",
    });
    expect(numbers(r.actions.items)).toEqual([2, 3, 4]);
    const rules = r.subjects.find((s) => s.url === waiting.url)!.findings.map((f) => f.rule);
    expect(rules).not.toContain("pr-failed-checks");
    expect(rules).not.toContain("pr-inspect-merge");
  });
  it("puts actionable PR follow-up before own active work, own PRs first", async () => {
    const failing = (number: number, closes: Issue[]): PullRequest => {
      const pull = { ...pr(), number, url: `https://github.com/${repo}/pull/${number}` };
      pull.closingIssuesReferences = page(closes.map((i) => ({ number: i.number, url: i.url })));
      pull.commits = {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "FAILURE",
                contexts: page([{ name: "verify", conclusion: "FAILURE" }]),
              },
            },
          },
        ],
      };
      return pull;
    };
    const mine = issue(5, ["agent:reader"]);
    const owned = issue(6, ["agent:reader"]);
    const r = await compact(snapshot([mine, owned], [failing(90, []), failing(91, [mine])]), {
      limit: 5,
      agent: "reader",
    });
    expect(numbers(r.actions.items)).toEqual([91, 90, 5, 6]);
  });
  it("flags claims stale after two days of ticket/linked-PR inactivity, never releasing them", () => {
    const old = at(issue(60, ["agent:bo"]), "2026-11-01T00:00:00Z");
    old.updatedAt = "2026-11-09T00:00:00Z";
    const fresh = issue(61, ["agent:bo"]);
    const r = brief(snapshot([old, fresh], []));
    const stale = r.actions.items.filter((a) => a.rule === "stale-claim");
    expect(stale.map((a) => a.target)).toEqual([old.url]);
    expect(stale[0].next).toContain("Never auto-release");
    const relaxed = briefing(snapshot([old], []), { limit: 100, staleHours: 200 }, new Date(time));
    expect(relaxed.actions.items.some((a) => a.rule === "stale-claim")).toBe(false);
  });
  it("validates --order, --platform and --stale-hours", () => {
    expect(argumentsFor(["--order", "oldest", "--platform", "codex"])).toMatchObject({
      order: "oldest",
      platform: "codex",
    });
    expect(argumentsFor([]).order).toBe("impact");
    expect(() => argumentsFor(["--order", "urgent"])).toThrow("--order must be one of");
    expect(() => argumentsFor(["--stale-hours", "0"])).toThrow("--stale-hours");
  });
});

describe("TypeScript source boundary (#91, #113, doc/design/typescript.md)", () => {
  it("allows only allowlisted non-TypeScript files in src/, scripts/ and doc/reports/examples/", async () => {
    const { LANGUAGE_SCOPE, languageViolations } = await import("./language-policy.js");
    const root = new URL("../", import.meta.url);
    // Generated output and dependencies are runtime artifacts, not handwritten source.
    const skipped = new Set(["node_modules", "dist"]);
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(new URL(dir, root), { withFileTypes: true })) {
        const path = `${dir}${entry.name}`;
        if (entry.isDirectory()) {
          if (!skipped.has(entry.name)) await walk(`${path}/`);
        } else files.push(path);
      }
    };
    for (const dir of LANGUAGE_SCOPE) await walk(dir);
    const sources = new Map<string, string>();
    for (const file of files) {
      if (/\.tsx?$/.test(file) && (file.startsWith("src/") || file.startsWith("scripts/"))) {
        sources.set(file, await readFile(new URL(file, root), "utf8"));
      }
    }
    expect(languageViolations(files, sources)).toEqual([]);
  });

  it("fails unlisted files, stale entries and imports of allowlisted files", async () => {
    const { languageViolations } = await import("./language-policy.js");
    const entry = {
      file: "scripts/helper.sh",
      purpose: "p",
      integrationBoundary: "b",
      runtimeRequirements: "r",
      supportedPlatforms: "s",
      validation: "v",
    };
    const none = new Map<string, string>();
    expect(languageViolations(["scripts/helper.sh"], none, [])).toEqual([
      "scripts/helper.sh: non-TypeScript file is not on the allowlist",
    ]);
    expect(languageViolations(["scripts/helper.sh", "src/cli.ts"], none, [entry])).toEqual([]);
    expect(languageViolations(["src/cli.ts"], none, [entry])).toEqual([
      "scripts/helper.sh: allowlisted file does not exist",
    ]);
    const importing = new Map([["src/cli.ts", 'import x from "../scripts/helper.sh";']]);
    expect(languageViolations(["scripts/helper.sh", "src/cli.ts"], importing, [entry])).toEqual([
      "src/cli.ts: imports allowlisted non-TypeScript file scripts/helper.sh",
    ]);
    const requiring = new Map([["scripts/a.ts", 'require("./helper.sh")']]);
    expect(languageViolations(["scripts/helper.sh"], requiring, [entry])).toHaveLength(1);
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

describe("who is working on a ticket (#61, doc/design/diagnostics.md)", () => {
  const at = (hoursAgo: number) => new Date(Date.parse(time) - hoursAgo * 3_600_000).toISOString();
  const note = (body: string, hoursAgo: number, n = 0) => ({
    body,
    url: `https://github.com/${repo}/issues/1#c${n}`,
    author: { login: "shared" },
    createdAt: at(hoursAgo),
    updatedAt: at(hoursAgo),
  });
  const ticket = (labels: string[], comments: ReturnType<typeof note>[] = [], hoursAgo = 1) => ({
    ...issue(1, labels),
    updatedAt: at(hoursAgo),
    comments: page(comments),
  });
  const lookup = (data: Snapshot, staleHours?: number) =>
    ticketOwnership(data, 1, { now: new Date(time), staleHours });
  const kinds = (r: ReturnType<typeof lookup>) => r.findings.map((f) => `${f.certainty}:${f.kind}`);

  it("label-only ownership: answers from the agent: label, presence unknown", () => {
    const r = lookup(snapshot([ticket(["agent:ana"])], []));
    expect(r).toMatchObject({
      kind: "ticket-ownership",
      schemaVersion: 1,
      recordedOwners: ["ana"],
    });
    expect(r.answer).toBe("recorded claim: ana");
    expect(r.presence).toMatch(/^unknown/);
    expect(kinds(r)).toEqual([]);
    expect(r.next).toContain(`github-triage --repo ${repo} --issue 1`);
    expect(ticketOwnershipText(r)).toContain("Presence: unknown");
  });
  it("comment-only reported work is a candidate, not a claim", () => {
    const r = lookup(snapshot([ticket(["status:ready"], [note("Picked up by dee", 1)])], []));
    expect(r.recordedOwners).toEqual([]);
    expect(r.answer).toMatch(/^no recorded claim/);
    expect(kinds(r)).toEqual(["candidate:comment-only-work"]);
    expect(r.commentEvidence[0]).toMatchObject({ kind: "reported-work" });
  });
  it("released contribution with an open PR: awaiting review is not ownership", () => {
    const linked = pr();
    linked.updatedAt = at(0.5);
    const r = lookup(
      snapshot(
        [ticket([], [note("Picked up", 3, 1), note("Released my claim; PR awaits review", 2, 2)])],
        [linked],
      ),
    );
    expect(r.pullRequests.map((p) => p.number)).toEqual([4]);
    expect(kinds(r)).toEqual(["candidate:unowned-open-pr"]);
    expect(r.latestActivity!.source).toBe("PR #4 updated");
    expect(r.next).toContain(`github-triage pr 4 --repo ${repo}`);
  });
  it("multiple owners are definite; a claim after a handoff comment is a candidate contradiction", () => {
    const r = lookup(
      snapshot([ticket(["agent:ana", "agent:bo"], [note("Handing off to review", 1)])], []),
    );
    expect(r.answer).toBe("conflicting recorded claims: ana, bo");
    expect(kinds(r)).toEqual(["definite:multiple-owners", "candidate:claim-after-handoff"]);
  });
  it("stale activity is a candidate and releases nothing", () => {
    const r = lookup(snapshot([ticket(["agent:ana"], [], 100)], []));
    expect(kinds(r)).toEqual(["candidate:stale-activity"]);
    expect(kinds(lookup(snapshot([ticket(["agent:ana"], [], 100)], []), 200))).toEqual([]);
  });
  it("incomplete labels make ownership unknown, never nobody", () => {
    const t = ticket([]);
    t.labels = page([], true, "x");
    const r = lookup(snapshot([t], []));
    expect(r.recordedOwners).toBeNull();
    expect(r.answer).toMatch(/^unknown/);
    expect(r.completeness.complete).toBe(false);
  });
  it("runs through the CLI with --issue collection and validates arguments", async () => {
    let out = "";
    let options: unknown;
    const runtime = {
      collect: async (_r: string, o: unknown) => {
        options = o;
        return snapshot([ticket(["agent:ana"])], []);
      },
      currentRepository: async () => repo,
      now: () => new Date(time),
    };
    expect(await main(["who", "1", "--json"], async (t) => void (out = t), runtime)).toBe(0);
    expect(options).toEqual({ issue: 1 });
    expect(JSON.parse(out).answer).toBe("recorded claim: ana");
    for (const bad of [["who"], ["who", "x"], ["who", "1", "--stale-hours", "0"]])
      await expect(main(bad, async () => {}, runtime)).rejects.toThrow();
  });
});

describe("repository configuration service (#116, doc/design/repository-configuration.md)", () => {
  const root = "/repo";
  const path = join(root, CONFIG_PATH);
  /** In-memory filesystem; `onBeforeRename` simulates a concurrent edit. */
  function memoryFs(initial?: string) {
    const files = new Map<string, string>(initial === undefined ? [] : [[path, initial]]);
    const writes: string[] = [];
    let onBeforeRename: (() => void) | undefined;
    let failRename = false;
    const fs: ConfigFileSystem = {
      readText: async (file) => files.get(file) ?? null,
      writeText: async (file, text) => {
        writes.push(file);
        files.set(file, text);
      },
      rename: async (from, to) => {
        onBeforeRename?.();
        if (failRename) throw new Error("disk full");
        files.set(to, files.get(from)!);
        files.delete(from);
      },
      remove: async (file) => void files.delete(file),
      makeDirectory: async () => undefined,
    };
    return {
      fs,
      files,
      writes,
      concurrent: (edit: () => void) => (onBeforeRename = edit),
      failRename: () => (failRename = true),
    };
  }
  const target = { root, repository: "owner/name" };
  const token = () => "t";

  it("defaults complexity on, fieldId unset, when the file is absent", async () => {
    const memory = memoryFs();
    const config = await loadConfig(root, memory.fs);
    expect(config.storedVersion).toBeNull();
    expect(config.settings).toEqual([
      { key: "complexity.enabled", value: true, source: "default" },
      { key: "complexity.fieldId", value: null, source: "default" },
    ]);
    expect(memory.writes).toEqual([]);
  });

  it("treats an explicitly stored default as explicit", () => {
    const config = parseConfig('{"schemaVersion":1,"complexity":{"enabled":true}}', undefined);
    expect(settingFor(config, "complexity.enabled").source).toBe("explicit");
    expect(settingFor(config, "complexity.fieldId").source).toBe("default");
  });

  it("reports explicit settings and their source", async () => {
    const memory = memoryFs(
      '{"schemaVersion":1,"complexity":{"enabled":false,"fieldId":"PVTF_1"}}',
    );
    const config = await loadConfig(root, memory.fs);
    expect(settingFor(config, "complexity.enabled")).toEqual({
      key: "complexity.enabled",
      value: false,
      source: "explicit",
    });
    expect(settingFor(config, "complexity.fieldId").value).toBe("PVTF_1");
    expect(() => settingFor(config, "complexity.colour")).toThrow(ConfigError);
  });

  it.each([
    ["not json", "malformed"],
    ["[]", "malformed"],
    ['{"complexity":{}}', "malformed"],
    ['{"schemaVersion":2}', "unsupported-version"],
    ['{"schemaVersion":1,"complexity":{"enabled":"yes"}}', "incompatible"],
    ['{"schemaVersion":1,"token":"secret"}', "incompatible"],
    // Empty objects must not bypass validation (Codex review on #131).
    ['{"schemaVersion":1,"complexity":{"enabled":{}}}', "incompatible"],
    ['{"schemaVersion":1,"futureSetting":{}}', "incompatible"],
    ['{"schemaVersion":1,"complexity":{"enabled":true,"later":{}}}', "incompatible"],
  ])("refuses %s without touching the file", async (raw, code) => {
    const memory = memoryFs(raw);
    await expect(loadConfig(root, memory.fs)).rejects.toMatchObject({ code });
    await expect(
      updateConfig(target, new Map([["complexity.enabled", false]]), { fs: memory.fs, token }),
    ).rejects.toMatchObject({ code });
    expect(memory.files.get(path)).toBe(raw);
    expect(memory.writes).toEqual([]);
  });

  it("migrates older schemas in memory on read and only persists on write", async () => {
    const schema: ConfigSchema = {
      version: 2,
      keys: [
        {
          key: "complexity.enabled",
          type: "boolean",
          nullable: false,
          defaultValue: true,
          description: "",
        },
        { key: "other", type: "string", nullable: true, defaultValue: null, description: "" },
      ],
      migrations: [
        {
          from: 1,
          migrate: ({ estimates, ...rest }) => ({ ...rest, complexity: { enabled: estimates } }),
        },
      ],
    };
    const old = '{"schemaVersion":1,"estimates":false,"other":"kept"}';
    const memory = memoryFs(old);
    const read = await loadConfig(root, memory.fs, schema);
    expect(read.storedVersion).toBe(1);
    expect(read.explicit.get("complexity.enabled")).toBe(false);
    expect(memory.files.get(path)).toBe(old);

    const written = await updateConfig(target, new Map([["other", "changed"]]), {
      fs: memory.fs,
      schema,
      token,
    });
    expect(written.changed).toBe(true);
    expect(JSON.parse(memory.files.get(path)!)).toEqual({
      schemaVersion: 2,
      complexity: { enabled: false },
      other: "changed",
    });
  });

  it("refuses an older schema with no registered migration", async () => {
    const memory = memoryFs('{"schemaVersion":1}');
    const schema: ConfigSchema = { version: 2, keys: [], migrations: [] };
    await expect(loadConfig(root, memory.fs, schema)).rejects.toMatchObject({
      code: "unsupported-version",
    });
  });

  it("writes atomically, preserves unrelated settings and skips equal writes", async () => {
    const memory = memoryFs('{"schemaVersion":1,"complexity":{"fieldId":"PVTF_1"}}');
    const result = await updateConfig(target, new Map([["complexity.enabled", false]]), {
      fs: memory.fs,
      token,
    });
    expect(result.changed).toBe(true);
    expect(memory.writes).toEqual([`${path}.t.tmp`]);
    expect(memory.files.has(`${path}.t.tmp`)).toBe(false);
    expect(JSON.parse(memory.files.get(path)!)).toEqual({
      schemaVersion: 1,
      complexity: { enabled: false, fieldId: "PVTF_1" },
    });
    const again = await updateConfig(target, new Map([["complexity.enabled", false]]), {
      fs: memory.fs,
      token,
    });
    expect(again.changed).toBe(false);
    expect(memory.writes).toHaveLength(1);
  });

  it("unsets a key back to its default and creates no file for default-only state", async () => {
    const memory = memoryFs('{"schemaVersion":1,"complexity":{"fieldId":"PVTF_1"}}');
    await updateConfig(target, new Map([["complexity.fieldId", undefined]]), {
      fs: memory.fs,
      token,
    });
    expect(JSON.parse(memory.files.get(path)!)).toEqual({ schemaVersion: 1 });
    const empty = memoryFs();
    const result = await updateConfig(target, new Map([["complexity.fieldId", undefined]]), {
      fs: empty.fs,
      token,
    });
    expect(result.changed).toBe(false);
    expect(empty.files.size).toBe(0);
  });

  it("validates values against the registry before writing", async () => {
    const memory = memoryFs();
    for (const [key, value] of [
      ["complexity.enabled", "false"],
      ["complexity.enabled", null],
      ["complexity.fieldId", ""],
      ["complexity.colour", true],
    ] as const) {
      await expect(
        updateConfig(target, new Map([[key, value]]), { fs: memory.fs, token }),
      ).rejects.toBeInstanceOf(ConfigError);
    }
    expect(memory.writes).toEqual([]);
  });

  it("detects an intervening edit and leaves the other writer's file in place", async () => {
    const memory = memoryFs('{"schemaVersion":1}');
    const theirs = '{"schemaVersion":1,"complexity":{"fieldId":"PVTF_9"}}';
    const fs: ConfigFileSystem = {
      ...memory.fs,
      writeText: async (file, text) => {
        await memory.fs.writeText(file, text);
        memory.files.set(path, theirs);
      },
    };
    await expect(
      updateConfig(target, new Map([["complexity.enabled", false]]), { fs, token }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(memory.files.get(path)).toBe(theirs);
    expect(memory.files.has(`${path}.t.tmp`)).toBe(false);
  });

  it("removes the temporary file and keeps the original when the replace fails", async () => {
    const original = '{"schemaVersion":1}';
    const memory = memoryFs(original);
    memory.failRename();
    await expect(
      updateConfig(target, new Map([["complexity.enabled", false]]), { fs: memory.fs, token }),
    ).rejects.toThrow("disk full");
    expect(memory.files.get(path)).toBe(original);
    expect([...memory.files.keys()]).toEqual([path]);
  });

  it("writes through the real filesystem into a temporary checkout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "triage-config-"));
    try {
      const local = { root: directory, repository: "owner/name" };
      await updateConfig(local, new Map([["complexity.enabled", false]]));
      const config = await loadConfig(directory);
      expect(settingFor(config, "complexity.enabled").source).toBe("explicit");
      expect(await readdir(join(directory, ".github"))).toEqual(["triage.json"]);
      await expect(nodeFileSystem.readText(join(directory, "missing"))).resolves.toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  describe("repository resolution before writes", () => {
    const git =
      (remotes: string, top = "/repo"): GitRunner =>
      async (args) =>
        args[0] === "rev-parse" ? `${top}\n` : remotes;

    it("parses GitHub remotes in common forms", () => {
      expect(
        githubRepositories(
          "origin\tgit@github.com:Owner/Name.git (fetch)\nup\thttps://github.com/a/b (push)\nx\thttps://gitlab.com/c/d (fetch)",
        ),
      ).toEqual(["owner/name", "a/b"]);
    });

    it("only accepts remotes whose host is exactly github.com", () => {
      expect(
        githubRepositories(
          [
            "a\thttps://notgithub.com/evil/one.git (fetch)",
            "b\t/mirrors/github.com/evil/two.git (fetch)",
            "c\thttps://example.com/github.com/evil/three.git (fetch)",
            "d\tgit@github.com.evil.net:evil/four.git (fetch)",
            "e\t../github.com/evil/five (fetch)",
            "f\tssh://git@GitHub.com/Ok/One.git (fetch)",
            "g\tgit@GITHUB.COM:ok/two (fetch)",
            "h\thttps://user@github.com/ok/three/ (fetch)",
          ].join("\n"),
        ),
      ).toEqual(["ok/one", "ok/two", "ok/three"]);
    });

    it("accepts a checkout whose remote matches --repo", async () => {
      await expect(
        resolveRepositoryTarget(
          "/repo/src",
          "owner/name",
          git("origin\thttps://github.com/owner/name.git (fetch)"),
        ),
      ).resolves.toEqual({ root: "/repo", repository: "owner/name" });
    });

    it("refuses when --repo names an unrelated repository", async () => {
      await expect(
        resolveRepositoryTarget(
          "/repo",
          "other/project",
          git("origin\thttps://github.com/owner/name (fetch)"),
        ),
      ).rejects.toMatchObject({ code: "repository-mismatch" });
    });

    it("refuses ambiguous remotes without --repo and non-checkouts", async () => {
      await expect(
        resolveRepositoryTarget(
          "/repo",
          undefined,
          git("a\thttps://github.com/x/y (fetch)\nb\thttps://github.com/p/q (fetch)"),
        ),
      ).rejects.toMatchObject({ code: "repository-mismatch" });
      const failing: GitRunner = async () => {
        throw new Error("not a git repository");
      };
      await expect(resolveRepositoryTarget("/tmp", undefined, failing)).rejects.toMatchObject({
        code: "not-a-repository",
      });
    });
  });
});

describe("bundled complexity guidance (#118)", () => {
  const offline = {
    collect: async (): Promise<never> => {
      throw new Error("guidance must not query GitHub");
    },
    currentRepository: async (): Promise<never> => {
      throw new Error("guidance must not resolve a repository");
    },
    updateCheck: async () => ({ status: "skipped" as const, reason: "" }),
  };
  it("renders text and JSON help from one versioned definition without GitHub", async () => {
    let text = "";
    let json = "";
    expect(await main(["estimate", "--help"], async (t) => void (text = t), offline)).toBe(0);
    expect(
      await main(["estimate", "--help", "--json"], async (t) => void (json = t), offline),
    ).toBe(0);
    const parsed = JSON.parse(json);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      kind: "complexity-guidance",
      guidanceVersion: complexityGuidance.guidanceVersion,
      sizes: ["XS", "S", "M", "L", "XL", "XXL"],
    });
    expect(parsed.bands.map((b: { size: string }) => b.size)).toEqual(parsed.sizes);
    for (const band of complexityGuidance.bands) expect(text).toContain(band.guidance);
    expect(text).toContain(`version ${complexityGuidance.guidanceVersion}`);
    expect(text).toMatch(/not hours/);
    expect(text).toMatch(/waiting/);
    expect(text).toMatch(/no anchors/);
    expect(text).toContain("--rationale TEXT");
    // Repository-neutral: no ticket/PR numbers from any repository are bundled.
    expect(json).not.toMatch(/#\d+/);
  });
  it("lists estimate in top-level help and validates recording arguments first", async () => {
    let text = "";
    await main(["--help"], async (t) => void (text = t), offline);
    expect(text).toContain("estimate --help");
    expect(text).toContain("estimate N --size S --rationale TEXT");
    await expect(main(["estimate", "12", "M"], async () => {}, offline)).rejects.toThrow("Usage:");
    await expect(main(["estimate", "12", "--size", "M"], async () => {}, offline)).rejects.toThrow(
      "--rationale is required",
    );
    await expect(
      main(["estimate", "12", "--size", "huge", "--rationale", "x"], async () => {}, offline),
    ).rejects.toThrow("--size must be one of");
    await expect(main(["estimate"], async () => {}, offline)).rejects.toThrow("Usage:");
  });
});

describe("config get/set/list/help commands (#117)", () => {
  const root = "/repo";
  const path = join(root, CONFIG_PATH);
  function setup(
    initial?: string,
    remotes = "origin\thttps://github.com/owner/name.git (fetch)\n",
  ) {
    const files = new Map<string, string>(initial === undefined ? [] : [[path, initial]]);
    const fs: ConfigFileSystem = {
      readText: async (file) => files.get(file) ?? null,
      writeText: async (file, text) => void files.set(file, text),
      rename: async (from, to) => {
        files.set(to, files.get(from)!);
        files.delete(from);
      },
      remove: async (file) => void files.delete(file),
      makeDirectory: async () => undefined,
    };
    const git: GitRunner = async (args) =>
      args[0] === "rev-parse" ? `${root}\n` : args[0] === "remote" ? remotes : "";
    const out: string[] = [];
    const call = (...args: string[]) =>
      main(["config", ...args, "--no-update-check"], async (t) => void out.push(t), {
        collect: async () => {
          throw new Error("no GitHub");
        },
        currentRepository: async () => {
          throw new Error("no GitHub");
        },
        config: { fs, git, cwd: root },
      });
    return { files, fs, out, call, json: () => JSON.parse(out.at(-1)!) };
  }

  it("gets effective defaults with provenance without creating the file", async () => {
    const t = setup();
    expect(await t.call("get", "complexity.enabled")).toBe(0);
    expect(t.out[0]).toBe("complexity.enabled = true (default)\n");
    expect(await t.call("get", "complexity.fieldId", "--json")).toBe(0);
    expect(t.json()).toMatchObject({
      schemaVersion: 1,
      kind: "config-get",
      repository: "owner/name",
      key: "complexity.fieldId",
      value: null,
      source: "default",
    });
    expect(t.files.size).toBe(0);
  });

  it("sets through the service, is idempotent, and disabling keeps the field mapping", async () => {
    const t = setup('{"schemaVersion":1,"complexity":{"fieldId":"PVTF_1"}}');
    expect(await t.call("set", "complexity.enabled", "false", "--json")).toBe(0);
    expect(t.json()).toMatchObject({ changed: true, value: false, source: "explicit" });
    const written = JSON.parse(t.files.get(path)!);
    expect(written.complexity).toEqual({ enabled: false, fieldId: "PVTF_1" });
    expect(await t.call("set", "complexity.enabled", "false")).toBe(0);
    expect(t.out.at(-1)).toContain("unchanged");
    expect(await t.call("list", "--json")).toBe(0);
    expect(t.json().settings).toEqual([
      expect.objectContaining({ key: "complexity.enabled", value: false, source: "explicit" }),
      expect.objectContaining({ key: "complexity.fieldId", value: "PVTF_1", source: "explicit" }),
    ]);
    expect(await t.call("list")).toBe(0);
    expect(t.out.at(-1)).toContain("complexity.fieldId = PVTF_1 (explicit)");
  });

  it("refuses bad keys, values, scopes and syntax with recovery, as JSON or text", async () => {
    const t = setup();
    expect(await t.call("set", "complexity.enabled", "nope", "--json")).toBe(1);
    expect(t.json()).toMatchObject({
      kind: "config-error",
      code: "invalid-value",
      recovery: "github-triage config set complexity.enabled true|false",
    });
    expect(await t.call("get", "colour", "--json")).toBe(1);
    expect(t.json()).toMatchObject({ code: "unknown-key" });
    expect(t.json().recovery).toContain("complexity.enabled");
    expect(await t.call("list", "--global", "--json")).toBe(1);
    expect(t.json()).toMatchObject({ code: "unsupported-scope" });
    await expect(t.call("set", "complexity.enabled")).rejects.toThrow(
      /Usage: github-triage config/,
    );
    await expect(t.call("frobnicate")).rejects.toThrow(/Unknown config command/);
    expect(t.files.size).toBe(0);
  });

  it("reports filesystem failures as structured refusals but still propagates programming errors", async () => {
    const t = setup();
    const denied = (op: string) =>
      Object.assign(new Error(`${op} denied`), { code: "EACCES", path });
    t.fs.readText = async () => {
      throw denied("open");
    };
    expect(await t.call("list", "--json")).toBe(1);
    expect(t.json()).toMatchObject({ kind: "config-error", code: "filesystem" });
    expect(t.json().message).toContain("EACCES");
    await expect(t.call("get", "complexity.enabled")).rejects.toThrow(
      /EACCES[\s\S]*Nothing was changed/,
    );
    t.fs.readText = async () => null;
    t.fs.writeText = async () => {
      throw Object.assign(new Error("full"), { code: "ENOSPC" });
    };
    expect(await t.call("set", "complexity.enabled", "false", "--json")).toBe(1);
    expect(t.json()).toMatchObject({ code: "filesystem" });
    t.fs.writeText = async () => {
      throw new TypeError("bug");
    };
    await expect(t.call("set", "complexity.enabled", "false", "--json")).rejects.toThrow("bug");
  });

  it("refuses a repository that does not match the checkout and malformed files untouched", async () => {
    const t = setup("{oops");
    expect(
      await t.call("set", "complexity.enabled", "false", "--repo", "other/repo", "--json"),
    ).toBe(1);
    expect(t.json()).toMatchObject({ code: "repository-mismatch" });
    expect(await t.call("set", "complexity.enabled", "false", "--json")).toBe(1);
    expect(t.json()).toMatchObject({ code: "malformed" });
    expect(t.files.get(path)).toBe("{oops");
  });

  it("explains keys, defaults and valid values in text and JSON help", async () => {
    const t = setup();
    expect(await t.call("help")).toBe(0);
    expect(t.out[0]).toContain("complexity.enabled (boolean; default true; valid: true, false)");
    expect(await t.call("help", "complexity.fieldId", "--json")).toBe(0);
    expect(t.json()).toMatchObject({
      kind: "config-help",
      keys: [{ key: "complexity.fieldId", defaultValue: null }],
    });
    expect(await t.call("--help")).toBe(0);
    const top: string[] = [];
    await main(["--help", "--no-update-check"], async (x) => void top.push(x));
    expect(top.join("")).toContain("config get KEY | set KEY VALUE | list | help [KEY]");
  });
});

describe("estimate N records a size with provenance (#121)", () => {
  const root = "/repo";
  const path = join(root, CONFIG_PATH);
  const sha = "a".repeat(40);
  const mapped = '{"schemaVersion":1,"complexity":{"fieldId":"IF_c"}}\n';
  const field = {
    __typename: "IssueFieldSingleSelect",
    id: "IF_c",
    name: "Complexity",
    dataType: "SINGLE_SELECT",
    visibility: "ALL",
    options: ["XS", "S", "M", "L", "XL", "XXL"].map((name) => ({ id: `O_${name}`, name })),
  };
  type Answer = { data: unknown; errors: { type?: string; message?: string }[] };
  function harness(
    options: {
      config?: string | null;
      current?: string | null;
      comments?: string[];
      fieldNode?: unknown;
      queryErrors?: Answer["errors"];
      /** Change the remote value after the Nth query (simulates a concurrent writer). */
      concurrent?: { afterQuery: number; size?: string; comment?: string };
      /** Fail the Nth older-comments page query with GraphQL errors. */
      failPage?: number;
      failSet?: Answer;
      failComment?: boolean;
      /** Degrade the Nth query: GraphQL errors and/or issueFieldValues missing. */
      degrade?: { onQuery: number; errors?: Answer["errors"]; dropValues?: boolean };
    } = {},
  ) {
    const files = new Map<string, string>();
    const config = options.config === undefined ? mapped : options.config;
    if (config !== null) files.set(path, config);
    const fs: ConfigFileSystem = {
      readText: async (file) => files.get(file) ?? null,
      writeText: async () => {
        throw new Error("estimate must not write config");
      },
      rename: async () => undefined,
      remove: async () => undefined,
      makeDirectory: async () => undefined,
    };
    const git: GitRunner = async (args) =>
      args[0] === "rev-parse"
        ? args[1] === "HEAD"
          ? `${sha}\n`
          : `${root}\n`
        : "origin\thttps://github.com/owner/name.git (fetch)\n";
    const remote = { current: options.current ?? null, comments: [...(options.comments ?? [])] };
    const mutations: { query: string; vars: Record<string, string> }[] = [];
    let queries = 0;
    let pageQueries = 0;
    // Comment pages are served newest-last, 100 at a time; a cursor is the start index.
    const page = (end: number) => {
      const start = Math.max(0, end - 100);
      return {
        pageInfo: { hasPreviousPage: start > 0, startCursor: String(start) },
        nodes: remote.comments.slice(start, end).map((body) => ({ body })),
      };
    };
    const answer = (): Answer => ({
      data: {
        field: options.fieldNode === undefined ? field : options.fieldNode,
        repository: {
          issue: {
            id: "I_7",
            state: "OPEN",
            issueFieldValues: {
              nodes: remote.current
                ? [
                    {
                      __typename: "IssueFieldSingleSelectValue",
                      name: remote.current,
                      field: { id: "IF_c" },
                    },
                  ]
                : [],
            },
            comments: page(remote.comments.length),
          },
        },
      },
      errors: options.queryErrors ?? [],
    });
    const out: string[] = [];
    const call = (...args: string[]) =>
      main(["estimate", "7", ...args, "--no-update-check"], async (t) => void out.push(t), {
        collect: async () => {
          throw new Error("no GitHub");
        },
        currentRepository: async () => {
          throw new Error("no GitHub");
        },
        now: () => new Date("2026-11-13T12:00:00Z"),
        estimate: {
          fs,
          git,
          cwd: root,
          api: {
            query: async (query, vars) => {
              if (query.includes("$before")) {
                pageQueries += 1;
                if (options.failPage === pageQueries)
                  return { data: null, errors: [{ type: "INTERNAL", message: "timeout" }] };
                return {
                  data: { repository: { issue: { comments: page(Number(vars.before)) } } },
                  errors: [],
                };
              }
              queries += 1;
              const a = answer();
              const d = options.degrade;
              if (d && queries === d.onQuery) {
                if (d.errors) a.errors = d.errors;
                if (d.dropValues)
                  delete (a.data as { repository: { issue: Record<string, unknown> } }).repository
                    .issue.issueFieldValues;
              }
              const c = options.concurrent;
              if (c && queries === c.afterQuery) {
                if (c.size) remote.current = c.size;
                if (c.comment) remote.comments.push(c.comment);
              }
              return a;
            },
            mutate: async (query, vars) => {
              mutations.push({ query, vars });
              if (query.includes("setIssueFieldValue")) {
                if (options.failSet) return options.failSet;
                remote.current = vars.option!.replace("O_", "");
                return { data: { setIssueFieldValue: { issue: { id: "I_7" } } }, errors: [] };
              }
              if (options.failComment) throw new Error("network down");
              remote.comments.push(vars.body!);
              return {
                data: { addComment: { commentEdge: { node: { url: "https://c/1" } } } },
                errors: [],
              };
            },
          },
        },
      });
    return {
      remote,
      mutations,
      out,
      call,
      pageQueries: () => pageQueries,
      json: () => JSON.parse(out.at(-1)!),
    };
  }
  const base = ["--size", "M", "--rationale", "few modules; bounded tests", "--json"];

  it("records the native value and versioned provenance without inventing identity", async () => {
    const t = harness();
    expect(
      await t.call(
        ...base,
        "--assumption",
        "blocker #3 supplies the API; waiting excluded",
        "--reference",
        "#86",
      ),
    ).toBe(0);
    expect(t.json()).toMatchObject({
      schemaVersion: 1,
      kind: "complexity-estimate",
      status: "recorded",
      previous: null,
      valueWritten: true,
      provenanceWritten: true,
      provenance: {
        size: "M",
        estimator: null,
        revision: sha,
        guidanceVersion: complexityGuidance.guidanceVersion,
        assumptions: ["blocker #3 supplies the API; waiting excluded"],
        references: ["#86"],
      },
    });
    expect(t.remote.current).toBe("M");
    expect(t.mutations.map((m) => m.query.match(/(setIssueFieldValue|addComment)/)![1])).toEqual([
      "setIssueFieldValue",
      "addComment",
    ]);
    // Never touches labels, claims or dependencies.
    expect(t.mutations.some((m) => /label|claim|BlockedBy/i.test(m.query))).toBe(false);
    const stored = parseProvenance(t.remote.comments[0]!);
    expect(stored).toMatchObject({ size: "M", rationale: "few modules; bounded tests" });
  });
  it("records the estimator only when given", async () => {
    const t = harness();
    expect(await t.call(...base, "--agent", "kavya")).toBe(0);
    expect(t.json().provenance.estimator).toBe("kavya");
  });
  it("is idempotent: the same size and provenance write nothing", async () => {
    const t = harness();
    await t.call(...base);
    const writes = t.mutations.length;
    expect(await t.call(...base)).toBe(0);
    expect(t.json().status).toBe("unchanged");
    expect(t.mutations.length).toBe(writes);
  });
  it("preserves a different existing estimate unless --replace names it", async () => {
    const t = harness({ current: "S" });
    expect(await t.call(...base)).toBe(1);
    expect(t.json()).toMatchObject({ status: "refused:existing", code: "existing-estimate" });
    expect(t.json().recovery).toContain("--replace S");
    expect(t.mutations).toEqual([]);
    expect(await t.call(...base, "--replace", "S")).toBe(0);
    expect(t.json()).toMatchObject({
      status: "recorded",
      previous: "S",
      provenance: { previous: "S" },
    });
  });
  it("refuses a stale --replace", async () => {
    const t = harness({ current: "L" });
    expect(await t.call(...base, "--replace", "S")).toBe(1);
    expect(t.json()).toMatchObject({ status: "refused:stale", code: "stale" });
    expect(t.mutations).toEqual([]);
  });
  it("does not overwrite a concurrent estimate recorded after the first read", async () => {
    const t = harness({ concurrent: { afterQuery: 1, size: "XL" } });
    expect(await t.call(...base)).toBe(1);
    expect(t.json()).toMatchObject({ status: "refused:stale", code: "concurrent-change" });
    expect(t.remote.current).toBe("XL");
    expect(t.mutations).toEqual([]);
  });
  it("rereads before a provenance-only write and refuses a concurrent value change", async () => {
    // Value already M (needs provenance); another writer sets L after the first read.
    const t = harness({ current: "M", concurrent: { afterQuery: 1, size: "L" } });
    expect(await t.call(...base)).toBe(1);
    expect(t.json()).toMatchObject({ status: "refused:stale", code: "concurrent-change" });
    expect(t.json().recovery).toContain("Re-run");
    expect(t.mutations).toEqual([]);
    expect(t.remote.current).toBe("L");
  });
  it("refuses a provenance-only write when newer provenance appeared meanwhile", async () => {
    const other = harness();
    await other.call(...base, "--agent", "other");
    const t = harness({
      current: "M",
      concurrent: { afterQuery: 1, comment: other.remote.comments[0]! },
    });
    expect(await t.call(...base)).toBe(1);
    expect(t.json()).toMatchObject({ status: "refused:stale", code: "concurrent-change" });
    expect(t.mutations).toEqual([]);
  });
  it("pages back through older comments to find the newest provenance marker", async () => {
    const seed = harness();
    await seed.call(...base);
    const marker = seed.remote.comments[0]!;
    const filler = Array.from({ length: 250 }, (_, i) => `chatter ${i}`);
    const t = harness({ current: "M", comments: [marker, ...filler] });
    expect(await t.call(...base)).toBe(0);
    expect(t.json().status).toBe("unchanged");
    expect(t.mutations).toEqual([]);
    // Bounded: stops once found (2 older pages per read; unchanged needs no reread).
    expect(t.pageQueries()).toBe(2);
  });
  it("treats failed or unbounded comment paging as unknown provenance and writes nothing", async () => {
    const filler = Array.from({ length: 150 }, (_, i) => `chatter ${i}`);
    const failed = harness({ current: "M", comments: filler, failPage: 1 });
    expect(await failed.call(...base)).toBe(2);
    expect(failed.json()).toMatchObject({
      status: "failed:unknown",
      code: "provenance-unavailable",
    });
    expect(failed.mutations).toEqual([]);
    const huge = Array.from({ length: 100 * (MAX_COMMENT_PAGES + 2) }, (_, i) => `c ${i}`);
    const endless = harness({ current: "M", comments: huge });
    expect(await endless.call(...base)).toBe(2);
    expect(endless.json().code).toBe("provenance-unavailable");
    expect(endless.pageQueries()).toBe(MAX_COMMENT_PAGES);
    expect(endless.mutations).toEqual([]);
  });
  it("reports a partial write honestly and repairs only provenance on retry", async () => {
    const t = harness({ failComment: true });
    expect(await t.call(...base)).toBe(2);
    expect(t.json()).toMatchObject({
      status: "partial",
      valueWritten: true,
      provenanceWritten: false,
    });
    expect(t.remote.current).toBe("M");
    const retry = harness({ current: "M" });
    expect(await retry.call(...base)).toBe(0);
    expect(retry.json()).toMatchObject({ status: "recorded", valueWritten: false });
    expect(retry.mutations.map((m) => m.query.includes("addComment"))).toEqual([true]);
  });
  it("refuses an errored or incomplete value read instead of treating it as unset", async () => {
    for (const degrade of [
      { onQuery: 1, dropValues: true },
      { onQuery: 1, errors: [{ type: "INTERNAL", message: "partial" }] },
      { onQuery: 2, dropValues: true },
      { onQuery: 2, errors: [{ type: "INTERNAL", message: "partial" }], dropValues: true },
    ]) {
      const t = harness({ current: "S", degrade });
      // The reread (query 2) is only reached by an authorised replacement.
      const replace = degrade.onQuery === 2 ? ["--replace", "S"] : [];
      expect(await t.call(...base, ...replace)).toBe(2);
      expect(t.json()).toMatchObject({ status: "failed:unknown", code: "value-unavailable" });
      expect(t.json().recovery).toContain("Retry");
      expect(t.mutations).toEqual([]);
      expect(t.remote.current).toBe("S");
    }
  });
  it("retries --replace idempotently after a partial write, repairing only provenance", async () => {
    const t = harness({ current: "S", failComment: true });
    expect(await t.call(...base, "--replace", "S")).toBe(2);
    expect(t.json().status).toBe("partial");
    const retry = harness({ current: "M", comments: t.remote.comments });
    expect(await retry.call(...base, "--replace", "S")).toBe(0);
    expect(retry.json()).toMatchObject({
      status: "recorded",
      valueWritten: false,
      provenance: { previous: "S" },
    });
    expect(retry.mutations.map((m) => m.query.includes("addComment"))).toEqual([true]);
    const conflict = harness({ current: "L" });
    expect(await conflict.call(...base, "--replace", "S")).toBe(1);
    expect(conflict.json().code).toBe("stale");
  });
  it("records new provenance when only the estimator identity changes", async () => {
    const t = harness();
    await t.call(...base);
    const sets = () => t.mutations.filter((m) => m.query.includes("setIssueFieldValue")).length;
    expect(await t.call(...base, "--agent", "kavya")).toBe(0);
    expect(t.json()).toMatchObject({
      status: "recorded",
      valueWritten: false,
      provenance: { estimator: "kavya" },
    });
    expect(sets()).toBe(1);
    expect(parseProvenance(t.remote.comments.at(-1)!)?.estimator).toBe("kavya");
    expect(await t.call(...base, "--agent", "kavya")).toBe(0);
    expect(t.json().status).toBe("unchanged");
  });
  it("reports the stored provenance, not a new timestamp or revision, when unchanged", async () => {
    const t = harness();
    await t.call(...base);
    const stored = t.remote.comments.at(-1)!;
    const first = parseProvenance(stored)!;
    expect(first.revision).toBe(sha);
    const older = stored
      .replaceAll(first.recordedAt, "2026-01-01T00:00:00.000Z")
      .replaceAll(sha, "b".repeat(40));
    t.remote.comments[t.remote.comments.length - 1] = older;
    expect(await t.call(...base)).toBe(0);
    expect(t.json().status).toBe("unchanged");
    expect(t.json().provenance).toEqual(parseProvenance(older));
    expect(JSON.stringify(t.json().provenance)).not.toContain(sha);
  });
  it("reports API denial of the value write without claiming success", async () => {
    const t = harness({ failSet: { data: null, errors: [{ type: "FORBIDDEN", message: "no" }] } });
    expect(await t.call(...base)).toBe(1);
    expect(t.json()).toMatchObject({ status: "failed", code: "api-denied" });
    expect(t.json().message).toContain("FORBIDDEN");
    expect(t.remote.comments).toEqual([]);
  });
  it("gives opt-in and setup guidance when disabled or unmapped, without remote calls", async () => {
    const off = harness({ config: '{"schemaVersion":1,"complexity":{"enabled":false}}\n' });
    expect(await off.call(...base)).toBe(2);
    expect(off.json()).toMatchObject({
      status: "disabled",
      recovery: "Opt in with: github-triage config set complexity.enabled true",
    });
    const unset = harness({ config: null });
    expect(await unset.call(...base)).toBe(2);
    expect(unset.json()).toMatchObject({ status: "setup-required", code: "not-configured" });
    expect(unset.json().recovery).toContain("github-triage setup complexity");
    expect([...off.mutations, ...unset.mutations]).toEqual([]);
  });
  it("distinguishes a forbidden or incompatible field and never writes", async () => {
    const forbidden = harness({
      fieldNode: null,
      queryErrors: [{ type: "FORBIDDEN", message: "x" }],
    });
    expect(await forbidden.call(...base)).toBe(2);
    expect(forbidden.json()).toMatchObject({
      status: "setup-required:inaccessible",
      code: "field-forbidden",
    });
    const wrong = harness({ fieldNode: { ...field, options: field.options.slice(0, 3) } });
    expect(await wrong.call(...base)).toBe(2);
    expect(wrong.json()).toMatchObject({ status: "setup-required:incompatible" });
    expect([...forbidden.mutations, ...wrong.mutations]).toEqual([]);
  });
  it("keeps the provenance marker safe inside an HTML comment and ignores forgeries", () => {
    const p: EstimateProvenance = {
      schemaVersion: 1,
      kind: "complexity-estimate",
      fieldId: "IF_c",
      size: "S",
      previous: null,
      rationale: "ends --> early? <b>",
      assumptions: [],
      references: [],
      estimator: null,
      revision: null,
      guidanceVersion: 1,
      recordedAt: "2026-11-13T12:00:00.000Z",
    };
    const body = provenanceComment(p);
    expect(body.split("-->")[0]).toContain("recordedAt"); // the marker ends only at its own close
    expect(parseProvenance(body)).toEqual(p);
    expect(
      parseProvenance('<!-- github-triage:complexity-estimate v1 {"size":"HUGE"} -->'),
    ).toBeNull();
  });
});

describe("setup complexity (#119)", () => {
  const root = "/repo";
  const path = join(root, CONFIG_PATH);
  const sizes = ["XS", "S", "M", "L", "XL", "XXL"].map((name) => ({ name }));
  const good = {
    __typename: "IssueFieldSingleSelect",
    id: "IF_good",
    name: "Complexity",
    dataType: "SINGLE_SELECT",
    visibility: "ALL",
    options: sizes,
  };
  const wrongOptions = { ...good, id: "IF_opts", name: "Size", options: sizes.slice(0, 3) };
  const text = {
    __typename: "IssueFieldText",
    id: "IF_text",
    name: "Notes",
    dataType: "TEXT",
    visibility: "ALL",
  };
  type Answer = { data: unknown; errors: { type?: string; message?: string }[] };
  const owner = (fields: unknown, extra: Record<string, unknown> = {}): Answer => ({
    data: {
      viewer: { login: "owner" },
      repository: {
        owner: { __typename: "User", id: "U_1", login: "owner", issueFields: fields, ...extra },
      },
    },
    errors: [],
  });
  const list = (...nodes: unknown[]) => ({ pageInfo: { hasNextPage: false }, nodes });
  function setup(
    answer: Answer,
    options: {
      initial?: string;
      prompt?: string[];
      failWrite?: boolean;
      created?: Answer;
      onQuery?: (files: Map<string, string>) => void;
    } = {},
  ) {
    const files = new Map<string, string>(
      options.initial === undefined ? [] : [[path, options.initial]],
    );
    const fs: ConfigFileSystem = {
      readText: async (file) => files.get(file) ?? null,
      writeText: async (file, value) => {
        if (options.failWrite) throw new ConfigError("filesystem", "disk full", "free space");
        files.set(file, value);
      },
      rename: async (from, to) => {
        files.set(to, files.get(from)!);
        files.delete(from);
      },
      remove: async (file) => void files.delete(file),
      makeDirectory: async () => undefined,
    };
    const git: GitRunner = async (args) =>
      args[0] === "rev-parse" ? `${root}\n` : "origin\thttps://github.com/owner/name.git (fetch)\n";
    const mutations: unknown[] = [];
    const queries: unknown[] = [];
    const prompts: string[] = [];
    const replies = [...(options.prompt ?? [])];
    const out: string[] = [];
    const call = (...args: string[]) =>
      main(["setup", "complexity", ...args, "--no-update-check"], async (t) => void out.push(t), {
        collect: async () => {
          throw new Error("no GitHub");
        },
        currentRepository: async () => {
          throw new Error("no GitHub");
        },
        setup: {
          fs,
          git,
          cwd: root,
          api: {
            query: async (_q, v) => (queries.push(v), options.onQuery?.(files), answer),
            mutate: async (_q, v) => (
              mutations.push(v),
              options.created ?? { data: null, errors: [] }
            ),
          },
          prompt: options.prompt ? async (q) => (prompts.push(q), replies.shift() ?? "") : null,
        },
      });
    return { files, out, call, mutations, queries, prompts, json: () => JSON.parse(out.at(-1)!) };
  }

  it("skips all remote calls when complexity is explicitly disabled", async () => {
    const t = setup(owner(list(good)), {
      initial: '{"schemaVersion":1,"complexity":{"enabled":false,"fieldId":"IF_x"}}\n',
    });
    expect(await t.call("--json")).toBe(0);
    expect(t.json()).toMatchObject({ status: "disabled", mappedFieldId: "IF_x" });
    expect(t.queries).toEqual([]);
  });
  it("reports discovered fields and returns setup-required unattended without hanging", async () => {
    const t = setup(owner(list(good, wrongOptions, text)));
    expect(await t.call()).toBe(2);
    const out = t.out[0]!;
    expect(out).toContain("compatible   IF_good");
    expect(out).toMatch(/incompatible IF_opts .*expected XS, S, M, L, XL, XXL/);
    expect(out).toMatch(/IF_text .*type TEXT/);
    expect(out).toContain("visible to all of owner's repositories");
    expect(out).toContain("--select IF_good");
    expect(t.files.size).toBe(0);
    expect(t.mutations).toEqual([]);
  });
  it("saves an explicitly selected compatible field and is idempotent on retry", async () => {
    const t = setup(owner(list(good)));
    expect(await t.call("--select", "IF_good", "--json")).toBe(0);
    expect(t.json()).toMatchObject({ status: "saved", changed: true, mappedFieldId: "IF_good" });
    expect(JSON.parse(t.files.get(path)!)).toEqual({
      schemaVersion: 1,
      complexity: { fieldId: "IF_good" },
    });
    expect(await t.call("--select", "IF_good", "--json")).toBe(0);
    expect(t.json()).toMatchObject({ changed: false });
    expect(await t.call()).toBe(0);
    expect(t.out.at(-1)).toContain("Configured");
  });
  it("compares options one by one, not as a comma-joined string", async () => {
    const merged = [{ name: "XS,S" }, ...sizes.slice(2)];
    const field = classifyField({ ...good, options: merged })!;
    expect(field.compatible).toBe(false);
    expect(classifyField(good)!.compatible).toBe(true);
  });
  it("refuses with a conflict when the mapping changes while setup is running", async () => {
    const elsewhere = '{"schemaVersion":1,"complexity":{"fieldId":"IF_other"}}\n';
    const t = setup(owner(list(good)), {
      onQuery: (files) => void files.set(path, elsewhere),
    });
    expect(await t.call("--select", "IF_good", "--json")).toBe(1);
    expect(t.json()).toMatchObject({
      code: "conflict",
      recovery: expect.stringContaining("setup complexity"),
    });
    expect(t.files.get(path)).toBe(elsewhere);
  });
  it("refuses incompatible or unknown selections without writing", async () => {
    const t = setup(owner(list(good, wrongOptions)));
    expect(await t.call("--select", "IF_opts", "--json")).toBe(1);
    expect(t.json()).toMatchObject({ kind: "complexity-setup-error", code: "incompatible" });
    await expect(t.call("--select", "IF_nope")).rejects.toThrow("not among");
    expect(t.files.size).toBe(0);
  });
  it("distinguishes forbidden and unsupported APIs and offers no fallback", async () => {
    const forbidden = setup({ ...owner(null), errors: [{ type: "FORBIDDEN", message: "no" }] });
    expect(await forbidden.call("--create", "--json")).toBe(2);
    expect(forbidden.json()).toMatchObject({ status: "setup-required:inaccessible" });
    expect(forbidden.mutations).toEqual([]);
    const unsupported = setup({
      data: null,
      errors: [{ message: "Field 'issueFields' doesn't exist on type 'User'" }],
    });
    expect(await unsupported.call("--json")).toBe(2);
    expect(unsupported.json()).toMatchObject({ status: "setup-required:unsupported" });
  });
  it("creates only on explicit --create, after confirmation on a terminal", async () => {
    const created = {
      data: { createIssueField: { issueField: { ...good, id: "IF_new" } } },
      errors: [],
    };
    const declined = setup(owner(list(text)), { prompt: ["n"], created });
    expect(await declined.call("--create")).toBe(2);
    expect(declined.prompts[0]).toContain("visible to all of owner's repositories");
    expect(declined.mutations).toEqual([]);
    const menu = setup(owner(list(text)), { prompt: ["c", "y"], created });
    expect(await menu.call()).toBe(0);
    expect(menu.mutations).toHaveLength(1);
    expect(menu.mutations[0]).toMatchObject({ ownerId: "U_1", name: "Complexity" });
    expect(JSON.parse(menu.files.get(path)!).complexity.fieldId).toBe("IF_new");
    const unattended = setup(owner(list(text)), { created });
    expect(await unattended.call("--create", "--json")).toBe(0);
    expect(unattended.json()).toMatchObject({ status: "created", mappedFieldId: "IF_new" });
  });
  it("refuses creation without permission, with partial lists or when a field already exists", async () => {
    const org = setup({
      data: {
        viewer: { login: "me" },
        repository: {
          owner: {
            __typename: "Organization",
            id: "O_1",
            login: "org",
            viewerCanAdminister: false,
            issueFields: list(),
          },
        },
      },
      errors: [],
    });
    expect(await org.call("--create", "--json")).toBe(1);
    expect(org.json()).toMatchObject({ code: "not-permitted" });
    const partial = setup(owner({ pageInfo: { hasNextPage: true }, nodes: [] }));
    expect(await partial.call("--create", "--json")).toBe(1);
    expect(partial.json()).toMatchObject({ code: "incomplete-discovery" });
    const exists = setup(owner(list(good)));
    expect(await exists.call("--create", "--json")).toBe(1);
    expect(exists.json()).toMatchObject({
      code: "exists",
      recovery: "github-triage setup complexity --select IF_good",
    });
    for (const t of [org, partial, exists]) expect(t.mutations).toEqual([]);
  });
  it("reports the created ID and recovery when the local save fails", async () => {
    const created = {
      data: { createIssueField: { issueField: { ...good, id: "IF_new" } } },
      errors: [],
    };
    const t = setup(owner(list()), { failWrite: true, created });
    expect(await t.call("--create", "--json")).toBe(2);
    expect(t.json()).toMatchObject({
      status: "created-not-saved",
      created: { id: "IF_new" },
      recovery: "github-triage setup complexity --select IF_new",
    });
  });
  it("flags a mapped field that is missing and verifies the repository target", async () => {
    const t = setup(owner(list(good)), {
      initial: '{"schemaVersion":1,"complexity":{"fieldId":"IF_gone"}}\n',
    });
    expect(await t.call()).toBe(2);
    expect(t.out[0]).toContain("IF_gone: missing");
    await expect(t.call("--repo", "other/repo")).rejects.toThrow("is not other/repo");
    expect(
      await (async () => {
        let s = "";
        await main(["setup", "--help"], async (x) => void (s = x));
        return s;
      })(),
    ).toContain("--create");
  });
});

describe("Ticket Doctor: complexity configuration (#120)", () => {
  const root = "/repo";
  const path = join(root, CONFIG_PATH);
  const sizes = ["XS", "S", "M", "L", "XL", "XXL"].map((name) => ({ name }));
  const good = {
    __typename: "IssueFieldSingleSelect",
    id: "IF_good",
    name: "Complexity",
    dataType: "SINGLE_SELECT",
    visibility: "ALL",
    options: sizes,
  };
  const bad = { ...good, id: "IF_bad", name: "Size", options: sizes.slice(0, 2) };
  const owner = (fields: unknown, errors: { type?: string; message?: string }[] = []) => ({
    data: {
      viewer: { login: "owner" },
      repository: {
        owner: { __typename: "User", id: "U_1", login: "owner", issueFields: fields },
      },
    },
    errors,
  });
  const list = (...nodes: unknown[]) => ({ pageInfo: { hasNextPage: false }, nodes });
  function run(
    config: string | null,
    answer: unknown,
    options: { offline?: boolean; checkout?: boolean; readError?: Error } = {},
  ) {
    const writes: string[] = [];
    const queries: unknown[] = [];
    const fs: ConfigFileSystem = {
      readText: async (file) => {
        if (options.readError) throw options.readError;
        return file === path ? config : null;
      },
      writeText: async (file) => void writes.push(file),
      rename: async (file) => void writes.push(file),
      remove: async (file) => void writes.push(file),
      makeDirectory: async (file) => void writes.push(file),
    };
    const git: GitRunner = async (args) => {
      if (options.checkout === false) throw new Error("not a repository");
      return args[0] === "rev-parse"
        ? `${root}\n`
        : "origin\thttps://github.com/owner/name.git (fetch)\n";
    };
    const mutations: unknown[] = [];
    const api = {
      query: async (_q: string, v: Record<string, string>) => {
        queries.push(v);
        if (answer instanceof Error) throw answer;
        return answer as { data: unknown; errors: [] };
      },
      mutate: async (_q: string, v: Record<string, string>) => {
        mutations.push(v);
        return { data: null, errors: [] };
      },
    };
    return diagnoseComplexityConfig(
      "owner/name",
      { offline: options.offline },
      { fs, git, cwd: root, api },
    ).then((r) => ({ r, writes, queries, mutations }));
  }
  const mapped = (id: string) => `{"schemaVersion":1,"complexity":{"fieldId":"${id}"}}\n`;

  it("suppresses findings and makes no remote call when disabled", async () => {
    const { r, queries } = await run(
      '{"schemaVersion":1,"complexity":{"enabled":false,"fieldId":"IF_gone"}}\n',
      owner(list()),
    );
    expect(r).toMatchObject({ status: "disabled", findings: [], fieldId: "IF_gone" });
    expect(queries).toEqual([]);
  });
  it("reports an unmapped field with the exact setup command", async () => {
    const { r } = await run(null, owner(list(good, bad)));
    expect(r.status).toBe("unconfigured");
    expect(r.findings[0]).toMatchObject({
      rule: "complexity-field-unmapped",
      next: [
        "github-triage setup complexity --select IF_good",
        "github-triage config set complexity.enabled false",
      ],
    });
  });
  it("accepts a compatible mapping with no findings", async () => {
    const { r } = await run(mapped("IF_good"), owner(list(good)));
    expect(r).toMatchObject({ status: "configured-compatible", verified: true, findings: [] });
  });
  it("distinguishes incompatible from missing", async () => {
    const incompatible = (await run(mapped("IF_bad"), owner(list(good, bad)))).r;
    expect(incompatible.status).toBe("incompatible");
    expect(incompatible.findings[0]!.detail).toContain("expected XS, S, M, L, XL, XXL");
    const missing = (await run(mapped("IF_gone"), owner(list(good)))).r;
    expect(missing.status).toBe("missing");
    expect(missing.findings[0]!.next[0]).toBe("github-triage setup complexity --select IF_good");
  });
  it("reports FORBIDDEN as inaccessible, not absent", async () => {
    const { r } = await run(mapped("IF_good"), owner(null, [{ type: "FORBIDDEN", message: "no" }]));
    expect(r.status).toBe("inaccessible");
    expect(r.findings[0]).toMatchObject({ certainty: "unknown" });
    expect(r.findings[0]!.detail).toContain("Absent is not the same as unavailable");
  });
  it("reports an API without issue fields as unsupported", async () => {
    const { r } = await run(null, {
      data: null,
      errors: [{ message: "Field 'issueFields' doesn't exist on type 'User'" }],
    });
    expect(r.status).toBe("unsupported");
  });
  it("treats missing evidence as unknown, never healthy", async () => {
    const offline = (await run(mapped("IF_good"), owner(list(good)), { offline: true })).r;
    expect(offline).toMatchObject({ status: "unknown", verified: false });
    expect(offline.findings[0]!.rule).toBe("complexity-field-unverified");
    const failed = (await run(mapped("IF_good"), new Error("network"))).r;
    expect(failed.status).toBe("unknown");
    const partial = (
      await run(mapped("IF_x"), owner({ pageInfo: { hasNextPage: true }, nodes: [good] }))
    ).r;
    expect(partial.status).toBe("unknown");
    const noCheckout = (await run(null, owner(list(good)), { checkout: false })).r;
    expect(noCheckout).toMatchObject({
      status: "unknown",
      findings: [{ rule: "config-unavailable" }],
    });
  });
  it("never recommends --create when setup would refuse it", async () => {
    const taken = { ...bad, id: "IF_taken", name: "complexity" };
    const unmapped = (await run(null, owner(list(taken)))).r;
    expect(unmapped.findings[0]!.next[0]).toMatch(/Choose or fix a field in GitHub yourself/);
    expect(unmapped.findings[0]!.next.join(" ")).not.toContain("--create");
    const incompatible = (await run(mapped("IF_taken"), owner(list(taken)))).r;
    expect(incompatible.findings[0]!.next.join(" ")).not.toContain("--create");
    const free = (await run(null, owner(list(bad)))).r;
    expect(free.findings[0]!.next[0]).toBe("github-triage setup complexity --create");
  });
  it("reports an unreadable configuration file as unknown instead of failing the report", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES", path });
    const { r, queries } = await run(mapped("IF_good"), owner(list(good)), { readError: denied });
    expect(r).toMatchObject({
      status: "unknown",
      findings: [{ rule: "config-unavailable", certainty: "unknown" }],
    });
    expect(r.findings[0]!.detail).toContain("EACCES");
    expect(queries).toEqual([]);
    await expect(
      run(mapped("IF_good"), owner(list(good)), { readError: new TypeError("bug") }),
    ).rejects.toThrow("bug");
  });
  it("reports malformed configuration with recovery and never writes", async () => {
    const { r, writes, mutations } = await run("{not json", owner(list(good)));
    expect(r.findings[0]).toMatchObject({ rule: "config-invalid", certainty: "definite" });
    expect(writes).toEqual([]);
    expect(mutations).toEqual([]);
  });
  it("renders the configuration section in Ticket Doctor text", async () => {
    const { r } = await run(mapped("IF_gone"), owner(list(good)));
    const lines = complexityConfigText(r).join("\n");
    expect(lines).toContain("complexity missing");
    expect(lines).toContain("next: github-triage setup complexity --select IF_good");
  });
});

describe("estimation queue and briefing visibility (#122)", () => {
  const root = "/repo";
  const path = join(root, CONFIG_PATH);
  const field = "IF_size";
  const config = (text: string | null): ConfigFileSystem => ({
    readText: async (file) => (file === path ? text : null),
    writeText: async () => undefined,
    rename: async () => undefined,
    remove: async () => undefined,
    makeDirectory: async () => undefined,
  });
  const git: GitRunner = async (args) =>
    args[0] === "rev-parse" ? `${root}\n` : `origin\thttps://github.com/${repo}.git (fetch)\n`;
  const mapped = `{"schemaVersion":1,"complexity":{"fieldId":"${field}"}}\n`;
  const valuesAnswer = (values: Record<number, string | null>) => ({
    data: {
      repository: {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: Object.entries(values).map(([number, name]) => ({
            number: Number(number),
            issueFieldValues: {
              nodes: name
                ? [{ __typename: "IssueFieldSingleSelectValue", name, field: { id: field } }]
                : [],
            },
          })),
        },
      },
    },
    errors: [],
  });
  const sizeOptions = ["XS", "S", "M", "L", "XL", "XXL"].map((name) => ({ name }));
  const sizeField = {
    __typename: "IssueFieldSingleSelect",
    id: field,
    name: "Complexity",
    dataType: "SINGLE_SELECT",
    visibility: "ALL",
    options: sizeOptions,
  };
  /** Owner issue-field discovery answer (Ticket Doctor's verification query). */
  const discoveryOf = (
    fields: unknown[] | null,
    errors: { type?: string; message?: string }[] = [],
  ) => ({
    data: {
      viewer: { login: "owner" },
      repository: {
        owner: {
          __typename: "User",
          id: "U_1",
          login: "owner",
          issueFields: fields ? { pageInfo: { hasNextPage: false }, nodes: fields } : null,
        },
      },
    },
    errors,
  });
  const apiOf = (answer: unknown, discovery: unknown = discoveryOf([sizeField])) => {
    /** Native value queries only; field verification is recorded separately. */
    const calls: unknown[] = [];
    const verifications: unknown[] = [];
    return {
      calls,
      verifications,
      api: {
        query: async (q: string, v: Record<string, string>) => {
          if (q.includes("issueFields(")) {
            verifications.push(v);
            return discovery as { data: unknown; errors: { type?: string; message?: string }[] };
          }
          calls.push(v);
          if (answer instanceof Error) throw answer;
          return answer as { data: unknown; errors: { type?: string; message?: string }[] };
        },
        mutate: async () => {
          throw new Error("briefing must never mutate");
        },
      },
    };
  };
  const marker = (size: "M" | "S", recordedAt = time, guidanceVersion = 1) =>
    provenanceComment({
      schemaVersion: 1,
      kind: "complexity-estimate",
      fieldId: field,
      size,
      previous: null,
      rationale: "contained capability across modules",
      assumptions: ["blocker #9 supplies the API; waiting excluded"],
      references: [],
      estimator: "ana",
      revision: null,
      guidanceVersion,
      recordedAt,
    });
  const withComment = (item: Issue, body: string): Issue => ({
    ...item,
    comments: page([{ body, url: `${item.url}#c`, author: null, createdAt: time }]),
  });
  async function brief(
    configText: string | null,
    answer: unknown,
    issues: Issue[],
    args: string[] = [],
    discovery?: unknown,
  ) {
    const { api, calls } = apiOf(answer, discovery);
    let out = "";
    const code = await main(["--json", ...args], async (t) => void (out = t), {
      collect: async () => snapshot(issues, []),
      currentRepository: async () => repo,
      now: () => new Date(time),
      estimation: { fs: config(configText), git, cwd: root, api },
    });
    return { code, report: JSON.parse(out), calls };
  }
  const blocked = (): Issue => ({
    ...issue(2),
    issueDependenciesSummary: { blockedBy: 1, totalBlockedBy: 1, blocking: 0, totalBlocking: 0 },
  });

  it("queues unestimated blocked tickets while they stay ineligible for implementation", async () => {
    const { code, report, calls } = await brief(mapped, valuesAnswer({ 1: "M", 2: null }), [
      withComment(issue(1), marker("M")),
      blocked(),
    ]);
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(report.schemaVersion).toBe(2);
    expect(report.estimation).toMatchObject({ status: "available", requested: false });
    expect(report.estimation.queue.items.map((e: { number: number }) => e.number)).toEqual([2]);
    expect(report.estimation.queue.items[0]).toMatchObject({
      state: "unestimated",
      implementation: "ineligible",
    });
    const one = report.subjects.find((s: { number: number }) => s.number === 1);
    expect(one.complexity).toMatchObject({
      size: "M",
      state: "estimated",
      recorded: { rationale: "contained capability across modules", estimator: "ana" },
    });
    // Eligible pickup still comes first; estimation is not offered automatically.
    expect(report.actions.items[0]).toBe(issue(1).url);
    expect(report.estimation.offered).toBe(false);
  });
  it("flags stale estimates: value drift, older guidance or later description edits", async () => {
    const edited = { ...withComment(issue(1), marker("M")), lastEditedAt: "2026-11-13T00:00:00Z" };
    const { report } = await brief(mapped, valuesAnswer({ 1: "M", 2: "L", 3: "S" }), [
      edited,
      withComment(issue(2), marker("M")),
      withComment(issue(3), marker("S", time, 0)),
    ]);
    const states = report.estimation.queue.items.map(
      (e: { number: number; state: string; reasons: string[] }) => [
        e.number,
        e.state,
        e.reasons.join(),
      ],
    );
    expect(states).toEqual([
      [1, "stale", expect.stringContaining("description edited")],
      [2, "stale", expect.stringContaining("differs from recorded estimate M")],
      [3, "stale", expect.stringContaining("guidance version 0 < 1")],
    ]);
  });
  it("treats unreadable native values (FORBIDDEN) as unknown, never unestimated, and still succeeds", async () => {
    const forbidden = { data: null, errors: [{ type: "FORBIDDEN", message: "not enabled" }] };
    const { code, report } = await brief(mapped, forbidden, [
      withComment(issue(1), marker("M")),
      blocked(),
    ]);
    expect(code).toBe(0);
    expect(report.estimation).toMatchObject({ status: "unknown", queue: null, unknown: 2 });
    expect(report.estimation.detail).toContain("FORBIDDEN");
    const one = report.subjects.find((s: { number: number }) => s.number === 1);
    expect(one.complexity).toMatchObject({ state: "unknown", size: null, recorded: { size: "M" } });
    const thrown = await brief(mapped, new Error("network down"), [issue(1)]);
    expect(thrown.code).toBe(0);
    expect(thrown.report.estimation.status).toBe("unknown");
  });
  it("keeps the queue unavailable when the mapped field is deleted, incompatible or inaccessible", async () => {
    const issues = [issue(1), blocked()];
    // The values query succeeds with no matching values: without verification every
    // issue would wrongly be queued as unestimated.
    const empty = valuesAnswer({ 1: null, 2: null });
    const other = { ...sizeField, id: "IF_other" };
    const deleted = await brief(mapped, empty, issues, [], discoveryOf([other]));
    expect(deleted.report.estimation).toMatchObject({ status: "missing", queue: null, unknown: 2 });
    expect(deleted.report.estimation.findings[0]).toMatchObject({
      rule: "complexity-field-missing",
      next: [
        "github-triage setup complexity --select IF_other",
        "github-triage config set complexity.enabled false",
      ],
    });
    const wrong = { ...sizeField, options: sizeOptions.slice(0, 3) };
    const incompatible = await brief(mapped, empty, issues, [], discoveryOf([wrong]));
    expect(incompatible.report.estimation).toMatchObject({ status: "incompatible", queue: null });
    expect(incompatible.report.estimation.findings[0].rule).toBe("complexity-field-incompatible");
    const forbidden = discoveryOf(null, [{ type: "FORBIDDEN", message: "no" }]);
    const inaccessible = await brief(mapped, empty, issues, [], forbidden);
    expect(inaccessible.report.estimation).toMatchObject({ status: "inaccessible", queue: null });
    expect(inaccessible.report.estimation.findings[0]).toMatchObject({
      rule: "complexity-field-api-inaccessible",
      next: ["github-triage setup complexity", "github-triage config set complexity.enabled false"],
    });
    for (const r of [deleted, incompatible, inaccessible]) {
      expect(r.code).toBe(0);
      expect(r.calls).toEqual([]);
      const subject = r.report.subjects.find((s: { number: number }) => s.number === 2);
      expect(subject.complexity.state).toBe("unknown");
    }
  });
  it("suppresses the queue when disabled and reports a missing mapping as a finding", async () => {
    const disabled = await brief(
      '{"schemaVersion":1,"complexity":{"enabled":false,"fieldId":"x"}}',
      valuesAnswer({}),
      [issue(1)],
    );
    expect(disabled.calls).toEqual([]);
    expect(disabled.report.estimation).toMatchObject({ status: "disabled", queue: null });
    const unmapped = await brief(null, valuesAnswer({}), [issue(1)]);
    expect(unmapped.calls).toEqual([]);
    expect(unmapped.report.estimation).toMatchObject({ status: "setup-required", queue: null });
    expect(unmapped.report.estimation.findings[0]).toMatchObject({
      rule: "complexity-field-unmapped",
      next: ["github-triage setup complexity", "github-triage config set complexity.enabled false"],
    });
  });
  it("offers estimation only without higher-priority work, or first on --estimate", async () => {
    const idle = await brief(mapped, valuesAnswer({ 2: null }), [blocked()]);
    expect(idle.report.estimation.offered).toBe(true);
    const { api } = apiOf(valuesAnswer({ 1: null, 2: null }));
    let text = "";
    await main(["--estimate"], async (t) => void (text = t), {
      collect: async () => snapshot([issue(1), blocked()], []),
      currentRepository: async () => repo,
      now: () => new Date(time),
      estimation: { fs: config(mapped), git, cwd: root, api },
    });
    expect(text.indexOf("ESTIMATION (requested)")).toBeGreaterThan(0);
    expect(text.indexOf("ESTIMATION (requested)")).toBeLessThan(text.indexOf("NEXT STEPS"));
    expect(text).toContain("unestimated [unestimated]; implementation ineligible");
    expect(text).toContain("acquires no claim");
    let full = "";
    await main(["--estimate", "--full"], async (t) => void (full = t), {
      collect: async () => snapshot([issue(1), blocked()], []),
      currentRepository: async () => repo,
      now: () => new Date(time),
      estimation: { fs: config(mapped), git, cwd: root, api },
    });
    expect(full.indexOf("ESTIMATION (requested)")).toBeGreaterThan(0);
    expect(full.indexOf("ESTIMATION (requested)")).toBeLessThan(full.indexOf("NEXT ACTIONS"));
    let plain = "";
    await main([], async (t) => void (plain = t), {
      collect: async () => snapshot([issue(1), blocked()], []),
      currentRepository: async () => repo,
      now: () => new Date(time),
      estimation: { fs: config(mapped), git, cwd: root, api },
    });
    expect(plain.indexOf("ESTIMATION (optional")).toBeGreaterThan(plain.indexOf("NEXT STEPS"));
    expect(plain).toContain("#1 Ticket 1  (unestimated)");
  });
  it("reports offline briefings as unknown without querying, and keeps --full in sync", async () => {
    const { api, calls } = apiOf(valuesAnswer({ 1: null }));
    const dir = await mkdtemp(join(tmpdir(), "triage-estimation-"));
    try {
      const cache = join(dir, "cache.json");
      await atomicJson(cache, snapshot([issue(1)], []));
      let out = "";
      await main(["--offline", "--cache", cache, "--full", "--json"], async (t) => void (out = t), {
        collect: async () => {
          throw new Error("offline only");
        },
        currentRepository: async () => repo,
        estimation: { fs: config(mapped), git, cwd: root, api },
      });
      expect(calls).toEqual([]);
      expect(JSON.parse(out).estimation).toMatchObject({ status: "unknown", queue: null });
      expect(JSON.parse(out).schemaVersion).toBe(1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("read-only MCP adapter (#25)", async () => {
  const { Client } = await import("@modelcontextprotocol/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/server");
  const { createServer, envelope, mcpArguments, redactLocalText, redactPaths } =
    await import("./mcp.js");
  const { IssueUnavailable } = await import("./github.js");
  type Runtime = import("./mcp.js").McpRuntime;
  type Options = import("./mcp.js").McpOptions;

  const fake = (overrides: Partial<Runtime> = {}): Runtime & { seen: string[] } => {
    const seen: string[] = [];
    return {
      seen,
      currentRepository: async () => repo,
      collect: async (repository: string, options?: { issue?: number; since?: string }) => {
        seen.push(`${repository}#${options?.issue ?? "-"}@${options?.since ?? "-"}`);
        return { ...snapshot(), repository };
      },
      dependencyReport: (r: string, n: number, o?: { tree?: boolean }) =>
        dependencyReport(r, n, o, graphQuery({ edges: [[1, 2]] }).query, clock),
      // A fixed clock keeps freshness ages identical between the MCP and CLI reads.
      now: clock,
      ...overrides,
    };
  };
  const connect = async (runtime: Runtime, options: Options = {}) => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer(options, runtime).connect(serverSide);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(clientSide);
    return client;
  };
  const structured = (result: { structuredContent?: unknown }) =>
    envelope.parse(result.structuredContent);
  const text = (result: { content?: unknown }): string => {
    const first: unknown = Array.isArray(result.content) ? result.content[0] : undefined;
    return typeof first === "object" && first !== null && "text" in first ? String(first.text) : "";
  };

  it("lists exactly three read-only tools with strict inputs", async () => {
    const client = await connect(fake());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "triage_briefing",
      "triage_dependencies",
      "triage_issue",
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.outputSchema).toBeDefined();
    }
    await client.close();
  });

  it("returns the same versioned JSON as the CLI for briefing, issue and dependencies", async () => {
    const runtime = fake();
    const client = await connect(runtime, { repo });
    const cli = async (args: string[]) => {
      let out = "";
      await main([...args, "--json", "--no-update-check"], async (t) => void (out = t), runtime);
      return JSON.parse(out);
    };
    const brief = structured(await client.callTool({ name: "triage_briefing", arguments: {} }));
    expect(brief).toMatchObject({
      schemaVersion: 1,
      kind: "briefing",
      status: "complete",
      selection: { repository: repo, agent: null, identitySource: "unresolved" },
      error: null,
    });
    const { checkpoint: _, ...cliBrief } = await cli(["--repo", repo]);
    // Identical except that local paths in diagnostics are redacted for the MCP client.
    expect(brief.result).toEqual(redactPaths(cliBrief, [process.cwd()]));
    const intake = structured(
      await client.callTool({ name: "triage_issue", arguments: { number: 1, agent: "ana" } }),
    );
    const { checkpoint: __, ...cliIssue } = await cli([
      "--repo",
      repo,
      "--issue",
      "1",
      "--agent",
      "ana",
    ]);
    expect(intake).toMatchObject({
      kind: "issue",
      selection: { agent: "ana", identitySource: "tool" },
    });
    expect(intake.result).toEqual(redactPaths(cliIssue, [process.cwd()]));
    const deps = structured(
      await client.callTool({ name: "triage_dependencies", arguments: { number: 1, tree: true } }),
    );
    expect(deps.result).toEqual(await cli(["deps", "1", "--tree", "--repo", repo]));
    await client.close();
  });

  it("bounds triage_issue text to maxChars while structuredContent keeps the full intake", async () => {
    const long = "x".repeat(4000);
    const comments = Array.from({ length: 30 }, (_, i) => ({
      author: { login: `user${i}` },
      body: `comment ${i} ${long}`,
      createdAt: time,
      url: `${issue().url}#issuecomment-${i}`,
    }));
    const big = { ...issue(1), body: `body ${long}`, comments: page(comments) } as unknown as Issue;
    const runtime = fake({
      collect: async (repository: string) => ({ ...snapshot([big]), repository }),
    });
    const client = await connect(runtime, { repo });
    const result = await client.callTool({
      name: "triage_issue",
      arguments: { number: 1, maxChars: 2000 },
    });
    const body = text(result);
    expect(body.length).toBeLessThanOrEqual(2000);
    expect(body).toContain("omitted from text; it is in structuredContent.result.detail");
    expect(JSON.stringify(structured(result).result)).toContain(`comment 29 ${long}`);
    await client.close();
  });

  it("rejects unknown properties and out-of-range values before collection", async () => {
    const runtime = fake();
    const client = await connect(runtime);
    for (const [name, args] of [
      ["triage_briefing", { path: "/etc" }],
      ["triage_briefing", { limit: 0 }],
      ["triage_briefing", { maxChars: 50 }],
      ["triage_briefing", { since: "2026-11-12" }],
      ["triage_issue", { number: -1 }],
      ["triage_issue", {}],
      ["triage_dependencies", { number: 1, repo: "not a repo" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args }).catch((error) => ({
        isError: true,
        thrown: error,
      }));
      expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
    }
    expect(runtime.seen).toEqual([]);
    await client.close();
  });

  it("keeps per-call selection: tool repo/agent win and concurrent calls do not interfere", async () => {
    const runtime = fake();
    const client = await connect(runtime, { repo: "start/default", agent: "boot" });
    const [a, b, c] = await Promise.all([
      client.callTool({ name: "triage_briefing", arguments: { repo: "o/a" } }),
      client.callTool({ name: "triage_briefing", arguments: { repo: "o/b", agent: "zed" } }),
      client.callTool({ name: "triage_briefing", arguments: {} }),
    ]);
    expect(structured(a).selection).toEqual({
      repository: "o/a",
      agent: "boot",
      identitySource: "startup",
    });
    expect(structured(b).selection).toEqual({
      repository: "o/b",
      agent: "zed",
      identitySource: "tool",
    });
    expect(structured(c).selection.repository).toBe("start/default");
    expect(runtime.seen.sort()).toEqual(["o/a#-@-", "o/b#-@-", "start/default#-@-"]);
    await client.close();
  });

  it("resolves the default repository in the configured project and reports unresolved identity", async () => {
    const dirs: (string | undefined)[] = [];
    const client = await connect(
      fake({ currentRepository: async (cwd) => (dirs.push(cwd), repo) }),
      { project: "/work/project" },
    );
    const result = await client.callTool({ name: "triage_briefing", arguments: {} });
    expect(dirs).toEqual(["/work/project"]);
    expect(text(result)).toMatch(/Identity: unresolved; this is an unfocused read/);
    await client.close();
  });

  it("returns sanitized errors, never raw failure text", async () => {
    const client = await connect(
      fake({
        currentRepository: async () => {
          throw new Error("gh: secret-token-123 stderr");
        },
        collect: async () => {
          throw new Error("ghp_SECRET raw stderr\n    at stack");
        },
      }),
    );
    const unresolved = await client.callTool({ name: "triage_briefing", arguments: {} });
    expect(unresolved.isError).toBe(true);
    expect(structured(unresolved)).toMatchObject({
      status: "error",
      result: null,
      error: { code: "repository-unresolved" },
    });
    const failed = await client.callTool({ name: "triage_briefing", arguments: { repo } });
    expect(structured(failed).error?.code).toBe("collection-failed");
    expect(JSON.stringify(failed)).not.toMatch(/SECRET|secret-token|stack|stderr/);
    await client.close();
  });

  it("reports incomplete evidence and unavailable issues as incomplete, not complete", async () => {
    const client = await connect(
      fake({
        collect: async (_r: string, options?: { issue?: number }) => {
          if (options?.issue === 9)
            throw new IssueUnavailable({
              repository: repo,
              number: 9,
              url: `https://github.com/${repo}/issues/9`,
              state: "forbidden",
              detail: "No access.",
              next: "Check permissions.",
            });
          return { ...snapshot(), warnings: ["Pull requests were truncated."] };
        },
      }),
      { repo },
    );
    const partial = await client.callTool({ name: "triage_briefing", arguments: {} });
    expect(structured(partial).status).toBe("incomplete");
    expect(text(partial)).toMatch(/^INCOMPLETE evidence/);
    const denied = await client.callTool({ name: "triage_issue", arguments: { number: 9 } });
    expect(structured(denied)).toMatchObject({
      status: "incomplete",
      result: { kind: "issue-unavailable", state: "forbidden" },
    });
    expect(text(denied)).toMatch(/FORBIDDEN/);
    await client.close();
  });

  it("does not report a cancelled call as complete", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = () => {};
    const begun = new Promise<void>((resolve) => (started = resolve));
    const client = await connect(
      fake({
        collect: async () => {
          started();
          await gate;
          return snapshot();
        },
      }),
      { repo },
    );
    const controller = new AbortController();
    const pending = client
      .callTool({ name: "triage_briefing", arguments: {} }, { signal: controller.signal })
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      );
    await begun;
    controller.abort();
    release();
    const outcome = await pending;
    expect("error" in outcome || structured(outcome.result).status === "error").toBe(true);
    await client.close();
  });

  it("hands the call's abort signal to collection and dependency reads", async () => {
    const seen: AbortSignal[] = [];
    const hang = (signal: AbortSignal | undefined) => {
      if (signal) seen.push(signal);
      return new Promise<never>((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason)),
      );
    };
    const client = await connect(
      fake({
        collect: async (_r: string, options?: { signal?: AbortSignal }) => hang(options?.signal),
        dependencyReport: async (_r: string, _n: number, options?: { signal?: AbortSignal }) =>
          hang(options?.signal),
      }),
      { repo },
    );
    for (const [name, args] of [
      ["triage_briefing", {}],
      ["triage_dependencies", { number: 1 }],
    ] as const) {
      const before = seen.length;
      const controller = new AbortController();
      const pending = client
        .callTool({ name, arguments: args }, { signal: controller.signal })
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
      await expect.poll(() => seen.length).toBe(before + 1);
      controller.abort();
      const outcome = await pending;
      expect("error" in outcome || structured(outcome.result).status === "error").toBe(true);
      // The server-side signal for that call fires, so the gh child is terminated.
      await expect.poll(() => seen.at(-1)?.aborted).toBe(true);
    }
    expect(seen).toHaveLength(2);
    await client.close();
  });

  it("never returns local filesystem paths from configuration diagnostics", async () => {
    const leaks = ["/home/alice/private/checkout", "C:\\Users\\alice\\private\\checkout"];
    for (const root of leaks) {
      // The checkout's remote does not match the requested repository, so the estimation
      // config error names the checkout directory.
      const git: GitRunner = async (args) =>
        args[0] === "rev-parse" ? `${root}\n` : "origin\thttps://github.com/other/thing (fetch)\n";
      const client = await connect(fake({ estimation: { cwd: root, git } }), {
        project: root,
        repo,
      });
      for (const [name, args] of [
        ["triage_briefing", {}],
        ["triage_issue", { number: 1 }],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        const all = JSON.stringify(result);
        expect(all, `${name} ${root}`).not.toContain("alice");
        expect(all).toContain("<local checkout>");
        expect(all).toContain("other/thing");
        expect(all).toContain(`https://github.com/${repo}/issues/1`);
      }
      await client.close();
    }
  });

  it("redacts absolute paths in local diagnostics without touching URLs or repository names", () => {
    expect(
      [
        "The checkout at /srv/work/x is not owner/name (remotes: o/r).",
        "Restore C:\\Users\\bob\\proj\\.github\\triage.json from Git.",
        "See https://github.com/owner/name/issues/2 and ~/secret/file",
      ].map(redactLocalText),
    ).toEqual([
      "The checkout at <local checkout> is not owner/name (remotes: o/r).",
      "Restore <local checkout> from Git.",
      "See https://github.com/owner/name/issues/2 and <local checkout>",
    ]);
  });

  it("redacts only verified local directories everywhere, at path boundaries", () => {
    expect(
      redactPaths(
        {
          a: "Mine: /opt/me/repo/src and /opt/me/repo.",
          b: "Not mine: /opt/me/repository, /api/v1/users, /srv/work/x",
          c: ["Win: c:/Users/Bob/proj\\src", "D:\\Users\\Bob\\proj"],
          n: 3,
        },
        ["/opt/me/repo", "C:\\Users\\Bob\\proj"],
      ),
    ).toEqual({
      a: "Mine: <local checkout>/src and <local checkout>.",
      b: "Not mine: /opt/me/repository, /api/v1/users, /srv/work/x",
      c: ["Win: <local checkout>\\src", "D:\\Users\\Bob\\proj"],
      n: 3,
    });
  });

  it("keeps GitHub-authored paths verbatim and still redacts the home directory", async () => {
    const { homedir } = await import("node:os");
    const authored = "Call /api/v1/users; see [contract](/doc/design/mcp.md).";
    const home = `${homedir()}/private/notes.md`;
    const evidence = {
      ...issue(1),
      title: "Fix /api/v1/users",
      body: `${authored}\\nLocal: ${home}`,
      comments: page([
        { author: { login: "ana" }, body: authored, createdAt: time, url: `${issue().url}#c1` },
      ]),
    } as unknown as Issue;
    const client = await connect(
      fake({ collect: async (repository: string) => ({ ...snapshot([evidence]), repository }) }),
      { repo },
    );
    for (const [name, args] of [
      ["triage_issue", { number: 1 }],
      ["triage_briefing", {}],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      const all = JSON.stringify(result.structuredContent) + text(result);
      expect(all, name).not.toContain(homedir());
      if (name === "triage_issue") {
        const detail = JSON.stringify(structured(result).result);
        expect(detail).toContain(JSON.stringify(authored).slice(1, -1));
        expect(detail).toContain("Fix /api/v1/users");
        expect(detail).toContain("<local checkout>/private/notes.md");
      }
    }
    await client.close();
  });

  it("validates startup arguments", () => {
    expect(mcpArguments(["--repo", "o/r", "--agent", "ana"])).toMatchObject({
      repo: "o/r",
      agent: "ana",
    });
    expect(() => mcpArguments(["--repo", "bad"])).toThrow();
    expect(() => mcpArguments(["--agent", "-x"])).toThrow();
    expect(() => mcpArguments(["--harness", "ori"])).toThrow();
  });
});

describe("role-shaped briefings (#1, doc/design/briefings.md)", () => {
  const compact = async (
    data: Snapshot,
    options: { limit: number; agent?: string; role?: string; platform?: string },
  ) => {
    const { compactBriefing } = await import("./compact.js");
    const expanded = briefing(data, { ...options, limit: 1000 }, new Date(time));
    return compactBriefing(data, options, expanded);
  };
  const numbers = (rows: { url: string }[]) => rows.map(({ url }) => Number(url.split("/").pop()));
  const section = (r: Awaited<ReturnType<typeof compact>>, name: string) =>
    r.role!.sections.find((s) => s.name === name)!;
  const blocking = (from: Issue, dependant: Issue): void => {
    from.issueDependenciesSummary!.blocking = 1;
    from.blocking = page([
      {
        number: dependant.number,
        title: dependant.title,
        url: dependant.url,
        state: dependant.state,
        repository: { nameWithOwner: repo },
        issueDependenciesSummary: dependant.issueDependenciesSummary!,
      },
    ]);
    dependant.issueDependenciesSummary!.blockedBy = 1;
    dependant.issueDependenciesSummary!.totalBlockedBy = 1;
  };

  it("leaves the briefing unchanged without --role", async () => {
    const data = snapshot([issue(1), issue(2)], []);
    const r = await compact(data, { limit: 5 });
    expect(r.role).toBeNull();
    expect(r.sections.available.total).toBe(2);
  });
  it("implementer orders addressed, PR follow-up, own work, then ranked pickup", async () => {
    const addressed = issue(10, ["status:needs-design", "attention:reader"]);
    const own = issue(11, ["agent:reader"]);
    const pickup = issue(12);
    const design = issue(13, ["status:needs-design"]);
    const failing = { ...pr(), closingIssuesReferences: page([]) };
    failing.commits.nodes[0]!.commit.statusCheckRollup!.contexts = page([
      { name: "verify", status: "COMPLETED", conclusion: "FAILURE" },
    ]);
    const r = await compact(snapshot([addressed, own, pickup, design], [failing]), {
      limit: 10,
      agent: "reader",
      role: "implementer",
    });
    expect(r.role!.question).toMatch(/implementation/);
    expect(numbers(r.role!.next)).toEqual([10, 4, 11, 12]);
    expect(r.actions.items.map((u) => Number(u.split("/").pop()))).toEqual([10, 4, 11, 12]);
    // Pending design is short background awareness, never a next step.
    expect(numbers(section(r, "pending-design").items)).toEqual([13]);
    expect(section(r, "pending-design").background).toBe(true);
    expect(section(r, "pickup").items[0]!.reason).toMatch(/Pickup rank 1/);
  });
  it("designer keeps addressed implementation questions visible and unblocks active work first", async () => {
    const addressed = issue(20, ["status:ready", "attention:reader"]);
    const idle = issue(21, ["design:decision-needed"]);
    const holding = issue(22, ["design:decision-needed"]);
    const claimed = issue(23, ["agent:other"]);
    blocking(holding, claimed);
    const documentation = issue(24, ["design:documentation-needed"]);
    const newDesign = issue(25, ["status:needs-design"]);
    const unlocked = issue(26);
    blocking(newDesign, unlocked);
    const quiet = issue(27, ["status:needs-design"]);
    const docsPr = {
      ...pr(),
      number: 40,
      url: `https://github.com/${repo}/pull/40`,
      labels: page([{ name: "documentation" }]),
      closingIssuesReferences: page([]),
    };
    const implPr = {
      ...pr(),
      number: 41,
      url: `https://github.com/${repo}/pull/41`,
      closingIssuesReferences: page([]),
      reviews: page([
        { body: "", url: "r1", author: null, state: "CHANGES_REQUESTED" },
        { body: "", url: "r2", author: null, state: "CHANGES_REQUESTED" },
      ]),
    };
    const r = await compact(
      snapshot(
        [addressed, idle, holding, claimed, documentation, quiet, newDesign, unlocked],
        [docsPr, implPr],
      ),
      { limit: 10, agent: "reader", role: "designer" },
    );
    expect(numbers(section(r, "addressed").items)).toEqual([20]);
    expect(numbers(section(r, "decision-needed").items)).toEqual([22, 21]);
    expect(section(r, "decision-needed").items[0]!.reason).toMatch(/Holds up active work #23/);
    expect(numbers(section(r, "documentation-needed").items)).toEqual([24]);
    expect(numbers(section(r, "design-review").items)).toEqual([40]);
    expect(numbers(section(r, "design-pickup").items)).toEqual([25, 27]);
    expect(section(r, "design-pickup").items[0]!.reason).toMatch(/unlocks 1 \(#26\)/);
    const impl = section(r, "implementation-prs");
    expect(impl.background).toBe(true);
    expect(impl.items[0]!.reason).toMatch(/possible design input/);
    // General implementation pickup is outside the designer view.
    expect(r.role!.sections.some((s) => s.name === "pickup")).toBe(false);
    expect(numbers(r.role!.next)).not.toContain(41);
  });
  it("bounds each section with omission counts and lists each subject once", async () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      issue(50 + i, ["design:decision-needed", "attention:reader"]),
    );
    const r = await compact(snapshot(many, []), { limit: 5, agent: "reader", role: "designer" });
    expect(section(r, "addressed")).toMatchObject({ total: 8, omitted: 0 });
    expect(section(r, "decision-needed").total).toBe(0);
    expect(r.actions).toMatchObject({ total: 8, omitted: 3 });
  });
  it("keeps PRs with only verification or merge-state findings visible but not actionable", async () => {
    const unverified = { ...pr(), closingIssuesReferences: page([]) };
    unverified.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes[0]!.name = "unrelated";
    const behind = {
      ...pr(),
      number: 5,
      url: `https://github.com/${repo}/pull/5`,
      closingIssuesReferences: page([]),
      mergeStateStatus: "BEHIND",
    };
    const data = snapshot([issue(1)], [unverified, behind]);
    const r = await compact(data, { limit: 10, agent: "reader", role: "implementer" });
    const waiting = section(r, "pr-waiting");
    expect(numbers(waiting.items)).toEqual([4, 5]);
    expect(waiting.background).toBe(true);
    expect(waiting.items[0]!.reason).toMatch(/verify not proven/);
    expect(waiting.items[1]!.reason).toMatch(/Merge state: BEHIND/);
    expect(numbers(section(r, "pr-follow-up").items)).toEqual([]);
    expect(numbers(r.role!.next)).not.toContain(4);
    // No PR in the non-role compact output silently vanishes from a role view.
    const plain = await compact(data, { limit: 10, agent: "reader" });
    const plainPrs = new Set(
      [...plain.actions.items, ...Object.values(plain.sections).flatMap((s) => s.items)].filter(
        (url) => url.includes("/pull/"),
      ),
    );
    expect(plainPrs.size).toBe(2);
    for (const role of ["implementer", "designer"]) {
      const view = await compact(data, { limit: 10, agent: "reader", role });
      const shown = new Set(view.role!.sections.flatMap((s) => s.items.map((row) => row.url)));
      for (const url of plainPrs) expect(shown.has(url), `${role} ${url}`).toBe(true);
    }
  });
  it("designer new design work excludes tickets with an open closing PR", async () => {
    const covered = issue(70, ["status:needs-design"]);
    const fresh = issue(71, ["status:needs-design"]);
    const docsPr = {
      ...pr(),
      number: 72,
      url: `https://github.com/${repo}/pull/72`,
      closingIssuesReferences: page([{ number: 70, url: covered.url }]),
    };
    const r = await compact(snapshot([covered, fresh], [docsPr as PullRequest]), {
      limit: 10,
      agent: "reader",
      role: "designer",
    });
    expect(numbers(section(r, "design-pickup").items)).toEqual([71]);
    expect(numbers(section(r, "design-review").items)).toEqual([72]);
  });
  it("implementer active work excludes parked items unless addressed", async () => {
    const parked = issue(80, ["agent:reader", "status:parked"]);
    const active = issue(81, ["agent:reader"]);
    const r = await compact(snapshot([parked, active], []), {
      limit: 10,
      agent: "reader",
      role: "implementer",
    });
    expect(numbers(section(r, "own-work").items)).toEqual([81]);
    expect(numbers(r.role!.next)).not.toContain(80);
    const addressed = issue(80, ["agent:reader", "status:parked", "attention:reader"]);
    const a = await compact(snapshot([addressed, active], []), {
      limit: 10,
      agent: "reader",
      role: "implementer",
    });
    expect(numbers(r.role!.next)).not.toContain(80);
    expect(numbers(a.role!.next)).toContain(80);
  });
  it("excludes parked design work from new design pickup unless addressed", async () => {
    const parked = issue(100, ["status:needs-design", "status:parked"]);
    const fresh = issue(101, ["status:needs-design"]);
    const r = await compact(snapshot([parked, fresh], []), {
      limit: 10,
      agent: "reader",
      role: "designer",
    });
    expect(numbers(section(r, "design-pickup").items)).toEqual([101]);
    expect(numbers(r.role!.next)).not.toContain(100);
    // Still visible as background context, never silently dropped.
    expect(numbers(section(r, "other-context").items)).toContain(100);
    const addressed = issue(100, ["status:needs-design", "status:parked", "attention:reader"]);
    const a = await compact(snapshot([addressed, fresh], []), {
      limit: 10,
      agent: "reader",
      role: "designer",
    });
    expect(numbers(a.role!.next)).toContain(100);
  });
  it("applies the parked guard centrally to every foreground role section", async () => {
    const { roleView, sectionSelectors } = await import("./roles.js");
    const parked = issue(102, ["agent:reader", "status:parked"]);
    const data = snapshot([parked], []);
    const r = await compact(data, { limit: 10, agent: "reader" });
    // A selector that ignores parking still cannot promote a parked ticket to a next step.
    sectionSelectors.set("own-work-unguarded", ({ byUrl }) =>
      [...byUrl.keys()].map((url) => ({ url, reason: "test" })),
    );
    const { roleRegistry } = await import("./roles.js");
    roleRegistry.set("probe", {
      question: "probe",
      sections: [{ section: "own-work-unguarded", title: "PROBE", budget: 5 }],
    });
    try {
      const view = roleView("probe", {
        snapshot: data,
        facts: briefing(data, { limit: 1000, agent: "reader" }, new Date(time)),
        findings: new Map(),
        byUrl: new Map([[parked.url, parked]]),
        isAddressed: () => false,
        isMine: () => true,
        linkedMine: () => true,
        baseline: new Map([[parked.url, "Parked; not a next step."]]),
      });
      expect(view.next).toEqual([]);
      expect(numbers(view.sections.at(-1)!.items)).toEqual([102]);
    } finally {
      roleRegistry.delete("probe");
      sectionSelectors.delete("own-work-unguarded");
    }
    expect(r.role).toBeNull();
  });
  it("populates unblock candidates from the real dependency rule", async () => {
    const blocker = issue(110, ["agent:other"]);
    const waiting = issue(111);
    blocking(blocker, waiting);
    const r = await compact(snapshot([blocker, waiting], []), {
      limit: 10,
      agent: "reader",
      role: "implementer",
    });
    expect(numbers(section(r, "unblock-candidates").items)).toEqual([111]);
    expect(section(r, "unblock-candidates").items[0]!.reason).toMatch(/native blockers close/);
  });
  it("never cuts addressed attention by a fixed cap", async () => {
    const many = Array.from({ length: 14 }, (_, i) => issue(120 + i, ["attention:reader"]));
    const r = await compact(snapshot(many, []), { limit: 5, agent: "reader", role: "designer" });
    expect(section(r, "addressed")).toMatchObject({ total: 14, omitted: 0 });
    expect(section(r, "addressed").items).toHaveLength(14);
  });
  it("respects platform restrictions on new design work", async () => {
    const codex = issue(140, ["status:needs-design", "platform:codex"]);
    const open = issue(141, ["status:needs-design"]);
    const data = snapshot([codex, open], []);
    const other = await compact(data, {
      limit: 10,
      agent: "reader",
      role: "designer",
      platform: "ori",
    });
    expect(numbers(section(other, "design-pickup").items)).toEqual([141]);
    expect(numbers(other.role!.next)).not.toContain(140);
    const match = await compact(data, {
      limit: 10,
      agent: "reader",
      role: "designer",
      platform: "codex",
    });
    expect(numbers(section(match, "design-pickup").items)).toEqual([140, 141]);
    const unknown = await compact(data, { limit: 10, agent: "reader", role: "designer" });
    expect(numbers(section(unknown, "design-pickup").items)).toEqual([141]);
    expect(numbers(section(unknown, "design-pickup-inspect").items)).toEqual([140]);
    expect(section(unknown, "design-pickup-inspect").background).toBe(true);
    expect(numbers(unknown.role!.next)).not.toContain(140);
  });
  it("keeps pickup-unverified tickets visible for inspection", async () => {
    const restricted = issue(150, ["status:ready", "platform:codex"]);
    const r = await compact(snapshot([restricted], []), {
      limit: 10,
      agent: "reader",
      role: "implementer",
    });
    const inspect = section(r, "pickup-inspect");
    expect(numbers(inspect.items)).toEqual([150]);
    expect(inspect.background).toBe(true);
    expect(inspect.items[0]!.reason).toMatch(/eligibility unknown/);
    expect(numbers(r.role!.next)).not.toContain(150);
  });
  it("shows every issue and PR from the non-role briefing somewhere in each role", async () => {
    const holder = issue(160, ["agent:other"]);
    const waiting = issue(161);
    blocking(holder, waiting);
    const items = [
      issue(162),
      issue(163, ["status:parked"]),
      issue(164, ["agent:reader"]),
      issue(165, ["agent:other", "status:parked"]),
      issue(166, ["status:needs-design", "platform:codex"]),
      issue(167, ["status:ready", "platform:codex"]),
      issue(168, ["design:decision-needed", "agent:other"]),
      issue(169, ["status:blocked"]),
      holder,
      waiting,
    ];
    const data = snapshot(items, [{ ...pr(), closingIssuesReferences: page([]) }]);
    const plain = await compact(data, { limit: 50, agent: "reader" });
    const all = new Set([
      ...plain.actions.items,
      ...Object.values(plain.sections).flatMap((s) => s.items),
    ]);
    expect([...all].some((url) => url.includes("/issues/"))).toBe(true);
    for (const role of ["implementer", "designer"]) {
      const view = await compact(data, { limit: 50, agent: "reader", role });
      const shown = new Set(view.role!.sections.flatMap((s) => s.items.map((row) => row.url)));
      // Anything not placed is in OTHER CONTEXT, bounded with an explicit omission count.
      const missing = [...all].filter((url) => !shown.has(url));
      expect(missing.length, role).toBe(section(view, "other-context").omitted);
    }
  });
  it("renders the role in text and rejects unknown roles", async () => {
    const { compactText } = await import("./compact.js");
    const r = await compact(snapshot([issue(60)], []), { limit: 5, role: "implementer" });
    const text = compactText(r);
    expect(text).toMatch(/Role implementer: What action advances implementation most\?/);
    expect(text).toMatch(/\nPICKUP \(1; 0 omitted\)/);
    expect(text).not.toMatch(/\nAVAILABLE/);
    const { argumentsFor } = await import("./cli.js");
    expect(() => argumentsFor(["--role", "owner"])).toThrow(/implementer, designer/);
    expect(() => argumentsFor(["--role", "designer", "--full"])).toThrow(/--full/);
    expect(argumentsFor(["--role=designer"]).role).toBe("designer");
  });
});

describe("release: coordinated handoff (#62, doc/design/workflow.md)", () => {
  type Live = {
    labels: string[];
    comments: { body: string; createdAt: string }[];
    state?: string;
    linkedOpenPr?: boolean;
    prState?: string | null;
    labelledAt?: string;
    events: { __typename?: string; createdAt: string; label: { name: string } }[];
  };
  /** A mutable fake GitHub: writes through `run` change what later reads see. */
  const live = (initial: Partial<Live> & { labels: string[] }) => {
    const labelledAt = "labelledAt" in initial ? initial.labelledAt : "2026-11-12T09:00:00.000Z";
    const s: Live = {
      comments: [],
      events: labelledAt ? [{ createdAt: labelledAt, label: { name: "agent:kavya" } }] : [],
      ...initial,
    };
    // A monotonic clock, so label events and comments are ordered like GitHub's.
    let ticks = 0;
    const tick = () => new Date(Date.parse(time) + ++ticks * 1000).toISOString();
    const addLabel = (name: string) => {
      s.labels.push(name);
      s.events.push({ createdAt: tick(), label: { name } });
    };
    const removeLabel = (name: string) => {
      s.labels = s.labels.filter((l) => l !== name);
      s.events.push({ __typename: "UnlabeledEvent", createdAt: tick(), label: { name } });
    };
    const writes: string[][] = [];
    // Label history paged like GitHub's: the newest 50, then older pages of 100 by cursor.
    const timeline = (end: number, size: number) => {
      const start = Math.max(0, end - size);
      return {
        nodes: s.events.slice(start, end),
        pageInfo: { hasPreviousPage: start > 0, startCursor: String(start) },
      };
    };
    const query = async (source: string, variables: Record<string, unknown> = {}) => {
      if (source.includes("before:$before"))
        return {
          repository: { issue: { timelineItems: timeline(Number(variables.before), 100) } },
        };
      if (source.includes("resource(url:"))
        return {
          resource: s.prState === null ? null : { __typename: "PullRequest", state: s.prState },
        };
      return {
        repository: {
          issueOrPullRequest: {
            __typename: "Issue",
            number: 7,
            title: "T7",
            url: `https://github.com/${repo}/issues/7`,
            state: s.state ?? "OPEN",
            updatedAt: time,
            labels: page(s.labels.map((name) => ({ name }))),
            issueDependenciesSummary: { blockedBy: 0 },
            blockedBy: page([]),
            closedByPullRequestsReferences: page(
              s.linkedOpenPr
                ? [{ number: 70, url: `https://github.com/${repo}/pull/70`, state: "OPEN" }]
                : [],
            ),
            comments: page(s.comments),
            timelineItems: timeline(s.events.length, 50),
          },
          claims: page([]),
          ownerLabel: { name: "agent:kavya" },
          questionLabel: null,
          decisionLabel: null,
          needsDesignLabel: null,
          attentionLabel: null,
          targetLabel: variables.target ? { name: variables.target } : null,
        },
      };
    };
    const run = async (args: string[]) => {
      writes.push(args);
      if (args[1] === "edit")
        for (let i = 0; i < args.length; i++) {
          if (args[i] === "--add-label") addLabel(args[i + 1]);
          if (args[i] === "--remove-label") removeLabel(args[i + 1]);
        }
      if (args[1] === "comment")
        s.comments.push({ body: args[args.indexOf("--body") + 1], createdAt: tick() });
    };
    return { s, query, run, writes, addLabel, removeLabel };
  };
  const pr = `https://github.com/${repo}/pull/70`;
  const release = (env: ReturnType<typeof live>, extra: Record<string, unknown> = {}) =>
    planRelease(repo, { number: 7, agent: "kavya", outcome: "incomplete", ...extra }, env.query);

  it("releases incomplete work with a note: the recorded handoff comment first, then labels", async () => {
    const env = live({ labels: ["agent:kavya", "bug", "question", "attention:nicole"] });
    const result = await applyPlan(
      repo,
      await release(env, { note: "Parser done; CLI remains." }),
      env,
    );
    expect(result.exitCode).toBe(0);
    expect(env.writes.map((w) => w[1])).toEqual(["comment", "edit"]);
    expect(env.s.labels.sort()).toEqual(
      ["attention:nicole", "bug", "question", "status:incomplete"].sort(),
    );
    expect(env.s.comments[0].body).toContain("Parser done; CLI remains.");
    expect(env.s.comments[0].body).toMatch(/<!-- github-triage:release:/);
  });
  it("every suggested release command keeps --repo executable", async () => {
    const note = "Fix # parser, it's half done";
    const plans = [
      await release(live({ labels: [] })),
      await release(live({ labels: ["agent:kavya"], state: "CLOSED" }), { pr }),
      await release(live({ labels: ["agent:kavya"] }), { note }),
    ];
    const commands = plans.flatMap((p) => (p.ok ? [p.retry!] : [...p.recovery]));
    expect(commands.length).toBeGreaterThan(3);
    for (const c of commands) {
      const words = shellWords(c);
      if (words[0] !== "github-triage" && words[0] !== "gh") continue;
      expect(words[words.indexOf("--repo") + 1], c).toBe(repo);
    }
    expect(shellWords(accepted(plans[2]).retry!)).toContain(note);
  });
  it("releases without a note: never a gate, but noted; parked maps to status:incomplete", async () => {
    const env = live({ labels: ["agent:kavya"] });
    const plan = await release(env, { outcome: "parked" });
    expect(accepted(plan).notes!.join(" ")).toMatch(/No handoff note/);
    const result = await applyPlan(repo, plan, env);
    expect(result.exitCode).toBe(0);
    expect(env.s.labels).toEqual(["status:incomplete"]);
    expect(env.s.labels).not.toContain("status:parked");
    expect(env.s.comments[0].body).toContain("No handoff note supplied");
  });
  it("ready returns untouched work to pickup and drops a stale awaiting-review label", async () => {
    const env = live({ labels: ["agent:kavya", "status:awaiting-review"] });
    await applyPlan(repo, await release(env, { outcome: "ready" }), env);
    expect(env.s.labels).toEqual(["status:ready"]);
  });
  it("done with an open PR awaits review and leaves pickup; never closes", async () => {
    const env = live({ labels: ["agent:kavya", "status:ready"], prState: "OPEN" });
    const plan = await release(env, { outcome: "done", pr, note: "Ready for review." });
    expect(plan).toMatchObject({
      ok: true,
      facts: { target: "status:awaiting-review", pullRequestState: "OPEN" },
    });
    const result = await applyPlan(repo, plan, env);
    expect(result.exitCode).toBe(0);
    expect(env.s.labels).toEqual(["status:awaiting-review"]);
    expect(env.writes.flat().join(" ")).not.toMatch(/close/);
    // A PR linked to the issue counts even without --pr.
    const linked = live({ labels: ["agent:kavya"], linkedOpenPr: true });
    expect(accepted(await release(linked, { outcome: "done" })).facts.target).toBe(
      "status:awaiting-review",
    );
  });
  it("done without an open PR releases without returning to pickup or closing; unknown PR stays unknown", async () => {
    const env = live({ labels: ["agent:kavya", "status:incomplete"], prState: "MERGED" });
    const plan = await release(env, { outcome: "done", pr });
    expect(accepted(plan).facts.target).toBeNull();
    await applyPlan(repo, plan, env);
    expect(env.s.labels).toEqual([]);
    const unknown = live({ labels: ["agent:kavya"], prState: null });
    const u = accepted(await release(unknown, { outcome: "done", pr }));
    expect(u.facts.pullRequestState).toBe("UNKNOWN");
    expect(u.facts.target).toBeNull();
    expect(u.notes!.join(" ")).toMatch(/UNKNOWN/);
  });
  it("refuses when the caller holds no claim or another agent owns it; keeps other owners", async () => {
    const other = live({ labels: ["agent:other", "status:ready"], labelledAt: undefined });
    expect(await release(other)).toMatchObject({ ok: false, error: "NOT_CLAIMED" });
    // Someone else claimed after our label was removed: re-evaluate, never post.
    const taken = live({ labels: ["agent:other", "status:incomplete"] });
    expect(await release(taken)).toMatchObject({ ok: false, error: "NOT_CLAIMED" });
    const shared = live({ labels: ["agent:kavya", "agent:other"] });
    const plan = await release(shared);
    expect(accepted(plan).notes!.join(" ")).toMatch(/Other owners kept: agent:other/);
    await applyPlan(repo, plan, shared);
    expect(shared.s.labels).toContain("agent:other");
    const many = live({ labels: ["agent:kavya"] });
    const q = async (source: string) => {
      const d = (await many.query(source)) as ReturnType<typeof Object>;
      (
        d as {
          repository: { issueOrPullRequest: { labels: { pageInfo: { hasNextPage: boolean } } } };
        }
      ).repository.issueOrPullRequest.labels.pageInfo.hasNextPage = true;
      return d;
    };
    expect(
      await planRelease(repo, { number: 7, agent: "kavya", outcome: "ready" }, q),
    ).toMatchObject({
      ok: false,
      error: "EVIDENCE_INCOMPLETE",
    });
  });
  it("reports a concurrent change after writing as a conflict", async () => {
    const env = live({ labels: ["agent:kavya"] });
    const plan = await release(env);
    const racing = async (args: string[]) => {
      await env.run(args);
      if (args[1] === "edit") env.s.labels = env.s.labels.filter((l) => l !== "status:incomplete");
    };
    const result = await applyPlan(repo, plan, { run: racing, query: env.query });
    expect(result.exitCode).toBe(2);
    expect(result.conflict).toMatch(/status:incomplete is no longer/);
  });
  it("partial API failure: the recorded intent is visible, retry applies only its labels once", async () => {
    const env = live({ labels: ["agent:kavya", "status:ready"] });
    const failing = async (args: string[]) => {
      if (args[1] === "edit") throw new Error("gh issue edit failed.");
      await env.run(args);
    };
    const first = await applyPlan(repo, await release(env, { note: "half" }), {
      run: failing,
      query: env.query,
    });
    expect(first.exitCode).toBe(2);
    expect(first.steps!.map((s) => s.status)).toEqual(["done", "failed"]);
    expect(env.s.labels).toEqual(["agent:kavya", "status:ready"]);
    const { claimText } = await import("./claims.js");
    expect(claimText(first)).toMatch(
      /Retry \(safe.*github-triage release 7 --agent kavya --as incomplete --note half --repo/,
    );
    const retry = await release(env, { note: "half" });
    expect(accepted(retry).changes.map((c) => c.step)).toEqual(["labels"]);
    expect((await applyPlan(repo, retry, env)).exitCode).toBe(0);
    expect(env.s.labels).toEqual(["status:incomplete"]);
    expect(env.s.comments).toHaveLength(1);
    // A further retry, even with different wording, recognises the recorded handoff.
    const again = await release(env, { note: "different" });
    expect(again).toMatchObject({ ok: true, noop: true, changes: [] });
    expect((await applyPlan(repo, again, env)).exitCode).toBe(0);
    expect(env.s.comments).toHaveLength(1);
  });
  it("never treats a historical claim label as release authorisation", async () => {
    // The claim was removed some other way: no recorded handoff, so nothing is stripped or posted.
    const env = live({ labels: ["status:ready"] });
    expect(await release(env, { outcome: "ready" })).toMatchObject({
      ok: false,
      error: "NOT_CLAIMED",
    });
    expect(await release(env, { outcome: "done" })).toMatchObject({
      ok: false,
      error: "NOT_CLAIMED",
    });
    // A marker with an unparsable plan is not authorisation either.
    env.s.comments.push({
      body: "<!-- github-triage:release:0123456789abcdef {broken -->",
      createdAt: time,
    });
    expect(await release(env, { outcome: "ready" })).toMatchObject({ ok: false });
  });
  it("a retry keeps the owners the original release retained", async () => {
    const env = live({ labels: ["agent:kavya", "agent:other"] });
    const failing = async (args: string[]) => {
      if (args[1] === "edit") throw new Error("gh issue edit failed.");
      await env.run(args);
    };
    await applyPlan(repo, await release(env), { run: failing, query: env.query });
    // The label write failed: our claim label is still there, so the step is unfinished.
    expect(env.s.labels.sort()).toEqual(["agent:kavya", "agent:other"]);
    const retry = accepted(await release(env));
    expect(retry.changes.map((c) => c.step)).toEqual(["labels"]);
    expect(retry.notes!.join(" ")).toMatch(/Other owners kept: agent:other/);
    expect((await applyPlan(repo, retry, env)).exitCode).toBe(0);
    expect(env.s.labels.sort()).toEqual(["agent:other", "status:incomplete"]);
    expect(env.s.comments).toHaveLength(1);
  });
  it("refuses a retry when ownership or readiness changed after the recorded handoff", async () => {
    const env = live({ labels: ["agent:kavya"] });
    const failing = async (args: string[]) => {
      if (args[1] === "edit") throw new Error("gh issue edit failed.");
      await env.run(args);
    };
    await applyPlan(repo, await release(env), { run: failing, query: env.query });
    env.addLabel("agent:newcomer");
    expect(await release(env)).toMatchObject({ ok: false, error: "RELEASE_DIVERGED" });
    const ready = live({ labels: ["agent:kavya"] });
    await applyPlan(repo, await release(ready), {
      run: async (args) => {
        if (args[1] === "edit") throw new Error("failed");
        await ready.run(args);
      },
      query: ready.query,
    });
    ready.addLabel("status:ready");
    expect(await release(ready)).toMatchObject({ ok: false, error: "RELEASE_DIVERGED" });
    // A different outcome cannot replace a recorded, unfinished one.
    const pending = live({ labels: ["agent:kavya"] });
    await applyPlan(repo, await release(pending), {
      run: async (args) => {
        if (args[1] === "edit") throw new Error("failed");
        await pending.run(args);
      },
      query: pending.query,
    });
    expect(await release(pending, { outcome: "ready" })).toMatchObject({
      ok: false,
      error: "RELEASE_PENDING",
    });
  });
  describe("claim identity beyond the first page of label history (Codex P2)", () => {
    const at = (n: number) =>
      new Date(Date.parse("2026-11-12T09:00:00.000Z") + n * 1000).toISOString();
    // A handoff from an earlier acquisition whose claim time was never established.
    const unknownHandoff = (outcome = "incomplete") => {
      const op = `<!-- github-triage:release:${createHash("sha256")
        .update(JSON.stringify([repo, 7, "kavya", null]))
        .digest("hex")
        .slice(0, 16)}`;
      const plan = {
        v: 1,
        agent: "kavya",
        outcome,
        target: "status:incomplete",
        remove: ["agent:kavya"],
        retained: [],
        claimedAt: null,
      };
      return { body: `Handoff.\n\n${op} ${JSON.stringify(plan)} -->`, createdAt: at(5) };
    };
    // The current claim's add event, followed by more noise than one page holds.
    const buried = (noise: number) => {
      const events: Live["events"] = [{ createdAt: at(10), label: { name: "agent:kavya" } }];
      for (let i = 0; i < noise; i++)
        events.push({
          ...(i % 2 ? { __typename: "UnlabeledEvent" } : {}),
          createdAt: at(11 + i),
          label: { name: "noise" },
        });
      return events;
    };
    it("finds the claim time by paging back, so an older handoff is not matched", async () => {
      const env = live({
        labels: ["agent:kavya"],
        comments: [unknownHandoff()],
        events: buried(60),
      });
      const plan = await release(env, { outcome: "ready" });
      expect(plan).toMatchObject({ ok: true, noop: false });
      expect(accepted(plan).changes.map((c) => c.step)).toContain("comment");
      expect(
        accepted(plan)
          .changes.find((c) => c.step === "comment")!
          .command.at(-1),
      ).toContain(`"claimedAt":"${at(10)}"`);
    });
    it("refuses EVIDENCE_INCOMPLETE when the claim time is beyond the bounded search", async () => {
      const env = live({
        labels: ["agent:kavya"],
        comments: [unknownHandoff()],
        events: buried(400),
      });
      const plan = await release(env, { outcome: "ready" });
      expect(plan).toMatchObject({ ok: false, error: "EVIDENCE_INCOMPLETE" });
      expect(refused(plan).recovery.length).toBeGreaterThan(0);
      // Same outcome as the old handoff: still never replayed.
      expect(await release(env)).toMatchObject({ ok: false, error: "EVIDENCE_INCOMPLETE" });
    });
    it("never matches a handoff recorded with no claim time, even with no visible claim", async () => {
      const env = live({ labels: [], comments: [unknownHandoff()], labelledAt: undefined });
      expect(await release(env)).toMatchObject({ ok: false, error: "NOT_CLAIMED" });
    });
  });
  it("never restores labels from a completed handoff after others changed them", async () => {
    // Codex P2: done with an open PR, PR merged, a maintainer removes the review label.
    const env = live({ labels: ["agent:kavya"], linkedOpenPr: true });
    expect((await applyPlan(repo, await release(env, { outcome: "done" }), env)).exitCode).toBe(0);
    expect(env.s.labels).toEqual(["status:awaiting-review"]);
    env.s.linkedOpenPr = false;
    env.removeLabel("status:awaiting-review");
    const rerun = await release(env, { outcome: "done" });
    expect(rerun).toMatchObject({ ok: true, noop: true, changes: [] });
    const before = env.writes.length;
    expect((await applyPlan(repo, rerun, env)).exitCode).toBe(0);
    expect(env.writes).toHaveLength(before);
    expect(env.s.labels).toEqual([]);
  });
  it("refuses an unfinished retry when a plan label was removed after the handoff", async () => {
    const env = live({ labels: ["agent:kavya"] });
    await applyPlan(repo, await release(env), {
      run: async (args) => {
        if (args[1] === "edit") throw new Error("failed");
        await env.run(args);
      },
      query: env.query,
    });
    // Someone applied the recorded target, then deliberately took it off again.
    env.addLabel("status:incomplete");
    env.removeLabel("status:incomplete");
    expect(await release(env)).toMatchObject({ ok: false, error: "RELEASE_DIVERGED" });
    expect(env.s.labels).toContain("agent:kavya");
  });
  it("done: a linked open closing PR awaits review even when the supplied --pr is merged or unknown", async () => {
    for (const prState of ["MERGED", "CLOSED", null]) {
      const env = live({ labels: ["agent:kavya"], prState, linkedOpenPr: true });
      const plan = accepted(
        await release(env, { outcome: "done", pr: `https://github.com/${repo}/pull/69` }),
      );
      expect(plan.facts.target).toBe("status:awaiting-review");
    }
  });
  it("validates arguments and dry-runs without writing", async () => {
    for (const bad of [
      ["release", "7", "--agent", "a"],
      ["release", "7", "--agent", "a", "--as", "closed"],
      ["release", "7", "--agent", "a", "--as", "done", "--pr", pr, "--change", "https://x/y"],
      ["release", "7", "--agent", "a", "--as", "done", "--pr", "not-a-url"],
      ["release", "7", "--agent", "a", "--as", "ready", "--branch", "b"],
      ["claim", "7", "--agent", "a", "--as", "ready"],
    ])
      await expect(main(bad, async () => {})).rejects.toThrow();
    let help = "";
    expect(await main(["release", "--help"], async (t) => void (help = t))).toBe(0);
    expect(help).toMatch(/parked is a synonym/);
    const env = live({ labels: ["agent:kavya"] });
    let text = "";
    const code = await main(
      [
        "release",
        "7",
        "--agent",
        "kavya",
        "--as",
        "incomplete",
        "--dry-run",
        "--json",
        "--repo",
        repo,
      ],
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
    expect(JSON.parse(text)).toMatchObject({
      schemaVersion: 1,
      ok: true,
      facts: { outcome: "incomplete" },
    });
  });
});

describe("pr review history: why does this keep failing review (#60)", () => {
  const sha = (c: string) => c.repeat(40);
  const [c1, c2, c3, c4] = [sha("1"), sha("2"), sha("3"), sha("4")];
  const bot = { login: "chatgpt-codex-connector" };
  const me = { login: "dev" };
  const status = { blockers: [], verdict: "ok", completeness: { complete: true, warnings: [] } };
  let n = 0;
  const thread = (
    commit: string,
    title: string,
    o: { path?: string; resolved?: boolean; outdated?: boolean; reply?: string; by?: any } = {},
  ) => ({
    isResolved: !!o.resolved,
    isOutdated: !!o.outdated,
    path: o.path ?? "src/a.ts",
    line: 3,
    comments: {
      totalCount: o.reply ? 2 : 1,
      nodes: [
        {
          author: o.by ?? bot,
          body: `**<sub><sub>![P2 Badge](https://x)</sub></sub>  ${title}**\n\ndetail`,
          createdAt: `2026-11-1${commit[0]}T10:00:0${n % 10}Z`,
          url: `https://t/${++n}`,
          originalCommit: { oid: commit },
        },
        ...(o.reply
          ? [{ author: me, body: o.reply, createdAt: "2026-11-19T00:00:00Z", url: "https://r" }]
          : []),
      ],
    },
  });
  const review = (commit: string, state = "COMMENTED", by: any = bot) => ({
    author: by,
    state,
    submittedAt: `2026-11-1${commit[0]}T10:00:00Z`,
    url: `https://rv/${commit[0]}`,
    commit: { oid: commit },
  });
  const history = (o: Record<string, any> = {}) => ({
    number: 47,
    url: `https://github.com/${repo}/pull/47`,
    headRefOid: o.head ?? c4,
    author: me,
    commits: {
      nodes: (o.commits ?? [c1, c2, c3, c4]).map((oid: string) => ({
        commit: { oid, messageHeadline: `commit ${oid[0]}` },
      })),
      pageInfo: { hasNextPage: false },
    },
    reviews: { nodes: o.reviews ?? [], pageInfo: { hasNextPage: false } },
    reviewThreads: { nodes: o.threads ?? [], pageInfo: { hasNextPage: false } },
    comments: { nodes: o.comments ?? [], pageInfo: { hasNextPage: false } },
  });

  it("matches rounds to commits and classifies a fix/review loop with evidence", async () => {
    const { reviewHistory, reviewHistoryText } = await import("./reviewhistory.js");
    const r = reviewHistory(
      repo,
      history({
        reviews: [review(c1), review(c2), review(c3), review(c4), review(c2, "COMMENTED", me)],
        threads: [
          thread(c1, "Bound the output", { resolved: true, reply: "Fixed in 2222222" }),
          thread(c2, "Bound the output", { resolved: false }),
          thread(c2, "Handle empty input", { path: "src/a.ts", resolved: true }),
          thread(c3, "Escape names", { path: "src/b.ts" }),
          thread(c3, "Escape names", { path: "src/b.ts" }),
        ],
      }),
      status,
    );
    expect(r).toMatchObject({ schemaVersion: 1, kind: "pr-review-history", headReviewed: true });
    expect(r.rounds.map((x) => [x.commit[0], x.findingsRaised])).toEqual([
      ["1", 1],
      ["2", 2],
      ["3", 2],
      ["4", 0],
    ]);
    // The PR author's own reply review is not a review round.
    expect(r.rounds[1].reviewers.map((v) => v.by)).toEqual(["chatgpt-codex-connector"]);
    const cls = Object.fromEntries(r.findings.map((f) => [`${f.round}:${f.title}`, f.class]));
    expect(cls).toMatchObject({
      "1:Bound the output": "initial",
      "2:Bound the output": "repeated",
      "2:Handle empty input": "same-area-after-fix",
      "3:Escape names": "duplicate",
    });
    expect(r.findings.find((f) => f.round === 1)?.citedFixes).toEqual([c2]);
    expect(r.findings.find((f) => f.class === "repeated")?.related).toEqual(["https://t/1"]);
    expect(r.signal.repeatedCycleCandidate).toBe(true);
    expect(r.signal.roundsWithFindings).toBe(3);
    expect(r.themes[0]).toMatchObject({ path: "src/a.ts", rounds: [1, 2] });
    expect(r.nextActions.map((a) => a.action)).toEqual([
      "continue targeted fixes",
      "broader invariant/design review of the recurring area",
    ]);
    expect(r.completeness.complete).toBe(true);
    const text = reviewHistoryText(r);
    expect(text).toContain("REPEATED-CYCLE CANDIDATE (inspect, not a verdict)");
    expect(text).toContain("[repeated] r2 open");
  });

  it("reports a clean re-review, a stale head, disagreement and missing history honestly", async () => {
    const { reviewHistory } = await import("./reviewhistory.js");
    const marker = (commit: string, unresolved: boolean) => ({
      author: bot,
      createdAt: "2026-11-15T00:00:00Z",
      url: "https://m",
      body: `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${commit}","has_unresolved_findings":${unresolved},"status":"completed"}} -->`,
    });
    const clean = reviewHistory(
      repo,
      history({
        threads: [thread(c1, "Bug", { resolved: true })],
        reviews: [review(c1)],
        comments: [marker(c4, false)],
      }),
      status,
    );
    expect(clean.rounds.at(-1)).toMatchObject({ current: true, findingsRaised: 0 });
    expect(clean.rounds.at(-1)?.reviewers[0].state).toBe("NO FINDINGS (marker)");
    expect(clean.signal.repeatedCycleCandidate).toBe(false);
    expect(clean.nextActions[0].action).toBe("none suggested by review history");

    const stale = reviewHistory(repo, history({ reviews: [review(c1)] }), status);
    expect(stale.headReviewed).toBe(false);
    expect(stale.nextActions.map((a) => a.action)).toContain(
      "wait for or request review of the current head",
    );

    const split = reviewHistory(
      repo,
      history({
        reviews: [
          review(c4, "APPROVED", { login: "alice" }),
          review(c4, "CHANGES_REQUESTED", { login: "bob" }),
        ],
      }),
      status,
    );
    expect(split.disagreements).toEqual([
      { commit: c4, states: { alice: "APPROVED", bob: "CHANGES_REQUESTED" } },
    ]);

    const empty = reviewHistory(repo, history(), status);
    expect(empty.rounds).toEqual([]);
    expect(empty.uncertainty.join(" ")).toContain("history is missing, not clean");

    const rewritten = reviewHistory(
      repo,
      history({ reviews: [review(sha("9"))], threads: [thread(sha("9"), "Old")] }),
      status,
    );
    expect(rewritten.completeness.complete).toBe(false);
    expect(rewritten.completeness.warnings[0]).toContain("not among the PR's current commits");
  });

  it("bounds output and reports truncation", async () => {
    const { reviewHistory, historyLimits } = await import("./reviewhistory.js");
    const many = Array.from({ length: 15 }, (_, i) => thread(c1, `Finding ${i}`));
    const r = reviewHistory(
      repo,
      {
        ...history({ threads: many, reviews: [review(c1)] }),
        comments: { nodes: [], pageInfo: { hasNextPage: true } },
      },
      status,
    );
    expect(r.findings).toHaveLength(historyLimits.findings);
    expect(r.omittedFindings).toBe(5);
    expect(r.completeness.warnings).toContain(
      "more than 100 comments; later review markers not read",
    );
  });

  it("never counts an unsubmitted (PENDING) review as coverage of the head", async () => {
    const { reviewHistory } = await import("./reviewhistory.js");
    const draft = { ...review(c4, "PENDING", { login: "alice" }), submittedAt: null };
    const r = reviewHistory(repo, history({ reviews: [review(c1), draft] }), status);
    expect(r.headReviewed).toBe(false);
    expect(r.rounds.map((x) => x.commit)).toEqual([c1]);
    const unsubmitted = reviewHistory(
      repo,
      history({ reviews: [{ ...review(c4), submittedAt: null }] }),
      status,
    );
    expect(unsubmitted.headReviewed).toBe(false);
  });

  it("does not claim a recurrence order that only current resolution suggests", async () => {
    const { reviewHistory, reviewHistoryText } = await import("./reviewhistory.js");
    const r = reviewHistory(
      repo,
      history({
        reviews: [review(c1), review(c2), review(c3), review(c4)],
        threads: [
          thread(c1, "Bound the output", { resolved: true }),
          thread(c2, "Bound the output"),
          thread(c2, "Handle empty input", { path: "src/a.ts" }),
          thread(c3, "Check paths", { path: "src/a.ts" }),
        ],
      }),
      status,
    );
    expect(r.findings.filter((f) => f.round! > 1).map((f) => f.class)).toEqual([
      "recurrence-unordered",
      "recurrence-unordered",
      "recurrence-unordered",
    ]);
    expect(r.counts.repeated).toBe(0);
    expect(r.counts["same-area-after-fix"]).toBe(0);
    expect(r.signal.reasons.join(" ")).not.toMatch(/after resolution|already fixed/);
    expect(r.uncertainty.join(" ")).toContain("resolution order is unestablished");
    expect(reviewHistoryText(r)).toContain("recurrence-unordered 3");
    // A fix cited after the later finding's commit does not establish order either.
    const late = reviewHistory(
      repo,
      history({
        threads: [
          thread(c1, "Bound the output", { resolved: true, reply: "Fixed in 3333333" }),
          thread(c2, "Bound the output"),
        ],
      }),
      status,
    );
    expect(late.findings.find((f) => f.round === 2)?.class).toBe("recurrence-unordered");
  });

  it("retries once, then refuses to combine status and history for different heads", async () => {
    const { pullRequestReviewHistory } = await import("./reviewhistory.js");
    const live = (heads: string[]) => {
      const calls: string[] = [];
      let i = 0;
      const query = (async (q: string) => {
        calls.push(q);
        const head = heads[Math.min(i++, heads.length - 1)];
        return q.includes("statusCheckRollup")
          ? {
              repository: {
                pullRequest: {
                  ...history({ head }),
                  title: "x",
                  state: "OPEN",
                  mergeable: "MERGEABLE",
                  mergeStateStatus: "CLEAN",
                  headRefName: "b",
                  baseRefName: "main",
                  updatedAt: time,
                  commits: { nodes: [] },
                  reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
                  closingIssuesReferences: { nodes: [] },
                },
              },
            }
          : { repository: { pullRequest: history({ head, reviews: [review(head)] }) } };
      }) as Query;
      return { calls, query };
    };
    const raced = live([c3, c4, c4, c4]);
    const ok = await pullRequestReviewHistory(repo, 47, raced.query);
    expect(raced.calls).toHaveLength(4);
    expect(ok.cost.requests).toBe(4);
    expect(ok.completeness.warnings.join(" ")).not.toContain("head changed");

    const moving = live([c2, c3, c3, c4]);
    const bad = await pullRequestReviewHistory(repo, 47, moving.query);
    expect(moving.calls).toHaveLength(4);
    expect(bad.completeness.complete).toBe(false);
    expect(bad.completeness.warnings.join(" ")).toContain(
      "head changed between the status and history queries",
    );
    expect(bad.current.verdict).toContain("inconsistent snapshot");
    expect(bad.current.blockers.join(" ")).toContain("head moved during collection");
  });

  it("runs pr N --history through the injected query", async () => {
    let text = "";
    const calls: string[] = [];
    const runtime = {
      collect: async () => {
        throw new Error("no briefing");
      },
      currentRepository: async () => repo,
      query: (async (q: string) => {
        calls.push(q);
        return q.includes("statusCheckRollup")
          ? {
              repository: {
                pullRequest: {
                  ...history(),
                  title: "x",
                  state: "OPEN",
                  mergeable: "MERGEABLE",
                  mergeStateStatus: "CLEAN",
                  headRefName: "b",
                  baseRefName: "main",
                  updatedAt: time,
                  commits: { nodes: [] },
                  reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } },
                  closingIssuesReferences: { nodes: [] },
                },
              },
            }
          : { repository: { pullRequest: history({ reviews: [review(c4)] }) } };
      }) as Query,
    };
    expect(
      await main(["pr", "47", "--history", "--json"], async (t) => void (text = t), runtime),
    ).toBe(0);
    expect(calls).toHaveLength(2);
    const r = JSON.parse(text);
    expect(r).toMatchObject({ kind: "pr-review-history", cost: { requests: 2 } });
    expect(r.current.blockers.join(" ")).toContain("verify");
    expect(r.nextCommands[1]).toBe(`github-triage pr 47 --repo ${repo} --history --json`);
  });
});

describe("local configuration doctor (#64)", () => {
  type Answers = Record<string, number | null>;
  const base: Answers = {
    "gh --version": 0,
    "gh auth status --active --hostname github.com": 0,
    "git rev-parse --show-toplevel": 0,
    "git remote -v": 0,
    "git check-ignore --quiet --no-index agent-inbox.toml": 0,
    "git ls-files --error-unmatch -- agent-inbox.toml": 1,
  };
  const SECRET = "SECRET-TOKEN-VALUE";
  async function run(
    answers: Answers = {},
    file: string | null | Error = 'name = "x"\ntoken = "SECRET-TOKEN-VALUE"\n',
    options: { repo?: string; agent?: string; role?: string } = {},
    nodeVersion = "26.1.0",
  ) {
    const all = { ...base, ...answers };
    const calls: string[] = [];
    const probe = async (command: string, args: readonly string[]) => {
      const key = [command, ...args].join(" ");
      calls.push(key);
      const code = key in all ? all[key]! : 0;
      const stdout =
        key === "git rev-parse --show-toplevel"
          ? "/private/home/user/project\n"
          : key === "git remote -v"
            ? "origin\tgit@github.com:owner/name.git (fetch)\n"
            : `${SECRET}\n`;
      return { code, stdout };
    };
    const fs = {
      readText: async () => {
        if (file instanceof Error) throw file;
        return file;
      },
      writeText: async () => expect.fail("doctor wrote a file"),
      rename: async () => expect.fail("doctor renamed a file"),
      remove: async () => expect.fail("doctor removed a file"),
      makeDirectory: async () => expect.fail("doctor created a directory"),
    };
    const report = await localDoctor(options, { cwd: "/x", probe, fs, nodeVersion });
    const status = Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
    return { report, status, calls, text: localDoctorText(report), json: JSON.stringify(report) };
  }

  it("reports a healthy checkout with explicit identity, never leaking contents or paths", async () => {
    const { report, status, text, json, calls } = await run({}, undefined, {
      agent: "kavya",
      role: "implementer",
    });
    expect(report).toMatchObject({ schemaVersion: 1, repository: "owner/name", agent: "kavya" });
    expect(status).toMatchObject({
      "runtime.node": "ok",
      "gh.available": "ok",
      "gh.auth": "ok",
      "project.checkout": "ok",
      "identity.file": "ok",
      "identity.git-ignored": "ok",
      "identity.git-tracked": "ok",
      "identity.entry": "unsupported",
      "identity.agent": "ok",
      "triage.role": "ok",
    });
    expect(localDoctorExitCode(report)).toBe(0);
    for (const out of [text, json]) {
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain("/private/home");
    }
    expect(calls.every((c) => !c.includes("login") && !c.startsWith("git rm"))).toBe(true);
  });

  it("distinguishes a missing ignore rule from an already tracked file", async () => {
    const missingRule = await run({ "git check-ignore --quiet --no-index agent-inbox.toml": 1 });
    expect(missingRule.status["identity.git-ignored"]).toBe("missing");
    expect(missingRule.status["identity.git-tracked"]).toBe("ok");
    const tracked = await run({ "git ls-files --error-unmatch -- agent-inbox.toml": 0 });
    expect(tracked.status["identity.git-ignored"]).toBe("ok");
    expect(tracked.status["identity.git-tracked"]).toBe("invalid");
    expect(tracked.report.checks.find((c) => c.id === "identity.git-tracked")!.next).toEqual([
      'git rm --cached -- ":/agent-inbox.toml"',
    ]);
    expect(localDoctorExitCode(tracked.report)).toBe(1);
  });

  it("suggests an untracking command that works from a checkout subdirectory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "triage-test-"));
    try {
      const git = (cwd: string, ...args: string[]) =>
        new Promise<string>((resolve, reject) =>
          execFile("git", args, { cwd }, (error, stdout) =>
            error ? reject(error) : resolve(stdout),
          ),
        );
      await git(dir, "init", "-q");
      await writeFile(join(dir, "agent-inbox.toml"), "x\n");
      await git(dir, "add", "agent-inbox.toml");
      const sub = join(dir, "sub");
      await mkdir(sub);
      const tracked = await run({ "git ls-files --error-unmatch -- agent-inbox.toml": 0 });
      const suggested = tracked.report.checks.find((c) => c.id === "identity.git-tracked")!
        .next[0]!;
      // Run the suggested command's arguments from the subdirectory, as a user would.
      const args = suggested
        .replace(/^git /, "")
        .split(" ")
        .map((a) => a.replace(/^"(.*)"$/, "$1"));
      await git(sub, ...args);
      expect(await git(dir, "ls-files")).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps reporting every check when gh and the checkout are unavailable", async () => {
    const { status, report } = await run({
      "gh --version": null,
      "git rev-parse --show-toplevel": 128,
    });
    expect(status).toMatchObject({
      "gh.available": "missing",
      "gh.auth": "unknown",
      "project.checkout": "missing",
      "identity.file": "unknown",
      "identity.git-ignored": "unknown",
      "identity.git-tracked": "unknown",
      "triage.role": "unsupported",
    });
    expect(report.repository).toBeNull();
    expect(localDoctorExitCode(report)).toBe(1);
  });

  it("checks only the active GitHub account, not expired inactive ones", async () => {
    const r = await run({
      "gh auth status --active --hostname github.com": 0,
      "gh auth status --hostname github.com": 1,
    });
    expect(r.status["gh.auth"]).toBe("ok");
  });

  it("separates unauthenticated gh, missing identity file, unreadable file and old Node", async () => {
    expect(
      (await run({ "gh auth status --active --hostname github.com": 1 })).status["gh.auth"],
    ).toBe("access");
    expect((await run({}, null)).status["identity.file"]).toBe("missing");
    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    expect((await run({}, denied)).status["identity.file"]).toBe("access");
    expect((await run({}, undefined, {}, "20.11.0")).status["runtime.node"]).toBe("invalid");
  });

  it("treats an ambiguous project or mismatched --repo as unknown, not a guess", async () => {
    const { status, report } = await run({}, undefined, { repo: "other/repo" });
    expect(status["project.checkout"]).toBe("unknown");
    expect(report.repository).toBeNull();
  });

  it("validates --role against registered views and leaves identity unknown without --agent", async () => {
    const { status, report } = await run({}, undefined, { role: "agent" });
    expect(status["triage.role"]).toBe("invalid");
    expect(status["identity.agent"]).toBe("unknown");
    const role = report.checks.find((c) => c.id === "triage.role")!;
    expect(role.next).toContain("github-triage doctor --role implementer");
  });

  it("is wired into the CLI with versioned JSON", async () => {
    let out = "";
    const probe = async (command: string, args: readonly string[]) => {
      const key = [command, ...args].join(" ");
      return {
        code: key in base ? base[key]! : 0,
        stdout:
          key === "git rev-parse --show-toplevel"
            ? "/r\n"
            : key === "git remote -v"
              ? "origin\thttps://github.com/owner/name (fetch)\n"
              : "",
      };
    };
    const code = await main(
      ["doctor", "--json", "--agent", "a", "--role", "designer"],
      async (t) => void (out += t),
      {
        collect: async () => expect.fail("doctor must not collect"),
        currentRepository: async () => "owner/name",
        updateCheck: async () => ({ status: "skipped" }) as never,
        localDoctor: {
          cwd: "/r",
          probe,
          nodeVersion: "26.0.0",
          fs: { ...nodeFileSystem, readText: async () => null },
        },
      },
    );
    expect(JSON.parse(out)).toMatchObject({ schemaVersion: 1, scope: "local-configuration" });
    expect(code).toBe(1);
  });
});
