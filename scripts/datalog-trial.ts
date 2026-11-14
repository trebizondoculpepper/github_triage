#!/usr/bin/env node
/** Reproduce #306's read-only same-snapshot comparison; raw inputs/outputs stay outside Git. */
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cachedSnapshot } from "../src/cli.js";
import { readSnapshotAssessments } from "../src/assessments.js";
import { collectLabelEstimationInput, metricStatus } from "../src/complexitylabels.js";
import { impactMetric } from "../src/metrics.js";
import { markerTrust } from "../src/delivery.js";
import { ghRest, permissionLookup } from "../src/github.js";
import { briefing } from "../src/briefing.js";
import { compactBriefing } from "../src/compact.js";
import { evaluateDatalog } from "../src/rules/datalog/datalog.js";
const { values } = parseArgs({
  options: {
    snapshot: { type: "string" },
    out: { type: "string" },
    agent: { type: "string" },
    platform: { type: "string" },
    repo: { type: "string" },
  },
});
if (!values.snapshot || !values.out)
  throw new Error(
    "Use --snapshot PATH --out PATH [--repo owner/repo] [--agent NAME] [--platform PLATFORM]. Reads current provenance-author permissions through authenticated gh; never mutates GitHub or configuration.",
  );
const snapshot = await cachedSnapshot(values.snapshot, values.repo);
const local = { cwd: process.cwd() };
const estimation = await collectLabelEstimationInput(snapshot.repository, local);
const impactStatus = await metricStatus(impactMetric, snapshot.repository, local);
const assessments = await readSnapshotAssessments(snapshot, {
  complexity: estimation.status,
  impact: impactStatus,
  trust: markerTrust(permissionLookup(snapshot.repository, ghRest)),
  platform: values.platform,
});
const now = new Date(snapshot.fetchedAt);
const expanded = briefing(
  snapshot,
  {
    limit: 10000,
    agent: values.agent,
    platform: values.platform,
    order: "impact",
    estimation,
    assessments,
    offline: true,
  },
  now,
);
const source = (await promisify(execFile)("git", ["rev-parse", "HEAD"])).stdout.trim();
const roles = { implementer: {}, designer: {} } as Record<string, unknown>;
for (const role of ["implementer", "designer"] as const) {
  const options = { limit: 10000, agent: values.agent, role };
  const native = compactBriefing(snapshot, options, expanded, assessments, impactStatus);
  const derived = evaluateDatalog(snapshot, assessments, {
    role,
    agent: values.agent,
    platform: values.platform,
    order: "impact",
    limit: 10000,
  });
  const alternative = compactBriefing(
    snapshot,
    options,
    expanded,
    assessments,
    impactStatus,
    derived,
  );
  const rows = (report: typeof native) => {
    const reasons = new Map(
      report.role?.sections.flatMap((s) => s.items.map((r) => [r.url, r.reason] as const)) ?? [],
    );
    return (
      report.rankedActions?.items.map((r) => ({
        id: r.id,
        target: r.target,
        kind: r.kind,
        band: r.band,
        why: r.why?.text ?? reasons.get(r.target) ?? r.reasonCodes.join(", "),
        ruleIds: r.ruleIds ?? [],
        facts: r.why?.facts ?? null,
        complexity: r.complexity,
        impact: r.impact,
        unlocks: r.unlocks,
        unlocksUnknown: r.unlocksUnknown,
      })) ?? []
    );
  };
  const typescript = rows(native),
    datalog = rows(alternative),
    nativeIDs = new Set(typescript.map((r) => r.id)),
    derivedIDs = new Set(datalog.map((r) => r.id));
  const common = new Set([...nativeIDs].filter((id) => derivedIDs.has(id)));
  roles[role] = {
    typescript,
    datalog,
    comparison: {
      commonActions: common.size,
      sameCommonRelativeOrder:
        JSON.stringify(typescript.filter((r) => common.has(r.id)).map((r) => r.id)) ===
        JSON.stringify(datalog.filter((r) => common.has(r.id)).map((r) => r.id)),
      sameTopTen:
        JSON.stringify(typescript.slice(0, 10).map((r) => r.id)) ===
        JSON.stringify(datalog.slice(0, 10).map((r) => r.id)),
      typescriptOnly: typescript.filter((r) => !derivedIDs.has(r.id)),
      datalogOnly: datalog.filter((r) => !nativeIDs.has(r.id)),
    },
    decisionEngine: derived.decisionEngine,
  };
}
await writeFile(
  values.out,
  JSON.stringify(
    {
      schemaVersion: 1,
      kind: "same-snapshot-datalog-trial",
      sourceRevision: source,
      repository: snapshot.repository,
      snapshotAt: snapshot.fetchedAt,
      subjectCount: snapshot.issues.length + snapshot.pullRequests.length,
      permissions:
        "current read-only permission lookup; one shared assessment map for both engines",
      agent: values.agent ?? null,
      platform: values.platform ?? null,
      roles,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Compared both engines on ${snapshot.issues.length} issues / ${snapshot.pullRequests.length} PRs at ${snapshot.fetchedAt}; source ${source}.`,
);
for (const [role, result] of Object.entries(roles)) {
  const c = (
    result as {
      comparison: {
        commonActions: number;
        sameCommonRelativeOrder: boolean;
        sameTopTen: boolean;
        typescriptOnly: { id: string }[];
        datalogOnly: { id: string }[];
      };
    }
  ).comparison;
  console.log(
    `${role}: ${c.commonActions} shared actions; same shared order=${c.sameCommonRelativeOrder}; same top ten=${c.sameTopTen}; TypeScript-only=${c.typescriptOnly.length}; Datalog-only=${c.datalogOnly.length}.`,
  );
}
