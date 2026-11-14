import { describe, expect, it } from "vite-plus/test";
import { Live, manifestStatus, readManifest } from "./refresh-run.js";
import type { GhResult, Manifest } from "./refresh.js";

const page = (conn: "issues" | "pullRequests", hasNextPage: boolean): GhResult => ({
  exitCode: 0,
  stderr: "",
  stdout:
    "HTTP/2.0 200 OK\n\n" +
    JSON.stringify({
      data: {
        rateLimit: { cost: 1, remaining: 4000 },
        repository: {
          [conn]: {
            totalCount: 1,
            pageInfo: { hasNextPage, endCursor: "c" },
            nodes: [{ number: 1, state: "OPEN", updatedAt: "2026-11-14T00:00:00Z" }],
          },
        },
      },
    }),
});

const previous: Manifest = { coverage: "complete", observedAt: 1000, entries: [] };

describe("live manifest read reporting (#202)", () => {
  it("reports a failed warm manifest page as stale with its diagnostic", async () => {
    const replies: GhResult[] = [
      page("issues", false),
      { exitCode: 1, stderr: "", stdout: "HTTP/2.0 502 Bad Gateway\n\n" },
    ];
    const read = await readManifest(new Live(async () => replies.shift()!, 10), "o", "n", previous);
    expect(read).toMatchObject({
      advanced: false,
      manifest: previous,
      diagnostic: "page 2 failed",
    });
    expect(manifestStatus(read)).toEqual({
      advanced: false,
      coverage: "stale",
      diagnostic: "page 2 failed",
      observedAt: new Date(1000).toISOString(),
    });
  });

  it("reports hitting the page cap as an incomplete, unadvanced read", async () => {
    const read = await readManifest(
      new Live(
        async (args) => page(args.join(" ").includes("issues(") ? "issues" : "pullRequests", true),
        10,
      ),
      "o",
      "n",
      previous,
      1,
    );
    expect(read.advanced).toBe(false);
    expect(read.diagnostic).toMatch(/failed/);
    expect(manifestStatus(read)).toMatchObject({ coverage: "stale" });
  });

  it("advances on a complete read", async () => {
    const replies = [page("issues", false), page("pullRequests", false)];
    const read = await readManifest(new Live(async () => replies.shift()!, 10), "o", "n", previous);
    expect(read.advanced).toBe(true);
    expect(read.manifest?.entries.map((e) => e.key)).toEqual(["issue#1", "pr#1"]);
  });
});
