/**
 * Ticket Doctor v1 (#66): a read-only consistency scan of every open ticket.
 * Contract: doc/design/diagnostics.md, "#66: Ticket Doctor v1".
 *
 * Cheap structured checks only, grouped by ticket and labelled definite, candidate or
 * unknown. It never changes anything and never reclaims: v2 (#67) suggests corrections.
 */
import { owners, workflow } from "./briefing.js";
import { dependencyDrift, nativeKnown } from "./dependencies.js";
import { teamView } from "./team.js";
import { complexityConfigText } from "./complexitydoctor.js";
import type { ComplexityConfigReport } from "./complexitydoctor.js";
import type { Issue, Snapshot } from "./types.js";

/** Ticket Doctor's own staleness default: 24 hours, separate from the briefing's two days. */
export const doctorStaleHours = 24;

/** Label conventions from the merged contracts (registered here, not per check). */
export const doctorPolicy = {
  classification: ["bug", "enhancement", "documentation"],
  readiness: [...workflow.readiness, "status:incomplete", "status:awaiting-review"],
  claimedReadiness: [workflow.ready, "status:incomplete"],
  awaitingReview: "status:awaiting-review",
  designEvidence: ["question", "design:decision-needed", "status:needs-design"],
  urgency: ["urgency:high", "urgency:low"],
};

export type Certainty = "definite" | "candidate" | "unknown";
export interface DoctorFinding {
  kind: string;
  certainty: Certainty;
  detail: string;
}
export interface DoctorTicket {
  number: number;
  title: string;
  url: string;
  findings: DoctorFinding[];
}
export interface TicketDoctorOptions {
  now?: Date;
  staleHours?: number;
  limit?: number;
  offline?: boolean;
}
export interface TicketDoctorReport {
  schemaVersion: 1;
  kind: "ticket-doctor";
  repository: string;
  fetchedAt: string;
  freshness: ReturnType<typeof teamView>["freshness"];
  staleHours: number;
  scanned: number;
  summary: { tickets: number; definite: number; candidate: number; unknown: number };
  tickets: DoctorTicket[];
  omittedTickets: number;
  completeness: { complete: boolean; warnings: string[] };
  guidance: string;
  /** Repository-level configuration diagnosis (#120); additive, absent when not evaluated. */
  configuration?: { complexity: ComplexityConfigReport };
}

/**
 * Tickets on a blocked-by cycle: every member of a strongly connected component with more than
 * one ticket (or a self-loop). Tarjan's algorithm, so overlapping cycles are reported in full.
 * `edges` maps ticket URL → blocker URLs (open tickets only); returns components, each sorted.
 */
export function blockerCycles(edges: Map<string, string[]>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const connect = (v: string): void => {
    indices.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!edges.has(w)) continue;
      if (!indices.has(w)) {
        connect(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v) ?? 0, indices.get(w) ?? 0));
    }
    if (low.get(v) === indices.get(v)) {
      const component: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop();
        if (w !== undefined) {
          onStack.delete(w);
          component.push(w);
        }
      } while (w !== v && w !== undefined);
      if (component.length > 1 || (edges.get(v) ?? []).includes(v))
        components.push(component.sort((a, b) => a.localeCompare(b)));
    }
  };
  for (const v of edges.keys()) if (!indices.has(v)) connect(v);
  return components;
}

export function ticketDoctor(
  snapshot: Snapshot,
  {
    now = new Date(),
    staleHours = doctorStaleHours,
    limit = 30,
    offline = false,
  }: TicketDoctorOptions = {},
): TicketDoctorReport {
  const open = snapshot.issues.filter((i) => i.state === "OPEN");
  const tickets = new Map<number, DoctorTicket>();
  const add = (
    issue: Pick<Issue, "number" | "title" | "url">,
    kind: string,
    certainty: Certainty,
    detail: string,
  ): void => {
    let ticket = tickets.get(issue.number);
    if (!ticket) {
      ticket = { number: issue.number, title: issue.title, url: issue.url, findings: [] };
      tickets.set(issue.number, ticket);
    }
    ticket.findings.push({ kind, certainty, detail });
  };
  /** Evidence gaps that make the scan itself incomplete, not just one ticket's finding. */
  const gaps: string[] = [];
  const openPrsFor = new Map<string, number[]>();
  for (const pr of snapshot.pullRequests)
    if (pr.state === "OPEN")
      for (const ref of pr.closingIssuesReferences?.nodes ?? [])
        openPrsFor.set(ref.url, [...(openPrsFor.get(ref.url) ?? []), pr.number]);

  for (const issue of open) {
    const labels = issue.labels.nodes.map((l) => l.name);
    const held = owners(issue);
    // With labels on an unseen page, "no such label" is not established: absence-based
    // findings become unknown instead of definite.
    const partial = !!issue.labels.pageInfo?.hasNextPage;
    const absent = (certainty: Certainty): Certainty => (partial ? "unknown" : certainty);
    if (partial) {
      add(
        issue,
        "labels-incomplete",
        "unknown",
        "More than 100 labels; label checks may be incomplete.",
      );
      gaps.push(`${issue.url}: more than 100 labels`);
    }
    const classes = doctorPolicy.classification.filter((l) => labels.includes(l));
    if (!classes.length)
      add(
        issue,
        "classification-missing",
        absent("candidate"),
        `No classification label (${doctorPolicy.classification.join(", ")}).`,
      );
    else if (classes.length > 1)
      add(
        issue,
        "classification-conflict",
        "candidate",
        `More than one classification label: ${classes.join(", ")}.`,
      );
    const readiness = labels.filter((l) => doctorPolicy.readiness.includes(l));
    if (!held.length && !readiness.length)
      add(
        issue,
        "readiness-missing",
        absent("definite"),
        "Unclaimed ticket without a readiness label.",
      );
    if (readiness.length > 1)
      add(
        issue,
        "readiness-conflict",
        "definite",
        `More than one readiness label: ${readiness.join(", ")}.`,
      );
    if (doctorPolicy.urgency.every((l) => labels.includes(l)))
      add(
        issue,
        "urgency-conflict",
        "definite",
        "Both urgency:high and urgency:low; treated as unspecified until corrected.",
      );
    const design = doctorPolicy.designEvidence.filter((l) => labels.includes(l));
    if (labels.includes(workflow.ready) && design.length)
      add(
        issue,
        "design-conflict",
        "definite",
        `Labelled ${workflow.ready} but also ${design.join(", ")}.`,
      );
    if (held.length > 1)
      add(
        issue,
        "multiple-owners",
        "definite",
        `Claimed by more than one agent: ${held.join(", ")}.`,
      );
    const claimedReady = labels.filter((l) => doctorPolicy.claimedReadiness.includes(l));
    if (held.length && claimedReady.length)
      add(
        issue,
        "leftover-readiness",
        "candidate",
        `Claimed (${held.join(", ")}) but still labelled ${claimedReady.join(", ")}: a leftover after claim or handoff.`,
      );
    const prs = openPrsFor.get(issue.url) ?? [];
    if (prs.length && labels.some((l) => doctorPolicy.claimedReadiness.includes(l)))
      add(
        issue,
        "ready-with-open-pr",
        "definite",
        `Open PR ${prs.map((n) => `#${n}`).join(", ")} addresses it, yet it is labelled for pickup; expected ${doctorPolicy.awaitingReview}.`,
      );
    // A handoff to review that no open PR backs: the PR merged or closed, so the awaiting-review
    // state (and any remaining claim) is a leftover to inspect.
    if (!prs.length && labels.includes(doctorPolicy.awaitingReview))
      add(
        issue,
        "awaiting-review-without-pr",
        "candidate",
        `Labelled ${doctorPolicy.awaitingReview}${held.length ? ` and claimed by ${held.join(", ")}` : ""}, but no open PR addresses it; the PR may have merged or closed.`,
      );
    if (
      labels.includes(workflow.blocked) &&
      !labels.some((l) => l.startsWith(workflow.reasonPrefix) && l !== workflow.retiredReason)
    )
      add(
        issue,
        "blocked-without-reason",
        absent("definite"),
        `${workflow.blocked} without a ${workflow.reasonPrefix}* reason.`,
      );
    if (!nativeKnown(issue)) {
      add(
        issue,
        "dependency-evidence-unknown",
        "unknown",
        "Native dependency evidence unavailable; readiness cannot be verified.",
      );
      gaps.push(`${issue.url}: native dependency evidence missing`);
    } else {
      const drift = dependencyDrift(issue, snapshot.repository);
      if (drift.length)
        add(
          issue,
          "dependency-drift",
          "candidate",
          `Body text names ${drift.map((d) => `#${d.number}`).join(", ")} with no native blocked-by edge.`,
        );
    }
    // status:ready with open native blockers is a valid state ("ready when its blockers close",
    // doc/issue-dependencies.md "Label meanings"), so it is deliberately not reported.
  }

  // Native dependency cycles among open tickets (blocked-by direction).
  const byUrl = new Map(open.map((i) => [i.url, i]));
  // Cycle members and claims are open tickets of this snapshot, so the lookup always succeeds.
  const openIssue = (url: string): Issue => {
    const issue = byUrl.get(url);
    if (!issue) throw new Error(`Open ticket ${url} missing from the snapshot.`);
    return issue;
  };
  const edges = new Map(open.map((i) => [i.url, (i.blockedBy?.nodes ?? []).map((b) => b.url)]));
  for (const component of blockerCycles(edges)) {
    const names = component.map((u) => `#${openIssue(u).number}`).join(", ");
    for (const u of component)
      add(
        openIssue(u),
        "dependency-cycle",
        "definite",
        `On a native blocker cycle among ${names}.`,
      );
  }

  // Per-agent claims and staleness reuse the team view with the doctor's own threshold.
  const team = teamView(snapshot, { now, staleHours, offline });
  for (const agent of team.agents) {
    if (agent.claims.length > 1)
      for (const claim of agent.claims)
        add(
          openIssue(claim.url),
          "agent-multiple-claims",
          "definite",
          `${agent.agent} holds ${agent.claims.length} active claims (${agent.claims.map((c) => `#${c.number}`).join(", ")}).`,
        );
    for (const claim of agent.claims) {
      const stale = claim.candidates.find((c) => c.startsWith("stale candidate"));
      if (stale)
        add(
          openIssue(claim.url),
          "stale-agent-activity",
          "candidate",
          `${agent.agent}: ${stale}. Recorded ownership is not presence; nothing is released.`,
        );
      if (!claim.latestActivity)
        add(
          openIssue(claim.url),
          "agent-activity-unknown",
          "unknown",
          `${agent.agent}: no evidenced activity.`,
        );
    }
  }

  const order: Record<Certainty, number> = { definite: 0, candidate: 1, unknown: 2 };
  const all = [...tickets.values()]
    .map((t) => ({
      ...t,
      findings: t.findings.sort((a, b) => order[a.certainty] - order[b.certainty]),
    }))
    .sort(
      (a, b) =>
        order[a.findings[0].certainty] - order[b.findings[0].certainty] || a.number - b.number,
    );
  const count = (k: Certainty): number =>
    all.reduce((n, t) => n + t.findings.filter((f) => f.certainty === k).length, 0);
  const warnings = [...snapshot.warnings, ...gaps];
  return {
    schemaVersion: 1,
    kind: "ticket-doctor",
    repository: snapshot.repository,
    fetchedAt: snapshot.fetchedAt,
    // Same freshness shape as the briefing and team view: offline caches are labelled.
    freshness: team.freshness,
    staleHours,
    scanned: open.length,
    summary: {
      tickets: all.length,
      definite: count("definite"),
      candidate: count("candidate"),
      unknown: count("unknown"),
    },
    tickets: all.slice(0, limit),
    omittedTickets: Math.max(0, all.length - limit),
    completeness: { complete: !warnings.length, warnings },
    guidance:
      "Read-only. Definite findings break a recorded rule; candidates and unknowns need inspection. Nothing is changed; correction suggestions are #67.",
  };
}

/** Text rendering. */
export function ticketDoctorText(r: TicketDoctorReport): string {
  const age = r.freshness.ageSeconds;
  const lines = [
    r.freshness.offline
      ? `Ticket Doctor: ${r.repository} — OFFLINE cache fetched ${r.fetchedAt} (${Math.floor(age / 3600)}h ${Math.floor((age % 3600) / 60)}m old); not verified live; ${r.scanned} open tickets scanned`
      : `Ticket Doctor: ${r.repository} (fetched ${r.fetchedAt}); ${r.scanned} open tickets scanned`,
    `${r.summary.tickets} tickets with findings: ${r.summary.definite} definite, ${r.summary.candidate} candidate, ${r.summary.unknown} unknown`,
    r.guidance,
  ];
  for (const t of r.tickets) {
    lines.push("", `#${t.number} ${t.title} ${t.url}`);
    for (const f of t.findings) lines.push(`  [${f.certainty}] ${f.kind}: ${f.detail}`);
  }
  if (r.configuration) lines.push("", ...complexityConfigText(r.configuration.complexity));
  if (r.omittedTickets)
    lines.push("", `…${r.omittedTickets} more tickets; raise --limit to see them.`);
  for (const w of r.completeness.warnings) lines.push(`INCOMPLETE: ${w}`);
  return lines.join("\n") + "\n";
}
