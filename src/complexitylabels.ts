/**
 * Shared label-backed complexity classification and prepared read side (#151).
 * Contract: doc/design/complexity-estimation.md "Label representation and collection" and
 * "Estimation as implementer work".
 *
 * Complexity is stored as one of the repository labels `complexity:XS`..`complexity:XXL`.
 * Classification uses only the labels already collected in the snapshot: no extra queries,
 * native fields, account discovery or mapping. With complete label evidence, no recognized size
 * is unestimated, one is estimated and several are a conflict to inspect; a label with the
 * `complexity:` prefix but an unrecognized suffix is also a conflict. A truncated label page is
 * unknown, never unestimated. A conflict never chooses a size.
 *
 * Rollout (#151 -> #152 -> #153): this module is the classifier the label writer (estimate.ts)
 * shares and the reader the production briefing/estimation queue and Ticket Doctor consume. #152
 * switched the writer and those read routes together, so there is never a dual authoritative read
 * or a backend setting; #153 deletes the retired field code.
 */
import { COMPLEXITY_SIZES } from "./complexity.js";
import type { ComplexitySize } from "./complexity.js";
import {
  ConfigError,
  filesystemRefusal,
  loadConfig,
  nodeFileSystem,
  nodeGit,
  resolveRepositoryTarget,
  settingFor,
} from "./config.js";
import type { ConfigFileSystem, GitRunner } from "./config.js";
import { sizeReport } from "./estimation.js";
import type { EstimationFinding, EstimationReport, SizeReading, SizeSource } from "./estimation.js";
import type { PickupContext } from "./ranking.js";
import type { Issue } from "./types.js";

export const COMPLEXITY_LABEL_PREFIX = "complexity:";

/** Canonical label name for a size: lowercase prefix, uppercase size suffix. */
export const complexityLabelName = (size: ComplexitySize): string =>
  `${COMPLEXITY_LABEL_PREFIX}${size}`;

/** The size a label names, compared case-insensitively like GitHub label identity; else null. */
export function complexityLabelSize(name: string): ComplexitySize | null {
  const lower = name.toLowerCase();
  if (!lower.startsWith(COMPLEXITY_LABEL_PREFIX)) return null;
  const suffix = name.slice(COMPLEXITY_LABEL_PREFIX.length).toUpperCase();
  return COMPLEXITY_SIZES.includes(suffix as ComplexitySize) ? (suffix as ComplexitySize) : null;
}

/** Whether a label carries the complexity prefix (recognized size or not). */
export const isComplexityLabel = (name: string): boolean =>
  name.toLowerCase().startsWith(COMPLEXITY_LABEL_PREFIX);

export type LabelClassificationState = "estimated" | "unestimated" | "conflicting" | "unknown";

export interface LabelClassification {
  state: LabelClassificationState;
  /** The size, only when exactly one recognized label and complete evidence. */
  size: ComplexitySize | null;
  /** Distinct recognized sizes observed, in scale order. */
  sizes: ComplexitySize[];
  /** Observed recognized size labels, as spelled on the ticket. */
  labels: string[];
  /** Observed `complexity:` labels whose suffix is not a recognized size. */
  unrecognized: string[];
  /** False when the label collection was truncated. */
  complete: boolean;
  detail: string;
}

/** Classify one issue's current size from its collected labels. Pure; the writer shares it. */
export function classifyComplexityLabels(issue: Pick<Issue, "labels">): LabelClassification {
  const complete = !issue.labels.pageInfo.hasNextPage;
  const labels: string[] = [];
  const unrecognized: string[] = [];
  const found = new Set<ComplexitySize>();
  for (const { name } of issue.labels.nodes) {
    const size = complexityLabelSize(name);
    if (size) {
      labels.push(name);
      found.add(size);
    } else if (isComplexityLabel(name)) unrecognized.push(name);
  }
  const sizes = COMPLEXITY_SIZES.filter((size) => found.has(size));
  const base = { sizes, labels, unrecognized, complete };
  // Evidence of a conflict is definite even on a truncated page; absence is not.
  if (sizes.length > 1 || unrecognized.length)
    return {
      ...base,
      state: "conflicting",
      size: null,
      detail: [
        ...(sizes.length > 1 ? [`several size labels (${labels.join(", ")})`] : []),
        ...(unrecognized.length
          ? [`unrecognized complexity label(s) ${unrecognized.join(", ")}`]
          : []),
      ]
        .join("; ")
        .concat("; inspect, no size is chosen"),
    };
  if (!complete)
    return {
      ...base,
      state: "unknown",
      size: null,
      detail: "labels truncated; complexity unknown, not unestimated",
    };
  const [size] = sizes;
  return size
    ? { ...base, state: "estimated", size, detail: `size label ${labels[0]}` }
    : { ...base, state: "unestimated", size: null, detail: "no complexity size label" };
}

/** Classification as a size reading for the shared report builder. */
export function labelSizeReading(issue: Pick<Issue, "labels">): SizeReading {
  const c = classifyComplexityLabels(issue);
  if (c.state === "conflicting") return { kind: "conflict", sizes: c.sizes, reason: c.detail };
  if (c.state === "unknown") return { kind: "unknown", reason: c.detail };
  return { kind: "known", size: c.size };
}

/** Prepared label reader inputs: configuration only; sizes come from snapshot labels. */
export interface LabelEstimationInput {
  status: "available" | "disabled" | "unknown";
  unavailable: string | null;
  findings: EstimationFinding[];
}

export interface LabelEstimationRuntime {
  readonly fs?: ConfigFileSystem;
  readonly git?: GitRunner;
  readonly cwd?: string;
}

/**
 * Read only `complexity.enabled` (default on, explicit opt-out). Never queries GitHub, never
 * creates labels; missing label definitions are normal. Offline makes no difference because
 * label evidence already arrives in the snapshot.
 */
export async function collectLabelEstimationInput(
  repository: string,
  runtime: LabelEstimationRuntime = {},
): Promise<LabelEstimationInput> {
  try {
    const target = await resolveRepositoryTarget(
      runtime.cwd ?? process.cwd(),
      repository,
      runtime.git ?? nodeGit,
    );
    const config = await loadConfig(target.root, runtime.fs ?? nodeFileSystem);
    return settingFor(config, "complexity.enabled").value === false
      ? { status: "disabled", unavailable: null, findings: [] }
      : { status: "available", unavailable: null, findings: [] };
  } catch (caught) {
    const error = filesystemRefusal(caught) ?? caught;
    if (!(error instanceof ConfigError)) throw error;
    return {
      status: "unknown",
      unavailable: `repository configuration not read (${error.message}); complexity state is unknown`,
      findings: [{ rule: "config-unavailable", detail: error.message, next: [error.recovery] }],
    };
  }
}

/** Prepared label-backed estimation report (queue, conflicts, per-ticket visibility). Pure. */
export function labelEstimationReport(
  issues: Issue[],
  input: LabelEstimationInput | undefined,
  options: PickupContext & { limit: number; requested?: boolean },
): EstimationReport {
  const source: SizeSource | undefined = input && {
    status: input.status,
    fieldId: null,
    unavailable: input.unavailable,
    findings: input.findings,
    provenanceFieldId: null,
    evidence: "complexity size label",
    read: labelSizeReading,
  };
  return sizeReport(issues, source, options);
}

/** Ticket Doctor inspection finding for one issue's label evidence; never a repair. */
export interface LabelDoctorFinding {
  kind: "complexity-label-conflict" | "complexity-labels-incomplete";
  certainty: "definite" | "unknown";
  detail: string;
}

/** Conflicts and incomplete label evidence; unestimated tickets are not findings. Pure. */
export function complexityLabelFindings(issue: Pick<Issue, "labels">): LabelDoctorFinding[] {
  const c = classifyComplexityLabels(issue);
  if (c.state === "conflicting")
    return [{ kind: "complexity-label-conflict", certainty: "definite", detail: c.detail }];
  if (c.state === "unknown")
    return [{ kind: "complexity-labels-incomplete", certainty: "unknown", detail: c.detail }];
  return [];
}
