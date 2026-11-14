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
function fakeGitHub(log: string[], rateLimitAt?: string) {
  return async (args: string[]): Promise<GhResult> => {
    const a = args.join(" ");
    log.push(a);
    if (rateLimitAt && a.includes(rateLimitAt))
      return {
        exitCode: 1,
        stderr: "",
        stdout:
          'HTTP/2.0 403 Forbidden\nRetry-After: 60\nX-Ratelimit-Remaining: 4000\n\n{"message":"secondary rate limit"}',
      };
    if (a.endsWith(" user")) return ok({ login: "someone" });
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
