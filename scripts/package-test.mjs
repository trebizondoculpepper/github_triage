#!/usr/bin/env node
/**
 * Installed-archive test (doc/npm-releases.md, "Verification and publication").
 *
 * Packs the real npm archive, checks its contents against the allowlist, installs that exact
 * archive into a clean temporary consumer project, and runs the installed `github-triage`
 * executable through npm's bin link: help, invalid arguments, and the credential-free offline
 * smoke checks. Direct source or dist execution alone is not enough (#11).
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const windows = process.platform === "win32";
const npm = (args, cwd) => run(windows ? "npm.cmd" : "npm", args, { cwd, shell: windows });
const root = resolve(".");
const expected = ["LICENSE", "README.md", "dist/cli.mjs", "package.json"];

const work = await mkdtemp(join(tmpdir(), "triage-package-"));
try {
  const { stdout } = await npm(
    ["pack", "--json", "--pack-destination", work, "--ignore-scripts"],
    root,
  );
  const [packed] = JSON.parse(stdout);
  const files = packed.files.map((f) => f.path).sort();
  if (JSON.stringify(files) !== JSON.stringify(expected))
    throw new Error(
      `Archive contents ${JSON.stringify(files)} differ from ${JSON.stringify(expected)}.`,
    );
  console.log(`ok   archive ${packed.filename} contains exactly the allowlisted files`);

  const consumer = join(work, "consumer");
  await run(process.execPath, ["-e", `require("fs").mkdirSync(${JSON.stringify(consumer)})`]);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", private: true }),
  );
  await npm(
    ["install", "--no-audit", "--no-fund", "--save-dev", join(work, packed.filename)],
    consumer,
  );
  const manifest = JSON.parse(
    await readFile(
      join(consumer, "node_modules", ...packed.name.split("/"), "package.json"),
      "utf8",
    ),
  );
  if (manifest.scripts?.postinstall || manifest.scripts?.install || manifest.scripts?.preinstall)
    throw new Error("The package must not run install scripts in consumers.");
  console.log("ok   installed into a clean consumer without install scripts");

  const bin = join(
    consumer,
    "node_modules",
    ".bin",
    windows ? "github-triage.cmd" : "github-triage",
  );
  const cli = (args) => run(bin, args, { cwd: consumer, shell: windows });
  const help = await cli(["--help"]);
  if (!help.stdout.startsWith("Usage:")) throw new Error("Installed bin printed no help.");
  console.log("ok   installed bin prints help");
  const invalid = await cli(["--no-such-option"]).then(
    () => null,
    (error) => error,
  );
  if (invalid?.code !== 1)
    throw new Error(`Invalid arguments exited ${invalid?.code ?? 0}, not 1.`);
  console.log("ok   installed bin exits 1 on invalid arguments");

  // Reuse the credential-free smoke checks (offline fixtures, unreachable gh) on the installed copy.
  const installed = join(consumer, "node_modules", ...packed.name.split("/"), "dist", "cli.mjs");
  await run(process.execPath, [join(root, "scripts", "smoke.mjs"), installed], { cwd: consumer });
  console.log("ok   smoke checks pass on the installed package");
  console.log("Package test passed.");
} finally {
  await rm(work, { recursive: true, force: true });
}
