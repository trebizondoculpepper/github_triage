/**
 * Ticket Doctor v1 (#66): a read-only consistency scan of every open ticket.
 * Contract: doc/design/diagnostics.md, "#66: Ticket Doctor v1".
 *
 * Cheap structured checks only, grouped by ticket and labelled definite, candidate or
 * unknown. It never changes anything and never reclaims. v2 (#67) attaches a deterministic
 * correction plan to every finding (src/doctorplans.ts): suggestions, never execution.
 */
import { owners, workflow } from "./briefing.js";
import { dependencyDrift, nativeKnown } from "./dependencies.js";
import { teamView } from "./team.js";
import { complexityLabelFindings, metricLabelFindings } from "./complexitylabels.js";
import { impactMetric } from "./metrics.js";
import { closingPrEvidence } from "./ranking.js";
import type { Issue, PullRequest, Snapshot } from "./types.js";
import type { DeliveryDiagnosis, IssueDeliveryDiagnosis } from "./deliverydoctor.js";

/**
 * Whether a PR's contribution is evidently finished: out of draft, checks passing, no open or
 * unseen review threads, no changes requested. Missing evidence is not finished.
 */
export function contributionFinished(pr: PullRequest): boolean {
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const threads = pr.reviewThreads;
  return (
    !pr.isDraft &&
    rollup?.state === "SUCCESS" &&
    !!threads &&
    !threads.pageInfo?.hasNextPage &&
    threads.nodes.every((t) => t.isResolved) &&
    !workflow.changesRequested.includes(pr.reviewDecision ?? "")
  );
}
import { planCommands } from "./doctorplans.js";
import type { CorrectionPlan, CorrectionStep } from "./doctorplans.js";

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
  /** #67: suggested correction; unknown findings only ever get inspection steps. */
  plan: CorrectionPlan;
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
  /**
   * `impact.enabled` (#245): false suppresses impact findings; labels are never touched. Default
   * true, including when configuration could not be read (findings only suggest, never apply).
   */
  impactEnabled?: boolean;
  /**
   * #192: delivery facts from `diagnoseDelivery`. Absent leaves every finding as before; present,
   * trusted delivery records supersede the two label-only review checks for that ticket.
   */
  delivery?: DeliveryDiagnosis;
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

/** One deterministic blocked-by cycle from `start` back to itself, within `members` (BFS). */
export function cyclePath(
  start: string,
  edges: Map<string, string[]>,
  members: Set<string>,
): string[] {
  const previous = new Map<string, string>();
  const queue = [start];
  while (queue.length) {
    const v = queue.shift() as string;
    for (const w of [...(edges.get(v) ?? [])].sort((a, b) => a.localeCompare(b))) {
      if (!members.has(w)) continue;
      if (w === start) {
        const path = [v];
        while (path[0] !== start) path.unshift(previous.get(path[0]) as string);
        return [...path, start];
      }
      if (!previous.has(w)) {
        previous.set(w, v);
        queue.push(w);
      }
    }
  }
  return [start];
}

type AddFinding = (
  issue: Pick<Issue, "number" | "title" | "url">,
  kind: string,
  certainty: Certainty,
  detail: string,
  steps?: CorrectionStep[],
  extra?: { judgment?: boolean; facts?: string[] },
) => void;

const prLabel = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
const prLink = (label: string): string | null => {
  const m = label.match(prLabel);
  return m ? `https://github.com/${m[1]}/pull/${m[2]}` : null;
};

/**
 * #192: delivery-aware findings for one ticket from `diagnoseDelivery`. Read-only suggestions;
 * an unknown fold or evaluation only ever yields inspection, never a mutation or a negative.
 */
function deliveryFindings(
  issue: Issue,
  d: IssueDeliveryDiagnosis,
  claimants: string[],
  add: AddFinding,
  cmd: ReturnType<typeof planCommands>,
  repository: string,
): void {
  const n = issue.number;
  const claimFact = claimants.length
    ? [
        `Active claim held by ${claimants.join(", ")}; a claim and delivery responsibility are distinct.`,
      ]
    : [];
  if (d.fold === "unread") {
    add(
      issue,
      "delivery-evidence-unknown",
      "unknown",
      "Delivery or release records are present but were not verified; delivery and responsibility are unknown, not absent.",
      [cmd.inspectIssue(n)],
      { facts: d.unknownBecause },
    );
    return;
  }
  for (const t of d.staleTransfers) {
    const scope = t.scope === "ticket" ? "ticket" : `deliverable ${t.deliverable ?? "(unknown)"}`;
    const facts = [
      `Rejected record ${t.comment}${t.url ? ` ${t.url}` : ""}: ${t.sender} -> ${t.recipient} (${scope}), expected predecessor ${t.expected ?? "none"}.`,
      `Effective record ${t.effective ?? "none"}${t.effectiveUrl ? ` ${t.effectiveUrl}` : ""}; effective responsible ${t.effectiveHolder ?? "nobody"}.`,
      ...claimFact,
    ];
    // Recovery is addressed to whoever is responsible after the whole fold, never the holder at
    // rejection time; an unknown final fold names nobody, so only inspection is offered.
    const known = d.fold === "known";
    const holder = known ? t.current : null;
    facts.push(
      known
        ? `Currently responsible after all records: ${holder ?? "nobody"}.`
        : "Current responsibility is unknown: a later record could not be read or trusted.",
    );
    add(
      issue,
      "handoff-stale",
      known ? "candidate" : "unknown",
      `Handoff ${t.sender} -> ${t.recipient} (${scope}) was rejected HANDOFF_STALE; ${known ? `${holder ?? "nobody"} is responsible now` : "current responsibility is unknown"}. Nothing is transferred automatically.`,
      [
        cmd.inspectIssue(n),
        cmd.deliveryDryRun(n, holder ?? t.effectiveHolder ?? t.sender),
        ...(holder
          ? [
              cmd.deliveryHandoff(
                n,
                holder,
                t.scope === "deliverable" && t.deliverable ? prLink(t.deliverable) : null,
                `fresh-handoff-${t.comment}`,
              ),
            ]
          : []),
      ],
      { judgment: true, facts },
    );
  }
  if (d.unverifiableTransfers.length)
    add(
      issue,
      "handoff-unverifiable",
      "unknown",
      `Handoff ${d.unverifiableTransfers.map((t) => t.comment).join(", ")} cannot be validated because an earlier record is unknown; it is neither applied nor stale.`,
      [cmd.inspectIssue(n)],
      {
        facts: d.unverifiableTransfers.map(
          (t) => `Record ${t.comment}${t.url ? ` ${t.url}` : ""}.`,
        ),
      },
    );
  if (d.fold === "unknown") {
    add(
      issue,
      "delivery-records-unknown",
      "unknown",
      "Delivery records could not all be read or trusted; delivery and responsibility are unknown, not absent.",
      [cmd.inspectIssue(n)],
      { facts: d.unknownBecause },
    );
    return;
  }
  if (d.legacy?.status === "unknown")
    add(
      issue,
      "legacy-release-unverified",
      "unknown",
      "A v1 done release record exists but its author's authority could not be verified.",
      [cmd.inspectIssue(n)],
      { facts: d.legacy.unverified },
    );
  if (d.legacy?.status === "trusted") {
    const facts = [
      `Release record ${d.legacy.release ?? "(no link)"}${d.legacy.agent ? ` by ${d.legacy.agent}` : ""}.`,
      ...(d.legacy.candidates.length
        ? [`Candidates (not membership): ${d.legacy.candidates.map((c) => c.value).join(", ")}.`]
        : ["No candidate deliverable is named; supply the PR URL or commit yourself."]),
      ...claimFact,
    ];
    add(
      issue,
      "legacy-delivery",
      "candidate",
      "Only a legacy v1 done handoff exists: membership is unknown and never inferred. Record the required deliverables, or attest a non-code outcome.",
      [
        cmd.inspectIssue(n),
        ...(d.legacy.candidates.length
          ? d.legacy.candidates.map((c, i) =>
              cmd.legacyAttach(
                n,
                c.flag,
                c.value,
                d.legacy!.candidates.length > 1 ? `attach-${i + 1}` : "attach",
              ),
            )
          : [cmd.legacyAttach(n, "--pr", "<PR_URL>", "attach")]),
        cmd.legacyAttest(n),
      ],
      { judgment: true, facts },
    );
    return;
  }
  if (!d.trustedRecord) return;
  const responsible = d.ticketResponsible;
  const facts = [
    `Ticket responsible: ${responsible ?? "nobody (after a reset or effective completion)"}.`,
    ...d.members.map((m) => `${m.deliverable}: responsible ${m.responsible ?? "nobody"}.`),
    ...claimFact,
  ];
  const inspect = cmd.deliveryDryRun(n, responsible ?? "<AGENT>");
  if (!d.evaluation) {
    add(
      issue,
      "delivery-not-evaluated",
      "unknown",
      `Delivery was not evaluated: ${d.notEvaluated ?? "no live evidence"}.`,
      [inspect],
      { facts },
    );
    return;
  }
  const e = d.evaluation;
  const lines = e.perDeliverable.map(
    (m) => `${m.deliverable} -> ${m.target}: ${m.state} (${m.why}).`,
  );
  if (e.delivery === "unknown") {
    add(
      issue,
      "delivery-unknown",
      "unknown",
      "Delivery cannot be verified: some evidence is unknown (never read as not delivered).",
      [inspect],
      { facts: [...facts, ...e.because, ...lines] },
    );
    return;
  }
  if (e.delivery === "delivered" || e.delivery === "attested") {
    add(
      issue,
      "delivery-verified-open",
      "candidate",
      `Delivery is ${e.delivery} but the issue is still open${responsible ? `; ${responsible} may record completion` : "; no agent is responsible"}.`,
      [
        inspect,
        ...(responsible
          ? [
              cmd.complete(
                n,
                responsible,
                `${responsible} records verified completion and closes #${n}.`,
              ),
            ]
          : []),
      ],
      { facts: [...facts, ...e.because, ...e.overrides, ...lines] },
    );
    return;
  }
  const stalled = e.perDeliverable.filter(
    (m) => m.state === "closed-unmerged" || m.state === "merged-off-target",
  );
  const prSteps = (states: typeof e.perDeliverable) =>
    states.flatMap((m) => {
      // `pr N` reads this repository only; another repository's member is in the facts.
      const match = m.deliverable.match(prLabel);
      return match && match[1].toLowerCase() === repository.toLowerCase()
        ? [cmd.pr(Number(match[2]))]
        : [];
    });
  if (e.delivery === "partial" || stalled.length) {
    const outstanding = e.perDeliverable.filter((m) => m.state !== "merged");
    add(
      issue,
      stalled.length ? "delivery-member-stalled" : "delivery-partial",
      "candidate",
      stalled.length
        ? `Required ${stalled.map((m) => `${m.deliverable} is ${m.state}`).join("; ")}: it cannot deliver as recorded. ${responsible ?? "The responsible agent"} decides whether to reopen, replace, retarget or detach it.`
        : `Partly delivered: ${outstanding.map((m) => `${m.deliverable} is ${m.state}`).join("; ")}. Responsibility continues until every required member merges into its target.`,
      [inspect, ...prSteps(stalled.length ? stalled : outstanding)],
      { judgment: !!stalled.length, facts: [...facts, ...lines] },
    );
    return;
  }
  if (e.delivery === "none")
    add(
      issue,
      "delivery-empty",
      "candidate",
      `Trusted records leave no required deliverable and no applicable attestation; ${responsible ?? "nobody"} remains responsible for attaching, attesting or handing back.`,
      [inspect],
      { facts: [...facts, ...e.because] },
    );
  // `submitted` with every member open or draft is waiting on review or CI: not a finding.
}

export function ticketDoctor(
  snapshot: Snapshot,
  {
    now = new Date(),
    staleHours = doctorStaleHours,
    limit = 30,
    offline = false,
    impactEnabled = true,
    delivery,
  }: TicketDoctorOptions = {},
): TicketDoctorReport {
  const open = snapshot.issues.filter((i) => i.state === "OPEN");
  const tickets = new Map<number, DoctorTicket>();
  const cmd = planCommands(snapshot.repository);
  const add = (
    issue: Pick<Issue, "number" | "title" | "url">,
    kind: string,
    certainty: Certainty,
    detail: string,
    steps: CorrectionStep[] = [],
    { judgment = false, facts = [] }: { judgment?: boolean; facts?: string[] } = {},
  ): void => {
    let ticket = tickets.get(issue.number);
    if (!ticket) {
      ticket = { number: issue.number, title: issue.title, url: issue.url, findings: [] };
      tickets.set(issue.number, ticket);
    }
    // Unknown evidence is never grounds for a mutation: inspection only, whatever was offered.
    const inspection = steps.filter((x) => x.kind === "inspect");
    const plan: CorrectionPlan =
      certainty === "unknown"
        ? {
            judgment: false,
            facts,
            steps: inspection.length ? inspection : [cmd.inspectIssue(issue.number)],
          }
        : { judgment, facts, steps: steps.length ? steps : [cmd.inspectIssue(issue.number)] };
    ticket.findings.push({ kind, certainty, detail, plan });
  };
  /** Evidence gaps that make the scan itself incomplete, not just one ticket's finding. */
  const gaps: string[] = [];
  const openPrsFor = new Map<string, { number: number; url: string; finished: boolean }[]>();
  // "No open PR" rests on the shared closing-link rule (closingPrEvidence): an open PR whose
  // linked-issue page is truncated may address any ticket unless its reverse link proves not.
  for (const pr of snapshot.pullRequests)
    if (pr.state === "OPEN") {
      for (const ref of pr.closingIssuesReferences?.nodes ?? [])
        openPrsFor.set(ref.url, [
          ...(openPrsFor.get(ref.url) ?? []),
          { number: pr.number, url: pr.url, finished: contributionFinished(pr) },
        ]);
    }

  for (const issue of open) {
    const labels = issue.labels.nodes.map((l) => l.name);
    const held = owners(issue);
    /** Claimant agent names (labels minus the agent: prefix), for claimant-only commands. */
    const agents = held.map((l) => l.slice(workflow.ownerPrefix.length));
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
        [cmd.inspectIssue(issue.number)],
      );
      gaps.push(`${issue.url}: more than 100 labels`);
    }
    // Shared label classifier (#152): conflicting size labels are an inspection finding, never
    // repaired here; unestimated tickets are not findings, and truncated labels are reported above.
    // #178: invalid `complexity:*` labels get a judgment plan with registered suggestions only.
    for (const finding of complexityLabelFindings(issue))
      if (finding.kind === "complexity-label-conflict")
        add(
          issue,
          finding.kind,
          finding.certainty,
          `Conflicting complexity: ${finding.detail}.`,
          [cmd.inspectIssue(issue.number), cmd.estimate(issue.number)],
          { judgment: true },
        );
      else if (finding.kind === "complexity-label-invalid")
        add(
          issue,
          finding.kind,
          finding.certainty,
          `Invalid complexity label: ${finding.detail}.`,
          [
            cmd.inspectIssue(issue.number),
            cmd.estimateReplaceInvalid(issue.number, finding.invalid ?? []),
          ],
          {
            judgment: true,
            facts: (finding.suggestions ?? []).map((s) =>
              s.size
                ? `Suggestion only (never applied): ${s.label} probably means ${s.size}; confirm against the ticket.`
                : `No suggestion for ${s.label}: read the ticket and choose a size.`,
            ),
          },
        );
    // #245: the same descriptor-parameterised findings for impact labels. Suggestions only
    // (including impact's low -> S and high -> L); unassessed tickets are never findings.
    if (impactEnabled)
      for (const finding of metricLabelFindings(impactMetric, issue))
        if (finding.kind === "impact-label-conflict")
          add(
            issue,
            finding.kind,
            finding.certainty,
            `Conflicting impact: ${finding.detail}.`,
            [cmd.inspectIssue(issue.number), cmd.estimate(issue.number, "impact")],
            { judgment: true },
          );
        else if (finding.kind === "impact-label-invalid")
          add(
            issue,
            finding.kind,
            finding.certainty,
            `Invalid impact label: ${finding.detail}.`,
            [
              cmd.inspectIssue(issue.number),
              cmd.estimateReplaceInvalid(issue.number, finding.invalid ?? [], "impact"),
            ],
            {
              judgment: true,
              facts: (finding.suggestions ?? []).map((s) =>
                s.size
                  ? `Suggestion only (never applied): ${s.label} probably means ${s.size}; confirm against the ticket.`
                  : `No suggestion for ${s.label}: read the ticket and choose a size.`,
              ),
            },
          );
        else
          add(issue, finding.kind, finding.certainty, `Impact labels: ${finding.detail}.`, [
            cmd.inspectIssue(issue.number),
          ]);
    const classes = doctorPolicy.classification.filter((l) => labels.includes(l));
    if (!classes.length)
      add(
        issue,
        "classification-missing",
        absent("candidate"),
        `No classification label (${doctorPolicy.classification.join(", ")}).`,
        doctorPolicy.classification.map((l) =>
          cmd.labels(issue.number, [l], [], `Classify #${issue.number} as ${l}.`, { choice: l }),
        ),
        { judgment: true },
      );
    else if (classes.length > 1)
      add(
        issue,
        "classification-conflict",
        "candidate",
        `More than one classification label: ${classes.join(", ")}.`,
        classes.map((keep) =>
          cmd.labels(
            issue.number,
            [],
            classes.filter((l) => l !== keep),
            `Keep ${keep} only.`,
            { choice: `keep-${keep}` },
          ),
        ),
        { judgment: true },
      );
    const readiness = labels.filter((l) => doctorPolicy.readiness.includes(l));
    if (!held.length && !readiness.length)
      add(
        issue,
        "readiness-missing",
        absent("definite"),
        "Unclaimed ticket without a readiness label.",
        [
          cmd.inspectIssue(issue.number),
          ...[workflow.ready, "status:incomplete", "status:needs-design"].map((l) =>
            cmd.labels(issue.number, [l], [], `Mark #${issue.number} ${l}.`, { choice: l }),
          ),
        ],
        { judgment: true },
      );
    if (readiness.length > 1)
      add(
        issue,
        "readiness-conflict",
        "definite",
        `More than one readiness label: ${readiness.join(", ")}.`,
        readiness.map((keep) =>
          cmd.labels(
            issue.number,
            [],
            readiness.filter((l) => l !== keep),
            `Keep ${keep} only.`,
            { choice: `keep-${keep}` },
          ),
        ),
        { judgment: true },
      );
    if (doctorPolicy.urgency.every((l) => labels.includes(l)))
      add(
        issue,
        "urgency-conflict",
        "definite",
        "Both urgency:high and urgency:low; treated as unspecified until corrected.",
        [
          cmd.labels(issue.number, [], ["urgency:low"], "Keep urgency:high.", {
            choice: "keep-high",
          }),
          cmd.labels(issue.number, [], ["urgency:high"], "Keep urgency:low.", {
            choice: "keep-low",
          }),
          cmd.labels(issue.number, [], doctorPolicy.urgency, "Remove both (unspecified).", {
            choice: "remove-both",
          }),
        ],
        { judgment: true },
      );
    const design = doctorPolicy.designEvidence.filter((l) => labels.includes(l));
    if (labels.includes(workflow.ready) && design.length)
      add(
        issue,
        "design-conflict",
        "definite",
        `Labelled ${workflow.ready} but also ${design.join(", ")}.`,
        [
          cmd.inspectIssue(issue.number),
          cmd.labels(
            issue.number,
            [],
            [workflow.ready],
            "The design question is open: withdraw it from pickup.",
            { choice: "not-ready" },
          ),
          cmd.labels(
            issue.number,
            [],
            design,
            "The design question is settled on the ticket: clear the design labels.",
            {
              choice: "design-settled",
              preconditions: ["The decision is recorded on the ticket."],
            },
          ),
        ],
        { judgment: true },
      );
    if (held.length > 1)
      add(
        issue,
        "multiple-owners",
        "definite",
        `Claimed by more than one agent: ${held.join(", ")}.`,
        [
          cmd.who(issue.number),
          ...agents.map((agent) =>
            cmd.release(
              issue.number,
              agent,
              "ready",
              `If ${agent} is not the one doing the work, ${agent} hands it back.`,
              { choice: `${agent}-releases` },
            ),
          ),
        ],
        { judgment: true },
      );
    const claimedReady = labels.filter((l) => doctorPolicy.claimedReadiness.includes(l));
    if (held.length && claimedReady.length)
      add(
        issue,
        "leftover-readiness",
        "candidate",
        `Claimed (${held.join(", ")}) but still labelled ${claimedReady.join(", ")}: a leftover after claim or handoff.`,
        [
          cmd.who(issue.number),
          // With labels on an unseen page another claimant may exist: inspect, do not act.
          ...(held.length === 1 && !partial
            ? [
                cmd.labels(
                  issue.number,
                  [],
                  claimedReady,
                  `${agents[0]} keeps the claim: remove the pickup label.`,
                  { choice: "keep-claim", runBy: `agent ${agents[0]} only (the claimant)` },
                ),
                cmd.release(
                  issue.number,
                  agents[0],
                  "ready",
                  `${agents[0]} is no longer working on it: hand it back.`,
                  { choice: "release" },
                ),
              ]
            : []),
        ],
        { judgment: true },
      );
    const diagnosis = delivery?.issues.get(issue.number);
    // #192: trusted delivery records (or a trusted legacy v1 handoff) supersede the label-only
    // review checks below; an unknown fold never does, so those checks still run.
    const superseded =
      diagnosis?.fold === "known" &&
      (diagnosis.trustedRecord || diagnosis.legacy?.status === "trusted");
    if (diagnosis) deliveryFindings(issue, diagnosis, agents, add, cmd, snapshot.repository);
    const prs = superseded ? [] : (openPrsFor.get(issue.url) ?? []);
    const pickup = labels.filter((l) => doctorPolicy.claimedReadiness.includes(l));
    // Whether every linked PR is evidently finished (not draft, checks green, no open threads).
    const finished = prs.length > 0 && prs.every((p) => p.finished);
    if (prs.length && pickup.length)
      add(
        issue,
        "ready-with-open-pr",
        // Ownership rests on the absence of agent labels, unknown when labels are truncated.
        absent("definite"),
        `Open PR ${prs.map((p) => `#${p.number}`).join(", ")} addresses it, yet it is labelled for pickup; expected ${doctorPolicy.awaitingReview}.`,
        [
          cmd.who(issue.number),
          cmd.inspectIssue(issue.number),
          ...prs.map((p) => cmd.pr(p.number)),
          ...(held.length === 1
            ? [
                // The outcome is the claimant's choice (release never chooses for them), so
                // keeping the claim is always offered alongside the done handoff.
                cmd.labels(
                  issue.number,
                  [],
                  pickup,
                  `${agents[0]} keeps the claim${finished ? "" : " while the PR is unfinished"}: remove the leftover pickup label.`,
                  { choice: "keep-claim", runBy: `agent ${agents[0]} only (the claimant)` },
                ),
                ...prs.map((p) => {
                  const step = cmd.release(
                    issue.number,
                    agents[0],
                    "done",
                    `${agents[0]} hands over to review with PR #${p.number}.`,
                    { pr: p.url, choice: prs.length > 1 ? `done-pr-${p.number}` : "done" },
                  );
                  if (!p.finished)
                    step.preconditions.push(
                      `Only once PR #${p.number} is finished: out of draft, checks passing, review threads resolved.`,
                    );
                  return step;
                }),
              ]
            : held.length
              ? []
              : [
                  cmd.labels(
                    issue.number,
                    [doctorPolicy.awaitingReview],
                    pickup,
                    `Mark #${issue.number} ${doctorPolicy.awaitingReview}.`,
                  ),
                ]),
        ],
        // A claimant's handoff outcome is always their decision; only the unclaimed fix is mechanical.
        { judgment: prs.length > 1 || held.length > 0 },
      );
    // A handoff to review that no open PR backs: the PR merged or closed, so the awaiting-review
    // state (and any remaining claim) is a leftover to inspect.
    const closing = closingPrEvidence(issue, snapshot.pullRequests);
    if (!superseded && !closing.open.length && labels.includes(doctorPolicy.awaitingReview))
      add(
        issue,
        "awaiting-review-without-pr",
        // Rests on the absence of an open PR, unknown when a PR's linked issues are truncated.
        closing.complete ? "candidate" : "unknown",
        `Labelled ${doctorPolicy.awaitingReview}${held.length ? ` and claimed by ${held.join(", ")}` : ""}, but no open PR addresses it; the PR may have merged or closed.`,
        [
          cmd.who(issue.number),
          cmd.inspectIssue(issue.number),
          // The claimant decides; the ticket is never closed by a suggestion.
          ...agents.flatMap((agent) => [
            cmd.release(
              issue.number,
              agent,
              "done",
              `The PR merged: ${agent} releases the leftover claim (the ticket stays open for inspection).`,
              { choice: `${agent}-merged` },
            ),
            cmd.release(
              issue.number,
              agent,
              "incomplete",
              `The PR closed unmerged: ${agent} hands the remaining work back.`,
              { choice: `${agent}-closed` },
            ),
          ]),
        ],
        { judgment: true },
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
        [
          cmd.deps(issue.number),
          cmd.needsHuman(issue.number),
          cmd.labels(
            issue.number,
            ["<REASON_LABEL>"],
            [],
            `Record the existing ${workflow.reasonPrefix}* reason label.`,
            { choice: "reason-label" },
          ),
        ],
        { judgment: true },
      );
    if (!nativeKnown(issue)) {
      add(
        issue,
        "dependency-evidence-unknown",
        "unknown",
        "Native dependency evidence unavailable; readiness cannot be verified.",
        [cmd.deps(issue.number)],
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
          [
            cmd.deps(issue.number),
            ...drift
              .filter(
                (d) => d.url === `https://github.com/${snapshot.repository}/issues/${d.number}`,
              )
              .map((d) =>
                cmd.depsChange(
                  "add",
                  issue.number,
                  d.number,
                  `The body is right: record #${issue.number} blocked by #${d.number}.`,
                  `add-${d.number}`,
                ),
              ),
            cmd.inspectIssue(issue.number),
          ],
          { judgment: true },
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
    const members = new Set(component);
    for (const u of component) {
      const n = openIssue(u).number;
      const path = cyclePath(u, edges, members).map((x) => `#${openIssue(x).number}`);
      // Each of this ticket's own edges inside the cycle is one possible removal; none is chosen.
      const inCycle = [...new Set((edges.get(u) ?? []).filter((b) => members.has(b)))]
        .map((b) => openIssue(b).number)
        .sort((a, b) => a - b);
      add(
        openIssue(u),
        "dependency-cycle",
        "definite",
        `On a native blocker cycle among ${names}.`,
        [
          cmd.deps(n, true),
          ...inCycle.map((b) =>
            cmd.depsChange(
              "remove",
              n,
              b,
              `If #${n} does not really wait for #${b}, remove that edge.`,
              `remove-${n}-on-${b}`,
            ),
          ),
        ],
        { judgment: true, facts: [`Path (blocked by): ${path.join(" -> ")}`] },
      );
    }
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
          [
            cmd.team(),
            ...(["ready", "incomplete", "done"] as const).map((outcome) =>
              cmd.release(
                claim.number,
                agent.agent,
                outcome,
                `${agent.agent}'s disposition for #${claim.number}: release as ${outcome}${outcome === "done" ? " (add --pr URL when a PR exists)" : ""}; keep the one claim being worked on.`,
              ),
            ),
          ],
          { judgment: true },
        );
    for (const claim of agent.claims) {
      const stale = claim.candidates.find((c) => c.startsWith("stale candidate"));
      if (stale)
        add(
          openIssue(claim.url),
          "stale-agent-activity",
          "candidate",
          `${agent.agent}: ${stale}. Recorded ownership is not presence; nothing is released.`,
          [
            cmd.who(claim.number),
            ...(["ready", "incomplete"] as const).map((outcome) =>
              cmd.release(
                claim.number,
                agent.agent,
                outcome,
                `${agent.agent} has stopped: hand it back as ${outcome}.`,
              ),
            ),
          ],
          {
            judgment: true,
            facts: [
              claim.latestActivity
                ? `Last activity ${claim.latestActivity.at} (${claim.latestActivity.source}).`
                : "Last activity unknown.",
            ],
          },
        );
      if (!claim.latestActivity)
        add(
          openIssue(claim.url),
          "agent-activity-unknown",
          "unknown",
          `${agent.agent}: no evidenced activity.`,
          [cmd.who(claim.number)],
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
  const warnings = [...snapshot.warnings, ...gaps, ...(delivery?.warnings ?? [])];
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
      "Read-only. Definite findings break a recorded rule; candidates and unknowns need inspection. Suggested commands are never run; choices marked judgment need a decision, <PLACEHOLDERS> need filling, and claim commands are only for the claimant.",
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
    for (const f of t.findings) {
      lines.push(`  [${f.certainty}] ${f.kind}: ${f.detail}`);
      for (const fact of f.plan.facts) lines.push(`    fact: ${fact}`);
      if (f.plan.judgment) lines.push("    judgment required; alternatives:");
      for (const s of f.plan.steps) {
        const label = `${s.kind}${s.choice ? ` ${s.choice}` : ""}${s.runBy ? ` [${s.runBy}]` : ""}`;
        lines.push(`    ${label}: ${s.description}`);
        // Preconditions are not enforced by the command itself, so text users must see them.
        for (const pre of s.preconditions) lines.push(`      only if: ${pre}`);
        lines.push(`      $ ${s.command}`);
      }
    }
  }
  if (r.omittedTickets)
    lines.push("", `…${r.omittedTickets} more tickets; raise --limit to see them.`);
  for (const w of r.completeness.warnings) lines.push(`INCOMPLETE: ${w}`);
  return lines.join("\n") + "\n";
}
