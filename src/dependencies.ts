/** Native dependency queries and pure facts. Contract: doc/issue-dependencies.md. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ghQuery, ghQueryWith, pages, declaredDependencies, prop, selected } from "./github.js";
import type { Query } from "./github.js";
import type { Issue, NativeNode, Reference } from "./types.js";

const execute = promisify(execFile);
const pageInfo = "pageInfo { hasNextPage endCursor }";
export const summaryFields =
  "issueDependenciesSummary { blockedBy totalBlockedBy blocking totalBlocking }";
const nodeFields = `number title state stateReason url repository { nameWithOwner } ${summaryFields}`;
export const nativeFields = `${summaryFields} blockedBy(first:100) { nodes { ${nodeFields} } ${pageInfo} } blocking(first:100) { nodes { ${nodeFields} } ${pageInfo} }`;

/** The native-dependency fields of an issue, as optionally present in collected facts. */
export type NativeFields = Pick<Issue, "issueDependenciesSummary" | "blockedBy" | "blocking">;
/** Native-dependency fields whose evidence is present. */
export type KnownNative = Required<NativeFields>;
/** The subset of an issue that a dependency read selects. */
export type DependencyIssue = Pick<
  Issue,
  "number" | "title" | "body" | "url" | "state" | "stateReason" | "updatedAt" | "labels"
> &
  NativeFields;

export async function completeNative<T extends NativeFields & Pick<Issue, "number" | "url">>(
  item: T,
  repository: string,
  query: Query = ghQuery,
): Promise<T & KnownNative> {
  const fields = ["blockedBy", "blocking"] as const;
  for (const field of fields) {
    const initial = item[field];
    if (!initial || !item.issueDependenciesSummary)
      throw new Error(`Native dependency evidence missing for ${item.url}.`);
    initial.nodes = await pages<NativeNode>(async (cursor) => {
      if (!cursor) return initial;
      const [owner, name] = repository.split("/");
      const data = await query(
        `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){issue(number:$number){${field}(first:100,after:$cursor){nodes{${nodeFields}} ${pageInfo}}}}}`,
        { owner, name, number: item.number, cursor },
      );
      return prop(data, "repository", "issue", field);
    });
    initial.pageInfo = { hasNextPage: false, endCursor: null };
    const expected =
      item.issueDependenciesSummary[field === "blockedBy" ? "totalBlockedBy" : "totalBlocking"];
    if (initial.nodes.length !== expected)
      throw new Error(
        `Native dependency count changed or is incomplete for ${item.url}; refresh live.`,
      );
  }
  const { issueDependenciesSummary, blockedBy, blocking } = item;
  if (!issueDependenciesSummary || !blockedBy || !blocking)
    throw new Error(`Native dependency evidence missing for ${item.url}.`);
  // Reassigns the same values (no change): returns the same object, typed as complete.
  return Object.assign(item, { issueDependenciesSummary, blockedBy, blocking });
}
export const nativeKnown = <T extends NativeFields>(item: T): item is T & KnownNative =>
  !!item.issueDependenciesSummary && !!item.blockedBy && !!item.blocking;
export const pickable = (item: NativeFields): boolean =>
  nativeKnown(item) && item.issueDependenciesSummary.blockedBy === 0;
/** How many open dependants this open ticket is the last open blocker for. */
export const unblocks = (item: Pick<Issue, "state" | "blocking"> | null | undefined): number =>
  item?.state === "OPEN"
    ? (item.blocking?.nodes ?? []).filter(
        (n) => n.state === "OPEN" && n.issueDependenciesSummary?.blockedBy === 1,
      ).length
    : 0;
export const dependencyDrift = (
  item: Pick<Issue, "body" | "blockedBy">,
  repository: string,
): Reference[] =>
  declaredDependencies(item.body, repository).filter(
    (ref) => !(item.blockedBy?.nodes ?? []).some((n) => n.url === ref.url),
  );
export interface DependencyFacts {
  number: number;
  url: string;
  title: string;
  known: boolean;
  summary: Issue["issueDependenciesSummary"] | null;
  upstream: NativeNode[];
  downstream: (NativeNode & { lastOpenBlocker: boolean })[];
  drift: Reference[];
  verdict: string;
}
export function dependencyFacts(
  item: Pick<Issue, "number" | "url" | "title" | "body" | "state"> & NativeFields,
  repository: string,
): DependencyFacts {
  const known = nativeKnown(item);
  const blockers = item.blockedBy?.nodes ?? [];
  return {
    number: item.number,
    url: item.url,
    title: item.title,
    known,
    summary: item.issueDependenciesSummary ?? null,
    upstream: blockers,
    downstream: (item.blocking?.nodes ?? []).map((node) => ({
      ...node,
      lastOpenBlocker:
        item.state === "OPEN" &&
        node.state === "OPEN" &&
        node.issueDependenciesSummary?.blockedBy === 1,
    })),
    drift: dependencyDrift(item, repository),
    verdict: !nativeKnown(item)
      ? "Unknown native dependency evidence; refresh live."
      : blockers.some((n) => n.stateReason === "NOT_PLANNED")
        ? "A blocker was closed as not planned; human inspection required."
        : item.issueDependenciesSummary.blockedBy > 0
          ? `Waiting on ${blockers
              .filter((n) => n.state === "OPEN")
              .map((n) => n.url)
              .join(", ")}`
          : "No open native blockers; pickup still requires ready, unclaimed and acceptance verification.",
  };
}
export async function readDependencyIssue(
  repository: string,
  number: number,
  query: Query = ghQuery,
): Promise<DependencyIssue & KnownNative> {
  const [owner, name] = repository.split("/");
  const data = await query(
    `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){number title body url state stateReason updatedAt labels(first:100){nodes{name} ${pageInfo}} ${nativeFields}}}}`,
    { owner, name, number },
  );
  const item = selected<DependencyIssue>(prop(data, "repository", "issue"));
  if (!item)
    throw new Error(`Issue #${number} unavailable; pull requests cannot be native blockers.`);
  return completeNative(item, repository, query);
}
export interface DependencyReport {
  schemaVersion: 1;
  repository: string;
  startedAt: string;
  fetchedAt: string;
  tree: boolean;
  nodes: DependencyFacts[];
  cycles: string[][];
  guidance: string;
}
/**
 * Read one ticket's native dependencies; with `tree`, walk upstream and downstream
 * transitively, reading each ticket once, and report upstream (blocked-by) cycles.
 */
export async function dependencyReport(
  repository: string,
  number: number,
  { tree = false, signal }: { tree?: boolean; signal?: AbortSignal } = {},
  query: Query = ghQueryWith(signal),
  now: () => Date = () => new Date(),
): Promise<DependencyReport> {
  const startedAt = now().toISOString();
  const nodes = new Map<string, DependencyFacts>();
  const pending: [string, number][] = [[repository, number]];
  for (let next = pending.shift(); next; next = pending.shift()) {
    const [repo, n] = next;
    const key = `${repo}#${n}`;
    if (nodes.has(key)) continue;
    signal?.throwIfAborted();
    const item = await readDependencyIssue(repo, n, query);
    nodes.set(key, dependencyFacts(item, repo));
    if (tree)
      for (const ref of [...item.blockedBy.nodes, ...item.blocking.nodes])
        pending.push([ref.repository.nameWithOwner, ref.number]);
  }
  // Directed DFS over blocked-by edges: a reverse (blocking) relationship is not a cycle.
  const byUrl = new Map([...nodes.values()].map((node) => [node.url, node]));
  const cycles: string[][] = [];
  const done = new Set<string>();
  const stack: string[] = [];
  function detect(url: string): void {
    const at = stack.indexOf(url);
    if (at >= 0) {
      cycles.push([...stack.slice(at), url]);
      return;
    }
    if (done.has(url)) return;
    stack.push(url);
    for (const ref of byUrl.get(url)?.upstream ?? []) detect(ref.url);
    stack.pop();
    done.add(url);
  }
  if (tree) for (const url of byUrl.keys()) detect(url);
  return {
    schemaVersion: 1,
    repository,
    startedAt,
    fetchedAt: now().toISOString(),
    tree,
    nodes: [...nodes.values()],
    cycles,
    guidance:
      "Native blockers are authoritative. Closed blockers do not prove behavior was delivered. Body drift is migration context only.",
  };
}
export function dependencyText(report: DependencyReport): string {
  return (
    [
      `Native issue dependencies: ${report.repository}`,
      `LIVE ${report.startedAt}–${report.fetchedAt}`,
      report.guidance,
      ...report.nodes.flatMap((node) => [
        `\n#${node.number} ${node.title} ${node.url}`,
        node.verdict,
        ...node.upstream.map((n) => `  Upstream: ${n.url} ${n.state}/${n.stateReason ?? ""}`),
        ...node.downstream.map(
          (n) => `  Downstream: ${n.url}${n.lastOpenBlocker ? " — last open blocker" : ""}`,
        ),
        ...node.drift.map((n) => `  Drift: ${n.url} — text only; not yet migrated`),
      ]),
      ...report.cycles.map((path) => `CYCLE: ${path.join(" -> ")}`),
    ].join("\n") + "\n"
  );
}

// ---------------------------------------------------------------------------
// deps add / deps remove: validated dependency changes.
// Contract: doc/issue-dependencies.md, "deps add and deps remove" and
// "Rules for commands that change tickets".

/** The only GitHub write boundary: `gh` with explicit arguments, never a shell. */
export type GhRun = (args: string[]) => Promise<void>;
export const ghRun: GhRun = async (args) => {
  try {
    await execute("gh", args, { timeout: 60_000 });
  } catch (error) {
    // Keep only a rate-limit discriminator; never echo arguments, stderr or response bodies.
    if (isRateLimit(`${outputText(prop(error, "stderr"))}\n${outputText(prop(error, "stdout"))}`))
      throw new RateLimitError(`gh ${args[0]} ${args[1]} was rate limited by GitHub.`);
    throw new Error(`gh ${args[0]} ${args[1]} failed. Check gh auth status and rate limits.`);
  }
};
/** A write refused because of a GitHub (secondary) rate limit: stop all further writes. */
export class RateLimitError extends Error {
  rateLimited = true;
  /**
   * Sanitized retry metadata only: seconds from GitHub's retry-after hint and/or the ISO
   * time the quota resets. Never carries tokens, arguments or raw response bodies.
   */
  constructor(
    message: string,
    readonly retry: { retryAfterSeconds?: number | null; resetAt?: string | null } = {},
  ) {
    super(message);
  }
}
const outputText = (value: unknown): string =>
  typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString() : "";
export const isRateLimit = (text: string): boolean =>
  /rate limit|abuse detection|HTTP 429|retry-after/i.test(text);

type Blocker =
  | { __typename: "Issue"; number: number; url: string; state: string }
  | {
      __typename: "PullRequest";
      number: number;
      url: string;
      closingIssuesReferences?: { nodes: { number: number }[] } | null;
    };
/** Resolve a proposed blocker: an issue, a pull request (refused), or missing. */
async function readBlocker(
  repository: string,
  number: number,
  query: Query,
): Promise<Blocker | null> {
  const [owner, name] = repository.split("/");
  const data = await query(
    `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){__typename ... on Issue{number url state} ... on PullRequest{number url closingIssuesReferences(first:20){nodes{number}}}}}}`,
    { owner, name, number },
  );
  return selected<Blocker>(prop(data, "repository", "issueOrPullRequest"));
}

/**
 * Live upstream walk from `from`: does following blocked-by edges reach `target`?
 * If so, making `target` blocked by `from` would close a cycle.
 * @returns {Promise<string[] | null>} the path from `from` to `target`, or null.
 */
async function upstreamPath(
  repository: string,
  from: number,
  targetUrl: string,
  query: Query,
): Promise<string[] | null> {
  const seen = new Set<string>();
  const pending: [string, number, string[]][] = [[repository, from, []]];
  for (let next = pending.shift(); next; next = pending.shift()) {
    const [repo, n, path] = next;
    const item = await readDependencyIssue(repo, n, query);
    const here = [...path, item.url];
    if (item.url === targetUrl) return here;
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    for (const ref of item.blockedBy.nodes)
      pending.push([ref.repository.nameWithOwner, ref.number, here]);
  }
  return null;
}

/** The one explanatory comment posted on a changed ticket. */
export type DependencyAction = "add" | "remove";
export function commentFor(action: DependencyAction, blockers: number[], note: string): string {
  const verb = action === "add" ? "Added" : "Removed";
  const noun = blockers.length === 1 ? "dependency" : "dependencies";
  return `${verb} native blocked-by ${noun}: ${blockers.map((n) => `#${n}`).join(", ")}.\n\nWhy: ${note}\n\nRecorded with \`github-triage deps ${action}\`; labels are unchanged (doc/issue-dependencies.md).`;
}

export type ChangeStatus = "apply" | "refused" | "noop" | "done" | "failed" | "skipped";
export interface DependencyChange {
  blocker: number;
  url: string | null;
  status: ChangeStatus;
  reason: string;
  command: string[] | null;
}
export interface DependencyRequest {
  action: DependencyAction;
  number: number;
  on: number[];
  note: string;
}
export interface DependencyPlan {
  schemaVersion: 1;
  repository: string;
  action: DependencyAction;
  target: { number: number; url: string; title: string };
  note: string;
  changes: DependencyChange[];
  comment: string | null;
  commentCommand: string[] | null;
}
export interface DependencyChangeResult extends DependencyPlan {
  dryRun: false;
  commentStatus: string;
  rateLimited: boolean;
  exitCode: number;
}
/** Plan a dependency change from fresh live reads. Changes nothing. */
export async function planDependencyChange(
  repository: string,
  request: DependencyRequest,
  query: Query = ghQuery,
): Promise<DependencyPlan> {
  const { action, number, note } = request;
  const target = await readDependencyIssue(repository, number, query);
  // --on numbers name issues in this repository; ignore same-numbered cross-repository blockers.
  const existing = new Set(
    target.blockedBy.nodes
      // GitHub repository names are case-insensitive; --repo may differ from nameWithOwner.
      .filter((n) => n.repository?.nameWithOwner?.toLowerCase() === repository.toLowerCase())
      .map((n) => n.number),
  );
  const flag = action === "add" ? "--add-blocked-by" : "--remove-blocked-by";
  const changes: DependencyChange[] = [];
  for (const on of new Set(request.on)) {
    const change: DependencyChange = {
      blocker: on,
      url: null,
      status: "apply",
      reason: "",
      command: null,
    };
    changes.push(change);
    if (on === number) {
      Object.assign(change, { status: "refused", reason: "A ticket cannot depend on itself." });
      continue;
    }
    if (action === "remove") {
      change.url = `https://github.com/${repository}/issues/${on}`;
      if (!existing.has(on))
        Object.assign(change, {
          status: "noop",
          reason: "Not a native blocker; nothing to remove.",
        });
    } else {
      const blocker = await readBlocker(repository, on, query);
      if (!blocker) {
        Object.assign(change, { status: "refused", reason: `#${on} does not exist.` });
        continue;
      }
      change.url = blocker.url;
      if (blocker.__typename === "PullRequest") {
        const closes = (blocker.closingIssuesReferences?.nodes ?? []).map((n) => `#${n.number}`);
        Object.assign(change, {
          status: "refused",
          reason: `#${on} is a pull request and cannot be a blocker; name the issue it closes instead${closes.length ? ` (${closes.join(", ")})` : ""}.`,
        });
        continue;
      }
      if (existing.has(on)) {
        Object.assign(change, { status: "noop", reason: "Already a native blocker." });
        continue;
      }
      const cycle = await upstreamPath(repository, on, target.url, query);
      if (cycle) {
        Object.assign(change, {
          status: "refused",
          reason: `Would create a cycle: ${[target.url, ...cycle].join(" -> ")}`,
        });
        continue;
      }
    }
    if (change.status === "apply")
      change.command = ["issue", "edit", String(number), "--repo", repository, flag, String(on)];
  }
  const applying = changes.filter((c) => c.status === "apply").map((c) => c.blocker);
  const comment = applying.length ? commentFor(action, applying, note) : null;
  return {
    schemaVersion: 1,
    repository,
    action,
    target: { number: target.number, url: target.url, title: target.title },
    note,
    changes,
    comment,
    commentCommand: comment
      ? ["issue", "comment", String(number), "--repo", repository, "--body", comment]
      : null,
  };
}

/**
 * Apply a plan one edge at a time, then post one explanatory comment.
 * Exit codes follow the shared rules: 0 all done, 2 partly done, 1 nothing done.
 */
export async function applyDependencyChange(
  plan: DependencyPlan,
  run: GhRun = ghRun,
): Promise<DependencyChangeResult> {
  const results = plan.changes.map((c) => ({ ...c }));
  const applied: DependencyChange[] = [];
  let rateLimited = false;
  for (const change of results.filter((c) => c.status === "apply")) {
    if (rateLimited) {
      // The shared rules stop on a rate limit rather than pressing on.
      Object.assign(change, {
        status: "skipped",
        reason: "Not attempted: stopped after a rate limit.",
      });
      continue;
    }
    try {
      // A planned "apply" change always carries its command.
      await run(change.command ?? []);
      change.status = "done";
      applied.push(change);
    } catch (error) {
      rateLimited = !!prop(error, "rateLimited");
      Object.assign(change, { status: "failed", reason: prop(error, "message") });
    }
  }
  // The comment names only what actually changed, and is what the result reports.
  const comment = applied.length
    ? commentFor(
        plan.action,
        applied.map((c) => c.blocker),
        plan.note,
      )
    : null;
  const commentCommand = comment
    ? ["issue", "comment", String(plan.target.number), "--repo", plan.repository, "--body", comment]
    : null;
  let commentStatus = "none";
  if (commentCommand && rateLimited) commentStatus = "skipped: stopped after a rate limit";
  else if (commentCommand)
    try {
      await run(commentCommand);
      commentStatus = "posted";
    } catch (error) {
      commentStatus = prop(error, "rateLimited") ? "failed: rate limited" : "failed";
    }
  const unfinished = results.some((c) => c.status !== "done" && c.status !== "noop");
  const exitCode = !applied.length
    ? unfinished
      ? 1
      : 0
    : unfinished || commentStatus !== "posted"
      ? 2
      : 0;
  return {
    ...plan,
    dryRun: false,
    changes: results,
    comment,
    commentCommand,
    commentStatus,
    rateLimited,
    exitCode,
  };
}

/** Text rendering shared by dry runs and applied results. */
export function dependencyChangeText(
  result: DependencyPlan & { dryRun: boolean; commentStatus?: string },
): string {
  const lines = [
    `deps ${result.action}: #${result.target.number} ${result.target.title} ${result.target.url}`,
    result.dryRun ? "DRY RUN: no changes made." : "",
  ];
  for (const c of result.changes) {
    const shown = c.command && result.dryRun ? `  gh ${c.command.join(" ")}` : "";
    lines.push(`- #${c.blocker}: ${c.status}${c.reason ? ` — ${c.reason}` : ""}`);
    if (shown) lines.push(shown);
  }
  if (result.comment)
    lines.push(
      result.dryRun
        ? `Comment that would be posted on #${result.target.number}:\n${result.comment}`
        : `Comment: ${result.commentStatus}`,
    );
  return lines.filter(Boolean).join("\n") + "\n";
}
