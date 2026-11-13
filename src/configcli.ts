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
import {
  IDENTITY_FILE,
  IDENTITY_KEYS,
  identityValue,
  isIdentityKey,
  readIdentity,
  resolveIdentityTarget,
  setIdentity,
  validateEntryKey,
  validateIdentityValue,
} from "./identity.js";
import type { IdentityKey, IdentityRecord } from "./identity.js";
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
  /** Random source for generated agent names (identity initializer). */
  readonly random?: () => number;
}

export const configUsage = `Usage: github-triage config get KEY [--entry KEY] [--json] [--repo owner/name]
       github-triage config set KEY VALUE [--entry KEY] [--json] [--repo owner/name]
       github-triage config list [--entry KEY] [--json] [--repo owner/name]
       github-triage config help [KEY] [--json]
identity.* keys need --entry KEY selecting [agents.KEY] in the root agent-inbox.toml.`;

type Parsed =
  | { command: "help"; key?: string; json: boolean }
  | { command: "get"; key: string; json: boolean; repo?: string; entry?: string }
  | { command: "set"; key: string; value: string; json: boolean; repo?: string; entry?: string }
  | { command: "list"; json: boolean; repo?: string; entry?: string };

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
        entry: { type: "string" },
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
    if (
      operands.length > (command === "help" ? 1 : 0) ||
      values.repo !== undefined ||
      values.entry !== undefined
    )
      throw new ConfigUsageError(
        "usage",
        "config help takes at most one KEY and no --repo/--entry.",
      );
    return { command: "help", key, json };
  }
  const { repo, entry } = values;
  if (
    (command === "get" || command === "set") &&
    entry !== undefined &&
    !isIdentityKey(operands[0] ?? "")
  )
    throw new ConfigUsageError("usage", "--entry applies only to identity.* keys.");
  if (command === "get" && operands.length === 1)
    return { command, key: operands[0]!, json, repo, entry };
  if (command === "set" && operands.length === 2)
    return { command, key: operands[0]!, value: operands[1]!, json, repo, entry };
  if (command === "list" && operands.length === 0) return { command, json, repo, entry };
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

const identityKeyEntry = (key: string): IdentityKey => {
  const entry = IDENTITY_KEYS.find((candidate) => candidate.key === key);
  if (!entry) validateIdentityValue(key, "");
  return entry!;
};

const identityHelp = (entry: IdentityKey) => ({
  key: entry.key,
  scope: "agent" as const,
  path: IDENTITY_FILE,
  type: "string" as const,
  validValues: entry.validValues,
  description: entry.description,
  set: `github-triage config set ${entry.key} ${entry.validValues === "agent name" ? "NAME" : entry.validValues.join("|")} --entry KEY`,
});

function helpResult(key: string | undefined) {
  const identity = key ? (isIdentityKey(key) ? [identityKeyEntry(key)] : []) : IDENTITY_KEYS;
  const keys = key ? (isIdentityKey(key) ? [] : [keyEntry(key)]) : DEFAULT_SCHEMA.keys;
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
    identityKeys: identity.map(identityHelp),
  };
}

function helpText(result: ReturnType<typeof helpResult>): string {
  const keys = result.keys
    .map(
      (entry) =>
        `  ${entry.key} (${entry.type}; default ${display(entry.defaultValue)}; valid: ${entry.type === "boolean" ? "true, false" : "non-empty text"})\n    ${entry.description}\n    Set: ${entry.set}`,
    )
    .join("\n");
  const identity = result.identityKeys
    .map(
      (entry) =>
        `  ${entry.key} (valid: ${entry.validValues === "agent name" ? "an agent name" : entry.validValues.join(", ")})\n    ${entry.description}\n    Set: ${entry.set}`,
    )
    .join("\n");
  return `${result.usage}
Repository settings stored in ${CONFIG_PATH} of the current checkout (repository scope only;
global/machine scopes are not supported). Use these commands rather than editing the file:
values are validated, older schemas migrated and concurrent edits refused. Changes are not
committed; review and commit the file with Git. get/list never modify the file.
Keys:
${keys}
Per-agent identity keys, stored in the [agents.KEY] table selected by --entry KEY in
${IDENTITY_FILE} at the Git working-tree root (local, Git-ignored, never committed). Writes
preserve other agents and unknown values but normalise formatting and drop comments.
get/list never create the file; setting identity.triage_role initialises a missing entry
with a generated name once:
${identity}
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
    if (parsed.command !== "list" && isIdentityKey(parsed.key)) {
      await output(await runIdentity(parsed, runtime));
      return 0;
    }
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
      const identity = await identityListing(parsed, target.root, fs);
      const result = {
        schemaVersion: 1,
        kind: "config-list",
        ...where,
        storedVersion: config.storedVersion,
        settings: config.settings.map(settingJson),
        identity,
      };
      await output(
        parsed.json
          ? JSON.stringify(result, null, 2) + "\n"
          : `Configuration for ${target.repository} (${where.path}${config.storedVersion === null ? ", not present: all defaults" : ""}):\n${config.settings.map((s) => `  ${settingText(s)}`).join("\n")}\n${identityListText(identity)}`,
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

const flags = (parsed: { repo?: string }, entry: string): string =>
  ` --entry ${entry}${parsed.repo ? ` --repo ${parsed.repo}` : ""}`;

const unresolved = (command: string, parsed: { repo?: string }): ConfigError =>
  new ConfigError(
    "identity-unresolved",
    "No agent identity entry is selected (automatic harness detection is not available yet).",
    `Select the [agents.KEY] entry explicitly, for example: ${command}${flags(parsed, "KEY")}`,
  );

const identitySetting = (record: IdentityRecord, key: string) => {
  const value = identityValue(record, key);
  return { key, value, source: value === null ? ("unset" as const) : ("explicit" as const) };
};

/** `config get|set identity.*`: routed to the selected [agents.KEY] table. */
async function runIdentity(
  parsed: Extract<Parsed, { command: "get" | "set" }>,
  runtime: ConfigRuntime,
): Promise<string> {
  const command =
    parsed.command === "get"
      ? `github-triage config get ${parsed.key}`
      : `github-triage config set ${parsed.key} ${parsed.value}`;
  if (parsed.entry === undefined) {
    // Validate the key first so an unknown identity key gets its own refusal.
    if (parsed.command === "set") validateIdentityValue(parsed.key, parsed.value);
    else identityKeyEntry(parsed.key);
    throw unresolved(command, parsed);
  }
  const entry = validateEntryKey(parsed.entry);
  const fs = runtime.fs ?? nodeFileSystem;
  const target = await resolveIdentityTarget(
    runtime.cwd ?? process.cwd(),
    parsed.repo,
    runtime.git ?? nodeGit,
  );
  const where = {
    scope: "agent",
    repository: target.repository,
    path: IDENTITY_FILE,
    entry,
    selection: "--entry",
  };
  if (parsed.command === "get") {
    identityKeyEntry(parsed.key);
    const record = await readIdentity(target.root, entry, fs);
    const setting = identitySetting(record, parsed.key);
    const result = {
      schemaVersion: 1,
      kind: "config-get",
      ...where,
      fileExists: record.fileExists,
      entryExists: record.entryExists,
      ...setting,
      problems: record.problems,
    };
    if (parsed.json) return JSON.stringify(result, null, 2) + "\n";
    const notes = [
      !record.fileExists ? `${IDENTITY_FILE} not present` : "",
      record.fileExists && !record.entryExists ? `no [agents.${entry}] entry` : "",
      ...record.problems,
    ].filter(Boolean);
    return `${parsed.key} = ${setting.value ?? "(unset)"} (${setting.source}; entry ${entry} in ${IDENTITY_FILE})${notes.length ? `\n  ${notes.join("\n  ")}\n  Set: ${record.entryExists ? `github-triage config set ${parsed.key} ${parsed.key === "identity.name" ? "NAME" : "implementer|designer"}` : "github-triage config set identity.triage_role implementer|designer"}${flags(parsed, entry)}` : ""}\n`;
  }
  const write = await setIdentity(target, entry, parsed.key, parsed.value, {
    fs,
    git: runtime.git ?? nodeGit,
    random: runtime.random,
  });
  const setting = identitySetting(write.record, parsed.key);
  const result = {
    schemaVersion: 1,
    kind: "config-set",
    ...where,
    changed: write.changed,
    createdFile: write.createdFile,
    createdEntry: write.createdEntry,
    generatedName: write.generatedName,
    excludeRuleAdded: write.excluded,
    ...setting,
  };
  if (parsed.json) return JSON.stringify(result, null, 2) + "\n";
  const extra = [
    write.generatedName ? `generated name ${write.generatedName} for new entry ${entry}` : "",
    write.excluded ? `added /${IDENTITY_FILE} to this repository's local Git exclude file` : "",
  ].filter(Boolean);
  return `${parsed.key} = ${setting.value} (entry ${entry}) — ${write.changed ? `written to ${IDENTITY_FILE} (local, not committed)` : "unchanged"}${extra.map((line) => `\n  ${line}`).join("")}\n`;
}

/** Identity section of `config list`: only registered values of the selected entry. */
async function identityListing(
  parsed: { repo?: string; entry?: string },
  root: string,
  fs: ConfigFileSystem,
) {
  if (parsed.entry === undefined) {
    return {
      resolved: false as const,
      path: IDENTITY_FILE,
      recovery: `github-triage config list${flags(parsed, "KEY")}`,
    };
  }
  const entry = validateEntryKey(parsed.entry);
  try {
    const record = await readIdentity(root, entry, fs);
    return {
      resolved: true as const,
      path: IDENTITY_FILE,
      entry,
      selection: "--entry",
      fileExists: record.fileExists,
      entryExists: record.entryExists,
      settings: IDENTITY_KEYS.map((key) => identitySetting(record, key.key)),
      problems: record.problems,
    };
  } catch (error) {
    // Unreadable identity never breaks the repository listing.
    if (!(error instanceof ConfigError)) throw error;
    return {
      resolved: false as const,
      path: IDENTITY_FILE,
      entry,
      error: { code: error.code, message: error.message, recovery: error.recovery },
    };
  }
}

function identityListText(identity: Awaited<ReturnType<typeof identityListing>>): string {
  if (!identity.resolved) {
    return "error" in identity && identity.error
      ? `Agent identity (${IDENTITY_FILE}, entry ${identity.entry}): ${identity.error.message}\n  ${identity.error.recovery}\n`
      : `Agent identity: no entry selected; add --entry KEY (${"recovery" in identity ? identity.recovery : ""})\n`;
  }
  return `Agent identity (entry ${identity.entry} in ${IDENTITY_FILE}${identity.fileExists ? "" : ", not present"}):\n${identity.settings.map((s) => `  ${s.key} = ${s.value ?? "(unset)"} (${s.source})`).join("\n")}\n${identity.problems.map((p) => `  ${p}\n`).join("")}`;
}
