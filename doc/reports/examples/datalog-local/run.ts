/** Bounded research trial #308; not the complete production evaluator (#303). */
import * as fs from "node:fs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import type { DataScript, Datom, Value } from "datascript";

interface Reading {
  state: string;
  size: string | null;
  provenance: string | null;
}
interface RawComment {
  url: string;
  body: string;
}
interface Ref {
  state: string;
  url: string;
}
interface Page<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean };
}
interface RawIssue {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  state: string;
  labels: Page<{ name: string }>;
  comments: Page<RawComment>;
  blockedBy: Page<Ref>;
  issueDependenciesSummary: { totalBlockedBy: number };
  closedByPullRequestsReferences?: Page<Ref>;
}
interface SnapshotInput {
  repository: string;
  fetchedAt: string;
  issues: RawIssue[];
}
interface BaselineInput {
  subjects: { url: string; assessments?: { impact: Reading; complexity: Reading } }[];
  rankedActions: { items: unknown[] };
  role?: { sections: { items: { url: string; reason: string }[] }[] };
}
interface Subject {
  number: number;
  title?: string;
  url?: string;
  created?: number;
  kind?: string;
  state?: string;
  labels?: string[];
  labelsComplete?: boolean;
  nativeComplete?: boolean;
  closingComplete?: boolean;
  owners?: string[];
  attention?: string[];
  platforms?: string[];
  openPrs?: string[];
  checks?: string[];
  blockers?: string[];
  impactState?: string;
  impact?: string | null;
  complexityState?: string;
  complexity?: string | null;
  benefit?: string;
}
interface Row {
  number: number;
  action: string;
  band: number;
  pref: number;
  rule: string;
  why: string;
  shortWhy: string;
  bindings: Record<string, Value>;
  created: number;
  url?: string;
  title?: string;
}
type DecisionTuple = [
  number,
  number,
  string,
  number,
  number,
  string,
  string,
  string,
  string,
  string,
  string,
  number,
  number,
  string,
];
const { values } = parseArgs({
  options: {
    "engine-module": { type: "string" },
    snapshot: { type: "string" },
    baseline: { type: "string" },
    out: { type: "string" },
  },
});
if (!values["engine-module"] || !values.out)
  throw new Error(
    "Use --engine-module /trusted/path/to/datascript --out /tmp/result.json [--snapshot PATH --baseline PATH]. Omit both snapshot inputs to run only synthetic fixtures.",
  );
if (Boolean(values.snapshot) !== Boolean(values.baseline))
  throw new Error("Pass snapshot and baseline together.");
const localRequire = createRequire(resolve("package.json"));
// One assertion boundary for the reviewed external evaluator selected explicitly by this local research command.
const ds = localRequire(resolve(values["engine-module"])) as DataScript;
const snapshot: SnapshotInput = values.snapshot
  ? (JSON.parse(fs.readFileSync(values.snapshot, "utf8")) as SnapshotInput)
  : { repository: "synthetic", fetchedAt: "synthetic-fixtures", issues: [] };
const baseline: BaselineInput = values.baseline
  ? (JSON.parse(fs.readFileSync(values.baseline, "utf8")) as BaselineInput)
  : { subjects: [], rankedActions: { items: [] } };
assert(
  Array.isArray(snapshot.issues) && snapshot.issues.length <= 500,
  "bounded valid snapshot required",
);
assert(Array.isArray(baseline.subjects), "baseline assessment source required");
// This is a bounded research policy, not the complete #303 evaluator. Every selected action,
// classification, explanation template and dominance rule below is evaluated/joined in Datalog.
const shared = `
[(open-subject ?t) [?t "primary" true] [?t "state" "OPEN"]]
[(large-impact ?t) [?t "impact-state" "current"] [?t "impact-size" ?s] [1 "large" ?s]]
[(small-complexity ?t) [?t "complexity-state" "current"] [?t "complexity-size" ?s] [1 "small" ?s]]
[(small-impact ?t) [?t "impact-state" "current"] [?t "impact-size" ?s] [1 "small" ?s]]
[(large-complexity ?t) [?t "complexity-state" "current"] [?t "complexity-size" ?s] [1 "large" ?s]]
[(easy ?t) (large-impact ?t) (small-complexity ?t)]
[(unfavorable ?t) (small-impact ?t) (large-complexity ?t)]
[(claimed ?t) [?t "owner" _]]
[(open-blocker ?t) [?t "blocked-by" ?b] [?b "state" "OPEN"]]
[(open-pr ?t) [?t "open-pr" _]]
[(design-question ?t) (or [?t "label" "question"] [?t "label" "design:decision-needed"])]
[(has-platform ?t) [?t "platform" _]]
[(platform-ok ?t) (open-subject ?t) (not (has-platform ?t))]
[(platform-ok ?t) [?t "platform" ?p] [1 "platform" ?p] [(not= ?p "unknown")]]
[(eligible ?t) (open-subject ?t) [?t "kind" "issue"] [?t "labels-complete" true] [?t "native-complete" true] [?t "closing-complete" true]
 (or [?t "label" "status:ready"] [?t "label" "status:incomplete"])
 (not (claimed ?t)) (not (open-blocker ?t)) (not (open-pr ?t)) (not (design-question ?t))
 (not [?t "label" "status:needs-design"]) (platform-ok ?t)]
[(needs-complexity ?t) (open-subject ?t) (or [?t "complexity-state" "unassessed"] [?t "complexity-state" "stale"])]
[(needs-impact ?t) (open-subject ?t) (or [?t "impact-state" "unassessed"] [?t "impact-state" "stale"])]
`;
const catalog = [
  {
    id: "D-ATTENTION",
    action: "respond",
    band: 1,
    pref: 0,
    when: '(open-subject ?t) [?t "attention" ?a] [1 "agent" ?a] [(not= ?a "")]',
    why: "You were explicitly asked to respond; this takes precedence over discretionary work.",
  },
  {
    id: "D-PR-FAIL",
    action: "pr-follow-up",
    band: 2,
    pref: 0,
    when: '(open-subject ?t) [?t "kind" "pr"] (or [?t "check" "FAILURE"] [?t "check" "TIMED_OUT"])',
    why: "A failed PR check is actionable delivery work; fix the failure before starting more work.",
  },
  {
    id: "D-DECISION",
    action: "decide",
    band: 3,
    pref: 0,
    when: '(open-subject ?t) [1 "role" "designer"] (design-question ?t)',
    why: "Resolve the recorded decision before implementation proceeds. Expected benefit: {benefit}",
  },
  {
    id: "D-DOCUMENT",
    action: "document",
    band: 3,
    pref: 1,
    when: '(open-subject ?t) [1 "role" "designer"] [?t "label" "design:documentation-needed"]',
    why: "An agreed decision still needs its contract written. Expected benefit: {benefit}",
  },
  {
    id: "D-EASY",
    action: "implement",
    band: 4,
    pref: 0,
    when: '[1 "role" "implementer"] (eligible ?t) (easy ?t)',
    why: "Known easy win: impact {impact}, complexity {complexity}. Expected benefit: {benefit}",
  },
  {
    id: "D-COMPLEXITY-BOOST",
    action: "estimate-complexity",
    band: 5,
    pref: 0,
    when: '[1 "role" "implementer"] (needs-complexity ?t) (large-impact ?t)',
    why: "High impact {impact}, but effort is {complexityState}: estimate it to test whether this is a good-value implementation. Expected benefit: {benefit}",
  },
  {
    id: "D-COMPLEXITY",
    action: "estimate-complexity",
    band: 5,
    pref: 1,
    when: '[1 "role" "implementer"] (needs-complexity ?t)',
    why: "Effort is {complexityState}; sizing improves the evidence for choosing work. Expected benefit: {benefit}",
  },
  {
    id: "D-IMPACT-BOOST",
    action: "assess-impact",
    band: 5,
    pref: 0,
    when: '[1 "role" "designer"] (needs-impact ?t) (small-complexity ?t)',
    why: "Complexity is only {complexity}, but benefit is {impactState}: assess impact to reveal a possible easy win.",
  },
  {
    id: "D-IMPACT",
    action: "assess-impact",
    band: 5,
    pref: 1,
    when: '[1 "role" "designer"] (needs-impact ?t)',
    why: "Benefit is {impactState}; assess it before claiming this work is good value.",
  },
  {
    id: "D-ORDINARY",
    action: "implement",
    band: 6,
    pref: 0,
    when: '[1 "role" "implementer"] (eligible ?t) (not (easy ?t)) (not (unfavorable ?t))',
    why: "Ready and unblocked, but no current high-benefit/small-effort pair establishes an easy win. Expected benefit: {benefit}",
  },
  {
    id: "D-DESIGN",
    action: "design",
    band: 6,
    pref: 0,
    when: '[1 "role" "designer"] (open-subject ?t) [?t "label" "status:needs-design"] (not (design-question ?t)) (not [?t "label" "design:documentation-needed"]) (not (claimed ?t)) (platform-ok ?t)',
    why: "A design contract is still missing. Impact {impact}, complexity {complexity}. Expected benefit: {benefit}",
  },
  {
    id: "D-UNFAVORABLE",
    action: "implement",
    band: 7,
    pref: 0,
    when: '[1 "role" "implementer"] (eligible ?t) (unfavorable ?t)',
    why: "Low benefit {impact} relative to large effort {complexity}: prefer stronger options. Expected benefit: {benefit}",
  },
];
// Same-action conflict/overlap resolution is also Datalog, not the old decide() function.
const dominance = `
[(dominates ?t ?r ?other) (match ?t ?r) (match ?t ?other) [?r "action" ?a] [?other "action" ?a] [?r "band" ?b] [?other "band" ?ob] [(< ?ob ?b)]]
[(dominates ?t ?r ?other) (match ?t ?r) (match ?t ?other) [?r "action" ?a] [?other "action" ?a] [?r "band" ?b] [?other "band" ?b] [?r "pref" ?p] [?other "pref" ?op] [(< ?op ?p)]]
[(has-better ?t ?r) (dominates ?t ?r ?other)]
`;
const rules =
  "[" +
  shared +
  catalog
    .map(
      (r) =>
        `[(match ?t ?r) [?r "rule-id" "${r.id}"] ${r.when.replaceAll("(eligible ?t)", '[?t "derived-eligible" true]').replaceAll("(platform-ok ?t)", '[?t "derived-platform-ok" true]').replaceAll("(not (design-question ?t))", '(not [?t "derived-question" true])')}]`,
    )
    .join("\n") +
  dominance +
  "]";
function evaluate(subjects: Subject[], role: string, agent = "", platform = "unknown"): Row[] {
  const facts: Datom[] = [
    [1, "role", role],
    [1, "agent", agent],
    [1, "platform", platform],
    ...["XS", "S"].map((x): Datom => [1, "small", x]),
    ...["L", "XL", "XXL"].map((x): Datom => [1, "large", x]),
  ];
  catalog.forEach((r, i) => {
    for (const [k, v] of Object.entries({
      "rule-id": r.id,
      action: r.action,
      band: r.band,
      pref: r.pref,
      why: r.why,
      "why-short": r.why.replace(" Expected benefit: {benefit}", ""),
    }))
      facts.push([i + 10, k, v]);
  });
  const byId = new Map<number, Subject>();
  subjects.forEach((s, i) => {
    const id = 100 + i;
    byId.set(id, s);
    for (const [k, v] of Object.entries({
      primary: true,
      kind: s.kind || "issue",
      number: s.number,
      url: s.url || `fixture:${s.number}`,
      title: s.title || `Fixture ${s.number}`,
      state: s.state || "OPEN",
      "labels-complete": s.labelsComplete !== false,
      "native-complete": s.nativeComplete !== false,
      "closing-complete": s.closingComplete !== false,
      "impact-state": s.impactState || "unassessed",
      "impact-size": s.impact || "-",
      "complexity-state": s.complexityState || "unassessed",
      "complexity-size": s.complexity || "-",
      benefit: s.benefit || "No trusted benefit rationale recorded.",
      created: s.created ?? i,
    }))
      facts.push([id, k, v]);
    for (const [a, values] of Object.entries({
      label: s.labels || [],
      owner: s.owners || [],
      attention: s.attention || [],
      platform: s.platforms || [],
      "open-pr": s.openPrs || [],
      check: s.checks || [],
    }))
      for (const v of values) facts.push([id, a, v]);
    for (const [j, b] of (s.blockers || []).entries()) {
      const bid = 10000 + i * 100 + j;
      facts.push([id, "blocked-by", bid], [bid, "state", b]);
    }
  });
  const many = { ":db/cardinality": ":db.cardinality/many" };
  const schema = Object.fromEntries(
    [
      "small",
      "large",
      "label",
      "owner",
      "attention",
      "platform",
      "open-pr",
      "check",
      "blocked-by",
      "matched-rule",
      "overridden-rule",
    ].map((k) => [k, many]),
  );
  let db = ds.init_db(facts, schema);
  // An explicit Datalog query phase materializes eligibility; JS only transacts its result.
  // This avoids depending on nested negated rule evaluation during candidate resolution.
  const platformFacts = ds
    .q("[:find ?t :in $ % :where (platform-ok ?t)]", db, rules)
    .map(([id]): Datom => [Number(id), "derived-platform-ok", true]);
  const questionFacts = ds
    .q("[:find ?t :in $ % :where (design-question ?t)]", db, rules)
    .map(([id]): Datom => [Number(id), "derived-question", true]);
  facts.push(...platformFacts, ...questionFacts);
  db = ds.init_db(facts, schema);
  const eligibility =
    '[:find ?t :in $ % :where (open-subject ?t) [?t "kind" "issue"] [?t "labels-complete" true] [?t "native-complete" true] [?t "closing-complete" true] (or [?t "label" "status:ready"] [?t "label" "status:incomplete"]) (not (claimed ?t)) (not (open-blocker ?t)) (not (open-pr ?t)) (not (design-question ?t)) (not [?t "label" "status:needs-design"]) (platform-ok ?t)]';
  const derived = ds
    .q(eligibility, db, rules)
    .map(([id]): Datom => [Number(id), "derived-eligible", true]);
  db = ds.init_db([...facts, ...derived], schema);
  const matches = ds
    .q("[:find ?t ?r :in $ % :where (match ?t ?r)]", db, rules)
    .map(([id, r]): Datom => [Number(id), "matched-rule", r]);
  db = ds.init_db([...facts, ...derived, ...matches], schema);
  const higher =
    '[:find ?t ?r :where [?t "matched-rule" ?r] [?t "matched-rule" ?o] [?r "action" ?a] [?o "action" ?a] [?r "band" ?b] [?o "band" ?ob] [(< ?ob ?b)]]';
  const preferred =
    '[:find ?t ?r :where [?t "matched-rule" ?r] [?t "matched-rule" ?o] [?r "action" ?a] [?o "action" ?a] [?r "band" ?b] [?o "band" ?b] [?r "pref" ?p] [?o "pref" ?op] [(< ?op ?p)]]';
  const rejected = [...ds.q(higher, db), ...ds.q(preferred, db)].map(([id, r]): Datom => [
    Number(id),
    "overridden-rule",
    r,
  ]);
  db = ds.init_db([...facts, ...derived, ...matches, ...rejected], schema);

  const query =
    '[:find ?t ?r ?a ?b ?p ?why ?impact ?cs ?istate ?cstate ?benefit ?created ?n ?short :in $ % :where [?t "matched-rule" ?r] (not [?t "overridden-rule" ?r]) [?r "action" ?a] [?r "band" ?b] [?r "pref" ?p] [?r "why" ?why] [?t "impact-size" ?impact] [?t "complexity-size" ?cs] [?t "impact-state" ?istate] [?t "complexity-state" ?cstate] [?t "benefit" ?benefit] [?t "created" ?created] [?t "number" ?n] [?r "why-short" ?short]]';
  // The fixed query determines every column; this boundary asserts that result tuple shape.
  const rows = (ds.q(query, db, rules) as DecisionTuple[]).map(
    ([
      id,
      r,
      action,
      band,
      pref,
      template,
      impact,
      complexity,
      impactState,
      complexityState,
      benefit,
      created,
      number,
      short,
    ]) => {
      const bindings: Record<string, Value> = {
        impact,
        complexity,
        impactState,
        complexityState,
        benefit,
      };
      return {
        number,
        action,
        band,
        pref,
        rule: catalog[r - 10].id,
        why: template.replace(/\{(\w+)\}/g, (_, k) => String(bindings[k])),
        shortWhy: short.replace(/\{(\w+)\}/g, (_, k) => String(bindings[k])),
        bindings,
        created,
        url: byId.get(id)!.url,
        title: byId.get(id)!.title,
      };
    },
  );
  // Generic lexicographic sort of engine-produced numeric keys; no policy classification here.
  rows.sort(
    (a, b) =>
      a.band - b.band ||
      a.pref - b.pref ||
      a.created - b.created ||
      a.number - b.number ||
      a.action.localeCompare(b.action),
  );
  return rows;
}
const ready = (number: number, extra: Partial<Subject> = {}): Subject => ({
  number,
  labels: ["status:ready"],
  ...extra,
});
const tests: { name: string; pass: boolean }[] = [];
function test(name: string, fn: () => void) {
  fn();
  tests.push({ name, pass: true });
}
test("known easy win precedes high-impact complexity assessment", () => {
  let r = evaluate(
    [
      ready(1, {
        impact: "L",
        complexity: "S",
        impactState: "current",
        complexityState: "current",
      }),
      ready(2, { impact: "XL", impactState: "current" }),
    ],
    "implementer",
  );
  assert.equal(r[0].rule, "D-EASY");
  assert.equal(r.find((x) => x.number === 2)!.rule, "D-COMPLEXITY-BOOST");
});
test("small effort boosts missing impact assessment", () => {
  let r = evaluate(
    [ready(1), ready(2, { complexity: "S", complexityState: "current" })],
    "designer",
  );
  assert.equal(r[0].number, 2);
  assert.equal(r[0].rule, "D-IMPACT-BOOST");
});
test("unfavorable pair follows confidence-building assessment", () => {
  let r = evaluate(
    [
      ready(1, {
        impact: "S",
        complexity: "XL",
        impactState: "current",
        complexityState: "current",
      }),
      ready(2),
    ],
    "implementer",
  );
  assert.equal(r.at(-1)!.rule, "D-UNFAVORABLE");
});
test("unknown completeness never permits implementation", () => {
  let r = evaluate(
    [
      ready(1, {
        nativeComplete: false,
        impact: "L",
        complexity: "S",
        impactState: "current",
        complexityState: "current",
      }),
    ],
    "implementer",
  );
  assert(!r.some((x) => x.action === "implement"));
});
test("blocked work can be sized, not implemented", () => {
  let r = evaluate(
    [ready(1, { blockers: ["OPEN"], impact: "L", impactState: "current" })],
    "implementer",
  );
  assert(r.some((x) => x.action === "estimate-complexity"));
  assert(!r.some((x) => x.action === "implement"));
});
test("other claim prevents pickup", () => {
  let r = evaluate(
    [
      ready(1, {
        owners: ["other"],
        impact: "L",
        complexity: "S",
        impactState: "current",
        complexityState: "current",
      }),
    ],
    "implementer",
    "alice",
  );
  assert(!r.some((x) => x.action === "implement"));
});
test("waiting PR does not displace ready work; failed PR does", () => {
  let r = evaluate(
    [
      { number: 1, kind: "pr", checks: ["PENDING"] },
      { number: 2, kind: "pr", checks: ["FAILURE"] },
      ready(3),
    ],
    "implementer",
  );
  assert.equal(r[0].rule, "D-PR-FAIL");
  assert(!r.some((x) => x.number === 1 && x.action === "pr-follow-up"));
});
test("addressed attention wins and keeps multiple destinations", () => {
  let r = evaluate(
    [
      ready(1, { attention: ["bob", "alice"] }),
      ready(2, {
        impact: "L",
        complexity: "S",
        impactState: "current",
        complexityState: "current",
      }),
    ],
    "implementer",
    "alice",
  );
  assert.equal(r[0].rule, "D-ATTENTION");
});
test("overlapping assessment rules choose boosted explanation once", () => {
  let r = evaluate([ready(1, { impact: "XL", impactState: "current" })], "implementer");
  assert.equal(r.filter((x) => x.action === "estimate-complexity").length, 1);
  assert.equal(r[0].rule, "D-COMPLEXITY-BOOST");
});
test("narration is selected from the fired rule, with actual bindings", () => {
  let r = evaluate(
    [
      ready(1, {
        impact: "L",
        complexity: "S",
        impactState: "current",
        complexityState: "current",
        benefit: "Makes the core queue reliable.",
      }),
    ],
    "implementer",
  )[0];
  assert.match(r.why, /impact L, complexity S/);
  assert.match(r.why, /core queue reliable/);
  assert.equal(r.bindings.impact, "L");
});
test("multiple allowed platforms retain the matching alternative", () => {
  const s = ready(1, {
    platforms: ["other", "codex"],
    impact: "L",
    complexity: "S",
    impactState: "current",
    complexityState: "current",
  });
  assert(evaluate([s], "implementer", "", "codex").some((r) => r.rule === "D-EASY"));
  assert(!evaluate([s], "implementer", "", "unknown").some((r) => r.action === "implement"));
});
test("an unknown assessment never produces a known easy win", () => {
  assert(
    !evaluate(
      [
        ready(1, {
          impact: "L",
          complexity: "S",
          impactState: "unknown",
          complexityState: "current",
        }),
      ],
      "implementer",
    ).some((r) => r.rule === "D-EASY"),
  );
});
const subjects = new Map(baseline.subjects.map((s) => [s.url, s]));
function matchedProvenance(issue: RawIssue, reading: Reading | undefined) {
  if (!reading?.provenance) return "";
  const c = issue.comments.nodes.find((c) => c.url === reading.provenance);
  if (!c) return "";
  const m = c.body.match(/<!-- github-triage:impact-estimate v1 (\{.*?\}) -->/s);
  if (!m) return "";
  try {
    const p = JSON.parse(m[1]) as { rationale?: unknown };
    return typeof p.rationale === "string" ? p.rationale : "";
  } catch {
    return "";
  }
}
const real = snapshot.issues.map((s): Subject => {
  const f = subjects.get(s.url)?.assessments;
  const closed = s.closedByPullRequestsReferences;
  return {
    number: s.number,
    title: s.title,
    url: s.url,
    created: Date.parse(s.createdAt),
    state: s.state,
    labels: s.labels.nodes.map((x) => x.name),
    labelsComplete: !s.labels.pageInfo.hasNextPage,
    nativeComplete:
      !!s.blockedBy &&
      !s.blockedBy.pageInfo.hasNextPage &&
      s.blockedBy.nodes.length === s.issueDependenciesSummary.totalBlockedBy,
    closingComplete: !!closed && !closed.pageInfo.hasNextPage,
    owners: s.labels.nodes.filter((l) => l.name.startsWith("agent:")).map((l) => l.name.slice(6)),
    platforms: s.labels.nodes
      .filter((l) => l.name.startsWith("platform:"))
      .map((l) => l.name.slice(9)),
    attention: s.labels.nodes
      .filter((l) => l.name.startsWith("attention:"))
      .map((l) => l.name.slice(10)),
    blockers: s.blockedBy.nodes.map((b) => b.state),
    openPrs: closed?.nodes.filter((p) => p.state === "OPEN").map((p) => p.url) || [],
    impact: f?.impact.size,
    complexity: f?.complexity.size,
    impactState: f?.impact.state || "unknown",
    complexityState: f?.complexity.state || "unknown",
    benefit: matchedProvenance(s, f?.impact),
  };
});
const result = {
  schemaVersion: 1,
  kind: "bounded-datalog-explanation-trial",
  source: "67ed2ed",
  snapshotAt: snapshot.fetchedAt,
  scope:
    "Research subset; NOT the complete #303/#304 evaluator. No urgency/unlock tie policy, own-claim continuation, full review/responsibility coverage, config or MCP integration. Missing paired assessment inputs remain unknown.",
  tests,
  roles: { designer: evaluate(real, "designer"), implementer: evaluate(real, "implementer") },
  baselineActions: baseline.rankedActions.items,
};
fs.writeFileSync(values.out, JSON.stringify(result, null, 2));
console.log(`${tests.length}/${tests.length} synthetic scenarios passed with DataScript 1.8.1.`);
console.log(`Frozen snapshot ${snapshot.fetchedAt}, ${real.length} open tickets.`);
for (const role of ["designer", "implementer"] as const) {
  console.log("\n" + role.toUpperCase());
  for (const r of result.roles[role].slice(0, 6))
    console.log(`#${r.number} ${r.action} [${r.rule}]\n  ${r.shortWhy}`);
}
