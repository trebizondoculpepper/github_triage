import { describe, expect, it } from "vite-plus/test";
import {
  applyDeliverables,
  deliverablesArguments,
  deliverablesText,
  planDeliverables,
  readDeliveryComments,
  resetPlanPending,
} from "./deliverables.js";
import type { DeliverablesPlan, DeliverablesRequest, DeliverablesRuntime } from "./deliverables.js";
import { deliveryMarker, markerTrust, parseDeliveryComment } from "./delivery.js";
import type { DeliveryComment, DeliveryRecord } from "./delivery.js";
import type { RepositoryPermission } from "./github.js";

const repo = "example/project";
const other = "example/library";
const N = 42;
const prLink = (n: number, r = repo) => `https://github.com/${r}/pull/${n}`;

interface FakePr {
  id: string;
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  merged: boolean;
  mergeCommit: { oid: string } | null;
  headRefOid: string;
  baseRefName: string;
  baseRepository: { nameWithOwner: string; defaultBranchRef: { name: string } | null };
  closingIssuesReferences: { nodes: { number: number; repository: { nameWithOwner: string } }[] };
}
const fakePr = (n: number, fields: Partial<FakePr> = {}, r = repo): FakePr => ({
  id: `PR_${n}`,
  number: n,
  url: prLink(n, r),
  state: "OPEN",
  merged: false,
  mergeCommit: null,
  headRefOid: `head${n}`,
  baseRefName: "main",
  baseRepository: { nameWithOwner: r, defaultBranchRef: { name: "main" } },
  closingIssuesReferences: { nodes: [{ number: N, repository: { nameWithOwner: repo } }] },
  ...fields,
});

/** An injected GitHub: one issue, its comments and labels, PRs, permissions and compares. */
function github(
  setup: {
    labels?: string[];
    comments?: DeliveryComment[];
    prs?: FakePr[];
    linked?: { number: number; url: string; state: string }[];
    viewer?: string;
    permissions?: Record<string, RepositoryPermission>;
    compare?: Record<string, string>;
    failRun?: (args: string[]) => boolean;
    onRun?: (args: string[], state: { comments: DeliveryComment[] }) => void;
    issueType?: "Issue" | "PullRequest" | null;
    pageSize?: number;
  } = {},
) {
  const state = {
    labels: [...(setup.labels ?? [])],
    comments: [...(setup.comments ?? [])],
    writes: [] as string[][],
    nextId: 9000,
    clock: 0,
  };
  const prs = new Map((setup.prs ?? []).map((p) => [p.url, p]));
  const viewer = setup.viewer ?? "writer";
  const permissions: Record<string, RepositoryPermission> = {
    writer: "write",
    admin: "admin",
    reader: "read",
    flaky: "unknown",
    ...setup.permissions,
  };
  const size = setup.pageSize ?? 100;
  const page = (end: number) => {
    const start = Math.max(0, end - size);
    return {
      nodes: state.comments.slice(start, end),
      pageInfo: { hasPreviousPage: start > 0, startCursor: start > 0 ? `c${start}` : null },
    };
  };
  const query = async (q: string, v: Record<string, string | number>): Promise<unknown> => {
    if (q.includes("viewer{"))
      return {
        viewer: { __typename: "User", login: viewer },
        repository: {
          issueOrPullRequest:
            setup.issueType === null
              ? null
              : setup.issueType === "PullRequest"
                ? { __typename: "PullRequest", url: prLink(N) }
                : {
                    __typename: "Issue",
                    number: N,
                    title: "Ticket",
                    url: `https://github.com/${repo}/issues/${N}`,
                    state: "OPEN",
                    labels: { nodes: state.labels.map((name) => ({ name })), pageInfo: {} },
                    closedByPullRequestsReferences: { nodes: setup.linked ?? [], pageInfo: {} },
                    comments: page(state.comments.length),
                  },
        },
      };
    if (q.includes("comments(last:100,before"))
      return {
        repository: { issue: { comments: page(Number(String(v.before).slice(1))) } },
      };
    if (q.includes("resource(url")) {
      const p = prs.get(String(v.url));
      if (!p) throw new Error("not found");
      return { resource: { __typename: "PullRequest", ...p } };
    }
    if (q.includes("object(expression"))
      return {
        repository: {
          nameWithOwner: `${v.owner}/${v.name}`,
          object: { __typename: "Commit", oid: String(v.oid).padEnd(40, "0") },
        },
      };
    if (q.includes("defaultBranchRef"))
      return { repository: { defaultBranchRef: { name: "main" } } };
    throw new Error(`unexpected query ${q.slice(0, 40)}`);
  };
  const run = async (args: string[]) => {
    if (setup.failRun?.(args)) throw new Error("gh failed");
    setup.onRun?.(args, state);
    state.writes.push(args);
    if (args[0] === "issue" && args[1] === "comment")
      state.comments.push(comment(args[args.indexOf("--body") + 1], viewer, state.nextId++));
    if (args[0] === "issue" && args[1] === "edit")
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--add-label") state.labels.push(args[i + 1]);
        if (args[i] === "--remove-label")
          state.labels = state.labels.filter((l) => l !== args[i + 1]);
      }
  };
  const rest = async (path: string) => {
    const m = /collaborators\/([^/]+)\/permission$/.exec(path);
    if (m) {
      const p = permissions[decodeURIComponent(m[1])] ?? "none";
      return p === "unknown"
        ? { status: null, body: null }
        : { status: 200, body: { role_name: p, user: { login: decodeURIComponent(m[1]) } } };
    }
    const c = /compare\/[^.]+\.\.\.(\w+)$/.exec(path);
    if (c && setup.compare?.[c[1]]) return { status: 200, body: { status: setup.compare[c[1]] } };
    return { status: null, body: null };
  };
  const permission = async (login: string) => permissions[login] ?? "none";
  const rt: DeliverablesRuntime = {
    query,
    run,
    rest,
    trust: markerTrust(permission),
    now: () => new Date(Date.UTC(2026, 10, 13, 12, 0, state.clock++)),
  };
  return { rt, state };
}

let ids = 100;
function comment(body: string, login = "writer", id = ids++): DeliveryComment {
  return {
    databaseId: id,
    body,
    createdAt: new Date(Date.UTC(2026, 10, 13, 9, 0, id % 3600)).toISOString(),
    author: { __typename: "User", login },
    lastEditedAt: null,
    includesCreatedEdit: false,
    editor: null,
  };
}
const rec = (op: DeliveryRecord["op"], fields: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
  v: 1,
  op,
  opId: `op-${ids}`,
  repository: repo,
  issue: N,
  agent: "alice",
  deliverables: [],
  issuedAt: "2026-11-13T09:00:00Z",
  ...(["submit", "attach", "complete"].includes(op) ? {} : { reason: "because" }),
  ...fields,
});
const member = (n: number, r = repo) => ({
  kind: "pr" as const,
  repository: r,
  number: n,
  nodeId: `PR_${n}`,
  target: { repository: r, branch: null },
});
const post = (r: DeliveryRecord, login = "writer") => comment(deliveryMarker(r), login);
/** A v1 `release --as done` handoff comment, as src/claims.ts writes it. */
const v1Done = (login = "writer") =>
  comment(
    `Handoff by \`alice\`: done.\n\n<!-- github-triage:release:0123456789abcdef ${JSON.stringify({ v: 1, agent: "alice", outcome: "done", target: null, remove: ["agent:alice"], retained: [], claimedAt: "2026-11-12T00:00:00Z" })} -->`,
    login,
  );
/** Ticket submitted by alice with PR 5 required. */
const submitted = (n = 5) =>
  post(rec("submit", { deliverables: [member(n)], membership: "complete" }));

const request = (
  action: DeliverablesRequest["action"],
  fields: Partial<DeliverablesRequest> = {},
): DeliverablesRequest => ({
  number: N,
  action,
  agent: "alice",
  prs: [],
  commits: [],
  target: null,
  reason: "because",
  to: null,
  membership: null,
  legacy: false,
  evidence: null,
  comment: null,
  as: null,
  ...fields,
});
const refused = (plan: DeliverablesPlan, error: string) => {
  expect(plan.ok ? "accepted" : plan.error).toBe(error);
  if (plan.ok) throw new Error("expected refusal");
  // Every recovery is a runnable command: names the repository and carries no shell comment.
  for (const line of plan.recovery) {
    expect(line).toContain(`--repo `);
    expect(line).not.toMatch(/(^|\s)#/);
  }
  expect(plan.recovery.length).toBeGreaterThan(0);
  return plan;
};
const posted = (state: { writes: string[][] }) =>
  state.writes
    .filter((w) => w[1] === "comment")
    .map((w) => parseDeliveryComment(w[w.indexOf("--body") + 1]))
    .map((p) => (p.kind === "record" ? p.record : null));

describe("deliverables arguments", () => {
  it("S14: detach without a reason is refused; with one it parses", () => {
    expect(() =>
      deliverablesArguments(["42", "detach", "--agent", "alice", "--pr", prLink(5)]),
    ).toThrow(/requires --reason/);
    const ok = deliverablesArguments([
      "42",
      "detach",
      "--agent",
      "alice",
      "--pr",
      prLink(5),
      "--reason",
      "closed unmerged",
    ]);
    expect(ok.request).toMatchObject({ action: "detach", reason: "closed unmerged" });
  });
  it("parses membership state, legacy commits, targets and rejects misplaced options", () => {
    expect(
      deliverablesArguments(["42", "membership", "complete", "--agent", "a", "--reason", "r"])
        .request.membership,
    ).toBe("complete");
    expect(
      deliverablesArguments([
        "42",
        "attach",
        "--legacy",
        "--agent",
        "a",
        "--commit",
        "example/project@abc1234",
        "--reason",
        "r",
      ]).request.commits,
    ).toEqual(["example/project@abc1234"]);
    expect(
      deliverablesArguments([
        "42",
        "attach",
        "--agent",
        "a",
        "--pr",
        prLink(5),
        "--target",
        "example/library:dev",
      ]).request.target,
    ).toEqual({ repository: "example/library", branch: "dev" });
    expect(() =>
      deliverablesArguments(["42", "attest", "--legacy", "--agent", "a", "--membership", "open"]),
    ).toThrow();
    expect(() => deliverablesArguments(["42", "reset", "--agent", "a", "--reason", "r"])).toThrow(
      /--as/,
    );
    expect(() =>
      deliverablesArguments(["42", "detach", "--agent", "a", "--commit", "x/y@abc1234"]),
    ).toThrow();
  });
});

describe("paged comment reader", () => {
  it("keeps ids and timestamps and reads to the start of history", async () => {
    const comments = Array.from({ length: 250 }, () => comment("hello"));
    const { rt } = github({ comments, pageSize: 100 });
    const first = {
      nodes: comments.slice(150),
      pageInfo: { hasPreviousPage: true, startCursor: "c150" },
    };
    const read = await readDeliveryComments(repo, N, first, rt.query);
    expect(read.complete).toBe(true);
    expect(read.comments.map((c) => c.databaseId)).toEqual(comments.map((c) => c.databaseId));
    expect(read.comments.every((c) => c.createdAt)).toBe(true);
  });
  it("is incomplete when the page bound is hit, and stops early only when enough holds", async () => {
    const comments = Array.from({ length: 50 }, () => comment("x"));
    const { rt } = github({ comments, pageSize: 10 });
    const first = {
      nodes: comments.slice(40),
      pageInfo: { hasPreviousPage: true, startCursor: "c40" },
    };
    expect((await readDeliveryComments(repo, N, first, rt.query, undefined, 2)).complete).toBe(
      false,
    );
    const early = await readDeliveryComments(repo, N, first, rt.query, (c) => c.length >= 20);
    expect(early).toMatchObject({ complete: true, pages: 2 });
  });
  it("a truncated history refuses fold-dependent mutations EVIDENCE_INCOMPLETE", async () => {
    const comments = Array.from({ length: 30 }, () => comment("x"));
    comments.push(submitted());
    const { rt } = github({ comments, pageSize: 2, labels: ["agent:alice"] });
    refused(
      await planDeliverables(repo, request("attach", { prs: [prLink(6)] }), rt),
      "EVIDENCE_INCOMPLETE",
    );
  });
});

describe("deliverables attach and link checks", () => {
  it("S7: a PR in another repository is refused TARGET_MISMATCH unless --target states it", async () => {
    const pr = fakePr(9, {}, other);
    const { rt, state } = github({ labels: ["agent:alice"], prs: [pr] });
    const plan = refused(
      await planDeliverables(repo, request("attach", { prs: [pr.url] }), rt),
      "TARGET_MISMATCH",
    );
    expect(plan.recovery[0]).toContain(`--target ${other}:main`);
    const ok = await planDeliverables(
      repo,
      request("attach", { prs: [pr.url], target: { repository: other, branch: "main" } }),
      rt,
    );
    expect(ok.ok && ok.record?.deliverables[0]).toMatchObject({
      repository: other,
      target: { repository: other, branch: "main" },
    });
    expect(state.writes).toEqual([]);
  });
  it("S7: a PR on a different base branch is refused TARGET_MISMATCH; a missing closing link only warns", async () => {
    const pr = fakePr(9, { baseRefName: "feature", closingIssuesReferences: { nodes: [] } });
    const { rt } = github({ labels: ["agent:alice"], prs: [pr] });
    refused(
      await planDeliverables(repo, request("attach", { prs: [pr.url] }), rt),
      "TARGET_MISMATCH",
    );
    const ok = await planDeliverables(
      repo,
      request("attach", { prs: [pr.url], target: { repository: repo, branch: "feature" } }),
      rt,
    );
    expect(ok.ok && ok.notes.join(" ")).toMatch(/no closing reference/);
  });
  it("TARGET_MISMATCH: an explicit target branch must match the PR's base", async () => {
    const pr = fakePr(9);
    const { rt } = github({ labels: ["agent:alice"], prs: [pr] });
    refused(
      await planDeliverables(
        repo,
        request("attach", { prs: [pr.url], target: { repository: repo, branch: "release" } }),
        rt,
      ),
      "TARGET_MISMATCH",
    );
  });
  it("EVIDENCE_INCOMPLETE: an unreadable PR is refused and nothing is recorded", async () => {
    const { rt, state } = github({ labels: ["agent:alice"] });
    const result = await applyDeliverables(repo, request("attach", { prs: [prLink(9)] }), rt);
    refused(result, "EVIDENCE_INCOMPLETE");
    expect(state.writes).toEqual([]);
  });
  it("attach by the claim holder writes one record first, and a retry posts nothing more", async () => {
    const pr = fakePr(9);
    const { rt, state } = github({ labels: ["agent:alice"], prs: [pr] });
    const req = request("attach", { prs: [pr.url], reason: null });
    const result = await applyDeliverables(repo, req, rt);
    expect(result.exitCode).toBe(0);
    expect(posted(state)).toHaveLength(1);
    expect(posted(state)[0]).toMatchObject({
      op: "attach",
      responsible: "alice",
      deliverables: [{ number: 9, nodeId: "PR_9", headOid: "head9" }],
    });
    const again = await planDeliverables(repo, req, rt);
    expect(again.ok && again.noop).toBe(true);
  });
  it("dry run plans the record without writing", async () => {
    const pr = fakePr(9);
    const { rt, state } = github({ labels: ["agent:alice"], prs: [pr] });
    const plan = await planDeliverables(repo, request("attach", { prs: [pr.url] }), rt);
    expect(deliverablesText(plan, true)).toMatch(/DRY RUN[\s\S]*gh issue comment 42/);
    expect(state.writes).toEqual([]);
  });
  it("S48: another agent with no claim and no responsibility cannot attach (NOT_RESPONSIBLE)", async () => {
    const pr = fakePr(9);
    const { rt } = github({
      prs: [pr],
      comments: [submitted(), post(rec("detach", { deliverables: [member(5)] }))],
    });
    const plan = refused(
      await planDeliverables(repo, request("attach", { agent: "bob", prs: [pr.url] }), rt),
      "NOT_RESPONSIBLE",
    );
    expect(plan.recovery.join("\n")).toMatch(
      /handoff --agent alice --to bob[\s\S]*reassign[\s\S]*reset/,
    );
    // The ticket-responsible agent may still attach after detaching the last member (S47).
    const ok = await planDeliverables(repo, request("attach", { prs: [pr.url] }), rt);
    expect(ok.ok).toBe(true);
  });
});

describe("deliverables detach, retarget and handoff", () => {
  it("S14: detach with a reason records it and keeps ticket responsibility", async () => {
    const { rt, state } = github({ comments: [submitted()] });
    const result = await applyDeliverables(
      repo,
      request("detach", { prs: [prLink(5)], reason: "closed unmerged" }),
      rt,
    );
    expect(result.exitCode).toBe(0);
    expect(posted(state)[0]).toMatchObject({ op: "detach", reason: "closed unmerged" });
    expect(result.ok && result.notes.join(" ")).toMatch(/ticket responsibility \(alice\)/);
  });
  it("NOT_REQUIRED: retargeting a deliverable that is not required is refused", async () => {
    const pr = fakePr(7, { baseRefName: "dev" });
    const { rt } = github({ comments: [submitted()], prs: [pr] });
    refused(
      await planDeliverables(
        repo,
        request("retarget", { prs: [pr.url], target: { repository: repo, branch: "dev" } }),
        rt,
      ),
      "NOT_REQUIRED",
    );
  });
  it("retarget is checked live like attach and recorded", async () => {
    const pr = fakePr(5, { baseRefName: "dev" });
    const { rt } = github({ comments: [submitted()], prs: [pr] });
    const plan = await planDeliverables(
      repo,
      request("retarget", { prs: [pr.url], target: { repository: repo, branch: "dev" } }),
      rt,
    );
    expect(plan.ok && plan.record?.deliverables[0].target).toEqual({
      repository: repo,
      branch: "dev",
    });
  });
  it("S19: B cannot hand off A's deliverable; A can, naming its predecessor", async () => {
    const sub = submitted();
    const { rt, state } = github({ comments: [sub] });
    refused(
      await planDeliverables(
        repo,
        request("handoff", { agent: "bob", to: "carol", prs: [prLink(5)] }),
        rt,
      ),
      "NOT_RESPONSIBLE",
    );
    const result = await applyDeliverables(
      repo,
      request("handoff", { to: "bob", prs: [prLink(5)] }),
      rt,
    );
    expect(result.exitCode).toBe(0);
    expect(posted(state)[0]).toMatchObject({
      op: "handoff",
      scope: "deliverable",
      to: "bob",
      expectedResponsibilityRecord: String(sub.databaseId),
    });
  });
  it("S49: a ticket handoff while the caller holds a claim is refused CLAIM_HELD", async () => {
    const { rt } = github({ comments: [submitted()], labels: ["agent:alice"] });
    refused(await planDeliverables(repo, request("handoff", { to: "bob" }), rt), "CLAIM_HELD");
    const { rt: released } = github({ comments: [submitted()] });
    const ok = await planDeliverables(repo, request("handoff", { to: "bob" }), released);
    expect(ok.ok && ok.record).toMatchObject({ scope: "ticket", to: "bob" });
  });
  it("a handoff that folds as stale after posting is reported HANDOFF_STALE, never re-sent", async () => {
    const sub = submitted();
    let raced = false;
    const { rt, state } = github({
      comments: [sub],
      onRun: (args, s) => {
        // A concurrent valid handoff A to C lands just before ours is posted.
        if (raced || args[1] !== "comment") return;
        raced = true;
        s.comments.push(
          post(
            rec("handoff", {
              to: "carol",
              scope: "ticket",
              expectedResponsibilityRecord: String(sub.databaseId),
            }),
          ),
        );
      },
    });
    const result = await applyDeliverables(repo, request("handoff", { to: "bob" }), rt);
    expect(result.exitCode).toBe(2);
    expect(result.conflict).toMatch(/^HANDOFF_STALE/);
    expect(posted(state)).toHaveLength(1);
  });
  it("concurrent handoffs by one agent to different recipients get distinct opIds; the loser is HANDOFF_STALE", async () => {
    const sub = submitted();
    const { rt, state } = github({ comments: [sub] });
    // Both invocations plan against the same fold before either posts.
    const toCarol = await planDeliverables(repo, request("handoff", { to: "carol" }), rt);
    const toBob = await planDeliverables(repo, request("handoff", { to: "bob" }), rt);
    expect(toCarol.ok && toBob.ok && toCarol.record!.opId).not.toBe(toBob.ok && toBob.record!.opId);
    // Carol's handoff lands just before Bob's is posted.
    const run = rt.run;
    let raced = false;
    rt.run = async (args: string[]) => {
      if (!raced && args[1] === "comment") {
        raced = true;
        await run((toCarol.ok && toCarol.changes[0]!.command) as string[]);
      }
      await run(args);
    };
    const result = await applyDeliverables(repo, request("handoff", { to: "bob" }), rt, toBob);
    expect(result.exitCode).not.toBe(0);
    expect(result.conflict).toMatch(/^HANDOFF_STALE/);
    expect(
      posted(state)
        .filter((r) => r?.op === "handoff")
        .map((r) => r?.to),
    ).toEqual(["carol", "bob"]);
  });
  it("the same handoff retried with a different reason keeps its opId", async () => {
    const { rt } = github({ comments: [submitted()] });
    const a = await planDeliverables(repo, request("handoff", { to: "bob", reason: "one" }), rt);
    const b = await planDeliverables(repo, request("handoff", { to: "bob", reason: "two" }), rt);
    expect(a.ok && a.record!.opId).toBe(b.ok && b.record!.opId);
  });
});

describe("deliverables membership, attest and legacy recovery", () => {
  it("CLAIM_HELD: membership cannot change under another agent's claim", async () => {
    const { rt } = github({ comments: [submitted()], labels: ["agent:bob"] });
    refused(
      await planDeliverables(repo, request("membership", { membership: "open" }), rt),
      "CLAIM_HELD",
    );
  });
  it("a maintainer may close membership as an override when no claim is held", async () => {
    const { rt } = github({
      comments: [post(rec("submit", { deliverables: [member(5)], membership: "open" }))],
    });
    const plan = await planDeliverables(
      repo,
      request("membership", { agent: "maint", membership: "complete" }),
      rt,
    );
    expect(plan.ok && plan.record).toMatchObject({ membership: "complete", login: "writer" });
  });
  it("ATTEST_NOT_APPLICABLE: attest with an open required PR names it and the recovery", async () => {
    const { rt, state } = github({ comments: [submitted()], prs: [fakePr(5)] });
    const plan = refused(
      await applyDeliverables(repo, request("attest"), rt),
      "ATTEST_NOT_APPLICABLE",
    );
    expect(plan.prerequisite).toContain(`${repo}#5`);
    expect(plan.recovery[0]).toContain("detach");
    expect(state.writes).toEqual([]);
  });
  it("attest applies once every member is merged into its target (live compare)", async () => {
    const merged = fakePr(5, { state: "MERGED", merged: true, mergeCommit: { oid: "m5" } });
    const { rt } = github({ comments: [submitted()], prs: [merged], compare: { m5: "behind" } });
    const plan = await planDeliverables(repo, request("attest"), rt);
    expect(plan.ok && plan.record?.op).toBe("attest");
    const { rt: unknown } = github({ comments: [submitted()], prs: [merged] });
    refused(await planDeliverables(repo, request("attest"), unknown), "EVIDENCE_INCOMPLETE");
  });
  it("S27: attach --legacy while another agent holds a claim is refused CLAIM_HELD", async () => {
    const pr = fakePr(5, { state: "MERGED", merged: true });
    const { rt, state } = github({ comments: [v1Done()], labels: ["agent:bob"], prs: [pr] });
    refused(
      await applyDeliverables(repo, request("attach", { legacy: true, prs: [pr.url] }), rt),
      "CLAIM_HELD",
    );
    expect(state.writes).toEqual([]);
  });
  it("S28: attach --legacy by an author without write permission is refused MARKER_UNVERIFIED", async () => {
    const pr = fakePr(5);
    const { rt, state } = github({ comments: [v1Done()], viewer: "reader", prs: [pr] });
    refused(
      await applyDeliverables(repo, request("attach", { legacy: true, prs: [pr.url] }), rt),
      "MARKER_UNVERIFIED",
    );
    expect(state.writes).toEqual([]);
  });
  it("S28: attach --legacy with no v1 done record is refused LEGACY_NOT_APPLICABLE", async () => {
    const pr = fakePr(5);
    const { rt, state } = github({ prs: [pr] });
    refused(
      await applyDeliverables(repo, request("attach", { legacy: true, prs: [pr.url] }), rt),
      "LEGACY_NOT_APPLICABLE",
    );
    expect(state.writes).toEqual([]);
  });
  it("S1/S43: attach --legacy records login, the cited release and a commit deliverable", async () => {
    const release = v1Done();
    const pr = fakePr(5, { state: "MERGED", merged: true });
    const { rt, state } = github({ comments: [release], prs: [pr] });
    const result = await applyDeliverables(
      repo,
      request("attach", { legacy: true, prs: [pr.url], commits: [`${repo}@abc1234`] }),
      rt,
    );
    expect(result.exitCode).toBe(0);
    expect(posted(state)[0]).toMatchObject({
      op: "legacy-attach",
      login: "writer",
      legacyRelease: String(release.databaseId),
      membership: "complete",
      responsible: "alice",
    });
    expect(posted(state)[0]?.deliverables.map((d) => d.kind)).toEqual(["pr", "commit"]);
    expect(state.writes.some((w) => w[1] === "edit")).toBe(false);
    // Retrying is safe: the record is recognised, not refused LEGACY_NOT_APPLICABLE.
    const again = await planDeliverables(
      repo,
      request("attach", { legacy: true, prs: [pr.url], commits: [`${repo}@abc1234`] }),
      rt,
    );
    expect(again.ok && again.noop).toBe(true);
  });
  it("S40: attest --legacy while another agent holds a claim is refused CLAIM_HELD", async () => {
    const { rt, state } = github({ comments: [v1Done()], labels: ["agent:bob"] });
    refused(await applyDeliverables(repo, request("attest", { legacy: true }), rt), "CLAIM_HELD");
    expect(state.writes).toEqual([]);
  });
  it("S41: attest --legacy after any trusted delivery record, or without a v1 done record, is LEGACY_NOT_APPLICABLE", async () => {
    const { rt } = github({ comments: [v1Done(), submitted()] });
    const plan = refused(
      await planDeliverables(repo, request("attest", { legacy: true }), rt),
      "LEGACY_NOT_APPLICABLE",
    );
    expect(plan.recovery[0]).toContain(`deliverables ${N} attest --agent alice`);
    const { rt: none } = github();
    refused(
      await planDeliverables(repo, request("attest", { legacy: true }), none),
      "LEGACY_NOT_APPLICABLE",
    );
  });
  it("S42: attest --legacy when the permission lookup fails is refused MARKER_UNVERIFIED", async () => {
    const { rt, state } = github({ comments: [v1Done()], viewer: "flaky" });
    refused(
      await applyDeliverables(repo, request("attest", { legacy: true }), rt),
      "MARKER_UNVERIFIED",
    );
    // The cited v1 record's author being unverifiable refuses the same way.
    const { rt: v1Flaky } = github({ comments: [v1Done("flaky")] });
    refused(
      await planDeliverables(repo, request("attest", { legacy: true }), v1Flaky),
      "MARKER_UNVERIFIED",
    );
    expect(state.writes).toEqual([]);
  });
  it("S39: attest --legacy writes an empty, complete legacy-attest record and no labels", async () => {
    const { rt, state } = github({ comments: [v1Done()] });
    const result = await applyDeliverables(repo, request("attest", { legacy: true }), rt);
    expect(result.exitCode).toBe(0);
    expect(posted(state)[0]).toMatchObject({
      op: "legacy-attest",
      deliverables: [],
      membership: "complete",
    });
    expect(state.writes).toHaveLength(1);
  });
});

describe("deliverables maintainer overrides", () => {
  it("S62: reset with an open required PR is refused RESET_HAS_OPEN_PR naming it", async () => {
    const { rt, state } = github({ comments: [submitted()], prs: [fakePr(5)] });
    const plan = refused(
      await applyDeliverables(repo, request("reset", { agent: "maint", as: "ready" }), rt),
      "RESET_HAS_OPEN_PR",
    );
    expect(plan.facts.pullRequests).toEqual([prLink(5)]);
    expect(plan.recovery.join("\n")).toMatch(
      /reassign[\s\S]*gh pr close 5 --repo example\/project/,
    );
    expect(state.writes).toEqual([]);
  });
  it("S62: a merely linked open PR, or unreadable PR state, also refuses RESET_HAS_OPEN_PR", async () => {
    const { rt } = github({ linked: [{ number: 8, url: prLink(8), state: "OPEN" }] });
    refused(
      await planDeliverables(repo, request("reset", { agent: "maint", as: "ready" }), rt),
      "RESET_HAS_OPEN_PR",
    );
    const { rt: unreadable } = github({ comments: [submitted()] });
    const plan = refused(
      await planDeliverables(repo, request("reset", { agent: "maint", as: "ready" }), unreadable),
      "RESET_HAS_OPEN_PR",
    );
    expect(plan.prerequisite).toMatch(/could not be read/);
  });
  it("S63: a maintainer reassign records the override with the author's login", async () => {
    const { rt, state } = github({ comments: [submitted()], prs: [fakePr(5)] });
    const result = await applyDeliverables(
      repo,
      request("reassign", { agent: "maint", to: "bob" }),
      rt,
    );
    expect(result.exitCode).toBe(0);
    expect(posted(state)[0]).toMatchObject({ op: "reassign", to: "bob", login: "writer" });
    refused(
      await planDeliverables(
        repo,
        request("reassign", { agent: "maint", to: "carol" }),
        github({ comments: [submitted()], labels: ["agent:bob"] }).rt,
      ),
      "CLAIM_HELD",
    );
  });
  it("S64: after the PR is closed, reset writes its record first, then the labels", async () => {
    const closed = fakePr(5, { state: "CLOSED" });
    const { rt, state } = github({
      comments: [submitted()],
      prs: [closed],
      labels: ["status:awaiting-review"],
    });
    const result = await applyDeliverables(
      repo,
      request("reset", { agent: "maint", as: "ready" }),
      rt,
    );
    expect(result.exitCode).toBe(0);
    expect(state.writes.map((w) => w[1])).toEqual(["comment", "edit"]);
    expect(posted(state)[0]?.plan).toEqual({
      remove: ["status:awaiting-review"],
      add: ["status:ready"],
    });
    expect(state.labels).toEqual(["status:ready"]);
  });
  it("a reset whose label write failed is completed by a retry without a second record", async () => {
    const closed = fakePr(5, { state: "CLOSED" });
    let fail = true;
    const { rt, state } = github({
      comments: [submitted()],
      prs: [closed],
      labels: ["status:awaiting-review"],
      failRun: (args) => args[1] === "edit" && fail,
    });
    const req = request("reset", { agent: "maint", as: "incomplete" });
    expect((await applyDeliverables(repo, req, rt)).exitCode).toBe(2);
    fail = false;
    const retry = await applyDeliverables(repo, req, rt);
    expect(retry.exitCode).toBe(0);
    expect(posted(state)).toHaveLength(1);
    expect(state.labels).toEqual(["status:incomplete"]);
  });
  it("a recorded reset's label retry re-checks prerequisites: a new claim refuses CLAIM_HELD", async () => {
    const closed = fakePr(5, { state: "CLOSED" });
    let fail = true;
    const { rt, state } = github({
      comments: [submitted()],
      prs: [closed],
      labels: ["status:awaiting-review"],
      failRun: (args) => args[1] === "edit" && fail,
    });
    const req = request("reset", { agent: "maint", as: "ready" });
    expect((await applyDeliverables(repo, req, rt)).exitCode).toBe(2);
    fail = false;
    state.labels.push("agent:bob");
    const retry = refused(await applyDeliverables(repo, req, rt), "CLAIM_HELD");
    expect(retry.prerequisite).toMatch(
      /reset is recorded \(comment \d+\) but its labels were not applied/,
    );
    expect(retry.recovery.at(-1)).toMatch(/deliverables 42 reset --agent maint --as ready/);
    expect(posted(state)).toHaveLength(1);
    expect(state.writes.filter((w) => w[1] === "edit")).toHaveLength(0);
    expect(state.labels).toEqual(["status:awaiting-review", "agent:bob"]);
  });
  it("a recorded reset's label retry re-checks prerequisites: a reopened PR refuses RESET_HAS_OPEN_PR", async () => {
    const pr = fakePr(5, { state: "CLOSED" });
    const linked: { number: number; url: string; state: string }[] = [];
    let fail = true;
    const { rt, state } = github({
      comments: [submitted()],
      prs: [pr],
      linked,
      labels: ["status:awaiting-review"],
      failRun: (args) => args[1] === "edit" && fail,
    });
    const req = request("reset", { agent: "maint", as: "incomplete" });
    expect((await applyDeliverables(repo, req, rt)).exitCode).toBe(2);
    fail = false;
    pr.state = "OPEN";
    const reopened = refused(await applyDeliverables(repo, req, rt), "RESET_HAS_OPEN_PR");
    expect(reopened.prerequisite).toMatch(/labels were not applied[\s\S]*re-run the same reset/);
    pr.state = "CLOSED";
    linked.push({ number: 8, url: prLink(8), state: "OPEN" });
    refused(await applyDeliverables(repo, req, rt), "RESET_HAS_OPEN_PR");
    expect(posted(state)).toHaveLength(1);
    expect(state.labels).toEqual(["status:awaiting-review"]);
    linked.length = 0;
    expect((await applyDeliverables(repo, req, rt)).exitCode).toBe(0);
    expect(posted(state)).toHaveLength(1);
    expect(state.labels).toEqual(["status:incomplete"]);
  });
  /** A reset whose record is followed, before its label step, by another writer's record. */
  const interleavedReset = (intervene: DeliveryRecord, labels = ["status:awaiting-review"]) => {
    const { rt, state } = github({
      comments: [submitted()],
      prs: [fakePr(5, { state: "CLOSED" })],
      labels,
    });
    const run = rt.run;
    let raced = false;
    rt.run = async (args: string[]) => {
      await run(args);
      if (raced || args[1] !== "comment") return;
      raced = true;
      state.comments.push(comment(deliveryMarker(intervene), "writer", 9500));
    };
    return { rt, state };
  };
  it("a reset interleaved with a non-conflicting record finds its own record by opId and applies its labels", async () => {
    const { rt, state } = interleavedReset(
      rec("membership", { agent: "maint", membership: "open", opId: "other-op" }),
    );
    const result = await applyDeliverables(
      repo,
      request("reset", { agent: "maint", as: "ready" }),
      rt,
    );
    expect(result.exitCode).toBe(0);
    expect(posted(state).filter((r) => r?.op === "reset")).toHaveLength(1);
    expect(state.labels).toEqual(["status:ready"]);
    expect(result.ok && result.steps?.map((s) => s.step)).toEqual(["record", "labels"]);
  });
  it("a reset replanned after a membership record arrives before its write resumes by the posted opId", async () => {
    const { rt, state } = github({
      comments: [submitted()],
      prs: [fakePr(5, { state: "CLOSED" })],
      labels: ["status:awaiting-review"],
    });
    const req = request("reset", { agent: "maint", as: "ready" });
    const first = await planDeliverables(repo, req, rt);
    // Another writer's membership record lands after the CLI's plan, before the pre-write re-read.
    state.comments.push(
      comment(
        deliveryMarker(rec("membership", { agent: "maint", membership: "open", opId: "other" })),
        "writer",
        9500,
      ),
    );
    const result = await applyDeliverables(repo, req, rt, first);
    expect(result.exitCode).toBe(0);
    const resets = posted(state).filter((r) => r?.op === "reset");
    expect(resets).toHaveLength(1);
    expect(resets[0]!.opId).not.toBe(first.ok && first.record!.opId);
    expect(state.labels).toEqual(["status:ready"]);
    expect(result.ok && result.steps?.map((s) => s.step)).toEqual(["record", "labels"]);
  });
  it("a reset superseded by an interleaved responsibility record is refused, not re-posted or applied", async () => {
    const { rt, state } = interleavedReset(
      rec("reassign", { agent: "maint", to: "bob", login: "writer", opId: "other-op" }),
    );
    const result = await applyDeliverables(
      repo,
      request("reset", { agent: "maint", as: "ready" }),
      rt,
    );
    expect(result.exitCode).toBe(2);
    const refusal = refused(result, "DELIVERY_DIVERGED");
    expect(refusal.prerequisite).toMatch(
      /reset is recorded \(comment \d+\) but its labels were not applied[\s\S]*reassign \(comment 9500\)[\s\S]*no second reset/,
    );
    expect(refusal.recovery.length).toBeGreaterThan(0);
    expect(posted(state).filter((r) => r?.op === "reset")).toHaveLength(1);
    expect(state.writes.filter((w) => w[1] === "edit")).toHaveLength(0);
    expect(state.labels).toEqual(["status:awaiting-review"]);
  });
  it("a completed reset whose readiness was later changed without a record is refused on retry, labels unchanged", async () => {
    const closed = fakePr(5, { state: "CLOSED" });
    const { rt, state } = github({
      comments: [submitted()],
      prs: [closed],
      labels: ["status:awaiting-review"],
    });
    const req = request("reset", { agent: "maint", as: "ready" });
    expect((await applyDeliverables(repo, req, rt)).exitCode).toBe(0);
    expect(state.labels).toEqual(["status:ready"]);
    state.labels = ["status:incomplete"];
    const writes = state.writes.length;
    const retry = await applyDeliverables(repo, req, rt);
    expect(retry.exitCode).not.toBe(0);
    refused(await planDeliverables(repo, req, rt), "DELIVERY_DIVERGED");
    expect(state.labels).toEqual(["status:incomplete"]);
    expect(state.writes).toHaveLength(writes);
  });
  it("an exact reset retry right after success is a no-op with exit 0", async () => {
    const closed = fakePr(5, { state: "CLOSED" });
    const { rt, state } = github({
      comments: [submitted()],
      prs: [closed],
      labels: ["status:awaiting-review"],
    });
    const req = request("reset", { agent: "maint", as: "ready" });
    expect((await applyDeliverables(repo, req, rt)).exitCode).toBe(0);
    const writes = state.writes.length;
    expect((await applyDeliverables(repo, req, rt)).exitCode).toBe(0);
    expect(state.writes).toHaveLength(writes);
    expect(state.labels).toEqual(["status:ready"]);
  });
  it("resetPlanPending accepts the recorded starting state or a partial application only", () => {
    const plan = { remove: ["status:awaiting-review"], add: ["status:ready"] };
    const start = ["status:awaiting-review", "status:incomplete"];
    expect(resetPlanPending(plan, start, ["status:incomplete", "status:awaiting-review"])).toBe(
      true,
    );
    expect(resetPlanPending(plan, start, ["status:incomplete", "agent:bob"])).toBe(true);
    expect(resetPlanPending(plan, start, ["status:incomplete", "status:ready"])).toBe(false);
    expect(resetPlanPending(plan, start, ["status:awaiting-review"])).toBe(false);
    expect(resetPlanPending(plan, start, [])).toBe(false);
    expect(resetPlanPending(plan, ["status:awaiting-review"], ["status:incomplete"])).toBe(false);
    expect(resetPlanPending(plan, [], [])).toBe(true);
    // A record without its starting state is unknown, so it is never pending.
    expect(resetPlanPending(plan, undefined, ["status:awaiting-review"])).toBe(false);
  });
  it("a fresh reset --as ready on a ticket already marked status:incomplete applies its labels", async () => {
    const closed = fakePr(5, { state: "CLOSED" });
    const { rt, state } = github({
      comments: [submitted()],
      prs: [closed],
      labels: ["status:awaiting-review", "status:incomplete"],
    });
    const result = await applyDeliverables(
      repo,
      request("reset", { agent: "maint", as: "ready" }),
      rt,
    );
    expect(result.exitCode).toBe(0);
    expect(posted(state)[0]?.observedLabels).toEqual([
      "status:awaiting-review",
      "status:incomplete",
    ]);
    expect(state.labels).toContain("status:ready");
    expect(state.labels).not.toContain("status:awaiting-review");
  });
  it("a reset from status:incomplete whose label write failed is completed by a retry", async () => {
    const closed = fakePr(5, { state: "CLOSED" });
    let fail = true;
    const { rt, state } = github({
      comments: [submitted()],
      prs: [closed],
      labels: ["status:awaiting-review", "status:incomplete"],
      failRun: (args) => args[1] === "edit" && fail,
    });
    const req = request("reset", { agent: "maint", as: "ready" });
    expect((await applyDeliverables(repo, req, rt)).exitCode).toBe(2);
    fail = false;
    expect((await applyDeliverables(repo, req, rt)).exitCode).toBe(0);
    expect(posted(state)).toHaveLength(1);
    expect(state.labels).toContain("status:ready");
    expect(state.labels).not.toContain("status:awaiting-review");
    // An exact retry after success is a no-op.
    const writes = state.writes.length;
    expect((await applyDeliverables(repo, req, rt)).exitCode).toBe(0);
    expect(state.writes).toHaveLength(writes);
  });
  it("a completed reset from status:incomplete whose readiness was later removed is refused on retry", async () => {
    const closed = fakePr(5, { state: "CLOSED" });
    const { rt, state } = github({
      comments: [submitted()],
      prs: [closed],
      labels: ["status:awaiting-review", "status:incomplete"],
    });
    const req = request("reset", { agent: "maint", as: "ready" });
    expect((await applyDeliverables(repo, req, rt)).exitCode).toBe(0);
    state.labels = ["status:awaiting-review"];
    const writes = state.writes.length;
    expect((await applyDeliverables(repo, req, rt)).exitCode).not.toBe(0);
    refused(await planDeliverables(repo, req, rt), "DELIVERY_DIVERGED");
    expect(state.labels).toEqual(["status:awaiting-review"]);
    expect(state.writes).toHaveLength(writes);
  });
  it("an unapplied reset record without observedLabels is refused conservatively on resume", async () => {
    const closed = fakePr(5, { state: "CLOSED" });
    const reset = rec("reset", {
      agent: "maint",
      plan: { remove: ["status:awaiting-review"], add: ["status:ready"] },
    });
    const { rt, state } = github({
      comments: [submitted(), post(reset)],
      prs: [closed],
      labels: ["status:awaiting-review"],
    });
    const refusal = refused(
      await planDeliverables(
        repo,
        request("reset", { agent: "maint", as: "ready", reason: "because" }),
        rt,
      ),
      "DELIVERY_DIVERGED",
    );
    expect(refusal.prerequisite).toMatch(/does not state the labels it started from/);
    expect(state.labels).toEqual(["status:awaiting-review"]);
  });
  it("DELIVERY_DIVERGED: a recorded reset whose labels were changed by others is not re-applied", async () => {
    const closed = fakePr(5, { state: "CLOSED" });
    const reset = rec("reset", {
      agent: "maint",
      plan: { remove: ["status:awaiting-review"], add: ["status:ready"] },
    });
    const { rt } = github({
      comments: [submitted(), post(reset)],
      prs: [closed],
      labels: ["status:awaiting-review", "status:ready"],
    });
    refused(
      await planDeliverables(
        repo,
        request("reset", { agent: "maint", as: "ready", reason: "because" }),
        rt,
      ),
      "DELIVERY_DIVERGED",
    );
  });
  it("VOID_NOT_APPLICABLE: void of a parsable record is refused; a malformed one is voided", async () => {
    const good = submitted();
    const bad = comment("<!-- github-triage:delivery v1 {not json} -->");
    const { rt } = github({ comments: [good, bad] });
    refused(
      await planDeliverables(
        repo,
        request("void", { agent: "maint", comment: String(good.databaseId) }),
        rt,
      ),
      "VOID_NOT_APPLICABLE",
    );
    const plan = await planDeliverables(
      repo,
      request("void", { agent: "maint", comment: String(bad.databaseId) }),
      rt,
    );
    expect(plan.ok && plan.record).toMatchObject({ op: "void", voids: String(bad.databaseId) });
  });
});

describe("deliverables record-state refusals", () => {
  it("RECORD_MALFORMED: a trusted malformed record blocks mutations and offers void", async () => {
    const bad = comment("<!-- github-triage:delivery v1 {not json} -->");
    const { rt } = github({ comments: [submitted(), bad], labels: ["agent:alice"] });
    const plan = refused(
      await planDeliverables(repo, request("membership", { membership: "open" }), rt),
      "RECORD_MALFORMED",
    );
    expect(plan.recovery.join("\n")).toContain(`void --agent alice --comment ${bad.databaseId}`);
  });
  it("RECORD_UNSUPPORTED: a trusted future-version record blocks mutations", async () => {
    const future = comment('<!-- github-triage:delivery v2 {"v":2} -->');
    const { rt } = github({ comments: [submitted(), future] });
    refused(
      await planDeliverables(repo, request("membership", { membership: "open" }), rt),
      "RECORD_UNSUPPORTED",
    );
  });
  it("MARKER_UNVERIFIED: a record whose author's permission is unknown blocks mutations", async () => {
    const { rt } = github({
      comments: [post(rec("submit", { deliverables: [member(5)] }), "flaky")],
    });
    refused(
      await planDeliverables(repo, request("membership", { membership: "open" }), rt),
      "MARKER_UNVERIFIED",
    );
  });
  it("TICKET_NOT_FOUND: a missing issue is refused with recovery", async () => {
    refused(
      await planDeliverables(repo, request("attest"), github({ issueType: null }).rt),
      "TICKET_NOT_FOUND",
    );
  });
  it("NOT_AN_ISSUE: a pull request number is refused with recovery", async () => {
    refused(
      await planDeliverables(repo, request("attest"), github({ issueType: "PullRequest" }).rt),
      "NOT_AN_ISSUE",
    );
  });
});

describe("deliverables retry detection compares every defining field", () => {
  const recorded = (plan: DeliverablesPlan) =>
    plan.ok && /already recorded/i.test(plan.reason ?? "");
  const sub = submitted();
  const twoMembers = post(
    rec("submit", { deliverables: [member(5), member(6)], membership: "complete" }),
  );
  const bad1 = comment("<!-- github-triage:delivery v1 {not json} -->");
  const bad2 = comment("<!-- github-triage:delivery v1 {also not json} -->");
  const cases: {
    op: string;
    comments: DeliveryComment[];
    labels?: string[];
    prs?: FakePr[];
    same: DeliverablesRequest;
    differ: [string, DeliverablesRequest][];
  }[] = [
    {
      op: "attach",
      comments: [
        post(
          rec("attach", { responsible: "alice", deliverables: [member(9)], membership: "open" }),
        ),
      ],
      labels: ["agent:alice"],
      prs: [fakePr(9)],
      same: request("attach", { prs: [prLink(9)], membership: "open", reason: null }),
      differ: [
        [
          "membership",
          request("attach", { prs: [prLink(9)], membership: "complete", reason: null }),
        ],
        [
          "target",
          request("attach", {
            prs: [prLink(9)],
            membership: "open",
            target: { repository: repo, branch: "main" },
            reason: null,
          }),
        ],
        [
          "deliverables",
          request("attach", { prs: [prLink(10)], membership: "open", reason: null }),
        ],
        [
          "agent",
          request("attach", { agent: "bob", prs: [prLink(9)], membership: "open", reason: null }),
        ],
      ],
    },
    {
      op: "detach",
      comments: [twoMembers, post(rec("detach", { deliverables: [member(5)] }))],
      same: request("detach", { prs: [prLink(5)] }),
      differ: [["deliverables", request("detach", { prs: [prLink(6)] })]],
    },
    {
      op: "retarget",
      comments: [
        sub,
        post(
          rec("retarget", {
            deliverables: [{ ...member(5), target: { repository: repo, branch: "main" } }],
          }),
        ),
      ],
      prs: [fakePr(5)],
      same: request("retarget", { prs: [prLink(5)], target: { repository: repo, branch: "main" } }),
      differ: [["target", request("retarget", { prs: [prLink(5)] })]],
    },
    {
      op: "handoff",
      comments: [
        sub,
        post(
          rec("handoff", {
            deliverables: [member(5)],
            to: "bob",
            scope: "deliverable",
            expectedResponsibilityRecord: String(sub.databaseId),
          }),
        ),
      ],
      same: request("handoff", { prs: [prLink(5)], to: "bob" }),
      differ: [
        ["to", request("handoff", { prs: [prLink(5)], to: "carol" })],
        ["scope", request("handoff", { to: "bob" })],
      ],
    },
    {
      op: "membership",
      comments: [
        post(rec("submit", { deliverables: [member(5)], membership: "open" })),
        post(rec("membership", { membership: "complete" })),
      ],
      labels: ["agent:alice"],
      same: request("membership", { membership: "complete" }),
      differ: [["membership", request("membership", { membership: "open" })]],
    },
    {
      op: "reassign",
      comments: [sub, post(rec("reassign", { agent: "maint", to: "bob", login: "writer" }))],
      same: request("reassign", { agent: "maint", to: "bob" }),
      differ: [["to", request("reassign", { agent: "maint", to: "carol" })]],
    },
    {
      op: "reset",
      comments: [
        sub,
        post(
          rec("reset", {
            agent: "maint",
            login: "writer",
            plan: { remove: ["status:awaiting-review"], add: ["status:ready"] },
            observedLabels: ["status:awaiting-review"],
          }),
        ),
      ],
      labels: ["status:awaiting-review"],
      prs: [fakePr(5, { state: "CLOSED" })],
      same: request("reset", { agent: "maint", as: "ready" }),
      differ: [["as", request("reset", { agent: "maint", as: "incomplete" })]],
    },
    {
      op: "void",
      comments: [
        sub,
        bad1,
        bad2,
        post(rec("void", { agent: "maint", voids: String(bad1.databaseId), login: "writer" })),
      ],
      same: request("void", { agent: "maint", comment: String(bad1.databaseId) }),
      differ: [["voids", request("void", { agent: "maint", comment: String(bad2.databaseId) })]],
    },
  ];
  for (const c of cases)
    it(`${c.op}: an identical request is a retry; a differing defining field is not`, async () => {
      const setup = { comments: c.comments, labels: c.labels, prs: c.prs };
      expect(recorded(await planDeliverables(repo, c.same, github(setup).rt))).toBe(true);
      // Reason text is descriptive, not defining: rewording it is still a retry.
      expect(
        recorded(await planDeliverables(repo, { ...c.same, reason: "reworded" }, github(setup).rt)),
      ).toBe(true);
      for (const [field, req] of c.differ)
        expect([field, recorded(await planDeliverables(repo, req, github(setup).rt))]).toEqual([
          field,
          false,
        ]);
    });
});
