/**
 * Team view (#41): who holds which claims, their linked pull requests and latest evidenced
 * activity, with warnings. Contract: doc/design/diagnostics.md, "#41 / #61".
 *
 * Ownership is recorded `agent:` labels only: never comment text, origin, attention or the
 * shared GitHub login. Recorded ownership, recent activity and live presence are distinct;
 * there is no presence source, so availability is always reported as unknown. Nothing here
 * releases a claim or infers abandonment.
 */
import { owners, prChecks, workflow } from "./briefing.js";
import type { PullRequest, Snapshot } from "./types.js";

export interface LinkedPullRequest {
  number: number;
  url: string;
  draft: boolean;
  verify: string;
  reviewDecision: string | null;
  unresolvedThreads: number;
  mergeState: string;
  updatedAt: string | null;
}
export interface TeamClaim {
  number: number;
  title: string;
  url: string;
  coOwners: string[];
  pullRequests: LinkedPullRequest[];
  latestActivity: { at: string; source: string } | null;
  candidates: string[];
}
export interface TeamWarning {
  kind: string;
  certainty: "definite" | "candidate";
  detail: string;
  ticket?: number;
}
export interface TeamAgent {
  agent: string;
  presence: string;
  claims: TeamClaim[];
  warnings: TeamWarning[];
}
export interface TeamConflict {
  number: number;
  url: string;
  agents: string[];
}
export interface TeamView {
  schemaVersion: 1;
  kind: "team-view";
  repository: string;
  fetchedAt: string;
  freshness: {
    startedAt: string;
    fetchedAt: string;
    offline: boolean;
    ageSeconds: number;
    liveVerification: string;
  };
  staleHours: number;
  presence: string;
  agents: TeamAgent[];
  conflicts: TeamConflict[];
  completeness: { complete: boolean; warnings: string[] };
  guidance: string;
}
export interface TeamOptions {
  now?: Date;
  staleHours?: number;
  offline?: boolean;
}

interface ActivityEvent {
  at: string | null | undefined;
  source: string;
}

/** Default staleness candidate threshold: the general briefing's two days (#41 contract). */
export const defaultStaleHours = 48;

const latest = (events: ActivityEvent[]): { at: string; source: string } | null =>
  events
    .filter((e): e is { at: string; source: string } => !!e.at && Number.isFinite(Date.parse(e.at)))
    .sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;

/** A linked pull request's state, from the evidence the briefing already collects. */
function pullRequestState(pr: PullRequest): LinkedPullRequest {
  const checks = prChecks(pr);
  const verify = checks.find((c) => c.name === workflow.verify)?.outcome ?? "UNKNOWN";
  return {
    number: pr.number,
    url: pr.url,
    draft: !!pr.isDraft,
    verify,
    reviewDecision: pr.reviewDecision ?? null,
    unresolvedThreads: pr.reviewThreads.nodes.filter((t) => !t.isResolved).length,
    mergeState: pr.mergeStateStatus ?? "UNKNOWN",
    updatedAt: pr.updatedAt ?? null,
  };
}

/**
 * Aggregate open claims by agent.
 */
export function teamView(
  snapshot: Snapshot,
  { now = new Date(), staleHours = defaultStaleHours, offline = false }: TeamOptions = {},
): TeamView {
  const open = snapshot.issues.filter((i) => i.state === "OPEN");
  const linked = new Map<string, PullRequest[]>();
  for (const pr of snapshot.pullRequests)
    for (const ref of pr.closingIssuesReferences?.nodes ?? [])
      linked.set(ref.url, [...(linked.get(ref.url) ?? []), pr]);
  const agents = new Map<string, TeamAgent>();
  const conflicts: TeamConflict[] = [];
  for (const issue of open) {
    const labels = issue.labels.nodes.map((l) => l.name);
    const holders = owners(issue).map((o) => o.slice(workflow.ownerPrefix.length));
    if (!holders.length) continue;
    // Two agents on one ticket is a definite ownership violation, not a candidate.
    if (holders.length > 1)
      conflicts.push({ number: issue.number, url: issue.url, agents: holders });
    const prs = (linked.get(issue.url) ?? []).map(pullRequestState);
    const activity = latest([
      { at: issue.updatedAt, source: "ticket updated" },
      ...issue.comments.nodes.map((c) => ({ at: c.createdAt, source: `comment ${c.url}` })),
      ...prs.map((p) => ({ at: p.updatedAt, source: `PR #${p.number} updated` })),
    ]);
    const ageHours = activity ? (now.getTime() - Date.parse(activity.at)) / 3_600_000 : null;
    const candidates: string[] = [];
    if (ageHours === null) candidates.push("activity unknown");
    else if (ageHours > staleHours)
      candidates.push(
        `stale candidate: no evidenced activity for ${Math.floor(ageHours)}h (threshold ${staleHours}h)`,
      );
    if (labels.includes("meta") || /\bumbrella\b/i.test(issue.title))
      candidates.push(
        "umbrella candidate: a claim on an umbrella ticket is not active work on a slice",
      );
    if (labels.includes(workflow.ready))
      candidates.push(`claimed but still labelled ${workflow.ready}`);
    for (const blocker of ["status:needs-design", "question", "design:decision-needed"])
      if (labels.includes(blocker)) candidates.push(`claimed while ${blocker}`);
    const claim: TeamClaim = {
      number: issue.number,
      title: issue.title,
      url: issue.url,
      coOwners: holders.length > 1 ? holders : [],
      pullRequests: prs,
      latestActivity: activity ? { at: activity.at, source: activity.source } : null,
      candidates,
    };
    for (const agent of holders) {
      let entry = agents.get(agent);
      if (!entry) {
        entry = { agent, presence: "unknown", claims: [], warnings: [] };
        agents.set(agent, entry);
      }
      entry.claims.push(claim);
    }
  }
  for (const entry of agents.values()) {
    entry.claims.sort((a, b) => a.number - b.number);
    if (entry.claims.length > 1)
      entry.warnings.push({
        kind: "multiple-claims",
        certainty: "definite",
        detail: `${entry.claims.length} active claims (${entry.claims.map((c) => `#${c.number}`).join(", ")}); one active claim per agent.`,
      });
    for (const c of entry.claims)
      for (const detail of c.candidates)
        entry.warnings.push({
          kind: "candidate",
          certainty: "candidate",
          ticket: c.number,
          detail,
        });
  }
  return {
    schemaVersion: 1,
    kind: "team-view",
    repository: snapshot.repository,
    fetchedAt: snapshot.fetchedAt,
    // Same freshness shape as the briefing: an offline cache is labelled with its fetch time
    // and age, and ownership is not verified live.
    freshness: {
      startedAt: snapshot.startedAt,
      fetchedAt: snapshot.fetchedAt,
      offline,
      ageSeconds: Math.max(0, Math.floor((now.getTime() - Date.parse(snapshot.fetchedAt)) / 1000)),
      liveVerification: offline
        ? "not performed: offline cache; recheck live before acting on any claim"
        : "live fetch",
    },
    staleHours,
    presence:
      "unknown: no presence source; recorded ownership and recent activity are not availability",
    agents: [...agents.values()].sort((a, b) => a.agent.localeCompare(b.agent)),
    conflicts,
    completeness: { complete: !snapshot.warnings.length, warnings: snapshot.warnings },
    guidance:
      "Read-only. Ownership comes only from agent: labels. Candidates need inspection; nothing is released or reassigned automatically.",
  };
}

/** Text rendering. */
export function teamText(view: TeamView): string {
  const age = view.freshness.ageSeconds;
  const lines = [
    view.freshness.offline
      ? `Team view: ${view.repository} — OFFLINE cache fetched ${view.fetchedAt} (${Math.floor(age / 3600)}h ${Math.floor((age % 3600) / 60)}m old); ownership not verified live`
      : `Team view: ${view.repository} (fetched ${view.fetchedAt})`,
    view.guidance,
    `Presence: ${view.presence}`,
  ];
  if (!view.agents.length) lines.push("", "No open tickets carry an agent: claim.");
  for (const a of view.agents) {
    lines.push(
      "",
      `${a.agent}: ${a.claims.length} active claim${a.claims.length === 1 ? "" : "s"}`,
    );
    for (const c of a.claims) {
      lines.push(`  #${c.number} ${c.title} ${c.url}`);
      lines.push(
        `    last activity: ${c.latestActivity ? `${c.latestActivity.at} (${c.latestActivity.source})` : "unknown"}`,
      );
      for (const p of c.pullRequests)
        lines.push(
          `    PR #${p.number}${p.draft ? " (draft)" : ""}: verify ${p.verify}, ${p.unresolvedThreads} unresolved threads, merge ${p.mergeState}${p.reviewDecision ? `, review ${p.reviewDecision}` : ""}`,
        );
      if (c.coOwners.length)
        lines.push(
          `    CONFLICT: also claimed by ${c.coOwners.filter((o) => o !== a.agent).join(", ")}`,
        );
    }
    for (const w of a.warnings.filter((w) => w.certainty === "definite"))
      lines.push(`  WARNING: ${w.detail}`);
    for (const w of a.warnings.filter((w) => w.certainty === "candidate"))
      lines.push(`  candidate #${w.ticket}: ${w.detail}`);
  }
  for (const w of view.completeness.warnings) lines.push(`INCOMPLETE: ${w}`);
  return lines.join("\n") + "\n";
}
