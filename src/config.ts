/**
 * Repository configuration service (#116, doc/design/repository-configuration.md).
 *
 * Owns the versioned, non-secret `.github/triage.json` file: registered keys, typed
 * validation, defaults, schema migrations, repository resolution and atomic writes. CLI
 * commands, setup and diagnostics call this module instead of reading the file directly.
 *
 * Read-only loads never modify the file. Writes migrate supported older schemas in memory,
 * preserve unrelated supported values and atomically replace the file only when nobody else
 * changed it in the meantime. Malformed, unknown or future data is refused without rewriting.
 * Nothing here stores credentials, agent identity or caches, and nothing commits to Git.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

/** Repository-relative location of the configuration file. */
export const CONFIG_PATH = ".github/triage.json";

/** The schema version this build writes. */
export const CURRENT_SCHEMA_VERSION = 1;

export type ConfigValue = boolean | string | null;

/** A registered configuration key: its type, default and help text. */
export interface ConfigKey {
  readonly key: string;
  readonly type: "boolean" | "string";
  /** Whether an explicit `null` is a valid stored value. */
  readonly nullable: boolean;
  /** Effective value when nothing is stored; `null` means unset. */
  readonly defaultValue: ConfigValue;
  readonly description: string;
}

/** The single registry of supported keys. Extend here, never with special cases elsewhere. */
export const CONFIG_KEYS: readonly ConfigKey[] = [
  {
    key: "complexity.enabled",
    type: "boolean",
    nullable: false,
    defaultValue: true,
    description:
      "Whether complexity estimation is active for this repository. Disabling it keeps any existing field mapping and estimates.",
  },
  {
    key: "complexity.fieldId",
    type: "string",
    nullable: true,
    defaultValue: null,
    description:
      "Identifier of the native GitHub field that records complexity. Unset until explicitly selected.",
  },
];

/** Upgrade a document from `from` to `from + 1`. Must be pure. */
export interface ConfigMigration {
  readonly from: number;
  readonly migrate: (document: Record<string, unknown>) => Record<string, unknown>;
}

/** Registered migrations between stored schema versions. Version 1 is the first schema. */
export const CONFIG_MIGRATIONS: readonly ConfigMigration[] = [];

export interface ConfigSchema {
  readonly version: number;
  readonly keys: readonly ConfigKey[];
  readonly migrations: readonly ConfigMigration[];
}

export const DEFAULT_SCHEMA: ConfigSchema = {
  version: CURRENT_SCHEMA_VERSION,
  keys: CONFIG_KEYS,
  migrations: CONFIG_MIGRATIONS,
};

export type ConfigErrorCode =
  | "malformed"
  | "unsupported-version"
  | "incompatible"
  | "unknown-key"
  | "invalid-value"
  | "conflict"
  | "repository-mismatch"
  | "not-a-repository";

/** A refusal with exact recovery guidance. The file is left untouched. */
export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly recovery: string;
  constructor(code: ConfigErrorCode, message: string, recovery: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.recovery = recovery;
  }
}

/** Filesystem boundary, injectable for tests. `readText` returns null for a missing file. */
export interface ConfigFileSystem {
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  makeDirectory(path: string): Promise<void>;
}

export const nodeFileSystem: ConfigFileSystem = {
  async readText(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  writeText: (path, text) => writeFile(path, text, { flag: "wx" }),
  rename: (from, to) => rename(from, to),
  remove: (path) => unlink(path),
  async makeDirectory(path) {
    await mkdir(path, { recursive: true });
  },
};

/** One effective setting, saying whether it is explicit or the registered default. */
export interface EffectiveSetting {
  readonly key: string;
  readonly value: ConfigValue;
  readonly source: "explicit" | "default";
}

export interface LoadedConfig {
  /** Schema version found on disk; null when the file is absent. */
  readonly storedVersion: number | null;
  /** Explicitly stored values, after in-memory migration. */
  readonly explicit: ReadonlyMap<string, ConfigValue>;
  readonly settings: readonly EffectiveSetting[];
  /** Raw file text as read, used to detect intervening edits. */
  readonly raw: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recovery = (root: string): string =>
  `Restore ${join(root, CONFIG_PATH)} from Git (git checkout -- ${CONFIG_PATH}) or remove it to return to defaults, then retry.`;

function findKey(schema: ConfigSchema, key: string): ConfigKey {
  const entry = schema.keys.find((candidate) => candidate.key === key);
  if (!entry) {
    throw new ConfigError(
      "unknown-key",
      `Unknown configuration key "${key}".`,
      `Supported keys: ${schema.keys.map((candidate) => candidate.key).join(", ")}.`,
    );
  }
  return entry;
}

/** Validate a value for a registered key. */
export function validateValue(schema: ConfigSchema, key: string, value: unknown): ConfigValue {
  const entry = findKey(schema, key);
  if (value === null && entry.nullable) return null;
  if (entry.type === "boolean" && typeof value === "boolean") return value;
  if (entry.type === "string" && typeof value === "string" && value.trim() !== "") return value;
  throw new ConfigError(
    "invalid-value",
    `Invalid value for "${key}": expected ${entry.type}${entry.nullable ? " or null" : ""}, got ${JSON.stringify(value)}.`,
    entry.description,
  );
}

/**
 * Flatten `{complexity: {enabled: true}}` into dotted keys. Objects are only accepted at
 * namespace paths of registered keys, so an object at a scalar key or an unknown subtree
 * (even an empty one) is refused instead of being silently dropped.
 */
function flatten(
  schema: ConfigSchema,
  document: Record<string, unknown>,
  prefix = "",
): Map<string, unknown> {
  const flat = new Map<string, unknown>();
  for (const [name, value] of Object.entries(document)) {
    const key = prefix ? `${prefix}.${name}` : name;
    if (!isRecord(value)) {
      flat.set(key, value);
      continue;
    }
    if (schema.keys.some((entry) => entry.key === key)) {
      validateValue(schema, key, value);
    }
    if (!schema.keys.some((entry) => entry.key.startsWith(`${key}.`))) findKey(schema, key);
    for (const [inner, leaf] of flatten(schema, value, key)) flat.set(inner, leaf);
  }
  return flat;
}

function nest(values: ReadonlyMap<string, ConfigValue>, version: number): Record<string, unknown> {
  const document: Record<string, unknown> = { schemaVersion: version };
  for (const key of [...values.keys()].sort()) {
    const parts = key.split(".");
    let node = document;
    for (const part of parts.slice(0, -1)) {
      if (!isRecord(node[part])) node[part] = {};
      node = node[part] as Record<string, unknown>;
    }
    node[parts[parts.length - 1]!] = values.get(key);
  }
  return document;
}

/** Parse, migrate in memory and validate stored text. Never writes. */
export function parseConfig(
  raw: string | null,
  schema: ConfigSchema = DEFAULT_SCHEMA,
  root = ".",
): LoadedConfig {
  const explicit = new Map<string, ConfigValue>();
  if (raw === null) {
    return { storedVersion: null, explicit, settings: effective(schema, explicit), raw };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(
      "malformed",
      `${CONFIG_PATH} is not valid JSON: ${(error as Error).message}`,
      recovery(root),
    );
  }
  if (!isRecord(data)) {
    throw new ConfigError(
      "malformed",
      `${CONFIG_PATH} must contain a JSON object.`,
      recovery(root),
    );
  }
  const storedVersion = data.schemaVersion;
  if (typeof storedVersion !== "number" || !Number.isInteger(storedVersion) || storedVersion < 1) {
    throw new ConfigError(
      "malformed",
      `${CONFIG_PATH} has no valid integer "schemaVersion".`,
      recovery(root),
    );
  }
  if (storedVersion > schema.version) {
    throw new ConfigError(
      "unsupported-version",
      `${CONFIG_PATH} uses schema version ${storedVersion}; this build supports up to ${schema.version}.`,
      "Upgrade github-triage to a release that supports this schema. The file was not changed.",
    );
  }
  let document: Record<string, unknown> = { ...data };
  delete document.schemaVersion;
  for (let version = storedVersion; version < schema.version; version++) {
    const step = schema.migrations.find((migration) => migration.from === version);
    if (!step) {
      throw new ConfigError(
        "unsupported-version",
        `No migration from schema version ${version} to ${version + 1}.`,
        recovery(root),
      );
    }
    document = step.migrate(document);
  }
  try {
    for (const [key, value] of flatten(schema, document)) {
      explicit.set(key, validateValue(schema, key, value));
    }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    throw new ConfigError(
      "incompatible",
      `${CONFIG_PATH} contains unsupported data: ${error.message}`,
      `${error.recovery} ${recovery(root)}`,
    );
  }
  return { storedVersion, explicit, settings: effective(schema, explicit), raw };
}

function effective(
  schema: ConfigSchema,
  explicit: ReadonlyMap<string, ConfigValue>,
): EffectiveSetting[] {
  return schema.keys.map((entry) =>
    explicit.has(entry.key)
      ? { key: entry.key, value: explicit.get(entry.key)!, source: "explicit" }
      : { key: entry.key, value: entry.defaultValue, source: "default" },
  );
}

/** Look up one effective setting from a loaded configuration. */
export function settingFor(
  config: LoadedConfig,
  key: string,
  schema = DEFAULT_SCHEMA,
): EffectiveSetting {
  findKey(schema, key);
  return config.settings.find((setting) => setting.key === key)!;
}

/** Read-only load. Missing files yield defaults; the file is never modified. */
export async function loadConfig(
  root: string,
  fs: ConfigFileSystem = nodeFileSystem,
  schema: ConfigSchema = DEFAULT_SCHEMA,
): Promise<LoadedConfig> {
  return parseConfig(await fs.readText(join(root, CONFIG_PATH)), schema, root);
}

/** Serialise values in the canonical current-schema layout. */
export function serializeConfig(values: ReadonlyMap<string, ConfigValue>, version: number): string {
  return JSON.stringify(nest(values, version), null, 2) + "\n";
}

/** A verified write target: a local checkout whose remotes include the repository. */
export interface RepositoryTarget {
  readonly root: string;
  readonly repository: string;
}

/** Git boundary: runs `git` with arguments in a directory and returns stdout. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>;

const run = promisify(execFile);
export const nodeGit: GitRunner = async (args, cwd) =>
  (await run("git", [...args], { cwd, windowsHide: true })).stdout;

/** Extract `owner/name` from GitHub remote URLs (https, ssh and scp-like forms). */
export function githubRepositories(remotes: string): string[] {
  const found = new Set<string>();
  const pattern = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\s|\/?$)/gim;
  for (const match of remotes.matchAll(pattern)) {
    found.add(`${match[1]}/${match[2]}`.toLowerCase());
  }
  return [...found];
}

/**
 * Resolve the checkout containing `cwd` and verify it is `repository` (when given) before any
 * write. A remote `--repo` alone never selects or mutates an unrelated local checkout.
 */
export async function resolveRepositoryTarget(
  cwd: string,
  repository: string | undefined,
  git: GitRunner = nodeGit,
): Promise<RepositoryTarget> {
  let root: string;
  try {
    root = (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch {
    root = "";
  }
  if (!root) {
    throw new ConfigError(
      "not-a-repository",
      `${resolve(cwd)} is not inside a Git checkout.`,
      "Run the command from inside the repository's local checkout.",
    );
  }
  let remotes = "";
  try {
    remotes = await git(["remote", "-v"], root);
  } catch {
    remotes = "";
  }
  const repositories = githubRepositories(remotes);
  const wanted = repository?.toLowerCase();
  if (wanted ? !repositories.includes(wanted) : repositories.length !== 1) {
    throw new ConfigError(
      "repository-mismatch",
      wanted
        ? `The checkout at ${root} is not ${repository} (remotes: ${repositories.join(", ") || "none"}).`
        : `Cannot identify the repository for ${root} (GitHub remotes: ${repositories.join(", ") || "none"}).`,
      "Run from a local checkout of the intended repository, and pass --repo owner/name when it has several GitHub remotes.",
    );
  }
  return { root, repository: wanted ?? repositories[0]! };
}

/** Changes to apply: a value sets the key, `undefined` unsets it (returning it to default). */
export type ConfigChanges = ReadonlyMap<string, ConfigValue | undefined>;

export interface WriteOptions {
  readonly fs?: ConfigFileSystem;
  readonly schema?: ConfigSchema;
  /** Unique suffix for the temporary file; injected for deterministic tests. */
  readonly token?: () => string;
}

export interface WriteResult {
  readonly changed: boolean;
  readonly config: LoadedConfig;
}

/**
 * Validate and apply changes to a verified repository, migrating supported older schemas.
 * Writes a temporary file beside the target and renames it into place only if the file still
 * matches what was read; otherwise refuses with a conflict. Equal writes are no-ops.
 */
export async function updateConfig(
  target: RepositoryTarget,
  changes: ConfigChanges,
  options: WriteOptions = {},
): Promise<WriteResult> {
  const fs = options.fs ?? nodeFileSystem;
  const schema = options.schema ?? DEFAULT_SCHEMA;
  const path = join(target.root, CONFIG_PATH);
  const current = parseConfig(await fs.readText(path), schema, target.root);
  const next = new Map(current.explicit);
  for (const [key, value] of changes) {
    if (value === undefined) {
      findKey(schema, key);
      next.delete(key);
    } else {
      next.set(key, validateValue(schema, key, value));
    }
  }
  const text = serializeConfig(next, schema.version);
  if (text === current.raw) return { changed: false, config: current };
  if (current.raw === null && next.size === 0) return { changed: false, config: current };

  const token =
    options.token ?? (() => `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`);
  const temporary = `${path}.${token()}.tmp`;
  await fs.makeDirectory(join(target.root, ".github"));
  await fs.writeText(temporary, text);
  try {
    const latest = await fs.readText(path);
    if (latest !== current.raw) {
      throw new ConfigError(
        "conflict",
        `${CONFIG_PATH} changed while this update was being prepared.`,
        "Review the new contents and retry the command; nothing was overwritten.",
      );
    }
    await fs.rename(temporary, path);
  } catch (error) {
    await fs.remove(temporary).catch(() => undefined);
    throw error;
  }
  return { changed: true, config: parseConfig(text, schema, target.root) };
}
