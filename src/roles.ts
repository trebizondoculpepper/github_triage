/**
 * Role-shaped briefings (#1). Contract: doc/design/briefings.md, sections "Implementer" and
 * "Designer".
 *
 * A role chooses presentation, never authority. Roles are registered data: each names the
 * question it answers and an ordered list of sections, each with a row budget. Sections are
 * registered selectors over the shared normalized facts (findings, ranked pickup, native
 * dependencies); they never collect their own evidence. A new role is a new registry entry.
 * Every section keeps directed attention visible, explains each row and reports omissions.
 */
import { isParked, owners } from "./briefing.js";
import type { Bounded, Briefing } from "./briefing.js";
import {
  closingPrEvidence,
  compareImpact,
  immediateUnlocks,
  impactText,
  platformsOf,
} from "./ranking.js";
import type { Action, Issue, PullRequest, Snapshot } from "./github/types.js";

/** One row of a role section: the subject and why it is here, in this position. */
export interface RoleRow {
  url: string;
  reason: string;
}
/** What every registered section selector receives. */
export interface RoleContext {
  snapshot: Snapshot;
  facts: Briefing;
  /** Findings grouped by subject URL, from the shared registered analysis rules. */
  findings: ReadonlyMap<string, Action[]>;
  /** Open issues and pull requests by URL. */
  byUrl: ReadonlyMap<string, Issue | PullRequest>;
  isAddressed: (item: Issue) => boolean;
  isMine: (item: Issue) => boolean;
  /** Owned by the viewer directly or through a linked closing issue. */
  linkedMine: (item: Issue) => boolean;
  /**
   * Every subject the non-role compact briefing would show, with its reason. A role reorders
   * and groups these; any it does not place is shown in the bounded OTHER CONTEXT section.
   */
  baseline: ReadonlyMap<string, string>;
}
export type SectionSelector = (context: RoleContext) => RoleRow[];
export interface RoleSection {
  /** Registered selector name. */
  section: string;
  title: string;
  /** Row budget; detail is left to --issue N. */
  budget: number;
  /** Background awareness, not a next step. */
  background?: boolean;
  /** Never cut by the row budget (directed attention is always shown). */
  unbounded?: boolean;
}
export interface RolePolicy {
  question: string;
  sections: RoleSection[];
}

const labelsOf = (item: Issue): string[] => item.labels.nodes.map(({ name }) => name);
const open = (item: Issue): boolean => item.state === "OPEN";
const openIssues = ({ snapshot }: RoleContext): Issue[] => snapshot.issues.filter(open);
const openPrs = ({ snapshot }: RoleContext): PullRequest[] => snapshot.pullRequests.filter(open);
const urlNumber = (url: string): number => Number(url.split("/").pop());
const byNumber = (a: Issue, b: Issue): number => a.number - b.number;
const ruleRows = (context: RoleContext, rules: string[]): RoleRow[] =>
  [...context.findings]
    .flatMap(([url, findings]) => {
      const match = findings.find((f) => rules.includes(f.rule));
      const item = context.byUrl.get(url);
      return match && item ? [{ item, reason: match.reason }] : [];
    })
    .sort((a, b) => byNumber(a.item, b.item))
    .map(({ item, reason }) => ({ url: item.url, reason }));

/** Actionable PR follow-up rules; pending CI alone is waiting, not follow-up. */
export const followUpRules = [
  "pr-failed-checks",
  "pr-review-findings",
  "pr-conflicts",
  "pr-inspect-merge",
  "pr-integrate",
];
/** Label marking documentation/design work; PRs linked to such tickets are design review. */
export const designPolicy = {
  designLabels: ["documentation", "status:needs-design"],
  pendingDesign: "status:needs-design",
  decisionNeeded: "design:decision-needed",
  documentationNeeded: "design:documentation-needed",
  changesRequested: "CHANGES_REQUESTED",
  /** Change-request reviews at which an implementation PR may need design input. */
  repeatedReviewCycles: 2,
};

/**
 * Shared foreground policy, the same as the non-role compact action filter: parked work is
 * never a next step unless explicitly addressed. Applied centrally to every foreground
 * section, so no selector can bypass it.
 */
const nextStepAllowed = (item: Issue, context: RoleContext): boolean =>
  context.isAddressed(item) || !isParked(item);
/**
 * Shared platform policy (pickupPolicy / pickupEligibility): an explicit restriction the
 * viewer does not match excludes the ticket; an unknown viewer platform makes it inspection
 * only. Returns null when unrestricted or matched.
 */
const platformGate = (item: Issue, context: RoleContext): "mismatch" | "unknown" | null => {
  const platforms = platformsOf(item);
  if (!platforms.length) return null;
  const viewer = context.facts.ranking.platform ?? undefined;
  if (!viewer) return "unknown";
  return platforms.includes(viewer) ? null : "mismatch";
};
/** Unclaimed, unparked, undecided pending-design tickets, before closing-PR evidence. */
const pendingDesign = (context: RoleContext): Issue[] =>
  openIssues(context).filter(
    (item) =>
      labelsOf(item).includes(designPolicy.pendingDesign) &&
      !owners(item).length &&
      !labelsOf(item).includes(designPolicy.decisionNeeded) &&
      nextStepAllowed(item, context),
  );
/** Pending-design tickets proven to have no open closing PR. */
const designCandidates = (context: RoleContext): Issue[] => {
  const prs = openPrs(context);
  // An open closing PR is represented by DESIGN REVIEW, as pickup eligibility excludes it.
  return pendingDesign(context).filter((item) =>
    ((closing) => closing.complete && !closing.open.length)(closingPrEvidence(item, prs)),
  );
};
/**
 * Pending-design tickets whose absence of an open closing PR cannot be proven (truncated closing
 * references, no complete reverse link): inspection only, with the evidence reasons.
 */
const designClosingUnknown = (context: RoleContext): { item: Issue; reasons: string[] }[] => {
  const prs = openPrs(context);
  return pendingDesign(context).flatMap((item) => {
    const closing = closingPrEvidence(item, prs);
    return !closing.complete && !closing.open.length ? [{ item, reasons: closing.reasons }] : [];
  });
};

/** Unclaimed open issues another open ticket or PR is waiting on. */
const holdsActiveWork = (item: Issue, context: RoleContext): string[] =>
  (item.blocking?.nodes ?? []).flatMap((node) => {
    const dependant = context.byUrl.get(node.url);
    if (!dependant || !open(dependant)) return [];
    const active =
      owners(dependant).length > 0 ||
      openPrs(context).some((pr) =>
        pr.closingIssuesReferences.nodes.some((ref) => ref.url === dependant.url),
      );
    return active ? [`#${dependant.number}`] : [];
  });
const linkedIssues = (pr: PullRequest, context: RoleContext): Issue[] =>
  pr.closingIssuesReferences.nodes.flatMap((ref) => {
    const item = context.byUrl.get(ref.url);
    return item ? [item] : [];
  });
const isDesignPr = (pr: PullRequest, context: RoleContext): boolean =>
  [pr, ...linkedIssues(pr, context)].some((item) =>
    labelsOf(item).some((label) => designPolicy.designLabels.includes(label)),
  );
const changeRequests = (pr: PullRequest): number =>
  pr.reviews.nodes.filter((review) => review.state === designPolicy.changesRequested).length;

export const sectionSelectors = new Map<string, SectionSelector>();
sectionSelectors.set("addressed", (context) =>
  [...openIssues(context), ...openPrs(context)]
    .filter(context.isAddressed)
    .sort(byNumber)
    .map((item) => ({
      url: item.url,
      reason: "Explicitly addressed to you; respond before clearing your attention label.",
    })),
);
sectionSelectors.set("pr-follow-up", (context) =>
  openPrs(context)
    .flatMap((pr) => {
      const finding = (context.findings.get(pr.url) ?? []).find((f) =>
        followUpRules.includes(f.rule),
      );
      return finding ? [{ pr, finding, mine: context.linkedMine(pr) }] : [];
    })
    .sort(
      (a, b) =>
        Number(b.mine) - Number(a.mine) ||
        b.finding.priority - a.finding.priority ||
        byNumber(a.pr, b.pr),
    )
    .map(({ pr, finding, mine }) => ({
      url: pr.url,
      reason: `${mine ? "Your PR" : "Review opportunity"}: ${finding.reason}`,
    })),
);
// Open PRs with findings that are not actionable follow-up (pending CI, verification needed,
// merge state): inspect or wait, never a next step, but never silently dropped.
sectionSelectors.set("pr-waiting", (context) =>
  openPrs(context)
    .flatMap((pr) => {
      const findings = (context.findings.get(pr.url) ?? []).filter(
        (f) => !followUpRules.includes(f.rule),
      );
      return findings.length ? [{ pr, findings, mine: context.linkedMine(pr) }] : [];
    })
    .sort((a, b) => Number(b.mine) - Number(a.mine) || byNumber(a.pr, b.pr))
    .map(({ pr, findings, mine }) => ({
      url: pr.url,
      reason: `${mine ? "Your PR" : "Open PR"}, waiting or inspect only: ${findings.map((f) => f.reason).join(" ")}`,
    })),
);
sectionSelectors.set("own-work", (context) =>
  openIssues(context)
    .filter((item) => context.isMine(item) && nextStepAllowed(item, context))
    .sort(byNumber)
    .map((item) => ({ url: item.url, reason: "Owned by you; continue before claiming more." })),
);
sectionSelectors.set("pickup", ({ facts }) =>
  facts.ready.items.map((item) => ({ url: item.url, reason: item.rankReason })),
);
sectionSelectors.set("unblock-candidates", (context) =>
  ruleRows(context, ["ready-prerequisites-unverified"]),
);
// Possible pickup whose eligibility is unknown (for example an unknown viewer platform):
// inspection only, never confirmed pickup, but never silently dropped.
sectionSelectors.set("pickup-inspect", (context) => ruleRows(context, ["pickup-unverified"]));
sectionSelectors.set("stale-claims", (context) => ruleRows(context, ["stale-claim"]));
sectionSelectors.set("pending-design", (context) =>
  openIssues(context)
    .filter((item) => labelsOf(item).includes(designPolicy.pendingDesign))
    .sort(byNumber)
    .map((item) => ({ url: item.url, reason: "Pending design; not implementation pickup." })),
);
sectionSelectors.set("decision-needed", (context) =>
  openIssues(context)
    .filter((item) => labelsOf(item).includes(designPolicy.decisionNeeded))
    .map((item) => ({ item, holds: holdsActiveWork(item, context) }))
    .sort((a, b) => b.holds.length - a.holds.length || byNumber(a.item, b.item))
    .map(({ item, holds }) => {
      const finding = (context.findings.get(item.url) ?? []).find(
        (f) => f.rule === "design-decision-needed",
      );
      return {
        url: item.url,
        reason: `${holds.length ? `Holds up active work ${holds.join(", ")}. ` : ""}${finding?.reason ?? "Decision needed."}`,
      };
    }),
);
sectionSelectors.set("documentation-needed", (context) =>
  ruleRows(context, ["design-documentation-needed"]),
);
sectionSelectors.set("design-review", (context) =>
  openPrs(context)
    .filter((pr) => isDesignPr(pr, context))
    .sort(byNumber)
    .map((pr) => {
      const findings = (context.findings.get(pr.url) ?? []).map((f) => f.reason);
      return {
        url: pr.url,
        reason: `Design/documentation PR at ${pr.headRefOid}.${findings.length ? ` ${findings.join(" ")}` : ""}`,
      };
    }),
);
sectionSelectors.set("design-pickup", (context) => {
  const issues = openIssues(context);
  const byUrl = new Map(issues.map((item) => [item.url, item]));
  const prs = openPrs(context);
  const platform = context.facts.ranking.platform ?? undefined;
  return designCandidates(context)
    .filter((item) => platformGate(item, context) === null)
    .map((item) => ({
      item,
      impact: immediateUnlocks(item, byUrl, { prs, platform }),
    }))
    .sort(
      (a, b) =>
        compareImpact(a.impact, b.impact) ||
        Date.parse(a.item.createdAt) - Date.parse(b.item.createdAt) ||
        byNumber(a.item, b.item),
    )
    .map(({ item, impact }) => ({
      url: item.url,
      reason: `Unclaimed design work; ${impactText(impact)} otherwise-ready ticket(s) immediately.`,
    }));
});
// Possible design work that cannot be offered as pickup: the viewer platform is unknown for a
// restricted ticket, or an open closing PR cannot be ruled out. Inspection only, with reasons.
sectionSelectors.set("design-pickup-inspect", (context) =>
  [
    ...designCandidates(context)
      .filter((item) => platformGate(item, context) === "unknown")
      .map((item) => ({
        item,
        reason: `Possible design work restricted to platform ${platformsOf(item).join(" or ")}; viewer platform unknown (state --platform). Inspect only.`,
      })),
    ...designClosingUnknown(context)
      .filter(({ item }) => platformGate(item, context) !== "mismatch")
      .map(({ item, reasons }) => ({
        item,
        reason: `Possible design work, but an open closing PR cannot be ruled out: ${reasons.join("; ") || "closing-PR evidence incomplete"}. Inspect only.`,
      })),
  ]
    .sort((a, b) => byNumber(a.item, b.item))
    .map(({ item, reason }) => ({ url: item.url, reason })),
);
sectionSelectors.set("implementation-prs", (context) =>
  openPrs(context)
    .filter((pr) => !isDesignPr(pr, context))
    .map((pr) => ({ pr, cycles: changeRequests(pr) }))
    .sort(
      (a, b) =>
        Number(b.cycles >= designPolicy.repeatedReviewCycles) -
          Number(a.cycles >= designPolicy.repeatedReviewCycles) || byNumber(a.pr, b.pr),
    )
    .map(({ pr, cycles }) => ({
      url: pr.url,
      reason:
        cycles >= designPolicy.repeatedReviewCycles
          ? `${cycles} change-request reviews: possible design input needed (not proof of a design flaw).`
          : "Implementation PR (awareness only).",
    })),
);

/** Registered roles. Directed attention is always the first section of every role. */
export const roleRegistry = new Map<string, RolePolicy>([
  [
    "implementer",
    {
      question: "What action advances implementation most?",
      sections: [
        { section: "addressed", title: "ADDRESSED TO YOU", budget: 10, unbounded: true },
        { section: "pr-follow-up", title: "PR FOLLOW-UP", budget: 5 },
        { section: "own-work", title: "YOUR ACTIVE WORK", budget: 5 },
        {
          section: "pr-waiting",
          title: "PRS WAITING (inspect; not actionable)",
          budget: 5,
          background: true,
        },
        { section: "pickup", title: "PICKUP", budget: 5 },
        {
          section: "pickup-inspect",
          title: "POSSIBLE PICKUP (inspect; eligibility unknown)",
          budget: 5,
          background: true,
        },
        { section: "unblock-candidates", title: "UNBLOCK CANDIDATES", budget: 5 },
        { section: "stale-claims", title: "STALE CLAIMS (inspect; never auto-release)", budget: 3 },
        { section: "pending-design", title: "PENDING DESIGN", budget: 3, background: true },
      ],
    },
  ],
  [
    "designer",
    {
      question: "What can I resolve to unblock implementation?",
      sections: [
        { section: "addressed", title: "ADDRESSED TO YOU", budget: 10, unbounded: true },
        { section: "decision-needed", title: "DECISION NEEDED", budget: 5 },
        { section: "documentation-needed", title: "AGREED, NEEDS DOCUMENTATION", budget: 5 },
        { section: "design-review", title: "DESIGN REVIEW", budget: 5 },
        { section: "design-pickup", title: "NEW DESIGN WORK", budget: 5 },
        {
          section: "design-pickup-inspect",
          title: "POSSIBLE DESIGN WORK (inspect; platform unknown)",
          budget: 3,
          background: true,
        },
        {
          section: "implementation-prs",
          title: "IMPLEMENTATION PRS",
          budget: 3,
          background: true,
        },
      ],
    },
  ],
]);
export const roleNames = (): string[] => [...roleRegistry.keys()];

export interface RoleView {
  name: string;
  question: string;
  sections: (Bounded<RoleRow> & { name: string; title: string; background: boolean })[];
  /** Foreground rows in role order, each subject once. */
  next: RoleRow[];
}
/** Bounded catch-all: baseline subjects no role section placed. */
export const otherContext = { name: "other-context", title: "OTHER CONTEXT", budget: 5 };
/**
 * Run a registered role over the shared facts. Each subject appears in its first section only.
 * Foreground sections apply the shared next-step policy centrally; any subject the non-role
 * briefing would show that no section placed lands in the bounded OTHER CONTEXT section.
 */
export function roleSectionRows(
  name: string,
  context: RoleContext,
): { section: RoleSection; rows: RoleRow[] }[] {
  const policy = roleRegistry.get(name);
  if (!policy) throw new Error(`--role must be one of ${roleNames().join(", ")}.`);
  const seen = new Set<string>();
  return policy.sections.map((section) => {
    const selector = sectionSelectors.get(section.section);
    if (!selector) throw new Error(`Role ${name}: unregistered section ${section.section}.`);
    const rows = selector(context).filter((row) => {
      if (seen.has(row.url)) return false;
      const item = context.byUrl.get(row.url);
      return section.background || !item || nextStepAllowed(item, context);
    });
    for (const row of rows) seen.add(row.url);
    return { section, rows };
  });
}
export function roleView(name: string, context: RoleContext): RoleView {
  const policy = roleRegistry.get(name);
  if (!policy) throw new Error(`--role must be one of ${roleNames().join(", ")}.`);
  const seen = new Set<string>();
  const bounded = (rows: RoleRow[], budget: number) => ({
    total: rows.length,
    omitted: Math.max(0, rows.length - budget),
    items: rows.slice(0, budget),
  });
  const sections = roleSectionRows(name, context).map(
    ({ section: { section, title, budget, background = false, unbounded = false }, rows }) => {
      for (const row of rows) seen.add(row.url);
      return {
        name: section,
        title,
        background,
        ...bounded(rows, unbounded ? rows.length : budget),
      };
    },
  );
  const rest = [...context.baseline]
    .filter(([url]) => !seen.has(url))
    .sort(([a], [b]) => urlNumber(a) - urlNumber(b) || a.localeCompare(b))
    .map(([url, reason]) => ({ url, reason: `Not in a ${name} section: ${reason}` }));
  sections.push({
    name: otherContext.name,
    title: otherContext.title,
    background: true,
    ...bounded(rest, otherContext.budget),
  });
  return {
    name,
    question: policy.question,
    sections,
    next: sections.filter((s) => !s.background).flatMap((s) => s.items),
  };
}
