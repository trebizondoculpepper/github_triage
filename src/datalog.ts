/** Read-only opt-in evaluator. No legacy eligibility, classifier, candidate builder or sorter. */
import ds from "datascript";
import type { Datom, Value, Db } from "datascript";
import { createHash } from "node:crypto";
import type { Snapshot, Issue, PullRequest } from "./types.js";
import type { SubjectAssessments } from "./assessments.js";
import type { RankedAction, RankedActions, BlendedRole, ActionKind, Band } from "./blended.js";
import type { PickupOrder } from "./ranking.js";
import {
  definitions,
  clauses,
  schema,
  constants,
  comparison,
  keyQueries,
  queries,
  unknownUnlocks,
  activeDependents,
  denialsQuery,
  commandTemplates,
  commandKinds,
  otherClaimsQuery,
  witnessClauses,
  commonWitnesses,
  eligibilityWitnesses,
  sortClauses,
  policyVersion,
} from "./datalog-policy.js";

export interface DatalogOptions {
  role: BlendedRole;
  agent?: string;
  platform?: string;
  order?: PickupOrder;
  /**
   * Trusted delivery responsibility per deliverable URL (#190 records, read by #182). Additive to
   * `agent:` linkage; a deliverable absent here has no proven responsibility, never "nobody".
   */
  responsible?: ReadonlyMap<string, readonly string[]>;
  /** Issues whose delivery records could not be folded; reported, never treated as absence. */
  responsibilityUnknown?: readonly string[];
  limit: number;
  signal?: AbortSignal;
  now?: () => number;
}
export interface Explanation {
  text: string;
  ruleIds: string[];
  facts: Record<string, Value>;
  overriddenRuleIds: string[];
}
export interface DatalogAction extends RankedAction {
  ruleIds: string[];
  why: Explanation;
}
export interface DatalogResult extends RankedActions {
  items: DatalogAction[];
  decisionEngine: {
    requested: "datalog";
    used: "datalog";
    policyVersion: number;
    rulesHash: string;
    coverage: { subjects: number; datoms: number };
    diagnostics: string[];
    denials: { target: string; ruleId: string }[];
  };
}
export class DatalogError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}. Roll back: pdb config set briefing.engine typescript`);
  }
}
const artifact = {
  policyVersion,
  schema,
  constants,
  clauses,
  definitions,
  comparison,
  sortClauses,
  keyQueries,
  queries,
  unknownUnlocks,
  activeDependents,
  denialsQuery,
  commandTemplates,
  commandKinds,
  otherClaimsQuery,
  witnessClauses,
  commonWitnesses,
  eligibilityWitnesses,
};
export const rulesHash = createHash("sha256").update(JSON.stringify(artifact)).digest("hex");
/**
 * Codex review-state markers as raw facts. Kept local, not imported, so the lazily loaded
 * evaluator stays one self-contained chunk; reviewevidence.ts holds the TypeScript-engine twin
 * and the tests assert both engines agree.
 */
const codexAccount = "chatgpt-codex-connector";
function codexState(
  body: string,
): { status?: unknown; commit_sha?: unknown; has_unresolved_findings?: unknown } | null {
  const m = /codex-review-state:v1 (\{.*?\}) -->/.exec(body);
  try {
    const parsed: unknown = m ? JSON.parse(m[1]) : null;
    const review =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { code_review?: unknown }).code_review
        : null;
    return typeof review === "object" && review !== null ? review : null;
  } catch {
    return null;
  }
}
const emptyMetric = { state: "unknown" as const, size: null, provenance: null };
const subjectsOf = (s: Snapshot) => [...s.issues, ...s.pullRequests];
function normalize(
  snapshot: Snapshot,
  assessments: ReadonlyMap<string, SubjectAssessments>,
  options: DatalogOptions,
): { facts: Datom[]; ids: Map<string, number>; objects: Map<number, Issue | PullRequest> } {
  const objects = new Map(subjectsOf(snapshot).map((s, i) => [i + 100, s]));
  const ids = new Map([...objects].map(([id, s]) => [s.url, id]));
  let nextId = objects.size + 100;
  const facts: Datom[] = [
    [1, "role", options.role],
    [1, "agent", options.agent ?? ""],
    [1, "platform", options.platform ?? ""],
    [1, "order", options.order ?? "impact"],
  ];
  const put = (id: number, key: string, value: Value) => {
    if (facts.length >= 50000)
      throw new DatalogError("experimental-scope-exceeded", "at most 50000 datoms are supported");
    return facts.push([id, key, value]);
  };
  for (const [key, values] of Object.entries(constants)) for (const v of values) put(1, key, v);
  put(
    1,
    "forward-complete",
    snapshot.pullRequests
      .filter((p) => p.state === "OPEN")
      .every((p) => !p.closingIssuesReferences.pageInfo.hasNextPage),
  );
  for (const [id, s] of objects) {
    const a = assessments.get(s.url);
    const pr = snapshot.pullRequests.find((p) => p.url === s.url) ?? null;
    for (const [k, v] of Object.entries({
      kind: pr ? "pr" : "issue",
      state: s.state,
      number: s.number,
      target: s.url,
      created: Date.parse(s.createdAt),
      "labels-complete": !s.labels.pageInfo.hasNextPage,
      "reverse-complete":
        !!s.closedByPullRequestsReferences &&
        !s.closedByPullRequestsReferences.pageInfo.hasNextPage,
      "native-complete":
        !!s.blockedBy &&
        !s.blockedBy.pageInfo.hasNextPage &&
        !!s.issueDependenciesSummary &&
        s.blockedBy.nodes.length === s.issueDependenciesSummary.totalBlockedBy,
      "open-blockers": s.issueDependenciesSummary?.blockedBy ?? -1,
      "blocking-complete": !!s.blocking && !s.blocking.pageInfo.hasNextPage,
      "impact-state": a?.impact.state ?? "unknown",
      "impact-size": a?.impact.size ?? "unknown",
      "complexity-state": a?.complexity.state ?? "unknown",
      "complexity-size": a?.complexity.size ?? "unknown",
      head: pr?.headRefOid ?? "not-a-pr",
    }))
      put(id, k, v);
    for (const { name } of s.labels.nodes) {
      put(id, "label", name);
      for (const prefix of ["agent:", "attention:", "platform:"])
        if (name.startsWith(prefix))
          put(id, prefix === "agent:" ? "owner" : prefix.slice(0, -1), name.slice(prefix.length));
    }
    for (const b of s.blockedBy?.nodes ?? []) {
      const linked = ids.get(b.url) ?? nextId++;
      put(id, "blocker", linked);
      if (!ids.has(b.url)) {
        put(linked, "state", b.state);
        put(linked, "target", b.url);
      }
    }
    for (const b of s.blocking?.nodes ?? []) {
      const linked = ids.get(b.url) ?? nextId++;
      put(id, "dependent", linked);
      if (!ids.has(b.url)) {
        put(linked, "state", b.state);
        put(linked, "target", b.url);
      }
    }
    for (const p of s.closedByPullRequestsReferences?.nodes ?? [])
      if (p.state === "OPEN") put(id, "closing", ids.get(p.url) ?? nextId++);
    for (const agent of options.responsible?.get(s.url) ?? []) put(id, "responsible", agent);
    if (pr) {
      const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup;
      for (const [k, v] of Object.entries({
        draft: pr.isDraft,
        mergeable: pr.mergeable,
        "merge-state": pr.mergeStateStatus,
        "review-decision": pr.reviewDecision ?? "",
        "pr-complete":
          !snapshot.warnings.some((w) => w.startsWith(pr.url)) &&
          !!rollup &&
          !rollup.contexts.pageInfo.hasNextPage &&
          !pr.reviewThreads.pageInfo.hasNextPage &&
          !pr.reviews.pageInfo.hasNextPage,
      }))
        put(id, k, v);
      for (const ref of pr.closingIssuesReferences.nodes) {
        const other = ids.get(ref.url);
        if (other !== undefined) put(id, "closes", other);
      }
      for (const check of rollup?.contexts.nodes ?? []) {
        const c = nextId++;
        put(id, "check", c);
        put(c, "name", check.name ?? check.context ?? "unnamed");
        put(c, "outcome", check.conclusion ?? check.state ?? check.status ?? "UNKNOWN");
      }
      // Raw review evidence; the policy decides what binds to the current head (#182).
      for (const review of pr.reviews.nodes) {
        const r = nextId++;
        put(id, "review", r);
        put(r, "review-state", review.state);
        if (review.commit?.oid) put(r, "review-commit", review.commit.oid);
      }
      for (const c of pr.comments.nodes) {
        if ((c.author?.login ?? "").replace(/\[bot\]$/, "") !== codexAccount) continue;
        const state = codexState(c.body ?? "");
        if (!state) continue;
        const r = nextId++;
        put(id, "receipt", r);
        if (typeof state.commit_sha === "string") put(r, "receipt-commit", state.commit_sha);
        if (typeof state.status === "string") put(r, "receipt-status", state.status);
        if (typeof state.has_unresolved_findings === "boolean")
          put(r, "receipt-findings", state.has_unresolved_findings);
      }
      for (const thread of pr.reviewThreads.nodes) {
        const c = nextId++;
        put(id, "thread", c);
        put(c, "resolved", thread.isResolved);
      }
    }
  }
  for (const [i, r] of definitions.entries())
    for (const [k, v] of Object.entries({
      rule: r.id,
      kind: r.kind,
      band: r.band,
      preference: r.preference,
      why: r.why,
    }))
      put(10 + i, k, v);
  return { facts, ids, objects };
}

/** Fixed comparator executes policy-emitted scalar keys; no policy decisions here. */
export function compareKeys(a: readonly Value[], b: readonly Value[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i],
      y = b[i];
    if (typeof x !== typeof y) throw new DatalogError("invalid-sort-key", "inconsistent key types");
    if (x === y) continue;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}
const query = (db: Db, q: string) => (q.includes(":in $ %") ? ds.q(q, db, clauses) : ds.q(q, db));
export function evaluateDatalog(
  snapshot: Snapshot,
  assessments: ReadonlyMap<string, SubjectAssessments>,
  options: DatalogOptions,
): DatalogResult {
  options.signal?.throwIfAborted();
  const clock = options.now ?? performance.now.bind(performance),
    started = clock();
  if (!["implementer", "designer"].includes(options.role))
    throw new DatalogError("unsupported-role", "use --role implementer or --role designer");
  if (subjectsOf(snapshot).length > 500)
    throw new DatalogError("experimental-scope-exceeded", "at most 500 subjects are supported");
  const { facts, objects } = normalize(snapshot, assessments, options);
  const fullSchema = {
    ...schema,
    ...Object.fromEntries(
      Object.keys(constants).map((k) => [k, { ":db/cardinality": ":db.cardinality/many" }]),
    ),
  };
  const database = () => {
    options.signal?.throwIfAborted();
    if (facts.length > 50000)
      throw new DatalogError("experimental-scope-exceeded", "at most 50000 datoms are supported");
    return ds.init_db(facts, fullSchema);
  };
  let db = database();
  const denials = query(db, denialsQuery).map(([id, rule]) => ({
    target: objects.get(Number(id))?.url ?? "",
    ruleId: String(rule),
  }));
  // Each root query derives a relation; the host only transacts the returned tuples.
  for (const [i, r] of definitions.entries()) {
    const rows = query(db, `[:find ?t :in $ % :where (foreground ?t) ${r.clauses}]`);
    for (const [t] of rows) facts.push([Number(t), "matched", 10 + i]);
    options.signal?.throwIfAborted();
  }
  db = database();
  // Explicit deny-over-permit: unfavorable beats ordinary; easy wins beat ordinary.
  // Preference resolves overlapping boosted/default assessment rules. All matches remain auditable.
  const overrides = ds.q(queries.q0, db);
  for (const [t, r] of overrides) facts.push([Number(t), "overridden", r]);
  db = database();
  // Native direct unlocks only: the dependent has exactly one open blocker and is otherwise ready.
  const unlockRows = query(db, queries.q1);
  for (const [t, d] of unlockRows) facts.push([Number(t), "unlocks-dependent", d]);
  db = ds.init_db(facts, {
    ...fullSchema,
    "unlocks-dependent": { ":db/cardinality": ":db.cardinality/many" },
  });
  const countQ = queries.q2;
  const counts = ds.q(countQ, db);
  for (const [t, reason] of query(db, unknownUnlocks))
    facts.push([Number(t), "unlock-unknown", reason]);
  for (const [t, n] of counts) facts.push([Number(t), "unlock-count", n]);
  for (const [t] of ds.q(queries.q3, database())) facts.push([Number(t), "unlock-count", 0]);
  db = database();
  for (const [t, d] of query(db, activeDependents)) facts.push([Number(t), "active-dependent", d]);
  db = ds.init_db(facts, {
    ...fullSchema,
    "active-dependent": { ":db/cardinality": ":db.cardinality/many" },
  });
  for (const [t, n] of ds.q('[:find ?t (count-distinct ?d) :where [?t "active-dependent" ?d]]', db))
    facts.push([Number(t), "active-count", n]);
  db = database();
  for (const [t] of ds.q('[:find ?t :where [?t "kind" _] (not [?t "active-count" _])]', db))
    facts.push([Number(t), "active-count", 0]);
  // Boolean/order keys are inferred from the raw relations, not precomputed by an adapter.
  db = database();

  for (const [field, q] of keyQueries)
    for (const [t, k] of query(db, q)) facts.push([Number(t), field, k]);
  db = database();

  facts.push(
    [1, "assessment-kind", "estimate-complexity"],
    [1, "assessment-kind", "assess-impact"],
    [1, "assessment-kind", "inspect-assessment"],
  );
  db = ds.init_db(facts, {
    ...fullSchema,
    "assessment-kind": { ":db/cardinality": ":db.cardinality/many" },
  });
  const decisions = ds.q(queries.q4, db, sortClauses);
  options.signal?.throwIfAborted();
  const ranked = decisions
    .sort((a, b) => compareKeys(a.slice(2), b.slice(2)))
    .map((row): DatalogAction => {
      const [t, r, b] = row;
      const subject = objects.get(Number(t));
      const definition = definitions[Number(r) - 10];
      if (!subject || !definition)
        throw new DatalogError("invalid-inference", "unknown subject or rule");
      const a = assessments.get(subject.url);
      const bindings: Record<string, Value> = {};
      const selectedWitnesses = {
        ...commonWitnesses,
        ...eligibilityWitnesses,
        ...witnessClauses[definition.id],
      };
      for (const [key, clause] of Object.entries(selectedWitnesses)) {
        const values = ds.q(`[:find ?value :in $ % ?t :where ${clause}]`, db, clauses, t).flat();
        if (values.length === 1) bindings[key] = values[0];
        else if (values.length > 1) {
          const sorted = values.map(String).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
          bindings[key] = sorted.slice(0, 8).join("; ");
          if (values.length > 8) bindings[`${key}Omitted`] = values.length - 8;
        }
      }
      const text = definition.why.replace(/\{(\w+)\}/g, (_, key: string) => {
        if (!(key in bindings)) throw new DatalogError("missing-explanation-binding", key);
        return String(bindings[key]);
      });
      const overridden = ds.q(queries.q5, db, t).flat().map(String);
      const unlock = Number(ds.q(queries.q6, db, t)[0]?.[0] ?? 0);
      const unknown = ds.q(queries.q7, db, t).flat().map(String);
      const ruleIds = [definition.id];
      const commandFacts: Record<string, string> = {
        repo: snapshot.repository,
        number: String(subject.number),
        agent: options.agent ?? "NAME",
        platformFlag: options.platform ? ` --platform ${options.platform}` : "",
        other: "",
      };
      const fillCommand = (key: string) =>
        commandTemplates[key].replace(/\{(\w+)\}/g, (_, k: string) => commandFacts[k]);
      const commandKey = commandKinds[definition.kind] ?? "detail";
      let nextCommand = fillCommand(
        commandKey === "detail" && "headRefOid" in subject ? "pr" : commandKey,
      );
      let thenCommand: string | null = null;
      if (definition.kind === "implement") {
        const others = query(db, otherClaimsQuery)
          .filter(([id]) => Number(id) === Number(t))
          .map(([, id]) => objects.get(Number(id))!.number);
        nextCommand = fillCommand("claim");
        if (others.length === 1) {
          commandFacts.other = String(others[0]);
          thenCommand = nextCommand;
          nextCommand = fillCommand("release");
        } else if (others.length > 1) nextCommand = "";
      }
      return {
        id: `${snapshot.repository} ${subject.url} ${definition.kind}`,
        kind: definition.kind as ActionKind,
        target: subject.url,
        role: options.role,
        band: Number(b) as Band,
        reasonCodes: definition.codes,
        evidence: [
          subject.url,
          ...[a?.impact.provenance, a?.complexity.provenance].filter((p): p is string => !!p),
        ],
        nextCommand: nextCommand || null,
        thenCommand,
        inspection: nextCommand
          ? null
          : `Inspect current evidence: pdb --repo ${snapshot.repository} --issue ${subject.number} --json`,
        impact: a?.impact ?? emptyMetric,
        complexity: a?.complexity ?? emptyMetric,
        unlocks: unlock,
        unlocksUnknown: unknown,
        ruleIds,
        why: { text, ruleIds, facts: bindings, overriddenRuleIds: overridden },
      };
    });
  const elapsed = clock() - started;
  options.signal?.throwIfAborted();
  return {
    policyVersion: 1,
    total: ranked.length,
    omitted: Math.max(0, ranked.length - options.limit),
    items: ranked.slice(0, Math.max(0, options.limit)),
    decisionEngine: {
      requested: "datalog",
      used: "datalog",
      policyVersion,
      rulesHash,
      coverage: { subjects: objects.size, datoms: facts.length },
      denials,
      diagnostics: [
        ...(elapsed > 2000
          ? [`evaluation exceeded soft 2000ms budget (${Math.round(elapsed)}ms)`]
          : []),
        ...(options.responsibilityUnknown ?? []).map(
          (issue) => `delivery responsibility unknown for ${issue}; agent: labels only`,
        ),
      ],
    },
  };
}
