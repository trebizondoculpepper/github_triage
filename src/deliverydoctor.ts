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
import { collectDeliveryFacts, evaluateDelivery } from "./completion.js";
import type { DeliveryEvaluation } from "./completion.js";
import { legacyRelease, prUrl } from "./deliverables.js";
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
 * Folds, replays and (within the cap) evaluates delivery for every open snapshot ticket that has
 * a delivery or v1 release record. Tickets with neither are absent from the result.
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
    if (issue.state !== "OPEN") continue;
    const comments = issue.comments.nodes as DeliveryComment[];
    const records = comments.some((c) => parseDeliveryComment(c.body).kind !== "none");
    const releases = comments.some((c) => releaseDone.test(c.body));
    if (!records && !releases) continue;
    const d: IssueDeliveryDiagnosis = {
      number: issue.number,
      fold: "unread",
      unknownBecause: [],
      trustedRecord: false,
      ticketResponsible: null,
      completions: [],
      members: [],
      evaluation: null,
      notEvaluated: null,
      staleTransfers: [],
      unverifiableTransfers: [],
      legacy: null,
    };
    result.issues.set(issue.number, d);
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
    d.ticketResponsible = fold.ticketResponsible;
    d.completions = [...fold.completions];
    d.members = fold.members.map((m) => ({
      deliverable: deliverableLabel(m.deliverable),
      responsible: m.responsible,
    }));
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
        issueOpen: true,
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
