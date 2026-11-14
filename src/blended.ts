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
 * The additive `rankedActions` object is new; the legacy `actions` and `role.next` projections
 * are not derived from it in this slice (#259 and #246 wire the role views).
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
      const age = order === "oldest" ? created(a) - created(b) : created(b) - created(a);
      return age || identity(a, b);
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
  id: string;
  kind: ActionKind;
  target: string;
  role: BlendedRole;
  band: Band;
  reasonCodes: string[];
  evidence: string[];
  nextCommand: string | null;
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
        reasonCodes,
        evidence: a.evidence,
        nextCommand: a.nextCommand,
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
  "decision-needed": "decide",
  "documentation-needed": "document",
  "design-review": "design-review",
  "own-work": "continue-implementation",
  pickup: "implement",
  "design-pickup": "design",
  "unblock-candidates": "inspect",
  "stale-claims": "inspect",
};

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
  const facts = (url: string, kind: ActionKind, sequence?: number): ActionFacts | null => {
    const s = input.subjects.get(url);
    if (!s) return null;
    const a = input.assessments.get(url) ?? unknownAssessments;
    const detail = s.isIssue
      ? `github-triage --repo ${input.repository} --issue ${s.number} --json`
      : `gh pr view ${s.number} --repo ${input.repository}`;
    const estimate = (m: string) =>
      `github-triage estimate ${s.number} --metric ${m} --size SIZE --rationale TEXT --repo ${input.repository}`;
    const command: Partial<Record<ActionKind, string | null>> = {
      implement: `github-triage claim ${s.number} --repo ${input.repository} --agent ${agent}`,
      "estimate-complexity": estimate("complexity"),
      "assess-impact": estimate("impact"),
      "inspect-assessment": null,
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
      inspection: next
        ? null
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
