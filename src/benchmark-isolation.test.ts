import { execFile, spawn } from "node:child_process";
import { describe, expect, it } from "vite-plus/test";
import {
  assertNoLocalPaths,
  emptyFileSystem,
  fakeGit,
  forbidSubprocesses,
  SYNTHETIC_ROOT,
} from "../scripts/benchmark-isolation.js";
import { resolveGuideSetting } from "./process.js";
import { collectLabelEstimationInput } from "./estimation/complexitylabels.js";

describe("benchmark isolation (scripts/mcp-benchmark.ts)", () => {
  it("forbids subprocesses, including through ESM named imports, and restores them", () => {
    const restore = forbidSubprocesses();
    try {
      expect(() => spawn("git", ["--version"])).toThrow(/forbidden/);
      expect(() => execFile("git", ["--version"])).toThrow(/forbidden/);
    } finally {
      restore();
    }
  });

  it("rejects output that names a local path", () => {
    expect(() => assertNoLocalPaths("x", "checkout at /home/me/repo", ["/home/me"])).toThrow(
      /local path \/home\/me/,
    );
    expect(() => assertNoLocalPaths("x", "nothing local here", ["/home/me"])).not.toThrow();
  });

  it("resolves the guide and estimation settings without local state or diagnostics", async () => {
    const restore = forbidSubprocesses();
    try {
      const local = { cwd: SYNTHETIC_ROOT, fs: emptyFileSystem, git: fakeGit("example/project") };
      const guide = await resolveGuideSetting("example/project", undefined, local);
      expect(guide).toEqual({ enabled: false, source: "default", diagnostics: [] });
      const estimation = await collectLabelEstimationInput("example/project", local);
      expect(estimation.status).toBe("available");
      assertNoLocalPaths("estimation", JSON.stringify(estimation));
    } finally {
      restore();
    }
  });
});
