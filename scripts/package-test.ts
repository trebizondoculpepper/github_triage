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
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveEngineSetting, defaultEngine } from "../src/engine-setting.js";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const run = promisify(execFile);
const windows = process.platform === "win32";
const npm = (args: string[], cwd: string) =>
  run(windows ? "npm.cmd" : "npm", args, { cwd, shell: windows });
const root = resolve(".");
const expected = [
  "LICENSE",
  "README.md",
  "dist/cli.mjs",
  "dist/mcp.mjs",
  "package.json",
  "third-party/README.md",
  "third-party/datascript-LICENSE",
];

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

/**
 * A credential-free stand-in for `gh` (#260): answers every GraphQL read with one fixed
 * repository state, so the installed CLI and MCP server collect identical facts.
 */
const fakeGh = `#!/usr/bin/env node
const time = "2026-11-12T10:00:00.000Z";
const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
const issue = (number, labels, createdAt) => ({
  number, title: "Ticket " + number, body: "", url: "https://github.com/example/parity/issues/" + number,
  state: "OPEN", stateReason: null, createdAt, updatedAt: time,
  issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
  blockedBy: page([]), blocking: page([]), labels: page(labels.map((name) => ({ name }))), comments: page([]),
});
const args = process.argv.slice(2);
if (args[0] !== "api" || args[1] !== "graphql") { process.stderr.write("unsupported"); process.exit(1); }
const query = (args.find((a) => a.startsWith("query=")) || "");
const issues = query.includes("issues(first") ? [
  issue(1, ["status:ready", "impact:L", "complexity:S"], "2026-11-01T00:00:00Z"),
  issue(2, ["status:ready", "impact:XL"], "2026-11-02T00:00:00Z"),
  issue(3, ["status:needs-design", "complexity:XS"], "2026-11-03T00:00:00Z"),
  issue(4, ["status:ready", "impact:S", "complexity:M"], "2026-10-01T00:00:00Z"),
] : [];
process.stdout.write(JSON.stringify({ data: { repository: { issues: page(issues), pullRequests: page([]) } } }));
`;
const parityFields = [
  "actions",
  "role",
  "rankedActions",
  "estimation",
  "impactEstimation",
  "decisionEngine",
] as const;
type Report = Record<string, unknown>;
const rankedKinds = (report: Report): string[] => {
  const ranked = report.rankedActions as { items?: { kind: string; target: string }[] } | null;
  return (ranked?.items ?? []).map((i) => `${i.kind}#${i.target.split("/").pop()}`);
};

/**
 * Installed CLI and installed MCP server must report the same blended role queue (#260,
 * doc/design/mcp.md "Role views"). Returns the ranked kinds for the evidence log.
 */
async function blendedParity(
  cliBin: string,
  mcpCommand: { command: string; args: string[] },
  repository: string,
  role: string,
  order: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  expectedEngine = defaultEngine(),
): Promise<string[]> {
  const cliRun = await run(
    windows ? `"${cliBin}"` : cliBin,
    [
      "--repo",
      repository,
      "--role",
      role,
      "--order",
      order,
      "--limit",
      "10",
      "--json",
      "--no-update-check",
    ],
    { cwd, env, shell: windows, maxBuffer: 64 * 1024 * 1024 },
  );
  const cli = JSON.parse(cliRun.stdout) as Report;
  if ((cli.decisionEngine as { used?: string })?.used !== expectedEngine)
    throw new Error(`Installed engine is not ${expectedEngine}.`);
  if (expectedEngine === "datalog") {
    const ranked = cli.rankedActions as {
      items: { why?: { text?: string; facts?: object }; ruleIds?: string[] }[];
    };
    if (
      !ranked.items.length ||
      ranked.items.some((row) => !row.why?.text || !row.ruleIds?.length || !row.why.facts)
    )
      throw new Error("Installed Datalog reasons lack rule/fact bindings.");
  }
  const transport = new StdioClientTransport({
    command: mcpCommand.command,
    args: [...mcpCommand.args, "--repo", repository, "--project", cwd],
    cwd,
    env: env as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "package-test", version: "1.0.0" });
  await client.connect(transport);
  let mcp: Report;
  try {
    const result = await client.callTool({
      name: "triage_briefing",
      arguments: { role, order, limit: 10 },
    });
    const structured = result.structuredContent as { status?: string; result?: Report } | undefined;
    if (!structured?.result)
      throw new Error(`Installed MCP returned no ${role} briefing (${structured?.status}).`);
    mcp = structured.result;
  } finally {
    await client.close();
  }
  for (const key of parityFields)
    if (JSON.stringify(cli[key]) !== JSON.stringify(mcp[key]))
      throw new Error(
        `Installed CLI and MCP disagree on ${key} for ${role} (${order}): CLI ${JSON.stringify(cli[key])} MCP ${JSON.stringify(mcp[key])}.`,
      );
  return rankedKinds(cli);
}

const work = await mkdtemp(join(tmpdir(), "triage-package-"));
try {
  const { stdout } = await npm(
    ["pack", "--json", "--pack-destination", work, "--ignore-scripts"],
    root,
  );
  const packed = parsePack(stdout);
  const files = packed.files.map((f) => f.path).sort();
  const engineChunks = files.filter((p) => /^dist\/datalog-[A-Za-z0-9_-]+\.mjs$/.test(p));
  if (engineChunks.length !== 1)
    throw new Error("Expected exactly one packaged lazy evaluator chunk.");
  const expectedFiles = [...expected, ...engineChunks].sort();
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles))
    throw new Error(
      `Archive contents ${JSON.stringify(files)} differ from ${JSON.stringify(expectedFiles)}.`,
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
    // Blended role queues (#259): help names the ranked queue and its assessment kinds.
    if (!help.stdout.includes("rankedActions") || !help.stdout.includes("estimate-complexity"))
      throw new Error(`Installed bin help does not describe the blended queue in ${cwd}.`);
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
    // Impact guidance (#246): the bundled impact definition ships and renders as text and JSON.
    const impactHelp = await cli(["estimate", "--help", "--metric", "impact"]);
    const impactJson = await cli(["estimate", "--help", "--metric", "impact", "--json"]);
    if (
      !impactHelp.stdout.includes("Impact estimation guidance (version") ||
      !impactHelp.stdout.includes("impact:XS") ||
      !help.stdout.includes("estimate --help --metric impact") ||
      (JSON.parse(impactJson.stdout) as { kind?: string }).kind !== "impact-guidance"
    )
      throw new Error(`Installed bin printed no impact guidance in ${cwd}.`);
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
    // Delivery records (#189): the installed help documents every deliverables command.
    const deliverablesHelp = await cli(["deliverables", "--help"]);
    if (
      !help.stdout.includes("deliverables N attach") ||
      ![
        "attach",
        "detach",
        "retarget",
        "handoff",
        "membership",
        "attest",
        "reassign",
        "reset",
        "void",
        "--legacy",
        "TARGET_MISMATCH",
      ].every((term) => deliverablesHelp.stdout.includes(term))
    )
      throw new Error(`Installed bin does not document deliverables commands in ${cwd}.`);
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
  // #246: MCP help carries the same bundled impact guidance and the CLI commands for it.
  if (
    !mcpHelp.stdout.includes("Impact estimation guidance (version") ||
    !mcpHelp.stdout.includes("github-triage estimate --help --metric impact")
  )
    throw new Error("Installed MCP help carries no impact guidance.");
  console.log(
    "ok   installed github-triage-mcp completes a stdio round trip (four read-only tools)",
  );
  // #260: installed CLI and MCP produce identical blended role queues from the same facts.
  const mcpCommand = windows
    ? { command: process.execPath, args: [join(packageDir, "dist", "mcp.mjs")] }
    : { command: mcpBin, args: [] };
  if (windows)
    // execFile("gh") resolves only gh.exe on Windows, so a script stand-in cannot be found.
    console.log("skip installed blended-queue parity with a fake gh (not supported on Windows)");
  else {
    // A checkout of the fixture repository, so repository configuration resolves (absent).
    const checkout = join(work, "parity-checkout");
    await mkdir(checkout);
    await run("git", ["init", "-q"], { cwd: checkout });
    await run("git", ["remote", "add", "origin", "https://github.com/example/parity.git"], {
      cwd: checkout,
    });
    const fakeDir = join(work, "fake-gh");
    await mkdir(fakeDir);
    await writeFile(join(fakeDir, "gh"), fakeGh);
    await chmod(join(fakeDir, "gh"), 0o755);
    const env = {
      ...process.env,
      PATH: `${fakeDir}${delimiter}${process.env.PATH ?? ""}`,
      GITHUB_TRIAGE_NO_UPDATE_CHECK: "1",
    };
    const want: Record<string, string> = {
      implementer: "estimate-complexity",
      designer: "assess-impact",
    };
    for (const role of ["implementer", "designer"])
      for (const order of ["impact", "oldest"]) {
        const kinds = await blendedParity(
          bin,
          mcpCommand,
          "example/parity",
          role,
          order,
          env,
          checkout,
        );
        if (!kinds.some((k) => k.startsWith(want[role]!)))
          throw new Error(
            `Installed ${role} queue has no ${want[role]} action: ${kinds.join(", ")}.`,
          );
        console.log(`ok   installed CLI = MCP ${role} (${order}): ${kinds.join(", ")}`);
      }
    await run(bin, ["config", "set", "briefing.engine", "typescript"], { cwd: checkout, env });
    for (const role of ["implementer", "designer"])
      for (const order of ["impact", "oldest"]) {
        const kinds = await blendedParity(
          bin,
          mcpCommand,
          "example/parity",
          role,
          order,
          env,
          checkout,
          "typescript",
        );
        console.log(
          `ok   installed TypeScript rollback CLI = MCP ${role} (${order}): ${kinds.join(", ")}`,
        );
      }
  }
  // Optional read-only live smoke (#260): GITHUB_TRIAGE_PACKAGE_LIVE_REPO=owner/name uses the
  // real authenticated gh from this checkout. No labels, claims or other writes are made.
  const live = process.env.GITHUB_TRIAGE_PACKAGE_LIVE_REPO;
  if (live) {
    const revision = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    const version = (
      await run(windows ? `"${bin}"` : bin, ["version", "--no-update-check"], { shell: windows })
    ).stdout.split("\n")[0];
    console.log(`live source revision ${revision}; executable ${bin} (${version})`);
    const env = { ...process.env, GITHUB_TRIAGE_NO_UPDATE_CHECK: "1" };
    const selected = await resolveEngineSetting(live, { cwd: root });
    for (const role of ["implementer", "designer"]) {
      const kinds = await blendedParity(
        bin,
        mcpCommand,
        live,
        role,
        "impact",
        env,
        root,
        selected.requested,
      );
      console.log(`ok   live ${live} installed CLI = MCP ${role}: ${kinds.join(", ")}`);
    }
  }
  console.log("Package test passed.");
} finally {
  await rm(work, { recursive: true, force: true });
}
