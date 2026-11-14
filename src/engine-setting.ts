/** Repository-scoped engine selection; importing this never initializes DataScript. */
import {
  ConfigError,
  loadConfig,
  settingFor,
  resolveRepositoryTarget,
  nodeFileSystem,
  nodeGit,
} from "./config.js";
import type { GuideRuntime } from "./process.js";
export type EngineName = "typescript" | "datalog";
export interface EngineSetting {
  requested: EngineName;
  source: "config" | "default" | "no-matching-project";
}
export class BriefingEngineError extends Error {
  constructor(
    readonly code: "decision-engine-config" | "decision-engine-role" | "decision-engine-failed",
    detail: string,
  ) {
    super(`${detail} Roll back: github-triage config set briefing.engine typescript`);
  }
}
export async function resolveEngineSetting(
  repository: string,
  runtime?: GuideRuntime,
): Promise<EngineSetting> {
  if (!runtime) return { requested: "typescript", source: "no-matching-project" };
  let target;
  try {
    target = await resolveRepositoryTarget(
      runtime.cwd ?? process.cwd(),
      repository,
      runtime.git ?? nodeGit,
    );
  } catch (error) {
    if (
      error instanceof ConfigError &&
      ["not-a-repository", "repository-mismatch"].includes(error.code)
    )
      return { requested: "typescript", source: "no-matching-project" };
    throw new BriefingEngineError(
      "decision-engine-config",
      "Cannot resolve the selected repository configuration.",
    );
  }
  try {
    const setting = settingFor(
      await loadConfig(target.root, runtime.fs ?? nodeFileSystem),
      "briefing.engine",
    );
    return {
      requested: setting.value === "datalog" ? "datalog" : "typescript",
      source: setting.source === "explicit" ? "config" : "default",
    };
  } catch {
    throw new BriefingEngineError(
      "decision-engine-config",
      "Repository configuration cannot be read or validated; no decision engine was run.",
    );
  }
}

export interface DecisionEngineMetadata {
  requested: EngineName;
  used: EngineName;
  source: string;
  policyVersion: number | null;
  rulesHash: string | null;
  coverage: object;
  diagnostics: string[];
}
