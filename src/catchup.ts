/**
 * Repository catch-up aggregation and rendering for briefing mode (#169, slice 2 of
 * doc/design/briefing-mode.md). Pure: one snapshot (current open work plus the optional retained
 * `changeEvidence`), an injected clock and presentation limits in; one deterministic, versioned
 * report model out, rendered as JSON or bounded text. No GitHub calls, mutations, checkpoint
 * writes or CLI flags live here (#170 owns those).
 *
 * Evidence rules: current observations stay separate from historical events; reported agent
 * attribution stays separate from the GitHub account actor; waiting is not failure; incomplete
 * or unavailable history is never presented as "no changes".
 */
import { analysisRules, excerpt, owners, prChecks, workflow } from "./briefing.js";
import type { Bounded } from "./briefing.js";
import { inWindow, parseOperationMarker, snapshotChangeEvidence } from "./changes.js";
import type {
  ChangeEvidence,
  ChangeSubject,
  ComparisonWindow,
  SourceCoverage,
  SubjectOperation,
} from "./changes.js";
import type { Action, Comment, Issue, PullRequest, Snapshot } from "./types.js";

export const CATCHUP_SCHEMA_VERSION = 1;
/** Presentation bounds from the contract: rows per section and the text budget. */
export const catchUpLimits = {
  limit: { default: 5, min: 1, max: 100 },
  maxChars: { default: 10000, min: 1000, max: 40000 },
} as const;

export type Certainty = "reported" | "candidate" | "unknown";
/** Who a row is attributed to, how, and how sure. A GitHub login is never an agent identity. */
export interface Attribution {
  /** Persistent agent identity from labels or structured records; null when unknown. */
  agent: string | null;
  relation:
    | "current-owner"
    | "linked-pr-owner"
    | "origin"
    | "claim-record"
    | "release-record"
    | "review-author"
    | "none";
  /** The label name or record URL that supplied the attribution. */
  source: string | null;
  certainty: Certainty;
  /** The GitHub account that performed the operation, when known; kept apart from `agent`. */
  githubActor: string | null;
}
export interface SubjectRef {
  kind: "issue" | "pull-request";
  number: number;
  url: string;
  title: string;
}
export interface CatchUpRow {
  /** Stable identity: repository + subject kind/number + event identity. Never the title. */
  id: string;
  kind: string;
  subject: SubjectRef;
  /** Natively linked subjects grouped into this row (for example a PR and the issue it closed). */
  related: (SubjectRef & { relation: string })[];
  /** Event time for history rows, observation time for current rows; null when unknown. */
  at: string | null;
  timing: "event" | "observation" | "unknown";
  /** For current activity: when the subject started (its creation), kept apart from `at`. */
  startedAt?: string | null;
  description: string;
  /** All reasons that put the row here; grouping never drops one. */
  reasons: string[];
  evidence: string[];
  next: string | null;
  uncertainty: Certainty | "factual";
  attribution: Attribution[];
  detailCommand: string;
}
export type AttentionStatus = "none-evidenced" | "recorded" | "candidate" | "unknown";
export type HistoryStatus = "complete" | "incomplete" | "unavailable" | "baseline";
export interface CatchUpSection extends Bounded<CatchUpRow> {
  /** Current sections observe now; history sections qualify events against the window. */
  basis: "current" | "history";
  status: HistoryStatus | "complete" | "incomplete";
  notice: string | null;
}
export interface ActivityGroup {
  /** Agent identity, or null for the explicit unresolved-attribution group. */
  agent: string | null;
  rows: CatchUpRow[];
}
export interface CatchUpOptions {
  /** The viewing agent: highlights addressed attention; never filters repository history. */
  agent?: string;
  limit?: number;
  now: () => Date;
}

const SECTION_NAMES = ["attention", "completed", "progress", "blockers", "activity"] as const;
export type SectionName = (typeof SECTION_NAMES)[number];
export const sectionTitles: Record<SectionName, string> = {
  attention: "OWNER ATTENTION",
  completed: "COMPLETED / DISPOSED",
  progress: "PROGRESS",
  blockers: "BLOCKERS / RISKS",
  activity: "CURRENT ACTIVITY",
};

const labelsOf = (item: Pick<Issue, "labels">): string[] => item.labels.nodes.map((l) => l.name);
const isPr = (item: Issue): item is PullRequest => "headRefOid" in item;
const kindOf = (item: Issue): SubjectRef["kind"] => (isPr(item) ? "pull-request" : "issue");
const ref = (item: Pick<Issue, "number" | "url" | "title">, kind: SubjectRef["kind"]) => ({
  kind,
  number: item.number,
  url: item.url,
  title: item.title,
});
const time = (at: string | null): number => (at ? Date.parse(at) : Number.NaN);

/** Reported attribution from current labels: owner labels and origin provenance. */
function labelAttribution(item: Pick<Issue, "labels">): Attribution[] {
  const rows: Attribution[] = owners(item).map((label) => ({
    agent: label.slice(workflow.ownerPrefix.length),
    relation: "current-owner",
    source: label,
    certainty: "reported",
    githubActor: null,
  }));
  for (const label of labelsOf(item).filter((l) => l.startsWith("origin:")))
    rows.push({
      agent: label.slice("origin:".length),
      relation: "origin",
      source: label,
      certainty: "reported",
      githubActor: null,
    });
  return rows;
}
const unknownAttribution = (githubActor: string | null = null): Attribution => ({
  agent: null,
  relation: "none",
  source: null,
  certainty: "unknown",
  githubActor,
});
const orUnknown = (rows: Attribution[]): Attribution[] =>
  rows.length ? rows : [unknownAttribution()];

/** A structured triage operation record in a comment: claim or release, with its reported agent. */
interface OperationRecord {
  operation: "claim" | "release";
  agent: string | null;
  comment: Comment;
}
function operationRecord(comment: Comment): OperationRecord | null {
  const marker = parseOperationMarker(comment.body ?? "");
  return marker ? { ...marker, comment } : null;
}

/** Sort known times newest first, unknown times after, then stable id. */
function historyOrder(a: CatchUpRow, b: CatchUpRow): number {
  const ta = time(a.at);
  const tb = time(b.at);
  const ka = Number.isFinite(ta);
  const kb = Number.isFinite(tb);
  if (ka !== kb) return ka ? -1 : 1;
  if (ka && kb && ta !== tb) return tb - ta;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
const byId = (a: CatchUpRow, b: CatchUpRow) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Add rows once per identity; a repeated identity merges reasons and evidence. */
function dedupe(rows: CatchUpRow[]): CatchUpRow[] {
  const seen = new Map<string, CatchUpRow>();
  for (const row of rows) {
    const prior = seen.get(row.id);
    if (!prior) {
      seen.set(row.id, row);
      continue;
    }
    for (const reason of row.reasons)
      if (!prior.reasons.includes(reason)) prior.reasons.push(reason);
    for (const link of row.evidence) if (!prior.evidence.includes(link)) prior.evidence.push(link);
  }
  return [...seen.values()];
}

/**
 * Aggregate one repository catch-up report. History sections use the retained change evidence;
 * attention, blockers and activity are current observations of the snapshot.
 */
export function catchUp(snapshot: Snapshot, options: CatchUpOptions) {
  const limit = options.limit ?? catchUpLimits.limit.default;
  if (
    !Number.isInteger(limit) ||
    limit < catchUpLimits.limit.min ||
    limit > catchUpLimits.limit.max
  )
    throw new Error(
      `--limit must be an integer from ${catchUpLimits.limit.min} to ${catchUpLimits.limit.max}.`,
    );
  const now = options.now();
  const repository = snapshot.repository;
  const detail = (kind: SubjectRef["kind"], number: number) =>
    kind === "pull-request"
      ? `gh pr view ${number} --repo ${repository}`
      : `github-triage --repo ${repository} --issue ${number} --json`;
  const rowId = (kind: SubjectRef["kind"], number: number, event: string) =>
    `${repository}#${kind}#${number}#${event}`;
  const items: Issue[] = [...snapshot.issues, ...snapshot.pullRequests];
  const byUrl = new Map(items.map((item) => [item.url, item]));

  const retained = snapshotChangeEvidence(snapshot);
  const evidence: ChangeEvidence | null = retained.available ? retained.evidence : null;
  const window: ComparisonWindow | null = evidence?.window ?? null;
  let historyStatus: HistoryStatus = !evidence
    ? "unavailable"
    : window?.from === null
      ? "baseline"
      : evidence.complete
        ? "complete"
        : "incomplete";
  let historyNotice =
    historyStatus === "unavailable"
      ? `History unavailable: ${retained.available ? "" : retained.reason} This is not "no changes".`
      : historyStatus === "baseline"
        ? (window?.notice ?? "No previous comparison window; baseline only.")
        : historyStatus === "incomplete"
          ? "Change evidence is incomplete; absent rows do not mean nothing happened."
          : null;
  const qualifies = (at: string | null | undefined) =>
    window ? inWindow(at, window) === true : false;

  // ---- Owner attention (current; always first, even when the request predates the window).
  const rule = (name: string) =>
    analysisRules.get(name)?.({
      snapshot,
      issues: snapshot.issues,
      prs: snapshot.pullRequests,
      viewer: options.agent,
      now,
    }) ?? [];
  const recordedRules = new Set(["addressed-attention", "design-decision-needed"]);
  const recordedLabels = new Set(["blocked:credential", "blocked:testing"]);
  const findings: Action[] = [
    ...rule("addressed-attention"),
    ...rule("design-markers").filter((f) => f.rule === "design-decision-needed"),
    ...rule("attention"),
  ];
  // A question-shaped comment only enriches a subject that has current workflow evidence; on its
  // own it never reopens an answered or historical question.
  const questionByUrl = new Map(
    findings.filter((f) => f.rule === "question-candidate").map((f) => [f.target, f]),
  );
  const attentionRows: CatchUpRow[] = [];
  for (const finding of findings) {
    if (finding.rule === "question-candidate") continue;
    const item = byUrl.get(finding.target);
    if (!item) continue;
    const kind = kindOf(item);
    const tags = labelsOf(item);
    const recorded =
      recordedRules.has(finding.rule) ||
      (finding.rule === "attention-label" && tags.some((t) => recordedLabels.has(t)));
    const asked = questionByUrl.get(item.url);
    // Only quote a question that the finding itself does not already cite.
    const question =
      asked && !asked.evidence.every((e) => finding.evidence.includes(e)) ? asked : null;
    const blocks = (item.blocking?.nodes ?? []).map((n) => `#${n.number}`);
    const requestAt =
      (finding.evidence.length > 1
        ? item.comments.nodes.find((c) => c.url === finding.evidence.at(-1))?.createdAt
        : null) ??
      item.createdAt ??
      null;
    attentionRows.push({
      id: rowId(kind, item.number, "attention"),
      kind: recorded ? "recorded" : "candidate",
      subject: ref(item, kind),
      related: [],
      at: requestAt,
      timing: requestAt ? "observation" : "unknown",
      description: `${finding.reason}${blocks.length ? ` Blocks ${blocks.join(", ")}.` : ""}${question ? ` Latest question: "${question.reason}"` : ""}`,
      reasons: [finding.rule],
      evidence: [...finding.evidence, ...(question?.evidence ?? [])].filter(
        (v, i, all) => all.indexOf(v) === i,
      ),
      next: finding.next,
      uncertainty: recorded ? "reported" : "candidate",
      attribution: orUnknown(labelAttribution(item)),
      detailCommand: detail(kind, item.number),
    });
  }
  const attention = dedupe(attentionRows).sort((a, b) => {
    const rank = (r: CatchUpRow) =>
      (r.reasons.includes("addressed-attention") ? 0 : 2) + (r.kind === "recorded" ? 0 : 1);
    const blocks = (r: CatchUpRow) => (/Blocks /.test(r.description) ? 0 : 1);
    return (
      rank(a) - rank(b) ||
      blocks(a) - blocks(b) ||
      (time(a.at) || Infinity) - (time(b.at) || Infinity) ||
      a.subject.number - b.subject.number ||
      byId(a, b)
    );
  });
  const openWorkIncomplete = snapshot.warnings.length > 0;
  const attentionStatus: AttentionStatus = attention.some((r) => r.kind === "recorded")
    ? "recorded"
    : attention.length
      ? "candidate"
      : openWorkIncomplete
        ? "unknown"
        : "none-evidenced";

  // ---- Completed / disposed (history). Group a merged PR with the issue it natively closed.
  const subjects = evidence?.subjects ?? [];
  const subjectRef = (s: ChangeSubject): SubjectRef => ref(s, s.kind);
  const attributionFor = (s: ChangeSubject) => {
    const current = byUrl.get(s.url);
    return orUnknown(current ? labelAttribution(current) : []);
  };
  const completedRows: CatchUpRow[] = [];
  const grouped = new Set<string>();
  const disposition = (s: ChangeSubject) => {
    const merged = s.events.find((e) => e.type === "merged" && e.inWindow);
    if (merged) return { type: "merged", at: merged.at, kind: "completed", text: "PR merged" };
    const closed = s.events.find((e) => e.type === "closed" && e.inWindow);
    if (closed && s.stateReason === "COMPLETED")
      return { type: "closed", at: closed.at, kind: "completed", text: "Issue completed" };
    if (closed)
      return {
        type: "closed",
        at: closed.at,
        kind: "disposed",
        text: `Issue closed (${s.stateReason ?? "reason unknown"}); not a delivery`,
      };
    const unmerged = s.events.find((e) => e.type === "closed-unmerged" && e.inWindow);
    if (unmerged)
      return {
        type: "closed-unmerged",
        at: unmerged.at,
        kind: "disposed",
        text: "PR closed without merge; not a delivery",
      };
    return null;
  };
  const ordered = [...subjects].sort((a, b) =>
    a.kind === b.kind ? a.number - b.number : a.kind === "pull-request" ? -1 : 1,
  );
  for (const s of ordered) {
    const done = disposition(s);
    if (!done || grouped.has(s.url)) continue;
    const related: CatchUpRow["related"] = [];
    const reasons = [`${done.text} at ${done.at}.`];
    const evidenceLinks = [s.url];
    if (s.kind === "pull-request" && done.type === "merged")
      for (const link of s.links.filter((l) => l.relation === "closes")) {
        // Match by full URL: a cross-repository link may share a local issue's number. The issue
        // must link back to this exact PR as closed-by, not merely carry its number.
        const linked = subjects.find((x) => x.kind === "issue" && x.url === link.url);
        const linkedDone = linked ? disposition(linked) : null;
        if (
          !linked ||
          !linkedDone ||
          !linked.links.some((l) => l.relation === "closed-by" && l.url === s.url)
        ) {
          // The link is native, but the issue's own completion is not in the evidence.
          related.push({
            kind: "issue",
            number: link.number,
            url: link.url,
            title: "",
            relation: "closes",
          });
          continue;
        }
        grouped.add(linked.url);
        related.push({ ...subjectRef(linked), relation: "closes" });
        reasons.push(`#${linked.number}: ${linkedDone.text} at ${linkedDone.at}.`);
        evidenceLinks.push(linked.url);
      }
    if (!s.linksComplete) reasons.push("Native links are incomplete; unlinked status is unknown.");
    completedRows.push({
      id: rowId(s.kind, s.number, done.type),
      kind: done.kind,
      subject: subjectRef(s),
      related,
      at: done.at,
      timing: "event",
      description: `${done.text}: ${s.title}`,
      reasons,
      evidence: evidenceLinks,
      next: null,
      uncertainty: "factual",
      attribution: attributionFor(s),
      detailCommand: detail(s.kind, s.number),
    });
  }

  // ---- Progress (history): created subjects, review developments, workflow operations, and
  // updated-only observations where the exact operation is unknown.
  const progressRows: CatchUpRow[] = [];
  for (const s of subjects) {
    const created = s.events.find((e) => e.type === "created" && e.inWindow);
    if (created)
      progressRows.push({
        id: rowId(s.kind, s.number, "created"),
        kind: "opened",
        subject: subjectRef(s),
        related: s.links.map((l) => ({
          kind:
            l.relation === "closes" || l.relation === "blocked-by" || l.relation === "blocking"
              ? "issue"
              : "pull-request",
          number: l.number,
          url: l.url,
          title: "",
          relation: l.relation,
        })),
        at: created.at,
        timing: "event",
        description: `${s.kind === "pull-request" ? "PR" : "Issue"} opened: ${s.title}`,
        reasons: ["created in window"],
        evidence: [s.url],
        next: null,
        uncertainty: "factual",
        attribution: attributionFor(s),
        detailCommand: detail(s.kind, s.number),
      });
    else if (s.updatedOnly && !disposition(s))
      progressRows.push({
        id: rowId(s.kind, s.number, "updated"),
        kind: "updated",
        subject: subjectRef(s),
        related: [],
        at: s.updatedAt,
        timing: "observation",
        description: `Updated (operation unknown; current state ${s.state}): ${s.title}`,
        reasons: ["updatedAt in window without a known qualifying event"],
        evidence: [s.url],
        next: null,
        uncertainty: "unknown",
        attribution: [unknownAttribution()],
        detailCommand: detail(s.kind, s.number),
      });
  }
  // Operations come from open snapshot items (fully paginated comments) and from the retained
  // evidence of every changed subject, so work closed in the window keeps its claims, releases
  // and reviews. Rows share one id per subject and event, so the two sources deduplicate.
  const operations: { s: SubjectRef; op: SubjectOperation }[] = [];
  /** Subjects whose operation history could not be established completely. */
  const unknownOperations = new Set<string>();
  if (window?.from) {
    for (const item of items) {
      const kind = kindOf(item);
      for (const comment of item.comments.nodes)
        if (operationRecord(comment)) {
          // A structured operation without its time cannot be placed in or out of the window:
          // the subject's operation history is unknown, never silently empty.
          if (!comment.createdAt) unknownOperations.add(item.url);
          operations.push({
            s: ref(item, kind),
            op: {
              source: "comment",
              url: comment.url,
              at: comment.createdAt ?? null,
              body: comment.body,
              author: comment.author?.login ?? null,
              state: null,
            },
          });
        }
      if (isPr(item))
        for (const review of item.reviews.nodes) {
          if (review.state === "PENDING") continue;
          // A review without its submission time cannot be qualified: unknown, never "none".
          if (!review.submittedAt) unknownOperations.add(item.url);
          operations.push({
            s: ref(item, kind),
            op: {
              source: "review",
              url: review.url,
              at: review.submittedAt ?? null,
              body: review.body ?? "",
              author: review.author?.login ?? null,
              state: review.state,
            },
          });
        }
    }
    for (const s of subjects) {
      for (const op of s.operations ?? []) operations.push({ s: subjectRef(s), op });
      // An open subject's comments are fully paginated in the snapshot (truncated reviews are a
      // snapshot warning); a closed subject has only its retained, possibly truncated, evidence.
      // An open subject's untimed operations are flagged by the loop above; a retained record
      // that is itself incomplete (unparseable marker, truncated history) is unknown either way.
      if (s.operationsComplete === false || (s.operationsComplete !== true && !byUrl.has(s.url)))
        unknownOperations.add(s.url);
    }
  }
  for (const { s, op } of operations) {
    if (!qualifies(op.at)) continue;
    if (op.source === "review") {
      progressRows.push({
        id: rowId(s.kind, s.number, `review:${op.url}`),
        kind: "review",
        subject: s,
        related: [],
        at: op.at,
        timing: "event",
        description: `Review ${op.state}${op.body ? `: "${excerpt(op.body, 160)}"` : ""}`,
        reasons: ["review submitted in window"],
        evidence: [op.url],
        next: null,
        uncertainty: "factual",
        attribution: [{ ...unknownAttribution(op.author), relation: "review-author" }],
        detailCommand: detail(s.kind, s.number),
      });
      continue;
    }
    // Prefer the marker parsed from the full body at collection; older evidence is reparsed, and
    // a marker that no longer parses (for example, truncated) makes the subject's history unknown.
    const record = op.record !== undefined ? op.record : parseOperationMarker(op.body);
    if (!record) {
      unknownOperations.add(s.url);
      continue;
    }
    progressRows.push({
      id: rowId(s.kind, s.number, `${record.operation}:${op.url}`),
      kind: record.operation,
      subject: s,
      related: [],
      at: op.at,
      timing: "event",
      description: `Reported ${record.operation} by ${record.agent ?? "unknown agent"}`,
      reasons: ["structured workflow record in window"],
      evidence: [op.url],
      next: null,
      uncertainty: "reported",
      attribution: [
        {
          agent: record.agent,
          relation: record.operation === "claim" ? "claim-record" : "release-record",
          source: op.url,
          // Format validation is not authentication: reported, never verified.
          certainty: record.agent ? "reported" : "unknown",
          githubActor: op.author,
        },
      ],
      detailCommand: detail(s.kind, s.number),
    });
  }

  if (historyStatus === "complete" && unknownOperations.size) {
    historyStatus = "incomplete";
    historyNotice = `Operation history (reviews, claims, releases) is incomplete for ${[...unknownOperations].sort().join(", ")}; absent rows do not mean nothing happened.`;
  }
  // A changed subject whose creation, closure or merge time is unknown may hide an event in the
  // window: history cannot be complete and no checkpoint may pass it.
  // Only a time whose absence drops an event counts: a merged PR's closedAt yields no event.
  const missingTimes = (s: ChangeSubject) =>
    [
      !s.createdAt && "createdAt",
      s.state === "MERGED" && !s.mergedAt && "mergedAt",
      s.state === "CLOSED" && !s.closedAt && "closedAt",
    ].filter((f): f is string => !!f);
  const untimed = window?.from
    ? subjects
        .filter((s) => missingTimes(s).length)
        .map((s) => `${s.url} (${missingTimes(s).join(", ")} unknown)`)
        .sort()
    : [];
  const untimedNotice = untimed.length
    ? `Event times are unknown for ${untimed.join(", ")}; a merge, closure or creation may be unreported.`
    : null;
  if (untimedNotice && historyStatus === "complete") {
    historyStatus = "incomplete";
    historyNotice = untimedNotice;
  }

  // ---- Blockers / risks (current). Onset is unknown without delta evidence.
  const blockerRows: CatchUpRow[] = [];
  const observedAt = snapshot.fetchedAt;
  const blocker = (
    item: Issue,
    event: string,
    kind: string,
    description: string,
    next: string,
    links: string[],
    uncertainty: CatchUpRow["uncertainty"] = "factual",
  ) =>
    blockerRows.push({
      id: rowId(kindOf(item), item.number, event),
      kind,
      subject: ref(item, kindOf(item)),
      related: [],
      at: observedAt,
      timing: "observation",
      description: `${description} Onset unknown (current observation).`,
      reasons: [kind],
      evidence: links,
      next,
      uncertainty,
      attribution: orUnknown(labelAttribution(item)),
      detailCommand: detail(kindOf(item), item.number),
    });
  for (const pr of snapshot.pullRequests) {
    if (!workflow.openStates.includes(pr.state)) continue;
    const { failed, cancelled, pending } = classifyChecks(pr);
    if (failed.length)
      blocker(
        pr,
        "checks-failed",
        "failed-checks",
        `Failed checks: ${failed.map((c) => c.name).join(", ")}.`,
        "Inspect the failing logs and fix the head.",
        failed.map((c) => c.url),
      );
    if (cancelled.length)
      blocker(
        pr,
        "checks-cancelled",
        "cancelled-checks",
        `Cancelled checks (verification incomplete, not a code defect): ${cancelled.map((c) => c.name).join(", ")}.`,
        "Re-run the cancelled checks.",
        cancelled.map((c) => c.url),
      );
    if (pending.length)
      blocker(
        pr,
        "checks-pending",
        "waiting",
        `Waiting on checks (not a failure): ${pending.map((c) => c.name).join(", ")}.`,
        "Wait for the checks to finish.",
        pending.map((c) => c.url),
      );
    if (workflow.conflicts.includes(pr.mergeable))
      blocker(
        pr,
        "conflicts",
        "conflicts",
        "Merge conflicts with the base branch.",
        "Rebase or merge the base branch.",
        [pr.url],
      );
    const unresolved = pr.reviewThreads.nodes.filter((t) => !t.isResolved);
    if (
      unresolved.length ||
      (pr.reviewDecision && workflow.changesRequested.includes(pr.reviewDecision))
    )
      blocker(
        pr,
        "review",
        "unresolved-review",
        `${unresolved.length} unresolved review thread(s)${pr.reviewDecision ? `; review decision ${pr.reviewDecision}` : ""}.`,
        "Address the review findings.",
        unresolved.map((t) => t.comments.nodes[0]?.url ?? pr.url),
      );
  }
  for (const issue of snapshot.issues) {
    if (!workflow.openStates.includes(issue.state)) continue;
    const open = (issue.blockedBy?.nodes ?? []).filter((n) =>
      workflow.openStates.includes(n.state),
    );
    if (open.length)
      blocker(
        issue,
        "dependency",
        "dependency",
        `Blocked by open ${open.map((n) => `#${n.number}`).join(", ")}.`,
        "Finish or re-plan the native blockers.",
        open.map((n) => n.url),
      );
  }
  for (const stale of rule("stale-claim")) {
    const item = byUrl.get(stale.target);
    if (item)
      blocker(
        item,
        "stale-claim",
        "stale",
        stale.reason,
        stale.next,
        stale.evidence,
        stale.uncertainty,
      );
  }

  // ---- Current activity: claims and open linked PR contributions, grouped by agent identity.
  // A PR and the issue it natively closes form one contribution with all their reasons.
  const activityRows: CatchUpRow[] = [];
  const claimedPr = new Set<string>();
  const startedOrOngoing = (createdAt: string | null) =>
    window?.from && qualifies(createdAt) ? "started in window" : "ongoing (not new)";
  const byUrlOrder = (a: { url: string }, b: { url: string }) =>
    a.url < b.url ? -1 : a.url > b.url ? 1 : 0;
  const openPrs = snapshot.pullRequests
    .filter((pr) => workflow.openStates.includes(pr.state))
    .sort(byUrlOrder);
  const claimedIssues = snapshot.issues
    .filter((issue) => workflow.openStates.includes(issue.state) && owners(issue).length)
    .sort((a, b) => a.number - b.number || byUrlOrder(a, b));
  // One contribution per connected set of claimed issues and the open PRs that natively close
  // them, so a PR closing two claimed issues is one row, counted once.
  const component = new Map<string, string>();
  const root = (key: string): string => {
    const parent = component.get(key) ?? key;
    if (parent === key) return key;
    const top = root(parent);
    component.set(key, top);
    return top;
  };
  const join = (a: string, b: string) => {
    const [ra, rb] = [root(a), root(b)].sort();
    if (ra !== rb) component.set(rb!, ra!);
  };
  const prsOf = (issue: Issue) =>
    openPrs.filter((pr) => pr.closingIssuesReferences.nodes.some((r) => r.url === issue.url));
  for (const issue of claimedIssues) for (const pr of prsOf(issue)) join(issue.url, pr.url);
  const contributions = new Map<string, Issue[]>();
  for (const issue of claimedIssues)
    contributions.set(root(issue.url), [...(contributions.get(root(issue.url)) ?? []), issue]);
  for (const issues of contributions.values()) {
    const [lead, ...others] = issues;
    const issue = lead!;
    const prs = openPrs.filter((pr) => issues.some((i) => prsOf(i).includes(pr)));
    prs.forEach((pr) => claimedPr.add(pr.url));
    const status = issues.flatMap((i) =>
      labelsOf(i)
        .filter((l) => l.startsWith("status:"))
        .map((l) => (i === issue ? l : `#${i.number} ${l}`)),
    );
    const prState = prs.map((pr) => `PR #${pr.number} ${prStatusWord(pr)}`);
    const startedAt = issue.createdAt ?? null;
    activityRows.push({
      id: rowId("issue", issue.number, "activity"),
      kind: "claim",
      subject: ref(issue, "issue"),
      related: [
        ...others.map((i) => ({ ...ref(i, "issue" as const), relation: "co-closed" })),
        ...prs.map((pr) => ({ ...ref(pr, "pull-request" as const), relation: "closed-by" })),
      ],
      // A current observation is timed by the collection, never by the subject's creation.
      at: snapshot.fetchedAt,
      timing: "observation",
      startedAt,
      description: `${issue.title}${others.length ? ` (with ${others.map((i) => `#${i.number}`).join(", ")})` : ""} — ${startedOrOngoing(startedAt)}; ${[...status, ...prState].join("; ") || "no status label"}.`,
      reasons: [
        ...issues.map((i) =>
          i === issue
            ? `Reported owner label ${owners(i).join(", ")}`
            : `#${i.number}: reported owner label ${owners(i).join(", ")}`,
        ),
        ...prs.map(
          (pr) =>
            `Linked open PR #${pr.number} closes ${issues
              .filter((i) => pr.closingIssuesReferences.nodes.some((r) => r.url === i.url))
              .map((i) => `#${i.number}`)
              .join(", ")} (native closing reference)`,
        ),
      ],
      evidence: [...issues.map((i) => i.url), ...prs.map((pr) => pr.url)],
      next: prs.length ? nextFor(prs[0]!) : "Implementation in progress; no linked PR observed.",
      uncertainty: "reported",
      // Each issue's and linked PR's own owner labels stay in the contribution, sourced to them.
      attribution: [
        ...labelAttribution(issue),
        ...others.flatMap((i) =>
          labelAttribution(i).map((a) => ({ ...a, source: `${a.source} on issue #${i.number}` })),
        ),
        ...prs.flatMap((pr) =>
          owners(pr).map((label): Attribution => ({
            agent: label.slice(workflow.ownerPrefix.length),
            relation: "linked-pr-owner",
            source: `${label} on PR #${pr.number}`,
            certainty: "reported",
            githubActor: null,
          })),
        ),
      ],
      detailCommand: detail("issue", issue.number),
    });
  }
  for (const pr of snapshot.pullRequests) {
    if (!workflow.openStates.includes(pr.state) || claimedPr.has(pr.url)) continue;
    const linked = pr.closingIssuesReferences.nodes;
    activityRows.push({
      id: rowId("pull-request", pr.number, "activity"),
      kind: "contribution",
      subject: ref(pr, "pull-request"),
      related: linked.map((l) => ({
        kind: "issue",
        number: l.number,
        url: l.url,
        title: byUrl.get(l.url)?.title ?? "",
        relation: "closes",
      })),
      at: snapshot.fetchedAt,
      timing: "observation",
      startedAt: pr.createdAt ?? null,
      description: `${pr.title} — ${startedOrOngoing(pr.createdAt ?? null)}; ${prStatusWord(pr)}.`,
      reasons: [
        "Open PR",
        ...(pr.closingIssuesReferences.pageInfo.hasNextPage
          ? ["Closing references incomplete; unlinked status unknown."]
          : []),
      ],
      evidence: [pr.url, ...linked.map((l) => l.url)],
      next: nextFor(pr),
      uncertainty: owners(pr).length ? "reported" : "unknown",
      attribution: orUnknown(labelAttribution(pr).filter((a) => a.relation === "current-owner")),
      detailCommand: detail("pull-request", pr.number),
    });
  }
  // Group by agent identity (owner labels, including a linked PR's); every agent gets the row
  // once, unresolved last.
  const groups = new Map<string | null, CatchUpRow[]>();
  for (const row of dedupe(activityRows)) {
    const agents = new Set(
      row.attribution
        .filter(
          (a) => (a.relation === "current-owner" || a.relation === "linked-pr-owner") && a.agent,
        )
        .map((a) => a.agent),
    );
    for (const key of agents.size ? agents : [null])
      groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const activityGroups: ActivityGroup[] = [...groups.entries()]
    .sort(([a], [b]) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1))
    .map(([agent, rows]) => ({
      agent,
      rows: rows.sort((x, y) => x.subject.number - y.subject.number || byId(x, y)),
    }));
  const activity = activityGroups
    .flatMap((g) => g.rows)
    .filter((row, i, all) => all.indexOf(row) === i);

  const bound = (
    rows: CatchUpRow[],
    basis: CatchUpSection["basis"],
    status: CatchUpSection["status"],
    notice: string | null,
  ): CatchUpSection => ({
    total: rows.length,
    omitted: Math.max(0, rows.length - limit),
    items: rows.slice(0, limit),
    basis,
    status,
    notice,
  });
  const currentStatus = openWorkIncomplete ? "incomplete" : "complete";
  const currentNotice = openWorkIncomplete
    ? "Current open-work collection is incomplete; see warnings."
    : null;
  const completedAll = dedupe(completedRows).sort(historyOrder);
  const progressAll = dedupe(progressRows).sort(historyOrder);
  const sections: Record<SectionName, CatchUpSection> = {
    attention: bound(attention, "current", currentStatus, currentNotice),
    completed: bound(completedAll, "history", historyStatus, historyNotice),
    progress: bound(progressAll, "history", historyStatus, historyNotice),
    blockers: bound(
      dedupe(blockerRows).sort((a, b) => a.subject.number - b.subject.number || byId(a, b)),
      "current",
      currentStatus,
      currentNotice,
    ),
    activity: bound(activity, "current", currentStatus, currentNotice),
  };
  const shownIds = new Set(sections.activity.items.map((r) => r.id));
  const count = (rows: CatchUpRow[], kind: string) => rows.filter((r) => r.kind === kind).length;
  const warnings = [
    ...snapshot.warnings,
    ...(historyNotice ? [historyNotice] : []),
    ...(untimedNotice && untimedNotice !== historyNotice ? [untimedNotice] : []),
    ...(evidence?.coverage ?? [])
      .filter((c) => !c.complete)
      .map((c) => `${c.source}: ${c.omission ?? "incomplete"}`),
  ];
  const complete = historyStatus === "complete" && !openWorkIncomplete;
  // A baseline has no history by design, not by failure: its current collection and source
  // coverage being complete makes it a complete report that may seed a checkpoint at T0.
  const baselineComplete =
    historyStatus === "baseline" &&
    !openWorkIncomplete &&
    !!evidence?.complete &&
    evidence.coverage.every((c) => c.complete);
  return {
    schemaVersion: CATCHUP_SCHEMA_VERSION,
    kind: "repository-briefing" as const,
    repository,
    viewer: {
      agent: options.agent ?? null,
      note: "The viewer only highlights addressed attention; repository history is never filtered to one agent, and identity is never inferred from the GitHub login.",
    },
    window: window ?? null,
    observation: { startedAt: snapshot.startedAt, fetchedAt: snapshot.fetchedAt },
    scope: evidence?.scope ?? null,
    coverage: (evidence?.coverage ?? []) as SourceCoverage[],
    completeness: {
      complete,
      history: historyStatus,
      currentObservations: currentStatus,
      warnings,
    },
    attentionStatus,
    summary: {
      pullRequestsMerged: completedAll.filter(
        (r) => r.subject.kind === "pull-request" && r.kind === "completed",
      ).length,
      issuesCompleted: subjects.filter(
        (x) => x.kind === "issue" && disposition(x)?.kind === "completed",
      ).length,
      disposed: subjects.filter((x) => disposition(x)?.kind === "disposed").length,
      opened: count(progressAll, "opened"),
      updatedOnly: count(progressAll, "updated"),
      reviews: count(progressAll, "review"),
      operations: count(progressAll, "claim") + count(progressAll, "release"),
      attention: attention.length,
      blockers: blockerRows.length - count(blockerRows, "waiting"),
      waiting: count(blockerRows, "waiting"),
      activeContributions: activity.length,
    },
    sections,
    activityGroups: activityGroups.map((g) => ({
      agent: g.agent,
      total: g.rows.length,
      shown: g.rows.filter((r) => shownIds.has(r.id)).map((r) => r.id),
    })),
    omissions: Object.fromEntries(SECTION_NAMES.map((n) => [n, sections[n].omitted])) as Record<
      SectionName,
      number
    >,
    metrics: {
      requests: snapshot.metrics?.requestCount ?? null,
      changeRequests: evidence?.cost.requests ?? null,
      durationMs: snapshot.metrics?.durationMs ?? null,
    },
    checkpoint: {
      policy:
        "A complete live report may advance an explicitly requested checkpoint to the window end only after successful delivery; this report does not advance it.",
      candidate: (complete || baselineComplete) && window ? window.through : null,
    },
  };
}
export type CatchUpReport = ReturnType<typeof catchUp>;

/**
 * The one check classification shared by the blocker rows and current activity, so the two can
 * never disagree: a cancelled check is incomplete verification, not a failure.
 */
function classifyChecks(pr: PullRequest) {
  const checks = prChecks(pr);
  return {
    checks,
    failed: checks.filter((c) => workflow.failure.includes(c.outcome) && c.outcome !== "CANCELLED"),
    cancelled: checks.filter((c) => c.outcome === "CANCELLED"),
    pending: checks.filter((c) => workflow.unfinished.includes(c.outcome)),
    /** Outcomes that are neither a supported pass, failure nor unfinished state. */
    unknown: checks.filter(
      (c) => ![...workflow.pass, ...workflow.failure, ...workflow.unfinished].includes(c.outcome),
    ),
    /** False when the check connection was truncated: more outcomes exist than were seen. */
    complete: !pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.pageInfo?.hasNextPage,
  };
}
const CANCELLED_WORD = "checks cancelled; verification incomplete";
function prStatusWord(pr: PullRequest): string {
  const { checks, failed, cancelled, pending, unknown, complete } = classifyChecks(pr);
  if (pr.isDraft) return "draft";
  if (workflow.conflicts.includes(pr.mergeable)) return "conflicting";
  if (failed.length) return "checks failing";
  if (cancelled.length) return CANCELLED_WORD;
  if (pending.length) return "checks pending";
  if (pr.reviewThreads.nodes.some((t) => !t.isResolved)) return "review findings open";
  // A reviewer can request changes without inline threads; same rule as the blocker section.
  if (pr.reviewDecision && workflow.changesRequested.includes(pr.reviewDecision))
    return "changes requested";
  // Passing only when every observed outcome is a supported pass and none were left unseen.
  if (!checks.length || unknown.length) return "checks unknown";
  if (!complete) return "checks incomplete";
  return "checks passing";
}
function nextFor(pr: PullRequest): string {
  const word = prStatusWord(pr);
  if (word === "checks failing") return `Fix failing checks on PR #${pr.number}.`;
  if (word === CANCELLED_WORD) return `Rerun checks on PR #${pr.number}.`;
  if (word === "checks pending") return `Wait for checks on PR #${pr.number}.`;
  if (word === "conflicting") return `Resolve conflicts on PR #${pr.number}.`;
  if (word === "review findings open" || word === "changes requested")
    return `Address review findings on PR #${pr.number}.`;
  if (word === "draft") return `Finish draft PR #${pr.number}.`;
  return `Review PR #${pr.number}; verify the current head before merging.`;
}

const attentionHeadline: Record<AttentionStatus, string> = {
  recorded: "Owner attention: RECORDED requests below.",
  candidate: "Owner attention: candidates only (need triage; not confirmed owner decisions).",
  "none-evidenced": "Owner attention: no owner action identified in collected evidence.",
  unknown: "Owner attention: UNKNOWN — current collection is incomplete.",
};

/** Bounded text. Window, completeness, scope and omission notices are kept before row detail. */
export function catchUpText(
  report: CatchUpReport,
  maxChars: number = catchUpLimits.maxChars.default,
): string {
  if (
    !Number.isInteger(maxChars) ||
    maxChars < catchUpLimits.maxChars.min ||
    maxChars > catchUpLimits.maxChars.max
  )
    throw new Error(
      `--max-chars must be an integer from ${catchUpLimits.maxChars.min} to ${catchUpLimits.maxChars.max}.`,
    );
  const w = report.window;
  const s = report.summary;
  const head = [
    `Repository briefing: ${report.repository}`,
    attentionHeadline[report.attentionStatus],
    w
      ? `Window ${w.from ?? "(baseline)"} → ${w.through} (${w.source}${w.last ? ` ${w.last}` : ""}); observed ${report.observation.startedAt} → ${report.observation.fetchedAt}.`
      : "Window unknown: no retained change evidence.",
    report.completeness.history === "complete"
      ? `Changes: ${s.pullRequestsMerged} PR(s) merged; ${s.issuesCompleted} issue(s) completed; ${s.disposed} disposed; ${s.opened} opened; ${s.reviews} review(s); ${s.operations} reported operation(s); ${s.updatedOnly} updated with unknown operation.`
      : `Changes: history ${report.completeness.history.toUpperCase()}; counts below are not a complete account.`,
    `Now: ${s.attention} attention; ${s.blockers} blocker(s); ${s.waiting} waiting; ${s.activeContributions} active contribution(s).`,
    `Scope: issues and PRs only (no releases, npm publication, deployments or diffs). Agent names are reported attribution, not authenticated; GitHub logins are not agents.`,
  ];
  const warnings = report.completeness.warnings;
  const omitted = Object.entries(report.omissions).filter(([, n]) => n > 0);
  const footer = [
    omitted.length
      ? `Omitted rows: ${omitted.map(([k, n]) => `${k} ${n}`).join(", ")}; use --limit or --json.`
      : "No rows omitted by --limit.",
  ];
  const budgetNotice = "More rows omitted by text budget; use --json or --max-chars.";
  const row = (r: CatchUpRow) => {
    const who = r.attribution
      .map((a) =>
        a.agent
          ? `${a.agent} (${a.relation}, ${a.certainty}${a.githubActor ? `; GitHub ${a.githubActor}` : ""})`
          : `attribution unknown${a.githubActor ? ` (GitHub ${a.githubActor})` : ""}`,
      )
      .join("; ");
    // Evidence beyond the subject itself (question comments, reviews, failed checks).
    const links = r.evidence.filter((link) => link !== r.subject.url);
    const related = r.related.length
      ? ` [+ ${r.related.map((x) => `${x.relation} #${x.number}`).join(", ")}]`
      : "";
    return [
      `- [${r.kind}] #${r.subject.number}${related} ${r.description}`,
      `  ${r.at ?? "time unknown"} (${r.timing}); ${who}`,
      ...(r.reasons.length > 1 ? [`  Reasons: ${r.reasons.join(" | ")}`] : []),
      ...(r.next ? [`  Next: ${r.next}`] : []),
      ...(links.length
        ? [
            `  Evidence: ${links.slice(0, 3).join(" ")}${links.length > 3 ? ` (+${links.length - 3} more in --json)` : ""}`,
          ]
        : []),
      `  ${r.subject.url} — ${r.detailCommand}`,
    ].join("\n");
  };
  const body: string[] = [];
  for (const name of SECTION_NAMES) {
    const section = report.sections[name];
    body.push(
      `\n${sectionTitles[name]} (${section.basis}; ${section.total}; ${section.omitted} omitted)${section.notice ? `\n  ${section.notice}` : ""}`,
    );
    if (!section.items.length)
      body.push(
        section.basis === "history" && section.status !== "complete"
          ? "- Nothing shown; history is not complete, so this is not evidence of no change."
          : name === "attention"
            ? `- ${attentionHeadline[report.attentionStatus]}`
            : "- None in collected evidence.",
      );
    if (name === "activity") {
      const shown = new Set(section.items.map((r) => r.id));
      for (const group of report.activityGroups) {
        const rows = section.items.filter((r) => group.shown.includes(r.id) && shown.has(r.id));
        if (!rows.length) continue;
        // The group header travels with its first row so the budget never strands it.
        const header = `${group.agent ? `Agent ${group.agent}` : "Unresolved attribution"} (${group.total}):`;
        body.push(...rows.map((r, i) => (i ? row(r) : `${header}\n${row(r)}`)));
      }
    } else body.push(...section.items.map(row));
  }
  // The header is budgeted too: warnings collapse to one completeness notice with a count, whose
  // first-warning excerpt shrinks to fit; the full list stays in --json.
  const reserve = footer.join("\n").length + budgetNotice.length + 4;
  const fit = (text: string, room: number) =>
    text.length <= room ? text : room > 1 ? `${text.slice(0, room - 1)}…` : "";
  const essential = head.join("\n").length;
  if (warnings.length) {
    const prefix = `INCOMPLETE: ${warnings.length} collection warning(s)`;
    const suffix = "; see --json.";
    const room = maxChars - reserve - essential - prefix.length - suffix.length - 12;
    const first = fit(warnings[0]!, Math.min(200, room));
    head.push(`${prefix}${first ? ` (first: ${first})` : ""}${suffix}`);
  }
  const lines = head.map((line) => fit(line, maxChars - reserve));
  while (lines.join("\n").length + reserve > maxChars && lines.length > 1) lines.pop();
  let truncated = false;
  for (const line of body) {
    if (lines.join("\n").length + line.length + 1 + reserve > maxChars) {
      truncated = true;
      break;
    }
    lines.push(line);
  }
  lines.push("", ...footer);
  if (truncated) lines.push(budgetNotice);
  return lines.join("\n") + "\n";
}

/** Versioned JSON rendering of the same report model. */
export const catchUpJson = (report: CatchUpReport): string =>
  JSON.stringify(report, null, 2) + "\n";
