/**
 * Rules spike (#74) harness. Run from the repository root after
 *   npm install --ignore-scripts --no-save datascript@1.8.1
 * with: node doc/reports/examples/rules-spike/run.mjs
 * Asserts both evaluators agree on every scenario, prints the compiled English and
 * the conflict diagnostics, then measures both evaluators on synthetic data.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import ds from "datascript";
import { RULES, englishGuide, checkRules, evaluateJs, evaluateDataScript } from "./rules.mjs";

const t = (number, o = {}) => ({
  number,
  createdAt: `2026-11-${String(10 + (number % 9)).padStart(2, "0")}T00:00:00Z`,
  labels: ["status:ready"],
  owners: [],
  openBlockers: 0,
  labelsComplete: true,
  openPrs: [],
  platforms: [],
  attention: [],
  unblocks: 0,
  ...o,
});
const me = { name: "ana", platform: "macos" };

/** The dozen decision scenarios: [name, tickets, agent, expected { pickup, must, mustNot, inspect }]. */
/** @type {[string, any[], { name: string, platform: string | null }, Record<string, any>][]} */
const scenarios = [
  ["plain ready ticket is eligible", [t(1)], me, { pickup: [1] }],
  [
    "incomplete evidence is not eligible, inspect instead",
    [t(2, { openBlockers: null })],
    me,
    { pickup: [], inspect: ["2:refresh_evidence"] },
  ],
  [
    "partial labels are not eligible",
    [t(3, { labelsComplete: false })],
    me,
    { pickup: [], inspect: ["3:refresh_evidence"] },
  ],
  [
    "explicit attention must be answered",
    [t(4, { labels: ["question"], attention: ["ana"] })],
    me,
    { pickup: [], must: ["4:respond"], mustNot: ["4:implement", "4:pick_up"] },
  ],
  [
    "own open PR is follow-up, not pickup",
    [t(5, { owners: ["ana"], openPrs: [50] })],
    me,
    { pickup: [], must: ["5:follow_up"], mustNot: ["5:pick_up"] },
  ],
  [
    "another agent's claim is never taken",
    [t(6, { owners: ["bo"] })],
    me,
    { pickup: [], mustNot: ["6:pick_up"] },
  ],
  [
    "incomplete work comes before unstarted",
    [t(7), t(8, { labels: ["status:incomplete"] })],
    me,
    { pickup: [8, 7] },
  ],
  [
    "platform restriction excludes other platforms",
    [t(9, { platforms: ["windows"] })],
    me,
    { pickup: [], mustNot: ["9:pick_up"] },
  ],
  [
    "unknown platform needs confirming",
    [t(10, { platforms: ["windows"] })],
    { name: "ana", platform: null },
    { pickup: [], inspect: ["10:confirm_platform"] },
  ],
  [
    "native blocker forbids pickup despite ready label",
    [t(11, { openBlockers: 1 })],
    me,
    { pickup: [], mustNot: ["11:pick_up"] },
  ],
  [
    "impact first, then age",
    [t(12), t(13, { unblocks: 2 }), t(14, { createdAt: "2026-11-01T00:00:00Z" })],
    me,
    { pickup: [13, 14, 12] },
  ],
  [
    "design question forbids implementing and pickup",
    [t(15, { labels: ["status:ready", "design:decision-needed"] })],
    me,
    { pickup: [], mustNot: ["15:implement", "15:pick_up"] },
  ],
];

const project = (r, modality) =>
  r.decisions
    .filter((d) => d.modality === modality)
    .map((d) => `${d.ticket}:${d.action}`)
    .sort();
for (const [name, tickets, agent, want] of scenarios) {
  const js = evaluateJs(tickets, agent);
  const dl = evaluateDataScript(ds, tickets, agent);
  const norm = (r) => ({
    pickup: r.pickupOrder,
    must: project(r, "must"),
    mustNot: project(r, "must_not"),
    inspect: project(r, "inspect"),
  });
  assert.deepEqual(norm(dl), norm(js), `evaluators disagree: ${name}`);
  for (const k of Object.keys(want))
    assert.deepEqual(
      norm(js)[k],
      k === "pickup" ? want[k] : [...want[k]].sort((a, b) => String(a).localeCompare(String(b))),
      `${name}: ${k}`,
    );
}
console.log(`${scenarios.length} scenarios: JS and DataScript agree and match expectations.\n`);

// Overrides are explained, not hidden: R9 (may) is overridden by R5 (must_not).
const blocked = evaluateJs(
  [t(11, { openBlockers: 1, labels: ["status:ready"] })],
  me,
).decisions.find((d) => d.action === "pick_up");
assert.deepEqual(
  [blocked.modality, blocked.because, blocked.overrides],
  ["must_not", ["R5"], ["R9"]],
);
const claimedReady = evaluateJs([t(6, { owners: ["bo"] })], me).decisions[0];
console.log("Explanation example:", JSON.stringify(claimedReady), "\n");

console.log(englishGuide(), "\n");

assert.deepEqual(checkRules(), []);
const conflicting = [
  ...RULES,
  {
    id: "X1",
    modality: "may",
    action: "pick_up",
    when: [{ fact: "blocked" }],
    reason: "Contradicts R5.",
  },
  {
    id: "X2",
    modality: "must",
    action: "respond",
    when: [{ fact: "mine" }, { fact: "mine", not: true }],
    reason: "Never applies.",
  },
  {
    id: "X3",
    modality: "may",
    action: "pick_up",
    when: [{ fact: "typo" }],
    reason: "Unknown fact.",
  },
];
console.log(
  "Diagnostics for deliberately conflicting rules:",
  JSON.stringify(checkRules(conflicting), null, 1),
  "\n",
);
assert.deepEqual(
  checkRules(conflicting)
    .map((d) => d.kind)
    .sort(),
  ["contradiction", "never-applies", "unknown-fact"],
);

// Measurements on synthetic data.
const many = Array.from({ length: 500 }, (_, i) =>
  t(i + 1, {
    owners: i % 5 === 0 ? ["bo"] : [],
    openBlockers: i % 7 === 0 ? 1 : 0,
    labels: [i % 3 ? "status:ready" : "status:incomplete"],
    unblocks: i % 4,
  }),
);
const time = (f, n = 50) => {
  for (let i = 0; i < 5; i++) f();
  const xs = [];
  for (let i = 0; i < n; i++) {
    const s = performance.now();
    f();
    xs.push(performance.now() - s);
  }
  xs.sort((a, b) => a - b);
  return `median ${xs[n >> 1].toFixed(2)} ms, p95 ${xs[Math.floor(n * 0.95)].toFixed(2)} ms`;
};
assert.deepEqual(evaluateDataScript(ds, many, me).pickupOrder, evaluateJs(many, me).pickupOrder);
console.log(
  `500 tickets, ${RULES.length} rules (Node ${process.versions.node}, ${process.platform}/${process.arch}):`,
);
console.log(`  registered JS: ${time(() => evaluateJs(many, me))}`);
console.log(`  DataScript:    ${time(() => evaluateDataScript(ds, many, me))}`);
