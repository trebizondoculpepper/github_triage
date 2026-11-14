/**
 * Finish and integrate existing PRs before new work (#182, doc/design/delivery-lifecycle.md
 * "#182 ranking", S2/S9; doc/design/briefings.md "Bounded first ranking version").
 *
 * Real collect() over a fake GraphQL boundary, injected permissions, clock and configuration; no
 * live calls. Both the default Datalog engine and the explicit TypeScript engine are exercised,
 * for both roles, and CLI/MCP agree on the ranked queue.
 */
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vite-plus/test";
import { main } from "./cli.js";
import type { CompactBriefing } from "./compact.js";
import { TOML_CONFIG_PATH } from "./config.js";
import type { ConfigFileSystem, GitRunner } from "./config.js";
import { deliveryMarker } from "./delivery.js";
import type { DeliveryRecord } from "./delivery.js";
import { collect } from "./github.js";
import type { Query, Rest } from "./github.js";
import { createServer, envelope } from "./mcp.js";
import type { McpRuntime } from "./mcp.js";
import type { Issue, Page, PullRequest } from "./types.js";

const repo = "owner/finish";
const time = "2026-11-14T10:00:00.000Z";
const clock = () => new Date(time);
const page = <T>(nodes: T[]): Page<T> => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});
const issueUrl = (n: number) => `https://github.com/${repo}/issues/${n}`;
const pullUrl = (n: number) => `https://github.com/${repo}/pull/${n}`;
type Remote = Issue["comments"]["nodes"][number];

/** A `submit` delivery record by `agent`, posted under `login`. */
const submitted = (issue: number, pr: number, agent: string, login = "maintainer"): Remote => {
  const record: DeliveryRecord = {
    v: 1,
    op: "submit",
    opId: `op-${issue}-${pr}`,
    repository: repo,
    issue,
    agent,
    deliverables: [
      {
        kind: "pr",
        repository: repo,
        number: pr,
        nodeId: `PR_${pr}`,
        target: { repository: repo, branch: null },
      },
    ],
    membership: "complete",
    issuedAt: "2026-11-13T09:00:00Z",
  };
  return {
    databaseId: issue * 1000 + pr,
    body: `Submitted.\n\n${deliveryMarker(record)}`,
    url: `${issueUrl(issue)}#issuecomment-${issue}${pr}`,
    author: { __typename: "User", login },
    createdAt: "2026-11-13T09:00:00Z",
    lastEditedAt: null,
    includesCreatedEdit: false,
    editor: null,
  };
};
const issue = (n: number, labels: string[], comments: Remote[] = []): Issue => ({
  number: n,
  title: `Ticket ${n}`,
  body: "",
  url: issueUrl(n),
  state: "OPEN",
  stateReason: null,
  createdAt: `2026-11-${String(n).padStart(2, "0")}T00:00:00Z`,
  updatedAt: time,
  issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
  blockedBy: page([]),
  blocking: page([]),
  labels: page(labels.map((name) => ({ name }))),
  comments: page(comments),
});
interface PrShape {
  closes: number;
  checks?: [string, string][];
  mergeable?: string;
  mergeState?: string;
  review?: string | null;
  labels?: string[];
  /** Review evidence: approval or Codex receipt on the head, on an older commit, or none. */
  evidence?:
    | "approved"
    | "approved-codex-findings"
    | "codex"
    | "codex-findings"
    | "stale"
    | "untrusted-codex"
    | "none";
}
const codexReceipt = (n: number, sha: string, findings: boolean, login: string): Remote => ({
  databaseId: 90000 + n,
  body: `Reviewed.\n<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { status: "completed", commit_sha: sha, has_unresolved_findings: findings } })} -->`,
  url: `${pullUrl(n)}#issuecomment-9${n}`,
  author: { __typename: "Bot", login },
  createdAt: "2026-11-13T10:00:00Z",
  lastEditedAt: null,
  includesCreatedEdit: false,
  editor: null,
});
const evidence = (n: number, kind: PrShape["evidence"]) => {
  const head = `head${n}`;
  const approval = (oid: string) => ({
    body: "",
    url: `${pullUrl(n)}#review`,
    author: { login: "reviewer" },
    state: "APPROVED",
    submittedAt: "2026-11-13T10:00:00Z",
    commit: { oid },
  });
  const bot = "chatgpt-codex-connector";
  switch (kind) {
    case "approved":
      return { reviews: [approval(head)], comments: [] };
    case "stale":
      return { reviews: [approval("older")], comments: [codexReceipt(n, "older", false, bot)] };
    case "approved-codex-findings":
      return { reviews: [approval(head)], comments: [codexReceipt(n, head, true, bot)] };
    case "codex":
      return { reviews: [], comments: [codexReceipt(n, head, false, bot)] };
    case "codex-findings":
      return { reviews: [], comments: [codexReceipt(n, head, true, bot)] };
    case "untrusted-codex":
      return { reviews: [], comments: [codexReceipt(n, head, false, "someone")] };
    default:
      return { reviews: [], comments: [] };
  }
};
const pr = (n: number, s: PrShape): PullRequest => ({
  ...issue(n, s.labels ?? [], evidence(n, s.evidence ?? "approved").comments),
  url: pullUrl(n),
  headRefOid: `head${n}`,
  headRefName: `branch-${n}`,
  baseRefName: "main",
  isDraft: false,
  mergeable: s.mergeable ?? "MERGEABLE",
  mergeStateStatus: s.mergeState ?? "CLEAN",
  reviewDecision: s.review ?? null,
  closingIssuesReferences: page([{ number: s.closes, url: issueUrl(s.closes) }]),
  reviewThreads: page([]),
  reviews: page(evidence(n, s.evidence ?? "approved").reviews),
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            state: "SUCCESS",
            contexts: page(
              (s.checks ?? [["verify", "SUCCESS"]]).map(([name, conclusion]) => ({
                name,
                status: "COMPLETED",
                conclusion,
              })),
            ),
          },
        },
      },
    ],
  },
});

/** Injected permissions: `maintainer` writes; `stranger` has read access only. */
const rest: Rest = async (path) => {
  const login = /collaborators\/([^/]+)\/permission/.exec(path)?.[1];
  return login === "maintainer"
    ? { status: 200, body: { role_name: "write", user: { login } } }
    : { status: 200, body: { role_name: "read", user: { login } } };
};
const root = "/repo";
const files = (config: string | null): ConfigFileSystem => ({
  readText: async (file) => (config && file === join(root, TOML_CONFIG_PATH) ? config : null),
  writeText: async () => undefined,
  rename: async () => undefined,
  remove: async () => undefined,
  makeDirectory: async () => undefined,
});
const git: GitRunner = async (args) =>
  args[0] === "rev-parse" ? `${root}\n` : `origin\thttps://github.com/${repo}.git (fetch)\n`;
// Assessment actions are covered elsewhere; disabling both metrics keeps these queues focused.
const metricsOff = "[complexity]\nenabled = false\n[impact]\nenabled = false\n";
const datalog = `schemaVersion = 1\n${metricsOff}`;
const typescript = `schemaVersion = 1\n[briefing]\nengine = "typescript"\n${metricsOff}`;

interface World {
  issues: Issue[];
  prs: PullRequest[];
}
const query =
  (world: World): Query =>
  async (source) => ({
    repository: {
      issues: page(source.includes("issues(first") ? world.issues : []),
      pullRequests: page(source.includes("pullRequests(first") ? world.prs : []),
    },
  });
const runtime = (world: World, config: string | null): McpRuntime => {
  const fs = files(config);
  return {
    collect: (repository, options) => collect(repository, options, query(world), clock),
    currentRepository: async () => repo,
    dependencyReport: async () => {
      throw new Error("not used");
    },
    estimation: { fs, git, cwd: root },
    guide: { fs, git, cwd: root },
    now: clock,
    rest,
    git,
    fs,
    env: {},
  };
};
async function cli(
  world: World,
  role: "implementer" | "designer",
  config: string = datalog,
): Promise<CompactBriefing> {
  let out = "";
  const code = await main(
    ["--repo", repo, "--agent", "me", "--role", role, "--limit", "20", "--json"],
    async (text) => void (out += text),
    { ...runtime(world, config), updateCheck: async () => ({ status: "disabled" }) as never },
  );
  expect(code).toBe(0);
  return JSON.parse(out) as CompactBriefing;
}
const ranked = (r: { rankedActions?: CompactBriefing["rankedActions"] }) =>
  (r.rankedActions?.items ?? []).map((i) => `${i.kind}#${i.target.split("/").pop()}`);
const next = (r: CompactBriefing) =>
  (r.role?.next ?? []).map((row) => Number(row.url.split("/").pop()));

/**
 * #1 was submitted by `me` (claim released, so no `agent:` label) as PR 20, which has changes
 * requested; #2 is another agent's ticket whose PR 19 fails checks; #3 is ready pickup.
 */
const submittedWorld = (login = "maintainer"): World => ({
  issues: [
    issue(1, ["status:awaiting-review"], [submitted(1, 20, "me", login)]),
    issue(2, ["status:in-progress", "agent:other"]),
    issue(3, ["status:ready"]),
  ],
  prs: [
    pr(19, { closes: 2, checks: [["verify", "FAILURE"]] }),
    pr(20, { closes: 1, review: "CHANGES_REQUESTED" }),
  ],
});

describe("own submitted PR follow-up survives the released claim (#182 S2)", () => {
  it("ranks the trusted-responsible PR before another agent's PR and before pickup", async () => {
    const r = await cli(submittedWorld(), "implementer");
    expect(ranked(r)).toEqual(["pr-follow-up#20", "pr-follow-up#19", "implement#3"]);
    const [own] = r.rankedActions!.items as unknown as {
      reasonCodes: string[];
      why: { facts: Record<string, unknown>; ruleIds: string[] };
    }[];
    expect(own.reasonCodes).toContain("pr-review-findings");
    expect(own.why.ruleIds).toEqual(["D-PR-REVIEW"]);
    expect(own.why.facts.responsible).toBe("me");
  });

  it("does not treat a record by an author without write permission as responsibility", async () => {
    const r = await cli(submittedWorld("stranger"), "implementer");
    // Neither PR is the viewer's: equal groups and preferences fall back to numeric identity.
    expect(ranked(r)).toEqual(["pr-follow-up#19", "pr-follow-up#20", "implement#3"]);
    const own = (r.rankedActions!.items as unknown as { why: { facts: object } }[])[1];
    expect(own.why.facts).not.toHaveProperty("responsible");
  });

  it("keeps every responsible agent when one PR is required by several issues", async () => {
    // PR 25 is a deliverable of #9 (submitted by `me`) and #10 (submitted by `other`).
    const shared = (order: number[]): World => ({
      issues: order.map((n) =>
        issue(n, ["status:awaiting-review"], [submitted(n, 25, n === 9 ? "me" : "other")]),
      ),
      prs: [
        pr(19, { closes: 2, checks: [["verify", "FAILURE"]] }),
        pr(25, { closes: 9, review: "CHANGES_REQUESTED" }),
      ],
    });
    for (const order of [
      [9, 10],
      [10, 9],
    ]) {
      const r = await cli(shared(order), "implementer");
      expect(ranked(r)[0], `issue order ${order.join(",")}`).toBe("pr-follow-up#25");
      const own = r.rankedActions!.items[0] as unknown as { why: { facts: object } };
      expect(own.why.facts).toMatchObject({ responsible: "me; other" });
      const ts = await cli(shared(order), "implementer", typescript);
      expect(next(ts)[0], `typescript, issue order ${order.join(",")}`).toBe(25);
    }
  });

  it("the explicit TypeScript engine applies the same responsibility", async () => {
    const r = await cli(submittedWorld(), "implementer", typescript);
    expect(next(r).slice(0, 3)).toEqual([20, 19, 3]);
    const followUp = r.role!.sections.find((s) => s.name === "pr-follow-up")!;
    expect(followUp.items[0]).toMatchObject({ url: pullUrl(20) });
    expect(followUp.items[0]!.reason).toMatch(/^Your PR/);
    expect(followUp.items[1]!.reason).toMatch(/^Review opportunity/);
  });

  it("a designer's submitted documentation PR is own follow-up, not design review", async () => {
    const world: World = {
      issues: [
        issue(4, ["documentation", "status:awaiting-review"], [submitted(4, 21, "me")]),
        issue(5, ["status:needs-design"]),
      ],
      prs: [pr(21, { closes: 4, review: "CHANGES_REQUESTED" })],
    };
    const r = await cli(world, "designer");
    expect(ranked(r)).toEqual(["pr-follow-up#21", "design#5"]);
    const untrusted: World = {
      ...world,
      issues: [
        issue(4, ["documentation", "status:awaiting-review"], [submitted(4, 21, "me", "stranger")]),
        world.issues[1]!,
      ],
    };
    expect(ranked(await cli(untrusted, "designer"))).toEqual(["design-review#21", "design#5"]);
  });
});

describe("accepted PRs needing refresh are integration actions (#182 S9)", () => {
  const world = (shape: Partial<PrShape>): World => ({
    issues: [issue(6, ["status:in-progress", "agent:me"]), issue(7, ["status:ready"])],
    prs: [pr(22, { closes: 6, ...shape })],
  });
  for (const [label, shape] of [
    ["BEHIND", { mergeState: "BEHIND" }],
    ["BEHIND with a Codex receipt on the head", { mergeState: "BEHIND", evidence: "codex" }],
    ["mergeability UNKNOWN", { mergeable: "UNKNOWN", mergeState: "UNKNOWN" }],
  ] as const)
    it(`${label} ranks an integrate action ahead of own work and pickup`, async () => {
      const r = await cli(world(shape), "implementer");
      expect(ranked(r)).toEqual(["pr-follow-up#22", "continue-implementation#6", "implement#7"]);
      const [integrate] = r.rankedActions!.items as unknown as {
        reasonCodes: string[];
        nextCommand: string;
        why: { ruleIds: string[]; text: string };
      }[];
      expect(integrate.reasonCodes).toEqual(["pr-follow-up", "pr-integrate"]);
      expect(integrate.why.ruleIds).toEqual(["D-PR-INTEGRATE"]);
      expect(integrate.why.text).toContain(`merge state is ${shape.mergeState}`);
      expect(integrate.nextCommand).toBe(`pdb pr 22 --repo ${repo}`);
      // The TypeScript engine agrees.
      const ts = await cli(world(shape), "implementer", typescript);
      expect(next(ts)[0]).toBe(22);
    });

  it("another agent's actionable review precedes continuing own implementation (PR #251)", async () => {
    const r = await cli(
      {
        issues: [
          issue(6, ["status:in-progress", "agent:me"]),
          issue(7, ["status:ready"]),
          issue(8, ["status:in-progress", "agent:other"]),
        ],
        prs: [pr(24, { closes: 8, mergeState: "BEHIND" })],
      },
      "implementer",
    );
    expect(ranked(r)).toEqual(["pr-follow-up#24", "continue-implementation#6", "implement#7"]);
  });

  it("unknown or failing evidence is never an integration action", async () => {
    for (const shape of [
      { mergeState: "BEHIND", checks: [["verify", "PENDING"]] },
      { mergeState: "BEHIND", checks: [["verify", "MYSTERY"]] },
      { mergeState: "BEHIND", checks: [["lint", "SUCCESS"]] },
      { mergeState: "BLOCKED" },
      // Acceptance needs attributable review evidence bound to the current head.
      { mergeState: "BEHIND", evidence: "none" },
      { mergeState: "BEHIND", evidence: "stale" },
      { mergeState: "BEHIND", evidence: "codex-findings" },
      // A current-head approval does not override Codex findings on the same head.
      { mergeState: "BEHIND", evidence: "approved-codex-findings" },
      { mergeState: "BEHIND", evidence: "untrusted-codex" },
      { mergeable: "UNKNOWN", mergeState: "UNKNOWN", evidence: "none" },
    ] as Partial<PrShape>[]) {
      const r = await cli(world(shape), "implementer");
      expect(ranked(r), JSON.stringify(shape)).not.toContain("pr-follow-up#22");
      // Waiting on the PR never blocks own work or pickup.
      expect(ranked(r)).toEqual(["continue-implementation#6", "implement#7"]);
      const ts = await cli(world(shape), "implementer", typescript);
      expect(next(ts), JSON.stringify(shape)).not.toContain(22);
    }
  });
});

describe("CLI and MCP agree on finish-first ranking (#182)", () => {
  it("returns identical ranked queues and role projections", async () => {
    const world = submittedWorld();
    world.prs.push(pr(23, { closes: 3, mergeState: "BEHIND" }));
    const fromCli = await cli(world, "implementer");
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer({ repo }, runtime(world, datalog)).connect(serverSide);
    const client = new Client({ name: "finish-first", version: "1.0.0" });
    await client.connect(clientSide);
    try {
      const raw = await client.callTool({
        name: "triage_briefing",
        arguments: { agent: "me", role: "implementer", limit: 20 },
      });
      const parsed = envelope.parse(raw.structuredContent);
      expect(parsed.status).toBe("complete");
      const result = parsed.result as Record<string, unknown>;
      for (const key of ["rankedActions", "actions", "role"] as const)
        expect(result[key], key).toEqual(fromCli[key]);
      expect(ranked(fromCli)).toEqual(["pr-follow-up#20", "pr-follow-up#19", "pr-follow-up#23"]);
    } finally {
      await client.close();
    }
  });
});
