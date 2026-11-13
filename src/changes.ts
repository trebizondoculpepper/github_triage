/**
 * Retained change evidence and comparison-window resolution for repository briefing mode
 * (#168, slice 1 of doc/design/briefing-mode.md). Transport-neutral: no CLI flags, rendering
 * or checkpoint writes live here. Every timestamp is qualified against a half-open window
 * `[from, through)`; unknown facts stay explicit rather than becoming "nothing changed".
 */
import type { Issue, PullRequest, Snapshot } from "./types.js";

export const CHANGE_EVIDENCE_SCHEMA_VERSION = 1;
/** Default comparison window when no source is selected. */
export const DEFAULT_LAST = "24h";
/** Default page cap per all-state source (50 nodes per page): at most 2 x 20 extra requests. */
export const DEFAULT_CHANGE_PAGES = 20;
/** Declared scope of version-1 change evidence. Releases, deployments and diffs are excluded. */
export const CHANGE_SCOPE = ["issues", "pull-requests"] as const;
export const CHANGE_SCOPE_EXCLUDES = [
  "releases",
  "npm-publication",
  "deployments",
  "file-diffs",
  "transient-label-or-state-history",
] as const;

const UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Fixed elapsed UTC duration in ms for `<positive integer><m|h|d>`; throws otherwise. */
export function parseDuration(value: string): number {
  const match = /^([1-9]\d{0,9})([mhd])$/.exec(value);
  if (!match)
    throw new Error("--last must be a positive integer followed by m, h or d (e.g. 24h).");
  const ms = Number(match[1]) * UNITS[match[2] as keyof typeof UNITS];
  if (!Number.isSafeInteger(ms)) throw new Error("--last is too large.");
  return ms;
}

/** The existing --since validation: ISO date with time and an explicit timezone. */
export function parseSince(value: string): string {
  if (
    !/^\d{4}-\d\d-\d\dT/.test(value) ||
    !/(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error("--since must be an ISO timestamp with a time.");
  return new Date(value).toISOString();
}

/** Window source selection. At most one of `since`, `last` and `checkpoint` may be given. */
export interface WindowRequest {
  since?: string;
  last?: string;
  /**
   * A checkpoint path was requested. `through` is its recorded value, or null when the file
   * is missing (baseline). Reading/validating the file is the caller's filesystem boundary.
   */
  checkpoint?: { through: string | null };
}
export type WindowSource = "since" | "last" | "default-last" | "checkpoint" | "baseline";
export interface ComparisonWindow {
  source: WindowSource;
  /** Inclusive start; null for a baseline with no previous comparison window. */
  from: string | null;
  /** Exclusive end: the injected collection-start anchor T0. */
  through: string;
  /** The requested duration, for `last`/`default-last`. */
  last: string | null;
  notice: string | null;
}

/**
 * Resolve the requested change window `[from, T0)` from one injected anchor. Rejects
 * combined sources, invalid durations/timestamps and a start after T0 (clock skew or a
 * future checkpoint) rather than silently choosing or clamping.
 */
export function resolveWindow(request: WindowRequest, now: () => Date): ComparisonWindow {
  const chosen = (["since", "last", "checkpoint"] as const).filter((k) => request[k] !== undefined);
  if (chosen.length > 1)
    throw new Error(`Choose one window source; got ${chosen.map((k) => `--${k}`).join(" and ")}.`);
  const anchor = now();
  if (!Number.isFinite(anchor.getTime())) throw new Error("Clock returned an invalid time.");
  const through = anchor.toISOString();
  const future = (from: string, what: string) => {
    if (Date.parse(from) > anchor.getTime())
      throw new Error(`${what} ${from} is after the collection start ${through}.`);
  };
  if (request.checkpoint) {
    const recorded = request.checkpoint.through;
    if (recorded === null)
      return {
        source: "baseline",
        from: null,
        through,
        last: null,
        notice: "No previous comparison window; this run establishes a baseline.",
      };
    if (!Number.isFinite(Date.parse(recorded))) throw new Error("Checkpoint time is invalid.");
    const from = new Date(recorded).toISOString();
    future(from, "Checkpoint");
    return { source: "checkpoint", from, through, last: null, notice: null };
  }
  if (request.since !== undefined) {
    const from = parseSince(request.since);
    future(from, "--since");
    return { source: "since", from, through, last: null, notice: null };
  }
  const last = request.last ?? DEFAULT_LAST;
  const start = anchor.getTime() - parseDuration(last);
  if (!Number.isFinite(start) || start < 0 || !Number.isFinite(new Date(start).getTime()))
    throw new Error("--last reaches before the supported time range.");
  return {
    source: request.last === undefined ? "default-last" : "last",
    from: new Date(start).toISOString(),
    through,
    last,
    notice: null,
  };
}

/** Half-open qualification; null when there is no window or no timestamp. */
export function inWindow(
  at: string | null | undefined,
  window: Pick<ComparisonWindow, "from" | "through">,
): boolean | null {
  if (!at || window.from === null) return null;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return null;
  return t >= Date.parse(window.from) && t < Date.parse(window.through);
}

export interface SourceCoverage {
  source: "issues" | "pull-requests";
  /** True only when pagination reached the window start or the end of the connection. */
  complete: boolean;
  pages: number;
  nodes: number;
  /** Why coverage is incomplete, else null. */
  omission: string | null;
}
export interface NativeLink {
  relation: "closes" | "closed-by" | "blocked-by" | "blocking";
  number: number;
  url: string;
  repository?: string;
}
export type ChangeEventType = "created" | "merged" | "closed" | "closed-unmerged";
export interface ChangeEvent {
  type: ChangeEventType;
  at: string;
  /** Qualified by the event's own timestamp; null for a baseline. */
  inWindow: boolean | null;
}
/**
 * One retained operation on a changed subject: a structured claim/release marker comment or a
 * submitted review. Kept on the subject so operations survive when the subject closes in the
 * window and leaves the open snapshot. `at` is null when GitHub supplied no timestamp.
 */
export interface SubjectOperation {
  source: "comment" | "review";
  url: string;
  at: string | null;
  body: string;
  author: string | null;
  /** Review state (APPROVED, COMMENTED, ...); null for comments. */
  state: string | null;
}
/** Structured workflow markers retained from comments; ordinary comments are not kept. */
export const OPERATION_MARKERS = ["<!-- github-triage:claim:", "<!-- github-triage:release:"];
const MAX_OPERATION_BODY = 2000;

export interface ChangeSubject {
  kind: "issue" | "pull-request";
  number: number;
  url: string;
  title: string;
  /** Current state, observed during collection (not historical state at T0). */
  state: string;
  stateReason: string | null;
  createdAt: string | null;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  links: NativeLink[];
  /** False when any native link connection was truncated or not selected. */
  linksComplete: boolean;
  events: ChangeEvent[];
  /** Updated in the window without a qualifying known event: the operation is unknown. */
  updatedOnly: boolean;
  /** Facts that could not be established, by field name. */
  unknown: string[];
  /** In-window (or untimed) operations; absent on evidence retained before this field. */
  operations?: SubjectOperation[];
  /**
   * False when comments or reviews were truncated or a review had no timestamp: the subject's
   * operation history is unknown beyond what `operations` holds.
   */
  operationsComplete?: boolean;
}
export interface ChangeEvidence {
  schemaVersion: typeof CHANGE_EVIDENCE_SCHEMA_VERSION;
  window: ComparisonWindow;
  scope: { includes: readonly string[]; excludes: readonly string[] };
  coverage: SourceCoverage[];
  /** All sources complete. Incomplete coverage never means "nothing changed". */
  complete: boolean;
  subjects: ChangeSubject[];
  /** Extra all-state requests and the configured bound. */
  cost: { requests: number; maxPagesPerSource: number };
}

type Linkable = { number: number; url: string; repository?: { nameWithOwner: string } };
type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean } } | undefined | null;
/**
 * Links from one connection. Complete only when the connection has no further page and, where a
 * native summary total is known, it holds exactly that many nodes (the same check
 * `completeNative` applies to ordinary collection): a short page is incomplete, never "no links".
 */
function links(
  relation: NativeLink["relation"],
  connection: Connection<Linkable>,
  expectedTotal?: number | null,
) {
  const nodes = (connection?.nodes ?? []).map((node) => ({
    relation,
    number: node.number,
    url: node.url,
    ...(node.repository ? { repository: node.repository.nameWithOwner } : {}),
  }));
  const paged = !!connection && !connection.pageInfo.hasNextPage;
  const counted =
    expectedTotal === undefined ? true : expectedTotal !== null && nodes.length === expectedTotal;
  return { nodes, complete: paged && counted };
}

/** Changed issue node as selected with the evidence fields. */
export type EvidenceIssue = Issue & {
  closedAt?: string | null;
  closedByPullRequestsReferences?: Connection<Linkable>;
};
export type EvidencePullRequest = PullRequest & { closedAt?: string | null };

/** Normalize one changed issue/PR into explicit facts and window-qualified events. */
export function changeSubject(
  kind: ChangeSubject["kind"],
  node: EvidenceIssue | EvidencePullRequest,
  window: Pick<ComparisonWindow, "from" | "through">,
): ChangeSubject {
  const unknown: string[] = [];
  const pr = kind === "pull-request" ? (node as EvidencePullRequest) : null;
  const issue = kind === "issue" ? (node as EvidenceIssue) : null;
  const createdAt = node.createdAt ?? null;
  if (!createdAt) unknown.push("createdAt");
  const closedAt = node.closedAt ?? null;
  const closed = node.state === "CLOSED" || node.state === "MERGED";
  if (closed && !closedAt) unknown.push("closedAt");
  const mergedAt = pr ? (pr.mergedAt ?? null) : null;
  if (pr && node.state === "MERGED" && !mergedAt) unknown.push("mergedAt");
  const stateReason = issue ? (issue.stateReason ?? null) : null;
  if (issue && node.state === "CLOSED" && !stateReason) unknown.push("stateReason");
  const parts = pr
    ? [links("closes", pr.closingIssuesReferences)]
    : [
        links("closed-by", issue!.closedByPullRequestsReferences),
        // Native dependencies must also match the summary totals; a missing summary is unknown.
        links(
          "blocked-by",
          issue!.blockedBy,
          issue!.issueDependenciesSummary?.totalBlockedBy ?? null,
        ),
        links("blocking", issue!.blocking, issue!.issueDependenciesSummary?.totalBlocking ?? null),
      ];
  const linksComplete = parts.every((part) => part.complete);
  if (!linksComplete) unknown.push("links");
  const events: ChangeEvent[] = [];
  const add = (type: ChangeEventType, at: string | null) => {
    if (at) events.push({ type, at, inWindow: inWindow(at, window) });
  };
  add("created", createdAt);
  if (pr) {
    add("merged", mergedAt);
    if (node.state === "CLOSED") add("closed-unmerged", closedAt);
  } else if (node.state === "CLOSED") add("closed", closedAt);
  // Bounded operation evidence: only marker comments and reviews, only in-window or untimed.
  const operations: SubjectOperation[] = [];
  let operationsComplete = !node.comments?.pageInfo?.hasNextPage;
  const keep = (op: SubjectOperation) => {
    const qualified = inWindow(op.at, window);
    if (op.at === null || qualified === null) operationsComplete = false;
    if (qualified !== false) operations.push({ ...op, body: op.body.slice(0, MAX_OPERATION_BODY) });
  };
  for (const c of node.comments?.nodes ?? [])
    if (OPERATION_MARKERS.some((m) => c.body?.includes(m)))
      keep({
        source: "comment",
        url: c.url,
        at: c.createdAt ?? null,
        body: c.body,
        author: c.author?.login ?? null,
        state: null,
      });
  if (pr) {
    if (pr.reviews?.pageInfo?.hasNextPage) operationsComplete = false;
    for (const r of pr.reviews?.nodes ?? [])
      if (r.state !== "PENDING")
        keep({
          source: "review",
          url: r.url,
          at: r.submittedAt ?? null,
          body: r.body ?? "",
          author: r.author?.login ?? null,
          state: r.state,
        });
  }
  if (!operationsComplete) unknown.push("operations");
  return {
    kind,
    number: node.number,
    url: node.url,
    title: node.title,
    state: node.state,
    stateReason,
    createdAt,
    updatedAt: node.updatedAt,
    closedAt,
    mergedAt,
    links: parts.flatMap((part) => part.nodes),
    linksComplete,
    events,
    updatedOnly: !!inWindow(node.updatedAt, window) && !events.some((e) => e.inWindow),
    unknown,
    operations,
    operationsComplete,
  };
}

/** Evidence fields added to the existing all-state queries only in change-evidence mode. */
export const issueEvidenceFields =
  "closedAt closedByPullRequestsReferences(first:20,includeClosedPrs:true){nodes{number url repository{nameWithOwner}} pageInfo{hasNextPage endCursor}}";
export const pullRequestEvidenceFields = "closedAt";

/**
 * The retained evidence of a snapshot, or an explicit unavailable result. Legacy snapshots
 * (no `changeEvidence`) and unsupported versions cannot prove detailed history.
 */
export function snapshotChangeEvidence(
  snapshot: Snapshot,
): { available: true; evidence: ChangeEvidence } | { available: false; reason: string } {
  const evidence = snapshot.changeEvidence;
  if (!evidence)
    return {
      available: false,
      reason: "Snapshot has no retained change evidence; detailed history is unavailable.",
    };
  if (evidence.schemaVersion !== CHANGE_EVIDENCE_SCHEMA_VERSION)
    return { available: false, reason: "Change evidence schema version is unsupported." };
  return { available: true, evidence };
}
