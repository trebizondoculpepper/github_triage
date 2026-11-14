/**
 * Conditional refresh and lightweight manifest experiment (#202).
 *
 * Experimental, read-only and fixture-first, following doc/design/cache-experiments.md. Nothing
 * here is wired into the product. The fixture simulator models a synthetic repository and
 * compares refresh strategies on request counts, point cost, payload units and missed changes.
 * Simulated costs are model units, not live measurements; live figures come from
 * refresh-run.ts --live and are reported separately.
 */

/** Related facts, inventoried separately as #202 requires. */
export type FactKind =
  | "core" // title, body, state, labels
  | "assignees"
  | "comments"
  | "reviews"
  | "checks"
  | "dependencies"
  | "crossRefs"
  | "threads"
  | "mergeability";

export const ISSUE_FACTS: readonly FactKind[] = [
  "core",
  "assignees",
  "comments",
  "dependencies",
  "crossRefs",
];
export const PR_FACTS: readonly FactKind[] = [
  "core",
  "assignees",
  "comments",
  "reviews",
  "checks",
  "dependencies",
  "crossRefs",
  "threads",
  "mergeability",
];

/**
 * What can tell a cache that a fact is stale, from the #198 evidence. "updatedAt" means no
 * counterexample was observed for the events seen; "unknown" means the events were never
 * observed; "none" means a counterexample was observed or the fact is computed by GitHub.
 */
export const VALIDATOR: Record<FactKind, "updatedAt" | "unknown" | "none"> = {
  core: "updatedAt",
  comments: "updatedAt",
  reviews: "updatedAt",
  dependencies: "updatedAt",
  assignees: "unknown",
  checks: "none",
  crossRefs: "none",
  threads: "none",
  mergeability: "none",
};

/** Facts the recommended strategy reads live for every open subject, regardless of the manifest. */
export const ALWAYS_LIVE: readonly FactKind[] = ["checks", "crossRefs", "threads", "mergeability"];

/** Synthetic payload sizes (bytes) per fact, roughly scaled from the #198 snapshot figures. */
export const FACT_BYTES: Record<FactKind, number> = {
  core: 4000,
  assignees: 300,
  comments: 20000,
  reviews: 6000,
  checks: 3000,
  dependencies: 1500,
  crossRefs: 2000,
  threads: 2500,
  mergeability: 300,
};
const MANIFEST_ENTRY_BYTES = { issue: 70, pr: 125 } as const;
const HEADERS_ONLY_BYTES = 1200;
/** Per-item size of the REST issue list, from the live 100-item page (604 KB). */
const INVENTORY_ITEM_BYTES = 6000;

/** The REST resource that carries each fact; threads and mergeability have no REST validator. */
/**
 * The REST resource that carries a fact for a given subject. A PR's core facts, state and head
 * come from the pull resource; the issue resource does not return the head.
 */
export function restResourceFor(f: FactKind, kind: Subject["kind"]): string | undefined {
  const r = REST_RESOURCE[f];
  return r === "issue" && kind === "pr" ? "pull" : r;
}

export const REST_RESOURCE: Record<FactKind, string | undefined> = {
  core: "issue",
  assignees: "issue",
  comments: "comments",
  reviews: "reviews",
  checks: "check-runs",
  dependencies: "blocked_by",
  crossRefs: "timeline",
  threads: undefined,
  mergeability: undefined,
};

export type State = "OPEN" | "CLOSED" | "MERGED";
export interface Subject {
  key: string; // stable identity, e.g. "issue#12" or "pr#40"
  kind: "issue" | "pr";
  state: State;
  updatedAt: number; // fixture minutes
  headOid?: string;
  facts: Partial<Record<FactKind, string>>; // fact digest
}
export interface World {
  now: number;
  subjects: Subject[];
}

export interface ManifestEntry {
  key: string;
  state: State;
  updatedAt: number;
  headOid?: string;
}
export interface Manifest {
  coverage: "complete" | "partial";
  observedAt: number;
  entries: ManifestEntry[]; // deterministic order by key
}

export interface ManifestDiff {
  added: string[];
  changed: string[];
  removed: string[]; // only from a complete manifest
  absentUnknown: string[]; // absent from a partial manifest: proves nothing
}

export function manifestOf(world: World, coverage: Manifest["coverage"] = "complete"): Manifest {
  const entries = world.subjects
    .map(({ key, state, updatedAt, headOid }) => ({ key, state, updatedAt, headOid }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return { coverage, observedAt: world.now, entries };
}

export function diffManifest(previous: Manifest, next: Manifest): ManifestDiff {
  const before = new Map(previous.entries.map((e) => [e.key, e]));
  const after = new Map(next.entries.map((e) => [e.key, e]));
  const diff: ManifestDiff = { added: [], changed: [], removed: [], absentUnknown: [] };
  for (const [key, e] of after) {
    const old = before.get(key);
    if (!old) diff.added.push(key);
    else if (old.state !== e.state || old.updatedAt !== e.updatedAt || old.headOid !== e.headOid)
      diff.changed.push(key);
  }
  for (const key of before.keys())
    if (!after.has(key))
      (next.coverage === "complete" ? diff.removed : diff.absentUnknown).push(key);
  return diff;
}

/** One page of a paginated manifest read; a failed or cancelled page has no entries. */
export interface ManifestPage {
  ok: boolean;
  entries: ManifestEntry[];
  hasNextPage: boolean;
  /** Connection the page came from, e.g. "issues"; pages of one source are checked together. */
  source?: string;
  /** The connection's totalCount as reported on this page. */
  totalCount?: number;
  /** Why the page failed, when it did. */
  diagnostic?: string;
}

/**
 * Assemble pages into a manifest. A failed, cancelled, truncated or inconsistent read never
 * replaces the previous manifest and never advances the successful watermark. For each source,
 * every page must report the same totalCount and the deduplicated entries must match it;
 * otherwise pages overlapped or skipped items during the scan.
 */
export function advanceManifest(
  previous: Manifest | undefined,
  pages: ManifestPage[],
  observedAt: number,
): { manifest: Manifest | undefined; advanced: boolean; diagnostic?: string } {
  const stale = (diagnostic: string) => ({ manifest: previous, advanced: false, diagnostic });
  const failed = pages.findIndex((p) => !p.ok);
  if (failed >= 0) return stale(pages[failed]!.diagnostic ?? `page ${failed + 1} failed`);
  if (pages.length === 0 || pages[pages.length - 1]!.hasNextPage)
    return stale("pagination incomplete");
  const seen = new Map<string, ManifestEntry>();
  const bySource = new Map<string, { totals: Set<number>; keys: Set<string> }>();
  for (const p of pages) {
    for (const e of p.entries) seen.set(e.key, e); // dedupe overlap
    if (p.source === undefined) continue;
    const s = bySource.get(p.source) ?? { totals: new Set(), keys: new Set() };
    if (p.totalCount !== undefined) s.totals.add(p.totalCount);
    for (const e of p.entries) s.keys.add(e.key);
    bySource.set(p.source, s);
  }
  for (const [source, s] of bySource) {
    if (s.totals.size > 1)
      return stale(`${source}: totalCount changed during the scan (${[...s.totals].join(", ")})`);
    const [total] = [...s.totals];
    if (total !== undefined && total !== s.keys.size)
      return stale(`${source}: collected ${s.keys.size} of totalCount ${total}`);
  }
  const entries = [...seen.values()].sort((a, b) => a.key.localeCompare(b.key));
  return { manifest: { coverage: "complete", observedAt, entries }, advanced: true };
}

// ---------------------------------------------------------------------------------------------
// gh result classification

export interface GhResult {
  exitCode: number;
  stdout: string; // `gh api -i` output: status line, headers, blank line, body
  stderr: string;
}
export type HttpOutcome =
  | { kind: "ok"; status: number; etag?: string; lastModified?: string; body: string }
  | { kind: "not-modified"; status: 304 }
  | { kind: "http-error"; status: number; rateLimited: boolean }
  | { kind: "transport-error"; message: string };

/** Classify by the HTTP status line, not by gh's exit code (gh exits 1 on a 304). */
export function classifyGh(result: GhResult): HttpOutcome {
  const text = result.stdout.replace(/\r\n/g, "\n");
  const match = /^HTTP\/[\d.]+ (\d{3})/.exec(text);
  if (!match)
    return { kind: "transport-error", message: result.stderr.trim() || `exit ${result.exitCode}` };
  const status = Number(match[1]);
  const split = text.indexOf("\n\n");
  const headerText = split >= 0 ? text.slice(0, split) : text;
  const body = split >= 0 ? text.slice(split + 2) : "";
  const headers = new Map<string, string>();
  for (const line of headerText.split("\n").slice(1)) {
    const i = line.indexOf(":");
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  if (status === 304) return { kind: "not-modified", status: 304 };
  // GraphQL reports its rate limit as HTTP 200 with an errors entry of type RATE_LIMITED.
  if (status >= 200 && status < 300 && /"type"\s*:\s*"RATE_LIMITED"/.test(body))
    return { kind: "http-error", status, rateLimited: true };
  if (status >= 200 && status < 300)
    return {
      kind: "ok",
      status,
      etag: headers.get("etag"),
      lastModified: headers.get("last-modified"),
      body,
    };
  // Primary exhaustion, or a secondary limit: a Retry-After hint or the secondary-limit message
  // while the primary remaining count is still non-zero.
  const rateLimited =
    status === 429 ||
    (status === 403 &&
      (headers.get("x-ratelimit-remaining") === "0" ||
        headers.has("retry-after") ||
        /secondary rate limit/i.test(body)));
  return { kind: "http-error", status, rateLimited };
}

export interface StoredResource {
  contextKey: string;
  etag: string;
  body: string;
  /** "first-page" when the stored body was one page of a longer list; kept across 304s. */
  coverage?: "complete" | "first-page";
}
export type Revalidation =
  | { kind: "validated"; body: string }
  | { kind: "fresh"; body: string; etag?: string }
  | { kind: "miss"; reason: string };

/**
 * Apply a conditional read's outcome. A 304 reuses only the exact stored resource for the same
 * context and validator; a 304 without a matching payload is a miss, never empty evidence.
 */
export function applyConditional(
  stored: StoredResource | undefined,
  contextKey: string,
  sentEtag: string | undefined,
  outcome: HttpOutcome,
): Revalidation {
  if (outcome.kind === "ok") return { kind: "fresh", body: outcome.body, etag: outcome.etag };
  if (outcome.kind === "not-modified") {
    if (!stored || !sentEtag) return { kind: "miss", reason: "304 without a stored payload" };
    if (stored.contextKey !== contextKey)
      return { kind: "miss", reason: "304 for another context" };
    if (stored.etag !== sentEtag) return { kind: "miss", reason: "304 for a different validator" };
    return { kind: "validated", body: stored.body };
  }
  if (outcome.kind === "http-error")
    return {
      kind: "miss",
      reason: `HTTP ${outcome.status}${outcome.rateLimited ? " rate limited" : ""}`,
    };
  return { kind: "miss", reason: outcome.message };
}

// ---------------------------------------------------------------------------------------------
// Fixture simulator

export type StrategyId = "full" | "ttl" | "manifest" | "manifest+live" | "conditional";
export const STRATEGIES: readonly StrategyId[] = [
  "full",
  "ttl",
  "manifest",
  "manifest+live",
  "conditional",
];

export interface Counters {
  graphqlRequests: number;
  graphqlPoints: number;
  restRequests: number;
  corePoints: number; // 304s are free
  notModified: number;
  bytes: number;
  validatedHits: number; // facts reused after a successful revalidation
  ttlHits: number; // facts reused with no revalidation (stale/unvalidated)
  liveFacts: number; // facts read fresh
  reconciliations: number; // timed or coverage-gap full re-reads
  missedChanges: number; // facts whose reused value differs from truth
  missedFacts: string[];
}

function zero(): Counters {
  return {
    graphqlRequests: 0,
    graphqlPoints: 0,
    restRequests: 0,
    corePoints: 0,
    notModified: 0,
    bytes: 0,
    validatedHits: 0,
    ttlHits: 0,
    liveFacts: 0,
    reconciliations: 0,
    missedChanges: 0,
    missedFacts: [],
  };
}

const factsOf = (s: Subject): readonly FactKind[] => (s.kind === "pr" ? PR_FACTS : ISSUE_FACTS);
/** Experimental control from the contract: full selected re-read at least every 30 minutes. */
export const RECONCILE_MINUTES = 30;
const GRAPHQL_FULL_PAGE = 25; // nested selections force small pages
const GRAPHQL_MANIFEST_PAGE = 100;

function chunks(n: number, size: number): number {
  return Math.ceil(n / size);
}

/** Read every subject and every fact. The baseline every warm strategy is compared with. */
function fullRead(world: World, c: Counters): Map<string, Subject> {
  for (const kind of ["issue", "pr"] as const) {
    const n = world.subjects.filter((s) => s.kind === kind).length;
    const pages = Math.max(1, chunks(n, GRAPHQL_FULL_PAGE));
    c.graphqlRequests += pages;
    c.graphqlPoints += pages;
  }
  for (const s of world.subjects)
    for (const f of factsOf(s)) {
      c.bytes += FACT_BYTES[f];
      c.liveFacts++;
    }
  return new Map(world.subjects.map((s) => [s.key, structuredClone(s)]));
}

function manifestRead(world: World, c: Counters): Manifest {
  for (const kind of ["issue", "pr"] as const) {
    const n = world.subjects.filter((s) => s.kind === kind).length;
    const pages = Math.max(1, chunks(n, GRAPHQL_MANIFEST_PAGE));
    c.graphqlRequests += pages;
    c.graphqlPoints += pages;
    c.bytes += n * MANIFEST_ENTRY_BYTES[kind];
  }
  return manifestOf(world);
}

function compare(view: Map<string, Subject>, truth: World, c: Counters): void {
  for (const s of truth.subjects) {
    const seen = view.get(s.key);
    for (const f of factsOf(s))
      if (!seen || seen.facts[f] !== s.facts[f]) {
        c.missedChanges++;
        c.missedFacts.push(`${s.key}.${f}`);
      }
    if (seen && seen.state !== s.state) {
      c.missedChanges++;
      c.missedFacts.push(`${s.key}.state`);
    }
    if (seen && seen.headOid !== s.headOid) {
      c.missedChanges++;
      c.missedFacts.push(`${s.key}.head`);
    }
  }
  for (const key of view.keys())
    if (!truth.subjects.some((s) => s.key === key)) {
      c.missedChanges++;
      c.missedFacts.push(`${key}.deleted`);
    }
}

/**
 * Run a warm refresh of `next` from a cache populated by a cold read of `previous`.
 * `ttlFresh` says whether the cached snapshot is still inside the gh --cache TTL.
 */
export function warmRefresh(
  strategy: StrategyId,
  previous: World,
  next: World,
  options: { manifestCoverage?: Manifest["coverage"]; ttlFresh?: boolean } = {},
): Counters {
  const c = zero();
  const cached = new Map(previous.subjects.map((s) => [s.key, structuredClone(s)]));
  let view: Map<string, Subject>;
  switch (strategy) {
    case "full":
      view = fullRead(next, c);
      break;
    case "ttl":
      if (options.ttlFresh === false) {
        view = fullRead(next, c);
        break;
      }
      view = cached;
      for (const s of cached.values()) c.ttlHits += factsOf(s).length;
      break;
    case "manifest":
    case "manifest+live": {
      const prior = manifestOf(previous);
      let current = manifestRead(next, c);
      if (options.manifestCoverage === "partial")
        current = {
          ...current,
          coverage: "partial",
          entries: current.entries.slice(0, Math.ceil(current.entries.length / 2)),
        };
      // Reconcile with a full re-read when the last full read is older than the interval or the
      // manifest has a coverage gap; reused facts are only validated inside that window.
      if (next.now - previous.now >= RECONCILE_MINUTES || current.coverage !== "complete") {
        c.reconciliations++;
        view = fullRead(next, c);
        break;
      }
      const diff = diffManifest(prior, current);
      view = cached;
      for (const key of diff.removed) view.delete(key);
      const hydrate = [...diff.added, ...diff.changed];
      if (hydrate.length) {
        const pages = chunks(hydrate.length, GRAPHQL_FULL_PAGE);
        c.graphqlRequests += pages;
        c.graphqlPoints += pages;
      }
      const hydrated = new Set(hydrate);
      for (const key of hydrate) {
        const s = next.subjects.find((x) => x.key === key)!;
        view.set(key, structuredClone(s));
        for (const f of factsOf(s)) {
          c.bytes += FACT_BYTES[f];
          c.liveFacts++;
        }
      }
      const live = strategy === "manifest+live";
      const openUnhydrated = next.subjects.filter(
        (s) => s.state === "OPEN" && !hydrated.has(s.key) && view.has(s.key),
      );
      if (live && openUnhydrated.length) {
        const pages = chunks(openUnhydrated.length, GRAPHQL_FULL_PAGE);
        c.graphqlRequests += pages;
        c.graphqlPoints += pages;
      }
      for (const [key, s] of view) {
        if (hydrated.has(key)) continue;
        const truth = next.subjects.find((x) => x.key === key);
        for (const f of factsOf(s)) {
          if (live && truth?.state === "OPEN" && ALWAYS_LIVE.includes(f)) {
            s.facts[f] = truth.facts[f];
            c.bytes += FACT_BYTES[f];
            c.liveFacts++;
          } else c.validatedHits++;
        }
      }
      break;
    }
    case "conditional": {
      // One REST request per (subject, resource); 304 when the resource is unchanged. Threads
      // and mergeability have no REST validator, so open PRs read them live by GraphQL.
      view = new Map();
      // Inventory discovery: a conditional read of the REST issue list (which includes PRs),
      // 100 per page. It returns 200 when any subject was added, removed or updated, else 304.
      // Subjects not in the cache are only known through this read.
      const inventoryPages = Math.max(1, chunks(next.subjects.length, GRAPHQL_MANIFEST_PAGE));
      const inventory = diffManifest(manifestOf(previous), manifestOf(next));
      const inventoryChanged =
        inventory.added.length + inventory.changed.length + inventory.removed.length > 0;
      c.restRequests += inventoryPages;
      if (inventoryChanged) {
        c.corePoints += inventoryPages;
        c.bytes += next.subjects.length * INVENTORY_ITEM_BYTES;
      } else {
        c.notModified += inventoryPages;
        c.bytes += inventoryPages * HEADERS_ONLY_BYTES;
      }
      const openPrs = next.subjects.filter((s) => s.kind === "pr" && s.state === "OPEN");
      if (openPrs.length) {
        const pages = chunks(openPrs.length, GRAPHQL_FULL_PAGE);
        c.graphqlRequests += pages;
        c.graphqlPoints += pages;
      }
      for (const s of next.subjects) {
        const old = cached.get(s.key);
        const copy = structuredClone(old ?? s);
        const resources = new Map<string, FactKind[]>();
        for (const f of factsOf(s)) {
          const r = restResourceFor(f, s.kind);
          if (!r) {
            if (s.state === "OPEN" || !old) {
              copy.facts[f] = s.facts[f];
              c.bytes += FACT_BYTES[f];
              c.liveFacts++;
            } else c.validatedHits++;
            continue;
          }
          resources.set(r, [...(resources.get(r) ?? []), f]);
        }
        for (const [resource, facts] of resources) {
          c.restRequests++;
          // The issue resource carries state; the pull resource carries state and the PR head.
          const meta =
            (resource === "issue" && old?.state !== s.state) ||
            (resource === "pull" && (old?.state !== s.state || old?.headOid !== s.headOid));
          const changed = !old || meta || facts.some((f) => old.facts[f] !== s.facts[f]);
          if (changed) {
            c.corePoints++;
            if (resource === "issue") copy.state = s.state;
            if (resource === "pull") Object.assign(copy, { state: s.state, headOid: s.headOid });
            for (const f of facts) {
              copy.facts[f] = s.facts[f];
              c.bytes += FACT_BYTES[f];
              c.liveFacts++;
            }
          } else {
            c.notModified++;
            c.bytes += HEADERS_ONLY_BYTES;
            c.validatedHits += facts.length;
          }
        }
        view.set(s.key, copy);
      }
      // A deleted or transferred subject 404s on its next conditional read.
      c.restRequests += [...cached.keys()].filter(
        (k) => !next.subjects.some((s) => s.key === k),
      ).length;
      break;
    }
  }
  compare(view, next, c);
  return c;
}

// ---------------------------------------------------------------------------------------------
// Synthetic fixture and missed-change matrix

/** 30 issues (10 open) and 20 PRs (3 open); synthetic records only. */
export function baselineWorld(): World {
  const subjects: Subject[] = [];
  for (let i = 1; i <= 30; i++) {
    const facts: Subject["facts"] = {};
    for (const f of ISSUE_FACTS) facts[f] = `${f}-v1`;
    subjects.push({
      key: `issue#${i}`,
      kind: "issue",
      state: i <= 10 ? "OPEN" : "CLOSED",
      updatedAt: i,
      facts,
    });
  }
  for (let i = 1; i <= 20; i++) {
    const facts: Subject["facts"] = {};
    for (const f of PR_FACTS) facts[f] = `${f}-v1`;
    subjects.push({
      key: `pr#${100 + i}`,
      kind: "pr",
      state: i <= 3 ? "OPEN" : "MERGED",
      updatedAt: i,
      headOid: `sha-${i}`,
      facts,
    });
  }
  return { now: 100, subjects };
}

export interface Scenario {
  id: string;
  name: string;
  /** Whether GitHub moves updatedAt for this change: observed in #198, or a worst-case assumption. */
  bump: "observed" | "observed-not" | "assumed-not";
  apply(world: World): void;
  /** Expected missed changes per strategy, frozen before evaluation. */
  expected: Record<StrategyId, number>;
  manifestCoverage?: Manifest["coverage"];
  /** Fixture minutes since the cache's last full read; defaults to 5 (inside the interval). */
  elapsed?: number;
}

function edit(world: World, key: string, fact: FactKind, bump: boolean): void {
  const s = world.subjects.find((x) => x.key === key)!;
  s.facts[fact] = `${fact}-v2`;
  if (bump) s.updatedAt = world.now;
}

const MISSED = (manifest: number, live: number, ttl = 1): Record<StrategyId, number> => ({
  full: 0,
  ttl,
  manifest,
  "manifest+live": live,
  conditional: 0,
});

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "R0",
    name: "nothing changed",
    bump: "observed",
    apply: () => {},
    expected: MISSED(0, 0, 0),
  },
  {
    id: "R1",
    name: "issue comment added",
    bump: "observed",
    apply: (w) => edit(w, "issue#3", "comments", true),
    expected: MISSED(0, 0),
  },
  {
    id: "R2",
    name: "comment edited",
    bump: "observed",
    apply: (w) => edit(w, "issue#4", "comments", true),
    expected: MISSED(0, 0),
  },
  {
    id: "R3",
    name: "label or title changed",
    bump: "observed",
    apply: (w) => edit(w, "issue#5", "core", true),
    expected: MISSED(0, 0),
  },
  {
    id: "R4",
    name: "PR head changed (new commit, new checks)",
    bump: "observed",
    apply: (w) => {
      const s = w.subjects.find((x) => x.key === "pr#101")!;
      s.headOid = "sha-new";
      s.facts.checks = "checks-v2";
      s.facts.mergeability = "mergeability-v2";
      s.updatedAt = w.now;
    },
    expected: MISSED(0, 0, 3),
  },
  {
    id: "R5",
    name: "CI re-run completes on the same head",
    bump: "observed-not",
    apply: (w) => edit(w, "pr#102", "checks", false),
    expected: MISSED(1, 0),
  },
  {
    id: "R6",
    name: "review thread resolved",
    bump: "assumed-not",
    apply: (w) => edit(w, "pr#102", "threads", false),
    expected: MISSED(1, 0),
  },
  {
    id: "R7",
    name: "closing/cross reference added from elsewhere",
    bump: "observed-not",
    apply: (w) => edit(w, "issue#6", "crossRefs", false),
    expected: MISSED(1, 0),
  },
  {
    id: "R8",
    name: "base branch protection changes mergeability",
    bump: "assumed-not",
    apply: (w) => edit(w, "pr#103", "mergeability", false),
    expected: MISSED(1, 0),
  },
  {
    id: "R9",
    name: "native blocked-by edge removed",
    bump: "assumed-not",
    apply: (w) => edit(w, "issue#7", "dependencies", false),
    expected: MISSED(1, 1),
  },
  {
    id: "R10",
    name: "review dismissed",
    bump: "assumed-not",
    apply: (w) => edit(w, "pr#101", "reviews", false),
    expected: MISSED(1, 1),
  },
  {
    id: "R11",
    name: "assignment changed",
    bump: "assumed-not",
    apply: (w) => edit(w, "issue#8", "assignees", false),
    expected: MISSED(1, 1),
  },
  {
    id: "R12",
    name: "issue reopened",
    bump: "observed",
    apply: (w) => {
      const s = w.subjects.find((x) => x.key === "issue#20")!;
      s.state = "OPEN";
      s.updatedAt = w.now;
    },
    expected: MISSED(0, 0),
  },
  {
    id: "R13",
    name: "issue transferred or deleted (complete manifest)",
    bump: "observed",
    apply: (w) => {
      w.subjects = w.subjects.filter((s) => s.key !== "issue#9");
    },
    expected: MISSED(0, 0),
  },
  {
    id: "R14",
    name: "issue deleted but the manifest read was partial",
    bump: "observed",
    manifestCoverage: "partial",
    apply: (w) => {
      w.subjects = w.subjects.filter((s) => s.key !== "pr#120");
    },
    // Absence from a partial manifest proves nothing; the coverage gap forces a full re-read.
    expected: MISSED(0, 0),
  },
  {
    id: "R15",
    name: "new issue created",
    bump: "observed",
    apply: (w) => {
      const facts: Subject["facts"] = {};
      for (const f of ISSUE_FACTS) facts[f] = `${f}-v1`;
      w.subjects.push({ key: "issue#31", kind: "issue", state: "OPEN", updatedAt: w.now, facts });
    },
    expected: MISSED(0, 0, ISSUE_FACTS.length),
  },
  {
    id: "R16",
    name: "assignment changed, 31 minutes after the last full read",
    bump: "assumed-not",
    elapsed: RECONCILE_MINUTES + 1,
    apply: (w) => edit(w, "issue#8", "assignees", false),
    expected: MISSED(0, 0),
  },
  {
    id: "R17",
    name: "review dismissed, 31 minutes after the last full read",
    bump: "assumed-not",
    elapsed: RECONCILE_MINUTES + 1,
    apply: (w) => edit(w, "pr#101", "reviews", false),
    expected: MISSED(0, 0),
  },
];

export interface ScenarioOutcome {
  id: string;
  name: string;
  bump: Scenario["bump"];
  results: Record<StrategyId, Counters>;
  failures: string[];
}

export function runScenarios(scenarios: readonly Scenario[] = SCENARIOS): ScenarioOutcome[] {
  return scenarios.map((sc) => {
    const previous = baselineWorld();
    const next = baselineWorld();
    next.now += sc.elapsed ?? 5;
    sc.apply(next);
    const results = {} as Record<StrategyId, Counters>;
    const failures: string[] = [];
    for (const st of STRATEGIES) {
      results[st] = warmRefresh(st, previous, next, { manifestCoverage: sc.manifestCoverage });
      if (results[st].missedChanges !== sc.expected[st])
        failures.push(
          `${st}: expected ${sc.expected[st]} missed, observed ${results[st].missedChanges} (${results[st].missedFacts.join(", ")})`,
        );
    }
    return { id: sc.id, name: sc.name, bump: sc.bump, results, failures };
  });
}

/** Cold read cost: what every strategy pays when the cache is empty. */
export function coldCost(): Counters {
  const c = zero();
  fullRead(baselineWorld(), c);
  return c;
}
