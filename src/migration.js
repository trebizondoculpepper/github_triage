/**
 * One-time migration from `Depends on` text and `blocked:work` labels to native
 * GitHub dependencies. Contract: doc/issue-dependencies.md, "Migration" and
 * "Rules for commands that change tickets".
 *
 * planMigration only reads. applyMigration changes GitHub, and only applies a plan
 * that a person has reviewed, one ticket at a time, with a resumable journal.
 */
import { workflow } from "./briefing.js";
import { collect, declaredDependencyContexts, ghQuery } from "./github.js";
import { ghRun } from "./dependencies.js";

/** Wording that must never become a blocker without review. */
export const hedged = /\b(?:optional(?:ly)?|coordinat\w*|nice[- ]to[- ]have|ideally|after)\b/i;
export const designUrl = "https://github.com/trebizondoculpepper/github_triage/issues/7";
const sameRepo = (a, b) => a.toLowerCase() === b.toLowerCase();
/**
 * The clause of a declaring sentence that names a reference, so hedging elsewhere in the
 * sentence ("Depends on #1; coordinate #2") does not taint a firm blocker.
 * @param {string} context @param {number} number
 */
export function clauseFor(context, number) {
  const mention = new RegExp(`#${number}\\b|/(?:issues|pull)/${number}\\b`);
  return context.split(/[;,]|\s+\u2014\s+/).find((part) => mention.test(part)) ?? context;
}
const isHedged = (context, number) => hedged.test(clauseFor(context, number));

/** Resolve a referenced number to an issue, a pull request, or null (missing). */
async function resolveReference(repository, number, query) {
  const [owner, name] = repository.split("/");
  const data = await query(
    `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){__typename ... on Issue{number url state stateReason} ... on PullRequest{number url state merged closingIssuesReferences(first:20){nodes{number url state repository{nameWithOwner}}}}}}}`,
    { owner, name, number },
  );
  return data.repository?.issueOrPullRequest ?? null;
}

/**
 * Build the reviewable plan from fresh live reads. Changes nothing.
 * @param {string} repository
 * @param {{ query?: import("./github.js").Query, collect?: typeof collect, now?: () => Date }} [runtime]
 */
export async function planMigration(repository, runtime = {}) {
  const query = runtime.query ?? ghQuery;
  const now = runtime.now ?? (() => new Date());
  const snapshot = await (runtime.collect ?? collect)(repository, {}, query, now);
  const cache = new Map();
  const resolve = (n) => {
    if (!cache.has(n)) cache.set(n, resolveReference(repository, n, query));
    return cache.get(n);
  };
  const tickets = [];
  for (const issue of [...snapshot.issues].sort((a, b) => a.number - b.number)) {
    if (issue.state !== "OPEN") continue;
    const tags = issue.labels.nodes.map((l) => l.name);
    const native = new Set(
      issue.blockedBy.nodes
        .filter((n) => sameRepo(n.repository.nameWithOwner, repository))
        .map((n) => n.number),
    );
    const edges = [];
    const propose = (blocker, url, state, source, context, refNumber = blocker) => {
      if (blocker === issue.number)
        edges.push({
          blocker,
          url,
          state,
          source,
          context,
          status: "review",
          reason: "Self-reference.",
        });
      else if (native.has(blocker) || edges.some((e) => e.blocker === blocker)) return;
      else
        edges.push({
          blocker,
          url,
          state,
          source,
          context,
          status: isHedged(context, refNumber) ? "review" : "apply",
          reason: isHedged(context, refNumber)
            ? "Hedged wording; confirm it is a real blocker."
            : "",
        });
    };
    for (const ref of declaredDependencyContexts(issue.body ?? "", repository)) {
      const base = {
        blocker: ref.number,
        url: ref.url,
        state: null,
        source: "text",
        context: ref.context,
      };
      if (!sameRepo(ref.repository, repository)) {
        edges.push({ ...base, status: "review", reason: "Cross-repository reference." });
        continue;
      }
      if (ref.number === issue.number) {
        edges.push({ ...base, status: "review", reason: "Self-reference." });
        continue;
      }
      const target = await resolve(ref.number);
      if (!target) {
        edges.push({ ...base, status: "review", reason: `#${ref.number} does not exist.` });
        continue;
      }
      if (target.__typename === "Issue") {
        propose(target.number, target.url, target.state, "text", ref.context);
        continue;
      }
      // A pull request cannot be a blocker: map it to the issues it closes.
      const closes = (target.closingIssuesReferences?.nodes ?? []).filter((n) =>
        sameRepo(n.repository.nameWithOwner, repository),
      );
      if (closes.length)
        for (const n of closes)
          propose(n.number, n.url, n.state, `pr #${target.number}`, ref.context);
      else if (target.merged)
        edges.push({
          ...base,
          url: target.url,
          status: "satisfied",
          reason: `Merged PR #${target.number} closes no issue; dropped.`,
        });
      else
        edges.push({
          ...base,
          url: target.url,
          status: "review",
          reason: `PR #${target.number} closes no issue.`,
        });
    }
    let labels = null;
    if (tags.includes(workflow.retiredReason)) {
      const otherReasons = tags.filter(
        (t) => t.startsWith(workflow.reasonPrefix) && t !== workflow.retiredReason,
      );
      const openBlocker =
        issue.issueDependenciesSummary.blockedBy > 0 ||
        edges.some((e) => e.status === "apply" && e.state === "OPEN");
      labels = otherReasons.length
        ? {
            remove: [workflow.retiredReason],
            add: [],
            status: "apply",
            reason: `Keeps ${workflow.blocked}: ${otherReasons.join(", ")}.`,
          }
        : openBlocker
          ? {
              remove: [
                workflow.retiredReason,
                ...(tags.includes(workflow.blocked) ? [workflow.blocked] : []),
              ],
              add: tags.includes(workflow.ready) ? [] : [workflow.ready],
              status: "apply",
              reason: "Waits only on work; open native blockers keep it Blocked in GitHub.",
            }
          : {
              remove: [],
              add: [],
              status: "review",
              reason: `${workflow.retiredReason} alone, but no open blocker found; the comments may name one.`,
            };
    }
    if (edges.length || labels)
      tickets.push({
        number: issue.number,
        url: issue.url,
        title: issue.title,
        updatedAt: issue.updatedAt,
        edges,
        labels,
      });
  }
  const rows = tickets.flatMap((t) => [...t.edges, ...(t.labels ? [t.labels] : [])]);
  return {
    schemaVersion: 1,
    kind: "dependency-migration-plan",
    repository,
    createdAt: now().toISOString(),
    guidance:
      'Review before applying: change any row\'s status, remove an edge or add a missed one. Only rows with status "apply" are applied.',
    summary: {
      tickets: tickets.length,
      apply: rows.filter((r) => r.status === "apply").length,
      review: rows.filter((r) => r.status === "review").length,
      satisfied: rows.filter((r) => r.status === "satisfied").length,
    },
    tickets,
  };
}

/** @param {Awaited<ReturnType<typeof planMigration>>} plan */
export function migrationPlanText(plan) {
  const lines = [
    `Dependency migration plan: ${plan.repository} (${plan.createdAt})`,
    `${plan.summary.tickets} tickets; ${plan.summary.apply} rows to apply, ${plan.summary.review} to review, ${plan.summary.satisfied} already satisfied.`,
    plan.guidance,
  ];
  for (const group of ["apply", "review"]) {
    lines.push(`\n${group.toUpperCase()}`);
    for (const t of plan.tickets) {
      for (const e of t.edges.filter((e) => e.status === group))
        lines.push(
          `- #${t.number} blocked by #${e.blocker} (${e.source})${e.reason ? ` — ${e.reason}` : ""}`,
        );
      if (t.labels?.status === group)
        lines.push(
          `- #${t.number} labels: ${[...t.labels.remove.map((l) => `-${l}`), ...t.labels.add.map((l) => `+${l}`)].join(" ") || "(none)"} — ${t.labels.reason}`,
        );
    }
  }
  return lines.join("\n") + "\n";
}

/** The one comment posted on each changed ticket. */
export function migrationComment(blockers, removed, added) {
  const parts = [];
  if (blockers.length)
    parts.push(
      `Recorded native blocked-by dependencies: ${blockers.map((n) => `#${n}`).join(", ")}.`,
    );
  if (removed.length || added.length)
    parts.push(
      `Labels: ${[...removed.map((l) => `removed \`${l}\``), ...added.map((l) => `added \`${l}\``)].join(", ")}.`,
    );
  return `${parts.join(" ")}\n\nDependency migration (${designUrl}). The issue body is unchanged; \`github-triage deps N\` reports any remaining text drift.`;
}

/** Light live read used for the change guard and the journal. */
async function readTicket(repository, number, query) {
  const [owner, name] = repository.split("/");
  const data = await query(
    `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){number updatedAt labels(first:100){nodes{name}} blockedBy(first:100){nodes{number repository{nameWithOwner}}}}}}`,
    { owner, name, number },
  );
  const issue = data.repository?.issue;
  if (!issue) throw new Error(`Issue #${number} is unavailable.`);
  return issue;
}

/**
 * Apply the rows marked "apply" in a reviewed plan.
 * @param {Awaited<ReturnType<typeof planMigration>>} plan
 * @param {{ query?: import("./github.js").Query, run?: import("./dependencies.js").GhRun,
 *   journal?: Record<string, any>, saveJournal?: (journal: Record<string, any>) => Promise<void>,
 *   dryRun?: boolean, pace?: () => Promise<void> }} [runtime]
 */
export async function applyMigration(plan, runtime = {}) {
  if (plan?.schemaVersion !== 1 || plan.kind !== "dependency-migration-plan")
    throw new Error("Not a version-1 dependency migration plan.");
  const query = runtime.query ?? ghQuery;
  const run = runtime.run ?? ghRun;
  const pace = runtime.pace ?? (() => new Promise((r) => setTimeout(r, 1000)));
  const journal = runtime.journal ?? { schemaVersion: 1, repository: plan.repository, tickets: {} };
  const save = runtime.saveJournal ?? (async () => {});
  const repo = plan.repository;
  const results = [];
  let stopped = false;
  let wrote = false;
  const write = async (args) => {
    if (wrote) await pace();
    wrote = true;
    await run(args);
  };
  for (const ticket of [...plan.tickets].sort((a, b) => a.number - b.number)) {
    const edges = ticket.edges.filter((e) => e.status === "apply");
    const labels = ticket.labels?.status === "apply" ? ticket.labels : null;
    if (!edges.length && !labels) continue;
    const result = {
      number: ticket.number,
      url: ticket.url,
      status: "applied",
      reason: "",
      commands: [],
    };
    results.push(result);
    if (stopped) {
      Object.assign(result, {
        status: "skipped",
        reason: "Not attempted: stopped after a rate limit.",
      });
      continue;
    }
    const entry = (journal.tickets[ticket.number] ??= { steps: {} });
    if (entry.steps.comment) {
      Object.assign(result, { status: "done-earlier", reason: "Completed in an earlier run." });
      continue;
    }
    try {
      // Change guard: someone else editing the ticket since planning (or since our own
      // last recorded write) means the plan may no longer be right for it.
      let live = await readTicket(repo, ticket.number, query);
      const expected = entry.updatedAt ?? ticket.updatedAt;
      if (live.updatedAt !== expected) {
        Object.assign(result, {
          status: "skipped",
          reason: entry.updatedAt
            ? "Changed since the last partial apply."
            : "Changed since planning.",
        });
        continue;
      }
      const recorded = async (step) => {
        entry.steps[step] = true;
        if (!runtime.dryRun) {
          live = await readTicket(repo, ticket.number, query);
          entry.updatedAt = live.updatedAt;
          await save(journal);
        }
      };
      const nativeNow = new Set(
        live.blockedBy.nodes
          .filter((n) => sameRepo(n.repository.nameWithOwner, repo))
          .map((n) => n.number),
      );
      const tags = live.labels.nodes.map((l) => l.name);
      const newEdges = edges.filter((e) => !nativeNow.has(e.blocker));
      const remove = (labels?.remove ?? []).filter((l) => tags.includes(l));
      const add = (labels?.add ?? []).filter((l) => !tags.includes(l));
      const commands = [
        ...(entry.steps.edges
          ? []
          : newEdges.map((e) => [
              "issue",
              "edit",
              String(ticket.number),
              "--repo",
              repo,
              "--add-blocked-by",
              String(e.blocker),
            ])),
        ...(entry.steps.labels || (!remove.length && !add.length)
          ? []
          : [
              [
                "issue",
                "edit",
                String(ticket.number),
                "--repo",
                repo,
                ...remove.flatMap((l) => ["--remove-label", l]),
                ...add.flatMap((l) => ["--add-label", l]),
              ],
            ]),
        [
          "issue",
          "comment",
          String(ticket.number),
          "--repo",
          repo,
          "--body",
          migrationComment(
            edges.map((e) => e.blocker),
            labels?.remove ?? [],
            labels?.add ?? [],
          ),
        ],
      ];
      result.commands = commands;
      if (runtime.dryRun) {
        result.status = "would-apply";
        continue;
      }
      if (!entry.steps.edges) {
        for (let i = 0; i < newEdges.length; i++) await write(commands.shift());
        await recorded("edges");
      }
      if (!entry.steps.labels) {
        if (remove.length || add.length) await write(commands.shift());
        await recorded("labels");
      }
      await write(commands.at(-1));
      await recorded("comment");
    } catch (error) {
      stopped = !!error?.rateLimited;
      Object.assign(result, { status: "failed", reason: error.message });
    }
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  const summary = {
    applied: count("applied"),
    doneEarlier: count("done-earlier"),
    wouldApply: count("would-apply"),
    skipped: count("skipped"),
    failed: count("failed"),
  };
  const exitCode =
    summary.failed && !summary.applied && !summary.doneEarlier
      ? 1
      : summary.skipped || summary.failed
        ? 2
        : 0;
  return {
    schemaVersion: 1,
    kind: "dependency-migration-result",
    repository: repo,
    dryRun: !!runtime.dryRun,
    summary,
    results,
    exitCode,
  };
}

/** @param {Awaited<ReturnType<typeof applyMigration>>} result */
export function migrationResultText(result) {
  const lines = [
    `Dependency migration ${result.dryRun ? "DRY RUN (no changes made)" : "apply"}: ${result.repository}`,
    Object.entries(result.summary)
      .map(([k, v]) => `${k} ${v}`)
      .join(", "),
  ];
  for (const r of result.results) {
    lines.push(`- #${r.number}: ${r.status}${r.reason ? ` — ${r.reason}` : ""}`);
    if (result.dryRun)
      for (const c of r.commands)
        lines.push(`    gh ${c.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
  }
  return lines.join("\n") + "\n";
}
