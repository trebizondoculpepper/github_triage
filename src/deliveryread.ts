/**
 * Delivery, responsibility and closure for the shared read surfaces (#192): briefing JSON and the
 * MCP read tools (one service, so they agree), `who`, `team` and `pr`.
 * Contract: doc/design/delivery-lifecycle.md ("State axes", "Closure (reported, never
 * inferred)", "Source compatibility and migration": additive `delivery`, `responsibility` and
 * `closure` fields within the current schemaVersion; "#192 diagnostics and reads").
 *
 * Pure presentation of `diagnoseDelivery` (the shared fold, handoff replay, collector and
 * evaluator) plus the PR evidence the snapshot already holds. Unknown evidence stays unknown:
 * an unread or unverifiable record is never "no responsibility" and an unevaluated ticket is
 * never "not delivered". Read-only: `next` lists supported commands, never runs them.
 */
import { closureOf, diagnoseDelivery } from "./deliverydoctor.js";
import { deliveryCommentFields, readDeliveryComments } from "./deliverables.js";
import type { TrustDecision } from "./delivery.js";
import type { Query, Rest } from "./github/github.js";
import type { Closure, DeliveryDiagnosis, IssueDeliveryDiagnosis } from "./deliverydoctor.js";
import type { MemberState, TicketDelivery } from "./completion.js";
import type { Issue, PullRequest, Snapshot } from "./github/types.js";
import { prChecks, workflow } from "./briefing.js";
import type { PrStatusReport } from "./prstatus.js";
import { headAccepted, headReviewed } from "./reviewevidence.js";

/**
 * Follow-up for one required deliverable: `waiting` on checks or review (attention released,
 * responsibility kept), `actionable` for the responsible agent, `none` once merged into its
 * target, `unknown` when the evidence cannot say.
 */
export type FollowUp = "none" | "waiting" | "actionable" | "unknown";

export interface DeliverableView {
  deliverable: string;
  url: string | null;
  target: string;
  /** Live member state, or `not-evaluated` when delivery was not evaluated on this read. */
  state: MemberState | "not-evaluated";
  why: string;
  responsible: string | null;
  followUp: FollowUp;
  followUpWhy: string;
}
export interface DeliveryView {
  number: number;
  url: string;
  closure: Closure;
  /** `known` folded completely; `unknown` some record unreadable/unverifiable; `unread` offline. */
  records: "known" | "unknown" | "unread";
  /** The evaluator's verdict; `not-evaluated` when live evidence was not read on this request. */
  delivery: TicketDelivery | "not-evaluated";
  because: string[];
  /** Null when the records are not known: responsibility is then unknown, never "nobody". */
  responsibility: {
    ticket: string | null;
    since: string | null;
    members: { deliverable: string; responsible: string | null }[];
  } | null;
  deliverables: DeliverableView[];
  /** Supported read-only inspection commands (never run). */
  next: string[];
}
export interface DeliveryRead {
  /** Tickets in scope: those with a delivery or v1 release record, or unreadable history. */
  tickets: DeliveryView[];
  complete: boolean;
  omissions: string[];
  guidance: string;
}

const prLabel = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
/**
 * Structured follow-up facts for one open PR's current head, from either a snapshot PR or a
 * `pr N` status report, so every read surface classifies the same evidence the same way.
 */
export interface FollowUpFacts {
  draft: boolean;
  /** All check, thread and review evidence for the head was read. */
  complete: boolean;
  failing: boolean;
  pending: boolean;
  /** A check outcome outside the known pass/failure/unfinished sets. */
  unknownChecks: boolean;
  /** The repository's verify check passed on the head. */
  verified: boolean;
  changesRequested: boolean;
  unresolvedThreads: boolean;
  mergeable: string;
  mergeState: string;
  /** #341 acceptance: approval or a clean Codex receipt bound to the current head, no veto. */
  headReviewed: boolean;
}

/**
 * Follow-up from current-head evidence, mirroring the briefing's PR rules (#182/#341:
 * `pr-failed-checks`, `pr-review`, `pr-conflicts`, `pr-pending`, `pr-integrate`,
 * `pr-inspect-merge`). Only positive evidence decides; anything missing is unknown.
 */
export function classifyFollowUp(f: FollowUpFacts): [FollowUp, string] {
  if (f.draft) return ["actionable", "draft: the responsible agent finishes it"];
  if (!f.complete) return ["unknown", "check, thread or review evidence is incomplete"];
  if (f.failing) return ["actionable", "failing checks on the current head"];
  if (f.changesRequested) return ["actionable", "changes requested"];
  if (f.unresolvedThreads) return ["actionable", "unresolved review threads"];
  if (workflow.conflicts.includes(f.mergeable)) return ["actionable", "merge conflict"];
  if (f.pending) return ["waiting", "awaiting checks"];
  if (f.unknownChecks || !f.verified)
    return ["unknown", "the verify check is missing or has an unrecognised outcome"];
  if (f.mergeState === "BEHIND")
    return [
      "actionable",
      f.headReviewed
        ? "accepted on the current head but behind its base: update the branch (integrate)"
        : "behind its base: update the branch",
    ];
  if (f.headReviewed) {
    if (
      workflow.unknownMergeable.includes(f.mergeable) ||
      workflow.refreshMergeStates.includes(f.mergeState)
    )
      return ["actionable", "accepted on the current head: refresh mergeability (integrate)"];
    if (workflow.currentMergeStates.includes(f.mergeState))
      return [
        "actionable",
        "accepted on the current head but not merged: inspect, then consider merge",
      ];
    return [
      "actionable",
      `accepted on the current head but merge state is ${f.mergeState}: inspect the branch rules`,
    ];
  }
  // As the briefing's clean-pr rule: a clean merge state is follow-up even before head review.
  if (
    workflow.mergeable.includes(f.mergeable) &&
    workflow.currentMergeStates.includes(f.mergeState)
  )
    return ["actionable", "clean merge state: inspect the current head, then consider merge"];
  return ["waiting", "awaiting current-head review"];
}

/** Facts from a PR as the snapshot collects it. */
export function snapshotFollowUpFacts(pr: PullRequest, warnings: string[]): FollowUpFacts {
  const checks = prChecks(pr);
  const known = [...workflow.pass, ...workflow.failure, ...workflow.unfinished];
  return {
    draft: !!pr.isDraft,
    complete:
      !warnings.some((w) => w.startsWith(pr.url)) &&
      !!pr.reviewThreads &&
      !pr.reviewThreads.pageInfo?.hasNextPage,
    failing: checks.some((c) => workflow.failure.includes(c.outcome)),
    pending: checks.some((c) => workflow.unfinished.includes(c.outcome)),
    unknownChecks: checks.some((c) => !known.includes(c.outcome)),
    verified: checks.some(
      (c) => c.name === workflow.verify && workflow.verifySuccess.includes(c.outcome),
    ),
    changesRequested: workflow.changesRequested.includes(pr.reviewDecision ?? ""),
    unresolvedThreads: pr.reviewThreads.nodes.some((t) => !t.isResolved),
    mergeable: pr.mergeable,
    mergeState: pr.mergeStateStatus ?? "UNKNOWN",
    headReviewed: headReviewed(pr),
  };
}

/** Facts from `pr N`'s fresh status report (structured fields, never blocker prose). */
export function reportFollowUpFacts(r: PrStatusReport): FollowUpFacts {
  const count = (k: string) => r.checks.counts[k] ?? 0;
  return {
    draft: r.pullRequest.draft,
    complete: r.completeness.complete,
    failing: count("failed") + count("cancelled") > 0,
    pending: count("pending") > 0,
    unknownChecks: count("unknown") > 0,
    // As the snapshot rule and prstatus: only a successful verify, never SKIPPED or NEUTRAL.
    verified: workflow.verifySuccess.includes(r.checks.required?.outcome ?? ""),
    changesRequested: workflow.changesRequested.includes(r.pullRequest.reviewDecision ?? ""),
    unresolvedThreads: r.threads.unresolved.length + r.threads.omitted > 0,
    mergeable: r.pullRequest.mergeable,
    mergeState: r.pullRequest.mergeState,
    headReviewed: headAccepted(
      r.pullRequest.head,
      r.reviews.map((v) => ({ state: v.state, commit: v.reviewedCommit })),
      r.receipts.map((c) => ({ by: c.by, state: c.codexState?.code_review })),
    ),
  };
}

/** Follow-up of an open member from the snapshot's own PR evidence (current head only). */
function openFollowUp(
  pr: PullRequest | undefined,
  draft: boolean,
  warnings: string[],
): [FollowUp, string] {
  if (draft) return ["actionable", "draft: the responsible agent finishes it"];
  if (!pr)
    return ["unknown", "the pull request is not in this read; its checks and review are unknown"];
  return classifyFollowUp(snapshotFollowUpFacts(pr, warnings));
}

function memberView(
  repository: string,
  d: IssueDeliveryDiagnosis,
  prs: Map<string, PullRequest>,
  warnings: string[],
): DeliverableView[] {
  const evaluated = d.evaluation?.perDeliverable;
  return d.members.map((m, i) => {
    const match = m.deliverable.match(prLabel);
    const url = match ? `https://github.com/${match[1]}/pull/${match[2]}` : null;
    const e = evaluated?.[i];
    const base = { deliverable: m.deliverable, url, responsible: m.responsible };
    if (!e)
      return {
        ...base,
        target: "(not evaluated)",
        state: "not-evaluated" as const,
        why: d.notEvaluated ?? "delivery was not evaluated",
        followUp: "unknown" as const,
        followUpWhy: "delivery was not evaluated on this read",
      };
    let followUp: FollowUp;
    let followUpWhy: string;
    switch (e.state) {
      case "merged":
        [followUp, followUpWhy] = ["none", "merged into its target"];
        break;
      case "closed-unmerged":
        [followUp, followUpWhy] = ["actionable", "closed without merge: replace, reopen or detach"];
        break;
      case "merged-off-target":
        [followUp, followUpWhy] = ["actionable", "merged off target: merge onward or retarget"];
        break;
      case "unknown":
        [followUp, followUpWhy] = ["unknown", e.why];
        break;
      default:
        [followUp, followUpWhy] = openFollowUp(
          url && match?.[1].toLowerCase() === repository.toLowerCase()
            ? prs.get(url.toLowerCase())
            : undefined,
          e.state === "draft",
          warnings,
        );
    }
    return { ...base, target: e.target, state: e.state, why: e.why, followUp, followUpWhy };
  });
}

/** The view for one issue's diagnosis. */
export function deliveryView(
  repository: string,
  issue: Pick<Issue, "number" | "url" | "state" | "stateReason">,
  d: IssueDeliveryDiagnosis,
  prs: Map<string, PullRequest>,
  warnings: string[] = [],
): DeliveryView {
  const known = d.fold === "known";
  const legacyUnknown = d.fold === "known" && !d.trustedRecord && d.legacy?.status === "unknown";
  const delivery: DeliveryView["delivery"] =
    d.fold !== "known" || legacyUnknown
      ? "unknown"
      : !d.trustedRecord && d.legacy?.status === "trusted"
        ? "legacy"
        : !d.trustedRecord
          ? "none"
          : (d.evaluation?.delivery ?? "not-evaluated");
  const because =
    d.fold !== "known"
      ? d.unknownBecause
      : legacyUnknown
        ? [
            "a legacy v1 done handoff exists but its author's authority could not be verified",
            ...(d.legacy?.unverified ?? []),
          ]
        : delivery === "legacy"
          ? [
              "only a legacy v1 done handoff exists; its membership is unknown and is never inferred",
            ]
          : delivery === "none"
            ? ["no trusted delivery record exists"]
            : d.evaluation
              ? [...d.evaluation.because, ...d.evaluation.overrides]
              : [d.notEvaluated ?? "delivery was not evaluated"];
  const agent = d.ticketResponsible ?? "<AGENT>";
  return {
    number: issue.number,
    url: issue.url,
    closure: closureOf(issue.state, issue.stateReason),
    records: d.fold,
    delivery,
    because,
    responsibility: known
      ? {
          ticket: d.ticketResponsible,
          since: d.responsibilitySince,
          members: d.members,
        }
      : null,
    deliverables: known ? memberView(repository, d, prs, warnings) : [],
    next: [
      `pdb --issue ${issue.number} --json --repo ${repository}`,
      ...(known && d.trustedRecord
        ? [`pdb complete ${issue.number} --agent ${agent} --dry-run --repo ${repository}`]
        : []),
      `pdb ticket-doctor --repo ${repository}`,
    ],
  };
}

/** Views for every diagnosed issue in the snapshot, in issue order. */
export function deliveryRead(snapshot: Snapshot, diagnosis: DeliveryDiagnosis): DeliveryRead {
  const prs = new Map(snapshot.pullRequests.map((p) => [p.url.toLowerCase(), p]));
  const tickets = snapshot.issues
    // Only ignored markers (a verified non-writer's, or a copy bound elsewhere) are no record.
    .filter((i) => {
      const d = diagnosis.issues.get(i.number);
      return !!d && (d.fold !== "known" || d.trustedRecord || !!d.legacy);
    })
    .sort((a, b) => a.number - b.number)
    .map((i) =>
      deliveryView(
        snapshot.repository,
        i,
        diagnosis.issues.get(i.number)!,
        prs,
        snapshot.warnings ?? [],
      ),
    );
  return {
    tickets,
    complete: !diagnosis.warnings.length,
    omissions: diagnosis.warnings,
    guidance:
      "Read-only. Delivery is evaluated from live evidence; closure is reported beside it and is never evidence of delivery. Unknown or not-evaluated is never 'not delivered' or 'nobody responsible'. A claim and delivery responsibility are distinct.",
  };
}

/** Per-agent responsibility inventory (S18: count and age shown; no limit implied). */
export interface ResponsibilityItem {
  number: number;
  url: string;
  scope: "ticket" | "deliverable";
  deliverable: string | null;
  delivery: DeliveryView["delivery"];
  followUp: FollowUp | null;
  since: string | null;
}
export function responsibilityInventory(read: DeliveryRead): Map<string, ResponsibilityItem[]> {
  const out = new Map<string, ResponsibilityItem[]>();
  const push = (agent: string, item: ResponsibilityItem) =>
    out.set(agent, [...(out.get(agent) ?? []), item]);
  for (const t of read.tickets) {
    if (!t.responsibility || t.closure !== "open") continue;
    if (t.responsibility.ticket)
      push(t.responsibility.ticket, {
        number: t.number,
        url: t.url,
        scope: "ticket",
        deliverable: null,
        delivery: t.delivery,
        followUp: null,
        since: t.responsibility.since,
      });
    for (const m of t.deliverables)
      if (m.responsible)
        push(m.responsible, {
          number: t.number,
          url: t.url,
          scope: "deliverable",
          deliverable: m.deliverable,
          delivery: t.delivery,
          followUp: m.followUp,
          since: null,
        });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Additive fields for `who`, `team` and `pr`.

/** The additive triple for one issue; `delivery` null means no record in a complete history. */
export interface DeliveryFields {
  closure: Closure;
  delivery: DeliveryView | null;
  responsibility: DeliveryView["responsibility"];
}
export function deliveryFields(
  issue: Pick<Issue, "state" | "stateReason">,
  view: DeliveryView | null,
): DeliveryFields {
  return {
    closure: view?.closure ?? closureOf(issue.state, issue.stateReason),
    delivery: view,
    // No record in a complete history: nobody is responsible. Unknown records: null (unknown).
    responsibility: view ? view.responsibility : { ticket: null, since: null, members: [] },
  };
}

/** Text lines for one issue's delivery view (empty when it has none). */
export function deliveryLines(view: DeliveryView | null): string[] {
  if (!view) return [];
  const r = view.responsibility;
  return [
    `Delivery: ${view.delivery} (records ${view.records}); closure ${view.closure}; ticket responsible ${r ? (r.ticket ?? "nobody") : "unknown"}`,
    ...view.deliverables.map(
      (m) =>
        `  ${m.deliverable} -> ${m.target}: ${m.state}; follow-up ${m.followUp} (${m.followUpWhy}); responsible ${m.responsible ?? "nobody"}`,
    ),
    ...(view.delivery === "unknown" || view.delivery === "not-evaluated"
      ? view.because.map((b) => `  unknown: ${b}`)
      : []),
  ];
}

/**
 * Reads the named issues (state, closure and full comment history, bounded) and returns their
 * delivery views; `pr N` uses it for the issues the PR is linked to close.
 */
export async function readIssuesDelivery(
  repository: string,
  numbers: number[],
  rt: { query: Query; rest: Rest; trust: TrustDecision; signal?: AbortSignal },
): Promise<DeliveryRead & { closures: { number: number; closure: Closure }[] }> {
  const [owner, name] = repository.split("/");
  const issues: Issue[] = [];
  const omissions: string[] = [];
  for (const number of numbers) {
    try {
      const data = (await rt.query(
        `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){number title url state stateReason closedByPullRequestsReferences(first:10,includeClosedPrs:false){nodes{number url state} pageInfo{hasNextPage}} comments(last:100){nodes{${deliveryCommentFields}} pageInfo{hasPreviousPage startCursor}}}}}`,
        { owner, name, number },
      )) as {
        repository: {
          issue:
            | (Omit<Issue, "comments"> & {
                comments: Parameters<typeof readDeliveryComments>[2];
              })
            | null;
        } | null;
      };
      const node = data.repository?.issue;
      if (!node) throw new Error("not readable");
      const history = await readDeliveryComments(repository, number, node.comments, rt.query);
      issues.push({
        ...node,
        comments: {
          nodes: history.comments,
          pageInfo: { hasNextPage: !history.complete, endCursor: null },
        },
      } as Issue);
    } catch (error) {
      omissions.push(
        `#${number}: delivery records could not be read (${error instanceof Error ? error.message : "unknown error"}); its delivery is unknown`,
      );
    }
  }
  const snapshot = { repository, issues, pullRequests: [] } as unknown as Snapshot;
  const read = deliveryRead(
    snapshot,
    await diagnoseDelivery(snapshot, {
      trust: rt.trust,
      live: { query: rt.query, rest: rt.rest },
      signal: rt.signal,
    }),
  );
  return {
    ...read,
    complete: read.complete && !omissions.length,
    omissions: [...read.omissions, ...omissions],
    closures: issues.map((i) => ({ number: i.number, closure: closureOf(i.state, i.stateReason) })),
  };
}

/** `pr N`: which issues require this PR, who is responsible for it, and their delivery. */
export interface PrDelivery {
  /** Issues read: those the PR is linked to close. A record on an unlinked issue is not seen. */
  scope: "closing-references";
  issues: {
    number: number;
    /** The issue's repository (a PR may close an issue in another repository). */
    repository: string;
    /** Null when the issue was not read (another repository). */
    closure: Closure | null;
    /** This PR is a trusted required member of that issue (null when records are unknown). */
    required: boolean | null;
    /** Null is "nobody" only when `required` is known; with `required: null` it is unknown. */
    responsible: string | null;
    delivery: DeliveryView["delivery"] | null;
    /** As `responsible`: unknown, not "nobody", whenever `required` is null. */
    ticketResponsible: string | null;
    followUp: FollowUp | null;
    followUpWhy: string | null;
  }[];
  complete: boolean;
  omissions: string[];
}
export function prDelivery(
  prUrl: string,
  facts: FollowUpFacts,
  open: boolean,
  read: Awaited<ReturnType<typeof readIssuesDelivery>>,
  repository: string,
  foreign: { repository: string; number: number }[] = [],
): PrDelivery {
  const views = new Map(read.tickets.map((t) => [t.number, t]));
  // Issues in another repository are not read here: their records bind that repository and
  // issue, never this repository's issue with the same number. Reported unknown, out of scope.
  const outside: PrDelivery["issues"] = foreign.map((f) => ({
    number: f.number,
    repository: f.repository,
    closure: null,
    required: null,
    responsible: null,
    delivery: "unknown",
    ticketResponsible: null,
    followUp: null,
    followUpWhy: `in ${f.repository}: not read by this command; run pdb who ${f.number} --repo ${f.repository}`,
  }));
  return {
    scope: "closing-references",
    issues: [
      ...read.closures.map(({ number, closure }) => {
        const view = views.get(number) ?? null;
        const member = view?.deliverables.find((m) => m.url?.toLowerCase() === prUrl.toLowerCase());
        // This PR's follow-up comes from this report's own fresh, structured evidence.
        const [fresh, freshWhy] = classifyFollowUp(facts);
        const own = !!member && open && (member.state === "open" || member.state === "draft");
        const followUp: FollowUp | null = !member ? null : own ? fresh : member.followUp;
        return {
          number,
          repository,
          closure,
          required: view ? (view.responsibility ? !!member : null) : false,
          responsible: member?.responsible ?? null,
          delivery: view ? view.delivery : null,
          ticketResponsible: view?.responsibility?.ticket ?? null,
          followUp,
          followUpWhy: !member ? null : own ? freshWhy : member.followUpWhy,
        };
      }),
      ...outside,
    ],
    complete: read.complete,
    omissions: [
      ...read.omissions,
      ...foreign.map(
        (f) => `${f.repository}#${f.number}: another repository; its delivery is unknown here`,
      ),
    ],
  };
}
export function prDeliveryLines(d: PrDelivery): string[] {
  return [
    "",
    "Delivery (issues this PR is linked to close):",
    ...(d.issues.length ? [] : ["  none linked"]),
    ...d.issues.map(
      (i) =>
        `  ${i.repository}#${i.number} ${i.closure ?? "closure unknown"}: delivery ${i.delivery ?? "no record"}; ${i.required === null ? "required unknown" : i.required ? `required, responsible ${i.responsible ?? "nobody"}, follow-up ${i.followUp} (${i.followUpWhy})` : "not a required member"}; ticket responsible ${i.ticketResponsible ?? (i.required === null ? "unknown" : "nobody")}`,
    ),
    ...d.omissions.map((o) => `  INCOMPLETE: ${o}`),
  ];
}

/** `team`: each agent's responsibilities (S18 inventory), including agents with no claim. */
export function teamResponsibilities<
  A extends { agent: string; presence: string; claims: unknown[]; warnings: unknown[] },
>(agents: A[], read: DeliveryRead): (A & { responsibilities?: ResponsibilityItem[] })[] {
  const inventory = responsibilityInventory(read);
  const out: (A & { responsibilities?: ResponsibilityItem[] })[] = agents.map((a) =>
    inventory.has(a.agent) ? { ...a, responsibilities: inventory.get(a.agent)! } : a,
  );
  for (const [agent, items] of inventory)
    if (!agents.some((a) => a.agent === agent))
      out.push({
        agent,
        presence: "unknown",
        claims: [],
        warnings: [],
        responsibilities: items,
      } as unknown as A & { responsibilities: ResponsibilityItem[] });
  return out.sort((a, b) => a.agent.localeCompare(b.agent));
}
export function teamResponsibilityLines(
  agents: { agent: string; responsibilities?: ResponsibilityItem[] }[],
  read: DeliveryRead,
  now: Date,
): string[] {
  const lines: string[] = [];
  for (const a of agents) {
    if (!a.responsibilities?.length) continue;
    lines.push("", `${a.agent}: responsible for ${a.responsibilities.length} item(s) (no limit)`);
    for (const r of a.responsibilities) {
      const age = r.since
        ? ` for ${Math.max(0, Math.floor((now.getTime() - Date.parse(r.since)) / 3_600_000))}h`
        : "";
      lines.push(
        `  #${r.number} ${r.scope === "ticket" ? "ticket" : r.deliverable}${age}: delivery ${r.delivery}${r.followUp ? `, follow-up ${r.followUp}` : ""}`,
      );
    }
  }
  const unknown = read.tickets.filter((t) => !t.responsibility && t.closure === "open");
  if (unknown.length)
    lines.push(
      "",
      `Responsibility unknown (records unread or unverifiable): ${unknown.map((t) => `#${t.number}`).join(", ")}`,
    );
  return lines;
}

/**
 * Carries delivery omissions (the evaluation cap, unreadable issues) into a report's own
 * completeness, so a skipped evaluation never reads as a complete answer (#192).
 */
export function withDeliveryCompleteness<
  R extends { completeness: { complete: boolean; warnings: string[] } },
>(report: R, read: { complete: boolean; omissions: string[] } | null): R {
  if (!read || read.complete) return report;
  return {
    ...report,
    completeness: {
      ...report.completeness,
      complete: false,
      warnings: [...report.completeness.warnings, ...read.omissions],
    },
  };
}

/** Text lines for delivery omissions, appended to a surface's text output. */
export const omissionLines = (read: { omissions: string[] } | null): string[] =>
  (read?.omissions ?? []).map((o) => `INCOMPLETE (delivery): ${o}`);
