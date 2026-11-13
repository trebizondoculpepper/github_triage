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
 * Usage: npx tsx scripts/release-version.ts next|latest <commit-sha> [package-name]
 * Prints JSON: { version, alreadyPublished, distTag }.
 *        npx tsx scripts/release-version.ts following <prerelease>   (prints the next prerelease)
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  next: number | null;
}
export interface Publication {
  version: string;
  gitHead?: string;
}
export type Channel = "next" | "latest";
export interface VersionChoice {
  version: string | null;
  alreadyPublished: string | null;
  distTag: string;
}

export function parse(v: string): ParsedVersion | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-next\.(\d+))?$/.exec(v);
  return m
    ? { major: +m[1], minor: +m[2], patch: +m[3], next: m[4] === undefined ? null : +m[4] }
    : null;
}
export function compare(a: ParsedVersion, b: ParsedVersion): number {
  return (
    a.major - b.major ||
    a.minor - b.minor ||
    a.patch - b.patch ||
    // A prerelease sorts before the release with the same core.
    (a.next === null ? 1 : 0) - (b.next === null ? 1 : 0) ||
    (a.next ?? 0) - (b.next ?? 0)
  );
}

export function chooseVersion({
  channel,
  sha,
  published,
}: {
  channel: Channel;
  sha: string;
  published: Publication[];
}): VersionChoice {
  const known = published.flatMap((p) => {
    const parsed = parse(p.version);
    return parsed ? [{ ...p, parsed }] : [];
  });
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
  const base: ParsedVersion = stable ?? { major: 0, minor: 0, patch: 0, next: null };
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

/**
 * The next prerelease after one that npm reports as already taken, used when the registry's
 * read view lagged behind an earlier publication (#57). Only `next` advances this way: an
 * official version is never bumped past a conflict, because the conflict most likely means
 * the same release is already published.
 */
export function followingPrerelease(version: string): string {
  const p = parse(version);
  if (!p || p.next === null) throw new Error(`Not a -next prerelease: ${version}`);
  return `${p.major}.${p.minor}.${p.patch + 1}-next.1`;
}

/** Read publication history (version and source commit) from the public registry. */
export async function registryHistory(
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Publication[]> {
  const response = await fetchImpl(`https://registry.npmjs.org/${name.replace("/", "%2f")}`);
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`npm registry returned ${response.status} for ${name}.`);
  const doc: unknown = await response.json();
  const versions = isRecord(doc) && isRecord(doc.versions) ? doc.versions : {};
  return Object.values(versions).map((v) => ({
    version: String(isRecord(v) ? v.version : undefined),
    gitHead: isRecord(v) && typeof v.gitHead === "string" ? v.gitHead : undefined,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [channel, sha, nameArg] = process.argv.slice(2);
  if (channel === "following") {
    process.stdout.write(followingPrerelease(sha ?? "") + "\n");
    process.exit(0);
  }
  if ((channel !== "next" && channel !== "latest") || !/^[0-9a-f]{40}$/.test(sha ?? "")) {
    console.error("Usage: release-version.ts next|latest <40-hex commit sha> [package-name]");
    process.exit(1);
  }
  const manifest: unknown = JSON.parse(await readFile("package.json", "utf8"));
  const name = nameArg ?? String(isRecord(manifest) ? manifest.name : undefined);
  const result = chooseVersion({ channel, sha: sha ?? "", published: await registryHistory(name) });
  process.stdout.write(JSON.stringify(result) + "\n");
}
