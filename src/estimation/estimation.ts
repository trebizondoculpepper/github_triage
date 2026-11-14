/**
 * Optional implementer estimation queue and briefing visibility (#122, labels-only since #152/#153).
 * Contract: doc/design/complexity-estimation.md "Estimation as implementer work".
 *
 * Estimation eligibility is separate from implementation eligibility: a blocked ticket can be
 * sized while staying ineligible for pickup. The queue holds unestimated and meaningfully stale
 * estimates; it is presented after higher-priority work unless explicitly requested, acquires
 * no claim and reserves nothing. Disabled complexity suppresses it. Sizes come from the
 * `complexity:` labels already in the snapshot (complexitylabels.ts); incomplete label evidence
 * is unknown, never "unestimated" or queued. Missing labels or label definitions are not setup
 * errors. Provenance comes from v2 marker comments already in the snapshot.
 */
import { complexityGuidance } from "./complexity.js";
import type { ComplexitySize } from "./complexity.js";
import { parseLabelProvenance } from "./estimate.js";
import { pickupEligibility } from "../ranking.js";
import type { PickupContext } from "../ranking.js";
import type { Issue } from "../github/types.js";

export type EstimationStatus = "available" | "disabled" | "unknown";

export interface EstimationFinding {
  rule: string;
  detail: string;
  /** Delivered commands only. */
  next: string[];
}

/** Bound on conflicting-size inspection lines in text output. */
export const MAX_CONFLICT_LINES = 10;

/** "conflicting" (#151, additive): several recognized size labels; inspect, never choose one. */
export type EstimateState = "estimated" | "unestimated" | "stale" | "conflicting" | "unknown";

export interface RecordedEstimate {
  size: ComplexitySize;
  rationale: string;
  assumptions: readonly string[];
  estimator: string | null;
  recordedAt: string | null;
  guidanceVersion: number | null;
  url: string;
}

export interface EstimateEntry {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  /** Size from the complexity label; null when unset or unknown (see state). */
  size: ComplexitySize | null;
  state: EstimateState;
  /** Newest provenance marker in the comment history, if any. */
  recorded: RecordedEstimate | null;
  /** Implementation pickup eligibility, independent of estimation. */
  implementation: "eligible" | "ineligible" | "unknown";
  reasons: string[];
}

export interface EstimationReport {
  status: EstimationStatus;
  /**
   * Deprecated, always null: native-field storage was retired (#153). Kept so the briefing
   * output shape stays compatible with schema versions 1 (expanded) and 2 (compact).
   */
  fieldId: null;
  /** True when the caller asked to estimate (--estimate): the queue is presented first. */
  requested: boolean;
  guidanceVersion: number;
  detail: string;
  findings: EstimationFinding[];
  /** Unestimated and stale tickets, oldest first; null when the queue is unavailable. */
  queue: { total: number; omitted: number; items: EstimateEntry[] } | null;
  /** Open tickets whose size evidence could not be read completely. */
  unknown: number;
  /** Open tickets with conflicting size evidence: inspection candidates, never queued (#151). */
  conflicts: EstimateEntry[];
  /** Per-ticket state for compact visibility, keyed by URL. */
  entries: EstimateEntry[];
  boundaries: string;
}

/**
 * Newest valid v2 (label-backed) provenance marker; undefined when comment history is incomplete.
 * Retired field-era v1 markers are not provenance and are ignored, never parsed.
 */
function newestRecord(issue: Issue): RecordedEstimate | null | undefined {
  let found: RecordedEstimate | null = null;
  for (const comment of issue.comments.nodes) {
    const p = parseLabelProvenance(comment.body);
    if (p)
      found = {
        size: p.size,
        rationale: p.rationale,
        assumptions: Array.isArray(p.assumptions) ? p.assumptions : [],
        estimator: typeof p.estimator === "string" ? p.estimator : null,
        recordedAt: typeof p.recordedAt === "string" ? p.recordedAt : null,
        guidanceVersion: typeof p.guidanceVersion === "number" ? p.guidanceVersion : null,
        url: comment.url,
      };
  }
  if (!found && issue.comments.pageInfo.hasNextPage) return undefined;
  return found;
}

/**
 * One issue's current-size evidence, as read by the label reader in complexitylabels.ts.
 * "conflict" is an inspection case: no size is chosen.
 */
export type SizeReading =
  | { kind: "known"; size: ComplexitySize | null }
  | { kind: "unknown"; reason: string }
  | { kind: "conflict"; sizes: ComplexitySize[]; reason: string };

/** Report inputs from the size reader. */
export interface SizeSource {
  status: EstimationStatus;
  unavailable: string | null;
  findings: EstimationFinding[];
  /** Human noun for the authoritative size evidence, e.g. "complexity size label". */
  evidence: string;
  read: (issue: Issue) => SizeReading;
}

/** Shared report builder over any size reader. Pure. */
export function sizeReport(
  issues: Issue[],
  input: SizeSource | undefined,
  options: PickupContext & { limit: number; requested?: boolean },
): EstimationReport {
  const base = {
    fieldId: null,
    requested: !!options.requested,
    guidanceVersion: complexityGuidance.guidanceVersion,
    findings: input?.findings ?? [],
    boundaries:
      "Optional work after PR follow-up, own work and eligible pickup. Estimating acquires no claim, reserves nothing and does not unblock or re-rank.",
  };
  if (!input || input.status === "disabled")
    return {
      ...base,
      status: input ? "disabled" : "unknown",
      detail: input
        ? "Complexity is disabled for this repository (complexity.enabled = false); no estimation queue."
        : "Complexity state was not collected; estimation queue unknown.",
      queue: null,
      unknown: 0,
      conflicts: [],
      entries: [],
    };
  const entries = issues
    .filter((issue) => issue.state === "OPEN")
    .map((issue): EstimateEntry => {
      const reading = input.read(issue);
      const recorded = newestRecord(issue);
      const reasons: string[] = [];
      let state: EstimateState;
      let size: ComplexitySize | null = null;
      if (reading.kind === "unknown") {
        state = "unknown";
        reasons.push(reading.reason);
      } else if (reading.kind === "conflict") {
        state = "conflicting";
        reasons.push(reading.reason);
      } else if (recorded === undefined) {
        state = "unknown";
        reasons.push("comment history incomplete; provenance unknown");
      } else if (reading.size === null) {
        state = "unestimated";
        reasons.push(`no ${input.evidence}`);
      } else {
        size = reading.size;
        state = "estimated";
        if (!recorded) reasons.push("no recorded rationale (value set outside pdb)");
        else {
          if (recorded.size !== size) {
            state = "stale";
            reasons.push(
              `${input.evidence} ${size} differs from recorded estimate ${recorded.size}`,
            );
          }
          if ((recorded.guidanceVersion ?? 0) < complexityGuidance.guidanceVersion) {
            state = "stale";
            reasons.push(
              `guidance version ${recorded.guidanceVersion ?? "unknown"} < ${complexityGuidance.guidanceVersion}`,
            );
          }
          const edited = issue.lastEditedAt ? Date.parse(issue.lastEditedAt) : NaN;
          const at = recorded.recordedAt ? Date.parse(recorded.recordedAt) : NaN;
          if (edited > at) {
            state = "stale";
            reasons.push(`description edited ${issue.lastEditedAt} after the estimate`);
          } else if (!Number.isNaN(edited) && Number.isNaN(at)) {
            // An unparseable or missing recordedAt is unavailable freshness evidence: a later
            // description edit cannot be ruled out, so it never reads as fresh (#281).
            state = "stale";
            reasons.push(
              `description edited ${issue.lastEditedAt}; recorded time unknown, so the estimate cannot be shown fresh`,
            );
          }
        }
      }
      return {
        number: issue.number,
        title: issue.title,
        url: issue.url,
        createdAt: issue.createdAt,
        size,
        state,
        recorded: recorded ?? null,
        implementation: pickupEligibility(issue, options).status,
        reasons,
      };
    });
  const unknown = entries.filter((e) => e.state === "unknown").length;
  const conflicts = entries
    .filter((e) => e.state === "conflicting")
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number);
  if (input.status !== "available")
    return {
      ...base,
      status: input.status,
      detail: `Estimation queue unavailable: ${input.unavailable ?? "complexity state unknown"}. Unknown is not unestimated.`,
      queue: null,
      unknown,
      conflicts,
      entries,
    };
  const queued = entries
    .filter((e) => e.state === "unestimated" || e.state === "stale")
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number);
  return {
    ...base,
    status: "available",
    detail: `${queued.length} ticket(s) to estimate (unestimated or stale, blocked included)${conflicts.length ? `; ${conflicts.length} with conflicting size evidence to inspect, not queued` : ""}${unknown ? `; ${unknown} unknown (${input.unavailable ?? "unreadable"}), not queued` : ""}.`,
    queue: {
      total: queued.length,
      omitted: Math.max(0, queued.length - options.limit),
      items: queued.slice(0, options.limit),
    },
    unknown,
    conflicts,
    entries,
  };
}

/** One compact line describing an entry's size, freshness and assumptions. */
export function estimateLine(e: EstimateEntry): string {
  const r = e.recorded;
  const size =
    e.state === "conflicting"
      ? "conflicting sizes"
      : e.state === "unknown"
        ? `size unknown${r ? ` (last recorded ${r.size}, unverified)` : ""}`
        : e.size
          ? `size ${e.size}`
          : "unestimated";
  const facts = [
    `${size} [${e.state}]`,
    `implementation ${e.implementation}`,
    ...(r && e.state !== "unknown"
      ? [
          `recorded ${r.recordedAt ?? "at unknown time"}${r.estimator ? ` by ${r.estimator}` : ""}: ${r.rationale.slice(0, 120)}`,
          ...(r.assumptions.length ? [`assumes ${r.assumptions.join("; ").slice(0, 120)}`] : []),
        ]
      : []),
    ...e.reasons,
  ];
  return facts.join("; ");
}

/** Text section lines, bounded by the queue limit. */
export function estimationText(report: EstimationReport): string[] {
  const lines = [`${report.detail}`];
  for (const f of report.findings)
    lines.push(`  ${f.rule}: ${f.detail} Next: ${f.next.join(" | ")}`);
  if (report.queue) {
    for (const e of report.queue.items)
      lines.push(`#${e.number} ${e.title} — ${estimateLine(e)}\n  pdb estimate --help; ${e.url}`);
    if (report.queue.omitted) lines.push(`${report.queue.omitted} more omitted; increase --limit.`);
  }
  const shown = report.conflicts.slice(0, MAX_CONFLICT_LINES);
  for (const e of shown)
    lines.push(`#${e.number} ${e.title} — inspect: ${estimateLine(e)}\n  ${e.url}`);
  if (report.conflicts.length > shown.length)
    lines.push(`${report.conflicts.length - shown.length} more conflicting ticket(s) omitted.`);
  lines.push(report.boundaries);
  return lines;
}
