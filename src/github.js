/** Read-only, paginated gh GraphQL collector. Never invokes a mutation or shell. */
import { nativeFields, completeNative } from "./dependencies.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** @typedef {(query: string, variables: Record<string, string | number>) => Promise<Record<string, unknown>>} Query */
/** @type {Query} */
export const ghQuery = async (query, variables) => {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) args.push("-F", `${key}=${value}`);
  let stdout;
  try {
    ({ stdout } = await execute("gh", args, { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 }));
  } catch (error) {
    // gh exits non-zero on any GraphQL error but still prints the response. A response whose
    // only errors are NOT_FOUND is a valid answer ("no such issue"): callers see null fields.
    const answer = graphqlAnswer(error?.stdout);
    if (answer) return answer;
    // Do not echo subprocess arguments, stderr, credentials or private API response bodies.
    throw new Error(
      "GitHub query failed. Check gh auth status, repository access and API rate limits.",
    );
  }
  const parsed = JSON.parse(stdout);
  if (parsed.errors?.length && !graphqlAnswer(stdout))
    throw new Error("GitHub returned incomplete query data; no fresh report saved.");
  if (!parsed.data)
    throw new Error("GitHub returned incomplete query data; no fresh report saved.");
  return parsed.data;
};
/**
 * Data from a GraphQL response whose errors are all NOT_FOUND, else null.
 * @param {unknown} text
 * @returns {Record<string, unknown> | null}
 */
export function graphqlAnswer(text) {
  try {
    const parsed = JSON.parse(typeof text === "string" ? text : "");
    const notFoundOnly =
      Array.isArray(parsed.errors) &&
      parsed.errors.length > 0 &&
      parsed.errors.every((e) => e?.type === "NOT_FOUND");
    return notFoundOnly && parsed.data ? parsed.data : null;
  } catch {
    return null;
  }
}
export async function currentRepository() {
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
/**
 * @template T
 * @param {(cursor?: string) => Promise<import("./types.js").Page<T>>} fetch
 * @param {(page: T[]) => boolean} [stop]
 * @returns {Promise<T[]>}
 */
export async function pages(fetch, stop = () => false) {
  const result = [];
  const seen = new Set();
  let cursor;
  for (;;) {
    const page = await fetch(cursor);
    if (!page || !Array.isArray(page.nodes) || !page.pageInfo)
      throw new Error("Malformed GitHub connection.");
    result.push(...page.nodes);
    if (stop(page.nodes) || !page.pageInfo.hasNextPage) return result;
    const next = page.pageInfo.endCursor;
    if (!next || seen.has(next)) throw new Error("GitHub pagination did not advance.");
    seen.add(next);
    cursor = next;
  }
}

/** Only explicitly declared prerequisites, never every #mention in the body. */
/** @param {string} body @param {string} repository @returns {import("./types.js").Reference[]} */
export function declaredDependencies(body, repository) {
  const refs = new Map();
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
      const add = (repo, number, url) =>
        refs.set(`${repo}#${number}`, { repository: repo, number, url });
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

/**
 * @param {string} repository
 * @param {{ since?: string, issue?: number }} [options]
 * @param {Query} [query]
 * @param {() => Date} [now]
 * @returns {Promise<import("./types.js").Snapshot>}
 */
export async function collect(repository, options = {}, query = ghQuery, now = () => new Date()) {
  const originalQuery = query;
  let requestCount = 0;
  query = (...args) => {
    requestCount++;
    return originalQuery(...args);
  };
  const [owner, name] = repository.split("/");
  const vars = { owner: owner, name: name };
  const warnings = [];
  const startedAt = now().toISOString();
  let rateLimit = null;
  const request = async (source, variables = {}) => {
    const data = await query(source, { ...vars, ...variables });
    rateLimit = data.rateLimit ?? rateLimit;
    const repo = data.repository;
    if (!repo) throw new Error(`Repository unavailable: ${repository}`);
    return repo;
  };
  const collection = async (field, fields, states, cutoff) => {
    const source = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){${field}(first:50,after:$cursor,orderBy:{field:UPDATED_AT,direction:DESC}${states}){nodes{${fields}} ${info}}} rateLimit{remaining resetAt}}`;
    const nodes = await pages(
      async (cursor) => (await request(source, cursor ? { cursor } : {}))[field],
      (batch) => !!cutoff && batch.some((node) => Date.parse(node.updatedAt) < Date.parse(cutoff)),
    );
    return cutoff
      ? nodes.filter((node) => Date.parse(node.updatedAt) >= Date.parse(cutoff))
      : nodes;
  };
  const [issues, pullRequests] = await Promise.all([
    collection("issues", `${common} stateReason ${nativeFields}`, ",states:OPEN"),
    collection("pullRequests", prFields, ",states:OPEN"),
  ]);
  const issueSource = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){${common} stateReason ${nativeFields}}}}`;
  if (options.issue && !issues.some((issue) => issue.number === options.issue)) {
    const detail = (await request(issueSource, { number: options.issue })).issue;
    if (!detail) throw new Error(`Issue #${options.issue} is unavailable.`);
    issues.push(detail);
  }
  // All comments are available for semantic reconciliation, even if the briefing shows excerpts.
  await concurrentMap([...issues, ...pullRequests], async (item) => {
    if (item.comments.pageInfo.hasNextPage) {
      const source = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){... on Issue{comments(first:100,after:$cursor){nodes{${comment}} ${info}}} ... on PullRequest{comments(first:100,after:$cursor){nodes{${comment}} ${info}}}}}`;
      const initial = item.comments;
      item.comments.nodes = await pages(async (cursor) => {
        if (!cursor) return initial;
        const node = (await request(source, { number: item.number, cursor })).issueOrPullRequest;
        return node.comments;
      });
      item.comments.pageInfo = { hasNextPage: false, endCursor: null };
    }
    if (item.labels.pageInfo.hasNextPage)
      warnings.push(`${item.url}: labels exceed 100; label analysis incomplete.`);
  });
  for (const pr of pullRequests) {
    const nested = [
      ["closing references", pr.closingIssuesReferences],
      ["review threads", pr.reviewThreads],
      ["reviews", pr.reviews],
      ["head checks", pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts],
    ];
    for (const [label, connection] of nested)
      if (connection?.pageInfo.hasNextPage)
        warnings.push(`${pr.url}: ${label} exceed 100; review/merge evidence incomplete.`);
  }
  await concurrentMap(issues, (item) => completeNative(item, repository, query));
  const dependencies = [
    ...new Map(
      issues
        .flatMap((item) => item.blockedBy.nodes)
        .map((item) => [
          item.url,
          { ...item, available: true, repository: item.repository.nameWithOwner },
        ]),
    ).values(),
  ];
  let changed = [];
  if (options.since) {
    const values = await Promise.all([
      collection(
        "issues",
        `${common} stateReason ${nativeFields}`,
        ",states:[OPEN,CLOSED]",
        options.since,
      ),
      collection("pullRequests", prFields, ",states:[OPEN,CLOSED,MERGED]", options.since),
    ]);
    changed = values.flat().map(({ number, title, url, state, updatedAt }) => ({
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
export async function concurrentMap(items, handler, concurrency = 4) {
  const results = Array.from({ length: items.length });
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
