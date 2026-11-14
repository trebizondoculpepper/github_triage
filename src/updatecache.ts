/**
 * Daily cached version check and quiet notices (#65). Contract: doc/design/updates.md,
 * "#65: daily cache and quiet notices".
 *
 * Wraps the basic check (#51) with one small human-readable JSON file in the per-user cache
 * directory (`env-paths('presidential-daily-briefing').cache`), shared by every project checkout. Each npm
 * channel is looked up at most once per 24 hours, failed lookups included, and a given
 * available version is announced at most once per 24 hours. Writes use atomic replacement under
 * a short-lived exclusive lock with bounded waiting and stale-lock recovery. If the cache cannot
 * be coordinated safely the optional check is skipped rather than repeated against npm.
 */
import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { join } from "node:path";
import envPaths from "env-paths";
import { acquireFileLock, type LockFs } from "./filelock.js";
import {
  checkForUpdate,
  type CheckOptions,
  compareWith,
  defaultTimeoutMs,
  eligibility,
  type Channel,
  type InstalledInfo,
  type UpdateCheckResult,
} from "./updates.js";

export const cacheSchemaVersion = 1;
export const cacheFileName = "update-check.json";
/** Refresh interval for lookups (successful or failed) and for repeating a notice. */
export const refreshMs = 24 * 60 * 60 * 1000;
/** A lock older than this is from a crashed or stuck process and may be broken. */
export const lockStaleMs = 10_000;
/** How long an invocation waits for another one's lock before skipping the optional check. */
export const lockWaitMs = 250;
const lockPollMs = 25;

/** Per-channel state; timestamps are ISO strings so the file stays readable. */
export interface ChannelState {
  lastAttempt?: string;
  lastSuccess?: string;
  available?: string;
  lastWarningVersion?: string;
  lastWarningAt?: string;
}
export interface UpdateCache {
  schemaVersion: number;
  channels: Record<string, ChannelState>;
}

/** The filesystem operations the cache needs; tests inject failures. */
export interface CacheFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, options: { flag?: string }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  stat(path: string): Promise<{ mtimeMs: number }>;
}

export interface CachedCheckOptions extends CheckOptions {
  /** Directory holding the cache file; defaults to the per-user OS cache directory. */
  cacheDir?: string;
  fs?: CacheFs;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The per-user cache directory (XDG_CACHE_HOME, ~/Library/Caches, %LOCALAPPDATA%). */
export function defaultCacheDir(): string {
  return envPaths("presidential-daily-briefing").cache;
}

/** Read the cache; a missing, unreadable, corrupt or foreign-schema file counts as absent. */
export async function readCache(fs: CacheFs, file: string): Promise<UpdateCache> {
  const empty = { schemaVersion: cacheSchemaVersion, channels: {} };
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (!isRecord(parsed) || parsed.schemaVersion !== cacheSchemaVersion) return empty;
    if (!isRecord(parsed.channels)) return empty;
    const channels: Record<string, ChannelState> = {};
    for (const [name, value] of Object.entries(parsed.channels)) {
      if (!isRecord(value)) continue;
      const state: ChannelState = {};
      for (const key of [
        "lastAttempt",
        "lastSuccess",
        "available",
        "lastWarningVersion",
        "lastWarningAt",
      ] as const)
        if (typeof value[key] === "string") state[key] = value[key];
      channels[name] = state;
    }
    return { schemaVersion: cacheSchemaVersion, channels };
  } catch {
    return empty;
  }
}

/** Write to a unique temporary file, then rename over the cache: readers never see half a file. */
async function writeCache(fs: CacheFs, file: string, cache: UpdateCache): Promise<void> {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(cache, null, 2) + "\n", { flag: "wx" });
    await fs.rename(temp, file);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

/**
 * Take the cache lock, waiting at most `lockWaitMs` and breaking a lock older than
 * `lockStaleMs`. Returns a release function, or null when the lock could not be taken safely
 * (the caller then skips the optional check). Semantics: `src/filelock.ts`; the worst case of
 * its accepted race here is a duplicate registry request and notice with last-writer-wins
 * atomic cache replacement.
 */
export function acquireLock(
  fs: LockFs,
  lock: string,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<(() => Promise<void>) | null> {
  return acquireFileLock(
    fs,
    lock,
    { waitMs: lockWaitMs, staleMs: lockStaleMs, pollMs: lockPollMs },
    now,
    sleep,
  );
}

const within = (iso: string | undefined, now: number) => {
  const at = iso === undefined ? NaN : Date.parse(iso);
  // A timestamp in the future (clock moved back) is not trusted as recent.
  return Number.isFinite(at) && at <= now && now - at < refreshMs;
};

/**
 * The basic check with the shared daily cache. The returned result is the same shape as
 * `checkForUpdate`; a `newer` result carries `notify: false` when the notice was already shown
 * for that version within 24 hours.
 */
export async function cachedCheckForUpdate({
  cacheDir,
  fs = nodeFs,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  fetchImpl = fetch,
  timeoutMs = defaultTimeoutMs,
  ...options
}: CachedCheckOptions = {}): Promise<UpdateCheckResult> {
  // Skips (opt-out, offline, checkout, unknown version) never touch the cache or the network.
  const e = await eligibility(options.installed, !!options.offline, !!options.optOut);
  if (e.skip) return e.skip;
  const { info: installed, current, channel } = e;

  let dir: string;
  try {
    dir = cacheDir ?? defaultCacheDir();
    await fs.mkdir(dir, { recursive: true });
  } catch {
    return unavailable("update cache directory unavailable");
  }
  const file = join(dir, cacheFileName);
  // The lock is judged by the wall clock that stamps file mtimes, not the injected cache clock.
  const release = await acquireLock(fs, join(dir, `${cacheFileName}.lock`), Date.now, sleep);
  if (!release) return unavailable("update cache busy or not writable; check skipped");
  try {
    // Re-read under the lock: a concurrent invocation may have just refreshed it.
    const cache = await readCache(fs, file);
    const state: ChannelState = { ...cache.channels[channel] };
    const t = now();
    let result: UpdateCheckResult;
    if (within(state.lastAttempt, t)) {
      result = within(state.lastSuccess, t)
        ? fromCache(installed, current, channel, state.available)
        : {
            status: "unknown",
            reason: "last npm check failed; retrying after 24 hours",
            installed: installed.version,
            channel,
          };
    } else {
      state.lastAttempt = new Date(t).toISOString();
      // Record the attempt before contacting npm: if it cannot be remembered, the daily throttle
      // cannot hold, so the optional lookup is skipped rather than repeated on every run.
      try {
        await writeCache(fs, file, {
          schemaVersion: cacheSchemaVersion,
          channels: { ...cache.channels, [channel]: state },
        });
      } catch {
        return unavailable("update cache not writable; check skipped");
      }
      result = await checkForUpdate({ ...options, installed, fetchImpl, timeoutMs });
      // Only a successful lookup is remembered as evidence; a failure only throttles retries.
      if (result.status === "newer" || result.status === "current") {
        state.lastSuccess = state.lastAttempt;
        state.available = result.available;
      }
    }
    if (result.status === "newer") {
      const repeat =
        state.lastWarningVersion === result.available && within(state.lastWarningAt, t);
      if (repeat) result = { ...result, notify: false };
      else {
        state.lastWarningVersion = result.available;
        state.lastWarningAt = new Date(t).toISOString();
      }
    }
    try {
      await writeCache(fs, file, {
        schemaVersion: cacheSchemaVersion,
        channels: { ...cache.channels, [channel]: state },
      });
    } catch {
      // Unwritable cache: still report this lookup, but announce nothing we cannot remember.
      if (result.status === "newer") result = { ...result, notify: false };
    }
    return result;
  } finally {
    await release();
  }

  function unavailable(reason: string): UpdateCheckResult {
    return { status: "unknown", reason, installed: installed.version, channel };
  }
}

/** Compare the installed version with cached evidence; an upgrade since then is honoured. */
function fromCache(
  installed: InstalledInfo,
  current: Parameters<typeof compareWith>[1],
  channel: Channel,
  available: string | undefined,
): UpdateCheckResult {
  return available
    ? compareWith(installed, current, channel, available)
    : {
        status: "unknown",
        reason: `no cached ${channel} version`,
        installed: installed.version,
        channel,
      };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
