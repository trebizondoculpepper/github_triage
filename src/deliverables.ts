/**
 * `deliverables N attach | detach | retarget | handoff | membership | attest | reassign | reset |
 * void` (#189, doc/design/delivery-lifecycle.md "Transitions and commands", "Legacy attachment",
 * "Legacy attestation" and "Maintainer override").
 *
 * Each command reads the issue and its whole comment history live, folds the delivery records
 * (src/delivery.ts), checks the contract's prerequisites and either refuses with a stable error
 * ID, facts, the failed prerequisite and recovery commands, or plans its writes. Writes go through
 * the injected `gh` boundary in contract order: the delivery record first, then any label change.
 * Before every write the issue is read and folded again and the plan recomputed, so a write is
 * only ever made on fresh evidence and a retry completes only what is missing.
 */
import { parseArgs } from "node:util";
import { workflow } from "./briefing.js";
import { claimPolicy, shellQuote } from "./claims.js";
import type { Comment, GhRun, GraphQuery, PlanStep } from "./claims.js";
import {
  attestApplicability,
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
  DeliveryOp,
  DeliveryRecord,
  DeliveryTarget,
  MemberObservation,
  TrustDecision,
} from "./delivery.js";
import type { Rest } from "./github.js";

export const deliverablesActions = [
  "attach",
  "detach",
  "retarget",
  "handoff",
  "membership",
  "attest",
  "reassign",
  "reset",
  "void",
] as const;
export type DeliverablesAction = (typeof deliverablesActions)[number];

export interface DeliverablesRequest {
  number: number;
  action: DeliverablesAction;
  agent: string;
  /** Pull request URLs (`attach` may name several; the others exactly one). */
  prs: string[];
  /** `owner/name@SHA` commit deliverables (`attach --legacy` only). */
  commits: string[];
  /** Explicit `--target owner/name:branch`, or null for the issue repository's default branch. */
  target: DeliveryTarget | null;
  reason: string | null;
  to: string | null;
  membership: "complete" | "open" | null;
  legacy: boolean;
  evidence: string | null;
  /** `void --comment ID`. */
  comment: string | null;
  /** `reset --as ready|incomplete`. */
  as: "ready" | "incomplete" | null;
}

/** Injected boundaries: GraphQL reads, `gh` writes, REST reads, the authority rule and a clock. */
export interface DeliverablesRuntime {
  query: GraphQuery;
  run: GhRun;
  rest: Rest;
  trust: TrustDecision;
  now: () => Date;
}

export interface DeliverablesFacts {
  number: number;
  url?: string;
  title?: string;
  state?: string;
  /** Agents holding an active `agent:` claim on the issue. */
  claims?: string[];
  ticketResponsible?: string | null;
  membership?: "complete" | "open" | null;
  members?: { deliverable: string; target: string; responsible: string | null }[];
  recordsUnknown?: boolean;
  unknownBecause?: string[];
  pullRequests?: string[];
}
export interface DeliverablesRefusal {
  ok: false;
  error: string;
  facts: DeliverablesFacts;
  prerequisite: string;
  recovery: string[];
}
export interface DeliverablesAccepted {
  ok: true;
  noop: boolean;
  reason?: string;
  facts: DeliverablesFacts;
  /** The delivery record this plan writes (absent when the record is already posted). */
  record?: DeliveryRecord;
  changes: PlanStep[];
  notes: string[];
  /** Exact command that safely retries or completes this operation. */
  retry: string;
}
export type DeliverablesPlan = DeliverablesRefusal | DeliverablesAccepted;
export type DeliverablesResult = DeliverablesPlan & {
  steps?: PlanStep[];
  /** A posted handoff that the re-read fold rejected (HANDOFF_STALE), or other post-write news. */
  conflict?: string | null;
  unverified?: string | null;
  exitCode: number;
};

/** Comment pages read at most (100 each), so a long discussion costs a bounded number of requests. */
export const deliveryCommentPages = 10;

const commentFields =
  "databaseId url body createdAt author{__typename login} lastEditedAt includesCreatedEdit editor{__typename login}";
interface CommentPage {
  nodes: DeliveryComment[];
  pageInfo?: { hasPreviousPage?: boolean; startCursor?: string | null };
}
interface IssueRead {
  __typename: "Issue";
  number: number;
  title: string;
  url: string;
  state: string;
  labels: { nodes: { name: string }[]; pageInfo?: { hasNextPage?: boolean } };
  closedByPullRequestsReferences: {
    nodes: { number: number; url: string; state: string }[];
    pageInfo?: { hasNextPage?: boolean };
  };
  comments: CommentPage;
}
interface IssueResponse {
  viewer?: { __typename?: string; login?: string } | null;
  repository: {
    issueOrPullRequest: IssueRead | { __typename: "PullRequest"; url: string } | null;
  } | null;
}

/**
 * Paged comment reader for the delivery fold. Reads the newest page with the issue, then older
 * pages until history starts, `enough` holds on trusted evidence, or the page bound is reached.
 * Comment ids and creation times are kept, because the fold orders by them. `complete` false
 * means older comments are unseen: the fold must treat that as unknown, never as absence.
 */
export async function readDeliveryComments(
  repository: string,
  number: number,
  first: CommentPage,
  query: GraphQuery,
  enough: (comments: DeliveryComment[]) => boolean | Promise<boolean> = () => false,
  bound = deliveryCommentPages,
): Promise<{ comments: DeliveryComment[]; complete: boolean; pages: number }> {
  let comments = first.nodes;
  let info = first.pageInfo;
  let pages = 1;
  const [owner, name] = repository.split("/");
  while (info?.hasPreviousPage) {
    if (await enough(comments)) return { comments, complete: true, pages };
    if (!info.startCursor || pages >= bound) return { comments, complete: false, pages };
    const data = (await query(
      `query($owner:String!,$name:String!,$number:Int!,$before:String!){repository(owner:$owner,name:$name){issue(number:$number){comments(last:100,before:$before){nodes{${commentFields}} pageInfo{hasPreviousPage startCursor}}}}}`,
      { owner, name, number, before: info.startCursor },
    )) as { repository: { issue: { comments: CommentPage } | null } | null };
    const older = data.repository?.issue?.comments;
    if (!older) return { comments, complete: false, pages };
    comments = [...older.nodes, ...comments];
    info = older.pageInfo;
    pages++;
  }
  // No pageInfo at all is not evidence that history started.
  return { comments, complete: !!info, pages };
}

async function readIssue(repository: string, number: number, query: GraphQuery) {
  const [owner, name] = repository.split("/");
  const data = (await query(
    `query($owner:String!,$name:String!,$number:Int!){viewer{__typename login} repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){__typename ... on PullRequest{url} ... on Issue{number title url state labels(first:100){nodes{name} pageInfo{hasNextPage}} closedByPullRequestsReferences(first:20,includeClosedPrs:false){nodes{number url state} pageInfo{hasNextPage}} comments(last:100){nodes{${commentFields}} pageInfo{hasPreviousPage startCursor}}}}}}`,
    { owner, name, number },
  )) as IssueResponse;
  if (!data.repository) throw new Error(`Repository unavailable: ${repository}`);
  return { viewer: data.viewer ?? null, item: data.repository.issueOrPullRequest };
}

const prUrl = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/?$/;
const commitRef = /^([\w.-]+\/[\w.-]+)@([0-9a-f]{7,40})$/i;
const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

interface LivePr {
  id: string;
  number: number;
  url: string;
  state: string;
  merged: boolean;
  mergeCommit: { oid: string } | null;
  headRefOid: string;
  baseRefName: string;
  baseRepository: { nameWithOwner: string; defaultBranchRef: { name: string } | null } | null;
  closingIssuesReferences?: {
    nodes: { number: number; repository: { nameWithOwner: string } }[];
  };
}
async function readPr(url: string, query: GraphQuery): Promise<LivePr | null> {
  try {
    const data = (await query(
      `query($url:URI!){resource(url:$url){__typename ... on PullRequest{id number url state merged mergeCommit{oid} headRefOid baseRefName baseRepository{nameWithOwner defaultBranchRef{name}} closingIssuesReferences(first:50){nodes{number repository{nameWithOwner}}}}}}`,
      { url },
    )) as { resource: ({ __typename: string } & Partial<LivePr>) | null };
    const r = data.resource;
    if (r?.__typename !== "PullRequest" || !r.id || !r.state || !r.baseRefName || !r.baseRepository)
      return null;
    return r as LivePr;
  } catch {
    return null;
  }
}
async function defaultBranch(repository: string, query: GraphQuery): Promise<string | null> {
  const [owner, name] = repository.split("/");
  try {
    const data = (await query(
      `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){defaultBranchRef{name}}}`,
      { owner, name },
    )) as { repository: { defaultBranchRef: { name: string } | null } | null };
    return data.repository?.defaultBranchRef?.name ?? null;
  } catch {
    return null;
  }
}
async function readCommit(repository: string, oid: string, query: GraphQuery) {
  const [owner, name] = repository.split("/");
  try {
    const data = (await query(
      `query($owner:String!,$name:String!,$oid:String!){repository(owner:$owner,name:$name){nameWithOwner object(expression:$oid){__typename ... on Commit{oid}}}}`,
      { owner, name, oid },
    )) as {
      repository: { nameWithOwner: string; object: { __typename: string; oid?: string } | null };
    } | null;
    const object = data?.repository?.object;
    return object?.__typename === "Commit" && object.oid
      ? { repository: data!.repository.nameWithOwner, oid: object.oid }
      : null;
  } catch {
    return null;
  }
}

/**
 * Live containment of a commit in the target branch head (the compare API): contained is
 * `merged`; positively not contained is `outstanding`; anything else is `unknown`.
 */
async function contained(
  target: DeliveryTarget,
  oid: string,
  rt: DeliverablesRuntime,
): Promise<MemberObservation> {
  const branch = target.branch ?? (await defaultBranch(target.repository, rt.query));
  if (!branch) return "unknown";
  try {
    const answer = await rt.rest(
      `repos/${target.repository}/compare/${encodeURIComponent(branch)}...${oid}`,
    );
    const status =
      answer.status === 200 && typeof answer.body === "object" && answer.body !== null
        ? (answer.body as { status?: unknown }).status
        : undefined;
    if (status === "identical" || status === "behind") return "merged";
    if (status === "ahead" || status === "diverged") return "outstanding";
    return "unknown";
  } catch {
    return "unknown";
  }
}
/** Live state of one member for attestation applicability; only positive evidence decides. */
async function observe(d: Deliverable, rt: DeliverablesRuntime): Promise<MemberObservation> {
  if (d.kind === "commit") return contained(d.target, d.oid, rt);
  const live = await readPr(`https://github.com/${d.repository}/pull/${d.number}`, rt.query);
  if (!live) return "unknown";
  if (live.state === "OPEN") return "outstanding";
  if (live.state === "CLOSED" && !live.merged) return "outstanding";
  if (live.state === "MERGED" || live.merged)
    return live.mergeCommit?.oid ? contained(d.target, live.mergeCommit.oid, rt) : "unknown";
  return "unknown";
}

/** A trusted v1 `done` release record on the issue (doc "Legacy attachment", eligibility). */
async function legacyRelease(
  comments: DeliveryComment[],
  trust: TrustDecision,
): Promise<{ trusted: DeliveryComment | null; unverified: string[] }> {
  const done = comments.filter((c) => {
    for (const m of c.body.matchAll(/<!-- github-triage:release:[0-9a-f]+ /g)) {
      const start = m.index + m[0].length;
      try {
        const r = JSON.parse(c.body.slice(start, c.body.indexOf(" -->", start))) as {
          v?: unknown;
          outcome?: unknown;
        };
        if (r.v === 1 && r.outcome === "done") return true;
      } catch {
        // An unparsable release record never authorises anything.
      }
    }
    return false;
  });
  const unverified: string[] = [];
  for (const c of [...done].reverse()) {
    const authority = await trust(c);
    if (authority.status === "trusted") return { trusted: c, unverified };
    if (authority.status === "unknown")
      unverified.push(`release record ${c.databaseId} (${authority.why})`);
  }
  return { trusted: null, unverified };
}

const reasonRequired = new Set<DeliverablesAction>([
  "detach",
  "retarget",
  "handoff",
  "membership",
  "attest",
  "reassign",
  "reset",
  "void",
]);

/** The record op a request writes. */
const opFor = (r: DeliverablesRequest): DeliveryOp =>
  r.legacy ? (r.action === "attach" ? "legacy-attach" : "legacy-attest") : r.action;

/** The exact command line for a request, as shown in retries and recoveries. */
export function deliverablesCommand(repository: string, r: DeliverablesRequest): string {
  const parts = [`github-triage deliverables ${r.number} ${r.action}`];
  if (r.action === "membership" && r.membership) parts.push(r.membership);
  parts.push(`--agent ${r.agent}`);
  if (r.legacy) parts.push("--legacy");
  for (const p of r.prs) parts.push(`--pr ${shellQuote(p)}`);
  for (const c of r.commits) parts.push(`--commit ${shellQuote(c)}`);
  if (r.target) parts.push(`--target ${shellQuote(targetText(r.target))}`);
  if (r.action !== "membership" && r.membership) parts.push(`--membership ${r.membership}`);
  if (r.to) parts.push(`--to ${r.to}`);
  if (r.as) parts.push(`--as ${r.as}`);
  if (r.comment) parts.push(`--comment ${r.comment}`);
  if (r.evidence) parts.push(`--evidence ${shellQuote(r.evidence)}`);
  if (r.reason) parts.push(`--reason ${shellQuote(r.reason)}`);
  parts.push(`--repo ${repository}`);
  return parts.join(" ");
}
const targetText = (t: DeliveryTarget): string => `${t.repository}:${t.branch ?? ""}`;

/** The label plan a reset `--as` writes, shared by the reset step and retry detection. */
const resetPlan = (as: DeliverablesRequest["as"]): { remove: string[]; add: string[] } => ({
  remove: [claimPolicy.awaitingReview],
  add: [as === "ready" ? workflow.ready : claimPolicy.incomplete],
});

/** The readiness labels a reset chooses between; exactly one is the target of any reset plan. */
const readinessLabels: readonly string[] = [workflow.ready, claimPolicy.incomplete];

/** The labels a reset's plan is judged against: readiness plus the review label it removes. */
const resetRelevantLabels: readonly string[] = [...readinessLabels, claimPolicy.awaitingReview];
/** The reset-relevant subset of a label list, sorted and de-duplicated, for comparison. */
export const resetObserved = (labels: readonly string[]): string[] =>
  [...new Set(labels.filter((l) => resetRelevantLabels.includes(l)))].sort();
const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((l) => b.includes(l));

/** The reset-relevant labels a recorded plan leaves when applied to its observed starting state. */
export const resetPlanResult = (
  plan: { add: string[]; remove: string[] },
  observed: readonly string[],
): string[] =>
  resetObserved([...resetObserved(observed).filter((l) => !plan.remove.includes(l)), ...plan.add]);

/**
 * Whether a recorded reset's label plan is still pending, judged against the reset-relevant labels
 * the reset observed when it was planned (`observedLabels` in its record). Pending means the
 * current relevant labels are the observed starting state, or that state with only some of the
 * plan's removals made and its addition not yet made (the write was interrupted). A record without
 * `observedLabels` (written before the field existed) cannot tell its starting state from later
 * changes, so it is never pending: unknown refuses rather than guessing. Anything else, including
 * readiness changed after the reset finished, is not pending and must not be replayed.
 */
export const resetPlanPending = (
  plan: { add: string[]; remove: string[] },
  observed: readonly string[] | undefined,
  labels: readonly string[],
): boolean => {
  if (!observed) return false;
  const start = resetObserved(observed);
  const current = resetObserved(labels);
  if (sameSet(current, start)) return true;
  const missing = start.filter((l) => !current.includes(l));
  return (
    current.every((l) => start.includes(l)) &&
    missing.every((l) => plan.remove.includes(l)) &&
    !plan.add.some((l) => current.includes(l) && !start.includes(l))
  );
};

/**
 * The fields that define each op: two records with equal values here are the same operation, so
 * a later identical request is a retry. Every op also compares `op` and `agent`. Deliverables
 * compare by identity and target.
 *
 * Excluded everywhere, because they describe or observe an operation rather than define it:
 * `reason` and `evidence` (free text; rewording a retry must not post a second record), `opId`
 * and `issuedAt` (derived per attempt), `login` and `legacyRelease` (read from the authenticated
 * account and history, not chosen by the request), `responsible` (always the caller),
 * `expectedResponsibilityRecord` (the fold the record was planned against), `observedLabels` (the
 * labels a reset started from), `nodeId`/`headOid`
 * (live provenance that may move between attempts) and the evaluation fields.
 */
const definingFields: Record<DeliveryOp, (keyof DeliveryRecord)[]> = {
  submit: ["deliverables", "membership"],
  attach: ["deliverables", "membership"],
  "legacy-attach": ["deliverables", "membership"],
  "legacy-attest": ["deliverables", "membership"],
  detach: ["deliverables"],
  retarget: ["deliverables"],
  handoff: ["deliverables", "to", "scope"],
  membership: ["membership"],
  attest: ["deliverables"],
  complete: ["deliverables"],
  reassign: ["to"],
  reset: ["plan"],
  void: ["voids"],
};
const defining = (rec: Partial<DeliveryRecord> & { op: DeliveryOp }): string =>
  JSON.stringify([
    rec.op,
    rec.agent,
    ...definingFields[rec.op].map((f) => {
      const v = rec[f];
      if (f === "deliverables")
        return (v as Deliverable[])
          .map((d) => [deliverableKey(d), d.target.repository.toLowerCase(), d.target.branch])
          .sort((a, b) => a[0]!.localeCompare(b[0]!));
      return v ?? null;
    }),
  ]);
/** The defining fields a request would write, in record form (see `definingFields`). */
function intended(
  op: DeliveryOp,
  r: DeliverablesRequest,
  deliverables: Deliverable[],
): Partial<DeliveryRecord> & { op: DeliveryOp } {
  return {
    op,
    agent: r.agent,
    deliverables: op === "legacy-attest" ? [] : deliverables,
    membership:
      op === "legacy-attach"
        ? (r.membership ?? "complete")
        : op === "legacy-attest"
          ? "complete"
          : (r.membership ?? undefined),
    to: r.to ?? undefined,
    scope: op === "handoff" ? (deliverables.length ? "deliverable" : "ticket") : undefined,
    voids: r.comment ?? undefined,
    plan: op === "reset" ? resetPlan(r.as) : undefined,
  };
}
/** Ops that neither set nor end responsibility, so they leave a recorded reset's plan standing. */
const resetNeutralOps: ReadonlySet<DeliveryOp> = new Set([
  "membership",
  "detach",
  "retarget",
  "void",
]);
/** Whether a folded record is the one this request would write (retry detection). */
const sameRequest = (rec: DeliveryRecord, want: Partial<DeliveryRecord> & { op: DeliveryOp }) =>
  rec.op === want.op && defining(rec) === defining(want);

/**
 * Plan one `deliverables` command. Reads only; `applyDeliverables` performs the writes.
 */
export async function planDeliverables(
  repository: string,
  request: DeliverablesRequest,
  rt: DeliverablesRuntime,
  resume?: { opId: string },
): Promise<DeliverablesPlan> {
  const r = request;
  const { number, agent } = r;
  const op = opFor(r);
  const cmd = (text: string): string => `github-triage ${text} --repo ${repository}`;
  const retry = deliverablesCommand(repository, r);
  const inspect = cmd(`--issue ${number}`);
  const refuse = (
    error: string,
    facts: DeliverablesFacts,
    prerequisite: string,
    recovery: string[],
  ): DeliverablesRefusal => ({ ok: false, error, facts, prerequisite, recovery });

  let read: Awaited<ReturnType<typeof readIssue>>;
  try {
    read = await readIssue(repository, number, rt.query);
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
      "Delivery records live on the issue the pull request addresses.",
      [cmd(`pr ${number}`)],
    );
  const labels = item.labels.nodes.map((l) => l.name);
  const linked = item.closedByPullRequestsReferences;
  const claims = labels
    .filter((l) => l.startsWith(workflow.ownerPrefix))
    .map((l) => l.slice(workflow.ownerPrefix.length));
  const base: DeliverablesFacts = {
    number,
    url: item.url,
    title: item.title,
    state: item.state,
    claims,
  };
  if (item.labels.pageInfo?.hasNextPage)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      base,
      "More than 100 labels; active claims cannot be verified, so nothing is changed.",
      [inspect, cmd(`who ${number}`)],
    );

  // The author of the record is the authenticated account: it must pass the #212 rule, or the
  // record would be ignored (or unverifiable) by every reader.
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
  const login = viewer?.login ?? "(unknown)";
  if (authority.status !== "trusted")
    return refuse(
      "MARKER_UNVERIFIED",
      base,
      `The authenticated account ${login} must be a user with current write, maintain or admin permission on ${repository} to write delivery records (${authority.why}); nothing is changed.`,
      [cmd(`who ${number}`), retry],
    );

  const history = await readDeliveryComments(repository, number, item.comments, rt.query);
  const { records, fold } = await readDeliveryFold(
    history.comments,
    history.complete,
    { repository, issue: number },
    rt.trust,
  );
  const facts: DeliverablesFacts = {
    ...base,
    ticketResponsible: fold.ticketResponsible,
    membership: fold.membership,
    members: fold.members.map((m) => ({
      deliverable: deliverableLabel(m.deliverable),
      target: targetLabel(m.deliverable.target),
      responsible: m.responsible,
    })),
    recordsUnknown: fold.recordsUnknown,
    unknownBecause: fold.unknownBecause,
  };
  const notes: string[] = [...fold.ignored];
  if (fold.refusal && r.action !== "void")
    return refuse(
      fold.refusal,
      facts,
      `The delivery record history is not fully known (${fold.unknownBecause.join("; ")}), so a change that depends on it cannot be checked; nothing is changed.`,
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

  // Retry detection: the newest trusted record already is this request.
  const trustedRecords = records.filter(
    (c): c is ClassifiedRecord & { status: "trusted" } => c.status === "trusted",
  );
  const lastApplied = fold.applied.at(-1);

  const holds = claims.includes(agent);
  const others = claims.filter((c) => c !== agent);
  const ticketResponsible = fold.ticketResponsible === agent;
  const memberOf = (d: Deliverable) =>
    fold.members.find((m) => deliverableKey(m.deliverable) === deliverableKey(d));
  const claimHeld = (holders: string[], what: string): DeliverablesRefusal =>
    refuse(
      "CLAIM_HELD",
      facts,
      `${holders.map((h) => `${workflow.ownerPrefix}${h}`).join(", ")} holds an active claim on #${number}; ${what}. Wait for the claimant's handoff, or a maintainer's visible release for an absent holder.`,
      [
        cmd(`who ${number}`),
        ...holders.map((h) => cmd(`release ${number} --agent ${h} --as ready --note TEXT`)),
      ],
    );
  const notResponsible = (what: string): DeliverablesRefusal =>
    refuse(
      "NOT_RESPONSIBLE",
      facts,
      `${agent} ${what}. Ticket-responsible agent: ${fold.ticketResponsible ?? "none"}.`,
      [
        cmd(`who ${number}`),
        ...(fold.ticketResponsible
          ? [
              cmd(
                `deliverables ${number} handoff --agent ${fold.ticketResponsible} --to ${agent} --reason TEXT`,
              ),
            ]
          : []),
        cmd(`deliverables ${number} reassign --agent MAINTAINER --to ${agent} --reason TEXT`),
        cmd(`deliverables ${number} reset --agent MAINTAINER --as ready --reason TEXT`),
      ],
    );

  // Deliverables named by the request, checked live (attach-time link checks).
  const deliverables: Deliverable[] = [];
  const checkTarget = r.target ?? { repository, branch: null };
  const linkChecked = ["attach", "retarget"].includes(r.action);
  for (const url of r.prs) {
    const m = prUrl.exec(url);
    if (!m)
      return refuse("EVIDENCE_INCOMPLETE", facts, `${url} is not a pull request URL.`, [retry]);
    const [, prRepo, prNumber] = m;
    if (!linkChecked) {
      // Identity only: detach, handoff and retarget's lookup use the recorded member.
      const existing = fold.members.find(
        (x) =>
          x.deliverable.kind === "pr" &&
          sameRepo(x.deliverable.repository, prRepo) &&
          x.deliverable.number === Number(prNumber),
      );
      deliverables.push(
        existing?.deliverable ?? {
          kind: "pr",
          repository: prRepo,
          number: Number(prNumber),
          nodeId: "(unread)",
          target: checkTarget,
        },
      );
      continue;
    }
    const live = await readPr(url, rt.query);
    if (!live)
      return refuse(
        "EVIDENCE_INCOMPLETE",
        { ...facts, pullRequests: [url] },
        `${url} could not be read as a pull request (missing, inaccessible or rate-limited), so its target cannot be checked; nothing is recorded.`,
        [retry],
      );
    const baseRepo = live.baseRepository!.nameWithOwner;
    const intended =
      checkTarget.branch ??
      (sameRepo(baseRepo, checkTarget.repository)
        ? live.baseRepository!.defaultBranchRef?.name
        : null);
    const explicit = deliverablesCommand(repository, {
      ...r,
      target: { repository: baseRepo, branch: live.baseRefName },
    });
    if (!sameRepo(baseRepo, checkTarget.repository))
      return refuse(
        "TARGET_MISMATCH",
        { ...facts, pullRequests: [url] },
        `${url} targets ${baseRepo}:${live.baseRefName}, not the intended repository ${checkTarget.repository}. State the target explicitly when that is intended.`,
        [explicit],
      );
    if (!intended)
      return refuse(
        "EVIDENCE_INCOMPLETE",
        { ...facts, pullRequests: [url] },
        `The default branch of ${checkTarget.repository} could not be read, so ${url}'s target cannot be checked; nothing is recorded.`,
        [retry],
      );
    if (live.baseRefName !== intended)
      return refuse(
        "TARGET_MISMATCH",
        { ...facts, pullRequests: [url] },
        `${url} targets branch ${live.baseRefName}, not the intended ${intended} of ${checkTarget.repository}. State the target explicitly when that branch is intended.`,
        [explicit],
      );
    if (
      !live.closingIssuesReferences?.nodes.some(
        (n) => n.number === number && sameRepo(n.repository.nameWithOwner, repository),
      )
    )
      notes.push(
        `Warning: ${url} has no closing reference to ${repository}#${number}; membership is what the record says.`,
      );
    if (live.state === "CLOSED" && !live.merged)
      notes.push(`Warning: ${url} is closed unmerged; it is not delivered while required.`);
    deliverables.push({
      kind: "pr",
      repository: baseRepo,
      number: live.number,
      nodeId: live.id,
      target: { repository: checkTarget.repository, branch: r.target?.branch ?? null },
      headOid: live.headRefOid,
    });
  }
  for (const ref of r.commits) {
    const m = commitRef.exec(ref);
    if (!m) return refuse("EVIDENCE_INCOMPLETE", facts, `${ref} is not owner/name@SHA.`, [retry]);
    const live = await readCommit(m[1], m[2], rt.query);
    if (!live)
      return refuse(
        "EVIDENCE_INCOMPLETE",
        facts,
        `Commit ${ref} could not be read (missing, inaccessible or rate-limited); nothing is recorded.`,
        [retry],
      );
    if (!sameRepo(live.repository, checkTarget.repository))
      return refuse(
        "TARGET_MISMATCH",
        facts,
        `Commit ${ref} is in ${live.repository}, not the intended repository ${checkTarget.repository}. State the target explicitly when that is intended.`,
        [
          deliverablesCommand(repository, {
            ...r,
            target: { repository: live.repository, branch: "BRANCH" },
          }),
        ],
      );
    deliverables.push({
      kind: "commit",
      repository: live.repository,
      oid: live.oid,
      target: { repository: checkTarget.repository, branch: r.target?.branch ?? null },
    });
  }

  const issuedAt = rt.now().toISOString();
  const draft = (fields: Partial<DeliveryRecord>): DeliveryRecord => {
    const rec: DeliveryRecord = {
      v: 1,
      op,
      opId: "",
      repository,
      issue: number,
      agent,
      deliverables,
      ...(r.reason ? { reason: r.reason } : {}),
      ...fields,
      issuedAt,
    };
    // The opId covers every operation-defining field (the same `definingFields` table that
    // retry detection uses) plus the fold it was planned against: two different operations never
    // share an id, while an identical retry against the same fold (whatever its reason text)
    // yields the same one.
    rec.opId = deliveryOpId({
      repository,
      issue: number,
      op,
      deliverables,
      agent,
      issuedAt: `after:${lastApplied?.comment ?? "none"};${defining(rec)}`,
    });
    return rec;
  };
  const accepted = (
    record: DeliveryRecord,
    describe: string,
    labelPlan?: { add: string[]; remove: string[] },
  ): DeliverablesAccepted => {
    const body = [
      `Delivery record by \`${agent}\`${record.login ? ` (${record.login})` : ""} with \`github-triage deliverables ${r.action}${r.legacy ? " --legacy" : ""}\`: **${describe}**.`,
      "",
      ...(record.reason ? [`**Reason:** ${record.reason}`, ""] : []),
      ...(record.evidence ? [`Evidence: ${record.evidence}`, ""] : []),
      deliveryMarker(record),
    ].join("\n");
    const changes: PlanStep[] = [
      {
        step: "record",
        command: ["issue", "comment", String(number), "--repo", repository, "--body", body],
      },
    ];
    if (labelPlan) changes.push(...labelStep(labelPlan));
    return { ok: true, noop: false, facts, record, changes, notes, retry };
  };
  const labelStep = (plan: { add: string[]; remove: string[] }): PlanStep[] => {
    const add = plan.add.filter((l) => !labels.includes(l));
    const remove = plan.remove.filter((l) => labels.includes(l));
    return add.length || remove.length
      ? [
          {
            step: "labels",
            command: [
              "issue",
              "edit",
              String(number),
              "--repo",
              repository,
              ...add.flatMap((l) => ["--add-label", l]),
              ...remove.flatMap((l) => ["--remove-label", l]),
            ],
          },
        ]
      : [];
  };
  const noop = (reason: string): DeliverablesAccepted => ({
    ok: true,
    noop: true,
    reason,
    facts,
    changes: [],
    notes,
    retry,
  });

  // Find this request's own record by identity, never by position: with `resume`, the record
  // this invocation posted (its opId); otherwise the newest applied record that is this request.
  // Records applied after it are judged against the contract before any later step proceeds.
  const want = intended(op, r, deliverables);
  const ownIndex = resume
    ? fold.applied.findIndex((a) =>
        trustedRecords.some(
          (c) => String(c.comment.databaseId) === a.comment && c.record.opId === resume.opId,
        ),
      )
    : fold.applied.findLastIndex((a) => {
        const c = trustedRecords.find((t) => String(t.comment.databaseId) === a.comment);
        return !!c && sameRequest(c.record, want);
      });
  const own = ownIndex >= 0 ? fold.applied[ownIndex] : undefined;
  const ownRecord = own
    ? trustedRecords.find((c) => String(c.comment.databaseId) === own.comment)?.record
    : undefined;
  const after = ownIndex >= 0 ? fold.applied.slice(ownIndex + 1) : [];
  // The posted record did not fold (rejected or not found): post-write verification reports it.
  if (resume && !own)
    return noop(
      `The record posted by this run (opId ${resume.opId}) is not applied; nothing more is written.`,
    );

  if (
    own &&
    ownRecord &&
    (after.length === 0 ||
      (op === "reset" && (resume || after.every((a) => resetNeutralOps.has(a.op)))))
  ) {
    // The record step is done. Only reset has a later step: its recorded label plan.
    if (op === "reset" && ownRecord.plan) {
      const plan = ownRecord.plan;
      const where = `A reset is recorded (comment ${own.comment})`;
      const pending = `add ${plan.add.join(", ") || "nothing"}, remove ${plan.remove.join(", ") || "nothing"}`;
      // Contract: reset ends all responsibility and leaves membership alone. A later record that
      // sets or transfers responsibility (or another reset/complete) supersedes it, so its labels
      // must not be applied silently. Membership, detach, retarget and void records do not touch
      // responsibility, so the reset's plan still stands once its prerequisites are re-checked.
      const conflicting = after.filter((a) => !resetNeutralOps.has(a.op));
      if (conflicting.length || (after.length && fold.ticketResponsible))
        return refuse(
          "DELIVERY_DIVERGED",
          facts,
          `${where} but its labels were not applied (${pending}), and a later record intervened: ${(conflicting.length ? conflicting : after).map((a) => `${a.op} (comment ${a.comment}) by ${a.agent} (${a.login})`).join("; ")}${fold.ticketResponsible ? `; ${fold.ticketResponsible} is now ticket-responsible` : ""}. The reset is superseded, so no second reset is posted and its labels are not applied. Inspect the ticket; if a reset is still wanted, run it again so it is decided against the current records.`,
          [inspect, cmd(`who ${number}`), retry],
        );
      const intervened = after.length
        ? ` Later record(s) ${after.map((a) => `${a.op} (comment ${a.comment})`).join(", ")} do not change responsibility, so the reset still stands.`
        : "";
      const observed = ownRecord.observedLabels;
      const added = plan.add.filter((l) => labels.includes(l));
      const removed = plan.remove.filter((l) => !labels.includes(l));
      const done = observed
        ? sameSet(resetObserved(labels), resetPlanResult(plan, observed))
        : added.length === plan.add.length && removed.length === plan.remove.length;
      if (done) return noop(`Reset already recorded (comment ${own.comment}) and applied.`);
      // Completing the plan is allowed only while it is provably unapplied: the relevant labels
      // are the reset's recorded starting state, or that state with only some removals made.
      // Anything else means readiness changed after the reset (or the record predates the
      // recorded starting state), so replaying the stale plan could revert others' changes.
      if (!resetPlanPending(plan, observed, labels))
        return refuse(
          "DELIVERY_DIVERGED",
          facts,
          observed
            ? `${where} but its plan (${pending}) is no longer pending: the ticket now carries ${resetObserved(labels).join(", ") || "no readiness or review label"}, which is neither its recorded starting state (${resetObserved(observed).join(", ") || "none"}) nor a partial application of it, so readiness was most likely changed afterwards without a delivery record. Its stale labels are not re-applied and others' changes are never reverted. Inspect the ticket; if a reset is still wanted, run it again deliberately so it is decided against the current labels.`
            : `${where} but its plan (${pending}) is not applied, and the record does not state the labels it started from, so a pending plan cannot be told apart from later changes. Its labels are not applied and others' changes are never reverted. Inspect the ticket and set the readiness labels by hand, or run a new reset deliberately.`,
          [inspect, cmd(`who ${number}`), retry],
        );
      // Finishing the plan is a write, so the reset's live prerequisites are checked again: a
      // claim or open PR that appeared since the record was posted blocks the labels too.
      const blocked = await resetPrerequisites();
      if (blocked)
        return {
          ...blocked,
          prerequisite: `${where} but its labels were not applied (${pending}), and its prerequisites no longer hold: ${blocked.prerequisite}${intervened} No further record is posted; resolve this, then re-run the same reset to apply the recorded labels.`,
          recovery: blocked.recovery.includes(retry)
            ? blocked.recovery
            : [...blocked.recovery, retry],
        };
      return {
        ok: true,
        noop: false,
        reason: `Reset already recorded (comment ${own.comment}); applying its recorded label plan.${intervened}`,
        facts,
        changes: labelStep(plan),
        notes,
        retry,
      };
    }
    return noop(`Already recorded as comment ${own.comment}; nothing to change.`);
  }
  // Resuming a single-step record that is no longer last: nothing further to write here.
  if (resume) return noop(`Already recorded as comment ${own!.comment}; nothing to change.`);

  switch (r.action) {
    case "attach": {
      if (r.legacy) {
        const legacy = await legacyPrerequisites();
        if (legacy) return legacy;
        const rel = (await legacyRelease(history.comments, rt.trust)).trusted!;
        return accepted(
          draft({
            responsible: agent,
            membership: r.membership ?? "complete",
            login,
            legacyRelease: String(rel.databaseId),
          }),
          `legacy attachment by ${agent} (${login}) of ${deliverables.map(deliverableLabel).join(", ")}`,
        );
      }
      if (!holds && !ticketResponsible)
        return notResponsible(
          `neither holds the claim on #${number} nor is ticket-responsible, so it cannot attach deliverables`,
        );
      const fresh = deliverables.filter((d) => {
        const m = memberOf(d);
        return !m || JSON.stringify(m.deliverable.target) !== JSON.stringify(d.target);
      });
      if (!fresh.length && (!r.membership || r.membership === fold.membership))
        return noop("Every named deliverable is already required with that target.");
      return accepted(
        draft({ responsible: agent, ...(r.membership ? { membership: r.membership } : {}) }),
        `attached ${deliverables.map(deliverableLabel).join(", ")}`,
      );
    }
    case "detach":
    case "retarget": {
      const d = deliverables[0];
      const member = memberOf(d);
      if (!member && r.action === "detach") return noop(`${deliverableLabel(d)} is not required.`);
      if (!member)
        return refuse(
          "NOT_REQUIRED",
          facts,
          `${deliverableLabel(d)} is not a required deliverable of #${number}, so it has no target to change.`,
          [cmd(`deliverables ${number} attach --agent ${agent} --pr ${shellQuote(r.prs[0])}`)],
        );
      if (!holds && !ticketResponsible && member.responsible !== agent)
        return notResponsible(
          `neither holds the claim, is ticket-responsible, nor is responsible for ${deliverableLabel(d)}`,
        );
      if (r.action === "retarget") {
        if (JSON.stringify(member.deliverable.target) === JSON.stringify(d.target))
          return noop(`${deliverableLabel(d)} already targets ${targetLabel(d.target)}.`);
        return accepted(draft({}), `retargeted ${deliverableLabel(d)} to ${targetLabel(d.target)}`);
      }
      if (fold.members.length === 1)
        notes.push(
          `Detaching the last required deliverable; ticket responsibility (${fold.ticketResponsible ?? "none"}) is unchanged.`,
        );
      return accepted(
        draft({ deliverables: [member.deliverable] }),
        `detached ${deliverableLabel(d)}`,
      );
    }
    case "handoff": {
      const to = r.to!;
      if (deliverables.length) {
        const d = deliverables[0];
        const member = memberOf(d);
        if (!member || member.responsible !== agent)
          return notResponsible(
            `is not the responsible agent for ${deliverableLabel(d)} (responsible: ${member?.responsible ?? "not required"})`,
          );
        if (member.responsible === to) return noop(`${to} is already responsible.`);
        return accepted(
          draft({
            deliverables: [member.deliverable],
            to,
            scope: "deliverable",
            expectedResponsibilityRecord: member.responsibilityRecord ?? "none",
          }),
          `handed ${deliverableLabel(d)} to ${to}`,
        );
      }
      if (!ticketResponsible)
        return notResponsible("is not ticket-responsible, so it cannot hand the ticket off");
      if (holds)
        return claimHeld(
          [agent],
          "a ticket handoff needs the caller to hold no claim; release it first",
        );
      if (fold.ticketResponsible === to) return noop(`${to} is already ticket-responsible.`);
      return accepted(
        draft({
          to,
          scope: "ticket",
          expectedResponsibilityRecord: fold.ticketResponsibilityRecord ?? "none",
        }),
        `handed ticket responsibility to ${to}`,
      );
    }
    case "membership": {
      const override = !holds && !ticketResponsible;
      if (others.length)
        return claimHeld(others, "membership cannot change under another agent's claim");
      if (override && r.membership !== "complete")
        return notResponsible(
          "neither holds the claim nor is ticket-responsible; only a maintainer's membership complete is an override",
        );
      if (fold.membership === r.membership) return noop(`Membership is already ${r.membership}.`);
      return accepted(
        draft({ membership: r.membership!, ...(override ? { login } : {}) }),
        `${override ? `override by ${agent} (${login}): ` : ""}membership ${r.membership}`,
      );
    }
    case "attest": {
      if (r.legacy) {
        const legacy = await legacyPrerequisites();
        if (legacy) return legacy;
        const rel = (await legacyRelease(history.comments, rt.trust)).trusted!;
        return accepted(
          draft({
            deliverables: [],
            membership: "complete",
            responsible: agent,
            login,
            legacyRelease: String(rel.databaseId),
            ...(r.evidence ? { evidence: r.evidence } : {}),
          }),
          `legacy attestation by ${agent} (${login}); no code deliverable`,
        );
      }
      if (!holds && !ticketResponsible)
        return notResponsible(
          "neither holds the claim nor is ticket-responsible, so it cannot attest",
        );
      const observed = new Map<string, MemberObservation>();
      for (const m of fold.members)
        observed.set(deliverableKey(m.deliverable), await observe(m.deliverable, rt));
      const applies = attestApplicability(
        fold,
        (d) => observed.get(deliverableKey(d)) ?? "unknown",
      );
      if (!applies.applies) {
        if (applies.error === "ATTEST_NOT_APPLICABLE")
          return refuse(
            "ATTEST_NOT_APPLICABLE",
            facts,
            `An attestation never stands in for an outstanding deliverable: ${[
              ...applies.outstanding.map((o) => `${o} is not merged into its target`),
              ...(applies.membershipOpen
                ? [`membership is ${fold.membership ?? "not stated"}, not complete`]
                : []),
            ].join("; ")}.`,
            [
              ...fold.members
                .filter((m) => applies.outstanding.includes(deliverableLabel(m.deliverable)))
                .filter((m) => m.deliverable.kind === "pr")
                .map((m) => {
                  const d = m.deliverable as Extract<Deliverable, { kind: "pr" }>;
                  return cmd(
                    `deliverables ${number} detach --agent ${agent} --pr https://github.com/${d.repository}/pull/${d.number} --reason TEXT`,
                  );
                }),
              ...(applies.membershipOpen
                ? [cmd(`deliverables ${number} membership complete --agent ${agent} --reason TEXT`)]
                : []),
            ],
          );
        return refuse(
          applies.error,
          facts,
          `Delivery evidence is unknown (${applies.unknown.join("; ")}); re-read it before attesting.`,
          [retry, inspect],
        );
      }
      return accepted(
        draft(r.evidence ? { evidence: r.evidence } : {}),
        "attested non-code outcome",
      );
    }
    case "reassign": {
      if (claims.length)
        return claimHeld(claims, "a maintainer reassign never overrides a held claim");
      const to = r.to!;
      if (fold.ticketResponsible === to && fold.members.every((m) => m.responsible === to))
        return noop(`${to} is already responsible for the ticket and every member.`);
      return accepted(draft({ to, login }), `override by ${agent} (${login}): reassigned to ${to}`);
    }
    case "reset": {
      const blocked = await resetPrerequisites();
      if (blocked) return blocked;
      const { add, remove } = resetPlan(r.as);
      return accepted(
        draft({ login, plan: { remove, add }, observedLabels: resetObserved(labels) }),
        `override by ${agent} (${login}): reset to ${r.as}`,
        { add, remove },
      );
    }
    case "void": {
      const target = r.comment!;
      if (fold.voided.includes(target)) return noop(`Comment ${target} is already voided.`);
      if (!fold.malformed.some((m) => m.comment === target))
        return refuse(
          "VOID_NOT_APPLICABLE",
          facts,
          `Comment ${target} is not a malformed trusted delivery record; void never removes a parsable record (use detach, retarget or membership) or an unsupported-version one (upgrade github-triage).`,
          [inspect],
        );
      return accepted(
        draft({ voids: target, login }),
        `override by ${agent} (${login}): voided comment ${target}`,
      );
    }
  }

  /** Reset's live prerequisites (no claim, no open or unreadable linked PR); null when they hold. */
  async function resetPrerequisites(): Promise<DeliverablesRefusal | null> {
    if (claims.length) return claimHeld(claims, "a maintainer reset never overrides a held claim");
    const open: string[] = [];
    const unreadable: string[] = [];
    for (const p of linked.nodes) if (p.state === "OPEN") open.push(p.url);
    if (linked.pageInfo?.hasNextPage) unreadable.push("more than 20 linked pull requests");
    for (const m of fold.members) {
      if (m.deliverable.kind !== "pr") continue;
      const url = `https://github.com/${m.deliverable.repository}/pull/${m.deliverable.number}`;
      const live = await readPr(url, rt.query);
      if (!live) unreadable.push(url);
      else if (live.state === "OPEN" && !open.includes(live.url)) open.push(live.url);
    }
    if (open.length || unreadable.length)
      return refuse(
        "RESET_HAS_OPEN_PR",
        { ...facts, pullRequests: open },
        `${open.length ? `Open pull request(s) link or close #${number}: ${open.join(", ")}. ` : ""}${unreadable.length ? `Open-PR state could not be read for: ${unreadable.join(", ")}. ` : ""}A reset would leave the ticket unpickable; reassign instead (the new agent adopts or replaces the PR with claim --rework), or close or unlink the open PRs first, then reset.`,
        [
          cmd(`deliverables ${number} reassign --agent ${agent} --to AGENT --reason TEXT`),
          ...open.map((u) => {
            const m = prUrl.exec(u);
            return m ? `gh pr close ${m[2]} --repo ${m[1]} --comment TEXT` : u;
          }),
          retry,
        ],
      );
    return null;
  }

  /** Legacy eligibility (doc "Legacy attachment" / "Legacy attestation"); null when eligible. */
  async function legacyPrerequisites(): Promise<DeliverablesRefusal | null> {
    if (others.length)
      return claimHeld(others, "that agent owns the work and must attach or release it");
    const ordinary = cmd(
      `deliverables ${number} ${r.action} --agent ${agent}${r.prs.map((p) => ` --pr ${shellQuote(p)}`).join("")} --reason TEXT`,
    );
    if (fold.hasTrustedRecord)
      return refuse(
        "LEGACY_NOT_APPLICABLE",
        facts,
        `#${number} already has a trusted delivery record, so the v1 handoff is superseded; changes go through ticket responsibility (${fold.ticketResponsible ?? "none"}).`,
        [ordinary, cmd(`who ${number}`)],
      );
    const rel = await legacyRelease(history.comments, rt.trust);
    if (!rel.trusted && rel.unverified.length)
      return refuse(
        "MARKER_UNVERIFIED",
        facts,
        `A v1 done handoff on #${number} cannot be verified (${rel.unverified.join("; ")}); nothing is changed.`,
        [retry, inspect],
      );
    if (!rel.trusted)
      return refuse(
        "LEGACY_NOT_APPLICABLE",
        facts,
        `#${number} has no trusted v1 done handoff, so legacy recovery does not apply; use the ordinary command with a claim or ticket responsibility.`,
        [ordinary, cmd(`claim ${number} --agent ${agent}`)],
      );
    if (holds)
      notes.push(`${agent} holds the claim; the ordinary command also applies: ${ordinary}`);
    return null;
  }
}

/**
 * Apply a plan one write at a time. Before every write the issue is re-read, re-folded and
 * re-planned; the write proceeds only while the fresh plan still begins with it. After the last
 * write a final re-read confirms the record folded (a stale handoff is reported, never retried).
 * Exit: 0 done, 2 partly done, conflict or unverified, 1 refused or nothing done.
 */
export async function applyDeliverables(
  repository: string,
  request: DeliverablesRequest,
  rt: DeliverablesRuntime,
  first?: DeliverablesPlan,
): Promise<DeliverablesResult> {
  const initial = first ?? (await planDeliverables(repository, request, rt));
  if (!initial.ok) return { ...initial, exitCode: 1 };
  const steps: PlanStep[] = [];
  // Identity comes only from what was actually written: the record posted by this run is taken
  // from the fresh plan at the moment of its write, never from an earlier plan (a re-read may
  // have replanned it against a newer fold, changing its opId). Resume and verification use it.
  let posted: { plan: DeliverablesPlan & { ok: true }; record: DeliveryRecord } | null = null;
  let plan: DeliverablesPlan = initial;
  let fresh = !first;
  let later: DeliverablesRefusal | null = null;
  let skipped: string | null = null;
  for (let i = 0; i < 4; i++) {
    // Re-read and re-fold before every write; never write on an earlier read.
    // Once this run's record is posted, later steps resume from that record (found by opId).
    if (!fresh)
      plan = await planDeliverables(
        repository,
        request,
        rt,
        posted ? { opId: posted.record.opId } : undefined,
      );
    fresh = false;
    const done = steps.some((s) => s.status === "done");
    if (!plan.ok) {
      if (!done) return { ...plan, steps, exitCode: 1 };
      // Something changed after a write: verify what was written, then report the refusal.
      later = plan;
      break;
    }
    const next = plan.changes[0];
    if (!next) break;
    // A record posted in this run is never posted again; the re-read below reports its fate.
    if (next.step === "record" && steps.some((s) => s.step === "record")) {
      skipped = `A fresh plan proposed another record after this run's record was posted; nothing more was written. Re-run to see the current state.`;
      break;
    }
    const step: PlanStep = { ...next, status: "pending" };
    steps.push(step);
    try {
      await rt.run(step.command);
      step.status = "done";
      if (step.step === "record" && plan.record) posted = { plan, record: plan.record };
    } catch (error) {
      step.status = "failed";
      step.reason = error instanceof Error ? error.message : undefined;
      return { ...(posted?.plan ?? plan), steps, exitCode: done ? 2 : 1 };
    }
  }
  // Post-write verification: the record must fold as intended.
  let conflict: string | null = null;
  let unverified: string | null = skipped;
  const opId = posted?.record.opId;
  if (opId) {
    try {
      const read = await readIssue(repository, request.number, rt.query);
      const item = read.item?.__typename === "Issue" ? read.item : null;
      if (!item) unverified = `#${request.number} could not be re-read.`;
      else {
        const history = await readDeliveryComments(
          repository,
          request.number,
          item.comments,
          rt.query,
        );
        const { records, fold } = await readDeliveryFold(
          history.comments,
          history.complete,
          { repository, issue: request.number },
          rt.trust,
        );
        const mine = records.find((c) => c.status === "trusted" && c.record.opId === opId);
        const id = mine ? String(mine.comment.databaseId) : null;
        const rejected = id ? fold.rejected.find((x) => x.comment === id) : undefined;
        if (!mine) unverified = "The posted record was not found as a trusted record on re-read.";
        else if (rejected)
          conflict = `${rejected.error}: ${rejected.why}. The record stays as a rejected audit entry; ask the current responsible agent for a fresh handoff.`;
        else if (fold.recordsUnknown)
          unverified = `Record folds, but the history is not fully known (${fold.unknownBecause.join("; ")}).`;
      }
    } catch (error) {
      unverified = `Writes completed, but the record could not be re-read (${error instanceof Error ? error.message : "unknown error"}).`;
    }
  }
  if (later && !conflict) return { ...later, steps, conflict, unverified, exitCode: 2 };
  const exitCode = conflict || unverified ? 2 : 0;
  return { ...(posted?.plan ?? initial), steps, conflict, unverified, exitCode };
}

/** Text rendering for plans, refusals and results. */
export function deliverablesText(
  result: DeliverablesPlan | DeliverablesResult,
  dryRun = false,
): string {
  if (!result.ok)
    return (
      [
        `REFUSED ${result.error}: ${result.prerequisite}`,
        `Ticket: ${result.facts.url ?? `#${result.facts.number}`}`,
        ...(result.facts.claims?.length ? [`Claims: ${result.facts.claims.join(", ")}`] : []),
        ...(result.facts.pullRequests ?? []).map((p) => `Pull request: ${p}`),
        ...("steps" in result && result.steps?.length
          ? result.steps.map((s) => `- ${s.step}: ${s.status}`)
          : []),
        ...(result.recovery.length ? ["Recovery:", ...result.recovery.map((r) => `  ${r}`)] : []),
      ].join("\n") + "\n"
    );
  const lines = [`${result.facts.url} ${result.facts.title}`];
  lines.push(
    `Responsible: ${result.facts.ticketResponsible ?? "none"} · membership ${result.facts.membership ?? "not stated"} · required: ${result.facts.members?.map((m) => m.deliverable).join(", ") || "none"}`,
  );
  if (result.noop) lines.push(result.reason ?? "Nothing to change.");
  else if (result.reason) lines.push(result.reason);
  if (dryRun) lines.push("DRY RUN: no changes made.");
  const steps = ("steps" in result ? result.steps : undefined) ?? result.changes;
  for (const c of steps)
    lines.push(
      `- ${c.step}${c.status ? `: ${c.status}` : ""}${c.reason ? ` — ${c.reason}` : ""}`,
      ...(dryRun ? [`    gh ${c.command.map(shellQuote).join(" ")}`] : []),
    );
  for (const n of result.notes) lines.push(`Note: ${n}`);
  if ("conflict" in result && result.conflict) lines.push(`CONFLICT: ${result.conflict}`);
  if ("unverified" in result && result.unverified) lines.push(`UNVERIFIED: ${result.unverified}`);
  if ("exitCode" in result && result.exitCode !== 0)
    lines.push(`Retry (safe; completes only the missing steps): ${result.retry}`);
  return lines.join("\n") + "\n";
}

export const deliverablesUsage = `Usage: github-triage deliverables N attach --agent NAME --pr URL [--pr URL...] [--target owner/name:branch] [--membership complete|open] [--reason TEXT]
       github-triage deliverables N attach --legacy --agent NAME (--pr URL | --commit owner/name@SHA)... [--target owner/name:branch] [--membership open] --reason TEXT
       github-triage deliverables N detach --agent NAME --pr URL --reason TEXT
       github-triage deliverables N retarget --agent NAME --pr URL --target owner/name:branch --reason TEXT
       github-triage deliverables N handoff --agent NAME --to NAME [--pr URL] --reason TEXT
       github-triage deliverables N membership complete|open --agent NAME --reason TEXT
       github-triage deliverables N attest [--legacy] --agent NAME --reason TEXT [--evidence URL]
       github-triage deliverables N reassign --agent NAME --to NAME --reason TEXT
       github-triage deliverables N reset --agent NAME --as ready|incomplete --reason TEXT
       github-triage deliverables N void --agent NAME --comment ID --reason TEXT
  Every form also takes [--dry-run] [--json] [--repo owner/name].`;

export const deliverablesHelp = `${deliverablesUsage}
Record which deliverables issue N requires and who is responsible for them (#189,
doc/design/delivery-lifecycle.md). Records never say delivery happened; delivery is always
evaluated from live evidence. Each command re-reads the issue, its full comment history and the
named pull requests, folds the trusted delivery records, then posts one record comment
(reset then also changes labels). Nothing is merged, closed or claimed.
  attach      Add required PRs (claim holder or ticket-responsible). Each PR is read live: its
              base repository and branch must match the target (the issue repository's default
              branch unless --target names one), else TARGET_MISMATCH; an unreadable PR is
              EVIDENCE_INCOMPLETE. A missing closing reference is only a warning
  --legacy    attach/attest recovery for a v1 "release --as done" ticket with no delivery record:
              no claim needed; refused CLAIM_HELD while another agent holds a claim,
              LEGACY_NOT_APPLICABLE once any delivery record exists or without a v1 done record
  detach      Remove a required deliverable; --reason is required. Ticket responsibility stays
  retarget    Change a member's target branch, checked live like attach
  handoff     Move ticket responsibility (no --pr; refused CLAIM_HELD while you hold a claim) or
              one deliverable's responsibility (--pr); a concurrent stale handoff is HANDOFF_STALE
  membership  State whether the required set is complete or more deliverables are expected
  attest      Non-code outcome; only when the set is empty and complete, or every member merged
              into its target (ATTEST_NOT_APPLICABLE otherwise)
  reassign    Maintainer override: make another agent responsible (no claim may be held)
  reset       Maintainer override: end responsibility and return the ticket to ready or
              incomplete; refused RESET_HAS_OPEN_PR while an open PR links or closes the issue
  void        Maintainer override: exclude one malformed trusted record (VOID_NOT_APPLICABLE
              for anything else)
The authenticated account must have write, maintain or admin permission (MARKER_UNVERIFIED).
Refusals: CLAIM_HELD, NOT_RESPONSIBLE, NOT_REQUIRED, TARGET_MISMATCH, EVIDENCE_INCOMPLETE,
LEGACY_NOT_APPLICABLE, ATTEST_NOT_APPLICABLE, RESET_HAS_OPEN_PR, VOID_NOT_APPLICABLE,
DELIVERY_DIVERGED, MARKER_UNVERIFIED, RECORD_MALFORMED, RECORD_UNSUPPORTED, each with recovery
commands. Re-running the same command is safe: a record already posted is not posted again.
Exit: 0 done (or nothing to do); 2 partly done, conflict or unverified; 1 refused or nothing done.
`;

/** Arguments for `deliverables N ACTION ...`; throws a usage error for anything invalid. */
export function deliverablesArguments(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      json: { type: "boolean" },
      "dry-run": { type: "boolean" },
      agent: { type: "string" },
      pr: { type: "string", multiple: true },
      commit: { type: "string", multiple: true },
      target: { type: "string" },
      reason: { type: "string" },
      to: { type: "string" },
      membership: { type: "string" },
      legacy: { type: "boolean" },
      evidence: { type: "string" },
      comment: { type: "string" },
      as: { type: "string" },
    },
  });
  const usage = deliverablesUsage;
  const [n, action, state, ...extra] = positionals;
  const number = /^[1-9]\d*$/.test(n ?? "") ? Number(n) : null;
  const act = deliverablesActions.find((a) => a === action);
  const name = /^[A-Za-z0-9][\w.-]*$/;
  if (!number || !act || !values.agent || !name.test(values.agent)) throw new Error(usage);
  if (extra.length || (state !== undefined && act !== "membership")) throw new Error(usage);
  if (values.repo && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    throw new Error("--repo must be owner/name.");
  const prs = (values.pr ?? []).map((p) => p.trim());
  const commits = (values.commit ?? []).map((c) => c.trim());
  for (const p of prs)
    if (!prUrl.test(p)) throw new Error(`--pr must be a GitHub pull request URL: ${p}`);
  for (const c of commits)
    if (!commitRef.test(c)) throw new Error(`--commit must be owner/name@SHA: ${c}`);
  let target: DeliveryTarget | null = null;
  if (values.target !== undefined) {
    const m = /^([\w.-]+\/[\w.-]+):(\S+)$/.exec(values.target);
    if (!m) throw new Error(`--target must be owner/name:branch.\n${usage}`);
    target = { repository: m[1], branch: m[2] };
  }
  const reason = values.reason?.trim() || null;
  const legacy = !!values.legacy;
  const fail = (why: string): never => {
    throw new Error(`${why}\n${usage}`);
  };
  if (reasonRequired.has(act) && !reason) fail(`deliverables ${act} requires --reason TEXT.`);
  if (legacy && act !== "attach" && act !== "attest")
    fail("--legacy applies only to attach and attest.");
  if (legacy && !reason) fail("--legacy requires --reason TEXT.");
  if (reason && reason.length > claimPolicy.maxNote)
    fail(`--reason is limited to ${claimPolicy.maxNote} characters.`);
  if (commits.length && !(act === "attach" && legacy))
    fail("--commit applies only to attach --legacy.");
  const onePr = ["detach", "retarget"].includes(act);
  if (act === "attach" && !prs.length && !commits.length) fail("attach needs --pr URL.");
  if (onePr && prs.length !== 1) fail(`${act} needs exactly one --pr URL.`);
  if (act === "handoff" && prs.length > 1) fail("handoff takes at most one --pr URL.");
  if (!["attach", "detach", "retarget", "handoff"].includes(act) && prs.length)
    fail(`--pr does not apply to ${act}.`);
  if (act === "retarget" && !target) fail("retarget needs --target owner/name:branch.");
  if (target && act !== "attach" && act !== "retarget") fail(`--target does not apply to ${act}.`);
  const needsTo = act === "handoff" || act === "reassign";
  if (needsTo && (!values.to || !name.test(values.to))) fail(`${act} needs --to NAME.`);
  if (!needsTo && values.to) fail(`--to does not apply to ${act}.`);
  if (act === "handoff" && values.to === values.agent)
    fail("handoff --to must name another agent.");
  let membership: "complete" | "open" | null = null;
  if (act === "membership") {
    if (state !== "complete" && state !== "open") fail("membership needs complete or open.");
    membership = state as "complete" | "open";
    if (values.membership) fail("membership takes its state as a positional argument.");
  } else if (values.membership !== undefined) {
    if (act !== "attach") fail(`--membership does not apply to ${act}.`);
    if (values.membership !== "complete" && values.membership !== "open")
      fail("--membership must be complete or open.");
    membership = values.membership as "complete" | "open";
  }
  if (values.evidence !== undefined && act !== "attest") fail("--evidence applies only to attest.");
  const evidence = values.evidence?.trim() || null;
  if (evidence && !/^https?:\/\/\S+$/.test(evidence)) fail("--evidence must be a URL.");
  if ((act === "void") !== (values.comment !== undefined))
    fail("--comment ID applies to void only, and void needs it.");
  if (values.comment !== undefined && !/^[1-9]\d*$/.test(values.comment))
    fail("--comment must be a numeric comment id.");
  if ((act === "reset") !== (values.as !== undefined))
    fail("--as applies to reset only, and reset needs it.");
  if (values.as !== undefined && values.as !== "ready" && values.as !== "incomplete")
    fail("reset --as must be ready or incomplete.");
  const request: DeliverablesRequest = {
    number,
    action: act,
    agent: values.agent,
    prs,
    commits,
    target,
    reason,
    to: values.to ?? null,
    membership,
    legacy,
    evidence,
    comment: values.comment ?? null,
    as: (values.as as "ready" | "incomplete" | undefined) ?? null,
  };
  return { request, repo: values.repo, json: !!values.json, dryRun: !!values["dry-run"] };
}
