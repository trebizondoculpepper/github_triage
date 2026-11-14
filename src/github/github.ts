/** Read-only, paginated gh GraphQL collector. Never invokes a mutation or shell. */
import { completeNative, isRateLimit, nativeFields, RateLimitError } from "./dependencies.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CHANGE_EVIDENCE_SCHEMA_VERSION,
  CHANGE_SCOPE,
  CHANGE_SCOPE_EXCLUDES,
  changeSubject,
  DEFAULT_CHANGE_PAGES,
  issueEvidenceFields,
  pullRequestEvidenceFields,
} from "./changes.js";
import type {
  ComparisonWindow,
  EvidenceIssue,
  EvidencePullRequest,
  SourceCoverage,
} from "./changes.js";
import type { Comment, Issue, Page, PullRequest, Reference, Snapshot } from "./types.js";

const execute = promisify(execFile);

/** An untrusted JSON object (GitHub responses, cached files). */
export type JsonObject = { [key: string]: unknown };
export type QueryVariables = Record<string, string | number>;
/** Injected read-only GraphQL boundary: resolves to the response's `data` object. */
export type Query = (query: string, variables: QueryVariables) => Promise<JsonObject>;

export const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Follow a path through untrusted JSON; undefined as soon as a step is not an object. */
export function prop(value: unknown, ...path: string[]): unknown {
  let at = value;
  for (const key of path) {
    if (!isRecord(at)) return undefined;
    at = at[key];
  }
  return at;
}

/**
 * The single assertion boundary for GraphQL nodes. Their shape is fixed by this project's own
 * selection sets and GitHub's schema-validated response, so after checking that an object (or
 * connection) is present, its fields are trusted to match the selection rather than
 * re-validated field by field. Missing evidence is still detected by the callers.
 */
function trusted<T>(value: object): T {
  // Justified escape: see above; GraphQL guarantees the selected field shapes.
  return value as T;
}
/** A selected GraphQL object, or null when the response has none. */
export function selected<T>(value: unknown): T | null {
  return isRecord(value) ? trusted<T>(value) : null;
}

/**
 * Read-only GraphQL through gh. With `signal`, aborting terminates the running gh child
 * process (execFile's kill on abort) and rejects with the abort reason instead of a result.
 */
export const ghQueryWith =
  (signal?: AbortSignal): Query =>
  async (query, variables) => {
    signal?.throwIfAborted();
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [key, value] of Object.entries(variables)) args.push("-F", `${key}=${value}`);
    let stdout: string;
    try {
      ({ stdout } = await execute("gh", args, {
        maxBuffer: 32 * 1024 * 1024,
        timeout: 60_000,
        signal,
      }));
    } catch (error) {
      signal?.throwIfAborted();
      // gh exits non-zero on any GraphQL error but still prints the response. A response whose
      // only errors are NOT_FOUND is a valid answer ("no such issue"): callers see null fields.
      const answer = graphqlAnswer(prop(error, "stdout"));
      if (answer) return answer;
      const limited = rateLimitFailure(prop(error, "stderr"), prop(error, "stdout"));
      if (limited) throw limited;
      // Do not echo subprocess arguments, stderr, credentials or private API response bodies.
      throw new Error(
        "GitHub query failed. Check gh auth status, repository access and API rate limits.",
      );
    }
    const parsed: unknown = JSON.parse(stdout);
    const errors = prop(parsed, "errors");
    if (Array.isArray(errors) && errors.length && !graphqlAnswer(stdout)) {
      const limited = rateLimitFailure("", stdout);
      if (limited) throw limited;
      throw new Error("GitHub returned incomplete query data; no fresh report saved.");
    }
    const data = prop(parsed, "data");
    if (!isRecord(data))
      throw new Error("GitHub returned incomplete query data; no fresh report saved.");
    return data;
  };
const text = (value: unknown): string =>
  typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString() : "";
/**
 * A sanitized RateLimitError when gh's output reports a GitHub rate limit (HTTP 403/429
 * text or GraphQL RATE_LIMITED errors), else null. Only a bounded retry-after number and a
 * parsed reset time survive; nothing else from the output is kept.
 */
export function rateLimitFailure(stderr: unknown, stdout: unknown): RateLimitError | null {
  const output = `${text(stderr)}\n${text(stdout)}`;
  let graphqlLimited = false;
  try {
    const errors = prop(JSON.parse(text(stdout)), "errors");
    graphqlLimited =
      Array.isArray(errors) && errors.some((e) => prop(e, "type") === "RATE_LIMITED");
  } catch {
    // Not JSON: rely on the text discriminator only.
  }
  if (!graphqlLimited && !isRateLimit(output)) return null;
  const after = /retry-after:?\s*(\d{1,6})\b/i.exec(output);
  const reset = /x-ratelimit-reset:?\s*(\d{9,11})\b/i.exec(output);
  return new RateLimitError("GitHub query was rate limited; retry after the reported reset.", {
    retryAfterSeconds: after ? Number(after[1]) : null,
    resetAt: reset ? new Date(Number(reset[1]) * 1000).toISOString() : null,
  });
}
/** Uncancellable production GraphQL boundary used by the CLI. */
export const ghQuery: Query = ghQueryWith();
/** Data from a GraphQL response whose errors are all NOT_FOUND, else null. */
export function graphqlAnswer(text: unknown): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(typeof text === "string" ? text : "");
    const errors = prop(parsed, "errors");
    const data = prop(parsed, "data");
    const notFoundOnly =
      Array.isArray(errors) &&
      errors.length > 0 &&
      errors.every((e) => prop(e, "type") === "NOT_FOUND");
    return notFoundOnly && isRecord(data) ? data : null;
  } catch {
    return null;
  }
}
export interface RestAnswer {
  status: number | null;
  body: unknown;
}
/**
 * Read-only REST GET. With `options.signal`, an implementation stops before starting and aborts
 * a running request; an aborted signal rejects rather than answering.
 */
export type Rest = (path: string, options?: { signal?: AbortSignal }) => Promise<RestAnswer>;

/** Read-only REST GET through gh (which follows GitHub's transfer redirects). */
export const ghRestWith =
  (bound?: AbortSignal): Rest =>
  async (path, options) => {
    const signal = options?.signal ?? bound;
    signal?.throwIfAborted();
    try {
      const { stdout } = await execute("gh", ["api", path], { timeout: 30_000, signal });
      return { status: 200, body: JSON.parse(stdout) as unknown };
    } catch (error) {
      signal?.throwIfAborted();
      try {
        const out = prop(error, "stdout");
        const body: unknown = JSON.parse(typeof out === "string" ? out : "");
        return { status: Number(prop(body, "status")) || null, body };
      } catch {
        return { status: null, body: null };
      }
    }
  };
export const ghRest: Rest = ghRestWith();

interface LocationBase {
  repository: string;
  number: number;
  url: string;
  detail: string;
  next: string;
}
/** Why an issue number is unavailable, discriminated on `state`. */
export type IssueDiagnosis =
  | (LocationBase & {
      state: "moved";
      destination: { repository: string; number: unknown; url: unknown };
    })
  | (LocationBase & { state: "pull-request" | "missing" | "forbidden" | "unknown" });

/**
 * Why an issue number is unavailable (#39, doc/design/diagnostics.md): moved by transfer
 * (authoritative only when GitHub resolves it to another repository), a pull request,
 * missing, forbidden, or unknown. A missing or forbidden answer never implies a transfer.
 */
export async function locateIssue(
  repository: string,
  number: number,
  rest: Rest = ghRest,
): Promise<IssueDiagnosis> {
  const url = `https://github.com/${repository}/issues/${number}`;
  const { status, body } = await rest(`repos/${repository}/issues/${number}`);
  const base = { repository, number, url };
  const inspect = `gh api repos/${repository}/issues/${number}`;
  const repositoryUrl = prop(body, "repository_url");
  if (status === 200 && repositoryUrl) {
    const destination = String(repositoryUrl).replace(/^.*\/repos\//, "");
    const destNumber = prop(body, "number");
    const htmlUrl = prop(body, "html_url");
    if (destination.toLowerCase() !== repository.toLowerCase())
      return {
        ...base,
        state: "moved",
        destination: { repository: destination, number: destNumber, url: htmlUrl },
        detail: `Transferred to ${String(htmlUrl)}. It is not this project's work, and the destination's ownership is not assumed.`,
        next: `npm run --silent pdb -- --repo ${destination} --issue ${String(destNumber)} --json`,
      };
    if (prop(body, "pull_request"))
      return {
        ...base,
        state: "pull-request",
        detail: `#${number} is a pull request.`,
        next: `gh pr view ${number} --repo ${repository}`,
      };
    return {
      ...base,
      state: "unknown",
      detail: "REST found the issue but GraphQL did not; retry.",
      next: inspect,
    };
  }
  if (status === 404)
    return {
      ...base,
      state: "missing",
      detail:
        "Not found (deleted, never existed, or not visible to this account); not treated as a transfer.",
      next: inspect,
    };
  if (status === 403 || status === 401)
    return {
      ...base,
      state: "forbidden",
      detail: "Access denied; check gh auth status and repository access.",
      next: "gh auth status",
    };
  if (status === 410)
    return { ...base, state: "missing", detail: "Deleted (HTTP 410).", next: inspect };
  return {
    ...base,
    state: "unknown",
    detail: "GitHub gave no authoritative answer.",
    next: inspect,
  };
}

/** Thrown when `--issue N` cannot be read; carries the location diagnosis. */
export class IssueUnavailable extends Error {
  readonly diagnosis: IssueDiagnosis;
  constructor(diagnosis: IssueDiagnosis) {
    super(`Issue #${diagnosis.number} is unavailable: ${diagnosis.state}. ${diagnosis.detail}`);
    this.diagnosis = diagnosis;
  }
}

/** Resolve the gh repository of the working directory (or of `cwd`, e.g. an MCP project). */
export async function currentRepository(cwd?: string, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execute(
      "gh",
      ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      { timeout: 30_000, cwd, signal },
    );
    return stdout.trim();
  } catch {
    signal?.throwIfAborted();
    throw new Error(
      "Cannot resolve repository. Supply --repo owner/name and check gh authentication.",
    );
  }
}
const info = "pageInfo{hasNextPage endCursor}";
// Author type and edit history (#247) let the provenance reader apply the #212 trust rule; all
// are existing IssueComment/PullRequestReviewComment fields, so no request is added.
const comment =
  "databaseId body url author{__typename login} createdAt updatedAt lastEditedAt includesCreatedEdit editor{__typename login}";
const common = `number title body url state createdAt updatedAt lastEditedAt labels(first:100){nodes{name} ${info}} comments(first:100){nodes{${comment}} ${info}}`;
// The issue side of the closing link (#162): proves an issue has no open closing PR when an
// open PR's closing references are truncated.
const closedBy = `closedByPullRequestsReferences(first:10,includeClosedPrs:false){nodes{number url state} ${info}}`;
const prFields = `${common} headRefOid headRefName baseRefName isDraft mergeable mergeStateStatus reviewDecision mergedAt
 closingIssuesReferences(first:100){nodes{number url} ${info}}
 reviewThreads(first:100){nodes{isResolved isOutdated comments(first:1){totalCount nodes{${comment}} ${info}}} ${info}}
 reviews(first:100){nodes{body url author{login} state submittedAt commit{oid}} ${info}}
 commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){nodes{__typename ... on CheckRun{name status conclusion detailsUrl databaseId} ... on StatusContext{context state targetUrl}} ${info}}}}}}`;

/** Cursor pagination also detects a broken/repeating cursor instead of spinning forever. */
export async function pages<T>(
  fetch: (cursor?: string) => Promise<unknown>,
  stop: (page: T[]) => boolean = () => false,
): Promise<T[]> {
  const result: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await fetch(cursor);
    const nodes = prop(page, "nodes");
    const pageInfo = prop(page, "pageInfo");
    if (!Array.isArray(nodes) || !isRecord(pageInfo))
      throw new Error("Malformed GitHub connection.");
    const batch = trusted<T[]>(nodes);
    result.push(...batch);
    if (stop(batch) || !pageInfo.hasNextPage) return result;
    const next = pageInfo.endCursor;
    if (typeof next !== "string" || !next || seen.has(next))
      throw new Error("GitHub pagination did not advance.");
    seen.add(next);
    cursor = next;
  }
}

/** Only explicitly declared prerequisites, never every #mention in the body. */
export function declaredDependencies(body: string, repository: string): Reference[] {
  return declaredDependencyContexts(body, repository).map(({ repository, number, url }) => ({
    repository,
    number,
    url,
  }));
}
export type DeclaredReference = Reference & { context: string };
/** As declaredDependencies, with the declaring text kept for migration review. */
export function declaredDependencyContexts(body: string, repository: string): DeclaredReference[] {
  const refs = new Map<string, DeclaredReference>();
  let section = false;
  for (const original of body.split("\n")) {
    const line = original.replaceAll("**", "");
    if (/^\s*(?:#{1,6}\s*)?(?:dependencies|depends on|prerequisites)\s*:?\s*$/i.test(line)) {
      section = true;
      continue;
    }
    if (/^\s*#{1,6}\s/.test(line)) {
      section = false;
      continue;
    }
    // Explicit declarations can follow an introductory sentence, but following incidental
    // references are not swallowed into the prerequisite list.
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const declaration = /^\s*(?:[-*]\s*)?(?:depends on|blocked by|requires)\b\s*:?\s*(.*)/i.exec(
        sentence,
      );
      const text = declaration?.[1] ?? (section && /^\s*[-*]\s/.test(sentence) ? sentence : "");
      const add = (repo: string, number: number, url: string) =>
        refs.set(`${repo}#${number}`, { repository: repo, number, url, context: sentence.trim() });
      for (const match of text.matchAll(
        /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/g,
      ))
        add(match[1], Number(match[2]), match[0]);
      const local = text.replace(/https:\/\/github\.com\/[^\s)\]]+/g, "");
      for (const match of local.matchAll(/(?<![\w/])#([1-9]\d*)\b/g))
        add(repository, Number(match[1]), `https://github.com/${repository}/issues/${match[1]}`);
    }
  }
  return [...refs.values()];
}

export interface CollectOptions {
  since?: string;
  issue?: number;
  /** Injected issue-location diagnosis (production: `locateIssue`). */
  locate?: (repository: string, number: number) => Promise<IssueDiagnosis>;
  /**
   * Cancellation (MCP): stops further requests and, for the default gh boundaries, terminates
   * the running gh child processes. A cancelled collection rejects; it never returns a report.
   */
  signal?: AbortSignal;
  /**
   * Briefing mode only (#168): a resolved comparison window. Retains normalized all-state
   * change evidence with per-source coverage in `changeEvidence`. Exclusive with `since`.
   */
  changeWindow?: ComparisonWindow;
  /** Page cap per all-state source in change-evidence mode (default DEFAULT_CHANGE_PAGES). */
  maxChangePages?: number;
}
export async function collect(
  repository: string,
  options: CollectOptions = {},
  query: Query = ghQueryWith(options.signal),
  now: () => Date = () => new Date(),
): Promise<Snapshot> {
  const originalQuery = query;
  let requestCount = 0;
  query = (...args: Parameters<Query>) => {
    options.signal?.throwIfAborted();
    requestCount++;
    return originalQuery(...args);
  };
  const [owner, name] = repository.split("/");
  const vars = { owner: owner, name: name };
  const warnings: string[] = [];
  const startedAt = now().toISOString();
  let rateLimit: Snapshot["rateLimit"] = null;
  const request = async (source: string, variables: QueryVariables = {}): Promise<unknown> => {
    const data = await query(source, { ...vars, ...variables });
    rateLimit = selected<NonNullable<Snapshot["rateLimit"]>>(data.rateLimit) ?? rateLimit;
    const repo = data.repository;
    if (!repo) throw new Error(`Repository unavailable: ${repository}`);
    return repo;
  };
  const collection = async <T extends { updatedAt: string }>(
    field: string,
    fields: string,
    states: string,
    cutoff?: string,
  ): Promise<T[]> => {
    const source = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){${field}(first:50,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}${states}){nodes{${fields}} ${info}}} rateLimit{remaining resetAt}}`;
    const nodes = await pages<T>(
      async (cursor) => prop(await request(source, cursor ? { cursor } : {}), field),
      (batch) => !!cutoff && batch.some((node) => Date.parse(node.updatedAt) < Date.parse(cutoff)),
    );
    return cutoff
      ? nodes.filter((node) => Date.parse(node.updatedAt) >= Date.parse(cutoff))
      : nodes;
  };
  /**
   * All-state changes since `cutoff`, newest update first, stopping at the cutoff or after
   * `maxPages`. A cap hit before the cutoff is reported as incomplete coverage, never as
   * "nothing changed". Items updated during collection can shift between pages, so nodes are
   * deduplicated by URL and late updates (after T0) are retained: events are qualified later.
   */
  const boundedChanges = async <T extends { url: string; updatedAt: string }>(
    field: "issues" | "pullRequests",
    fields: string,
    states: string,
    cutoff: string,
    maxPages: number,
  ): Promise<[T[], SourceCoverage]> => {
    const source = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){${field}(first:50,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}${states}){nodes{${fields}} ${info}}} rateLimit{remaining resetAt}}`;
    let pageCount = 0;
    let reachedCutoff = false;
    let more = false;
    const nodes = await pages<T>(
      async (cursor) => {
        const page = prop(await request(source, cursor ? { cursor } : {}), field);
        pageCount++;
        more = prop(page, "pageInfo", "hasNextPage") === true;
        return page;
      },
      (batch) => {
        reachedCutoff = batch.some((node) => Date.parse(node.updatedAt) < Date.parse(cutoff));
        return reachedCutoff || pageCount >= maxPages;
      },
    );
    const unique = [
      ...new Map(
        nodes
          .filter((node) => Date.parse(node.updatedAt) >= Date.parse(cutoff))
          .map((node) => [node.url, node]),
      ).values(),
    ];
    const complete = reachedCutoff || !more;
    const label = field === "issues" ? "issues" : "pull-requests";
    return [
      unique,
      {
        source: label,
        complete,
        pages: pageCount,
        nodes: unique.length,
        omission: complete
          ? null
          : `${label} page cap (${maxPages} x 50) reached before ${cutoff}; older changes were not read.`,
      },
    ];
  };
  const locate =
    options.locate ??
    ((repo: string, number: number) => locateIssue(repo, number, ghRestWith(options.signal)));
  /**
   * For --issue N, a failed GraphQL read gets the read-only REST diagnosis. The failure itself
   * is never transfer evidence: only REST's own answer decides, and "unknown" keeps the error.
   */
  const diagnoseFailure = async (error: unknown): Promise<never> => {
    if (!options.issue) throw error;
    const diagnosis = await locate(repository, options.issue);
    if (diagnosis.state === "unknown") throw error;
    throw new IssueUnavailable(diagnosis);
  };
  const [issues, pullRequests] = await Promise.all([
    collection<Issue>(
      "issues",
      `${common} stateReason ${closedBy} ${nativeFields}`,
      ",states:OPEN",
    ),
    collection<PullRequest>("pullRequests", prFields, ",states:OPEN"),
  ]).catch(diagnoseFailure);
  const issueSource = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){${common} stateReason ${nativeFields}}}}`;
  if (options.issue && !issues.some((issue) => issue.number === options.issue)) {
    const detail = selected<Issue>(
      prop(await request(issueSource, { number: options.issue }).catch(diagnoseFailure), "issue"),
    );
    if (!detail) throw new IssueUnavailable(await locate(repository, options.issue));
    issues.push(detail);
  }
  // All comments are available for semantic reconciliation, even if the briefing shows excerpts.
  await concurrentMap([...issues, ...pullRequests], async (item) => {
    if (item.comments.pageInfo.hasNextPage) {
      const source = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){... on Issue{comments(first:100,after:$cursor){nodes{${comment}} ${info}}} ... on PullRequest{comments(first:100,after:$cursor){nodes{${comment}} ${info}}}}}`;
      const initial = item.comments;
      item.comments.nodes = await pages<Comment>(async (cursor) => {
        if (!cursor) return initial;
        const node = prop(
          await request(source, { number: item.number, cursor }),
          "issueOrPullRequest",
        );
        return prop(node, "comments");
      });
      item.comments.pageInfo = { hasNextPage: false, endCursor: null };
    }
    if (item.labels.pageInfo.hasNextPage)
      warnings.push(`${item.url}: labels exceed 100; label analysis incomplete.`);
  });
  for (const pr of pullRequests) {
    const nested: [string, Page<unknown> | undefined][] = [
      ["closing references", pr.closingIssuesReferences],
      ["review threads", pr.reviewThreads],
      ["reviews", pr.reviews],
      ["head checks", pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts],
    ];
    for (const [label, connection] of nested)
      if (connection?.pageInfo.hasNextPage)
        warnings.push(`${pr.url}: ${label} exceed 100; review/merge evidence incomplete.`);
  }
  // The same issue objects, now typed with their completed native evidence.
  const native = await concurrentMap(issues, (item) => completeNative(item, repository, query));
  const dependencies = [
    ...new Map(
      native
        .flatMap((item) => item.blockedBy.nodes)
        .map((item) => [
          item.url,
          { ...item, available: true, repository: item.repository.nameWithOwner },
        ]),
    ).values(),
  ];
  if (options.since && options.changeWindow)
    throw new Error("Choose either since or a change window, not both.");
  const since = options.since ?? options.changeWindow?.from ?? undefined;
  let changed: Snapshot["changed"] = [];
  let changeEvidence: Snapshot["changeEvidence"];
  if (since && options.changeWindow) {
    const window = options.changeWindow;
    const maxPages = options.maxChangePages ?? DEFAULT_CHANGE_PAGES;
    if (!Number.isSafeInteger(maxPages) || maxPages < 1)
      throw new Error("maxChangePages must be a positive integer.");
    const before = requestCount;
    const [issueNodes, issueCoverage] = await boundedChanges<EvidenceIssue>(
      "issues",
      `${common} stateReason ${nativeFields} ${issueEvidenceFields}`,
      ",states:[OPEN,CLOSED]",
      since,
      maxPages,
    );
    const [prNodes, prCoverage] = await boundedChanges<EvidencePullRequest>(
      "pullRequests",
      `${prFields} ${pullRequestEvidenceFields}`,
      ",states:[OPEN,CLOSED,MERGED]",
      since,
      maxPages,
    );
    changed = summarize([...issueNodes, ...prNodes]);
    const coverage = [issueCoverage, prCoverage];
    for (const item of coverage)
      if (!item.complete) warnings.push(`Change evidence incomplete: ${item.omission}`);
    changeEvidence = {
      schemaVersion: CHANGE_EVIDENCE_SCHEMA_VERSION,
      window,
      scope: { includes: CHANGE_SCOPE, excludes: CHANGE_SCOPE_EXCLUDES },
      coverage,
      complete: coverage.every((item) => item.complete),
      subjects: [
        ...issueNodes.map((node) => changeSubject("issue", node, window)),
        ...prNodes.map((node) => changeSubject("pull-request", node, window)),
      ],
      cost: { requests: requestCount - before, maxPagesPerSource: maxPages },
    };
  } else if (options.changeWindow) {
    // Baseline: no previous window, so nothing is labelled newly changed and no history query.
    changeEvidence = {
      schemaVersion: CHANGE_EVIDENCE_SCHEMA_VERSION,
      window: options.changeWindow,
      scope: { includes: CHANGE_SCOPE, excludes: CHANGE_SCOPE_EXCLUDES },
      coverage: [],
      complete: true,
      subjects: [],
      cost: { requests: 0, maxPagesPerSource: 0 },
    };
  } else if (since) {
    const values = await Promise.all([
      collection<Issue>(
        "issues",
        `${common} stateReason ${closedBy} ${nativeFields}`,
        ",states:[OPEN,CLOSED]",
        since,
      ),
      collection<PullRequest>("pullRequests", prFields, ",states:[OPEN,CLOSED,MERGED]", since),
    ]);
    changed = summarize([...values[0], ...values[1]]);
  }
  return {
    schemaVersion: 1,
    repository,
    startedAt,
    fetchedAt: now().toISOString(),
    issues,
    pullRequests,
    dependencies,
    changed,
    since: since ?? null,
    ...(changeEvidence ? { changeEvidence } : {}),
    warnings,
    rateLimit,
    metrics: { requestCount, durationMs: Date.parse(now().toISOString()) - Date.parse(startedAt) },
  };
}

const summarize = (nodes: (Issue | PullRequest)[]): Snapshot["changed"] =>
  nodes.map(({ number, title, url, state, updatedAt }) => ({
    number,
    title,
    url,
    state,
    updatedAt,
  }));

/** Bounded independent reads; results retain input order. */
export async function concurrentMap<T, R>(
  items: readonly T[],
  handler: (item: T, index: number) => Promise<R> | R,
  concurrency = 4,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await handler(items[index], index);
      }
    }),
  );
  return results;
}

/** Raw GraphQL response: data plus any errors, never thrown for GraphQL-level errors. */
export interface GraphqlAnswer {
  readonly data: unknown;
  readonly errors: readonly { type?: string; message?: string }[];
}

/** Injected authenticated GraphQL boundary. `query` is read-only; `mutate` changes GitHub. */
export interface GraphqlApi {
  query(query: string, variables: Record<string, string>): Promise<GraphqlAnswer>;
  mutate(query: string, variables: Record<string, string>): Promise<GraphqlAnswer>;
}

async function ghGraphql(query: string, variables: Record<string, string>): Promise<GraphqlAnswer> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) args.push("-f", `${key}=${value}`);
  let stdout: unknown;
  try {
    ({ stdout } = await execute("gh", args, { maxBuffer: 8 * 1024 * 1024, timeout: 60_000 }));
  } catch (error) {
    // gh exits non-zero on GraphQL errors but still prints the response body.
    stdout = prop(error, "stdout");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof stdout === "string" ? stdout : "");
  } catch {
    // Never echo arguments, stderr or response bodies.
    throw new Error("GitHub query failed. Check gh auth status, network and API rate limits.");
  }
  const errors = prop(parsed, "errors");
  return {
    data: prop(parsed, "data"),
    errors: Array.isArray(errors) ? errors.filter(isRecord) : [],
  };
}

/** Production GraphQL boundary through the existing authenticated `gh` (no shell). */
export const ghGraphqlApi: GraphqlApi = { query: ghGraphql, mutate: ghGraphql };

/**
 * A user's current permission on a repository (#212), as GitHub's REST collaborator-permission
 * endpoint reports it, or `unknown` when it cannot be established.
 */
export type RepositoryPermission =
  | "admin"
  | "maintain"
  | "write"
  | "triage"
  | "read"
  | "none"
  | "unknown";
/** Looks up one login's current repository permission; never throws. */
export type PermissionLookup = (login: string) => Promise<RepositoryPermission>;
const rolePermissions = new Set<RepositoryPermission>([
  "admin",
  "maintain",
  "write",
  "triage",
  "read",
  "none",
]);
/** Permissions that may drive workflow writes through a comment marker (#212). */
export const writePermissions: ReadonlySet<RepositoryPermission> = new Set([
  "admin",
  "maintain",
  "write",
]);

/**
 * A per-run permission lookup over the injected read-only REST boundary:
 * `GET /repos/{owner}/{repo}/collaborators/{username}/permission`, one request per distinct login
 * (case-insensitive) for the lifetime of the returned function, never persisted across runs.
 * `role_name` is preferred; a custom role falls back on the legacy `permission` field. A non-200
 * answer (404, missing access, rate limit), a transport error, a body for another user or an
 * unrecognised value is `unknown`, which grants nothing.
 */
export function permissionLookup(
  repository: string,
  rest: Rest = ghRest,
  signal?: AbortSignal,
): PermissionLookup {
  const cache = new Map<string, Promise<RepositoryPermission>>();
  const lookup = async (login: string): Promise<RepositoryPermission> => {
    // A cancelled run starts no further requests and never reports a partial answer as unknown.
    signal?.throwIfAborted();
    // A GitHub user login; anything else (an app's `name[bot]`, a malformed value) is never asked.
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) return "unknown";
    try {
      const answer = await rest(
        `repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`,
        signal ? { signal } : undefined,
      );
      if (answer.status !== 200 || !isRecord(answer.body)) return "unknown";
      const user = prop(answer.body, "user", "login");
      if (typeof user === "string" && user.toLowerCase() !== login.toLowerCase()) return "unknown";
      const role = prop(answer.body, "role_name");
      if (typeof role === "string" && rolePermissions.has(role as RepositoryPermission))
        return role as RepositoryPermission;
      const legacy = prop(answer.body, "permission");
      return typeof legacy === "string" && ["admin", "write", "read", "none"].includes(legacy)
        ? (legacy as RepositoryPermission)
        : "unknown";
    } catch {
      signal?.throwIfAborted();
      return "unknown";
    }
  };
  return (login) => {
    const key = login.toLowerCase();
    let answer = cache.get(key);
    if (!answer) {
      answer = lookup(login);
      cache.set(key, answer);
    }
    return answer;
  };
}
