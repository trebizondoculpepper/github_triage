/**
 * #245: impact estimates recorded and read through the shared estimation mechanics
 * (doc/design/impact-estimation.md). Injected gh GraphQL, clock, filesystem, git and trust;
 * no live mutations.
 */
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { readAssessment } from "./assessments.js";
import type { AssessmentSubject } from "./assessments.js";
import type { Comment } from "./claims.js";
import {
  classifyMetricLabels,
  metricLabelFindings,
  suggestedMetricSize,
  suggestedSize,
} from "./complexitylabels.js";
import { CONFIG_KEYS, TOML_CONFIG_PATH, loadConfig } from "./config.js";
import type { ConfigFileSystem, GitRunner } from "./config.js";
import type { TrustDecision } from "./delivery.js";
import {
  parseImpactProvenance,
  parseLabelProvenance,
  parseMetricProvenance,
  provenanceComment,
  runEstimate,
} from "./estimate.js";
import type { ImpactEstimateProvenance, MetricProvenance } from "./estimate.js";
import { impactGuidance } from "./impact.js";
import { IMPACT_LABEL_COLOR, METRICS, complexityMetric, impactMetric } from "./metrics.js";
import { ticketDoctor } from "./ticketdoctor.js";
import type { Issue, Snapshot } from "./types.js";

const sha = "a".repeat(40);
const NOW = "2026-11-13T12:00:00.000Z";
type Answer = { data: unknown; errors: { type?: string; message?: string }[] };
type Label = { id: string; name: string };
type RemoteComment = Comment & { url?: string };

const trusted: RemoteComment["author"] = { __typename: "User", login: "maintainer" };
const comment = (body: string, author = trusted): RemoteComment => ({
  body,
  createdAt: NOW,
  author,
  lastEditedAt: null,
  includesCreatedEdit: false,
  editor: null,
});
/** Trust by login: maintainer trusted, bot untrusted, anyone else unknown. */
const trust: TrustDecision = async (c) =>
  c.author?.login === "maintainer"
    ? { status: "trusted" }
    : c.author?.login === "bot"
      ? { status: "untrusted", why: "author bot is an app or bot account" }
      : { status: "unknown", why: "permission could not be verified" };

const impactRecord = (over: Partial<ImpactEstimateProvenance> = {}): ImpactEstimateProvenance => ({
  schemaVersion: 1,
  kind: "impact-estimate",
  storage: "labels",
  size: "L",
  previous: [],
  rationale: "core workflow for most users",
  assumptions: [],
  references: [],
  estimator: null,
  revision: null,
  guidanceVersion: impactGuidance.guidanceVersion,
  recordedAt: "2026-11-13T11:00:00.000Z",
  ...over,
});

function harness(
  options: {
    config?: string;
    labels?: string[];
    repoLabels?: string[];
    comments?: RemoteComment[];
    edited?: string | null;
    truncated?: boolean;
    createFails?: "denied" | "race";
    failAdd?: boolean;
    failComment?: boolean;
    trust?: TrustDecision;
  } = {},
) {
  const files = new Map<string, string>();
  if (options.config) files.set(join("/repo", TOML_CONFIG_PATH), options.config);
  const fs: ConfigFileSystem = {
    readText: async (file) => files.get(file) ?? null,
    writeText: async () => {
      throw new Error("estimate must not write config");
    },
    rename: async () => undefined,
    remove: async () => undefined,
    makeDirectory: async () => undefined,
  };
  const git: GitRunner = async (args) =>
    args[0] === "rev-parse"
      ? args[1] === "HEAD"
        ? `${sha}\n`
        : "/repo\n"
      : "origin\thttps://github.com/owner/name.git (fetch)\n";
  let ids = 0;
  const definitions = new Map<string, Label>();
  const define = (name: string): Label => {
    const known = definitions.get(name.toLowerCase());
    if (known) return known;
    const created = { id: `LA_${(ids += 1)}`, name };
    definitions.set(name.toLowerCase(), created);
    return created;
  };
  for (const name of options.repoLabels ?? []) define(name);
  const remote = {
    labels: (options.labels ?? ["bug"]).map(define),
    comments: [...(options.comments ?? [])],
  };
  const queries: string[] = [];
  const mutations: { query: string; vars: Record<string, string> }[] = [];
  const trustCalls: string[] = [];
  const ok = (data: unknown): Answer => ({ data, errors: [] });
  const out: string[] = [];
  const call = (...args: string[]) =>
    runEstimate(["7", ...args], async (t) => void out.push(t), {
      fs,
      git,
      cwd: "/repo",
      now: () => new Date(NOW),
      trust: (repository) => async (c) => {
        expect(repository).toBe("owner/name");
        trustCalls.push(c.author?.login ?? "?");
        return (options.trust ?? trust)(c);
      },
      api: {
        query: async (query, vars) => {
          queries.push(query);
          return {
            data: {
              repository: {
                id: "R_1",
                label: definitions.get(vars.label!.toLowerCase()) ?? null,
                issue: {
                  id: "I_7",
                  state: "OPEN",
                  lastEditedAt: options.edited ?? null,
                  labels: {
                    pageInfo: { hasNextPage: !!options.truncated },
                    nodes: [...remote.labels],
                  },
                  comments: {
                    pageInfo: { hasPreviousPage: false, startCursor: "0" },
                    nodes: [...remote.comments],
                  },
                },
              },
            },
            errors: [],
          };
        },
        mutate: async (query, vars) => {
          mutations.push({ query, vars });
          if (query.includes("createLabel")) {
            if (options.createFails === "denied")
              return { data: null, errors: [{ type: "FORBIDDEN", message: "no write" }] };
            const label = define(vars.name!);
            if (options.createFails === "race")
              return { data: null, errors: [{ message: "Name has already been taken" }] };
            return ok({ createLabel: { label } });
          }
          if (query.includes("addLabelsToLabelable")) {
            if (options.failAdd)
              return { data: null, errors: [{ type: "FORBIDDEN", message: "no" }] };
            remote.labels.push([...definitions.values()].find((l) => l.id === vars.label)!);
            return ok({ addLabelsToLabelable: { clientMutationId: null } });
          }
          if (query.includes("removeLabelsFromLabelable")) {
            remote.labels = remote.labels.filter((l) => l.id !== vars.label);
            return ok({ removeLabelsFromLabelable: { clientMutationId: null } });
          }
          if (options.failComment) throw new Error("network down");
          remote.comments.push(comment(vars.body!));
          return ok({
            addComment: { commentEdge: { node: { url: `https://c/${remote.comments.length}` } } },
          });
        },
      },
    });
  const kinds = () =>
    mutations.map(
      (m) =>
        m.query.match(
          /(createLabel|addLabelsToLabelable|removeLabelsFromLabelable|addComment)/,
        )![1],
    );
  return {
    options,
    remote,
    names: () => remote.labels.map((l) => l.name),
    queries,
    mutations,
    kinds,
    trustCalls,
    call,
    out,
    json: () => JSON.parse(out.at(-1)!),
  };
}

const impactArgs = [
  "--metric",
  "impact",
  "--size",
  "L",
  "--rationale",
  "core workflow for most users",
];

describe("metric descriptor (#245)", () => {
  it("registers exactly complexity and impact", () => {
    expect(Object.keys(METRICS)).toEqual(["complexity", "impact"]);
    expect(impactMetric).toMatchObject({
      labelPrefix: "impact:",
      marker: "github-triage:impact-estimate v1",
      provenanceKind: "impact-estimate",
      provenanceSchemaVersion: 1,
      enabledKey: "impact.enabled",
      guidance: { guidanceVersion: 1 },
    });
    expect(IMPACT_LABEL_COLOR).not.toBe(complexityMetric.labelColor);
    expect(impactGuidance.sizes).toEqual(["XS", "S", "M", "L", "XL", "XXL"]);
    expect(impactGuidance.bands.map((b) => b.size)).toEqual(impactGuidance.sizes);
  });
  it("classifies impact labels case-insensitively and ignores other prefixes", () => {
    const labels = (names: string[], more = false) => ({
      labels: {
        nodes: names.map((name) => ({ name })),
        pageInfo: { hasNextPage: more, endCursor: null },
      },
    });
    expect(classifyMetricLabels(impactMetric, labels(["Impact:l", "complexity:S"]))).toMatchObject({
      state: "estimated",
      size: "L",
    });
    expect(classifyMetricLabels(impactMetric, labels(["complexity:S"])).state).toBe("unestimated");
    expect(classifyMetricLabels(impactMetric, labels(["impact:S", "impact:L"])).state).toBe(
      "conflicting",
    );
    expect(classifyMetricLabels(impactMetric, labels([], true)).state).toBe("unknown");
    expect(classifyMetricLabels(complexityMetric, labels(["impact:huge"])).state).toBe(
      "unestimated",
    );
  });
  it("suggests low -> S and high -> L for impact only, plus the shared table", () => {
    expect(suggestedMetricSize(impactMetric, "impact:high")).toBe("L");
    expect(suggestedMetricSize(impactMetric, "impact:LOW")).toBe("S");
    expect(suggestedMetricSize(impactMetric, "impact:tiny")).toBe("XS");
    expect(suggestedMetricSize(impactMetric, "impact:massive")).toBe("XXL");
    expect(suggestedMetricSize(impactMetric, "impact:foo")).toBeNull();
    expect(suggestedSize("complexity:high")).toBeNull();
    expect(suggestedSize("complexity:low")).toBeNull();
  });
  it("registers impact.enabled defaulting to true beside complexity.enabled", async () => {
    expect(CONFIG_KEYS.find((k) => k.key === "impact.enabled")).toMatchObject({
      type: "boolean",
      defaultValue: true,
    });
    const fs: ConfigFileSystem = {
      readText: async (file) =>
        file.endsWith("triage.toml") ? "schemaVersion = 1\n[impact]\nenabled = false\n" : null,
      writeText: async () => undefined,
      rename: async () => undefined,
      remove: async () => undefined,
      makeDirectory: async () => undefined,
    };
    const config = await loadConfig("/repo", fs);
    expect(config.settings).toContainEqual({
      key: "impact.enabled",
      value: false,
      source: "explicit",
    });
    expect(config.settings).toContainEqual({
      key: "complexity.enabled",
      value: true,
      source: "default",
    });
  });
});

describe("impact provenance v1 (#245)", () => {
  it("round-trips and is metric-exclusive", () => {
    const body = provenanceComment(impactRecord({ previous: ["S"] }));
    expect(body.startsWith("<!-- github-triage:impact-estimate v1 {")).toBe(true);
    expect(body).toContain("**Impact estimate: L** (was S)");
    expect(body).toContain(
      "The label impact:L is the current benefit estimate; this comment records why. Estimating does not claim, unblock or re-rank this ticket.",
    );
    expect(parseImpactProvenance(body)).toMatchObject({ kind: "impact-estimate", size: "L" });
    expect(parseLabelProvenance(body)).toBeNull();
    const complexity = provenanceComment({
      ...impactRecord(),
      schemaVersion: 2,
      kind: "complexity-estimate",
    });
    expect(parseImpactProvenance(complexity)).toBeNull();
    expect(parseLabelProvenance(complexity)).toMatchObject({ kind: "complexity-estimate" });
  });
  it("ignores malformed payloads and unknown schema versions", () => {
    const body = provenanceComment(impactRecord());
    expect(
      parseImpactProvenance(body.replace('"schemaVersion":1', '"schemaVersion":2')),
    ).toBeNull();
    expect(
      parseImpactProvenance(body.replace("impact-estimate v1", "impact-estimate v2")),
    ).toBeNull();
    expect(parseImpactProvenance("<!-- github-triage:impact-estimate v1 {nope} -->")).toBeNull();
    expect(
      parseMetricProvenance(impactMetric, body.replace('"size":"L"', '"size":"Q"')),
    ).toBeNull();
  });
  it("rejects impact provenance with a missing or invalid recordedAt or required field", () => {
    const { recordedAt: _omit, ...withoutTime } = impactRecord();
    const malformed = [
      withoutTime,
      { ...impactRecord(), recordedAt: "not a date" },
      { ...impactRecord(), recordedAt: "2026-13-45T99:99:99Z" },
      { ...impactRecord(), recordedAt: 1_700_000_000_000 },
      { ...impactRecord(), guidanceVersion: "1" },
      { ...impactRecord(), estimator: 7 },
      { ...impactRecord(), revision: undefined },
      { ...impactRecord(), replacedInvalid: [1] },
    ];
    for (const value of malformed)
      expect(
        parseImpactProvenance(provenanceComment(value as unknown as MetricProvenance)),
      ).toBeNull();
    // Complexity keeps its byte-compatible behaviour: no new timestamp validation (#245).
    expect(
      parseLabelProvenance(
        provenanceComment({
          ...impactRecord(),
          schemaVersion: 2,
          kind: "complexity-estimate",
          recordedAt: "not a date",
        } as MetricProvenance),
      ),
    ).not.toBeNull();
  });
});

describe("estimate --metric impact records and revises (#245)", () => {
  it("records impact:L over impact:S, keeps complexity and unrelated labels, and retries idempotently", async () => {
    const t = harness({ labels: ["bug", "complexity:M", "impact:S"] });
    expect(await t.call(...impactArgs, "--agent", "dana", "--json")).toBe(0);
    expect(t.json()).toMatchObject({
      schemaVersion: 1,
      kind: "impact-estimate",
      status: "recorded",
      label: "impact:L",
      previous: ["S"],
      labelCreated: true,
      labelsAdded: ["impact:L"],
      labelsRemoved: ["impact:S"],
      provenanceWritten: true,
      provenance: {
        schemaVersion: 1,
        kind: "impact-estimate",
        size: "L",
        previous: ["S"],
        estimator: "dana",
        revision: sha,
        guidanceVersion: 1,
        recordedAt: NOW,
      },
    });
    expect(t.json().boundaries).toContain("Only impact size labels");
    expect(t.names()).toEqual(["bug", "complexity:M", "impact:L"]);
    expect(t.kinds()).toEqual([
      "createLabel",
      "addLabelsToLabelable",
      "removeLabelsFromLabelable",
      "addComment",
    ]);
    expect(t.mutations[0]!.vars).toMatchObject({
      name: "impact:L",
      color: IMPACT_LABEL_COLOR,
      description: "Impact estimate L (github-triage estimate)",
    });
    // Impact reads comment authority and the description edit time.
    expect(t.queries[0]).toContain("author { __typename login }");
    expect(t.queries[0]).toContain("lastEditedAt");
    expect(t.remote.comments).toHaveLength(1);
    expect(parseImpactProvenance(t.remote.comments[0]!.body)?.size).toBe("L");

    t.mutations.length = 0;
    expect(await t.call(...impactArgs, "--agent", "dana", "--json")).toBe(0);
    expect(t.json().status).toBe("unchanged");
    expect(t.json().provenance.recordedAt).toBe(NOW);
    expect(t.mutations).toEqual([]);
    expect(t.remote.comments).toHaveLength(1);
  });
  it("re-records instead of reporting unchanged when the stored recordedAt is invalid", async () => {
    const t = harness({ labels: ["impact:S"], edited: "2026-11-14T00:00:00.000Z" });
    expect(await t.call(...impactArgs, "--agent", "dana", "--json")).toBe(0);
    expect(t.remote.comments).toHaveLength(1);
    const c = t.remote.comments[0]!;
    c.body = c.body.replace(
      `"recordedAt":"${NOW.replace(/-/g, "\\u002d")}"`,
      '"recordedAt":"garbage"',
    );
    expect(c.body).toContain('"recordedAt":"garbage"');
    expect(await t.call(...impactArgs, "--agent", "dana", "--json")).toBe(0);
    expect(t.json().status).not.toBe("unchanged");
    expect(t.remote.comments).toHaveLength(2);
  });
  it("text output names the metric and the unassessed state", async () => {
    const t = harness();
    expect(await t.call(...impactArgs)).toBe(0);
    expect(t.out.at(-1)).toBe(
      "Impact estimate for owner/name#7: unassessed -> L\nCreated repository label impact:L.\nLabels: +impact:L.\nProvenance: https://c/1\nStatus: recorded\n",
    );
  });
  it("reports a failed comment as partial, and the retry adds only the comment", async () => {
    const t = harness({ labels: ["impact:S"], repoLabels: ["impact:L"], failComment: true });
    expect(await t.call(...impactArgs, "--json")).toBe(2);
    expect(t.json()).toMatchObject({ status: "partial", provenanceWritten: false });
    expect(t.names()).toEqual(["impact:L"]);
    t.options.failComment = false;
    t.mutations.length = 0;
    expect(await t.call(...impactArgs, "--replace", "S", "--json")).toBe(0);
    expect(t.kinds()).toEqual(["addComment"]);
    expect(t.json().provenance.previous).toEqual(["S"]);
    expect(t.remote.comments).toHaveLength(1);
  });
  it("refuses impact:high without --replace-invalid and records it as replaced with the flag", async () => {
    const t = harness({ labels: ["impact:high", "complexity:huge"] });
    expect(await t.call(...impactArgs, "--json")).toBe(1);
    expect(t.json()).toMatchObject({ status: "refused:unrecognized", code: "unrecognized-label" });
    expect(t.json().message).toContain("unrecognized impact label(s) impact:high");
    expect(t.json().recovery).toContain("--replace-invalid");
    expect(t.mutations).toEqual([]);

    expect(await t.call(...impactArgs, "--replace-invalid", "--json")).toBe(0);
    expect(t.json()).toMatchObject({
      status: "recorded",
      replacedInvalid: ["impact:high"],
      provenance: { replacedInvalid: ["impact:high"] },
    });
    // Cross-metric isolation: an invalid complexity label is neither refused nor removed.
    expect(t.names()).toEqual(["complexity:huge", "impact:L"]);
    // Replaced labels are not part of retry identity: the same command is now unchanged.
    expect(await t.call(...impactArgs, "--replace-invalid", "--json")).toBe(0);
    expect(t.json().status).toBe("unchanged");
    expect(t.remote.comments).toHaveLength(1);
  });
  it("a complexity write never touches impact labels, and it reads no comment authority", async () => {
    const t = harness({ labels: ["impact:S", "impact:bogus", "complexity:L"] });
    expect(await t.call("--size", "M", "--rationale", "few modules", "--json")).toBe(0);
    expect(t.json()).toMatchObject({ kind: "complexity-estimate", schemaVersion: 2 });
    expect(t.names()).toEqual(["impact:S", "impact:bogus", "complexity:M"]);
    expect(t.trustCalls).toEqual([]);
    expect(t.queries[0]).not.toContain("__typename");
  });
  it("re-records an identical stale record (old guidance version), then retries unchanged", async () => {
    const old = comment(provenanceComment(impactRecord({ guidanceVersion: 0 })));
    const t = harness({ labels: ["impact:L"], comments: [old] });
    expect(await t.call(...impactArgs, "--json")).toBe(0);
    expect(t.json().status).toBe("recorded");
    expect(t.kinds()).toEqual(["addComment"]);
    expect(t.json().provenance).toMatchObject({ guidanceVersion: 1, recordedAt: NOW });
    expect(await t.call(...impactArgs, "--json")).toBe(0);
    expect(t.json().status).toBe("unchanged");
    expect(t.remote.comments).toHaveLength(2);
  });
  it("re-records an identical record when the description was edited after it", async () => {
    const old = comment(provenanceComment(impactRecord()));
    const t = harness({
      labels: ["impact:L"],
      comments: [old],
      edited: "2026-11-13T11:30:00.000Z",
    });
    expect(await t.call(...impactArgs, "--json")).toBe(0);
    expect(t.json().status).toBe("recorded");
    expect(t.remote.comments).toHaveLength(2);
    // The fresh record (12:00) is later than the edit (11:30): no longer stale.
    expect(await t.call(...impactArgs, "--json")).toBe(0);
    expect(t.json().status).toBe("unchanged");
  });
  it("an identical current record from a trusted author is unchanged", async () => {
    const t = harness({
      labels: ["impact:L"],
      comments: [comment(provenanceComment(impactRecord()))],
    });
    expect(await t.call(...impactArgs, "--json")).toBe(0);
    expect(t.json().status).toBe("unchanged");
    expect(t.trustCalls).toEqual(["maintainer"]);
  });
  it("ignores identical provenance from untrusted or unverifiable authors and records afresh", async () => {
    for (const login of ["bot", "stranger"]) {
      const t = harness({
        labels: ["impact:L"],
        comments: [comment(provenanceComment(impactRecord()), { __typename: "User", login })],
      });
      expect(await t.call(...impactArgs, "--json")).toBe(0);
      expect(t.json().status).toBe("recorded");
      expect(t.kinds()).toEqual(["addComment"]);
    }
  });
  it("stops at newer provenance of unknown authority instead of accepting an older trusted record", async () => {
    const stranger = { __typename: "User", login: "stranger" } as const;
    const older = comment(provenanceComment(impactRecord()));
    const newer = comment(provenanceComment(impactRecord()), stranger);
    const reading = await readAssessment(
      impactMetric,
      {
        labels: {
          nodes: [{ name: "impact:L" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
        comments: { nodes: [older, newer], pageInfo: {} },
      },
      { trust },
    );
    expect(reading.state).toBe("unknown");
    const t = harness({ labels: ["impact:L"], comments: [older, newer] });
    expect(await t.call(...impactArgs, "--json")).toBe(0);
    expect(t.json().status).toBe("recorded");
    expect(t.kinds()).toEqual(["addComment"]);
    // A confirmed-untrusted newer marker is skipped: the older trusted record still matches.
    const skipped = harness({
      labels: ["impact:L"],
      comments: [
        older,
        comment(provenanceComment(impactRecord()), { __typename: "User", login: "bot" }),
      ],
    });
    expect(await skipped.call(...impactArgs, "--json")).toBe(0);
    expect(skipped.json().status).toBe("unchanged");
  });
  it("refuses a stale --replace guard", async () => {
    const t = harness({ labels: ["impact:M"] });
    expect(await t.call(...impactArgs, "--replace", "S", "--json")).toBe(1);
    expect(t.json()).toMatchObject({ status: "refused:stale", code: "stale" });
    expect(t.mutations).toEqual([]);
  });
  it("is disabled by impact.enabled = false without affecting complexity", async () => {
    const t = harness({ config: "schemaVersion = 1\n[impact]\nenabled = false\n" });
    expect(await t.call(...impactArgs, "--json")).toBe(2);
    expect(t.json()).toMatchObject({ status: "disabled", code: "disabled" });
    expect(t.json().recovery).toBe("Opt in with: github-triage config set impact.enabled true");
    expect(t.mutations).toEqual([]);
    expect(await t.call("--size", "S", "--rationale", "one module", "--json")).toBe(0);
    expect(t.json().status).toBe("recorded");
  });
  it("reports denied label creation as a failure, and reuses a concurrently created label", async () => {
    const denied = harness({ createFails: "denied" });
    expect(await denied.call(...impactArgs, "--json")).toBe(1);
    expect(denied.json()).toMatchObject({ status: "failed", code: "label-create-denied" });
    expect(denied.json().recovery).toContain("write access");
    expect(denied.kinds()).toEqual(["createLabel"]);
    const race = harness({ createFails: "race" });
    expect(await race.call(...impactArgs, "--json")).toBe(0);
    expect(race.json()).toMatchObject({ status: "recorded", labelCreated: false });
    const addDenied = harness({ repoLabels: ["impact:L"], failAdd: true });
    expect(await addDenied.call(...impactArgs, "--json")).toBe(1);
    expect(addDenied.json()).toMatchObject({ status: "failed", code: "api-denied" });
  });
  it("refuses truncated labels as unknown", async () => {
    const t = harness({ labels: ["impact:S"], truncated: true });
    expect(await t.call(...impactArgs, "--json")).toBe(2);
    expect(t.json()).toMatchObject({ status: "failed:unknown", code: "labels-unavailable" });
    expect(t.mutations).toEqual([]);
  });
  it("rejects an unknown --metric", async () => {
    await expect(
      harness().call("--metric", "risk", "--size", "L", "--rationale", "x"),
    ).rejects.toThrow("--metric must be one of complexity, impact.");
  });
});

describe("complexity estimate output stays byte-compatible (#245 regression)", () => {
  it("emits the same queries, mutations, comment and text as before the metric descriptor", async () => {
    const t = harness({ labels: ["bug", "complexity:S"] });
    const args = ["--size", "M", "--rationale", "r", "--agent", "a", "--assumption", "x"];
    expect(await t.call(...args, "--reference", "#1")).toBe(0);
    expect(t.queries[0]).toBe(
      "query($owner: String!, $name: String!, $label: String!) {\n  repository(owner: $owner, name: $name) { id label(name: $label) { id name }\n    issue(number: 7) { id state labels(first: 100) { pageInfo { hasNextPage } nodes { id name } }\n      comments(last: 100) { pageInfo { hasPreviousPage startCursor } nodes { body } } } } }",
    );
    expect(t.mutations[0]!.vars).toEqual({
      repository: "R_1",
      name: "complexity:M",
      color: "c5def5",
      description: "Complexity estimate M (github-triage estimate)",
    });
    expect(t.remote.comments[0]!.body).toBe(
      '<!-- github-triage:complexity-estimate v2 {"schemaVersion":2,"kind":"complexity\\u002destimate","storage":"labels","size":"M","previous":["S"],"rationale":"r","assumptions":["x"],"references":["#1"],"estimator":"a","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","guidanceVersion":1,"recordedAt":"2026\\u002d11\\u002d13T12:00:00.000Z"} -->\n**Complexity estimate: M** (was S) — recorded with github-triage, guidance version 1.\n\nRationale: r\n\nAssumptions:\n- x\n\nReference anchors: #1\n\nEstimator: a · Revision: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n\nThe label complexity:M is the current size; this comment records why. Estimating does not claim, unblock or re-rank this ticket.',
    );
    expect(t.out.at(-1)).toBe(
      "Complexity estimate for owner/name#7: S -> M\nCreated repository label complexity:M.\nLabels: +complexity:M -complexity:S.\nProvenance: https://c/1\nStatus: recorded\n",
    );
    expect(await t.call(...args, "--reference", "#1", "--json")).toBe(0);
    expect(t.out.at(-1)).toBe(
      '{\n  "schemaVersion": 2,\n  "kind": "complexity-estimate",\n  "issue": 7,\n  "size": "M",\n  "label": "complexity:M",\n  "repository": "owner/name",\n  "previous": [\n    "M"\n  ],\n  "issueState": "OPEN",\n  "provenance": {\n    "schemaVersion": 2,\n    "kind": "complexity-estimate",\n    "storage": "labels",\n    "size": "M",\n    "previous": [\n      "S"\n    ],\n    "rationale": "r",\n    "assumptions": [\n      "x"\n    ],\n    "references": [\n      "#1"\n    ],\n    "estimator": "a",\n    "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",\n    "guidanceVersion": 1,\n    "recordedAt": "2026-11-13T12:00:00.000Z"\n  },\n  "status": "unchanged",\n  "boundaries": "Only complexity size labels and one provenance comment were touched; no claim, blocker, readiness or ranking was changed."\n}\n',
    );
    // --metric complexity is the same as the default.
    expect(await t.call("--metric", "complexity", ...args, "--reference", "#1", "--json")).toBe(0);
    expect(JSON.parse(t.out.at(-1)!).status).toBe("unchanged");
  });
  it("keeps complexity Ticket Doctor findings unchanged", () => {
    const issue = {
      labels: {
        nodes: [{ name: "complexity:huge" }, { name: "complexity:S" }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    };
    expect(metricLabelFindings(complexityMetric, issue)).toEqual([
      {
        kind: "complexity-label-invalid",
        certainty: "definite",
        detail:
          "invalid complexity label(s) complexity:huge (suggested size XL); valid size label(s) also present: complexity:S",
        invalid: ["complexity:huge"],
        valid: ["complexity:S"],
        suggestions: [{ label: "complexity:huge", size: "XL" }],
      },
    ]);
  });
});

describe("trusted-provenance reader (#245)", () => {
  const subject = (
    labels: string[],
    comments: RemoteComment[] = [],
    over: Partial<AssessmentSubject> & {
      truncated?: boolean;
      moreComments?: boolean;
      olderComments?: boolean;
    } = {},
  ): AssessmentSubject => ({
    labels: {
      nodes: labels.map((name) => ({ name })),
      pageInfo: { hasNextPage: !!over.truncated, endCursor: null },
    },
    lastEditedAt: over.lastEditedAt ?? null,
    comments: {
      nodes: comments.map((c, i) => ({ ...c, url: `https://c/${i + 1}` })),
      pageInfo: { hasNextPage: !!over.moreComments, hasPreviousPage: !!over.olderComments },
    },
  });
  const read = (s: AssessmentSubject, enabled = true) =>
    readAssessment(impactMetric, s, { enabled, trust });
  const record = (over: Partial<ImpactEstimateProvenance> = {}, author = trusted) =>
    comment(provenanceComment(impactRecord(over)), author);

  it("current with trusted, agreeing provenance", async () => {
    expect(await read(subject(["impact:L", "complexity:S"], [record()]))).toEqual({
      state: "current",
      size: "L",
      provenance: "https://c/1",
      reasons: [],
    });
  });
  it("current with no recorded rationale for a hand-set label", async () => {
    expect(await read(subject(["impact:L"]))).toMatchObject({
      state: "current",
      size: "L",
      provenance: null,
      reasons: ["no recorded rationale"],
    });
  });
  it("stale when the size differs, the guidance is older or the description was edited later", async () => {
    expect(await read(subject(["impact:M"], [record()]))).toMatchObject({
      state: "stale",
      size: "M",
    });
    expect(await read(subject(["impact:L"], [record({ guidanceVersion: 0 })]))).toMatchObject({
      state: "stale",
    });
    expect(
      await read(subject(["impact:L"], [record()], { lastEditedAt: "2026-11-13T11:30:00.000Z" })),
    ).toMatchObject({ state: "stale", size: "L" });
  });
  it("unassessed, conflict and invalid (invalid takes precedence)", async () => {
    expect((await read(subject(["bug", "complexity:S"]))).state).toBe("unassessed");
    expect(await read(subject(["impact:S", "impact:L"]))).toMatchObject({
      state: "conflict",
      size: null,
    });
    expect((await read(subject(["impact:S", "impact:L", "impact:high"]))).state).toBe("invalid");
  });
  it("unknown for truncated labels, incomplete history or unknown provenance authority", async () => {
    expect((await read(subject(["impact:L"], [], { truncated: true }))).state).toBe("unknown");
    expect((await read(subject(["bug"], [], { truncated: true }))).state).toBe("unknown");
    expect((await read(subject(["impact:L"], [], { moreComments: true }))).state).toBe("unknown");
    const unknown = await read(
      subject(["impact:L"], [record({}, { __typename: "User", login: "stranger" })]),
    );
    expect(unknown).toMatchObject({ state: "unknown", size: null });
    expect(unknown.reasons[0]).toContain("provenance authority unknown");
  });
  it("treats untrusted provenance as no recorded rationale, falling back to older trusted records", async () => {
    const bot = { __typename: "Bot", login: "bot" };
    const untrusted = await read(subject(["impact:L"], [record({ size: "S" }, bot)]));
    expect(untrusted).toMatchObject({ state: "current", size: "L", provenance: null });
    expect(untrusted.reasons).toContain("no recorded rationale");
    const older = await read(subject(["impact:L"], [record(), record({ size: "S" }, bot)]));
    expect(older).toMatchObject({ state: "current", provenance: "https://c/1" });
  });
  it("unknown when newer comments are missing, even with a visible trusted record", async () => {
    const newerMissing = await read(subject(["impact:L"], [record()], { moreComments: true }));
    expect(newerMissing).toMatchObject({ state: "unknown", size: null, provenance: null });
    expect(newerMissing.reasons).toContain("newer comment history incomplete; provenance unknown");
    // Missing older comments cannot hide a newer record: the visible trusted one stands.
    expect(await read(subject(["impact:L"], [record()], { olderComments: true }))).toMatchObject({
      state: "current",
      provenance: "https://c/1",
    });
    expect((await read(subject(["impact:L"], [], { olderComments: true }))).state).toBe("unknown");
  });
  it("never reads a record with an invalid recordedAt as current", async () => {
    const reading = await read(
      subject(["impact:L"], [record({ recordedAt: "garbage" })], {
        lastEditedAt: "2026-11-13T11:30:00.000Z",
      }),
    );
    expect(reading).toMatchObject({ state: "current", provenance: null });
    expect(reading.reasons).toContain("no recorded rationale");
  });
  it("disabled yields disabled and reads nothing", async () => {
    expect(await read(subject(["impact:L"]), false)).toMatchObject({
      state: "disabled",
      size: null,
    });
  });
  it("ignores complexity markers for impact and works for the complexity descriptor too", async () => {
    const complexity = comment(
      provenanceComment({
        ...impactRecord(),
        schemaVersion: 2,
        kind: "complexity-estimate",
      } as MetricProvenance),
    );
    expect(await read(subject(["impact:L"], [complexity]))).toMatchObject({ provenance: null });
    expect(
      await readAssessment(complexityMetric, subject(["complexity:L"], [complexity]), { trust }),
    ).toMatchObject({ state: "current", provenance: "https://c/1" });
  });
});

describe("Ticket Doctor impact findings (#245)", () => {
  const time = "2026-11-13T00:00:00Z";
  const issue = (number: number, labels: string[], truncated = false): Issue =>
    ({
      number,
      title: `Ticket ${number}`,
      body: "",
      url: `https://github.com/owner/name/issues/${number}`,
      state: "OPEN",
      stateReason: null,
      createdAt: time,
      updatedAt: time,
      issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
      blockedBy: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      blocking: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      labels: {
        nodes: labels.map((name) => ({ name })),
        pageInfo: { hasNextPage: truncated, endCursor: null },
      },
      comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    }) as Issue;
  const snapshot = (issues: Issue[]): Snapshot =>
    ({
      schemaVersion: 1,
      repository: "owner/name",
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
  const findings = (issues: Issue[], impactEnabled?: boolean) =>
    ticketDoctor(snapshot(issues), { now: new Date(time), impactEnabled }).tickets.flatMap((t) =>
      t.findings
        .filter((f) => f.kind.startsWith("impact"))
        .map((f) => ({ number: t.number, ...f })),
    );
  const ready = ["bug", "status:ready"];

  it("reports impact:high as invalid with suggestion L and an --metric impact fix, never applied", () => {
    const [finding] = findings([issue(7, [...ready, "impact:high"])]);
    expect(finding).toMatchObject({ kind: "impact-label-invalid", certainty: "definite" });
    expect(finding!.plan.judgment).toBe(true);
    expect(finding!.plan.facts).toEqual([
      "Suggestion only (never applied): impact:high probably means L; confirm against the ticket.",
    ]);
    const fix = finding!.plan.steps.find((s) => s.argv[1] === "estimate")!;
    expect(fix.argv).toEqual([
      "github-triage",
      "estimate",
      "7",
      "--metric",
      "impact",
      "--size",
      "<SIZE>",
      "--rationale",
      "<RATIONALE>",
      "--replace-invalid",
      "--repo",
      "owner/name",
    ]);
  });
  it("suggests S for impact:low and asks for a size when unmapped", () => {
    const facts = findings([issue(7, [...ready, "impact:low", "impact:whatever"])])[0]!.plan.facts;
    expect(facts).toEqual([
      "Suggestion only (never applied): impact:low probably means S; confirm against the ticket.",
      "No suggestion for impact:whatever: read the ticket and choose a size.",
    ]);
  });
  it("reports conflicts and incomplete labels; unassessed tickets are not findings", () => {
    const all = findings([
      issue(1, [...ready, "impact:S", "impact:L"]),
      issue(2, [...ready, "impact:S"], true),
      issue(3, ready),
      issue(4, [...ready, "complexity:S"]),
    ]);
    expect(all.map((f) => [f.number, f.kind, f.certainty])).toEqual([
      [1, "impact-label-conflict", "definite"],
      [2, "impact-labels-incomplete", "unknown"],
    ]);
    expect(all[0]!.plan.steps.at(-1)!.argv).toContain("--metric");
    expect(all[1]!.plan.steps.every((s) => s.kind === "inspect")).toBe(true);
  });
  it("suppresses impact findings when impact.enabled is false, leaving complexity findings", () => {
    const issues = [issue(7, [...ready, "impact:high", "complexity:huge"])];
    expect(findings(issues, false)).toEqual([]);
    const kinds = ticketDoctor(snapshot(issues), {
      now: new Date(time),
      impactEnabled: false,
    }).tickets[0]!.findings.map((f) => f.kind);
    expect(kinds).toContain("complexity-label-invalid");
    expect(findings(issues).map((f) => f.kind)).toEqual(["impact-label-invalid"]);
  });
});
