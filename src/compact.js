/** Compact presentation of the registered findings; contract #698. */
import { owners, excerpt } from "./briefing.js";
import { unblocks } from "./dependencies.js";

export const ruleMetadata = new Map([
  ...["ownership-conflict", "readiness-inconsistent", "claimed-ready"].map((key) => [
    key,
    "hygiene",
  ]),
  ["question-candidate", "context"],
  ["attention-label", "decisions"],
  ["prerequisites-closed", "dependencies"],
  ["ready-prerequisites-unverified", "dependencies"],
  ["blocker-explanation", "dependencies"],
  ["ready-unclaimed", "available"],
  ...[
    "native-evidence-unknown",
    "retired-blocker-label",
    "dependency-not-planned",
    "dependency-drift",
  ].map((key) => [key, "hygiene"]),
  ...[
    "pr-failed-checks",
    "pr-review-findings",
    "pr-conflicts",
    "pr-pending",
    "pr-inspect-merge",
    "pr-verification-needed",
    "pr-merge-state",
  ].map((key) => [key, "review"]),
]);
export function sourceContext(item) {
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
export function compactBriefing(snapshot, options, expanded) {
  const bound = (items, size = 3) => ({
    total: items.length,
    omitted: Math.max(0, items.length - size),
    items: items.slice(0, size),
  });
  // Run expanded analysis without presentation limits so grouping never drops hidden findings.
  const facts = expanded;
  const objects = [...snapshot.issues, ...snapshot.pullRequests];
  const byUrl = new Map(objects.map((item) => [item.url, item]));
  const isMine = (item) => !!options.agent && owners(item).includes(`agent:${options.agent}`);
  const linkedMine = (item) =>
    isMine(item) ||
    (item.closingIssuesReferences?.nodes ?? []).some((ref) =>
      isMine(byUrl.get(ref.url) ?? { labels: { nodes: [] } }),
    );
  const grouped = new Map();
  for (const finding of facts.actions.items) {
    if (!grouped.has(finding.target)) grouped.set(finding.target, []);
    grouped.get(finding.target).push(finding);
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
      return (
        !item?.labels.nodes.some(({ name }) => name === "status:parked") &&
        findings.some((f) => !["context", "hygiene"].includes(ruleMetadata.get(f.rule))) &&
        (!options.agent ||
          !owners(item).length ||
          linkedMine(item) ||
          findings.some((f) => ruleMetadata.get(f.rule) === "review"))
      );
    })
    .sort(
      (a, b) =>
        Number(linkedMine(byUrl.get(b.target))) - Number(linkedMine(byUrl.get(a.target))) ||
        b.findings[0].priority - a.findings[0].priority ||
        unblocks(byUrl.get(b.target)) - unblocks(byUrl.get(a.target)) ||
        a.target.localeCompare(b.target),
    );
  const sections = Object.fromEntries(
    ["review", "available", "decisions", "dependencies", "hygiene", "context"].map((name) => [
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
  const subjects = [...urls].map((url) => {
    const item = byUrl.get(url);
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
    schemaVersion: 2,
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
    guidance: facts.guidance,
  };
}
export function compactText(report, maxChars = 10000) {
  const subjects = new Map(report.subjects.map((s) => [s.url, s]));
  const lines = [
    `GitHub action briefing: ${report.repository}`,
    `Fetched ${report.freshness.fetchedAt} — ${report.freshness.offline ? "OFFLINE CACHE; live verification unavailable" : "LIVE fetch window"}`,
    `${report.summary.issues} issues; ${report.summary.pullRequests} PRs; ${report.summary.findings} findings on ${report.summary.distinctSubjects} subjects.`,
    report.guidance,
  ];
  const rows = [];
  const shown = new Set();
  const add = (title, section) => {
    rows.push(`\n${title} (${section.total}; ${section.omitted} omitted)`);
    for (const url of section.items) {
      const s = subjects.get(url);
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
  for (const [name, section] of Object.entries(report.sections)) add(name.toUpperCase(), section);
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
