/**
 * Repository configuration service (#116, doc/design/repository-configuration.md).
 *
 * Owns the versioned, non-secret shared settings store: `.github/triage.toml` (#160,
 * doc/design/configuration-formats.md), with the earlier `.github/triage.json` still read and
 * written in place until an explicit `config convert`. Both files present is a refusal, never
 * a precedence rule. The service holds registered keys, typed
 * validation, defaults, schema migrations, repository resolution and atomic writes. CLI
 * commands, setup and diagnostics call this module instead of reading the file directly.
 *
 * Read-only loads never modify the file. Writes migrate supported older schemas in memory,
 * preserve unrelated supported values and atomically replace the file only when nobody else
 * changed it in the meantime. Malformed, unknown or future data is refused without rewriting.
 * Nothing here stores credentials, agent identity or caches, and nothing commits to Git.
 */

import { execFile } from "node:child_process";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { parse as parseToml, stringify as stringifyToml, TomlError } from "smol-toml";

/** Repository-relative location of the shared TOML settings file (#160). */
export const TOML_CONFIG_PATH = ".github/triage.toml";

/** Repository-relative location of the earlier JSON settings file, readable until converted. */
export const LEGACY_CONFIG_PATH = ".github/triage.json";

/**
 * The earlier JSON location, kept exported for existing importers.
 * @deprecated Use TOML_CONFIG_PATH, LEGACY_CONFIG_PATH or LoadedConfig.path.
 */
export const CONFIG_PATH = LEGACY_CONFIG_PATH;

/** Storage format of a settings file. */
export type ConfigFormat = "toml" | "json";

/** Repository-relative path of each format's file. */
export const CONFIG_PATHS: Readonly<Record<ConfigFormat, string>> = {
  toml: TOML_CONFIG_PATH,
  json: LEGACY_CONFIG_PATH,
};

/** The command that converts the JSON file to TOML (#160). */
export const CONVERT_COMMAND = "github-triage config convert";

/** The schema version this build writes. */
export const CURRENT_SCHEMA_VERSION = 1;

export type ConfigValue = boolean | string | null;

/** A registered configuration key: its type, default and help text. */
export interface ConfigKey {
  readonly key: string;
  readonly type: "boolean" | "string";
  readonly choices?: readonly string[];
  /** Whether an explicit `null` is a valid stored value. */
  readonly nullable: boolean;
  /** Effective value when nothing is stored; `null` means unset. */
  readonly defaultValue: ConfigValue;
  readonly description: string;
}

/** The single registry of supported keys. Extend here, never with special cases elsewhere. */
export const CONFIG_KEYS: readonly ConfigKey[] = [
  {
    key: "briefing.engine",
    type: "string",
    nullable: false,
    defaultValue: "datalog",
    choices: ["typescript", "datalog"],
    description:
      "Next-action decision engine: datalog (default) or explicit typescript rollback. Datalog uses --role implementer or designer, defaulting to the implementer view; rollback: github-triage config set briefing.engine typescript.",
  },
  {
    key: "complexity.enabled",
    type: "boolean",
    nullable: false,
    defaultValue: true,
    description:
      "Whether complexity estimation (complexity:XS..complexity:XXL labels) is active for this repository. Disabling it keeps existing labels and estimates.",
  },
  {
    key: "impact.enabled",
    type: "boolean",
    nullable: false,
    defaultValue: true,
    description:
      "Whether impact estimation (impact:XS..impact:XXL labels) is active for this repository. Disabling it hides impact assessment and findings but keeps existing labels and estimates.",
  },
  {
    key: "processGuide",
    type: "boolean",
    nullable: false,
    defaultValue: false,
    description:
      "Whether briefings include the compact workflow guide (#71). false omits the footer; --guide/--no-guide override per run and `github-triage process` always shows the full guide.",
  },
];

/**
 * Keys an earlier build registered and this one no longer supports (#153). A stored retired key
 * is not an error and never crashes a read: it is ignored (no effective value), reported in
 * `LoadedConfig.retired` so callers can show a diagnostic, and dropped by the next command-mediated
 * write (`config set`). This is not a schema migration: the schema version is unchanged.
 */
export const RETIRED_CONFIG_KEYS: readonly { readonly key: string; readonly reason: string }[] = [
  {
    key: "complexity.fieldId",
    reason:
      "complexity is stored as complexity:XS..complexity:XXL labels; the native issue field mapping was retired",
  },
];

/**
 * Diagnostic for each retired key in a loaded file. The correction re-sets complexity.enabled to
 * its current effective value: any `config set` rewrites the file without retired keys.
 */
export function retiredKeyNotices(config: LoadedConfig): {
  key: string;
  detail: string;
  next: string;
}[] {
  const enabled = settingFor(config, "complexity.enabled").value !== false;
  return config.retired.map((key) => ({
    key,
    detail: `${config.path} contains the retired key ${key} (${RETIRED_CONFIG_KEYS.find((entry) => entry.key === key)?.reason ?? "no longer supported"}); it is ignored.`,
    next: `github-triage config set complexity.enabled ${enabled}`,
  }));
}

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
  | "not-a-repository"
  | "filesystem"
  | "tracked"
  | "not-ignored"
  | "identity-unresolved"
  | "duplicate-config"
  | "partial-conversion";

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
  /** Create `path` exclusively; `mode` (POSIX permission bits) is used only for private files. */
  writeText(path: string, text: string, mode?: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Append to `path` (created when missing) without replacing concurrent additions. */
  appendText?(path: string, text: string): Promise<void>;
  /** POSIX permission bits of an existing file, or null when missing/unsupported. */
  fileMode?(path: string): Promise<number | null>;
  /** Set POSIX permission bits; a no-op where unsupported (Windows). */
  setFileMode?(path: string, mode: number): Promise<void>;
  /** Modification time in epoch ms, or null when missing; used to judge stale locks. */
  modifiedAt?(path: string): Promise<number | null>;
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
  writeText: (path, text, mode) =>
    writeFile(path, text, mode === undefined ? { flag: "wx" } : { flag: "wx", mode }),
  rename: (from, to) => rename(from, to),
  appendText: (path, text) => appendFile(path, text, { flag: "a" }),
  async fileMode(path) {
    if (process.platform === "win32") return null;
    try {
      return (await stat(path)).mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  async setFileMode(path, mode) {
    if (process.platform !== "win32") await chmod(path, mode);
  },
  async modifiedAt(path) {
    try {
      return (await stat(path)).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
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
  /** Format of the file read; null when no settings file is present. */
  readonly format: ConfigFormat | null;
  /** Repository-relative path read, or the TOML path new settings are written to. */
  readonly path: string;
  /** Schema version found on disk; null when the file is absent. */
  readonly storedVersion: number | null;
  /** Explicitly stored values, after in-memory migration. */
  readonly explicit: ReadonlyMap<string, ConfigValue>;
  readonly settings: readonly EffectiveSetting[];
  /** Raw file text as read, used to detect intervening edits. */
  readonly raw: string | null;
  /** Retired keys found in the file: ignored, and removed by the next `config set`. */
  readonly retired: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recovery = (root: string, path: string = LEGACY_CONFIG_PATH): string =>
  `Restore ${join(root, path)} from Git (git checkout -- ${path}) or remove it to return to defaults, then retry.`;

/** Render a parsed value for a message; BigInt and dates are not JSON-serialisable. */
const describe = (value: unknown): string => {
  if (typeof value === "bigint") return `${value}`;
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

/**
 * Shared TOML parse boundary (smol-toml) for identity and repository settings. Integers are
 * read as BigInt so no precision is lost. A syntax error reports line/column only: the parser's
 * code frame could echo private values. Never writes.
 */
export function parseTomlTable(
  raw: string,
  malformed: (detail: string) => ConfigError,
): Record<string, unknown> {
  let document: unknown;
  try {
    document = parseToml(raw, { integersAsBigInt: true });
  } catch (error) {
    if (error instanceof TomlError) {
      throw malformed(`TOML syntax error at line ${error.line}, column ${error.column}.`);
    }
    throw error;
  }
  if (!isRecord(document) || document instanceof Date) {
    throw malformed("the document is not a table.");
  }
  return document;
}

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
  if (
    entry.type === "string" &&
    typeof value === "string" &&
    value.trim() !== "" &&
    (!entry.choices || entry.choices.includes(value))
  )
    return value;
  throw new ConfigError(
    "invalid-value",
    `Invalid value for "${key}": expected ${entry.type}${entry.nullable ? " or null" : ""}, got ${describe(value)}.`,
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
    if (!isRecord(value) || value instanceof Date) {
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
  format: ConfigFormat = "json",
): LoadedConfig {
  const explicit = new Map<string, ConfigValue>();
  if (raw === null) {
    return {
      format: null,
      path: TOML_CONFIG_PATH,
      storedVersion: null,
      explicit,
      settings: effective(schema, explicit),
      raw,
      retired: [],
    };
  }
  const path = CONFIG_PATHS[format];
  const malformed = (detail: string) =>
    new ConfigError("malformed", `${path} ${detail}`, recovery(root, path));
  let data: Record<string, unknown>;
  if (format === "toml") {
    data = parseTomlTable(raw, (detail) => malformed(`is not valid TOML: ${detail}`));
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw malformed(`is not valid JSON: ${(error as Error).message}`);
    }
    if (!isRecord(parsed)) throw malformed("must contain a JSON object.");
    data = parsed;
  }
  // TOML integers arrive as BigInt; a float such as 1.0 is not an integer version.
  const version = data.schemaVersion;
  const storedVersion =
    format === "toml"
      ? typeof version === "bigint" && version <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(version)
        : null
      : version;
  if (typeof storedVersion !== "number" || !Number.isInteger(storedVersion) || storedVersion < 1) {
    throw malformed(`has no valid integer "schemaVersion".`);
  }
  if (storedVersion > schema.version) {
    throw new ConfigError(
      "unsupported-version",
      `${path} uses schema version ${storedVersion}; this build supports up to ${schema.version}.`,
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
        recovery(root, path),
      );
    }
    document = step.migrate(document);
  }
  const retired: string[] = [];
  try {
    for (const [key, value] of flatten(schema, document)) {
      if (RETIRED_CONFIG_KEYS.some((entry) => entry.key === key)) {
        retired.push(key);
        continue;
      }
      explicit.set(key, validateValue(schema, key, value));
    }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    throw new ConfigError(
      "incompatible",
      `${path} contains unsupported data: ${error.message}`,
      `${error.recovery} ${recovery(root, path)}`,
    );
  }
  return {
    format,
    path,
    storedVersion,
    explicit,
    settings: effective(schema, explicit),
    raw,
    retired,
  };
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

/** Raw text of both stores; null when a file is absent. */
interface StoredTexts {
  readonly toml: string | null;
  readonly json: string | null;
}

async function readStores(root: string, fs: ConfigFileSystem): Promise<StoredTexts> {
  const toml = await fs.readText(join(root, TOML_CONFIG_PATH));
  const json = await fs.readText(join(root, LEGACY_CONFIG_PATH));
  return { toml, json };
}

const sameValues = (
  left: ReadonlyMap<string, ConfigValue>,
  right: ReadonlyMap<string, ConfigValue>,
): boolean =>
  left.size === right.size &&
  [...left].every(([key, value]) => right.has(key) && right.get(key) === value);

/** Keys whose explicit values differ between two loaded stores, sorted. */
function differingKeys(left: LoadedConfig, right: LoadedConfig): string[] {
  const keys = new Set([...left.explicit.keys(), ...right.explicit.keys()]);
  return [...keys]
    .filter(
      (key) =>
        left.explicit.has(key) !== right.explicit.has(key) ||
        left.explicit.get(key) !== right.explicit.get(key),
    )
    .sort();
}

const preferCommands = (): string =>
  (["toml", "json"] as const).map((format) => `${CONVERT_COMMAND} --prefer ${format}`).join("\n");

/**
 * The refusal for both stores present. Never picks one: it says whether they agree and gives
 * the exact command that resolves it (`config convert` removes a JSON file whose settings the
 * TOML file already holds; `--prefer` names the file to keep when they disagree).
 */
function duplicateConfig(root: string, schema: ConfigSchema, stores: StoredTexts): ConfigError {
  let toml: LoadedConfig | null = null;
  let json: LoadedConfig | null = null;
  try {
    toml = parseConfig(stores.toml, schema, root, "toml");
  } catch {
    toml = null;
  }
  try {
    json = parseConfig(stores.json, schema, root, "json");
  } catch {
    json = null;
  }
  const both = `Both ${TOML_CONFIG_PATH} and ${LEGACY_CONFIG_PATH} exist`;
  if (toml && json && sameValues(toml.explicit, json.explicit)) {
    return new ConfigError(
      "duplicate-config",
      `${both}; they hold the same settings, but only one may be authoritative. Nothing was read or changed.`,
      `Remove the redundant JSON file with:\n${CONVERT_COMMAND}`,
    );
  }
  const detail =
    toml && json
      ? `they disagree on ${differingKeys(toml, json).join(", ")}`
      : `${toml ? LEGACY_CONFIG_PATH : json ? TOML_CONFIG_PATH : "both"} cannot be read`;
  return new ConfigError(
    "duplicate-config",
    `${both} and ${detail}; neither is preferred automatically. Nothing was read or changed.`,
    `Keep one file's settings and remove the other with one of:\n${preferCommands()}`,
  );
}

/**
 * Read-only load. Missing files yield defaults; nothing is ever modified or converted. The
 * TOML file is read when present, else the earlier JSON file. Both present is refused.
 */
export async function loadConfig(
  root: string,
  fs: ConfigFileSystem = nodeFileSystem,
  schema: ConfigSchema = DEFAULT_SCHEMA,
): Promise<LoadedConfig> {
  const stores = await readStores(root, fs);
  if (stores.toml !== null && stores.json !== null) throw duplicateConfig(root, schema, stores);
  return stores.toml !== null
    ? parseConfig(stores.toml, schema, root, "toml")
    : parseConfig(stores.json, schema, root, "json");
}

/** Header written at the top of the TOML file; comments are not otherwise preserved. */
export const TOML_HEADER =
  "# Shared github-triage repository settings (not secrets, not agent identity).\n# Change them with `github-triage config set KEY VALUE`; see `github-triage config help`.\n\n";

/** Serialise values in the canonical current-schema layout of the given format. */
export function serializeConfig(
  values: ReadonlyMap<string, ConfigValue>,
  version: number,
  format: ConfigFormat = "json",
): string {
  const document = nest(values, version);
  return format === "toml"
    ? `${TOML_HEADER}${stringifyToml(document)}\n`
    : JSON.stringify(document, null, 2) + "\n";
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

/** Parse one remote URL; returns `owner/name` only when the host is exactly github.com. */
export function githubRepositoryFromUrl(url: string): string | null {
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(url);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (!["https:", "http:", "ssh:", "git:", "git+ssh:", "ssh+git:"].includes(parsed.protocol)) {
      return null;
    }
    host = parsed.hostname;
    path = parsed.pathname;
  } else if (scp && !/^[a-z]$/i.test(scp[1]!)) {
    // SCP-style `git@github.com:owner/name.git`; a single letter is a Windows drive.
    host = scp[1]!;
    path = scp[2]!;
  } else {
    return null;
  }
  if (host.toLowerCase() !== "github.com") return null;
  const match = /^\/?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(path);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

/** Extract `owner/name` from `git remote -v` output (https, ssh and scp-like forms). */
export function githubRepositories(remotes: string): string[] {
  const found = new Set<string>();
  for (const line of remotes.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    const url = fields.length >= 2 ? fields[1]! : fields[0]!;
    const repository = url ? githubRepositoryFromUrl(url) : null;
    if (repository) found.add(repository);
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
  /**
   * Optional precondition: the raw file text (null when absent) the caller observed earlier,
   * e.g. what it showed an operator before a slow step. When given and the file no longer
   * matches, the update is refused with a conflict instead of applying to newer contents.
   */
  readonly expectedRaw?: string | null;
}

export interface WriteResult {
  readonly changed: boolean;
  readonly config: LoadedConfig;
}

const conflict = (path: string = TOML_CONFIG_PATH): ConfigError =>
  new ConfigError(
    "conflict",
    `${path} changed while this update was being prepared.`,
    "Review the new contents and retry the command; nothing was overwritten.",
  );

const temporaryToken = (): string =>
  `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;

/**
 * Atomically replace `relative` with `text`: write a temporary copy beside it, then rename it
 * into place only if both stores still hold exactly what was read (`expected`). Any other
 * outcome removes the temporary copy and leaves both files untouched.
 */
async function replaceAtomically(
  root: string,
  relative: string,
  text: string,
  expected: StoredTexts,
  fs: ConfigFileSystem,
  token: () => string,
): Promise<void> {
  const path = join(root, relative);
  const temporary = `${path}.${token()}.tmp`;
  await fs.makeDirectory(join(root, ".github"));
  try {
    await fs.writeText(temporary, text);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      await fs.remove(temporary).catch(() => undefined);
    }
    throw error;
  }
  try {
    const latest = await readStores(root, fs);
    if (latest.toml !== expected.toml) throw conflict(TOML_CONFIG_PATH);
    if (latest.json !== expected.json) throw conflict(LEGACY_CONFIG_PATH);
    await fs.rename(temporary, path);
  } catch (error) {
    await fs.remove(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * Validate and apply changes to a verified repository, migrating supported older schemas.
 * Writes the store that is present: the TOML file, or the earlier JSON file in place until it
 * is converted explicitly (never converted on write). With neither present, a new TOML file is
 * created. Both present is refused. Writes a temporary file beside the target and renames it
 * into place only if neither store changed since it was read; otherwise refuses with a
 * conflict. Equal writes are no-ops.
 */
export async function updateConfig(
  target: RepositoryTarget,
  changes: ConfigChanges,
  options: WriteOptions = {},
): Promise<WriteResult> {
  const fs = options.fs ?? nodeFileSystem;
  const schema = options.schema ?? DEFAULT_SCHEMA;
  const stores = await readStores(target.root, fs);
  if (stores.toml !== null && stores.json !== null) {
    throw duplicateConfig(target.root, schema, stores);
  }
  const format: ConfigFormat = stores.json !== null ? "json" : "toml";
  const current = parseConfig(stores[format], schema, target.root, format);
  if (options.expectedRaw !== undefined && current.raw !== options.expectedRaw) {
    throw conflict(CONFIG_PATHS[format]);
  }
  const next = new Map(current.explicit);
  for (const [key, value] of changes) {
    if (value === undefined) {
      findKey(schema, key);
      next.delete(key);
    } else {
      next.set(key, validateValue(schema, key, value));
    }
  }
  const text = serializeConfig(next, schema.version, format);
  if (text === current.raw) return { changed: false, config: current };
  if (current.raw === null && next.size === 0) return { changed: false, config: current };
  await replaceAtomically(
    target.root,
    CONFIG_PATHS[format],
    text,
    stores,
    fs,
    options.token ?? temporaryToken,
  );
  return { changed: true, config: parseConfig(text, schema, target.root, format) };
}

/** What `config convert` did. Nothing is ever committed to Git. */
export type ConvertStatus =
  /** No settings file: nothing to convert and nothing created. */
  | "nothing-to-convert"
  /** Only the TOML file exists: already converted. */
  | "already-toml"
  /** The JSON settings were written to TOML, verified, and the JSON file removed. */
  | "converted"
  /** Both existed with the same settings (or --prefer toml): the JSON file was removed. */
  | "removed-json"
  /** Both existed and --prefer json: TOML replaced by the JSON settings, then JSON removed. */
  | "replaced-toml";

export interface ConvertOptions extends WriteOptions {
  /** Which file's settings to keep when both exist and disagree. Ignored otherwise. */
  readonly prefer?: ConfigFormat;
}

export interface ConvertResult {
  readonly status: ConvertStatus;
  /** Whether the TOML file was written. */
  readonly wroteToml: boolean;
  /** Whether the JSON file was removed. */
  readonly removedJson: boolean;
  /** Retired keys (#153) in the JSON file that were not carried into TOML. */
  readonly droppedRetired: readonly string[];
  /** The settings now in effect, read back from the TOML file (defaults when none). */
  readonly config: LoadedConfig;
}

/**
 * Convert `.github/triage.json` to `.github/triage.toml` (#160). The only path from JSON to
 * TOML: reads never convert. The JSON file is validated with the same schema/migrations, the
 * TOML file is created atomically (refused if either file changed meanwhile), read back and
 * compared value by value, and only then is the JSON file removed, after checking it is still
 * exactly what was converted. A failure after the TOML write is a `partial-conversion` refusal
 * that says what exists and the exact command that finishes the job; the original JSON is
 * never removed unless its settings are verified in TOML. Both files present converts only
 * when they agree or `prefer` names the file to keep. Nothing is committed.
 */
export async function convertConfig(
  target: RepositoryTarget,
  options: ConvertOptions = {},
): Promise<ConvertResult> {
  const fs = options.fs ?? nodeFileSystem;
  const schema = options.schema ?? DEFAULT_SCHEMA;
  const root = target.root;
  const stores = await readStores(root, fs);
  if (stores.json === null) {
    const config = parseConfig(stores.toml, schema, root, "toml");
    return {
      status: stores.toml === null ? "nothing-to-convert" : "already-toml",
      wroteToml: false,
      removedJson: false,
      droppedRetired: [],
      config,
    };
  }
  // An explicit --prefer requires only the preferred file to be valid; the discarded file is
  // removed or replaced only after a byte-for-byte unchanged-since-read check.
  const prefer = stores.toml === null ? undefined : options.prefer;
  // The preferred file (the only file, when the TOML is absent) must be valid: its parse error
  // is the refusal. Without a preference, either file failing is a duplicate-config refusal.
  const json =
    stores.toml === null || prefer === "json"
      ? parseConfig(stores.json, schema, root, "json")
      : tryParse(stores.json, schema, root, "json");
  let toml: LoadedConfig | null = null;
  if (stores.toml !== null) {
    toml =
      prefer === "toml"
        ? parseConfig(stores.toml, schema, root, "toml")
        : tryParse(stores.toml, schema, root, "toml");
    const agree = toml !== null && json !== null && sameValues(toml.explicit, json.explicit);
    if (!agree && prefer === undefined) throw duplicateConfig(root, schema, stores);
  }
  const keepToml =
    toml !== null &&
    (prefer !== "json" || (json !== null && sameValues(toml.explicit, json.explicit)));
  let written: LoadedConfig;
  if (keepToml) {
    written = toml!;
  } else {
    const source = json!;
    const text = serializeConfig(source.explicit, schema.version, "toml");
    await replaceAtomically(
      root,
      TOML_CONFIG_PATH,
      text,
      stores,
      fs,
      options.token ?? temporaryToken,
    );
    written = await verifyConverted(root, fs, schema, source);
  }
  // Remove the JSON file only if the retained TOML still holds the verified settings and the
  // JSON is still exactly what was read: another process may have changed either meanwhile.
  await recheckRetainedToml(root, fs, schema, written, keepToml ? stores.toml : null);
  try {
    const latest = await fs.readText(join(root, LEGACY_CONFIG_PATH));
    if (latest !== stores.json) {
      throw new ConfigError(
        "partial-conversion",
        `${LEGACY_CONFIG_PATH} changed during conversion, so it was kept; ${TOML_CONFIG_PATH} ${keepToml ? "was not changed" : "holds the verified settings as they were when conversion started"}.`,
        `Review both files, then keep one file's settings with one of:\n${preferCommands()}`,
      );
    }
    await fs.remove(join(root, LEGACY_CONFIG_PATH));
  } catch (caught) {
    if (caught instanceof ConfigError) throw caught;
    const error = filesystemRefusal(caught);
    if (!error) throw caught;
    throw new ConfigError(
      "partial-conversion",
      `${TOML_CONFIG_PATH} holds the verified settings, but ${LEGACY_CONFIG_PATH} could not be removed (${error.message}); both files now exist.`,
      `Fix access to ${LEGACY_CONFIG_PATH}, then finish with:\n${CONVERT_COMMAND}`,
    );
  }
  return {
    status: stores.toml === null ? "converted" : keepToml ? "removed-json" : "replaced-toml",
    wroteToml: !keepToml,
    removedJson: true,
    droppedRetired: keepToml ? [] : json!.retired,
    config: written,
  };
}

/** Parse a store that is about to be discarded; invalid contents yield null, not a refusal. */
function tryParse(
  raw: string | null,
  schema: ConfigSchema,
  root: string,
  format: ConfigFormat,
): LoadedConfig | null {
  try {
    return parseConfig(raw, schema, root, format);
  } catch (caught) {
    if (caught instanceof ConfigError && caught.code !== "filesystem") return null;
    throw caught;
  }
}

/**
 * Immediately before the JSON file is removed, re-read the TOML file that will remain and
 * require that it exists, parses and holds exactly the verified settings (byte-identical to
 * `snapshot` when given). Otherwise the JSON file is kept and conversion is refused.
 */
async function recheckRetainedToml(
  root: string,
  fs: ConfigFileSystem,
  schema: ConfigSchema,
  verified: LoadedConfig,
  snapshot: string | null,
): Promise<void> {
  const refuse = (detail: string) =>
    new ConfigError(
      "partial-conversion",
      `${TOML_CONFIG_PATH} ${detail} during conversion, so ${LEGACY_CONFIG_PATH} was kept.`,
      `Review both files, then keep one file's settings with one of:\n${preferCommands()}`,
    );
  let raw: string | null;
  try {
    raw = await fs.readText(join(root, TOML_CONFIG_PATH));
  } catch (caught) {
    const error = filesystemRefusal(caught);
    if (!error) throw caught;
    throw refuse(`could not be read (${error.message})`);
  }
  if (raw === null) throw refuse("was removed");
  if (snapshot !== null && raw === snapshot) return;
  let latest: LoadedConfig;
  try {
    latest = parseConfig(raw, schema, root, "toml");
  } catch (caught) {
    if (!(caught instanceof ConfigError)) throw caught;
    throw refuse("became unreadable");
  }
  if (!sameValues(latest.explicit, verified.explicit)) throw refuse("changed");
}

/** Read the new TOML file back and require exactly the converted values. */
async function verifyConverted(
  root: string,
  fs: ConfigFileSystem,
  schema: ConfigSchema,
  source: LoadedConfig,
): Promise<LoadedConfig> {
  const failed = (detail: string) =>
    new ConfigError(
      "partial-conversion",
      `${TOML_CONFIG_PATH} was written but could not be verified (${detail}); ${LEGACY_CONFIG_PATH} was kept unchanged.`,
      `Inspect ${TOML_CONFIG_PATH}, then keep the original JSON settings with:\n${CONVERT_COMMAND} --prefer json`,
    );
  let written: LoadedConfig;
  try {
    const raw = await fs.readText(join(root, TOML_CONFIG_PATH));
    if (raw === null) throw failed("it is missing");
    written = parseConfig(raw, schema, root, "toml");
  } catch (caught) {
    if (caught instanceof ConfigError && caught.code === "partial-conversion") throw caught;
    const error = filesystemRefusal(caught) ?? caught;
    if (!(error instanceof ConfigError)) throw caught;
    throw failed(error.message);
  }
  if (!sameValues(written.explicit, source.explicit)) {
    throw failed(`it does not hold the same settings as ${LEGACY_CONFIG_PATH}`);
  }
  return written;
}

/**
 * Expected operating-system filesystem failures (permission, missing directory, full disk, …)
 * become a structured refusal; anything else, including programming errors, still propagates.
 */
export function filesystemRefusal(error: unknown): ConfigError | null {
  if (!(error instanceof Error)) return null;
  const { code, path } = error as NodeJS.ErrnoException;
  if (typeof code !== "string" || !/^E[A-Z]+$/.test(code)) return null;
  const where = path ? ` (${path})` : "";
  return new ConfigError(
    "filesystem",
    `Could not access the configuration file${where}: ${code}.`,
    "Check the file and its directory exist and are readable/writable by you, and that the disk has space; then retry. Nothing was changed.",
  );
}
