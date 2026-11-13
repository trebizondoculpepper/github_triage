import { describe, expect, it } from "vite-plus/test";
import {
  attestApplicability,
  deliveryMarker,
  deliveryOpId,
  foldDelivery,
  markerTrust,
  parseDeliveryComment,
  readDeliveryFold,
} from "./delivery.js";
import type {
  Deliverable,
  DeliveryComment,
  DeliveryRecord,
  MemberObservation,
  TrustDecision,
} from "./delivery.js";
import type { RepositoryPermission } from "./github.js";

const repo = "example/project";
const issue = 42;
const binding = { repository: repo, issue };
const t = (n: number) => `2026-11-13T09:${String(n).padStart(2, "0")}:00Z`;

const pr = (number: number, repository = repo, branch: string | null = null): Deliverable => ({
  kind: "pr",
  repository,
  number,
  nodeId: `PR_${number}`,
  target: { repository, branch },
  headOid: "abc1234",
});
const commit = (oid: string): Deliverable => ({
  kind: "commit",
  repository: repo,
  oid,
  target: { repository: repo, branch: null },
});

let nextId = 100;
const record = (
  op: DeliveryRecord["op"],
  fields: Partial<DeliveryRecord> = {},
): DeliveryRecord => ({
  v: 1,
  op,
  opId: `op-${nextId}`,
  repository: repo,
  issue,
  agent: "alice",
  deliverables: [],
  issuedAt: t(0),
  ...(["submit", "attach", "complete"].includes(op) ? {} : { reason: "because" }),
  ...fields,
});
/** A comment by `login`, posted in order; the default author is a trusted writer. */
const comment = (body: string, login = "writer", id = nextId++): DeliveryComment => ({
  databaseId: id,
  body,
  createdAt: t(id % 60),
  author: { __typename: "User", login },
  lastEditedAt: null,
  includesCreatedEdit: false,
  editor: null,
});
const post = (r: DeliveryRecord, login = "writer") => comment(deliveryMarker(r), login);

/** The #212 rule over an injected permission table: the real trust path, no network. */
const permissions: Record<string, RepositoryPermission> = {
  writer: "write",
  admin: "admin",
  reader: "read",
  flaky: "unknown",
};
const trust: TrustDecision = markerTrust(async (login) => permissions[login] ?? "none");

const fold = async (comments: DeliveryComment[], complete = true) =>
  (await readDeliveryFold(comments, complete, binding, trust)).fold;

describe("delivery record format", () => {
  it("round-trips a record through the marker and escapes HTML comment terminators", () => {
    const r = record("attach", { deliverables: [pr(5)], reason: "<!-- x -->" });
    const body = `Attached.\n\n${deliveryMarker(r)}`;
    expect(body.match(/-->/g)).toHaveLength(1);
    expect(parseDeliveryComment(body)).toEqual({ kind: "record", record: r });
  });
  it("ignores comments without the marker prefix", () => {
    expect(parseDeliveryComment("<!-- github-triage:release:abc {} -->")).toEqual({ kind: "none" });
  });
  it("gives a stable opId for the same operation", () => {
    const parts = {
      repository: repo,
      issue,
      op: "attach" as const,
      deliverables: [pr(1), pr(2)],
      agent: "a",
      issuedAt: t(1),
    };
    expect(deliveryOpId(parts)).toBe(deliveryOpId({ ...parts, deliverables: [pr(2), pr(1)] }));
    expect(deliveryOpId(parts)).not.toBe(deliveryOpId({ ...parts, issue: 43 }));
  });
  it("refuses a record without a required reason as malformed", () => {
    const { reason: _, ...bare } = record("detach", { deliverables: [pr(5)] });
    expect(parseDeliveryComment(deliveryMarker(bare as DeliveryRecord))).toMatchObject({
      kind: "malformed",
      why: "detach has no reason",
    });
  });
});

describe("delivery fold scenarios (#189)", () => {
  it("S1 legacy-attach half: a write-permission author attaches a merged PR to a v1 done ticket", async () => {
    const f = await fold([
      post(
        record("legacy-attach", {
          agent: "bob",
          deliverables: [pr(7)],
          membership: "complete",
          login: "writer",
          legacyRelease: "55",
        }),
      ),
    ]);
    expect(f.members.map((m) => m.deliverable)).toEqual([pr(7)]);
    expect(f.membership).toBe("complete");
    expect(f.ticketResponsible).toBe("bob");
    expect(f.hasTrustedRecord).toBe(true);
    expect(f.applied[0]).toMatchObject({ op: "legacy-attach", agent: "bob", login: "writer" });
  });

  it("S6 commit deliverables are first-class members", async () => {
    const f = await fold([
      post(record("attach", { deliverables: [commit("deadbeef01")], membership: "complete" })),
    ]);
    expect(f.members[0].deliverable).toEqual(commit("deadbeef01"));
  });

  it("S7 cross-repository PRs keep their own repository and explicit target", async () => {
    const other = pr(9, "other/lib", "release");
    const f = await fold([post(record("submit", { deliverables: [pr(5), other] }))]);
    expect(f.members.map((m) => m.deliverable)).toEqual([pr(5), other]);
    expect(f.membership).toBe("complete");
  });

  it("S10 a record by an author without write permission is listed as ignored and excluded", async () => {
    const f = await fold([post(record("attach", { deliverables: [pr(5)] }), "reader")]);
    expect(f.members).toEqual([]);
    expect(f.recordsUnknown).toBe(false);
    expect(f.ignored[0]).toMatch(/^unverified record by reader, ignored/);
  });

  it("S12 a record whose author permission lookup errors makes the fold unknown", async () => {
    const f = await fold([post(record("attach", { deliverables: [pr(5)] }), "flaky")]);
    expect(f.recordsUnknown).toBe(true);
    expect(f.refusal).toBe("MARKER_UNVERIFIED");
    expect(f.members).toEqual([]);
  });

  it("S13 a record copied from another issue is rejected by its repository/issue binding", async () => {
    const copied = post(record("attach", { issue: 41, deliverables: [pr(5)] }));
    const otherRepo = post(
      record("attach", { repository: "other/project", deliverables: [pr(6)] }),
    );
    const f = await fold([copied, otherRepo]);
    expect(f.members).toEqual([]);
    expect(f.hasTrustedRecord).toBe(false);
    expect(f.ignored).toHaveLength(2);
    expect(f.ignored[0]).toMatch(/bound to example\/project#41, not example\/project#42/);
    expect(f.ignored[0]).toContain(`copied record ${copied.databaseId} by writer, rejected`);
    expect(f.ignored[1]).toContain(`copied record ${otherRepo.databaseId} by writer, rejected`);
  });

  it("S13 a copied record without a comment id is named by the no-id form", () => {
    const copied = {
      ...post(record("attach", { issue: 41, deliverables: [pr(5)] })),
      databaseId: undefined,
      url: "https://github.com/example/project/issues/41#issuecomment-x",
    } as unknown as DeliveryComment;
    const f = foldDelivery(
      [{ comment: copied, login: "writer", status: "foreign", why: "record is bound elsewhere" }],
      true,
    );
    expect(f.recordsUnknown).toBe(false);
    expect(f.ignored).toEqual([
      "copied record (no id, https://github.com/example/project/issues/41#issuecomment-x) by writer, rejected (record is bound elsewhere)",
    ]);
  });

  it("S14 record half: a detach of the only member is recorded with its reason and stays in history", async () => {
    const f = await fold([
      post(record("submit", { deliverables: [pr(5)] })),
      post(record("detach", { deliverables: [pr(5)], reason: "closed unmerged, replaced" })),
    ]);
    expect(f.members).toEqual([]);
    expect(f.applied.map((a) => [a.op, a.reason])).toEqual([
      ["submit", undefined],
      ["detach", "closed unmerged, replaced"],
    ]);
  });

  it("S19 a handoff written under another agent's name does not move that agent's deliverable", async () => {
    const submit = post(record("submit", { agent: "alice", deliverables: [pr(5)] }));
    const f = await fold([
      submit,
      post(
        record("handoff", {
          agent: "bob",
          to: "carol",
          scope: "deliverable",
          deliverables: [pr(5)],
          expectedResponsibilityRecord: String(submit.databaseId),
        }),
      ),
    ]);
    expect(f.members[0].responsible).toBe("alice");
    expect(f.rejected[0]).toMatchObject({ error: "HANDOFF_STALE" });
  });

  it("S22 truncated comment history makes the fold unknown, never empty", async () => {
    const f = await fold([], false);
    expect(f.recordsUnknown).toBe(true);
    expect(f.refusal).toBe("EVIDENCE_INCOMPLETE");
  });

  it("S23 a trusted malformed record makes the fold unknown and is reported by login", async () => {
    const f = await fold([comment("<!-- github-triage:delivery v1 {not json} -->")]);
    expect(f.recordsUnknown).toBe(true);
    expect(f.refusal).toBe("RECORD_MALFORMED");
    expect(f.unknownBecause[0]).toMatch(/^malformed delivery record by writer/);
  });

  it("S24 a trusted future-version record is unsupported, never guessed at", async () => {
    const marker = await fold([comment('<!-- github-triage:delivery v2 {"v":2} -->')]);
    const payload = await fold([
      comment('<!-- github-triage:delivery v1 {"v":2,"op":"attach"} -->'),
    ]);
    for (const f of [marker, payload]) {
      expect(f.recordsUnknown).toBe(true);
      expect(f.refusal).toBe("RECORD_UNSUPPORTED");
      expect(f.unknownBecause[0]).toMatch(/^unsupported delivery record version 2 by writer/);
    }
  });

  it("S25 a record with unknown author permission is unknown whether or not it parses", async () => {
    for (const body of [
      deliveryMarker(record("attach", { deliverables: [pr(5)] })),
      "<!-- github-triage:delivery v1 {bad -->",
    ]) {
      const f = await fold([comment(body, "flaky")]);
      expect(f.recordsUnknown).toBe(true);
      expect(f.refusal).toBe("MARKER_UNVERIFIED");
    }
  });

  it("S25 an edit by an unverifiable editor makes a trusted author's record unknown", async () => {
    const c = {
      ...post(record("attach", { deliverables: [pr(5)] })),
      lastEditedAt: t(5),
      editor: { __typename: "User", login: "flaky" },
    };
    expect((await fold([c])).refusal).toBe("MARKER_UNVERIFIED");
  });

  it("S26 malformed or future-version records by a verified non-writer are ignored and do not block", async () => {
    const f = await fold([
      post(record("submit", { deliverables: [pr(5)] })),
      comment("<!-- github-triage:delivery v1 {bad -->", "reader"),
      comment('<!-- github-triage:delivery v9 {"v":9} -->', "reader"),
    ]);
    expect(f.recordsUnknown).toBe(false);
    expect(f.members).toHaveLength(1);
    expect(f.ignored).toHaveLength(2);
  });

  it("S26 a bot author is never trusted", async () => {
    const c = {
      ...post(record("attach", { deliverables: [pr(5)] })),
      author: { __typename: "Bot", login: "helper[bot]" },
    };
    const f = await fold([c]);
    expect(f.members).toEqual([]);
    expect(f.recordsUnknown).toBe(false);
  });

  const observe =
    (states: Record<number, MemberObservation>) =>
    (d: Deliverable): MemberObservation =>
      d.kind === "pr" ? (states[d.number] ?? "unknown") : "unknown";

  it("S33 attest while a required PR is open is not applicable, naming the PR", async () => {
    const f = await fold([post(record("submit", { deliverables: [pr(5)] }))]);
    expect(attestApplicability(f, observe({ 5: "outstanding" }))).toEqual({
      applies: false,
      error: "ATTEST_NOT_APPLICABLE",
      outstanding: ["example/project#5"],
      membershipOpen: false,
    });
  });

  it("S33 unknown member evidence refuses EVIDENCE_INCOMPLETE, never ATTEST_NOT_APPLICABLE", async () => {
    const f = await fold([post(record("submit", { deliverables: [pr(5), pr(6)] }))]);
    expect(attestApplicability(f, observe({ 5: "outstanding" }))).toMatchObject({
      error: "EVIDENCE_INCOMPLETE",
      unknown: ["example/project#6"],
    });
  });

  it("S34 an attestation stops applying once an open PR is attached", async () => {
    const f = await fold([
      post(
        record("legacy-attest", {
          agent: "bob",
          membership: "complete",
          login: "writer",
          legacyRelease: "55",
        }),
      ),
      post(record("attach", { agent: "bob", deliverables: [pr(8)] })),
    ]);
    expect(f.attestRecord).toBe(true);
    expect(attestApplicability(f, observe({ 8: "outstanding" }))).toMatchObject({
      applies: false,
      outstanding: ["example/project#8"],
    });
  });

  it("S35 attest applies to an empty complete set and to a fully merged set", async () => {
    const empty = await fold([
      post(
        record("legacy-attest", { membership: "complete", login: "writer", legacyRelease: "55" }),
      ),
    ]);
    expect(attestApplicability(empty, observe({}))).toEqual({ applies: true });
    const merged = await fold([
      post(record("submit", { deliverables: [pr(5)] })),
      post(record("attest")),
    ]);
    expect(merged.attestRecord).toBe(true);
    expect(attestApplicability(merged, observe({ 5: "merged" }))).toEqual({ applies: true });
  });

  it("S39 legacy-attest declares an empty, complete set and makes its agent ticket-responsible", async () => {
    const f = await fold([
      post(
        record("legacy-attest", {
          agent: "bob",
          membership: "complete",
          login: "writer",
          legacyRelease: "55",
          evidence: "https://example.com/decision",
        }),
      ),
    ]);
    expect(f).toMatchObject({
      members: [],
      membership: "complete",
      attestRecord: true,
      ticketResponsible: "bob",
    });
    expect(
      parseDeliveryComment(
        deliveryMarker(
          record("legacy-attest", { membership: "open", login: "w", legacyRelease: "1" }),
        ),
      ),
    ).toMatchObject({ kind: "malformed" });
  });

  it("S43 attach half: legacy-attach of a commit deliverable", async () => {
    const f = await fold([
      post(
        record("legacy-attach", {
          deliverables: [commit("0123456789abcdef")],
          membership: "complete",
          login: "writer",
          legacyRelease: "55",
        }),
      ),
    ]);
    expect(f.members[0].deliverable.kind).toBe("commit");
  });

  it("S47 detaching the last member leaves ticket responsibility in place", async () => {
    const f = await fold([
      post(record("submit", { agent: "alice", deliverables: [pr(5)] })),
      post(record("detach", { agent: "alice", deliverables: [pr(5)] })),
    ]);
    expect(f.members).toEqual([]);
    expect(f.ticketResponsible).toBe("alice");
  });

  it("S49 record half: a ticket handoff moves ticket responsibility and every member the sender held", async () => {
    const submit = post(record("submit", { agent: "alice", deliverables: [pr(5), pr(6)] }));
    const f = await fold([
      submit,
      post(
        record("handoff", {
          agent: "alice",
          to: "bob",
          scope: "ticket",
          expectedResponsibilityRecord: String(submit.databaseId),
        }),
      ),
    ]);
    expect(f.ticketResponsible).toBe("bob");
    expect(f.members.map((m) => m.responsible)).toEqual(["bob", "bob"]);
  });

  it("S50 a deliverable handoff moves only that PR; the sender stays ticket-responsible", async () => {
    const submit = post(record("submit", { agent: "alice", deliverables: [pr(5), pr(6)] }));
    const f = await fold([
      submit,
      post(
        record("handoff", {
          agent: "alice",
          to: "bob",
          scope: "deliverable",
          deliverables: [pr(5)],
          expectedResponsibilityRecord: String(submit.databaseId),
        }),
      ),
    ]);
    expect(f.ticketResponsible).toBe("alice");
    expect(f.members.map((m) => m.responsible)).toEqual(["bob", "alice"]);
  });

  it("S51 a membership record closes open membership", async () => {
    const f = await fold([
      post(record("submit", { deliverables: [pr(5)], membership: "open" })),
      post(record("membership", { membership: "complete" })),
    ]);
    expect(f.membership).toBe("complete");
  });

  it("S52 reassign makes the recipient ticket- and member-responsible", async () => {
    const f = await fold([
      post(record("submit", { agent: "alice", deliverables: [pr(5)] })),
      post(record("reassign", { agent: "maint", to: "bob" }), "admin"),
    ]);
    expect(f.ticketResponsible).toBe("bob");
    expect(f.members[0].responsible).toBe("bob");
    expect(f.applied[1]).toMatchObject({ op: "reassign", agent: "maint", login: "admin" });
  });

  it("S53 reset ends all responsibility and leaves members unchanged", async () => {
    const f = await fold([
      post(record("submit", { deliverables: [pr(5)] })),
      post(
        record("reset", { plan: { remove: ["status:awaiting-review"], add: ["status:ready"] } }),
      ),
    ]);
    expect(f.ticketResponsible).toBeNull();
    expect(f.members).toHaveLength(1);
    expect(f.members[0].responsible).toBeNull();
  });

  it("S54 record half: reset on a ticket with no prior delivery record folds", async () => {
    const f = await fold([post(record("reset"))]);
    expect(f.ticketResponsible).toBeNull();
    expect(f.hasTrustedRecord).toBe(true);
  });

  it("S55 void excludes a malformed record so the fold is known again", async () => {
    const bad = comment("<!-- github-triage:delivery v1 {bad -->");
    const f = await fold([
      post(record("submit", { deliverables: [pr(5)] })),
      bad,
      post(record("void", { voids: String(bad.databaseId) }), "admin"),
    ]);
    expect(f.recordsUnknown).toBe(false);
    expect(f.voided).toEqual([String(bad.databaseId)]);
  });

  it("S55 void of a parsable or future-version record is VOID_NOT_APPLICABLE and clears nothing", async () => {
    const good = post(record("submit", { deliverables: [pr(5)] }));
    const future = comment('<!-- github-triage:delivery v2 {"v":2} -->');
    const f = await fold([
      good,
      future,
      post(record("void", { voids: String(good.databaseId) })),
      post(record("void", { voids: String(future.databaseId) })),
    ]);
    expect(f.rejected.map((r) => r.error)).toEqual(["VOID_NOT_APPLICABLE", "VOID_NOT_APPLICABLE"]);
    expect(f.members).toHaveLength(1);
    expect(f.refusal).toBe("RECORD_UNSUPPORTED");
  });

  it("S66 of two concurrent handoffs from the same predecessor, the first applies and the second is stale", async () => {
    const submit = post(record("submit", { agent: "alice", deliverables: [pr(5)] }));
    const pred = String(submit.databaseId);
    const toB = post(
      record("handoff", {
        agent: "alice",
        to: "bob",
        scope: "ticket",
        expectedResponsibilityRecord: pred,
      }),
    );
    const toC = post(
      record("handoff", {
        agent: "alice",
        to: "carol",
        scope: "ticket",
        expectedResponsibilityRecord: pred,
      }),
    );
    const f = await fold([toC, submit, toB].sort((a, b) => a.databaseId - b.databaseId));
    expect(f.ticketResponsible).toBe("bob");
    expect(f.rejected).toEqual([
      expect.objectContaining({ comment: String(toC.databaseId), error: "HANDOFF_STALE" }),
    ]);
    // A valid onward transfer from the effective holder still applies.
    const onward = post(
      record("handoff", {
        agent: "bob",
        to: "carol",
        scope: "ticket",
        expectedResponsibilityRecord: String(toB.databaseId),
      }),
    );
    expect((await fold([submit, toB, toC, onward])).ticketResponsible).toBe("carol");
  });

  it("S67 a handoff after an unverifiable record is unverifiable, not a stale or successful transfer", async () => {
    const submit = post(record("submit", { agent: "alice", deliverables: [pr(5)] }));
    const unclear = post(record("attach", { agent: "alice", deliverables: [pr(6)] }), "flaky");
    const handoff = post(
      record("handoff", {
        agent: "alice",
        to: "bob",
        scope: "ticket",
        expectedResponsibilityRecord: String(submit.databaseId),
      }),
    );
    const f = await fold([submit, unclear, handoff]);
    expect(f.unverifiableTransfers).toEqual([String(handoff.databaseId)]);
    expect(f.rejected).toEqual([]);
    expect(f.ticketResponsible).toBe("alice");
    expect(f.recordsUnknown).toBe(true);
  });

  it("concurrent attaches append separately and both fold in comment order", async () => {
    const f = await fold([
      post(record("attach", { agent: "alice", deliverables: [pr(5)] })),
      post(record("attach", { agent: "alice", deliverables: [pr(6, "other/lib")] })),
      post(record("attach", { agent: "alice", deliverables: [pr(5, repo, "next")] })),
    ]);
    expect(
      f.members.map((m) => [
        m.deliverable.repository,
        m.deliverable.kind === "pr" && m.deliverable.number,
        m.deliverable.target.branch,
      ]),
    ).toEqual([
      [repo, 5, "next"],
      ["other/lib", 6, null],
    ]);
  });

  it("folds in stable comment order, not caller-supplied issuedAt", async () => {
    const first = post(record("membership", { membership: "open", issuedAt: t(59) }));
    const second = post(record("membership", { membership: "complete", issuedAt: t(1) }));
    expect((await fold([second, first])).membership).toBe("complete");
  });

  it("retarget changes only the named member's target", async () => {
    const f = foldDelivery(
      [
        {
          comment: comment(""),
          login: "writer",
          status: "trusted",
          record: record("submit", { deliverables: [pr(5), pr(6)] }),
        },
        {
          comment: comment(""),
          login: "writer",
          status: "trusted",
          record: record("retarget", { deliverables: [pr(5, repo, "release")] }),
        },
      ],
      true,
    );
    expect(f.members.map((m) => m.deliverable.target.branch)).toEqual(["release", null]);
  });
});

describe("delivery ordering evidence (PRRT_kwDOVsRJzc63TEp3)", () => {
  const submitThenHandoff = () => {
    const submit = post(record("submit", { agent: "alice", deliverables: [pr(5)] }));
    const handoff = post(
      record("handoff", {
        agent: "alice",
        to: "bob",
        scope: "ticket",
        expectedResponsibilityRecord: String(submit.databaseId),
      }),
    );
    return { submit, handoff };
  };
  const expectUnknown = (f: Awaited<ReturnType<typeof fold>>, pattern: RegExp) => {
    expect(f.recordsUnknown).toBe(true);
    expect(f.refusal).toBe("EVIDENCE_INCOMPLETE");
    expect(f.unknownBecause.join("\n")).toMatch(pattern);
  };

  it("a handoff with no creation time is unknown, not sorted before its submit", async () => {
    const { submit, handoff } = submitThenHandoff();
    const undated = { ...handoff, createdAt: undefined } as unknown as DeliveryComment;
    const f = await fold([submit, undated]);
    expectUnknown(f, /no creation time/);
    expect(f.ticketResponsible).not.toBe("bob");
    expect(f.rejected).toEqual([]);
  });

  it("an unparseable creation time is unknown, not guessed", async () => {
    const { submit, handoff } = submitThenHandoff();
    const f = await fold([submit, { ...handoff, createdAt: "yesterday-ish" }]);
    expectUnknown(f, /is not a timestamp/);
  });

  it("equal creation times with a missing comment id are unknown, not tie-broken by default", async () => {
    const { submit, handoff } = submitThenHandoff();
    const noId = {
      ...handoff,
      createdAt: submit.createdAt,
      databaseId: undefined,
    } as unknown as DeliveryComment;
    const f = await fold([submit, noId]);
    expectUnknown(f, /no numeric id/);
  });

  it("a recognised record with no author is unverified, never attributed to a default", async () => {
    const f = await fold([{ ...post(record("attach", { deliverables: [pr(5)] })), author: null }]);
    expect(f.recordsUnknown).toBe(true);
    expect(f.refusal).toBe("MARKER_UNVERIFIED");
    expect(f.members).toEqual([]);
  });

  it("ordering gaps on a non-writer's record are ignored and do not block", async () => {
    const f = await fold([
      { ...post(record("attach", { deliverables: [pr(5)] }), "reader"), createdAt: "" },
    ]);
    expect(f.recordsUnknown).toBe(false);
  });
});
