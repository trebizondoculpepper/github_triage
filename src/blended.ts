/**
 * Shared blended-action policy (#248). Contract: doc/design/blended-action-queues.md ("Default
 * order", "Output and compatibility") and doc/design/impact-estimation.md ("Queue heuristic").
 *
 * A pure, deterministic comparator over injected facts: first match wins over the ordinal bands,
 * then the shared within-band keys. Bands 1–3 (addressed attention, actionable PR follow-up,
 * designer unblock duties) keep the order their existing selectors already chose; this module
 * adds bands 4–7 with both cross-role boosts. Only `current` paired assessments qualify for the
 * easy-win and unfavorable bands or as a boost source; every other state, and every M or
 * otherwise incomparable pair, is ordinary work. Missing evidence is unknown, never a default.
 * No collection, no weighted score and no network lookup happen here.
 *
 * The additive `rankedActions` object is authoritative: since #259 the legacy `actions` and
 * `role.next` of both blended roles are its first-occurrence target projection, and both roles'
 * NEXT STEPS text renders it (designer since #246).
 */
import type { AssessmentState, MetricView, SubjectAssessments } from "./assessments.js";
import type { ComplexitySize } from "./complexity.js";
import type { PickupOrder } from "./ranking.js";

export const blendedPolicyVersion = 1 as const;

/** Registered action kinds. Assessment kinds never acquire a claim. */
export type ActionKind =
  | "addressed-response"
  | "pr-follow-up"
  | "decide"
  | "document"
  | "design-review"
  | "continue-implementation"
  | "implement"
  | "estimate-complexity"
  | "assess-impact"
  | "inspect-assessment"
  | "inspect"
  | "design";
export type BlendedRole = "implementer" | "designer";
/** 1 addressed, 2 PR follow-up, 3 designer duties, 4 easy win, 5 assessment, 6 ordinary, 7 unfavorable. */
export type Band = 1 | 2 | 3 | 4 | 5 | 6 | 7;

const small: readonly ComplexitySize[] = ["XS", "S"];
const large: readonly ComplexitySize[] = ["L", "XL", "XXL"];
const assessmentKinds: readonly ActionKind[] = ["estimate-complexity", "assess-impact"];
const implementationKinds: readonly ActionKind[] = ["implement", "continue-implementation"];

/** The facts one candidate is ranked on; everything is injected, nothing is looked up. */
export interface ActionFacts {
  repository: string;
  target: string;
  number: number;
  kind: ActionKind;
  role: BlendedRole;
  /** For kinds in bands 1–3: the position the existing selector gave it. */
  sequence?: number;
  complexity: Pick<MetricView, "state" | "size">;
  impact: Pick<MetricView, "state" | "size">;
  /** 0 high, 1 unspecified or conflicting, 2 low. */
  urgency: 0 | 1 | 2;
  /** The ticket's proven immediate-unlock lower bound. */
  unlocks: number;
  unlocksUnknown: string[];
  /** Owned by the viewer (own continuation). */
  own: boolean;
  incomplete: boolean;
  createdAt: string;
  evidence: string[];
  nextCommand: string | null;
  /**
   * The command to run once `nextCommand` (a prerequisite such as releasing the viewer's other
   * active claim) has succeeded; null when `nextCommand` is the action itself.
   */
  thenCommand?: string | null;
  /** Extra reason codes the candidate builder attaches (for example a prerequisite). */
  extraReasonCodes?: string[];
  /** Why there is no command (inspection only); null when `nextCommand` is set. */
  inspection: string | null;
}

const isCurrent = (m: ActionFacts["impact"], sizes: readonly ComplexitySize[]): boolean =>
  m.state === "current" && m.size !== null && sizes.includes(m.size);
const needsAssessment = (state: AssessmentState): boolean =>
  state === "unassessed" || state === "stale";

/** Band and reason codes for one candidate under the selected pickup order. */
export function classify(
  a: ActionFacts,
  order: PickupOrder = "impact",
): { band: Band; boosted: boolean; reasonCodes: string[] } {
  const states = [`impact-${a.impact.state}`, `complexity-${a.complexity.state}`];
  const fixed: Partial<Record<ActionKind, [Band, string]>> = {
    "addressed-response": [1, "addressed"],
    "pr-follow-up": [2, "pr-follow-up"],
    decide: [3, "designer-duty"],
    document: [3, "designer-duty"],
    "design-review": [3, "designer-duty"],
  };
  const known = fixed[a.kind];
  if (known) return { band: known[0], boosted: false, reasonCodes: [known[1]] };
  if (assessmentKinds.includes(a.kind)) {
    const boosted =
      a.kind === "estimate-complexity"
        ? isCurrent(a.impact, large) && needsAssessment(a.complexity.state)
        : isCurrent(a.complexity, small) && needsAssessment(a.impact.state);
    return {
      band: 5,
      boosted,
      reasonCodes: ["assessment", ...(boosted ? ["cross-role-boost"] : []), ...states],
    };
  }
  if (a.kind === "inspect-assessment")
    return { band: 5, boosted: false, reasonCodes: ["assessment", "inspection", ...states] };
  if (implementationKinds.includes(a.kind)) {
    const own = a.own ? ["own-claim"] : [];
    // Explicit age order coalesces unclaimed pickup into the ordinary band (no hidden value sort).
    if (order !== "impact" && !a.own)
      return { band: 6, boosted: false, reasonCodes: ["ordinary", "age-order", ...states] };
    if (a.role === "implementer" && isCurrent(a.impact, large) && isCurrent(a.complexity, small))
      return { band: 4, boosted: false, reasonCodes: ["easy-win", ...own, ...states] };
    if (isCurrent(a.impact, small) && isCurrent(a.complexity, large))
      return { band: 7, boosted: false, reasonCodes: ["unfavorable", ...own, ...states] };
    return { band: 6, boosted: false, reasonCodes: ["ordinary", ...own, ...states] };
  }
  return {
    band: 6,
    boosted: false,
    reasonCodes: ["ordinary", ...(a.kind === "inspect" ? ["inspection"] : [])],
  };
}

/** Immediate-unlock score used for ordering: assessment never unblocks implementation itself. */
const unlockScore = (a: ActionFacts): number =>
  assessmentKinds.includes(a.kind) || a.kind === "inspect-assessment" ? 0 : a.unlocks;
const created = (a: ActionFacts): number => Date.parse(a.createdAt);
const identity = (a: ActionFacts, b: ActionFacts): number =>
  a.repository.localeCompare(b.repository) ||
  a.number - b.number ||
  a.target.localeCompare(b.target) ||
  a.kind.localeCompare(b.kind);

/**
 * Total order over candidates: band, then (bands 1–3) the selector's sequence, or (bands 4–7)
 * cross-role boost, urgency, proven unlock lower bound, own continuation, incomplete before
 * unstarted and creation time; explicit age order uses creation time alone for band 6. Stable
 * identity breaks every remaining tie.
 */
export function compareActions(order: PickupOrder = "impact") {
  return (a: ActionFacts, b: ActionFacts): number => {
    const ca = classify(a, order);
    const cb = classify(b, order);
    if (ca.band !== cb.band) return ca.band - cb.band;
    if (ca.band <= 3)
      return (
        (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER) ||
        identity(a, b)
      );
    if (ca.band === 6 && order !== "impact") {
      // Age-only order applies to unclaimed implementation pickup alone (contract: "Explicit
      // --order oldest/newest"). Other band-6 actions (own continuation, designer `design`,
      // inspection) keep the normal keys and precede the age-ordered pickup group, which keeps
      // the comparison a total order.
      const pa = ca.reasonCodes.includes("age-order");
      const pb = cb.reasonCodes.includes("age-order");
      if (pa !== pb) return Number(pa) - Number(pb);
      if (pa) {
        const age = order === "oldest" ? created(a) - created(b) : created(b) - created(a);
        return age || identity(a, b);
      }
    }
    return (
      Number(cb.boosted) - Number(ca.boosted) ||
      a.urgency - b.urgency ||
      unlockScore(b) - unlockScore(a) ||
      Number(b.own) - Number(a.own) ||
      Number(b.incomplete) - Number(a.incomplete) ||
      created(a) - created(b) ||
      identity(a, b)
    );
  };
}

/** One `rankedActions` item (doc/design/blended-action-queues.md "Output and compatibility"). */
export interface RankedAction {
  ruleIds?: string[];
  why?: {
    text: string;
    ruleIds: string[];
    facts: Record<string, string | number | boolean>;
    overriddenRuleIds: string[];
  };
  id: string;
  kind: ActionKind;
  target: string;
  role: BlendedRole;
  band: Band;
  reasonCodes: string[];
  evidence: string[];
  nextCommand: string | null;
  /** Run after `nextCommand` succeeds (one-active-claim handoff); null otherwise. */
  thenCommand: string | null;
  inspection: string | null;
  complexity: { state: AssessmentState; size: ComplexitySize | null };
  impact: { state: AssessmentState; size: ComplexitySize | null };
  unlocks: number;
  unlocksUnknown: string[];
}
export interface RankedActions {
  policyVersion: typeof blendedPolicyVersion;
  total: number;
  omitted: number;
  items: RankedAction[];
}

/** Rank candidates, dedupe by stable ID, then apply the display limit. */
export function rankActions(
  candidates: ActionFacts[],
  { order = "impact", limit }: { order?: PickupOrder; limit: number },
): RankedActions {
  const seen = new Set<string>();
  const ranked = [...candidates].sort(compareActions(order)).flatMap((a): RankedAction[] => {
    const id = `${a.repository} ${a.target} ${a.kind}`;
    if (seen.has(id)) return [];
    seen.add(id);
    const { band, reasonCodes } = classify(a, order);
    return [
      {
        id,
        kind: a.kind,
        target: a.target,
        role: a.role,
        band,
        reasonCodes: [...reasonCodes, ...(a.extraReasonCodes ?? [])],
        evidence: a.evidence,
        nextCommand: a.nextCommand,
        thenCommand: a.nextCommand ? (a.thenCommand ?? null) : null,
        inspection: a.nextCommand ? null : a.inspection,
        complexity: { state: a.complexity.state, size: a.complexity.size },
        impact: { state: a.impact.state, size: a.impact.size },
        unlocks: a.unlocks,
        unlocksUnknown: a.unlocksUnknown,
      },
    ];
  });
  const items = ranked.slice(0, Math.max(0, limit));
  return {
    policyVersion: blendedPolicyVersion,
    total: ranked.length,
    omitted: ranked.length - items.length,
    items,
  };
}

/** Paired facts for a subject with no assessment reading (a PR, or none supplied): unknown. */
export const unknownAssessments: SubjectAssessments = {
  impact: { state: "unknown", size: null, provenance: null },
  complexity: { state: "unknown", size: null, provenance: null },
  unlocks: 0,
  unlocksUnknown: ["no paired assessment facts for this subject"],
};

/** Which kind each registered foreground role section contributes; others are not actions. */
export const sectionKinds: Readonly<Record<string, ActionKind>> = {
  addressed: "addressed-response",
  "pr-follow-up": "pr-follow-up",
  // Ranking-only section (see designFollowUpSections): owned design PRs with follow-up findings.
  "design-follow-up": "pr-follow-up",
  "decision-needed": "decide",
  "documentation-needed": "document",
  "design-review": "design-review",
  "own-work": "continue-implementation",
  pickup: "implement",
  "design-pickup": "design",
  "unblock-candidates": "inspect",
  "stale-claims": "inspect",
};

/**
 * Ranking input only: for designers, owned design PRs with an actionable follow-up finding are
 * own-PR delivery follow-up (contract "Default order" band 2, no role qualifier), not design
 * review (band 3). Moves those rows out of `design-review` into a `design-follow-up` section
 * placed straight after `addressed`. The displayed role sections are unchanged.
 */
export function designFollowUpSections<S extends { name: string; rows: { url: string }[] }>(
  sections: S[],
  ownedFollowUp: (url: string) => boolean,
): S[] {
  const review = sections.find((s) => s.name === "design-review");
  const moved = review ? review.rows.filter((r) => ownedFollowUp(r.url)) : [];
  if (!review || moved.length === 0) return sections;
  const out = sections.map((s) =>
    s === review ? { ...s, rows: s.rows.filter((r) => !ownedFollowUp(r.url)) } : s,
  );
  const at = out.findIndex((s) => s.name === "addressed") + 1;
  out.splice(at, 0, { ...review, name: "design-follow-up", rows: moved });
  return out;
}

/** The subject facts the candidate builder reads; supplied from the collected snapshot. */
export interface CandidateSubject {
  url: string;
  number: number;
  state: string;
  createdAt: string;
  labels: string[];
  isIssue: boolean;
}
export interface CandidateInput {
  repository: string;
  role: BlendedRole;
  agent?: string;
  /** The viewer's explicit platform (`--platform`); carried into platform-restricted claims. */
  platform?: string;
  /** Foreground role rows in role order, by registered section name. */
  sections: { name: string; background: boolean; rows: { url: string }[] }[];
  subjects: ReadonlyMap<string, CandidateSubject>;
  assessments: ReadonlyMap<string, SubjectAssessments>;
  isAddressed: (url: string) => boolean;
  isParked: (url: string) => boolean;
  urgency: (url: string) => 0 | 1 | 2;
  ownedByViewer: (url: string) => boolean;
}

/**
 * Candidates for one role: the existing foreground role rows (each mapped to its registered
 * kind) plus one viewer-appropriate assessment action per open issue whose paired state for the
 * role's metric needs work. Assessment candidates include blocked tickets (assessment does not
 * unblock or claim); disabled metrics contribute none; parked tickets contribute none unless
 * addressed.
 */
export function roleCandidates(input: CandidateInput): ActionFacts[] {
  const metric = input.role === "implementer" ? "complexity" : "impact";
  const agent = input.agent ?? "NAME";
  // The viewer's active claims: open issues carrying the viewer's agent label.
  const ownActive = [...input.subjects.values()]
    .filter((s) => s.isIssue && s.state === "OPEN" && input.ownedByViewer(s.url))
    .map((s) => s.number);
  const facts = (url: string, kind: ActionKind, sequence?: number): ActionFacts | null => {
    const s = input.subjects.get(url);
    if (!s) return null;
    const a = input.assessments.get(url) ?? unknownAssessments;
    const detail = s.isIssue
      ? `pdb --repo ${input.repository} --issue ${s.number} --json`
      : `gh pr view ${s.number} --repo ${input.repository}`;
    const estimate = (m: string, invalid = false) =>
      `pdb estimate ${s.number} --metric ${m} --size SIZE --rationale TEXT${invalid ? " --replace-invalid" : ""} --repo ${input.repository}`;
    const restricted = s.labels.some((l) => l.startsWith("platform:"));
    const claim = `pdb claim ${s.number} --repo ${input.repository} --agent ${agent}${
      restricted && input.platform ? ` --platform ${input.platform}` : ""
    }`;
    // One active claim per agent (src/claims.ts OTHER_ACTIVE_CLAIM): a claim on another ticket is
    // refused until the viewer's current claim is released, so show that handoff first
    // (doc/design/blended-action-queues.md "existing own implementation claim").
    const otherClaims = kind === "implement" ? ownActive.filter((n) => n !== s.number) : [];
    const handoff =
      otherClaims.length === 1
        ? `pdb release ${otherClaims[0]} --repo ${input.repository} --agent ${agent} --as incomplete --note TEXT`
        : null;
    const command: Partial<Record<ActionKind, string | null>> = {
      implement: otherClaims.length ? handoff : claim,
      "estimate-complexity": estimate("complexity"),
      "assess-impact": estimate("impact"),
      // Inspection of known bad evidence carries the Ticket Doctor fix for the role's metric
      // (designer impact #246, implementer complexity #259): the judged size replaces the
      // conflicting labels, or removes the invalid ones with --replace-invalid.
      "inspect-assessment": estimate(metric, a[metric].state === "invalid"),
      inspect: null,
    };
    const next = kind in command ? (command[kind] ?? null) : detail;
    return {
      repository: input.repository,
      target: url,
      number: s.number,
      kind,
      role: input.role,
      ...(sequence === undefined ? {} : { sequence }),
      complexity: a.complexity,
      impact: a.impact,
      urgency: input.urgency(url),
      unlocks: a.unlocks,
      unlocksUnknown: a.unlocksUnknown,
      own: input.ownedByViewer(url),
      incomplete: s.labels.includes("status:incomplete"),
      createdAt: s.createdAt,
      evidence: [
        url,
        ...[a.impact.provenance, a.complexity.provenance].filter((p): p is string => !!p),
      ],
      nextCommand: next,
      ...(otherClaims.length
        ? {
            thenCommand: handoff ? claim : null,
            extraReasonCodes: ["release-active-claim-first"],
          }
        : {}),
      inspection: next
        ? null
        : otherClaims.length
          ? `one active claim per agent: release #${otherClaims.join(", #")} first (pdb release N --repo ${input.repository} --agent ${agent} --as incomplete --note TEXT), then ${claim}`
          : kind === "inspect-assessment"
            ? `${metric} evidence is ${a[metric].state}; inspect labels and provenance (${detail})`
            : `inspect before acting (${detail})`,
    };
  };
  const out: ActionFacts[] = [];
  let sequence = 0;
  for (const section of input.sections) {
    const kind = sectionKinds[section.name];
    if (section.background || !kind) continue;
    for (const row of section.rows) {
      const f = facts(row.url, kind, sequence++);
      if (f) out.push(f);
    }
  }
  for (const [url, a] of input.assessments) {
    const s = input.subjects.get(url);
    if (!s || !s.isIssue || s.state !== "OPEN") continue;
    if (input.isParked(url) && !input.isAddressed(url)) continue;
    const state = a[metric].state;
    const kind: ActionKind | null = needsAssessment(state)
      ? metric === "complexity"
        ? "estimate-complexity"
        : "assess-impact"
      : // Known bad evidence is inspected; `unknown` (unread or unavailable) is not an action.
        state === "conflict" || state === "invalid"
        ? "inspect-assessment"
        : null;
    const f = kind && facts(url, kind);
    if (f) out.push(f);
  }
  return out;
}
