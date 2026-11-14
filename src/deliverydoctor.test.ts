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
import { evaluationRevision } from "./completion.js";
import { ticketDoctor } from "./ticketdoctor.js";
import type { TicketDoctorReport } from "./ticketdoctor.js";
import type { Issue, PullRequest, Snapshot } from "./github/types.js";
import {
  classifyFollowUp,
  deliveryFields,
  deliveryRead,
  prDelivery,
  prDeliveryLines,
  readIssuesDelivery,
  reportFollowUpFacts,
  teamResponsibilities,
  teamResponsibilityLines,
  withDeliveryCompleteness,
} from "./deliveryread.js";
import { readBriefing } from "./service.js";
import type { PrStatusReport } from "./prstatus.js";
import type { TeamAgent } from "./team.js";

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

  it("a completed ticket whose target later lost the commit is a regression after completion, with responsibility ended", async () => {
    const submit = post(record(51, "submit", { deliverables: [pr(71)], membership: "complete" }));
    const { fold } = await readDeliveryFold([submit], true, { repository: repo, issue: 51 }, trust);
    const done = post(
      record(51, "complete", {
        verdict: "delivered",
        evaluatedAt: "2026-11-13T09:59:00Z",
        evaluationRevision: evaluationRevision(fold),
      }),
    );
    const r = await closedDoctor(
      [closedNode(51, "COMPLETED", [submit, done])],
      { 71: { merged: "m71" } },
      { m71: "diverged" },
    );
    expect(kinds(r, 51)).toEqual(["delivery-regressed-after-completion"]);
    const f = finding(r, 51, "delivery-regressed-after-completion");
    expect(f.plan.steps.every((s) => s.kind === "inspect")).toBe(true);
    expect(f.plan.facts).toContain("Ticket responsible: nobody.");
    expect(f.plan.facts).toContain(`${repo}#71: responsible nobody.`);
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
    const facts = finding(r, 46, "closed-delivery-unknown").plan.facts.join(" ");
    expect(facts).toContain("Responsibility is unknown");
    expect(facts).not.toContain("nobody");
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

  it("a closed ticket with only ignored records (non-writer or copied marker) is out of scope", async () => {
    const byReader = post(record(48, "submit", { deliverables: [pr(68)] }), "reader");
    const copied = post(record(99, "submit", { deliverables: [pr(68)] }));
    const r = await closedDoctor([closedNode(48, "COMPLETED", [byReader, copied])], { 68: "open" });
    expect(r.tickets).toEqual([]);
    expect(r.closedScan).toMatchObject({ scanned: 1, withRecords: 0, complete: true });
  });

  it("a failed older comment page is incomplete coverage, not a crash or no record", async () => {
    const fake = live({});
    const query = async (q: string, v: Record<string, unknown>) => {
      if (q.includes("states:CLOSED"))
        return {
          repository: {
            issues: {
              nodes: [closedNode(49, "COMPLETED", [], { older: true })],
              pageInfo: { hasNextPage: false },
            },
          },
        };
      if (q.includes("comments(last:100,before:")) throw new Error("rate limited");
      return fake.rt.query(q, v);
    };
    const closedDrift = await diagnoseClosedDrift(repo, time, {
      trust,
      live: { query: query as never, rest: fake.rt.rest },
    });
    expect(closedDrift.complete).toBe(false);
    expect(closedDrift.warnings.join(" ")).toContain("rate limited");
    expect(closedDrift.tickets).toEqual([]);
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

describe("delivery, responsibility and closure on read surfaces (#192)", () => {
  /** A snapshot PR with the evidence the briefing collects. */
  /** A snapshot PR with the evidence the briefing collects (verify check, head, reviews). */
  const snapPr = (
    n: number,
    verify: string | null,
    {
      decision = null as string | null,
      mergeState = "BLOCKED",
      mergeable = "MERGEABLE",
      approvedOn = null as string | null,
      codexClean = false,
      unresolved = false,
    } = {},
  ) =>
    ({
      number: n,
      url: prLink(n),
      state: "OPEN",
      isDraft: false,
      headRefOid: `head${n}`,
      mergeable,
      mergeStateStatus: mergeState,
      reviewDecision: decision,
      reviewThreads: page(unresolved ? [{ isResolved: false }] : []),
      reviews: page(approvedOn ? [{ state: "APPROVED", commit: { oid: approvedOn } }] : []),
      comments: page(
        codexClean
          ? [
              {
                author: { login: "chatgpt-codex-connector" },
                body: `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { status: "completed", commit_sha: `head${n}`, has_unresolved_findings: false } })} -->`,
              },
            ]
          : [],
      ),
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: verify
                ? { state: verify, contexts: page([{ name: "verify", conclusion: verify }]) }
                : null,
            },
          },
        ],
      },
    }) as unknown as PullRequest;
  const read = async (
    issues: Issue[],
    prs: PullRequest[],
    livePrs: Record<number, LivePr>,
    compare = {},
    withTrust = true,
  ) => {
    const snap = { ...snapshot(issues), pullRequests: prs } as Snapshot;
    return deliveryRead(
      snap,
      await diagnoseDelivery(snap, {
        trust: withTrust ? trust : undefined,
        live: withTrust ? live(livePrs, compare).rt : undefined,
      }),
    );
  };
  const submitted = (n: number, prs: number[], membership: "open" | "complete" = "complete") =>
    post(record(n, "submit", { deliverables: prs.map(pr), membership }));

  it("classifies follow-up from current-head evidence, as the briefing's PR rules do", async () => {
    const prs = [
      snapPr(80, "PENDING"),
      snapPr(81, "FAILURE"),
      snapPr(82, "SUCCESS", { approvedOn: "head82", mergeState: "CLEAN" }),
      snapPr(83, "SUCCESS", { decision: "REVIEW_REQUIRED" }),
      // GitHub kept an approval from an older head: not acceptance (#341 headReviewed).
      snapPr(84, "SUCCESS", { decision: "APPROVED", approvedOn: "old" }),
      snapPr(85, "SUCCESS", { mergeState: "BEHIND" }),
      snapPr(86, "SUCCESS", { codexClean: true, mergeState: "UNKNOWN" }),
      snapPr(87, "SUCCESS", { approvedOn: "head87", mergeState: "BEHIND" }),
      snapPr(88, "SUCCESS", { mergeState: "CLEAN" }),
      snapPr(89, "SUCCESS", { unresolved: true }),
      snapPr(90, "SUCCESS", { mergeable: "CONFLICTING" }),
    ];
    const nums = prs.map((p) => p.number);
    const r = await read(
      [issue(60, ["bug"], [submitted(60, nums)])],
      prs,
      Object.fromEntries(nums.map((n) => [n, "open" as const])),
    );
    const [t] = r.tickets;
    expect(t.delivery).toBe("submitted");
    expect(t.closure).toBe("open");
    expect(t.responsibility?.ticket).toBe("alice");
    expect(t.deliverables.map((m) => [m.followUp, m.followUpWhy])).toEqual([
      ["waiting", "awaiting checks"],
      ["actionable", "failing checks on the current head"],
      ["actionable", "accepted on the current head but not merged: inspect, then consider merge"],
      ["waiting", "awaiting current-head review"],
      ["waiting", "awaiting current-head review"],
      ["actionable", "behind its base: update the branch"],
      ["actionable", "accepted on the current head: refresh mergeability (integrate)"],
      [
        "actionable",
        "accepted on the current head but behind its base: update the branch (integrate)",
      ],
      ["actionable", "clean merge state: inspect the current head, then consider merge"],
      ["actionable", "unresolved review threads"],
      ["actionable", "merge conflict"],
    ]);
    expect(t.deliverables.every((m) => m.responsible === "alice")).toBe(true);
  });

  it("unknown delivery evidence keeps the evaluator's reasons", async () => {
    const r = await read([issue(75, ["bug"], [submitted(75, [94])])], [], {});
    expect(r.tickets[0].delivery).toBe("unknown");
    expect(r.tickets[0].because.join(" ")).toContain("could not be read");
    expect(r.tickets[0].because.join(" ")).not.toContain("legacy");
    const c = await read(
      [issue(76, ["bug"], [submitted(76, [95])])],
      [],
      { 95: { merged: "m95" } },
      {},
    );
    expect(c.tickets[0].because.join(" ")).toContain("inconclusive");
  });

  it("a completed Codex receipt with findings on the head is actionable without threads", async () => {
    const pull = snapPr(96, "SUCCESS", { mergeState: "CLEAN" }) as unknown as {
      comments: { nodes: unknown[] };
    };
    pull.comments.nodes.push({
      author: { login: "chatgpt-codex-connector" },
      body: `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { status: "completed", commit_sha: "head96", has_unresolved_findings: true } })} -->`,
    });
    const r = await read(
      [issue(77, ["bug"], [submitted(77, [96])])],
      [pull as unknown as PullRequest],
      { 96: "open" },
    );
    expect(r.tickets[0].deliverables[0]).toMatchObject({
      followUp: "actionable",
      followUpWhy: "Codex reports unresolved findings on the current head",
    });
  });

  it("S5: an open required PR on a not-planned or duplicate issue is closure cleanup", async () => {
    for (const reason of ["NOT_PLANNED", "DUPLICATE"]) {
      const closed = {
        ...issue(78, ["bug"], [submitted(78, [97])]),
        state: "CLOSED",
        stateReason: reason,
      } as Issue;
      const r = await read([closed], [snapPr(97, "PENDING")], { 97: "open" });
      expect(r.tickets[0].deliverables[0].followUp).toBe("actionable");
      expect(r.tickets[0].deliverables[0].followUpWhy).toContain("closure cleanup");
    }
    // A completed closure with an open PR is S16 drift, classified as ordinary follow-up.
    const completed = {
      ...issue(79, ["bug"], [submitted(79, [98])]),
      state: "CLOSED",
      stateReason: "COMPLETED",
    } as Issue;
    const c = await read([completed], [snapPr(98, "PENDING")], { 98: "open" });
    expect(c.tickets[0].deliverables[0].followUpWhy).toBe("awaiting checks");
  });

  it("pr N keeps closure cleanup on a not-planned issue and reads head findings from the report", () => {
    const member = {
      deliverable: `${repo}#99`,
      url: prLink(99),
      target: `${repo}:(default branch)`,
      state: "open" as const,
      why: "open",
      responsible: "alice",
      followUp: "actionable" as const,
      followUpWhy:
        "closure cleanup: the issue is closed-not-planned; close this PR or explain why it stays open (the closure stands)",
    };
    const read = {
      tickets: [
        {
          number: 80,
          url: "",
          closure: "closed-not-planned" as const,
          records: "known" as const,
          delivery: "submitted" as const,
          because: [],
          responsibility: { ticket: "alice", since: null, members: [] },
          deliverables: [member],
          next: [],
        },
      ],
      closures: [{ number: 80, closure: "closed-not-planned" as const }],
      complete: true,
      omissions: [],
      guidance: "",
    };
    const facts = {
      draft: false,
      complete: true,
      failing: false,
      pending: true,
      unknownChecks: false,
      verified: false,
      changesRequested: false,
      unresolvedThreads: false,
      mergeable: "MERGEABLE",
      mergeState: "BLOCKED",
      headReviewed: false,
      headFindings: false,
    };
    expect(prDelivery(prLink(99), facts, true, read, repo).issues[0].followUpWhy).toContain(
      "closure cleanup",
    );
    expect(
      classifyFollowUp({ ...facts, pending: false, verified: true, headFindings: true }),
    ).toEqual(["actionable", "Codex reports unresolved findings on the current head"]);
  });

  it("an unverifiable legacy release is unknown delivery, with its diagnostics", async () => {
    const legacy = await release("alice", { pr: prLink(9) });
    const r = await read(
      [issue(74, ["bug"], [{ ...legacy, author: { __typename: "User", login: "flaky" } }])],
      [],
      {},
    );
    expect(r.tickets[0]).toMatchObject({ delivery: "unknown" });
    expect(r.tickets[0].because.join(" ")).toContain("could not be verified");
  });

  it("partial delivery shows the merged member as done and the rest outstanding", async () => {
    const r = await read(
      [issue(61, ["bug"], [submitted(61, [84, 85])])],
      [snapPr(85, "PENDING")],
      { 84: { merged: "m84" }, 85: "open" },
      { m84: "behind" },
    );
    expect(r.tickets[0].delivery).toBe("partial");
    expect(r.tickets[0].deliverables.map((m) => m.followUp)).toEqual(["none", "waiting"]);
  });

  it("a ticket whose only markers are ignored is out of the delivery block", async () => {
    const r = await read(
      [
        issue(
          73,
          ["bug"],
          [
            post(record(73, "submit", { deliverables: [pr(93)] }), "reader"),
            post(record(98, "submit", { deliverables: [pr(93)] })),
          ],
        ),
      ],
      [],
      { 93: "open" },
    );
    expect(r.tickets).toEqual([]);
  });

  it("offline, responsibility is unknown (null), never nobody, and delivery is unknown", async () => {
    const r = await read([issue(62, ["bug"], [submitted(62, [86])])], [], {}, {}, false);
    expect(r.tickets[0]).toMatchObject({
      records: "unread",
      delivery: "unknown",
      responsibility: null,
    });
    expect(deliveryFields(issue(62, []), r.tickets[0]).responsibility).toBeNull();
  });

  it("no record in a complete history means nobody responsible; truncated history is unknown", async () => {
    const none = await read([issue(63, ["bug"])], [], {});
    expect(none.tickets).toEqual([]);
    expect(deliveryFields(issue(63, []), null)).toEqual({
      closure: "open",
      delivery: null,
      responsibility: { ticket: null, since: null, members: [] },
    });
    const long = { ...issue(64, ["bug"]), comments: page([], true) } as Issue;
    const truncated = await read([long], [], {});
    expect(truncated.tickets[0]).toMatchObject({
      records: "unknown",
      delivery: "unknown",
      responsibility: null,
    });
  });

  it("an effective completion on a closed issue ends responsibility; closure is reported beside delivery", async () => {
    const submit = submitted(65, [87]);
    const snap0 = snapshot([issue(65, ["bug"], [submit])]);
    const { fold } = await readDeliveryFold([submit], true, { repository: repo, issue: 65 }, trust);
    const done = post(
      record(65, "complete", {
        verdict: "delivered",
        evaluatedAt: "2026-11-13T09:59:00Z",
        evaluationRevision: evaluationRevision(fold),
      }),
    );
    const closed = {
      ...issue(65, ["bug"], [submit, done]),
      state: "CLOSED",
      stateReason: "COMPLETED",
    } as Issue;
    expect(snap0.issues).toHaveLength(1);
    const r = await read([closed], [], { 87: { merged: "m87" } }, { m87: "behind" });
    expect(r.tickets[0]).toMatchObject({ closure: "closed-completed", delivery: "delivered" });
    expect(r.tickets[0].responsibility).toMatchObject({
      ticket: null,
      members: [{ responsible: null }],
    });
  });

  it("team lists responsibilities after the claim is gone, with count, and no limit", async () => {
    const r = await read(
      [issue(66, ["bug"], [submitted(66, [88])]), issue(67, ["bug"], [submitted(67, [89])])],
      [snapPr(88, "PENDING"), snapPr(89, "FAILURE")],
      { 88: "open", 89: "open" },
    );
    const agents = teamResponsibilities([] as TeamAgent[], r);
    expect(agents).toHaveLength(1);
    expect(agents[0].agent).toBe("alice");
    expect(agents[0].claims).toEqual([]);
    expect(agents[0].responsibilities?.map((x) => [x.number, x.scope, x.followUp])).toEqual([
      [66, "ticket", null],
      [66, "deliverable", "waiting"],
      [67, "ticket", null],
      [67, "deliverable", "actionable"],
    ]);
    const text = teamResponsibilityLines(agents, r, new Date(time)).join("\n");
    expect(text).toContain("alice: responsible for 4 item(s) (no limit)");
  });

  it("pr N names the issues requiring it, the responsible agent and its follow-up from fresh blockers", async () => {
    const fake = live({ 90: "open" });
    const issueNode = (n: number, comments: DeliveryComment[]) => ({
      number: n,
      title: "T",
      url: `https://github.com/${repo}/issues/${n}`,
      state: "OPEN",
      stateReason: null,
      closedByPullRequestsReferences: page([]),
      comments: { nodes: comments, pageInfo: { hasPreviousPage: false, startCursor: null } },
    });
    const nodes: Record<number, ReturnType<typeof issueNode>> = {
      68: issueNode(68, [submitted(68, [90])]),
      69: issueNode(69, []),
      70: issueNode(70, [post(record(70, "submit", { deliverables: [pr(90)] }), "flaky")]),
    };
    const query = async (q: string, v: Record<string, unknown>) =>
      q.includes("issue(number:$number){number title")
        ? { repository: { issue: nodes[Number(v.number)] } }
        : fake.rt.query(q, v);
    // A history cut at the page limit is an omission, never "no record".
    const cut = {
      ...issueNode(71, []),
      comments: { nodes: [], pageInfo: { hasPreviousPage: true, startCursor: null } },
    };
    const truncated = await readIssuesDelivery(repo, [71], {
      query: (async (q: string, v: Record<string, unknown>) =>
        q.includes("issue(number:$number){number title")
          ? { repository: { issue: cut } }
          : fake.rt.query(q, v)) as never,
      rest: fake.rt.rest,
      trust,
    });
    expect(truncated.complete).toBe(false);
    expect(truncated.omissions.join(" ")).toContain("#71: comment history truncated");
    const issuesRead = await readIssuesDelivery(repo, [68, 69, 70], {
      query: query as never,
      rest: fake.rt.rest,
      trust,
    });
    const facts = {
      draft: false,
      complete: true,
      failing: false,
      pending: false,
      unknownChecks: false,
      verified: true,
      changesRequested: false,
      unresolvedThreads: false,
      mergeable: "MERGEABLE",
      mergeState: "BLOCKED",
      headReviewed: false,
      headFindings: false,
    };
    const waiting = prDelivery(prLink(90), { ...facts, pending: true }, true, issuesRead, repo);
    expect(waiting.issues).toEqual([
      expect.objectContaining({
        number: 68,
        required: true,
        responsible: "alice",
        followUp: "waiting",
        delivery: "submitted",
      }),
      expect.objectContaining({ number: 69, required: false, delivery: null }),
      expect.objectContaining({ number: 70, required: null, delivery: "unknown" }),
    ]);
    // A missing required approval (verified, merge BLOCKED, no head review) is waiting.
    expect(prDelivery(prLink(90), facts, true, issuesRead, repo).issues[0]).toMatchObject({
      followUp: "waiting",
      followUpWhy: "awaiting current-head review",
    });
    expect(
      prDelivery(
        prLink(90),
        { ...facts, headReviewed: true, mergeState: "CLEAN" },
        true,
        issuesRead,
        repo,
      ).issues[0],
    ).toMatchObject({
      followUp: "actionable",
      followUpWhy: "accepted on the current head but not merged: inspect, then consider merge",
    });
    expect(
      prDelivery(prLink(90), { ...facts, changesRequested: true }, true, issuesRead, repo).issues[0]
        .followUp,
    ).toBe("actionable");
    expect(prDeliveryLines(waiting).join("\n")).toContain(
      `${repo}#70 open: delivery unknown; required unknown`,
    );
    expect(waiting.complete).toBe(true);
    // An issue in another repository keeps its identity, is unknown (never this repository's
    // same-numbered #68), and makes the result incomplete so pr N exits 2.
    const crossed = prDelivery(prLink(90), facts, true, issuesRead, repo, [
      { repository: "other/lib", number: 68 },
    ]);
    expect(crossed.issues.at(-1)).toMatchObject({
      repository: "other/lib",
      number: 68,
      required: null,
      delivery: "unknown",
      closure: null,
    });
    expect(crossed.omissions.join(" ")).toContain("pdb who 68 --repo other/lib");
    expect(crossed.complete).toBe(false);
    expect(
      withDeliveryCompleteness({ completeness: { complete: true, warnings: [] } }, crossed)
        .completeness.complete,
    ).toBe(false);
  });

  it("the briefing JSON carries the same delivery block through the CLI and the shared MCP read service", async () => {
    const snap = snapshot([issue(71, ["bug", "status:awaiting-review"], [submitted(71, [91])])]);
    const fake = live({ 91: { merged: "m91" } }, { m91: "behind" });
    const rest = async (path: string) =>
      path.includes("/collaborators/")
        ? { status: 200, body: { user: { login: "writer" }, role_name: "write" } }
        : fake.rt.rest(path);
    let text = "";
    await main(
      ["--repo", repo, "--json"],
      async (t) => {
        text += t;
      },
      {
        collect: async () => snap,
        currentRepository: async () => repo,
        dependencyReport: async () => ({}) as never,
        now: () => new Date(time),
        query: fake.rt.query as never,
        rest,
        updateCheck: async () => ({ status: "skipped" }) as never,
      },
    );
    const cli = JSON.parse(text) as { delivery: unknown };
    const mcp = await readBriefing(
      {
        collect: async () => snap,
        dependencyReport: async () => ({}) as never,
        now: () => new Date(time),
        query: fake.rt.query as never,
        rest,
      },
      { repository: repo, limit: 10, maxChars: 4000 },
    );
    if (mcp.kind !== "report") throw new Error("unavailable");
    expect(mcp.report.delivery).toEqual(cli.delivery);
    expect(cli.delivery).toMatchObject({
      tickets: [
        { number: 71, delivery: "delivered", closure: "open", responsibility: { ticket: "alice" } },
      ],
    });
  });

  it("who and team add delivery, responsibility and closure through the CLI", async () => {
    const snap = snapshot([issue(72, ["bug"], [submitted(72, [92])])]);
    const fake = live({ 92: "open" });
    const runtime = {
      collect: async () => snap,
      currentRepository: async () => repo,
      now: () => new Date(time),
      query: fake.rt.query as never,
      rest: async (path: string) =>
        path.includes("/collaborators/")
          ? { status: 200, body: { user: { login: "writer" }, role_name: "write" } }
          : fake.rt.rest(path),
      updateCheck: async () => ({ status: "skipped" }) as never,
    };
    const run = async (args: string[]) => {
      let out = "";
      await main(
        args,
        async (t) => {
          out += t;
        },
        runtime,
      );
      return out;
    };
    const who = JSON.parse(await run(["who", "72", "--repo", repo, "--json"]));
    expect(who).toMatchObject({
      closure: "open",
      delivery: { delivery: "submitted", records: "known" },
      responsibility: { ticket: "alice" },
    });
    expect(await run(["who", "72", "--repo", repo])).toContain(
      "Delivery: submitted (records known)",
    );
    const team = JSON.parse(await run(["team", "--repo", repo, "--json"]));
    expect(team.agents).toEqual([
      expect.objectContaining({ agent: "alice", claims: [], responsibilities: expect.any(Array) }),
    ]);
    expect(await run(["team", "--repo", repo])).toContain("alice: responsible for 2 item(s)");
  });

  it("pr N facts come from the status report's structured fields and #341 head acceptance", () => {
    const report = {
      pullRequest: {
        draft: false,
        head: "h1",
        mergeable: "MERGEABLE",
        mergeState: "BLOCKED",
        reviewDecision: "REVIEW_REQUIRED",
      },
      checks: {
        required: { class: "passed", outcome: "SUCCESS" },
        counts: { passed: 1, pending: 0, cancelled: 0, failed: 0, unknown: 0 },
      },
      threads: { unresolved: [], omitted: 0 },
      reviews: [{ state: "APPROVED", reviewedCommit: "old" }],
      receipts: [],
      headReviewed: false,
      headFindings: false,
      completeness: { complete: true, warnings: [] },
    } as unknown as PrStatusReport;
    expect(classifyFollowUp(reportFollowUpFacts(report))).toEqual([
      "waiting",
      "awaiting current-head review",
    ]);
    // A SKIPPED or NEUTRAL verify is "passed" by class but is not a successful verify.
    for (const outcome of ["SKIPPED", "NEUTRAL"]) {
      const skipped = {
        ...report,
        checks: { ...report.checks, required: { class: "passed", outcome } },
        receipts: [],
        headReviewed: true,
        reviews: [{ state: "APPROVED", reviewedCommit: "h1" }],
        pullRequest: { ...report.pullRequest, mergeState: "CLEAN" },
      } as unknown as PrStatusReport;
      expect(classifyFollowUp(reportFollowUpFacts(skipped))[0]).toBe("unknown");
    }
    const codex = {
      ...report,
      headReviewed: true,
      receipts: [
        {
          by: "chatgpt-codex-connector",
          codexState: {
            code_review: { status: "completed", commit_sha: "h1", has_unresolved_findings: false },
          },
        },
      ],
      pullRequest: { ...report.pullRequest, mergeState: "BEHIND" },
    } as unknown as PrStatusReport;
    expect(classifyFollowUp(reportFollowUpFacts(codex))[1]).toBe(
      "accepted on the current head but behind its base: update the branch (integrate)",
    );
  });

  describe("briefing completeness, intake scope and cancellation", () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, i) =>
        issue(200 + i, ["bug"], [submitted(200 + i, [600 + i])]),
      );
    const fakeFor = (count: number) =>
      live(Object.fromEntries(Array.from({ length: count }, (_, i) => [600 + i, "open" as const])));
    const permission = async (_path: string) => ({
      status: 200,
      body: { user: { login: "writer" }, role_name: "write" },
    });
    const runtime = (snap: Snapshot, fake: ReturnType<typeof live>, extra = {}) => ({
      collect: async () => snap,
      dependencyReport: async () => ({}) as never,
      now: () => new Date(time),
      query: fake.rt.query as never,
      rest: async (path: string) =>
        path.includes("/collaborators/") ? permission(path) : fake.rt.rest(path),
      ...extra,
    });

    it("the evaluation cap makes the briefing incomplete", async () => {
      const count = deliveryDoctorTicketCap + 1;
      const read = await readBriefing(runtime(snapshot(many(count)), fakeFor(count)), {
        repository: repo,
        limit: 10,
        maxChars: 4000,
      });
      if (read.kind !== "report") throw new Error("unavailable");
      expect(read.complete).toBe(false);
      expect(read.report.completeness.warnings.join(" ")).toContain("1 more with delivery records");
      expect(read.text).toContain("INCOMPLETE (delivery):");
      expect(read.text.length).toBeLessThanOrEqual(4000);
    });

    it("an explicit intake evaluates its own ticket even past the cap", async () => {
      const count = deliveryDoctorTicketCap + 5;
      const last = 200 + count - 1;
      const read = await readBriefing(runtime(snapshot(many(count)), fakeFor(count)), {
        repository: repo,
        issue: last,
        limit: 10,
        maxChars: 4000,
      });
      if (read.kind !== "report") throw new Error("unavailable");
      expect(read.report.delivery?.tickets).toEqual([
        expect.objectContaining({ number: last, delivery: "submitted" }),
      ]);
    });

    const cli = async (snap: Snapshot, fake: ReturnType<typeof live>, args: string[]) => {
      let out = "";
      const code = await main(
        args,
        async (t) => {
          out += t;
        },
        {
          ...runtime(snap, fake),
          currentRepository: async () => repo,
          updateCheck: async () => ({ status: "skipped" }) as never,
        },
      );
      return { code, out };
    };

    it("who N evaluates the requested issue even past the cap", async () => {
      const count = deliveryDoctorTicketCap + 5;
      const last = 200 + count - 1;
      const { code, out } = await cli(snapshot(many(count)), fakeFor(count), [
        "who",
        String(last),
        "--repo",
        repo,
        "--json",
      ]);
      const who = JSON.parse(out);
      expect(who.delivery).toMatchObject({ number: last, delivery: "submitted" });
      expect(who.completeness.complete).toBe(true);
      expect(code).toBe(0);
    });

    it("team carries the evaluation cap into its completeness and exit code", async () => {
      const count = deliveryDoctorTicketCap + 1;
      const { code, out } = await cli(snapshot(many(count)), fakeFor(count), [
        "team",
        "--repo",
        repo,
        "--json",
      ]);
      const team = JSON.parse(out);
      expect(team.completeness.complete).toBe(false);
      expect(team.completeness.warnings.join(" ")).toContain("1 more with delivery records");
      expect(code).toBe(2);
      const text = await cli(snapshot(many(count)), fakeFor(count), ["team", "--repo", repo]);
      expect(text.out).toContain("INCOMPLETE (delivery):");
    });

    it("pr N carries unreadable linked issues into its completeness", () => {
      const status = { completeness: { complete: true, warnings: [] } };
      expect(
        withDeliveryCompleteness(status, { complete: false, omissions: ["#9: unreadable"] }),
      ).toEqual({ completeness: { complete: false, warnings: ["#9: unreadable"] } });
      expect(withDeliveryCompleteness(status, { complete: true, omissions: [] })).toBe(status);
    });

    it("binds delivery requests to the request's cancellation signal", async () => {
      const fake = fakeFor(1);
      const seen: (AbortSignal | undefined)[] = [];
      const controller = new AbortController();
      await readBriefing(
        {
          ...runtime(snapshot(many(1)), fake),
          query: undefined,
          queryWith: (signal?: AbortSignal) => {
            seen.push(signal);
            return fake.rt.query as never;
          },
          rest: async (path: string, options?: { signal?: AbortSignal }) => {
            seen.push(options?.signal);
            return path.includes("/collaborators/") ? permission(path) : fake.rt.rest(path);
          },
        },
        { repository: repo, limit: 10, maxChars: 4000, signal: controller.signal },
      );
      expect(seen.length).toBeGreaterThan(1);
      expect(seen.every((x) => x === controller.signal)).toBe(true);
    });
  });
});
