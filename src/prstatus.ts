/**
 * "Why is this pull request not progressing?" in one operation (#59).
 * Contract: doc/design/diagnostics.md, "#59".
 *
 * Reports every blocker at once from current evidence: required-check outcomes classified as
 * passed / pending / cancelled / failed / missing / unknown, bounded failure detail, review
 * state with the reviewed commit against the current head, unresolved threads with later
 * replies, review receipts posted as comments, unanswered review requests, conflicts, linked
 * issues and their explicit owners. Green evidence means "inspect / consider merging", never
 * approval.
 */
import { workflow } from "./briefing.js";
import { ghQuery, prop, selected } from "./github.js";
import type { Query } from "./github.js";

type Login = { login: string } | null;
type PageInfo = { hasNextPage?: boolean; hasPreviousPage?: boolean };
type CheckContext = {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string | null;
  conclusion?: string | null;
  state?: string | null;
  detailsUrl?: string | null;
  targetUrl?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
};
type ReviewNode = {
  author: Login;
  state: string;
  submittedAt: string | null;
  url: string;
  commit: { oid: string } | null;
};
type ThreadComment = { author: Login; body?: string; createdAt: string | null; url: string };
type ThreadNode = {
  isResolved: boolean;
  isOutdated?: boolean;
  path?: string | null;
  line?: number | null;
  first?: { totalCount?: number; nodes: ThreadComment[] } | null;
  latest?: { nodes: ThreadComment[] } | null;
};
type CommentNode = { author: Login; body: string | null; createdAt: string; url: string };
type LinkedIssueNode = {
  number: number;
  url: string;
  title: string;
  state: string;
  labels: { nodes: { name: string }[] };
};
/** The pull request as selected by `query` below. */
export type PullRequestNode = {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft?: boolean;
  merged?: boolean;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision?: string | null;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  updatedAt: string;
  commits: {
    nodes: {
      commit: {
        oid?: string;
        statusCheckRollup: {
          state?: string;
          contexts: { nodes: CheckContext[]; pageInfo: PageInfo };
        } | null;
      };
    }[];
  };
  reviews: { nodes: ReviewNode[]; pageInfo?: PageInfo };
  reviewThreads: { nodes: ThreadNode[]; pageInfo: PageInfo };
  comments: { nodes: CommentNode[]; pageInfo?: PageInfo };
  closingIssuesReferences: { nodes: LinkedIssueNode[]; pageInfo?: PageInfo };
};

export type CheckClass = "passed" | "pending" | "cancelled" | "failed" | "unknown";
/** Codex's machine-readable review state, embedded in its summary comment. */
export type CodexReviewState = {
  status?: string;
  commit_sha?: string;
  has_unresolved_findings?: boolean;
};
type CodexMarker = { code_review?: CodexReviewState };
export type Receipt = {
  by: string;
  at: string;
  url: string;
  summary: string;
  codexState: CodexMarker | null;
};
export type PrStatusReport = {
  schemaVersion: 1;
  kind: "pr-status";
  repository: string;
  fetchedAt: string;
  startedAt: string;
  pullRequest: {
    number: number;
    title: string;
    url: string;
    state: string;
    draft: boolean;
    head: string;
    branch: string;
    base: string;
    mergeable: string;
    mergeState: string;
    reviewDecision: string | null;
    updatedAt: string;
  };
  checks: {
    required: { name: string; class: CheckClass; outcome: string; url: string } | null;
    counts: Record<string, number>;
    problems: { name: string; class: CheckClass; outcome: string; url: string; note?: string }[];
    omittedProblems: number;
  };
  reviews: {
    reviewer: string;
    state: string;
    submittedAt: string | null;
    reviewedCommit: string | null;
    current: boolean;
    url: string;
  }[];
  threads: {
    unresolved: {
      path: string | null;
      line: number | null;
      outdated: boolean;
      finding: string;
      by: string;
      url: string;
      replies: number;
      lastSpeaker: string | null;
      lastAt: string | null;
    }[];
    omitted: number;
  };
  receipts: Receipt[];
  /** Earlier receipts dropped by the presentation limit. */
  omittedReceipts: number;
  reviewRequest: { at: string; url: string; status: string } | null;
  linkedIssues: {
    number: number;
    url: string;
    title: string;
    state: string;
    owners: string[];
  }[];
  blockers: string[];
  verdict: string;
  completeness: { complete: boolean; warnings: string[] };
};

const query = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number title url state isDraft merged mergeable mergeStateStatus reviewDecision headRefOid headRefName baseRefName updatedAt
commits(last:1){nodes{commit{oid committedDate statusCheckRollup{state contexts(first:100){nodes{__typename ... on CheckRun{name status conclusion detailsUrl startedAt completedAt} ... on StatusContext{context state targetUrl}} pageInfo{hasNextPage}}}}}}
reviews(last:50){nodes{author{login} state submittedAt url commit{oid}} pageInfo{hasPreviousPage}}
reviewThreads(first:100){nodes{isResolved isOutdated path line first:comments(first:1){totalCount nodes{author{login} body createdAt url}} latest:comments(last:1){nodes{author{login} createdAt url}}} pageInfo{hasNextPage}}
comments(last:100){nodes{author{login} body createdAt url} pageInfo{hasPreviousPage}}
closingIssuesReferences(first:10){nodes{number url title state labels(first:50){nodes{name}}} pageInfo{hasNextPage}}}}}`;

/** Bounds keep the report small; omitted counts are always reported. */
export const limits = { failures: 5, threads: 8, receipts: 3, excerpt: 240 };

const excerpt = (text: string | null | undefined): string => {
  const flat = String(text ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > limits.excerpt ? `${flat.slice(0, limits.excerpt - 1)}…` : flat;
};

/** Classify one check context. Cancelled is incomplete verification, not a code defect. */
export function classifyCheck(check: CheckContext): CheckClass {
  const status = check.status ?? null;
  const outcome = check.conclusion ?? check.state ?? null;
  if (status && status !== "COMPLETED" && !check.conclusion) return "pending";
  if (outcome === null) return "unknown";
  if (["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"].includes(outcome))
    return "pending";
  if (workflow.pass.includes(outcome)) return "passed";
  if (outcome === "CANCELLED") return "cancelled";
  if (workflow.failure.includes(outcome)) return "failed";
  return "unknown";
}

const isBot = (login: string | undefined): boolean =>
  /\[bot\]$|^coderabbitai$|^chatgpt-codex-connector$/.test(login ?? "");
const requestPattern = /@(codex|coderabbitai)\s+review\b/i;
/** The account that answers each review request; other bots never count as an answer. */
const reviewerFor: Record<string, string> = {
  codex: "chatgpt-codex-connector",
  coderabbitai: "coderabbitai",
};

/**
 * Build the report from a fetched pull request. Pure; `now` is injected.
 */
export function prStatus(
  repository: string,
  pr: PullRequestNode,
  { now = new Date(), startedAt }: { now?: Date; startedAt?: string } = {},
): PrStatusReport {
  const head = pr.headRefOid;
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup ?? null;
  const contexts = (rollup?.contexts.nodes ?? []).map((c) => ({
    name: c.name ?? c.context ?? "unnamed",
    outcome: c.conclusion ?? c.state ?? c.status ?? "UNKNOWN",
    class: classifyCheck(c),
    url: c.detailsUrl ?? c.targetUrl ?? pr.url,
    noRunTime: c.__typename === "CheckRun" && !c.startedAt,
  }));
  const required = contexts.find((c) => c.name === workflow.verify) ?? null;
  const byClass = (k: CheckClass) => contexts.filter((c) => c.class === k);
  const problems = [...byClass("failed"), ...byClass("cancelled")];

  // Reviews: latest per reviewer, with the commit reviewed against the current head.
  const latestByReviewer = new Map<string, ReviewNode>();
  for (const r of pr.reviews.nodes) {
    const who = r.author?.login ?? "unknown";
    const prev = latestByReviewer.get(who);
    if (!prev || (r.submittedAt ?? "") > (prev.submittedAt ?? "")) latestByReviewer.set(who, r);
  }
  const reviews = [...latestByReviewer.values()].map((r) => ({
    reviewer: r.author?.login ?? "unknown",
    state: r.state,
    submittedAt: r.submittedAt,
    reviewedCommit: r.commit?.oid ?? null,
    current: r.commit?.oid === head,
    url: r.url,
  }));

  // Threads: unresolved first-comment findings, with later replies and who spoke last.
  const unresolved = pr.reviewThreads.nodes.filter((t) => !t.isResolved);
  const threads = unresolved.map((t) => {
    // The finding is the thread's first comment; the last speaker is its latest comment, read
    // separately so a long thread is never cut off before its newest reply.
    const opening = t.first?.nodes[0];
    const last = t.latest?.nodes[0] ?? opening;
    return {
      path: t.path ?? null,
      line: t.line ?? null,
      outdated: !!t.isOutdated,
      finding: excerpt(opening?.body),
      by: opening?.author?.login ?? "unknown",
      url: opening?.url ?? pr.url,
      replies: Math.max(0, (t.first?.totalCount ?? 1) - 1),
      lastSpeaker: last?.author?.login ?? null,
      lastAt: last?.createdAt ?? null,
    };
  });

  // Review receipts may be ordinary comments; requests are comments asking for a review.
  const comments = pr.comments.nodes;
  const receipts = comments
    .filter((c) => isBot(c.author?.login))
    .map((c) => ({
      by: c.author?.login ?? "unknown",
      at: c.createdAt,
      url: c.url,
      summary: excerpt(c.body).slice(0, 160),
      codexState: ((): CodexMarker | null => {
        const m = /codex-review-state:v1 (\{.*?\}) -->/.exec(c.body ?? "");
        try {
          const parsed: unknown = m ? JSON.parse(m[1]) : null;
          return selected<CodexMarker>(parsed);
        } catch {
          return null;
        }
      })(),
    }));
  const codex =
    receipts
      .map((r) => r.codexState)
      .filter((m): m is CodexMarker => m !== null)
      .at(-1)?.code_review ?? null;
  // Bots often update one summary comment in place, so a receipt's creation time does not show
  // whether a later request was answered. Codex's state marker records the commit it reviewed.
  // Bot replies often quote "@coderabbitai review" as an instruction; only non-bot comments
  // count as requests, so a receipt can never replace the request it answers.
  const lastRequest =
    comments.filter((c) => !isBot(c.author?.login) && requestPattern.test(c.body ?? "")).at(-1) ??
    null;
  const requested =
    reviewerFor[(requestPattern.exec(lastRequest?.body ?? "")?.[1] ?? "").toLowerCase()];
  const answerer = (login: string | undefined): string => (login ?? "").replace(/\[bot\]$/, "");
  const newerReceipt = (at: string): boolean =>
    receipts.some((r) => answerer(r.by) === requested && (r.at ?? "") > at && !r.codexState) ||
    // A formal review by the requested service also answers the request.
    pr.reviews.nodes.some(
      (r) => answerer(r.author?.login) === requested && (r.submittedAt ?? "") > at,
    );
  const request: PrStatusReport["reviewRequest"] = lastRequest
    ? {
        at: lastRequest.createdAt,
        url: lastRequest.url,
        // The Codex state marker answers only a Codex request; other services need their own reply.
        status:
          requested === reviewerFor.codex &&
          codex?.commit_sha === head &&
          codex.status === "completed"
            ? "current head reviewed (Codex)"
            : requested === reviewerFor.codex && codex?.commit_sha === head
              ? `review in progress on the current head (Codex: ${codex.status})`
              : newerReceipt(lastRequest.createdAt)
                ? "a reviewer has posted since the request"
                : "no reaction yet",
      }
    : null;

  const linkedIssues = pr.closingIssuesReferences.nodes.map((i) => ({
    number: i.number,
    url: i.url,
    title: i.title,
    state: i.state,
    owners: i.labels.nodes
      .map((l) => l.name)
      .filter((n) => n.startsWith(workflow.ownerPrefix))
      .map((n) => n.slice(workflow.ownerPrefix.length)),
  }));

  /** Every current blocker, simultaneously; no single merge verdict. */
  const blockers: string[] = [];
  const open = pr.state === "OPEN";
  if (!open) blockers.push(`pull request is ${pr.merged ? "merged" : pr.state.toLowerCase()}`);
  // Merge-readiness blockers only make sense for an open pull request.
  if (open) {
    if (pr.isDraft) blockers.push("draft");
    if (!required)
      blockers.push(
        byClass("pending").length
          ? `required check \`${workflow.verify}\` not reported yet on head ${head.slice(0, 7)} (other checks still pending)`
          : `required check \`${workflow.verify}\` is missing on head ${head.slice(0, 7)}`,
      );
    else if (required.class !== "passed")
      blockers.push(
        `required check \`${workflow.verify}\` is ${required.class} on head ${head.slice(0, 7)}`,
      );
    // The required check must succeed (workflow.verifySuccess); skipped or neutral is not proof.
    else if (!workflow.verifySuccess.includes(required.outcome))
      blockers.push(
        `required check \`${workflow.verify}\` concluded ${required.outcome.toLowerCase()} on head ${head.slice(0, 7)}; it must succeed`,
      );
    for (const c of byClass("failed")) if (c !== required) blockers.push(`check ${c.name} failed`);
    for (const c of byClass("cancelled"))
      if (c !== required)
        blockers.push(
          `check ${c.name} cancelled${c.noRunTime ? " without running (likely infrastructure, not a code defect)" : ""}: verification incomplete`,
        );
    if (byClass("pending").length)
      blockers.push(`${byClass("pending").length} check(s) still pending: waiting`);
    if (pr.mergeable === "CONFLICTING") blockers.push("merge conflicts with the base branch");
    else if (pr.mergeable === "UNKNOWN")
      blockers.push("mergeability unknown (GitHub still computing)");
    // A merge state outside the registered current states (workflow.currentMergeStates, as used
    // by the pr-merge-state rule) blocks merging. BLOCKED is explained below; DIRTY and DRAFT
    // are already reported as conflicts and draft.
    const state = pr.mergeStateStatus;
    if (
      !workflow.currentMergeStates.includes(state) &&
      state !== "BLOCKED" &&
      !(state === "DIRTY" && pr.mergeable === "CONFLICTING") &&
      !(state === "DRAFT" && pr.isDraft) &&
      !(state === "UNKNOWN" && pr.mergeable === "UNKNOWN")
    )
      blockers.push(
        state === "BEHIND"
          ? `branch is behind ${pr.baseRefName}: update it before merging`
          : `merge state ${state} is not current: merging is not possible yet`,
      );
    if (pr.reviewDecision === "CHANGES_REQUESTED") blockers.push("changes requested");
    if (pr.reviewDecision === "REVIEW_REQUIRED")
      blockers.push("a required approving review is missing");
    if (unresolved.length) blockers.push(`${unresolved.length} unresolved review thread(s)`);
    if (codex?.has_unresolved_findings && codex.commit_sha === head)
      blockers.push("Codex reports unresolved findings on the current head");
    else if (
      codex &&
      codex.commit_sha !== head &&
      // A formal Codex review of the current head covers it even if the marker comment is stale.
      !pr.reviews.nodes.some(
        (r) => answerer(r.author?.login) === reviewerFor.codex && r.commit?.oid === head,
      )
    )
      blockers.push("Codex's latest review is for an older commit; current head not yet covered");
    if (request?.status === "no reaction yet")
      blockers.push("a review was requested and has had no reaction");
    else if (request?.status.startsWith("review in progress"))
      blockers.push(`waiting for the requested review to finish (${request.status})`);
    // An automatically started review is still running even when nobody asked for it.
    else if (codex?.commit_sha === head && codex.status && codex.status !== "completed")
      blockers.push(`waiting for Codex's review of the current head to finish (${codex.status})`);
  }

  // GitHub says merging is blocked but nothing above explains it: report that, never "no blocker".
  if (open && !blockers.length && pr.mergeStateStatus === "BLOCKED")
    blockers.push("GitHub reports merging is blocked (branch protection); inspect the rules");

  const incomplete: string[] = [];
  if (rollup?.contexts.pageInfo.hasNextPage) incomplete.push("more than 100 check contexts");
  if (pr.reviewThreads.pageInfo.hasNextPage) incomplete.push("more than 100 review threads");
  // Truncated evidence is reported, never silently treated as complete.
  if (pr.comments.pageInfo?.hasPreviousPage)
    incomplete.push(
      "more than 100 comments; older comments (and earlier review receipts) not read",
    );
  if (pr.reviews.pageInfo?.hasPreviousPage)
    incomplete.push("more than 50 reviews; older reviews not read");
  if (pr.closingIssuesReferences.pageInfo?.hasNextPage)
    incomplete.push("more than 10 linked issues; ownership of the rest not read");

  return {
    schemaVersion: 1,
    kind: "pr-status",
    repository,
    fetchedAt: now.toISOString(),
    startedAt: startedAt ?? now.toISOString(),
    pullRequest: {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      state: pr.merged ? "MERGED" : pr.state,
      draft: !!pr.isDraft,
      head,
      branch: pr.headRefName,
      base: pr.baseRefName,
      mergeable: pr.mergeable,
      mergeState: pr.mergeStateStatus,
      reviewDecision: pr.reviewDecision ?? null,
      updatedAt: pr.updatedAt,
    },
    checks: {
      required: required
        ? {
            name: required.name,
            class: required.class,
            outcome: required.outcome,
            url: required.url,
          }
        : null,
      counts: Object.fromEntries(
        (["passed", "pending", "cancelled", "failed", "unknown"] as const).map((k) => [
          k,
          byClass(k).length,
        ]),
      ),
      problems: problems
        .slice(0, limits.failures)
        .map(({ name, class: k, outcome, url, noRunTime }) => ({
          name,
          class: k,
          outcome,
          url,
          ...(noRunTime ? { note: "no recorded run time" } : {}),
        })),
      omittedProblems: Math.max(0, problems.length - limits.failures),
    },
    reviews,
    threads: {
      unresolved: threads.slice(0, limits.threads),
      omitted: Math.max(0, threads.length - limits.threads),
    },
    receipts: receipts.slice(-limits.receipts),
    omittedReceipts: Math.max(0, receipts.length - limits.receipts),
    reviewRequest: request,
    linkedIssues,
    blockers,
    verdict: blockers.length
      ? "Blocked: address every listed blocker."
      : "No blocker found in current evidence: inspect the diff and consider merging. This is not approval.",
    completeness: { complete: !incomplete.length, warnings: incomplete },
  };
}

/** Fetch live and report. */
export async function pullRequestStatus(
  repository: string,
  number: number,
  q: Query = ghQuery,
  now: () => Date = () => new Date(),
): Promise<PrStatusReport> {
  const startedAt = now().toISOString();
  const [owner, name] = repository.split("/");
  const data = await q(query, { owner, name, number });
  const pr = selected<PullRequestNode>(prop(data, "repository", "pullRequest"));
  if (!pr) throw new Error(`Pull request #${number} is unavailable in ${repository}.`);
  return prStatus(repository, pr, { now: now(), startedAt });
}

/** Text rendering. */
export function prStatusText(r: PrStatusReport): string {
  const p = r.pullRequest;
  const lines = [
    `PR #${p.number} ${p.title} ${p.url}`,
    `${p.state}${p.draft ? " (draft)" : ""} · head ${p.head.slice(0, 7)} on ${p.branch} → ${p.base} · mergeable ${p.mergeable} (${p.mergeState}) · fetched ${r.fetchedAt}`,
    "",
    r.blockers.length ? "BLOCKERS" : "BLOCKERS: none found",
    ...r.blockers.map((b) => `- ${b}`),
    "",
    `Checks: ${Object.entries(r.checks.counts)
      .map(([k, v]) => `${k} ${v}`)
      .join(
        ", ",
      )}; required ${r.checks.required ? `${r.checks.required.name} ${r.checks.required.class}` : "missing"}`,
    ...r.checks.problems.map(
      (c) => `  ${c.class}: ${c.name} (${c.outcome}${c.note ? `, ${c.note}` : ""}) ${c.url}`,
    ),
    ...(r.checks.omittedProblems ? [`  …${r.checks.omittedProblems} more`] : []),
    `Reviews: decision ${p.reviewDecision ?? "none"}`,
    ...r.reviews.map(
      (v) =>
        `  ${v.reviewer}: ${v.state} on ${v.reviewedCommit?.slice(0, 7) ?? "?"}${v.current ? " (current head)" : " (older commit)"}`,
    ),
    `Unresolved threads: ${r.threads.unresolved.length + r.threads.omitted}`,
    ...r.threads.unresolved.map(
      (t) =>
        `  ${t.path ?? "general"}${t.line ? `:${t.line}` : ""} by ${t.by}${t.outdated ? " (outdated)" : ""}, ${t.replies} repl${t.replies === 1 ? "y" : "ies"}, last ${t.lastSpeaker ?? "?"}: ${t.finding} ${t.url}`,
    ),
    ...(r.threads.omitted ? [`  …${r.threads.omitted} more`] : []),
    ...(r.reviewRequest ? [`Review request ${r.reviewRequest.at}: ${r.reviewRequest.status}`] : []),
    ...r.receipts.map(
      (x) =>
        `Receipt ${x.by} ${x.at}${x.codexState?.code_review ? ` (Codex: ${x.codexState.code_review.status} on ${String(x.codexState.code_review.commit_sha).slice(0, 7)}, unresolved findings ${x.codexState.code_review.has_unresolved_findings})` : ""}${x.summary ? `: ${x.summary}` : ""} ${x.url}`,
    ),
    ...(r.omittedReceipts ? [`  …${r.omittedReceipts} earlier receipt(s) omitted`] : []),
    ...r.linkedIssues.map(
      (i) => `Linked #${i.number} ${i.state} owners: ${i.owners.join(", ") || "none"}`,
    ),
    "",
    r.verdict,
    ...r.completeness.warnings.map((w) => `INCOMPLETE: ${w}`),
  ];
  return lines.join("\n") + "\n";
}
