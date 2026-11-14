/**
 * Basic version check (#51). Contract: doc/design/updates.md, "#51: basic check and warning".
 *
 * On an eligible invocation, compare the installed version with npm's matching channel
 * (stable → `latest`, prerelease → `next`) and, if npm has a newer one, print one short
 * advisory on stderr. One bounded lookup per eligible invocation; the daily cache is #65.
 * Only this package's name is sent to npm. Failure never blocks triage or implies "up to date".
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";

export const packageName = "@trebizondoculpepper/presidential-daily-briefing";
export const defaultTimeoutMs = 1500;
export const optOutEnv = "PDB_NO_UPDATE_CHECK";
export const legacyOptOutEnv = "GITHUB_TRIAGE_NO_UPDATE_CHECK";

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  next: number | null;
}

export interface InstalledInfo {
  version: string | null;
  installed: boolean;
  reason?: string;
}

export type UpdateCheckResult =
  | { status: "skipped"; reason: string }
  | { status: "unknown"; reason: string; installed: string | null; channel: string }
  | {
      status: "newer" | "current";
      installed: string | null;
      available: string;
      channel: string;
      command: string;
      /** false when the cached check already showed this notice within the last 24 hours (#65). */
      notify?: boolean;
    };

export interface CheckOptions {
  installed?: InstalledInfo;
  offline?: boolean;
  optOut?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function parseVersion(v: string | null | undefined): ParsedVersion | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-next\.(\d+))?$/.exec(v ?? "");
  return m
    ? { major: +m[1], minor: +m[2], patch: +m[3], next: m[4] === undefined ? null : +m[4] }
    : null;
}
/** Positive when a is newer than b. A prerelease sorts before its own release. */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  return (
    a.major - b.major ||
    a.minor - b.minor ||
    a.patch - b.patch ||
    (a.next === null ? 1 : 0) - (b.next === null ? 1 : 0) ||
    (a.next ?? 0) - (b.next ?? 0)
  );
}

/**
 * Where this CLI runs from. Only an npm installation (a path inside node_modules) is eligible;
 * a source or development checkout is skipped.
 */
export async function installedVersion(
  moduleUrl: string = import.meta.url,
): Promise<InstalledInfo> {
  const here = dirname(fileURLToPath(moduleUrl));
  const installed = here.split(sep).includes("node_modules");
  // The bundle (dist/cli.mjs) sits one level below the package root; source modules such as
  // src/updates/updates.ts sit deeper. Search upward for this package's own manifest.
  let readable = false;
  for (let dir = here, depth = 0; depth < manifestSearchDepth; depth++) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
      readable = true;
    } catch {
      continue;
    }
    if (!isRecord(manifest) || manifest.name !== packageName) continue;
    const version = manifest.version ?? null;
    // The original JavaScript passed any manifest version through; keep that but require a string.
    return { version: typeof version === "string" ? version : null, installed };
  }
  return readable
    ? { version: null, installed, reason: "package manifest not found" }
    : { version: null, installed, reason: "package manifest not readable" };
}

/** How many parent directories installedVersion() inspects for the package manifest. */
const manifestSearchDepth = 3;

export type Eligibility =
  | { skip: UpdateCheckResult }
  | { skip?: undefined; info: InstalledInfo; current: ParsedVersion; channel: Channel };

export type Channel = "latest" | "next";

/** Opt-out, offline, checkout and unknown-version skips, shared by the plain and cached checks. */
export async function eligibility(
  installed: InstalledInfo | undefined,
  offline: boolean,
  optOut: boolean,
): Promise<Eligibility> {
  const info = installed ?? (await installedVersion());
  if (optOut)
    return {
      skip: { status: "skipped", reason: `disabled (${optOutEnv} or --no-update-check)` },
    };
  if (offline) return { skip: { status: "skipped", reason: "offline: no network lookup" } };
  if (!info.installed)
    return {
      skip: {
        status: "skipped",
        reason: "not an npm installation (source or development checkout)",
      },
    };
  const current = parseVersion(info.version ?? "");
  if (!current)
    return {
      skip: {
        status: "skipped",
        reason: `installed version unknown (${info.reason ?? info.version ?? "none"})`,
      },
    };
  return { info, current, channel: current.next === null ? "latest" : "next" };
}

/** Result of one registry lookup: the channel's version, or why there is none. */
type Lookup = { ok: true; available: string } | { ok: false; reason: string };

async function lookup(
  channel: Channel,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Lookup> {
  let tags: unknown;
  try {
    const response = await fetchImpl(
      `https://registry.npmjs.org/-/package/${packageName.replace("/", "%2f")}/dist-tags`,
      { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } },
    );
    if (!response.ok) return { ok: false, reason: `npm registry returned ${response.status}` };
    tags = await response.json();
  } catch (error) {
    return {
      ok: false,
      reason:
        isRecord(error) && error.name === "TimeoutError"
          ? `npm registry did not answer within ${timeoutMs} ms`
          : "npm registry unreachable",
    };
  }
  const tag = isRecord(tags) ? tags[channel] : undefined;
  return typeof tag === "string" && parseVersion(tag)
    ? { ok: true, available: tag }
    : { ok: false, reason: `no usable ${channel} version on npm` };
}

/** Compare the installed version with a known channel version. */
export function compareWith(
  info: InstalledInfo,
  current: ParsedVersion,
  channel: Channel,
  available: string,
) {
  const parsed = parseVersion(available);
  if (!parsed)
    return {
      status: "unknown" as const,
      reason: `no usable ${channel} version on npm`,
      installed: info.version,
      channel,
    };
  return {
    status: compareVersions(parsed, current) > 0 ? ("newer" as const) : ("current" as const),
    installed: info.version,
    available,
    channel,
    command: `npm install -g ${packageName}${channel === "next" ? "@next" : ""}`,
  };
}

/**
 * Decide and perform the check (one lookup, no cache). Every outcome is returned for explicit
 * inspection; only `status: "newer"` produces routine output.
 */
export async function checkForUpdate({
  installed,
  offline = false,
  optOut = false,
  fetchImpl = fetch,
  timeoutMs = defaultTimeoutMs,
}: CheckOptions = {}): Promise<UpdateCheckResult> {
  const e = await eligibility(installed, offline, optOut);
  if (e.skip) return e.skip;
  const found = await lookup(e.channel, fetchImpl, timeoutMs);
  return found.ok
    ? compareWith(e.info, e.current, e.channel, found.available)
    : { status: "unknown", reason: found.reason, installed: e.info.version, channel: e.channel };
}

/** The one-line advisory, or null when nothing should be said routinely. */
export function updateAdvisory(result: UpdateCheckResult): string | null {
  return result.status === "newer" && result.notify !== false
    ? `pdb ${result.available} is available (installed ${result.installed}). Update with: ${result.command}`
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
