#!/usr/bin/env node
/**
 * Read-only stdio MCP adapter (doc/design/mcp.md, #25). Three tools over the shared read
 * service; no mutation, shell, file-path, cache or checkpoint routes are registered.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod";
import { collect, currentRepository } from "./github.js";
import { dependencyReport } from "./dependencies.js";
import { readBriefing, readDependencies } from "./service.js";
import type { ReadRuntime } from "./service.js";
import { installedVersion } from "./updates.js";

/** Startup selection, explicit only so far (roots and project-local identity lookup are pending on #25). */
export interface McpOptions {
  /** Configured local project used for repository resolution and repository configuration. */
  project?: string;
  repo?: string;
  agent?: string;
}

/** Injected boundaries; tests replace every GitHub-facing one. */
export interface McpRuntime extends ReadRuntime {
  currentRepository: (cwd?: string, signal?: AbortSignal) => Promise<string>;
}

export const mcpHelp = `Usage: github-triage-mcp [--project PATH] [--repo owner/name] [--agent NAME]
Read-only stdio MCP server for github-triage. Requires authenticated gh and Node 26+.
Tools: triage_briefing, triage_issue, triage_dependencies. Never changes GitHub.
  --project PATH        Local project checkout used to resolve the default repository
  --repo owner/name     Default repository (a tool's repo argument wins)
  --agent NAME          Default agent for focused reads (a tool's agent argument wins)
  --help                Show usage
Stdout carries only the MCP protocol; diagnostics go to stderr.
`;

const repoPattern = /^[\w.-]+\/[\w.-]+$/;
const agentPattern = /^[A-Za-z0-9][\w.-]*$/;

/** Parse startup arguments; throws on invalid input. */
export function mcpArguments(args: string[]): McpOptions & { help?: boolean } {
  const { values } = parseArgs({
    args,
    options: {
      project: { type: "string" },
      repo: { type: "string" },
      agent: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.repo !== undefined && !repoPattern.test(values.repo))
    throw new Error("--repo must be owner/name.");
  if (values.agent !== undefined && !agentPattern.test(values.agent))
    throw new Error("--agent must be an agent name such as kavya_sabbagh.");
  return {
    help: values.help,
    project: values.project === undefined ? undefined : resolve(values.project),
    repo: values.repo,
    agent: values.agent,
  };
}

const repo = z.string().regex(repoPattern, "repo must be owner/name").optional();
const agent = z.string().regex(agentPattern, "agent must be an agent name").optional();
const number = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const maxChars = z.number().int().min(1000).max(40000).default(10000);
const since = z
  .string()
  .regex(/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d{2}:\d{2})$/, "since must be an ISO timestamp with a time")
  .refine((text) => Number.isFinite(Date.parse(text)), "since must be a valid timestamp")
  .optional();

export const briefingInput = z.strictObject({
  repo,
  agent,
  since,
  limit: z.number().int().min(1).max(100).default(5),
  maxChars,
});
export const issueInput = z.strictObject({ number, repo, agent, maxChars });
export const dependenciesInput = z.strictObject({
  number,
  repo,
  tree: z.boolean().default(false),
});

const identitySource = z.enum(["tool", "startup", "unresolved"]);
/** Versioned MCP envelope; `result` is the unchanged versioned CLI JSON. */
export const envelope = z.object({
  schemaVersion: z.literal(1),
  kind: z.enum(["briefing", "issue", "dependencies"]),
  status: z.enum(["complete", "incomplete", "error"]),
  selection: z.object({
    repository: z.string().nullable(),
    agent: z.string().nullable(),
    identitySource,
  }),
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type Envelope = z.infer<typeof envelope>;

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** Stable, sanitized failures: no stack traces, subprocess stderr or configuration. */
const failures = {
  "repository-unresolved":
    "No repository selected. Pass repo as owner/name, or start the server with --repo or --project.",
  "collection-failed":
    "GitHub evidence could not be collected. Check gh authentication and repository access, then retry.",
  cancelled: "The request was cancelled before collection finished; no result is reported.",
} as const;
type FailureCode = keyof typeof failures;

class Failure extends Error {
  constructor(readonly code: FailureCode) {
    super(failures[code]);
  }
}

type Kind = Envelope["kind"];
type Selection = Envelope["selection"];

function toolResult(structured: Envelope, text: string) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: structured,
    ...(structured.status === "error" ? { isError: true } : {}),
  };
}

function plain(value: object): Record<string, unknown> {
  // The CLI's JSON output is exactly this serialization; keep the MCP result byte-compatible.
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error("Report did not serialize to an object.");
  return parsed as Record<string, unknown>;
}

export const pathPlaceholder = "<local checkout>";

/** Directories this server knows about whose names must not reach the MCP client. */
function localPaths(project: string | undefined): string[] {
  const candidates = [project, project ? resolve(project) : undefined, process.cwd(), homedir()];
  const paths = new Set<string>();
  for (const path of candidates) {
    if (!path) continue;
    paths.add(path);
    try {
      paths.add(realpathSync(path));
    } catch {
      // A directory that cannot be resolved is still redacted by its configured name.
    }
  }
  return [...paths];
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Exact-prefix matcher for one verified directory, in POSIX and Windows separator forms. */
function knownPathPattern(path: string): RegExp | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  // A root ("/", "C:\\") or one-character path would match too much evidence to be useful.
  if (trimmed.length < 2 || /^[A-Za-z]:$/.test(trimmed)) return null;
  const separator = "[\\\\/]";
  const body = trimmed.split(/[\\/]/).map(escapeRegExp).join(separator);
  // Boundaries: not inside a longer path segment before or after the directory name.
  return new RegExp(
    `(?<![\\w.\\\\/-])${body}(?![\\w-]|\\.\\w)`,
    /^[A-Za-z]:/.test(trimmed) ? "gi" : "g",
  );
}

/**
 * Recursively replace verified local directories (the project, working directory and home
 * directory) in every string, including GitHub-authored evidence, where only an exact prefix
 * of a known directory can match. Other text is untouched.
 */
export function redactPaths<T>(value: T, known: readonly string[] = []): T {
  const patterns = [...known]
    .sort((a, b) => b.length - a.length)
    .map(knownPathPattern)
    .filter((pattern): pattern is RegExp => pattern !== null);
  const walk = (item: unknown): unknown => {
    if (typeof item === "string")
      return patterns.reduce((text, pattern) => text.replace(pattern, pathPlaceholder), item);
    if (Array.isArray(item)) return item.map(walk);
    if (typeof item === "object" && item !== null)
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, walk(entry)]));
    return item;
  };
  return walk(value) as T;
}

// Absolute paths not part of a URL: Windows drive or UNC paths, POSIX paths with at least two
// segments, and home-relative paths. The lookbehinds keep URL paths ("https://h/a/b") and
// repository names ("owner/name") intact.
const windowsPath = /(?<![\w/\\:])(?:[A-Za-z]:[\\/]|\\\\[^\s\\/]+[\\/])[^\s"'<>()|,;`]*/g;
const posixPath = /(?<![\w.:/~>\\-])\/(?:[^\s/"'<>()|,;`]+\/)+[^\s/"'<>()|,;`]*/g;
const homePath = /(?<![\w/])~[\\/][^\s"'<>()|,;`]*/g;

/** Replace a matched path, leaving sentence punctuation that followed it in place. */
const replacePath = (match: string): string => {
  const trailing = /[.:!?]+$/.exec(match)?.[0] ?? "";
  return pathPlaceholder + trailing;
};

/**
 * Replace any absolute path in one locally generated diagnostic (configuration and estimation
 * findings). Never applied to GitHub-authored fields, where "/api/v1/users" is evidence.
 */
export function redactLocalText(text: string): string {
  return text
    .replace(windowsPath, replacePath)
    .replace(posixPath, replacePath)
    .replace(homePath, replacePath);
}

/** Build one server for one connection; no state is shared between calls or connections. */
export function createServer(
  options: McpOptions,
  runtime: McpRuntime,
  version = "0.0.0",
): McpServer {
  const server = new McpServer({ name: "github-triage", version });
  // Generic path redaction applies only to the service's local diagnostics (doc/design/mcp.md).
  const reader: McpRuntime = { ...runtime, redactDiagnostic: redactLocalText };

  const select = async (
    args: { repo?: string; agent?: string },
    signal: AbortSignal,
  ): Promise<Selection & { repository: string }> => {
    let repository = args.repo ?? options.repo;
    if (!repository) {
      try {
        repository = await runtime.currentRepository(options.project, signal);
      } catch {
        if (signal.aborted) throw new Failure("cancelled");
        throw new Failure("repository-unresolved");
      }
      if (!repoPattern.test(repository)) throw new Failure("repository-unresolved");
    }
    if (signal.aborted) throw new Failure("cancelled");
    const name = args.agent ?? options.agent ?? null;
    return {
      repository,
      agent: name,
      identitySource: args.agent ? "tool" : options.agent ? "startup" : "unresolved",
    };
  };

  const identityNotice = (selection: Selection): string =>
    selection.identitySource === "unresolved"
      ? "Identity: unresolved; this is an unfocused read. Pass agent to focus it.\n"
      : "";

  /** Run one call with per-call selection, mapping failures to a sanitized error envelope. */
  const call = async (
    kind: Kind,
    args: { repo?: string; agent?: string },
    signal: AbortSignal,
    read: (selection: Selection & { repository: string }) => Promise<{
      status: "complete" | "incomplete";
      result: Record<string, unknown>;
      text: string;
      /** Bound the rendered text (issue intake); structuredContent stays complete. */
      maxChars?: number;
    }>,
  ) => {
    let selection: Selection = {
      repository: args.repo ?? options.repo ?? null,
      agent: args.agent ?? options.agent ?? null,
      identitySource: args.agent ? "tool" : options.agent ? "startup" : "unresolved",
    };
    try {
      const selected = await select(args, signal);
      selection = selected;
      const outcome = await read(selected);
      if (signal.aborted) throw new Failure("cancelled");
      const notice =
        outcome.status === "incomplete"
          ? "INCOMPLETE evidence: do not treat missing findings as clean or eligible.\n"
          : "";
      // Diagnostics (e.g. config errors) can name local directories; never return them.
      const known = localPaths(options.project);
      const body = redactPaths(outcome.text, known);
      return toolResult(
        {
          schemaVersion: 1,
          kind,
          status: outcome.status,
          selection,
          result: redactPaths(outcome.result, known),
          error: null,
        },
        outcome.maxChars === undefined
          ? notice + identityNotice(selection) + body
          : boundedIssueText(notice + identityNotice(selection) + body, outcome.maxChars),
      );
    } catch (error) {
      const code: FailureCode =
        error instanceof Failure ? error.code : signal.aborted ? "cancelled" : "collection-failed";
      return toolResult(
        {
          schemaVersion: 1,
          kind,
          status: "error",
          selection,
          result: null,
          error: { code, message: failures[code] },
        },
        `Error (${code}): ${failures[code]}\n`,
      );
    }
  };

  server.registerTool(
    "triage_briefing",
    {
      title: "Triage briefing",
      description:
        "Evidence-linked action briefing for a GitHub repository: what needs attention and what to pick up next. Call at the start of work or with since to catch up.",
      inputSchema: briefingInput,
      outputSchema: envelope,
      annotations,
    },
    async (args, ctx) =>
      call("briefing", args, ctx.mcpReq.signal, async (selection) => {
        const read = await readBriefing(reader, {
          repository: selection.repository,
          agent: selection.agent ?? undefined,
          since: args.since ? new Date(args.since).toISOString() : undefined,
          limit: args.limit,
          maxChars: args.maxChars,
          signal: ctx.mcpReq.signal,
        });
        if (read.kind === "unavailable") throw new Failure("collection-failed");
        return {
          status: read.complete ? "complete" : "incomplete",
          result: plain(read.report),
          text: read.text,
        };
      }),
  );

  server.registerTool(
    "triage_issue",
    {
      title: "Triage issue intake",
      description:
        "Full intake for one issue: body, history, dependencies and ownership evidence, even if closed. Diagnoses transferred, missing or inaccessible issues. Call before working on a ticket.",
      inputSchema: issueInput,
      outputSchema: envelope,
      annotations,
    },
    async (args, ctx) =>
      call("issue", args, ctx.mcpReq.signal, async (selection) => {
        const read = await readBriefing(reader, {
          repository: selection.repository,
          agent: selection.agent ?? undefined,
          issue: args.number,
          limit: 5,
          maxChars: args.maxChars,
          signal: ctx.mcpReq.signal,
        });
        if (read.kind === "unavailable")
          return {
            status: "incomplete",
            result: plain({ schemaVersion: 1, kind: "issue-unavailable", ...read.diagnosis }),
            text: read.text,
            maxChars: args.maxChars,
          };
        return {
          status: read.complete ? "complete" : "incomplete",
          result: plain(read.report),
          text: read.text,
          maxChars: args.maxChars,
        };
      }),
  );

  server.registerTool(
    "triage_dependencies",
    {
      title: "Native issue dependencies",
      description:
        "Native GitHub blocked-by/blocking relationships for one issue; with tree, the transitive graph and cycles. Call before claiming or ordering work.",
      inputSchema: dependenciesInput,
      outputSchema: envelope,
      annotations,
    },
    async (args, ctx) =>
      call("dependencies", { repo: args.repo }, ctx.mcpReq.signal, async (selection) => {
        const read = await readDependencies(
          runtime,
          selection.repository,
          args.number,
          args.tree,
          ctx.mcpReq.signal,
        );
        return { status: "complete", result: plain(read.report), text: read.text };
      }),
  );

  return server;
}

const detailMarker = "\nFULL ISSUE DETAIL\n";
const detailNotice =
  "\nFull issue intake (body, history, dependencies, ownership) omitted from text; it is in structuredContent.result.detail.\n";
const truncatedNotice =
  "\nText truncated at maxChars; the complete intake is in structuredContent.result.\n";

/**
 * MCP text for an issue intake, bounded by maxChars (doc/design/mcp.md: concise text with a
 * detail/omission notice). The CLI appends the full serialized detail after its budget checks;
 * here that detail stays only in structuredContent, so text never duplicates it unbounded.
 */
export function boundedIssueText(text: string, maxChars: number): string {
  const at = text.indexOf(detailMarker);
  const head = at === -1 ? text : `${text.slice(0, at).trimEnd()}\n`;
  const tail = at === -1 ? "" : detailNotice;
  if (head.length + tail.length <= maxChars) return head + tail;
  return `${head.slice(0, maxChars - tail.length - truncatedNotice.length)}${truncatedNotice}${tail}`;
}

/** Production boundaries: authenticated gh through the existing argument-array runners. */
export const defaultRuntime = (options: McpOptions): McpRuntime => ({
  collect,
  dependencyReport,
  currentRepository,
  // Every runtime piece that reads local state resolves against the configured project, not
  // the server's working directory: estimation settings and the workflow-guide opt-out (#71).
  estimation: options.project ? { cwd: options.project } : undefined,
  guide: options.project ? { cwd: options.project } : undefined,
});

function isEntryPoint(entry: string | undefined): boolean {
  if (!entry) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1])) {
  try {
    const options = mcpArguments(process.argv.slice(2));
    if (options.help) process.stdout.write(mcpHelp);
    else {
      const { version } = await installedVersion();
      const runtime = defaultRuntime(options);
      serveStdio(() => createServer(options, runtime, version ?? "0.0.0"), {
        onerror: (error) => process.stderr.write(`github-triage-mcp: ${error.message}\n`),
      });
    }
  } catch (error) {
    process.stderr.write(
      `github-triage-mcp: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
