/**
 * Rules plausibility suite (#154). Not part of the runtime.
 *
 * Extends the isolated rule-record spike (#74, rules.ts) with only the facts and actions the
 * plausibility scenarios need, combines rule hits with the spike's `decide`, and turns the
 * permitted decisions into one ordered list of offered work following the briefing action
 * groups (doc/design/briefings.md): addressed attention, actionable PR follow-up, own active
 * work, eligible pickup, then optional estimation (doc/design/complexity-estimation.md).
 *
 * Every scenario declares complete synthetic facts and its expectations as data before any
 * evaluation. Checks compare rule IDs, facts, modality and overrides, never English wording.
 * This is a deterministic engine check; it says nothing about whether an LLM follows the
 * compiled guidance (#78).
 */
import { FACTS, RULES, checkRules, decide } from "./rules.js";
import type { Action, Agent, Decision, Diagnostic, Hit, Modality, Rule, Ticket } from "./rules.js";

/** Extra ticket evidence the plausibility scenarios need. */
export interface PTicket extends Ticket {
  /** State of the open PR, when there is one: needs action from its author, or is waiting. */
  prState: "actionable" | "waiting" | null;
  /** Agents recorded as contributors by a done handoff (not the shared GitHub login). */
  prAuthors: string[];
  /** A complexity estimate is already recorded. */
  estimated: boolean;
}
/** The viewer plus the repository configuration it sees. */
export interface PAgent extends Agent {
  complexityEnabled: boolean;
}
export type SortMode = "impact" | "oldest" | "newest";
interface PFact {
  js: (t: PTicket, a: PAgent) => boolean;
}

const has = (t: PTicket, label: string): boolean => t.labels.includes(label);
const lifted: Record<string, PFact> = Object.fromEntries(
  Object.entries(FACTS).flatMap(([name, f]) => (f ? [[name, { js: f.js }]] : [])),
);

/** The spike's facts plus the ones added for #154. */
export const PFACTS: Record<string, PFact | undefined> = {
  ...lifted,
  prActionable: { js: (t) => t.openPrs.length > 0 && t.prState === "actionable" },
  prWaiting: { js: (t) => t.openPrs.length > 0 && t.prState === "waiting" },
  myContribution: { js: (t, a) => t.owners.includes(a.name) || t.prAuthors.includes(a.name) },
  statusConflict: {
    js: (t) =>
      has(t, "status:awaiting-review") && (has(t, "status:ready") || has(t, "status:incomplete")),
  },
  urgencyConflict: { js: (t) => has(t, "urgency:high") && has(t, "urgency:low") },
  complexityOn: { js: (_t, a) => a.complexityEnabled },
  estimated: { js: (t) => t.estimated },
};

/**
 * Spike R2 ("must follow up when you hold the claim and a PR is open") is replaced: it makes a
 * waiting PR mandatory work and misses post-done follow-up, where the claim was released.
 */
export const ADDED_RULES: Rule[] = [
  {
    id: "P1",
    modality: "must",
    action: "follow_up",
    when: [{ fact: "myContribution" }, { fact: "prActionable" }],
    reason: "Actionable follow-up on your own PR comes before new work, even after a done handoff.",
  },
  {
    id: "P2",
    modality: "inspect",
    action: "wait",
    when: [{ fact: "myContribution" }, { fact: "prWaiting" }],
    reason: "Pending review or CI is waiting, not work.",
  },
  {
    id: "P3",
    modality: "must",
    action: "continue",
    when: [{ fact: "mine" }, { fact: "hasOpenPr", not: true }],
    reason: "Own active work comes before new pickup.",
  },
  {
    id: "P4",
    modality: "must_not",
    action: "pick_up",
    when: [{ fact: "statusConflict" }],
    reason: "Ready and awaiting-review together are contradictory evidence.",
  },
  {
    id: "P5",
    modality: "inspect",
    action: "fix_labels",
    when: [{ fact: "statusConflict" }],
    reason: "Contradictory status labels need correcting.",
  },
  {
    id: "P6",
    modality: "inspect",
    action: "fix_labels",
    when: [{ fact: "urgencyConflict" }],
    reason: "Both urgency labels: report it and rank in the unspecified band.",
  },
  {
    id: "P7",
    modality: "may",
    action: "estimate",
    when: [{ fact: "complexityOn" }, { fact: "estimated", not: true }],
    reason: "Unestimated tickets, blocked ones included, are optional estimation work.",
  },
  {
    id: "P8",
    modality: "must_not",
    action: "estimate",
    when: [{ fact: "complexityOn", not: true }],
    reason: "Disabled complexity suppresses the estimation queue.",
  },
];
export const PLAUSIBILITY_RULES: Rule[] = [...RULES.filter((r) => r.id !== "R2"), ...ADDED_RULES];

/** Briefing action groups; lower is offered first. Actions without a group are never work. */
const GROUP: Partial<Record<Action, number>> = {
  respond: 1,
  follow_up: 2,
  continue: 3,
  pick_up: 4,
  estimate: 5,
};

export interface PlanItem {
  ticket: number;
  action: Action;
  modality: Modality;
  because: string[];
  /** Conditions of the deciding rules, `!` for negated ones. */
  facts: string[];
  overrides: string[];
}
export interface PEvaluation {
  /** Offered work (must/may decisions in a work group), in order. */
  plan: PlanItem[];
  decisions: PlanItem[];
}

function pfact(name: string): PFact {
  const found = PFACTS[name];
  if (!found) throw new Error(`unknown fact ${name}`);
  return found;
}

const urgencyBand = (t: PTicket): number =>
  has(t, "urgency:high") && !has(t, "urgency:low")
    ? 0
    : has(t, "urgency:low") && !has(t, "urgency:high")
      ? 2
      : 1;

/** Pickup comparator: impact mode, or explicit age modes that replace all weighting. */
function comparePickup(x: PTicket, y: PTicket, sort: SortMode): number {
  const keys: [number, number][] =
    sort === "impact"
      ? [
          [urgencyBand(x), urgencyBand(y)],
          [y.unblocks, x.unblocks],
          [Number(has(y, "status:incomplete")), Number(has(x, "status:incomplete"))],
          [Date.parse(x.createdAt), Date.parse(y.createdAt)],
        ]
      : sort === "oldest"
        ? [[Date.parse(x.createdAt), Date.parse(y.createdAt)]]
        : [[Date.parse(y.createdAt), Date.parse(x.createdAt)]];
  for (const [a, b] of [...keys, [x.number, y.number] as [number, number]])
    if (a !== b) return a - b;
  return 0;
}

export function evaluate(
  tickets: PTicket[],
  agent: PAgent,
  rules: Rule[] = PLAUSIBILITY_RULES,
  sort: SortMode = "impact",
): PEvaluation {
  const hits: Hit[] = [];
  for (const t of tickets)
    for (const r of rules)
      if (r.when.every((c) => pfact(c.fact).js(t, agent) !== !!c.not))
        hits.push({ ticket: t.number, action: r.action, modality: r.modality, rule: r.id });
  const byId = new Map(rules.map((r) => [r.id, r]));
  const explain = (d: Decision): PlanItem => ({
    ...d,
    facts: [
      ...new Set(
        d.because.flatMap((id) => byId.get(id)?.when.map((c) => `${c.not ? "!" : ""}${c.fact}`)),
      ),
    ].filter((f): f is string => f !== undefined),
  });
  const decisions = decide(hits).map(explain);
  const byNumber = new Map(tickets.map((t) => [t.number, t]));
  const ticket = (n: number): PTicket => {
    const found = byNumber.get(n);
    if (!found) throw new Error(`no ticket ${n}`);
    return found;
  };
  const plan = decisions
    .filter((d) => GROUP[d.action] !== undefined && (d.modality === "must" || d.modality === "may"))
    .sort(
      (x, y) =>
        (GROUP[x.action] ?? 0) - (GROUP[y.action] ?? 0) ||
        (x.action === "pick_up"
          ? comparePickup(ticket(x.ticket), ticket(y.ticket), sort)
          : x.ticket - y.ticket),
    );
  return { plan, decisions };
}

export const checkPlausibilityRules = (rules: Rule[] = PLAUSIBILITY_RULES): Diagnostic[] =>
  checkRules(rules, PFACTS);

// ---------------------------------------------------------------------------------------------
// Scenarios: complete synthetic facts and expectations, declared before evaluation.

/** `ticket:action`, e.g. `3:pick_up`. */
type Key = `${number}:${Action}`;
export interface Explanation {
  item: Key;
  modality: Modality;
  because: string[];
  overrides?: string[];
  /** Facts that must appear among the deciding rules' conditions. */
  facts?: string[];
}
export interface Expectation {
  /** Exact set of offered work, any order. */
  offered?: Key[];
  /** Partial order: each [a, b] means a is offered before b. */
  before?: [Key, Key][];
  /** Exact order of pickup tickets. */
  pickupOrder?: number[];
  /** Never offered as valid work anywhere in the plan. */
  forbidden?: Key[];
  /** Exact set of inspect decisions. */
  inspect?: Key[];
  explain?: Explanation[];
  /** Static diagnostic kinds for the scenario's rule set, sorted. */
  diagnostics?: Diagnostic["kind"][];
}
export interface Scenario {
  id: string;
  name: string;
  tickets: PTicket[];
  agent: PAgent;
  sort?: SortMode;
  rules?: Rule[];
  expect: Expectation;
}

/** Complete ticket record: every field is set explicitly, defaults are a plain ready ticket. */
export const ticket = (number: number, o: Partial<PTicket> = {}): PTicket => ({
  number,
  createdAt: `2026-10-${String(number % 28 || 28).padStart(2, "0")}T00:00:00Z`,
  labels: ["status:ready"],
  owners: [],
  openBlockers: 0,
  labelsComplete: true,
  openPrs: [],
  platforms: [],
  attention: [],
  unblocks: 0,
  prState: null,
  prAuthors: [],
  estimated: true,
  ...o,
});
const me: PAgent = { name: "ana", platform: "macos", complexityEnabled: false };
const meSizing: PAgent = { ...me, complexityEnabled: true };
const day = (d: number): string => `2026-09-${String(d).padStart(2, "0")}T00:00:00Z`;
const ageTickets = [
  ticket(30, { labels: ["status:ready", "urgency:low"], createdAt: day(1) }),
  ticket(31, { labels: ["status:ready", "urgency:high"], createdAt: day(20), unblocks: 3 }),
  ticket(32, { labels: ["status:incomplete"], createdAt: day(10) }),
];
const estimationTickets = [
  ticket(20, { estimated: false }),
  ticket(21, { openBlockers: 1, estimated: false }),
  ticket(22, { openBlockers: 2, estimated: true }),
];

export const SCENARIOS: readonly Scenario[] = Object.freeze([
  {
    id: "S1",
    name: "actionable versus waiting PR",
    tickets: [
      ticket(1, {
        labels: ["status:awaiting-review"],
        owners: ["ana"],
        openPrs: [101],
        prState: "actionable",
      }),
      ticket(2, {
        labels: ["status:awaiting-review"],
        prAuthors: ["ana"],
        openPrs: [102],
        prState: "waiting",
      }),
      ticket(3),
    ],
    agent: me,
    expect: {
      offered: ["1:follow_up", "3:pick_up"],
      before: [["1:follow_up", "3:pick_up"]],
      forbidden: ["2:follow_up", "1:pick_up", "2:pick_up"],
      inspect: ["2:wait"],
      explain: [
        {
          item: "1:follow_up",
          modality: "must",
          because: ["P1"],
          facts: ["myContribution", "prActionable"],
        },
        { item: "1:pick_up", modality: "must_not", because: ["R6"] },
      ],
    },
  },
  {
    id: "S2",
    name: "addressed attention",
    tickets: [
      ticket(5, { labels: ["status:ready", "urgency:low"], attention: ["ana"] }),
      ticket(6, { labels: ["status:ready", "urgency:high"] }),
      ticket(7, { attention: [] }),
      ticket(8, { attention: ["bo"] }),
    ],
    agent: me,
    expect: {
      offered: ["5:respond", "6:pick_up", "5:pick_up", "7:pick_up", "8:pick_up"],
      before: [
        ["5:respond", "6:pick_up"],
        ["6:pick_up", "5:pick_up"],
      ],
      forbidden: ["7:respond", "8:respond"],
      explain: [{ item: "5:respond", modality: "must", because: ["R1"], facts: ["addressed"] }],
    },
  },
  {
    id: "S3",
    name: "ready versus blocked, unknown and claimed implementation",
    tickets: [
      ticket(10),
      ticket(11, { openBlockers: 1 }),
      ticket(12, { openBlockers: null }),
      ticket(13, { owners: ["bo"] }),
      ticket(14, { labels: ["status:incomplete"], owners: ["ana"] }),
    ],
    agent: me,
    expect: {
      offered: ["14:continue", "10:pick_up"],
      before: [["14:continue", "10:pick_up"]],
      forbidden: ["11:pick_up", "12:pick_up", "13:pick_up", "14:pick_up"],
      inspect: ["12:refresh_evidence"],
      explain: [
        { item: "11:pick_up", modality: "must_not", because: ["R5"], overrides: ["R9"] },
        { item: "12:refresh_evidence", modality: "inspect", because: ["R10"] },
        { item: "13:pick_up", modality: "must_not", because: ["R4"], overrides: [] },
        { item: "14:continue", modality: "must", because: ["P3"], facts: ["mine", "!hasOpenPr"] },
      ],
    },
  },
  {
    id: "S4",
    name: "optional estimation of blocked work",
    tickets: estimationTickets,
    agent: meSizing,
    expect: {
      offered: ["20:pick_up", "20:estimate", "21:estimate"],
      before: [
        ["20:pick_up", "20:estimate"],
        ["20:pick_up", "21:estimate"],
      ],
      forbidden: ["21:pick_up", "22:pick_up", "22:estimate"],
      explain: [
        { item: "21:estimate", modality: "may", because: ["P7"], facts: ["!estimated"] },
        { item: "21:pick_up", modality: "must_not", because: ["R5"], overrides: ["R9"] },
      ],
    },
  },
  {
    id: "S5",
    name: "disabled complexity",
    tickets: estimationTickets,
    agent: me,
    expect: {
      offered: ["20:pick_up"],
      forbidden: ["20:estimate", "21:estimate", "22:estimate"],
      explain: [
        { item: "21:estimate", modality: "must_not", because: ["P8"], facts: ["!complexityOn"] },
      ],
    },
  },
  {
    id: "S6a",
    name: "explicit oldest ordering replaces urgency, impact and incomplete weighting",
    tickets: ageTickets,
    agent: me,
    sort: "oldest",
    expect: { pickupOrder: [30, 32, 31] },
  },
  {
    id: "S6b",
    name: "explicit newest ordering",
    tickets: ageTickets,
    agent: me,
    sort: "newest",
    expect: { pickupOrder: [31, 32, 30] },
  },
  {
    id: "S6c",
    name: "default impact ordering of the same tickets",
    tickets: ageTickets,
    agent: me,
    expect: { pickupOrder: [31, 32, 30] },
  },
  {
    id: "S7",
    name: "urgency then utility (immediate unlocks)",
    tickets: [
      ticket(40, { unblocks: 2, createdAt: day(5) }),
      ticket(41, { createdAt: day(1) }),
      ticket(42, { labels: ["status:ready", "urgency:high"], createdAt: day(25) }),
      ticket(43, { labels: ["status:ready", "urgency:low"], unblocks: 5, createdAt: day(2) }),
    ],
    agent: me,
    expect: { pickupOrder: [42, 40, 41, 43] },
  },
  {
    id: "S8",
    name: "label conflicts",
    tickets: [
      ticket(50, { labels: ["status:ready", "urgency:high", "urgency:low"], createdAt: day(1) }),
      ticket(51, { labels: ["status:ready", "urgency:low"], createdAt: day(2) }),
      ticket(52, { labels: ["status:ready", "urgency:high"], createdAt: day(3) }),
      ticket(53, { labels: ["status:ready", "status:awaiting-review"] }),
    ],
    agent: me,
    expect: {
      pickupOrder: [52, 50, 51],
      forbidden: ["53:pick_up"],
      inspect: ["50:fix_labels", "53:fix_labels"],
      explain: [
        { item: "53:pick_up", modality: "must_not", because: ["P4"], overrides: ["R9"] },
        { item: "50:fix_labels", modality: "inspect", because: ["P6"], facts: ["urgencyConflict"] },
      ],
    },
  },
  {
    id: "S9",
    name: "incomplete label evidence versus status:incomplete work",
    tickets: [
      ticket(60, { labelsComplete: false }),
      ticket(61, { labels: ["status:incomplete"] }),
      ticket(62),
    ],
    agent: me,
    expect: {
      pickupOrder: [61, 62],
      forbidden: ["60:pick_up"],
      inspect: ["60:refresh_evidence"],
      explain: [
        {
          item: "60:refresh_evidence",
          modality: "inspect",
          because: ["R10"],
          facts: ["evidenceUnknown"],
        },
      ],
    },
  },
  {
    id: "S10",
    name: "post-done PR follow-up",
    tickets: [
      ticket(70, {
        labels: ["status:awaiting-review"],
        prAuthors: ["ana"],
        openPrs: [700],
        prState: "actionable",
      }),
      ticket(71, { labels: ["status:ready", "urgency:high"] }),
      ticket(72, {
        labels: ["status:awaiting-review"],
        prAuthors: ["bo"],
        openPrs: [720],
        prState: "actionable",
      }),
    ],
    agent: me,
    expect: {
      offered: ["70:follow_up", "71:pick_up"],
      before: [["70:follow_up", "71:pick_up"]],
      forbidden: ["70:pick_up", "72:follow_up", "72:pick_up"],
      explain: [
        { item: "70:follow_up", modality: "must", because: ["P1"], facts: ["prActionable"] },
      ],
    },
  },
  {
    id: "S11",
    name: "deliberately conflicting rules",
    tickets: [ticket(80, { openBlockers: 1 }), ticket(81, { attention: ["ana"] })],
    agent: me,
    rules: [
      ...PLAUSIBILITY_RULES,
      {
        id: "X1",
        modality: "may",
        action: "pick_up",
        when: [{ fact: "blocked" }],
        reason: "Contradicts R5.",
      },
      {
        id: "X2",
        modality: "must_not",
        action: "respond",
        when: [{ fact: "addressed" }],
        reason: "Contradicts R1.",
      },
    ],
    expect: {
      diagnostics: ["contradiction", "contradiction"],
      offered: ["81:pick_up"],
      forbidden: ["80:pick_up", "81:respond"],
      explain: [
        { item: "80:pick_up", modality: "must_not", because: ["R5"], overrides: ["R9", "X1"] },
        { item: "81:respond", modality: "must_not", because: ["X2"], overrides: ["R1"] },
      ],
    },
  },
] satisfies Scenario[]);

export interface Outcome {
  id: string;
  name: string;
  pass: boolean;
  failures: string[];
  result: PEvaluation;
}

const key = (d: { ticket: number; action: Action }): Key => `${d.ticket}:${d.action}`;
const j = (x: unknown): string => JSON.stringify(x);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sorted = (xs: readonly string[]): string[] => [...xs].sort();

export function runScenario(s: Scenario): Outcome {
  const rules = s.rules ?? PLAUSIBILITY_RULES;
  const result = evaluate(s.tickets, s.agent, rules, s.sort);
  const failures: string[] = [];
  const offered = result.plan.map(key);
  const e = s.expect;
  const check = (ok: boolean, msg: string): void => {
    if (!ok) failures.push(msg);
  };
  if (e.offered)
    check(same(sorted(offered), sorted(e.offered)), `offered ${j(offered)} != ${j(e.offered)}`);
  for (const [a, b] of e.before ?? []) {
    const [ia, ib] = [offered.indexOf(a), offered.indexOf(b)];
    check(ia >= 0 && ib >= 0 && ia < ib, `${a} not before ${b} in ${j(offered)}`);
  }
  if (e.pickupOrder) {
    const pick = result.plan.filter((d) => d.action === "pick_up").map((d) => d.ticket);
    check(same(pick, e.pickupOrder), `pickup ${j(pick)} != ${j(e.pickupOrder)}`);
  }
  for (const f of e.forbidden ?? []) check(!offered.includes(f), `forbidden ${f} offered`);
  if (e.inspect) {
    const got = result.decisions.filter((d) => d.modality === "inspect").map(key);
    check(same(sorted(got), sorted(e.inspect)), `inspect ${j(got)} != ${j(e.inspect)}`);
  }
  for (const x of e.explain ?? []) {
    const d = result.decisions.find((d) => key(d) === x.item);
    if (!d) {
      failures.push(`no decision for ${x.item}`);
      continue;
    }
    check(d.modality === x.modality, `${x.item} modality ${d.modality} != ${x.modality}`);
    check(same(sorted(d.because), sorted(x.because)), `${x.item} because ${j(d.because)}`);
    if (x.overrides)
      check(
        same(sorted(d.overrides), sorted(x.overrides)),
        `${x.item} overrides ${j(d.overrides)}`,
      );
    for (const f of x.facts ?? []) check(d.facts.includes(f), `${x.item} lacks fact ${f}`);
  }
  if (e.diagnostics) {
    const kinds = checkPlausibilityRules(rules).map((d) => d.kind);
    check(same(sorted(kinds), sorted(e.diagnostics)), `diagnostics ${j(kinds)}`);
  }
  return { id: s.id, name: s.name, pass: failures.length === 0, failures, result };
}

export const runScenarios = (scenarios: readonly Scenario[] = SCENARIOS): Outcome[] =>
  scenarios.map(runScenario);

/**
 * Baseline finding: the unmodified spike rules (with R2) make a waiting PR on a claimed ticket a
 * `must follow_up`, and offer nothing for a post-done PR whose claim was released.
 */
export function baselineFinding(): { waitingClaimed: Key[]; postDone: Key[] } {
  const rules = RULES;
  const waiting = ticket(90, { owners: ["ana"], openPrs: [900], prState: "waiting" });
  const postDone = ticket(91, { prAuthors: ["ana"], openPrs: [910], prState: "actionable" });
  return {
    waitingClaimed: evaluate([waiting], me, rules).plan.map(key),
    postDone: evaluate([postDone], me, rules).plan.map(key),
  };
}
