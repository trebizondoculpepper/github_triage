import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  applyComplete,
  collectDeliveryFacts,
  completeArguments,
  completeText,
  completionEffects,
  completionPredicates,
  deliveryMemberCap,
  deriveDatalog,
  effectiveResponsibility,
  evaluateDelivery,
  evaluationRevision,
  planComplete,
  renderDatalog,
} from "./completion.js";
import type { CompletePlan, CompleteResult, DeliveryFacts, MemberEvidence } from "./completion.js";
import type { DeliverablesRuntime } from "./deliverables.js";
import { deliveryMarker, markerTrust, parseDeliveryComment, readDeliveryFold } from "./delivery.js";
import type { Deliverable, DeliveryComment, DeliveryRecord } from "./delivery.js";
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
  isDraft: boolean;
  merged: boolean;
  mergeCommit: { oid: string } | null;
  headRefOid: string;
  baseRefName: string;
  baseRepository: { nameWithOwner: string; defaultBranchRef: { name: string } | null };
}
const pr = (n: number, fields: Partial<FakePr> = {}, r = repo): FakePr => ({
  id: `PR_${n}`,
  number: n,
  url: prLink(n, r),
  state: "OPEN",
  isDraft: false,
  merged: false,
  mergeCommit: null,
  headRefOid: `head${n}`,
  baseRefName: "main",
  baseRepository: { nameWithOwner: r, defaultBranchRef: { name: "main" } },
  ...fields,
});
const merged = (n: number, oid = `m${n}`, r = repo, base = "main") =>
  pr(n, { state: "MERGED", merged: true, mergeCommit: { oid }, baseRefName: base }, r);

interface State {
  issueState: "OPEN" | "CLOSED";
  stateReason: string | null;
  closedBy: string | null;
  labels: string[];
  comments: DeliveryComment[];
  prs: Map<string, FakePr>;
  /** `repo:branch...oid` (or just the oid) → compare status; missing is an error answer. */
  compare: Record<string, string>;
  /** repository → default branch; null makes the read fail. */
  defaults: Record<string, string | null>;
  writes: string[][];
  nextId: number;
  queries: number;
  rests: number;
}

/** An injected GitHub: one issue, its comments, labels and closure, PRs, compares, permissions. */
function github(
  setup: {
    labels?: string[];
    comments?: DeliveryComment[];
    prs?: FakePr[];
    compare?: Record<string, string>;
    defaults?: Record<string, string | null>;
    issueState?: "OPEN" | "CLOSED";
    stateReason?: string | null;
    closedBy?: string | null;
    viewer?: string;
    permissions?: Record<string, RepositoryPermission>;
    failRun?: (args: string[]) => boolean;
    /** Runs after each write: the place to inject a concurrent actor. */
    onRun?: (args: string[], state: State) => void;
    pageSize?: number;
  } = {},
) {
  const state: State = {
    issueState: setup.issueState ?? "OPEN",
    stateReason: setup.stateReason ?? null,
    closedBy: setup.closedBy ?? null,
    labels: [...(setup.labels ?? [])],
    comments: [...(setup.comments ?? [])],
    prs: new Map((setup.prs ?? []).map((p) => [p.url, p])),
    compare: { ...setup.compare },
    defaults: { [repo]: "main", [other]: "main", ...setup.defaults },
    writes: [],
    nextId: 9000,
    queries: 0,
    rests: 0,
  };
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
    state.queries++;
    if (q.includes("viewer{"))
      return {
        viewer: { __typename: "User", login: viewer },
        repository: {
          issueOrPullRequest: {
            __typename: "Issue",
            number: N,
            title: "Ticket",
            url: `https://github.com/${repo}/issues/${N}`,
            state: state.issueState,
            stateReason: state.stateReason,
            labels: { nodes: state.labels.map((name) => ({ name })), pageInfo: {} },
            timelineItems: {
              nodes: state.closedBy ? [{ actor: { login: state.closedBy } }] : [],
            },
            comments: page(state.comments.length),
          },
        },
      };
    if (q.includes("comments(last:100,before"))
      return { repository: { issue: { comments: page(Number(String(v.before).slice(1))) } } };
    if (q.includes("resource(url")) {
      const p = state.prs.get(String(v.url));
      if (!p) throw new Error("not found");
      return { resource: { __typename: "PullRequest", ...p } };
    }
    if (q.includes("defaultBranchRef")) {
      const name = state.defaults[`${v.owner}/${v.name}`];
      if (name === null) throw new Error("rate limited");
      return { repository: { defaultBranchRef: name ? { name } : null } };
    }
    throw new Error(`unexpected query ${q.slice(0, 40)}`);
  };
  const run = async (args: string[]) => {
    if (setup.failRun?.(args)) throw new Error("gh failed");
    state.writes.push(args);
    if (args[0] === "issue" && args[1] === "comment")
      state.comments.push(comment(args[args.indexOf("--body") + 1], viewer, state.nextId++));
    if (args[0] === "issue" && args[1] === "close") {
      state.issueState = "CLOSED";
      state.stateReason = "COMPLETED";
      state.closedBy = viewer;
    }
    if (args[0] === "issue" && args[1] === "edit")
      for (let i = 0; i < args.length; i++)
        if (args[i] === "--remove-label")
          state.labels = state.labels.filter((l) => l !== args[i + 1]);
    setup.onRun?.(args, state);
  };
  const rest = async (path: string) => {
    state.rests++;
    const m = /collaborators\/([^/]+)\/permission$/.exec(path);
    if (m) {
      const p = permissions[decodeURIComponent(m[1])] ?? "none";
      return p === "unknown"
        ? { status: null, body: null }
        : { status: 200, body: { role_name: p, user: { login: decodeURIComponent(m[1]) } } };
    }
    const c = /^repos\/([^/]+\/[^/]+)\/compare\/(.+)\.\.\.(\w+)$/.exec(path);
    if (c) {
      const status =
        state.compare[`${c[1]}:${decodeURIComponent(c[2])}...${c[3]}`] ?? state.compare[c[3]];
      return status ? { status: 200, body: { status } } : { status: 404, body: null };
    }
    return { status: null, body: null };
  };
  const permission = async (login: string) => permissions[login] ?? "none";
  let clock = 0;
  const rt: DeliverablesRuntime = {
    query,
    run,
    rest,
    trust: markerTrust(permission),
    now: () => new Date(Date.UTC(2026, 10, 14, 12, 0, clock++)),
  };
  return { rt, state };
}

let ids = 100;
function comment(body: string, login = "writer", id = ids++): DeliveryComment {
  return {
    databaseId: id,
    body,
    // Fixtures are created before the run's clock (2026-11-14T12:00Z); posted ones after it.
    createdAt:
      id >= 9000
        ? new Date(Date.UTC(2026, 10, 14, 13, 0, id - 9000)).toISOString()
        : new Date(Date.UTC(2026, 10, 13, 9, 0, id % 3600)).toISOString(),
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
const member = (n: number, r = repo, branch: string | null = null): Deliverable => ({
  kind: "pr",
  repository: r,
  number: n,
  nodeId: `PR_${n}`,
  target: { repository: r, branch },
});
const commitMember = (oid: string): Deliverable => ({
  kind: "commit",
  repository: repo,
  oid,
  target: { repository: repo, branch: null },
});
const post = (r: DeliveryRecord, login = "writer") => comment(deliveryMarker(r), login);
const submitted = (...members: Deliverable[]) =>
  post(rec("submit", { deliverables: members, membership: "complete" }));
const v1Done = () =>
  comment(
    `Handoff by \`alice\`: done.\n\n<!-- github-triage:release:0123456789abcdef ${JSON.stringify({ v: 1, agent: "alice", outcome: "done", target: null, remove: ["agent:alice"], retained: [], claimedAt: "2026-11-12T00:00:00Z" })} -->`,
  );
const request = (agent = "bob") => ({ number: N, agent });

const refused = (plan: CompletePlan | CompleteResult, error: string) => {
  expect(plan.ok ? "accepted" : plan.error).toBe(error);
  if (plan.ok) throw new Error("expected refusal");
  // Every recovery is a runnable command: it names the repository and has no shell comment.
  expect(plan.recovery.length).toBeGreaterThan(0);
  for (const line of plan.recovery) {
    expect(line).toContain("--repo ");
    expect(line).not.toMatch(/(^|\s)#/);
  }
  return plan;
};
const posted = (state: State) =>
  state.writes
    .filter((w) => w[1] === "comment")
    .map((w) => parseDeliveryComment(w[w.indexOf("--body") + 1]))
    .map((p) => (p.kind === "record" ? p.record : null));
const kinds = (state: State) => state.writes.map((w) => `${w[0]} ${w[1]}`);
const complete = (rt: DeliverablesRuntime, agent = "bob") =>
  applyComplete(repo, request(agent), rt);

// ---------------------------------------------------------------------------------------------

describe("completion rule records", () => {
  it("render exactly the contract's completion predicates (EDN-style cross-check)", () => {
    const doc = readFileSync(
      new URL("../doc/design/delivery-lifecycle.md", import.meta.url),
      "utf8",
    );
    const block = /```text\n(% Negative member states[\s\S]*?)```/.exec(doc)?.[1] ?? "";
    const normal = (t: string) =>
      t
        .split("\n")
        .filter((l) => !l.trim().startsWith("%"))
        .join(" ")
        .replace(/\s+/g, " ")
        .replace(/\s*:-\s*/g, " :- ")
        .trim();
    expect(block).not.toBe("");
    expect(normal(renderDatalog(completionPredicates))).toBe(normal(block));
  });
  it("are stratified: a clause never uses a predicate a later clause still defines", () => {
    expect(() => deriveDatalog(completionPredicates, new Map())).not.toThrow();
    expect(() => deriveDatalog([...completionPredicates].reverse(), new Map())).toThrow();
  });
});

/** Pure-evaluator fixture: facts with members in the given states. */
const facts = (
  members: [MemberEvidence["state"], string?][],
  fields: Partial<DeliveryFacts> = {},
): DeliveryFacts => ({
  repository: repo,
  issue: N,
  issueOpen: true,
  recordsUnknown: false,
  unknownBecause: [],
  membership: "complete",
  attestRecord: false,
  hasTrustedRecord: true,
  legacyHandoff: false,
  coverage: { complete: true, requests: 0, omissions: [] },
  members: members.map(([state, why], i) => ({
    key: `pr:${repo}#${i + 1}`,
    label: `${repo}#${i + 1}`,
    deliverable: member(i + 1),
    target: `${repo}:(default branch)`,
    state,
    branch: "main",
    mergeCommit: null,
    compare: null,
    baseRefName: "main",
    why: why ?? state,
  })),
  ...fields,
});

describe("evaluateDelivery (pure)", () => {
  it("verdict precedence: unknown outranks a merged member and an outstanding one", () => {
    const e = evaluateDelivery(facts([["merged"], ["open"], ["unknown", "unreadable"]]));
    expect(e.delivery).toBe("unknown");
    expect(e.actions.map((a) => a.id)).toEqual(["L4", "L5a"]);
  });
  it("delivered needs a member, complete membership and every member merged", () => {
    expect(evaluateDelivery(facts([["merged"], ["merged"]])).delivery).toBe("delivered");
    expect(evaluateDelivery(facts([])).delivery).toBe("none");
    expect(evaluateDelivery(facts([["merged"]], { membership: null })).delivery).toBe("submitted");
  });
  it("partial needs a merged and a positively outstanding member; submitted otherwise", () => {
    const p = evaluateDelivery(facts([["merged"], ["closed-unmerged"]]));
    expect(p.delivery).toBe("partial");
    expect(p.actions.map((a) => a.id)).toEqual(["L5"]);
    expect(evaluateDelivery(facts([["draft"], ["open"]])).delivery).toBe("submitted");
  });
  it("legacy only without any trusted delivery record", () => {
    expect(
      evaluateDelivery(
        facts([], { hasTrustedRecord: false, legacyHandoff: true, membership: null }),
      ).delivery,
    ).toBe("legacy");
  });
  it("incomplete coverage is unknown, never delivered", () => {
    const e = evaluateDelivery(
      facts([["merged"]], { coverage: { complete: false, requests: 0, omissions: ["cap"] } }),
    );
    expect(e.delivery).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------------------------

describe("complete: verified delivery closes", () => {
  it("S46: a normal merge is delivered via the live compare (not base equality) and closes", async () => {
    const { rt, state } = github({
      comments: [submitted(member(5))],
      labels: ["status:awaiting-review"],
      prs: [merged(5)],
      compare: { [`${repo}:main...m5`]: "behind" },
    });
    const result = await complete(rt);
    expect(result.exitCode).toBe(0);
    expect(kinds(state)).toEqual(["issue comment", "issue close", "issue edit"]);
    expect(state.writes[1]).toEqual([
      "issue",
      "close",
      String(N),
      "--repo",
      repo,
      "--reason",
      "completed",
    ]);
    expect(state.labels).toEqual([]);
    const record = posted(state)[0]!;
    expect(record.op).toBe("complete");
    expect(record.verdict).toBe("delivered");
    expect(record.evaluatedAt).toBe("2026-11-14T12:00:00.000Z");
    expect(record.snapshot).toEqual([
      expect.objectContaining({
        deliverable: `${repo}#5`,
        state: "merged",
        mergeCommit: "m5",
        branch: "main",
        compare: "behind",
      }),
    ]);
    // The same base without a contained merge commit is never delivered.
    const { rt: noCompare } = github({ comments: [submitted(member(5))], prs: [merged(5)] });
    refused(await planComplete(repo, request(), noCompare), "EVIDENCE_INCOMPLETE");
  });
  it("S6/S43: a commit member is delivered when the commit is contained in the target", async () => {
    const oid = "abc1234".padEnd(40, "0");
    const { rt, state } = github({
      comments: [
        v1Done(),
        post(
          rec("legacy-attach", {
            deliverables: [commitMember(oid)],
            membership: "complete",
            login: "writer",
            legacyRelease: "1",
          }),
        ),
      ],
      compare: { [oid]: "identical" },
    });
    const result = await complete(rt);
    expect(result.exitCode).toBe(0);
    expect(kinds(state)).toEqual(["issue comment", "issue close"]);
  });
  it("S1: after attach --legacy of a merged PR, complete closes the issue completed", async () => {
    const { rt, state } = github({
      comments: [
        v1Done(),
        post(
          rec("legacy-attach", {
            deliverables: [member(5)],
            membership: "complete",
            login: "writer",
            legacyRelease: "1",
          }),
        ),
      ],
      labels: ["status:awaiting-review"],
      prs: [merged(5)],
      compare: { m5: "identical" },
    });
    expect((await complete(rt)).exitCode).toBe(0);
    expect(state.issueState).toBe("CLOSED");
    expect(state.stateReason).toBe("COMPLETED");
    // Before the attach, the legacy ticket is refused, never inferred delivered.
    const { rt: legacy } = github({
      comments: [v1Done()],
      prs: [merged(5)],
      compare: { m5: "identical" },
    });
    const plan = refused(await planComplete(repo, request(), legacy), "NOT_DELIVERED");
    expect(plan.facts.delivery).toBe("legacy");
    expect(plan.recovery.some((r) => r.includes("attach --legacy"))).toBe(true);
  });
  it("S20/S39: an attested non-code ticket (empty complete set) closes as attested", async () => {
    for (const records of [
      [submitted(), post(rec("attest"))],
      [
        v1Done(),
        post(rec("legacy-attest", { membership: "complete", login: "writer", legacyRelease: "1" })),
      ],
    ]) {
      const { rt, state } = github({ comments: records });
      const result = await complete(rt);
      expect(result.exitCode).toBe(0);
      expect(posted(state)[0]!.verdict).toBe("attested");
      expect(state.issueState).toBe("CLOSED");
    }
  });
  it("S35: every member merged plus an attestation reports delivered, attestation retained", async () => {
    const { rt } = github({
      comments: [submitted(member(5)), post(rec("attest"))],
      prs: [merged(5)],
      compare: { m5: "behind" },
    });
    const plan = await planComplete(repo, request(), rt);
    expect(plan.ok && plan.evaluation?.delivery).toBe("delivered");
    expect(plan.ok && plan.evaluation?.overrides.join(" ")).toContain("supporting evidence");
  });
  it("S36: an off-target merge merged onward into the target is delivered with no record change", async () => {
    const { rt } = github({
      comments: [submitted(member(5))],
      prs: [merged(5, "m5", repo, "feature")],
      compare: { m5: "behind" },
    });
    const plan = await planComplete(repo, request(), rt);
    expect(plan.ok && plan.evaluation?.delivery).toBe("delivered");
  });
  it("S51: all members merged, membership closed by a later record: delivered", async () => {
    const { rt } = github({
      comments: [
        post(rec("attach", { deliverables: [member(5)], membership: "open" })),
        post(rec("membership", { membership: "complete" })),
      ],
      prs: [merged(5)],
      compare: { m5: "behind" },
    });
    expect((await complete(rt)).exitCode).toBe(0);
  });
});

describe("complete: refusals on positive negative evidence", () => {
  it("S3: one of two cross-repository members open is partial, even if the issue was closed", async () => {
    for (const closed of [false, true]) {
      const { rt, state } = github({
        comments: [submitted(member(5), member(7, other))],
        prs: [merged(5), pr(7, {}, other)],
        compare: { m5: "behind" },
        ...(closed
          ? { issueState: "CLOSED" as const, stateReason: "COMPLETED", closedBy: "writer" }
          : {}),
      });
      const plan = refused(await complete(rt), "NOT_DELIVERED");
      expect(plan.facts.delivery).toBe("partial");
      expect(plan.prerequisite).toContain(`${other}#7`);
      expect(state.writes).toEqual([]);
    }
  });
  it("S4: a PR merged into a feature branch is merged-off-target with retarget recovery", async () => {
    const { rt } = github({
      comments: [submitted(member(5))],
      prs: [merged(5, "m5", repo, "feature")],
      compare: { m5: "ahead" },
    });
    const plan = refused(await planComplete(repo, request(), rt), "NOT_DELIVERED");
    expect(plan.facts.members?.[0]?.state).toBe("merged-off-target");
    expect(plan.recovery.some((r) => r.includes("retarget"))).toBe(true);
  });
  it("S37: one member merged, one merged off target: partial, off-target member named", async () => {
    const { rt } = github({
      comments: [submitted(member(5), member(6))],
      prs: [merged(5), merged(6, "m6", repo, "feature")],
      compare: { m5: "behind", m6: "diverged" },
    });
    const plan = refused(await planComplete(repo, request(), rt), "NOT_DELIVERED");
    expect(plan.facts.delivery).toBe("partial");
    expect(plan.prerequisite).toContain(`${repo}#6 is not delivered`);
  });
  it("S45: a force-pushed target no longer containing the merge commit is not delivered", async () => {
    const { rt } = github({
      comments: [submitted(member(5))],
      prs: [merged(5)],
      compare: { m5: "diverged" },
    });
    const plan = refused(await planComplete(repo, request(), rt), "NOT_DELIVERED");
    expect(plan.facts.members?.[0]?.state).toBe("merged-off-target");
  });
  it("S15: membership open with every listed member merged is not delivered, naming it", async () => {
    const { rt } = github({
      comments: [post(rec("attach", { deliverables: [member(5)], membership: "open" }))],
      prs: [merged(5)],
      compare: { m5: "behind" },
    });
    const plan = refused(await planComplete(repo, request(), rt), "NOT_DELIVERED");
    expect(plan.facts.delivery).toBe("submitted");
    expect(plan.prerequisite).toContain("membership is open");
    expect(plan.recovery.some((r) => r.includes("membership complete"))).toBe(true);
  });
  it("S34: an attestation stops applying once an open member is attached", async () => {
    const { rt } = github({
      comments: [
        submitted(),
        post(rec("attest")),
        post(rec("attach", { deliverables: [member(5)] })),
      ],
      prs: [pr(5)],
    });
    const plan = refused(await planComplete(repo, request(), rt), "NOT_DELIVERED");
    expect(plan.facts.delivery).toBe("submitted");
    expect(plan.prerequisite).toContain("does not apply");
  });
  it("a draft and a closed-unmerged member are reported in their positive states", async () => {
    const { rt } = github({
      comments: [submitted(member(5), member(6))],
      prs: [pr(5, { isDraft: true }), pr(6, { state: "CLOSED" })],
    });
    const plan = refused(await planComplete(repo, request(), rt), "NOT_DELIVERED");
    expect(plan.facts.members?.map((m) => m.state)).toEqual(["draft", "closed-unmerged"]);
  });
});

describe("complete: unknown evidence never closes", () => {
  it("S8: an unreadable required PR makes the ticket unknown and refuses", async () => {
    const { rt, state } = github({ comments: [submitted(member(5))] });
    const plan = refused(await complete(rt), "EVIDENCE_INCOMPLETE");
    expect(plan.facts.delivery).toBe("unknown");
    expect(state.writes).toEqual([]);
  });
  it("S32: one merged, one unreadable is unknown, not partial; recovery re-reads, never merges", async () => {
    const { rt } = github({
      comments: [submitted(member(5), member(6))],
      prs: [merged(5)],
      compare: { m5: "behind" },
    });
    const plan = refused(await planComplete(repo, request(), rt), "EVIDENCE_INCOMPLETE");
    expect(plan.facts.delivery).toBe("unknown");
    expect(plan.evaluation?.actions.map((a) => a.id)).toEqual(["L4", "L5a"]);
    expect(plan.recovery.join(" ")).not.toContain("merge");
    expect(plan.recovery).toContain(`github-triage pr 6 --repo ${repo}`);
  });
  it("S38: an off-target merge whose compare errors is unknown, never merged-off-target", async () => {
    const { rt } = github({
      comments: [submitted(member(5))],
      prs: [merged(5, "m5", repo, "feature")],
    });
    const plan = refused(await planComplete(repo, request(), rt), "EVIDENCE_INCOMPLETE");
    expect(plan.facts.members?.[0]?.state).toBe("unknown");
  });
  it("S44: a deleted target branch (or unreadable default branch) is unknown", async () => {
    const { rt } = github({
      comments: [submitted(member(5, repo, "release"))],
      prs: [merged(5, "m5", repo, "release")],
    });
    refused(await planComplete(repo, request(), rt), "EVIDENCE_INCOMPLETE");
    const { rt: noDefault } = github({
      comments: [submitted(member(5))],
      prs: [merged(5)],
      compare: { m5: "behind" },
      defaults: { [repo]: null },
    });
    const plan = refused(await planComplete(repo, request(), noDefault), "EVIDENCE_INCOMPLETE");
    expect(plan.prerequisite).toContain("default branch");
  });
  it("S22: truncated comment history refuses; nothing is delivered or not delivered", async () => {
    const filler = Array.from({ length: 1001 }, () => comment("chatter"));
    const { rt } = github({
      comments: [submitted(member(5)), ...filler],
      prs: [merged(5)],
      compare: { m5: "behind" },
      pageSize: 100,
    });
    refused(await planComplete(repo, request(), rt), "EVIDENCE_INCOMPLETE");
  });
  it("S23: a trusted malformed record refuses RECORD_MALFORMED and offers void", async () => {
    const { rt } = github({
      comments: [submitted(member(5)), comment("<!-- github-triage:delivery v1 {oops} -->")],
      prs: [merged(5)],
      compare: { m5: "behind" },
    });
    const plan = refused(await planComplete(repo, request(), rt), "RECORD_MALFORMED");
    expect(plan.recovery.some((r) => r.includes("void"))).toBe(true);
  });
  it("S24: a trusted future-version record refuses RECORD_UNSUPPORTED", async () => {
    const { rt } = github({
      comments: [submitted(member(5)), comment("<!-- github-triage:delivery v2 {} -->")],
      prs: [merged(5)],
      compare: { m5: "behind" },
    });
    refused(await planComplete(repo, request(), rt), "RECORD_UNSUPPORTED");
  });
  it("S25: a record whose author permission is unknown refuses MARKER_UNVERIFIED", async () => {
    const { rt } = github({
      comments: [submitted(member(5)), post(rec("attest"), "flaky")],
      prs: [merged(5)],
      compare: { m5: "behind" },
    });
    refused(await planComplete(repo, request(), rt), "MARKER_UNVERIFIED");
  });
  it("MARKER_UNVERIFIED: an author without write permission cannot record completion", async () => {
    const { rt, state } = github({ viewer: "reader", comments: [submitted()] });
    refused(await complete(rt), "MARKER_UNVERIFIED");
    expect(state.writes).toEqual([]);
  });
  it("member cap: more required members than the cap are unknown, unread", async () => {
    const many = Array.from({ length: deliveryMemberCap + 1 }, (_, i) => member(i + 1));
    const { rt, state } = github({ comments: [submitted(...many)] });
    const plan = refused(await planComplete(repo, request(), rt), "EVIDENCE_INCOMPLETE");
    expect(plan.prerequisite).toContain("exceed the cap");
    expect(state.rests).toBeLessThanOrEqual(1);
  });
});

describe("complete: claims", () => {
  it("S57: a rework claim by A refuses B's complete with CLAIM_HELD naming A; nothing written", async () => {
    const { rt, state } = github({
      comments: [submitted(member(5))],
      labels: ["agent:alice"],
      prs: [merged(5)],
      compare: { m5: "behind" },
    });
    const plan = refused(await complete(rt), "CLAIM_HELD");
    expect(plan.prerequisite).toContain("agent:alice");
    expect(plan.recovery.some((r) => r.includes("release 42 --agent alice"))).toBe(true);
    expect(state.writes).toEqual([]);
    expect(state.issueState).toBe("OPEN");
    // The caller's own claim blocks too.
    const { rt: own } = github({
      comments: [submitted(member(5))],
      labels: ["agent:bob"],
      prs: [merged(5)],
      compare: { m5: "behind" },
    });
    refused(await planComplete(repo, request("bob"), own), "CLAIM_HELD");
  });
  it("S58: after the rework claim's membership open record the verdict is submitted, complete refused", async () => {
    const comments = [
      submitted(member(5)),
      post(rec("membership", { membership: "open", reason: "rework claim" })),
    ];
    const { rt } = github({ comments, prs: [merged(5)], compare: { m5: "behind" } });
    const plan = refused(await planComplete(repo, request(), rt), "NOT_DELIVERED");
    expect(plan.facts.delivery).toBe("submitted");
    expect(plan.prerequisite).toContain("membership is open");
  });
  it("S59: after a resubmit closes membership and the replacement PR merges, any agent completes", async () => {
    const { rt, state } = github({
      comments: [
        submitted(member(5)),
        post(rec("membership", { membership: "open", reason: "rework claim" })),
        post(rec("submit", { deliverables: [member(8)], membership: "complete" })),
      ],
      prs: [merged(5), merged(8)],
      compare: { m5: "behind", m8: "behind" },
    });
    expect((await complete(rt, "carol")).exitCode).toBe(0);
    expect(state.issueState).toBe("CLOSED");
  });
  it("S61: after a maintainer's visible release and membership complete, complete closes", async () => {
    const { rt, state } = github({
      comments: [
        submitted(member(5)),
        post(rec("membership", { membership: "open", reason: "rework claim" })),
        post(
          rec("membership", { agent: "maint", membership: "complete", login: "admin" }),
          "admin",
        ),
      ],
      prs: [merged(5)],
      compare: { m5: "behind" },
    });
    expect((await complete(rt)).exitCode).toBe(0);
    expect(state.issueState).toBe("CLOSED");
  });
});

describe("complete: write order, races and retries", () => {
  const ready = () => ({
    comments: [submitted(member(5))],
    labels: ["status:awaiting-review"],
    prs: [merged(5)],
    compare: { m5: "behind" },
  });
  it("S60: a claim taken after the precheck stops before the close; the record is inert", async () => {
    const { rt, state } = github({
      ...ready(),
      onRun: (args, s) => {
        if (args[1] === "comment" && posted({ ...s, writes: [args] })[0]?.op === "complete") {
          s.labels.push("agent:alice");
          s.comments.push(post(rec("membership", { membership: "open", reason: "rework claim" })));
          // The claimant's record is created after the completion's evaluatedAt.
          s.comments.at(-1)!.createdAt = "2026-11-14T14:00:00.000Z";
        }
      },
    });
    const result = refused(await complete(rt), "CLAIM_HELD");
    expect((result as CompleteResult).exitCode).toBe(2);
    expect(result.prerequisite).toContain("Completion record written");
    expect((result as CompleteResult).closeSkipped).toBe(
      "completion record written, close skipped",
    );
    expect(kinds(state)).toEqual(["issue comment"]);
    expect(state.issueState).toBe("OPEN");
    // The written record is inert and alice stays responsible.
    const { records, fold } = await readDeliveryFold(
      state.comments,
      true,
      { repository: repo, issue: N },
      rt.trust,
    );
    const effects = completionEffects(records, fold, false);
    expect(effects.map((e) => e.effective)).toEqual([false]);
    expect(effectiveResponsibility(fold, effects).ticketResponsible).toBe("alice");
  });
  it("S68: a concurrent attach of an open PR (membership still complete) refuses DELIVERY_DIVERGED", async () => {
    const { rt, state } = github({
      ...ready(),
      prs: [merged(5), pr(9)],
      onRun: (args, s) => {
        if (args[1] !== "comment") return;
        s.comments.push(post(rec("attach", { deliverables: [member(9)] })));
        s.comments.at(-1)!.createdAt = "2026-11-14T14:00:00.000Z";
      },
    });
    const result = refused(await complete(rt), "DELIVERY_DIVERGED");
    expect((result as CompleteResult).exitCode).toBe(2);
    expect(result.prerequisite).toContain("attach by alice");
    expect(state.issueState).toBe("OPEN");
    expect(kinds(state)).toEqual(["issue comment"]);
  });
  it("a record intervening between the precheck and the write also diverges, never closes", async () => {
    const { rt, state } = github(ready());
    const plan = await planComplete(repo, request(), rt);
    // Another writer detaches the member after the precheck, before the record is posted.
    state.comments.push(post(rec("detach", { deliverables: [member(5)] })));
    const result = refused(await applyComplete(repo, request(), rt, plan), "DELIVERY_DIVERGED");
    expect((result as CompleteResult).exitCode).toBe(2);
    expect(state.issueState).toBe("OPEN");
  });
  it("a member reverted between the record and the close is caught by the step-3 re-evaluation", async () => {
    const { rt, state } = github({
      ...ready(),
      onRun: (args, s) => {
        if (args[1] === "comment") s.compare.m5 = "diverged";
      },
    });
    const result = refused(await complete(rt), "NOT_DELIVERED");
    expect((result as CompleteResult).exitCode).toBe(2);
    expect(state.issueState).toBe("OPEN");
  });
  it("S17: someone else closes the issue mid-command: record kept, close skipped and reported", async () => {
    const { rt, state } = github({
      ...ready(),
      onRun: (args, s) => {
        if (args[1] === "comment") {
          s.issueState = "CLOSED";
          s.stateReason = "NOT_PLANNED";
          s.closedBy = "someone";
        }
      },
    });
    const result = await complete(rt);
    expect(result.exitCode).toBe(0);
    expect(result.ok && result.closeSkipped).toContain("someone");
    expect(kinds(state)).toEqual(["issue comment"]);
    expect(state.writes.some((w) => w.includes("reopen"))).toBe(false);
    expect(state.stateReason).toBe("NOT_PLANNED");
  });
  it("delivered and already closed: record only, never reopened or re-closed; a retry is a no-op", async () => {
    const { rt, state } = github({
      ...ready(),
      issueState: "CLOSED",
      stateReason: "COMPLETED",
      closedBy: "writer",
    });
    expect((await complete(rt)).exitCode).toBe(0);
    expect(kinds(state)).toEqual(["issue comment"]);
    expect(posted(state)[0]!.plan).toEqual({ remove: [], add: [] });
    const again = await complete(rt);
    expect(again.ok && again.noop).toBe(true);
    expect(kinds(state)).toEqual(["issue comment"]);
  });
  it("a failed close is retried without a second record (opId retry detection)", async () => {
    let fail = true;
    const { rt, state } = github({ ...ready(), failRun: (a) => a[1] === "close" && fail });
    const first = await complete(rt);
    expect(first.exitCode).toBe(2);
    expect(state.issueState).toBe("OPEN");
    fail = false;
    const second = await complete(rt);
    expect(second.exitCode).toBe(0);
    expect(posted(state).filter((r) => r?.op === "complete")).toHaveLength(1);
    expect(state.issueState).toBe("CLOSED");
  });
  it("S56: an effective completion ends ticket and deliverable responsibility", async () => {
    const { rt, state } = github(ready());
    await complete(rt);
    const { records, fold } = await readDeliveryFold(
      state.comments,
      true,
      { repository: repo, issue: N },
      rt.trust,
    );
    const effects = completionEffects(records, fold, true);
    expect(effects.map((e) => e.effective)).toEqual([true]);
    expect(effectiveResponsibility(fold, effects)).toEqual({
      ticketResponsible: null,
      members: [{ deliverable: `${repo}#5`, responsible: null }],
    });
    // A later changed delivery makes the same record inert.
    const changed = await readDeliveryFold(
      [...state.comments, post(rec("attach", { deliverables: [member(9)] }))],
      true,
      { repository: repo, issue: N },
      rt.trust,
    );
    expect(completionEffects(changed.records, changed.fold, true)[0]!.effective).toBe(false);
    expect(evaluationRevision(changed.fold)).not.toBe(evaluationRevision(fold));
  });
  it("dry run plans record, close and label without writing", async () => {
    const { rt, state } = github(ready());
    const plan = await planComplete(repo, request(), rt);
    expect(plan.ok && plan.changes.map((c) => c.step)).toEqual(["record", "close", "labels"]);
    expect(completeText(plan, true)).toContain("DRY RUN");
    expect(state.writes).toEqual([]);
  });
});

describe("complete: request bounds", () => {
  it("member evidence costs one PR read per PR member, one compare per merged member and one default-branch read per target repository", async () => {
    const { rt, state } = github({
      comments: [submitted(member(5), member(6), member(7, other))],
      prs: [merged(5), merged(6), merged(7, "m7", other)],
      compare: { m5: "behind", m6: "behind", m7: "behind" },
    });
    const fold = (
      await readDeliveryFold(state.comments, true, { repository: repo, issue: N }, rt.trust)
    ).fold;
    const facts = await collectDeliveryFacts(
      { repository: repo, issue: N, issueOpen: true, fold, legacyHandoff: false },
      rt,
    );
    expect(facts.coverage.requests).toBe(3 + 3 + 2);
    expect(evaluateDelivery(facts).delivery).toBe("delivered");
  });
});

describe("complete arguments", () => {
  it("parses and rejects invalid input", () => {
    expect(completeArguments(["42", "--agent", "bob", "--repo", repo, "--dry-run"])).toEqual({
      request: { number: 42, agent: "bob" },
      repo,
      json: false,
      dryRun: true,
    });
    expect(() => completeArguments(["42"])).toThrow(/Usage/);
    expect(() => completeArguments(["x", "--agent", "bob"])).toThrow(/Usage/);
    expect(() => completeArguments(["42", "--agent", "bob", "--repo", "bad"])).toThrow(/owner/);
  });
});
