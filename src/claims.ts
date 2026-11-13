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
import { ghQuery } from "./github.js";
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
  | (ClaimRefusal & { exitCode: number; steps?: undefined; conflict?: undefined })
  | (ClaimAccepted & { steps: PlanStep[]; conflict: string | null; exitCode: number });

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
  closedByPullRequestsReferences: { nodes: { number: number; url: string; state: string }[] };
  comments: { nodes: { body: string; createdAt?: string }[] };
  timelineItems?: { nodes: { createdAt?: string; label?: { name: string } }[] };
}
type TicketItem = TicketIssue | { __typename: "PullRequest"; number: number; url: string };
interface TicketResponse {
  repository: {
    issueOrPullRequest: TicketItem | null;
    claims: { nodes: { number: number; title: string; url: string }[] } | null;
    ownerLabel: { name: string } | null;
    questionLabel: { name: string } | null;
    decisionLabel: { name: string } | null;
    needsDesignLabel: { name: string } | null;
    attentionLabel: { name: string } | null;
    targetLabel?: { name: string } | null;
  } | null;
}

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
}
/** Marker plus JSON plan; `<`/`>` are escaped so the HTML comment cannot be terminated early. */
const releaseMarker = (op: string, record: ReleaseRecord): string => {
  const { createdAt: _, ...plan } = record;
  const json = JSON.stringify(plan).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  return op.replace(/ -->$/, ` ${json} -->`);
};
function releaseRecords(
  comments: { body: string; createdAt?: string }[],
  op: string,
): ReleaseRecord[] {
  const prefix = op.replace(/ -->$/, " ");
  const records: ReleaseRecord[] = [];
  for (const c of comments) {
    const at = c.body.indexOf(prefix);
    if (at < 0) continue;
    const endAt = c.body.indexOf(" -->", at + prefix.length);
    try {
      const r = JSON.parse(c.body.slice(at + prefix.length, endAt)) as ReleaseRecord;
      if (r.v === 1 && Array.isArray(r.remove) && Array.isArray(r.retained))
        records.push({ ...r, createdAt: c.createdAt ?? "" });
    } catch {
      // Not a parsable record: never treated as authorisation.
    }
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
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
    `query($owner:String!,$name:String!,$number:Int!,$label:String!,$question:String!,$decision:String!,$needsDesign:String!,$attention:String!${target ? ",$target:String!" : ""}){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){__typename ... on PullRequest{number url} ... on Issue{number title url state updatedAt labels(first:100){nodes{name} pageInfo{hasNextPage}} issueDependenciesSummary{blockedBy} blockedBy(first:20){nodes{number url state}} closedByPullRequestsReferences(first:10,includeClosedPrs:false){nodes{number url state}} comments(last:100){nodes{body createdAt}} timelineItems(itemTypes:[LABELED_EVENT],last:50){nodes{... on LabeledEvent{createdAt label{name}}}}}} claims:issues(first:20,states:OPEN,labels:[$label]){nodes{number title url}} ownerLabel:label(name:$label){name} questionLabel:label(name:$question){name} decisionLabel:label(name:$decision){name} needsDesignLabel:label(name:$needsDesign){name} attentionLabel:label(name:$attention){name}${target ? " targetLabel:label(name:$target){name}" : ""}}}`,
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
): Promise<ClaimPlan> {
  const { number, agent, branch = null, platform = null } = request;
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
        ...ownOther.map((c) =>
          command(
            `release ${c.number} --agent ${agent} --as incomplete --note '<what was done and what remains>'   # or --as ready if untouched, --as done --pr URL when finished`,
          ),
        ),
        command(`claim ${number} --agent ${agent}${branch ? ` --branch ${branch}` : ""}`),
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
    const since = (item.timelineItems?.nodes ?? [])
      .filter((e) => e.label?.name === mine)
      .map((e) => e.createdAt)
      .sort()
      .at(-1);
    const commented = item.comments.nodes.some(
      (c) => c.body.includes(op) && (!since || !c.createdAt || c.createdAt >= since),
    );
    return {
      ok: true,
      noop: commented,
      facts,
      reason: commented
        ? `Already claimed by ${agent}.`
        : `Claimed by ${agent}; posting the missing claim comment.`,
      changes: commented ? [] : [claimComment()],
      // Completing a partly failed acquisition gets the same post-write ownership check.
      ...(commented ? {} : { recheck: { agent } }),
    };
  }
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
  if (!claimPolicy.pickable.some((l) => label(item, l)))
    return refuse(
      "NOT_READY",
      facts,
      `The ticket needs ${claimPolicy.pickable.join(" or ")} to be picked up.`,
      [`${triage} --agent ${agent}`],
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
  const openPrs = item.closedByPullRequestsReferences.nodes.filter((p) => p.state === "OPEN");
  if (openPrs.length)
    return refuse(
      "HAS_OPEN_PR",
      { ...facts, pullRequests: openPrs.map((p) => p.url) },
      "An open pull request already addresses this ticket; follow up on it instead.",
      openPrs.map((p) => `gh pr view ${p.number} --repo ${repository}`),
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
  const remove = claimPolicy.pickable.filter((l) => label(item, l));
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
      `Claimed by \`${agent}\`${branch ? ` on branch \`${branch}\`` : ""} with \`github-triage claim\`. Removed: ${remove.map((l) => `\`${l}\``).join(", ")}.\n\n${op}`,
    ],
  });
  return { ok: true, noop: false, facts, changes, recheck: { agent } };
}

/**
 * Plan `needs-human N --agent NAME --designer NAME --why TEXT --question TEXT...`.
 */
export async function planNeedsHuman(
  repository: string,
  request: NeedsHumanRequest,
  query: GraphQuery = ghQuery,
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
  const already = item.comments.nodes.some((c) => c.body.includes(op));
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
  const notes: string[] = [];
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
  const labelled = (item.timelineItems?.nodes ?? []).filter((e) => e.label && e.createdAt);
  const since =
    labelled
      .filter((e) => e.label!.name === mine)
      .map((e) => e.createdAt!)
      .sort((a, b) => a.localeCompare(b))
      .at(-1) ?? null;
  const op = marker("release", [repository, number, agent, since]);
  const record = releaseRecords(item.comments.nodes, op)
    .filter((r) => r.agent === agent && r.claimedAt === since)
    .at(-1);
  const holds = label(item, mine);
  const others = facts.owners.filter((o) => o !== mine);
  if (record) {
    const recordedRetry = command(`release ${number} --agent ${agent} --as ${record.outcome}`);
    const recorded = { ...facts, outcome: record.outcome, target: record.target };
    const same = (a: string[], b: string[]): boolean =>
      a.length === b.length && a.every((x) => b.includes(x));
    const complete =
      (!record.target || label(item, record.target)) &&
      !record.remove.some((l) => label(item, l)) &&
      same(others, record.retained);
    if (complete)
      return {
        ok: true,
        noop: true,
        facts: recorded,
        reason: `Handoff already recorded and ${agent}'s claim already released.`,
        changes: [],
      };
    // Anything another party did after the record (a new owner, a readiness label other than
    // the recorded target) means the recorded plan no longer describes the ticket.
    const handoffStates = [...workflow.readiness, claimPolicy.awaitingReview];
    const later = labelled
      .filter((e) => e.createdAt! > record.createdAt)
      .map((e) => e.label!.name)
      .filter(
        (n) =>
          n !== record.target && (n.startsWith(workflow.ownerPrefix) || handoffStates.includes(n)),
      );
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
      notes: record.retained.length ? [`Other owners kept: ${record.retained.join(", ")}.`] : [],
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
  const notes: string[] = [];
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
  if (!failed && plan.recheck && done) {
    try {
      const mine = claimPolicy.owner(plan.recheck.agent);
      const ticket = await readTicket(repository, plan.facts.number, plan.recheck.agent, query);
      const { claims } = ticket;
      // A claim is only ever planned for an issue; anything else cannot hold the claim.
      const item = ticket.item?.__typename === "Issue" ? ticket.item : null;
      const others = item ? owners(item).filter((o) => o !== mine) : [];
      const elsewhere = claims.filter((c) => c.number !== plan.facts.number);
      // GitHub label edits are not a lock: report conflicts rather than resolve them.
      const problems: string[] = [];
      if (plan.recheck.release) {
        const target = plan.recheck.release.target;
        if (item && owners(item).includes(mine))
          problems.push(`${mine} is still recorded on #${plan.facts.number}`);
        if (item && target && !label(item, target))
          problems.push(`${target} is no longer on #${plan.facts.number}`);
      } else {
        // An incomplete label page cannot confirm ownership: a competing claim may be unseen.
        if (item?.labels?.pageInfo?.hasNextPage)
          problems.push(
            `ownership is unverified: #${plan.facts.number} has more than 100 labels, so a competing claim may be unseen`,
          );
        if (!item || item.state !== "OPEN" || !owners(item).includes(mine))
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
      conflict = `Writes completed, but ownership could not be re-checked (${errorMessage(error)}). Re-run the same command to verify${plan.retry ? `: ${plan.retry}` : ""}.`;
    }
  }
  const exitCode = failed ? (done ? 2 : 1) : conflict ? 2 : 0;
  return { ...plan, steps, conflict, exitCode };
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
  if (result.retry && "exitCode" in result && result.exitCode !== 0)
    lines.push(`Retry (safe; completes only the missing steps): ${result.retry}`);
  return lines.join("\n") + "\n";
}

/** `error.message` as the JavaScript read it: undefined for a thrown non-Error value. */
function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}
