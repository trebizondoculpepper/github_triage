/**
 * Evidence-based ticket completion (#191, doc/design/delivery-lifecycle.md "Default completion
 * policy", "Rule and fact interface" and "Complete and concurrent claims").
 *
 * - `collectDeliveryFacts` reads live evidence for every required member of the trusted fold:
 *   each pull request's state, and for every merged PR and every commit member a compare of the
 *   merge commit (or commit) against the live head of its intended target branch. The default
 *   branch is read live on each read. Nothing recorded (base, head, earlier verdict) is evidence.
 * - `evaluateDelivery` is pure. It runs the contract's completion predicates, written below as
 *   rule records (`completionPredicates`), over the collected facts, and derives the ticket
 *   verdict by the contract's precedence: unknown > delivered > attested > partial > submitted >
 *   legacy > none. The same records render the Datalog text the contract states, which the tests
 *   compare against the document, so prose and enforcement cannot drift apart silently.
 * - `complete N` writes a `complete` record only on a fresh `delivered` or applicable `attested`
 *   verdict with no active claim, then re-reads claims, records and every member's evidence and
 *   evaluates again before closing the issue `completed`. It never reopens, never merges and never
 *   closes on unknown or incomplete evidence.
 */
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { workflow } from "./briefing.js";
import { claimPolicy, shellQuote } from "./claims.js";
import type { Comment, PlanStep } from "./claims.js";
import {
  defaultBranch,
  deliveryCommentFields,
  legacyRelease,
  readDeliveryComments,
  readPr,
  targetContainment,
} from "./deliverables.js";
import type { DeliverablesRuntime } from "./deliverables.js";
import {
  deliverableKey,
  deliverableLabel,
  deliveryMarker,
  deliveryOpId,
  readDeliveryFold,
  targetLabel,
} from "./delivery.js";
import type {
  ClassifiedRecord,
  Deliverable,
  DeliveryComment,
  DeliveryFold,
  DeliveryRecord,
  EvidenceSnapshot,
} from "./delivery.js";

// ---------------------------------------------------------------------------------------------
// Rule records: the contract's completion predicates as data.

/** One atom of a rule: a predicate over variables (`T`, `D`) or the wildcard `_`. */
export interface Atom {
  pred: string;
  args: string[];
  negated?: boolean;
}
/** `head :- body.` Negation is stratified: a negated predicate is fully derived earlier. */
export interface Clause {
  head: Atom;
  body: Atom[];
}
const atom = (text: string): Atom => {
  const m = /^(not )?(\w+)\(([^)]*)\)$/.exec(text.trim());
  if (!m) throw new Error(`bad atom ${text}`);
  return { pred: m[2], args: m[3].split(",").map((a) => a.trim()), negated: !!m[1] };
};
const clause = (head: string, ...body: string[]): Clause => ({
  head: atom(head),
  body: body.map(atom),
});

/**
 * The completion predicates of doc/design/delivery-lifecycle.md "Rule and fact interface", in
 * the document's order. `undelivered` and `partial` hold only from positive `outstanding`
 * evidence and never when `unknown(T)`; `delivered` needs every member `mergedIntoTarget`, which
 * the collector sets only from a live compare on this read.
 */
export const completionPredicates: readonly Clause[] = [
  clause("outstanding(D)", "notYetMerged(D)"),
  clause("outstanding(D)", "mergedOffTarget(D)"),
  clause("outstanding(D)", "closedUnmerged(D)"),
  clause("memberUnknown(T)", "required(T, D)", "evidenceUnknown(D)"),
  clause("unknown(T)", "memberUnknown(T)"),
  clause("unknown(T)", "recordsUnknown(T)"),
  clause("undelivered(T)", "required(T, D)", "outstanding(D)", "not unknown(T)"),
  clause("hasMember(T)", "required(T, _)"),
  clause(
    "delivered(T)",
    "hasMember(T)",
    "membershipComplete(T)",
    "not unknown(T)",
    "not undelivered(T)",
  ),
  clause("attestApplies(T)", "membershipComplete(T)", "not unknown(T)", "not undelivered(T)"),
  clause("attested(T)", "attestRecord(T)", "attestApplies(T)"),
  clause("partial(T)", "required(T, D)", "mergedIntoTarget(D)", "undelivered(T)"),
];

/** Registered base facts with the English phrase explanations use (doc "Facts"). */
export const completionFacts: Readonly<Record<string, string>> = {
  required: "the trusted fold lists it as required",
  membershipComplete: "the latest membership statement is complete",
  mergedIntoTarget: "its merge commit is contained in the live target branch",
  notYetMerged: "it is open or draft",
  mergedOffTarget: "it is merged, but its merge commit is not contained in the target branch",
  closedUnmerged: "it is closed without merge",
  evidenceUnknown: "its live evidence could not be established",
  recordsUnknown: "the delivery record history is not fully known",
  attestRecord: "a trusted attestation record exists",
  issueOpen: "the issue is open",
};

const renderAtom = (a: Atom): string => `${a.negated ? "not " : ""}${a.pred}(${a.args.join(", ")})`;
/** The Datalog text of a rule set, one clause per line (the contract's EDN-style cross-check). */
export const renderDatalog = (clauses: readonly Clause[]): string =>
  clauses.map((c) => `${renderAtom(c.head)} :- ${c.body.map(renderAtom).join(", ")}.`).join("\n");

export type Tuples = Map<string, string[][]>;
/**
 * A minimal non-recursive Datalog evaluator over ground tuples. Clauses run in order; a clause
 * may use (positively or negated) only predicates that no later clause defines, so one ordered
 * pass is the stratified fixpoint. Throws when the order would break that guarantee.
 */
export function deriveDatalog(clauses: readonly Clause[], base: Tuples): Tuples {
  const db: Tuples = new Map([...base].map(([k, v]) => [k, [...v]]));
  clauses.forEach((c, i) => {
    for (const a of c.body)
      if (clauses.slice(i).some((later) => later.head.pred === a.pred))
        throw new Error(`clause ${i + 1} uses ${a.pred} before it is fully derived`);
  });
  const isVar = (t: string) => /^[A-Z]/.test(t);
  const match = (a: Atom, tuple: string[], b: Record<string, string>) => {
    const next = { ...b };
    for (let i = 0; i < a.args.length; i++) {
      const t = a.args[i];
      if (t === "_") continue;
      if (!isVar(t)) {
        if (t !== tuple[i]) return null;
      } else if (t in next) {
        if (next[t] !== tuple[i]) return null;
      } else next[t] = tuple[i];
    }
    return next;
  };
  for (const c of clauses) {
    let bindings: Record<string, string>[] = [{}];
    for (const a of c.body.filter((x) => !x.negated))
      bindings = bindings.flatMap((b) =>
        (db.get(a.pred) ?? []).flatMap((tuple) => {
          const m = match(a, tuple, b);
          return m ? [m] : [];
        }),
      );
    for (const a of c.body.filter((x) => x.negated))
      bindings = bindings.filter((b) => !(db.get(a.pred) ?? []).some((t) => match(a, t, b)));
    const out = db.get(c.head.pred) ?? [];
    const seen = new Set(out.map((t) => JSON.stringify(t)));
    for (const b of bindings) {
      const tuple = c.head.args.map((t) => b[t] ?? t);
      if (!seen.has(JSON.stringify(tuple))) {
        seen.add(JSON.stringify(tuple));
        out.push(tuple);
      }
    }
    db.set(c.head.pred, out);
  }
  return db;
}

/** Action rules over the derived predicates (doc "Action rules", the completion subset). */
export interface ActionRule {
  id: string;
  modality: "may" | "must" | "must_not" | "inspect";
  action: string;
  when: string[];
  reason: string;
}
export const completionActionRules: readonly ActionRule[] = [
  {
    id: "L3",
    modality: "may",
    action: "complete",
    when: ["delivered", "issueOpen"],
    reason: "Delivery verified; record completion so dependants unblock.",
  },
  {
    id: "L4",
    modality: "inspect",
    action: "complete",
    when: ["unknown"],
    reason: "Delivery evidence is unknown; re-read it before deciding.",
  },
  {
    id: "L5",
    modality: "must_not",
    action: "complete",
    when: ["undelivered"],
    reason: "A required deliverable is observed open, closed unmerged or merged off target.",
  },
  {
    id: "L5a",
    modality: "must_not",
    action: "complete",
    when: ["unknown"],
    reason: "Delivery cannot be verified; re-read the unknown evidence.",
  },
];

// ---------------------------------------------------------------------------------------------
// Facts and the pure evaluator.

/** Live state of one required member; every state but `unknown` is positive evidence. */
export type MemberState =
  | "draft"
  | "open"
  | "merged"
  | "merged-off-target"
  | "closed-unmerged"
  | "unknown";
export interface MemberEvidence {
  key: string;
  label: string;
  deliverable: Deliverable;
  /** The recorded intended target, as `owner/name:branch` or `(default branch)`. */
  target: string;
  state: MemberState;
  /** The branch the containment compare ran against, when one ran. */
  branch: string | null;
  mergeCommit: string | null;
  /** The compare API status (`identical`, `behind`, `ahead`, `diverged`), when one answered. */
  compare: string | null;
  /** The PR's live base branch: a display hint only, never containment evidence. */
  baseRefName: string | null;
  why: string;
}
export interface DeliveryFacts {
  repository: string;
  issue: number;
  issueOpen: boolean;
  recordsUnknown: boolean;
  unknownBecause: string[];
  membership: "complete" | "open" | null;
  attestRecord: boolean;
  hasTrustedRecord: boolean;
  /** A trusted v1 `done` handoff exists and no trusted delivery record does. */
  legacyHandoff: boolean;
  members: MemberEvidence[];
  coverage: { complete: boolean; requests: number; omissions: string[] };
}

export type TicketDelivery =
  | "unknown"
  | "delivered"
  | "attested"
  | "partial"
  | "submitted"
  | "legacy"
  | "none";
export interface DeliveryEvaluation {
  delivery: TicketDelivery;
  perDeliverable: { deliverable: string; target: string; state: MemberState; why: string }[];
  /** Why the verdict holds, or which clause failed and on what positive evidence. */
  because: string[];
  /** Evidence a higher-precedence verdict outranked (an applicable attestation under delivered). */
  overrides: string[];
  /** The derived predicates for the ticket (cross-check and display). */
  derived: Record<string, boolean>;
  /** Action rules whose conditions hold. */
  actions: ActionRule[];
}

const positive: Record<Exclude<MemberState, "unknown">, string> = {
  draft: "notYetMerged",
  open: "notYetMerged",
  merged: "mergedIntoTarget",
  "merged-off-target": "mergedOffTarget",
  "closed-unmerged": "closedUnmerged",
};

/** The ground tuples the predicates run over, for one ticket `t`. */
export function deliveryTuples(facts: DeliveryFacts): Tuples {
  const t = "t";
  const db: Tuples = new Map();
  const add = (pred: string, ...args: string[]) => db.set(pred, [...(db.get(pred) ?? []), args]);
  for (const m of facts.members) {
    add("required", t, m.key);
    add(m.state === "unknown" ? "evidenceUnknown" : positive[m.state], m.key);
  }
  if (facts.recordsUnknown || !facts.coverage.complete) add("recordsUnknown", t);
  if (facts.membership === "complete") add("membershipComplete", t);
  if (facts.attestRecord) add("attestRecord", t);
  return db;
}

/**
 * Pure evaluation of collected facts. Only positive evidence yields a negative verdict; anything
 * unknown makes the ticket `unknown`, which outranks every other verdict.
 */
export function evaluateDelivery(facts: DeliveryFacts): DeliveryEvaluation {
  const db = deriveDatalog(completionPredicates, deliveryTuples(facts));
  const holds = (pred: string) => (db.get(pred) ?? []).length > 0;
  const derived: Record<string, boolean> = {};
  for (const p of [
    "unknown",
    "memberUnknown",
    "recordsUnknown",
    "undelivered",
    "hasMember",
    "delivered",
    "attestApplies",
    "attested",
    "partial",
    "membershipComplete",
  ])
    derived[p] = holds(p);
  derived.issueOpen = facts.issueOpen;
  const outstanding = facts.members.filter((m) => m.state !== "merged" && m.state !== "unknown");
  const unknownMembers = facts.members.filter((m) => m.state === "unknown");
  const because: string[] = [];
  const overrides: string[] = [];
  let delivery: TicketDelivery;
  if (derived.unknown) {
    delivery = "unknown";
    because.push(
      ...facts.unknownBecause,
      ...facts.coverage.omissions,
      ...unknownMembers.map((m) => `${m.label}: ${m.why}`),
    );
  } else if (derived.delivered) {
    delivery = "delivered";
    because.push(
      `membership is complete and every required member (${facts.members.length}) is contained in its live target branch`,
    );
    if (derived.attested)
      overrides.push(
        "an applicable attestation exists; verified delivery takes precedence and the attestation is retained as supporting evidence",
      );
  } else if (derived.attested) {
    delivery = "attested";
    because.push(
      facts.members.length
        ? "a trusted attestation applies: membership is complete and every member is contained in its target"
        : "a trusted attestation applies to an empty, complete required set (non-code outcome)",
    );
  } else if (derived.partial) {
    delivery = "partial";
  } else if (facts.hasTrustedRecord && (facts.members.length > 0 || facts.membership === "open")) {
    delivery = "submitted";
  } else if (!facts.hasTrustedRecord && facts.legacyHandoff) {
    delivery = "legacy";
    because.push(
      "only a legacy v1 done handoff exists; its membership is unknown and is never inferred",
    );
  } else {
    delivery = "none";
    because.push(
      facts.hasTrustedRecord
        ? "the required set is empty and no applicable attestation exists"
        : "no trusted delivery record exists",
    );
  }
  if (delivery === "partial" || delivery === "submitted") {
    for (const m of outstanding) because.push(`${m.label} is not delivered: ${m.why}`);
    if (facts.membership !== "complete")
      because.push(
        `membership is ${facts.membership ?? "not stated"}, not complete: more deliverables may be expected`,
      );
  }
  if (facts.attestRecord && !derived.attested && delivery !== "unknown")
    because.push(
      "a trusted attestation exists but does not apply: it never stands in for an outstanding member or open membership",
    );
  const actions = completionActionRules.filter((r) => r.when.every((w) => derived[w]));
  return {
    delivery,
    perDeliverable: facts.members.map((m) => ({
      deliverable: m.label,
      target: m.target,
      state: m.state,
      why: m.why,
    })),
    because,
    overrides,
    derived,
    actions,
  };
}

// ---------------------------------------------------------------------------------------------
// Live fact collection.

/** Required members read at most per evaluation; a larger set is unknown, never partly judged. */
export const deliveryMemberCap = 20;

const prLink = (d: Extract<Deliverable, { kind: "pr" }>) =>
  `https://github.com/${d.repository}/pull/${d.number}`;

/**
 * Collects live evidence for every required member of `fold`. Each PR is read by its recorded
 * identity; each merged PR's merge commit and each commit member is compared against the live
 * head of its intended target branch. A default branch is read live once per target repository
 * per collection (never from a record or an earlier read). Any failed or inconclusive read makes
 * that member `unknown`. Requests: one PR read per PR member, one compare per merged PR or
 * commit member, one default-branch read per distinct target repository with no branch.
 */
export async function collectDeliveryFacts(
  input: {
    repository: string;
    issue: number;
    issueOpen: boolean;
    fold: DeliveryFold;
    legacyHandoff: boolean;
  },
  rt: Pick<DeliverablesRuntime, "query" | "rest">,
): Promise<DeliveryFacts> {
  let requests = 0;
  const counted: Pick<DeliverablesRuntime, "query" | "rest"> = {
    query: (q, v) => {
      requests++;
      return rt.query(q, v);
    },
    rest: (p, o) => {
      requests++;
      return rt.rest(p, o);
    },
  };
  const branches = new Map<string, Promise<string | null>>();
  const branchOf = (repository: string) => {
    const key = repository.toLowerCase();
    if (!branches.has(key)) branches.set(key, defaultBranch(repository, counted.query));
    return branches.get(key)!;
  };
  const { fold } = input;
  const omissions: string[] = [];
  const over = fold.members.length > deliveryMemberCap;
  if (over)
    omissions.push(
      `${fold.members.length} required members exceed the cap of ${deliveryMemberCap}; their evidence was not read`,
    );
  const members: MemberEvidence[] = [];
  for (const m of fold.members) {
    const d = m.deliverable;
    const base = {
      key: deliverableKey(d),
      label: deliverableLabel(d),
      deliverable: d,
      target: targetLabel(d.target),
      branch: null,
      mergeCommit: null,
      compare: null,
      baseRefName: null,
    };
    if (over) {
      members.push({ ...base, state: "unknown", why: "not read: the member cap was exceeded" });
      continue;
    }
    if (d.kind === "commit") {
      const c = await targetContainment(d.target, d.oid, counted, branchOf);
      members.push({
        ...base,
        branch: c.branch,
        mergeCommit: d.oid,
        compare: c.status,
        state:
          c.state === "contained"
            ? "merged"
            : c.state === "absent"
              ? "merged-off-target"
              : "unknown",
        why: `commit ${c.why}`,
      });
      continue;
    }
    const live = await readPr(prLink(d), counted.query);
    if (!live || live.number !== d.number) {
      members.push({
        ...base,
        state: "unknown",
        why: "the pull request could not be read (missing, inaccessible or rate-limited)",
      });
      continue;
    }
    const baseRefName = live.baseRefName ?? null;
    if (live.state === "OPEN") {
      members.push({
        ...base,
        baseRefName,
        state: live.isDraft ? "draft" : "open",
        why: live.isDraft ? "it is an open draft" : "it is open, not merged",
      });
      continue;
    }
    if (live.state === "CLOSED" && !live.merged) {
      members.push({
        ...base,
        baseRefName,
        state: "closed-unmerged",
        why: "it was closed without merge",
      });
      continue;
    }
    if (live.state === "MERGED" || live.merged) {
      const oid = live.mergeCommit?.oid;
      if (!oid) {
        members.push({
          ...base,
          baseRefName,
          state: "unknown",
          why: "it is merged but GitHub reports no merge commit, so containment cannot be checked",
        });
        continue;
      }
      // No same-base shortcut: containment is decided only by this live compare.
      const c = await targetContainment(d.target, oid, counted, branchOf);
      members.push({
        ...base,
        baseRefName,
        branch: c.branch,
        mergeCommit: oid,
        compare: c.status,
        state:
          c.state === "contained"
            ? "merged"
            : c.state === "absent"
              ? "merged-off-target"
              : "unknown",
        why: `merge commit ${oid.slice(0, 12)} ${c.why}${c.state !== "contained" ? ` (merged into base ${baseRefName ?? "unknown"})` : ""}`,
      });
      continue;
    }
    members.push({
      ...base,
      baseRefName,
      state: "unknown",
      why: `unexpected pull request state ${live.state}`,
    });
  }
  return {
    repository: input.repository,
    issue: input.issue,
    issueOpen: input.issueOpen,
    recordsUnknown: fold.recordsUnknown,
    unknownBecause: fold.unknownBecause,
    membership: fold.membership,
    attestRecord: fold.attestRecord,
    hasTrustedRecord: fold.hasTrustedRecord,
    legacyHandoff: input.legacyHandoff,
    members,
    coverage: { complete: !over, requests, omissions },
  };
}

// ---------------------------------------------------------------------------------------------
// Evaluation revision and effective completion.

/**
 * The effective required set, targets, membership and responsibility of a fold, plus the last
 * non-complete record applied: any record written after an evaluation changes it, so `complete`
 * can tell that the delivery it evaluated is still the delivery it is about to close. A
 * `complete` record itself does not change it (a pending completion ends nothing).
 */
export function evaluationRevision(fold: DeliveryFold): string {
  const last = fold.applied.filter((a) => a.op !== "complete").at(-1)?.comment ?? null;
  return createHash("sha256")
    .update(
      JSON.stringify([
        fold.members
          .map((m) => [
            deliverableKey(m.deliverable),
            m.deliverable.target.repository.toLowerCase(),
            m.deliverable.target.branch,
            m.responsible,
            m.responsibilityRecord,
          ])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
        fold.membership,
        fold.ticketResponsible,
        fold.ticketResponsibilityRecord,
        last,
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}

export interface CompletionEffect {
  comment: string;
  agent: string;
  effective: boolean;
  why: string;
}
/**
 * Which `complete` records are effective (doc "Effective completion"): the issue is closed, no
 * trusted `membership open` record was created after the record's `evaluatedAt`, and the fold's
 * current revision still equals the revision the record evaluated. Anything else is inert: an
 * audit entry that ends nothing.
 */
export function completionEffects(
  records: ClassifiedRecord[],
  fold: DeliveryFold,
  issueClosed: boolean,
): CompletionEffect[] {
  const revision = evaluationRevision(fold);
  const trusted = records.filter(
    (r): r is ClassifiedRecord & { status: "trusted" } => r.status === "trusted",
  );
  return trusted
    .filter((r) => r.record.op === "complete")
    .map((r) => {
      const at = Date.parse(r.record.evaluatedAt ?? "");
      const reopened = trusted.find(
        (o) =>
          o.record.op === "membership" &&
          o.record.membership === "open" &&
          Date.parse(o.comment.createdAt) > at,
      );
      const comment = String(r.comment.databaseId);
      const why = !issueClosed
        ? "the issue is open"
        : reopened
          ? `membership was reopened after its evaluation (comment ${reopened.comment.databaseId})`
          : r.record.evaluationRevision !== revision
            ? "the required set, targets, membership or responsibility changed after its evaluation"
            : "the issue is closed and the evaluated delivery is unchanged";
      return {
        comment,
        agent: r.record.agent,
        effective: issueClosed && !reopened && r.record.evaluationRevision === revision,
        why,
      };
    });
}

/** Responsibility after effective completion: an effective `complete` ends all of it. */
export function effectiveResponsibility(
  fold: DeliveryFold,
  effects: CompletionEffect[],
): {
  ticketResponsible: string | null;
  members: { deliverable: string; responsible: string | null }[];
} {
  const ended = effects.some((e) => e.effective);
  return {
    ticketResponsible: ended ? null : fold.ticketResponsible,
    members: fold.members.map((m) => ({
      deliverable: deliverableLabel(m.deliverable),
      responsible: ended ? null : m.responsible,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// The `complete` command.

export interface CompleteRequest {
  number: number;
  agent: string;
}
export interface CompleteFacts {
  number: number;
  url?: string;
  title?: string;
  state?: string;
  stateReason?: string | null;
  /** The GitHub actor of the latest close, reported as a login only, never "a human". */
  closedBy?: string | null;
  claims?: string[];
  delivery?: TicketDelivery;
  membership?: "complete" | "open" | null;
  ticketResponsible?: string | null;
  members?: { deliverable: string; target: string; state: MemberState; why: string }[];
  recordsUnknown?: boolean;
  unknownBecause?: string[];
  evaluatedAt?: string;
  evaluationRevision?: string;
  completions?: CompletionEffect[];
  /** GitHub requests made for member evidence on this read. */
  evidenceRequests?: number;
}
export interface CompleteRefusal {
  ok: false;
  error: string;
  facts: CompleteFacts;
  prerequisite: string;
  recovery: string[];
  evaluation?: DeliveryEvaluation;
}
export interface CompleteAccepted {
  ok: true;
  noop: boolean;
  reason?: string;
  facts: CompleteFacts;
  evaluation?: DeliveryEvaluation;
  /** The `complete` record this plan writes (absent when it is already posted). */
  record?: DeliveryRecord;
  /** The opId of this operation's record, posted or planned. */
  opId?: string;
  changes: PlanStep[];
  notes: string[];
  /** The close was not made by this run: the issue was already closed by someone else. */
  closeSkipped?: string | null;
  /** The posted record could not be confirmed on re-read. */
  unverified?: string | null;
  retry: string;
}
export type CompletePlan = CompleteRefusal | CompleteAccepted;
export type CompleteResult = CompletePlan & {
  steps?: PlanStep[];
  closeSkipped?: string | null;
  unverified?: string | null;
  exitCode: number;
};

interface CompleteIssue {
  __typename: "Issue";
  number: number;
  title: string;
  url: string;
  state: string;
  stateReason?: string | null;
  labels: { nodes: { name: string }[]; pageInfo?: { hasNextPage?: boolean } };
  timelineItems?: { nodes: { actor?: { login?: string } | null }[] };
  comments: {
    nodes: DeliveryComment[];
    pageInfo?: { hasPreviousPage?: boolean; startCursor?: string | null };
  };
}
async function readCompleteIssue(repository: string, number: number, rt: DeliverablesRuntime) {
  const [owner, name] = repository.split("/");
  const data = (await rt.query(
    `query($owner:String!,$name:String!,$number:Int!){viewer{__typename login} repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){__typename ... on PullRequest{url} ... on Issue{number title url state stateReason labels(first:100){nodes{name} pageInfo{hasNextPage}} timelineItems(itemTypes:[CLOSED_EVENT],last:1){nodes{... on ClosedEvent{actor{login}}}} comments(last:100){nodes{${deliveryCommentFields}} pageInfo{hasPreviousPage startCursor}}}}}}`,
    { owner, name, number },
  )) as {
    viewer?: { __typename?: string; login?: string } | null;
    repository: {
      issueOrPullRequest: CompleteIssue | { __typename: "PullRequest"; url: string } | null;
    } | null;
  };
  if (!data.repository) throw new Error(`Repository unavailable: ${repository}`);
  return { viewer: data.viewer ?? null, item: data.repository.issueOrPullRequest };
}

const snapshotOf = (m: MemberEvidence): EvidenceSnapshot => ({
  deliverable: m.label,
  state: m.state,
  target: m.target,
  branch: m.branch,
  mergeCommit: m.mergeCommit,
  compare: m.compare,
});

/** The exact, runnable command for a `complete` request. */
export const completeCommand = (repository: string, r: CompleteRequest): string =>
  `github-triage complete ${r.number} --agent ${r.agent} --repo ${repository}`;

/**
 * Plan `complete N`. Reads only; `applyComplete` writes. With `resume`, the run has posted its
 * record (identified by opId): this is the contract's step 3, a fresh re-read of claims, records
 * and every member's evidence and a second evaluation, compared with the posted record's
 * evaluation revision before anything is closed.
 */
export async function planComplete(
  repository: string,
  request: CompleteRequest,
  rt: DeliverablesRuntime,
  resume?: { opId: string; closedByRun: boolean },
): Promise<CompletePlan> {
  const { number, agent } = request;
  const cmd = (text: string): string => `github-triage ${text} --repo ${repository}`;
  const retry = completeCommand(repository, request);
  const inspect = cmd(`--issue ${number}`);
  const written = (own: string | null) =>
    own ? `Completion record written (comment ${own}), close skipped: ` : "";
  let ownComment: string | null = null;
  const refuse = (
    error: string,
    facts: CompleteFacts,
    prerequisite: string,
    recovery: string[],
    evaluation?: DeliveryEvaluation,
  ): CompleteRefusal => ({
    ok: false,
    error,
    facts,
    prerequisite: `${written(ownComment)}${prerequisite}`,
    recovery,
    ...(evaluation ? { evaluation } : {}),
  });

  // The time of this read is the evaluation time recorded as `evaluatedAt`.
  const evaluatedAt = rt.now().toISOString();
  let read: Awaited<ReturnType<typeof readCompleteIssue>>;
  try {
    read = await readCompleteIssue(repository, number, rt);
  } catch (error) {
    return refuse(
      "EVIDENCE_INCOMPLETE",
      { number },
      `#${number} could not be read (${error instanceof Error ? error.message : "unknown error"}); nothing is changed.`,
      [retry],
    );
  }
  const item = read.item;
  if (!item)
    return refuse("TICKET_NOT_FOUND", { number }, `#${number} must exist.`, [cmd("--json")]);
  if (item.__typename !== "Issue")
    return refuse(
      "NOT_AN_ISSUE",
      { number, url: item.url },
      "Completion is recorded on the issue the pull request addresses.",
      [cmd(`pr ${number}`)],
    );
  const labels = item.labels.nodes.map((l) => l.name);
  const claims = labels
    .filter((l) => l.startsWith(workflow.ownerPrefix))
    .map((l) => l.slice(workflow.ownerPrefix.length));
  const closed = item.state !== "OPEN";
  const closedBy = closed ? (item.timelineItems?.nodes.at(-1)?.actor?.login ?? null) : null;
  const base: CompleteFacts = {
    number,
    url: item.url,
    title: item.title,
    state: item.state,
    stateReason: item.stateReason ?? null,
    closedBy,
    claims,
  };
  if (item.labels.pageInfo?.hasNextPage)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      base,
      "More than 100 labels; active claims cannot be verified, so nothing is changed.",
      [inspect, cmd(`who ${number}`)],
    );

  // The record's author is the authenticated account; it must pass the #212 rule.
  const viewer = read.viewer;
  const self: Comment = {
    body: "",
    author: viewer ?? undefined,
    lastEditedAt: null,
    includesCreatedEdit: false,
    editor: null,
  };
  const authority = viewer?.login
    ? await rt.trust(self)
    : { status: "unknown" as const, why: "the authenticated account could not be read" };
  if (authority.status !== "trusted")
    return refuse(
      "MARKER_UNVERIFIED",
      base,
      `The authenticated account ${viewer?.login ?? "(unknown)"} must be a user with current write, maintain or admin permission on ${repository} to record completion (${authority.why}); nothing is changed.`,
      [cmd(`who ${number}`), retry],
    );

  const history = await readDeliveryComments(repository, number, item.comments, rt.query);
  const { records, fold } = await readDeliveryFold(
    history.comments,
    history.complete,
    { repository, issue: number },
    rt.trust,
  );
  const trusted = records.filter(
    (r): r is ClassifiedRecord & { status: "trusted" } => r.status === "trusted",
  );
  const own = resume ? trusted.find((r) => r.record.opId === resume.opId) : undefined;
  ownComment = own ? String(own.comment.databaseId) : null;
  const revision = evaluationRevision(fold);
  const effects = completionEffects(records, fold, closed);
  const facts: CompleteFacts = {
    ...base,
    membership: fold.membership,
    ticketResponsible: effectiveResponsibility(fold, effects).ticketResponsible,
    recordsUnknown: fold.recordsUnknown,
    unknownBecause: fold.unknownBecause,
    evaluatedAt,
    evaluationRevision: revision,
    completions: effects,
  };
  const notes: string[] = [...fold.ignored];

  if (resume && !own)
    return {
      ok: true,
      noop: true,
      reason: `The record posted by this run (opId ${resume.opId}) is not found as a trusted record; nothing more is written.`,
      unverified: `The posted completion record (opId ${resume.opId}) was not found as a trusted record on re-read; the issue was not closed.`,
      facts,
      changes: [],
      notes,
      retry,
    };

  if (fold.refusal)
    return refuse(
      fold.refusal,
      facts,
      `The delivery record history is not fully known (${fold.unknownBecause.join("; ")}), so delivery cannot be verified; nothing is ${ownComment ? "closed" : "changed"}.`,
      fold.refusal === "RECORD_MALFORMED"
        ? [
            inspect,
            ...fold.malformed
              .filter((m) => !fold.voided.includes(m.comment))
              .map((m) =>
                cmd(
                  `deliverables ${number} void --agent ${agent} --comment ${m.comment} --reason TEXT`,
                ),
              ),
          ]
        : [inspect, retry],
    );

  if (claims.length)
    return refuse(
      "CLAIM_HELD",
      facts,
      `${claims.map((h) => `${workflow.ownerPrefix}${h}`).join(", ")} holds an active claim on #${number}; completion is refused while any agent, the caller included, holds a claim, because work (or a rework that may change scope) is in progress. Wait for the claimant to hand the work back, or a maintainer's visible release for an absent holder.`,
      [
        cmd(`who ${number}`),
        ...claims.map((h) => cmd(`release ${number} --agent ${h} --as ready --note TEXT`)),
      ],
    );

  // Step 3 after this run closed the issue: only the recorded label plan remains. Delivery was
  // re-evaluated before the close; it is not re-read again for a label removal.
  if (resume && closed) {
    if (!resume.closedByRun && (own!.record.plan?.remove ?? []).length === 0)
      return {
        ok: true,
        noop: true,
        reason: `Completion recorded (comment ${ownComment}) on #${number}, already closed (${item.stateReason ?? "no reason"}) by ${closedBy ?? "an unknown actor"}; it is never reopened or re-closed.`,
        facts,
        opId: resume.opId,
        changes: [],
        notes,
        retry,
      };
    if (!resume.closedByRun)
      return {
        ok: true,
        noop: true,
        reason: `#${number} was closed by ${closedBy ?? "an unknown actor"} (${item.stateReason ?? "no reason"}) before this run closed it; the close step is skipped and the issue is never reopened.`,
        closeSkipped: `closed by ${closedBy ?? "an unknown actor"} (${item.stateReason ?? "no reason"}) before this run's close`,
        facts,
        changes: [],
        notes,
        retry,
      };
    const remove = (own!.record.plan?.remove ?? []).filter((l) => labels.includes(l));
    return {
      ok: true,
      noop: remove.length === 0,
      reason: remove.length
        ? `#${number} closed as completed; removing ${remove.join(", ")}.`
        : `#${number} closed as completed.`,
      facts,
      opId: resume.opId,
      changes: remove.length
        ? [
            {
              step: "labels",
              command: [
                "issue",
                "edit",
                String(number),
                "--repo",
                repository,
                ...remove.flatMap((l) => ["--remove-label", l]),
              ],
            },
          ]
        : [],
      notes,
      retry,
    };
  }

  if (own && own.record.evaluationRevision !== revision) {
    const since = Date.parse(own.record.evaluatedAt ?? "");
    const changed = trusted.filter(
      (r) => r.record.op !== "complete" && Date.parse(r.comment.createdAt) > since,
    );
    return refuse(
      "DELIVERY_DIVERGED",
      facts,
      `the required set, targets, membership or responsibility changed after the evaluation this record was written on${changed.length ? ` (${changed.map((r) => `${r.record.op} by ${r.record.agent} (${r.login}), comment ${r.comment.databaseId}`).join("; ")})` : ""}. The record stays as an inert audit entry and ends nothing; the changed delivery must be evaluated afresh.`,
      [inspect, retry],
    );
  }

  const legacyHandoff =
    !fold.hasTrustedRecord && !!(await legacyRelease(history.comments, rt.trust)).trusted;
  const collected = await collectDeliveryFacts(
    { repository, issue: number, issueOpen: !closed, fold, legacyHandoff },
    rt,
  );
  const evaluation = evaluateDelivery(collected);
  facts.delivery = evaluation.delivery;
  facts.members = evaluation.perDeliverable;
  facts.evidenceRequests = collected.coverage.requests;

  if (evaluation.delivery === "unknown") {
    const unread = collected.members.filter((m) => m.state === "unknown");
    return refuse(
      fold.refusal ?? "EVIDENCE_INCOMPLETE",
      facts,
      `Delivery cannot be verified: ${evaluation.because.join("; ")}. Unknown evidence is never treated as delivered or as not delivered; re-read it (retry, check access, or restore or retarget a missing target branch). Nothing is ${ownComment ? "closed" : "changed"}.`,
      [
        retry,
        inspect,
        ...unread
          .filter((m) => m.deliverable.kind === "pr")
          .map((m) => {
            const d = m.deliverable as Extract<Deliverable, { kind: "pr" }>;
            return `github-triage pr ${d.number} --repo ${d.repository}`;
          }),
      ],
      evaluation,
    );
  }
  if (evaluation.delivery !== "delivered" && evaluation.delivery !== "attested")
    return refuse(
      "NOT_DELIVERED",
      facts,
      `Delivery is ${evaluation.delivery}, not delivered or an applicable attestation: ${evaluation.because.join("; ")}.`,
      notDeliveredRecovery(),
      evaluation,
    );

  const snapshot = collected.members.map(snapshotOf);
  const deliverables = fold.members.map((m) => m.deliverable);
  const opId = deliveryOpId({
    repository,
    issue: number,
    op: "complete",
    deliverables,
    agent,
    issuedAt: `rev:${revision};${JSON.stringify(snapshot)};${evaluation.delivery}`,
  });
  if (evaluation.overrides.length) notes.push(...evaluation.overrides);
  // Retry detection: a trusted complete record for this exact evaluation is already posted.
  const existing = own ?? trusted.find((r) => r.record.op === "complete" && r.record.opId === opId);
  const existingId = existing ? String(existing.comment.databaseId) : null;
  const plan = { remove: closed ? [] : [claimPolicy.awaitingReview], add: [] as string[] };
  const record: DeliveryRecord = {
    v: 1,
    op: "complete",
    opId,
    repository,
    issue: number,
    agent,
    deliverables,
    ...(fold.membership ? { membership: fold.membership } : {}),
    plan,
    evaluationRevision: revision,
    evaluatedAt,
    verdict: evaluation.delivery,
    snapshot,
    issuedAt: rt.now().toISOString(),
  };
  const recordStep: PlanStep = {
    step: "record",
    command: [
      "issue",
      "comment",
      String(number),
      "--repo",
      repository,
      "--body",
      completionBody(agent, record),
    ],
  };
  if (closed) {
    // Delivered and already closed by anyone: the record only; never reopen, never re-close.
    if (existingId)
      return {
        ok: true,
        noop: true,
        reason: `Completion already recorded (comment ${existingId}); #${number} is closed (${item.stateReason ?? "no reason"}) by ${closedBy ?? "an unknown actor"}, and is never reopened or re-closed.`,
        facts,
        evaluation,
        opId,
        changes: [],
        notes,
        retry,
      };
    notes.push(
      `#${number} is already closed (${item.stateReason ?? "no reason"}) by ${closedBy ?? "an unknown actor"}; only the completion record is written. It is never reopened or re-closed.`,
    );
    return {
      ok: true,
      noop: false,
      reason: `Delivery ${evaluation.delivery}; recording completion on the closed issue.`,
      facts,
      evaluation,
      record,
      opId,
      changes: [recordStep],
      notes,
      retry,
    };
  }
  const closeStep: PlanStep = {
    step: "close",
    command: ["issue", "close", String(number), "--repo", repository, "--reason", "completed"],
  };
  const labelStep: PlanStep[] = labels.includes(claimPolicy.awaitingReview)
    ? [
        {
          step: "labels",
          command: [
            "issue",
            "edit",
            String(number),
            "--repo",
            repository,
            "--remove-label",
            claimPolicy.awaitingReview,
          ],
        },
      ]
    : [];
  return {
    ok: true,
    noop: false,
    reason: existingId
      ? `Delivery ${evaluation.delivery} on fresh evidence; completion is recorded (comment ${existingId}); closing.`
      : `Delivery ${evaluation.delivery} on fresh evidence; recording completion, re-checking, then closing.`,
    facts,
    evaluation,
    ...(existingId ? {} : { record }),
    opId: existing ? existing.record.opId : opId,
    changes: [...(existingId ? [] : [recordStep]), closeStep, ...labelStep],
    notes,
    retry,
  };

  function notDeliveredRecovery(): string[] {
    const out: string[] = [inspect];
    for (const m of collected.members) {
      if (m.state === "merged" || m.deliverable.kind !== "pr") continue;
      const d = m.deliverable;
      const url = prLink(d);
      if (m.state === "open" || m.state === "draft")
        out.push(`github-triage pr ${d.number} --repo ${d.repository}`);
      if (m.state === "merged-off-target")
        out.push(
          cmd(
            `deliverables ${number} retarget --agent ${agent} --pr ${url} --target ${d.target.repository}:BRANCH --reason TEXT`,
          ),
        );
      out.push(cmd(`deliverables ${number} detach --agent ${agent} --pr ${url} --reason TEXT`));
    }
    if (fold.hasTrustedRecord && fold.membership !== "complete")
      out.push(cmd(`deliverables ${number} membership complete --agent ${agent} --reason TEXT`));
    if (!fold.hasTrustedRecord) {
      out.push(
        cmd(`deliverables ${number} attach --legacy --agent ${agent} --pr URL --reason TEXT`),
      );
      out.push(cmd(`deliverables ${number} attest --legacy --agent ${agent} --reason TEXT`));
    }
    return [...new Set(out)];
  }
}

function completionBody(agent: string, record: DeliveryRecord): string {
  const lines = (record.snapshot ?? []).map(
    (s) =>
      `- ${s.deliverable} → ${s.target}: ${s.state}${s.mergeCommit ? ` (${s.mergeCommit.slice(0, 12)}${s.branch ? ` in ${s.branch}` : ""}${s.compare ? `, compare ${s.compare}` : ""})` : ""}`,
  );
  return [
    `Completion record by \`${agent}\` with \`github-triage complete\`: **delivery ${record.verdict}** on evidence read at ${record.evaluatedAt}.`,
    "",
    ...(lines.length ? [...lines, ""] : ["No code deliverable (attested non-code outcome).", ""]),
    deliveryMarker(record),
  ].join("\n");
}

/**
 * Apply a `complete` plan one write at a time, re-planning from a fresh read before every write:
 * the record, then (after the step-3 re-evaluation) the close, then the label. A refusal after the
 * record is written stops without closing and reports "completion record written, close skipped".
 * Exit: 0 done (or nothing to do); 2 record written but not closed, partly done or unverified;
 * 1 refused or nothing done.
 */
export async function applyComplete(
  repository: string,
  request: CompleteRequest,
  rt: DeliverablesRuntime,
  first?: CompletePlan,
): Promise<CompleteResult> {
  const initial = first ?? (await planComplete(repository, request, rt));
  if (!initial.ok) return { ...initial, exitCode: 1 };
  if (initial.noop) return { ...initial, exitCode: 0 };
  const steps: PlanStep[] = [];
  let plan: CompletePlan = initial;
  let fresh = true;
  // The record's identity comes only from what this run wrote or found (#263's posted opId).
  let opId = initial.record ? undefined : initial.opId;
  let closedByRun = false;
  let last: CompleteAccepted = initial;
  for (let i = 0; i < 5; i++) {
    if (!fresh)
      plan = await planComplete(repository, request, rt, opId ? { opId, closedByRun } : undefined);
    fresh = false;
    const done = steps.some((s) => s.status === "done");
    if (!plan.ok) {
      if (!done && !opId) return { ...plan, steps, exitCode: 1 };
      return {
        ...plan,
        steps,
        closeSkipped: closedByRun ? null : "completion record written, close skipped",
        exitCode: 2,
      };
    }
    last = plan;
    const next = plan.changes[0];
    if (!next) break;
    if (next.step === "record" && steps.some((s) => s.step === "record")) {
      return {
        ...plan,
        steps,
        unverified:
          "A fresh plan proposed another completion record after this run's record was posted; nothing more was written. Re-run to see the current state.",
        exitCode: 2,
      };
    }
    const step: PlanStep = { ...next, status: "pending" };
    steps.push(step);
    try {
      await rt.run(step.command);
      step.status = "done";
      if (step.step === "record") opId = plan.record?.opId ?? plan.opId;
      if (step.step === "close") closedByRun = true;
    } catch (error) {
      step.status = "failed";
      step.reason = error instanceof Error ? error.message : undefined;
      return {
        ...plan,
        steps,
        ...(step.step === "close" ? { closeSkipped: "the close failed; re-run to retry it" } : {}),
        exitCode: done || step.step !== "record" ? 2 : 1,
      };
    }
  }
  const exitCode = last.unverified ? 2 : 0;
  return { ...last, steps, exitCode };
}

/** Text rendering for plans, refusals and results. */
export function completeText(result: CompletePlan | CompleteResult, dryRun = false): string {
  const evaluation = result.evaluation;
  const evidence = evaluation
    ? [
        `Delivery: ${evaluation.delivery}`,
        ...evaluation.perDeliverable.map(
          (m) => `  ${m.deliverable} → ${m.target}: ${m.state} (${m.why})`,
        ),
      ]
    : [];
  const steps = ("steps" in result ? result.steps : undefined) ?? [];
  if (!result.ok)
    return (
      [
        `REFUSED ${result.error}: ${result.prerequisite}`,
        `Ticket: ${result.facts.url ?? `#${result.facts.number}`}`,
        ...(result.facts.claims?.length ? [`Claims: ${result.facts.claims.join(", ")}`] : []),
        ...evidence,
        ...steps.map((s) => `- ${s.step}: ${s.status}`),
        ...("closeSkipped" in result && result.closeSkipped
          ? [`CLOSE SKIPPED: ${result.closeSkipped}`]
          : []),
        ...(result.recovery.length ? ["Recovery:", ...result.recovery.map((r) => `  ${r}`)] : []),
      ].join("\n") + "\n"
    );
  const lines = [`${result.facts.url} ${result.facts.title}`, ...evidence];
  if (result.reason) lines.push(result.reason);
  if (dryRun) lines.push("DRY RUN: no changes made.");
  for (const c of steps.length ? steps : result.changes)
    lines.push(
      `- ${c.step}${c.status ? `: ${c.status}` : ""}${c.reason ? ` — ${c.reason}` : ""}`,
      ...(dryRun ? [`    gh ${c.command.map(shellQuote).join(" ")}`] : []),
    );
  for (const n of result.notes) lines.push(`Note: ${n}`);
  if (result.closeSkipped) lines.push(`CLOSE SKIPPED: ${result.closeSkipped}`);
  if (result.unverified) lines.push(`UNVERIFIED: ${result.unverified}`);
  if ("exitCode" in result && result.exitCode !== 0)
    lines.push(`Retry (safe; re-evaluates and completes only the missing steps): ${result.retry}`);
  return lines.join("\n") + "\n";
}

export const completeUsage =
  "Usage: github-triage complete N --agent NAME [--dry-run] [--json] [--repo owner/name]";
export const completeHelp = `${completeUsage}
Verify delivery of issue N from fresh evidence and, only when it holds, record completion and
close the issue as completed (#191, doc/design/delivery-lifecycle.md). Delivery is "delivered"
when the trusted required set is non-empty, its membership complete, and every member's merge
commit (or commit) is contained in the live head of its intended target branch by a compare on
this read; "attested" when a trusted attestation applies. Unknown or unreadable evidence is never
delivered or not delivered.
Order: read claims, records and member evidence; write the complete record (evidence snapshot,
evaluatedAt, evaluationRevision); re-read and evaluate again; close as completed; remove
status:awaiting-review. A change in between leaves the issue open ("completion record written,
close skipped"). An issue already closed by anyone gets the record only. Never reopens or merges.
Refusals: CLAIM_HELD (any agent holds a claim, the caller included), NOT_DELIVERED,
EVIDENCE_INCOMPLETE, DELIVERY_DIVERGED, MARKER_UNVERIFIED, RECORD_MALFORMED, RECORD_UNSUPPORTED,
TICKET_NOT_FOUND, NOT_AN_ISSUE, each with recovery commands. Re-running is safe.
Exit: 0 done (or nothing to do); 2 record written but not closed, partly done or unverified;
1 refused or nothing done.
`;

/** Arguments for `complete N ...`; throws a usage error for anything invalid. */
export function completeArguments(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      json: { type: "boolean" },
      "dry-run": { type: "boolean" },
      agent: { type: "string" },
    },
  });
  const [n, ...extra] = positionals;
  const number = /^[1-9]\d*$/.test(n ?? "") ? Number(n) : null;
  if (!number || extra.length || !values.agent || !/^[A-Za-z0-9][\w.-]*$/.test(values.agent))
    throw new Error(completeUsage);
  if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    throw new Error("--repo must be owner/name.");
  return {
    request: { number, agent: values.agent } satisfies CompleteRequest,
    repo: values.repo,
    json: !!values.json,
    dryRun: !!values["dry-run"],
  };
}
