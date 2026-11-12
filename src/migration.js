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
const reference = /#\d+\b|\/(?:issues|pull)\/\d+\b/;
const clauses = (context) => context.split(/[;,]|\s+\u2014\s+/);
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * The clause of a declaring sentence that names a reference, so hedging elsewhere in the
 * sentence ("Depends on #1; coordinate #2") does not taint a firm blocker. A reference is
 * matched in its own form: a local one as a bare `#N` (or its URL), an external one only by
 * its URL. A clause holding nothing but references ("optionally #2, #3") continues the
 * clause before it, so it keeps that clause's qualifier.
 * @param {string} context
 * @param {number | { number: number, url?: string, local?: boolean }} ref
 */
export function clauseFor(context, ref) {
  const { number, url, local = true } = typeof ref === "number" ? { number: ref } : ref;
  const forms = [
    ...(local ? [`(?<![\\w/])#${number}\\b`] : []),
    ...(url ? [`${escape(url)}\\b`] : []),
  ];
  const mention = new RegExp(forms.join("|") || `#${number}\\b`);
  const parts = clauses(context);
  let at = parts.findIndex((part) => mention.test(part));
  if (at < 0) return context;
  const end = at;
  const onlyReferences = (part) =>
    !part
      .replace(/https:\/\/github\.com\/[^\s)\]]+|#\d+\b/g, "")
      .replace(/\b(?:and|or)\b/gi, "")
      // Markdown around references (`#4`, **#4**, [#4](...)) is formatting, not words.
      .replace(/[\s.!?:()`*_[\]]/g, "");
  while (at > 0 && onlyReferences(parts[at])) at--;
  return parts.slice(at, end + 1).join(",");
}
/**
 * A hedge that qualifies the whole list ("Depends on #1, #2 and #3 (all optional)",
 * "Depends on #1, #2, ideally") rather than one reference: a hedged clause or parenthetical
 * that names no reference itself, or "all/both/each/either ... optional".
 * @param {string} context
 */
export function listWideHedge(context) {
  // A qualifier before the first reference governs the list it introduces ("Optional: #2, #3").
  const first = context.search(reference);
  if (first > 0 && hedged.test(context.slice(0, first))) return true;
  const parts = clauses(context);
  if (parts.some((part) => !reference.test(part) && hedged.test(part))) return true;
  for (const m of context.matchAll(/\(([^)]*)\)/g))
    if (!reference.test(m[1]) && hedged.test(m[1])) return true;
  return /\b(?:all|both|each|either|any)\b[^.;]*\b(?:optional(?:ly)?|nice[- ]to[- ]have)\b/i.test(
    context,
  );
}
const isHedged = (context, ref) => listWideHedge(context) || hedged.test(clauseFor(context, ref));

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
    const propose = (blocker, url, state, source, context, mention = blocker) => {
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
          status: isHedged(context, mention) ? "review" : "apply",
          reason: isHedged(context, mention) ? "Hedged wording; confirm it is a real blocker." : "",
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
        propose(target.number, target.url, target.state, "text", ref.context, {
          number: ref.number,
          url: ref.url,
          local: true,
        });
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
        propose(n.number, n.url, n.state, `pr #${target.number}`, ref.context, {
          number: ref.number,
          url: ref.url,
          local: true,
        });
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
    if (issue.labels.pageInfo?.hasNextPage) {
      // blocked:work or another blocked:* reason may be on a later page: report the ticket
      // for review rather than infer anything from a partial list, or silently omit it.
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
    // Collection warnings (e.g. incomplete labels) travel with the report.
    warnings: snapshot.warnings ?? [],
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
    ...(plan.warnings ?? []).map((w) => `INCOMPLETE: ${w}`),
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
