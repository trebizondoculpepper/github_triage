#!/usr/bin/env node
/**
 * Request an official release (doc/npm-releases.md): promote origin/main's current commit to the
 * `release` branch by fast-forward. The Publish workflow verifies it, chooses the next minor
 * version and publishes under `latest`. Nothing is published from the local working tree.
 */
import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
git("fetch", "--no-tags", "origin", "main");
const main = git("rev-parse", "origin/main");
// The first promotion creates the release branch, so it may not exist yet.
let release = "";
if (git("ls-remote", "--heads", "origin", "release")) {
  git("fetch", "--no-tags", "origin", "release");
  release = git("rev-parse", "origin/release");
}
if (release === main) {
  console.log(`release already points at origin/main (${main.slice(0, 7)}); nothing to do.`);
  process.exit(0);
}
if (release) {
  try {
    git("merge-base", "--is-ancestor", release, main);
  } catch {
    console.error("origin/release is not an ancestor of origin/main; refusing a non-fast-forward.");
    process.exit(1);
  }
}
git("push", "origin", `${main}:refs/heads/release`);
console.log(`Promoted ${main.slice(0, 7)} to release; the Publish workflow will release it.`);
