/**
 * Transport-neutral read service shared by the CLI and the MCP adapter (doc/design/mcp.md).
 *
 * Both front ends call these functions directly; neither runs the other in a subprocess or
 * parses terminal text. Only read operations live here: mutation planning and application stay
 * in their own modules and are never reachable through this service.
 */
import { collect, IssueUnavailable } from "./github.js";
import type { IssueDiagnosis } from "./github.js";
import { dependencyReport, dependencyText } from "./dependencies.js";
import type { DependencyReport } from "./dependencies.js";
import { compactBriefing, compactText } from "./compact.js";
import { briefing, textReport } from "./briefing.js";
import type { BriefingOptions } from "./briefing.js";
import { collectEstimationInput } from "./estimation.js";
import type { EstimationRuntime } from "./estimation.js";
import type { Snapshot } from "./types.js";

/** Presentation options for a collected snapshot, as the CLI's briefing flags express them. */
export interface PresentOptions extends Omit<BriefingOptions, "estimation"> {
  /** Expanded version-1 report instead of the compact briefing. */
  full?: boolean;
  /** Compact text budget. */
  maxChars: number;
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
  estimationRuntime?: EstimationRuntime,
  now: Date = new Date(),
): Promise<PresentedBriefing> {
  const estimation = await collectEstimationInput(
    snapshot.repository,
    { offline: !!options.offline },
    estimationRuntime,
  );
  const expanded = briefing(
    snapshot,
    options.full
      ? { ...options, estimation }
      : {
          ...options,
          estimation,
          limit: Math.max(snapshot.issues.length + snapshot.pullRequests.length, 1) * 20,
        },
    now,
  );
  const compact = options.full ? null : compactBriefing(snapshot, options, expanded);
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
  estimation?: EstimationRuntime;
  /** Clock for freshness ages; defaults to the system clock. */
  now?: () => Date;
}

/** Live read request for a briefing or one issue's intake. */
export interface BriefingRequest {
  repository: string;
  agent?: string;
  issue?: number;
  since?: string;
  limit: number;
  maxChars: number;
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
    });
  } catch (error) {
    if (!(error instanceof IssueUnavailable)) throw error;
    return {
      kind: "unavailable",
      diagnosis: error.diagnosis,
      text: unavailableText(error.diagnosis),
    };
  }
  const presented = await presentBriefing(
    snapshot,
    {
      limit: request.limit,
      maxChars: request.maxChars,
      agent: request.agent,
      issue: request.issue,
    },
    runtime.estimation,
    runtime.now?.(),
  );
  return { kind: "report", ...presented };
}

/** Read native dependencies of one issue, with its text rendering. */
export async function readDependencies(
  runtime: ReadRuntime,
  repository: string,
  number: number,
  tree: boolean,
): Promise<{ report: DependencyReport; text: string }> {
  const report = await runtime.dependencyReport(repository, number, { tree });
  return { report, text: dependencyText(report) };
}
