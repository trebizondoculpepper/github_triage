/** Bundled experiment policy: clauses, decision metadata, explanations and schema are one artifact. */
export const policyVersion = 1;
export const schema = Object.fromEntries(
  [
    "label",
    "owner",
    "platform",
    "attention",
    "blocker",
    "dependent",
    "closes",
    "closing",
    "check",
    "review",
    "thread",
    "matched",
    "overridden",
    "unlocks-dependent",
    "permit",
    "deny",
    "unknown",
    "unlock-unknown",
  ].map((k) => [k, { ":db/cardinality": ":db.cardinality/many" }]),
);
export interface RuleDefinition {
  id: string;
  kind: string;
  band: number;
  preference: number;
  clauses: string;
  why: string;
  codes: string[];
}
const rule = (
  id: string,
  kind: string,
  band: number,
  preference: number,
  clauses: string,
  why: string,
  codes: string[],
): RuleDefinition => ({ id, kind, band, preference, clauses, why, codes });
export const definitions: RuleDefinition[] = [
  rule(
    "D-ATTENTION",
    "addressed-response",
    1,
    0,
    "(addressed ?t)",
    "Explicitly addressed to you; respond before clearing attention.",
    ["addressed"],
  ),
  rule(
    "D-PR-FAIL",
    "pr-follow-up",
    2,
    0,
    "(pr-action ?t) (pr-failure ?t)",
    "PR checks failed at head {head}; inspect and repair before merge.",
    ["pr-follow-up", "pr-failed-checks"],
  ),
  rule(
    "D-PR-REVIEW",
    "pr-follow-up",
    2,
    0,
    "(pr-action ?t) (pr-review ?t)",
    "PR has unresolved review findings at head {head}.",
    ["pr-follow-up", "pr-review-findings"],
  ),
  rule(
    "D-PR-CONFLICT",
    "pr-follow-up",
    2,
    1,
    '(pr-action ?t) [?t "mergeable" "CONFLICTING"]',
    "PR has merge conflicts at head {head}.",
    ["pr-follow-up", "pr-conflicts"],
  ),
  rule(
    "D-PR-MERGE",
    "pr-follow-up",
    2,
    2,
    "(pr-action ?t) (clean-pr ?t)",
    "Current verify passes at head {head}; inspect the diff and review evidence, then consider merge.",
    ["pr-follow-up", "pr-inspect-merge"],
  ),
  rule(
    "D-DECIDE",
    "decide",
    3,
    0,
    '[1 "role" "designer"] [?t "label" "design:decision-needed"]',
    "Resolve the recorded design decision before implementation proceeds.",
    ["designer-duty"],
  ),
  rule(
    "D-DOCUMENT",
    "document",
    3,
    1,
    '[1 "role" "designer"] [?t "label" "design:documentation-needed"]',
    "An agreed decision needs documentation before implementation.",
    ["designer-duty"],
  ),
  rule(
    "D-DESIGN-REVIEW",
    "design-review",
    3,
    2,
    '[1 "role" "designer"] (design-pr ?t) (not (own-follow-up ?t))',
    "Review the design/documentation PR at head {head}.",
    ["designer-duty"],
  ),
  rule(
    "D-EASY",
    "implement",
    4,
    0,
    '[1 "role" "implementer"] (eligible ?t) (easy ?t) [1 "order" "impact"]',
    "Known easy win: impact {impact}, complexity {complexity}.",
    ["easy-win"],
  ),
  rule(
    "D-OWN-EASY",
    "continue-implementation",
    4,
    0,
    '[1 "role" "implementer"] (own-issue ?t) (easy ?t)',
    "Continue your known easy win: impact {impact}, complexity {complexity}.",
    ["easy-win", "own-claim"],
  ),
  rule(
    "D-COMPLEXITY-BOOST",
    "estimate-complexity",
    5,
    0,
    '[1 "role" "implementer"] (issue ?t) (needs-complexity ?t) (large-impact ?t)',
    "High impact {impact}, but effort is {complexityState}; estimate it to test implementation value.",
    ["assessment", "cross-role-boost"],
  ),
  rule(
    "D-COMPLEXITY",
    "estimate-complexity",
    5,
    1,
    '[1 "role" "implementer"] (issue ?t) (needs-complexity ?t)',
    "Effort is {complexityState}; sizing improves the evidence for choosing work.",
    ["assessment"],
  ),
  rule(
    "D-IMPACT-BOOST",
    "assess-impact",
    5,
    0,
    '[1 "role" "designer"] (issue ?t) (needs-impact ?t) (small-complexity ?t)',
    "Complexity {complexity} is small, but benefit is {impactState}; assess impact to test for an easy win.",
    ["assessment", "cross-role-boost"],
  ),
  rule(
    "D-IMPACT",
    "assess-impact",
    5,
    1,
    '[1 "role" "designer"] (issue ?t) (needs-impact ?t)',
    "Benefit is {impactState}; assess it before comparing implementation value.",
    ["assessment"],
  ),
  rule(
    "D-BAD-COMPLEXITY",
    "inspect-assessment",
    5,
    1,
    '[1 "role" "implementer"] (issue ?t) (bad-complexity ?t)',
    "Complexity evidence is {complexityState}; inspect and correct the labels or provenance.",
    ["assessment", "inspection"],
  ),
  rule(
    "D-BAD-IMPACT",
    "inspect-assessment",
    5,
    1,
    '[1 "role" "designer"] (issue ?t) (bad-impact ?t)',
    "Impact evidence is {impactState}; inspect and correct the labels or provenance.",
    ["assessment", "inspection"],
  ),
  rule(
    "D-ORDINARY",
    "implement",
    6,
    0,
    '[1 "role" "implementer"] (eligible ?t)',
    "Eligible implementation: impact {impact} ({impactState}), complexity {complexity} ({complexityState}).",
    ["ordinary"],
  ),
  rule(
    "D-OWN",
    "continue-implementation",
    6,
    0,
    '[1 "role" "implementer"] (own-issue ?t)',
    "Continue your active claim; impact {impact}, complexity {complexity}.",
    ["ordinary", "own-claim"],
  ),
  rule(
    "D-DESIGN",
    "design",
    6,
    0,
    '[1 "role" "designer"] (design-eligible ?t)',
    "A design contract is missing. Impact {impact}, complexity {complexity}.",
    ["ordinary"],
  ),
  rule(
    "D-UNFAVORABLE",
    "implement",
    7,
    0,
    '[1 "role" "implementer"] (eligible ?t) (unfavorable ?t) [1 "order" "impact"]',
    "High effort for limited benefit: impact {impact}, complexity {complexity}; reconsider or split.",
    ["unfavorable"],
  ),
  rule(
    "D-OWN-UNFAVORABLE",
    "continue-implementation",
    7,
    0,
    '[1 "role" "implementer"] (own-issue ?t) (unfavorable ?t)',
    "Your active work has impact {impact} and complexity {complexity}; reconsider or split before continuing.",
    ["unfavorable", "own-claim"],
  ),
  rule(
    "D-INSPECT",
    "inspect",
    6,
    0,
    "(issue ?t) (possible ?t) (uncertain ?t)",
    "Eligibility is unproven: inspect incomplete evidence or state the required platform.",
    ["ordinary", "inspection"],
  ),
];
/** Inference over raw facts. Absence is usable only after the corresponding complete relation. */
export const clauses = `[
[(issue ?t) [?t "kind" "issue"]]
[(pr ?t) [?t "kind" "pr"]]
[(open ?t) [?t "state" "OPEN"]]
[(claimed ?t) [?t "owner" ?a]]
[(mine ?t) [1 "agent" ?a] [?t "owner" ?a]]
[(mine-linked ?t) (mine ?t)]
[(mine-linked ?t) [?t "closes" ?i] (mine ?i)]
[(addressed ?t) [1 "agent" ?a] [?t "attention" ?a]]
[(parked ?t) [?t "label" "status:parked"]]
[(foreground ?t) (open ?t) (not (parked ?t))]
[(foreground ?t) (open ?t) (addressed ?t)]
[(own-issue ?t) (issue ?t) (mine ?t)]
[(platform-ok ?t) [?t "labels-complete" true] (not [?t "platform" _])]
[(platform-ok ?t) [1 "platform" ?p] [?t "platform" ?p]]
[(platform-unknown ?t) [?t "platform" _] [1 "platform" ""]]
[(available ?t) [?t "label" "status:ready"]]
[(available ?t) [?t "label" "status:incomplete"]]
[(prerequisite ?t) [?t "label" ?l] [1 "prerequisite" ?l]]
[(has-closing ?t) [?t "closing" ?p]]
[(has-closing ?t) [?p "closes" ?t] (open ?p)]
[(closing-complete ?t) [?t "reverse-complete" true]]
[(closing-complete ?t) [?t "kind" _] [1 "forward-complete" true]]
[(otherwise ?t) (issue ?t) (open ?t) (available ?t) [?t "labels-complete" true] (platform-ok ?t) (closing-complete ?t) (not (claimed ?t)) (not (has-closing ?t)) (not (prerequisite ?t))]
[(blocked ?t) [?t "open-blockers" ?n] [(> ?n 0)]]
[(blocked ?t) [?t "blocker" ?i] [?i "state" "OPEN"]]
[(implementation-permit ?t) (issue ?t) (open ?t) (available ?t)]
[(implementation-deny ?t ?r) (issue ?t) (claimed ?t) [(str "D-DENY-CLAIM") ?r]]
[(implementation-deny ?t ?r) (issue ?t) (prerequisite ?t) [(str "D-DENY-PREREQUISITE") ?r]]
[(implementation-deny ?t ?r) (issue ?t) (has-closing ?t) [(str "D-DENY-OPEN-PR") ?r]]
[(implementation-deny ?t ?r) (issue ?t) (blocked ?t) [(str "D-DENY-BLOCKER") ?r]]
[(implementation-deny ?t ?r) (issue ?t) [?t "labels-complete" false] [(str "D-DENY-LABELS-UNKNOWN") ?r]]
[(implementation-deny ?t ?r) (issue ?t) [?t "native-complete" false] [(str "D-DENY-NATIVE-UNKNOWN") ?r]]
[(implementation-deny ?t ?r) (issue ?t) (not (closing-complete ?t)) [(str "D-DENY-CLOSING-UNKNOWN") ?r]]
[(implementation-deny ?t ?r) (issue ?t) (not (platform-ok ?t)) [(str "D-DENY-PLATFORM") ?r]]
[(implementation-denied ?t) (implementation-deny ?t ?r)]
[(eligible ?t) (implementation-permit ?t) (not (implementation-denied ?t))]
[(design-eligible ?t) (issue ?t) (open ?t) [?t "label" "status:needs-design"] [?t "labels-complete" true] (platform-ok ?t) (closing-complete ?t) (not (claimed ?t)) (not (has-closing ?t)) (not [?t "label" "design:decision-needed"])]
[(possible ?t) (available ?t) (not (claimed ?t)) (not (prerequisite ?t)) (not (blocked ?t)) (not (has-closing ?t))]
[(possible ?t) [1 "role" "designer"] [?t "label" "status:needs-design"] (not (claimed ?t)) (not (has-closing ?t))]
[(uncertain ?t) [?t "labels-complete" false]]
[(uncertain ?t) [?t "native-complete" false]]
[(uncertain ?t) [?t "kind" _] (not (closing-complete ?t))]
[(uncertain ?t) (platform-unknown ?t)]
[(large-impact ?t) [?t "impact-state" "current"] [?t "impact-size" ?s] [1 "large" ?s]]
[(small-complexity ?t) [?t "complexity-state" "current"] [?t "complexity-size" ?s] [1 "small" ?s]]
[(easy ?t) (large-impact ?t) (small-complexity ?t)]
[(unfavorable ?t) [?t "impact-state" "current"] [?t "impact-size" ?i] [1 "small" ?i] [?t "complexity-state" "current"] [?t "complexity-size" ?c] [1 "large" ?c]]
[(needs-complexity ?t) [?t "complexity-state" ?s] [1 "needs-assessment" ?s]]
[(needs-impact ?t) [?t "impact-state" ?s] [1 "needs-assessment" ?s]]
[(bad-complexity ?t) [?t "complexity-state" ?s] [1 "bad-assessment" ?s]]
[(bad-impact ?t) [?t "impact-state" ?s] [1 "bad-assessment" ?s]]
[(design-pr ?t) (pr ?t) [?t "label" ?l] [1 "design-label" ?l]]
[(design-pr ?t) (pr ?t) [?t "closes" ?i] [?i "label" ?l] [1 "design-label" ?l]]
[(pr-failure ?t) [?t "check" ?c] [?c "outcome" ?o] [1 "failure" ?o]]
[(pr-pending ?t) [?t "check" ?c] [?c "outcome" ?o] [1 "pending" ?o]]
[(pr-unknown ?t) [?t "check" ?c] [?c "outcome" ?o] (not [1 "known-check" ?o])]
[(pr-review ?t) [?t "review-decision" "CHANGES_REQUESTED"]]
[(pr-review ?t) [?t "thread" ?c] [?c "resolved" false]]
[(verified ?t) [?t "check" ?c] [?c "name" "verify"] [?c "outcome" "SUCCESS"]]
[(clean-pr ?t) (pr ?t) [?t "pr-complete" true] [?t "draft" false] [?t "mergeable" "MERGEABLE"] [?t "merge-state" ?m] [1 "merge-state" ?m] (verified ?t) (not (pr-failure ?t)) (not (pr-pending ?t)) (not (pr-unknown ?t)) (not (pr-review ?t))]
[(follow-up ?t) (pr-failure ?t)]
[(follow-up ?t) (pr-review ?t)]
[(follow-up ?t) (pr ?t) [?t "mergeable" "CONFLICTING"]]
[(follow-up ?t) (clean-pr ?t)]
[(own-follow-up ?t) (mine-linked ?t) (follow-up ?t)]
[(pr-action ?t) (pr ?t) [1 "role" "implementer"]]
[(pr-action ?t) (pr ?t) [1 "role" "designer"] (design-pr ?t) (mine-linked ?t)]
]`;
export const constants: Record<string, (string | number | boolean)[]> = {
  small: ["XS", "S"],
  large: ["L", "XL", "XXL"],
  "needs-assessment": ["unassessed", "stale"],
  "bad-assessment": ["invalid", "conflict"],
  prerequisite: [
    "status:needs-design",
    "question",
    "design:decision-needed",
    "status:blocked",
    "status:parked",
  ],
  "design-label": ["documentation", "status:needs-design"],
  failure: [
    "FAILURE",
    "ERROR",
    "TIMED_OUT",
    "CANCELLED",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
    "STALE",
  ],
  pending: ["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"],
  "known-check": [
    "SUCCESS",
    "NEUTRAL",
    "SKIPPED",
    "FAILURE",
    "ERROR",
    "TIMED_OUT",
    "CANCELLED",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
    "STALE",
    "PENDING",
    "QUEUED",
    "IN_PROGRESS",
    "WAITING",
    "REQUESTED",
    "EXPECTED",
  ],
  "merge-state": ["CLEAN", "HAS_HOOKS", "UNSTABLE"],
};
// Every sort column is inferred by these queries; the host only executes this descriptor.
export const comparison = [
  "band",
  "group",
  "primary",
  "urgency",
  "unlocks",
  "own",
  "incomplete",
  "created",
  "number",
  "target",
  "kind",
] as const;

export const sortClauses = `[
[(selected ?t ?r) [?t "matched" ?r] (not [?t "overridden" ?r])]
[(age ?t ?r ?created) [?r "kind" "implement"] [1 "order" "oldest"] [?t "created" ?created]]
[(age ?t ?r ?created) [?r "kind" "implement"] [1 "order" "newest"] [?t "created" ?c] [(- 0 ?c) ?created]]
[(keys ?t ?r ?b ?g ?p ?u ?un ?own ?inc ?created) (selected ?t ?r) [?r "band" ?b] [(<= ?b 3)] (fixed-key ?t ?r ?b ?g ?p) [(+ 0 0) ?u] [(+ 0 0) ?un] [(+ 0 0) ?own] [(+ 0 0) ?inc] [?t "number" ?created]]
[(fixed-key ?t ?r ?b ?g ?p) [?t "kind" _] [?r "band" ?b] [(= ?b 1)] [(+ 0 0) ?g] [(+ 0 0) ?p]]
[(fixed-key ?t ?r ?b ?g ?p) [?t "linked-key" ?g] [?r "band" ?b] [(= ?b 2)] [?r "preference" ?p]]
[(fixed-key ?t ?r ?b ?g ?p) [?r "band" ?b] [(= ?b 3)] [?r "preference" ?g] [?t "active-count" ?n] [(- 0 ?n) ?p]]
[(keys ?t ?r ?b ?g ?p ?u ?un ?own ?inc ?created) (selected ?t ?r) [?r "band" ?b] [(> ?b 3)] (age ?t ?r ?created) [(+ 0 1) ?g] [(+ 0 0) ?p] [(+ 0 0) ?u] [(+ 0 0) ?un] [(+ 0 0) ?own] [(+ 0 0) ?inc]]
[(keys ?t ?r ?b ?g ?p ?u ?un ?own ?inc ?created) (selected ?t ?r) [?r "band" ?b] [(> ?b 3)] (not (age ?t ?r _)) [(+ 0 0) ?g] [?r "preference" ?p] [?t "urgency-key" ?u] [?t "own-key" ?own] [?t "incomplete-key" ?inc] [?t "created" ?created] [?r "kind" ?k] (or-join [?t ?k ?un] (and [1 "assessment-kind" ?k] [(+ 0 0) ?un]) (and (not [1 "assessment-kind" ?k]) [?t "unlock-count" ?n] [(- 0 ?n) ?un]))]
]`;

export const keyQueries: [string, string][] = [
  [
    "own-key",
    '[:find ?t ?k :in $ % :where [?t "kind" _] (or-join [?t ?k] (and (mine ?t) [(- 0 1) ?k]) (and (not (mine ?t)) [(+ 0 0) ?k]))]',
  ],
  [
    "linked-key",
    '[:find ?t ?k :in $ % :where [?t "kind" _] (or-join [?t ?k] (and (mine-linked ?t) [(- 0 1) ?k]) (and (not (mine-linked ?t)) [(+ 0 0) ?k]))]',
  ],
  [
    "incomplete-key",
    '[:find ?t ?k :where [?t "kind" _] (or-join [?t ?k] (and [?t "label" "status:incomplete"] [(- 0 1) ?k]) (and (not [?t "label" "status:incomplete"]) [(+ 0 0) ?k]))]',
  ],
  [
    "urgency-key",
    '[:find ?t ?k :where [?t "kind" _] (or-join [?t ?k] (and [?t "label" "urgency:high"] (not [?t "label" "urgency:low"]) [(+ 0 0) ?k]) (and [?t "label" "urgency:low"] (not [?t "label" "urgency:high"]) [(+ 1 1) ?k]) (and (not [?t "label" "urgency:high"]) (not [?t "label" "urgency:low"]) [(+ 0 1) ?k]) (and [?t "label" "urgency:high"] [?t "label" "urgency:low"] [(+ 0 1) ?k]))]',
  ],
];

export const queries = {
  q0: '[:find ?t ?r :where [?t "matched" ?r] [?t "matched" ?o] [?r "kind" ?k] [?o "kind" ?k] [?r "rule" ?rid] [?o "rule" ?oid] (or-join [?rid ?oid ?r ?o] (and [?r "band" ?b] [?o "band" ?b] [?r "preference" ?p] [?o "preference" ?p] [(< ?o ?r)]) (and [?r "band" ?b] [?o "band" ?b] [?r "preference" ?p] [?o "preference" ?op] [(< ?op ?p)]) (and [(= ?rid "D-ORDINARY")] [(= ?oid "D-EASY")]) (and [(= ?rid "D-ORDINARY")] [(= ?oid "D-UNFAVORABLE")]) (and [(= ?rid "D-OWN")] [(= ?oid "D-OWN-EASY")]) (and [(= ?rid "D-OWN")] [(= ?oid "D-OWN-UNFAVORABLE")]))]',
  q1: '[:find ?t ?d :in $ % :where [?t "dependent" ?d] (otherwise ?d) [?d "native-complete" true] [?d "open-blockers" 1] [?d "blocker" ?t] (open ?t)]',
  q2: '[:find ?t (count-distinct ?d) :where [?t "unlocks-dependent" ?d]]',
  q3: '[:find ?t :where [?t "kind" _] (not [?t "unlock-count" _])]',
  q4: '[:find ?t ?r ?b ?g ?p ?u ?un ?own ?inc ?created ?n ?target ?kind :in $ % :where (keys ?t ?r ?b ?g ?p ?u ?un ?own ?inc ?created) [?t "number" ?n] [?t "target" ?target] [?r "kind" ?kind]]',
  q5: '[:find ?id :in $ ?t :where [?t "overridden" ?r] [?r "rule" ?id]]',
  q6: '[:find ?n :in $ ?t :where [?t "unlock-count" ?n]]',
  q7: '[:find ?reason :in $ ?t :where [?t "unlock-unknown" ?reason]]',
} as const;

export const unknownUnlocks = `[:find ?t ?reason :in $ % :where [?t "kind" "issue"] (or-join [?t ?reason] (and [?t "blocking-complete" false] [(str "direct dependent coverage incomplete") ?reason]) (and [?t "dependent" ?d] [?d "state" "OPEN"] (not [?d "kind" "issue"]) [(str "dependent absent from collected repository") ?reason]) (and [?t "dependent" ?d] [?d "state" "OPEN"] [?d "native-complete" false] [(str "dependent native evidence incomplete") ?reason]) (and [?t "dependent" ?d] [?d "state" "OPEN"] (uncertain ?d) [(str "dependent eligibility evidence incomplete") ?reason]))]`;

export const activeDependents = `[:find ?t ?d :in $ % :where [?t "dependent" ?d] (open ?d) (or-join [?d] (claimed ?d) (has-closing ?d))]`;

export const denialsQuery =
  "[:find ?t ?r :in $ % :where (implementation-permit ?t) (implementation-deny ?t ?r)]";

export const commandTemplates: Record<string, string> = {
  detail: "github-triage --repo {repo} --issue {number} --json",
  pr: "github-triage pr {number} --repo {repo}",
  claim: "github-triage claim {number} --repo {repo} --agent {agent}{platformFlag}",
  release:
    "github-triage release {other} --repo {repo} --agent {agent} --as incomplete --note TEXT",
  complexity:
    "github-triage estimate {number} --metric complexity --size SIZE --rationale TEXT --repo {repo}",
  impact:
    "github-triage estimate {number} --metric impact --size SIZE --rationale TEXT --repo {repo}",
};
export const commandKinds: Record<string, string> = {
  "estimate-complexity": "complexity",
  "assess-impact": "impact",
  "pr-follow-up": "pr",
  "design-review": "pr",
  "addressed-response": "detail",
  decide: "detail",
  document: "detail",
  "continue-implementation": "detail",
  design: "detail",
  inspect: "detail",
  "inspect-assessment": "detail",
};
export const otherClaimsQuery =
  '[:find ?t ?other :in $ % :where [?t "kind" "issue"] (own-issue ?other) [(not= ?t ?other)]]';
