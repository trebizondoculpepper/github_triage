/**
 * Trusted-provenance reader producing the paired assessment state for one metric
 * (doc/design/impact-estimation.md "Who records, and authority" and "Reading: states, staleness
 * and unknowns", #245).
 *
 * The label is the authority for the current size; provenance is evidence of why. A provenance
 * comment counts as recorded only when its author and, if edited, its last editor are trusted
 * through the injected `TrustDecision` (#215 rule: a `User` with current write, maintain or admin
 * permission). Untrusted provenance stays visible but is treated as no recorded rationale;
 * provenance whose authority is unknown makes the state unknown, never current. This vocabulary
 * is new and separate: it never replaces the existing `EstimateState` of `complexity.state`.
 *
 * #245 ships the primitive; #247 adds `readSnapshotAssessments`, the one shared paired-facts
 * reader per snapshot that report subjects (`assessments`) and later the queue (#248) consume.
 */
import type { ComplexitySize } from "./complexity.js";
import { impactLookup } from "./ranking.js";
import type { Comment } from "./claims.js";
import { classifyMetricLabels } from "./complexitylabels.js";
import type { TrustDecision } from "./delivery.js";
import { scanProvenance } from "./estimate.js";
import { complexityMetric, impactMetric } from "./metrics.js";
import type { MetricDescriptor } from "./metrics.js";
import type { Issue, Snapshot } from "./types.js";

export type AssessmentState =
  | "current"
  | "stale"
  | "unassessed"
  | "conflict"
  | "invalid"
  | "unknown"
  | "disabled";

export interface AssessmentReading {
  state: AssessmentState;
  /** Non-null only for `current` and `stale`. */
  size: ComplexitySize | null;
  /** URL of the newest trusted provenance comment, or null. */
  provenance: string | null;
  reasons: string[];
}

/** The issue facts the reader needs: labels, comments with author/edit evidence, edit time. */
export interface AssessmentSubject {
  labels: Issue["labels"];
  lastEditedAt?: string | null;
  comments: {
    nodes: (Comment & { url?: string })[];
    pageInfo: { hasNextPage?: boolean; hasPreviousPage?: boolean };
  };
}

/**
 * Read one metric's paired state for one issue. `enabled` false yields `disabled` without
 * reading anything; disabling never deletes labels or provenance.
 */
export async function readAssessment(
  d: MetricDescriptor,
  issue: AssessmentSubject,
  { enabled = true, trust }: { enabled?: boolean; trust: TrustDecision },
): Promise<AssessmentReading> {
  const none = (state: AssessmentState, reasons: string[]): AssessmentReading => ({
    state,
    size: null,
    provenance: null,
    reasons,
  });
  if (!enabled) return none("disabled", [`${d.enabledKey} is false`]);
  const c = classifyMetricLabels(d, issue);
  // Invalid takes precedence over conflict; both are definite even on a truncated page.
  if (c.unrecognized.length)
    return none("invalid", [`unrecognized ${d.metric} label(s) ${c.unrecognized.join(", ")}`]);
  if (c.sizes.length > 1) return none("conflict", [`several size labels (${c.labels.join(", ")})`]);
  if (!c.complete) return none("unknown", [c.detail]);
  if (!c.size) return none("unassessed", [`no ${d.metric} size label`]);
  const size = c.size;

  const scan = await scanProvenance(d, issue.comments.nodes, trust);
  if (scan.status === "unknown")
    return none("unknown", [...scan.ignored, `provenance authority unknown (${scan.why})`]);
  const reasons = scan.ignored;
  const record =
    scan.status === "trusted" ? { provenance: scan.provenance, url: scan.node.url ?? null } : null;
  // Newer comments are missing: a replacement or unverifiable record may be among them, so
  // neither the selected provenance nor its state is established, even when one was found.
  if (issue.comments.pageInfo.hasNextPage)
    return none("unknown", [...reasons, "newer comment history incomplete; provenance unknown"]);
  // Only older comments are missing: a found record is still the newest; none found is unknown.
  if (!record && issue.comments.pageInfo.hasPreviousPage)
    return none("unknown", [...reasons, "comment history incomplete; provenance unknown"]);
  if (!record)
    return {
      state: "current",
      size,
      provenance: null,
      reasons: [...reasons, "no recorded rationale"],
    };

  const p = record.provenance;
  let state: AssessmentState = "current";
  if (p.size !== size) {
    state = "stale";
    reasons.push(`label ${size} differs from recorded estimate ${p.size}`);
  }
  if (
    (typeof p.guidanceVersion === "number" ? p.guidanceVersion : 0) < d.guidance.guidanceVersion
  ) {
    state = "stale";
    reasons.push(`guidance version ${p.guidanceVersion} < ${d.guidance.guidanceVersion}`);
  }
  const edited = issue.lastEditedAt ? Date.parse(issue.lastEditedAt) : NaN;
  if (edited > Date.parse(p.recordedAt)) {
    state = "stale";
    reasons.push(`description edited ${issue.lastEditedAt} after the estimate`);
  }
  return { state, size, provenance: record.url, reasons };
}

/** One metric as shown side by side (doc/design/impact-estimation.md "Side-by-side display"). */
export interface MetricView {
  state: AssessmentState;
  /** Non-null only for `current` and `stale`. */
  size: ComplexitySize | null;
  /** URL of the newest trusted provenance comment, or null. */
  provenance: string | null;
}

/**
 * The `assessments` property of a report subject: the designer's impact estimate, the
 * implementer's complexity estimate and the computed immediate-unlock utility, kept separate.
 */
export interface SubjectAssessments {
  impact: MetricView;
  complexity: MetricView;
  /** Definite immediate unlocks (the same count as pickup ranking, #208). */
  unlocks: number;
  /** Why more unlocks cannot be ruled out; empty when `unlocks` is complete. */
  unlocksUnknown: string[];
}

/** Whether a metric is enabled; a configuration that cannot be read is `unknown`. */
export type MetricAvailability = "available" | "disabled" | "unknown";

/** Without a permission boundary (offline, or none injected) provenance authority is unknown. */
export const unknownTrust: TrustDecision = async () => ({
  status: "unknown",
  why: "comment author permissions not read",
});

const view = (reading: AssessmentReading): MetricView => ({
  state: reading.state,
  size: reading.size,
  provenance: reading.provenance,
});

/**
 * The shared paired-facts reader (#247): read both metrics and the unlock count once per
 * snapshot, for every open issue, keyed by URL. Presentation and the blended queue consume the
 * same map; nothing here scores or ranks. No collection happens here: labels and comments come
 * from the snapshot, and `trust` is the per-run permission cache (#212), so permission requests
 * are bounded by one per distinct provenance-marker author or editor login per run. The reader
 * consults trust only for a ticket with exactly one recognized size label and a provenance
 * marker, stopping at the newest trusted or unknown marker.
 */
export async function readSnapshotAssessments(
  snapshot: Pick<Snapshot, "issues" | "pullRequests">,
  {
    impact,
    complexity,
    trust = unknownTrust,
    platform,
    signal,
  }: {
    impact: MetricAvailability;
    complexity: MetricAvailability;
    trust?: TrustDecision;
    platform?: string;
    /** Cancellation: rejects with the abort reason; never returns a partial map. */
    signal?: AbortSignal;
  },
): Promise<Map<string, SubjectAssessments>> {
  const open = snapshot.issues.filter((issue) => issue.state === "OPEN");
  const unlocksOf = impactLookup(open, {
    prs: snapshot.pullRequests.filter((pr) => pr.state === "OPEN"),
    platform,
  });
  const read = async (
    d: MetricDescriptor,
    status: MetricAvailability,
    issue: Issue,
  ): Promise<MetricView> =>
    status === "unknown"
      ? { state: "unknown", size: null, provenance: null }
      : view(await readAssessment(d, issue, { enabled: status === "available", trust }));
  const result = new Map<string, SubjectAssessments>();
  // Sequential, so the permission cache answers repeated authors without a second request.
  for (const issue of open) {
    signal?.throwIfAborted();
    const unlocks = unlocksOf(issue.url);
    result.set(issue.url, {
      impact: await read(impactMetric, impact, issue),
      complexity: await read(complexityMetric, complexity, issue),
      unlocks: unlocks.unlocks.length,
      unlocksUnknown: unlocks.unknown,
    });
  }
  signal?.throwIfAborted();
  return result;
}

const metricText = (name: string, v: MetricView): string =>
  v.state === "current"
    ? `${name} ${v.size}`
    : v.state === "stale"
      ? `${name} stale (was ${v.size})`
      : `${name} ${v.state}`;

/** Fixed order, impact first: `impact L · complexity S · unlocks at least 2`. */
export function assessmentsText(a: SubjectAssessments): string {
  return `${metricText("impact", a.impact)} · ${metricText("complexity", a.complexity)} · unlocks at least ${a.unlocks}${a.unlocksUnknown.length ? " (dependants incomplete)" : ""}`;
}

/** Provenance links for detail views, newest trusted comment per metric. */
export function provenanceText(a: SubjectAssessments): string | null {
  const links = [
    a.impact.provenance && `impact ${a.impact.provenance}`,
    a.complexity.provenance && `complexity ${a.complexity.provenance}`,
  ].filter(Boolean);
  return links.length ? `Provenance: ${links.join("; ")}` : null;
}
