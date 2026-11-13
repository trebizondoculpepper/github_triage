/**
 * `estimate N --size S --rationale TEXT` (#121, doc/design/complexity-estimation.md
 * "Native storage and repository meaning").
 *
 * Records a complexity size in the repository's configured native GitHub issue field and
 * documents its provenance in an issue comment carrying a versioned machine-readable marker.
 * Two remote steps are needed, so a failure after the first is reported as partial, and a
 * retry of the same command repairs it without rewriting the native value.
 *
 * Estimating never claims, unblocks, labels, splits or re-ranks a ticket. Missing identity is
 * recorded as null, never inferred from the GitHub login. A different existing estimate is
 * only replaced when the caller names it with --replace (compare-and-set), and the native
 * value is re-read immediately before writing so a concurrent estimate is not overwritten.
 */

import { parseArgs } from "node:util";
import { COMPLEXITY_SIZES, complexityGuidance } from "./complexity.js";
import type { ComplexitySize } from "./complexity.js";
import {
  ConfigError,
  loadConfig,
  nodeFileSystem,
  nodeGit,
  resolveRepositoryTarget,
  settingFor,
} from "./config.js";
import type { ConfigFileSystem, GitRunner } from "./config.js";
import { classifyField, ghFieldApi } from "./complexitysetup.js";
import type { FieldApi, GraphqlAnswer } from "./complexitysetup.js";
import { isRecord, prop } from "./github.js";

export const estimateUsage = `Usage: github-triage estimate N --size SIZE --rationale TEXT [--assumption TEXT]...
         [--reference REF]... [--agent NAME] [--replace SIZE] [--json] [--repo owner/name]
       github-triage estimate --help [--json]
(From a source checkout, use npm run triage -- estimate ...)
Record a complexity size for issue N in the native issue field mapped by complexity.fieldId,
with its provenance in an issue comment (marker github-triage:complexity-estimate v1).
  --size SIZE           One of ${COMPLEXITY_SIZES.join(", ")} (an unestimated ticket stays unset)
  --rationale TEXT      Required: which dimensions triggered the band (short, <= 1000 chars)
  --assumption TEXT     Repeatable: stated conditions, e.g. "blocker #B supplies the API;
                        waiting excluded" — sizing a blocked ticket does not unblock it
  --reference REF       Repeatable reference anchor: #N, owner/name#N or an https URL
  --agent NAME          Estimator identity to record; omitted means null (never inferred)
  --replace SIZE        Required to change an existing different estimate: the size you read;
                        refused if the issue no longer holds it (stale read)
  --json                Versioned structured output (kind complexity-estimate)
  --repo owner/name     Refuse unless this checkout is that repository
Also recorded: repository revision (git HEAD) and guidance version ${complexityGuidance.guidanceVersion}.
Never claims, unblocks, relabels, splits or re-ranks; no field is ever created (setup complexity).
Same size and provenance again: unchanged, nothing written. Retrying after a partial write
records only the missing provenance.
Exit: 0 recorded or unchanged; 2 disabled, setup required, field inaccessible/incompatible,
partial write, or current value unreadable (retry); 1 invalid arguments, refused (existing/stale estimate), or API denial.`;

export interface EstimateRuntime {
  readonly fs?: ConfigFileSystem;
  readonly git?: GitRunner;
  readonly cwd?: string;
  readonly api?: FieldApi;
  readonly now?: () => Date;
}

/** Versioned provenance stored in the marker comment. */
export interface EstimateProvenance {
  readonly schemaVersion: 1;
  readonly kind: "complexity-estimate";
  readonly fieldId: string;
  readonly size: ComplexitySize;
  readonly previous: ComplexitySize | null;
  readonly rationale: string;
  readonly assumptions: readonly string[];
  readonly references: readonly string[];
  readonly estimator: string | null;
  readonly revision: string | null;
  readonly guidanceVersion: number;
  readonly recordedAt: string;
}

const MARKER = "github-triage:complexity-estimate v1";
const MARKER_PATTERN = /<!-- github-triage:complexity-estimate v1 (\{.*?\}) -->/s;

/** JSON safe inside an HTML comment: no "--" or ">" can terminate it early. */
const commentSafe = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/-/g, "\\u002d");

export function provenanceComment(p: EstimateProvenance): string {
  const lines = [
    `<!-- ${MARKER} ${commentSafe(p)} -->`,
    `**Complexity estimate: ${p.size}**${p.previous ? ` (was ${p.previous})` : ""} — recorded with github-triage, guidance version ${p.guidanceVersion}.`,
    "",
    `Rationale: ${p.rationale}`,
  ];
  if (p.assumptions.length) lines.push("", "Assumptions:", ...p.assumptions.map((a) => `- ${a}`));
  if (p.references.length) lines.push("", `Reference anchors: ${p.references.join(", ")}`);
  lines.push(
    "",
    `Estimator: ${p.estimator ?? "not given"} · Revision: ${p.revision ?? "unknown"}`,
    "",
    "Estimating does not claim, unblock, relabel or re-rank this ticket.",
  );
  return lines.join("\n");
}

/** Parse a marker comment; anything malformed is ignored, never trusted. */
export function parseProvenance(body: string): EstimateProvenance | null {
  const match = MARKER_PATTERN.exec(body);
  if (!match) return null;
  try {
    const value: unknown = JSON.parse(match[1]!);
    if (
      isRecord(value) &&
      value.kind === "complexity-estimate" &&
      typeof value.fieldId === "string" &&
      COMPLEXITY_SIZES.includes(value.size as ComplexitySize) &&
      typeof value.rationale === "string"
    )
      return value as unknown as EstimateProvenance;
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

interface IssueState {
  readonly issueId: string;
  readonly state: string;
  readonly current: ComplexitySize | null;
  readonly provenance: EstimateProvenance | null;
}

const fieldQuery = (number: number) => `query($owner: String!, $name: String!, $field: ID!) {
  field: node(id: $field) { __typename
    ... on IssueFieldCommon { name dataType visibility }
    ... on IssueFieldSingleSelect { id options { id name } } }
  repository(owner: $owner, name: $name) { issue(number: ${number}) { id state
    issueFieldValues(first: 50) { nodes { __typename
      ... on IssueFieldSingleSelectValue { name field { ... on IssueFieldSingleSelect { id } } } } }
    comments(last: 100) { nodes { body } } } } }`;

const SET_VALUE = `mutation($issue: ID!, $field: ID!, $option: ID!) {
  setIssueFieldValue(input: { issueId: $issue,
    issueFields: [{ fieldId: $field, singleSelectOptionId: $option }] }) { issue { id } } }`;
const ADD_COMMENT = `mutation($issue: ID!, $body: String!) {
  addComment(input: { subjectId: $issue, body: $body }) { commentEdge { node { url } } } }`;

const denied = (answer: GraphqlAnswer): string | null => {
  const error = answer.errors[0];
  if (!error) return null;
  return `${error.type ? `${error.type}: ` : ""}${error.message ?? "GitHub returned an error"}`;
};

function readIssue(answer: GraphqlAnswer, fieldId: string, number: number): IssueState {
  const issue = prop(answer.data, "repository", "issue");
  if (!isRecord(issue) || typeof issue.id !== "string")
    throw new Refusal(
      "issue-unavailable",
      "failed",
      1,
      `Issue #${number} could not be read${denied(answer) ? ` (${denied(answer)})` : ""}.`,
      "Check the number, gh auth status and access; nothing was written.",
    );
  // An errored or incomplete read is unknown evidence, never "unset": treating it as unset
  // would let a later write overwrite an estimate without --replace.
  const values = prop(issue, "issueFieldValues", "nodes");
  const unknown = (why: string) =>
    new Refusal(
      "value-unavailable",
      "failed:unknown",
      2,
      `The current estimate of #${number} could not be read reliably (${why}); nothing was written.`,
      "Retry the same command; a missing or partial read is never treated as no estimate.",
    );
  if (answer.errors.length) throw unknown(denied(answer) ?? "GitHub returned errors");
  if (!Array.isArray(values)) throw unknown("issue field values missing from the response");
  let current: ComplexitySize | null = null;
  for (const node of values)
    if (prop(node, "field", "id") === fieldId) {
      const name = prop(node, "name");
      if (!COMPLEXITY_SIZES.includes(name as ComplexitySize))
        throw unknown(`unrecognised value ${JSON.stringify(name ?? null)}`);
      current = name as ComplexitySize;
    }
  const comments = prop(issue, "comments", "nodes");
  let provenance: EstimateProvenance | null = null;
  for (const node of Array.isArray(comments) ? comments : []) {
    const parsed = parseProvenance(text(prop(node, "body")));
    if (parsed?.fieldId === fieldId) provenance = parsed; // last (newest) wins
  }
  return { issueId: issue.id, state: text(issue.state, "UNKNOWN"), current, provenance };
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
        size: { type: "string" },
        rationale: { type: "string" },
        assumption: { type: "string", multiple: true },
        reference: { type: "string", multiple: true },
        agent: { type: "string" },
        replace: { type: "string" },
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
    throw new Error(`--size is required; an unestimated ticket stays unset.\n${estimateUsage}`);
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
  if (values.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    throw new Error("--repo must be owner/name.");

  const json = !!values.json;
  const fs = runtime.fs ?? nodeFileSystem;
  const git = runtime.git ?? nodeGit;
  const api = runtime.api ?? ghFieldApi;
  const result: Record<string, unknown> = {
    schemaVersion: 1,
    kind: "complexity-estimate",
    issue: number,
    size,
  };
  const lines: string[] = [];
  const finish = async (status: string, code: number) => {
    result.status = status;
    result.boundaries =
      "No claim, label, blocker, readiness or ranking was changed; no field was created.";
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
    if (settingFor(config, "complexity.enabled").value === false)
      throw new Refusal(
        "disabled",
        "disabled",
        2,
        `Complexity is disabled for ${target.repository} (complexity.enabled = false); nothing was recorded.`,
        "Opt in with: github-triage config set complexity.enabled true",
      );
    const fieldId = settingFor(config, "complexity.fieldId").value;
    if (typeof fieldId !== "string" || !fieldId)
      throw new Refusal(
        "not-configured",
        "setup-required",
        2,
        `No complexity field is mapped for ${target.repository} (complexity.fieldId is unset). Fields are never created implicitly and labels are not a fallback.`,
        "Map one with: github-triage setup complexity",
      );
    result.fieldId = fieldId;

    const [owner, name] = target.repository.split("/") as [string, string];
    const read = () => api.query(fieldQuery(number), { owner, name, field: fieldId });
    const first = await read();
    const fieldNode = prop(first.data, "field");
    if (!isRecord(fieldNode)) {
      const forbidden = first.errors.some((e) => e.type === "FORBIDDEN");
      throw new Refusal(
        forbidden ? "field-forbidden" : "field-inaccessible",
        "setup-required:inaccessible",
        2,
        forbidden
          ? `GitHub refused access to field ${fieldId} (FORBIDDEN): issue fields may not be enabled for this owner, or you lack permission. Unavailable is not the same as absent; nothing was written.`
          : `Field ${fieldId} could not be read (deleted, or not an issue field); nothing was written.`,
        "Check with: github-triage setup complexity (it reports the mapping and compatible fields)",
      );
    }
    const field = classifyField(fieldNode);
    if (!field?.compatible)
      throw new Refusal(
        "field-incompatible",
        "setup-required:incompatible",
        2,
        `Field ${fieldId} is not compatible: ${field?.reason ?? "unrecognised field"}. Its options are never changed by this tool.`,
        "Choose a compatible field with: github-triage setup complexity",
      );
    const options = prop(fieldNode, "options");
    const option = (Array.isArray(options) ? options : []).find((o) => prop(o, "name") === size);
    const optionId = prop(option, "id");
    if (typeof optionId !== "string")
      throw new Refusal(
        "field-incompatible",
        "setup-required:incompatible",
        2,
        `Field ${fieldId} exposes no option ID for ${size}.`,
        "Check with: github-triage setup complexity",
      );

    const before = readIssue(first, fieldId, number);
    result.previous = before.current;
    result.issueState = before.state;
    const revisionText = await git(["rev-parse", "HEAD"], target.root).catch(() => "");
    const revision = /^[0-9a-f]{40}$/.test(revisionText.trim()) ? revisionText.trim() : null;
    const provenance: EstimateProvenance = {
      schemaVersion: 1,
      kind: "complexity-estimate",
      fieldId,
      size,
      // A retry of `--replace OLD` after a partial write still records OLD as the previous size.
      previous:
        before.current === size ? (replace ?? before.provenance?.previous ?? null) : before.current,
      rationale,
      assumptions,
      references,
      estimator,
      revision,
      guidanceVersion: complexityGuidance.guidanceVersion,
      recordedAt: (runtime.now?.() ?? new Date()).toISOString(),
    };
    result.provenance = provenance;
    lines.push(
      `Complexity estimate for ${target.repository}#${number}: ${before.current ?? "unset"} -> ${size}`,
    );

    // Target already applied (e.g. retry after a partial write) is not stale: only a value
    // that is neither the named OLD size nor the target is a genuine conflict.
    if (replace !== undefined && before.current !== replace && before.current !== size)
      throw new Refusal(
        "stale",
        "refused:stale",
        1,
        `--replace ${replace} is stale: #${number} now holds ${before.current ?? "no estimate"}. Nothing was overwritten.`,
        "Read the current estimate and its rationale, then decide again.",
      );
    if (before.current !== null && before.current !== size && replace === undefined)
      throw new Refusal(
        "existing-estimate",
        "refused:existing",
        1,
        `#${number} already has estimate ${before.current}${before.provenance?.estimator ? ` by ${before.provenance.estimator}` : ""}; it is preserved.`,
        `To replace it deliberately: github-triage estimate ${number} --size ${size} --replace ${before.current} --rationale ...`,
      );

    const recorded = before.provenance;
    const provenanceMatches =
      recorded?.size === size &&
      recorded.rationale === rationale &&
      (recorded.estimator ?? null) === estimator &&
      sameList(recorded.assumptions, assumptions) &&
      sameList(recorded.references, references);
    if (before.current === size && provenanceMatches) {
      lines.push("Unchanged: the same size and provenance are already recorded.");
      return await finish("unchanged", 0);
    }

    let valueWritten = false;
    if (before.current !== size) {
      // Re-read immediately before writing: a concurrent estimate must not be overwritten.
      const latest = readIssue(await read(), fieldId, number);
      if (latest.current !== before.current)
        throw new Refusal(
          "concurrent-change",
          "refused:stale",
          1,
          `#${number} changed from ${before.current ?? "unset"} to ${latest.current ?? "unset"} while recording; nothing was overwritten.`,
          "Read the new estimate and its rationale, then decide again.",
        );
      const set = await api.mutate(SET_VALUE, {
        issue: before.issueId,
        field: fieldId,
        option: optionId,
      });
      if (!prop(set.data, "setIssueFieldValue", "issue") || set.errors.length)
        throw new Refusal(
          "api-denied",
          "failed",
          1,
          `GitHub did not record the size (${denied(set) ?? "no result"}); nothing was written.`,
          "Check gh auth status and that you may set issue fields here, then retry.",
        );
      valueWritten = true;
      lines.push(`Recorded native value ${size} in field ${fieldId}.`);
    } else {
      lines.push(`Native value already ${size}; recording provenance only.`);
    }
    result.valueWritten = valueWritten;

    const comment = await api
      .mutate(ADD_COMMENT, { issue: before.issueId, body: provenanceComment(provenance) })
      .catch((error: unknown) => ({ data: null, errors: [{ message: (error as Error).message }] }));
    const url = prop(comment.data, "addComment", "commentEdge", "node", "url");
    if (typeof url !== "string") {
      result.provenanceWritten = false;
      result.recovery = `Re-run the same command; the native value is kept and only provenance is added.`;
      lines.push(
        `Partial: the native value is ${size} but the provenance comment failed (${denied(comment) ?? "no result"}).`,
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
