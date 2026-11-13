/**
 * Claim and human-question commands (#2). Contract: doc/design/workflow.md, "One active
 * contribution", "Human questions" and "Actionable refusals".
 *
 * Each command reads live state first, plans its changes, and either refuses with a stable
 * error ID, facts, the failed prerequisite and recovery commands, or applies the plan through
 * the injected `gh` write boundary. Label names come from the registered workflow policy.
 */
import { createHash } from "node:crypto";
import { workflow } from "./briefing.js";
import { ghQuery, permissionLookup, writePermissions } from "./github.js";
import type { PermissionLookup } from "./github.js";
import { ghRun } from "./dependencies.js";

const labelColours: Record<string, string> = {
  agent: "1d76db",
  "design:decision-needed": "d93f0b",
  "status:incomplete": "fbca04",
  "status:awaiting-review": "5319e7",
  "status:ready": "0e8a16",
};

/** Labels these commands use, beyond the briefing's existing policy. */
export const claimPolicy = {
  owner: (agent: string): string => `${workflow.ownerPrefix}${agent}`,
  /** An addressed response request (doc/design/briefings.md); never a claim. */
  attention: (name: string): string => `attention:${name}`,
  /** Deliberate non-pickup states that a stale ready label must not override. */
  held: [workflow.blocked, workflow.parked],
  pickable: [workflow.ready, "status:incomplete"],
  incomplete: "status:incomplete",
  /** A handed-over contribution with an open PR: out of implementation pickup (#62). */
  awaitingReview: "status:awaiting-review",
  /** Release outcomes (#62); parked is a synonym for incomplete, never `status:parked`. */
  outcomes: ["ready", "incomplete", "parked", "done"] as const,
  /** Bounded handoff note length. */
  maxNote: 4000,
  needsDesign: "status:needs-design",
  decisionNeeded: "design:decision-needed",
  question: "question",
  platformPrefix: "platform:",
  questionsHeading: "### Questions for the designer",
  labelColours,
};

export interface PlanStep {
  step: string;
  command: string[];
  status?: string;
  reason?: string;
}
/** Facts reported with a plan or refusal; which fields are present depends on the outcome. */
export interface ClaimFacts {
  number: number;
  url?: string;
  title?: string;
  state?: string;
  labels?: string[];
  owners?: string[];
  activeClaims?: { number: number; url: string }[];
  openBlockers?: string[];
  pullRequests?: string[];
  platforms?: string[];
  platform?: string | null;
  /** release: the explicit outcome, deliverable and its verified state. */
  outcome?: string;
  deliverable?: string | null;
  pullRequestState?: string | null;
  target?: string | null;
}
export interface ClaimRefusal {
  ok: false;
  error: string;
  facts: ClaimFacts;
  prerequisite: string;
  recovery: string[];
}
export interface ClaimAccepted {
  ok: true;
  facts: ClaimFacts;
  noop: boolean;
  reason?: string;
  changes: PlanStep[];
  notes?: string[];
  recheck?: { agent: string; release?: { target: string | null } };
  /** Exact command that safely retries or completes this operation. */
  retry?: string;
}
export type ClaimPlan = ClaimRefusal | ClaimAccepted;
export type ClaimResult =
  | (ClaimRefusal & {
      exitCode: number;
      steps?: undefined;
      conflict?: undefined;
      unverified?: undefined;
    })
  | (ClaimAccepted & {
      steps: PlanStep[];
      conflict: string | null;
      /** Writes done but the post-write re-read was missing or truncated: not verified. */
      unverified: string | null;
      exitCode: number;
    });

/** The injected GraphQL read boundary (production: `ghQuery`). */
export type GraphQuery = (
  query: string,
  variables: Record<string, string | number>,
) => Promise<unknown>;
/** The injected `gh` write boundary (production: `ghRun`). */
export type GhRun = (args: string[]) => Promise<unknown>;

export interface ClaimRequest {
  number: number;
  agent: string;
  branch?: string | null;
  platform?: string | null;
  /**
   * Explicit review-rework reclaim (doc/design/workflow.md "Focused handoff"): accepted only on
   * an awaiting-review issue with an open PR whose latest recorded handoff is the caller's own
   * `done` release. Never makes awaiting-review work generally pickable.
   */
  rework?: boolean;
}
export type ReleaseOutcome = (typeof claimPolicy.outcomes)[number];
export interface ReleaseRequest {
  number: number;
  agent: string;
  outcome: ReleaseOutcome;
  note?: string | null;
  pr?: string | null;
  change?: string | null;
}
export interface NeedsHumanRequest {
  number: number;
  agent: string;
  designer: string;
  why: string;
  questions: string[];
}

type Labels = { nodes: { name: string }[]; pageInfo?: { hasNextPage: boolean } };
interface TicketIssue {
  __typename: "Issue";
  number: number;
  title: string;
  url: string;
  state: string;
  updatedAt: string;
  labels: Labels;
  issueDependenciesSummary: { blockedBy: number } | null;
  blockedBy: { nodes: { number: number; url: string; state: string }[] };
  closedByPullRequestsReferences: {
    nodes: { number: number; url: string; state: string }[];
    pageInfo?: { hasNextPage?: boolean };
  };
  comments: { nodes: Comment[]; pageInfo?: CommentPageInfo };
  timelineItems?: {
    nodes: LabelEvent[];
    pageInfo?: { hasPreviousPage?: boolean; startCursor?: string | null };
  };
}
/**
 * An issue comment. Author and edit evidence (#212) decide whether a marker in it may drive a
 * write; `undefined` means the field was not read, which is missing evidence.
 */
type Comment = {
  body: string;
  createdAt?: string;
  author?: Actor | null;
  lastEditedAt?: string | null;
  includesCreatedEdit?: boolean;
  editor?: Actor | null;
};
type Actor = { __typename?: string; login?: string };
type CommentPageInfo = { hasPreviousPage?: boolean; startCursor?: string | null };
type LabelEvent = { __typename?: string; createdAt?: string; label?: { name: string } };
type TicketItem = TicketIssue | { __typename: "PullRequest"; number: number; url: string };
interface TicketResponse {
  repository: {
    issueOrPullRequest: TicketItem | null;
    claims: {
      nodes: { number: number; title: string; url: string }[];
      pageInfo?: { hasNextPage?: boolean };
    } | null;
    ownerLabel: { name: string } | null;
    questionLabel: { name: string } | null;
    decisionLabel: { name: string } | null;
    needsDesignLabel: { name: string } | null;
    attentionLabel: { name: string } | null;
    targetLabel?: { name: string } | null;
  } | null;
}

/** Comment fields read wherever a marker may drive a write: body, author and edit evidence. */
const commentFields =
  "body createdAt author{__typename login} lastEditedAt includesCreatedEdit editor{__typename login}";

/**
 * Whether a marker comment may drive a write (#212, doc/design/triage-efficiency-and-trust.md
 * "Message visibility is distinct from authority"): its author is a user with current write,
 * maintain or admin permission, and any edit was made by such a user. `untrusted` is established
 * as lacking authority (ignored, with a warning); `unknown` could not be established (refused).
 */
type Authority = { status: "trusted" } | { status: "untrusted" | "unknown"; why: string };
async function actorAuthority(
  actor: Actor | null | undefined,
  role: string,
  permission: PermissionLookup,
): Promise<Authority> {
  if (actor === undefined) return { status: "unknown", why: `${role} not read` };
  if (actor === null || !actor.login)
    return { status: "untrusted", why: `${role} is a deleted or unknown account` };
  if (actor.__typename === undefined)
    return { status: "unknown", why: `${role} ${actor.login} has no account type` };
  // Apps and bots get no marker authority: a shared integration never speaks for an agent.
  if (actor.__typename !== "User" || actor.login.endsWith("[bot]"))
    return { status: "untrusted", why: `${role} ${actor.login} is an app or bot account` };
  const level = await permission(actor.login);
  if (level === "unknown")
    return {
      status: "unknown",
      why: `${role} ${actor.login}'s repository permission could not be verified`,
    };
  return writePermissions.has(level)
    ? { status: "trusted" }
    : { status: "untrusted", why: `${role} ${actor.login} has ${level} permission, not write` };
}
async function commentAuthority(c: Comment, permission: PermissionLookup): Promise<Authority> {
  const author = await actorAuthority(c.author, "author", permission);
  if (author.status !== "trusted") return author;
  if (c.lastEditedAt === undefined || c.includesCreatedEdit === undefined)
    return { status: "unknown", why: "edit history not read" };
  if (!c.lastEditedAt && !c.includesCreatedEdit) return { status: "trusted" };
  // Edited: GitHub exposes only the last editor. Only the author or a user with write access can
  // edit a comment, so a trusted author and a trusted last editor leave no untrusted edit.
  if (!c.editor?.login)
    return { status: "unknown", why: "edited, and who edited it cannot be established" };
  if (c.editor.login === c.author?.login) return { status: "trusted" };
  return actorAuthority(c.editor, "editor", permission);
}
/** A marker comment's authority, partitioned for the caller (newest first). */
interface MarkerVerdicts<T> {
  trusted: T | null;
  /** Newer than `trusted` and not established either way: refuse rather than guess. */
  unverified: string[];
  /** Established as lacking authority: ignored and named in a warning. */
  ignored: string[];
}
/**
 * The newest trusted candidate, checking newest first and stopping there, so permission lookups
 * are bounded by the distinct authors (and editors) of the markers newer than it.
 */
async function newestTrusted<T>(
  candidates: T[],
  comment: (c: T) => Comment,
  permission: PermissionLookup,
): Promise<MarkerVerdicts<T>> {
  const verdicts: MarkerVerdicts<T> = { trusted: null, unverified: [], ignored: [] };
  for (const candidate of [...candidates].reverse()) {
    const c = comment(candidate);
    const authority = await commentAuthority(c, permission);
    if (authority.status === "trusted") {
      verdicts.trusted = candidate;
      break;
    }
    const what = `marker comment${c.createdAt ? ` at ${c.createdAt}` : ""} (${authority.why})`;
    (authority.status === "unknown" ? verdicts.unverified : verdicts.ignored).push(what);
  }
  return verdicts;
}
const ignoredNote = (ignored: string[]): string[] =>
  ignored.length ? [`Ignored marker(s) without write authority: ${ignored.join("; ")}.`] : [];
const markerRecovery = "a maintainer must re-post or confirm the handoff on the ticket";

const marker = (kind: string, parts: unknown[]): string =>
  `<!-- github-triage:${kind}:${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16)} -->`;

/** A release's durable intent, recorded in its handoff comment before labels change. */
interface ReleaseRecord {
  v: 1;
  agent: string;
  outcome: ReleaseOutcome;
  target: string | null;
  remove: string[];
  retained: string[];
  claimedAt: string | null;
  /** The comment's creation time (from GitHub; not serialised). */
  createdAt: string;
  /** The comment carrying the record (not serialised); its author decides its authority. */
  comment?: Comment;
}
/** Marker plus JSON plan; `<`/`>` are escaped so the HTML comment cannot be terminated early. */
const releaseMarker = (op: string, record: ReleaseRecord): string => {
  const { createdAt: _, comment: __, ...plan } = record;
  const json = JSON.stringify(plan).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  return op.replace(/ -->$/, ` ${json} -->`);
};
function releaseRecords(comments: Comment[], op: string): ReleaseRecord[] {
  const prefix = op.replace(/ -->$/, " ");
  const records: ReleaseRecord[] = [];
  for (const c of comments) {
    const at = c.body.indexOf(prefix);
    if (at < 0) continue;
    const endAt = c.body.indexOf(" -->", at + prefix.length);
    try {
      const r = JSON.parse(c.body.slice(at + prefix.length, endAt)) as ReleaseRecord;
      if (r.v === 1 && Array.isArray(r.remove) && Array.isArray(r.retained))
        records.push({ ...r, createdAt: c.createdAt ?? "", comment: c });
    } catch {
      // Not a parsable record: never treated as authorisation.
    }
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
/** Every parsable release record on the issue, oldest first, whoever made it. */
function allReleases(comments: Comment[]): ReleaseRecord[] {
  const records: ReleaseRecord[] = [];
  for (const c of comments) {
    for (const m of c.body.matchAll(/<!-- github-triage:release:[0-9a-f]+ /g)) {
      const start = m.index + m[0].length;
      const end = c.body.indexOf(" -->", start);
      try {
        const r = JSON.parse(c.body.slice(start, end)) as ReleaseRecord;
        if (r.v === 1 && typeof r.agent === "string")
          records.push({ ...r, createdAt: c.createdAt ?? "", comment: c });
      } catch {
        // Not a parsable record: never treated as authorisation.
      }
    }
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
/** The most recent parsable release record, whoever made it: a hint only, never authority. */
const latestRelease = (comments: Comment[]): ReleaseRecord | null =>
  allReleases(comments).at(-1) ?? null;
function labelSteps(
  repository: string,
  number: number,
  add: string[],
  remove: string[],
  repoLabels: Set<string>,
): PlanStep[] {
  const changes: PlanStep[] = add
    .filter((l) => !repoLabels.has(l))
    .map((name) => ({
      step: "create-label",
      command: [
        "label",
        "create",
        name,
        "--repo",
        repository,
        "--color",
        claimPolicy.labelColours[name] ?? "ededed",
      ],
    }));
  if (add.length || remove.length)
    changes.push({
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
    });
  return changes;
}

/** Older label-event pages read at most, so a long label history costs a bounded number of requests. */
const claimHistoryPages = 3;
/**
 * When `ownerLabel` was last added: the identity of the caller's current claim. Pages backwards
 * through label history (bounded) when the add event is not in `readTicket`'s window. `since` is
 * null when no add event was found; `complete` says whether the whole history was searched, so a
 * null there is a genuine absence rather than unknown evidence.
 */
async function claimStart(
  repository: string,
  number: number,
  ownerLabel: string,
  item: TicketIssue,
  query: GraphQuery,
): Promise<{ since: string | null; complete: boolean; events: LabelEvent[] }> {
  const latestAdd = (events: LabelEvent[]): string | null =>
    events
      .filter(
        (e) => e.__typename !== "UnlabeledEvent" && e.label?.name === ownerLabel && e.createdAt,
      )
      .map((e) => e.createdAt!)
      .sort((a, b) => a.localeCompare(b))
      .at(-1) ?? null;
  let events = item.timelineItems?.nodes ?? [];
  let info = item.timelineItems?.pageInfo;
  let since = latestAdd(events);
  const [owner, name] = repository.split("/");
  for (
    let pageNo = 0;
    !since && info?.hasPreviousPage && info.startCursor && pageNo < claimHistoryPages;
    pageNo++
  ) {
    const data = (await query(
      `query($owner:String!,$name:String!,$number:Int!,$before:String!){repository(owner:$owner,name:$name){issue(number:$number){timelineItems(itemTypes:[LABELED_EVENT,UNLABELED_EVENT],last:100,before:$before){nodes{__typename ... on LabeledEvent{createdAt label{name}} ... on UnlabeledEvent{createdAt label{name}}} pageInfo{hasPreviousPage startCursor}}}}}`,
      { owner, name, number, before: info.startCursor },
    )) as {
      repository: {
        issue: { timelineItems: NonNullable<TicketIssue["timelineItems"]> } | null;
      } | null;
    };
    const older = data.repository?.issue?.timelineItems;
    if (!older) break;
    events = [...older.nodes, ...events];
    info = older.pageInfo;
    since = latestAdd(older.nodes);
  }
  return { since, complete: !info?.hasPreviousPage, events };
}

/** Older comment pages read at most, so a long discussion costs a bounded number of requests. */
const commentHistoryPages = 5;
/**
 * The issue's comments, paged backwards from `readTicket`'s newest window until `enough` holds
 * for the comments read so far (or history starts), within a bounded number of requests.
 * `complete` is false when the bound was hit first: the needed comments may be unseen, so their
 * absence is unknown evidence, never "nothing there".
 */
async function commentHistory(
  repository: string,
  number: number,
  item: TicketIssue,
  enough: (comments: Comment[]) => boolean,
  query: GraphQuery,
): Promise<{ comments: Comment[]; complete: boolean }> {
  let comments = item.comments.nodes;
  let info = item.comments.pageInfo;
  const [owner, name] = repository.split("/");
  for (let pageNo = 0; info?.hasPreviousPage && !enough(comments); pageNo++) {
    if (!info.startCursor || pageNo >= commentHistoryPages) return { comments, complete: false };
    const data = (await query(
      `query($owner:String!,$name:String!,$number:Int!,$before:String!){repository(owner:$owner,name:$name){issue(number:$number){comments(last:100,before:$before){nodes{${commentFields}} pageInfo{hasPreviousPage startCursor}}}}}`,
      { owner, name, number, before: info.startCursor },
    )) as { repository: { issue: { comments: TicketIssue["comments"] } | null } | null };
    const older = data.repository?.issue?.comments;
    if (!older) return { comments, complete: false };
    comments = [...older.nodes, ...comments];
    info = older.pageInfo;
  }
  return { comments, complete: true };
}
/** Enough history once the oldest comment read predates `since` (the claim start). */
const reaches =
  (since: string) =>
  (comments: Comment[]): boolean =>
    comments.some((c) => !!c.createdAt && c.createdAt < since);

/** Live read of one ticket plus the agent's open claims. */
async function readTicket(
  repository: string,
  number: number,
  agent: string,
  query: GraphQuery,
  designer = "",
  target = "",
) {
  const [owner, name] = repository.split("/");
  const data = await query(
    `query($owner:String!,$name:String!,$number:Int!,$label:String!,$question:String!,$decision:String!,$needsDesign:String!,$attention:String!${target ? ",$target:String!" : ""}){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){__typename ... on PullRequest{number url} ... on Issue{number title url state updatedAt labels(first:100){nodes{name} pageInfo{hasNextPage}} issueDependenciesSummary{blockedBy} blockedBy(first:20){nodes{number url state}} closedByPullRequestsReferences(first:10,includeClosedPrs:false){nodes{number url state} pageInfo{hasNextPage}} comments(last:100){nodes{${commentFields}} pageInfo{hasPreviousPage startCursor}} timelineItems(itemTypes:[LABELED_EVENT,UNLABELED_EVENT],last:50){nodes{__typename ... on LabeledEvent{createdAt label{name}} ... on UnlabeledEvent{createdAt label{name}}} pageInfo{hasPreviousPage startCursor}}}} claims:issues(first:20,states:OPEN,labels:[$label]){nodes{number title url} pageInfo{hasNextPage}} ownerLabel:label(name:$label){name} questionLabel:label(name:$question){name} decisionLabel:label(name:$decision){name} needsDesignLabel:label(name:$needsDesign){name} attentionLabel:label(name:$attention){name}${target ? " targetLabel:label(name:$target){name}" : ""}}}`,
    {
      owner,
      name,
      number,
      label: claimPolicy.owner(agent),
      question: claimPolicy.question,
      decision: claimPolicy.decisionNeeded,
      needsDesign: claimPolicy.needsDesign,
      attention: designer ? claimPolicy.attention(designer) : "",
      ...(target ? { target } : {}),
    },
  );
  // The response shape is fixed by the query text above; GitHub's GraphQL schema guarantees
  // it for a successful (non-error) response, which `ghQuery` has already established.
  const repo = (data as TicketResponse).repository;
  if (!repo) throw new Error(`Repository unavailable: ${repository}`);
  return {
    item: repo.issueOrPullRequest ?? null,
    claims: repo.claims?.nodes ?? [],
    claimsComplete: !!repo.claims && !repo.claims.pageInfo?.hasNextPage,
    // Exact-name lookups, so a repository with many labels cannot hide an existing one.
    repoLabels: new Set(
      [
        repo.ownerLabel,
        repo.questionLabel,
        repo.decisionLabel,
        repo.needsDesignLabel,
        repo.attentionLabel,
        repo.targetLabel,
      ]
        .filter((l): l is { name: string } => !!l)
        .map((l) => l.name),
    ),
  };
}

/**
 * A refusal: stable ID, current facts, failed prerequisite, recovery commands. Recovery only
 * names implemented commands; anything else is marked as a manual step.
 */
const refuse = (
  error: string,
  facts: ClaimFacts,
  prerequisite: string,
  recovery: string[] = [],
): ClaimRefusal => ({
  ok: false,
  error,
  facts,
  prerequisite,
  recovery,
});

const label = (item: { labels: Labels }, name: string): boolean =>
  item.labels.nodes.some((l) => l.name === name);
const owners = (item: { labels: Labels }): string[] =>
  item.labels.nodes.map((l) => l.name).filter((n) => n.startsWith(workflow.ownerPrefix));

/**
 * Plan `claim N --agent NAME`. Reads only.
 */
export async function planClaim(
  repository: string,
  request: ClaimRequest,
  query: GraphQuery = ghQuery,
  permission: PermissionLookup = permissionLookup(repository),
): Promise<ClaimPlan> {
  const { number, agent, branch = null, platform = null, rework = false } = request;
  const { item, claims, repoLabels } = await readTicket(repository, number, agent, query);
  const triage = `github-triage --repo ${repository}`;
  // Subcommands are dispatched on the first argument, so they must precede options.
  const command = (text: string): string => `github-triage ${text} --repo ${repository}`;
  if (!item)
    return refuse("TICKET_NOT_FOUND", { number }, `#${number} must exist.`, [`${triage} --json`]);
  if (item.__typename !== "Issue")
    return refuse(
      "NOT_AN_ISSUE",
      { number, url: item.url },
      "Only issues can be claimed; a pull request is reviewed or fixed, not claimed.",
      [`${triage} --issue ${number}`],
    );
  const facts = {
    number,
    url: item.url,
    title: item.title,
    state: item.state,
    labels: item.labels.nodes.map((l) => l.name),
    owners: owners(item),
  } satisfies ClaimFacts;
  const mine = claimPolicy.owner(agent);
  if (item.state !== "OPEN")
    return refuse("TICKET_CLOSED", facts, "Only an open ticket can be claimed.", [`${triage}`]);
  // Ownership is decided from the complete label set only.
  if (item.labels.pageInfo?.hasNextPage)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      "More than 100 labels; ownership and readiness cannot be verified.",
      [`${triage} --issue ${number}`],
    );
  const others = facts.owners.filter((o) => o !== mine);
  if (others.length)
    return refuse(
      "OWNED_BY_OTHER",
      facts,
      `Already claimed by ${others.join(", ")}; never take over another agent's claim.`,
      [`${triage} --agent ${agent}`],
    );
  const ownOther = claims.filter((c) => c.number !== number);
  if (ownOther.length)
    return refuse(
      "OTHER_ACTIVE_CLAIM",
      { ...facts, activeClaims: ownOther.map((c) => ({ number: c.number, url: c.url })) },
      `${agent} already has an active claim; one active claim per agent.`,
      [
        // Alternatives are separate executable entries: never a shell comment inside a command,
        // which would swallow the trailing --repo.
        ...ownOther.flatMap((c) => [
          command(
            `release ${c.number} --agent ${agent} --as incomplete --note '<what was done and what remains>'`,
          ),
          command(`release ${c.number} --agent ${agent} --as ready`),
          command(`release ${c.number} --agent ${agent} --as done --pr '<pull request URL>'`),
        ]),
        command(
          `claim ${number} --agent ${agent}${branch ? ` --branch ${branch}` : ""}${rework ? " --rework" : ""}`,
        ),
      ],
    );
  const op = marker("claim", [repository, number, agent]);
  const claimComment = (): PlanStep => ({
    step: "comment",
    command: [
      "issue",
      "comment",
      String(number),
      "--repo",
      repository,
      "--body",
      `Claimed by \`${agent}\`${branch ? ` on branch \`${branch}\`` : ""} with \`github-triage claim\`.\n\n${op}`,
    ],
  });
  if (label(item, mine)) {
    // Complete only when the explanatory comment exists too: a run whose comment failed is
    // repaired by retrying just that step.
    // This acquisition began when the label was last added; only a claim comment posted since
    // then counts, so an earlier claim's comment (before a release) does not.
    const history = await claimStart(repository, number, mine, item, query);
    const since = history.since;
    const found =
      since || history.complete
        ? await commentHistory(
            repository,
            number,
            item,
            since ? reaches(since) : () => false,
            query,
          )
        : null;
    if (!found?.complete)
      return refuse(
        "EVIDENCE_INCOMPLETE",
        facts,
        `${mine} is on #${number}, but ${found ? "the comments since this claim began" : "when it was added"} cannot be read within the bounded history, so whether its claim comment was posted is unknown; nothing is changed.`,
        [`${triage} --issue ${number}`, command(`who ${number}`)],
      );
    // Only a claim comment with write authority proves the comment step ran (#212): a forged
    // copy of the public marker never suppresses it.
    const posted = await newestTrusted(
      found.comments.filter(
        (c) => c.body.includes(op) && (!since || !c.createdAt || c.createdAt >= since),
      ),
      (c) => c,
      permission,
    );
    const commented = !!posted.trusted;
    if (!commented && posted.unverified.length)
      return refuse(
        "MARKER_UNVERIFIED",
        facts,
        `${mine} is on #${number}, but the authority of its claim comment cannot be verified (${posted.unverified.join("; ")}), so whether the claim comment was posted is unknown; nothing is changed. Recovery: ${markerRecovery}, then retry.`,
        [command(`who ${number}`), `${triage} --issue ${number}`],
      );
    return {
      ok: true,
      noop: commented,
      facts,
      reason: commented
        ? `Already claimed by ${agent}.`
        : `Claimed by ${agent}; posting the missing claim comment.`,
      changes: commented ? [] : [claimComment()],
      ...(commented ? {} : { notes: ignoredNote(posted.ignored) }),
      // Completing a partly failed acquisition gets the same post-write ownership check.
      ...(commented ? {} : { recheck: { agent } }),
    };
  }
  const openPrs = item.closedByPullRequestsReferences.nodes.filter((p) => p.state === "OPEN");
  // More linked PRs than one page: an open one may be unseen, so "no open PR" is unknown.
  if (!openPrs.length && item.closedByPullRequestsReferences.pageInfo?.hasNextPage)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      "More than 10 linked pull requests; whether one is open cannot be verified.",
      [`${triage} --issue ${number}`],
    );
  // Without --rework, the newest release in the window is only a hint for suggesting --rework;
  // it never authorises anything, so no permission is looked up.
  let lastRelease = rework ? null : latestRelease(item.comments.nodes);
  let claimedSince: string | null = rework ? null : (lastRelease?.claimedAt ?? null);
  let ignored: string[] = [];
  if (rework) {
    // The rework reclaim is authorised only by the caller's own done handoff for the claim it
    // released (#212): that claim began when the caller's label was last added, and its handoff
    // was posted after that, so the comments since then hold every record that can authorise it.
    const history = await claimStart(repository, number, mine, item, query);
    claimedSince = history.since;
    if (!claimedSince && !history.complete)
      return refuse(
        "EVIDENCE_INCOMPLETE",
        facts,
        `When ${mine} was last added to #${number} cannot be established from its label history, so ${agent}'s handoff cannot be tied to the claim it released.`,
        [`${triage} --issue ${number}`, command(`who ${number}`)],
      );
    const releaseHistory = claimedSince
      ? await commentHistory(repository, number, item, reaches(claimedSince), query)
      : { comments: [], complete: true };
    if (!releaseHistory.complete)
      return refuse(
        "EVIDENCE_INCOMPLETE",
        facts,
        `No handoff record found within the bounded comment history of #${number}, so the latest release (and whether it is ${agent}'s own done handoff) cannot be verified.`,
        [`${triage} --issue ${number}`, command(`who ${number}`)],
      );
    // Only a handoff posted by a current writer counts (#212); forged ones are ignored.
    const verdicts = await newestTrusted(
      allReleases(releaseHistory.comments).filter((r) => r.createdAt >= claimedSince!),
      (r) => r.comment ?? { body: "" },
      permission,
    );
    ignored = verdicts.ignored;
    if (verdicts.unverified.length)
      return refuse(
        "MARKER_UNVERIFIED",
        facts,
        `The authority of a handoff on #${number} cannot be verified (${verdicts.unverified.join("; ")}), so the latest release cannot be established; nothing is changed. Recovery: ${markerRecovery}, then retry.`,
        [`${triage} --issue ${number}`, command(`who ${number}`)],
      );
    lastRelease = verdicts.trusted;
  }
  // Conservative authorisation: awaiting review, an open PR, and the caller's own done handoff
  // for the claim it released is the latest trusted release on this issue.
  const reworkable =
    label(item, claimPolicy.awaitingReview) &&
    openPrs.length > 0 &&
    lastRelease?.agent === agent &&
    lastRelease.outcome === "done" &&
    // A handoff with no recorded claim time, or another claim's, is never the caller's claim.
    !!lastRelease.claimedAt &&
    lastRelease.claimedAt === claimedSince;
  const reworkCommand = command(
    `claim ${number} --agent ${agent}${branch ? ` --branch ${branch}` : ""} --rework`,
  );
  if (rework && !reworkable)
    return refuse(
      "REWORK_NOT_AUTHORISED",
      {
        ...facts,
        pullRequests: openPrs.map((p) => p.url),
        ...(lastRelease ? { lastReleasedBy: lastRelease.agent } : {}),
      },
      `Review rework needs ${claimPolicy.awaitingReview}, an open pull request, and ${agent}'s own done handoff, posted by a user with write access and recording the claim time of ${agent}'s last claim${claimedSince ? ` (${claimedSince})` : ""}, as the latest release on #${number}.${ignored.length ? ` ${ignoredNote(ignored)[0]}` : ""}`,
      [`${triage} --issue ${number}`, `${triage} --agent ${agent}`],
    );
  if (
    label(item, claimPolicy.question) ||
    label(item, claimPolicy.needsDesign) ||
    label(item, claimPolicy.decisionNeeded)
  )
    return refuse(
      "NOT_READY",
      facts,
      "The ticket has an outstanding question or design prerequisite.",
      [`${triage} --issue ${number}`, `${triage} --agent ${agent}`],
    );
  const held = claimPolicy.held.filter((l) => label(item, l));
  if (held.length)
    return refuse(
      "NOT_READY",
      facts,
      `The ticket is ${held.join(" and ")}; resolve that before claiming, even if a ready label remains.`,
      [`${triage} --issue ${number}`, `${triage} --agent ${agent}`],
    );
  if (!rework && !claimPolicy.pickable.some((l) => label(item, l)))
    return refuse(
      "NOT_READY",
      facts,
      `The ticket needs ${claimPolicy.pickable.join(" or ")} to be picked up.${reworkable ? " To fix review feedback on your own pull request, reclaim it explicitly with --rework." : ""}`,
      [...(reworkable ? [reworkCommand] : []), `${triage} --agent ${agent}`],
    );
  if (!item.issueDependenciesSummary)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      "Native blocker evidence is unavailable; readiness is unknown.",
      [command(`deps ${number}`)],
    );
  if (item.issueDependenciesSummary.blockedBy > 0)
    return refuse(
      "BLOCKED",
      {
        ...facts,
        openBlockers: item.blockedBy.nodes.filter((b) => b.state === "OPEN").map((b) => b.url),
      },
      "Open native blockers must close first.",
      [command(`deps ${number}`), `${triage} --agent ${agent}`],
    );
  if (openPrs.length && !rework)
    return refuse(
      "HAS_OPEN_PR",
      { ...facts, pullRequests: openPrs.map((p) => p.url) },
      "An open pull request already addresses this ticket; follow up on it instead.",
      [
        ...(reworkable ? [reworkCommand] : []),
        ...openPrs.map((p) => `gh pr view ${p.number} --repo ${repository}`),
      ],
    );
  const restrictions = facts.labels
    .filter((l) => l.startsWith(claimPolicy.platformPrefix))
    .map((l) => l.slice(claimPolicy.platformPrefix.length));
  if (restrictions.length && !platform)
    return refuse(
      "PLATFORM_UNKNOWN",
      { ...facts, platforms: restrictions },
      `The ticket is restricted to ${restrictions.join(", ")}; state your platform with --platform.`,
      [command(`claim ${number} --agent ${agent} --platform ${restrictions[0]}`)],
    );
  // platform is non-null here: an empty platform with restrictions was refused just above.
  if (restrictions.length && !restrictions.includes(platform ?? ""))
    return refuse(
      "PLATFORM_MISMATCH",
      { ...facts, platforms: restrictions, platform },
      `The ticket is restricted to ${restrictions.join(", ")}.`,
      [`${triage} --agent ${agent}`],
    );
  const remove = [...claimPolicy.pickable, ...(rework ? [claimPolicy.awaitingReview] : [])].filter(
    (l) => label(item, l),
  );
  // A fresh acquisition (label absent) always explains itself; retries of this acquisition are
  // handled above, where the label is already present.
  const changes: PlanStep[] = [];
  if (!repoLabels.has(mine))
    changes.push({
      step: "create-label",
      command: [
        "label",
        "create",
        mine,
        "--repo",
        repository,
        "--color",
        claimPolicy.labelColours.agent,
        "--description",
        `Claimed by agent ${agent}`,
      ],
    });
  changes.push({
    step: "labels",
    command: [
      "issue",
      "edit",
      String(number),
      "--repo",
      repository,
      "--add-label",
      mine,
      ...remove.flatMap((l) => ["--remove-label", l]),
    ],
  });
  // Always post the claim comment for a new acquisition.
  changes.push({
    step: "comment",
    command: [
      "issue",
      "comment",
      String(number),
      "--repo",
      repository,
      "--body",
      `Claimed by \`${agent}\`${branch ? ` on branch \`${branch}\`` : ""} with \`github-triage claim\`${rework ? " for review rework" : ""}. Removed: ${remove.map((l) => `\`${l}\``).join(", ")}.\n\n${op}`,
    ],
  });
  return {
    ok: true,
    noop: false,
    facts,
    changes,
    recheck: { agent },
    ...(ignored.length ? { notes: ignoredNote(ignored) } : {}),
  };
}

/**
 * Plan `needs-human N --agent NAME --designer NAME --why TEXT --question TEXT...`.
 */
export async function planNeedsHuman(
  repository: string,
  request: NeedsHumanRequest,
  query: GraphQuery = ghQuery,
  permission: PermissionLookup = permissionLookup(repository),
): Promise<ClaimPlan> {
  const { number, agent, designer, why, questions } = request;
  const { item, repoLabels } = await readTicket(repository, number, agent, query, designer);
  const triage = `github-triage --repo ${repository}`;
  if (!item)
    return refuse("TICKET_NOT_FOUND", { number }, `#${number} must exist.`, [`${triage} --json`]);
  if (item.__typename !== "Issue")
    return refuse(
      "NOT_AN_ISSUE",
      { number, url: item.url },
      "Questions are recorded on the issue the pull request addresses.",
      [`gh pr view ${number} --repo ${repository}`],
    );
  const facts = {
    number,
    url: item.url,
    title: item.title,
    state: item.state,
    labels: item.labels.nodes.map((l) => l.name),
    owners: owners(item),
  } satisfies ClaimFacts;
  if (item.state !== "OPEN")
    return refuse("TICKET_CLOSED", facts, "Questions are recorded on open tickets.", [
      `gh issue reopen ${number} --repo ${repository}   # manual, only if it should be open`,
    ]);
  if (item.labels.pageInfo?.hasNextPage)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      "More than 100 labels; the caller's claim and readiness cannot be verified, so nothing is posted.",
      [`${triage} --issue ${number}`],
    );
  const mine = claimPolicy.owner(agent);
  const op = marker("needs-human", [repository, number, agent, designer, why, questions]);
  const seen = await commentHistory(
    repository,
    number,
    item,
    (c) => c.some((x) => x.body.includes(op)),
    query,
  );
  if (!seen.complete)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      "The comment history is longer than the bounded read, so whether these questions were already posted is unknown; nothing is posted.",
      [`${triage} --issue ${number}`],
    );
  // Only a marker with write authority suppresses a repeat question (#214): a forged copy is
  // ignored with a warning, and an unverifiable one never suppresses, so the question is posted.
  const posted = await newestTrusted(
    seen.comments.filter((c) => c.body.includes(op)),
    (c) => c,
    permission,
  );
  const already = posted.trusted !== null;
  const readiness = workflow.readiness.filter((l) => label(item, l));
  const swap = claimPolicy.pickable.filter((l) => label(item, l));
  // Exactly one readiness label: replace ready/incomplete with needs-design; add it when there
  // is none; leave another deliberate state (blocked, parked) alone and report it.
  const held = claimPolicy.held.filter((l) => label(item, l));
  // Never add a second readiness state on top of a deliberate blocked/parked one.
  const addNeedsDesign =
    !label(item, claimPolicy.needsDesign) && !held.length && (swap.length || !readiness.length);
  const attention = claimPolicy.attention(designer);
  const add = [
    claimPolicy.question,
    claimPolicy.decisionNeeded,
    attention,
    ...(addNeedsDesign ? [claimPolicy.needsDesign] : []),
  ].filter((l) => !label(item, l));
  const remove = [...swap, ...(label(item, mine) ? [mine] : [])];
  const notes: string[] = ignoredNote(posted.ignored);
  if (!already && posted.unverified.length)
    notes.push(
      `Marker(s) whose authority could not be verified do not suppress the question: ${posted.unverified.join("; ")}.`,
    );
  if (held.length)
    notes.push(`Readiness ${held.join(", ")} kept; not replaced with ${claimPolicy.needsDesign}.`);
  const changes: PlanStep[] = [];
  if (!already)
    changes.push({
      step: "comment",
      command: [
        "issue",
        "comment",
        String(number),
        "--repo",
        repository,
        "--body",
        [
          claimPolicy.questionsHeading,
          "",
          `Designer: \`${designer}\` · Raised by: \`${agent}\``,
          "",
          `**Why:** ${why}`,
          "",
          ...questions.map((q, i) => `${i + 1}. ${q}`),
          "",
          op,
        ].join("\n"),
      ],
    });
  for (const name of add.filter((l) => !repoLabels.has(l)))
    changes.push({
      step: "create-label",
      command: [
        "label",
        "create",
        name,
        "--repo",
        repository,
        "--color",
        claimPolicy.labelColours[name] ?? "ededed",
      ],
    });
  if (add.length || remove.length)
    changes.push({
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
    });
  return { ok: true, noop: !changes.length, facts, changes, notes };
}

/** Live state of a supplied pull request URL; null when it cannot be verified. */
async function readPullRequest(url: string, query: GraphQuery): Promise<string | null> {
  try {
    const data = (await query(
      `query($url:URI!){resource(url:$url){__typename ... on PullRequest{state}}}`,
      { url },
    )) as { resource: { __typename: string; state?: string } | null };
    return data.resource?.__typename === "PullRequest" ? (data.resource.state ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Plan `release N --agent NAME --as ready|incomplete|parked|done [--note TEXT] [--pr URL|--change URL]`
 * (#62, doc/design/workflow.md "Focused handoff"). Reads only.
 *
 * The outcome is always the agent's explicit choice. The handoff comment is posted first and
 * records the whole label plan (target, labels to remove, owners retained, claim time) in a
 * hidden marker; labels change second. A retry is accepted only on that recorded intent: it
 * completes exactly the recorded label plan, or refuses if ownership/readiness changed since.
 */
export async function planRelease(
  repository: string,
  request: ReleaseRequest,
  query: GraphQuery = ghQuery,
  permission: PermissionLookup = permissionLookup(repository),
): Promise<ClaimPlan> {
  const { number, agent, outcome, note = null, pr = null, change = null } = request;
  const triage = `github-triage --repo ${repository}`;
  const command = (text: string): string => `github-triage ${text} --repo ${repository}`;
  const deliverable = pr ?? change;
  const prState = pr ? await readPullRequest(pr, query) : null;
  const preliminary =
    outcome === "ready" ? workflow.ready : outcome === "done" ? null : claimPolicy.incomplete;
  // Done with an open PR (supplied or linked) awaits review; otherwise contribution-done.
  const { item, repoLabels } = await readTicket(
    repository,
    number,
    agent,
    query,
    "",
    preliminary ?? claimPolicy.awaitingReview,
  );
  if (!item)
    return refuse("TICKET_NOT_FOUND", { number }, `#${number} must exist.`, [`${triage} --json`]);
  if (item.__typename !== "Issue")
    return refuse(
      "NOT_AN_ISSUE",
      { number, url: item.url },
      "Only an issue holds a claim; hand over on the issue the pull request addresses.",
      [`gh pr view ${number} --repo ${repository}`],
    );
  const linkedOpen = item.closedByPullRequestsReferences.nodes.filter((p) => p.state === "OPEN");
  const linkedUnknown =
    !linkedOpen.length && !!item.closedByPullRequestsReferences.pageInfo?.hasNextPage;
  // A verified open closing PR establishes review whatever state a supplied --pr has.
  const openPr = prState === "OPEN" || linkedOpen.length > 0;
  const target = outcome === "done" ? (openPr ? claimPolicy.awaitingReview : null) : preliminary;
  const facts = {
    number,
    url: item.url,
    title: item.title,
    state: item.state,
    labels: item.labels.nodes.map((l) => l.name),
    owners: owners(item),
    outcome,
    deliverable,
    pullRequestState: pr ? (prState ?? "UNKNOWN") : null,
    target,
    ...(linkedOpen.length ? { pullRequests: linkedOpen.map((p) => p.url) } : {}),
  } satisfies ClaimFacts;
  if (item.labels.pageInfo?.hasNextPage)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      "More than 100 labels; the caller's claim and readiness cannot be verified, so nothing is changed.",
      [`${triage} --issue ${number}`, command(`who ${number}`)],
    );
  // Done's target depends on whether a PR is open; an unseen linked PR makes that unknown.
  if (outcome === "done" && prState !== "OPEN" && linkedUnknown)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      "More than 10 linked pull requests; whether one is open (and so the handoff target) cannot be verified.",
      [`${triage} --issue ${number}`],
    );
  const mine = claimPolicy.owner(agent);
  const args = [
    `release ${number} --agent ${agent} --as ${outcome}`,
    ...(note ? [`--note ${shellQuote(note)}`] : []),
    ...(pr ? [`--pr ${shellQuote(pr)}`] : []),
    ...(change ? [`--change ${shellQuote(change)}`] : []),
  ].join(" ");
  const retry = command(args);
  // The operation identity is the claim being released (when its label was last added). The
  // handoff comment is posted BEFORE any label changes and carries the full label plan, so a
  // retry is authorised only by that durable record of intent, never by label history alone.
  const history = await claimStart(repository, number, mine, item, query);
  const since = history.since;
  if (!since && (!history.complete || label(item, mine)))
    // Without the claim's start time, separate acquisitions by this agent are indistinguishable,
    // so no recorded handoff may be matched (it could belong to an earlier claim).
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      `When ${mine} was added to #${number} cannot be established from its label history, so this claim cannot be told apart from earlier ones; nothing is changed. Inspect the ticket's label history and coordinate on the ticket, or remove and re-add ${mine} to start a verifiable claim.`,
      [`${triage} --issue ${number}`, command(`who ${number}`)],
    );
  // Every handoff recorded for this claim was posted after it began: read back to that point.
  const recorded = since
    ? await commentHistory(repository, number, item, reaches(since), query)
    : { comments: item.comments.nodes, complete: true };
  if (!recorded.complete)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      `The comments since ${mine} was added at ${since} exceed the bounded read, so a handoff already recorded for this claim may be unseen; nothing is changed.`,
      [`${triage} --issue ${number}`, command(`who ${number}`)],
    );
  const events = history.events.filter((e) => e.label && e.createdAt);
  const removed = (e: (typeof events)[number]): boolean => e.__typename === "UnlabeledEvent";
  const op = marker("release", [repository, number, agent, since]);
  // A record with no claim time can never be tied to a particular claim, so it never matches.
  // The marker's hash is of public values, so only a record posted by a current writer is the
  // recorded intent (#212); a forged one is ignored and named, an unverifiable one refused.
  const verdicts = await newestTrusted(
    since
      ? releaseRecords(recorded.comments, op).filter(
          (r) => r.agent === agent && r.claimedAt !== null && r.claimedAt === since,
        )
      : [],
    (r) => r.comment ?? { body: "" },
    permission,
  );
  if (verdicts.unverified.length)
    return refuse(
      "MARKER_UNVERIFIED",
      facts,
      `A handoff recorded for ${agent}'s claim on #${number} cannot be verified (${verdicts.unverified.join("; ")}), so whether its label plan applies is unknown; nothing is changed. Recovery: ${markerRecovery}, then retry.`,
      [command(`who ${number}`), `${triage} --issue ${number}`],
    );
  const record = verdicts.trusted ?? undefined;
  const ignored = ignoredNote(verdicts.ignored);
  const holds = label(item, mine);
  const others = facts.owners.filter((o) => o !== mine);
  if (record) {
    const recordedRetry = command(`release ${number} --agent ${agent} --as ${record.outcome}`);
    const recorded = { ...facts, outcome: record.outcome, target: record.target };
    const same = (a: string[], b: string[]): boolean =>
      a.length === b.length && a.every((x) => b.includes(x));
    // The plan removes the caller's own claim label in the same write that applies the rest, so
    // while that label is present the label step is demonstrably unfinished. Once it is gone the
    // step completed, and whatever happened to the labels since (a merged PR's review label
    // removed by a maintainer, say) belongs to others: never restore labels from the plan.
    if (!holds)
      return {
        ok: true,
        noop: true,
        facts: recorded,
        reason: `Handoff already recorded and ${agent}'s claim already released.`,
        changes: [],
        notes: ignored,
      };
    // Anything another party did after the record (a new owner, a readiness label other than
    // the recorded target) means the recorded plan no longer describes the ticket.
    const handoffStates = [...workflow.readiness, claimPolicy.awaitingReview];
    // Additions and removals both count; only changes the plan itself makes are expected.
    const relevant = (n: string): boolean =>
      n.startsWith(workflow.ownerPrefix) || handoffStates.includes(n);
    const later = events
      .filter((e) => e.createdAt! > record.createdAt && relevant(e.label!.name))
      .filter((e) =>
        removed(e) ? !record.remove.includes(e.label!.name) : e.label!.name !== record.target,
      )
      .map((e) => `${removed(e) ? "-" : "+"}${e.label!.name}`);
    if (later.length || !same(others, record.retained))
      return refuse(
        "RELEASE_DIVERGED",
        recorded,
        `A handoff was recorded for ${agent}'s claim at ${record.createdAt}, but ownership or readiness changed afterwards (${[...new Set([...later, ...others.filter((o) => !record.retained.includes(o))])].join(", ") || "retained owners removed"}); the recorded label plan is not applied. Inspect and coordinate on the ticket.`,
        [command(`who ${number}`), `${triage} --issue ${number}`],
      );
    if (outcome !== record.outcome)
      return refuse(
        "RELEASE_PENDING",
        recorded,
        `A ${record.outcome} handoff is already recorded for this claim and its labels are not yet applied; complete it with the recorded outcome.`,
        [recordedRetry],
      );
    const add = record.target && !label(item, record.target) ? [record.target] : [];
    const remove = record.remove.filter((l) => label(item, l));
    return {
      ok: true,
      noop: false,
      facts: recorded,
      reason: "Handoff comment already recorded; applying its recorded label changes.",
      changes: labelSteps(repository, number, add, remove, repoLabels),
      notes: [
        ...ignored,
        ...(record.retained.length ? [`Other owners kept: ${record.retained.join(", ")}.`] : []),
      ],
      recheck: { agent, release: { target: record.target } },
      retry: recordedRetry,
    };
  }
  if (!holds)
    return refuse(
      "NOT_CLAIMED",
      facts,
      `${agent} holds no claim on #${number}${others.length ? ` (owned by ${others.join(", ")})` : ""}; only the caller's own claim can be released.`,
      [command(`who ${number}`), `${triage} --agent ${agent}`],
    );
  if (item.state !== "OPEN" && outcome !== "done")
    return refuse(
      "TICKET_CLOSED",
      facts,
      `#${number} is closed; only --as done can hand over a closed ticket's claim.`,
      [
        command(
          `release ${number} --agent ${agent} --as done${pr ? ` --pr ${shellQuote(pr)}` : ""}`,
        ),
      ],
    );
  const notes: string[] = [...ignored];
  if (!note) notes.push("No handoff note supplied; release proceeds, but a note is expected.");
  if (others.length) notes.push(`Other owners kept: ${others.join(", ")}.`);
  if (pr && !prState)
    notes.push(
      `Pull request state is UNKNOWN (${pr} could not be verified); not treated as open or merged.`,
    );
  if (outcome === "done" && !deliverable && !linkedOpen.length)
    notes.push("Done without a PR or change link; inspect the ticket to confirm the deliverable.");
  if (outcome === "done" && !target)
    notes.push(
      "Contribution done with no open PR: no readiness label is added, so the ticket is reported for inspection, not returned to pickup or closed.",
    );
  const held = [...claimPolicy.held, claimPolicy.needsDesign].filter((l) => label(item, l));
  if (held.length) notes.push(`Kept unrelated state: ${held.join(", ")}.`);
  // Exactly one handoff readiness state; questions, blockers, attention and others untouched.
  const handoff = [...claimPolicy.pickable, claimPolicy.awaitingReview];
  const remove = [mine, ...handoff.filter((l) => l !== target && label(item, l))];
  const add = target && !label(item, target) ? [target] : [];
  const plan: ReleaseRecord = {
    v: 1,
    agent,
    outcome,
    target,
    remove,
    retained: others,
    claimedAt: since,
    createdAt: "",
  };
  const describe =
    outcome === "done"
      ? target
        ? `done; awaiting review (\`${target}\`)`
        : "done (contribution finished; no open PR, for inspection)"
      : outcome === "parked"
        ? `incomplete (parked; \`${target}\`)`
        : `${outcome} (\`${target}\`)`;
  const changes: PlanStep[] = [];
  changes.push({
    step: "comment",
    command: [
      "issue",
      "comment",
      String(number),
      "--repo",
      repository,
      "--body",
      [
        `Handoff by \`${agent}\` with \`github-triage release\`: **${describe}**. Releasing the claim.`,
        "",
        ...(pr
          ? [`Pull request: ${pr}${prState ? ` (${prState})` : " (state unknown)"}`, ""]
          : change
            ? [`Change: ${change}`, ""]
            : []),
        note ? `**Note:** ${note}` : "_No handoff note supplied._",
        "",
        releaseMarker(op, plan),
      ].join("\n"),
    ],
  });
  changes.push(...labelSteps(repository, number, add, remove, repoLabels));
  return {
    ok: true,
    noop: false,
    facts,
    changes,
    notes,
    recheck: { agent, release: { target } },
    retry,
  };
}

/**
 * Apply a plan step by step. The comment comes first for needs-human, so a failed comment
 * leaves nothing changed. After a claim, ownership is re-read and conflicts are reported.
 * Exit: 0 done, 2 partly done or conflict, 1 nothing done.
 */
export async function applyPlan(
  repository: string,
  plan: ClaimPlan,
  { run = ghRun, query = ghQuery }: { run?: GhRun; query?: GraphQuery } = {},
): Promise<ClaimResult> {
  if (!plan.ok) return { ...plan, exitCode: 1 };
  const steps: PlanStep[] = plan.changes.map((c) => ({ ...c, status: "pending" }));
  let failed = false;
  for (const step of steps) {
    if (failed) {
      step.status = "skipped";
      continue;
    }
    try {
      await run(step.command);
      step.status = "done";
    } catch (error) {
      step.status = "failed";
      step.reason = errorMessage(error);
      failed = true;
    }
  }
  const done = steps.filter((s) => s.status === "done").length;
  let conflict: string | null = null;
  let unverified: string | null = null;
  const verify = `Verify with: github-triage who ${plan.facts.number} --repo ${repository} (or github-triage --repo ${repository} --issue ${plan.facts.number})${plan.retry ? `; the same command is safe to re-run: ${plan.retry}` : ""}.`;
  if (!failed && plan.recheck && done) {
    try {
      const mine = claimPolicy.owner(plan.recheck.agent);
      const ticket = await readTicket(repository, plan.facts.number, plan.recheck.agent, query);
      const { claims, claimsComplete } = ticket;
      // A claim is only ever planned for an issue; anything else cannot hold the claim.
      const item = ticket.item?.__typename === "Issue" ? ticket.item : null;
      const others = item ? owners(item).filter((o) => o !== mine) : [];
      const elsewhere = claims.filter((c) => c.number !== plan.facts.number);
      // GitHub label edits are not a lock: report conflicts rather than resolve them.
      const problems: string[] = [];
      // Missing or truncated evidence is never success: report it as unverified.
      const gaps: string[] = [];
      if (!item) gaps.push(`#${plan.facts.number} could not be re-read as an issue`);
      else if (item.labels?.pageInfo?.hasNextPage)
        gaps.push(
          `#${plan.facts.number} has more than 100 labels, so ${plan.recheck.release ? "a remaining claim label" : "a competing claim"} may be unseen`,
        );
      if (!plan.recheck.release && !claimsComplete)
        gaps.push(`${plan.recheck.agent}'s open claims could not be read completely`);
      if (gaps.length) unverified = `Writes completed, but ${gaps.join("; ")}. ${verify}`;
      else if (plan.recheck.release) {
        const target = plan.recheck.release.target;
        if (owners(item!).includes(mine))
          problems.push(`${mine} is still recorded on #${plan.facts.number}`);
        if (target && !label(item!, target))
          problems.push(`${target} is no longer on #${plan.facts.number}`);
      } else {
        if (item!.state !== "OPEN" || !owners(item!).includes(mine))
          problems.push(
            `the claim is no longer recorded on #${plan.facts.number} (open, labelled ${mine})`,
          );
        if (others.length)
          problems.push(`another claim appeared concurrently: ${others.join(", ")}`);
        if (elsewhere.length)
          problems.push(
            `${plan.recheck.agent} now also claims ${elsewhere.map((c) => `#${c.number}`).join(", ")}; one active claim per agent`,
          );
      }
      if (problems.length)
        conflict = `${problems.join("; ")}. Coordinate on the tickets; nothing was removed.`;
    } catch (error) {
      // Keep the completed writes; ownership is merely unverified.
      unverified = `Writes completed, but ownership could not be re-checked (${errorMessage(error)}). ${verify}`;
    }
  }
  const exitCode = failed ? (done ? 2 : 1) : conflict || unverified ? 2 : 0;
  return { ...plan, steps, conflict, unverified, exitCode };
}

/** POSIX shell quoting for displayed commands: nothing inside single quotes is expanded. */
export const shellQuote = (arg: string): string =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;

/** Text rendering for plans, refusals and results. */
export function claimText(result: ClaimPlan | ClaimResult, dryRun = false): string {
  if (!result.ok)
    return (
      [
        `REFUSED ${result.error}: ${result.prerequisite}`,
        `Ticket: ${result.facts.url ?? `#${result.facts.number}`}`,
        ...(result.facts.owners?.length ? [`Owners: ${result.facts.owners.join(", ")}`] : []),
        ...(result.facts.activeClaims ?? []).map((c) => `Active claim: ${c.url}`),
        ...(result.facts.openBlockers ?? []).map((b) => `Open blocker: ${b}`),
        ...(result.facts.pullRequests ?? []).map((p) => `Open PR: ${p}`),
        ...(result.recovery.length ? ["Recovery:", ...result.recovery.map((r) => `  ${r}`)] : []),
      ].join("\n") + "\n"
    );
  const lines = [`${result.facts.url} ${result.facts.title}`];
  if (result.facts.outcome)
    lines.push(
      `Handoff: ${result.facts.outcome} -> ${result.facts.target ?? "no readiness label (contribution done, inspect)"}${result.facts.deliverable ? ` · ${result.facts.deliverable}${result.facts.pullRequestState ? ` (${result.facts.pullRequestState})` : ""}` : ""}`,
    );
  if (result.noop) lines.push(result.reason ?? "Nothing to change.");
  if (dryRun) lines.push("DRY RUN: no changes made.");
  for (const c of ("steps" in result ? result.steps : undefined) ?? result.changes)
    lines.push(
      `- ${c.step}${c.status ? `: ${c.status}` : ""}${c.reason ? ` — ${c.reason}` : ""}`,
      ...(dryRun ? [`    gh ${c.command.map(shellQuote).join(" ")}`] : []),
    );
  for (const n of result.notes ?? []) lines.push(`Note: ${n}`);
  if ("conflict" in result && result.conflict) lines.push(`CONFLICT: ${result.conflict}`);
  if ("unverified" in result && result.unverified) lines.push(`UNVERIFIED: ${result.unverified}`);
  if (result.retry && "exitCode" in result && result.exitCode !== 0)
    lines.push(`Retry (safe; completes only the missing steps): ${result.retry}`);
  return lines.join("\n") + "\n";
}

/** `error.message` as the JavaScript read it: undefined for a thrown non-Error value. */
function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}
