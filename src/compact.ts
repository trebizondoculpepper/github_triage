/** Compact presentation of the registered findings; contract #698. */
import { isParked, owners, excerpt } from "./briefing.js";
import type { BriefingProcess } from "./process.js";
import type { Briefing, BriefingOptions, Bounded, CheckOutcome } from "./briefing.js";
import { estimateLine } from "./estimation.js";
import { assessmentsText, provenanceText } from "./assessments.js";
import type { SubjectAssessments } from "./assessments.js";
import type { EstimateEntry } from "./estimation.js";
import { compareImpact, impactLookup, urgencyBand } from "./ranking.js";
import { roleSectionRows, roleView } from "./roles.js";
import type { RoleContext } from "./roles.js";
import { rankActions, roleCandidates } from "./blended.js";
import type { BlendedRole, RankedActions } from "./blended.js";
import type { RoleView } from "./roles.js";
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
  ["stale-claim", "hygiene"],
  ["pickup-unverified", "context"],
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
  /** Complexity size/estimate state (#122); null when disabled or not an open issue. */
  complexity?: EstimateEntry | null;
  /**
   * Impact, complexity and unlock utility side by side (#247), in the paired vocabulary; null
   * for pull requests and closed issues. The legacy `complexity` field above is unchanged.
   */
  assessments?: SubjectAssessments | null;
}
export function compactBriefing(
  snapshot: Snapshot,
  options: Pick<BriefingOptions, "limit" | "agent" | "estimate"> & { role?: string },
  expanded: Briefing,
  assessments?: ReadonlyMap<string, SubjectAssessments>,
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
  // The same eligibility-filtered impact as the role views and pickup ranking (#208).
  const openStates = ["OPEN"];
  const impactOf = impactLookup(
    snapshot.issues.filter((i) => openStates.includes(i.state)),
    {
      prs: snapshot.pullRequests.filter((p) => openStates.includes(p.state)),
      platform: facts.ranking.platform ?? undefined,
    },
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
  // Implementer action groups (doc/design/briefings.md), first match wins: addressed attention,
  // actionable PR follow-up (own first), own active work, eligible pickup, then the rest.
  // Waiting PRs (pending CI only) are not actionable follow-up.
  const actionable = new Set([
    "pr-failed-checks",
    "pr-review-findings",
    "pr-conflicts",
    "pr-inspect-merge",
  ]);
  const tier = ({ target, findings }: { target: string; findings: Action[] }): number => {
    const item = byUrl.get(target);
    if (isAddressed(item)) return 0;
    if (findings.some((f) => actionable.has(f.rule))) return linkedMine(item) ? 1 : 2;
    if (item && isMine(item)) return 3;
    if (findings.some((f) => f.rule === "ready-unclaimed")) return 4;
    return 5;
  };
  // Pickup is ordered by its own ranked finding, so other findings cannot reorder the ranking.
  const topPriority = (findings: Action[]): number =>
    findings.find((f) => f.rule === "ready-unclaimed")?.priority ??
    Math.max(...findings.map((f) => f.priority));
  const next = groups
    .filter(({ target, findings }) => {
      const item = byUrl.get(target);
      if (isAddressed(item)) return true;
      return (
        !(item && isParked(item)) &&
        findings.some((f) => !["context", "hygiene"].includes(ruleMetadata.get(f.rule) ?? "")) &&
        (!options.agent ||
          !owners(defined(item)).length ||
          linkedMine(item) ||
          findings.some((f) => ruleMetadata.get(f.rule) === "review"))
      );
    })
    .sort(
      (a, b) =>
        tier(a) - tier(b) ||
        topPriority(b.findings) - topPriority(a.findings) ||
        compareImpact(impactOf(a.target), impactOf(b.target)) ||
        a.target.localeCompare(b.target),
    );
  const sectionNames = [
    "addressed",
    "review",
    "available",
    "decision-needed",
    "documentation-needed",
    "decisions",
    "dependencies",
    "hygiene",
    "context",
  ];
  // Unbounded section membership; the non-role briefing bounds it, role views use it as the
  // baseline every role must still show somewhere.
  const sectionLists: Record<string, string[]> = Object.fromEntries(
    sectionNames.map((name) => [
      name,
      groups
        .filter(({ findings }) => findings.some((f) => ruleMetadata.get(f.rule) === name))
        .map(({ target }) => target),
    ]),
  );
  sectionLists.current = objects
    .filter((item) => owners(item).length && (!options.agent || linkedMine(item)))
    .map((item) => item.url);
  sectionLists.deferred = snapshot.issues.filter(isParked).map((item) => item.url);
  const sections: Record<string, Bounded<string>> = Object.fromEntries(
    Object.entries(sectionLists).map(([name, urls]) => [name, bound(urls)]),
  );
  // Every subject the non-role briefing would show, with the reason it would show it.
  const baseline = new Map<string, string>();
  for (const { target, findings } of next)
    baseline.set(target, findings.map((f) => f.reason).join(" "));
  for (const [name, urls] of Object.entries(sectionLists))
    for (const url of urls)
      if (!baseline.has(url))
        baseline.set(
          url,
          name === "deferred"
            ? "Parked; not a next step."
            : name === "current"
              ? `Current claimed work (${owners(defined(byUrl.get(url))).join(", ")}).`
              : (grouped.get(url) ?? []).map((f) => f.reason).join(" ") || name,
        );
  // A registered role (#1) reshapes presentation of the same facts; without one, unchanged.
  const roleContext: RoleContext | null = options.role
    ? {
        snapshot,
        facts,
        findings: grouped,
        byUrl: new Map(
          objects.filter((item) => item.state === "OPEN").map((item) => [item.url, item]),
        ),
        isAddressed: (item) => isAddressed(item),
        isMine,
        linkedMine: (item) => linkedMine(item),
        baseline,
      }
    : null;
  const role: RoleView | null =
    options.role && roleContext ? roleView(options.role, roleContext) : null;
  const rowsBySection = new Map(
    options.role && roleContext
      ? roleSectionRows(options.role, roleContext).map(({ section, rows }) => [
          section.section,
          rows,
        ])
      : [],
  );
  // Additive blended ranking (#248); the legacy `actions` and `role.next` are unchanged.
  const blendedRole: BlendedRole | null =
    role && (role.name === "implementer" || role.name === "designer") ? role.name : null;
  const rankedActions: RankedActions | null =
    role && blendedRole && assessments
      ? rankActions(
          roleCandidates({
            repository: snapshot.repository,
            role: blendedRole,
            ...(options.agent ? { agent: options.agent } : {}),
            ...(facts.ranking.platform ? { platform: facts.ranking.platform } : {}),
            sections: role.sections.map((section) => ({
              name: section.name,
              background: section.background,
              // Ranking happens before limits: rank every row the selector placed.
              rows: rowsBySection.get(section.name) ?? section.items,
            })),
            subjects: new Map(
              objects.map((item) => [
                item.url,
                {
                  url: item.url,
                  number: item.number,
                  state: item.state,
                  createdAt: item.createdAt,
                  labels: labelNames(item),
                  isIssue: !("headRefOid" in item),
                },
              ]),
            ),
            assessments,
            isAddressed: (url) => isAddressed(byUrl.get(url)),
            isParked: (url) => isParked(defined(byUrl.get(url))),
            urgency: (url) => urgencyBand(defined(byUrl.get(url))),
            ownedByViewer: (url) => isMine(defined(byUrl.get(url))),
          }),
          { order: facts.ranking.order, limit: options.limit },
        )
      : null;
  const ordered = role
    ? role.next.map(({ url }) => ({ target: url, findings: grouped.get(url) ?? [] }))
    : next;
  const actions = bound(ordered, options.limit);
  // Estimation is offered automatically only when no higher-priority group (addressed
  // attention, PR follow-up, own work, eligible pickup) exists; explicit requests always see it.
  const higher = next.some((group) => tier(group) <= 4);
  const estimates = new Map(facts.estimation.entries.map((e) => [e.url, e]));
  const { entries: _entries, queue, conflicts, ...estimationFacts } = facts.estimation;
  const shownQueue = queue?.items.slice(0, options.limit) ?? [];
  const shownConflicts = conflicts.slice(0, options.limit);
  const estimation = {
    ...estimationFacts,
    conflicts: {
      total: conflicts.length,
      omitted: conflicts.length - shownConflicts.length,
      items: shownConflicts,
    },
    offered: estimationFacts.requested || (!higher && !!queue?.total),
    queue: queue
      ? { total: queue.total, omitted: queue.total - shownQueue.length, items: shownQueue }
      : null,
  };
  const urls = new Set([
    ...actions.items.map((item) => item.target),
    ...Object.values(sections).flatMap((s) => s.items),
    ...(role?.sections.flatMap((s) => s.items.map((row) => row.url)) ?? []),
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
      complexity: estimates.get(url) ?? null,
      assessments: assessments?.get(url) ?? null,
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
    ranking: facts.ranking,
    metrics: snapshot.metrics ?? null,
    summary: {
      issues: snapshot.issues.filter((i) => i.state === "OPEN").length,
      pullRequests: facts.pullRequests.length,
      findings: groups.reduce((count, group) => count + group.findings.length, 0),
      distinctSubjects: groups.length,
    },
    actions: { ...actions, items: actions.items.map(({ target }) => target) },
    sections,
    role,
    rankedActions,
    estimation,
    subjects,
    changes: facts.changes,
    detail: facts.detail,
    guidance: options.agent
      ? facts.guidance
      : `${facts.guidance} No --agent given: addressed attention and owned-work focus are unavailable (identity is never inferred from the GitHub login).`,
  };
}
export type CompactBriefing = ReturnType<typeof compactBriefing>;
export function compactText(
  report: CompactBriefing & { process?: BriefingProcess },
  maxChars = 10000,
): string {
  const subjects = new Map(report.subjects.map((s) => [s.url, s]));
  const lines = [
    `GitHub action briefing: ${report.repository}`,
    `Fetched ${report.freshness.fetchedAt} — ${report.freshness.offline ? "OFFLINE CACHE; live verification unavailable" : "LIVE fetch window"}`,
    `${report.summary.issues} issues; ${report.summary.pullRequests} PRs; ${report.summary.findings} findings on ${report.summary.distinctSubjects} subjects.`,
    report.guidance,
  ];
  const rows: string[] = [];
  const shown = new Set<string>();
  const add = (
    title: string,
    section: Bounded<string>,
    reasons?: ReadonlyMap<string, string>,
  ): void => {
    rows.push(`\n${title} (${section.total}; ${section.omitted} omitted)`);
    for (const url of section.items) {
      const s = defined(subjects.get(url));
      const why = reasons?.get(url);
      if (shown.has(url)) {
        rows.push(`- #${s.number}: ${url}${why ? ` — ${why}` : ""}`);
        continue;
      }
      shown.add(url);
      rows.push(
        `- #${s.number} ${s.title} ${s.owners.join(", ")}${s.assessments ? "" : s.complexity && report.estimation.status === "available" ? ` (${s.complexity.state === "unknown" ? "size unknown" : (s.complexity.size ?? "unestimated")})` : ""}${s.assessments ? `\n  ${assessmentsText(s.assessments)}` : ""}${s.assessments && report.detail?.url === url && provenanceText(s.assessments) ? `\n  ${provenanceText(s.assessments)}` : ""}${why ? `\n  Why: ${why}` : ""}\n  ${s.findings.map((f) => `[${f.uncertainty}] ${f.reason}${markerSource(f)} Next: ${f.next}`).join(" ")}\n  ${url}${s.pullRequest ? `\n  Head ${s.pullRequest.head}; ${s.pullRequest.checks.map((c) => `${c.name}:${c.outcome}`).join(", ")}; ${s.pullRequest.unresolvedThreads} unresolved threads` : ""}\n  ${s.source.chronology}\n  ${s.detailCommand}`,
      );
    }
  };
  const estimation = report.estimation;
  const estimationRows = (): void => {
    if (estimation.status === "disabled") return;
    rows.push(
      `\nESTIMATION${estimation.requested ? " (requested)" : " (optional; after the work above)"} (${estimation.queue?.total ?? "unavailable"}; ${estimation.queue?.omitted ?? 0} omitted)`,
      `- ${estimation.detail}`,
      ...estimation.findings.map((f) => `- ${f.rule}: ${f.detail} Next: ${f.next.join(" | ")}`),
      ...(estimation.queue?.items ?? []).map(
        (e) => `- #${e.number} ${e.title}\n  ${estimateLine(e)}\n  ${e.url}`,
      ),
      `- ${estimation.boundaries} Guidance: github-triage estimate --help`,
    );
  };
  if (estimation.requested) estimationRows();
  const roleReasons = new Map(
    report.role?.sections.flatMap((s) =>
      s.items.map((row): [string, string] => [row.url, row.reason]),
    ) ?? [],
  );
  add("NEXT STEPS", report.actions, roleReasons);
  if (estimation.offered && !estimation.requested)
    rows.push("- No higher-priority work: estimation is offered below (optional).");
  if (report.role) {
    lines.push(`Role ${report.role.name}: ${report.role.question}`);
    for (const section of report.role.sections) {
      const reasons = new Map(section.items.map((row) => [row.url, row.reason]));
      add(
        section.background ? `${section.title} (background)` : section.title,
        { ...section, items: section.items.map((row) => row.url) },
        reasons,
      );
    }
  }
  const titles: Record<string, string> = {
    "decision-needed": "DECISION NEEDED",
    "documentation-needed": "AGREED, NEEDS DOCUMENTATION",
  };
  if (!report.role)
    for (const [name, section] of Object.entries(report.sections))
      add(titles[name] ?? name.toUpperCase(), section);
  if (!estimation.requested) estimationRows();
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
  // The workflow-guide footer (config diagnostics plus the pointer or omission notice) is
  // required output, so its space is reserved before evidence rows are allocated (#71).
  const guide = report.process;
  const footer = guide
    ? [
        ...guide.diagnostics.map((diagnostic) => `CONFIG: ${diagnostic}`),
        guide.guide
          ? `\nWorkflow guide omitted by text budget. ${guide.pointer}`
          : `\n${guide.pointer}`,
      ].reduce((total, line) => total + line.length + 1, 0)
    : 0;
  for (const row of rows) {
    if (lines.join("\n").length + row.length + notice.length + footer + 2 > maxChars) {
      lines.push(notice);
      break;
    }
    lines.push(row);
  }
  // The workflow guide (#71) is optional context: it follows the evidence and counts against the
  // same budget. When it does not fit, only its pointer is shown and the omission is stated.
  if (guide) {
    for (const diagnostic of guide.diagnostics) lines.push(`CONFIG: ${diagnostic}`);
    const fits = (text: string) => lines.join("\n").length + text.length + 2 <= maxChars;
    if (guide.guide && fits(`\n${guide.guide}`)) lines.push(`\n${guide.guide}`);
    else if (guide.guide) lines.push(`\nWorkflow guide omitted by text budget. ${guide.pointer}`);
    else lines.push(`\n${guide.pointer}`);
  }
  if (report.detail) lines.push(`\nFULL ISSUE DETAIL\n${JSON.stringify(report.detail, null, 2)}`);
  return lines.join("\n") + "\n";
}

/**
 * Narrow a lookup that is defined by construction. A missing value throws a TypeError at
 * the first property access, matching the previous untyped behavior.
 */
function defined<T>(value: T | undefined): T {
  // Narrowly justified: the runtime failure mode for an impossible miss is preserved
  // deliberately rather than invented; callers only pass lookups of known keys.
  return value as T;
}

/** Designer-marker findings (#40) cite the comment that supplied their reason, beyond the target. */
const designMarkerRules: ReadonlySet<string> = new Set([
  "design-decision-needed",
  "design-documentation-needed",
]);
function markerSource(finding: Action): string {
  if (!designMarkerRules.has(finding.rule)) return "";
  const source = finding.evidence.slice(1).at(-1);
  return source ? ` Source: ${source}` : "";
}
