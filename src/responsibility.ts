/**
 * Delivery responsibility facts for next-action ranking (#182, consuming #190's records).
 * Contract: doc/design/delivery-lifecycle.md ("#182 ranking", rule L1/L2 over `responsible`).
 *
 * Reads only the comments already in the collected snapshot: no request is added beyond the
 * injected #212 trust decision for authors of recognised delivery records. A fold that is unknown
 * (truncated history, unverified, malformed, unsupported or unordered records) contributes no
 * responsibility and is reported, so unknown evidence is never read as "nobody is responsible".
 */
import type { Snapshot } from "./types.js";
import {
  parseDeliveryComment,
  readDeliveryFold,
  type DeliveryComment,
  type TrustDecision,
} from "./delivery.js";

export interface ResponsibilityFacts {
  /**
   * Deliverable (pull request) URL to every trusted responsible agent. Responsibility is
   * (agent, issue, deliverable): one PR can be required by several issues with different agents.
   */
  responsible: Map<string, string[]>;
  /** Issue URLs whose delivery records exist but could not be folded, with the reasons. */
  unknown: { issue: string; because: string[] }[];
}

const pullUrl = (repository: string, number: number): string =>
  `https://github.com/${repository}/pull/${number}`;

/** Folds the delivery records on each snapshot issue that carries any. */
export async function readSnapshotResponsibility(
  snapshot: Snapshot,
  trust: TrustDecision | undefined,
  signal?: AbortSignal,
): Promise<ResponsibilityFacts> {
  const facts: ResponsibilityFacts = { responsible: new Map(), unknown: [] };
  // Records name a repository as written; match it to the collected URL case-insensitively.
  const collected = new Map(snapshot.pullRequests.map((p) => [p.url.toLowerCase(), p.url]));
  for (const issue of snapshot.issues) {
    signal?.throwIfAborted();
    const comments = issue.comments.nodes;
    if (!comments.some((c) => parseDeliveryComment(c.body).kind !== "none")) continue;
    if (!trust) {
      facts.unknown.push({
        issue: issue.url,
        because: ["delivery record authors' permissions were not read"],
      });
      continue;
    }
    const { fold } = await readDeliveryFold(
      comments as DeliveryComment[],
      !issue.comments.pageInfo.hasNextPage,
      { repository: snapshot.repository, issue: issue.number },
      trust,
    );
    if (fold.recordsUnknown) {
      facts.unknown.push({ issue: issue.url, because: fold.unknownBecause });
      continue;
    }
    for (const member of fold.members)
      if (member.deliverable.kind === "pr" && member.responsible) {
        const url = pullUrl(member.deliverable.repository, member.deliverable.number);
        const key = collected.get(url.toLowerCase()) ?? url;
        const agents = facts.responsible.get(key) ?? [];
        if (!agents.includes(member.responsible)) agents.push(member.responsible);
        facts.responsible.set(key, agents);
      }
  }
  return facts;
}
