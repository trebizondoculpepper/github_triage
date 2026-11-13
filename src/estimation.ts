/**
 * Optional implementer estimation queue and briefing visibility (#122).
 * Contract: doc/design/complexity-estimation.md "Estimation as implementer work" and
 * "Repository setup and configuration diagnostics".
 *
 * Estimation eligibility is separate from implementation eligibility: a blocked ticket can be
 * sized while staying ineligible for pickup. The queue holds unestimated and meaningfully stale
 * estimates; it is presented after higher-priority work unless explicitly requested, acquires
 * no claim and reserves nothing. Disabled complexity suppresses it; a missing field mapping is
 * a configuration finding, not an empty queue. A native value that could not be read (offline,
 * FORBIDDEN on user-owned accounts, API errors) is unknown, never "unestimated" or queued.
 *
 * Collection cost: provenance comes from the comments already in the snapshot; native values
 * cost one paginated query over open issues, only when complexity is enabled and mapped, and only
 * after Ticket Doctor's discovery query verifies the mapped field exists and is compatible.
 */
import { COMPLEXITY_SIZES, complexityGuidance } from "./complexity.js";
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
import { diagnoseComplexityConfig } from "./complexitydoctor.js";
import { ghFieldApi } from "./complexitysetup.js";
import type { FieldApi, GraphqlAnswer } from "./complexitysetup.js";
import { parseProvenance } from "./estimate.js";
import { prop } from "./github.js";
import { pickupEligibility } from "./ranking.js";
import type { PickupContext } from "./ranking.js";
import type { Issue } from "./types.js";

export interface EstimationRuntime {
  readonly fs?: ConfigFileSystem;
  readonly git?: GitRunner;
  readonly cwd?: string;
  readonly api?: FieldApi;
}

export type EstimationStatus =
  | "available"
  | "disabled"
  | "setup-required"
  | "missing"
  | "incompatible"
  | "inaccessible"
  | "unsupported"
  | "unknown";

export interface EstimationFinding {
  rule: string;
  detail: string;
  /** Delivered commands only. */
  next: string[];
}

/** Collected inputs: configuration state and native values (by issue number). */
export interface EstimationInput {
  status: EstimationStatus;
  fieldId: string | null;
  /** Read native values: null means read and unset. A missing key means unknown. */
  values: ReadonlyMap<number, ComplexitySize | null>;
  /** Why some or all native values are unknown, when they are. */
  unavailable: string | null;
  findings: EstimationFinding[];
}

const SETUP = "github-triage setup complexity";
const DISABLE = "github-triage config set complexity.enabled false";
/** Bound on pages (100 open issues each) of native field values read per briefing. */
export const MAX_VALUE_PAGES = 10;

const valuesQuery = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: 100, after: $cursor) { pageInfo { hasNextPage endCursor }
      nodes { number issueFieldValues(first: 50) { nodes { __typename
        ... on IssueFieldSingleSelectValue { name field { ... on IssueFieldSingleSelect { id } } } } } } } } }`;

const unknownInput = (
  status: EstimationStatus,
  fieldId: string | null,
  unavailable: string,
  findings: EstimationFinding[] = [],
): EstimationInput => ({ status, fieldId, values: new Map(), unavailable, findings });

/** Read configuration and, when enabled and mapped online, native values. Never throws for missing evidence. */
export async function collectEstimationInput(
  repository: string,
  { offline = false }: { offline?: boolean } = {},
  runtime: EstimationRuntime = {},
): Promise<EstimationInput> {
  let config;
  try {
    const target = await resolveRepositoryTarget(
      runtime.cwd ?? process.cwd(),
      repository,
      runtime.git ?? nodeGit,
    );
    config = await loadConfig(target.root, runtime.fs ?? nodeFileSystem);
  } catch (caught) {
    const error = filesystemRefusal(caught) ?? caught;
    if (!(error instanceof ConfigError)) throw error;
    return unknownInput(
      "unknown",
      null,
      `repository configuration not read (${error.message}); complexity state is unknown`,
      [{ rule: "config-unavailable", detail: error.message, next: [error.recovery] }],
    );
  }
  if (settingFor(config, "complexity.enabled").value === false)
    return {
      status: "disabled",
      fieldId: null,
      values: new Map(),
      unavailable: null,
      findings: [],
    };
  const mapped = settingFor(config, "complexity.fieldId").value;
  const fieldId = typeof mapped === "string" && mapped ? mapped : null;
  if (!fieldId)
    return unknownInput("setup-required", null, "no complexity field is mapped", [
      {
        rule: "complexity-field-unmapped",
        detail:
          "Complexity is enabled but complexity.fieldId is not set: estimates cannot be read, so the queue is unavailable (a configuration finding, not an empty queue).",
        next: [SETUP, DISABLE],
      },
    ]);
  if (offline) return unknownInput("unknown", fieldId, "offline: native values were not read");

  // An absent value only means "unset" for a verified, compatible field: a deleted, foreign,
  // inaccessible or incompatible mapping yields no matching values for every issue. Reuse
  // Ticket Doctor's live verification (and its recovery commands) rather than duplicating it.
  const doctor = await diagnoseComplexityConfig(repository, {}, runtime);
  if (doctor.status !== "configured-compatible") {
    const status: EstimationStatus =
      doctor.status === "missing" ||
      doctor.status === "incompatible" ||
      doctor.status === "inaccessible" ||
      doctor.status === "unsupported"
        ? doctor.status
        : doctor.status === "disabled"
          ? "disabled"
          : doctor.status === "unconfigured"
            ? "setup-required"
            : "unknown";
    const findings = doctor.findings.map(({ rule, detail, next }) => ({ rule, detail, next }));
    return unknownInput(
      status,
      fieldId,
      `mapped complexity field ${fieldId} not verified compatible (${doctor.status})`,
      findings,
    );
  }

  const api = runtime.api ?? ghFieldApi;
  const [owner, name] = repository.split("/") as [string, string];
  const values = new Map<number, ComplexitySize | null>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_VALUE_PAGES; page += 1) {
    const vars: Record<string, string> = cursor ? { owner, name, cursor } : { owner, name };
    const answer: GraphqlAnswer = await api
      .query(valuesQuery, vars)
      .catch((error: unknown) => ({ data: null, errors: [{ message: (error as Error).message }] }));
    const issues = prop(answer.data, "repository", "issues");
    const nodes = prop(issues, "nodes");
    if (answer.errors.length || !Array.isArray(nodes)) {
      const error = answer.errors[0];
      const why = error
        ? `${error.type ? `${error.type}: ` : ""}${error.message ?? "GitHub returned an error"}`
        : "issue field values missing from the response";
      return {
        ...unknownInput("unknown", fieldId, `native values unreadable (${why})`),
        values,
      };
    }
    for (const node of nodes) {
      const number = prop(node, "number");
      const fieldValues = prop(node, "issueFieldValues", "nodes");
      if (typeof number !== "number" || !Array.isArray(fieldValues)) continue;
      let size: ComplexitySize | null = null;
      let readable = true;
      for (const value of fieldValues)
        if (prop(value, "field", "id") === fieldId) {
          const text = prop(value, "name");
          if (COMPLEXITY_SIZES.includes(text as ComplexitySize)) size = text as ComplexitySize;
          else readable = false;
        }
      if (readable) values.set(number, size);
    }
    const more = prop(issues, "pageInfo", "hasNextPage");
    const next = prop(issues, "pageInfo", "endCursor");
    if (more !== true)
      return { status: "available", fieldId, values, unavailable: null, findings: [] };
    if (typeof next !== "string" || !next) break;
    cursor = next;
  }
  return {
    status: "available",
    fieldId,
    values,
    unavailable: `native values read for the first ${MAX_VALUE_PAGES * 100} open issues only`,
    findings: [],
  };
}

export type EstimateState = "estimated" | "unestimated" | "stale" | "unknown";

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
  /** Native field value; null when unset or unknown (see state). */
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
  /** True when the caller asked to estimate (--estimate): the queue is presented first. */
  requested: boolean;
  fieldId: string | null;
  guidanceVersion: number;
  detail: string;
  findings: EstimationFinding[];
  /** Unestimated and stale tickets, oldest first; null when the queue is unavailable. */
  queue: { total: number; omitted: number; items: EstimateEntry[] } | null;
  /** Open tickets whose native value could not be read. */
  unknown: number;
  /** Per-ticket state for compact visibility, keyed by URL. */
  entries: EstimateEntry[];
  boundaries: string;
}

/** Newest valid provenance marker for the field; undefined when comment history is incomplete. */
function newestRecord(issue: Issue, fieldId: string | null): RecordedEstimate | null | undefined {
  let found: RecordedEstimate | null = null;
  for (const comment of issue.comments.nodes) {
    const p = parseProvenance(comment.body);
    if (p && (!fieldId || p.fieldId === fieldId))
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

/** Classify every open issue and build the bounded queue. Pure. */
export function estimationReport(
  issues: Issue[],
  input: EstimationInput | undefined,
  options: PickupContext & { limit: number; requested?: boolean },
): EstimationReport {
  const base = {
    requested: !!options.requested,
    fieldId: input?.fieldId ?? null,
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
      entries: [],
    };
  const entries = issues
    .filter((issue) => issue.state === "OPEN")
    .map((issue): EstimateEntry => {
      const known = input.values.has(issue.number);
      const size = input.values.get(issue.number) ?? null;
      const recorded = newestRecord(issue, input.fieldId);
      const reasons: string[] = [];
      let state: EstimateState;
      if (!known || recorded === undefined) {
        state = "unknown";
        reasons.push(
          !known
            ? `native value unknown (${input.unavailable ?? "not read"})`
            : "comment history incomplete; provenance unknown",
        );
      } else if (size === null) {
        state = "unestimated";
        reasons.push("no native complexity value");
      } else {
        state = "estimated";
        if (!recorded) reasons.push("no recorded rationale (value set outside github-triage)");
        else {
          if (recorded.size !== size) {
            state = "stale";
            reasons.push(`native value ${size} differs from recorded estimate ${recorded.size}`);
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
          }
        }
      }
      return {
        number: issue.number,
        title: issue.title,
        url: issue.url,
        createdAt: issue.createdAt,
        size: state === "unknown" ? null : size,
        state,
        recorded: recorded ?? null,
        implementation: pickupEligibility(issue, options).status,
        reasons,
      };
    });
  const unknown = entries.filter((e) => e.state === "unknown").length;
  if (input.status !== "available")
    return {
      ...base,
      status: input.status,
      detail:
        input.status === "setup-required"
          ? "Estimation queue unavailable: no complexity field is mapped (configuration finding)."
          : input.status === "missing" ||
              input.status === "incompatible" ||
              input.status === "inaccessible" ||
              input.status === "unsupported"
            ? `Estimation queue unavailable: ${input.unavailable ?? `complexity field ${input.status}`} (configuration finding, not an empty queue). Unknown is not unestimated.`
            : `Estimation queue unavailable: ${input.unavailable ?? "complexity state unknown"}. Unknown is not unestimated.`,
      queue: null,
      unknown,
      entries,
    };
  const queued = entries
    .filter((e) => e.state === "unestimated" || e.state === "stale")
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number);
  return {
    ...base,
    status: "available",
    detail: `${queued.length} ticket(s) to estimate (unestimated or stale, blocked included)${unknown ? `; ${unknown} unknown (${input.unavailable ?? "unreadable"}), not queued` : ""}.`,
    queue: {
      total: queued.length,
      omitted: Math.max(0, queued.length - options.limit),
      items: queued.slice(0, options.limit),
    },
    unknown,
    entries,
  };
}

/** One compact line describing an entry's size, freshness and assumptions. */
export function estimateLine(e: EstimateEntry): string {
  const r = e.recorded;
  const size =
    e.state === "unknown"
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
      lines.push(
        `#${e.number} ${e.title} — ${estimateLine(e)}\n  github-triage estimate --help; ${e.url}`,
      );
    if (report.queue.omitted) lines.push(`${report.queue.omitted} more omitted; increase --limit.`);
  }
  lines.push(report.boundaries);
  return lines;
}
