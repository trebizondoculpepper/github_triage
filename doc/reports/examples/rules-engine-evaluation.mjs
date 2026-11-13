import ds from "datascript";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
const query = `[:find ?t :where [?t "open" true] [?t "complete" true]
  (or [?t "status" "ready"] [?t "status" "incomplete"])
  (not [?t "blocked" true]) (not [?t "claimed" true])
  (not [?t "restricted" true])]`;
const datoms = [
  [1, "open", true],
  [1, "complete", true],
  [1, "status", "ready"],
  [2, "open", true],
  [2, "complete", true],
  [2, "status", "ready"],
  [2, "blocked", true],
  [3, "open", true],
  [3, "complete", true],
  [3, "status", "incomplete"],
  [4, "open", true],
  [4, "status", "ready"],
  [5, "open", true],
  [5, "complete", true],
  [5, "status", "ready"],
  [5, "claimed", true],
  [6, "open", true],
  [6, "complete", true],
  [6, "status", "ready"],
  [6, "restricted", true],
];
assert.deepEqual(ds.q(query, ds.init_db(datoms)).flat().sort(), [1, 3]);
const rules = `[[(ready ?t) [?t "open" true] [?t "complete" true]
  (or [?t "status" "ready"] [?t "status" "incomplete"])
  (not [?t "blocked" true]) (not [?t "claimed" true]) (not [?t "restricted" true])]]`;
assert.deepEqual(
  ds.q("[:find ?t :in $ % :where (ready ?t)]", ds.init_db(datoms), rules).flat().sort(),
  [1, 3],
);
let unsafeNegation;
try {
  ds.q('[:find ?x :where (not [?x "blocked" true])]', ds.init_db(datoms));
} catch (e) {
  unsafeNegation = String(e.message);
  assert.ok(unsafeNegation.length);
}
const n = 500,
  facts = [];
for (let i = 1; i <= n; i++) {
  facts.push(
    [i, "open", true],
    [i, "complete", true],
    [i, "status", i % 2 ? "ready" : "incomplete"],
  );
  if (i % 3 === 0) facts.push([i, "blocked", true]);
  if (i % 5 === 0) facts.push([i, "claimed", true]);
}
const buildStart = performance.now();
const db = ds.init_db(facts);
const buildMs = performance.now() - buildStart;
for (let i = 0; i < 10; i++) ds.q(query, db);
const times = [];
for (let i = 0; i < 100; i++) {
  const t = performance.now();
  ds.q(query, db);
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      fixture: { tickets: n, facts: facts.length, eligible: ds.q(query, db).length },
      buildMs,
      queryMedianMs: times[50],
      queryP95Ms: times[95],
      unsafeNegation,
      smoke: "6 cases plus reusable rule passed",
    },
    null,
    2,
  ),
);
