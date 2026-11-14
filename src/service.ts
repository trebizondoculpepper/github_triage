/**
 * Transport-neutral read service shared by the CLI and the MCP adapter (doc/design/mcp.md).
 *
 * Both front ends call these functions directly; neither runs the other in a subprocess or
 * parses terminal text. Only read operations live here: mutation planning and application stay
 * in their own modules and are never reachable through this service.
 */
import { collect, IssueUnavailable, permissionLookup } from "./github.js";
import type { IssueDiagnosis, Rest } from "./github.js";
import { markerTrust } from "./delivery.js";
import type { TrustDecision } from "./delivery.js";
import { impactMetric } from "./metrics.js";
import { dependencyReport, dependencyText } from "./dependencies.js";
import type { DependencyReport } from "./dependencies.js";
import { compactBriefing, compactText } from "./compact.js";
import { briefing, textReport } from "./briefing.js";
import type { BriefingOptions } from "./briefing.js";
import { readSnapshotAssessments } from "./assessments.js";
import { collectLabelEstimationInput, metricStatus } from "./complexitylabels.js";
import type { LabelEstimationRuntime } from "./complexitylabels.js";
import type { Snapshot } from "./types.js";
import type { PickupOrder } from "./ranking.js";
import { briefingProcess, resolveGuideSetting } from "./process.js";
import type { BriefingProcess, GuideRuntime } from "./process.js";

/** Presentation options for a collected snapshot, as the CLI's briefing flags express them. */
export interface PresentOptions extends Omit<BriefingOptions, "estimation" | "assessments"> {
  /** Expanded version-1 report instead of the compact briefing. */
  full?: boolean;
  /** Compact text budget. */
  maxChars: number;
  /** Registered role view (#1) shaping the compact briefing. */
  role?: string;
  /** Workflow guide (#71) for the compact briefing; omitted means no `process` object. */
  process?: BriefingProcess;
}

/** The versioned briefing report and its text rendering. */
export interface PresentedBriefing {
  report: ReturnType<typeof compactBriefing> | ReturnType<typeof briefing>;
  text: string;
  complete: boolean;
}

/** Build the briefing (compact unless `full`) for an already collected snapshot. */
export async function presentBriefing(
  snapshot: Snapshot,
  options: PresentOptions,
  estimationRuntime?: LabelEstimationRuntime,
  now: Date = new Date(),
  redactDiagnostic?: (text: string) => string,
  trust?: TrustDecision,
  signal?: AbortSignal,
): Promise<PresentedBriefing> {
  // Sizes come from the snapshot's labels (#152); only configuration is read here.
  const collected = await collectLabelEstimationInput(snapshot.repository, estimationRuntime);
  // Locally generated configuration diagnostics may name local directories; a remote front end
  // rewrites only these strings, never GitHub-authored evidence. The CLI passes no rewriter.
  const estimation = redactDiagnostic
    ? {
        ...collected,
        unavailable: collected.unavailable && redactDiagnostic(collected.unavailable),
        findings: collected.findings.map((finding) => ({
          ...finding,
          detail: redactDiagnostic(finding.detail),
          next: finding.next.map(redactDiagnostic),
        })),
      }
    : collected;
  // One shared paired-facts read per snapshot (#247); without `trust` provenance is unknown.
  const impactStatus = await metricStatus(impactMetric, snapshot.repository, estimationRuntime);
  const assessments = await readSnapshotAssessments(snapshot, {
    complexity: collected.status,
    impact: impactStatus,
    trust,
    platform: options.platform,
    signal,
  });
  const expanded = briefing(
    snapshot,
    options.full
      ? { ...options, estimation, assessments }
      : {
          ...options,
          estimation,
          assessments,
          limit: Math.max(snapshot.issues.length + snapshot.pullRequests.length, 1) * 20,
        },
    now,
  );
  const built = options.full
    ? null
    : compactBriefing(snapshot, options, expanded, assessments, impactStatus);
  // Additive: the process object is only present when the front end resolved a guide setting.
  const compact = built && options.process ? { ...built, process: options.process } : built;
  const report = compact ?? expanded;
  return {
    report,
    text: compact ? compactText(compact, options.maxChars) : textReport(expanded),
    complete: report.completeness.complete,
  };
}

/** GitHub-facing boundaries of a live read; tests inject credential-free fakes. */
export interface ReadRuntime {
  collect: typeof collect;
  dependencyReport: typeof dependencyReport;
  estimation?: LabelEstimationRuntime;
  /**
   * Read-only REST boundary for provenance authors' permissions (#212, #247), cached per run.
   * Absent means no permission requests: trusted provenance is then reported as unknown.
   */
  rest?: Rest;
  /** Clock for freshness ages; defaults to the system clock. */
  now?: () => Date;
  /** Rewrites locally generated diagnostics (not GitHub evidence) for remote consumers. */
  redactDiagnostic?: (text: string) => string;
  /** Filesystem, git and working directory for the workflow-guide setting (#71). */
  guide?: GuideRuntime;
}

/** Live read request for a briefing or one issue's intake. */
export interface BriefingRequest {
  repository: string;
  agent?: string;
  issue?: number;
  since?: string;
  limit: number;
  maxChars: number;
  /** Registered role view (#260): the same blended queue as CLI --role. */
  role?: string;
  /** Pickup order (#260), as CLI --order. */
  order?: PickupOrder;
  /** Cancellation: stops collection and terminates running gh child processes. */
  signal?: AbortSignal;
}

/** A live briefing read: either a report, or a diagnosis of an unavailable issue. */
export type BriefingRead =
  | ({ kind: "report" } & PresentedBriefing)
  | { kind: "unavailable"; diagnosis: IssueDiagnosis; text: string };

/** Text for an issue that is transferred, missing or inaccessible (shared with the CLI). */
export function unavailableText(d: IssueDiagnosis): string {
  return `Issue #${d.number} in ${d.repository}: ${d.state.toUpperCase()}\n${d.detail}\n${d.state === "moved" ? `Destination: ${String(d.destination.url)} (use --include-transferred to read it)\n` : ""}Next: ${d.next}\n`;
}

/** Collect live evidence and present the compact briefing, focused on `issue` if given. */
export async function readBriefing(
  runtime: ReadRuntime,
  request: BriefingRequest,
): Promise<BriefingRead> {
  let snapshot: Snapshot;
  try {
    snapshot = await runtime.collect(request.repository, {
      issue: request.issue,
      since: request.since,
      signal: request.signal,
    });
  } catch (error) {
    if (!(error instanceof IssueUnavailable)) throw error;
    return {
      kind: "unavailable",
      diagnosis: error.diagnosis,
      text: unavailableText(error.diagnosis),
    };
  }
  const setting = await resolveGuideSetting(request.repository, undefined, runtime.guide);
  const redact = runtime.redactDiagnostic;
  const process = briefingProcess(
    redact ? { ...setting, diagnostics: setting.diagnostics.map(redact) } : setting,
  );
  const presented = await presentBriefing(
    snapshot,
    {
      limit: request.limit,
      maxChars: request.maxChars,
      agent: request.agent,
      issue: request.issue,
      ...(request.role ? { role: request.role } : {}),
      ...(request.order ? { order: request.order } : {}),
      process,
    },
    runtime.estimation,
    runtime.now?.(),
    runtime.redactDiagnostic,
    runtime.rest
      ? markerTrust(permissionLookup(request.repository, runtime.rest, request.signal))
      : undefined,
    request.signal,
  );
  return { kind: "report", ...presented };
}

/** Read native dependencies of one issue, with its text rendering. */
export async function readDependencies(
  runtime: ReadRuntime,
  repository: string,
  number: number,
  tree: boolean,
  signal?: AbortSignal,
): Promise<{ report: DependencyReport; text: string }> {
  const report = await runtime.dependencyReport(repository, number, { tree, signal });
  return { report, text: dependencyText(report) };
}
