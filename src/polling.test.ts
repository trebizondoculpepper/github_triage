import { describe, expect, it } from "vite-plus/test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  chunkedTimeout,
  EventLog,
  eventsReport,
  maxTimerDelayMs,
  sharedCollect,
  Watcher,
} from "./polling.js";
import type { Clock, Collect, DomainEvent } from "./polling.js";
import { createServer, envelope, mcpArguments } from "./mcp.js";
import { RateLimitError } from "./dependencies.js";
import { rateLimitFailure } from "./github.js";
import type { McpRuntime } from "./mcp.js";
import type { Issue, Page, PullRequest, Snapshot } from "./types.js";

const repo = "example/project";
const start = Date.parse("2026-11-12T10:00:00.000Z");
const minute = 60 * 1000;
const page = <T>(nodes: T[], more = false): Page<T> => ({
  nodes,
  pageInfo: { hasNextPage: more, endCursor: null },
});
const issue = (number: number, labels: string[] = ["status:ready"]): Issue => ({
  number,
  title: `Ticket ${number}`,
  body: "",
  url: `https://github.com/${repo}/issues/${number}`,
  state: "OPEN",
  createdAt: new Date(start).toISOString(),
  updatedAt: new Date(start).toISOString(),
  issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
  blockedBy: page([]),
  blocking: page([]),
  labels: page(labels.map((name) => ({ name }))),
  comments: page([]),
});
const pr = (
  options: {
    head?: string;
    verify?: string;
    threads?: string[];
    labels?: string[];
    mergeable?: string;
  } = {},
): PullRequest => ({
  ...issue(40, options.labels ?? ["agent:ana"]),
  url: `https://github.com/${repo}/pull/40`,
  headRefOid: options.head ?? "aaa",
  headRefName: "feature",
  baseRefName: "main",
  isDraft: false,
  mergeable: options.mergeable ?? "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  closingIssuesReferences: page([]),
  reviewThreads: page(
    (options.threads ?? []).map((id) => ({
      isResolved: false,
      isOutdated: false,
      comments: page([
        {
          body: "finding",
          url: `https://github.com/${repo}/pull/40#discussion_${id}`,
          author: { login: "reviewer" },
          createdAt: new Date(start - 5 * minute).toISOString(),
        },
      ]),
    })),
  ),
  reviews: page([]),
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            state: "SUCCESS",
            contexts: page([
              {
                name: "verify",
                status: "COMPLETED",
                conclusion: options.verify ?? "SUCCESS",
                detailsUrl: "https://github.com/example/project/actions/runs/1",
              },
            ]),
          },
        },
      },
    ],
  },
});
const snap = (
  issues: Issue[] = [],
  prs: PullRequest[] = [],
  extra: Partial<Snapshot> = {},
): Snapshot => ({
  schemaVersion: 1,
  repository: repo,
  startedAt: new Date(start).toISOString(),
  fetchedAt: new Date(start).toISOString(),
  issues,
  pullRequests: prs,
  dependencies: [],
  changed: [],
  since: null,
  warnings: [],
  rateLimit: null,
  metrics: { requestCount: 3, durationMs: 1 },
  ...extra,
});

/** Fake clock: timers run only when the test advances time. */
function fakeClock() {
  let now = start;
  let id = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: Clock = {
    now: () => new Date(now),
    setTimeout: (run, ms) => {
      timers.set(++id, { at: now + ms, run });
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    clock,
    timers,
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
        await settle();
      }
      now = target;
      await settle();
    },
    pendingDelays: () => [...timers.values()].map((timer) => timer.at - now),
  };
}

/** A scripted collector: each call returns (or throws) the next scripted snapshot. */
function scripted(steps: (Snapshot | Error | (() => Promise<Snapshot>))[]) {
  const calls: { signal?: AbortSignal }[] = [];
  let last: Snapshot | Error | (() => Promise<Snapshot>) = steps[0];
  const collect: Collect = async (_repository, options) => {
    calls.push({ signal: options?.signal });
    const step = steps.shift() ?? last;
    last = step;
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step();
    return step;
  };
  return { collect, calls };
}

const watch = (collect: Collect, clock: Clock, intervalMinutes?: number) =>
  new Watcher(
    { repository: repo, intervalMinutes },
    { collect, clock, random: () => 0.5, generation: "gen1" },
  );
const kinds = (w: Watcher) => w.log.read(undefined, 100).items.map((event) => event.kind);

describe("optional polling and domain events (#32)", () => {
  it("does nothing before start, then polls on the default 30-minute interval", async () => {
    const time = fakeClock();
    const { collect, calls } = scripted([snap()]);
    const w = watch(collect, time.clock);
    await time.advance(120 * minute);
    expect(calls).toHaveLength(0);
    w.start();
    await time.advance(0);
    expect(calls).toHaveLength(1);
    expect(w.status()).toMatchObject({ state: "watching", intervalMinutes: 30 });
    await time.advance(29 * minute);
    expect(calls).toHaveLength(1);
    await time.advance(1 * minute);
    expect(calls).toHaveLength(2);
    w.stop();
  });

  it("validates interval options and requires --poll for an interval", () => {
    expect(mcpArguments(["--repo", repo])).not.toHaveProperty("poll");
    expect(mcpArguments(["--repo", repo, "--poll"])).toMatchObject({
      poll: true,
      pollIntervalMinutes: 30,
    });
    expect(mcpArguments(["--poll", "--poll-interval-minutes", "5"]).pollIntervalMinutes).toBe(5);
    expect(() => mcpArguments(["--poll-interval-minutes", "5"])).toThrow(/requires --poll/);
    for (const bad of ["0", "-1", "1.5", "x"])
      expect(() => mcpArguments(["--poll", "--poll-interval-minutes", bad])).toThrow();
    expect(() => watch(scripted([]).collect, fakeClock().clock, 0)).toThrow();
  });

  it("rejects intervals above 24 hours so the poll timer cannot overflow", () => {
    expect(mcpArguments(["--poll", "--poll-interval-minutes", "1440"]).pollIntervalMinutes).toBe(
      1440,
    );
    for (const big of ["1441", "43200"])
      expect(() => mcpArguments(["--poll", "--poll-interval-minutes", big])).toThrow(/1440/);
    expect(() => watch(scripted([]).collect, fakeClock().clock, 43200)).toThrow(/1440/);
  });

  it("chunks timer delays above 2^31-1 ms instead of letting Node clamp them to 1 ms", () => {
    const armed: { run: () => void; ms: number }[] = [];
    let fired = 0;
    const timers = {
      set: (run: () => void, ms: number) => {
        armed.push({ run, ms });
        return armed.length as unknown as ReturnType<typeof setTimeout>;
      },
      clear: () => {},
    };
    const total = 30 * 24 * 60 * minute; // 30 days
    chunkedTimeout(() => fired++, total, timers);
    let elapsed = 0;
    while (fired === 0) {
      const next = armed.at(-1)!;
      expect(next.ms).toBeLessThanOrEqual(maxTimerDelayMs);
      elapsed += next.ms;
      next.run();
    }
    expect(elapsed).toBe(total);
    expect(armed.length).toBeGreaterThan(1);
  });

  it("establishes a baseline without historical events and suppresses unchanged evidence", async () => {
    const time = fakeClock();
    const busy = snap([issue(1, ["attention:ana"])], [pr({ verify: "FAILURE", threads: ["1"] })]);
    const { collect } = scripted([busy, busy, busy]);
    const w = watch(collect, time.clock, 1);
    w.start();
    await time.advance(0);
    expect(w.status().baselineAt).not.toBeNull();
    expect(kinds(w)).toEqual([]);
    await time.advance(2 * minute);
    expect(kinds(w)).toEqual([]);
    w.stop();
  });

  it("emits each detector once with stable identity and distinct findings", async () => {
    const time = fakeClock();
    const steps = [
      snap([issue(1, ["status:needs-design"])], [pr({ threads: ["1"] })]),
      snap(
        [issue(1, ["status:ready", "attention:bo", "origin:ana"])],
        [pr({ threads: ["1", "2", "3"], verify: "FAILURE" })],
      ),
      snap(
        [issue(1, ["status:ready", "attention:bo", "origin:ana"])],
        [pr({ threads: ["1", "2", "3"], verify: "FAILURE" })],
      ),
      snap([issue(1, ["agent:ana"])], [pr({ head: "bbb" })]),
    ];
    const { collect } = scripted(steps);
    const w = watch(collect, time.clock, 1);
    w.start();
    await time.advance(0);
    await time.advance(minute);
    const second = w.log.read(undefined, 100).items;
    expect(second.map((event) => event.kind).sort()).toEqual([
      "attention-requested",
      "review-feedback",
      "review-feedback",
      "verification-problem",
      "work-became-eligible",
    ]);
    const attention = second.find((event) => event.kind === "attention-requested");
    expect(attention).toMatchObject({ destinations: ["bo"], origin: "ana" });
    const review = second.find((event) => event.kind === "review-feedback");
    expect(review).toMatchObject({ destinations: ["ana"], currentSha: "aaa" });
    expect(review?.sourceEventAt).not.toBe(review?.observedAt);
    expect(new Set(second.map((event) => event.eventId)).size).toBe(second.length);
    await time.advance(minute);
    expect(w.log.read(undefined, 100).items).toHaveLength(5);
    await time.advance(minute);
    // A new head that verifies is a new follow-up candidate; nothing claims or merges.
    expect(kinds(w).slice(5)).toEqual(["pr-follow-up-ready"]);
    expect(w.log.read(undefined, 100).items[5].currentSha).toBe("bbb");
    w.stop();
  });

  it("keeps distinct failed checks with the same name as separate evidence", async () => {
    const time = fakeClock();
    const failed = (id: number) => ({
      name: "test",
      status: "COMPLETED",
      conclusion: "FAILURE",
      detailsUrl: `https://github.com/${repo}/actions/runs/${id}/job/${id}`,
      databaseId: id,
    });
    const withChecks = (checks: ReturnType<typeof failed>[]): PullRequest => {
      const base = pr();
      base.commits.nodes[0].commit.statusCheckRollup!.contexts = page(checks);
      return base;
    };
    const one = snap([], [withChecks([failed(11)])]);
    const two = snap([], [withChecks([failed(11), failed(22)])]);
    const { collect } = scripted([one, two, two]);
    const w = watch(collect, time.clock, 1);
    w.start();
    await time.advance(0);
    expect(kinds(w)).toEqual([]);
    await time.advance(minute);
    const events = w.log.read(undefined, 100).items;
    expect(events.map((event) => event.kind)).toEqual(["verification-problem"]);
    expect(events[0].evidence).toEqual([`https://github.com/${repo}/actions/runs/22/job/22`]);
    await time.advance(minute);
    expect(kinds(w)).toHaveLength(1);
    w.stop();
  });

  it("gives a recurring transition a new identity but repeated reads the same one", async () => {
    const time = fakeClock();
    const failing = snap([], [pr({ verify: "FAILURE" })]);
    const pending = snap([], [pr({ verify: "IN_PROGRESS" })]);
    const { collect } = scripted([pending, failing, pending, pending, failing]);
    const w = watch(collect, time.clock, 1);
    w.start();
    for (let i = 0; i < 5; i++) await time.advance(i ? minute : 0);
    const events = w.log.read(undefined, 100).items;
    expect(events.map((event) => event.kind)).toEqual([
      "verification-problem",
      "verification-problem",
    ]);
    expect(events[0].eventId).not.toBe(events[1].eventId);
    w.stop();
  });

  it("never advances the baseline on incomplete data or invents eligibility", async () => {
    const time = fakeClock();
    const blocked = snap([issue(1, ["status:blocked"])]);
    const truncated = snap([issue(1)], [], { warnings: ["issues exceed the page bound"] });
    const unknownIssue = snap([issue(1)], [], {
      warnings: [`${issue(1).url}: labels exceed 100; label analysis incomplete.`],
    });
    const { collect } = scripted([blocked, truncated, unknownIssue, blocked]);
    const w = watch(collect, time.clock, 1);
    w.start();
    await time.advance(0);
    await time.advance(minute);
    expect(w.status().lastOutcome).toBe("incomplete");
    await time.advance(minute);
    await time.advance(minute);
    expect(kinds(w)).toEqual([]);
    const report = eventsReport(w, undefined, 20);
    expect(report.status?.baselineAt).toBe(new Date(start).toISOString());
    w.stop();
  });

  it("never establishes a subject baseline from incomplete evidence on the first poll", async () => {
    const time = fakeClock();
    const labelsCut = {
      warnings: [`${issue(1).url}: labels exceed 100; label analysis incomplete.`],
    };
    const { collect } = scripted([
      // The status:ready label sits on an unseen label page, so the issue reads ineligible.
      snap([issue(1, ["status:needs-design"])], [], labelsCut),
      snap([issue(1, ["status:ready"])]),
      snap([issue(1, ["status:needs-design"])]),
      snap([issue(1, ["status:ready"])]),
    ]);
    const w = watch(collect, time.clock, 1);
    w.start();
    await time.advance(0);
    expect(w.status()).toMatchObject({ lastOutcome: "incomplete", incompleteSubjects: 1 });
    expect(eventsReport(w, undefined, 20).complete).toBe(false);
    await time.advance(minute);
    // The first complete read establishes the subject silently; no artefactual transition.
    expect(kinds(w)).toEqual([]);
    expect(w.status()).toMatchObject({ lastOutcome: "complete", incompleteSubjects: 0 });
    await time.advance(minute);
    await time.advance(minute);
    // A genuine change after a complete baseline still emits.
    expect(kinds(w)).toEqual(["work-became-eligible"]);
    w.stop();
  });

  it("treats every issue as incomplete while any open PR's closing references are truncated", async () => {
    const time = fakeClock();
    const closing = (more: boolean) => ({
      ...pr(),
      closingIssuesReferences: page([{ number: 1, url: issue(1).url }], more),
    });
    const cut = (more: boolean) =>
      more
        ? {
            warnings: [
              `${pr().url}: closing references exceed 100; review/merge evidence incomplete.`,
            ],
          }
        : {};
    const truncated = { ...closing(true), closingIssuesReferences: page([], true) };
    const { collect } = scripted([
      snap([issue(1)], [closing(false)]),
      // The closing reference to #1 falls on an unseen page: #1 must not read as eligible.
      snap([issue(1)], [truncated], cut(true)),
      snap([issue(1)], [closing(false)]),
    ]);
    const w = watch(collect, time.clock, 1);
    w.start();
    await time.advance(0);
    await time.advance(minute);
    expect(kinds(w)).toEqual([]);
    expect(w.status()).toMatchObject({ lastOutcome: "incomplete" });
    await time.advance(minute);
    expect(kinds(w)).toEqual([]);
    w.stop();
  });

  it("does not report review threads hidden by truncation as new feedback", async () => {
    const time = fakeClock();
    const threadsCut = { warnings: [`${pr().url}: review threads exceed the page bound.`] };
    const { collect } = scripted([
      snap([], [pr({ threads: ["1"] })], threadsCut),
      snap([], [pr({ threads: ["1", "2", "3"] })]),
      snap([], [pr({ threads: ["1", "2", "3", "4"] })]),
    ]);
    const w = watch(collect, time.clock, 1);
    w.start();
    await time.advance(0);
    await time.advance(minute);
    expect(kinds(w)).toEqual([]);
    await time.advance(minute);
    expect(kinds(w)).toEqual(["review-feedback"]);
    w.stop();
  });

  it("diffs across a mid-stream incomplete read against the last complete baseline", async () => {
    const time = fakeClock();
    const labelsCut = {
      warnings: [`${issue(1).url}: labels exceed 100; label analysis incomplete.`],
    };
    const { collect } = scripted([
      snap([issue(1, ["status:needs-design"])]),
      snap([issue(1, ["status:ready"])], [], labelsCut),
      snap([issue(1, ["status:ready"])]),
    ]);
    const w = watch(collect, time.clock, 1);
    w.start();
    await time.advance(0);
    await time.advance(minute);
    expect(kinds(w)).toEqual([]);
    expect(w.status().incompleteSubjects).toBe(0);
    await time.advance(minute);
    // Both sides of the comparison are complete for the subject, so the real change emits.
    expect(kinds(w)).toEqual(["work-became-eligible"]);
    w.stop();
  });

  it("backs off with jitter on failures and waits for a rate-limit reset", async () => {
    const time = fakeClock();
    const reset = new Date(start + 45 * minute).toISOString();
    const { collect, calls } = scripted([
      snap([], [], { rateLimit: { remaining: 100, resetAt: reset } }),
      new Error("gh: connection refused"),
      new Error("gh: connection refused"),
      new Error("API rate limit exceeded"),
      snap(),
    ]);
    const w = watch(collect, time.clock, 1);
    w.start();
    await time.advance(0);
    await time.advance(minute);
    expect(w.status()).toMatchObject({ state: "backoff", lastOutcome: "failed" });
    expect(time.pendingDelays()).toEqual([45 * 1000]); // 60s * 2^0 * (0.5 + 0.5*0.5)
    await time.advance(45 * 1000);
    expect(time.pendingDelays()).toEqual([90 * 1000]);
    expect(w.status().backoff.consecutiveFailures).toBe(2);
    await time.advance(90 * 1000);
    expect(w.status().lastOutcome).toBe("rate-limited");
    await time.advance(3 * minute);
    expect(calls).toHaveLength(5);
    expect(w.status()).toMatchObject({ state: "watching", lastOutcome: "complete" });
    w.stop();
  });

  it("keeps a rate-limited failure's retry-after deadline across the collector boundary", async () => {
    const time = fakeClock();
    const { collect, calls } = scripted([
      snap(),
      new RateLimitError("GitHub query was rate limited.", { retryAfterSeconds: 120 }),
      snap(),
    ]);
    const w = watch(collect, time.clock, 1);
    w.start();
    await time.advance(0);
    await time.advance(minute);
    expect(w.status().lastOutcome).toBe("rate-limited");
    // Ordinary jitter would be 45 s with random()=0.5; retry-after 120 wins.
    expect(time.pendingDelays()).toEqual([120 * 1000]);
    await time.advance(119 * 1000);
    expect(calls).toHaveLength(2);
    await time.advance(1000);
    expect(calls).toHaveLength(3);
    w.stop();
  });

  it("extracts sanitized retry metadata from gh rate-limit output", () => {
    const limited = rateLimitFailure(
      "gh: You have exceeded a secondary rate limit (HTTP 403)\nretry-after: 120\ntoken ghp_secret",
      "",
    );
    expect(limited).toBeInstanceOf(RateLimitError);
    expect(limited?.retry).toEqual({ retryAfterSeconds: 120, resetAt: null });
    expect(limited?.message).not.toMatch(/ghp_|secondary/);
    const graphql = rateLimitFailure(
      "",
      JSON.stringify({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }),
    );
    expect(graphql?.retry).toEqual({ retryAfterSeconds: null, resetAt: null });
    expect(rateLimitFailure("gh: Could not resolve to a Repository", "")).toBeNull();
  });

  it("does not retry before an exhausted quota resets", async () => {
    const time = fakeClock();
    const reset = new Date(start + 40 * minute).toISOString();
    const { collect } = scripted([snap([], [], { rateLimit: { remaining: 0, resetAt: reset } })]);
    const w = watch(collect, time.clock, 1);
    w.start();
    await time.advance(0);
    expect(time.pendingDelays()).toEqual([40 * minute]);
    w.stop();
  });

  it("prevents overlapping polls and coalesces unfocused reads", async () => {
    const time = fakeClock();
    const releases: ((value: Snapshot) => void)[] = [];
    const slow: Collect = async () => new Promise<Snapshot>((resolve) => releases.push(resolve));
    const shared = sharedCollect(slow);
    const w = watch(shared, time.clock, 1);
    w.start();
    await time.advance(0);
    const again = w.poll();
    const reader = shared(repo, {});
    const focused = shared(repo, { issue: 3 });
    // One shared unfocused collection plus the separately requested focused read.
    expect(releases).toHaveLength(2);
    for (const release of releases) release(snap());
    await Promise.all([again, reader, focused]);
    expect(w.status().collecting).toBe(false);
    w.stop();
  });

  it("aborts sibling requests when a shared collection fails", async () => {
    let sibling: AbortSignal | undefined;
    // One request fails while its sibling is still paginating under the same signal.
    const partlyFailing: Collect = async (_repository, options) => {
      sibling = options?.signal;
      const paging = new Promise<void>((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve()),
      );
      void paging;
      throw new Error("one request failed");
    };
    const shared = sharedCollect(partlyFailing);
    await expect(shared(repo, {})).rejects.toThrow("one request failed");
    expect(sibling?.aborted).toBe(true);
  });

  it("cancels in-flight collection on stop and never polls afterwards", async () => {
    const time = fakeClock();
    const { collect, calls } = scripted([
      () => new Promise<Snapshot>(() => {}), // never resolves on its own
    ]);
    const hanging: Collect = (repository, options) =>
      new Promise<Snapshot>((resolve, reject) => {
        void collect(repository, options).then(resolve);
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const w = watch(hanging, time.clock, 1);
    w.start();
    await time.advance(0);
    expect(calls[0].signal?.aborted).toBe(false);
    w.stop();
    expect(calls[0].signal?.aborted).toBe(true);
    await time.advance(120 * minute);
    expect(calls).toHaveLength(1);
    expect(w.status().state).toBe("stopped");
    expect(time.timers.size).toBe(0);
  });

  it("bounds a hung collection by the poll timeout", async () => {
    const time = fakeClock();
    const hanging: Collect = (_repository, options) =>
      new Promise<Snapshot>((_resolve, reject) =>
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    const w = watch(hanging, time.clock, 1);
    w.start();
    await time.advance(0);
    await time.advance(10 * minute);
    expect(w.status().lastOutcome).toBe("failed");
    w.stop();
  });

  it("starts a fresh baseline and cursor generation after restart", async () => {
    const time = fakeClock();
    const first = watch(scripted([snap()]).collect, time.clock, 1);
    first.start();
    await time.advance(0);
    const cursor = first.log.read(undefined, 20).nextCursor;
    first.stop();
    const restarted = new Watcher(
      { repository: repo, intervalMinutes: 1 },
      {
        collect: scripted([snap([issue(1, ["attention:bo"])])]).collect,
        clock: time.clock,
        generation: "gen2",
      },
    );
    restarted.start();
    await time.advance(0);
    expect(kinds(restarted)).toEqual([]); // no invented offline history
    expect(restarted.log.read(cursor, 20)).toMatchObject({ resetRequired: true, items: [] });
    restarted.stop();
  });

  it("bounds retention by count and age and reports gaps instead of skipping", () => {
    let now = start;
    const log = new EventLog("g", () => new Date(now), 3, 60 * minute);
    const event = (n: number): Omit<DomainEvent, "sequence"> => ({
      schemaVersion: 1,
      eventId: `e${n}`,
      repository: repo,
      subject: { number: n, kind: "issue", url: `u${n}` },
      kind: "attention-requested",
      observedAt: new Date(now).toISOString(),
      sourceEventAt: null,
      evidence: [],
      currentSha: null,
      reviewedSha: null,
      reason: "r",
      destinations: [],
      origin: null,
      completeness: { complete: true, uncertainty: null },
    });
    log.append(event(1));
    const early = log.read(undefined, 10).nextCursor;
    for (let n = 2; n <= 5; n++) log.append(event(n));
    expect(log.size).toBe(3);
    expect(log.read(early, 10)).toMatchObject({ resetRequired: true });
    const fresh = log.read(undefined, 2);
    expect(fresh.items.map((item) => item.eventId)).toEqual(["e3", "e4"]);
    expect(fresh.more).toBe(true);
    expect(fresh.gap).toMatch(/evicted/);
    // Independent cursors: reading never consumes another reader's events.
    expect(log.read(fresh.nextCursor, 10).items.map((item) => item.eventId)).toEqual(["e5"]);
    expect(log.read(fresh.nextCursor, 10).items).toHaveLength(1);
    now += 61 * minute;
    expect(log.size).toBe(0);
    expect(log.read("garbage", 10).resetRequired).toBe(true);
  });

  it("suppresses only exact echoes of an agent's own mechanical writes", async () => {
    const time = fakeClock();
    const { collect } = scripted([
      snap([issue(1, ["status:needs-design"])], [pr()]),
      snap([issue(1, ["attention:ana", "attention:bo"])], [pr({ threads: ["9"] })]),
    ]);
    const w = new Watcher(
      { repository: repo, intervalMinutes: 1 },
      {
        collect,
        clock: time.clock,
        random: () => 0,
        // ana's own tool wrote attention:ana and nothing else.
        origins: {
          echoOf: (_r, _u, key) =>
            key === "attention/ana" ? "ana" : key.startsWith("thread/") ? "ana" : null,
        },
      },
    );
    w.start();
    await time.advance(0);
    await time.advance(minute);
    const events = w.log.read(undefined, 100).items;
    expect(
      events.filter((e) => e.kind === "attention-requested").map((e) => e.destinations),
    ).toEqual([["bo"]]);
    // Reviewer feedback is never treated as a mechanical echo.
    expect(events.find((e) => e.kind === "review-feedback")?.destinations).toEqual(["ana"]);
    expect(w.status().suppressedEchoes).toBe(1);
    w.stop();
  });

  it("publishes typed in-process events and survives a failing subscriber", async () => {
    const time = fakeClock();
    const { collect } = scripted([snap(), snap([issue(1, ["attention:bo"])])]);
    const w = watch(collect, time.clock, 1);
    const seen: string[] = [];
    w.subscribe(() => {
      throw new Error("adapter down");
    });
    w.subscribe((event) => seen.push(event.kind));
    w.start();
    await time.advance(0);
    await time.advance(minute);
    expect(seen).toEqual(["attention-requested"]);
    w.stop();
  });

  it("serves triage_events read-only over a real SDK client", async () => {
    const time = fakeClock();
    const { collect } = scripted([snap(), snap([issue(1, ["attention:bo"])])]);
    const w = watch(collect, time.clock, 1);
    const runtime = (watcher?: Watcher): McpRuntime => ({
      collect,
      dependencyReport: async () => {
        throw new Error("unused");
      },
      currentRepository: async () => repo,
      watcher,
    });
    const connect = async (r: McpRuntime) => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await createServer({ repo }, r).connect(serverSide);
      const client = new Client({ name: "test", version: "1.0.0" });
      await client.connect(clientSide);
      return client;
    };
    const disabled = await connect(runtime());
    const off = envelope.parse(
      (await disabled.callTool({ name: "triage_events", arguments: {} })).structuredContent,
    );
    expect(off).toMatchObject({ kind: "events", status: "incomplete", result: { enabled: false } });

    const client = await connect(runtime(w));
    const tools = await client.listTools();
    expect(
      tools.tools.find((tool) => tool.name === "triage_events")?.annotations?.readOnlyHint,
    ).toBe(true);
    w.start();
    await time.advance(0);
    await time.advance(minute);
    const call = async (args: Record<string, unknown>) =>
      envelope.parse(
        (await client.callTool({ name: "triage_events", arguments: args })).structuredContent,
      );
    const first = await call({ limit: 5 });
    expect(first).toMatchObject({ status: "complete", selection: { repository: repo } });
    const result = first.result as { items: DomainEvent[]; nextCursor: string; status: object };
    expect(result.items.map((item) => item.kind)).toEqual(["attention-requested"]);
    expect(result.status).toMatchObject({ baselineAt: new Date(start).toISOString() });
    // Nondestructive: a second reader without a cursor still sees the same event.
    expect(((await call({})).result as { items: unknown[] }).items).toHaveLength(1);
    expect(
      ((await call({ cursor: result.nextCursor })).result as { items: unknown[] }).items,
    ).toHaveLength(0);
    const bad = await client.callTool({ name: "triage_events", arguments: { limit: 101 } });
    expect(bad.isError).toBe(true);
    w.stop();
  });
});
