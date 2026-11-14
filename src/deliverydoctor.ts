/**
 * Delivery-aware Ticket Doctor facts (#192, first slice).
 * Contract: doc/design/delivery-lifecycle.md ("#192 diagnostics and reads", "Responsibility-
 * transfer ordering and stale records", "Source compatibility and migration", S1, S66, S67) and
 * doc/design/delivery-owner-clarifications.md.
 *
 * Read-only. For each open snapshot ticket that carries a delivery record or a v1 `done` release
 * record, folds the trusted records with the shared fold, replays handoffs with the shared
 * validator (the fold), and evaluates delivery from live evidence with the shared collector and
 * evaluator. Nothing is posted, closed, reopened, claimed or reassigned. Unknown evidence is
 * reported as unknown: it is never read as "no record", "nobody responsible" or "not delivered".
 */
import {
  collectDeliveryFacts,
  completionEffects,
  effectiveResponsibility,
  evaluateDelivery,
} from "./completion.js";
import type { DeliveryEvaluation } from "./completion.js";
import {
  deliveryCommentFields,
  legacyRelease,
  prUrl,
  readDeliveryComments,
} from "./deliverables.js";
import type { DeliverablesRuntime } from "./deliverables.js";
import { deliverableLabel, parseDeliveryComment, readDeliveryFold } from "./delivery.js";
import type { DeliveryComment, TrustDecision } from "./delivery.js";
import type { Issue, Snapshot } from "./github/types.js";

/** Open tickets whose delivery is evaluated live per Doctor run; more are reported, not read. */
export const deliveryDoctorTicketCap = 20;

export interface DeliveryDoctorRuntime {
  /** #212 authority of record authors; absent (offline, or not injected) means unverified. */
  trust?: TrustDecision;
  /** Live PR, default-branch and compare reads; absent means delivery is not evaluated. */
  live?: Pick<DeliverablesRuntime, "query" | "rest">;
  signal?: AbortSignal;
}

/** A known stale (rejected) responsibility transfer, with the records on both sides. */
export interface StaleTransfer {
  comment: string;
  url: string | null;
  sender: string;
  recipient: string;
  scope: "ticket" | "deliverable";
  deliverable: string | null;
  expected: string | null;
  effective: string | null;
  effectiveUrl: string | null;
  effectiveHolder: string | null;
  /**
   * Responsible for the same scope after the whole fold (later valid transfers applied), or null
   * when nobody is, or when the final fold is unknown and so cannot name anyone.
   */
  current: string | null;
  why: string;
}

export interface IssueDeliveryDiagnosis {
  number: number;
  /**
   * `known`: the trusted records folded completely. `unknown`: some record could not be read or
   * trusted. `unread`: authority could not be checked at all (offline or no permission boundary).
   */
  fold: "known" | "unknown" | "unread";
  unknownBecause: string[];
  /** A trusted, bound delivery record exists (only meaningful when the fold is known). */
  trustedRecord: boolean;
  ticketResponsible: string | null;
  /** Creation time of the record that established ticket responsibility (inventory age). */
  responsibilitySince: string | null;
  /** Comment ids of `complete` records in the fold (pending or effective). */
  completions: string[];
  members: { deliverable: string; responsible: string | null }[];
  /** Live evaluation; null when it was not run (see `notEvaluated`). */
  evaluation: DeliveryEvaluation | null;
  notEvaluated: string | null;
  staleTransfers: StaleTransfer[];
  unverifiableTransfers: { comment: string; url: string | null }[];
  /** A legacy v1 `done` release: trusted, unverifiable, or absent (null). */
  legacy: {
    status: "trusted" | "unknown";
    release: string | null;
    agent: string | null;
    /** Attach candidates named for a human decision, never inferred membership. */
    candidates: { flag: "--pr" | "--commit"; value: string }[];
    unverified: string[];
  } | null;
}

export interface DeliveryDiagnosis {
  issues: Map<number, IssueDeliveryDiagnosis>;
  /** Scan-level omissions (the evaluation cap). */
  warnings: string[];
}

const releaseDone = /<!-- github-triage:release:[0-9a-f]+ /;
const commitUrl = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/commit\/([0-9a-f]{7,40})\/?$/i;
const commitForm = /^[\w.-]+\/[\w.-]+@[0-9a-f]{7,40}$/i;

/**
 * The agent and deliverable a v1 release comment names. `planRelease` (src/claims.ts) records the
 * agent in the marker JSON and writes the deliverable only as a visible line of the same trusted
 * comment: `Pull request: URL (STATE)` for --pr or `Change: VALUE` for --change.
 */
function releasePayload(body: string): { agent: string | null; deliverable: string | null } {
  let agent: string | null = null;
  const m = body.match(releaseDone);
  if (m && m.index !== undefined) {
    const start = m.index + m[0].length;
    try {
      const r = JSON.parse(body.slice(start, body.indexOf(" -->", start))) as { agent?: unknown };
      agent = typeof r.agent === "string" ? r.agent : null;
    } catch {
      agent = null;
    }
  }
  const line = body.match(/^(?:Pull request|Change): (\S+)/m);
  return { agent, deliverable: line ? line[1] : null };
}

/** Attach candidates: the release's own deliverable, then PRs GitHub links as closing the issue. */
function legacyCandidates(
  issue: Issue,
  release: DeliveryComment | null,
): { flag: "--pr" | "--commit"; value: string }[] {
  const out: { flag: "--pr" | "--commit"; value: string }[] = [];
  const add = (flag: "--pr" | "--commit", value: string) => {
    if (!out.some((c) => c.value.toLowerCase() === value.toLowerCase())) out.push({ flag, value });
  };
  const named = release ? releasePayload(release.body).deliverable : null;
  if (named && prUrl.test(named)) add("--pr", named);
  else if (named && commitForm.test(named)) add("--commit", named);
  else if (named && commitUrl.test(named)) {
    // `release --change URL` names a commit URL; attach takes `owner/name@SHA`.
    const [, repository, oid] = named.match(commitUrl)!;
    add("--commit", `${repository}@${oid}`);
  }
  for (const node of issue.closedByPullRequestsReferences?.nodes ?? [])
    if (prUrl.test(node.url)) add("--pr", node.url);
  return out;
}

/**
 * Folds, replays and (within the cap) evaluates delivery for every snapshot ticket that has a
 * delivery or v1 release record (open tickets in a briefing; a closed one only when an issue
 * intake collected it). Tickets with neither are absent from the result.
 */
export async function diagnoseDelivery(
  snapshot: Snapshot,
  rt: DeliveryDoctorRuntime,
): Promise<DeliveryDiagnosis> {
  const result: DeliveryDiagnosis = { issues: new Map(), warnings: [] };
  let evaluated = 0;
  let skipped = 0;
  for (const issue of snapshot.issues) {
    rt.signal?.throwIfAborted();
    const issueOpen = issue.state === "OPEN";
    const comments = issue.comments.nodes as DeliveryComment[];
    const records = comments.some((c) => parseDeliveryComment(c.body).kind !== "none");
    const releases = comments.some((c) => releaseDone.test(c.body));
    // Unseen comment pages may hold a record: that is unknown, never "no record".
    const truncated = !!issue.comments.pageInfo?.hasNextPage;
    if (!records && !releases && !truncated) continue;
    const d: IssueDeliveryDiagnosis = {
      number: issue.number,
      fold: "unread",
      unknownBecause: [],
      trustedRecord: false,
      ticketResponsible: null,
      responsibilitySince: null,
      completions: [],
      members: [],
      evaluation: null,
      notEvaluated: null,
      staleTransfers: [],
      unverifiableTransfers: [],
      legacy: null,
    };
    result.issues.set(issue.number, d);
    if (!records && !releases) {
      d.fold = "unknown";
      d.unknownBecause.push(
        "the comment history was truncated, so delivery records may be on unseen pages",
      );
      continue;
    }
    if (!rt.trust) {
      d.unknownBecause.push(
        "record authors' permissions were not read (offline or no permission lookup), so no record is trusted or excluded",
      );
      continue;
    }
    const historyComplete = !issue.comments.pageInfo.hasNextPage;
    const { records: classified, fold } = await readDeliveryFold(
      comments,
      historyComplete,
      { repository: snapshot.repository, issue: issue.number },
      rt.trust,
    );
    const urlOf = new Map(
      classified.map((r) => [String(r.comment.databaseId), r.comment.url ?? null]),
    );
    d.fold = fold.recordsUnknown ? "unknown" : "known";
    d.unknownBecause = [...fold.unknownBecause];
    d.trustedRecord = fold.hasTrustedRecord;
    // An effective `complete` (issue closed, evaluation unchanged) ends all responsibility.
    const ended = effectiveResponsibility(
      fold,
      issueOpen ? [] : completionEffects(classified, fold, true),
    );
    d.ticketResponsible = ended.ticketResponsible;
    d.completions = [...fold.completions];
    d.responsibilitySince = fold.ticketResponsibilityRecord
      ? (classified.find((r) => String(r.comment.databaseId) === fold.ticketResponsibilityRecord)
          ?.comment.createdAt ?? null)
      : null;
    d.members = ended.members;
    for (const r of fold.rejected)
      if (r.error === "HANDOFF_STALE" && r.transfer)
        d.staleTransfers.push({
          comment: r.comment,
          url: urlOf.get(r.comment) ?? null,
          ...r.transfer,
          effectiveUrl: r.transfer.effective ? (urlOf.get(r.transfer.effective) ?? null) : null,
          current: fold.recordsUnknown
            ? null
            : r.transfer.scope === "ticket"
              ? fold.ticketResponsible
              : (fold.members.find(
                  (m) => deliverableLabel(m.deliverable) === r.transfer!.deliverable,
                )?.responsible ?? null),
          why: r.why,
        });
    d.unverifiableTransfers = fold.unverifiableTransfers.map((c) => ({
      comment: c,
      url: urlOf.get(c) ?? null,
    }));
    // A legacy release matters only when no trusted delivery record supersedes it.
    let legacyHandoff = false;
    if (releases && !fold.hasTrustedRecord) {
      const rel = await legacyRelease(comments, rt.trust);
      if (rel.trusted || rel.unverified.length) {
        legacyHandoff = !!rel.trusted;
        d.legacy = {
          status: rel.trusted ? "trusted" : "unknown",
          release: rel.trusted ? (rel.trusted.url ?? String(rel.trusted.databaseId)) : null,
          agent: rel.trusted ? releasePayload(rel.trusted.body).agent : null,
          candidates: legacyCandidates(issue, rel.trusted),
          unverified: rel.unverified,
        };
      }
    }
    if (fold.recordsUnknown || !fold.hasTrustedRecord) continue;
    if (!rt.live) {
      d.notEvaluated = "live delivery evidence was not read (offline)";
      continue;
    }
    if (evaluated >= deliveryDoctorTicketCap) {
      d.notEvaluated = `more than ${deliveryDoctorTicketCap} tickets with delivery records; this one was not evaluated`;
      skipped++;
      continue;
    }
    evaluated++;
    const facts = await collectDeliveryFacts(
      {
        repository: snapshot.repository,
        issue: issue.number,
        issueOpen,
        fold,
        legacyHandoff,
      },
      rt.live,
    );
    d.evaluation = evaluateDelivery(facts);
  }
  if (skipped)
    result.warnings.push(
      `delivery evaluated for ${deliveryDoctorTicketCap} tickets; ${skipped} more with delivery records were not evaluated`,
    );
  return result;
}

// ---------------------------------------------------------------------------------------------
// Closed-issue drift (S5, S16, S68 after closing): an explicitly bounded --since window.

/** Closed issues read per Doctor run (one page); more in the window make the scan incomplete. */
export const closedDriftIssueCap = 50;

/** Closure as reported, never inferred (doc "Closure (reported, never inferred)"). */
export type Closure =
  | "open"
  | "closed-completed"
  | "closed-not-planned"
  | "closed-duplicate"
  | "closed-other";
export const closureOf = (state: string, stateReason: string | null | undefined): Closure =>
  state === "OPEN"
    ? "open"
    : stateReason === "COMPLETED"
      ? "closed-completed"
      : stateReason === "NOT_PLANNED"
        ? "closed-not-planned"
        : stateReason === "DUPLICATE"
          ? "closed-duplicate"
          : "closed-other";

export interface ClosedDriftTicket {
  number: number;
  title: string;
  url: string;
  closure: Closure;
  /** The GitHub login of the closing actor, never "a human"; null when unreadable. */
  closedBy: string | null;
  closedAt: string | null;
  fold: "known" | "unknown";
  unknownBecause: string[];
  ticketResponsible: string | null;
  members: { deliverable: string; responsible: string | null }[];
  completions: string[];
  /** Effective `complete` records: responsibility has ended (empty when none is effective). */
  effectiveCompletion: string[];
  evaluation: DeliveryEvaluation | null;
  notEvaluated: string | null;
}
export interface ClosedDriftScan {
  since: string;
  /** Closed issues in the window that were read. */
  scanned: number;
  /** Of those, issues carrying a delivery record (the only ones in drift scope). */
  withRecords: number;
  complete: boolean;
  warnings: string[];
  tickets: ClosedDriftTicket[];
}

interface ClosedIssueNode {
  number: number;
  title: string;
  url: string;
  state: string;
  stateReason: string | null;
  closedAt: string | null;
  timelineItems?: { nodes: ({ actor?: { login?: string } | null } | null)[] };
  comments: {
    nodes: DeliveryComment[];
    pageInfo?: { hasPreviousPage?: boolean; startCursor?: string | null };
  };
}

/**
 * Reads closed issues updated since `since` (one bounded page) and, for those carrying a
 * delivery record, folds and evaluates delivery live (issue closed). Historical closed tickets
 * outside the window are out of scope by contract; a truncated window or unreadable history is
 * reported incomplete, never as "no drift".
 */
export async function diagnoseClosedDrift(
  repository: string,
  since: string,
  rt: Required<Pick<DeliveryDoctorRuntime, "trust" | "live">> & { signal?: AbortSignal },
): Promise<ClosedDriftScan> {
  const scan: ClosedDriftScan = {
    since,
    scanned: 0,
    withRecords: 0,
    complete: true,
    warnings: [],
    tickets: [],
  };
  const [owner, name] = repository.split("/");
  let nodes: ClosedIssueNode[];
  try {
    const data = (await rt.live.query(
      `query($owner:String!,$name:String!,$since:DateTime!,$first:Int!){repository(owner:$owner,name:$name){issues(states:CLOSED,first:$first,orderBy:{field:UPDATED_AT,direction:DESC},filterBy:{since:$since}){nodes{number title url state stateReason closedAt timelineItems(itemTypes:[CLOSED_EVENT],last:1){nodes{... on ClosedEvent{actor{login}}}} comments(last:100){nodes{${deliveryCommentFields}} pageInfo{hasPreviousPage startCursor}}} pageInfo{hasNextPage}}}}`,
      { owner, name, since, first: closedDriftIssueCap },
    )) as {
      repository: {
        issues: { nodes: ClosedIssueNode[]; pageInfo: { hasNextPage: boolean } };
      } | null;
    };
    if (!data.repository) throw new Error(`repository ${repository} unavailable`);
    nodes = data.repository.issues.nodes;
    if (data.repository.issues.pageInfo.hasNextPage) {
      scan.complete = false;
      scan.warnings.push(
        `more than ${closedDriftIssueCap} issues closed and updated since ${since}; drift beyond them is unknown (narrow --since)`,
      );
    }
  } catch (error) {
    scan.complete = false;
    scan.warnings.push(
      `closed issues since ${since} could not be read (${error instanceof Error ? error.message : "unknown error"}); closed-issue drift is unknown`,
    );
    return scan;
  }
  let evaluated = 0;
  for (const node of nodes) {
    rt.signal?.throwIfAborted();
    scan.scanned++;
    let history: Awaited<ReturnType<typeof readDeliveryComments>>;
    try {
      history = await readDeliveryComments(repository, node.number, node.comments, rt.live.query);
    } catch (error) {
      // A failed older page (rate limit, network) is incomplete coverage, never "no record".
      scan.complete = false;
      scan.warnings.push(
        `${node.url}: comment history could not be read (${error instanceof Error ? error.message : "unknown error"}); its delivery drift is unknown`,
      );
      continue;
    }
    if (!history.comments.some((c) => parseDeliveryComment(c.body).kind !== "none")) {
      // An unseen older page may hold a record: that is unknown, never "no record".
      if (!history.complete) {
        scan.complete = false;
        scan.warnings.push(
          `${node.url}: comment history truncated; whether it carries a delivery record is unknown`,
        );
      }
      continue;
    }
    const { records: classified, fold } = await readDeliveryFold(
      history.comments,
      history.complete,
      { repository, issue: node.number },
      rt.trust,
    );
    // An effective `complete` (issue closed, evaluation unchanged) ends all responsibility.
    const effects = completionEffects(classified, fold, true);
    const ended = effectiveResponsibility(fold, effects);
    // Only ignored markers (a verified non-writer's, or a copy bound to another issue) mean no
    // delivery record: out of drift scope. An unknown fold stays in scope as unknown.
    if (!fold.recordsUnknown && !fold.hasTrustedRecord) continue;
    scan.withRecords++;
    const t: ClosedDriftTicket = {
      number: node.number,
      title: node.title,
      url: node.url,
      closure: closureOf(node.state, node.stateReason),
      closedBy: node.timelineItems?.nodes?.[0]?.actor?.login ?? null,
      closedAt: node.closedAt ?? null,
      fold: fold.recordsUnknown ? "unknown" : "known",
      unknownBecause: [...fold.unknownBecause],
      ticketResponsible: ended.ticketResponsible,
      members: ended.members,
      completions: [...fold.completions],
      effectiveCompletion: effects.filter((e) => e.effective).map((e) => e.comment),
      evaluation: null,
      notEvaluated: null,
    };
    scan.tickets.push(t);
    if (fold.recordsUnknown) continue;
    if (evaluated >= deliveryDoctorTicketCap) {
      t.notEvaluated = `more than ${deliveryDoctorTicketCap} closed tickets with delivery records; this one was not evaluated`;
      scan.complete = false;
      continue;
    }
    evaluated++;
    t.evaluation = evaluateDelivery(
      await collectDeliveryFacts(
        { repository, issue: node.number, issueOpen: false, fold, legacyHandoff: false },
        rt.live,
      ),
    );
  }
  if (scan.tickets.some((t) => t.notEvaluated))
    scan.warnings.push(
      `delivery evaluated for ${deliveryDoctorTicketCap} closed tickets; the rest with delivery records were not evaluated`,
    );
  return scan;
}
