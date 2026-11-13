/** Read-only, paginated gh GraphQL collector. Never invokes a mutation or shell. */
import { nativeFields, completeNative } from "./dependencies.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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

export const ghQuery: Query = async (query, variables) => {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) args.push("-F", `${key}=${value}`);
  let stdout: string;
  try {
    ({ stdout } = await execute("gh", args, { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 }));
  } catch (error) {
    // gh exits non-zero on any GraphQL error but still prints the response. A response whose
    // only errors are NOT_FOUND is a valid answer ("no such issue"): callers see null fields.
    const answer = graphqlAnswer(prop(error, "stdout"));
    if (answer) return answer;
    // Do not echo subprocess arguments, stderr, credentials or private API response bodies.
    throw new Error(
      "GitHub query failed. Check gh auth status, repository access and API rate limits.",
    );
  }
  const parsed: unknown = JSON.parse(stdout);
  const errors = prop(parsed, "errors");
  if (Array.isArray(errors) && errors.length && !graphqlAnswer(stdout))
    throw new Error("GitHub returned incomplete query data; no fresh report saved.");
  const data = prop(parsed, "data");
  if (!isRecord(data))
    throw new Error("GitHub returned incomplete query data; no fresh report saved.");
  return data;
};
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
export async function currentRepository(): Promise<string> {
  try {
    const { stdout } = await execute(
      "gh",
      ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
      { timeout: 30_000 },
    );
    return stdout.trim();
  } catch {
    throw new Error(
      "Cannot resolve repository. Supply --repo owner/name and check gh authentication.",
    );
  }
}
const info = "pageInfo{hasNextPage endCursor}";
const comment = "body url author{login} createdAt updatedAt";
const common = `number title body url state createdAt updatedAt lastEditedAt labels(first:100){nodes{name} ${info}} comments(first:100){nodes{${comment}} ${info}}`;
const prFields = `${common} headRefOid headRefName baseRefName isDraft mergeable mergeStateStatus reviewDecision mergedAt
 closingIssuesReferences(first:100){nodes{number url} ${info}}
 reviewThreads(first:100){nodes{isResolved isOutdated comments(first:1){totalCount nodes{${comment}} ${info}}} ${info}}
 reviews(first:100){nodes{body url author{login} state} ${info}}
 commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){nodes{__typename ... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}} ${info}}}}}}`;

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
}
export async function collect(
  repository: string,
  options: CollectOptions = {},
  query: Query = ghQuery,
  now: () => Date = () => new Date(),
): Promise<Snapshot> {
  const originalQuery = query;
  let requestCount = 0;
  query = (...args: Parameters<Query>) => {
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
  const [issues, pullRequests] = await Promise.all([
    collection<Issue>("issues", `${common} stateReason ${nativeFields}`, ",states:OPEN"),
    collection<PullRequest>("pullRequests", prFields, ",states:OPEN"),
  ]);
  const issueSource = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){${common} stateReason ${nativeFields}}}}`;
  if (options.issue && !issues.some((issue) => issue.number === options.issue)) {
    const detail = selected<Issue>(
      prop(await request(issueSource, { number: options.issue }), "issue"),
    );
    if (!detail) throw new Error(`Issue #${options.issue} is unavailable.`);
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
  let changed: Snapshot["changed"] = [];
  if (options.since) {
    const values = await Promise.all([
      collection<Issue>(
        "issues",
        `${common} stateReason ${nativeFields}`,
        ",states:[OPEN,CLOSED]",
        options.since,
      ),
      collection<PullRequest>(
        "pullRequests",
        prFields,
        ",states:[OPEN,CLOSED,MERGED]",
        options.since,
      ),
    ]);
    changed = [...values[0], ...values[1]].map(({ number, title, url, state, updatedAt }) => ({
      number,
      title,
      url,
      state,
      updatedAt,
    }));
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
    since: options.since ?? null,
    warnings,
    rateLimit,
    metrics: { requestCount, durationMs: Date.parse(now().toISOString()) - Date.parse(startedAt) },
  };
}

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
