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
 * Live runs follow doc/design/cache-experiments.md: at most ten requests and one page per source
 * per run, serial, stopping at the first rate-limit response. A manifest larger than one page is
 * therefore reported as partial (stale), never complete.
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
  source: string;
  status: number | string;
  exitCode: number;
  bytes: number;
  ms: number;
  point?: string;
  note?: string;
}

/** Limits from the experiment contract; one shared budget for every live request. */
export interface Limits {
  perSource: number; // requests per source per run
  pagesPerSource: number; // paginated pages per source per run
  total: number; // requests per run, across all sources
}
export const CONTRACT_LIMITS: Limits = { perSource: 10, pagesPerSource: 1, total: 60 };

/** Thrown instead of sending a request: budget exhausted or a rate limit already seen. */
export class LiveStop extends Error {}

export class Live {
  readonly log: Measure[] = [];
  readonly requests = { core: 0, graphql: 0 };
  readonly bySource: Record<string, number> = {};
  stopped?: string; // set on the first rate-limit response; no further requests are sent
  constructor(
    readonly gh: Gh,
    readonly limits: Limits = CONTRACT_LIMITS,
    /** Every request names this host explicitly, so GH_HOST cannot silently redirect it. */
    readonly host = "github.com",
  ) {}
  /** Throws LiveStop when this source or the run has no budget left; checked before sending. */
  reserve(source: string): void {
    if (this.stopped) throw new LiveStop(this.stopped);
    if (this.requests.core + this.requests.graphql >= this.limits.total)
      throw new LiveStop(`run budget of ${this.limits.total} requests reached`);
    if ((this.bySource[source] ?? 0) >= this.limits.perSource)
      throw new LiveStop(`${source}: budget of ${this.limits.perSource} requests reached`);
  }
  async call(
    label: string,
    args: string[],
    resource: "core" | "graphql",
    source: string,
  ): Promise<{ out: HttpOutcome; raw: GhResult }> {
    this.reserve(source);
    this.requests[resource]++;
    this.bySource[source] = (this.bySource[source] ?? 0) + 1;
    const t0 = performance.now();
    const raw = await this.gh(["api", "--hostname", this.host, "-i", ...args]);
    const ms = Math.round(performance.now() - t0);
    const out = classifyGh(raw);
    const header = (h: string) => headerOf(raw.stdout, h);
    this.log.push({
      label,
      source,
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
    if (out.kind === "http-error" && out.rateLimited) {
      this.stopped = `rate limited at ${label}`;
      throw new LiveStop(this.stopped);
    }
    // A response that spends the last request of the window is usable, but nothing more is sent.
    if (header("x-ratelimit-remaining") === "0") this.stopped = `rate limit exhausted at ${label}`;
    return { out, raw };
  }
}

const headerOf = (stdout: string, h: string): string | undefined =>
  new RegExp(`^${h}: (.*)$`, "im").exec(stdout.split(/\r?\n\r?\n/, 1)[0] ?? "")?.[1]?.trim();

/** True when a REST list response says more pages exist; one page then covers only part. */
const hasNextLink = (stdout: string): boolean => /rel="next"/.test(headerOf(stdout, "link") ?? "");

const MANIFEST_QUERY = (
  conn: "issues" | "pullRequests",
) => `query($owner:String!,$name:String!,$cursor:String){
  rateLimit{cost remaining}
  repository(owner:$owner,name:$name){ ${conn}(first:100,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}){
    totalCount pageInfo{hasNextPage endCursor}
    nodes{ number state updatedAt ${conn === "pullRequests" ? "headRefOid" : ""} } } } }`;

interface ConnectionPage {
  totalCount: number;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: {
    number: number;
    state: ManifestEntry["state"];
    updatedAt: string;
    headRefOid?: string;
  }[];
}

/** Validate a GraphQL envelope; anything unexpected is a failed page, never a crash. */
function connectionOf(
  body: string,
  conn: string,
): { page: ConnectionPage; cost?: number } | { error: string } {
  let json: {
    data?: { rateLimit?: { cost?: number }; repository?: Record<string, ConnectionPage> | null };
    errors?: { message?: string }[];
  };
  try {
    json = JSON.parse(body);
  } catch {
    return { error: "unparseable GraphQL response" };
  }
  if (json.errors?.length)
    return { error: `GraphQL errors: ${json.errors.map((e) => e.message ?? "?").join("; ")}` };
  const page = json.data?.repository?.[conn];
  if (!page || !Array.isArray(page.nodes) || typeof page.totalCount !== "number" || !page.pageInfo)
    return { error: `GraphQL response has no ${conn} connection` };
  return { page, cost: json.data?.rateLimit?.cost };
}

export interface ManifestRead {
  manifest: Manifest | undefined; // the previous manifest when this read did not advance
  advanced: boolean;
  diagnostic?: string;
  /** Entries actually observed this run, complete or not; for sampling only, never a manifest. */
  observed: ManifestEntry[];
}

export async function readManifest(
  live: Live,
  owner: string,
  name: string,
  previous?: Manifest,
): Promise<ManifestRead> {
  const pages: ManifestPage[] = [];
  const fail = (source: string, diagnostic: string) =>
    pages.push({ ok: false, entries: [], hasNextPage: false, source, diagnostic });
  for (const conn of ["issues", "pullRequests"] as const) {
    const source = `manifest:${conn}`;
    let cursor: string | undefined;
    for (let page = 1; ; page++) {
      if (page > live.limits.pagesPerSource) {
        fail(source, `${conn}: page limit of ${live.limits.pagesPerSource} reached; partial`);
        break;
      }
      const args = ["graphql", "-f", `query=${MANIFEST_QUERY(conn)}`];
      args.push("-F", `owner=${owner}`, "-F", `name=${name}`);
      if (cursor) args.push("-F", `cursor=${cursor}`);
      let out: HttpOutcome;
      try {
        out = (await live.call(`manifest ${conn} p${page}`, args, "graphql", source)).out;
      } catch (e) {
        if (!(e instanceof LiveStop)) throw e;
        fail(source, `${conn}: ${e.message}`);
        break;
      }
      if (out.kind !== "ok") {
        fail(
          source,
          `${conn}: page ${page} ${out.kind === "transport-error" ? out.message : `HTTP ${out.status}`}`,
        );
        break;
      }
      const parsed = connectionOf(out.body, conn);
      if ("error" in parsed) {
        fail(source, `${conn}: page ${page} ${parsed.error}`);
        break;
      }
      const c = parsed.page;
      live.log[live.log.length - 1]!.note = `cost ${parsed.cost ?? "?"}, total ${c.totalCount}`;
      pages.push({
        ok: true,
        source,
        totalCount: c.totalCount,
        hasNextPage: c.pageInfo.hasNextPage,
        entries: c.nodes.map((n) => ({
          key: `${conn === "issues" ? "issue" : "pr"}#${n.number}`,
          state: n.state,
          updatedAt: Date.parse(n.updatedAt),
          headOid: n.headRefOid,
        })),
      });
      if (!c.pageInfo.hasNextPage) break;
      if (!c.pageInfo.endCursor) {
        fail(source, `${conn}: hasNextPage without a cursor`);
        break;
      }
      cursor = c.pageInfo.endCursor;
    }
  }
  const observed = pages.flatMap((p) => p.entries);
  return { ...advanceManifest(previous, pages, Date.now()), observed };
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
    observedThisRun: read.observed.length,
  };
}

/** Restore saved state only if it is for this exact context and has the expected shape. */
export function validState(x: unknown, contextKey: string): LiveState | undefined {
  if (!x || typeof x !== "object") return undefined;
  const st = x as Record<string, unknown>;
  if (st.contextKey !== contextKey) return undefined;
  if (!st.resources || typeof st.resources !== "object" || Array.isArray(st.resources))
    return undefined;
  for (const v of Object.values(st.resources as Record<string, unknown>)) {
    const res = v as Partial<StoredResource> | null;
    if (
      !res ||
      res.contextKey !== contextKey ||
      typeof res.etag !== "string" ||
      typeof res.body !== "string" ||
      (res.coverage !== undefined && res.coverage !== "complete" && res.coverage !== "first-page")
    )
      return undefined;
  }
  if (st.manifest !== undefined) {
    const m = st.manifest as Partial<Manifest> | null;
    if (
      !m ||
      m.coverage !== "complete" ||
      typeof m.observedAt !== "number" ||
      !Array.isArray(m.entries) ||
      !m.entries.every(
        (e) =>
          e &&
          typeof e.key === "string" &&
          typeof e.state === "string" &&
          typeof e.updatedAt === "number" &&
          (e.headOid === undefined || e.headOid === null || typeof e.headOid === "string"),
      )
    )
      return undefined;
  }
  return st as unknown as LiveState;
}

/** Run one optional section; a budget or rate-limit stop is recorded, never a crash. */
async function section(
  skipped: Record<string, string>,
  name: string,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (e) {
    if (!(e instanceof LiveStop)) throw e;
    skipped[name] = e.message;
  }
}

export async function liveRun(
  gh: Gh = realGh,
  argv: string[] = process.argv,
  limits: Limits = CONTRACT_LIMITS,
): Promise<Record<string, unknown>> {
  const opt = (n: string) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const repo = opt("--repo");
  const statePath = opt("--state");
  if (!repo || !statePath) throw new Error("--live requires --repo OWNER/NAME and --state PATH");
  const [owner, name] = repo.split("/") as [string, string];
  const probe = argv.includes("--probe");
  // Bind requests and the context key to one explicit host; default is GH_HOST or github.com.
  const host = opt("--hostname") ?? process.env.GH_HOST ?? "github.com";
  const live = new Live(gh, limits, host);
  const report: Record<string, unknown> = {
    repo,
    observedAt: new Date().toISOString(),
    ghLogin: "(omitted)",
    host,
  };
  const skipped: Record<string, string> = {};
  report.skipped = skipped;
  const finish = () => {
    report.requests = { ...live.requests, bySource: live.bySource, limits: live.limits };
    if (live.stopped) report.stopped = live.stopped;
    report.log = live.log;
    return report;
  };

  // The login is part of the context key; it goes through the same budget.
  let login = "";
  await section(skipped, "auth", async () => {
    const { out } = await live.call("auth user", ["user"], "core", "auth");
    if (out.kind === "ok") login = (JSON.parse(out.body) as { login?: string }).login ?? "";
  });
  if (!login) {
    report.error = "authenticated login unknown; no reuse without a known context";
    return finish();
  }
  const contextKey = `${host}|${repo}|${login}|refresh-v1`;
  // A corrupt or foreign state file is a cache miss with a diagnostic, never a crash or reuse.
  let prior: Partial<LiveState> | undefined;
  try {
    prior = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : undefined;
  } catch {
    report.stateDiagnostic = "unreadable state file ignored";
  }
  const restored = prior === undefined ? undefined : validState(prior, contextKey);
  if (prior !== undefined && !restored && !report.stateDiagnostic)
    report.stateDiagnostic = "state for another context or of an invalid shape ignored";
  const state: LiveState = restored ?? { contextKey, resources: {} };
  report.run = state.manifest ? "warm" : "cold";

  const read = await readManifest(live, owner, name, state.manifest);
  const manifest = read.manifest;
  report.manifest = manifestStatus(read);
  if (read.advanced && manifest && state.manifest)
    report.diff = diffManifest(state.manifest, manifest);
  if (read.advanced && manifest) state.manifest = manifest;
  // Candidate subjects come from what was actually observed, complete or not.
  const observed = read.observed.length ? read.observed : (manifest?.entries ?? []);

  const pr = opt("--pr");
  const issue = opt("--issue");
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
  const head = observed.find((e) => e.key === `pr#${pr}`)?.headOid;
  if (head) resources["check-runs"] = `${base}/commits/${head}/check-runs?per_page=100`;

  const outcomes: Record<string, string> = {};
  report.conditional = outcomes;
  const lastModified: Record<string, string> = {};
  // Saved payloads are reused only for paths that returned 200 or a matching 304 on this run.
  const revalidated = new Set<string>();
  await section(skipped, "conditional", async () => {
    for (const [label, path] of Object.entries(resources)) {
      const stored = state.resources[path];
      const args = stored ? ["-H", `If-None-Match: ${stored.etag}`, path] : [path];
      const call = await live.call(
        `${stored ? "conditional" : "full"} ${label}`,
        args,
        "core",
        "rest",
      );
      const r = applyConditional(stored, contextKey, stored?.etag, call.out);
      if (r.kind === "fresh" || r.kind === "validated") revalidated.add(path);
      // One page only: a resource with more pages is partial evidence, whatever the validator
      // says. Coverage is stored with the payload, so a later 304 keeps the omission notice.
      const coverage =
        r.kind === "fresh"
          ? hasNextLink(call.raw.stdout)
            ? "first-page"
            : "complete"
          : r.kind === "validated"
            ? (stored?.coverage ?? "first-page") // unknown coverage is not complete
            : undefined;
      const partial = coverage === "first-page" ? " (first page only)" : "";
      outcomes[label] = (r.kind === "miss" ? `miss: ${r.reason}` : r.kind) + partial;
      if (r.kind === "fresh" && r.etag)
        state.resources[path] = { contextKey, etag: r.etag, body: r.body, coverage };
      if (call.out.kind === "ok" && call.out.lastModified)
        lastModified[label] = call.out.lastModified;
    }
  });

  if (probe) {
    await section(skipped, "if-modified-since", async () => {
      for (const [label, lm] of Object.entries(lastModified)) {
        const { out } = await live.call(
          `if-modified-since ${label}`,
          ["-H", `If-Modified-Since: ${lm}`, resources[label]!],
          "core",
          "probe:if-modified-since",
        );
        outcomes[`${label} (If-Modified-Since)`] = out.kind;
      }
    });

    await section(skipped, "graphql", async () => {
      // Does GraphQL return validators, and does it honour them?
      const q = ["graphql", "-f", "query={viewer{login}}"];
      const g1 = await live.call("graphql validators", q, "graphql", "probe:graphql");
      const etag = headerOf(g1.raw.stdout, "etag");
      const lastMod = headerOf(g1.raw.stdout, "last-modified");
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
        "probe:graphql",
      );
      report.graphql = {
        etag: etag ?? null,
        lastModified: lastMod ?? null,
        conditionalStatus: g2.out.kind === "transport-error" ? "transport" : g2.out.status,
      };
    });

    await section(skipped, "gh-cache", async () => {
      // gh --cache: TTL reuse, no revalidation. Compare Date headers. Both calls are budgeted,
      // although the second is expected to be served from disk.
      const dates: string[] = [];
      for (let i = 0; i < 2; i++) {
        const r = await live.call(
          `gh --cache 1h #${i + 1}`,
          ["--cache", "1h", `${base}/issues/${issue ?? 1}`],
          "core",
          "probe:gh-cache",
        );
        dates.push(headerOf(r.raw.stdout, "date") ?? "");
      }
      report.ghCache = { dates, servedFromDisk: dates[0] === dates[1] };
    });

    // Invalidation sample: events timestamped after their subject's updatedAt.
    const recent = observed
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 8);
    const late: Record<string, number> = {};
    const seen: Record<string, number> = {};
    const truncated: string[] = [];
    const sampled: string[] = [];
    report.invalidation = {
      subjects: sampled,
      seen,
      afterUpdatedAt: late,
      firstPageOnly: truncated,
    };
    await section(skipped, "invalidation", async () => {
      for (const e of recent) {
        const n = e.key.split("#")[1];
        const { out, raw } = await live.call(
          `timeline ${e.key}`,
          [`${base}/issues/${n}/timeline?per_page=100`],
          "core",
          "probe:invalidation",
        );
        if (out.kind !== "ok") continue;
        sampled.push(e.key);
        if (hasNextLink(raw.stdout)) truncated.push(e.key);
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
    });
    const checkRunsPath = resources["check-runs"];
    const checkRuns =
      checkRunsPath && revalidated.has(checkRunsPath) ? state.resources[checkRunsPath] : undefined;
    if (checkRunsPath && !checkRuns)
      (report.invalidation as Record<string, unknown>).checkRuns =
        `stale or unknown: ${outcomes["check-runs"] ?? "not read on this run"}`;
    const prUpdated = observed.find((e) => e.key === `pr#${pr}`)?.updatedAt;
    if (checkRuns && prUpdated !== undefined) {
      const body = JSON.parse(checkRuns.body) as {
        total_count: number;
        check_runs: { completed_at: string | null }[];
      };
      if (body.total_count > body.check_runs.length) truncated.push(`pr#${pr} check runs`);
      for (const run of body.check_runs) {
        seen["check_run_completed"] = (seen["check_run_completed"] ?? 0) + 1;
        if (run.completed_at && Date.parse(run.completed_at) > prUpdated + 1000)
          late["check_run_completed"] = (late["check_run_completed"] ?? 0) + 1;
      }
    }
  }

  writeFileSync(statePath, JSON.stringify(state));
  return finish();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.includes("--live")) console.log(JSON.stringify(await liveRun(), null, 2));
  else fixtureReport();
}
