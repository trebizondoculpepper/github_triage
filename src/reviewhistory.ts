/**
 * "Why does this work keep failing review?" (#60): the explicit deeper review-history mode of
 * `pr N`. Contract: doc/design/diagnostics.md, "#60".
 *
 * Extends the #59 current-head diagnosis (reused, not re-collected) with review rounds matched
 * to the commits they reviewed, the commits between rounds, findings with their resolution and
 * the author's responses, and recurring themes. Every classification is a structured,
 * evidence-linked candidate for inspection. The tool never infers causation from counts,
 * never judges value, and never changes scope, threads or reviews; the consuming agent
 * interprets the signals.
 */
import { ghQuery, prop, selected } from "./github.js";
import type { Query } from "./github.js";
import { codexMarker, excerpt, pullRequestStatus } from "./prstatus.js";
import type { PrStatusReport } from "./prstatus.js";

type Login = { login: string } | null;
type HistoryComment = {
  author: Login;
  body?: string | null;
  createdAt: string | null;
  url: string;
  originalCommit?: { oid: string } | null;
};
/** The pull request as selected by `historyQuery` below. */
export type ReviewHistoryNode = {
  number: number;
  url: string;
  headRefOid: string;
  author: Login;
  commits: {
    totalCount?: number;
    nodes: { commit: { oid: string; committedDate?: string; messageHeadline?: string } }[];
    pageInfo?: { hasNextPage?: boolean };
  };
  reviews: {
    nodes: {
      author: Login;
      state: string;
      submittedAt: string | null;
      url: string;
      commit: { oid: string } | null;
    }[];
    pageInfo?: { hasNextPage?: boolean };
  };
  reviewThreads: {
    nodes: {
      isResolved: boolean;
      isOutdated?: boolean;
      path?: string | null;
      line?: number | null;
      comments: { totalCount?: number; nodes: HistoryComment[] };
    }[];
    pageInfo?: { hasNextPage?: boolean };
  };
  comments: { nodes: HistoryComment[]; pageInfo?: { hasNextPage?: boolean } };
};

/** How a finding relates to earlier findings. Candidates for inspection, never verdicts. */
export type FindingClass =
  | "initial"
  | "repeated"
  | "duplicate"
  | "same-area-after-fix"
  | "new-later";

export type Finding = {
  title: string;
  severity: string | null;
  by: string;
  path: string | null;
  line: number | null;
  raisedOn: string | null;
  round: number | null;
  status: "open" | "resolved";
  outdated: boolean;
  url: string;
  authorReplies: number;
  /** PR commits the author's replies cite (e.g. "Fixed in abc1234"). */
  citedFixes: string[];
  lastSpeaker: string | null;
  class: FindingClass;
  basis: string;
  related: string[];
};

export type Round = {
  round: number;
  commit: string;
  inHistory: boolean;
  current: boolean;
  reviewers: { by: string; state: string; at: string | null; url: string }[];
  findingsRaised: number;
  /** Commits pushed after the previous round's commit, up to this one. */
  commitsSincePrevious: number | null;
  commitHeadlines: string[];
};

export type ReviewHistoryReport = {
  schemaVersion: 1;
  kind: "pr-review-history";
  repository: string;
  fetchedAt: string;
  startedAt: string;
  pullRequest: { number: number; url: string; head: string; author: string | null };
  /** The #59 current-head diagnosis this mode extends. */
  current: Pick<PrStatusReport, "blockers" | "verdict">;
  rounds: Round[];
  omittedRounds: number;
  headReviewed: boolean;
  findings: Finding[];
  omittedFindings: number;
  counts: Record<FindingClass | "open" | "resolved" | "total", number>;
  themes: { path: string; findings: number; rounds: number[]; open: number; links: string[] }[];
  omittedThemes: number;
  disagreements: { commit: string; states: Record<string, string> }[];
  signal: {
    repeatedCycleCandidate: boolean;
    roundsWithFindings: number;
    threshold: number;
    reasons: string[];
  };
  nextActions: { action: string; basis: string; evidence: string[] }[];
  uncertainty: string[];
  nextCommands: string[];
  cost: { requests: number };
  completeness: { complete: boolean; warnings: string[] };
};

const historyQuery = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number url headRefOid author{login}
commits(first:100){totalCount nodes{commit{oid committedDate messageHeadline}} pageInfo{hasNextPage}}
reviews(first:100){nodes{author{login} state submittedAt url commit{oid}} pageInfo{hasNextPage}}
reviewThreads(first:100){nodes{isResolved isOutdated path line comments(first:20){totalCount nodes{author{login} body createdAt url originalCommit{oid}}}} pageInfo{hasNextPage}}
comments(first:100){nodes{author{login} body createdAt url} pageInfo{hasNextPage}}}}}`;

/**
 * Presentation bounds and the inspection threshold. Reaching the threshold marks a candidate
 * for inspection only; it never decides scope.
 */
export const historyLimits = { rounds: 8, findings: 10, themes: 5, links: 3, cycleThreshold: 3 };

const login = (a: Login): string => (a?.login ?? "unknown").replace(/\[bot\]$/, "");

/** The finding's title: a reviewer's bold heading (Codex style) or its first sentence. */
export function findingTitle(body: string | null | undefined): {
  title: string;
  severity: string | null;
} {
  const text = String(body ?? "");
  const severity = /!\[(P\d) Badge\]/.exec(text)?.[1] ?? null;
  const bold = /\*\*([\s\S]*?)\*\*/.exec(text)?.[1];
  const heading = bold
    ?.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
  const title = heading || excerpt(text).split(/(?<=[.!?])\s/)[0];
  return { title: excerpt(title).slice(0, 120), severity };
}

const key = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Build the report from fetched history and the #59 report. Pure; `now` is injected. */
export function reviewHistory(
  repository: string,
  pr: ReviewHistoryNode,
  status: Pick<PrStatusReport, "blockers" | "verdict" | "completeness">,
  { now = new Date(), startedAt }: { now?: Date; startedAt?: string } = {},
): ReviewHistoryReport {
  const head = pr.headRefOid;
  const author = pr.author ? login(pr.author) : null;
  const short = (sha: string | null | undefined): string => (sha ?? "?").slice(0, 7);
  const commits = pr.commits.nodes.map((n) => n.commit);
  const position = new Map(commits.map((c, i) => [c.oid, i]));
  const warnings: string[] = [...status.completeness.warnings];

  // Review events: formal reviews by anyone but the PR author (GitHub records the author's
  // thread replies as reviews too), plus Codex state markers naming the reviewed commit.
  type Event = { by: string; state: string; at: string | null; url: string; commit: string };
  const events: Event[] = [];
  for (const r of pr.reviews.nodes) {
    if (!r.commit?.oid || login(r.author) === author) continue;
    events.push({
      by: login(r.author),
      state: r.state,
      at: r.submittedAt,
      url: r.url,
      commit: r.commit.oid,
    });
  }
  for (const c of pr.comments.nodes) {
    const state = codexMarker(c.body)?.code_review;
    if (!state?.commit_sha || state.status !== "completed") continue;
    const by = login(c.author);
    if (events.some((e) => e.by === by && e.commit === state.commit_sha)) continue;
    events.push({
      by,
      state: state.has_unresolved_findings ? "FINDINGS (marker)" : "NO FINDINGS (marker)",
      at: c.createdAt,
      url: c.url,
      commit: state.commit_sha,
    });
  }

  // Findings: review threads opened by someone other than the PR author.
  type Raw = Omit<Finding, "class" | "basis" | "related" | "round"> & { order: string };
  const raw: Raw[] = [];
  for (const t of pr.reviewThreads.nodes) {
    const first = t.comments.nodes[0];
    if (!first || login(first.author) === author) continue;
    if ((t.comments.totalCount ?? 0) > t.comments.nodes.length)
      warnings.push(
        `a thread has more than ${t.comments.nodes.length} comments; later replies not read`,
      );
    const replies = t.comments.nodes.slice(1).filter((c) => login(c.author) === author);
    const cited = new Set<string>();
    for (const reply of replies)
      for (const m of String(reply.body ?? "").matchAll(/\b[0-9a-f]{7,40}\b/g)) {
        const hit = commits.find((c) => c.oid.startsWith(m[0]));
        if (hit) cited.add(hit.oid);
      }
    const last = t.comments.nodes.at(-1);
    raw.push({
      ...findingTitle(first.body),
      by: login(first.author),
      path: t.path ?? null,
      line: t.line ?? null,
      raisedOn: first.originalCommit?.oid ?? null,
      status: t.isResolved ? "resolved" : "open",
      outdated: !!t.isOutdated,
      url: first.url,
      authorReplies: replies.length,
      citedFixes: [...cited],
      lastSpeaker: last ? login(last.author) : null,
      order: first.createdAt ?? "",
    });
  }

  // Rounds: one per reviewed commit (or commit a finding was raised on), in commit order.
  const reviewed = new Set([
    ...events.map((e) => e.commit),
    ...raw.map((f) => f.raisedOn).filter((s): s is string => !!s),
  ]);
  const firstSeen = (sha: string): string =>
    events
      .filter((e) => e.commit === sha)
      .map((e) => e.at ?? "")
      .concat(raw.filter((f) => f.raisedOn === sha).map((f) => f.order))
      .sort((a, b) => a.localeCompare(b))[0] ?? "";
  const ordered = [...reviewed].sort((a, b) => {
    const pa = position.get(a);
    const pb = position.get(b);
    return pa !== undefined && pb !== undefined ? pa - pb : firstSeen(a) < firstSeen(b) ? -1 : 1;
  });
  for (const sha of ordered)
    if (!position.has(sha))
      warnings.push(
        `reviewed commit ${short(sha)} is not among the PR's current commits (history rewritten or not read); its place in the sequence is by time`,
      );
  let previous = -1;
  const rounds: Round[] = ordered.map((sha, i) => {
    const at = position.get(sha);
    const between = at !== undefined ? commits.slice(previous + 1, at + 1) : [];
    const since = at !== undefined ? at - previous : null;
    if (at !== undefined) previous = at;
    return {
      round: i + 1,
      commit: sha,
      inHistory: at !== undefined,
      current: sha === head,
      reviewers: events
        .filter((e) => e.commit === sha)
        .map(({ by, state, at: when, url }) => ({ by, state, at: when, url })),
      findingsRaised: raw.filter((f) => f.raisedOn === sha).length,
      commitsSincePrevious: since,
      commitHeadlines: between
        .slice(-historyLimits.links)
        .map((c) => `${short(c.oid)} ${c.messageHeadline ?? ""}`.trim()),
    };
  });
  const roundOf = new Map(rounds.map((r) => [r.commit, r.round]));
  const firstFindingRound = Math.min(
    ...raw.map((f) => (f.raisedOn ? (roundOf.get(f.raisedOn) ?? Infinity) : Infinity)),
  );

  // Classify each finding against earlier findings only; links are the evidence.
  const sorted = raw
    .map((f) => ({ ...f, round: f.raisedOn ? (roundOf.get(f.raisedOn) ?? null) : null }))
    .sort((a, b) => (a.round ?? 0) - (b.round ?? 0) || (a.order < b.order ? -1 : 1));
  const findings: Finding[] = [];
  for (const f of sorted) {
    const same = findings.filter(
      (p) => p.by === f.by && p.path === f.path && key(p.title) === key(f.title),
    );
    const area = findings.filter(
      (p) =>
        p.path && p.path === f.path && p.status === "resolved" && (p.round ?? 0) < (f.round ?? 0),
    );
    let cls: FindingClass;
    let basis: string;
    let related: string[] = [];
    if (same.some((p) => p.raisedOn === f.raisedOn)) {
      cls = "duplicate";
      basis = "same reviewer, file and title already raised on the same commit";
      related = same.map((p) => p.url);
    } else if (same.some((p) => p.status === "resolved")) {
      cls = "repeated";
      basis =
        "same reviewer, file and title raised again on a later commit after the earlier thread was resolved: the earlier fix may be incomplete, or the finding was reopened";
      related = same.map((p) => p.url);
    } else if (same.length) {
      cls = "duplicate";
      basis = "same reviewer, file and title re-raised while the earlier thread is still open";
      related = same.map((p) => p.url);
    } else if (f.round === null || f.round <= firstFindingRound) {
      cls = "initial";
      basis = "raised in the first round with findings";
    } else if (area.length) {
      cls = "same-area-after-fix";
      basis =
        "new finding in a file whose earlier finding was resolved: possibly a regression from that fix, possibly a newly noticed gap; causation not established";
      related = area.map((p) => p.url);
    } else {
      cls = "new-later";
      basis =
        "first finding in this file, raised in a later round: whether the gap is original or introduced is unknown";
    }
    const { order: _order, ...rest } = f;
    findings.push({ ...rest, class: cls, basis, related: related.slice(0, historyLimits.links) });
  }

  // Recurring themes: a file with findings in at least two distinct rounds.
  const byPath = new Map<string, Finding[]>();
  for (const f of findings) if (f.path) byPath.set(f.path, [...(byPath.get(f.path) ?? []), f]);
  const themes = [...byPath.entries()]
    .map(([path, fs]) => ({
      path,
      findings: fs.length,
      rounds: [...new Set(fs.map((f) => f.round).filter((r): r is number => r !== null))].sort(
        (a, b) => a - b,
      ),
      open: fs.filter((f) => f.status === "open").length,
      links: fs.slice(-historyLimits.links).map((f) => f.url),
    }))
    .filter((t) => t.rounds.length >= 2)
    .sort((a, b) => b.rounds.length - a.rounds.length || b.findings - a.findings);

  // Reviewer disagreement: different decisive states on the same commit.
  const disagreements = rounds
    .map((r) => {
      const states = Object.fromEntries(
        r.reviewers
          .filter((v) => ["APPROVED", "CHANGES_REQUESTED"].includes(v.state))
          .map((v) => [v.by, v.state]),
      );
      return { commit: r.commit, states };
    })
    .filter((d) => new Set(Object.values(d.states)).size > 1);

  const count = (c: FindingClass) => findings.filter((f) => f.class === c).length;
  const counts = {
    total: findings.length,
    open: findings.filter((f) => f.status === "open").length,
    resolved: findings.filter((f) => f.status === "resolved").length,
    initial: count("initial"),
    repeated: count("repeated"),
    duplicate: count("duplicate"),
    "same-area-after-fix": count("same-area-after-fix"),
    "new-later": count("new-later"),
  };
  const roundsWithFindings = rounds.filter((r) => r.findingsRaised > 0).length;
  const headReviewed = rounds.some((r) => r.current && r.reviewers.length > 0);

  const reasons: string[] = [];
  if (roundsWithFindings >= historyLimits.cycleThreshold)
    reasons.push(
      `${roundsWithFindings} rounds raised findings (inspection threshold ${historyLimits.cycleThreshold})`,
    );
  if (counts.repeated) reasons.push(`${counts.repeated} finding(s) raised again after resolution`);
  if (counts["same-area-after-fix"] >= 2)
    reasons.push(`${counts["same-area-after-fix"]} new finding(s) in files already fixed once`);
  if (themes.length) reasons.push(`${themes.length} file(s) drew findings in more than one round`);

  const open = findings.filter((f) => f.status === "open" && !f.outdated);
  const nextActions: ReviewHistoryReport["nextActions"] = [];
  if (open.length)
    nextActions.push({
      action: "continue targeted fixes",
      basis: `${open.length} open finding(s) not outdated by later commits`,
      evidence: open.slice(0, historyLimits.links).map((f) => f.url),
    });
  if (
    counts.repeated ||
    counts["same-area-after-fix"] >= 2 ||
    (themes.length && rounds.length >= historyLimits.cycleThreshold)
  )
    nextActions.push({
      action: "broader invariant/design review of the recurring area",
      basis:
        "findings recur in the same files or reappear after fixes, which point-fixes have not settled",
      evidence: [
        ...findings
          .filter((f) => f.class === "repeated" || f.class === "same-area-after-fix")
          .map((f) => f.url),
        ...themes.flatMap((t) => t.links),
      ].slice(0, historyLimits.links),
    });
  const laterPaths = new Set(findings.filter((f) => f.class === "new-later").map((f) => f.path));
  if (roundsWithFindings >= historyLimits.cycleThreshold && laterPaths.size >= 3)
    nextActions.push({
      action: "consider splitting the PR",
      basis: `later rounds keep finding new gaps across ${laterPaths.size} different files`,
      evidence: findings
        .filter((f) => f.class === "new-later")
        .slice(0, historyLimits.links)
        .map((f) => f.url),
    });
  if (!headReviewed)
    nextActions.push({
      action: "wait for or request review of the current head",
      basis: `no review event recorded for head ${short(head)}; earlier reviews are of older commits`,
      evidence: [],
    });
  if (!nextActions.length)
    nextActions.push({
      action: "none suggested by review history",
      basis: "current head reviewed with no open findings; see the current blockers",
      evidence: [],
    });

  const uncertainty = [
    "Classifications compare reviewer, file and finding title only; they are candidates for inspection, not proof of cause.",
    "Value and importance are not assessed: deferring scope needs project evidence or agent judgement, not finding counts.",
  ];
  if (pr.comments.nodes.length === 0 && pr.reviews.nodes.length === 0)
    uncertainty.push("No reviews or comments were found: review history is missing, not clean.");

  if (pr.commits.pageInfo?.hasNextPage)
    warnings.push("more than 100 commits; later commits not read");
  if (pr.reviews.pageInfo?.hasNextPage)
    warnings.push("more than 100 reviews; later reviews not read");
  if (pr.reviewThreads.pageInfo?.hasNextPage)
    warnings.push("more than 100 review threads; later findings not read");
  if (pr.comments.pageInfo?.hasNextPage)
    warnings.push("more than 100 comments; later review markers not read");

  // Show the most informative findings first: open, then non-initial, newest first.
  const rank = (f: Finding) => (f.status === "open" ? 0 : 2) + (f.class === "initial" ? 1 : 0);
  const shown = [...findings]
    .sort((a, b) => rank(a) - rank(b) || (b.round ?? 0) - (a.round ?? 0))
    .slice(0, historyLimits.findings);
  const uniqueWarnings = [...new Set(warnings)];
  const command = `github-triage pr ${pr.number} --repo ${repository}`;

  return {
    schemaVersion: 1,
    kind: "pr-review-history",
    repository,
    fetchedAt: now.toISOString(),
    startedAt: startedAt ?? now.toISOString(),
    pullRequest: { number: pr.number, url: pr.url, head, author },
    current: { blockers: status.blockers, verdict: status.verdict },
    rounds: rounds.slice(-historyLimits.rounds),
    omittedRounds: Math.max(0, rounds.length - historyLimits.rounds),
    headReviewed,
    findings: shown,
    omittedFindings: findings.length - shown.length,
    counts,
    themes: themes.slice(0, historyLimits.themes),
    omittedThemes: Math.max(0, themes.length - historyLimits.themes),
    disagreements,
    signal: {
      repeatedCycleCandidate: reasons.length > 0,
      roundsWithFindings,
      threshold: historyLimits.cycleThreshold,
      reasons,
    },
    nextActions,
    uncertainty,
    nextCommands: [command, `${command} --history --json`],
    cost: { requests: 2 },
    completeness: { complete: !uniqueWarnings.length, warnings: uniqueWarnings },
  };
}

/** Fetch live: the #59 report plus one bounded history query. */
export async function pullRequestReviewHistory(
  repository: string,
  number: number,
  q: Query = ghQuery,
  now: () => Date = () => new Date(),
): Promise<ReviewHistoryReport> {
  const startedAt = now().toISOString();
  const status = await pullRequestStatus(repository, number, q, now);
  const [owner, name] = repository.split("/");
  const data = await q(historyQuery, { owner, name, number });
  const pr = selected<ReviewHistoryNode>(prop(data, "repository", "pullRequest"));
  if (!pr) throw new Error(`Pull request #${number} is unavailable in ${repository}.`);
  return reviewHistory(repository, pr, status, { now: now(), startedAt });
}

/** Text rendering. */
export function reviewHistoryText(r: ReviewHistoryReport): string {
  const p = r.pullRequest;
  const s = r.signal;
  const lines = [
    `PR #${p.number} review history ${p.url}`,
    `head ${p.head.slice(0, 7)} · ${r.rounds.length + r.omittedRounds} round(s), ${s.roundsWithFindings} with findings · head ${r.headReviewed ? "reviewed" : "NOT reviewed"} · fetched ${r.fetchedAt}`,
    s.repeatedCycleCandidate
      ? `REPEATED-CYCLE CANDIDATE (inspect, not a verdict): ${s.reasons.join("; ")}`
      : "No repeated-cycle signal in the evidence read.",
    "",
    "ROUNDS",
    ...(r.omittedRounds ? [`  …${r.omittedRounds} earlier round(s) omitted`] : []),
    ...r.rounds.map(
      (x) =>
        `  ${x.round}. ${x.commit.slice(0, 7)}${x.current ? " (head)" : ""}${x.inHistory ? "" : " (not in history)"}: ${x.findingsRaised} finding(s); ${x.reviewers.map((v) => `${v.by} ${v.state}`).join(", ") || "no review event"}${x.commitsSincePrevious !== null ? `; ${x.commitsSincePrevious} commit(s) since previous` : ""}`,
    ),
    "",
    `FINDINGS: ${r.counts.total} (open ${r.counts.open}, resolved ${r.counts.resolved}; repeated ${r.counts.repeated}, duplicate ${r.counts.duplicate}, same-area-after-fix ${r.counts["same-area-after-fix"]}, new-later ${r.counts["new-later"]}, initial ${r.counts.initial})`,
    ...r.findings.map(
      (f) =>
        `  [${f.class}] r${f.round ?? "?"} ${f.status}${f.outdated ? " (outdated)" : ""} ${f.severity ? `${f.severity} ` : ""}${f.path ?? "general"}${f.line ? `:${f.line}` : ""} by ${f.by}: ${f.title}${f.citedFixes.length ? ` · fix cited ${f.citedFixes.map((c) => c.slice(0, 7)).join(",")}` : ""} ${f.url}`,
    ),
    ...(r.omittedFindings ? [`  …${r.omittedFindings} more finding(s)`] : []),
    ...(r.themes.length ? ["", "RECURRING FILES"] : []),
    ...r.themes.map(
      (t) =>
        `  ${t.path}: ${t.findings} finding(s) in rounds ${t.rounds.join(",")}, ${t.open} open`,
    ),
    ...(r.omittedThemes ? [`  …${r.omittedThemes} more`] : []),
    ...r.disagreements.map(
      (d) =>
        `Reviewers disagree on ${d.commit.slice(0, 7)}: ${Object.entries(d.states)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ")}`,
    ),
    "",
    "CANDIDATE NEXT ACTIONS (never applied automatically)",
    ...r.nextActions.map((a) => `- ${a.action}: ${a.basis}`),
    "",
    `Current blockers (#59): ${r.current.blockers.length ? r.current.blockers.join("; ") : "none"}`,
    ...r.uncertainty.map((u) => `Note: ${u}`),
    `Next: ${r.nextCommands.join(" | ")}`,
    ...r.completeness.warnings.map((w) => `INCOMPLETE: ${w}`),
  ];
  return lines.join("\n") + "\n";
}
