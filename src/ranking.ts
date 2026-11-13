/**
 * Shared pickup eligibility and ranking (#45). Contract: doc/design/briefings.md, sections
 * "Identity, relevance and eligibility" and "Pickup ordering and manual urgency".
 *
 * Declarative policy, not an opaque weighted score: eligibility is a set of explicit gates,
 * and each ordering mode is an ordered list of comparison keys. Unknown evidence is never
 * eligibility and never counts as definite impact.
 */
import { nativeKnown } from "./dependencies.js";
import type { Issue, PullRequest } from "./types.js";

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

/** Open pull requests that would close the issue; such an issue is PR follow-up, not pickup. */
export const openClosingPrs = (issue: Issue, prs: PullRequest[]): PullRequest[] =>
  prs.filter(
    (pr) =>
      pickupPolicy.openStates.includes(pr.state) &&
      pr.closingIssuesReferences.nodes.some((ref) => ref.url === issue.url),
  );

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
  const linked = openClosingPrs(issue, context.prs);
  if (linked.length)
    hard.push(`open closing PR ${linked.map((pr) => `#${pr.number}`).join(", ")} (PR follow-up)`);
  const platforms = platformsOf(issue);
  if (platforms.length && context.platform && !platforms.includes(context.platform))
    hard.push(`restricted to platform ${platforms.join(" or ")}; viewer is ${context.platform}`);
  if (hard.length) return { status: "ineligible", reasons: hard };
  if (platforms.length && !context.platform)
    return {
      status: "unknown",
      reasons: [
        `restricted to platform ${platforms.join(" or ")}; viewer platform unknown (state --platform)`,
      ],
    };
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
 * Distinct open dependants that become otherwise eligible when this ticket, their last open
 * native blocker, completes. Distant descendants, dependants still needing design, dependants
 * absent from the snapshot, dependants without complete native dependency evidence and unknown
 * eligibility do not count.
 */
export function immediateUnlocks(
  issue: Issue,
  byUrl: ReadonlyMap<string, Issue>,
  context: PickupContext,
): Issue[] {
  if (!pickupPolicy.openStates.includes(issue.state)) return [];
  const seen = new Set<string>();
  return (issue.blocking?.nodes ?? []).flatMap((node) => {
    if (seen.has(node.url)) return [];
    seen.add(node.url);
    if (node.state !== "OPEN" || node.issueDependenciesSummary?.blockedBy !== 1) return [];
    const dependant = byUrl.get(node.url);
    // The dependant's own native evidence must be complete and agree that this ticket is its
    // only open blocker; otherwise its eligibility is unknown and it is not a definite unlock.
    return dependant &&
      nativeKnown(dependant) &&
      dependant.issueDependenciesSummary.blockedBy === 1 &&
      otherwiseEligible(dependant, context).status === "eligible"
      ? [dependant]
      : [];
  });
}

/** One ranked pickup candidate, with the metadata kept visible under every ordering. */
export interface RankedPickup {
  issue: Issue;
  rank: number;
  order: PickupOrder;
  urgency: string;
  unlocks: number[];
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
    .map((issue): RankedPickup => ({
      issue,
      rank: 0,
      order,
      urgency: urgencyText(issue),
      unlocks: immediateUnlocks(issue, byUrl, context).map((dependant) => dependant.number),
      incomplete: names(issue).includes(pickupPolicy.incomplete),
      createdAt: issue.createdAt,
      platforms: platformsOf(issue),
      reason: "",
    }));
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
      `unlocks ${candidate.unlocks.length}${candidate.unlocks.length ? ` (${candidate.unlocks.map((n) => `#${n}`).join(", ")})` : ""}`,
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
