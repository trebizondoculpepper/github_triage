/**
 * Delivery-aware Ticket Doctor (#192, doc/design/delivery-lifecycle.md S1, S66, S67 and
 * "#192 diagnostics and reads"). Injected trust, GraphQL and REST boundaries; no live calls.
 */
import { describe, expect, it } from "vite-plus/test";
import { main } from "./cli.js";
import { deliveryMarker, markerTrust, readDeliveryFold } from "./delivery.js";
import type { Deliverable, DeliveryComment, DeliveryRecord, TrustDecision } from "./delivery.js";
import { deliveryDoctorTicketCap, diagnoseDelivery } from "./deliverydoctor.js";
import type { RepositoryPermission, RestAnswer } from "./github.js";
import { ticketDoctor } from "./ticketdoctor.js";
import type { TicketDoctorReport } from "./ticketdoctor.js";
import type { Issue, Snapshot } from "./types.js";

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
    createdAt: `2026-11-13T09:${String(id % 60).padStart(2, "0")}:00Z`,
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
const release = (agent: string, deliverable: string | null) =>
  comment(
    `Released.\n\n<!-- github-triage:release:abcdef12 ${JSON.stringify({ v: 1, agent, outcome: "done", deliverable })} -->`,
  );

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
      [issue(6, ["bug", "status:awaiting-review"], [release("alice", prLink(9))], [prLink(9)])],
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
