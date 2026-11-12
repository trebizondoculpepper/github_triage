/** Native dependency queries and pure facts. Contract: doc/issue-dependencies.md. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ghQuery, pages, declaredDependencies } from "./github.js";

const execute = promisify(execFile);
const pageInfo = "pageInfo { hasNextPage endCursor }";
export const summaryFields =
  "issueDependenciesSummary { blockedBy totalBlockedBy blocking totalBlocking }";
const nodeFields = `number title state stateReason url repository { nameWithOwner } ${summaryFields}`;
export const nativeFields = `${summaryFields} blockedBy(first:100) { nodes { ${nodeFields} } ${pageInfo} } blocking(first:100) { nodes { ${nodeFields} } ${pageInfo} }`;

export async function completeNative(item, repository, query = ghQuery) {
  for (const field of ["blockedBy", "blocking"]) {
    const initial = item[field];
    if (!initial || !item.issueDependenciesSummary)
      throw new Error(`Native dependency evidence missing for ${item.url}.`);
    item[field].nodes = await pages(async (cursor) => {
      if (!cursor) return initial;
      const [owner, name] = repository.split("/");
      const data = await query(
        `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){issue(number:$number){${field}(first:100,after:$cursor){nodes{${nodeFields}} ${pageInfo}}}}}`,
        { owner, name, number: item.number, cursor },
      );
      return data.repository?.issue?.[field];
    });
    item[field].pageInfo = { hasNextPage: false, endCursor: null };
    const expected =
      item.issueDependenciesSummary[field === "blockedBy" ? "totalBlockedBy" : "totalBlocking"];
    if (item[field].nodes.length !== expected)
      throw new Error(
        `Native dependency count changed or is incomplete for ${item.url}; refresh live.`,
      );
  }
  return item;
}
export const nativeKnown = (item) =>
  !!item.issueDependenciesSummary && !!item.blockedBy && !!item.blocking;
export const pickable = (item) =>
  nativeKnown(item) && item.issueDependenciesSummary.blockedBy === 0;
/** How many open dependants this open ticket is the last open blocker for. */
export const unblocks = (item) =>
  item?.state === "OPEN"
    ? (item.blocking?.nodes ?? []).filter(
        (n) => n.state === "OPEN" && n.issueDependenciesSummary?.blockedBy === 1,
      ).length
    : 0;
export const dependencyDrift = (item, repository) =>
  declaredDependencies(item.body, repository).filter(
    (ref) => !(item.blockedBy?.nodes ?? []).some((n) => n.url === ref.url),
  );
/**
 * @param {import("./types.js").Issue} item
 * @param {string} repository
 */
export function dependencyFacts(item, repository) {
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
    verdict: !known
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
export async function readDependencyIssue(repository, number, query = ghQuery) {
  const [owner, name] = repository.split("/");
  const data = await query(
    `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){number title body url state stateReason updatedAt labels(first:100){nodes{name} ${pageInfo}} ${nativeFields}}}}`,
    { owner, name, number },
  );
  const item = data.repository?.issue;
  if (!item)
    throw new Error(`Issue #${number} unavailable; pull requests cannot be native blockers.`);
  return completeNative(item, repository, query);
}
/**
 * Read one ticket's native dependencies; with `tree`, walk upstream and downstream
 * transitively, reading each ticket once, and report upstream (blocked-by) cycles.
 * @param {string} repository
 * @param {number} number
 * @param {{ tree?: boolean }} [options]
 * @param {import("./github.js").Query} [query]
 * @param {() => Date} [now]
 */
export async function dependencyReport(
  repository,
  number,
  { tree = false } = {},
  query = ghQuery,
  now = () => new Date(),
) {
  const startedAt = now().toISOString();
  /** @type {Map<string, ReturnType<typeof dependencyFacts>>} */
  const nodes = new Map();
  /** @type {[string, number][]} */
  const pending = [[repository, number]];
  while (pending.length) {
    const [repo, n] = pending.shift();
    const key = `${repo}#${n}`;
    if (nodes.has(key)) continue;
    const item = await readDependencyIssue(repo, n, query);
    nodes.set(key, dependencyFacts(item, repo));
    if (tree)
      for (const ref of [...item.blockedBy.nodes, ...item.blocking.nodes])
        pending.push([ref.repository.nameWithOwner, ref.number]);
  }
  // Directed DFS over blocked-by edges: a reverse (blocking) relationship is not a cycle.
  const byUrl = new Map([...nodes.values()].map((node) => [node.url, node]));
  /** @type {string[][]} */
  const cycles = [];
  const done = new Set();
  /** @type {string[]} */
  const stack = [];
  function detect(url) {
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
export function dependencyText(report) {
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

/**
 * The only GitHub write boundary: `gh` with explicit arguments, never a shell.
 * @typedef {(args: string[]) => Promise<void>} GhRun
 * @type {GhRun}
 */
export const ghRun = async (args) => {
  try {
    await execute("gh", args, { timeout: 60_000 });
  } catch {
    // Do not echo arguments, stderr or response bodies.
    throw new Error(`gh ${args[0]} ${args[1]} failed. Check gh auth status and rate limits.`);
  }
};

/** Resolve a proposed blocker: an issue, a pull request (refused), or missing. */
async function readBlocker(repository, number, query) {
  const [owner, name] = repository.split("/");
  const data = await query(
    `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){__typename ... on Issue{number url state} ... on PullRequest{number url closingIssuesReferences(first:20){nodes{number}}}}}}`,
    { owner, name, number },
  );
  return data.repository?.issueOrPullRequest ?? null;
}

/**
 * Live upstream walk from `from`: does following blocked-by edges reach `target`?
 * If so, making `target` blocked by `from` would close a cycle.
 * @returns {Promise<string[] | null>} the path from `from` to `target`, or null.
 */
async function upstreamPath(repository, from, targetUrl, query) {
  const seen = new Set();
  /** @type {[string, number, string[]][]} */
  const pending = [[repository, from, []]];
  while (pending.length) {
    const [repo, n, path] = pending.shift();
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
export function commentFor(action, blockers, note) {
  const verb = action === "add" ? "Added" : "Removed";
  const noun = blockers.length === 1 ? "dependency" : "dependencies";
  return `${verb} native blocked-by ${noun}: ${blockers.map((n) => `#${n}`).join(", ")}.\n\nWhy: ${note}\n\nRecorded with \`github-triage deps ${action}\`; labels are unchanged (doc/issue-dependencies.md).`;
}

/**
 * Plan a dependency change from fresh live reads. Changes nothing.
 * @param {string} repository
 * @param {{ action: "add" | "remove", number: number, on: number[], note: string }} request
 * @param {import("./github.js").Query} [query]
 */
export async function planDependencyChange(repository, request, query = ghQuery) {
  const { action, number, note } = request;
  const target = await readDependencyIssue(repository, number, query);
  const existing = new Set(target.blockedBy.nodes.map((n) => n.number));
  const flag = action === "add" ? "--add-blocked-by" : "--remove-blocked-by";
  const changes = [];
  for (const on of new Set(request.on)) {
    const change = { blocker: on, url: null, status: "apply", reason: "", command: null };
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
 * @param {Awaited<ReturnType<typeof planDependencyChange>>} plan
 * @param {GhRun} [run]
 */
export async function applyDependencyChange(plan, run = ghRun) {
  const results = plan.changes.map((c) => ({ ...c }));
  const applied = [];
  for (const change of results.filter((c) => c.status === "apply")) {
    try {
      await run(change.command);
      change.status = "done";
      applied.push(change);
    } catch (error) {
      Object.assign(change, { status: "failed", reason: error.message });
    }
  }
  let comment = "skipped";
  if (applied.length) {
    const body = commentFor(
      plan.action,
      applied.map((c) => c.blocker),
      plan.note,
    );
    try {
      await run([
        "issue",
        "comment",
        String(plan.target.number),
        "--repo",
        plan.repository,
        "--body",
        body,
      ]);
      comment = "posted";
    } catch {
      comment = "failed";
    }
  }
  const unfinished = results.some((c) => c.status === "refused" || c.status === "failed");
  const exitCode = !applied.length
    ? unfinished
      ? 1
      : 0
    : unfinished || comment === "failed"
      ? 2
      : 0;
  return { ...plan, dryRun: false, changes: results, commentStatus: comment, exitCode };
}

/** Text rendering shared by dry runs and applied results. */
export function dependencyChangeText(result) {
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
