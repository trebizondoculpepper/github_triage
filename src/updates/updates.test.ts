import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { installedVersion } from "./updates.js";

const root = join(import.meta.dirname, "..", "..");

describe("installedVersion manifest resolution (#335)", () => {
  it("finds the package manifest from a nested source module", async () => {
    const info = await installedVersion();
    expect(info.version).toEqual(expect.any(String));
    expect(info.reason).toBeUndefined();
  });

  it("still finds it from the bundle location one level below the root", async () => {
    const info = await installedVersion(pathToFileURL(join(root, "dist", "cli.mjs")).href);
    expect(info.version).toEqual(expect.any(String));
  });

  it("reports a missing manifest outside the package", async () => {
    const info = await installedVersion(pathToFileURL("/nonexistent/a/b/c/cli.mjs").href);
    expect(info.version).toBeNull();
    expect(info.reason).toBeDefined();
  });
});
