/**
 * Shared pickup eligibility and ranking (#45). Contract: doc/design/briefings.md, sections
 * "Identity, relevance and eligibility" and "Pickup ordering and manual urgency".
 *
 * Declarative policy, not an opaque weighted score: eligibility is a set of explicit gates,
 * and each ordering mode is an ordered list of comparison keys. Unknown evidence is never
 * eligibility and never counts as definite impact.
 */
import { nativeKnown } from "./github/dependencies.js";
import type { Issue, PullRequest } from "./github/types.js";

export const pickupOrders = ["impact", "oldest", "newest"] as const;
export type PickupOrder = (typeof pickupOrders)[number];

export const pickupPolicy = {
  /** Readiness labels that make unclaimed work available for implementation pickup. */
  available: ["status:ready", "status:incomplete"],
  incomplete: "status:incomplete",
  /** Outstanding question/design or explicit non-dependency prerequisites. */
  prerequisites: [
    "status:needs-design",
    "question",
    "design:decision-needed",
    "status:blocked",
    "status:parked",
  ],
  ownerPrefix: "agent:",
  platformPrefix: "platform:",
  urgency: { high: "urgency:high", low: "urgency:low" },
  openStates: ["OPEN"],
};

const names = (item: Pick<Issue, "labels">): string[] => item.labels.nodes.map(({ name }) => name);

/** Explicit platform restrictions: an allowed-set; none means unrestricted. */
export const platformsOf = (item: Pick<Issue, "labels">): string[] =>
  names(item)
    .filter((label) => label.startsWith(pickupPolicy.platformPrefix))
    .map((label) => label.slice(pickupPolicy.platformPrefix.length));

/** Pickup urgency band: 0 high, 1 unspecified (or conflicting), 2 low. */
export function urgencyBand(item: Pick<Issue, "labels">): 0 | 1 | 2 {
  const high = names(item).includes(pickupPolicy.urgency.high);
  const low = names(item).includes(pickupPolicy.urgency.low);
  return high && low ? 1 : high ? 0 : low ? 2 : 1;
}
const urgencyText = (item: Pick<Issue, "labels">): string => {
  const high = names(item).includes(pickupPolicy.urgency.high);
  const low = names(item).includes(pickupPolicy.urgency.low);
  return high && low
    ? "conflicting (ordered unspecified)"
    : high
      ? "high"
      : low
        ? "low"
        : "unspecified";
};

/**
 * - `eligible`: confirmed implementation pickup.
 * - `unknown`: might be pickup, but some evidence is missing; inspect, never pick up blindly.
 * - `ineligible`: a known gate excludes it.
 */
export type Eligibility =
  | { status: "eligible"; reasons: string[] }
  | { status: "unknown"; reasons: string[] }
  | { status: "ineligible"; reasons: string[] };

export interface PickupContext {
  /** Open pull requests; an issue with an open closing PR is PR follow-up, not pickup. */
  prs: PullRequest[];
  /** The viewer's explicit platform, when stated. Never inferred. */
  platform?: string;
}

/**
 * What is known about the open pull requests that would close an issue (#162). Such an issue is
 * PR follow-up, not pickup. Presence is proven by either side of the link: an open PR's
 * `closingIssuesReferences` naming the issue, or the issue's own `closedByPullRequestsReferences`
 * naming an open PR. Absence needs a complete side: every open PR's closing references are
 * untruncated, or the issue's reverse link is present and untruncated. Otherwise `complete` is
 * false and the absence of an open closing PR is unknown, never assumed.
 *
 * The one rule shared by pickup eligibility, design pickup, polling and Ticket Doctor.
 */
export interface ClosingPrEvidence {
  /** Open closing PR numbers proven by either side of the link, ascending. */
  open: number[];
  /** False when no open closing PR was found and its absence cannot be proven. */
  complete: boolean;
  /** Why absence is unproven; empty when complete. */
  reasons: string[];
}

const isOpen = (state: string | undefined): boolean =>
  !!state && pickupPolicy.openStates.includes(state);

export function closingPrEvidence(issue: Issue, prs: PullRequest[]): ClosingPrEvidence {
  const open = new Set<number>();
  const truncated: number[] = [];
  for (const pr of prs) {
    if (!isOpen(pr.state)) continue;
    if (pr.closingIssuesReferences.nodes.some((ref) => ref.url === issue.url)) open.add(pr.number);
    if (pr.closingIssuesReferences.pageInfo?.hasNextPage) truncated.push(pr.number);
  }
  const reverse = issue.closedByPullRequestsReferences;
  for (const node of reverse?.nodes ?? []) if (isOpen(node.state)) open.add(node.number);
  const reverseComplete = !!reverse && !reverse.pageInfo?.hasNextPage;
  const complete = open.size > 0 || !truncated.length || reverseComplete;
  return {
    open: [...open].sort((a, b) => a - b),
    complete,
    reasons: complete
      ? []
      : [
          `open closing PR unknown: closing references truncated on open PR ${truncated.map((n) => `#${n}`).join(", ")}${reverse ? " and the issue's closing-PR list is truncated" : " and the issue's closing-PR list was not collected"}`,
        ],
  };
}

/** Open closing PR numbers proven by either side of the link (see closingPrEvidence). */
export const openClosingPrs = (issue: Issue, prs: PullRequest[]): number[] =>
  closingPrEvidence(issue, prs).open;

/**
 * The eligibility gates other than native blockers. Shared by the ticket itself and by the
 * dependants whose immediate unlock it would cause.
 */
function otherwiseEligible(issue: Issue, context: PickupContext): Eligibility {
  const tags = names(issue);
  const hard: string[] = [];
  if (!pickupPolicy.openStates.includes(issue.state)) hard.push(`state ${issue.state}`);
  const owners = tags.filter((tag) => tag.startsWith(pickupPolicy.ownerPrefix));
  if (owners.length) hard.push(`claimed by ${owners.join(", ")}`);
  if (!tags.some((tag) => pickupPolicy.available.includes(tag)))
    hard.push(`not labelled ${pickupPolicy.available.join(" or ")}`);
  const prerequisites = tags.filter((tag) => pickupPolicy.prerequisites.includes(tag));
  if (prerequisites.length) hard.push(`outstanding prerequisite: ${prerequisites.join(", ")}`);
  const closing = closingPrEvidence(issue, context.prs);
  if (closing.open.length)
    hard.push(`open closing PR ${closing.open.map((n) => `#${n}`).join(", ")} (PR follow-up)`);
  const platforms = platformsOf(issue);
  if (platforms.length && context.platform && !platforms.includes(context.platform))
    hard.push(`restricted to platform ${platforms.join(" or ")}; viewer is ${context.platform}`);
  if (hard.length) return { status: "ineligible", reasons: hard };
  const unknown = [...closing.reasons];
  if (platforms.length && !context.platform)
    unknown.push(
      `restricted to platform ${platforms.join(" or ")}; viewer platform unknown (state --platform)`,
    );
  if (unknown.length) return { status: "unknown", reasons: unknown };
  return { status: "eligible", reasons: [] };
}

/** Full pickup eligibility, including complete native blocker evidence. */
export function pickupEligibility(issue: Issue, context: PickupContext): Eligibility {
  const other = otherwiseEligible(issue, context);
  if (other.status === "ineligible") return other;
  if (!nativeKnown(issue))
    return {
      status: "unknown",
      reasons: [...other.reasons, "native dependency evidence missing"],
    };
  if (issue.issueDependenciesSummary.blockedBy > 0)
    return {
      status: "ineligible",
      reasons: [`${issue.issueDependenciesSummary.blockedBy} open native blocker(s)`],
    };
  return other;
}

/**
 * The one impact definition (#208): distinct open dependants that become otherwise eligible
 * when this ticket, their last open native blocker, completes, plus why that count may be
 * incomplete. Distant descendants, dependants still needing design or otherwise ineligible,
 * and dependants with another open blocker do not count.
 *
 * Missing evidence is unknown impact, never zero: a truncated or uncollected `blocking`
 * connection, or a possible unlock that cannot be resolved (absent from the snapshot, in another
 * repository, or without complete native evidence of its own), adds a reason to `unknown`. The
 * `unlocks` count is then only a proven lower bound.
 */
export interface UnlockImpact {
  /** Definite immediate unlocks, in `blocking` order. */
  unlocks: Issue[];
  /** Why more unlocks cannot be ruled out; empty when the count is complete. */
  unknown: string[];
}
export function immediateUnlocks(
  issue: Issue,
  byUrl: ReadonlyMap<string, Issue>,
  context: PickupContext,
): UnlockImpact {
  if (!pickupPolicy.openStates.includes(issue.state)) return { unlocks: [], unknown: [] };
  const unknown: string[] = [];
  const blocking = issue.blocking;
  if (!blocking) unknown.push("dependants not collected");
  else if (blocking.pageInfo?.hasNextPage) {
    const total = issue.issueDependenciesSummary?.totalBlocking;
    unknown.push(
      `dependant list truncated (${blocking.nodes.length}${total === undefined ? "" : ` of ${total}`} seen)`,
    );
  }
  const seen = new Set<string>();
  const unlocks = (blocking?.nodes ?? []).flatMap((node) => {
    if (seen.has(node.url)) return [];
    seen.add(node.url);
    if (node.state !== "OPEN") return [];
    const blockers = node.issueDependenciesSummary?.blockedBy;
    if (blockers !== undefined && blockers !== 1) return [];
    const dependant = byUrl.get(node.url);
    const name = `${node.repository?.nameWithOwner ?? "unknown repository"}#${node.number}`;
    if (!dependant) {
      unknown.push(`dependant ${name} not in this snapshot`);
      return [];
    }
    // The dependant's own native evidence must be complete and agree that this ticket is its
    // only open blocker; otherwise whether it unlocks is unknown.
    if (blockers === undefined || !nativeKnown(dependant)) {
      unknown.push(`dependant ${name} lacks native dependency evidence`);
      return [];
    }
    if (dependant.issueDependenciesSummary.blockedBy !== 1) return [];
    const eligibility = otherwiseEligible(dependant, context);
    // Unknown eligibility (platform restriction without a viewer platform, truncated closing-PR
    // evidence) is unknown impact, never a silent zero.
    if (eligibility.status === "unknown") {
      unknown.push(...eligibility.reasons.map((reason) => `dependant ${name}: ${reason}`));
      return [];
    }
    return eligibility.status === "eligible" ? [dependant] : [];
  });
  return { unlocks, unknown };
}

/**
 * Impact comparison rule (#208), shared by every ordering that uses impact: compare the proven
 * lower bound (definite unlocks) only. Unknown impact therefore never outranks a larger known
 * count and never ranks below zero; equal lower bounds tie, whether known or not, and fall
 * through to the next deterministic key.
 */
export const compareImpact = (a: UnlockImpact, b: UnlockImpact): number =>
  b.unlocks.length - a.unlocks.length;

/** Human-readable impact: a definite count, or a lower bound with the unknown reasons. */
export function impactText(impact: UnlockImpact): string {
  const numbers = impact.unlocks.map((d) => `#${d.number}`).join(", ");
  const count = `${impact.unknown.length ? "at least " : ""}${impact.unlocks.length}`;
  return `unlocks ${count}${numbers ? ` (${numbers})` : ""}${impact.unknown.length ? `; impact unknown: ${impact.unknown.join("; ")}` : ""}`;
}

/** Memoized impact by URL for orderings over arbitrary targets; non-issues have no impact. */
export function impactLookup(
  issues: Issue[],
  context: PickupContext,
): (url: string) => UnlockImpact {
  const byUrl = new Map(issues.map((issue) => [issue.url, issue]));
  const cache = new Map<string, UnlockImpact>();
  return (url) => {
    let impact = cache.get(url);
    if (!impact) {
      const item = byUrl.get(url);
      impact = item ? immediateUnlocks(item, byUrl, context) : { unlocks: [], unknown: [] };
      cache.set(url, impact);
    }
    return impact;
  };
}

/** One ranked pickup candidate, with the metadata kept visible under every ordering. */
export interface RankedPickup {
  issue: Issue;
  rank: number;
  order: PickupOrder;
  urgency: string;
  unlocks: number[];
  /** Why more unlocks cannot be ruled out (#208); empty when `unlocks` is complete. */
  unlocksUnknown: string[];
  incomplete: boolean;
  createdAt: string;
  platforms: string[];
  /** Human-readable explanation of the rank and the facts behind it. */
  reason: string;
}

type Key = (a: RankedPickup, b: RankedPickup) => number;
const created: Key = (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt);
const numeric: Key = (a, b) => a.issue.number - b.issue.number;
/** Ordered comparison keys per mode. Explicit age modes use creation time alone. */
export const orderingPolicy: Record<PickupOrder, Key[]> = {
  impact: [
    (a, b) => urgencyBand(a.issue) - urgencyBand(b.issue),
    // compareImpact: proven lower bound only; unknown neither outranks nor sinks (#208).
    (a, b) => b.unlocks.length - a.unlocks.length,
    (a, b) => Number(b.incomplete) - Number(a.incomplete),
    created,
    numeric,
  ],
  oldest: [created, numeric],
  newest: [(a, b) => created(b, a), numeric],
};
const orderText: Record<PickupOrder, string> = {
  impact: "impact order: urgency, immediate unlocks, incomplete first, then oldest",
  oldest: "oldest-first by creation time only; urgency/impact shown but not used for order",
  newest: "newest-first by creation time only; urgency/impact shown but not used for order",
};

/** Rank eligible pickup under the selected ordering mode. */
export function rankPickup(
  issues: Issue[],
  context: PickupContext & { order?: PickupOrder },
): RankedPickup[] {
  const order = context.order ?? "impact";
  const byUrl = new Map(issues.map((issue) => [issue.url, issue]));
  const candidates = issues
    .filter((issue) => pickupEligibility(issue, context).status === "eligible")
    .map((issue): RankedPickup => {
      const impact = immediateUnlocks(issue, byUrl, context);
      return {
        issue,
        rank: 0,
        order,
        urgency: urgencyText(issue),
        unlocks: impact.unlocks.map((dependant) => dependant.number),
        unlocksUnknown: impact.unknown,
        incomplete: names(issue).includes(pickupPolicy.incomplete),
        createdAt: issue.createdAt,
        platforms: platformsOf(issue),
        reason: "",
      };
    });
  const keys = orderingPolicy[order];
  candidates.sort((a, b) => {
    for (const key of keys) {
      const result = key(a, b);
      if (result) return result;
    }
    return 0;
  });
  return candidates.map((candidate, index) => {
    const rank = index + 1;
    const facts = [
      `urgency ${candidate.urgency}`,
      impactText({
        unlocks: candidate.unlocks.map((number) => ({ number }) as Issue),
        unknown: candidate.unlocksUnknown,
      }),
      candidate.incomplete ? "released incomplete work" : "unstarted",
      `created ${candidate.createdAt}`,
      ...(candidate.platforms.length ? [`platform ${candidate.platforms.join("/")}`] : []),
    ];
    return {
      ...candidate,
      rank,
      reason: `Pickup rank ${rank} of ${candidates.length} (${orderText[order]}): ${facts.join("; ")}.`,
    };
  });
}
