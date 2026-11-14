/**
 * Registered summary data for each bounded MCP read (doc/design/mcp-bounded-results.md,
 * "Implementation decisions"). Each builder selects fields from the existing versioned report,
 * names its prunable lists in pruning order and renders minimal text from returned rows only.
 */
import { catchUpLimits, catchUpText } from "../catchup.js";
import { dependencyFacts } from "../github/dependencies.js";
import type { CatchUpReport } from "../catchup.js";
import { warningsList } from "./bounded.js";
import type { BoundedView, Next, PrunableList, Selection } from "./bounded.js";

/** Text share of the byte budget for the repository briefing's rendered rows. */
const repositoryTextChars = 4000;

type Json = Record<string, unknown>;

const obj = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const pick = (source: Json, keys: readonly string[]): Json =>
  Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));

/** Common inputs of every view. */
export interface ViewBase {
  repository: string;
  selection: Selection;
  status: "complete" | "incomplete";
  notices: string[];
  maxChars: number;
}

const completenessOf = (report: Json): BoundedView["sourceCompleteness"] => {
  const completeness = obj(report.completeness);
  return {
    ...completeness,
    complete: completeness.complete === true,
    warnings: list(completeness.warnings).map(String),
  };
};

/** Compact subject row: identity, labels, ownership, assessments and actionable findings. */
function compactSubject(subject: Json): Json {
  const dependencies = obj(subject.dependencies);
  return {
    ...pick(subject, ["number", "url", "title", "labels", "owners", "assessments"]),
    findings: list(subject.findings).map((finding) =>
      pick(obj(finding), ["rule", "reason", "next", "uncertainty"]),
    ),
    ...(subject.dependencies
      ? { dependencies: pick(dependencies, ["known", "summary", "verdict"]) }
      : {}),
    ...pick(subject, ["detailCommand"]),
  };
}

/** Briefing report fields carried under their CLI names and values (role-view parity). */
const briefingFields = [
  "summary",
  "actions",
  "sections",
  "role",
  "rankedActions",
  "estimation",
  "impactEstimation",
  "ranking",
  "changes",
  "guidance",
  "process",
  "decisionEngine",
] as const;

const itemsLine = (prefix: string, rows: unknown[]): string[] =>
  rows.map((row, i) => {
    const item = obj(row);
    const why = str(obj(item.why).text) || str(item.reason);
    const command = str(item.nextCommand) || str(item.next);
    return `${prefix}${i + 1}. ${str(item.kind) ? `${str(item.kind)} ` : ""}${str(item.target) || str(item.url)}${why ? ` — ${why}` : ""}${command ? ` Next: ${command}` : ""}`;
  });

const countsLine = (sections: Json): string => {
  const counts = Object.entries(sections)
    .map(([name, section]) => [name, Number(obj(section).total ?? 0)] as const)
    .filter(([, total]) => total > 0)
    .map(([name, total]) => `${name} ${total}`);
  return counts.length ? `Sections (totals): ${counts.join(", ")}.` : "Sections: none.";
};

export function briefingView(base: ViewBase, report: Json): BoundedView {
  const data: Json = {
    reportSchemaVersion: report.schemaVersion,
    ...pick(report, briefingFields),
    subjects: list(report.subjects).map((subject) => compactSubject(obj(subject))),
  };
  return {
    ...base,
    tool: "triage_briefing",
    view: "briefing",
    subject: null,
    freshness: obj(report.freshness),
    sourceCompleteness: completenessOf(report),
    data,
    // Completeness is carried once, in the envelope's bounded sourceCompleteness.
    protectedPaths: ["guidance"],
    lists: (d) => {
      const role = obj(d.role);
      const lists: PrunableList[] = [{ path: ["subjects"] }];
      list(role.sections).forEach((_, i, all) =>
        lists.push({ path: ["role", "sections", all.length - 1 - i, "items"] }),
      );
      lists.push({ path: ["changes", "items"] });
      for (const name of Object.keys(obj(d.sections)).reverse())
        lists.push({ path: ["sections", name, "items"] });
      lists.push(
        { path: ["impactEstimation", "conflicts", "items"] },
        { path: ["impactEstimation", "queue", "items"] },
        { path: ["estimation", "conflicts", "items"] },
        { path: ["estimation", "queue", "items"] },
        { path: ["actions", "items"] },
        { path: ["role", "next"] },
        { path: ["decisionEngine", "denials"] },
        // Beyond the first few, warnings yield before the ranked shortlist; their count remains.
        { path: [warningsList] },
        { path: ["rankedActions", "items"] },
        { path: ["estimation", "findings"] },
        { path: ["decisionEngine", "diagnostics"] },
      );
      return lists;
    },
    text: (d) => {
      const freshness = obj(report.freshness);
      const ranked = obj(d.rankedActions);
      const role = obj(d.role);
      const lines = [
        `Presidential Daily Briefing: ${base.repository} — fetched ${str(freshness.fetchedAt)}${freshness.offline ? " (OFFLINE CACHE)" : ""}`,
      ];
      if (d.rankedActions) {
        lines.push(
          `Next actions (${list(ranked.items).length} shown of ${Number(ranked.total ?? 0)}):`,
          ...itemsLine("", list(ranked.items)),
        );
      }
      const targets = list(obj(d.actions).items).map(String);
      if (targets.length) lines.push(`Action targets: ${targets.join(" ")}`);
      if (d.role && list(role.next).length) {
        lines.push(`Role ${str(role.name)} next:`, ...itemsLine("", list(role.next)));
      }
      lines.push(countsLine(obj(d.sections)));
      const subjects = list(d.subjects);
      lines.push(
        `Subjects: ${subjects.length} compact row(s) in structuredContent.data.subjects; use triage_issue for one ticket.`,
      );
      return lines;
    },
  };
}

const catchUpSectionOrder = ["activity", "progress", "completed", "blockers", "attention"];

export function repositoryBriefingView(base: ViewBase, report: Json): BoundedView {
  const { sections: _sections, ...rest } = report;
  const data: Json = { ...rest, sections: report.sections };
  return {
    ...base,
    tool: "triage_briefing",
    view: "repository-briefing",
    subject: null,
    freshness: obj(report.observation),
    sourceCompleteness: completenessOf(report),
    data,
    protectedPaths: ["completeness", "coverage", "checkpoint"],
    lists: (d) =>
      catchUpSectionOrder
        .filter((name) => name in obj(d.sections))
        .map((name) => ({ path: ["sections", name, "items"] })),
    fixup: (d) => {
      const sections = obj(d.sections);
      const omissions = obj(d.omissions);
      for (const name of Object.keys(sections)) {
        if (name in omissions) omissions[name] = obj(sections[name]).omitted;
      }
      // Activity groups name the rows they show; only rows still returned count as shown.
      const shown = new Set(list(obj(sections.activity).items).map((row) => obj(row).id));
      d.activityGroups = list(d.activityGroups).map((group) => ({
        ...obj(group),
        shown: list(obj(group).shown).filter((id) => shown.has(id)),
      }));
    },
    // The catch-up renderer over the returned rows only, within a share of the byte budget.
    text: (d) =>
      catchUpText(
        d as unknown as CatchUpReport,
        Math.max(catchUpLimits.maxChars.min, Math.min(base.maxChars, repositoryTextChars)),
      )
        .trimEnd()
        .split("\n"),
  };
}

/** Issue detail sections; summary is the default. */
export const issueSections = ["summary", "body", "discussion", "pullRequests"] as const;
export type IssueSection = (typeof issueSections)[number];

export interface Page {
  offset: number;
  limit: number;
}

const commentId = (url: string): number => Number(/(\d+)$/.exec(url)?.[1] ?? 0);

/** Pull out one page of rows; `next` names the following page when one exists. */
function paged(
  rows: unknown[],
  page: Page,
  next: (offset: number) => Next,
): { rows: unknown[]; total: number; available: number; next: (returned: number) => Next | null } {
  const slice = rows.slice(page.offset, page.offset + page.limit);
  return {
    rows: slice,
    total: rows.length,
    available: slice.length,
    next: (returned) =>
      page.offset + returned < rows.length ? next(page.offset + returned) : null,
  };
}

export function issueView(
  base: ViewBase,
  report: Json,
  number: number,
  section: IssueSection,
  page: Page,
  args: Json,
): BoundedView {
  const detail = obj(report.detail);
  const url = str(detail.url);
  const subject = list(report.subjects)
    .map(obj)
    .find((item) => item.url === url);
  const body = str(detail.body);
  const bodyLines = body ? body.split(/\r?\n/) : [];
  const comments = list(obj(detail.comments).nodes)
    .map(obj)
    .sort(
      (a, b) =>
        str(a.createdAt).localeCompare(str(b.createdAt)) ||
        commentId(str(a.url)) - commentId(str(b.url)),
    )
    .map((comment) => ({
      author: obj(comment.author).login ?? null,
      createdAt: comment.createdAt ?? null,
      url: comment.url ?? null,
      body: str(comment.body),
    }));
  // From the requested issue's own collected native fields, whether or not it is a shortlisted
  // subject; dependencyFacts reports unknown evidence as known: false, never as none.
  const nativeFacts = obj(
    JSON.parse(
      JSON.stringify(
        dependencyFacts(
          detail as unknown as Parameters<typeof dependencyFacts>[0],
          base.repository,
        ),
      ),
    ),
  );
  // A page that GitHub reported as unfinished must never be counted as the whole history.
  const unfinished: string[] = (["comments", "labels"] as const).filter(
    (key) => obj(obj(detail[key]).pageInfo).hasNextPage === true,
  );
  if (nativeFacts.known !== true) unfinished.push("native dependencies");
  const sourceCompleteness = completenessOf(report);
  if (unfinished.length) {
    sourceCompleteness.complete = false;
    sourceCompleteness.warnings.push(
      ...unfinished.map((key) => `Issue ${key} were not fully collected; counts are lower bounds.`),
    );
  }
  const subjectsByUrl = new Map(list(report.subjects).map((item) => [obj(item).url, obj(item)]));
  const pullRequests = list(detail.relatedPullRequests).map((prUrl) => {
    const known = subjectsByUrl.get(prUrl);
    // The section the caller asked for keeps the collected PR evidence (head, checks, reviews,
    // threads); absence is unknown, never "no checks".
    return known
      ? { ...compactSubject(known), pullRequest: known.pullRequest ?? null }
      : { url: prUrl, pullRequest: null };
  });
  const issue = {
    number: detail.number ?? number,
    title: detail.title ?? null,
    url: url || null,
    state: detail.state ?? null,
    stateReason: detail.stateReason ?? null,
    createdAt: detail.createdAt ?? null,
    updatedAt: detail.updatedAt ?? null,
    labels: list(obj(detail.labels).nodes).map((label) => obj(label).name),
    // Owners are known only from the collected subject; absence is unknown, never "nobody".
    owners: subject ? (subject.owners ?? null) : null,
    assessments: detail.assessments ?? null,
    complexity: subject?.complexity ?? null,
  };
  const counts = {
    bodyLines: bodyLines.length,
    bodyCharacters: body.length,
    comments: comments.length,
    pullRequests: pullRequests.length,
  };
  const nextFor = (s: IssueSection) => (offset: number) => ({
    tool: "triage_issue",
    arguments: { ...args, number, section: s, offset, limit: page.limit },
  });
  let data: Json;
  let lists: PrunableList[] = [];
  let next: BoundedView["next"];
  let rowsText: (d: Json) => string[] = () => [];
  if (section === "summary") {
    const dependencies = nativeFacts;
    data = {
      section,
      issue,
      counts,
      findings: subject
        ? list(subject.findings).map((finding) =>
            pick(obj(finding), ["rule", "reason", "next", "evidence", "uncertainty"]),
          )
        : [],
      dependencies,
      // Local estimation diagnostics (configuration problems) explain unknown assessments.
      estimationFindings: list(obj(report.estimation).findings),
      sections: issueSections.filter((name) => name !== "summary"),
    };
    lists = [
      { path: ["estimationFindings"] },
      { path: ["dependencies", "downstream"] },
      { path: ["dependencies", "upstream"] },
      { path: ["findings"] },
    ];
    rowsText = (d) => [
      ...list(d.findings).map(
        (finding) =>
          `- ${str(obj(finding).rule)}: ${str(obj(finding).reason)} Next: ${str(obj(finding).next)}`,
      ),
      ...(d.dependencies ? [`Dependencies: ${str(obj(d.dependencies).verdict)}`] : []),
      `Body ${counts.bodyLines} line(s), ${counts.comments} comment(s), ${counts.pullRequests} related pull request(s): call triage_issue with section body, discussion or pullRequests.`,
    ];
  } else {
    const source =
      section === "body"
        ? bodyLines.map((text, i) => ({ line: i + 1, text }))
        : section === "discussion"
          ? comments
          : pullRequests;
    const pageRows = paged(source, page, nextFor(section));
    data = {
      section,
      issue,
      counts,
      offset: page.offset,
      total: pageRows.total,
      rows: pageRows.rows,
    };
    lists = [{ path: ["rows"], available: pageRows.available, requireRow: true }];
    next = (returned) => pageRows.next(returned["rows"] ?? 0);
    rowsText = (d) =>
      list(d.rows).map((row) => {
        const item = obj(row);
        if (section === "body") return `${String(item.line)}: ${str(item.text)}`;
        if (section === "discussion")
          return `- ${String(item.author)} ${String(item.createdAt)} ${String(item.url)}\n  ${str(item.body).replace(/\s+/g, " ")}`;
        return `- ${str(item.url)} ${str(item.title)}`.trimEnd();
      });
  }
  return {
    ...base,
    status: unfinished.length ? "incomplete" : base.status,
    tool: "triage_issue",
    view: "issue",
    subject: { type: "issue", number },
    freshness: obj(report.freshness),
    sourceCompleteness,
    data,
    protectedPaths: ["issue.url", "issue.labels"],
    lists: () => lists,
    next,
    text: (d) => [
      `Issue #${number} ${str(issue.title)} (${str(issue.state)}) ${str(issue.url)}`,
      `Labels: ${issue.labels.join(", ") || "none"}`,
      `Section ${section}${section === "summary" ? "" : `: rows ${page.offset + 1}–${page.offset + list(d.rows).length} of ${String(d.total)}`}`,
      ...rowsText(d),
    ],
  };
}

/** Diagnosis for a missing, transferred or inaccessible issue; small and never pruned. */
export function unavailableIssueView(
  base: ViewBase,
  number: number,
  diagnosis: Json,
  text: string,
): BoundedView {
  return {
    ...base,
    tool: "triage_issue",
    view: "issue",
    subject: { type: "issue", number },
    freshness: null,
    sourceCompleteness: { complete: false, warnings: [str(diagnosis.detail)].filter(Boolean) },
    data: { schemaVersion: 1, kind: "issue-unavailable", ...diagnosis },
    lists: () => [],
    text: () => text.trimEnd().split("\n"),
  };
}

interface Relationship {
  relation: "blockedBy" | "blocking";
  depth: number;
  path: number[];
  number: number;
  url: string;
  title: string;
  state: string;
  repository: string | null;
  /** Whether this ticket's own native relationships were read (tree only). */
  expanded: boolean;
}

/**
 * Flatten native relationships in a stable breadth-first order from the requested ticket. With
 * tree, every reached ticket contributes both its blocked-by and its blocking edges, so edges whose
 * direction differs from the root's (a blocker that also blocks another ticket) are kept. Each
 * edge appears once; `relation` is relative to the ticket at the end of `path` before this row.
 * Rows keep relation, depth and path, so a page or pruned list can never look like a whole tree.
 */
export function flattenRelationships(report: Json, number: number): Relationship[] {
  const nodes = list(report.nodes).map(obj);
  const byUrl = new Map(nodes.map((node) => [str(node.url), node]));
  const root = nodes.find((node) => node.number === number) ?? nodes[0];
  if (!root) return [];
  const tree = report.tree === true;
  const rows: Relationship[] = [];
  const edges = new Set<string>();
  const seen = new Set<string>([str(root.url)]);
  let frontier: { node: Json; path: number[] }[] = [{ node: root, path: [Number(root.number)] }];
  for (let depth = 1; frontier.length; depth++) {
    const following: typeof frontier = [];
    for (const { node, path } of frontier)
      for (const [relation, key] of [
        ["blockedBy", "upstream"],
        ["blocking", "downstream"],
      ] as const)
        for (const ref of list(node[key]).map(obj)) {
          const url = str(ref.url);
          // One native edge, seen from either end: blocker → blocked.
          const edge =
            relation === "blockedBy" ? `${url}>${str(node.url)}` : `${str(node.url)}>${url}`;
          if (edges.has(edge)) continue;
          edges.add(edge);
          const known = byUrl.get(url);
          rows.push({
            relation,
            depth,
            path: [...path, Number(ref.number)],
            number: Number(ref.number),
            url,
            title: str(ref.title),
            state: str(ref.state),
            repository: str(obj(ref.repository).nameWithOwner) || null,
            expanded: tree && known !== undefined,
          });
          if (tree && known && !seen.has(url)) {
            seen.add(url);
            following.push({ node: known, path: [...path, Number(ref.number)] });
          }
        }
    frontier = following;
  }
  return rows;
}

export function dependenciesView(
  base: ViewBase,
  report: Json,
  number: number,
  page: Page,
  args: Json,
): BoundedView {
  const nodes = list(report.nodes).map(obj);
  const root = nodes.find((node) => node.number === number) ?? nodes[0] ?? {};
  const relationships = flattenRelationships(report, number);
  const unknown = nodes.filter((node) => node.known !== true).map((node) => str(node.url));
  const rows = paged(relationships, page, (offset) => ({
    tool: "triage_dependencies",
    arguments: { ...args, number, offset, limit: page.limit },
  }));
  const warnings = unknown.map(
    (url) => `Native dependency evidence unknown for ${url}; refresh live.`,
  );
  return {
    ...base,
    status: unknown.length ? "incomplete" : base.status,
    tool: "triage_dependencies",
    view: "dependencies",
    subject: { type: "issue", number },
    freshness: pick(report, ["startedAt", "fetchedAt"]),
    sourceCompleteness: { complete: unknown.length === 0, warnings },
    data: {
      reportSchemaVersion: report.schemaVersion,
      tree: report.tree === true,
      ticket: pick(root, ["number", "url", "title", "known", "summary", "drift", "verdict"]),
      cycles: report.cycles ?? [],
      offset: page.offset,
      total: rows.total,
      relationships: rows.rows,
      guidance: report.guidance,
    },
    protectedPaths: ["ticket.verdict"],
    // Cycle metadata goes before the requested relationship rows.
    lists: () => [
      { path: ["cycles"] },
      { path: ["relationships"], available: rows.available, requireRow: true },
    ],
    next: (returned) => rows.next(returned["relationships"] ?? 0),
    text: (d) => [
      `Dependencies of #${number}${d.tree ? " (tree)" : ""}: ${str(obj(d.ticket).verdict)}`,
      `Relationships ${page.offset + 1}–${page.offset + list(d.relationships).length} of ${String(d.total)}:`,
      ...list(d.relationships).map((row) => {
        const item = obj(row);
        return `- ${str(item.relation)} depth ${String(item.depth)} #${String(item.number)} ${str(item.state)} ${str(item.title)} (path ${list(item.path).join(" > ")})`;
      }),
      ...(list(d.cycles).length ? [`Cycles: ${list(d.cycles).length}`] : []),
    ],
  };
}
