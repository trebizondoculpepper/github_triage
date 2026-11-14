import { describe, it, expect } from "vite-plus/test";
import { parseConfig, settingFor } from "./config.js";
import { resolveEngineSetting } from "./engine-setting.js";
import { emptyFileSystem, fakeGit, SYNTHETIC_ROOT } from "../scripts/benchmark-isolation.js";
import { presentBriefing, readBriefing } from "./service.js";
import { main } from "./cli.js";
import { dependencyReport } from "./dependencies.js";
import type { Issue, Snapshot } from "./types.js";
const item: Issue = {
  number: 1,
  title: "An available job",
  url: "https://github.com/example/project/issues/1",
  body: "",
  state: "OPEN",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  labels: { nodes: [{ name: "status:ready" }], pageInfo: { hasNextPage: false, endCursor: null } },
  comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  blockedBy: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  blocking: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  issueDependenciesSummary: { blockedBy: 0, totalBlockedBy: 0, blocking: 0, totalBlocking: 0 },
  closedByPullRequestsReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
};
const snapshot: Snapshot = {
  schemaVersion: 1,
  repository: "example/project",
  startedAt: "2026-01-01T00:00:00Z",
  fetchedAt: "2026-01-01T00:00:00Z",
  issues: [item],
  pullRequests: [],
  dependencies: [],
  changed: [],
  since: null,
  warnings: [],
  rateLimit: null,
};
const local = (raw = 'schemaVersion = 1\n[briefing]\nengine = "datalog"\n') => ({
  cwd: SYNTHETIC_ROOT,
  git: fakeGit(snapshot.repository),
  fs: {
    ...emptyFileSystem,
    readText: async (path: string) => (path.endsWith("triage.toml") ? raw : null),
  },
});
describe("repository-scoped experimental engine selection", () => {
  it("registers and validates the enum, with TypeScript default", () => {
    expect(settingFor(parseConfig('{"schemaVersion":1}', undefined), "briefing.engine").value).toBe(
      "typescript",
    );
    expect(() =>
      parseConfig('{"schemaVersion":1,"briefing":{"engine":"invented"}}', undefined),
    ).toThrow();
  });
  it("uses only a matching selected checkout and never reads another repo settings", async () => {
    expect(await resolveEngineSetting(snapshot.repository, local())).toMatchObject({
      requested: "datalog",
      source: "config",
    });
    expect(await resolveEngineSetting("another/repo", local())).toMatchObject({
      requested: "typescript",
      source: "no-matching-project",
    });
    expect(await resolveEngineSetting(snapshot.repository)).toMatchObject({
      requested: "typescript",
      source: "no-matching-project",
    });
    await expect(resolveEngineSetting(snapshot.repository, local("garbage"))).rejects.toThrow(
      "no decision engine was run",
    );
  });
  it("does not load the evaluator in default or full-intake paths", async () => {
    const never = async () => {
      throw new Error("evaluator initialized");
    };
    const normal = await presentBriefing(
      snapshot,
      { limit: 10, maxChars: 10000 },
      local(),
      new Date(),
      undefined,
      undefined,
      undefined,
      never,
    );
    expect(normal.report.decisionEngine.used).toBe("typescript");
    const intake = await presentBriefing(
      snapshot,
      {
        limit: 10,
        maxChars: 10000,
        issue: 1,
        engineSetting: { requested: "datalog", source: "config" },
      },
      local(),
      new Date(),
      undefined,
      undefined,
      undefined,
      never,
    );
    expect(intake.report.decisionEngine.used).toBe("typescript");
  });
  it("requires a supported role and never falls back after evaluator failure", async () => {
    const selected = {
      limit: 10,
      maxChars: 10000,
      engineSetting: { requested: "datalog" as const, source: "config" as const },
    };
    await expect(presentBriefing(snapshot, selected, local())).rejects.toThrow(
      "--role implementer",
    );
    await expect(
      presentBriefing(
        snapshot,
        { ...selected, role: "implementer" },
        local(),
        new Date(),
        undefined,
        undefined,
        undefined,
        async () => {
          throw new Error("fixture engine failure");
        },
      ),
    ).rejects.toThrow("fixture engine failure");
  });
  it("uses the same actual Datalog actions and explanation text through CLI and shared MCP read service", async () => {
    const runtime = {
      collect: async () => snapshot,
      currentRepository: async () => snapshot.repository,
      guide: local(),
      estimation: local(),
    };
    let json = "";
    await main(
      ["--repo", snapshot.repository, "--role", "implementer", "--json", "--no-update-check"],
      async (t) => {
        json = t;
      },
      runtime,
    );
    const cli = JSON.parse(json) as {
      decisionEngine: { used: string };
      rankedActions: { items: { why: { text: string } }[] };
    };
    expect(cli.decisionEngine.used).toBe("datalog");
    const result = await readBriefing(
      { ...runtime, dependencyReport },
      { repository: snapshot.repository, role: "implementer", limit: 10, maxChars: 10000 },
    );
    expect(result.kind).toBe("report");
    if (result.kind !== "report") throw new Error("expected report");
    expect("rankedActions" in result.report && result.report.rankedActions).toEqual(
      cli.rankedActions,
    );
    expect(result.text).toContain(cli.rankedActions.items[0].why.text);
    expect(result.text).toContain("Decision engine: Datalog");
  });
});

it("keeps background parked context without restoring TypeScript next actions", async () => {
  const parked = {
    ...item,
    number: 2,
    url: item.url.replace("/1", "/2"),
    title: "Parked work",
    labels: { ...item.labels, nodes: [{ name: "status:parked" }] },
  };
  const built = await presentBriefing(
    { ...snapshot, issues: [parked] },
    {
      role: "implementer",
      limit: 10,
      maxChars: 10000,
      engineSetting: { requested: "datalog", source: "config" },
    },
    local(),
  );
  expect(built.text).toContain("Parked work");
  expect(built.text).toContain("Parked; not a next step.");
  expect("rankedActions" in built.report && built.report.rankedActions?.items).toEqual([]);
});
it("preserves config repair guidance instead of an unusable rollback", async () => {
  try {
    await resolveEngineSetting(snapshot.repository, local("not valid TOML"));
    throw new Error("expected config refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("Roll back:");
    expect((error as Error).message).toContain("configuration");
  }
});
