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
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const run = promisify(execFile);
const windows = process.platform === "win32";
const npm = (args: string[], cwd: string) =>
  run(windows ? "npm.cmd" : "npm", args, { cwd, shell: windows });
const root = resolve(".");
const expected = ["LICENSE", "README.md", "dist/cli.mjs", "dist/mcp.mjs", "package.json"];

interface PackResult {
  filename: string;
  name: string;
  files: { path: string }[];
}

/** Validate `npm pack --json` output instead of trusting its shape. */
function parsePack(stdout: string): PackResult {
  const parsed: unknown = JSON.parse(stdout);
  // npm <= 11 prints an array of results; npm 12 prints an object keyed by package name.
  const first: unknown = Array.isArray(parsed)
    ? parsed[0]
    : typeof parsed === "object" && parsed !== null
      ? Object.values(parsed)[0]
      : undefined;
  if (
    typeof first === "object" &&
    first !== null &&
    "filename" in first &&
    typeof first.filename === "string" &&
    "name" in first &&
    typeof first.name === "string" &&
    "files" in first &&
    Array.isArray(first.files)
  ) {
    const files = first.files.map((f: unknown) => {
      if (typeof f === "object" && f !== null && "path" in f && typeof f.path === "string")
        return { path: f.path };
      throw new Error("npm pack reported a file without a path.");
    });
    return { filename: first.filename, name: first.name, files };
  }
  throw new Error("npm pack --json returned an unexpected result.");
}

const work = await mkdtemp(join(tmpdir(), "triage-package-"));
try {
  const { stdout } = await npm(
    ["pack", "--json", "--pack-destination", work, "--ignore-scripts"],
    root,
  );
  const packed = parsePack(stdout);
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
  // Only optional fields are read, each through optional chaining, so any JSON shape is safe.
  const manifest: { scripts?: Record<string, unknown> } | null = JSON.parse(
    await readFile(join(packageDir, "package.json"), "utf8"),
  );
  if (manifest?.scripts?.postinstall || manifest?.scripts?.install || manifest?.scripts?.preinstall)
    throw new Error("The package must not run install scripts on installation.");
  console.log("ok   installed globally into an isolated prefix without install scripts");

  const bin = windows ? join(prefix, "github-triage.cmd") : join(prefix, "bin", "github-triage");
  // Separate working directories stand in for different project checkouts.
  const checkouts = [join(work, "checkout-a"), join(work, "checkout-b")];
  for (const dir of checkouts) await mkdir(dir);
  for (const cwd of checkouts) {
    // With shell: true, Windows needs the .cmd path quoted (temporary paths may contain spaces).
    const cli = (args: string[]) => run(windows ? `"${bin}"` : bin, args, { cwd, shell: windows });
    const help = await cli(["--help"]);
    if (!help.stdout.startsWith("Usage:"))
      throw new Error(`Installed bin printed no help in ${cwd}.`);
    // The bundled complexity guidance must ship inside the packed artifact.
    const guidance = await cli(["estimate", "--help"]);
    if (!/XS[\s\S]*XXL/.test(guidance.stdout) || !guidance.stdout.includes("guidance (version"))
      throw new Error(`Installed bin printed no complexity guidance in ${cwd}.`);
    // Labels-only complexity (#153): the installed artifact names label storage and no field setup.
    if (!guidance.stdout.includes("complexity:XS"))
      throw new Error(`Installed complexity guidance does not describe size labels in ${cwd}.`);
    // Impact estimates (#245): the installed help documents --metric impact and its marker.
    if (
      !help.stdout.includes("--metric impact") ||
      !guidance.stdout.includes("--metric METRIC") ||
      !guidance.stdout.includes("github-triage:impact-estimate v1")
    )
      throw new Error(`Installed bin does not document impact estimates in ${cwd}.`);
    if (/setup complexity|issue field|fieldId/.test(help.stdout + guidance.stdout))
      throw new Error(`Installed bin still advertises retired native-field setup in ${cwd}.`);
    // Repository briefing mode (#170): the installed help documents the mode and its windows.
    const catchUpHelp = await cli(["briefing", "--help"]);
    if (
      !help.stdout.includes("briefing [--last 24h") ||
      !["--last", "--since", "--checkpoint", "--offline", "Scope:"].every((term) =>
        catchUpHelp.stdout.includes(term),
      )
    )
      throw new Error(`Installed bin does not document briefing mode in ${cwd}.`);
    const invalid = await cli(["--no-such-option"]).then(
      () => null,
      (error: { code?: unknown }) => error,
    );
    if (invalid?.code !== 1)
      throw new Error(`Invalid arguments exited ${invalid?.code ?? 0}, not 1, in ${cwd}.`);
    // Reuse the credential-free smoke checks (offline fixtures, unreachable gh) on the
    // globally installed copy, run from this working directory.
    await run(
      process.execPath,
      [
        // The smoke script is TypeScript, run through the development-only tsx loader; the
        // CLI under test is the installed compiled artifact.
        "--import",
        import.meta.resolve("tsx"),
        join(root, "scripts", "smoke.ts"),
        join(packageDir, "dist", "cli.mjs"),
      ],
      {
        cwd,
      },
    );
  }
  console.log(
    "ok   global bin works from separate working directories (help, guidance, invalid args, smoke)",
  );
  // The second bin (#25): a real SDK client completes a stdio round trip with the installed
  // MCP server. Listing tools needs no GitHub access or credentials.
  const mcpBin = windows
    ? join(prefix, "github-triage-mcp.cmd")
    : join(prefix, "bin", "github-triage-mcp");
  const transport = new StdioClientTransport({
    command: windows ? process.execPath : mcpBin,
    args: windows
      ? [join(packageDir, "dist", "mcp.mjs"), "--repo", "example/example"]
      : ["--repo", "example/example"],
    cwd: checkouts[0],
    stderr: "pipe",
  });
  const client = new Client({ name: "package-test", version: "1.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    const want = ["triage_briefing", "triage_dependencies", "triage_events", "triage_issue"];
    if (JSON.stringify(names) !== JSON.stringify(want))
      throw new Error(
        `Installed MCP bin listed ${JSON.stringify(names)}, not ${JSON.stringify(want)}.`,
      );
    if (!tools.every((t) => t.annotations?.readOnlyHint === true))
      throw new Error("Installed MCP tools must all be annotated read-only.");
  } finally {
    await client.close();
  }
  const mcpHelp = await run(
    windows ? `"${join(prefix, "github-triage-mcp.cmd")}"` : mcpBin,
    ["--help"],
    {
      shell: windows,
    },
  );
  if (!mcpHelp.stdout.startsWith("Usage: github-triage-mcp"))
    throw new Error("Installed MCP bin printed no help.");
  console.log(
    "ok   installed github-triage-mcp completes a stdio round trip (four read-only tools)",
  );
  console.log("Package test passed.");
} finally {
  await rm(work, { recursive: true, force: true });
}
