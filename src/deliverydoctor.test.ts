/**
 * Delivery-aware Ticket Doctor (#192, doc/design/delivery-lifecycle.md S1, S66, S67 and
 * "#192 diagnostics and reads"). Injected trust, GraphQL and REST boundaries; no live calls.
 */
import { describe, expect, it } from "vite-plus/test";
import { planRelease } from "./claims.js";
import { main } from "./cli.js";
import { deliveryMarker, markerTrust, readDeliveryFold } from "./delivery.js";
import type { Deliverable, DeliveryComment, DeliveryRecord, TrustDecision } from "./delivery.js";
import {
  closedDriftIssueCap,
  deliveryDoctorTicketCap,
  diagnoseClosedDrift,
  diagnoseDelivery,
} from "./deliverydoctor.js";
import type { RepositoryPermission, RestAnswer } from "./github/github.js";
import { ticketDoctor } from "./ticketdoctor.js";
import type { TicketDoctorReport } from "./ticketdoctor.js";
import type { Issue, Snapshot } from "./github/types.js";

const repo = "owner/name";
const time = "2026-11-14T10:00:00.000Z";
const prLink = (n: number) => `https://github.com/${repo}/pull/${n}`;
const page = <T>(nodes: T[], more = false) => ({
  nodes,
  pageInfo: { hasNextPage: more, endCursor: null },
});

let nextId = 1000;
const comment = (body: string, login = "writer"): DeliveryComment => {
  const id = nextId++;
  return {
    databaseId: id,
    body,
    url: `https://github.com/${repo}/issues/1#issuecomment-${id}`,
    // Monotonic in posting order, so the fold's creation-time order matches the test's order.
    createdAt: new Date(Date.parse("2026-11-13T09:00:00Z") + id * 1000).toISOString(),
    author: { __typename: "User", login },
    lastEditedAt: null,
    includesCreatedEdit: false,
    editor: null,
  };
};
const pr = (n: number): Deliverable => ({
  kind: "pr",
  repository: repo,
  number: n,
  nodeId: `PR_${n}`,
  target: { repository: repo, branch: null },
});
const record = (issue: number, op: DeliveryRecord["op"], fields: Partial<DeliveryRecord> = {}) =>
  ({
    v: 1,
    op,
    opId: `op-${nextId}`,
    repository: repo,
    issue,
    agent: "alice",
    deliverables: [],
    issuedAt: time,
    ...(["submit", "attach", "complete"].includes(op) ? {} : { reason: "because" }),
    ...fields,
  }) as DeliveryRecord;
const post = (r: DeliveryRecord, login = "writer") => comment(deliveryMarker(r), login);
/** A real v1 release comment body, exactly as `planRelease` writes it (no hand-written format). */
const release = async (
  agent: string,
  deliverable: { pr: string } | { change: string },
): Promise<DeliveryComment> => {
  const p = (nodes: unknown[]) => ({
    nodes,
    pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null },
  });
  const query = async (text: string) =>
    text.includes("resource(url")
      ? { resource: { __typename: "PullRequest", state: "MERGED" } }
      : {
          repository: {
            issueOrPullRequest: {
              __typename: "Issue",
              number: 6,
              title: "T",
              url: `https://github.com/${repo}/issues/6`,
              state: "OPEN",
              updatedAt: time,
              labels: p([{ name: `agent:${agent}` }, { name: "bug" }]),
              issueDependenciesSummary: { blockedBy: 0 },
              blockedBy: p([]),
              closedByPullRequestsReferences: p([]),
              comments: p([]),
              timelineItems: p([
                {
                  __typename: "LabeledEvent",
                  createdAt: "2026-11-12T00:00:00Z",
                  label: { name: `agent:${agent}` },
                },
              ]),
            },
            claims: p([{ number: 6, title: "T", url: `https://github.com/${repo}/issues/6` }]),
            ownerLabel: { name: `agent:${agent}` },
            questionLabel: null,
            decisionLabel: null,
            needsDesignLabel: null,
            attentionLabel: null,
            targetLabel: null,
          },
        };
  const plan = await planRelease(
    repo,
    { number: 6, agent, outcome: "done", ...deliverable },
    query as never,
    async () => "write",
  );
  if (!plan.ok) throw new Error("planRelease refused");
  const argv = plan.changes[0].command;
  return comment(argv[argv.indexOf("--body") + 1]);
};

const issue = (
  number: number,
  labels: string[],
  comments: DeliveryComment[] = [],
  closedBy: string[] = [],
): Issue =>
  ({
    number,
    title: `Ticket ${number}`,
    body: "",
    url: `https://github.com/${repo}/issues/${number}`,
    state: "OPEN",
    stateReason: null,
    createdAt: time,
    updatedAt: time,
    issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
    blockedBy: page([]),
    blocking: page([]),
    labels: page(labels.map((name) => ({ name }))),
    comments: page(comments),
    closedByPullRequestsReferences: page(
      closedBy.map((url) => ({ number: Number(url.split("/").pop()), url, state: "MERGED" })),
    ),
  }) as Issue;
const snapshot = (issues: Issue[]): Snapshot =>
  ({
    schemaVersion: 1,
    repository: repo,
    startedAt: time,
    fetchedAt: time,
    issues,
    pullRequests: [],
    dependencies: [],
    changed: [],
    since: null,
    warnings: [],
    rateLimit: null,
  }) as Snapshot;

const permissions: Record<string, RepositoryPermission> = {
  writer: "write",
  reader: "read",
  flaky: "unknown",
};
const trust: TrustDecision = markerTrust(async (login) => permissions[login] ?? "none");

/** Live PRs by number: open, draft, merged (merge oid), closed; absent means unreadable. */
type LivePr = "open" | "draft" | "closed" | { merged: string };
function live(prs: Record<number, LivePr>, compare: Record<string, string> = {}) {
  const calls = { query: 0, rest: 0 };
  return {
    calls,
    rt: {
      query: async (q: string, v: Record<string, unknown>) => {
        calls.query++;
        if (!q.includes("resource(")) return { repository: { defaultBranchRef: { name: "main" } } };
        const n = Number(String(v.url).split("/").pop());
        const s = prs[n];
        if (!s) throw new Error("not found");
        return {
          resource: {
            __typename: "PullRequest",
            id: `PR_${n}`,
            number: n,
            url: prLink(n),
            state: typeof s === "object" ? "MERGED" : s === "closed" ? "CLOSED" : "OPEN",
            isDraft: s === "draft",
            merged: typeof s === "object",
            mergeCommit: typeof s === "object" ? { oid: s.merged } : null,
            headRefOid: `head${n}`,
            baseRefName: "main",
            baseRepository: { nameWithOwner: repo, defaultBranchRef: { name: "main" } },
          },
        };
      },
      rest: async (path: string): Promise<RestAnswer> => {
        calls.rest++;
        const oid = path.split("...").pop() ?? "";
        const status = compare[oid];
        return status ? { status: 200, body: { status } } : { status: 404, body: null };
      },
    },
  };
}

const doctor = async (
  issues: Issue[],
  prs: Record<number, LivePr> = {},
  compare: Record<string, string> = {},
  withTrust = true,
): Promise<TicketDoctorReport> => {
  const snap = snapshot(issues);
  const delivery = await diagnoseDelivery(snap, {
    trust: withTrust ? trust : undefined,
    live: withTrust ? live(prs, compare).rt : undefined,
  });
  return ticketDoctor(snap, { now: new Date(time), delivery });
};
const findings = (r: TicketDoctorReport, n: number) =>
  r.tickets.find((t) => t.number === n)?.findings ?? [];
const kinds = (r: TicketDoctorReport, n: number) =>
  findings(r, n)
    .map((f) => f.kind)
    .filter((k) => k !== "readiness-missing");
const finding = (r: TicketDoctorReport, n: number, kind: string) => {
  const f = findings(r, n).find((x) => x.kind === kind);
  if (!f) throw new Error(`no ${kind} finding on #${n}: ${kinds(r, n).join(", ")}`);
  return f;
};

describe("delivery-aware Ticket Doctor (#192)", () => {
  it("leaves a ticket without delivery or release records exactly as before", async () => {
    const issues = [issue(1, ["bug", "status:awaiting-review"])];
    const plain = ticketDoctor(snapshot(issues), { now: new Date(time) });
    expect(await doctor(issues)).toEqual(plain);
  });

  it("S66 reports a stale handoff with both records, the effective holder and a fresh-handoff recovery", async () => {
    const submit = post(record(2, "submit", { deliverables: [pr(5)], membership: "complete" }));
    const pred = String(submit.databaseId);
    const toBob = post(
      record(2, "handoff", { to: "bob", scope: "ticket", expectedResponsibilityRecord: pred }),
    );
    const toCarol = post(
      record(2, "handoff", { to: "carol", scope: "ticket", expectedResponsibilityRecord: pred }),
    );
    const r = await doctor([issue(2, ["bug"], [submit, toBob, toCarol])], { 5: "open" });
    const f = finding(r, 2, "handoff-stale");
    expect(f.certainty).toBe("candidate");
    expect(f.detail).toContain("alice -> carol (ticket)");
    expect(f.detail).toContain("bob is responsible now");
    expect(f.plan.facts.join("\n")).toContain(toCarol.url!);
    expect(f.plan.facts.join("\n")).toContain(toBob.url!);
    expect(f.plan.facts.join("\n")).toContain(`expected predecessor ${pred}`);
    const fresh = f.plan.steps.find((s) => s.choice?.startsWith("fresh-handoff"));
    expect(fresh?.argv).toEqual(
      expect.arrayContaining(["deliverables", "2", "handoff", "--agent", "bob", "--to", "<AGENT>"]),
    );
    expect(fresh?.runBy).toContain("bob");
    // Waiting on an open PR is not itself a finding.
    expect(kinds(r, 2)).toEqual(["handoff-stale"]);
  });

  it("S66 addresses recovery to the agent responsible after the whole fold, not the holder at rejection", async () => {
    const submit = post(record(20, "submit", { deliverables: [pr(5)], membership: "complete" }));
    const pred = String(submit.databaseId);
    const toBob = post(
      record(20, "handoff", { to: "bob", scope: "ticket", expectedResponsibilityRecord: pred }),
    );
    const toCarol = post(
      record(20, "handoff", { to: "carol", scope: "ticket", expectedResponsibilityRecord: pred }),
    );
    const toDan = post(
      record(20, "handoff", {
        agent: "bob",
        to: "dan",
        scope: "ticket",
        expectedResponsibilityRecord: String(toBob.databaseId),
      }),
    );
    const r = await doctor([issue(20, ["bug"], [submit, toBob, toCarol, toDan])], { 5: "open" });
    const f = finding(r, 20, "handoff-stale");
    expect(f.detail).toContain("dan is responsible now");
    const fresh = f.plan.steps.find((s) => s.choice?.startsWith("fresh-handoff"));
    expect(fresh?.argv).toEqual(expect.arrayContaining(["--agent", "dan"]));
    expect(fresh?.runBy).toContain("dan");
    expect(f.plan.steps.some((s) => s.argv.includes("bob") && s.kind === "command")).toBe(false);
  });

  it("S66 offers inspection only when a later record leaves the final fold unknown", async () => {
    const submit = post(record(21, "submit", { deliverables: [pr(5)], membership: "complete" }));
    const pred = String(submit.databaseId);
    const toBob = post(
      record(21, "handoff", { to: "bob", scope: "ticket", expectedResponsibilityRecord: pred }),
    );
    const toCarol = post(
      record(21, "handoff", { to: "carol", scope: "ticket", expectedResponsibilityRecord: pred }),
    );
    const unclear = post(record(21, "attach", { agent: "bob", deliverables: [pr(6)] }), "flaky");
    const r = await doctor([issue(21, ["bug"], [submit, toBob, toCarol, unclear])], { 5: "open" });
    const f = finding(r, 21, "handoff-stale");
    expect(f.certainty).toBe("unknown");
    expect(f.detail).toContain("current responsibility is unknown");
    expect(f.plan.steps.every((s) => s.kind === "inspect")).toBe(true);
  });

  it("S66 exposes the rejected transfer on the shared fold", async () => {
    const submit = post(record(3, "submit", { deliverables: [pr(5)] }));
    const pred = String(submit.databaseId);
    const toBob = post(
      record(3, "handoff", { to: "bob", scope: "ticket", expectedResponsibilityRecord: pred }),
    );
    const toCarol = post(
      record(3, "handoff", { to: "carol", scope: "ticket", expectedResponsibilityRecord: pred }),
    );
    const { fold } = await readDeliveryFold(
      [submit, toBob, toCarol],
      true,
      { repository: repo, issue: 3 },
      trust,
    );
    expect(fold.rejected[0].transfer).toEqual({
      sender: "alice",
      recipient: "carol",
      scope: "ticket",
      deliverable: null,
      expected: pred,
      effective: String(toBob.databaseId),
      effectiveHolder: "bob",
    });
  });

  it("S67 reports an unverifiable transfer separately from a stale one, with inspection only", async () => {
    const submit = post(record(4, "submit", { deliverables: [pr(5)] }));
    const unclear = post(record(4, "attach", { deliverables: [pr(6)] }), "flaky");
    const handoff = post(
      record(4, "handoff", {
        to: "bob",
        scope: "ticket",
        expectedResponsibilityRecord: String(submit.databaseId),
      }),
    );
    const r = await doctor([issue(4, ["bug"], [submit, unclear, handoff])]);
    expect(kinds(r, 4)).toEqual(
      expect.arrayContaining(["handoff-unverifiable", "delivery-records-unknown"]),
    );
    expect(kinds(r, 4)).not.toContain("handoff-stale");
    for (const f of findings(r, 4).filter((x) => x.kind !== "readiness-missing")) {
      expect(f.certainty).toBe("unknown");
      expect(f.plan.steps.every((s) => s.kind === "inspect")).toBe(true);
    }
  });

  it("S1 names legacy attach candidates instead of the label-only awaiting-review check", async () => {
    const r = await doctor(
      [issue(6, ["bug", "status:awaiting-review"], [await release("alice", { pr: prLink(9) })])],
      {},
    );
    expect(kinds(r, 6)).not.toContain("awaiting-review-without-pr");
    const f = finding(r, 6, "legacy-delivery");
    expect(f.plan.judgment).toBe(true);
    const attach = f.plan.steps.filter((s) => s.argv.includes("--legacy"));
    expect(attach.map((s) => s.command)).toEqual([
      `pdb deliverables 6 attach --legacy --agent '<AGENT>' --pr ${prLink(9)} --reason '<REASON>' --repo ${repo}`,
      `pdb deliverables 6 attest --legacy --agent '<AGENT>' --reason '<REASON>' --repo ${repo}`,
    ]);
    expect(f.plan.facts.join(" ")).toContain("not membership");
  });

  it("S1 turns a released --change commit URL into a --commit candidate", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const r = await doctor([
      issue(
        23,
        ["bug"],
        [await release("alice", { change: `https://github.com/${repo}/commit/${sha}` })],
      ),
    ]);
    const f = finding(r, 23, "legacy-delivery");
    expect(f.plan.steps.map((s) => s.argv.join(" "))).toContainEqual(
      expect.stringContaining(`attach --legacy --agent <AGENT> --commit ${repo}@${sha}`),
    );
  });

  it("reports an empty open required set after the last PR is detached", async () => {
    const submit = post(record(24, "submit", { deliverables: [pr(31)], membership: "open" }));
    const detach = post(record(24, "detach", { deliverables: [pr(31)] }));
    const r = await doctor([issue(24, ["bug"], [submit, detach])]);
    expect(kinds(r, 24)).toEqual(["delivery-membership-open"]);
    const f = finding(r, 24, "delivery-membership-open");
    expect(f.detail).toContain("No deliverable is required yet");
    expect(f.plan.steps.some((s) => s.choice === "complete")).toBe(false);
  });

  it("an empty complete set with an attestation is completable; without one it is empty", async () => {
    const attested = await doctor([
      issue(
        25,
        ["bug"],
        [
          post(record(25, "submit", { deliverables: [], membership: "complete" })),
          post(record(25, "attest", {})),
        ],
      ),
    ]);
    expect(kinds(attested, 25)).toEqual(["delivery-verified-open"]);
    const empty = await doctor([
      issue(
        26,
        ["bug"],
        [post(record(26, "submit", { deliverables: [], membership: "complete" }))],
      ),
    ]);
    expect(kinds(empty, 26)).toEqual(["delivery-empty"]);
  });

  it("an attestation never stands in for an outstanding member", async () => {
    const r = await doctor(
      [
        issue(
          27,
          ["bug"],
          [
            post(record(27, "submit", { deliverables: [pr(32)], membership: "complete" })),
            post(record(27, "attest", {})),
          ],
        ),
      ],
      { 32: "open" },
    );
    expect(kinds(r, 27)).toEqual([]);
  });

  it("S68 on an open issue: a complete record whose delivery no longer holds is reported, not re-closed", async () => {
    const submit = post(record(28, "submit", { deliverables: [pr(33)], membership: "complete" }));
    const done = post(
      record(28, "complete", { verdict: "delivered", evaluationRevision: "r", evaluatedAt: time }),
    );
    const attach = post(record(28, "attach", { deliverables: [pr(34)] }));
    const r = await doctor(
      [issue(28, ["bug"], [submit, done, attach])],
      { 33: { merged: "m33" }, 34: "open" },
      { m33: "behind" },
    );
    expect(kinds(r, 28)).toEqual(["delivery-diverged-after-complete"]);
    const f = finding(r, 28, "delivery-diverged-after-complete");
    expect(f.plan.steps.every((s) => s.kind === "inspect")).toBe(true);
  });

  it("reports a partial delivery with per-member responsibility and supersedes ready-with-open-pr", async () => {
    const submit = post(
      record(7, "submit", { deliverables: [pr(10), pr(11)], membership: "complete" }),
    );
    const r = await doctor(
      [issue(7, ["bug", "status:ready"], [submit])],
      { 10: { merged: "m10" }, 11: "open" },
      { m10: "behind" },
    );
    const f = finding(r, 7, "delivery-partial");
    expect(f.detail).toContain(`${repo}#11 is open`);
    expect(f.plan.facts).toEqual(
      expect.arrayContaining([
        "Ticket responsible: alice.",
        `${repo}#10: responsible alice.`,
        `${repo}#11: responsible alice.`,
      ]),
    );
    expect(f.plan.steps.map((s) => s.command)).toContain(`pdb pr 11 --repo ${repo}`);
    expect(kinds(r, 7)).not.toContain("ready-with-open-pr");
  });

  it("suggests complete, for the responsible agent only, when delivery is verified and the issue is open", async () => {
    const submit = post(record(8, "submit", { deliverables: [pr(12)], membership: "complete" }));
    const r = await doctor(
      [issue(8, ["bug"], [submit])],
      { 12: { merged: "m12" } },
      { m12: "identical" },
    );
    const f = finding(r, 8, "delivery-verified-open");
    const complete = f.plan.steps.find((s) => s.choice === "complete");
    expect(complete?.command).toBe(`pdb complete 8 --agent alice --repo ${repo}`);
    expect(complete?.runBy).toContain("alice");
  });

  it("reports open membership after every recorded member merged, never as verified or completable", async () => {
    const submit = post(record(22, "submit", { deliverables: [pr(30)], membership: "open" }));
    const r = await doctor(
      [issue(22, ["bug"], [submit])],
      { 30: { merged: "m30" } },
      { m30: "behind" },
    );
    expect(kinds(r, 22)).toEqual(["delivery-membership-open"]);
    const f = finding(r, 22, "delivery-membership-open");
    expect(f.detail).toContain("membership is still open");
    expect(f.plan.steps.some((s) => s.choice === "complete")).toBe(false);
    expect(f.plan.steps.find((s) => s.choice === "membership-complete")?.command).toBe(
      `pdb deliverables 22 membership complete --agent alice --reason '<REASON>' --repo ${repo}`,
    );
  });

  it("never treats unreadable evidence as undelivered: unknown, inspection only", async () => {
    const submit = post(record(9, "submit", { deliverables: [pr(13)], membership: "complete" }));
    const r = await doctor([issue(9, ["bug"], [submit])], {});
    const f = finding(r, 9, "delivery-unknown");
    expect(f.certainty).toBe("unknown");
    expect(f.plan.steps.every((s) => s.kind === "inspect")).toBe(true);
    expect(kinds(r, 9)).not.toContain("delivery-member-stalled");
  });

  it("an inconclusive compare is unknown, never merged off target", async () => {
    const submit = post(record(10, "submit", { deliverables: [pr(14)], membership: "complete" }));
    const r = await doctor([issue(10, ["bug"], [submit])], { 14: { merged: "m14" } }, {});
    expect(kinds(r, 10)).toEqual(["delivery-unknown"]);
  });

  it("names a closed-unmerged required PR as actionable, without changing anything", async () => {
    const submit = post(
      record(11, "submit", { deliverables: [pr(15), pr(16)], membership: "complete" }),
    );
    const r = await doctor([issue(11, ["bug"], [submit])], { 15: "closed", 16: "draft" });
    const f = finding(r, 11, "delivery-member-stalled");
    expect(f.detail).toContain(`${repo}#15 is closed-unmerged`);
    expect(f.plan.judgment).toBe(true);
    expect(f.plan.steps.every((s) => s.kind === "inspect")).toBe(true);
  });

  it("offline, records are unknown rather than absent and the label-only checks still run", async () => {
    const submit = post(record(12, "submit", { deliverables: [pr(17)] }));
    const r = await doctor([issue(12, ["bug", "status:awaiting-review"], [submit])], {}, {}, false);
    expect(finding(r, 12, "delivery-evidence-unknown").certainty).toBe("unknown");
    expect(kinds(r, 12)).toContain("awaiting-review-without-pr");
  });

  it("an untrusted author's record is ignored, not unknown", async () => {
    const r = await doctor([
      issue(13, ["bug"], [post(record(13, "submit", { deliverables: [pr(18)] }), "reader")]),
    ]);
    expect(kinds(r, 13)).toEqual([]);
  });

  it("bounds live evaluation and reports the omission", async () => {
    const issues = Array.from({ length: deliveryDoctorTicketCap + 1 }, (_, i) =>
      issue(100 + i, ["bug"], [post(record(100 + i, "submit", { deliverables: [pr(500 + i)] }))]),
    );
    const prs = Object.fromEntries(issues.map((_, i) => [500 + i, "open" as const]));
    const r = await doctor(issues, prs);
    expect(r.completeness.complete).toBe(false);
    expect(r.completeness.warnings.join(" ")).toContain("1 more with delivery records");
    expect(finding(r, 100 + deliveryDoctorTicketCap, "delivery-not-evaluated").certainty).toBe(
      "unknown",
    );
  });

  it("the CLI folds with the permission boundary and reads live evidence", async () => {
    const submit = post(record(14, "submit", { deliverables: [pr(19)], membership: "complete" }));
    const fake = live({ 19: { merged: "m19" } }, { m19: "behind" });
    let text = "";
    const code = await main(
      ["ticket-doctor", "--repo", repo, "--json"],
      async (t) => {
        text += t;
      },
      {
        collect: async () => snapshot([issue(14, ["bug"], [submit])]),
        currentRepository: async () => repo,
        now: () => new Date(time),
        query: fake.rt.query as never,
        rest: async (path) =>
          path.includes("/collaborators/")
            ? { status: 200, body: { user: { login: "writer" }, role_name: "write" } }
            : fake.rt.rest(path),
        updateCheck: async () => ({ status: "skipped" }) as never,
      },
    );
    expect(code).toBe(0);
    const report = JSON.parse(text) as TicketDoctorReport;
    expect(kinds(report, 14)).toEqual(["delivery-verified-open"]);
  });
});

/** A closed issue as the closed-window query returns it. */
const closedNode = (
  number: number,
  stateReason: string,
  comments: DeliveryComment[],
  { actor = "shared-account", older = false } = {},
) => ({
  number,
  title: `Ticket ${number}`,
  url: `https://github.com/${repo}/issues/${number}`,
  state: "CLOSED",
  stateReason,
  closedAt: time,
  timelineItems: { nodes: [{ actor: { login: actor } }] },
  comments: {
    nodes: comments,
    pageInfo: { hasPreviousPage: older, startCursor: older ? "c" : null },
  },
});

const closedDoctor = async (
  nodes: ReturnType<typeof closedNode>[],
  prs: Record<number, LivePr> = {},
  compare: Record<string, string> = {},
  more = false,
) => {
  const fake = live(prs, compare);
  const query = async (q: string, v: Record<string, unknown>) => {
    if (q.includes("states:CLOSED"))
      return { repository: { issues: { nodes, pageInfo: { hasNextPage: more } } } };
    if (q.includes("comments(last:100,before:"))
      return {
        repository: {
          issue: {
            comments: { nodes: [], pageInfo: { hasPreviousPage: true, startCursor: null } },
          },
        },
      };
    return fake.rt.query(q, v);
  };
  const closedDrift = await diagnoseClosedDrift(repo, time, {
    trust,
    live: { query: query as never, rest: fake.rt.rest },
  });
  return ticketDoctor(snapshot([]), { now: new Date(time), closedDrift });
};

describe("closed-issue delivery drift (#192: S5, S16, S68 after closing)", () => {
  it("S16 reports closed-completed without verified delivery as a discrepancy, naming the login, never reopening", async () => {
    const submit = post(record(40, "submit", { deliverables: [pr(60)], membership: "complete" }));
    const r = await closedDoctor([closedNode(40, "COMPLETED", [submit])], { 60: "open" });
    const f = finding(r, 40, "closed-not-delivered");
    expect(f.detail).toContain("by shared-account");
    expect(f.detail).toContain("not proof of unauthorised closure");
    expect(f.plan.steps.some((s) => s.argv.includes("reopen"))).toBe(false);
    expect(f.plan.steps.map((s) => s.command)).toContain(`pdb pr 60 --repo ${repo}`);
    expect(r.closedScan).toEqual({ since: time, scanned: 1, withRecords: 1, complete: true });
  });

  it("S68 after closing: a complete record whose delivery no longer holds is a residual race, not reopened", async () => {
    const submit = post(record(41, "submit", { deliverables: [pr(61)], membership: "complete" }));
    const done = post(
      record(41, "complete", { verdict: "delivered", evaluationRevision: "r", evaluatedAt: time }),
    );
    const attach = post(record(41, "attach", { deliverables: [pr(62)] }));
    const r = await closedDoctor(
      [closedNode(41, "COMPLETED", [submit, done, attach])],
      { 61: { merged: "m61" }, 62: "open" },
      { m61: "behind" },
    );
    const f = finding(r, 41, "closed-not-delivered");
    expect(f.plan.facts.join(" ")).toContain("residual race");
  });

  it("closed completed with verified delivery is not a finding", async () => {
    const submit = post(record(42, "submit", { deliverables: [pr(63)], membership: "complete" }));
    const r = await closedDoctor(
      [closedNode(42, "COMPLETED", [submit])],
      { 63: { merged: "m63" } },
      { m63: "identical" },
    );
    expect(r.tickets).toEqual([]);
  });

  it("S5 turns open required PRs after a not-planned closure into cleanup for the responsible agent", async () => {
    const submit = post(record(43, "submit", { deliverables: [pr(64)], membership: "complete" }));
    const r = await closedDoctor([closedNode(43, "NOT_PLANNED", [submit])], { 64: "draft" });
    const f = finding(r, 43, "closed-cleanup");
    const close = f.plan.steps.find((s) => s.choice === "close-pr-64");
    expect(close?.command).toBe(`gh pr close 64 --repo ${repo} --comment '<WHY>'`);
    expect(close?.runBy).toContain("alice");
    expect(f.detail).toContain("The closure stands");
  });

  it("not planned with nothing left open is respected silently", async () => {
    const submit = post(record(44, "submit", { deliverables: [pr(65)], membership: "complete" }));
    const r = await closedDoctor([closedNode(44, "NOT_PLANNED", [submit])], { 65: "closed" });
    expect(r.tickets).toEqual([]);
  });

  it("unreadable evidence on a closed ticket is unknown with inspection only", async () => {
    const submit = post(record(45, "submit", { deliverables: [pr(66)], membership: "complete" }));
    const r = await closedDoctor([closedNode(45, "COMPLETED", [submit])], {});
    const f = finding(r, 45, "closed-delivery-unknown");
    expect(f.certainty).toBe("unknown");
    expect(f.plan.steps.every((s) => s.kind === "inspect")).toBe(true);
  });

  it("an unverifiable record on a closed ticket is unknown, never a discrepancy", async () => {
    const submit = post(
      record(46, "submit", { deliverables: [pr(67)], membership: "complete" }),
      "flaky",
    );
    const r = await closedDoctor([closedNode(46, "COMPLETED", [submit])], { 67: "open" });
    expect(kinds(r, 46)).toEqual(["closed-delivery-unknown"]);
  });

  it("a truncated window or comment history is incomplete, never no drift", async () => {
    const r = await closedDoctor([closedNode(47, "COMPLETED", [], { older: true })], {}, {}, true);
    expect(r.completeness.complete).toBe(false);
    expect(r.completeness.warnings.join(" ")).toContain(`more than ${closedDriftIssueCap}`);
    expect(r.completeness.warnings.join(" ")).toContain(
      "whether it carries a delivery record is unknown",
    );
    expect(r.closedScan?.complete).toBe(false);
  });

  it("the CLI refuses --since with --offline", async () => {
    await expect(
      main(["ticket-doctor", "--since", time, "--offline", "--cache", "x.json"], async () => {}, {
        collect: async () => snapshot([]),
        currentRepository: async () => repo,
        updateCheck: async () => ({ status: "skipped" }) as never,
      }),
    ).rejects.toThrow("--offline");
  });
});

describe("stale claims beside delivery responsibility (#192)", () => {
  const later = new Date(Date.parse(time) + 10 * 24 * 3_600_000);
  const stale = async (comments: DeliveryComment[], withTrust = true) => {
    const old = {
      ...issue(50, ["bug", "agent:alice"], comments),
      updatedAt: "2026-11-01T00:00:00Z",
    };
    const snap = snapshot([old]);
    const delivery = await diagnoseDelivery(snap, {
      trust: withTrust ? trust : undefined,
      live: withTrust ? live({ 70: "open" }).rt : undefined,
    });
    return finding(ticketDoctor(snap, { now: later, delivery }), 50, "stale-agent-activity");
  };

  it("states that releasing a stale claim does not end the claimant's delivery responsibility", async () => {
    const f = await stale([
      post(record(50, "submit", { deliverables: [pr(70)], membership: "complete" })),
    ]);
    expect(f.plan.facts.join(" ")).toContain(
      `Delivery responsibility: ticket alice; alice is responsible for ${repo}#70. Releasing the claim does not end responsibility`,
    );
    // Recovery stays the supported claimant-only release; nothing is reassigned.
    expect(f.plan.steps.every((s) => s.kind === "inspect" || s.runBy?.includes("alice"))).toBe(
      true,
    );
  });

  it("reports responsibility as unknown, not absent, when records are unverified", async () => {
    const f = await stale(
      [post(record(50, "submit", { deliverables: [pr(70)], membership: "complete" }))],
      false,
    );
    expect(f.plan.facts.join(" ")).toContain("Delivery responsibility is unknown");
  });
});
