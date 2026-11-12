#!/usr/bin/env node
/**
 * Installed-archive test (doc/npm-releases.md, "Verification and publication").
 *
 * Packs the real npm archive, checks its contents against the allowlist, installs that exact
 * archive globally into an isolated temporary npm prefix (the recommended installation, #17),
 * and runs the installed `github-triage` executable through npm's bin link from separate
 * working directories: help, invalid arguments, and the credential-free offline smoke checks.
 * Direct source or dist execution alone is not enough (#11).
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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

  // The recommended installation is global (#17): one executable serves many checkouts.
  // Install into an isolated temporary prefix so the test never touches the real global tree.
  const prefix = join(work, "prefix");
  await npm(
    [
      "install",
      "--global",
      "--prefix",
      prefix,
      "--no-audit",
      "--no-fund",
      join(work, packed.filename),
    ],
    work,
  );
  const packageDir = windows
    ? join(prefix, "node_modules", ...packed.name.split("/"))
    : join(prefix, "lib", "node_modules", ...packed.name.split("/"));
  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  if (manifest.scripts?.postinstall || manifest.scripts?.install || manifest.scripts?.preinstall)
    throw new Error("The package must not run install scripts on installation.");
  console.log("ok   installed globally into an isolated prefix without install scripts");

  const bin = windows ? join(prefix, "github-triage.cmd") : join(prefix, "bin", "github-triage");
  // Separate working directories stand in for different project checkouts.
  const checkouts = [join(work, "checkout-a"), join(work, "checkout-b")];
  for (const dir of checkouts) await mkdir(dir);
  for (const cwd of checkouts) {
    // With shell: true, Windows needs the .cmd path quoted (temporary paths may contain spaces).
    const cli = (args) => run(windows ? `"${bin}"` : bin, args, { cwd, shell: windows });
    const help = await cli(["--help"]);
    if (!help.stdout.startsWith("Usage:"))
      throw new Error(`Installed bin printed no help in ${cwd}.`);
    const invalid = await cli(["--no-such-option"]).then(
      () => null,
      (error) => error,
    );
    if (invalid?.code !== 1)
      throw new Error(`Invalid arguments exited ${invalid?.code ?? 0}, not 1, in ${cwd}.`);
    // Reuse the credential-free smoke checks (offline fixtures, unreachable gh) on the
    // globally installed copy, run from this working directory.
    await run(
      process.execPath,
      [join(root, "scripts", "smoke.mjs"), join(packageDir, "dist", "cli.mjs")],
      {
        cwd,
      },
    );
  }
  console.log(
    "ok   global bin works from separate working directories (help, invalid args, smoke)",
  );
  console.log("Package test passed.");
} finally {
  await rm(work, { recursive: true, force: true });
}
