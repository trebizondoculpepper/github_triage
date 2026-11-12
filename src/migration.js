/**
 * Read-only migration report: how `Depends on` text and `blocked:work` labels map to
 * native GitHub dependencies. Contract: doc/issue-dependencies.md, "Migration".
 *
 * planMigration only reads. Automatic apply is deferred (#48); changes are made with the
 * validated `deps add` / `deps remove` commands or deliberate manual edits.
 */
import { workflow } from "./briefing.js";
import { collect, declaredDependencyContexts, ghQuery } from "./github.js";

/** Wording that must never become a blocker without review. */
export const hedged = /\b(?:optional(?:ly)?|coordinat\w*|nice[- ]to[- ]have|ideally|after)\b/i;
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
    `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){__typename ... on Issue{number url state stateReason} ... on PullRequest{number url state merged closingIssuesReferences(first:100){nodes{number url state repository{nameWithOwner}} pageInfo{hasNextPage}}}}}}`,
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
      // Local edges dedupe against local rows only; a cross-repository #N is a different issue.
      else if (
        native.has(blocker) ||
        edges.some((e) => e.blocker === blocker && !e.crossRepository)
      )
        return;
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
        edges.push({
          ...base,
          crossRepository: true,
          status: "review",
          reason: "Cross-repository reference.",
        });
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
      if (target.closingIssuesReferences?.pageInfo?.hasNextPage) {
        edges.push({
          ...base,
          url: target.url,
          status: "review",
          reason: `PR #${target.number} closes more than 100 issues; list incomplete.`,
        });
        continue;
      }
      const allClosing = target.closingIssuesReferences?.nodes ?? [];
      const closes = allClosing.filter((n) => sameRepo(n.repository.nameWithOwner, repository));
      for (const n of closes)
        propose(n.number, n.url, n.state, `pr #${target.number}`, ref.context, ref.number);
      // Issues the PR closes elsewhere are kept for review, like declared cross-repo references.
      for (const n of allClosing.filter((n) => !sameRepo(n.repository.nameWithOwner, repository)))
        edges.push({
          blocker: n.number,
          url: n.url,
          state: n.state,
          source: `pr #${target.number}`,
          context: ref.context,
          crossRepository: true,
          status: "review",
          reason: "Cross-repository issue closed by a referenced PR.",
        });
      if (allClosing.length) continue;
      if (target.merged)
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
    if (tags.includes(workflow.retiredReason) && issue.labels.pageInfo?.hasNextPage) {
      // Another blocked:* reason may be on a later page: never infer readiness from a partial list.
      labels = {
        remove: [],
        add: [],
        status: "review",
        reason: "More than 100 labels; the label list is incomplete.",
      };
    } else if (tags.includes(workflow.retiredReason)) {
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
  const createdAt = now().toISOString();
  return {
    schemaVersion: 1,
    kind: "dependency-migration-plan",
    repository,
    createdAt,
    guidance:
      'Read-only report. "apply" rows resolved cleanly from explicit declarations; "review" rows need a person. Record edges with `deps add N --on M --note WHY`; change labels deliberately. Automatic apply is deferred (#48).',
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
