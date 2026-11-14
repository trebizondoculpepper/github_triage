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
 * #245 ships the primitive only; wiring it into reports (`assessments`) is #247.
 */
import type { ComplexitySize } from "./complexity.js";
import type { Comment } from "./claims.js";
import { classifyMetricLabels } from "./complexitylabels.js";
import type { TrustDecision } from "./delivery.js";
import { parseMetricProvenance } from "./estimate.js";
import type { MetricDescriptor } from "./metrics.js";
import type { Issue } from "./types.js";

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

  const reasons: string[] = [];
  let record: {
    provenance: NonNullable<ReturnType<typeof parseMetricProvenance>>;
    url: string | null;
  } | null = null;
  for (const comment of [...issue.comments.nodes].reverse()) {
    const parsed = parseMetricProvenance(d, comment.body);
    if (!parsed) continue;
    const authority = await trust(comment);
    if (authority.status === "trusted") {
      record = { provenance: parsed, url: comment.url ?? null };
      break;
    }
    if (authority.status === "unknown")
      return none("unknown", [`provenance authority unknown (${authority.why})`]);
    reasons.push(`untrusted provenance ignored (${authority.why})`);
  }
  const incomplete = !!(
    issue.comments.pageInfo.hasNextPage || issue.comments.pageInfo.hasPreviousPage
  );
  if (!record && incomplete)
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
