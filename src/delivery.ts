/**
 * Delivery records (#189, doc/design/delivery-lifecycle.md "Records: storage, versioning and
 * authority"): the `github-triage:delivery v1` comment marker, its parser and schema validation,
 * authority classification through an injected `TrustDecision`, and the in-order fold into the
 * current required set, membership and responsibility.
 *
 * Everything here is pure apart from the injected trust boundary. Records never state that
 * delivery happened; they name what is required and who is responsible. Missing, unreadable or
 * unverifiable evidence is `recordsUnknown`, never absence.
 */
import { createHash } from "node:crypto";
import { commentAuthority } from "./claims.js";
import type { Authority, Comment } from "./claims.js";
import type { PermissionLookup } from "./github.js";

export const deliveryMarkerPrefix = "<!-- github-triage:delivery ";
export const deliveryVersion = 1;

export const deliveryOps = [
  "submit",
  "attach",
  "legacy-attach",
  "legacy-attest",
  "detach",
  "retarget",
  "handoff",
  "membership",
  "attest",
  "complete",
  "reassign",
  "reset",
  "void",
] as const;
export type DeliveryOp = (typeof deliveryOps)[number];

/** `branch: null` means the target repository's default branch, read live on every read. */
export interface DeliveryTarget {
  repository: string;
  branch: string | null;
}
export type Deliverable =
  | {
      kind: "pr";
      repository: string;
      number: number;
      nodeId: string;
      target: DeliveryTarget;
      /** Head observed at attach time: provenance only, never freshness evidence. */
      headOid?: string;
    }
  | { kind: "commit"; repository: string; oid: string; target: DeliveryTarget };

export interface DeliveryRecord {
  v: 1;
  op: DeliveryOp;
  opId: string;
  repository: string;
  issue: number;
  agent: string;
  deliverables: Deliverable[];
  responsible?: string;
  membership?: "complete" | "open";
  to?: string;
  scope?: "ticket" | "deliverable";
  expectedResponsibilityRecord?: string;
  voids?: string;
  reason?: string;
  /** legacy-attach / legacy-attest: the author's authenticated login and the cited v1 release. */
  login?: string;
  legacyRelease?: string;
  evidence?: string;
  plan?: { remove: string[]; add: string[] };
  /** reset: the reset-relevant labels observed when it was planned; absent on older records. */
  observedLabels?: string[];
  evaluationRevision?: string;
  evaluatedAt?: string;
  issuedAt: string;
}

/**
 * A comment as read from GitHub, with its stable numeric id for ordering and `void`. The
 * collector must supply `createdAt` and `databaseId`; both are still checked at runtime, and a
 * recognised record lacking either is unordered evidence, never given a default.
 */
export type DeliveryComment = Comment & { databaseId: number; createdAt: string; url?: string };

/** The injected authority boundary (#212 rule in production, replaceable by #205). */
export type TrustDecision = (comment: Comment) => Promise<Authority>;
/** Production trust: the #212 rule over the per-run permission cache. */
export const markerTrust =
  (permission: PermissionLookup): TrustDecision =>
  (comment) =>
    commentAuthority(comment, permission);

const ownerName = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isPositiveInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0;

/** Stable identity of a deliverable inside a required set. */
export const deliverableKey = (d: Deliverable): string =>
  d.kind === "pr"
    ? `pr:${d.repository.toLowerCase()}#${d.number}`
    : `commit:${d.repository.toLowerCase()}@${d.oid.toLowerCase()}`;
export const deliverableLabel = (d: Deliverable): string =>
  d.kind === "pr" ? `${d.repository}#${d.number}` : `${d.repository}@${d.oid.slice(0, 12)}`;
export const targetLabel = (t: DeliveryTarget): string =>
  `${t.repository}:${t.branch ?? "(default branch)"}`;

/** Deterministic id for retries: the same operation always yields the same `opId`. */
export const deliveryOpId = (parts: {
  repository: string;
  issue: number;
  op: DeliveryOp;
  deliverables: Deliverable[];
  agent: string;
  issuedAt: string;
}): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        parts.repository.toLowerCase(),
        parts.issue,
        parts.op,
        parts.deliverables.map(deliverableKey).sort(),
        parts.agent,
        parts.issuedAt,
      ]),
    )
    .digest("hex")
    .slice(0, 16);

/** Marker plus JSON; `<`/`>` are escaped so the HTML comment cannot end early. */
export function deliveryMarker(record: DeliveryRecord): string {
  const json = JSON.stringify(record).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  return `${deliveryMarkerPrefix}v${deliveryVersion} ${json} -->`;
}

export type ParsedDelivery =
  | { kind: "none" }
  | { kind: "record"; record: DeliveryRecord }
  | { kind: "malformed"; why: string }
  | { kind: "unsupported"; version: string };

function validTarget(v: unknown): v is DeliveryTarget {
  return (
    isObject(v) &&
    isString(v.repository) &&
    ownerName.test(v.repository) &&
    (v.branch === null || isString(v.branch))
  );
}
function deliverableProblem(v: unknown): string | null {
  if (!isObject(v)) return "deliverable is not an object";
  if (!isString(v.repository) || !ownerName.test(v.repository))
    return "deliverable repository is not owner/name";
  if (!validTarget(v.target)) return "deliverable target is not {repository, branch}";
  if (v.kind === "pr") {
    if (!isPositiveInt(v.number)) return "pr deliverable has no positive number";
    if (!isString(v.nodeId)) return "pr deliverable has no nodeId";
    if (v.headOid !== undefined && !isString(v.headOid)) return "pr headOid is not a string";
    return null;
  }
  if (v.kind === "commit")
    return isString(v.oid) && /^[0-9a-f]{7,64}$/i.test(v.oid)
      ? null
      : "commit deliverable has no hex oid";
  return "deliverable kind is neither pr nor commit";
}
const reasonOptional = new Set<DeliveryOp>(["submit", "attach", "complete"]);
const needsMembers = new Set<DeliveryOp>(["attach", "legacy-attach", "detach", "retarget"]);

/** Schema validation of a v1 payload; returns the first problem, or null. */
export function deliveryRecordProblem(v: unknown): string | null {
  if (!isObject(v)) return "payload is not a JSON object";
  if (v.v !== 1) return "payload v is not 1";
  if (!deliveryOps.includes(v.op as DeliveryOp)) return `unknown op ${JSON.stringify(v.op)}`;
  const op = v.op as DeliveryOp;
  if (!isString(v.opId)) return "opId missing";
  if (!isString(v.repository) || !ownerName.test(v.repository))
    return "repository is not owner/name";
  if (!isPositiveInt(v.issue)) return "issue is not a positive integer";
  if (!isString(v.agent)) return "agent missing";
  if (!isString(v.issuedAt) || Number.isNaN(Date.parse(v.issuedAt)))
    return "issuedAt is not a timestamp";
  if (!Array.isArray(v.deliverables)) return "deliverables is not an array";
  for (const d of v.deliverables) {
    const problem = deliverableProblem(d);
    if (problem) return problem;
  }
  if (needsMembers.has(op) && v.deliverables.length === 0) return `${op} names no deliverable`;
  if (!reasonOptional.has(op) && !isString(v.reason)) return `${op} has no reason`;
  if (v.membership !== undefined && v.membership !== "complete" && v.membership !== "open")
    return "membership is neither complete nor open";
  if (v.responsible !== undefined && !isString(v.responsible)) return "responsible is not a name";
  switch (op) {
    case "membership":
      if (v.membership === undefined) return "membership record has no membership";
      break;
    case "legacy-attest":
      if (v.deliverables.length !== 0 || v.membership !== "complete")
        return "legacy-attest must declare an empty, complete set";
      if (!isString(v.login) || !isString(v.legacyRelease))
        return "legacy-attest must name its login and cited release record";
      break;
    case "legacy-attach":
      if (!isString(v.login) || !isString(v.legacyRelease))
        return "legacy-attach must name its login and cited release record";
      break;
    case "handoff":
      if (!isString(v.to)) return "handoff has no recipient";
      if (v.scope !== "ticket" && v.scope !== "deliverable") return "handoff has no scope";
      if (v.scope === "deliverable" && v.deliverables.length !== 1)
        return "deliverable handoff must name exactly one deliverable";
      if (v.scope === "ticket" && v.deliverables.length !== 0)
        return "ticket handoff must name no deliverable";
      if (!isString(v.expectedResponsibilityRecord))
        return "handoff has no expectedResponsibilityRecord";
      break;
    case "reassign":
      if (!isString(v.to)) return "reassign has no recipient";
      break;
    case "void":
      if (!isString(v.voids)) return "void names no comment";
      break;
    case "complete":
      if (!isString(v.evaluationRevision) || !isString(v.evaluatedAt))
        return "complete has no evaluation revision or time";
      break;
    default:
      break;
  }
  if (v.evidence !== undefined && !isString(v.evidence)) return "evidence is not a string";
  if (
    v.observedLabels !== undefined &&
    (!Array.isArray(v.observedLabels) || !v.observedLabels.every(isString))
  )
    return "observedLabels is not a list of labels";
  return null;
}

/**
 * Parses the delivery marker in a comment body. A body without the marker prefix is `none`; any
 * body with it is a recognized record, so it is a record, malformed or unsupported, never
 * silently skipped.
 */
export function parseDeliveryComment(body: string): ParsedDelivery {
  const at = body.indexOf(deliveryMarkerPrefix);
  if (at < 0) return { kind: "none" };
  if (body.indexOf(deliveryMarkerPrefix, at + 1) >= 0)
    return { kind: "malformed", why: "more than one delivery marker in one comment" };
  const rest = body.slice(at + deliveryMarkerPrefix.length);
  const version = /^v(\S*)\s/.exec(rest);
  if (!version) return { kind: "malformed", why: "marker has no version token" };
  if (version[1] !== String(deliveryVersion)) {
    // A version this reader does not know is never guessed at or downgraded.
    return /^\d+$/.test(version[1]) && Number(version[1]) > deliveryVersion
      ? { kind: "unsupported", version: version[1] }
      : { kind: "malformed", why: `marker version v${version[1]} is not recognised` };
  }
  const end = rest.indexOf(" -->", version[0].length);
  if (end < 0) return { kind: "malformed", why: "marker is not terminated" };
  let payload: unknown;
  try {
    payload = JSON.parse(rest.slice(version[0].length, end));
  } catch {
    return { kind: "malformed", why: "payload is not JSON" };
  }
  if (isObject(payload) && isPositiveInt(payload.v) && payload.v > deliveryVersion)
    return { kind: "unsupported", version: String(payload.v) };
  const problem = deliveryRecordProblem(payload);
  return problem
    ? { kind: "malformed", why: problem }
    : { kind: "record", record: payload as DeliveryRecord };
}

/** One recognized record after authority, parse and binding classification. */
export type ClassifiedRecord = { comment: DeliveryComment; login: string } & (
  | { status: "trusted"; record: DeliveryRecord }
  /** Trusted author, payload unparsable or invalid: makes the fold unknown until voided. */
  | { status: "malformed"; why: string }
  /** Trusted author, future version: makes the fold unknown. */
  | { status: "unsupported"; version: string }
  /** Authority could not be established: makes the fold unknown. */
  | { status: "unverified"; why: string }
  /** Established as lacking authority: listed and excluded, never unknown. */
  | { status: "ignored"; why: string }
  /** No usable ordering evidence (creation time or comment id): makes the fold unknown. */
  | { status: "unordered"; why: string }
  /** Trusted and valid, but bound to another repository or issue (copied record). */
  | { status: "foreign"; why: string }
);

/** The repository and issue being read; a record bound elsewhere never folds here. */
export interface IssueBinding {
  repository: string;
  issue: number;
}

/** Why a comment cannot be placed in stable order, or null when it can. Nothing is defaulted. */
const orderingProblem = (c: DeliveryComment): string | null => {
  if (typeof c.createdAt !== "string" || c.createdAt.length === 0)
    return "comment has no creation time, so its order is unknown";
  if (Number.isNaN(Date.parse(c.createdAt)))
    return `comment creation time ${JSON.stringify(c.createdAt)} is not a timestamp, so its order is unknown`;
  if (!isPositiveInt(c.databaseId))
    return "comment has no numeric id to break timestamp ties, so its order is unknown";
  return null;
};
/** Comments with ordering evidence, by creation time then id; the rest keep input order, last. */
const byCommentOrder = (a: DeliveryComment, b: DeliveryComment): number => {
  const aOk = orderingProblem(a) === null;
  const bOk = orderingProblem(b) === null;
  if (!aOk || !bOk) return aOk === bOk ? 0 : aOk ? -1 : 1;
  return Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.databaseId - b.databaseId;
};

/**
 * Classifies every recognized delivery record in stable comment order (creation time, then
 * comment id). Authority is decided first, so a malformed or future-version comment from a
 * verified non-writer is simply ignored and cannot block anything.
 */
export async function classifyDeliveryRecords(
  comments: DeliveryComment[],
  binding: IssueBinding,
  trust: TrustDecision,
): Promise<ClassifiedRecord[]> {
  const out: ClassifiedRecord[] = [];
  for (const comment of [...comments].sort(byCommentOrder)) {
    const parsed = parseDeliveryComment(comment.body);
    if (parsed.kind === "none") continue;
    const login = comment.author?.login;
    if (!isString(login)) {
      // No author is no authority evidence; the record is unverified, never attributed to a default.
      out.push({
        comment,
        login: "(author not established)",
        status: "unverified",
        why: "comment author could not be established",
      });
      continue;
    }
    const authority = await trust(comment);
    if (authority.status === "untrusted") {
      out.push({ comment, login, status: "ignored", why: authority.why });
      continue;
    }
    if (authority.status === "unknown") {
      out.push({ comment, login, status: "unverified", why: authority.why });
      continue;
    }
    // A trusted record that cannot be placed in order cannot be folded: no default position.
    const unordered = orderingProblem(comment);
    if (unordered) {
      out.push({ comment, login, status: "unordered", why: unordered });
      continue;
    }
    if (parsed.kind === "malformed")
      out.push({ comment, login, status: "malformed", why: parsed.why });
    else if (parsed.kind === "unsupported")
      out.push({ comment, login, status: "unsupported", version: parsed.version });
    else if (
      parsed.record.repository.toLowerCase() !== binding.repository.toLowerCase() ||
      parsed.record.issue !== binding.issue
    )
      out.push({
        comment,
        login,
        status: "foreign",
        why: `record is bound to ${parsed.record.repository}#${parsed.record.issue}, not ${binding.repository}#${binding.issue}`,
      });
    else out.push({ comment, login, status: "trusted", record: parsed.record });
  }
  return out;
}

export interface RequiredMember {
  deliverable: Deliverable;
  /** Reported agent name, or null after a reset. */
  responsible: string | null;
  /** Comment id of the record that established this member's responsibility. */
  responsibilityRecord: string | null;
  /** Comment id of the record that added it. */
  addedBy: string;
}
export interface RejectedRecord {
  comment: string;
  error: "HANDOFF_STALE" | "VOID_NOT_APPLICABLE";
  why: string;
}
export interface DeliveryFold {
  /** False when history was truncated or any recognized record could not be read or trusted. */
  recordsUnknown: boolean;
  /** Human-readable reasons for `recordsUnknown`, naming the comment and login. */
  unknownBecause: string[];
  /** The record refusal a fold-dependent mutation must give, or null when the fold is known. */
  refusal:
    | "RECORD_MALFORMED"
    | "RECORD_UNSUPPORTED"
    | "MARKER_UNVERIFIED"
    | "EVIDENCE_INCOMPLETE"
    | null;
  members: RequiredMember[];
  /** null until a record states membership. */
  membership: "complete" | "open" | null;
  ticketResponsible: string | null;
  /** Comment id of the record establishing ticket responsibility. */
  ticketResponsibilityRecord: string | null;
  /** A trusted `attest` or `legacy-attest` record exists (applicability is evaluated live). */
  attestRecord: boolean;
  /** Any trusted, bound delivery record exists (supersedes legacy v1 rules). */
  hasTrustedRecord: boolean;
  /** Folded records in order, for history display. */
  applied: { comment: string; op: DeliveryOp; agent: string; login: string; reason?: string }[];
  /** `complete` records seen; their effectiveness needs closure evidence (#191). */
  completions: string[];
  rejected: RejectedRecord[];
  /** Handoffs whose predecessor could not be validated because the earlier fold was unknown. */
  unverifiableTransfers: string[];
  /** Malformed comment ids excluded by a trusted void. */
  voided: string[];
  /** "unverified record by LOGIN, ignored" and copied-record notices. */
  ignored: string[];
  malformed: { comment: string; login: string; why: string }[];
}

const commentId = (c: DeliveryComment): string =>
  isPositiveInt(c.databaseId) ? String(c.databaseId) : `(no id${c.url ? `, ${c.url}` : ""})`;

/**
 * Folds classified records in order into the current required set (doc/design/
 * delivery-lifecycle.md "Folding"). `historyComplete` false (a truncated comment read) makes the
 * fold unknown. Handoff preconditions are validated during replay: a handoff applies only when
 * its sender is still responsible for its scope and its expected predecessor matches.
 */
export function foldDelivery(records: ClassifiedRecord[], historyComplete: boolean): DeliveryFold {
  const fold: DeliveryFold = {
    recordsUnknown: false,
    unknownBecause: [],
    refusal: null,
    members: [],
    membership: null,
    ticketResponsible: null,
    ticketResponsibilityRecord: null,
    attestRecord: false,
    hasTrustedRecord: false,
    applied: [],
    completions: [],
    rejected: [],
    unverifiableTransfers: [],
    voided: [],
    ignored: [],
    malformed: [],
  };
  const unknown = (why: string, refusal?: NonNullable<DeliveryFold["refusal"]>) => {
    fold.recordsUnknown = true;
    fold.unknownBecause.push(why);
    // Unverified authority outranks the others: nothing about that record can be relied on.
    const rank = {
      MARKER_UNVERIFIED: 4,
      EVIDENCE_INCOMPLETE: 3,
      RECORD_UNSUPPORTED: 2,
      RECORD_MALFORMED: 1,
    } as const;
    if (refusal && (!fold.refusal || rank[refusal] > rank[fold.refusal])) fold.refusal = refusal;
  };
  if (!historyComplete)
    unknown(
      "comment history was truncated, so the record fold is incomplete",
      "EVIDENCE_INCOMPLETE",
    );

  // Voids target malformed trusted records only; collect them first so order does not matter.
  const malformedIds = new Set(
    records.filter((r) => r.status === "malformed").map((r) => commentId(r.comment)),
  );
  const voids = new Set<string>();
  for (const r of records) {
    if (r.status !== "trusted" || r.record.op !== "void") continue;
    const target = r.record.voids as string;
    if (malformedIds.has(target)) voids.add(target);
    else
      fold.rejected.push({
        comment: commentId(r.comment),
        error: "VOID_NOT_APPLICABLE",
        why: `comment ${target} is not a malformed delivery record`,
      });
  }

  // Once an earlier record is unknown, later responsibility transfers cannot be validated.
  let priorUnknown = !historyComplete;
  const find = (d: Deliverable) =>
    fold.members.findIndex((m) => deliverableKey(m.deliverable) === deliverableKey(d));
  for (const r of records) {
    const id = commentId(r.comment);
    switch (r.status) {
      case "ignored":
        fold.ignored.push(`unverified record by ${r.login}, ignored (${r.why})`);
        continue;
      case "foreign":
        fold.ignored.push(`copied record ${id} by ${r.login}, rejected (${r.why})`);
        continue;
      case "unverified":
        priorUnknown = true;
        unknown(
          `delivery record ${id} by ${r.login} could not be verified (${r.why})`,
          "MARKER_UNVERIFIED",
        );
        continue;
      case "unordered":
        priorUnknown = true;
        unknown(
          `delivery record ${id} by ${r.login} cannot be ordered (${r.why})`,
          "EVIDENCE_INCOMPLETE",
        );
        continue;
      case "unsupported":
        priorUnknown = true;
        unknown(
          `unsupported delivery record version ${r.version} by ${r.login} (comment ${id})`,
          "RECORD_UNSUPPORTED",
        );
        continue;
      case "malformed":
        fold.malformed.push({ comment: id, login: r.login, why: r.why });
        if (voids.has(id)) {
          fold.voided.push(id);
          continue;
        }
        priorUnknown = true;
        unknown(
          `malformed delivery record by ${r.login} (comment ${id}: ${r.why})`,
          "RECORD_MALFORMED",
        );
        continue;
      case "trusted":
        break;
    }
    const rec = r.record;
    fold.hasTrustedRecord = true;
    const applied = () =>
      fold.applied.push({
        comment: id,
        op: rec.op,
        agent: rec.agent,
        login: r.login,
        reason: rec.reason,
      });
    switch (rec.op) {
      case "submit":
      case "attach":
      case "legacy-attach": {
        const responsible = rec.responsible ?? rec.agent;
        for (const d of rec.deliverables) {
          const member: RequiredMember = {
            deliverable: d,
            responsible,
            responsibilityRecord: id,
            addedBy: id,
          };
          const at = find(d);
          if (at >= 0) fold.members[at] = member;
          else fold.members.push(member);
        }
        if (rec.membership) fold.membership = rec.membership;
        else if (rec.op === "submit") fold.membership = "complete";
        fold.ticketResponsible = rec.agent;
        fold.ticketResponsibilityRecord = id;
        applied();
        break;
      }
      case "legacy-attest":
        fold.members = [];
        fold.membership = "complete";
        fold.attestRecord = true;
        fold.ticketResponsible = rec.agent;
        fold.ticketResponsibilityRecord = id;
        applied();
        break;
      case "attest":
        fold.attestRecord = true;
        applied();
        break;
      case "detach":
        for (const d of rec.deliverables) {
          const at = find(d);
          if (at >= 0) fold.members.splice(at, 1);
        }
        applied();
        break;
      case "retarget":
        for (const d of rec.deliverables) {
          const at = find(d);
          if (at >= 0)
            fold.members[at] = {
              ...fold.members[at],
              deliverable: { ...fold.members[at].deliverable, target: d.target },
            };
        }
        applied();
        break;
      case "membership":
        fold.membership = rec.membership ?? fold.membership;
        applied();
        break;
      case "handoff": {
        if (priorUnknown) {
          fold.unverifiableTransfers.push(id);
          unknown(`handoff ${id} by ${r.login} cannot be validated: an earlier record is unknown`);
          break;
        }
        const to = rec.to as string;
        if (rec.scope === "ticket") {
          if (
            fold.ticketResponsible !== rec.agent ||
            fold.ticketResponsibilityRecord !== rec.expectedResponsibilityRecord
          ) {
            fold.rejected.push({
              comment: id,
              error: "HANDOFF_STALE",
              why: `${rec.agent} → ${to} expected ticket responsibility record ${rec.expectedResponsibilityRecord}; current is ${fold.ticketResponsibilityRecord ?? "none"} held by ${fold.ticketResponsible ?? "nobody"}`,
            });
            break;
          }
          fold.ticketResponsible = to;
          fold.ticketResponsibilityRecord = id;
          for (const m of fold.members)
            if (m.responsible === rec.agent) {
              m.responsible = to;
              m.responsibilityRecord = id;
            }
        } else {
          const at = find(rec.deliverables[0]);
          const m = at >= 0 ? fold.members[at] : null;
          if (
            !m ||
            m.responsible !== rec.agent ||
            m.responsibilityRecord !== rec.expectedResponsibilityRecord
          ) {
            fold.rejected.push({
              comment: id,
              error: "HANDOFF_STALE",
              why: `${rec.agent} → ${to} for ${deliverableLabel(rec.deliverables[0])} expected responsibility record ${rec.expectedResponsibilityRecord}; current is ${m?.responsibilityRecord ?? "none"} held by ${m?.responsible ?? "nobody"}`,
            });
            break;
          }
          m.responsible = to;
          m.responsibilityRecord = id;
        }
        applied();
        break;
      }
      case "reassign": {
        const to = rec.to as string;
        fold.ticketResponsible = to;
        fold.ticketResponsibilityRecord = id;
        for (const m of fold.members) {
          m.responsible = to;
          m.responsibilityRecord = id;
        }
        applied();
        break;
      }
      case "reset":
        fold.ticketResponsible = null;
        fold.ticketResponsibilityRecord = id;
        for (const m of fold.members) {
          m.responsible = null;
          m.responsibilityRecord = id;
        }
        applied();
        break;
      case "void":
        if (voids.has(rec.voids as string)) applied();
        break;
      case "complete":
        // Effectiveness needs live closure evidence and the recorded revision (#191).
        fold.completions.push(id);
        applied();
        break;
    }
  }
  return fold;
}

/** The live state of one member as the caller observed it; only `merged` resolves it. */
export type MemberObservation = "merged" | "outstanding" | "unknown";
export type AttestApplicability =
  | { applies: true }
  | {
      applies: false;
      error: "ATTEST_NOT_APPLICABLE";
      outstanding: string[];
      membershipOpen: boolean;
    }
  | {
      applies: false;
      error: "EVIDENCE_INCOMPLETE" | NonNullable<DeliveryFold["refusal"]>;
      unknown: string[];
    };

/**
 * Attestation applicability (doc "Attestation applicability"): the required set is empty and
 * complete, or every member is merged into its target, with nothing unknown. Unknown evidence
 * refuses with the record or evidence refusal, never ATTEST_NOT_APPLICABLE on guessed state.
 */
export function attestApplicability(
  fold: DeliveryFold,
  observe: (d: Deliverable) => MemberObservation,
): AttestApplicability {
  if (fold.refusal) return { applies: false, error: fold.refusal, unknown: fold.unknownBecause };
  const states = fold.members.map((m) => ({
    label: deliverableLabel(m.deliverable),
    state: observe(m.deliverable),
  }));
  const unknown = states.filter((s) => s.state === "unknown").map((s) => s.label);
  if (unknown.length) return { applies: false, error: "EVIDENCE_INCOMPLETE", unknown };
  const outstanding = states.filter((s) => s.state === "outstanding").map((s) => s.label);
  const membershipOpen = fold.membership !== "complete";
  if (outstanding.length || membershipOpen)
    return { applies: false, error: "ATTEST_NOT_APPLICABLE", outstanding, membershipOpen };
  return { applies: true };
}

/** Classify and fold in one call. */
export async function readDeliveryFold(
  comments: DeliveryComment[],
  historyComplete: boolean,
  binding: IssueBinding,
  trust: TrustDecision,
): Promise<{ records: ClassifiedRecord[]; fold: DeliveryFold }> {
  const records = await classifyDeliveryRecords(comments, binding, trust);
  return { records, fold: foldDelivery(records, historyComplete) };
}
