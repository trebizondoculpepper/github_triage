import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  CONTRACT_LIMITS,
  Live,
  liveRun,
  manifestStatus,
  readManifest,
  validState,
  type Limits,
} from "./refresh-run.js";
import type { GhResult, Manifest } from "./refresh.js";

const ok = (body: unknown, headers = ""): GhResult => ({
  exitCode: 0,
  stderr: "",
  stdout: `HTTP/2.0 200 OK\n${headers}Etag: W/"e"\n\n${JSON.stringify(body)}`,
});

const page = (
  conn: "issues" | "pullRequests",
  numbers: number[],
  hasNextPage: boolean,
  totalCount = numbers.length,
): GhResult =>
  ok({
    data: {
      rateLimit: { cost: 1, remaining: 4000 },
      repository: {
        [conn]: {
          totalCount,
          pageInfo: { hasNextPage, endCursor: "c" },
          nodes: numbers.map((number) => ({
            number,
            state: "OPEN",
            updatedAt: "2026-11-14T00:00:00Z",
            headRefOid: conn === "pullRequests" ? "sha" : undefined,
          })),
        },
      },
    },
  });

const queue =
  (...replies: GhResult[]) =>
  async () =>
    replies.shift()!;
const two: Limits = { ...CONTRACT_LIMITS, pagesPerSource: 2 };
const previous: Manifest = { coverage: "complete", observedAt: 1000, entries: [] };

describe("live manifest read (#202)", () => {
  it("reports a failed warm manifest page as stale with its diagnostic", async () => {
    const gh = queue(page("issues", [1], false), {
      exitCode: 1,
      stderr: "",
      stdout: "HTTP/2.0 502 Bad Gateway\n\n",
    });
    const read = await readManifest(new Live(gh), "o", "n", previous);
    expect(read).toMatchObject({ advanced: false, manifest: previous });
    expect(manifestStatus(read)).toMatchObject({
      advanced: false,
      coverage: "stale",
      diagnostic: "pullRequests: page 1 HTTP 502",
      observedAt: new Date(1000).toISOString(),
    });
  });

  it("stops at the contract's one page per source and reports the read as partial", async () => {
    const calls: string[] = [];
    const gh = async (args: string[]) => {
      calls.push(args.join(" "));
      return page(args.join(" ").includes("issues(") ? "issues" : "pullRequests", [1], true, 150);
    };
    const read = await readManifest(new Live(gh), "o", "n", previous);
    expect(calls).toHaveLength(2); // one page per connection, never more
    expect(read.advanced).toBe(false);
    expect(read.diagnostic).toMatch(/page limit of 1 reached/);
    expect(read.observed).toHaveLength(2);
  });

  it("advances on a complete, count-consistent read", async () => {
    const read = await readManifest(
      new Live(queue(page("issues", [1], false), page("pullRequests", [1], false))),
      "o",
      "n",
      previous,
    );
    expect(read.advanced).toBe(true);
    expect(read.manifest?.entries.map((e) => e.key)).toEqual(["issue#1", "pr#1"]);
  });

  it("rejects overlapping pages whose entries fall short of totalCount", async () => {
    const gh = queue(
      page("issues", [1, 2], true, 4),
      page("issues", [2, 3], false, 4),
      page("pullRequests", [], false),
    );
    const read = await readManifest(new Live(gh, two), "o", "n", previous);
    expect(read).toMatchObject({
      advanced: false,
      manifest: previous,
      diagnostic: "manifest:issues: collected 3 of totalCount 4",
    });
  });

  it("rejects a totalCount that changes between pages", async () => {
    const gh = queue(
      page("issues", [1], true, 2),
      page("issues", [2], false, 3),
      page("pullRequests", [], false),
    );
    const read = await readManifest(new Live(gh, two), "o", "n", previous);
    expect(read.diagnostic).toMatch(/totalCount changed/);
  });

  it("routes a GraphQL 200 with errors and a null repository to the stale result", async () => {
    const gh = queue(
      ok({ data: { repository: null }, errors: [{ message: "Not found" }] }),
      page("pullRequests", [], false),
    );
    const read = await readManifest(new Live(gh), "o", "n", previous);
    expect(read).toMatchObject({ advanced: false, manifest: previous });
    expect(read.diagnostic).toBe("issues: page 1 GraphQL errors: Not found");
  });

  it("routes a GraphQL 200 with a null connection to the stale result", async () => {
    const gh = queue(
      ok({ data: { repository: { issues: null } } }),
      page("pullRequests", [], false),
    );
    const read = await readManifest(new Live(gh), "o", "n", previous);
    expect(read.diagnostic).toBe("issues: page 1 GraphQL response has no issues connection");
  });
});

/** A fake GitHub for whole live runs: every REST list says it has more pages. */
function fakeGitHub(
  log: string[],
  rateLimitAt?: string,
  override?: (a: string) => GhResult | undefined,
) {
  return async (args: string[]): Promise<GhResult> => {
    const a = args.join(" ");
    log.push(a);
    const o = override?.(a);
    if (o) return o;
    if (rateLimitAt && a.includes(rateLimitAt))
      return {
        exitCode: 1,
        stderr: "",
        stdout:
          'HTTP/2.0 403 Forbidden\nRetry-After: 60\nX-Ratelimit-Remaining: 4000\n\n{"message":"secondary rate limit"}',
      };
    if (a.endsWith(" user")) return ok({ login: "someone" });
    if (a.includes("If-None-Match") && !a.includes("graphql"))
      return {
        exitCode: 1,
        stderr: "gh: HTTP 304",
        stdout: 'HTTP/2.0 304 Not Modified\nEtag: W/"e"\n\n',
      };
    if (a.includes("issues(")) return page("issues", [1, 2], true, 150);
    if (a.includes("pullRequests(")) return page("pullRequests", [7], true, 150);
    if (a.includes("viewer")) return ok({ data: { viewer: { login: "someone" } } });
    if (a.includes("check-runs"))
      return ok({ total_count: 1, check_runs: [{ completed_at: "2026-11-15T00:00:00Z" }] });
    if (a.includes("/timeline") || a.includes("comments") || a.includes("reviews"))
      return ok([], 'Link: <https://x?page=2>; rel="next"\n');
    if (a.includes("issues?")) return ok([], 'Link: <https://x?page=2>; rel="next"\n');
    if (a.includes("blocked_by")) return ok([]);
    return ok({}, "Last-Modified: Sat, 14 Nov 2026 18:22:58 GMT\n");
  };
}

const args = (state: string) => [
  "--live",
  "--repo",
  "o/n",
  "--state",
  state,
  "--pr",
  "7",
  "--issue",
  "1",
  "--probe",
];
const tempState = () => join(mkdtempSync(join(tmpdir(), "refresh-run-")), "state.json");

describe("live run budget (#202)", () => {
  it("keeps a full probe run within the shared per-source, page and total limits", async () => {
    const log: string[] = [];
    const report = await liveRun(fakeGitHub(log), args(tempState()));
    const requests = report.requests as {
      core: number;
      graphql: number;
      bySource: Record<string, number>;
    };
    expect(log).toHaveLength(requests.core + requests.graphql);
    expect(log.length).toBeLessThanOrEqual(CONTRACT_LIMITS.total);
    for (const n of Object.values(requests.bySource))
      expect(n).toBeLessThanOrEqual(CONTRACT_LIMITS.perSource);
    expect(requests.bySource["manifest:issues"]).toBe(1);
    expect(requests.bySource["manifest:pullRequests"]).toBe(1);
    expect(report.manifest).toMatchObject({ advanced: false, coverage: "stale" });
    expect(report.diff).toBeUndefined();
    expect((report.conditional as Record<string, string>).comments).toBe("fresh (first page only)");
    expect(report.invalidation).toMatchObject({ firstPageOnly: ["issue#1", "issue#2", "pr#7"] });
  });

  it("stops every section once the run total is spent and reports what was skipped", async () => {
    const log: string[] = [];
    const report = await liveRun(fakeGitHub(log), args(tempState()), {
      perSource: 10,
      pagesPerSource: 1,
      total: 5,
    });
    expect(log).toHaveLength(5);
    expect(report.skipped).toMatchObject({ conditional: "run budget of 5 requests reached" });
  });

  it("sends nothing after a GraphQL RATE_LIMITED error", async () => {
    const log: string[] = [];
    const report = await liveRun(
      fakeGitHub(log, undefined, (a) =>
        a.includes("pullRequests(")
          ? ok({
              data: null,
              errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
            })
          : undefined,
      ),
      args(tempState()),
    );
    expect(log.at(-1)).toContain("pullRequests(");
    expect(report.stopped).toBe("rate limited at manifest pullRequests p1");
  });

  it("sends nothing after a 429 or after a response that spends the last request", async () => {
    const log: string[] = [];
    const report = await liveRun(
      fakeGitHub(log, undefined, (a) =>
        a.includes("/comments")
          ? { exitCode: 1, stderr: "", stdout: "HTTP/2.0 429 Too Many Requests\n\n{}" }
          : undefined,
      ),
      args(tempState()),
    );
    expect(log.at(-1)).toContain("/comments");
    expect(report.stopped).toBe("rate limited at full comments");
    const last: string[] = [];
    const spent = await liveRun(
      fakeGitHub(last, undefined, (a) =>
        a.includes("/comments") ? ok([], "X-Ratelimit-Remaining: 0\n") : undefined,
      ),
      args(tempState()),
    );
    expect(last.at(-1)).toContain("/comments");
    expect(spent.stopped).toBe("rate limit exhausted at full comments");
  });

  it("does not sample saved check runs unless they revalidated on this run", async () => {
    const state = tempState();
    await liveRun(fakeGitHub([]), args(state));
    const warm = await liveRun(
      fakeGitHub([], undefined, (a) =>
        a.includes("check-runs")
          ? { exitCode: 1, stderr: "", stdout: "HTTP/2.0 502 Bad Gateway\n\n" }
          : undefined,
      ),
      args(state),
    );
    const inv = warm.invalidation as { seen: Record<string, number>; checkRuns?: string };
    expect(inv.seen.check_run_completed).toBeUndefined();
    expect(inv.checkRuns).toBe("stale or unknown: miss: HTTP 502");
    const ok304 = await liveRun(fakeGitHub([]), args(state));
    expect((ok304.invalidation as { seen: Record<string, number> }).seen.check_run_completed).toBe(
      1,
    );
  });

  it("samples a fresh 200 without an ETag instead of the saved payload", async () => {
    const state = tempState();
    await liveRun(fakeGitHub([]), args(state));
    const runs = (n: number) => ({
      total_count: n,
      check_runs: Array.from({ length: n }, () => ({ completed_at: "2026-11-15T00:00:00Z" })),
    });
    const warm = await liveRun(
      fakeGitHub([], undefined, (a) =>
        a.includes("check-runs")
          ? { exitCode: 0, stderr: "", stdout: `HTTP/2.0 200 OK\n\n${JSON.stringify(runs(3))}` }
          : undefined,
      ),
      args(state),
    );
    expect((warm.conditional as Record<string, string>)["check-runs"]).toBe("fresh");
    expect((warm.invalidation as { seen: Record<string, number> }).seen.check_run_completed).toBe(
      3,
    );
    // The superseded validator is dropped, so the next run reads in full rather than revalidating.
    const log: string[] = [];
    await liveRun(fakeGitHub(log), args(state));
    expect(log.find((a) => a.includes("check-runs"))).not.toContain("If-None-Match");
  });

  it("counts only completed check runs and reports pending ones separately", async () => {
    const report = await liveRun(
      fakeGitHub([], undefined, (a) =>
        a.includes("check-runs")
          ? ok({
              total_count: 3,
              check_runs: [
                { completed_at: "2026-11-15T00:00:00Z" },
                { completed_at: null },
                { completed_at: null },
              ],
            })
          : undefined,
      ),
      args(tempState()),
    );
    expect(report.invalidation).toMatchObject({
      seen: { check_run_completed: 1 },
      afterUpdatedAt: { check_run_completed: 1 },
      checkRunsNotCompleted: 2,
    });
  });

  it("leaves stale manifest entries out of the invalidation measurements", async () => {
    const state = tempState();
    writeFileSync(
      state,
      JSON.stringify({
        contextKey: "github.com|o/n|someone|refresh-v1",
        resources: {},
        manifest: {
          coverage: "complete",
          observedAt: 1,
          entries: [
            { key: "issue#1", state: "OPEN", updatedAt: 1 },
            { key: "pr#7", state: "OPEN", updatedAt: 1, headOid: "sha" },
          ],
        },
      }),
    );
    const log: string[] = [];
    const bad: GhResult = { exitCode: 1, stderr: "", stdout: "HTTP/2.0 502 Bad Gateway\n\n" };
    const report = await liveRun(
      fakeGitHub(log, undefined, (a) => (a.includes("graphql -f query=query(") ? bad : undefined)),
      args(state),
    );
    expect(report.manifest).toMatchObject({ coverage: "stale", observedThisRun: 0 });
    expect(report.invalidation).toMatchObject({ subjects: [], seen: {}, afterUpdatedAt: {} });
    expect(log.some((a) => a.includes("/timeline") && !a.includes("issues/1/timeline"))).toBe(
      false,
    );
    expect(log.some((a) => a.includes("check-runs"))).toBe(false);
    expect(report.skipped).toMatchObject({
      "check-runs": expect.stringMatching(/head of pr#7 unknown/),
    });
    expect(report.ghCache).toMatchObject({ servedFromDisk: expect.stringMatching(/^unknown/) });
  });

  it("sends nothing after a secondary rate limit", async () => {
    const log: string[] = [];
    const report = await liveRun(fakeGitHub(log, "comments"), args(tempState()));
    expect(log.at(-1)).toContain("comments");
    expect(report.stopped).toBe("rate limited at full comments");
  });

  it("treats a corrupt state file as a miss", async () => {
    const state = tempState();
    writeFileSync(state, "{not json");
    const report = await liveRun(fakeGitHub([]), args(state));
    expect(report).toMatchObject({ run: "cold", stateDiagnostic: "unreadable state file ignored" });
  });

  it("keeps first-page-only coverage when a later read of the resource is a 304", async () => {
    const state = tempState();
    await liveRun(fakeGitHub([]), args(state));
    const warm = await liveRun(fakeGitHub([]), args(state));
    const outcomes = warm.conditional as Record<string, string>;
    expect(outcomes.comments).toBe("validated (first page only)");
    expect(outcomes.blocked_by).toBe("validated");
  });

  it("binds requests and the saved context to the host", async () => {
    const state = tempState();
    const log: string[] = [];
    await liveRun(fakeGitHub(log), args(state));
    expect(log.every((a) => a.startsWith("api --hostname github.com -i"))).toBe(true);
    const other: string[] = [];
    const report = await liveRun(fakeGitHub(other), [...args(state), "--hostname", "ghe.example"]);
    expect(other.every((a) => a.startsWith("api --hostname ghe.example -i"))).toBe(true);
    expect(report).toMatchObject({
      run: "cold",
      host: "ghe.example",
      stateDiagnostic: "state for another context or of an invalid shape ignored",
    });
    // No validator saved for github.com is sent to the other host (the GraphQL probe sends its own).
    expect(other.some((a) => a.includes("If-None-Match") && !a.includes("graphql"))).toBe(false);
  });

  it("treats a well-formed JSON state of the wrong shape as a miss", async () => {
    const state = tempState();
    writeFileSync(
      state,
      JSON.stringify({
        contextKey: "github.com|o/n|someone|refresh-v1",
        resources: {},
        manifest: { coverage: "complete", observedAt: 1, entries: null },
      }),
    );
    const report = await liveRun(fakeGitHub([]), args(state));
    expect(report).toMatchObject({ run: "cold" });
    expect(validState({ contextKey: "k", resources: { p: { etag: 1 } } }, "k")).toBeUndefined();
    expect(validState({ contextKey: "k", resources: {} }, "k")).toEqual({
      contextKey: "k",
      resources: {},
    });
  });

  it("does not reuse anything when the login is unknown", async () => {
    const log: string[] = [];
    const report = await liveRun(
      async (a) => (log.push(a.join(" ")), { exitCode: 1, stdout: "", stderr: "offline" }),
      args(tempState()),
    );
    expect(log).toHaveLength(1);
    expect(report.error).toMatch(/login unknown/);
  });
});
