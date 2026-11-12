/** Native dependency queries and pure facts. Contract: doc/issue-dependencies.md. */
import { ghQuery, pages, declaredDependencies } from "./github.js";
const pageInfo = "pageInfo { hasNextPage endCursor }";
export const summaryFields =
  "issueDependenciesSummary { blockedBy totalBlockedBy blocking totalBlocking }";
const nodeFields = `number title state stateReason url repository { nameWithOwner } ${summaryFields}`;
export const nativeFields = `${summaryFields} blockedBy(first:100) { nodes { ${nodeFields} } ${pageInfo} } blocking(first:100) { nodes { ${nodeFields} } ${pageInfo} }`;

export async function completeNative(item, repository, query = ghQuery) {
  for (const field of ["blockedBy", "blocking"]) {
    const initial = item[field];
    if (!initial || !item.issueDependenciesSummary)
      throw new Error(`Native dependency evidence missing for ${item.url}.`);
    item[field].nodes = await pages(async (cursor) => {
      if (!cursor) return initial;
      const [owner, name] = repository.split("/");
      const data = await query(
        `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){issue(number:$number){${field}(first:100,after:$cursor){nodes{${nodeFields}} ${pageInfo}}}}}`,
        { owner, name, number: item.number, cursor },
      );
      return data.repository?.issue?.[field];
    });
    item[field].pageInfo = { hasNextPage: false, endCursor: null };
    const expected =
      item.issueDependenciesSummary[field === "blockedBy" ? "totalBlockedBy" : "totalBlocking"];
    if (item[field].nodes.length !== expected)
      throw new Error(
        `Native dependency count changed or is incomplete for ${item.url}; refresh live.`,
      );
  }
  return item;
}
export const nativeKnown = (item) =>
  !!item.issueDependenciesSummary && !!item.blockedBy && !!item.blocking;
export const pickable = (item) =>
  nativeKnown(item) && item.issueDependenciesSummary.blockedBy === 0;
export const unblocks = (item) =>
  (item.blocking?.nodes ?? []).filter(
    (n) =>
      n.state === "OPEN" && n.issueDependenciesSummary?.blockedBy === 1 && item.state === "OPEN",
  ).length;
export const dependencyDrift = (item, repository) =>
  declaredDependencies(item.body, repository).filter(
    (ref) => !(item.blockedBy?.nodes ?? []).some((n) => n.url === ref.url),
  );
export function dependencyFacts(item, repository) {
  const known = nativeKnown(item);
  const blockers = item.blockedBy?.nodes ?? [];
  return {
    number: item.number,
    url: item.url,
    title: item.title,
    known,
    summary: item.issueDependenciesSummary ?? null,
    upstream: blockers,
    downstream: (item.blocking?.nodes ?? []).map((node) => ({
      ...node,
      lastOpenBlocker:
        item.state === "OPEN" &&
        node.state === "OPEN" &&
        node.issueDependenciesSummary?.blockedBy === 1,
    })),
    drift: dependencyDrift(item, repository),
    verdict: !known
      ? "Unknown native dependency evidence; refresh live."
      : blockers.some((n) => n.stateReason === "NOT_PLANNED")
        ? "A blocker was closed as not planned; human inspection required."
        : item.issueDependenciesSummary.blockedBy > 0
          ? `Waiting on ${blockers
              .filter((n) => n.state === "OPEN")
              .map((n) => n.url)
              .join(", ")}`
          : "No open native blockers; pickup still requires ready, unclaimed and acceptance verification.",
  };
}
export async function readDependencyIssue(repository, number, query = ghQuery) {
  const [owner, name] = repository.split("/");
  const data = await query(
    `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){number title body url state stateReason updatedAt labels(first:100){nodes{name} ${pageInfo}} ${nativeFields}}}}`,
    { owner, name, number },
  );
  const item = data.repository?.issue;
  if (!item)
    throw new Error(`Issue #${number} unavailable; pull requests cannot be native blockers.`);
  return completeNative(item, repository, query);
}
export async function dependencyReport(repository, number, { tree = false } = {}, query = ghQuery) {
  const startedAt = new Date().toISOString();
  const nodes = new Map();
  const visiting = new Set();
  const cycles = [];
  async function visit(repo, n, path = []) {
    const key = `${repo}#${n}`;
    if (visiting.has(key)) {
      cycles.push([...path, key]);
      return;
    }
    if (nodes.has(key)) return;
    const item = await readDependencyIssue(repo, n, query);
    nodes.set(key, dependencyFacts(item, repo));
    if (!tree) return;
    visiting.add(key);
    for (const ref of [...item.blockedBy.nodes, ...item.blocking.nodes]) {
      // Walk both directions for context; cycle detection uses upstream edges only below.
      const refRepo = ref.repository.nameWithOwner;
      if (!nodes.has(`${refRepo}#${ref.number}`)) await visit(refRepo, ref.number, []);
    }
    visiting.delete(key);
  }
  await visit(repository, number);
  // Directed DFS distinguishes a dependency cycle from a normal reverse relationship.
  const done = new Set();
  const stack = new Set();
  function detect(url, path = []) {
    if (stack.has(url)) {
      cycles.push([...path, url]);
      return;
    }
    if (done.has(url)) return;
    stack.add(url);
    const node = [...nodes.values()].find((n) => n.url === url);
    for (const ref of node?.upstream ?? []) detect(ref.url, [...path, url]);
    stack.delete(url);
    done.add(url);
  }
  if (tree) for (const node of nodes.values()) detect(node.url);
  return {
    schemaVersion: 1,
    repository,
    startedAt,
    fetchedAt: new Date().toISOString(),
    tree,
    nodes: [...nodes.values()],
    cycles,
    guidance:
      "Native blockers are authoritative. Closed blockers do not prove behavior was delivered. Body drift is migration context only.",
  };
}
export function dependencyText(report) {
  return (
    [
      `Native issue dependencies: ${report.repository}`,
      `LIVE ${report.startedAt}–${report.fetchedAt}`,
      report.guidance,
      ...report.nodes.flatMap((node) => [
        `\n#${node.number} ${node.title} ${node.url}`,
        node.verdict,
        ...node.upstream.map((n) => `  Upstream: ${n.url} ${n.state}/${n.stateReason ?? ""}`),
        ...node.downstream.map(
          (n) => `  Downstream: ${n.url}${n.lastOpenBlocker ? " — last open blocker" : ""}`,
        ),
        ...node.drift.map((n) => `  Drift: ${n.url} — text only; not yet migrated`),
      ]),
      ...report.cycles.map((path) => `CYCLE: ${path.join(" -> ")}`),
    ].join("\n") + "\n"
  );
}
