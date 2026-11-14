/** Naming migration behavior that must remain compatible for existing installations. */
import { it, expect } from "vite-plus/test";
import { main } from "./cli.js";
import { optOutEnv, legacyOptOutEnv } from "./updates.js";
it("accepts both canonical and legacy update opt-out environment variables", async () => {
  const prior = new Map([optOutEnv, legacyOptOutEnv].map((k) => [k, process.env[k]]));
  try {
    for (const key of [optOutEnv, legacyOptOutEnv]) {
      delete process.env[optOutEnv];
      delete process.env[legacyOptOutEnv];
      process.env[key] = "1";
      const seen: boolean[] = [];
      await main(["version", "--json"], async () => undefined, {
        collect: async () => {
          throw new Error("no collection");
        },
        currentRepository: async () => {
          throw new Error("no repository read");
        },
        updateCheck: async (options) => {
          seen.push(!!options?.optOut);
          return { status: "skipped", reason: "fixture" };
        },
      });
      expect(seen).toEqual([true]);
    }
  } finally {
    for (const [key, value] of prior)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});
