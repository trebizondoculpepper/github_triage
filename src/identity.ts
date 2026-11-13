/**
 * Repository-local agent identity service (#70, doc/design/identity.md).
 *
 * Owns `<working-tree-root>/agent-inbox.toml`: Git root resolution, explicit entry selection,
 * typed reads of the registered per-agent settings (`identity.name`, `identity.triage_role`)
 * and conflict-detecting atomic writes that preserve every other value and table.
 *
 * - The file lives only at the Git working-tree root (nested directories and linked worktrees
 *   with a `.git` file resolve through Git). There is no parent/sibling/global fallback, and a
 *   remote `--repo` alone never selects local storage: it must agree with the checkout.
 * - Reads never create, rewrite or repair anything. Read-only consumers (#38, #64, #25) call
 *   `readIdentity`/`lookupIdentity`.
 * - Writes establish Git exclusion before creating the file (repository-local
 *   `info/exclude`, never global settings), refuse a tracked file without untracking it, and
 *   never commit or delete.
 * - Parsing/serialising uses smol-toml. The serialiser keeps every key, table and typed value
 *   (integers as BigInt, floats, dates/times) but does NOT keep comments or layout: a write
 *   normalises formatting. This is documented rather than claiming byte preservation.
 * - Results only ever expose the selected entry's registered values; other agents' data,
 *   unknown keys and credentials are never returned. Paths are reported relative to the root.
 */

import { dirname, isAbsolute, join } from "node:path";
import { parse, stringify, TomlError } from "smol-toml";
import { ConfigError, githubRepositories, nodeFileSystem, nodeGit } from "./config.js";
import type { ConfigFileSystem, GitRunner } from "./config.js";

/** Root-relative identity file name (shared format with the agent-inbox tooling). */
export const IDENTITY_FILE = "agent-inbox.toml";

/** Accepted `triage_role` values. Independent of any generic `role` key, which is preserved. */
export const TRIAGE_ROLES = ["implementer", "designer"] as const;
export type TriageRole = (typeof TRIAGE_ROLES)[number];

/** A registered per-agent setting and the table field it is stored in. */
export interface IdentityKey {
  readonly key: string;
  readonly field: "name" | "triage_role";
  readonly validValues: readonly string[] | "agent name";
  readonly description: string;
}

/** The single registry of per-agent settings routed to `[agents.KEY]`. */
export const IDENTITY_KEYS: readonly IdentityKey[] = [
  {
    key: "identity.name",
    field: "name",
    validValues: "agent name",
    description:
      "Stable workflow attribution name of the selected agent entry (letters, digits, '_', '.', '-'). Generated once when the entry is initialised; changing it never rewrites GitHub claims.",
  },
  {
    key: "identity.triage_role",
    field: "triage_role",
    validValues: TRIAGE_ROLES,
    description:
      "Default triage role of the selected agent entry (implementer or designer). Setting it initialises a missing file/entry with a generated name. Separate from any existing 'role' key, which is preserved.",
  },
];

export const isIdentityKey = (key: string): boolean => key.startsWith("identity.");

const ENTRY_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

/** Validate an `--entry` key. Dotted keys such as `ori.review` are one quoted table key. */
export function validateEntryKey(entry: string): string {
  if (!ENTRY_PATTERN.test(entry) || RESERVED.has(entry) || entry.length > 100) {
    throw new ConfigError(
      "invalid-value",
      `Invalid --entry ${JSON.stringify(entry)}: use letters, digits, '_', '.' or '-'.`,
      "Pass the agent entry key, for example --entry codex or --entry ori.review.",
    );
  }
  return entry;
}

function identityKey(key: string): IdentityKey {
  const entry = IDENTITY_KEYS.find((candidate) => candidate.key === key);
  if (!entry) {
    throw new ConfigError(
      "unknown-key",
      `Unknown identity setting "${key}".`,
      `Supported identity keys: ${IDENTITY_KEYS.map((k) => k.key).join(", ")}.`,
    );
  }
  return entry;
}

/** Validate a value for a registered identity key. */
export function validateIdentityValue(key: string, value: string): string {
  const entry = identityKey(key);
  const ok =
    entry.validValues === "agent name"
      ? NAME_PATTERN.test(value) && value.length <= 100
      : entry.validValues.includes(value);
  if (!ok) {
    throw new ConfigError(
      "invalid-value",
      `Invalid value for "${key}": ${JSON.stringify(value)}.`,
      `${entry.description} Valid: ${entry.validValues === "agent name" ? "an agent name" : entry.validValues.join(", ")}.`,
    );
  }
  return value;
}

/** A resolved working-tree root; `repository` is set only when `--repo` was verified. */
export interface IdentityTarget {
  readonly root: string;
  readonly repository: string | null;
}

/**
 * Resolve the Git working-tree root containing `cwd`. Works from nested directories and from
 * linked worktrees (`.git` file). Never walks to a parent/sibling project or a global location.
 * With `repository`, the checkout's GitHub remotes must include it.
 */
export async function resolveIdentityTarget(
  cwd: string,
  repository: string | undefined,
  git: GitRunner = nodeGit,
): Promise<IdentityTarget> {
  let root = "";
  try {
    root = (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch {
    root = "";
  }
  if (!root) {
    throw new ConfigError(
      "not-a-repository",
      "The current directory is not inside a Git working tree, so there is no agent identity file to use.",
      "Run the command from inside the repository's local checkout (not a bare repository or its .git directory).",
    );
  }
  if (repository === undefined) return { root, repository: null };
  let remotes = "";
  try {
    remotes = await git(["remote", "-v"], root);
  } catch {
    remotes = "";
  }
  const wanted = repository.toLowerCase();
  if (!githubRepositories(remotes).includes(wanted)) {
    throw new ConfigError(
      "repository-mismatch",
      `The current checkout is not ${repository}; its local identity file cannot be selected by --repo alone.`,
      "Run from a local checkout of the intended repository.",
    );
  }
  return { root, repository: wanted };
}

/** The selected entry's registered values. Nothing else from the file is ever returned. */
export interface IdentityRecord {
  /** Root-relative path, never an absolute private path. */
  readonly path: typeof IDENTITY_FILE;
  readonly entry: string;
  readonly fileExists: boolean;
  readonly entryExists: boolean;
  /** Valid stored name, or null when absent/invalid. */
  readonly name: string | null;
  /** Valid stored triage role, or null when absent/invalid. */
  readonly triageRole: TriageRole | null;
  /** Non-secret problems such as an invalid stored triage_role (values are not echoed). */
  readonly problems: readonly string[];
}

type Table = Record<string, unknown>;

const isTable = (value: unknown): value is Table =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

const malformed = (detail: string): ConfigError =>
  new ConfigError(
    "malformed",
    `${IDENTITY_FILE} is not valid for identity use: ${detail}`,
    `Fix or restore ${IDENTITY_FILE} at the repository root by hand, then retry; nothing was changed.`,
  );

/** Parse the whole document with types preserved (integers as BigInt). Never writes. */
export function parseIdentityDocument(raw: string): Table {
  let document: unknown;
  try {
    document = parse(raw, { integersAsBigInt: true });
  } catch (error) {
    if (error instanceof TomlError) {
      // Line/column only: the message's code frame could echo private values.
      throw malformed(`TOML syntax error at line ${error.line}, column ${error.column}.`);
    }
    throw error;
  }
  if (!isTable(document)) throw malformed("the document is not a table.");
  if (document.agents !== undefined && !isTable(document.agents)) {
    throw malformed("'agents' is not a table.");
  }
  return document;
}

/** Serialise a document. Keys, tables and typed values survive; comments/layout do not. */
export function serializeIdentityDocument(document: Table): string {
  return stringify(document, { numbersAsFloat: true });
}

function recordFor(document: Table | null, entry: string): IdentityRecord {
  const agents = document?.agents as Table | undefined;
  const table = agents && Object.hasOwn(agents, entry) ? agents[entry] : undefined;
  const problems: string[] = [];
  if (table !== undefined && !isTable(table)) {
    problems.push(`agents.${entry} is not a table.`);
  }
  const values = isTable(table) ? table : {};
  let name: string | null = null;
  if (values.name !== undefined) {
    if (typeof values.name === "string" && NAME_PATTERN.test(values.name)) name = values.name;
    else problems.push("Stored name is not a valid agent name.");
  }
  let triageRole: TriageRole | null = null;
  if (values.triage_role !== undefined) {
    if (TRIAGE_ROLES.includes(values.triage_role as TriageRole)) {
      triageRole = values.triage_role as TriageRole;
    } else {
      problems.push(`Stored triage_role is not one of ${TRIAGE_ROLES.join(", ")}.`);
    }
  }
  return {
    path: IDENTITY_FILE,
    entry,
    fileExists: document !== null,
    entryExists: table !== undefined,
    name,
    triageRole,
    problems,
  };
}

/** Read-only lookup of one entry. Missing files/entries are reported, never created. */
export async function readIdentity(
  root: string,
  entry: string,
  fs: ConfigFileSystem = nodeFileSystem,
): Promise<IdentityRecord> {
  validateEntryKey(entry);
  const raw = await fs.readText(join(root, IDENTITY_FILE));
  return recordFor(raw === null ? null : parseIdentityDocument(raw), entry);
}

/** Read-only service for consumers (#38 detection, #64 doctor, #25 MCP): resolve then read. */
export async function lookupIdentity(options: {
  readonly cwd: string;
  readonly entry: string;
  readonly repository?: string;
  readonly git?: GitRunner;
  readonly fs?: ConfigFileSystem;
}): Promise<IdentityRecord & { readonly repository: string | null }> {
  const target = await resolveIdentityTarget(options.cwd, options.repository, options.git);
  const record = await readIdentity(target.root, options.entry, options.fs);
  return { ...record, repository: target.repository };
}

/** The value a registered key reads from a record. */
export function identityValue(record: IdentityRecord, key: string): string | null {
  return identityKey(key).field === "name" ? record.name : record.triageRole;
}

// Human-like generated names: first_last, lower case, checked against local names.
const GIVEN = [
  "amara",
  "bilal",
  "chen",
  "dalia",
  "emeka",
  "farah",
  "goran",
  "hana",
  "idris",
  "jonas",
  "keiko",
  "lars",
  "mira",
  "nadia",
  "omar",
  "priya",
  "quinn",
  "rosa",
  "samir",
  "talia",
  "uma",
  "viktor",
  "wren",
  "xenia",
  "yusuf",
  "zara",
  "anouk",
  "bruno",
  "celeste",
  "dario",
];
const FAMILY = [
  "abara",
  "bianchi",
  "castell",
  "dimitrov",
  "eklund",
  "ferreira",
  "gallo",
  "haddad",
  "ivanova",
  "jensen",
  "kowalski",
  "lindqvist",
  "moreau",
  "nakamura",
  "okafor",
  "petrov",
  "quaresma",
  "rahman",
  "sato",
  "tanaka",
  "ueda",
  "varga",
  "weber",
  "xu",
  "yilmaz",
  "zeller",
];

/** Generate a human-like name not already used by any local entry (case-insensitive). */
export function generateName(taken: ReadonlySet<string>, random: () => number): string {
  const pick = (list: readonly string[]) => list[Math.floor(random() * list.length)]!;
  for (let attempt = 0; attempt < 200; attempt++) {
    const name = `${pick(GIVEN)}_${pick(FAMILY)}`;
    if (!taken.has(name)) return name;
  }
  throw new ConfigError(
    "conflict",
    "Could not generate an unused agent name.",
    "Choose one explicitly with github-triage config set identity.name NAME --entry KEY.",
  );
}

function namesInUse(document: Table, except: string): Set<string> {
  const taken = new Set<string>();
  const agents = isTable(document.agents) ? document.agents : {};
  for (const [key, table] of Object.entries(agents)) {
    if (key !== except && isTable(table) && typeof table.name === "string") {
      taken.add(table.name.toLowerCase());
    }
  }
  return taken;
}

/** Exit code of a Git command: 0 on success, the process exit code on failure, else null. */
async function gitStatus(git: GitRunner, args: readonly string[], cwd: string) {
  try {
    await git(args, cwd);
    return 0;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "number" ? code : null;
  }
}

/** Git standing of the identity file: tracked, ignored, or neither. Read-only. */
export async function identityGitState(
  root: string,
  git: GitRunner = nodeGit,
): Promise<{ tracked: boolean | null; ignored: boolean | null }> {
  const tracked = await gitStatus(git, ["ls-files", "--error-unmatch", "--", IDENTITY_FILE], root);
  const ignored = await gitStatus(
    git,
    ["check-ignore", "--quiet", "--no-index", IDENTITY_FILE],
    root,
  );
  return {
    tracked: tracked === 0 ? true : tracked === 1 ? false : null,
    ignored: ignored === 0 ? true : ignored === 1 ? false : null,
  };
}

/**
 * Ensure the identity file is Git-ignored before any write. Reuses existing ignore coverage;
 * otherwise appends a rule to the repository-local `info/exclude` resolved by Git. A tracked
 * file is refused (never untracked, committed or deleted). Returns whether a rule was added.
 */
export async function ensureExcluded(
  root: string,
  git: GitRunner,
  fs: ConfigFileSystem,
  token: () => string,
): Promise<boolean> {
  const state = await identityGitState(root, git);
  if (state.tracked === true) {
    throw new ConfigError(
      "tracked",
      `${IDENTITY_FILE} is tracked by Git; local identity must not be versioned, so it was not changed.`,
      `Decide yourself whether to untrack it (for example: git rm --cached -- ${IDENTITY_FILE}) and commit that, then retry. This tool never untracks, commits or deletes it.`,
    );
  }
  if (state.tracked === null || state.ignored === null) {
    throw new ConfigError(
      "filesystem",
      `Could not determine whether ${IDENTITY_FILE} is tracked or ignored by Git; nothing was changed.`,
      "Check that git works in this checkout, then retry.",
    );
  }
  if (state.ignored) return false;
  let excludePath = (await git(["rev-parse", "--git-path", "info/exclude"], root)).trim();
  if (!isAbsolute(excludePath)) excludePath = join(root, excludePath);
  const existing = (await fs.readText(excludePath)) ?? "";
  const rule = `/${IDENTITY_FILE}`;
  if (!existing.split(/\r?\n/).includes(rule)) {
    const text = `${existing}${existing === "" || existing.endsWith("\n") ? "" : "\n"}${rule}\n`;
    await fs.makeDirectory(dirname(excludePath));
    const temporary = `${excludePath}.${token()}.tmp`;
    await fs.writeText(temporary, text);
    try {
      await fs.rename(temporary, excludePath);
    } catch (error) {
      await fs.remove(temporary).catch(() => undefined);
      throw error;
    }
  }
  const after = await identityGitState(root, git);
  if (after.ignored !== true) {
    throw new ConfigError(
      "not-ignored",
      `${IDENTITY_FILE} is still not ignored after adding a local exclude rule (a negated ignore pattern may re-include it); nothing was written.`,
      `Remove the rule that re-includes ${IDENTITY_FILE} from your ignore files, then retry.`,
    );
  }
  return true;
}

export interface IdentityWriteOptions {
  readonly fs?: ConfigFileSystem;
  readonly git?: GitRunner;
  /** Random source for name generation; injected for deterministic tests. */
  readonly random?: () => number;
  /** Unique temporary-file suffix; injected for deterministic tests. */
  readonly token?: () => string;
  /** Optional precondition: the raw text (null when absent) the caller observed earlier. */
  readonly expectedRaw?: string | null;
}

export interface IdentityWriteResult {
  readonly changed: boolean;
  readonly createdFile: boolean;
  readonly createdEntry: boolean;
  /** The name generated by the initializer for a new entry, if any. */
  readonly generatedName: string | null;
  /** Whether a repository-local exclude rule was added before writing. */
  readonly excluded: boolean;
  readonly record: IdentityRecord;
}

const conflict = (): ConfigError =>
  new ConfigError(
    "conflict",
    `${IDENTITY_FILE} changed while this update was being prepared.`,
    "Retry the command; nothing was overwritten.",
  );

/**
 * Set one registered identity setting on the selected entry, preserving all other data.
 * Setting `identity.triage_role` on an absent file/entry runs the shared initializer: it
 * creates the entry with a generated, locally unique name once. A valid existing name is never
 * regenerated. Equal writes are no-ops. Writes are atomic and refuse intervening edits.
 */
export async function setIdentity(
  target: IdentityTarget,
  entry: string,
  key: string,
  value: string,
  options: IdentityWriteOptions = {},
): Promise<IdentityWriteResult> {
  validateEntryKey(entry);
  const field = identityKey(key).field;
  validateIdentityValue(key, value);
  const fs = options.fs ?? nodeFileSystem;
  const git = options.git ?? nodeGit;
  const token =
    options.token ?? (() => `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`);
  const path = join(target.root, IDENTITY_FILE);

  const raw = await fs.readText(path);
  if (options.expectedRaw !== undefined && raw !== options.expectedRaw) throw conflict();
  const document: Table = raw === null ? Object.create(null) : parseIdentityDocument(raw);
  const before = recordFor(raw === null ? null : document, entry);
  if (before.entryExists && !isTable((document.agents as Table)[entry])) {
    throw malformed(`agents.${entry} is not a table.`);
  }
  if (field === "name" && namesInUse(document, entry).has(value.toLowerCase())) {
    throw new ConfigError(
      "conflict",
      `Another local agent entry already uses the name ${JSON.stringify(value)}.`,
      "Choose a different name; names identify one logical agent each.",
    );
  }
  if (identityValue(before, key) === value) {
    return {
      changed: false,
      createdFile: false,
      createdEntry: false,
      generatedName: null,
      excluded: false,
      record: before,
    };
  }

  if (!isTable(document.agents)) document.agents = Object.create(null);
  const agents = document.agents as Table;
  let generatedName: string | null = null;
  if (!before.entryExists) {
    const table: Table = Object.create(null);
    if (field === "triage_role") {
      generatedName = generateName(namesInUse(document, entry), options.random ?? Math.random);
      table.name = generatedName;
    }
    agents[entry] = table;
  }
  (agents[entry] as Table)[field] = value;
  const text = serializeIdentityDocument(document);

  // Exclusion is established before the file can be created or rewritten.
  const excluded = await ensureExcluded(target.root, git, fs, token);
  const temporary = `${path}.${token()}.tmp`;
  await fs.writeText(temporary, text);
  try {
    if ((await fs.readText(path)) !== raw) throw conflict();
    await fs.rename(temporary, path);
  } catch (error) {
    await fs.remove(temporary).catch(() => undefined);
    throw error;
  }
  return {
    changed: true,
    createdFile: raw === null,
    createdEntry: !before.entryExists,
    generatedName,
    excluded,
    record: recordFor(parseIdentityDocument(text), entry),
  };
}
