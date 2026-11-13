/**
 * Rules-language feasibility spike (#74). Not part of the runtime.
 *
 * One source of truth:
 * - FACTS: each named fact has a JS test, a DataScript (EDN) clause and an English phrase.
 * - RULES: small data records (id, modality, action, conditions, reason). A condition is a fact
 *   name, optionally negated. No user-supplied functions or free-form queries.
 * From these, the spike compiles English guidance, a plain-JS evaluator and a DataScript
 * evaluator, and checks the rule set for contradictions.
 */

/** Ticket labels and evidence the facts are computed from (one viewer agent). */
const has = (t, label) => t.labels.includes(label);

/**
 * @typedef {{ number: number, createdAt: string, labels: string[], owners: string[],
 *   openBlockers: number | null, labelsComplete: boolean, openPrs: number[],
 *   platforms: string[], attention: string[], unblocks: number }} Ticket
 * @typedef {{ name: string, platform: string | null }} Agent
 */

/** @type {Record<string, { js: (t: Ticket, a: Agent) => boolean, edn: string, en: string }>} */
export const FACTS = {
  addressed: {
    js: (t, a) => t.attention.includes(a.name),
    edn: '[?t "attention" ?a]',
    en: "it requests your attention",
  },
  mine: {
    js: (t, a) => t.owners.includes(a.name),
    edn: '[?t "owner" ?a]',
    en: "you hold its claim",
  },
  claimed: {
    js: (t) => t.owners.length > 0,
    edn: '[?t "owner" _]',
    en: "an agent holds its claim",
  },
  claimedByOther: {
    js: (t, a) => t.owners.some((o) => o !== a.name),
    edn: '[?t "owner" ?o] [(not= ?o ?a)]',
    en: "another agent holds its claim",
  },
  hasOpenPr: {
    js: (t) => t.openPrs.length > 0,
    edn: '[?t "open-pr" _]',
    en: "an open pull request addresses it",
  },
  pickupLabel: {
    js: (t) => has(t, "status:ready") || has(t, "status:incomplete"),
    edn: '(or [?t "label" "status:ready"] [?t "label" "status:incomplete"])',
    en: "it is labelled status:ready or status:incomplete",
  },
  designOpen: {
    js: (t) => ["question", "status:needs-design", "design:decision-needed"].some((l) => has(t, l)),
    edn: '(or [?t "label" "question"] [?t "label" "status:needs-design"] [?t "label" "design:decision-needed"])',
    en: "a question or design decision is outstanding",
  },
  blocked: {
    js: (t) => (t.openBlockers ?? 0) > 0,
    edn: '[?t "blocked" true]',
    en: "an open native blocker remains",
  },
  evidenceUnknown: {
    js: (t) => t.openBlockers === null || !t.labelsComplete,
    edn: '[?t "evidence-unknown" true]',
    en: "its blocker or label evidence is incomplete",
  },
  restricted: {
    js: (t, a) => t.platforms.length > 0 && !!a.platform && !t.platforms.includes(a.platform),
    edn: '[?t "platform" _] [?ae "agent-platform" ?p] (not [?t "platform" ?p])',
    en: "it is restricted to another platform",
  },
  platformUnknown: {
    js: (t, a) => t.platforms.length > 0 && !a.platform,
    edn: '[?t "platform" _] (not [?ae "agent-platform" _])',
    en: "it is platform-restricted and your platform is unknown",
  },
};

/**
 * @typedef {{ fact: string, not?: boolean }} Condition
 * @typedef {{ id: string, modality: "must" | "may" | "must_not" | "inspect", action: string,
 *   when: Condition[], reason: string }} Rule
 */

/** The current agreed workflow (a slice), as data. */
/** @type {Rule[]} */
export const RULES = [
  {
    id: "R1",
    modality: "must",
    action: "respond",
    when: [{ fact: "addressed" }],
    reason: "Addressed attention comes before new work.",
  },
  {
    id: "R2",
    modality: "must",
    action: "follow_up",
    when: [{ fact: "mine" }, { fact: "hasOpenPr" }],
    reason: "Get your own pull request merged before taking new work.",
  },
  {
    id: "R3",
    modality: "must_not",
    action: "implement",
    when: [{ fact: "designOpen" }],
    reason: "Implementation follows a settled design.",
  },
  {
    id: "R4",
    modality: "must_not",
    action: "pick_up",
    when: [{ fact: "claimedByOther" }],
    reason: "Never take over another agent's claim.",
  },
  {
    id: "R5",
    modality: "must_not",
    action: "pick_up",
    when: [{ fact: "blocked" }],
    reason: "Native blockers are authoritative.",
  },
  {
    id: "R6",
    modality: "must_not",
    action: "pick_up",
    when: [{ fact: "hasOpenPr" }],
    reason: "An open pull request is follow-up, not new pickup.",
  },
  {
    id: "R7",
    modality: "must_not",
    action: "pick_up",
    when: [{ fact: "restricted" }],
    reason: "Platform restrictions are explicit.",
  },
  {
    id: "R8",
    modality: "must_not",
    action: "pick_up",
    when: [{ fact: "designOpen" }],
    reason: "Implementation follows a settled design.",
  },
  {
    id: "R9",
    modality: "may",
    action: "pick_up",
    when: [
      { fact: "pickupLabel" },
      { fact: "claimed", not: true },
      { fact: "evidenceUnknown", not: true },
      { fact: "platformUnknown", not: true },
    ],
    reason: "Ready and unclaimed work is eligible.",
  },
  {
    id: "R10",
    modality: "inspect",
    action: "refresh_evidence",
    when: [{ fact: "pickupLabel" }, { fact: "evidenceUnknown" }],
    reason: "Missing evidence is not eligibility.",
  },
  {
    id: "R11",
    modality: "inspect",
    action: "confirm_platform",
    when: [{ fact: "pickupLabel" }, { fact: "platformUnknown" }],
    reason: "A restricted ticket needs your platform.",
  },
];

/** Pickup order among permitted pick_up actions (the "order" clause), as data. */
export const ORDER = [
  { key: "unblocks", direction: "desc", en: "most dependants unblocked first" },
  { key: "incomplete", direction: "desc", en: "incomplete work before unstarted" },
  { key: "createdAt", direction: "asc", en: "oldest first" },
  { key: "number", direction: "asc", en: "then by number" },
];

const modalEn = { must: "You must", may: "You may", must_not: "You must not", inspect: "Inspect:" };
const actionEn = {
  respond: "respond to the ticket",
  follow_up: "follow up the pull request",
  implement: "implement the ticket",
  pick_up: "pick up the ticket",
  refresh_evidence: "refresh its evidence before deciding",
  confirm_platform: "confirm your platform before claiming",
};

/** Compile one rule to English from the same record and fact table. */
export function english(rule) {
  const conds = rule.when.map((c) => (c.not ? `not (${FACTS[c.fact].en})` : FACTS[c.fact].en));
  return `${rule.id}: ${modalEn[rule.modality]} ${actionEn[rule.action]} when ${conds.join(" and ")}. ${rule.reason}`;
}
export const englishGuide = (rules = RULES) =>
  [...rules.map(english), `Order for pick_up: ${ORDER.map((o) => o.en).join(", ")}.`].join("\n");

/** Static checks: unknown facts, self-contradictory rules, and contradictory rule pairs. */
export function checkRules(rules = RULES) {
  const diagnostics = [];
  const key = (r) =>
    r.when
      .map((c) => `${c.not ? "!" : ""}${c.fact}`)
      .sort()
      .join("&");
  for (const r of rules) {
    for (const c of r.when)
      if (!FACTS[c.fact])
        diagnostics.push({ kind: "unknown-fact", rules: [r.id], detail: `unknown fact ${c.fact}` });
    const pos = new Set(r.when.filter((c) => !c.not).map((c) => c.fact));
    if (r.when.some((c) => c.not && pos.has(c.fact)))
      diagnostics.push({
        kind: "never-applies",
        rules: [r.id],
        detail: "a fact is both required and negated",
      });
  }
  for (let i = 0; i < rules.length; i++)
    for (let j = i + 1; j < rules.length; j++) {
      const [a, b] = [rules[i], rules[j]];
      const opposite =
        a.action === b.action &&
        ((a.modality === "must_not" && b.modality !== "must_not") ||
          (b.modality === "must_not" && a.modality !== "must_not"));
      // Identical conditions with opposite modality always collide: a definite contradiction.
      if (opposite && key(a) === key(b))
        diagnostics.push({
          kind: "contradiction",
          rules: [a.id, b.id],
          detail: `same conditions, ${a.modality} vs ${b.modality} ${a.action}`,
        });
    }
  return diagnostics;
}

/** Combine rule hits per (ticket, action): must_not wins over may/must, and the override is shown. */
function decide(hits) {
  const byKey = new Map();
  for (const h of hits) {
    const k = `${h.ticket}:${h.action}`;
    byKey.set(k, [...(byKey.get(k) ?? []), h]);
  }
  const decisions = [];
  for (const [, group] of byKey) {
    const forbid = group.filter((h) => h.modality === "must_not");
    const others = group.filter((h) => h.modality !== "must_not");
    if (forbid.length)
      decisions.push({
        ticket: group[0].ticket,
        action: group[0].action,
        modality: "must_not",
        because: forbid.map((h) => h.rule),
        overrides: others.map((h) => h.rule),
      });
    else
      for (const m of ["must", "may", "inspect"]) {
        const hit = others.filter((h) => h.modality === m);
        if (hit.length) {
          decisions.push({
            ticket: group[0].ticket,
            action: group[0].action,
            modality: m,
            because: hit.map((h) => h.rule),
            overrides: [],
          });
          break;
        }
      }
  }
  return decisions;
}

/** Order permitted pick_up decisions with the ORDER clause. */
function order(decisions, tickets) {
  const byNumber = new Map(tickets.map((t) => [t.number, t]));
  const value = (t, key) => (key === "incomplete" ? Number(has(t, "status:incomplete")) : t[key]);
  const pick = decisions
    .filter((d) => d.action === "pick_up" && d.modality === "may")
    .sort((x, y) => {
      for (const o of ORDER) {
        const a = value(byNumber.get(x.ticket), o.key);
        const b = value(byNumber.get(y.ticket), o.key);
        const c = typeof a === "string" ? a.localeCompare(b) : a - b;
        if (c) return o.direction === "asc" ? c : -c;
      }
      return 0;
    });
  return pick.map((d) => d.ticket);
}

/** Plain registered-JS evaluator compiled from the rule records. */
export function evaluateJs(tickets, agent, rules = RULES) {
  const hits = [];
  for (const t of tickets)
    for (const r of rules)
      if (r.when.every((c) => FACTS[c.fact].js(t, agent) !== !!c.not))
        hits.push({ ticket: t.number, action: r.action, modality: r.modality, rule: r.id });
  const decisions = decide(hits);
  return { decisions, pickupOrder: order(decisions, tickets) };
}

/** Datoms for DataScript: one entity per ticket plus the viewer agent entity. */
function datoms(tickets, agent) {
  const out = [];
  let id = 1;
  const agentId = id++;
  out.push([agentId, "name", agent.name]);
  if (agent.platform) out.push([agentId, "agent-platform", agent.platform]);
  const entity = new Map();
  for (const t of tickets) {
    const e = id++;
    entity.set(e, t.number);
    out.push([e, "number", t.number]);
    for (const l of t.labels) out.push([e, "label", l]);
    for (const o of t.owners) out.push([e, "owner", o]);
    for (const a of t.attention) out.push([e, "attention", a]);
    for (const p of t.openPrs) out.push([e, "open-pr", p]);
    for (const p of t.platforms) out.push([e, "platform", p]);
    if ((t.openBlockers ?? 0) > 0) out.push([e, "blocked", true]);
    if (t.openBlockers === null || !t.labelsComplete) out.push([e, "evidence-unknown", true]);
  }
  return { out, agentId, entity };
}

/**
 * DataScript evaluator compiled from the same rule records and fact clauses. Each rule becomes
 * one query; ?a is the viewer's name and ?ae the viewer entity (for its platform).
 */
export function evaluateDataScript(ds, tickets, agent, rules = RULES) {
  const { out, agentId, entity } = datoms(tickets, agent);
  const conn = ds.create_conn();
  ds.transact(
    conn,
    out.map(([e, a, v]) => [":db/add", e, a, v]),
  );
  const db = ds.db(conn);
  const hits = [];
  for (const r of rules) {
    const clauses = r.when.map((c) => (c.not ? `(not ${FACTS[c.fact].edn})` : FACTS[c.fact].edn));
    const query = `[:find ?t :in $ ?a ?ae :where [?t "number" _] ${clauses.join(" ")}]`;
    for (const [e] of ds.q(query, db, agent.name, agentId))
      hits.push({ ticket: entity.get(e), action: r.action, modality: r.modality, rule: r.id });
  }
  const decisions = decide(hits);
  return { decisions, pickupOrder: order(decisions, tickets) };
}
