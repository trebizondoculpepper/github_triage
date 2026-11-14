/**
 * Shared blended-action policy (#248): the pure comparator over injected facts, and the additive
 * `rankedActions` output through the real collector with a fake GraphQL boundary.
 */
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import type { AssessmentState } from "./assessments.js";
import {
  classify,
  compareActions,
  designFollowUpSections,
  rankActions,
  roleCandidates,
} from "./blended.js";
import type { ActionFacts, ActionKind, CandidateSubject } from "./blended.js";
import { briefing } from "./briefing.js";
import { compactBriefing } from "./compact.js";
import type { CompactBriefing } from "./compact.js";
import type { ComplexitySize } from "./complexity.js";
import { collectLabelEstimationInput } from "./complexitylabels.js";
import { TOML_CONFIG_PATH } from "./config.js";
import type { ConfigFileSystem, GitRunner } from "./config.js";
import { collect } from "./github.js";
import type { Query } from "./github.js";
import { presentBriefing } from "./service.js";
import type { Issue, Page } from "./types.js";

const repo = "owner/name";
const time = "2026-11-14T10:00:00.000Z";
const url = (n: number) => `https://github.com/${repo}/issues/${n}`;
type Pair = [AssessmentState, ComplexitySize | null];
const unassessed: Pair = ["unassessed", null];

function fact(
  n: number,
  kind: ActionKind,
  impact: Pair = unassessed,
  complexity: Pair = unassessed,
  extra: Partial<ActionFacts> = {},
): ActionFacts {
  return {
    repository: repo,
    target: url(n),
    number: n,
    kind,
    role: kind === "assess-impact" || kind === "design" ? "designer" : "implementer",
    impact: { state: impact[0], size: impact[1] },
    complexity: { state: complexity[0], size: complexity[1] },
    urgency: 1,
    unlocks: 0,
    unlocksUnknown: [],
    own: false,
    incomplete: false,
    createdAt: time,
    evidence: [url(n)],
    nextCommand: "cmd",
    inspection: null,
    ...extra,
  };
}
const order = (facts: ActionFacts[], mode?: "impact" | "oldest" | "newest") =>
  rankActions(facts, { limit: 100, ...(mode ? { order: mode } : {}) }).items.map(
    (i) => `${i.kind}#${Number(i.target.split("/").pop())}`,
  );

describe("blended comparator bands (#248)", () => {
  it("classifies easy wins, unfavorable and ordinary pairs only from current evidence", () => {
    const band = (impact: Pair, complexity: Pair) =>
      classify(fact(1, "implement", impact, complexity)).band;
    expect(band(["current", "L"], ["current", "S"])).toBe(4);
    expect(band(["current", "XXL"], ["current", "XS"])).toBe(4);
    expect(band(["current", "S"], ["current", "L"])).toBe(7);
    expect(band(["current", "XS"], ["current", "XXL"])).toBe(7);
    // M on either scale, L/L and S/S tradeoffs are ordinary.
    expect(band(["current", "M"], ["current", "S"])).toBe(6);
    expect(band(["current", "L"], ["current", "M"])).toBe(6);
    expect(band(["current", "L"], ["current", "L"])).toBe(6);
    expect(band(["current", "S"], ["current", "S"])).toBe(6);
    // Non-current states never qualify, even with a remembered size.
    for (const state of ["stale", "conflict", "invalid", "unknown", "disabled", "unassessed"]) {
      const size = state === "stale" ? "L" : null;
      expect(band([state as AssessmentState, size], ["current", "S"])).toBe(6);
      expect(band(["current", "S"], [state as AssessmentState, size && "XL"])).toBe(6);
    }
  });

  it("gives easy wins to implementers only", () => {
    const designer = fact(1, "implement", ["current", "L"], ["current", "S"], {
      role: "designer",
    });
    expect(classify(designer).band).toBe(6);
  });

  it("keeps bands 1–3 in their selector order ahead of every discretionary band", () => {
    expect(
      order([
        fact(9, "implement", ["current", "XL"], ["current", "XS"], { urgency: 0 }),
        fact(5, "design-review", unassessed, unassessed, { sequence: 3 }),
        fact(4, "decide", unassessed, unassessed, { sequence: 2 }),
        fact(3, "pr-follow-up", unassessed, unassessed, { sequence: 1 }),
        fact(2, "addressed-response", unassessed, unassessed, { sequence: 0, urgency: 2 }),
      ]),
    ).toEqual([
      "addressed-response#2",
      "pr-follow-up#3",
      "decide#4",
      "design-review#5",
      "implement#9",
    ]);
  });

  it("orders easy win, boosted then unboosted assessment, ordinary, unfavorable", () => {
    expect(
      order([
        fact(1, "implement", ["current", "XS"], ["current", "XL"]),
        fact(2, "implement", ["current", "M"], ["current", "M"]),
        fact(3, "estimate-complexity", unassessed, unassessed),
        fact(4, "estimate-complexity", ["current", "XL"], unassessed),
        fact(5, "implement", ["current", "L"], ["current", "S"]),
      ]),
    ).toEqual([
      "implement#5",
      "estimate-complexity#4",
      "estimate-complexity#3",
      "implement#2",
      "implement#1",
    ]);
  });

  it("boosts complexity estimates on current high impact with absent or stale complexity", () => {
    const boosted = (impact: Pair, complexity: Pair) =>
      classify(fact(1, "estimate-complexity", impact, complexity));
    expect(boosted(["current", "L"], unassessed)).toMatchObject({
      band: 5,
      boosted: true,
      reasonCodes: expect.arrayContaining(["cross-role-boost"]),
    });
    expect(boosted(["current", "XXL"], ["stale", "S"]).boosted).toBe(true);
    expect(boosted(["current", "M"], unassessed).boosted).toBe(false);
    expect(boosted(["stale", "XL"], unassessed).boosted).toBe(false);
    expect(boosted(["unknown", null], unassessed).boosted).toBe(false);
  });

  it("boosts impact assessment on current small complexity with absent or stale impact", () => {
    const boosted = (impact: Pair, complexity: Pair) =>
      classify(fact(1, "assess-impact", impact, complexity)).boosted;
    expect(boosted(unassessed, ["current", "XS"])).toBe(true);
    expect(boosted(["stale", "L"], ["current", "S"])).toBe(true);
    expect(boosted(unassessed, ["current", "M"])).toBe(false);
    expect(boosted(unassessed, ["conflict", null])).toBe(false);
    expect(boosted(unassessed, ["stale", "XS"])).toBe(false);
  });

  it("puts inspection in band 5 without a speculative boost", () => {
    const inspect = classify(
      fact(1, "inspect-assessment", ["current", "XL"], ["conflict", null], { nextCommand: null }),
    );
    expect(inspect).toEqual({
      band: 5,
      boosted: false,
      reasonCodes: ["assessment", "inspection", "impact-current", "complexity-conflict"],
    });
  });

  it("gives assessment no immediate-unlock credit but keeps unlocks visible", () => {
    const a = fact(1, "estimate-complexity", unassessed, unassessed, { unlocks: 5 });
    const b = fact(2, "estimate-complexity", unassessed, unassessed);
    expect(order([a, b])).toEqual(["estimate-complexity#1", "estimate-complexity#2"]);
    expect(order([b, a])).toEqual(["estimate-complexity#1", "estimate-complexity#2"]);
    // Equal except identity: the number decides, not the unlock count.
    const c = fact(3, "estimate-complexity", unassessed, unassessed, { unlocks: 9 });
    expect(order([c, b])).toEqual(["estimate-complexity#2", "estimate-complexity#3"]);
    expect(rankActions([c], { limit: 1 }).items[0]?.unlocks).toBe(9);
  });

  it("applies urgency, unlocks, own continuation, incomplete and age within a band", () => {
    const ordinary = (n: number, extra: Partial<ActionFacts>) =>
      fact(n, n === 4 ? "continue-implementation" : "implement", unassessed, unassessed, extra);
    expect(
      order([
        ordinary(1, { createdAt: "2026-01-01T00:00:00Z" }),
        ordinary(2, { incomplete: true }),
        ordinary(4, { own: true }),
        ordinary(5, { unlocks: 2 }),
        ordinary(6, { urgency: 0 }),
        ordinary(7, { urgency: 2, unlocks: 9 }),
      ]),
    ).toEqual([
      "implement#6",
      "implement#5",
      "continue-implementation#4",
      "implement#2",
      "implement#1",
      "implement#7",
    ]);
  });

  it("falls back to deterministic identity for equal and incomparable candidates", () => {
    const facts = [
      fact(3, "implement", ["current", "L"], ["current", "L"]),
      fact(1, "implement", ["current", "S"], ["current", "XS"]),
      fact(2, "implement", ["unknown", null], ["current", "S"]),
    ];
    const first = order(facts);
    expect(first).toEqual(["implement#1", "implement#2", "implement#3"]);
    expect(order([...facts].reverse())).toEqual(first);
    const compare = compareActions();
    expect(compare(facts[0]!, facts[0]!)).toBe(0);
  });

  it("coalesces unclaimed pickup into band 6 by age under explicit oldest/newest", () => {
    const facts = [
      fact(1, "implement", ["current", "XL"], ["current", "XS"], {
        createdAt: "2026-06-01T00:00:00Z",
      }),
      fact(2, "implement", ["current", "XS"], ["current", "XL"], {
        createdAt: "2026-01-01T00:00:00Z",
        urgency: 2,
      }),
      fact(3, "estimate-complexity", ["current", "XL"], unassessed),
    ];
    expect(order(facts, "oldest")).toEqual(["estimate-complexity#3", "implement#2", "implement#1"]);
    expect(order(facts, "newest")).toEqual(["estimate-complexity#3", "implement#1", "implement#2"]);
    expect(order(facts)).toEqual(["implement#1", "estimate-complexity#3", "implement#2"]);
    // Labels remain visible, and own claims keep their value band.
    const ranked = rankActions(facts, { order: "oldest", limit: 5 });
    expect(ranked.items[1]?.impact).toEqual({ state: "current", size: "XS" });
    expect(classify({ ...facts[0]!, own: true }, "oldest").band).toBe(4);
  });

  it("keeps the normal keys for designer design actions under explicit oldest/newest", () => {
    const older = fact(1, "design", unassessed, unassessed, {
      createdAt: "2026-01-01T00:00:00Z",
      urgency: 2,
    });
    const newer = fact(2, "design", unassessed, unassessed, {
      createdAt: "2026-06-01T00:00:00Z",
      urgency: 0,
      unlocks: 4,
    });
    for (const mode of ["impact", "oldest", "newest"] as const)
      expect(order([older, newer], mode)).toEqual(["design#2", "design#1"]);
    // Own continuation also keeps urgency, and precedes the age-ordered pickup group.
    const own = fact(3, "continue-implementation", unassessed, unassessed, {
      own: true,
      urgency: 2,
      createdAt: "2026-09-01T00:00:00Z",
    });
    const pickup = fact(4, "implement", unassessed, unassessed, {
      urgency: 0,
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(order([pickup, own], "oldest")).toEqual(["continue-implementation#3", "implement#4"]);
  });

  it("ranks an owned design PR with a follow-up finding as band-2 PR follow-up", () => {
    const pr = (n: number) => `https://github.com/${repo}/pull/${n}`;
    const sections = [
      { name: "addressed", background: false, rows: [] },
      { name: "decision-needed", background: false, rows: [{ url: url(5) }] },
      { name: "design-review", background: false, rows: [{ url: pr(10) }, { url: pr(11) }] },
    ];
    const moved = designFollowUpSections(sections, (u) => u === pr(11));
    expect(moved.map((s) => [s.name, s.rows.map((r) => r.url)])).toEqual([
      ["addressed", []],
      ["design-follow-up", [pr(11)]],
      ["decision-needed", [url(5)]],
      ["design-review", [pr(10)]],
    ]);
    expect(designFollowUpSections(sections, () => false)).toBe(sections);
    const subject = (n: number, u: string, isIssue: boolean) =>
      [
        u,
        { url: u, number: n, state: "OPEN", createdAt: time, labels: [] as string[], isIssue },
      ] as [string, CandidateSubject];
    const ranked = rankActions(
      roleCandidates({
        repository: repo,
        role: "designer",
        agent: "me",
        sections: moved,
        subjects: new Map([
          subject(5, url(5), true),
          subject(10, pr(10), false),
          subject(11, pr(11), false),
        ]),
        assessments: new Map(),
        isAddressed: () => false,
        isParked: () => false,
        urgency: () => 1,
        ownedByViewer: () => false,
      }),
      { limit: 10 },
    ).items.map((i) => [i.kind, i.band, Number(i.target.split("/").pop())]);
    expect(ranked).toEqual([
      ["pr-follow-up", 2, 11],
      ["decide", 3, 5],
      ["design-review", 3, 10],
    ]);
  });

  it("dedupes by stable ID and counts omissions after ranking", () => {
    const facts = [
      fact(1, "implement"),
      fact(1, "implement"),
      fact(1, "estimate-complexity"),
      fact(2, "implement"),
    ];
    const ranked = rankActions(facts, { limit: 1 });
    expect(ranked).toMatchObject({ policyVersion: 1, total: 3, omitted: 2 });
    expect(ranked.items[0]).toMatchObject({
      id: `${repo} ${url(1)} estimate-complexity`,
      band: 5,
    });
    expect(
      rankActions(
        [
          fact(1, "inspect-assessment", unassessed, unassessed, {
            nextCommand: null,
            inspection: "why",
          }),
        ],
        { limit: 1 },
      ).items[0],
    ).toMatchObject({ nextCommand: null, inspection: "why" });
  });
});

// ---- Integration through the real collector with a fake GraphQL boundary ----

const page = <T>(nodes: T[], more = false): Page<T> => ({
  nodes,
  pageInfo: { hasNextPage: more, endCursor: more ? "next" : null },
});
const issue = (n: number, labels: string[], createdAt = time): Issue => ({
  number: n,
  title: `Ticket ${n}`,
  body: "",
  url: url(n),
  state: "OPEN",
  stateReason: null,
  createdAt,
  updatedAt: time,
  issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
  blockedBy: page([]),
  blocking: page([]),
  labels: page(labels.map((name) => ({ name }))),
  comments: page([]),
});
/** Hand-set labels (no provenance) read as `current` with "no recorded rationale". */
const fixture = (): Issue[] => [
  issue(1, ["status:ready", "impact:L", "complexity:S"], "2026-11-01T00:00:00Z"),
  issue(2, ["status:ready", "impact:XS", "complexity:XL"], "2026-10-01T00:00:00Z"),
  issue(3, ["status:ready", "impact:M", "complexity:M"], "2026-11-02T00:00:00Z"),
  issue(4, ["status:ready", "impact:XL"], "2026-11-03T00:00:00Z"),
  issue(5, ["status:needs-design", "complexity:XS"], "2026-11-04T00:00:00Z"),
  issue(6, ["status:ready", "complexity:S", "complexity:L"], "2026-11-05T00:00:00Z"),
  {
    ...issue(7, ["status:ready", "impact:XL"], "2026-11-06T00:00:00Z"),
    issueDependenciesSummary: { blockedBy: 1, totalBlockedBy: 1, blocking: 0, totalBlocking: 0 },
    blockedBy: page([
      {
        number: 3,
        title: "Ticket 3",
        url: url(3),
        state: "OPEN",
        repository: { nameWithOwner: repo },
        issueDependenciesSummary: {
          blockedBy: 0,
          totalBlockedBy: 0,
          blocking: 1,
          totalBlocking: 1,
        },
      },
    ]),
  },
  issue(8, ["status:ready", "agent:other", "impact:S"], "2026-11-07T00:00:00Z"),
  issue(9, ["status:parked", "impact:XL"], "2026-11-08T00:00:00Z"),
];
const queryFor =
  (issues: () => Issue[]): Query =>
  async (source) => ({
    repository: {
      issues: page(source.includes("issues(first") ? issues() : []),
      pullRequests: page([]),
    },
  });
const root = "/repo";
const files = (config: string | null = null): ConfigFileSystem => ({
  readText: async (file) => (config && file === join(root, TOML_CONFIG_PATH) ? config : null),
  writeText: async () => undefined,
  rename: async () => undefined,
  remove: async () => undefined,
  makeDirectory: async () => undefined,
});
const git: GitRunner = async (args) =>
  args[0] === "rev-parse" ? `${root}\n` : `origin\thttps://github.com/${repo}.git (fetch)\n`;
const estimation = (config: string | null = null) => ({ fs: files(config), git, cwd: root });

async function present(
  role: "implementer" | "designer" | undefined,
  extra: {
    order?: "impact" | "oldest";
    limit?: number;
    config?: string;
    estimate?: boolean;
    issues?: () => Issue[];
  } = {},
) {
  const snapshot = await collect(repo, {}, queryFor(extra.issues ?? fixture), () => new Date(time));
  const options = {
    limit: extra.limit ?? 20,
    maxChars: 20000,
    agent: "me",
    engineSetting: { requested: "typescript" as const, source: "config" as const },
    ...(role ? { role } : {}),
    ...(extra.order ? { order: extra.order } : {}),
    ...(extra.estimate ? { estimate: true } : {}),
  };
  const presented = await presentBriefing(
    snapshot,
    options,
    estimation(extra.config ?? null),
    new Date(time),
  );
  return { snapshot, options, report: presented.report as CompactBriefing, text: presented.text };
}
const items = (report: CompactBriefing) =>
  (report.rankedActions?.items ?? []).map((i) => `${i.kind}#${Number(i.target.split("/").pop())}`);

describe("rankedActions through collect() (#248)", () => {
  it("blends the implementer queue: easy win, boosted estimate, assessments, ordinary, unfavorable", async () => {
    const { report } = await present("implementer");
    expect(items(report)).toEqual([
      "implement#1",
      "estimate-complexity#4",
      "estimate-complexity#7",
      "inspect-assessment#6",
      "estimate-complexity#8",
      "implement#3",
      "implement#4",
      "implement#6",
      "inspect#7",
      "implement#2",
    ]);
    const ranked = report.rankedActions!;
    expect(ranked.policyVersion).toBe(1);
    expect(ranked.items[0]).toMatchObject({
      band: 4,
      reasonCodes: ["easy-win", "impact-current", "complexity-current"],
      impact: { state: "current", size: "L" },
      complexity: { state: "current", size: "S" },
      nextCommand: `pdb claim 1 --repo ${repo} --agent me`,
    });
    // A blocked ticket (#7) may be assessed but is never implementation pickup; another agent's
    // claim (#8) can be estimated (no claim) but never picked up; parked work (#9) is absent; a
    // current small complexity (#5) needs no estimate.
    expect(items(report)).not.toContain("implement#7");
    expect(items(report)).not.toContain("implement#8");
    expect(items(report).some((i) => i.endsWith("#9") || i === "estimate-complexity#5")).toBe(
      false,
    );
    const inspect = ranked.items.find((i) => i.kind === "inspect-assessment");
    // #259: the implementer's complexity inspection carries the Ticket Doctor fix as its command.
    expect(inspect).toMatchObject({
      band: 5,
      nextCommand: `pdb estimate 6 --metric complexity --size SIZE --rationale TEXT --repo ${repo}`,
      inspection: null,
    });
    expect(ranked.items.at(-1)).toMatchObject({
      band: 7,
      reasonCodes: expect.arrayContaining(["unfavorable"]),
    });
  });

  it("blends the designer queue with boosted impact assessment above new design work", async () => {
    const { report } = await present("designer");
    const kinds = items(report);
    expect(kinds[0]).toBe("assess-impact#5");
    expect(report.rankedActions?.items[0]?.reasonCodes).toContain("cross-role-boost");
    expect(kinds.indexOf("design#5")).toBeGreaterThan(kinds.indexOf("assess-impact#6"));
    expect(kinds.some((k) => k.startsWith("estimate-complexity"))).toBe(false);
  });

  it("applies limits after ranking and keeps omitted assessments counted", async () => {
    const { report } = await present("implementer", { limit: 2 });
    expect(report.rankedActions).toMatchObject({ total: 10, omitted: 8 });
    expect(items(report)).toEqual(["implement#1", "estimate-complexity#4"]);
  });

  it("coalesces pickup by age under explicit oldest", async () => {
    const { report } = await present("implementer", { order: "oldest" });
    const implement = items(report).filter((k) => k.startsWith("implement"));
    expect(implement).toEqual([
      "implement#2",
      "implement#1",
      "implement#3",
      "implement#4",
      "implement#6",
    ]);
  });

  it("suppresses only the disabled metric's assessments and value bands", async () => {
    const { report } = await present("implementer", {
      config: "schemaVersion = 1\n[complexity]\nenabled = false\n",
    });
    expect(items(report).some((k) => k.startsWith("estimate-complexity"))).toBe(false);
    expect(report.rankedActions?.items.every((i) => i.band === 6)).toBe(true);
    expect(items(report)).toContain("implement#1");
  });

  it("is absent without a role", async () => {
    const { report } = await present(undefined);
    expect(report.rankedActions).toBeNull();
  });
});

/** First-occurrence targets of the ranked queue: the legacy projection (#259). */
const projection = (report: CompactBriefing): string[] => [
  ...new Set((report.rankedActions?.items ?? []).map((i) => i.target)),
];

describe("legacy projections follow the blended ranking (#259)", () => {
  for (const role of ["implementer", "designer"] as const)
    for (const order of ["impact", "oldest"] as const)
      it(`projects actions and role.next from rankedActions for ${role} (${order})`, async () => {
        const { snapshot, options, report } = await present(role, { order });
        // The pre-#248 pipeline: no assessments, so no blended ranking at all.
        const input = await collectLabelEstimationInput(repo, estimation());
        const wide = { ...options, estimation: input, limit: 2000 };
        const legacy = compactBriefing(snapshot, options, briefing(snapshot, wide, new Date(time)));
        expect(legacy.rankedActions).toBeNull();
        // Deliberate change: target-only, each target once, in blended order.
        const targets = projection(report);
        expect(report.actions).toEqual({ total: targets.length, omitted: 0, items: targets });
        expect(report.role?.next.map((r) => r.url)).toEqual(targets);
        expect(report.role?.next.every((r) => typeof r.reason === "string" && r.reason)).toBe(true);
        expect(JSON.stringify(report.actions)).not.toBe(JSON.stringify(legacy.actions));
        // Unchanged: the role sections, the non-role section lists and the ranking metadata.
        for (const key of ["sections", "ranking"] as const)
          expect(JSON.stringify(report[key])).toBe(JSON.stringify(legacy[key]));
        expect(JSON.stringify(report.role?.sections)).toBe(JSON.stringify(legacy.role?.sections));
      });

  it("bounds the projection by --limit after ranking, with repeated targets once", async () => {
    const { report } = await present("implementer", { limit: 3 });
    // Ranked: implement#1, estimate#4, estimate#7, ... implement#4 later repeats #4.
    expect(report.actions.items).toEqual([url(1), url(4), url(7)]);
    // Ten ranked actions on seven distinct targets: 1, 4, 7, 6, 8, 3, 2.
    expect(report.actions).toMatchObject({ total: 7, omitted: 4 });
    expect(report.role?.next.map((r) => r.url)).toEqual(report.actions.items);
    // A target no role section placed (another agent's claim) explains itself by its ranked action.
    expect(
      (await present("implementer")).report.role?.next.find((r) => r.url === url(8))?.reason,
    ).toContain("estimate-complexity");
  });

  it("leaves the non-role briefing on its previous order", async () => {
    const { snapshot, options, report } = await present(undefined);
    const input = await collectLabelEstimationInput(repo, estimation());
    const wide = { ...options, estimation: input, limit: 2000 };
    const legacy = compactBriefing(snapshot, options, briefing(snapshot, wide, new Date(time)));
    for (const key of ["actions", "role", "sections", "estimation"] as const)
      expect(JSON.stringify(report[key])).toBe(JSON.stringify(legacy[key]));
  });
});

describe("implementer estimation counts and NEXT STEPS (#259)", () => {
  it("counts eligible, ranked and shown estimates; offered survives truncation", async () => {
    const { report } = await present("implementer", { limit: 2 });
    // #2, #3, #5 and #6 have complexity; #1 too; #4, #7, #8, #9 are unassessed.
    expect(report.estimation).toMatchObject({
      requested: false,
      offered: true,
      eligible: 4,
      ranked: 3,
      shown: 1,
    });
    const none = await present("implementer", { limit: 0 });
    expect(none.report.estimation).toMatchObject({ offered: true, ranked: 3, shown: 0 });
  });

  it("renders the ranked queue as NEXT STEPS with kinds, reasons and commands", async () => {
    const { text, report } = await present("implementer", { limit: 3 });
    const steps = text.slice(text.indexOf("NEXT STEPS"));
    expect(steps).toMatch(/^NEXT STEPS \(10; 7 omitted\)/);
    expect(steps).toContain("— implement (easy-win, impact-current, complexity-current)");
    expect(steps).toContain("— estimate-complexity (assessment, cross-role-boost");
    expect(steps).toContain(
      `Next: pdb estimate 4 --metric complexity --size SIZE --rationale TEXT --repo ${repo}`,
    );
    expect(steps).toContain(
      "- Complexity assessment: 4 eligible, 3 ranked, 2 shown; 1 conflicting.",
    );
    expect(text).not.toContain("estimation is offered below");
    expect(text).toContain("ESTIMATION (detail; estimates are ranked in NEXT STEPS)");
    expect(report.rankedActions?.items).toHaveLength(3);
  });

  it("keeps --estimate as the focused view first", async () => {
    const { text, report } = await present("implementer", { estimate: true });
    expect(report.estimation).toMatchObject({ requested: true, offered: true });
    expect(text.indexOf("ESTIMATION (requested)")).toBeLessThan(text.indexOf("NEXT STEPS"));
  });

  it("hides the complexity counts and offers nothing when complexity is disabled", async () => {
    const { text, report } = await present("implementer", {
      config: "schemaVersion = 1\n[complexity]\nenabled = false\n",
    });
    expect(report.estimation).toMatchObject({ status: "disabled", offered: false, ranked: 0 });
    expect(text).not.toContain("Complexity assessment:");
    expect(report.actions.items).toContain(url(1));
  });

  it("treats truncated labels as unknown: never an estimate, an easy win or a count", async () => {
    const issues = () => [
      ...fixture().filter((i) => i.number !== 1),
      {
        ...issue(1, ["status:ready", "impact:L"], "2026-11-01T00:00:00Z"),
        labels: page([{ name: "status:ready" }, { name: "impact:L" }], true),
      },
    ];
    const { report } = await present("implementer", { issues });
    const one = report.rankedActions?.items.filter((i) => i.target === url(1)) ?? [];
    expect(one.map((i) => i.kind)).not.toContain("estimate-complexity");
    expect(one.every((i) => i.band !== 4)).toBe(true);
    // Unchanged from the fixture: #4, #7, #8 and parked #9 eligible; #1 is neither.
    expect(report.estimation).toMatchObject({ eligible: 4, ranked: 3 });
  });

  it("keeps an own claim visible and hands off before another pickup", async () => {
    const issues = () => [
      ...fixture().filter((i) => i.number !== 3),
      issue(3, ["status:ready", "agent:me", "impact:M", "complexity:M"], "2026-11-02T00:00:00Z"),
    ];
    const { report } = await present("implementer", { issues });
    const own = report.rankedActions?.items.find((i) => i.target === url(3));
    expect(own).toMatchObject({ kind: "continue-implementation", band: 6 });
    expect(own?.reasonCodes).toContain("own-claim");
    const easy = report.rankedActions?.items[0];
    expect(easy).toMatchObject({
      kind: "implement",
      target: url(1),
      nextCommand: `pdb release 3 --repo ${repo} --agent me --as incomplete --note TEXT`,
      thenCommand: `pdb claim 1 --repo ${repo} --agent me`,
    });
    expect(report.actions.items).toContain(url(3));
  });
});

describe("generated commands are runnable for the viewer (#248 review)", () => {
  const repo = "o/r";
  const subject = (n: number, labels: string[] = []) => ({
    url: `https://github.com/${repo}/issues/${n}`,
    number: n,
    state: "OPEN",
    createdAt: "2026-01-01T00:00:00Z",
    labels,
    isIssue: true,
  });
  const input = (
    subjects: ReturnType<typeof subject>[],
    owned: number[],
    extra: { platform?: string } = {},
  ) => ({
    repository: repo,
    role: "implementer" as const,
    agent: "me",
    ...extra,
    sections: [{ name: "pickup", background: false, rows: [{ url: subjects[0].url }] }],
    subjects: new Map(subjects.map((s) => [s.url, s])),
    assessments: new Map(),
    isAddressed: () => false,
    isParked: () => false,
    urgency: () => 1 as const,
    ownedByViewer: (url: string) => owned.some((n) => url.endsWith(`/issues/${n}`)),
  });
  const implement = (i: ReturnType<typeof input>) =>
    rankActions(roleCandidates(i), { limit: 10 }).items.find((a) => a.kind === "implement")!;

  it("carries --platform into a platform-restricted claim", () => {
    const a = implement(
      input([subject(7, ["platform:claude-code"])], [], { platform: "claude-code" }),
    );
    expect(a.nextCommand).toBe(`pdb claim 7 --repo ${repo} --agent me --platform claude-code`);
  });

  it("omits --platform for an unrestricted ticket", () => {
    const a = implement(input([subject(7)], [], { platform: "claude-code" }));
    expect(a.nextCommand).toBe(`pdb claim 7 --repo ${repo} --agent me`);
  });

  it("shows the release handoff before claiming a second implementation", () => {
    const a = implement(input([subject(7), subject(3)], [3]));
    expect(a.nextCommand).toBe(
      `pdb release 3 --repo ${repo} --agent me --as incomplete --note TEXT`,
    );
    expect(a.thenCommand).toBe(`pdb claim 7 --repo ${repo} --agent me`);
    expect(a.reasonCodes).toContain("release-active-claim-first");
  });

  it("offers no command, only the restriction, with several active claims", () => {
    const a = implement(input([subject(7), subject(3), subject(4)], [3, 4]));
    expect(a.nextCommand).toBeNull();
    expect(a.inspection).toContain("one active claim per agent");
  });
});
