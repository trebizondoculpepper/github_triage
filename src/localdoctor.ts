/**
 * Local configuration doctor (#64). Contract: doc/design/diagnostics.md "#64" and
 * doc/design/identity.md.
 *
 * Read-only. Each check is independent, so one failure never hides another. It never creates
 * identities, edits TOML, changes roles, installs hooks, alters Git tracking or logs in. It
 * never prints file contents, credentials or `gh` output; paths are reported relative to the
 * checkout so output can be shared without exposing the local filesystem layout.
 *
 * `agent-inbox.toml` contents are not read: doc/design/mcp.md requires a maintained TOML parser
 * and none is approved as a dependency yet (open question on #25). Those checks report
 * `unsupported` with the explicit `--agent`/`--role` fallback until that decision lands.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import {
  ConfigError,
  filesystemRefusal,
  nodeFileSystem,
  resolveRepositoryTarget,
} from "./config.js";
import type { ConfigFileSystem, GitRunner } from "./config.js";
import { roleNames } from "./roles.js";

export const LOCAL_DOCTOR_SCHEMA_VERSION = 1;
export const IDENTITY_FILE = "agent-inbox.toml";
export const MINIMUM_NODE_MAJOR = 26;

/** Distinct outcomes: only `ok` is healthy; `unsupported` means this version cannot tell. */
export type CheckStatus = "ok" | "missing" | "invalid" | "access" | "unsupported" | "unknown";

export interface LocalCheck {
  /** Stable diagnostic identifier. */
  id: string;
  status: CheckStatus;
  /** The signal that decided the status (an option, a command's exit code, a file's presence). */
  source: string;
  detail: string;
  /** Exact delivered commands; `<PLACEHOLDER>` marks a value needing judgment. */
  next: string[];
}

export interface LocalDoctorReport {
  schemaVersion: typeof LOCAL_DOCTOR_SCHEMA_VERSION;
  scope: "local-configuration";
  repository: string | null;
  agent: string | null;
  role: string | null;
  checks: LocalCheck[];
  summary: Record<CheckStatus, number>;
}

/** Outcome of running a program: exit code, or null when it could not be started. */
export interface ProbeResult {
  code: number | null;
  stdout: string;
}
/** Process boundary; output is used only for parsing, never echoed. */
export type Probe = (command: string, args: readonly string[], cwd: string) => Promise<ProbeResult>;

export const nodeProbe: Probe = (command, args, cwd) =>
  new Promise((resolve) => {
    execFile(command, [...args], { cwd, windowsHide: true, timeout: 15_000 }, (error, stdout) => {
      if (!error) return resolve({ code: 0, stdout: String(stdout) });
      const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
      resolve({ code: typeof code === "number" ? code : null, stdout: String(stdout ?? "") });
    });
  });

export interface LocalDoctorRuntime {
  readonly cwd?: string;
  readonly fs?: ConfigFileSystem;
  readonly probe?: Probe;
  /** Node version string such as "26.1.0"; defaults to the running process. */
  readonly nodeVersion?: string;
}

export interface LocalDoctorOptions {
  repo?: string;
  agent?: string;
  role?: string;
}

const gitRunner =
  (probe: Probe): GitRunner =>
  async (args, cwd) => {
    const result = await probe("git", args, cwd);
    if (result.code !== 0) throw new Error(`git ${args[0]} failed`);
    return result.stdout;
  };

/** Diagnose local project and agent configuration. Never throws for missing evidence. */
export async function localDoctor(
  options: LocalDoctorOptions,
  runtime: LocalDoctorRuntime = {},
): Promise<LocalDoctorReport> {
  const probe = runtime.probe ?? nodeProbe;
  const fs = runtime.fs ?? nodeFileSystem;
  const cwd = runtime.cwd ?? process.cwd();
  const checks: LocalCheck[] = [];
  const add = (check: LocalCheck) => void checks.push(check);
  const report: LocalDoctorReport = {
    schemaVersion: LOCAL_DOCTOR_SCHEMA_VERSION,
    scope: "local-configuration",
    repository: null,
    agent: options.agent ?? null,
    role: options.role ?? null,
    checks,
    summary: { ok: 0, missing: 0, invalid: 0, access: 0, unsupported: 0, unknown: 0 },
  };

  // runtime.node
  const nodeVersion = runtime.nodeVersion ?? process.versions.node;
  const major = Number(/^v?(\d+)\./.exec(nodeVersion)?.[1]);
  add(
    Number.isFinite(major)
      ? major >= MINIMUM_NODE_MAJOR
        ? {
            id: "runtime.node",
            status: "ok",
            source: "node version",
            detail: `Node ${nodeVersion}.`,
            next: [],
          }
        : {
            id: "runtime.node",
            status: "invalid",
            source: "node version",
            detail: `Node ${nodeVersion} is older than the required ${MINIMUM_NODE_MAJOR}.`,
            next: [`Install Node ${MINIMUM_NODE_MAJOR} or later, then run: node --version`],
          }
      : {
          id: "runtime.node",
          status: "unknown",
          source: "node version",
          detail: "Node version could not be read.",
          next: ["node --version"],
        },
  );

  // gh.available and gh.auth: exit codes only; gh output may contain account details.
  const ghVersion = await probe("gh", ["--version"], cwd);
  if (ghVersion.code === null) {
    add({
      id: "gh.available",
      status: "missing",
      source: "gh --version could not start",
      detail: "The GitHub CLI (gh) is not installed or not on PATH.",
      next: ["Install the GitHub CLI from https://cli.github.com, then run: gh --version"],
    });
    add({
      id: "gh.auth",
      status: "unknown",
      source: "gh unavailable",
      detail: "Authentication cannot be checked without gh.",
      next: ["gh auth status"],
    });
  } else {
    add(
      ghVersion.code === 0
        ? {
            id: "gh.available",
            status: "ok",
            source: "gh --version exit 0",
            detail: "gh is installed.",
            next: [],
          }
        : {
            id: "gh.available",
            status: "unknown",
            source: `gh --version exit ${ghVersion.code}`,
            detail: "gh started but did not report a version.",
            next: ["gh --version"],
          },
    );
    const auth = await probe("gh", ["auth", "status", "--active", "--hostname", "github.com"], cwd);
    add(
      auth.code === 0
        ? {
            id: "gh.auth",
            status: "ok",
            source: "gh auth status exit 0",
            detail: "gh is authenticated to github.com (credentials not read).",
            next: [],
          }
        : {
            id: "gh.auth",
            status: auth.code === 1 ? "access" : "unknown",
            source:
              auth.code === null
                ? "gh auth status could not start"
                : `gh auth status exit ${auth.code}`,
            detail:
              auth.code === 1
                ? "gh is not authenticated to github.com, or its token is invalid."
                : "gh authentication state could not be determined.",
            next: ["gh auth status", "gh auth login --hostname github.com"],
          },
    );
  }

  // project.checkout
  let root: string | null = null;
  try {
    const target = await resolveRepositoryTarget(cwd, options.repo, gitRunner(probe));
    root = target.root;
    report.repository = target.repository;
    add({
      id: "project.checkout",
      status: "ok",
      source: options.repo
        ? "--repo matched a GitHub remote of this checkout"
        : "single GitHub remote of this checkout",
      detail: `This checkout is ${target.repository}.`,
      next: [],
    });
  } catch (caught) {
    if (!(caught instanceof ConfigError)) throw caught;
    const notRepo = caught.code === "not-a-repository";
    add({
      id: "project.checkout",
      status: notRepo ? "missing" : "unknown",
      source: notRepo ? "git rev-parse --show-toplevel" : "git remote -v",
      detail: notRepo
        ? "The working directory is not inside a Git checkout, so local configuration cannot be located."
        : options.repo
          ? `This checkout has no GitHub remote for ${options.repo}.`
          : "This checkout does not have exactly one GitHub remote; the intended project is ambiguous.",
      next: notRepo
        ? ["cd <CHECKOUT_OF_INTENDED_REPOSITORY> && github-triage doctor"]
        : ["git remote -v", "github-triage doctor --repo <OWNER/NAME>"],
    });
  }

  // identity.file, identity.git-ignored, identity.git-tracked
  if (root === null) {
    for (const id of ["identity.file", "identity.git-ignored", "identity.git-tracked"])
      add({
        id,
        status: "unknown",
        source: "no checkout",
        detail: "No checkout was resolved, so this was not checked.",
        next: [],
      });
  } else {
    try {
      const present = (await fs.readText(join(root, IDENTITY_FILE))) !== null;
      add(
        present
          ? {
              id: "identity.file",
              status: "ok",
              source: `${IDENTITY_FILE} exists`,
              detail: `${IDENTITY_FILE} is present at the checkout root (contents not shown).`,
              next: [],
            }
          : {
              id: "identity.file",
              status: "missing",
              source: `${IDENTITY_FILE} absent`,
              detail: `No ${IDENTITY_FILE} at the checkout root. Triage still works with an explicit agent name.`,
              next: ["github-triage --agent <AGENT_NAME> --role <ROLE>"],
            },
      );
    } catch (caught) {
      const refusal = filesystemRefusal(caught);
      if (!refusal) throw caught;
      add({
        id: "identity.file",
        status: "access",
        source: `${IDENTITY_FILE} unreadable (${(caught as NodeJS.ErrnoException).code})`,
        detail: `${IDENTITY_FILE} exists but could not be read.`,
        next: [`ls -l ${IDENTITY_FILE}`],
      });
    }
    // --no-index asks whether a rule exists, independent of whether the file is tracked.
    const ignored = await probe(
      "git",
      ["check-ignore", "--quiet", "--no-index", IDENTITY_FILE],
      root,
    );
    add(
      ignored.code === 0
        ? {
            id: "identity.git-ignored",
            status: "ok",
            source: "git check-ignore exit 0",
            detail: `An ignore rule covers ${IDENTITY_FILE}.`,
            next: [],
          }
        : ignored.code === 1
          ? {
              id: "identity.git-ignored",
              status: "missing",
              source: "git check-ignore exit 1",
              detail: `No ignore rule covers ${IDENTITY_FILE}; a local identity could be committed.`,
              next: [`echo ${IDENTITY_FILE} >> "$(git rev-parse --git-path info/exclude)"`],
            }
          : {
              id: "identity.git-ignored",
              status: "unknown",
              source: "git check-ignore failed",
              detail: "Ignore rules could not be checked.",
              next: [`git check-ignore -v --no-index ${IDENTITY_FILE}`],
            },
    );
    const tracked = await probe("git", ["ls-files", "--error-unmatch", "--", IDENTITY_FILE], root);
    add(
      tracked.code === 0
        ? {
            id: "identity.git-tracked",
            status: "invalid",
            source: "git ls-files exit 0",
            detail: `${IDENTITY_FILE} is tracked by Git. An ignore rule does not untrack it; removing it from the index is a separate, deliberate change.`,
            next: [`git rm --cached -- ":/${IDENTITY_FILE}"`],
          }
        : tracked.code === 1
          ? {
              id: "identity.git-tracked",
              status: "ok",
              source: "git ls-files exit 1",
              detail: `${IDENTITY_FILE} is not tracked.`,
              next: [],
            }
          : {
              id: "identity.git-tracked",
              status: "unknown",
              source: "git ls-files failed",
              detail: "Tracking state could not be checked.",
              next: [`git ls-files -- ${IDENTITY_FILE}`],
            },
    );
  }

  // identity.entry: parse, harness/server entry and persistent name need a TOML parser.
  add({
    id: "identity.entry",
    status: "unsupported",
    source: "no approved TOML parser (#25)",
    detail: `This version does not read ${IDENTITY_FILE}, so parse validity, the harness/server entry (including distinct Ori entries) and its persistent name are not checked. Pass the name explicitly.`,
    next: ["github-triage --agent <AGENT_NAME>"],
  });
  add({
    id: "identity.compatibility",
    status: "unsupported",
    source: "doc/design/identity.md (#69)",
    detail:
      "Agent Inbox's writer may drop triage_role and does not establish Ori per-server mapping; shared writes stay disabled.",
    next: [],
  });

  // identity.agent: the deciding signal for which agent this is.
  add(
    options.agent
      ? {
          id: "identity.agent",
          status: "ok",
          source: "--agent",
          detail: `Agent ${options.agent} supplied explicitly.`,
          next: [],
        }
      : {
          id: "identity.agent",
          status: "unknown",
          source: "no --agent; automatic lookup unsupported",
          detail:
            "No agent identity resolved. A shared GitHub login does not identify an agent; reads are unfocused.",
          next: ["github-triage doctor --agent <AGENT_NAME>"],
        },
  );

  // triage.role: validated against the registered views; Agent Inbox's `role` is different.
  const roles = roleNames();
  add(
    options.role === undefined
      ? {
          id: "triage.role",
          status: "unsupported",
          source: "triage_role not read (#25)",
          detail: `triage_role in ${IDENTITY_FILE} is not read by this version; Agent Inbox's mailbox role is a different field. Supported views: ${roles.join(", ")}.`,
          next: ["github-triage doctor --role <ROLE>"],
        }
      : roles.includes(options.role)
        ? {
            id: "triage.role",
            status: "ok",
            source: "--role",
            detail: `${options.role} is a registered view.`,
            next: [],
          }
        : {
            id: "triage.role",
            status: "invalid",
            source: "--role",
            detail: `${options.role} is not a registered view. Supported: ${roles.join(", ")}.`,
            next: roles.map((r) => `github-triage doctor --role ${r}`),
          },
  );

  for (const check of checks) report.summary[check.status] += 1;
  return report;
}

/** 0: nothing actionable; 1: missing, invalid or access problems; 2: only unknowns remain. */
export function localDoctorExitCode(report: LocalDoctorReport): number {
  const { missing, invalid, access, unknown } = report.summary;
  if (missing + invalid + access > 0) return 1;
  return unknown > 0 ? 2 : 0;
}

export function localDoctorText(report: LocalDoctorReport): string {
  const lines = [
    `Local configuration doctor${report.repository ? `: ${report.repository}` : ""}`,
    "Read-only; nothing was changed. Unknown and unsupported are not healthy.",
  ];
  for (const check of report.checks) {
    lines.push(
      `${check.status.toUpperCase().padEnd(11)} ${check.id} — ${check.detail} [${check.source}]`,
    );
    for (const next of check.next) lines.push(`            next: ${next}`);
  }
  const s = report.summary;
  lines.push(
    `Summary: ${s.ok} ok, ${s.missing} missing, ${s.invalid} invalid, ${s.access} access, ${s.unknown} unknown, ${s.unsupported} unsupported.`,
  );
  return lines.join("\n") + "\n";
}
