/**
 * `estimate N --size S --rationale TEXT` (#152, doc/design/complexity-estimation.md
 * "Recording and revising an estimate").
 *
 * Records a complexity size as the repository issue label `complexity:S` and documents its
 * provenance in an issue comment carrying a versioned machine-readable marker (v2, label-backed;
 * no field IDs). The requested label is created only when the repository lacks it; existing
 * definitions are reused unchanged. Other recognized size labels on the ticket are removed and
 * every unrelated label is preserved: labels are added and removed individually, never replaced
 * from a snapshot.
 *
 * Only a justification of the assigned size is required. Replacing an earlier (or conflicting)
 * estimate needs no permission or explanation of the earlier reasoning; `--replace OLD` is an
 * optional caller guard. Fresh facts are re-read immediately before writing, and the final label
 * set is verified afterwards. Label creation, label changes and the comment are separate remote
 * operations: a failure part-way is reported as partial, never rolled back, and a retry of the
 * same command completes it without duplicating the provenance comment.
 *
 * `--replace-invalid` (#178) also removes `complexity:*` labels outside the recognized sizes, and
 * the provenance lists those it observed; without it they are refused, never guessed.
 *
 * Estimating never claims, unblocks, changes readiness, splits or re-ranks a ticket. Missing
 * identity is recorded as null, never inferred from the GitHub login.
 */

import { parseArgs } from "node:util";
import { COMPLEXITY_SIZES, complexityGuidance } from "./complexity.js";
import type { ComplexitySize } from "./complexity.js";
import { classifyMetricLabels, metricLabelName, metricLabelSize } from "./complexitylabels.js";
import type { Comment } from "./claims.js";
import type { TrustDecision } from "./delivery.js";
import { COMPLEXITY_LABEL_COLOR, METRICS, complexityMetric, impactMetric } from "./metrics.js";
import type { EstimateMetric, MetricDescriptor } from "./metrics.js";
import {
  ConfigError,
  loadConfig,
  nodeFileSystem,
  nodeGit,
  resolveRepositoryTarget,
  settingFor,
} from "./config/config.js";
import type { ConfigFileSystem, GitRunner } from "./config/config.js";
import { ghGraphqlApi, isRecord, prop } from "./github/github.js";
import type { GraphqlAnswer, GraphqlApi } from "./github/github.js";

export const estimateUsage = `Usage: pdb estimate N [--metric complexity|impact] --size SIZE --rationale TEXT
         [--assumption TEXT]... [--reference REF]... [--agent NAME] [--replace SIZE]
         [--replace-invalid] [--json] [--repo owner/name]
       pdb estimate --help [--metric complexity|impact] [--json]
(From a source checkout, use npm run pdb -- estimate ...)
Record a complexity size for issue N as the label complexity:SIZE, with its provenance in an
issue comment (marker github-triage:complexity-estimate v2).
  --metric METRIC       complexity (default; effort) or impact (judged benefit, recorded as
                        impact:SIZE with marker github-triage:impact-estimate v1). The same
                        rules apply to each metric; neither touches the other's labels.
  --size SIZE           One of ${COMPLEXITY_SIZES.join(", ")} (an unestimated ticket has no size label)
  --rationale TEXT      Required: why this size; which dimensions triggered the band (<= 1000 chars).
                        Justify the size you assign; earlier estimates need no explanation.
  --assumption TEXT     Repeatable: stated conditions, e.g. "blocker #B supplies the API;
                        waiting excluded" — sizing a blocked ticket does not unblock it
  --reference REF       Repeatable reference anchor: #N, owner/name#N or an https URL
  --agent NAME          Estimator identity to record; omitted means null (never inferred)
  --replace SIZE        Optional guard: refuse unless the ticket still carries this size
  --replace-invalid     Also remove complexity: labels that are not a recognized size (e.g.
                        complexity:huge); they are listed in the provenance. Without it they
                        are refused, never guessed.
  --json                Versioned structured output (kind complexity-estimate or impact-estimate)
  --repo owner/name     Refuse unless this checkout is that repository
Creates the requested label only if the repository lacks it (existing labels are reused as-is),
removes other complexity size labels from the ticket and preserves every other label.
Also recorded: observed previous size(s), repository revision (git HEAD) and guidance version ${complexityGuidance.guidanceVersion}.
Never claims, unblocks, changes readiness, splits or re-ranks.
Same size and provenance again: unchanged, nothing written. Retrying after a partial write
completes only what is missing.
Exit: 0 recorded or unchanged; 2 disabled, partial write, conflicting or unreadable result, or
labels/history unreadable (retry); 1 invalid arguments, refused (stale guard, concurrent change,
unrecognized complexity label without --replace-invalid) or API denial.`;

export interface EstimateRuntime {
  readonly fs?: ConfigFileSystem;
  readonly git?: GitRunner;
  readonly cwd?: string;
  /** The authenticated gh GraphQL boundary (production: gh api graphql). */
  readonly api?: GraphqlApi;
  readonly now?: () => Date;
  /**
   * Impact provenance authority (#215 rule) for the resolved repository: only a comment whose
   * author and any editor are trusted counts as a recorded impact estimate. The CLI supplies the
   * #212 rule over a per-run permission cache; without it every impact marker is unverified (never
   * trusted). Complexity provenance is read without a trust check, as before (#269).
   */
  readonly trust?: (repository: string) => TrustDecision;
}

/** Label-backed provenance stored in the v2 marker comment. */
export interface LabelEstimateProvenance {
  readonly schemaVersion: 2;
  readonly kind: "complexity-estimate";
  readonly storage: "labels";
  readonly size: ComplexitySize;
  /** Every recognized size observed on the ticket before this estimate (scale order). */
  readonly previous: readonly ComplexitySize[];
  readonly rationale: string;
  readonly assumptions: readonly string[];
  readonly references: readonly string[];
  readonly estimator: string | null;
  readonly revision: string | null;
  readonly guidanceVersion: number;
  readonly recordedAt: string;
  /** #178: invalid `complexity:*` labels this run observed and removed (--replace-invalid). */
  readonly replacedInvalid?: readonly string[];
}

/** Label-backed impact provenance stored in the v1 impact marker comment (#245). */
export interface ImpactEstimateProvenance extends Omit<
  LabelEstimateProvenance,
  "schemaVersion" | "kind"
> {
  readonly schemaVersion: 1;
  readonly kind: "impact-estimate";
}

/** Either metric's provenance record. */
export type MetricProvenance = LabelEstimateProvenance | ImpactEstimateProvenance;

const markerPattern = (d: MetricDescriptor): RegExp =>
  new RegExp(`<!-- ${d.marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (\\{.*?\\}) -->`, "s");

/** JSON safe inside an HTML comment: no "--" or ">" can terminate it early. */
const commentSafe = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/-/g, "\\u002d");

export function provenanceComment(p: MetricProvenance): string {
  const d = p.kind === "impact-estimate" ? impactMetric : complexityMetric;
  const title = d === impactMetric ? "Impact" : "Complexity";
  const lines = [
    `<!-- ${d.marker} ${commentSafe(p)} -->`,
    `**${title} estimate: ${p.size}**${p.previous.length ? ` (was ${p.previous.join(", ")})` : ""} — recorded with pdb, guidance version ${p.guidanceVersion}.`,
    "",
    `Rationale: ${p.rationale}`,
  ];
  if (p.assumptions.length) lines.push("", "Assumptions:", ...p.assumptions.map((a) => `- ${a}`));
  if (p.references.length) lines.push("", `Reference anchors: ${p.references.join(", ")}`);
  if (p.replacedInvalid?.length)
    lines.push("", `Replaced invalid ${d.metric} label(s): ${p.replacedInvalid.join(", ")}`);
  lines.push(
    "",
    `Estimator: ${p.estimator ?? "not given"} · Revision: ${p.revision ?? "unknown"}`,
    "",
    `The label ${metricLabelName(d, p.size)} is the current ${d === impactMetric ? "benefit estimate" : "size"}; this comment records why. Estimating does not claim, unblock or re-rank this ticket.`,
  );
  return lines.join("\n");
}

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const nullableString = (value: unknown): boolean => value === null || typeof value === "string";
/** An ISO-8601 instant that `Date.parse` accepts; missing or unparsable is malformed. */
const validInstant = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));

/**
 * Impact-only required provenance fields (doc/design/impact-estimation.md "Provenance"): a
 * malformed timestamp, guidance version or provenance field makes the whole record malformed,
 * so freshness is never judged from unavailable evidence. Complexity keeps its existing
 * compatibility behaviour.
 */
const validImpactFields = (value: Record<string, unknown>): boolean =>
  validInstant(value.recordedAt) &&
  typeof value.guidanceVersion === "number" &&
  Number.isInteger(value.guidanceVersion) &&
  value.guidanceVersion >= 0 &&
  nullableString(value.estimator) &&
  nullableString(value.revision) &&
  (value.replacedInvalid === undefined || strings(value.replacedInvalid));

/** Parse a v2 (label-backed) marker comment; anything malformed is ignored, never trusted. */
export function parseLabelProvenance(body: string): LabelEstimateProvenance | null {
  return parseMetricProvenance(complexityMetric, body) as LabelEstimateProvenance | null;
}

/** Parse a v1 impact marker comment; anything malformed is ignored, never trusted. */
export function parseImpactProvenance(body: string): ImpactEstimateProvenance | null {
  return parseMetricProvenance(impactMetric, body) as ImpactEstimateProvenance | null;
}

/**
 * Parse one metric's marker comment. Markers are metric-exclusive: a complexity parser never
 * accepts an impact marker and vice versa. Impact accepts only its known schema version.
 */
export function parseMetricProvenance(d: MetricDescriptor, body: string): MetricProvenance | null {
  const match = markerPattern(d).exec(body);
  if (!match) return null;
  try {
    const value: unknown = JSON.parse(match[1]!);
    if (
      isRecord(value) &&
      value.kind === d.provenanceKind &&
      (d === complexityMetric || value.schemaVersion === d.provenanceSchemaVersion) &&
      value.storage === "labels" &&
      COMPLEXITY_SIZES.includes(value.size as ComplexitySize) &&
      typeof value.rationale === "string" &&
      strings(value.previous) &&
      strings(value.assumptions) &&
      strings(value.references) &&
      (d === complexityMetric || validImpactFields(value))
    )
      return value as unknown as MetricProvenance;
  } catch {
    // Not ours or corrupted.
  }
  return null;
}

class Refusal extends Error {
  constructor(
    readonly code: string,
    readonly status: string,
    readonly exitCode: number,
    message: string,
    readonly recovery: string,
  ) {
    super(message);
  }
}

interface LabelNode {
  readonly id: string;
  readonly name: string;
}

interface IssueState {
  readonly repositoryId: string;
  readonly issueId: string;
  readonly state: string;
  /** The repository's definition of the requested label, or null when it does not exist. */
  readonly definition: LabelNode | null;
  /** All labels on the ticket (complete: a truncated page is refused). */
  readonly labels: readonly LabelNode[];
  /** Recognized sizes on the ticket, in scale order. */
  readonly sizes: readonly ComplexitySize[];
  /** Labels with the complexity prefix but no recognized size (allowed only with the flag). */
  readonly invalid: readonly LabelNode[];
  readonly provenance: MetricProvenance | null;
  /** Impact only: the issue description's last edit time (null: never edited). */
  readonly edited?: string | null;
}

/** Impact reads comment author/edit evidence (#215) and the description edit time (staleness). */
const commentNode = (d: MetricDescriptor) =>
  d === complexityMetric
    ? "body"
    : "body createdAt author { __typename login } lastEditedAt includesCreatedEdit editor { __typename login }";
const issueQuery = (
  number: number,
  d: MetricDescriptor = complexityMetric,
) => `query($owner: String!, $name: String!, $label: String!) {
  repository(owner: $owner, name: $name) { id label(name: $label) { id name }
    issue(number: ${number}) { id state ${d === complexityMetric ? "" : "lastEditedAt "}labels(first: 100) { pageInfo { hasNextPage } nodes { id name } }
      comments(last: 100) { pageInfo { hasPreviousPage startCursor } nodes { ${commentNode(d)} } } } } }`;

/** Older comment pages, newest first, read only until the newest valid marker is found. */
const commentsPageQuery = (
  number: number,
  d: MetricDescriptor = complexityMetric,
) => `query($owner: String!, $name: String!, $before: String!) {
  repository(owner: $owner, name: $name) { issue(number: ${number}) {
    comments(last: 100, before: $before) { pageInfo { hasPreviousPage startCursor } nodes { ${commentNode(d)} } } } } }`;

/** Bound on extra comment pages (100 comments each) searched for an older marker. */
export const MAX_COMMENT_PAGES = 20;

/** Neutral colour for a created size label; existing definitions are never restyled. */
export { COMPLEXITY_LABEL_COLOR };

const CREATE_LABEL = `mutation($repository: ID!, $name: String!, $color: String!, $description: String!) {
  createLabel(input: { repositoryId: $repository, name: $name, color: $color, description: $description }) {
    label { id name } } }`;
const ADD_LABEL = `mutation($issue: ID!, $label: ID!) {
  addLabelsToLabelable(input: { labelableId: $issue, labelIds: [$label] }) { clientMutationId } }`;
const REMOVE_LABEL = `mutation($issue: ID!, $label: ID!) {
  removeLabelsFromLabelable(input: { labelableId: $issue, labelIds: [$label] }) { clientMutationId } }`;
const ADD_COMMENT = `mutation($issue: ID!, $body: String!) {
  addComment(input: { subjectId: $issue, body: $body }) { commentEdge { node { url } } } }`;

const denied = (answer: GraphqlAnswer): string | null => {
  const error = answer.errors[0];
  if (!error) return null;
  return `${error.type ? `${error.type}: ` : ""}${error.message ?? "GitHub returned an error"}`;
};

/** A remote call whose transport failure becomes an errored answer, never a thrown secret. */
const safely = (call: Promise<GraphqlAnswer>): Promise<GraphqlAnswer> =>
  call.catch((error: unknown) => ({ data: null, errors: [{ message: (error as Error).message }] }));

const unknownProvenance = (number: number, why: string) =>
  new Refusal(
    "provenance-unavailable",
    "failed:unknown",
    2,
    `The estimate history of #${number} could not be read completely (${why}); nothing was written.`,
    "Retry the same command; missing comment history is never treated as no provenance.",
  );

/** Result of scanning comments newest-first for the newest relevant provenance marker. */
export type ProvenanceScan<N> =
  | {
      readonly status: "trusted";
      readonly provenance: MetricProvenance;
      readonly node: N;
      readonly ignored: string[];
    }
  | { readonly status: "unknown"; readonly why: string; readonly ignored: string[] }
  | { readonly status: "none"; readonly ignored: string[] };

/**
 * The newest relevant provenance among comment nodes (oldest-first order), shared by the writer
 * and the trusted-provenance reader so they cannot diverge (#245). With a trust decision
 * (impact), a confirmed-untrusted marker is skipped (noted in `ignored`) and the search goes on;
 * a marker whose author or editor authority is unknown stops the search as `unknown`, so an older
 * trusted record is never accepted behind it. Without a trust decision (complexity, #269) the
 * newest valid marker is taken as before.
 */
export async function scanProvenance<N>(
  d: MetricDescriptor,
  nodes: readonly N[],
  trust: TrustDecision | undefined,
): Promise<ProvenanceScan<N>> {
  const ignored: string[] = [];
  for (const node of [...nodes].reverse()) {
    const provenance = parseMetricProvenance(d, text(prop(node, "body")));
    if (!provenance) continue;
    const authority = trust
      ? await trust(node as unknown as Comment)
      : { status: "trusted" as const };
    if (authority.status === "trusted") return { status: "trusted", provenance, node, ignored };
    if (authority.status === "unknown") return { status: "unknown", why: authority.why, ignored };
    ignored.push(`untrusted provenance ignored (${authority.why})`);
  }
  return { status: "none", ignored };
}

const nodesOf = (comments: unknown): unknown[] => {
  const nodes = prop(comments, "nodes");
  return Array.isArray(nodes) ? nodes : [];
};

/** Cursor for older comments, or null when history is exhausted; throws when unreadable. */
function olderCursor(comments: unknown, number: number): string | null {
  if (!Array.isArray(prop(comments, "nodes"))) throw unknownProvenance(number, "comments missing");
  const more = prop(comments, "pageInfo", "hasPreviousPage");
  if (more === false) return null;
  const cursor = prop(comments, "pageInfo", "startCursor");
  if (more !== true || typeof cursor !== "string" || !cursor)
    throw unknownProvenance(number, "comment pagination missing");
  return cursor;
}

const labelNode = (value: unknown): LabelNode | null => {
  const id = prop(value, "id");
  const name = prop(value, "name");
  return typeof id === "string" && typeof name === "string" ? { id, name } : null;
};

/** Parse one issue read; incomplete or errored label evidence is unknown, never "no size". */
function readIssue(
  answer: GraphqlAnswer,
  number: number,
  size: ComplexitySize,
  replaceInvalid: boolean,
  d: MetricDescriptor,
): IssueState & { comments: unknown } {
  const repository = prop(answer.data, "repository");
  const issue = prop(repository, "issue");
  const repositoryId = prop(repository, "id");
  if (!isRecord(issue) || typeof issue.id !== "string" || typeof repositoryId !== "string")
    throw new Refusal(
      "issue-unavailable",
      "failed",
      1,
      `Issue #${number} could not be read${denied(answer) ? ` (${denied(answer)})` : ""}.`,
      "Check the number, gh auth status and access; nothing was written.",
    );
  const unknown = (why: string) =>
    new Refusal(
      "labels-unavailable",
      "failed:unknown",
      2,
      `The labels of #${number} could not be read completely (${why}); nothing was written.`,
      "Retry the same command; incomplete labels are unknown, never treated as no estimate.",
    );
  if (answer.errors.length) throw unknown(denied(answer) ?? "GitHub returned errors");
  const nodes = prop(issue, "labels", "nodes");
  if (!Array.isArray(nodes)) throw unknown("labels missing from the response");
  const hasNext = prop(issue, "labels", "pageInfo", "hasNextPage");
  if (hasNext !== false) throw unknown("more than 100 labels, or label pagination missing");
  const labels: LabelNode[] = [];
  for (const node of nodes) {
    const parsed = labelNode(node);
    if (!parsed) throw unknown("a label without id or name");
    labels.push(parsed);
  }
  const found = prop(repository, "label");
  const candidate = labelNode(found);
  // GitHub label identity is case-insensitive; accept only a definition naming this size.
  const definition = candidate && metricLabelSize(d, candidate.name) === size ? candidate : null;
  const classification = classifyMetricLabels(d, {
    labels: { nodes: labels, pageInfo: { hasNextPage: false, endCursor: null } },
  });
  if (classification.unrecognized.length && !replaceInvalid)
    throw new Refusal(
      "unrecognized-label",
      "refused:unrecognized",
      1,
      `#${number} carries unrecognized ${d.metric} label(s) ${classification.unrecognized.join(", ")}; only ${COMPLEXITY_SIZES.map((s) => metricLabelName(d, s)).join(", ")} are managed, so nothing was written.`,
      `Read the ticket, choose the size, then re-run with --replace-invalid to remove them while recording it (or remove them yourself with gh issue edit ${number} --remove-label LABEL).`,
    );
  const edited = prop(issue, "lastEditedAt");
  return {
    repositoryId,
    issueId: issue.id,
    state: text(issue.state, "UNKNOWN"),
    definition,
    labels,
    sizes: classification.sizes,
    invalid: labels.filter((l) => classification.unrecognized.includes(l.name)),
    provenance: null,
    ...(d === complexityMetric ? {} : { edited: typeof edited === "string" ? edited : null }),
    comments: prop(issue, "comments"),
  };
}

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;
const sameList = (a: readonly string[] | undefined, b: readonly string[]) =>
  Array.isArray(a) && a.length === b.length && a.every((item, i) => item === b[i]);

const REFERENCE = /^(#[1-9]\d*|[\w.-]+\/[\w.-]+#[1-9]\d*|https:\/\/\S+)$/;
const asSize = (value: string, flag: string): ComplexitySize => {
  const size = value.trim().toUpperCase();
  if (!COMPLEXITY_SIZES.includes(size as ComplexitySize))
    throw new Error(`${flag} must be one of ${COMPLEXITY_SIZES.join(", ")}.`);
  return size as ComplexitySize;
};

/** Run `estimate N ...` (recording). Returns the exit code; output is text or one JSON value. */
export async function runEstimate(
  args: string[],
  output: (text: string) => Promise<void>,
  runtime: EstimateRuntime = {},
): Promise<number> {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        metric: { type: "string" },
        size: { type: "string" },
        rationale: { type: "string" },
        assumption: { type: "string", multiple: true },
        reference: { type: "string", multiple: true },
        agent: { type: "string" },
        replace: { type: "string" },
        "replace-invalid": { type: "boolean" },
        json: { type: "boolean" },
        repo: { type: "string" },
      },
    }));
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${estimateUsage}`);
  }
  if (positionals.length !== 1 || !/^[1-9]\d*$/.test(positionals[0]!))
    throw new Error(estimateUsage);
  if (values.size === undefined)
    throw new Error(
      `--size is required; an unestimated ticket has no size label.\n${estimateUsage}`,
    );
  const metricName = values.metric ?? "complexity";
  if (!Object.hasOwn(METRICS, metricName))
    throw new Error(`--metric must be one of ${Object.keys(METRICS).join(", ")}.`);
  const d = METRICS[metricName as EstimateMetric];
  const impact = d === impactMetric;
  const Title = impact ? "Impact" : "Complexity";
  const none = impact ? "unassessed" : "unestimated";
  const number = Number(positionals[0]);
  const size = asSize(values.size, "--size");
  const replace = values.replace === undefined ? undefined : asSize(values.replace, "--replace");
  const rationale = (values.rationale ?? "").trim();
  if (!rationale) throw new Error(`--rationale is required: say why this size.\n${estimateUsage}`);
  if (rationale.length > 1000) throw new Error("--rationale must be at most 1000 characters.");
  const assumptions = (values.assumption ?? []).map((a) => a.trim()).filter(Boolean);
  const references = (values.reference ?? []).map((r) => r.trim());
  const badReference = references.find((r) => !REFERENCE.test(r));
  if (badReference !== undefined)
    throw new Error(`--reference ${badReference}: use #N, owner/name#N or an https URL.`);
  const estimator = values.agent?.trim() || null;
  const replaceInvalid = !!values["replace-invalid"];
  if (values.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    throw new Error("--repo must be owner/name.");

  const json = !!values.json;
  const fs = runtime.fs ?? nodeFileSystem;
  const git = runtime.git ?? nodeGit;
  const api = runtime.api ?? ghGraphqlApi;
  const label = metricLabelName(d, size);
  const result: Record<string, unknown> = {
    schemaVersion: impact ? 1 : 2,
    kind: d.provenanceKind,
    issue: number,
    size,
    label,
  };
  const lines: string[] = [];
  const finish = async (status: string, code: number) => {
    result.status = status;
    result.boundaries = `Only ${d.metric} size labels and one provenance comment were touched; no claim, blocker, readiness or ranking was changed.`;
    await output(
      json
        ? JSON.stringify(result, null, 2) + "\n"
        : [...lines, `Status: ${status}`].join("\n") + "\n",
    );
    return code;
  };

  try {
    const target = await resolveRepositoryTarget(runtime.cwd ?? process.cwd(), values.repo, git);
    result.repository = target.repository;
    const config = await loadConfig(target.root, fs);
    if (settingFor(config, d.enabledKey).value === false)
      throw new Refusal(
        "disabled",
        "disabled",
        2,
        `${Title} is disabled for ${target.repository} (${d.enabledKey} = false); nothing was recorded.`,
        `Opt in with: pdb config set ${d.enabledKey} true`,
      );
    const trust: TrustDecision | undefined = impact
      ? (runtime.trust?.(target.repository) ??
        (async () => ({ status: "unknown", why: "no trust boundary supplied" })))
      : undefined;

    const [owner, name] = target.repository.split("/") as [string, string];
    const vars = { owner, name, label };
    /** Fresh read, paging comments backward until the newest marker or exhausted history. */
    const read = async (): Promise<IssueState> => {
      const answer = await safely(api.query(issueQuery(number, d), vars));
      const { comments: firstPage, ...first } = readIssue(answer, number, size, replaceInvalid, d);
      // Paging stops at the first relevant marker: trusted (recorded) or unknown authority. An
      // unknown marker leaves `provenance` null, so it never matches and fresh provenance is
      // recorded, exactly where readAssessment reports `unknown` (doc/design/impact-estimation.md).
      let scan = await scanProvenance(d, nodesOf(firstPage), trust);
      let cursor = scan.status === "none" ? olderCursor(firstPage, number) : null;
      let pages = 0;
      while (scan.status === "none" && cursor !== null) {
        if (pages >= MAX_COMMENT_PAGES)
          throw unknownProvenance(number, `more than ${MAX_COMMENT_PAGES + 1} pages of comments`);
        pages += 1;
        const page = await safely(
          api.query(commentsPageQuery(number, d), { owner, name, before: cursor }),
        );
        if (page.errors.length)
          throw unknownProvenance(number, denied(page) ?? "GitHub returned errors");
        const comments = prop(page.data, "repository", "issue", "comments");
        scan = await scanProvenance(d, nodesOf(comments), trust);
        const next = olderCursor(comments, number);
        cursor = scan.status === "none" ? next : null;
      }
      const state: IssueState = {
        ...first,
        provenance: scan.status === "trusted" ? scan.provenance : null,
      };
      return state;
    };
    const onlyTarget = (sizes: readonly ComplexitySize[]) =>
      sizes.length === 1 && sizes[0] === size;
    const invalidNames = (state: IssueState) => state.invalid.map((l) => l.name);

    const before = await read();
    result.previous = before.sizes;
    if (replaceInvalid) result.replacedInvalid = invalidNames(before);
    result.issueState = before.state;
    const revisionText = await git(["rev-parse", "HEAD"], target.root).catch(() => "");
    const revision = /^[0-9a-f]{40}$/.test(revisionText.trim()) ? revisionText.trim() : null;
    const provenance = {
      schemaVersion: d.provenanceSchemaVersion,
      kind: d.provenanceKind,
      storage: "labels",
      size,
      // Record only observed evidence: the sizes this run read, or, on a retry after a partial
      // write (target already applied), the size named by the explicit --replace guard. An older
      // provenance comment is not evidence that this run is repairing it (the label may have
      // been changed by hand since), so it never supplies a previous size.
      previous: onlyTarget(before.sizes) && replace && replace !== size ? [replace] : before.sizes,
      rationale,
      assumptions,
      references,
      estimator,
      revision,
      guidanceVersion: d.guidance.guidanceVersion,
      recordedAt: (runtime.now?.() ?? new Date()).toISOString(),
      // Only invalid labels this run observed; a retry after they were removed records none.
      ...(before.invalid.length ? { replacedInvalid: invalidNames(before) } : {}),
    } as MetricProvenance;
    result.provenance = provenance;
    const retryGuard = before.sizes.filter((observed) => observed !== size);
    const retryHint =
      retryGuard.length === 1
        ? ` with --replace ${retryGuard[0]} so the replaced size is recorded`
        : "";

    lines.push(
      `${Title} estimate for ${target.repository}#${number}: ${before.sizes.join(", ") || none} -> ${size}`,
    );

    // The optional guard: the target already applied (a retry) is not stale.
    if (replace !== undefined && !before.sizes.includes(replace) && !onlyTarget(before.sizes))
      throw new Refusal(
        "stale",
        "refused:stale",
        1,
        `--replace ${replace} is stale: #${number} now carries ${before.sizes.join(", ") || "no size label"}. Nothing was changed.`,
        "Read the current estimate, then decide again (the guard is optional).",
      );

    const recorded = before.provenance;
    /**
     * Impact only: a record is stale when its guidance version is not current or the description
     * was edited after it. An identical stale record is re-recorded, which clears the staleness.
     */
    const stale = (stored: MetricProvenance, state: IssueState) => {
      if (!impact) return false;
      if (stored.guidanceVersion !== d.guidance.guidanceVersion) return true;
      const edited = state.edited ? Date.parse(state.edited) : NaN;
      return edited > Date.parse(stored.recordedAt);
    };
    /**
     * Whether a stored record is this same assessment (size, reasons and estimator, and for impact
     * not stale). Replaced invalid labels are not part of identity: a retry cannot observe them.
     */
    const isThisAssessment = (stored: MetricProvenance | null, state: IssueState) =>
      !!stored &&
      !stale(stored, state) &&
      stored.size === size &&
      stored.rationale === rationale &&
      (stored.estimator ?? null) === estimator &&
      sameList(stored.assumptions, assumptions) &&
      sameList(stored.references, references);
    const provenanceMatches = isThisAssessment(recorded, before);
    if (onlyTarget(before.sizes) && !before.invalid.length && provenanceMatches) {
      // Nothing is written, so report the stored provenance (its real time and revision).
      result.provenance = recorded;
      lines.push("Unchanged: the same size and provenance are already recorded.");
      return await finish("unchanged", 0);
    }

    // Ensure the requested repository label exists; never restyle an existing definition.
    let definition = before.definition;
    result.labelCreated = false;
    if (!definition) {
      const created = await safely(
        api.mutate(CREATE_LABEL, {
          repository: before.repositoryId,
          name: label,
          color: d.labelColor,
          description: `${Title} estimate ${size} (pdb estimate)`,
        }),
      );
      const node = labelNode(prop(created.data, "createLabel", "label"));
      if (node && !created.errors.length) {
        definition = node;
        result.labelCreated = true;
        lines.push(`Created repository label ${node.name}.`);
      } else {
        // An already-exists race is settled by fresh verification, not by the error text.
        definition = (await read()).definition;
        if (!definition)
          throw new Refusal(
            "label-create-denied",
            "failed",
            1,
            `GitHub did not create the repository label ${label} (${denied(created) ?? "no result"}); nothing on #${number} was changed.`,
            `Creating a label needs write access to ${target.repository}. Check gh auth status, or ask a maintainer to create ${label}, then retry.`,
          );
        lines.push(`Reusing repository label ${definition.name} (created concurrently).`);
      }
    }

    // Re-read immediately before changing the ticket: a concurrent estimate or provenance
    // record must not be silently overwritten or contradicted.
    const latest = await read();
    if (
      !sameList(latest.sizes, before.sizes) ||
      !sameList(invalidNames(latest), invalidNames(before)) ||
      JSON.stringify(latest.provenance) !== JSON.stringify(before.provenance)
    )
      throw new Refusal(
        "concurrent-change",
        "refused:stale",
        1,
        !sameList(latest.sizes, before.sizes) ||
          !sameList(invalidNames(latest), invalidNames(before))
          ? `#${number} changed from ${before.sizes.join(", ") || none} to ${latest.sizes.join(", ") || none} while recording; the ticket was not changed.`
          : `#${number} received new estimate provenance while recording; the ticket was not changed.`,
        "Re-run the command after reading the new estimate and its rationale.",
      );

    const added: string[] = [];
    const removed: string[] = [];
    const failed: string[] = [];
    result.labelsAdded = added;
    result.labelsRemoved = removed;
    if (!latest.labels.some((l) => metricLabelSize(d, l.name) === size)) {
      const add = await safely(
        api.mutate(ADD_LABEL, { issue: latest.issueId, label: definition.id }),
      );
      if (add.errors.length || !isRecord(prop(add.data, "addLabelsToLabelable")))
        throw new Refusal(
          "api-denied",
          result.labelCreated ? "partial" : "failed",
          result.labelCreated ? 2 : 1,
          `GitHub did not apply ${definition.name} to #${number} (${denied(add) ?? "no result"}); the ticket's labels were not changed${result.labelCreated ? ", but the repository label was created and is kept" : ""}.`,
          `Check gh auth status and that you may label issues here, then retry the same command${retryHint}.`,
        );
      added.push(definition.name);
    }
    for (const other of latest.labels) {
      const otherSize = metricLabelSize(d, other.name);
      const invalid = latest.invalid.some((l) => l.id === other.id);
      if (!invalid && (!otherSize || otherSize === size)) continue;
      const remove = await safely(
        api.mutate(REMOVE_LABEL, { issue: latest.issueId, label: other.id }),
      );
      if (remove.errors.length || !isRecord(prop(remove.data, "removeLabelsFromLabelable")))
        failed.push(`${other.name} (${denied(remove) ?? "no result"})`);
      else removed.push(other.name);
    }
    if (added.length || removed.length)
      lines.push(
        `Labels: ${[...added.map((l) => `+${l}`), ...removed.map((l) => `-${l}`)].join(" ")}.`,
      );

    // Verify the resulting facts; a contradictory or unreadable final state is not success.
    let final: IssueState | null = null;
    try {
      final = await read();
    } catch (caught) {
      if (!(caught instanceof Refusal)) throw caught;
    }
    result.final = final
      ? { sizes: final.sizes, invalid: invalidNames(final) }
      : { sizes: null, readable: false };
    if (!final || !onlyTarget(final.sizes) || final.invalid.length) {
      result.provenanceWritten = false;
      const why = failed.length
        ? `removing ${failed.join(", ")} failed`
        : final
          ? `the ticket now carries ${[...final.sizes, ...invalidNames(final)].join(", ") || "no size label"} (a concurrent change?)`
          : "the final labels could not be read";
      result.recovery = `Inspect #${number}, then re-run the same command${retryHint}; nothing is rolled back.`;
      lines.push(
        `Partial: the size is not verified as ${size} alone: ${why}. No provenance comment was written.`,
        String(result.recovery),
      );
      return await finish(final ? (failed.length ? "partial" : "conflict") : "unknown", 2);
    }

    // Another invocation may have finished an assessment between the pre-write check and this
    // final read. A new record that is this same assessment means it is already recorded (do not
    // duplicate it); a different one is a concurrent estimate this run must not talk over.
    if (JSON.stringify(final.provenance ?? null) !== JSON.stringify(recorded ?? null)) {
      if (isThisAssessment(final.provenance, final)) {
        result.provenance = final.provenance;
        result.provenanceWritten = false;
        lines.push("Already recorded: a concurrent run completed this same assessment.");
        return await finish("unchanged", 0);
      }
      result.provenanceWritten = false;
      result.recovery = `Read the new estimate on #${number} and its rationale, then decide whether to estimate again.`;
      lines.push(
        `Conflict: another estimate was recorded on #${number} while this one was being written; no provenance comment was added.`,
        String(result.recovery),
      );
      return await finish("conflict", 2);
    }

    const comment = await safely(
      api.mutate(ADD_COMMENT, { issue: latest.issueId, body: provenanceComment(provenance) }),
    );
    const url = prop(comment.data, "addComment", "commentEdge", "node", "url");
    if (typeof url !== "string") {
      result.provenanceWritten = false;
      result.recovery = `Re-run the same command${retryHint}; the label is kept and only provenance is added.`;
      lines.push(
        `Partial: #${number} carries ${label} but the provenance comment failed (${denied(comment) ?? "no result"}).`,
        String(result.recovery),
      );
      return await finish("partial", 2);
    }
    result.provenanceWritten = true;
    result.provenanceUrl = url;
    lines.push(`Provenance: ${url}`);
    return await finish("recorded", 0);
  } catch (caught) {
    if (caught instanceof ConfigError) {
      if (!json) throw new Error(`${caught.message}\n${caught.recovery}`, { cause: caught });
      Object.assign(result, {
        code: caught.code,
        message: caught.message,
        recovery: caught.recovery,
      });
      return finish("failed", 1);
    }
    if (!(caught instanceof Refusal)) throw caught;
    Object.assign(result, {
      code: caught.code,
      message: caught.message,
      recovery: caught.recovery,
    });
    lines.push(caught.message, caught.recovery);
    return finish(caught.status, caught.exitCode);
  }
}
