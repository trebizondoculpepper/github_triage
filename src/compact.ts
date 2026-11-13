/** Compact presentation of the registered findings; contract #698. */
import { owners, excerpt } from "./briefing.js";
import { unblocks } from "./dependencies.js";
import type { Briefing, BriefingOptions, Bounded, CheckOutcome } from "./briefing.js";
import type { Action, Issue, PullRequest, Snapshot } from "./types.js";

export type RuleGroup =
  | "hygiene"
  | "context"
  | "decisions"
  | "decision-needed"
  | "documentation-needed"
  | "dependencies"
  | "available"
  | "addressed"
  | "review";
export const ruleMetadata = new Map<string, RuleGroup>([
  ...["ownership-conflict", "readiness-inconsistent", "claimed-ready"].map(
    (key): [string, RuleGroup] => [key, "hygiene"],
  ),
  ["question-candidate", "context"],
  ["attention-label", "decisions"],
  ["design-decision-needed", "decision-needed"],
  ["design-documentation-needed", "documentation-needed"],
  ["prerequisites-closed", "dependencies"],
  ["ready-prerequisites-unverified", "dependencies"],
  ["blocker-explanation", "dependencies"],
  ["ready-unclaimed", "available"],
  ["urgency-conflict", "hygiene"],
  ["addressed-attention", "addressed"],
  ...[
    "native-evidence-unknown",
    "retired-blocker-label",
    "dependency-not-planned",
    "dependency-drift",
  ].map((key): [string, RuleGroup] => [key, "hygiene"]),
  ...[
    "pr-failed-checks",
    "pr-review-findings",
    "pr-conflicts",
    "pr-pending",
    "pr-inspect-merge",
    "pr-verification-needed",
    "pr-merge-state",
  ].map((key): [string, RuleGroup] => [key, "review"]),
]);
/** Chronology and excerpts of an item's body and latest comment. */
export interface SourceContext {
  body: { at: string | null; excerpt: string; url: string };
  latestComment: { at: string | null; excerpt: string; url: string } | null;
  chronology: string;
  guidance: string;
}
export function sourceContext(item: Issue): SourceContext {
  const latest = item.comments.nodes.at(-1);
  const bodyAt = item.lastEditedAt ?? item.createdAt ?? null;
  const commentAt = latest?.updatedAt ?? latest?.createdAt ?? null;
  return {
    body: { at: bodyAt, excerpt: excerpt(item.body, 180), url: item.url },
    latestComment: latest
      ? { at: commentAt, excerpt: excerpt(latest.body, 180), url: latest.url }
      : null,
    chronology:
      bodyAt && commentAt
        ? Date.parse(bodyAt) > Date.parse(commentAt)
          ? "Body edited after latest comment; comment may be superseded."
          : "Comment is not older than body; this does not establish a decision."
        : "Unknown chronology.",
    guidance:
      "Reconcile current body and comment history with --issue; chronology is not semantic authority.",
  };
}
/** Issues and pull requests share one subject shape; PR-only fields are optional here. */
type Subject = Issue & Partial<Pick<PullRequest, "closingIssuesReferences" | "headRefOid">>;
export interface CompactPullRequest {
  head: string;
  checks: CheckOutcome[];
  unresolvedThreads: number;
  linkedIssues: { number: number; url: string }[];
}
export interface CompactSubject {
  url: string;
  number: number;
  title: string;
  owners: string[];
  labels: string[];
  updatedAt: string;
  source: SourceContext;
  dependencies: Briefing["dependencies"][number] | null;
  findings: Action[];
  detailCommand: string;
  pullRequest?: CompactPullRequest;
}
export function compactBriefing(
  snapshot: Snapshot,
  options: Pick<BriefingOptions, "limit" | "agent">,
  expanded: Briefing,
) {
  const bound = <T>(items: T[], size = 3): Bounded<T> => ({
    total: items.length,
    omitted: Math.max(0, items.length - size),
    items: items.slice(0, size),
  });
  // Run expanded analysis without presentation limits so grouping never drops hidden findings.
  const facts = expanded;
  const objects = [...snapshot.issues, ...snapshot.pullRequests];
  const byUrl = new Map<string, Subject>(objects.map((item) => [item.url, item]));
  const isMine = (item: Pick<Issue, "labels">): boolean =>
    !!options.agent && owners(item).includes(`agent:${options.agent}`);
  // The addressed-attention rule itself is registered in briefing.js; here it only orders and
  // keeps addressed items visible regardless of role, ownership or parking.
  const labelNames = (item: Subject): string[] => item.labels.nodes.map(({ name }) => name);
  const isAddressed = (item: Subject | undefined): boolean =>
    !!options.agent && !!item && labelNames(item).includes(`attention:${options.agent}`);
  // Targets and section entries always come from snapshot objects, so a lookup by URL is
  // defined at runtime; an undefined item fails exactly as the untyped code did.
  const linkedMine = (item: Subject | undefined): boolean =>
    isMine(defined(item)) ||
    (defined(item).closingIssuesReferences?.nodes ?? []).some((ref) =>
      isMine(byUrl.get(ref.url) ?? unlabelled),
    );
  const unlabelled: Pick<Issue, "labels"> = {
    labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  };
  const grouped = new Map<string, Action[]>();
  for (const finding of facts.actions.items) {
    if (!grouped.has(finding.target)) grouped.set(finding.target, []);
    grouped.get(finding.target)?.push(finding);
  }
  for (const item of snapshot.issues.filter(isMine)) {
    const findings = grouped.get(item.url) ?? [];
    findings.unshift({
      rule: "continue-owned",
      priority: 110,
      target: item.url,
      title: item.title,
      reason: "Current work owned by the configured agent.",
      next: "Read current intake and continue this claim before claiming another ticket.",
      evidence: [item.url],
      uncertainty: "factual",
    });
    grouped.set(item.url, findings);
  }
  const groups = [...grouped].map(([target, findings]) => ({ target, findings }));
  const next = groups
    .filter(({ target, findings }) => {
      const item = byUrl.get(target);
      if (isAddressed(item)) return true;
      return (
        !item?.labels.nodes.some(({ name }) => name === "status:parked") &&
        findings.some((f) => !["context", "hygiene"].includes(ruleMetadata.get(f.rule) ?? "")) &&
        (!options.agent ||
          !owners(defined(item)).length ||
          linkedMine(item) ||
          findings.some((f) => ruleMetadata.get(f.rule) === "review"))
      );
    })
    .sort(
      (a, b) =>
        Number(isAddressed(byUrl.get(b.target))) - Number(isAddressed(byUrl.get(a.target))) ||
        Number(linkedMine(byUrl.get(b.target))) - Number(linkedMine(byUrl.get(a.target))) ||
        b.findings[0].priority - a.findings[0].priority ||
        unblocksOf(byUrl.get(b.target)) - unblocksOf(byUrl.get(a.target)) ||
        a.target.localeCompare(b.target),
    );
  const sections: Record<string, Bounded<string>> = Object.fromEntries(
    [
      "addressed",
      "review",
      "available",
      "decision-needed",
      "documentation-needed",
      "decisions",
      "dependencies",
      "hygiene",
      "context",
    ].map((name) => [
      name,
      bound(
        groups
          .filter(({ findings }) => findings.some((f) => ruleMetadata.get(f.rule) === name))
          .map(({ target }) => target),
      ),
    ]),
  );
  sections.current = bound(
    objects
      .filter((item) => owners(item).length && (!options.agent || linkedMine(item)))
      .map((item) => item.url),
  );
  sections.deferred = bound(
    snapshot.issues
      .filter((item) => item.labels.nodes.some(({ name }) => name === "status:parked"))
      .map((item) => item.url),
  );
  const actions = bound(next, options.limit);
  const urls = new Set([
    ...actions.items.map((item) => item.target),
    ...Object.values(sections).flatMap((s) => s.items),
  ]);
  const subjects = [...urls].map((url): CompactSubject => {
    const item = defined(byUrl.get(url));
    return {
      url,
      number: item.number,
      title: item.title,
      owners: owners(item),
      labels: item.labels.nodes.map(({ name }) => name),
      updatedAt: item.updatedAt,
      source: sourceContext(item),
      dependencies: facts.dependencies.find((dep) => dep.url === url) ?? null,
      findings: grouped.get(url) ?? [],
      detailCommand: item.headRefOid
        ? `gh pr view ${item.number} --repo ${snapshot.repository} --json headRefOid,statusCheckRollup,reviews`
        : `npm run --silent triage -- --repo ${snapshot.repository} --issue ${item.number} --json`,
      ...Object.fromEntries(
        facts.pullRequests
          .filter((pr) => pr.url === url)
          .map((pr) => [
            "pullRequest",
            {
              head: pr.headRefOid,
              checks: pr.checks,
              unresolvedThreads: pr.unresolvedThreads.length,
              linkedIssues: pr.linkedIssues,
            },
          ]),
      ),
    };
  });
  return {
    schemaVersion: 2 as const,
    repository: snapshot.repository,
    freshness: facts.freshness,
    completeness: facts.completeness,
    rateLimit: facts.rateLimit,
    metrics: snapshot.metrics ?? null,
    summary: {
      issues: snapshot.issues.filter((i) => i.state === "OPEN").length,
      pullRequests: facts.pullRequests.length,
      findings: groups.reduce((count, group) => count + group.findings.length, 0),
      distinctSubjects: groups.length,
    },
    actions: { ...actions, items: actions.items.map(({ target }) => target) },
    sections,
    subjects,
    changes: facts.changes,
    detail: facts.detail,
    guidance: options.agent
      ? facts.guidance
      : `${facts.guidance} No --agent given: addressed attention and owned-work focus are unavailable (identity is never inferred from the GitHub login).`,
  };
}
export type CompactBriefing = ReturnType<typeof compactBriefing>;
export function compactText(report: CompactBriefing, maxChars = 10000): string {
  const subjects = new Map(report.subjects.map((s) => [s.url, s]));
  const lines = [
    `GitHub action briefing: ${report.repository}`,
    `Fetched ${report.freshness.fetchedAt} — ${report.freshness.offline ? "OFFLINE CACHE; live verification unavailable" : "LIVE fetch window"}`,
    `${report.summary.issues} issues; ${report.summary.pullRequests} PRs; ${report.summary.findings} findings on ${report.summary.distinctSubjects} subjects.`,
    report.guidance,
  ];
  const rows: string[] = [];
  const shown = new Set<string>();
  const add = (title: string, section: Bounded<string>): void => {
    rows.push(`\n${title} (${section.total}; ${section.omitted} omitted)`);
    for (const url of section.items) {
      const s = defined(subjects.get(url));
      if (shown.has(url)) {
        rows.push(`- #${s.number}: ${url}`);
        continue;
      }
      shown.add(url);
      rows.push(
        `- #${s.number} ${s.title} ${s.owners.join(", ")}\n  ${s.findings.map((f) => `[${f.uncertainty}] ${f.reason} Next: ${f.next}`).join(" ")}\n  ${url}${s.pullRequest ? `\n  Head ${s.pullRequest.head}; ${s.pullRequest.checks.map((c) => `${c.name}:${c.outcome}`).join(", ")}; ${s.pullRequest.unresolvedThreads} unresolved threads` : ""}\n  ${s.source.chronology}\n  ${s.detailCommand}`,
      );
    }
  };
  add("NEXT STEPS", report.actions);
  const titles: Record<string, string> = {
    "decision-needed": "DECISION NEEDED",
    "documentation-needed": "AGREED, NEEDS DOCUMENTATION",
  };
  for (const [name, section] of Object.entries(report.sections))
    add(titles[name] ?? name.toUpperCase(), section);
  // Warnings are always shown, but bounded so they cannot exhaust the text budget alone;
  // JSON output keeps the full list.
  const warnings = report.completeness.warnings;
  const shownWarnings = 5;
  for (const warning of warnings.slice(0, shownWarnings)) lines.push(`INCOMPLETE: ${warning}`);
  if (warnings.length > shownWarnings)
    lines.push(
      `INCOMPLETE: ${warnings.length - shownWarnings} more warning(s) omitted; use --json for all.`,
    );
  const notice =
    "\nMore context omitted by text budget; use --json, --full, --issue N or --max-chars.\n";
  for (const row of rows) {
    if (lines.join("\n").length + row.length + notice.length + 2 > maxChars) {
      lines.push(notice);
      break;
    }
    lines.push(row);
  }
  if (report.detail) lines.push(`\nFULL ISSUE DETAIL\n${JSON.stringify(report.detail, null, 2)}`);
  return lines.join("\n") + "\n";
}

/** Open dependants an item unblocks; 0 for an unknown item, as before. */
const unblocksOf = (item: Issue | undefined): number => (item ? unblocks(item) : 0);
/**
 * Narrow a lookup that is defined by construction. A missing value throws a TypeError at
 * the first property access, matching the previous untyped behavior.
 */
function defined<T>(value: T | undefined): T {
  // Narrowly justified: the runtime failure mode for an impossible miss is preserved
  // deliberately rather than invented; callers only pass lookups of known keys.
  return value as T;
}
