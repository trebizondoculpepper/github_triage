/**
 * Whole-result byte budget for MCP read results (doc/design/mcp-bounded-results.md, #266).
 *
 * Every successful read is built from selected fields, measured as the serialized
 * CallToolResult (text and structuredContent together) and pruned deterministically until it
 * fits: first long strings are shortened with a visible marker, then rows are dropped from the
 * end of the lowest-priority list. Every shortened field and dropped row is reported in
 * `presentation`; essential fields are never pruned. If the essentials alone cannot fit, the
 * caller gets an explicit OUTPUT_BUDGET_EXCEEDED error rather than a partial success.
 */
import * as z from "zod";

/** Hard upper bound for JSON.stringify of the whole returned CallToolResult, in UTF-8 bytes. */
export const budgetBytes = 16_384;
/** Strings longer than this are shortened when the result does not otherwise fit. */
export const fieldLimit = 280;
export const truncationMarker = "… [truncated]";
export const budgetErrorCode = "OUTPUT_BUDGET_EXCEEDED";
export const incompleteNotice =
  "INCOMPLETE evidence: do not treat missing findings as clean or eligible.";

export const views = ["briefing", "repository-briefing", "issue", "dependencies"] as const;
export type View = (typeof views)[number];

const identitySource = z.enum([
  "tool",
  "startup",
  "entry",
  "harness",
  "client",
  "environment",
  "unresolved",
]);

export const selectionSchema = z.object({
  repository: z.string().nullable(),
  agent: z.string().nullable(),
  identitySource,
  /** `[agents.KEY]` consulted for a persisted identity, if any. */
  entry: z.string().nullable(),
  triageRole: z.string().nullable(),
  /** Why identity is unresolved (the read is unfocused), with recovery. */
  identityDiagnostic: z.string().nullable(),
});
export type Selection = z.infer<typeof selectionSchema>;

const next = z.object({ tool: z.string(), arguments: z.record(z.string(), z.unknown()) });
export type Next = z.infer<typeof next>;

export const presentationSchema = z.object({
  budgetBytes: z.number().int(),
  /** Bytes of the final serialized CallToolResult, including this value itself. */
  bytes: z.number().int(),
  /** Rows returned for each prunable list, by its path in `data`. */
  returned: z.record(z.string(), z.number().int()),
  /** Rows of each list available but not returned, by its path in `data`. */
  omitted: z.record(z.string(), z.number().int()),
  truncatedFields: z.array(z.string()),
  next: next.nullable(),
});
export type Presentation = z.infer<typeof presentationSchema>;

/** Version-2 bounded envelope for triage_briefing, triage_issue and triage_dependencies. */
export const boundedEnvelope = z.strictObject({
  schemaVersion: z.literal(2),
  kind: z.literal("mcp-read-result"),
  tool: z.string(),
  view: z.enum(views),
  status: z.enum(["complete", "incomplete", "error"]),
  repository: z.string().nullable(),
  subject: z.object({ type: z.literal("issue"), number: z.number().int() }).nullable(),
  selection: selectionSchema,
  freshness: z.record(z.string(), z.unknown()).nullable(),
  sourceCompleteness: z
    .object({ complete: z.boolean(), warnings: z.array(z.string()) })
    .catchall(z.unknown())
    .nullable(),
  presentation: presentationSchema,
  data: z.record(z.string(), z.unknown()).nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
export type BoundedEnvelope = z.infer<typeof boundedEnvelope>;

export type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent: BoundedEnvelope;
  isError?: true;
};

/** Bytes of the serialized result, as a client receives it. */
export const resultBytes = (result: unknown): number =>
  Buffer.byteLength(JSON.stringify(result), "utf8");

/** Fill `presentation.bytes` with the size of the result that contains it (a fixed point). */
export function measured<T extends ToolResult>(result: T): T {
  const presentation = result.structuredContent.presentation;
  presentation.bytes = 0;
  for (let i = 0; i < 8; i++) {
    const bytes = resultBytes(result);
    if (bytes === presentation.bytes) return result;
    presentation.bytes = bytes;
  }
  return result;
}

type Path = (string | number)[];
const pathText = (path: Path): string =>
  path.map((part, i) => (typeof part === "number" ? `[${part}]` : i ? `.${part}` : part)).join("");

function at(root: unknown, path: Path): unknown {
  let value = root;
  for (const part of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string | number, unknown>)[part];
  }
  return value;
}

/** A list in `data` whose trailing rows may be dropped, highest index first. */
/**
 * Pseudo-list naming the envelope's completeness warnings in a view's pruning order: there they
 * are reduced to `keptWarnings`; any remaining warnings are pruned only after every list.
 */
export const warningsList = "$sourceCompleteness.warnings";
export const keptWarnings = 5;

export interface PrunableList {
  path: Path;
  /** Rows available in total (for a page, from the page start); defaults to the initial length. */
  available?: number;
  /**
   * A paged list must return at least one available row: an empty page would repeat the same
   * `next` forever, so it becomes OUTPUT_BUDGET_EXCEEDED instead.
   */
  requireRow?: boolean;
}

export interface BoundedView {
  tool: string;
  view: View;
  status: "complete" | "incomplete";
  repository: string;
  subject: BoundedEnvelope["subject"];
  selection: Selection;
  freshness: Record<string, unknown> | null;
  sourceCompleteness: { complete: boolean; warnings: string[] } & Record<string, unknown>;
  data: Record<string, unknown>;
  /** Prunable lists in pruning order: the first entry loses rows first. */
  lists: (data: Record<string, unknown>) => PrunableList[];
  /** Paths under which strings are never shortened (completeness, warnings). */
  protectedPaths?: string[];
  /** Recompute counters that depend on returned rows, after pruning. */
  fixup?: (data: Record<string, unknown>, returned: Record<string, number>) => void;
  /** Next-page arguments, given what was returned. */
  next?: (returned: Record<string, number>) => Next | null;
  /** Text lines for the returned data, most important first. */
  text: (data: Record<string, unknown>, presentation: Presentation) => string[];
  /** Prefix lines that are never dropped from text (incomplete and identity notices). */
  notices: string[];
  maxChars: number;
}

/** Shorten the text body to whole lines within maxChars, saying how many lines were dropped. */
export function boundText(lines: string[], maxChars: number): string {
  const all = `${lines.join("\n")}\n`;
  if (all.length <= maxChars) return all;
  const kept: string[] = [];
  let length = 0;
  const notice = (dropped: number) =>
    `${dropped} text line(s) omitted at maxChars ${maxChars}; the returned rows are in structuredContent.data.\n`;
  for (const [i, line] of lines.entries()) {
    const reserve = notice(lines.length - i).length;
    if (length + line.length + 1 + reserve > maxChars) {
      return `${kept.join("\n")}\n${notice(lines.length - i)}`;
    }
    kept.push(line);
    length += line.length + 1;
  }
  return all;
}

const shorten = (text: string): string =>
  `${text.slice(0, fieldLimit - truncationMarker.length)}${truncationMarker}`;

/** Shorten every over-long string at or below `path`, recording each field's path. */
function shortenStrings(
  container: Record<string | number, unknown>,
  key: string | number,
  path: Path,
  isProtected: (path: string) => boolean,
  truncated: Path[],
): void {
  const value = container[key];
  const text = pathText(path);
  if (isProtected(text)) return;
  if (typeof value === "string") {
    // URLs are evidence links: a shortened link would be a broken one, so they stay whole.
    if (value.length > fieldLimit && !/^https?:\/\/\S+$/.test(value)) {
      container[key] = shorten(value);
      truncated.push(path);
    }
    return;
  }
  if (Array.isArray(value))
    value.forEach((_, i) =>
      shortenStrings(
        value as unknown as Record<number, unknown>,
        i,
        [...path, i],
        isProtected,
        truncated,
      ),
    );
  else if (value !== null && typeof value === "object")
    for (const child of Object.keys(value))
      shortenStrings(
        value as Record<string, unknown>,
        child,
        [...path, child],
        isProtected,
        truncated,
      );
}

/** Inputs of a version-2 error result; every string here may echo caller input. */
export interface ErrorInput {
  tool: string;
  view: View;
  repository: string | null;
  subject: BoundedEnvelope["subject"];
  selection: Selection;
  freshness: Record<string, unknown> | null;
  sourceCompleteness: BoundedEnvelope["sourceCompleteness"];
  code: string;
  message: string;
}

const echoNotice = `Echoed input longer than ${fieldLimit} characters was shortened (${truncationMarker}).`;
const shortenEcho = (text: string | null): string | null =>
  text !== null && text.length > fieldLimit ? shorten(text) : text;

function errorShape(input: ErrorInput): ToolResult {
  return measured({
    content: [{ type: "text", text: `Error (${input.code}): ${input.message}\n` }],
    structuredContent: {
      schemaVersion: 2,
      kind: "mcp-read-result",
      tool: input.tool,
      view: input.view,
      status: "error",
      repository: input.repository,
      subject: input.subject,
      selection: input.selection,
      freshness: input.freshness,
      sourceCompleteness: input.sourceCompleteness,
      presentation: {
        budgetBytes,
        bytes: 0,
        returned: {},
        omitted: {},
        truncatedFields: [],
        next: null,
      },
      data: null,
      error: { code: input.code, message: input.message },
    },
    isError: true,
  });
}

/**
 * Sanitized version-2 error result, always within the byte budget. Stages: as given; then echoed
 * input (repository, agent, identity diagnostic, message) shortened, saying so; then warnings
 * replaced by their count; finally a minimal envelope with only the code and the verdict.
 */
export function boundedError(input: ErrorInput): ToolResult {
  const first = errorShape(input);
  if (resultBytes(first) <= budgetBytes) return first;
  const echo = (text: string): string =>
    text.length > 2000 ? `${text.slice(0, 2000)}${truncationMarker}` : text;
  const shortened: ErrorInput = {
    ...input,
    repository: shortenEcho(input.repository),
    selection: {
      ...input.selection,
      repository: shortenEcho(input.selection.repository),
      agent: shortenEcho(input.selection.agent),
      entry: shortenEcho(input.selection.entry),
      triageRole: shortenEcho(input.selection.triageRole),
      identityDiagnostic: shortenEcho(input.selection.identityDiagnostic),
    },
    message: `${echo(input.message)} ${echoNotice}`,
  };
  const second = errorShape(shortened);
  if (resultBytes(second) <= budgetBytes) return second;
  const counted: ErrorInput = {
    ...shortened,
    freshness: null,
    sourceCompleteness: input.sourceCompleteness && {
      complete: input.sourceCompleteness.complete,
      warnings: [],
      warningsOmitted: input.sourceCompleteness.warnings.length,
    },
  };
  const third = errorShape(counted);
  if (resultBytes(third) <= budgetBytes) return third;
  // Fixed-size last resort: nothing caller-controlled except the verdict remains.
  return errorShape({
    ...counted,
    repository: null,
    selection: {
      repository: null,
      agent: null,
      identitySource: input.selection.identitySource,
      entry: null,
      triageRole: null,
      identityDiagnostic: null,
    },
    message: `The ${input.code} error details exceed the ${budgetBytes}-byte response budget and were omitted. ${echoNotice}`,
  });
}

/** Error result for a read whose essential fields cannot fit; never a partial success. */
export function budgetExceeded(view: BoundedView, reason: string): ToolResult {
  const message = `${reason} Recovery: request a narrower view (a smaller limit, a later offset or another section), or use the CLI for full intake: pdb --repo ${view.repository}${view.subject ? ` --issue ${view.subject.number}` : ""} --json.`;
  return boundedError({
    tool: view.tool,
    view: view.view,
    repository: view.repository,
    subject: view.subject,
    selection: view.selection,
    freshness: view.freshness,
    sourceCompleteness: view.sourceCompleteness,
    code: budgetErrorCode,
    message,
  });
}

const presentationTruncated = (truncated: Path[], data: unknown): number =>
  truncated.filter((path) => at(data, path) !== undefined).length;

/** Build the bounded result for one read; see the module comment for the pruning order. */
export function boundedResult(view: BoundedView): ToolResult {
  const data = structuredClone(view.data);
  const ordered = view.lists(data);
  const lists = ordered.filter((list) => Array.isArray(at(data, list.path)));
  const available = new Map(
    lists.map((list) => [
      pathText(list.path),
      list.available ?? (at(data, list.path) as unknown[]).length,
    ]),
  );
  const truncated: Path[] = [];
  // Warnings are bounded like rows, pruned last: the verdict and the count always remain.
  const completeness = structuredClone(view.sourceCompleteness);
  const allWarnings = completeness.warnings.length;

  const build = (): ToolResult => {
    const returned: Record<string, number> = {};
    const omitted: Record<string, number> = {};
    for (const list of lists) {
      const key = pathText(list.path);
      const rows = (at(data, list.path) as unknown[]).length;
      returned[key] = rows;
      const missing = (available.get(key) ?? rows) - rows;
      if (missing > 0) omitted[key] = missing;
    }
    const warningsOmitted = allWarnings - completeness.warnings.length;
    if (warningsOmitted > 0) omitted["sourceCompleteness.warnings"] = warningsOmitted;
    const shaped = structuredClone(data);
    // A list kept in a { total, omitted, items } container reports what is actually returned.
    for (const list of lists) {
      const parent = at(shaped, list.path.slice(0, -1));
      const rows = at(shaped, list.path);
      if (
        parent !== null &&
        typeof parent === "object" &&
        Array.isArray(rows) &&
        typeof (parent as Record<string, unknown>).total === "number" &&
        typeof (parent as Record<string, unknown>).omitted === "number"
      ) {
        const container = parent as { total: number; omitted: number };
        container.omitted = Math.max(0, container.total - rows.length);
      }
    }
    view.fixup?.(shaped, returned);
    const presentation: Presentation = {
      budgetBytes,
      bytes: 0,
      returned,
      omitted,
      // Only fields still returned: rows dropped by pruning take their paths with them.
      truncatedFields: truncated.filter((path) => at(data, path) !== undefined).map(pathText),
      next: view.next?.(returned) ?? null,
    };
    const header = [
      ...(view.status === "incomplete" ? [incompleteNotice] : []),
      ...view.notices,
      `Bounded MCP result (${budgetBytes}-byte budget for the whole result). Omitted rows, shortened fields and the next page are listed in structuredContent.presentation.`,
      ...(Object.keys(omitted).length
        ? [
            `Omitted for size: ${Object.entries(omitted)
              .map(([path, count]) => `${count} from ${path}`)
              .join(", ")}.`,
          ]
        : []),
      ...(presentationTruncated(truncated, data)
        ? [`${presentationTruncated(truncated, data)} field(s) shortened (${truncationMarker}).`]
        : []),
      ...(presentation.next
        ? [`Next page: ${presentation.next.tool} ${JSON.stringify(presentation.next.arguments)}`]
        : []),
    ];
    const body = view.text(shaped, presentation);
    const reserved = header.join("\n").length + 1;
    // Notices are essential; when they alone reach maxChars, the body is omitted with a notice.
    const text =
      reserved >= view.maxChars
        ? `${header.join("\n")}\nAll ${body.length} text line(s) omitted at maxChars ${view.maxChars}; the returned rows are in structuredContent.data.\n`
        : `${header.join("\n")}\n${boundText(body, view.maxChars - reserved)}`;
    return measured({
      content: [{ type: "text", text }],
      structuredContent: {
        schemaVersion: 2,
        kind: "mcp-read-result",
        tool: view.tool,
        view: view.view,
        status: view.status,
        repository: view.repository,
        subject: view.subject,
        selection: view.selection,
        freshness: view.freshness,
        sourceCompleteness:
          warningsOmitted > 0 ? { ...completeness, warningsOmitted } : completeness,
        presentation,
        data: shaped,
        error: null,
      },
    });
  };

  const fits = (result: ToolResult) => resultBytes(result) <= budgetBytes;
  const finish = (result: ToolResult): ToolResult => {
    const empty = lists.find(
      (list) =>
        list.requireRow &&
        (available.get(pathText(list.path)) ?? 0) > 0 &&
        (at(data, list.path) as unknown[]).length === 0,
    );
    return empty
      ? budgetExceeded(
          view,
          `The first row of ${pathText(empty.path)} at this offset cannot fit in the ${budgetBytes}-byte response budget, so this page cannot make progress.`,
        )
      : result;
  };
  let result = build();
  if (fits(result)) return finish(result);

  const protectedPaths = view.protectedPaths ?? [];
  const isProtected = (path: string) =>
    protectedPaths.some((p) => path === p || path.startsWith(`${p}.`) || path.startsWith(`${p}[`));
  for (const key of Object.keys(data)) shortenStrings(data, key, [key], isProtected, truncated);
  result = build();
  if (fits(result)) return finish(result);

  for (const list of ordered) {
    if (list.path[0] === warningsList) {
      while (completeness.warnings.length > keptWarnings) {
        completeness.warnings.pop();
        result = build();
        if (fits(result)) return finish(result);
      }
      continue;
    }
    const rows = at(data, list.path);
    if (!Array.isArray(rows)) continue;
    while (rows.length > 0) {
      rows.pop();
      result = build();
      if (fits(result)) return finish(result);
    }
  }
  while (completeness.warnings.length > 0) {
    completeness.warnings.pop();
    result = build();
    if (fits(result)) return finish(result);
  }
  return budgetExceeded(
    view,
    `The essential fields of this ${view.view} result exceed the ${budgetBytes}-byte response budget even with every optional row omitted.`,
  );
}
