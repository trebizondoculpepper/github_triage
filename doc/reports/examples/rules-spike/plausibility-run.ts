/**
 * Rules plausibility runner (#154). Credential-free; no dependencies beyond tsx.
 * Run from the repository root: npx tsx doc/reports/examples/rules-spike/plausibility-run.ts
 * Prints per-scenario outcomes, a few readable plans for human review and the baseline finding,
 * and exits non-zero if any scenario fails.
 */
import {
  PLAUSIBILITY_RULES,
  SCENARIOS,
  baselineFinding,
  checkPlausibilityRules,
  runScenarios,
} from "./plausibility.js";

const outcomes = runScenarios();
for (const o of outcomes)
  console.log(
    `${o.pass ? "PASS" : "FAIL"} ${o.id} ${o.name}${o.pass ? "" : `\n  ${o.failures.join("\n  ")}`}`,
  );
console.log(
  `\n${outcomes.filter((o) => o.pass).length}/${outcomes.length} scenarios pass; ${PLAUSIBILITY_RULES.length} rules.\n`,
);

for (const id of ["S1", "S3", "S4", "S11"]) {
  const o = outcomes.find((x) => x.id === id);
  const s = SCENARIOS.find((x) => x.id === id);
  if (!o || !s) continue;
  console.log(`--- ${id} ${o.name}`);
  if (s.rules)
    for (const d of checkPlausibilityRules(s.rules))
      console.log(`  static diagnostic: ${d.kind} ${d.rules.join("/")}`);
  for (const t of s.tickets) console.log(`  facts #${t.number}: ${JSON.stringify(t)}`);
  console.log("  offered, in order:");
  for (const d of o.result.plan)
    console.log(
      `    ${d.ticket}:${d.action}${d.alsoActions.length ? ` (also ${d.alsoActions.join(",")})` : ""} ${d.modality} because ${d.because.join(",")} [${d.facts.join(",")}]${d.overrides.length ? ` overrides ${d.overrides.join(",")}` : ""}`,
    );
  const offered = new Set(
    o.result.plan.flatMap((d) => [d.action, ...d.alsoActions].map((a) => `${d.ticket}:${a}`)),
  );
  console.log("  not offered:");
  for (const d of o.result.decisions.filter((d) => !offered.has(`${d.ticket}:${d.action}`)))
    console.log(
      `    ${d.ticket}:${d.action} ${d.modality} because ${d.because.join(",")} [${d.facts.join(",")}]${d.overrides.length ? ` overrides ${d.overrides.join(",")}` : ""}`,
    );
}
console.log("\nBaseline spike rules (with R2):", JSON.stringify(baselineFinding()));
if (outcomes.some((o) => !o.pass)) process.exitCode = 1;
