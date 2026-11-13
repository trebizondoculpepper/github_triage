import { describe, expect, it } from "vite-plus/test";
import {
  SCENARIOS,
  baselineFinding,
  checkPlausibilityRules,
  runScenarios,
} from "./plausibility.js";

describe("rules plausibility scenarios (#154)", () => {
  it("has no static diagnostics in the plausibility rule set", () => {
    expect(checkPlausibilityRules()).toEqual([]);
  });
  for (const outcome of runScenarios(SCENARIOS))
    it(`${outcome.id} ${outcome.name}`, () => {
      expect(outcome.failures).toEqual([]);
    });
  it("records the baseline R2 finding the extended rules correct", () => {
    expect(baselineFinding()).toEqual({ waitingClaimed: ["90:follow_up"], postDone: [] });
  });
});
