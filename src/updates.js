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

export const packageName = "@trebizondoculpepper/github-triage";
export const defaultTimeoutMs = 1500;
export const optOutEnv = "GITHUB_TRIAGE_NO_UPDATE_CHECK";

/** @param {string} v */
export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-next\.(\d+))?$/.exec(v ?? "");
  return m
    ? { major: +m[1], minor: +m[2], patch: +m[3], next: m[4] === undefined ? null : +m[4] }
    : null;
}
/** Positive when a is newer than b. A prerelease sorts before its own release. */
export function compareVersions(a, b) {
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
 * @returns {Promise<{ version: string | null, installed: boolean, reason?: string }>}
 */
export async function installedVersion(moduleUrl = import.meta.url) {
  const here = dirname(fileURLToPath(moduleUrl));
  const installed = here.split(sep).includes("node_modules");
  try {
    // dist/cli.mjs and src/*.js both sit one level below the package root.
    const manifest = JSON.parse(await readFile(join(here, "..", "package.json"), "utf8"));
    if (manifest.name !== packageName)
      return { version: null, installed, reason: "package manifest not found" };
    return { version: manifest.version ?? null, installed };
  } catch {
    return { version: null, installed, reason: "package manifest not readable" };
  }
}

/**
 * Decide and perform the check. Every outcome is returned for explicit inspection; only
 * `status: "newer"` produces routine output.
 * @param {{ installed?: { version: string | null, installed: boolean, reason?: string },
 *   offline?: boolean, optOut?: boolean, fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 */
export async function checkForUpdate({
  installed,
  offline = false,
  optOut = false,
  fetchImpl = fetch,
  timeoutMs = defaultTimeoutMs,
} = {}) {
  const info = installed ?? (await installedVersion());
  if (optOut) return { status: "skipped", reason: `disabled (${optOutEnv} or --no-update-check)` };
  if (offline) return { status: "skipped", reason: "offline: no network lookup" };
  if (!info.installed)
    return {
      status: "skipped",
      reason: "not an npm installation (source or development checkout)",
    };
  const current = parseVersion(info.version ?? "");
  if (!current)
    return {
      status: "skipped",
      reason: `installed version unknown (${info.reason ?? info.version ?? "none"})`,
    };
  const channel = current.next === null ? "latest" : "next";
  let tags;
  try {
    const response = await fetchImpl(
      `https://registry.npmjs.org/-/package/${packageName.replace("/", "%2f")}/dist-tags`,
      { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } },
    );
    if (!response.ok)
      return {
        status: "unknown",
        reason: `npm registry returned ${response.status}`,
        installed: info.version,
        channel,
      };
    tags = await response.json();
  } catch (error) {
    return {
      status: "unknown",
      reason:
        error?.name === "TimeoutError"
          ? `npm registry did not answer within ${timeoutMs} ms`
          : "npm registry unreachable",
      installed: info.version,
      channel,
    };
  }
  const available = parseVersion(tags?.[channel] ?? "");
  if (!available)
    return {
      status: "unknown",
      reason: `no usable ${channel} version on npm`,
      installed: info.version,
      channel,
    };
  const newer = compareVersions(available, current) > 0;
  return {
    status: newer ? "newer" : "current",
    installed: info.version,
    available: tags[channel],
    channel,
    command: `npm install -g ${packageName}${channel === "next" ? "@next" : ""}`,
  };
}

/** The one-line advisory, or null when nothing should be said routinely. */
export function updateAdvisory(result) {
  return result.status === "newer"
    ? `github-triage ${result.available} is available (installed ${result.installed}). Update with: ${result.command}`
    : null;
}
