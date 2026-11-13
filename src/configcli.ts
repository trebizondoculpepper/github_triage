/**
 * `config get|set|list|help` (#117, doc/design/repository-configuration.md).
 *
 * Thin command layer over the configuration service in config.ts: this module parses
 * arguments, converts command-line text into typed values and renders text/JSON results.
 * Validation, defaults, migration, conflict detection, atomic writes and repository-target
 * verification all stay in the service.
 */

import { parseArgs } from "node:util";
import { join } from "node:path";
import {
  CONFIG_PATH,
  ConfigError,
  DEFAULT_SCHEMA,
  loadConfig,
  nodeFileSystem,
  nodeGit,
  resolveRepositoryTarget,
  settingFor,
  filesystemRefusal,
  updateConfig,
  validateValue,
} from "./config.js";
import type {
  ConfigErrorCode,
  ConfigFileSystem,
  ConfigKey,
  ConfigValue,
  EffectiveSetting,
  GitRunner,
} from "./config.js";

/** Injected boundaries; tests replace all three so the real checkout is never touched. */
export interface ConfigRuntime {
  readonly fs?: ConfigFileSystem;
  readonly git?: GitRunner;
  readonly cwd?: string;
}

export const configUsage = `Usage: github-triage config get KEY [--json] [--repo owner/name]
       github-triage config set KEY VALUE [--json] [--repo owner/name]
       github-triage config list [--json] [--repo owner/name]
       github-triage config help [KEY] [--json]`;

type Parsed =
  | { command: "help"; key?: string; json: boolean }
  | { command: "get"; key: string; json: boolean; repo?: string }
  | { command: "set"; key: string; value: string; json: boolean; repo?: string }
  | { command: "list"; json: boolean; repo?: string };

type ErrorCode = ConfigErrorCode | "usage" | "unsupported-scope";

/** A refusal before the service is reached: bad syntax or a non-repository scope. */
class ConfigUsageError extends Error {
  readonly code: ErrorCode;
  readonly recovery: string;
  constructor(code: ErrorCode, message: string, recovery = configUsage) {
    super(message);
    this.code = code;
    this.recovery = recovery;
  }
}

const scopeRecovery = `Repository scope is the only supported scope and is implicit; run the command from the repository's checkout without a scope option.\n${configUsage}`;

/** Parse `config ...` arguments (after the word `config`). Throws ConfigUsageError. */
export function configArgumentsFor(args: string[]): Parsed {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        repo: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean" },
        scope: { type: "string" },
        global: { type: "boolean" },
        system: { type: "boolean" },
        machine: { type: "boolean" },
        user: { type: "boolean" },
      },
    });
  } catch (error) {
    throw new ConfigUsageError("usage", (error as Error).message);
  }
  const { values, positionals } = parsed;
  const json = !!values.json;
  const other = (["global", "system", "machine", "user"] as const).find((flag) => values[flag]);
  if (other || (values.scope !== undefined && values.scope !== "repository")) {
    throw new ConfigUsageError(
      "unsupported-scope",
      `Unsupported configuration scope "${other ?? values.scope}"; global/machine settings are not available.`,
      scopeRecovery,
    );
  }
  if (values.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(values.repo)) {
    throw new ConfigUsageError("usage", "--repo must be owner/name.");
  }
  const [command, ...operands] = positionals;
  if (values.help || command === undefined || command === "help") {
    const key = command === "help" ? operands[0] : undefined;
    if (operands.length > (command === "help" ? 1 : 0) || values.repo !== undefined)
      throw new ConfigUsageError("usage", "config help takes at most one KEY and no --repo.");
    return { command: "help", key, json };
  }
  if (command === "get" && operands.length === 1)
    return { command, key: operands[0]!, json, repo: values.repo };
  if (command === "set" && operands.length === 2)
    return { command, key: operands[0]!, value: operands[1]!, json, repo: values.repo };
  if (command === "list" && operands.length === 0) return { command, json, repo: values.repo };
  throw new ConfigUsageError(
    "usage",
    ["get", "set", "list"].includes(command)
      ? `Wrong number of arguments for config ${command}.`
      : `Unknown config command "${command}".`,
  );
}

const keyEntry = (key: string): ConfigKey => {
  const entry = DEFAULT_SCHEMA.keys.find((candidate) => candidate.key === key);
  // Unknown keys are refused by the service, with its own list of supported keys.
  if (!entry) validateValue(DEFAULT_SCHEMA, key, undefined);
  return entry!;
};

const valueSyntax = (entry: ConfigKey): string =>
  entry.type === "boolean" ? "true|false" : "VALUE";

/** Convert command-line text into the key's typed value; the service validates the result. */
function typedValue(entry: ConfigKey, text: string): ConfigValue {
  if (entry.type !== "boolean") return text;
  if (text === "true") return true;
  if (text === "false") return false;
  throw new ConfigUsageError(
    "invalid-value",
    `Invalid value for "${entry.key}": expected true or false, got ${JSON.stringify(text)}.`,
    `github-triage config set ${entry.key} ${valueSyntax(entry)}`,
  );
}

const display = (value: ConfigValue): string => (value === null ? "(unset)" : String(value));

const settingJson = (setting: EffectiveSetting) => {
  const entry = keyEntry(setting.key);
  return { ...setting, type: entry.type, defaultValue: entry.defaultValue };
};

const settingText = (setting: EffectiveSetting): string =>
  `${setting.key} = ${display(setting.value)} (${setting.source})`;

function helpResult(key: string | undefined) {
  const keys = key ? [keyEntry(key)] : DEFAULT_SCHEMA.keys;
  return {
    schemaVersion: 1,
    kind: "config-help",
    scope: "repository",
    path: CONFIG_PATH,
    usage: configUsage,
    keys: keys.map((entry) => ({
      key: entry.key,
      type: entry.type,
      nullable: entry.nullable,
      defaultValue: entry.defaultValue,
      validValues: entry.type === "boolean" ? [true, false] : "non-empty text",
      description: entry.description,
      set: `github-triage config set ${entry.key} ${valueSyntax(entry)}`,
    })),
  };
}

function helpText(result: ReturnType<typeof helpResult>): string {
  const keys = result.keys
    .map(
      (entry) =>
        `  ${entry.key} (${entry.type}; default ${display(entry.defaultValue)}; valid: ${entry.type === "boolean" ? "true, false" : "non-empty text"})\n    ${entry.description}\n    Set: ${entry.set}`,
    )
    .join("\n");
  return `${result.usage}
Repository settings stored in ${CONFIG_PATH} of the current checkout (repository scope only;
global/machine scopes are not supported). Use these commands rather than editing the file:
values are validated, older schemas migrated and concurrent edits refused. Changes are not
committed; review and commit the file with Git. get/list never modify the file.
Keys:
${keys}
Exit: 0 success (including an unchanged set); 1 invalid arguments, unsupported scope,
unknown key, invalid value, unreadable file, write conflict or wrong repository.
`;
}

/** Run a config subcommand. Returns the exit code; output is either text or one JSON value. */
export async function runConfig(
  args: string[],
  output: (text: string) => Promise<void>,
  runtime: ConfigRuntime = {},
): Promise<number> {
  const json = args.includes("--json");
  try {
    const parsed = configArgumentsFor(args);
    if (parsed.command === "help") {
      const result = helpResult(parsed.key);
      await output(parsed.json ? JSON.stringify(result, null, 2) + "\n" : helpText(result));
      return 0;
    }
    const fs = runtime.fs ?? nodeFileSystem;
    // Reads verify the target too: a remote --repo never selects an unrelated checkout.
    const target = await resolveRepositoryTarget(
      runtime.cwd ?? process.cwd(),
      parsed.repo,
      runtime.git ?? nodeGit,
    );
    const where = {
      repository: target.repository,
      path: join(target.root, CONFIG_PATH),
    };
    if (parsed.command === "get") {
      const setting = settingFor(await loadConfig(target.root, fs), parsed.key);
      const result = { schemaVersion: 1, kind: "config-get", ...where, ...settingJson(setting) };
      await output(
        parsed.json ? JSON.stringify(result, null, 2) + "\n" : `${settingText(setting)}\n`,
      );
      return 0;
    }
    if (parsed.command === "list") {
      const config = await loadConfig(target.root, fs);
      const result = {
        schemaVersion: 1,
        kind: "config-list",
        ...where,
        storedVersion: config.storedVersion,
        settings: config.settings.map(settingJson),
      };
      await output(
        parsed.json
          ? JSON.stringify(result, null, 2) + "\n"
          : `Configuration for ${target.repository} (${where.path}${config.storedVersion === null ? ", not present: all defaults" : ""}):\n${config.settings.map((s) => `  ${settingText(s)}`).join("\n")}\n`,
      );
      return 0;
    }
    const entry = keyEntry(parsed.key);
    const write = await updateConfig(
      target,
      new Map([[entry.key, typedValue(entry, parsed.value)]]),
      { fs },
    );
    const setting = settingFor(write.config, entry.key);
    const result = {
      schemaVersion: 1,
      kind: "config-set",
      ...where,
      changed: write.changed,
      ...settingJson(setting),
    };
    await output(
      parsed.json
        ? JSON.stringify(result, null, 2) + "\n"
        : `${settingText(setting)} — ${write.changed ? `written to ${where.path} (not committed)` : "unchanged"}\n`,
    );
    return 0;
  } catch (caught) {
    const error = filesystemRefusal(caught) ?? caught;
    if (!(error instanceof ConfigError || error instanceof ConfigUsageError)) throw error;
    if (!json) throw new Error(`${error.message}\n${error.recovery}`, { cause: error });
    await output(
      JSON.stringify(
        {
          schemaVersion: 1,
          kind: "config-error",
          code: error.code,
          message: error.message,
          recovery: error.recovery,
        },
        null,
        2,
      ) + "\n",
    );
    return 1;
  }
}
