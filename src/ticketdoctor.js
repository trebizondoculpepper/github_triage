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

/** Ticket Doctor's own staleness default: 24 hours, separate from the briefing's two days. */
export const doctorStaleHours = 24;

/** Label conventions from the merged contracts (registered here, not per check). */
export const doctorPolicy = {
  classification: ["bug", "enhancement", "documentation"],
  readiness: [...workflow.readiness, "status:incomplete", "status:awaiting-review"],
  claimedReadiness: [workflow.ready, "status:incomplete"],
  designEvidence: ["question", "design:decision-needed", "status:needs-design"],
  urgency: ["urgency:high", "urgency:low"],
};

/**
 * @typedef {{ kind: string, certainty: "definite" | "candidate" | "unknown", detail: string }} DoctorFinding
 */

/**
 * @param {import("./types.js").Snapshot} snapshot
 * @param {{ now?: Date, staleHours?: number, limit?: number }} [options]
 */
export function ticketDoctor(
  snapshot,
  { now = new Date(), staleHours = doctorStaleHours, limit = 30 } = {},
) {
  const open = snapshot.issues.filter((i) => i.state === "OPEN");
  /** @type {Map<number, { number: number, title: string, url: string, findings: DoctorFinding[] }>} */
  const tickets = new Map();
  const add = (issue, kind, certainty, detail) => {
    if (!tickets.has(issue.number))
      tickets.set(issue.number, {
        number: issue.number,
        title: issue.title,
        url: issue.url,
        findings: [],
      });
    tickets.get(issue.number).findings.push({ kind, certainty, detail });
  };
  const openPrsFor = new Map();
  for (const pr of snapshot.pullRequests)
    if (pr.state === "OPEN")
      for (const ref of pr.closingIssuesReferences?.nodes ?? [])
        openPrsFor.set(ref.url, [...(openPrsFor.get(ref.url) ?? []), pr.number]);

  for (const issue of open) {
    const labels = issue.labels.nodes.map((l) => l.name);
    const held = owners(issue);
    if (issue.labels.pageInfo?.hasNextPage)
      add(
        issue,
        "labels-incomplete",
        "unknown",
        "More than 100 labels; label checks may be incomplete.",
      );
    if (!doctorPolicy.classification.some((l) => labels.includes(l)))
      add(
        issue,
        "classification-missing",
        "candidate",
        `No classification label (${doctorPolicy.classification.join(", ")}).`,
      );
    const readiness = labels.filter((l) => doctorPolicy.readiness.includes(l));
    if (!held.length && !readiness.length)
      add(issue, "readiness-missing", "definite", "Unclaimed ticket without a readiness label.");
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
        `Open PR ${prs.map((n) => `#${n}`).join(", ")} addresses it, yet it is labelled for pickup; expected status:awaiting-review.`,
      );
    if (
      labels.includes(workflow.blocked) &&
      !labels.some((l) => l.startsWith(workflow.reasonPrefix) && l !== workflow.retiredReason)
    )
      add(
        issue,
        "blocked-without-reason",
        "definite",
        `${workflow.blocked} without a ${workflow.reasonPrefix}* reason.`,
      );
    if (!nativeKnown(issue))
      add(
        issue,
        "dependency-evidence-unknown",
        "unknown",
        "Native dependency evidence unavailable; readiness cannot be verified.",
      );
    else {
      const drift = dependencyDrift(issue, snapshot.repository);
      if (drift.length)
        add(
          issue,
          "dependency-drift",
          "candidate",
          `Body text names ${drift.map((d) => `#${d.number}`).join(", ")} with no native blocked-by edge.`,
        );
    }
  }

  // Native dependency cycles among open tickets (blocked-by direction).
  const byUrl = new Map(open.map((i) => [i.url, i]));
  const reported = new Set();
  const visiting = [];
  const done = new Set();
  const walk = (url) => {
    const at = visiting.indexOf(url);
    if (at >= 0) {
      const cycle = visiting.slice(at);
      const key = [...cycle].sort((a, b) => a.localeCompare(b)).join(" ");
      if (!reported.has(key)) {
        reported.add(key);
        for (const u of cycle)
          add(
            byUrl.get(u),
            "dependency-cycle",
            "definite",
            `Native blocker cycle: ${[...cycle, url].map((x) => `#${byUrl.get(x)?.number}`).join(" → ")}.`,
          );
      }
      return;
    }
    if (done.has(url) || !byUrl.has(url)) return;
    visiting.push(url);
    for (const b of byUrl.get(url).blockedBy?.nodes ?? []) walk(b.url);
    visiting.pop();
    done.add(url);
  };
  for (const url of byUrl.keys()) walk(url);

  // Per-agent claims and staleness reuse the team view with the doctor's own threshold.
  const team = teamView(snapshot, { now, staleHours });
  for (const agent of team.agents) {
    if (agent.claims.length > 1)
      for (const claim of agent.claims)
        add(
          byUrl.get(claim.url),
          "agent-multiple-claims",
          "definite",
          `${agent.agent} holds ${agent.claims.length} active claims (${agent.claims.map((c) => `#${c.number}`).join(", ")}).`,
        );
    for (const claim of agent.claims) {
      const stale = claim.candidates.find((c) => c.startsWith("stale candidate"));
      if (stale)
        add(
          byUrl.get(claim.url),
          "stale-agent-activity",
          "candidate",
          `${agent.agent}: ${stale}. Recorded ownership is not presence; nothing is released.`,
        );
      if (!claim.latestActivity)
        add(
          byUrl.get(claim.url),
          "agent-activity-unknown",
          "unknown",
          `${agent.agent}: no evidenced activity.`,
        );
    }
  }

  const order = { definite: 0, candidate: 1, unknown: 2 };
  const all = [...tickets.values()]
    .map((t) => ({
      ...t,
      findings: t.findings.sort((a, b) => order[a.certainty] - order[b.certainty]),
    }))
    .sort(
      (a, b) =>
        order[a.findings[0].certainty] - order[b.findings[0].certainty] || a.number - b.number,
    );
  const count = (k) =>
    all.reduce((n, t) => n + t.findings.filter((f) => f.certainty === k).length, 0);
  return {
    schemaVersion: 1,
    kind: "ticket-doctor",
    repository: snapshot.repository,
    fetchedAt: snapshot.fetchedAt,
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
    completeness: { complete: !snapshot.warnings.length, warnings: snapshot.warnings },
    guidance:
      "Read-only. Definite findings break a recorded rule; candidates and unknowns need inspection. Nothing is changed; correction suggestions are #67.",
  };
}

/** Text rendering. */
export function ticketDoctorText(r) {
  const lines = [
    `Ticket Doctor: ${r.repository} (fetched ${r.fetchedAt}); ${r.scanned} open tickets scanned`,
    `${r.summary.tickets} tickets with findings: ${r.summary.definite} definite, ${r.summary.candidate} candidate, ${r.summary.unknown} unknown`,
    r.guidance,
  ];
  for (const t of r.tickets) {
    lines.push("", `#${t.number} ${t.title} ${t.url}`);
    for (const f of t.findings) lines.push(`  [${f.certainty}] ${f.kind}: ${f.detail}`);
  }
  if (r.omittedTickets) lines.push("", `…${r.omittedTickets} more tickets; use --limit or --json.`);
  for (const w of r.completeness.warnings) lines.push(`INCOMPLETE: ${w}`);
  return lines.join("\n") + "\n";
}
