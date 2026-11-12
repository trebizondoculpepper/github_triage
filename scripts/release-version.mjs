#!/usr/bin/env node
/**
 * Choose the npm version for a publication. Contract: doc/npm-releases.md.
 *
 * - `next` (verified main builds): advance patch from the newest stable release, or from the
 *   newest prerelease line above it, with an explicit `-next.1` suffix. Before the first stable
 *   release the line is 0.0.x-next.1, so 0.1.0 follows it in semantic-version order.
 * - `latest` (explicit release-branch promotion): 0.1.0 first, then advance minor, reset patch.
 * - A commit that is already published on the requested channel is reported, never republished.
 *
 * Usage: node scripts/release-version.mjs next|latest <commit-sha> [package-name]
 * Prints JSON: { version, alreadyPublished, distTag }.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** @param {string} v */
export function parse(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-next\.(\d+))?$/.exec(v);
  return m
    ? { major: +m[1], minor: +m[2], patch: +m[3], next: m[4] === undefined ? null : +m[4] }
    : null;
}
/** @param {ReturnType<typeof parse>} a @param {ReturnType<typeof parse>} b */
export function compare(a, b) {
  return (
    a.major - b.major ||
    a.minor - b.minor ||
    a.patch - b.patch ||
    // A prerelease sorts before the release with the same core.
    (a.next === null ? 1 : 0) - (b.next === null ? 1 : 0) ||
    (a.next ?? 0) - (b.next ?? 0)
  );
}

/**
 * @param {{ channel: "next" | "latest", sha: string, published: { version: string, gitHead?: string }[] }} input
 * @returns {{ version: string | null, alreadyPublished: string | null, distTag: string }}
 */
export function chooseVersion({ channel, sha, published }) {
  const known = published.map((p) => ({ ...p, parsed: parse(p.version) })).filter((p) => p.parsed);
  const sameCommit = known.find(
    (p) =>
      p.gitHead === sha && (channel === "latest" ? p.parsed.next === null : p.parsed.next !== null),
  );
  if (sameCommit) return { version: null, alreadyPublished: sameCommit.version, distTag: channel };
  const stable = known
    .filter((p) => p.parsed.next === null)
    .map((p) => p.parsed)
    .sort(compare)
    .at(-1);
  if (channel === "latest") {
    const version = stable ? `${stable.major}.${stable.minor + 1}.0` : "0.1.0";
    return { version, alreadyPublished: null, distTag: "latest" };
  }
  const base = stable ?? { major: 0, minor: 0, patch: 0, next: null };
  // Prereleases on the current stable line (same major.minor, above the stable patch).
  const line = known
    .map((p) => p.parsed)
    .filter(
      (p) =>
        p.next !== null && p.major === base.major && p.minor === base.minor && p.patch > base.patch,
    );
  const patch = Math.max(base.patch, ...line.map((p) => p.patch)) + 1;
  return {
    version: `${base.major}.${base.minor}.${patch}-next.1`,
    alreadyPublished: null,
    distTag: "next",
  };
}

/** Read publication history (version and source commit) from the public registry. */
export async function registryHistory(name, fetchImpl = fetch) {
  const response = await fetchImpl(`https://registry.npmjs.org/${name.replace("/", "%2f")}`);
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`npm registry returned ${response.status} for ${name}.`);
  const doc = await response.json();
  return Object.values(doc.versions ?? {}).map((v) => ({ version: v.version, gitHead: v.gitHead }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [channel, sha, nameArg] = process.argv.slice(2);
  if (!["next", "latest"].includes(channel) || !/^[0-9a-f]{40}$/.test(sha ?? "")) {
    console.error("Usage: release-version.mjs next|latest <40-hex commit sha> [package-name]");
    process.exit(1);
  }
  const name = nameArg ?? JSON.parse(await readFile("package.json", "utf8")).name;
  const result = chooseVersion({ channel, sha, published: await registryHistory(name) });
  process.stdout.write(JSON.stringify(result) + "\n");
}
