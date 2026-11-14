/**
 * Conditional refresh experiment runner (#202). Read-only; never writes to GitHub.
 *
 * Fixture mode (default, no network):
 *   npx tsx doc/reports/examples/cache-experiments/refresh-run.ts
 * Live mode (explicit, bounded, serial, uses the existing authenticated gh):
 *   npx tsx doc/reports/examples/cache-experiments/refresh-run.ts --live --repo OWNER/NAME \
 *     --state /path/outside/the/repo/state.json [--pr N --issue N] [--probe]
 * --state holds the previous manifest and ETags between runs; keep it out of Git. --probe adds
 * the one-off checks (GraphQL conditional headers, gh --cache, invalidation sample).
 * Every live run stops at the first rate-limit response.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  STRATEGIES,
  advanceManifest,
  applyConditional,
  classifyGh,
  coldCost,
  diffManifest,
  runScenarios,
  type GhResult,
  type HttpOutcome,
  type Manifest,
  type ManifestEntry,
  type ManifestPage,
  type StoredResource,
} from "./refresh.js";

type Gh = (args: string[]) => Promise<GhResult>;
const realGh: Gh = (args) =>
  new Promise((resolve) => {
    execFile("gh", args, { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
      resolve({ exitCode: code, stdout, stderr });
    });
  });

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

function fixtureReport(): void {
  const outcomes = runScenarios();
  const cold = coldCost();
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: "cache-experiment",
        experiment: "refresh",
        mode: "fixture (simulated units, not live measurements)",
        cold: { graphqlRequests: cold.graphqlRequests, bytes: cold.bytes },
        scenarios: outcomes.map((o) => ({
          id: o.id,
          name: o.name,
          bump: o.bump,
          pass: o.failures.length === 0,
          ...Object.fromEntries(
            STRATEGIES.map((st) => {
              const c = o.results[st];
              return [
                st,
                {
                  requests: c.graphqlRequests + c.restRequests,
                  graphqlPoints: c.graphqlPoints,
                  corePoints: c.corePoints,
                  notModified: c.notModified,
                  bytes: c.bytes,
                  validatedHits: c.validatedHits,
                  ttlHits: c.ttlHits,
                  liveFacts: c.liveFacts,
                  missed: c.missedChanges,
                },
              ];
            }),
          ),
        })),
      },
      null,
      2,
    ),
  );
  if (outcomes.some((o) => o.failures.length)) process.exitCode = 1;
}

interface LiveState {
  contextKey: string;
  manifest?: Manifest;
  resources: Record<string, StoredResource>;
}
interface Measure {
  label: string;
  status: number | string;
  exitCode: number;
  bytes: number;
  ms: number;
  point?: string;
  note?: string;
}

export class Live {
  readonly log: Measure[] = [];
  requests = { core: 0, graphql: 0 };
  constructor(
    readonly gh: Gh,
    readonly limit: number,
  ) {}
  async call(
    label: string,
    args: string[],
    resource: "core" | "graphql",
  ): Promise<{ out: HttpOutcome; raw: GhResult }> {
    if (this.requests.core + this.requests.graphql >= this.limit)
      throw new Error(`request budget of ${this.limit} reached`);
    this.requests[resource]++;
    const t0 = performance.now();
    const raw = await this.gh(["api", "-i", ...args]);
    const ms = Math.round(performance.now() - t0);
    const out = classifyGh(raw);
    const header = (h: string) => new RegExp(`^${h}: (.*)$`, "im").exec(raw.stdout)?.[1]?.trim();
    this.log.push({
      label,
      status: out.kind === "transport-error" ? "transport" : out.status,
      exitCode: raw.exitCode,
      bytes: Buffer.byteLength(raw.stdout),
      ms,
      point: header("x-ratelimit-remaining"),
      note:
        [header("etag") ? "etag" : "", header("last-modified") ? "last-modified" : ""]
          .filter(Boolean)
          .join("+") || undefined,
    });
    if (out.kind === "http-error" && out.rateLimited) throw new Error(`rate limited at ${label}`);
    return { out, raw };
  }
}

const MANIFEST_QUERY = (
  conn: "issues" | "pullRequests",
) => `query($owner:String!,$name:String!,$cursor:String){
  rateLimit{cost remaining}
  repository(owner:$owner,name:$name){ ${conn}(first:100,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){
    totalCount pageInfo{hasNextPage endCursor}
    nodes{ number state updatedAt ${conn === "pullRequests" ? "headRefOid" : ""} } } } }`;

export interface ManifestRead {
  manifest: Manifest | undefined; // the previous manifest when this read did not advance
  advanced: boolean;
  diagnostic?: string;
}

export async function readManifest(
  live: Live,
  owner: string,
  name: string,
  previous?: Manifest,
  maxPages = 10,
): Promise<ManifestRead> {
  const pages: ManifestPage[] = [];
  for (const conn of ["issues", "pullRequests"] as const) {
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const args = [
        "graphql",
        "-f",
        `query=${MANIFEST_QUERY(conn)}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
      ];
      if (cursor) args.push("-F", `cursor=${cursor}`);
      const { out } = await live.call(`manifest ${conn} p${page + 1}`, args, "graphql");
      if (out.kind !== "ok") {
        pages.push({ ok: false, entries: [], hasNextPage: false });
        break;
      }
      const json = JSON.parse(out.body);
      const c = json.data.repository[conn];
      live.log[live.log.length - 1]!.note =
        `cost ${json.data.rateLimit.cost}, total ${c.totalCount}`;
      const entries: ManifestEntry[] = c.nodes.map(
        (n: {
          number: number;
          state: ManifestEntry["state"];
          updatedAt: string;
          headRefOid?: string;
        }) => ({
          key: `${conn === "issues" ? "issue" : "pr"}#${n.number}`,
          state: n.state,
          updatedAt: Date.parse(n.updatedAt),
          headOid: n.headRefOid,
        }),
      );
      pages.push({ ok: true, entries, hasNextPage: c.pageInfo.hasNextPage });
      if (!c.pageInfo.hasNextPage) break;
      cursor = c.pageInfo.endCursor;
    }
    // A connection that did not finish within the page cap is an incomplete read.
    if (pages[pages.length - 1]?.hasNextPage)
      pages.push({ ok: false, entries: [], hasNextPage: false });
  }
  return advanceManifest(previous, pages, Date.now());
}

/**
 * Describe a manifest read for the report. A read that did not advance is reported as stale with
 * its diagnostic and the original observation time, never as an unchanged refresh.
 */
export function manifestStatus(read: ManifestRead): Record<string, unknown> {
  return {
    advanced: read.advanced,
    coverage: read.advanced ? "complete" : "stale",
    diagnostic: read.diagnostic,
    observedAt: read.manifest ? new Date(read.manifest.observedAt).toISOString() : null,
  };
}

async function liveRun(): Promise<void> {
  const repo = arg("--repo");
  const statePath = arg("--state");
  if (!repo || !statePath) throw new Error("--live requires --repo OWNER/NAME and --state PATH");
  const [owner, name] = repo.split("/") as [string, string];
  const login = (await realGh(["api", "user", "--jq", ".login"])).stdout.trim();
  const contextKey = `github.com|${repo}|${login}|refresh-v1`;
  const prior: LiveState = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : { contextKey, resources: {} };
  const state: LiveState = prior.contextKey === contextKey ? prior : { contextKey, resources: {} };
  const live = new Live(realGh, 60);
  const report: Record<string, unknown> = {
    repo,
    observedAt: new Date().toISOString(),
    ghLogin: "(omitted)",
  };
  const run = state.manifest ? "warm" : "cold";
  report.run = run;

  const read = await readManifest(live, owner, name, state.manifest);
  const manifest = read.manifest;
  report.manifest = manifestStatus(read);
  if (read.advanced && manifest && state.manifest)
    report.diff = diffManifest(state.manifest, manifest);
  report.manifestEntries = manifest?.entries.length;

  const pr = arg("--pr");
  const issue = arg("--issue");
  const base = `repos/${repo}`;
  const resources: Record<string, string> = {};
  if (issue) {
    resources.issue = `${base}/issues/${issue}`;
    resources.comments = `${base}/issues/${issue}/comments?per_page=100`;
    resources.timeline = `${base}/issues/${issue}/timeline?per_page=100`;
    resources.blocked_by = `${base}/issues/${issue}/dependencies/blocked_by`;
  }
  if (pr) {
    resources.pull = `${base}/pulls/${pr}`;
    resources.reviews = `${base}/pulls/${pr}/reviews?per_page=100`;
    resources["review-comments"] = `${base}/pulls/${pr}/comments?per_page=100`;
  }
  resources["issue-list"] = `${base}/issues?state=all&sort=updated&per_page=100`;
  const head = manifest?.entries.find((e) => e.key === `pr#${pr}`)?.headOid;
  if (head) resources["check-runs"] = `${base}/commits/${head}/check-runs?per_page=100`;

  const outcomes: Record<string, string> = {};
  for (const [label, path] of Object.entries(resources)) {
    const stored = state.resources[path];
    const args = stored ? ["-H", `If-None-Match: ${stored.etag}`, path] : [path];
    const { out } = await live.call(`${stored ? "conditional" : "full"} ${label}`, args, "core");
    const r = applyConditional(stored, contextKey, stored?.etag, out);
    outcomes[label] = r.kind === "miss" ? `miss: ${r.reason}` : r.kind;
    if (r.kind === "fresh" && r.etag)
      state.resources[path] = { contextKey, etag: r.etag, body: r.body };
    if (out.kind === "ok" && out.lastModified && process.argv.includes("--probe")) {
      const lm = await live.call(
        `if-modified-since ${label}`,
        ["-H", `If-Modified-Since: ${out.lastModified}`, path],
        "core",
      );
      outcomes[`${label} (If-Modified-Since)`] = lm.out.kind;
    }
  }
  report.conditional = outcomes;

  if (process.argv.includes("--probe")) {
    // GraphQL: does it return validators, and does it honour them?
    const q = ["graphql", "-f", "query={viewer{login}}"];
    const g1 = await live.call("graphql validators", q, "graphql");
    const etag = /^etag: (.*)$/im.exec(g1.raw.stdout)?.[1]?.trim();
    const lastMod = /^last-modified: (.*)$/im.exec(g1.raw.stdout)?.[1]?.trim();
    const g2 = await live.call(
      "graphql If-None-Match",
      [
        "-H",
        `If-None-Match: ${etag ?? 'W/"probe"'}`,
        "-H",
        `If-Modified-Since: ${lastMod ?? new Date().toUTCString()}`,
        ...q,
      ],
      "graphql",
    );
    report.graphql = {
      etag: etag ?? null,
      lastModified: lastMod ?? null,
      conditionalStatus: g2.out.kind === "transport-error" ? "transport" : g2.out.status,
    };

    // gh --cache: TTL reuse, no revalidation. Compare Date headers.
    const cached: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await live.call(
        `gh --cache 1h #${i + 1}`,
        ["--cache", "1h", `${base}/issues/${issue ?? 1}`],
        "core",
      );
      cached.push(/^date: (.*)$/im.exec(r.raw.stdout)?.[1]?.trim() ?? "");
    }
    report.ghCache = { dates: cached, servedFromDisk: cached[0] === cached[1] };

    // Invalidation sample: events timestamped after their subject's updatedAt.
    const recent = (manifest?.entries ?? [])
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 8);
    const late: Record<string, number> = {};
    const seen: Record<string, number> = {};
    for (const e of recent) {
      const n = e.key.split("#")[1];
      const { out } = await live.call(
        `timeline ${e.key}`,
        [`${base}/issues/${n}/timeline?per_page=100`],
        "core",
      );
      if (out.kind !== "ok") continue;
      for (const ev of JSON.parse(out.body) as {
        event: string;
        created_at?: string;
        submitted_at?: string;
        updated_at?: string;
      }[]) {
        const t = Date.parse(ev.updated_at ?? ev.submitted_at ?? ev.created_at ?? "");
        if (Number.isNaN(t)) continue;
        seen[ev.event] = (seen[ev.event] ?? 0) + 1;
        if (t > e.updatedAt + 1000) late[ev.event] = (late[ev.event] ?? 0) + 1;
      }
    }
    if (head && pr) {
      const prUpdated = manifest?.entries.find((e) => e.key === `pr#${pr}`)?.updatedAt ?? 0;
      const body = state.resources[resources["check-runs"]!]?.body;
      if (body)
        for (const run of (JSON.parse(body) as { check_runs: { completed_at: string | null }[] })
          .check_runs) {
          seen["check_run_completed"] = (seen["check_run_completed"] ?? 0) + 1;
          if (run.completed_at && Date.parse(run.completed_at) > prUpdated + 1000)
            late["check_run_completed"] = (late["check_run_completed"] ?? 0) + 1;
        }
    }
    report.invalidation = { subjects: recent.map((e) => e.key), seen, afterUpdatedAt: late };
  }

  if (manifest) state.manifest = manifest;
  writeFileSync(statePath, JSON.stringify(state));
  report.requests = live.requests;
  report.log = live.log;
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.includes("--live")) await liveRun();
  else fixtureReport();
}
