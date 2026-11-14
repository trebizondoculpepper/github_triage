/**
 * "Who is working on this?" (#61): one ticket's recorded ownership, linked pull requests,
 * latest evidenced activity, and historical claim/handoff/release comments, with
 * contradictions. Contract: doc/design/diagnostics.md, "#41 / #61".
 *
 * Reuses the #41 team records (`owners`, `pullRequestState`, `latest`). Ownership is recorded
 * `agent:` labels only. Comments are historical evidence matched by registered patterns, never
 * an authoritative claim parser. Recorded ownership, recent activity and presence are separate;
 * with no presence source, availability is unknown. Nothing is claimed, released or notified.
 */
import { owners, workflow } from "./briefing.js";
import { defaultStaleHours, latest, pullRequestState } from "./team.js";
import type { LinkedPullRequest } from "./team.js";
import type { Comment, PullRequest, Snapshot } from "./types.js";

/** Kinds of historical comment evidence. */
export type CommentEvidenceKind = "reported-work" | "handoff" | "release" | "done";

/**
 * Registered comment-evidence policy. Patterns only surface comments for inspection; a match
 * is never treated as a claim or release. Extend here rather than special-casing tickets.
 */
export const ownershipEvidencePolicy: { kind: CommentEvidenceKind; pattern: RegExp }[] = [
  {
    kind: "release",
    pattern:
      /\b(releas(e|ed|ing) (my |the )?claim|unclaim(ed)?|dropp(ed|ing) (this|the ticket))\b/i,
  },
  {
    kind: "handoff",
    pattern: /\b(hand(ed|ing)? ?off|handoff|over to\b|awaiting[- ]review|ready for review)\b/i,
  },
  { kind: "done", pattern: /\b(done|completed|merged in|fixed in|shipped)\b/i },
  {
    kind: "reported-work",
    pattern: /\b(claim(ed|ing)?|picked up|picking (this )?up|working on|taking this|i'?ll take)\b/i,
  },
];

export interface CommentEvidence {
  kind: CommentEvidenceKind;
  at: string | null;
  url: string;
  excerpt: string;
}
export interface OwnershipFinding {
  kind: string;
  certainty: "definite" | "candidate" | "unknown";
  detail: string;
  sources: string[];
}
export interface TicketOwnership {
  schemaVersion: 1;
  kind: "ticket-ownership";
  repository: string;
  number: number;
  title: string;
  url: string;
  state: string;
  fetchedAt: string;
  freshness: { offline: boolean; ageSeconds: number; liveVerification: string };
  /** One-line answer; "unknown" whenever recorded ownership cannot be read completely. */
  answer: string;
  /** Persistent identities recorded by `agent:` labels; null when labels are incomplete. */
  recordedOwners: string[] | null;
  pullRequests: LinkedPullRequest[];
  latestActivity: { at: string; source: string } | null;
  staleHours: number;
  presence: string;
  commentEvidence: CommentEvidence[];
  findings: OwnershipFinding[];
  next: string[];
  completeness: { complete: boolean; warnings: string[] };
  guidance: string;
}
export interface OwnershipOptions {
  now?: Date;
  staleHours?: number;
  offline?: boolean;
}

const excerpt = (text: string, size = 160): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > size ? `${flat.slice(0, size - 1)}…` : flat;
};

/** First registered evidence kind a comment matches, if any. */
export function classifyComment(body: string): CommentEvidenceKind | null {
  return ownershipEvidencePolicy.find((rule) => rule.pattern.test(body))?.kind ?? null;
}

/**
 * Ownership lookup for one ticket from a snapshot collected with `--issue N` semantics.
 * Throws when the snapshot lacks the ticket.
 */
export function ticketOwnership(
  snapshot: Snapshot,
  number: number,
  { now = new Date(), staleHours = defaultStaleHours, offline = false }: OwnershipOptions = {},
): TicketOwnership {
  const issue = snapshot.issues.find((i) => i.number === number);
  if (!issue) throw new Error(`Issue #${number} is not in the snapshot.`);
  const warnings = [...snapshot.warnings];
  const labelsComplete = !issue.labels.pageInfo.hasNextPage;
  if (!labelsComplete)
    warnings.push(`${issue.url}: labels incomplete; recorded ownership unknown.`);
  if (issue.comments.pageInfo.hasNextPage)
    warnings.push(`${issue.url}: comment history incomplete.`);
  const recorded = labelsComplete
    ? owners(issue).map((o) => o.slice(workflow.ownerPrefix.length))
    : null;
  const linked: PullRequest[] = snapshot.pullRequests.filter((pr) =>
    (pr.closingIssuesReferences?.nodes ?? []).some((ref) => ref.url === issue.url),
  );
  const prs = linked.map(pullRequestState);
  const prComments = linked.flatMap((pr) => pr.comments.nodes);
  const evidence: CommentEvidence[] = [...issue.comments.nodes, ...prComments]
    .map((c: Comment) => ({ c, kind: classifyComment(c.body) }))
    .filter((e): e is { c: Comment; kind: CommentEvidenceKind } => e.kind !== null)
    .map(({ c, kind }) => ({ kind, at: c.createdAt ?? null, url: c.url, excerpt: excerpt(c.body) }))
    .sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
  const activity = latest([
    { at: issue.updatedAt, source: "ticket updated" },
    ...issue.comments.nodes.map((c) => ({ at: c.createdAt, source: `comment ${c.url}` })),
    ...prs.map((p) => ({ at: p.updatedAt, source: `PR #${p.number} updated` })),
    ...prComments.map((c) => ({ at: c.createdAt, source: `PR comment ${c.url}` })),
  ]);

  const findings: OwnershipFinding[] = [];
  const latestEvidence = evidence.at(-1);
  if (recorded && recorded.length > 1)
    findings.push({
      kind: "multiple-owners",
      certainty: "definite",
      detail: `Claimed by ${recorded.length} agents (${recorded.join(", ")}); one owner per ticket.`,
      sources: [issue.url],
    });
  if (recorded?.length && latestEvidence && latestEvidence.kind !== "reported-work")
    findings.push({
      kind: "claim-after-handoff",
      certainty: "candidate",
      detail: `Claim label present, but the latest ownership comment reads as ${latestEvidence.kind}; the label may be left over. Label history is not checked, so inspect before acting.`,
      sources: [latestEvidence.url],
    });
  if (recorded && !recorded.length) {
    const reported = evidence.filter((e) => e.kind === "reported-work");
    const lastReported = reported.at(-1);
    if (lastReported && latestEvidence === lastReported)
      findings.push({
        kind: "comment-only-work",
        certainty: "candidate",
        detail:
          "A comment reports work but no agent: label records a claim; comments are not authoritative claims.",
        sources: [lastReported.url],
      });
    for (const p of prs)
      findings.push({
        kind: "unowned-open-pr",
        certainty: "candidate",
        detail: `Open PR #${p.number} with no recorded owner; it may await review after its contributor released the claim. PR authorship is not identity.`,
        sources: [p.url],
      });
  }
  if (recorded?.length && issue.state !== "OPEN")
    findings.push({
      kind: "claim-on-closed",
      certainty: "definite",
      detail: `Ticket is ${issue.state} but still carries ${recorded.map((r) => workflow.ownerPrefix + r).join(", ")}.`,
      sources: [issue.url],
    });
  const ageHours = activity ? (now.getTime() - Date.parse(activity.at)) / 3_600_000 : null;
  if (ageHours === null)
    findings.push({
      kind: "activity-unknown",
      certainty: "unknown",
      detail: "No timestamped activity evidence.",
      sources: [issue.url],
    });
  else if (recorded?.length && ageHours > staleHours)
    findings.push({
      kind: "stale-activity",
      certainty: "candidate",
      detail: `No evidenced activity for ${Math.floor(ageHours)}h (threshold ${staleHours}h). Silence is not abandonment; nothing is released.`,
      sources: [activity!.source.replace(/^(PR )?comment /, "")],
    });

  const complete = labelsComplete && !warnings.length;
  const answer =
    recorded === null
      ? "unknown: recorded ownership could not be read completely"
      : recorded.length === 0
        ? "no recorded claim (no agent: label)"
        : recorded.length === 1
          ? `recorded claim: ${recorded[0]}`
          : `conflicting recorded claims: ${recorded.join(", ")}`;
  const triage = `pdb --repo ${snapshot.repository}`;
  const next = [
    `${triage} --issue ${number}`,
    ...prs.map((p) => `pdb pr ${p.number} --repo ${snapshot.repository}`),
    `pdb team --repo ${snapshot.repository}`,
  ];
  if (!complete)
    warnings.push(
      "Missing evidence is unknown, not absence of an owner; rerun live or inspect the ticket.",
    );
  return {
    schemaVersion: 1,
    kind: "ticket-ownership",
    repository: snapshot.repository,
    number,
    title: issue.title,
    url: issue.url,
    state: issue.state,
    fetchedAt: snapshot.fetchedAt,
    freshness: {
      offline,
      ageSeconds: Math.max(0, Math.floor((now.getTime() - Date.parse(snapshot.fetchedAt)) / 1000)),
      liveVerification: offline
        ? "not performed: offline cache; recheck live before acting on any claim"
        : "live fetch",
    },
    answer,
    recordedOwners: recorded,
    pullRequests: prs,
    latestActivity: activity,
    staleHours,
    presence:
      "unknown: no presence source; recorded ownership and recent activity are not availability",
    commentEvidence: evidence,
    findings,
    next,
    completeness: { complete, warnings },
    guidance:
      "Read-only. Ownership comes only from agent: labels; comments are historical evidence. Only open PRs that close this ticket are examined. Nothing is claimed, released or notified.",
  };
}

/** Text rendering. */
export function ticketOwnershipText(r: TicketOwnership): string {
  const lines = [
    `Who is working on #${r.number} ${r.title} (${r.state}) ${r.url}`,
    r.freshness.offline
      ? `OFFLINE cache fetched ${r.fetchedAt}; ownership not verified live`
      : `fetched ${r.fetchedAt}`,
    `Answer: ${r.answer}`,
    `Last activity: ${r.latestActivity ? `${r.latestActivity.at} (${r.latestActivity.source})` : "unknown"}`,
    `Presence: ${r.presence}`,
  ];
  for (const p of r.pullRequests)
    lines.push(
      `PR #${p.number}${p.draft ? " (draft)" : ""}: verify ${p.verify}, ${p.unresolvedThreads} unresolved threads, merge ${p.mergeState}${p.reviewDecision ? `, review ${p.reviewDecision}` : ""} ${p.url}`,
    );
  if (r.commentEvidence.length) lines.push("", "Ownership comments (historical, not claims):");
  for (const e of r.commentEvidence)
    lines.push(`  ${e.at ?? "unknown time"} ${e.kind}: ${e.excerpt} ${e.url}`);
  if (r.findings.length) lines.push("", "Findings:");
  for (const f of r.findings)
    lines.push(`  ${f.certainty.toUpperCase()} ${f.kind}: ${f.detail} ${f.sources.join(" ")}`);
  lines.push("", "Next:", ...r.next.map((n) => `  ${n}`));
  for (const w of r.completeness.warnings) lines.push(`INCOMPLETE: ${w}`);
  lines.push(r.guidance);
  return lines.join("\n") + "\n";
}
