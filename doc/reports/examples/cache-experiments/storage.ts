/**
 * Local evidence storage experiment (#203). Contract: doc/design/cache-experiments.md, "#203
 * storage experiment". Experimental only: nothing here is wired into the product, and it never
 * writes to the default per-user cache. Every function takes an explicit cache root.
 *
 * Layout: <root>/v1/<contextKey>/snapshot.json, with snapshot.json.lock beside it while a writer
 * holds it. The context key is a digest of the canonical host, repository, authenticated login,
 * collection profile and schema/profile versions, so different contexts never share a file.
 *
 * Writes: lock (src/config/filelock.ts with age-based breaking disabled, five-second deadline),
 * read the previous snapshot under the lock, write a same-directory temporary file with `wx`,
 * fsync it, read it back and verify it, rename it over the snapshot, fsync the directory where
 * the platform allows it, release. A failure at any step leaves the previous snapshot in place.
 */
import { createHash, randomBytes } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { join } from "node:path";
import envPaths from "env-paths";
import { acquireFileLock } from "../../../../src/config/filelock.js";

export const SCHEMA_VERSION = 1;
export const SNAPSHOT_KIND = "cache-experiment-snapshot";
export const PROFILE_VERSION = 1;
/** Contract limits for this experiment. */
export const MAX_RECORDS = 256;
export const RETENTION_MS = 24 * 60 * 60 * 1000;
export const LOCK_WAIT_MS = 5_000;
export const LOCK_POLL_MS = 25;
/** A stored time further ahead of the local clock than this is treated as clock rollback. */
export const CLOCK_SKEW_MS = 60_000;
/** Contexts examined per cleanup call (bounded cleanup). */
export const CLEANUP_LIMIT = 64;
export const SNAPSHOT_FILE = "snapshot.json";
export const LOCK_FILE = `${SNAPSHOT_FILE}.lock`;
const LAYOUT_DIR = `v${SCHEMA_VERSION}`;

// ---------------------------------------------------------------------------------------------
// Context identity

export interface Context {
  host: string;
  /** Resolved `owner/name`. A rename or transfer yields a new context (a miss, never reuse). */
  repository: string;
  /** Effective authenticated login; absent means unknown, which disables reuse. */
  authenticatedLogin?: string;
  collectionProfile: string;
}

export type ContextKey =
  | { ok: true; key: string; canonical: Required<Context> }
  | { ok: false; reason: string };

/** Canonicalise and digest a context. Unknown login or malformed identity: no key, no reuse. */
export function contextKey(context: Context): ContextKey {
  const host = context.host.trim().toLowerCase().replace(/\.$/, "");
  const repository = context.repository.trim().toLowerCase();
  const login = context.authenticatedLogin?.trim().toLowerCase();
  const profile = context.collectionProfile.trim();
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(host)) return { ok: false, reason: "invalid host" };
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
    repository.split("/").some((part) => part === "." || part === "..")
  )
    return { ok: false, reason: "invalid repository" };
  if (!login) return { ok: false, reason: "authenticated login unknown; no shared reuse" };
  if (!/^[\w.-]+$/.test(profile)) return { ok: false, reason: "invalid collection profile" };
  const canonical = {
    host,
    repository,
    authenticatedLogin: login,
    collectionProfile: profile,
  };
  const key = createHash("sha256")
    .update(JSON.stringify([SCHEMA_VERSION, PROFILE_VERSION, host, repository, login, profile]))
    .digest("hex")
    .slice(0, 32);
  return { ok: true, key, canonical };
}

export const contextDir = (root: string, key: string) => join(root, LAYOUT_DIR, key);

/**
 * Where a production store would live (not used by this experiment): env-paths' per-user cache
 * directory, the same one the update check (#65) uses, plus a subdirectory.
 */
export function proposedRoot(): string {
  return join(envPaths("presidential-daily-briefing").cache, "evidence");
}

// ---------------------------------------------------------------------------------------------
// Envelope

export type CoverageStatus = "complete" | "partial" | "unknown";
export interface SourceCoverage {
  status: CoverageStatus;
  pages: number;
  scope: string;
}
export interface ManifestEntry {
  subject: string;
  state: string;
  updatedAt: string;
  headOid?: string;
}
export interface EvidenceRecord {
  subject: string;
  facts: Record<string, unknown>;
  /** Time the facts were observed at the source. */
  sourceTime: string;
  validator: string;
  revalidatedAt: string;
  /** Last time a successful manifest listed this subject (retention clock). */
  lastSeenAt: string;
}
export interface Snapshot {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: typeof SNAPSHOT_KIND;
  contextKey: string;
  host: string;
  repository: string;
  authenticatedLogin: string;
  collectionProfile: string;
  profileVersion: typeof PROFILE_VERSION;
  observedAt: string;
  lastSuccessfulAt: string;
  sourceCoverage: Record<string, SourceCoverage>;
  manifest: ManifestEntry[];
  records: EvidenceRecord[];
  /**
   * What the last write left out, persisted so a later load can report it: `evicted` stays
   * listed (in the manifest) but unstored until it is stored again; `expired` and
   * `prunedUnseen` describe the last write.
   */
  omissions: Omissions;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
/** Describe a parsed JSON value for a diagnostic without invoking anything on it. */
const safeDescribe = (v: unknown): string =>
  typeof v === "number" || typeof v === "boolean" || v === null
    ? `${v}`
    : typeof v === "string"
      ? JSON.stringify(v.slice(0, 40))
      : Array.isArray(v)
        ? "array"
        : typeof v;
const isTime = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));

/** Structural check; returns a reason when the value is not a usable snapshot. */
export function shapeProblem(v: unknown): string | undefined {
  if (!isRecord(v)) return "not an object";
  for (const k of ["contextKey", "host", "repository", "authenticatedLogin", "collectionProfile"])
    if (typeof v[k] !== "string") return `missing ${k}`;
  if (v.profileVersion !== PROFILE_VERSION) return "profile version mismatch";
  if (!isTime(v.observedAt) || !isTime(v.lastSuccessfulAt)) return "invalid timestamps";
  if (!isRecord(v.sourceCoverage)) return "missing sourceCoverage";
  for (const c of Object.values(v.sourceCoverage))
    if (
      !isRecord(c) ||
      typeof c.status !== "string" ||
      !["complete", "partial", "unknown"].includes(c.status) ||
      typeof c.pages !== "number" ||
      !Number.isInteger(c.pages) ||
      c.pages < 0 ||
      typeof c.scope !== "string"
    )
      return "invalid sourceCoverage";
  if (!Array.isArray(v.manifest) || !Array.isArray(v.records)) return "missing manifest/records";
  for (const m of v.manifest)
    if (
      !isRecord(m) ||
      typeof m.subject !== "string" ||
      typeof m.state !== "string" ||
      !isTime(m.updatedAt) ||
      (m.headOid !== undefined && typeof m.headOid !== "string")
    )
      return "invalid manifest entry";
  for (const r of v.records)
    if (
      !isRecord(r) ||
      typeof r.subject !== "string" ||
      !isRecord(r.facts) ||
      !isTime(r.sourceTime) ||
      typeof r.validator !== "string" ||
      !isTime(r.revalidatedAt) ||
      !isTime(r.lastSeenAt)
    )
      return "invalid record";
  const isList = (x: unknown) => Array.isArray(x) && x.every((y) => typeof y === "string");
  if (
    !isRecord(v.omissions) ||
    !isList(v.omissions.evicted) ||
    !isList(v.omissions.expired) ||
    !isList(v.omissions.prunedUnseen)
  )
    return "invalid omissions";
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Filesystem boundary

export interface FileHandleLike {
  writeFile(data: string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}
/** The operations the store needs; `node:fs/promises` satisfies it. Tests inject failures. */
export interface StorageFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, options: { flag?: string }): Promise<void>;
  open(path: string, flags: string, mode?: number): Promise<FileHandleLike>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, options: { recursive: true; mode?: number }): Promise<unknown>;
  stat(path: string): Promise<{ mtimeMs: number; size: number }>;
  readdir(path: string): Promise<string[]>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
  /** Non-recursive: fails if the directory is not empty, so a new writer's lock survives. */
  rmdir(path: string): Promise<void>;
}
export const realFs: StorageFs = nodeFs as unknown as StorageFs;

const describeError = (e: unknown) =>
  `${errorCode(e) ?? "error"}: ${e instanceof Error ? e.message : typeof e}`;

export const errorCode = (e: unknown): string | undefined => {
  const c = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof c === "string" ? c : undefined;
};

// ---------------------------------------------------------------------------------------------
// Reading

export type MissReason =
  | "unknown-context"
  | "no-cache"
  | "truncated"
  | "corrupt"
  | "schema-mismatch"
  | "future-schema"
  | "context-mismatch"
  | "future-timestamp"
  | "expired"
  | "access-not-confirmed"
  | "unreadable";

export type LoadResult =
  | {
      status: "hit";
      snapshot: Snapshot;
      /** Stored evidence is never fresh: it needs revalidation (#202) before display as current. */
      freshness: "stored-unvalidated";
      ageMs: number;
      coverageComplete: boolean;
      /** Records withheld because their own lastSeenAt is past the 24-hour retention. */
      expiredOnLoad: string[];
      /** Manifest subjects with no stored record (any cause); non-empty means incomplete. */
      unstored: string[];
      /** Omissions persisted by the last write (evictions, expiries, pruned subjects). */
      storedOmissions: Omissions;
    }
  | {
      /** A valid snapshot with no records. Authoritative only when every source was complete. */
      status: "empty";
      snapshot: Snapshot;
      freshness: "stored-unvalidated";
      ageMs: number;
      coverageComplete: boolean;
      /** Records withheld because their own lastSeenAt is past the 24-hour retention. */
      expiredOnLoad: string[];
      /** Manifest subjects with no stored record (any cause); non-empty means incomplete. */
      unstored: string[];
      /** Omissions persisted by the last write (evictions, expiries, pruned subjects). */
      storedOmissions: Omissions;
    }
  | { status: "miss"; reason: MissReason; detail: string };

export interface ReadOptions {
  fs?: StorageFs;
  now?: () => number;
  /**
   * Whether current access to the repository was confirmed for this login on this run. A
   * matching login is not proof that permissions are unchanged, so anything other than
   * "confirmed" is a miss for restricted facts.
   */
  access?: "confirmed" | "lost" | "unknown";
}

/** Classify a snapshot file's text. Pure; exported for tests. */
export function classifyText(
  text: string,
  key: ContextKey & { ok: true },
  now: number,
): LoadResult {
  if (text.length === 0) return miss("truncated", "zero-length file");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    // A prefix of valid JSON fails at the end of the text; anything earlier is corruption.
    // Classification by V8's message is a heuristic; both outcomes are misses.
    const message = e instanceof Error ? e.message : String(e);
    const at = /position (\d+)/.exec(message);
    const atEnd =
      /end of JSON input/.test(message) || (at && Number(at[1]) >= text.trimEnd().length);
    return atEnd ? miss("truncated", message) : miss("corrupt", message);
  }
  if (!isRecord(parsed)) return miss("corrupt", "not an object");
  if (typeof parsed.schemaVersion === "number" && parsed.schemaVersion > SCHEMA_VERSION)
    return miss("future-schema", `schemaVersion ${parsed.schemaVersion}`);
  if (parsed.schemaVersion !== SCHEMA_VERSION || parsed.kind !== SNAPSHOT_KIND)
    return miss("schema-mismatch", `schemaVersion ${safeDescribe(parsed.schemaVersion)}`);
  const problem = shapeProblem(parsed);
  if (problem) return miss("corrupt", problem);
  const s = parsed as unknown as Snapshot;
  const c = key.canonical;
  if (
    s.contextKey !== key.key ||
    s.host !== c.host ||
    s.repository !== c.repository ||
    s.authenticatedLogin !== c.authenticatedLogin ||
    s.collectionProfile !== c.collectionProfile
  )
    return miss("context-mismatch", "stored context differs from the requested one");
  const observed = Date.parse(s.observedAt);
  const success = Date.parse(s.lastSuccessfulAt);
  if (Math.max(observed, success) > now + CLOCK_SKEW_MS)
    return miss("future-timestamp", "stored time is ahead of the local clock (rollback?)");
  if (now - success > RETENTION_MS) return miss("expired", "older than 24-hour retention");
  // Per-record retention: a partial refresh can move lastSuccessfulAt past records it kept, so
  // each record's own listing time is checked too. Expired records are withheld and reported,
  // and their absence makes the snapshot's coverage incomplete (it is no longer what was seen).
  const expiredOnLoad: string[] = [];
  const records = s.records.filter((r) => {
    const keep = now - Date.parse(r.lastSeenAt) <= RETENTION_MS;
    if (!keep) expiredOnLoad.push(r.subject);
    return keep;
  });
  // Listed subjects without a stored record (evicted at the cap, expired, or never stored) mean
  // the snapshot does not hold everything its manifest covers.
  const stored = new Set(records.map((r) => r.subject));
  const unstored = s.manifest.map((m) => m.subject).filter((x) => !stored.has(x));
  const coverageComplete =
    expiredOnLoad.length === 0 &&
    unstored.length === 0 &&
    s.omissions.evicted.length === 0 &&
    Object.keys(s.sourceCoverage).length > 0 &&
    Object.values(s.sourceCoverage).every((cv) => cv.status === "complete");
  const base = {
    snapshot: { ...s, records },
    freshness: "stored-unvalidated" as const,
    ageMs: Math.max(0, now - success),
    coverageComplete,
    expiredOnLoad,
    unstored,
    storedOmissions: s.omissions,
  };
  return records.length === 0 ? { status: "empty", ...base } : { status: "hit", ...base };
}

const miss = (reason: MissReason, detail: string): LoadResult => ({
  status: "miss",
  reason,
  detail,
});

/** Read a context's snapshot. Every failure is a classified miss; nothing throws. */
export async function loadSnapshot(
  root: string,
  context: Context,
  { fs = realFs, now = Date.now, access = "unknown" }: ReadOptions = {},
): Promise<LoadResult> {
  const key = contextKey(context);
  if (!key.ok) return miss("unknown-context", key.reason);
  if (access !== "confirmed")
    return miss("access-not-confirmed", `current access ${access}; stored facts not reused`);
  let text: string;
  try {
    text = await fs.readFile(join(contextDir(root, key.key), SNAPSHOT_FILE), "utf8");
  } catch (e) {
    return errorCode(e) === "ENOENT"
      ? miss("no-cache", "no snapshot for this context")
      : miss("unreadable", `${errorCode(e) ?? "error"}: ${(e as Error).message}`);
  }
  return classifyText(text, key, now());
}

// ---------------------------------------------------------------------------------------------
// Refresh (pure): retention, eviction and pruning

export interface Observation {
  observedAt: string;
  sourceCoverage: Record<string, SourceCoverage>;
  manifest: ManifestEntry[];
  records: EvidenceRecord[];
}
export interface Omissions {
  /** Unseen in a complete manifest: dropped (not proof of deletion; #202 diagnoses that). */
  prunedUnseen: string[];
  /** Over the record cap: evicted, oldest lastSeenAt first. Eviction is not deletion. */
  evicted: string[];
  /** Older than the retention window. */
  expired: string[];
}

/**
 * Merge a successful observation into the previous snapshot. A subject is pruned as unseen, or
 * its eviction cleared, only when this observation covers that subject's own source completely
 * (`sourceOf`); records from a partial, unknown or absent source are kept. A source collected
 * earlier but missing from this observation keeps its coverage entry, downgraded to "unknown". Records past 24 hours
 * are dropped, then the oldest are evicted above 256. Every removal is reported.
 */
/**
 * The coverage source a subject belongs to: `issue:N` to "issues", `pr:N` to "pullRequests".
 * An unrecognised subject has no source and is therefore never pruned or cleared.
 */
export function sourceOf(subject: string): string | undefined {
  if (subject.startsWith("issue:")) return "issues";
  if (subject.startsWith("pr:")) return "pullRequests";
  return undefined;
}

/** The full selection of a source (every subject in every state); it includes every scope. */
export const FULL_SCOPE = "all states";

/**
 * Whether an observation made with scope `observed` covers everything stored under `stored`.
 * Scopes are opaque strings: only an identical scope or the full scope counts as including.
 */
export function scopeIncludes(observed: string, stored: string): boolean {
  return observed === stored || observed === FULL_SCOPE;
}

export function applyObservation(
  previous: Snapshot | undefined,
  key: ContextKey & { ok: true },
  obs: Observation,
  now: number,
  /** Records already withheld for age when the previous snapshot was loaded. */
  expiredBefore: string[] = [],
): { snapshot: Snapshot; omissions: Omissions } {
  const omissions: Omissions = { prunedUnseen: [], evicted: [], expired: [...expiredBefore] };
  // Per-source completeness: a complete issue list says nothing about pull requests, and a
  // complete list of a narrower selection says nothing about subjects outside it. Removal is
  // allowed only when the observed scope matches or includes the stored scope for the source.
  const sourceComplete = (subject: string) => {
    const src = sourceOf(subject);
    if (src === undefined) return false;
    const seen = obs.sourceCoverage[src];
    if (seen?.status !== "complete") return false;
    const stored = previous?.sourceCoverage[src];
    return stored === undefined || scopeIncludes(seen.scope, stored.scope);
  };
  const listed = new Set(obs.manifest.map((m) => m.subject));
  const merged = new Map<string, EvidenceRecord>();
  for (const r of previous?.records ?? []) {
    if (sourceComplete(r.subject) && !listed.has(r.subject)) omissions.prunedUnseen.push(r.subject);
    // Listed again by this successful manifest: renew its listing time only. Its facts,
    // sourceTime and revalidatedAt are unchanged, so they are not claimed as revalidated.
    else if (listed.has(r.subject)) merged.set(r.subject, { ...r, lastSeenAt: obs.observedAt });
    else merged.set(r.subject, r);
  }
  for (const r of obs.records) merged.set(r.subject, r);
  let records = [...merged.values()].filter((r) => {
    const fresh = now - Date.parse(r.lastSeenAt) <= RETENTION_MS;
    if (!fresh) omissions.expired.push(r.subject);
    return fresh;
  });
  if (records.length > MAX_RECORDS) {
    records.sort(
      (a, b) =>
        Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt) || a.subject.localeCompare(b.subject),
    );
    omissions.evicted = records.slice(MAX_RECORDS).map((r) => r.subject);
    records = records.slice(0, MAX_RECORDS);
  }
  records.sort((a, b) => a.subject.localeCompare(b.subject));
  const manifest = [...obs.manifest].sort((a, b) => a.subject.localeCompare(b.subject));
  // Persisted eviction: this write's evictions plus earlier ones that are still listed and
  // still unstored. A subject leaves the list only once it is stored or no longer listed.
  const kept = new Set(records.map((r) => r.subject));
  const listedNow = new Set(manifest.map((m) => m.subject));
  const evicted = [...new Set([...(previous?.omissions.evicted ?? []), ...omissions.evicted])]
    // Cleared once stored again, or once a complete manifest no longer lists it. A partial
    // manifest that does not list it proves nothing, so the eviction stays on record.
    .filter((x) => !kept.has(x) && (listedNow.has(x) || !sourceComplete(x)))
    .sort();
  // Sources collected before but absent now: keep their entry, marked not re-observed.
  const sourceCoverage: Record<string, SourceCoverage> = { ...obs.sourceCoverage };
  for (const [src, cov] of Object.entries(previous?.sourceCoverage ?? {}))
    if (!(src in sourceCoverage)) sourceCoverage[src] = { ...cov, status: "unknown" };
  const c = key.canonical;
  return {
    snapshot: {
      schemaVersion: SCHEMA_VERSION,
      kind: SNAPSHOT_KIND,
      contextKey: key.key,
      host: c.host,
      repository: c.repository,
      authenticatedLogin: c.authenticatedLogin,
      collectionProfile: c.collectionProfile,
      profileVersion: PROFILE_VERSION,
      observedAt: obs.observedAt,
      lastSuccessfulAt: obs.observedAt,
      sourceCoverage,
      manifest,
      records,
      omissions: {
        evicted,
        expired: [...omissions.expired].sort(),
        prunedUnseen: [...omissions.prunedUnseen].sort(),
      },
    },
    omissions,
  };
}

// ---------------------------------------------------------------------------------------------
// Writing

/**
 * Directory fsync outcomes that mean "not supported on this platform or filesystem". Windows
 * cannot open or flush a directory handle through Node (EISDIR, EPERM or EACCES there); some
 * filesystems reject the flush with EINVAL, ENOTSUP or EOPNOTSUPP. Anything else is real.
 */
export function dirSyncUnsupported(
  code: string | undefined,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP") return true;
  return platform === "win32" && (code === "EISDIR" || code === "EPERM" || code === "EACCES");
}

export type WriteStep =
  | "mkdir"
  | "lock"
  | "read-previous"
  | "write-temp"
  | "fsync-temp"
  | "verify-temp"
  | "rename"
  | "fsync-dir"
  | "unlock";

export interface WriteOptions {
  fs?: StorageFs;
  /** Clock for timestamps and retention. */
  now?: () => number;
  /** Clock and sleep used by the lock; the lock compares against file mtimes. */
  lockNow?: () => number;
  sleep?: (ms: number) => Promise<void>;
  lockWaitMs?: number;
  /** Test hook: runs before each step; throwing simulates a failure at that point. */
  beforeStep?: (step: WriteStep) => void | Promise<void>;
  /** Test hook: runs after each step. */
  afterStep?: (step: WriteStep) => void | Promise<void>;
  /** Attempts for a rename refused with EPERM/EACCES/EBUSY (Windows sharing violations). */
  renameAttempts?: number;
}

export type WriteResult =
  | {
      status: "written";
      bytes: number;
      omissions: Omissions;
      renameRetries: number;
      dirSynced: boolean;
      /** Error code when the platform cannot fsync a directory (e.g. Windows); not a failure. */
      dirSyncSkipped?: string;
      previous: LoadResult["status"] | MissReason;
      /** Errors after the outcome was decided (temp removal, unlock hooks); empty normally. */
      cleanupErrors: string[];
    }
  | {
      /**
       * The replacement is in place (the rename succeeded) but a later step failed, for
       * example the directory fsync. Readers see the new snapshot; its durability across a
       * power loss is not confirmed.
       */
      status: "committed-with-error";
      reason: "post-commit-failure";
      step: WriteStep;
      detail: string;
      omissions: Omissions;
      cleanupErrors: string[];
    }
  | {
      status: "not-written";
      reason:
        | "unknown-context"
        | "lock-timeout"
        | "lock-error"
        | "failed"
        | "declined"
        | "previous-unreadable";
      step?: WriteStep;
      detail: string;
      cleanupErrors?: string[];
    };

/**
 * Read-modify-write one context under its lock. `update` receives the previous load result
 * (read under the lock, so concurrent writers never lose each other's records) and returns the
 * observation to merge, or null to leave the snapshot unchanged. Never throws for filesystem
 * failures. Every failure before the rename leaves the previous snapshot in place
 * ("not-written"); a failure after it is "committed-with-error", with the new snapshot in place.
 */
export async function storeSnapshot(
  root: string,
  context: Context,
  update: (previous: LoadResult) => Observation | null,
  options: WriteOptions = {},
): Promise<WriteResult> {
  const {
    fs = realFs,
    now = Date.now,
    lockNow = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    lockWaitMs = LOCK_WAIT_MS,
    beforeStep,
    afterStep,
    renameAttempts = 5,
  } = options;
  const key = contextKey(context);
  if (!key.ok) return { status: "not-written", reason: "unknown-context", detail: key.reason };
  const dir = contextDir(root, key.key);
  const file = join(dir, SNAPSHOT_FILE);
  let step: WriteStep = "mkdir";
  const run = async <T>(s: WriteStep, f: () => Promise<T>): Promise<T> => {
    step = s;
    await beforeStep?.(s);
    const value = await f();
    await afterStep?.(s);
    return value;
  };
  const failed = (e: unknown): WriteResult => ({
    status: "not-written",
    reason: "failed",
    step,
    detail: `${errorCode(e) ?? "error"}: ${e instanceof Error ? e.message : String(e)}`,
  });

  try {
    await run("mkdir", () => fs.mkdir(dir, { recursive: true, mode: 0o700 }));
  } catch (e) {
    return failed(e);
  }
  let release: (() => Promise<void>) | null = null;
  const started = lockNow();
  try {
    step = "lock";
    await beforeStep?.("lock");
    // Assign before the after-hook runs, so a hook failure still releases a lock we took.
    release = await acquireFileLock(
      fs,
      join(dir, LOCK_FILE),
      // Age-based breaking disabled: an old lock is never removed (contract).
      { waitMs: lockWaitMs, staleMs: Number.POSITIVE_INFINITY, pollMs: LOCK_POLL_MS },
      lockNow,
      sleep,
    );
    if (release) await afterStep?.("lock");
  } catch (e) {
    let detail = "";
    if (release)
      await release().catch((r: unknown) => (detail = `; release failed: ${describeError(r)}`));
    const f = failed(e);
    return f.status === "not-written" ? { ...f, detail: f.detail + detail } : f;
  }
  if (!release) {
    // acquireFileLock returns null both on timeout and on an unexpected error; tell them apart.
    const timedOut = lockNow() - started >= lockWaitMs;
    return {
      status: "not-written",
      reason: timedOut ? "lock-timeout" : "lock-error",
      step: "lock",
      detail: timedOut
        ? `lock held by another writer for ${lockWaitMs} ms; cache miss, lock left in place`
        : "lock could not be created (filesystem error)",
    };
  }
  const temp = join(dir, `${SNAPSHOT_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let tempCreated = false;
  const cleanupErrors: string[] = [];
  // Set once the rename has replaced the snapshot: failures after it are not "not-written".
  let committed: Omissions | undefined;
  try {
    const previous = await run("read-previous", () =>
      loadSnapshot(root, context, { fs, now, access: "confirmed" }),
    );
    // An existing snapshot that could not be read (EIO, EACCES...) is not replaced: it may hold
    // records and omissions this write would silently lose. Classified misses (no cache,
    // corrupt, truncated, schema, expired, future timestamp) are safe to replace.
    if (previous.status === "miss" && previous.reason === "unreadable")
      return {
        status: "not-written",
        reason: "previous-unreadable",
        step: "read-previous",
        detail: previous.detail,
        cleanupErrors,
      };
    const obs = update(previous);
    if (!obs)
      return {
        status: "not-written",
        reason: "declined",
        detail: "update returned no change",
        cleanupErrors,
      };
    const prior = previous.status === "miss" ? undefined : previous.snapshot;
    // Records withheld on load for age are dropped by this write; report them as expired.
    const { snapshot, omissions } = applyObservation(
      prior,
      key,
      obs,
      now(),
      previous.status === "miss" ? [] : previous.expiredOnLoad,
    );
    const text = JSON.stringify(snapshot) + "\n";
    let handle: FileHandleLike | undefined;
    try {
      await run("write-temp", async () => {
        handle = await fs.open(temp, "wx", 0o600);
        tempCreated = true;
        await handle.writeFile(text);
      });
      await run("fsync-temp", () => handle!.sync());
    } finally {
      await handle?.close();
    }
    await run("verify-temp", async () => {
      const back = await fs.readFile(temp, "utf8");
      if (back !== text) throw Object.assign(new Error("read-back differs"), { code: "EVERIFY" });
    });
    let renameRetries = 0;
    await run("rename", async () => {
      for (;;) {
        try {
          await fs.rename(temp, file);
          committed = omissions;
          return;
        } catch (e) {
          const c = errorCode(e);
          if (
            !["EPERM", "EACCES", "EBUSY"].includes(c ?? "") ||
            renameRetries + 1 >= renameAttempts
          )
            throw e;
          renameRetries++;
          await sleep(20 * renameRetries);
        }
      }
    });
    tempCreated = false;
    let dirSynced = false;
    let dirSyncSkipped: string | undefined;
    await run("fsync-dir", async () => {
      // POSIX: persist the rename. Only "not supported here" outcomes are skipped (and
      // recorded); any other error, such as EIO, propagates and the result is
      // committed-with-error.
      try {
        const h = await fs.open(dir, "r");
        try {
          await h.sync();
          dirSynced = true;
        } finally {
          await h.close();
        }
      } catch (e) {
        if (!dirSyncUnsupported(errorCode(e))) throw e;
        dirSyncSkipped = errorCode(e);
      }
    });
    return {
      status: "written",
      bytes: Buffer.byteLength(text),
      omissions,
      renameRetries,
      dirSynced,
      ...(dirSyncSkipped ? { dirSyncSkipped } : {}),
      previous: previous.status === "miss" ? previous.reason : previous.status,
      cleanupErrors,
    };
  } catch (e) {
    if (committed) {
      const f = failed(e);
      return {
        status: "committed-with-error",
        reason: "post-commit-failure",
        step,
        detail: f.status === "not-written" ? f.detail : "",
        omissions: committed,
        cleanupErrors,
      };
    }
    return { ...failed(e), cleanupErrors } as WriteResult;
  } finally {
    // Errors here cannot change the outcome already decided, but they are not hidden: they are
    // appended to `cleanupErrors`, the same array the returned result carries.
    if (tempCreated && !committed)
      await fs.unlink(temp).catch((e: unknown) => {
        if (errorCode(e) !== "ENOENT") cleanupErrors.push(`temp left: ${describeError(e)}`);
      });
    // The release itself always runs once, even if the unlock hooks fail. (filelock's release
    // swallows its own errors; a lock it fails to remove stays in place and later writers
    // time out, never take over.)
    step = "unlock";
    const noting = async (what: string, f: () => unknown) => {
      try {
        await f();
      } catch (e) {
        cleanupErrors.push(`${what}: ${describeError(e)}`);
      }
    };
    await noting("before unlock", () => beforeStep?.("unlock"));
    await noting("release", () => release());
    await noting("after unlock", () => afterStep?.("unlock"));
  }
}

// ---------------------------------------------------------------------------------------------
// Cleanup

export interface CleanupReport {
  examined: number;
  removedContexts: string[];
  removedTemps: string[];
  busy: string[];
  kept: number;
  /** Contexts not examined because of the per-call bound. */
  deferred: number;
  /** Where the next call starts (the last key examined); persisted in the root. */
  nextCursor?: string;
  /** Unexpected filesystem errors, each with the context or file it concerns. */
  errors: string[];
}

export const CLEANUP_CURSOR_FILE = `${LAYOUT_DIR}.cleanup-cursor`;

/**
 * Bounded cleanup of expired contexts and orphaned temporary files. Each context is cleaned only
 * while holding its lock (one attempt, no waiting); a context whose lock is held is reported as
 * busy and left alone. Under the lock no writer can be mid-write, so any temporary file there is
 * an orphan from a failed or crashed write.
 */
export async function cleanupExpired(
  root: string,
  {
    fs = realFs,
    now = Date.now,
    limit = CLEANUP_LIMIT,
    cursor,
  }: { fs?: StorageFs; now?: () => number; limit?: number; cursor?: string } = {},
): Promise<CleanupReport> {
  const report: CleanupReport = {
    examined: 0,
    removedContexts: [],
    removedTemps: [],
    busy: [],
    kept: 0,
    deferred: 0,
    errors: [],
  };
  const note = (where: string, e: unknown) => report.errors.push(`${where}: ${describeError(e)}`);
  let keys: string[];
  try {
    keys = (await fs.readdir(join(root, LAYOUT_DIR))).sort();
  } catch (e) {
    if (errorCode(e) !== "ENOENT") note("root", e);
    return report;
  }
  // Rotate: start after the cursor (given, or saved by the previous call) and wrap around, so
  // contexts beyond the first `limit` are reached by later calls even if earlier ones persist.
  const cursorFile = join(root, CLEANUP_CURSOR_FILE);
  const after =
    cursor ??
    (
      await fs.readFile(cursorFile, "utf8").catch((e: unknown) => {
        if (errorCode(e) !== "ENOENT") note("cursor read", e);
        return "";
      })
    ).trim();
  const start = keys.findIndex((k) => k > after);
  const rotated = start <= 0 ? keys : [...keys.slice(start), ...keys.slice(0, start)];
  const batch = rotated.slice(0, limit);
  report.deferred = Math.max(0, keys.length - batch.length);
  report.nextCursor = batch.at(-1);
  if (report.nextCursor !== undefined)
    await fs.writeFile(cursorFile, report.nextCursor, {}).catch((e: unknown) => {
      note("cursor write", e);
    });
  for (const key of batch) {
    report.examined++;
    const dir = join(root, LAYOUT_DIR, key);
    const release = await acquireFileLock(
      fs,
      join(dir, LOCK_FILE),
      { waitMs: 0, staleMs: Number.POSITIVE_INFINITY, pollMs: 0 },
      Date.now,
      async () => {},
    );
    if (!release) {
      report.busy.push(key);
      continue;
    }
    let removed = false;
    try {
      let expired = true;
      let names: string[] = [];
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(join(dir, SNAPSHOT_FILE), "utf8"));
        const at =
          isRecord(parsed) && typeof parsed.lastSuccessfulAt === "string"
            ? Date.parse(parsed.lastSuccessfulAt)
            : NaN;
        expired = !Number.isFinite(at) || now() - at > RETENTION_MS || at > now() + CLOCK_SKEW_MS;
      } catch (e) {
        // Missing or unparseable snapshot: removable. Unreadable: leave it and report it.
        if (errorCode(e) !== "ENOENT" && !(e instanceof SyntaxError)) {
          expired = false;
          note(`${key} read`, e);
        }
      }
      try {
        names = await fs.readdir(dir);
      } catch (e) {
        note(`${key} list`, e);
        expired = false;
      }
      for (const name of names)
        if (name.endsWith(".tmp"))
          try {
            await fs.unlink(join(dir, name));
            report.removedTemps.push(join(key, name));
          } catch (e) {
            if (errorCode(e) !== "ENOENT") note(`${key}/${name}`, e);
          }
      if (expired) {
        try {
          await fs.unlink(join(dir, SNAPSHOT_FILE));
          removed = true;
        } catch (e) {
          if (errorCode(e) === "ENOENT") removed = true;
          else {
            note(`${key} unlink`, e);
            report.kept++;
          }
        }
      } else report.kept++;
    } finally {
      await release();
    }
    if (removed) {
      // The lock is released first; a non-recursive rmdir fails if a writer has since created
      // its lock or snapshot, which then survives.
      try {
        await fs.rmdir(dir);
        report.removedContexts.push(key);
      } catch (e) {
        report.kept++;
        // Not empty: a writer arrived after we released (expected). Anything else is reported.
        if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes(errorCode(e) ?? ""))
          note(`${key} rmdir`, e);
      }
    }
  }
  return report;
}

/**
 * Remove a disposable experiment root. Allowed only after the caller has stopped and joined
 * every process that could hold a lock in it (`holdersJoined`). Otherwise the root, including any
 * lock, is preserved and the caller should use a new temporary root.
 */
export async function removeExperimentRoot(
  root: string,
  { holdersJoined, fs = realFs }: { holdersJoined: boolean; fs?: StorageFs },
): Promise<"removed" | "preserved"> {
  if (!holdersJoined) return "preserved";
  await fs.rm(root, { recursive: true, force: true });
  return "removed";
}

// ---------------------------------------------------------------------------------------------
// Synthetic fixtures (public, no real data)

/** A synthetic issue/PR record of realistic size: core facts plus a few related facts. */
export function syntheticRecord(n: number, at: string): EvidenceRecord {
  const pr = n % 3 === 0;
  return {
    subject: `${pr ? "pr" : "issue"}:${n}`,
    facts: {
      number: n,
      title: `Synthetic subject ${n}: ${"lorem ipsum dolor sit amet ".repeat(3).trim()}`,
      state: n % 4 === 0 ? "CLOSED" : "OPEN",
      labels: ["status:ready", `complexity:${"SML"[n % 3]}`, "impact:M"],
      assignees: n % 2 ? [`agent_${n % 5}`] : [],
      updatedAt: at,
      author: `user_${n % 7}`,
      commentCount: n % 11,
      lastComments: Array.from({ length: Math.min(3, n % 11) }, (_, i) => ({
        author: `user_${(n + i) % 7}`,
        createdAt: at,
        excerpt: "Synthetic comment body for sizing only. ".repeat(4).trim(),
      })),
      blockedBy: n % 5 === 0 ? [n - 1] : [],
      blocking: [],
      ...(pr
        ? {
            headOid: createHash("sha1").update(String(n)).digest("hex"),
            baseRef: "main",
            reviewDecision: "REVIEW_REQUIRED",
            checks: [{ name: "test (ubuntu-latest, node 26)", conclusion: "SUCCESS" }],
          }
        : {}),
    },
    sourceTime: at,
    validator: pr ? "manifest:updatedAt+headOid" : "manifest:updatedAt",
    revalidatedAt: at,
    lastSeenAt: at,
  };
}

export function syntheticObservation(
  count: number,
  at: string,
  coverage: CoverageStatus = "complete",
  offset = 0,
): Observation {
  const records = Array.from({ length: count }, (_, i) => syntheticRecord(offset + i + 1, at));
  return {
    observedAt: at,
    sourceCoverage: {
      issues: { status: coverage, pages: 1, scope: "all states" },
      pullRequests: { status: coverage, pages: 1, scope: "all states" },
    },
    manifest: records.map((r) => ({
      subject: r.subject,
      state: String(r.facts.state),
      updatedAt: at,
      ...(typeof r.facts.headOid === "string" ? { headOid: r.facts.headOid } : {}),
    })),
    records,
  };
}
