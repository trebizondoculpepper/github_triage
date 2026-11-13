/**
 * `setup complexity` (#119, doc/design/complexity-estimation.md "Repository setup").
 *
 * Discovers native GitHub issue fields (GraphQL `issueFields`, defined at user/organization
 * scope) for the repository's owner, verifies which are compatible single-select XS..XXL
 * fields, and maps an explicitly chosen one through the configuration service. Creating a
 * field is a shared, owner-wide change: it happens only after an explicit `--create` decision
 * and, when a terminal is attached, a confirmation that explains ownership and visibility.
 * Unattended runs never prompt; without an explicit decision they return setup-required.
 *
 * Discovery is read-only. There is no label or Project-field fallback, and existing field
 * options or visibility are never changed. Repository-target checks, validation and atomic
 * writes all stay in config.ts.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { COMPLEXITY_SIZES } from "./complexity.js";
import {
  CONFIG_PATH,
  ConfigError,
  loadConfig,
  nodeFileSystem,
  nodeGit,
  resolveRepositoryTarget,
  settingFor,
  updateConfig,
} from "./config.js";
import type { ConfigFileSystem, GitRunner } from "./config.js";
import { isRecord, prop } from "./github.js";

export const setupUsage = `Usage: github-triage setup complexity [--select FIELD_ID | --create] [--json] [--repo owner/name]
(From a source checkout, use npm run triage -- setup complexity ...)
Find a native GitHub issue field for complexity (single-select with exactly the options
XS, S, M, L, XL, XXL) and map it in .github/triage.json of this checkout.
Without a decision flag it only reports: the current mapping, every discovered field and why
it is or is not compatible. With a terminal attached it then asks which field to use.
  --select FIELD_ID     Map an existing compatible field (verified live before saving)
  --create              Create a "Complexity" issue field owned by the repository owner.
                        Issue fields are user/organization-wide, not repository-owned: the
                        field becomes visible to every repository of that owner. Asks for
                        confirmation on a terminal; unattended, --create is the confirmation
  --json                Versioned structured output (kind complexity-setup)
  --repo owner/name     Refuse unless this checkout is that repository
  --help                Show usage
Discovery is read-only. Existing fields' options and visibility are never changed, and labels
or Project fields are never used instead. complexity.enabled false skips setup entirely and
keeps any mapping. The config file is written but not committed.
Exit: 0 configured, saved or disabled; 2 setup required (no decision, no compatible field,
unsupported or inaccessible API, or local save failed after creation); 1 invalid arguments
or refused choice.`;

/** Raw GraphQL response: data plus any errors, never thrown for GraphQL-level errors. */
export interface GraphqlAnswer {
  readonly data: unknown;
  readonly errors: readonly { type?: string; message?: string }[];
}
/** Injected GitHub boundary. `query` is read-only; `mutate` is used only for creation. */
export interface FieldApi {
  query(query: string, variables: Record<string, string>): Promise<GraphqlAnswer>;
  mutate(query: string, variables: Record<string, string>): Promise<GraphqlAnswer>;
}

const execute = promisify(execFile);
async function ghGraphql(query: string, variables: Record<string, string>) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) args.push("-f", `${key}=${value}`);
  let stdout: unknown;
  try {
    ({ stdout } = await execute("gh", args, { maxBuffer: 8 * 1024 * 1024, timeout: 60_000 }));
  } catch (error) {
    // gh exits non-zero on GraphQL errors but still prints the response body.
    stdout = prop(error, "stdout");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof stdout === "string" ? stdout : "");
  } catch {
    // Never echo arguments, stderr or response bodies.
    throw new Error("GitHub query failed. Check gh auth status, network and API rate limits.");
  }
  const errors = prop(parsed, "errors");
  return {
    data: prop(parsed, "data"),
    errors: Array.isArray(errors) ? errors.filter(isRecord) : [],
  };
}
export const ghFieldApi: FieldApi = { query: ghGraphql, mutate: ghGraphql };

export interface SetupRuntime {
  readonly fs?: ConfigFileSystem;
  readonly git?: GitRunner;
  readonly cwd?: string;
  readonly api?: FieldApi;
  /** Ask one question; null means unattended (no terminal) and nothing is ever asked. */
  readonly prompt?: ((question: string) => Promise<string>) | null;
}

export interface DiscoveredField {
  readonly id: string;
  readonly name: string;
  readonly dataType: string;
  readonly visibility: string | null;
  readonly options: readonly string[];
  readonly compatible: boolean;
  readonly reason: string;
}

export type DiscoveryStatus = "available" | "unsupported" | "inaccessible" | "partial";
export interface Discovery {
  readonly status: DiscoveryStatus;
  readonly owner: { login: string; type: "User" | "Organization"; id: string } | null;
  /** Whether the viewer may create owner-wide fields; null when unknown. */
  readonly canCreate: boolean | null;
  readonly fields: readonly DiscoveredField[];
  readonly detail: string;
}

const FIELDS = `issueFields(first: 100) { pageInfo { hasNextPage } nodes { __typename
  ... on IssueFieldCommon { name dataType visibility }
  ... on IssueFieldSingleSelect { id options { name } }
  ... on IssueFieldText { id } ... on IssueFieldNumber { id } ... on IssueFieldDate { id }
  ... on IssueFieldMultiSelect { id } } }`;
const DISCOVER = `query($owner: String!, $name: String!) { viewer { login }
  repository(owner: $owner, name: $name) { owner { __typename id login
    ... on Organization { viewerCanAdminister ${FIELDS} } ... on User { ${FIELDS} } } } }`;

const text = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

/** Exact ordered XS..XXL options; anything else is reported, never "fixed" remotely. */
export function classifyField(node: unknown): DiscoveredField | null {
  const id = prop(node, "id");
  if (typeof id !== "string") return null;
  const dataType = text(prop(node, "dataType"), text(prop(node, "__typename"), "unknown"));
  const raw = prop(node, "options");
  const options = Array.isArray(raw) ? raw.map((o) => text(prop(o, "name"))) : [];
  const visibility = prop(node, "visibility");
  let reason = "single-select with exactly XS, S, M, L, XL, XXL";
  if (dataType !== "SINGLE_SELECT") reason = `type ${dataType}, not SINGLE_SELECT`;
  else if (options.join() !== COMPLEXITY_SIZES.join())
    reason = `options ${options.join(", ") || "(none)"}; expected ${COMPLEXITY_SIZES.join(", ")} in order`;
  return {
    id,
    name: text(prop(node, "name")),
    dataType,
    visibility: typeof visibility === "string" ? visibility : null,
    options,
    compatible: reason.startsWith("single-select"),
    reason,
  };
}

/** Read-only discovery of the owner's issue fields and the viewer's ability to create one. */
export async function discoverFields(api: FieldApi, repository: string): Promise<Discovery> {
  const [ownerName, name] = repository.split("/") as [string, string];
  const answer = await api.query(DISCOVER, { owner: ownerName, name });
  const ownerNode = prop(answer.data, "repository", "owner");
  const unsupported = answer.errors.find((e) =>
    /doesn't exist on type|undefinedField|Unknown type/i.test(`${e.type ?? ""} ${e.message ?? ""}`),
  );
  if (unsupported || (!ownerNode && answer.errors.length && !prop(answer.data, "repository")))
    return {
      status: unsupported ? "unsupported" : "inaccessible",
      owner: null,
      canCreate: null,
      fields: [],
      detail: unsupported
        ? "This GitHub API does not offer native issue fields (GraphQL issueFields)."
        : "The repository could not be read; check gh auth status and access.",
    };
  if (!isRecord(ownerNode)) throw new Error("GitHub returned no repository owner.");
  const type = ownerNode.__typename === "Organization" ? "Organization" : "User";
  const owner = { login: String(ownerNode.login), type, id: String(ownerNode.id) } as const;
  const viewer = prop(answer.data, "viewer", "login");
  const canCreate =
    type === "Organization"
      ? typeof ownerNode.viewerCanAdminister === "boolean"
        ? ownerNode.viewerCanAdminister
        : null
      : typeof viewer === "string"
        ? viewer.toLowerCase() === owner.login.toLowerCase()
        : null;
  const connection = ownerNode.issueFields;
  if (!isRecord(connection)) {
    const forbidden = answer.errors.find((e) => e.type === "FORBIDDEN");
    return {
      status: "inaccessible",
      owner,
      canCreate,
      fields: [],
      detail: forbidden
        ? `GitHub refused to list issue fields for ${owner.login} (FORBIDDEN): issue fields may not be enabled for this ${type.toLowerCase()}, or you lack permission. Absent is not the same as unavailable.`
        : `GitHub returned no issue-field data for ${owner.login}.`,
    };
  }
  const nodes = Array.isArray(connection.nodes) ? connection.nodes : [];
  const fields = nodes.map(classifyField).filter((f): f is DiscoveredField => f !== null);
  const partial = prop(connection, "pageInfo", "hasNextPage") === true || answer.errors.length > 0;
  return {
    status: partial ? "partial" : "available",
    owner,
    canCreate,
    fields,
    detail: partial
      ? `Only part of ${owner.login}'s issue fields could be read; creation is refused until the list is complete.`
      : `${fields.length} issue field(s) defined by ${type.toLowerCase()} ${owner.login}.`,
  };
}

const CREATE = `mutation($ownerId: ID!, $name: String!, $description: String!) {
  createIssueField(input: { ownerId: $ownerId, name: $name, description: $description,
    dataType: SINGLE_SELECT, options: [${COMPLEXITY_SIZES.map(
      (size, i) => `{ name: "${size}", color: GRAY, priority: ${i + 1} }`,
    ).join(", ")}] }) {
    issueField { ... on IssueFieldSingleSelect { id name dataType visibility options { name } } } } }`;

type Decision = { kind: "select"; fieldId: string } | { kind: "create" } | { kind: "none" };

class SetupRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recovery: string,
  ) {
    super(message);
  }
}

const ownership = (d: Discovery): string =>
  d.owner
    ? `Issue fields are defined by the ${d.owner.type.toLowerCase()} ${d.owner.login}, not by this repository: a created field is visible to all of ${d.owner.login}'s repositories, with GitHub's default visibility. This repository's mapping and calibration stay local in .github/triage.json.`
    : "Issue-field ownership could not be determined.";

/** Run `setup complexity`. Returns the exit code; output is text or one JSON value. */
export async function runSetup(
  args: string[],
  output: (text: string) => Promise<void>,
  runtime: SetupRuntime = {},
): Promise<number> {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        select: { type: "string" },
        create: { type: "boolean" },
        json: { type: "boolean" },
        repo: { type: "string" },
        help: { type: "boolean" },
      },
    }));
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${setupUsage}`);
  }
  if (values.help) {
    await output(`${setupUsage}\n`);
    return 0;
  }
  if (positionals.join(" ") !== "complexity" || (values.select !== undefined && values.create))
    throw new Error(setupUsage);
  if (values.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
    throw new Error("--repo must be owner/name.");
  const json = !!values.json;
  const fs = runtime.fs ?? nodeFileSystem;
  const api = runtime.api ?? ghFieldApi;
  // JSON output must stay one parseable value, so it never prompts.
  const prompt = json ? null : (runtime.prompt ?? null);
  const result: Record<string, unknown> = { schemaVersion: 1, kind: "complexity-setup" };
  const lines: string[] = [];
  const finish = async (status: string, code: number) => {
    result.status = status;
    await output(json ? JSON.stringify(result, null, 2) + "\n" : lines.join("\n") + "\n");
    return code;
  };
  try {
    const target = await resolveRepositoryTarget(
      runtime.cwd ?? process.cwd(),
      values.repo,
      runtime.git ?? nodeGit,
    );
    const path = join(target.root, CONFIG_PATH);
    Object.assign(result, { repository: target.repository, path });
    const config = await loadConfig(target.root, fs);
    const enabled = settingFor(config, "complexity.enabled");
    const mapped = settingFor(config, "complexity.fieldId").value as string | null;
    result.enabled = enabled;
    result.mappedFieldId = mapped;
    if (enabled.value === false) {
      lines.push(
        `Complexity is disabled for ${target.repository} (complexity.enabled = false, ${enabled.source}); setup skipped. Existing mapping and estimates are kept.`,
      );
      return await finish("disabled", 0);
    }

    const discovery = await discoverFields(api, target.repository);
    result.discovery = discovery;
    lines.push(`Complexity setup for ${target.repository} (${path})`);
    lines.push(`Native issue fields: ${discovery.status} — ${discovery.detail}`);
    if (discovery.owner) lines.push(ownership(discovery));
    for (const f of discovery.fields)
      lines.push(
        `  ${f.compatible ? "compatible  " : "incompatible"} ${f.id} "${f.name}": ${f.reason}`,
      );
    const compatible = discovery.fields.filter((f) => f.compatible);
    const current = mapped ? discovery.fields.find((f) => f.id === mapped) : undefined;
    if (mapped) {
      const state = current
        ? current.compatible
          ? "compatible"
          : `incompatible (${current.reason})`
        : discovery.status === "available"
          ? "missing (not among the owner's issue fields)"
          : "unverified (field list unavailable)";
      lines.push(`Current mapping complexity.fieldId = ${mapped}: ${state}`);
      result.mappedState = state;
    }
    if (discovery.status === "unsupported" || discovery.status === "inaccessible") {
      lines.push(
        "Setup required: native issue fields cannot be used here. Labels and Project fields are not substitutes. Retry once issue fields are available to you.",
      );
      return await finish(`setup-required:${discovery.status}`, 2);
    }

    let decision: Decision =
      values.select !== undefined
        ? { kind: "select", fieldId: values.select }
        : values.create
          ? { kind: "create" }
          : { kind: "none" };
    if (decision.kind === "none" && current?.compatible) {
      lines.push("Configured: the mapped field is compatible. Nothing to do.");
      return await finish("configured", 0);
    }
    if (decision.kind === "none" && prompt) {
      decision = await ask(prompt, compatible, discovery);
    }
    if (decision.kind === "none") {
      lines.push(
        compatible.length
          ? `Setup required: choose explicitly with --select ${compatible[0]!.id}${compatible.length > 1 ? " (or another compatible ID above)" : ""}, or --create.`
          : "Setup required: no compatible field exists. Run with --create to create one (owner-wide), or create it in GitHub and use --select.",
      );
      return await finish("setup-required", 2);
    }

    if (decision.kind === "create") {
      if (discovery.status !== "available")
        throw new SetupRefusal(
          "incomplete-discovery",
          discovery.detail,
          "Retry when the full field list can be read.",
        );
      if (discovery.canCreate !== true)
        throw new SetupRefusal(
          "not-permitted",
          `You are not verified as able to create issue fields for ${discovery.owner!.login}.`,
          "Ask an owner/organization administrator to create it, then use --select FIELD_ID.",
        );
      const existing = discovery.fields.find((f) => f.name.toLowerCase() === "complexity");
      if (existing)
        throw new SetupRefusal(
          "exists",
          `A field named "${existing.name}" already exists (${existing.id}; ${existing.reason}); not creating a duplicate.`,
          existing.compatible
            ? `github-triage setup complexity --select ${existing.id}`
            : "Choose or fix a field in GitHub yourself; existing options and visibility are never changed by this tool.",
        );
      if (prompt) {
        const answer = await prompt(
          `${ownership(discovery)}\nCreate single-select field "Complexity" (XS..XXL) for ${discovery.owner!.login}? [y/N] `,
        );
        if (!/^y(es)?$/i.test(answer.trim())) {
          lines.push("Not confirmed; nothing was created.");
          return await finish("setup-required", 2);
        }
      }
      const created = await api.mutate(CREATE, {
        ownerId: discovery.owner!.id,
        name: "Complexity",
        description: "Ticket complexity (XS..XXL), recorded by github-triage.",
      });
      const field = classifyField(prop(created.data, "createIssueField", "issueField"));
      if (!field)
        throw new SetupRefusal(
          "create-failed",
          `GitHub did not create the field${created.errors[0]?.message ? `: ${created.errors[0].message}` : "."}`,
          "Nothing was saved. Run setup complexity again to re-check before retrying.",
        );
      result.created = field;
      lines.push(`Created issue field ${field.id} "${field.name}" for ${discovery.owner!.login}.`);
      if (!field.compatible) {
        lines.push(`The created field is not compatible (${field.reason}); not mapped.`);
        return await finish("setup-required", 2);
      }
      try {
        return await save(field, true);
      } catch (error) {
        const recovery = `github-triage setup complexity --select ${field.id}`;
        result.recovery = recovery;
        lines.push(
          `Created field ${field.id} but could not save the mapping: ${(error as Error).message}`,
          `Do not create it again. Recover with: ${recovery}`,
        );
        return await finish("created-not-saved", 2);
      }
    }

    const chosen = discovery.fields.find((f) => f.id === decision.fieldId);
    if (!chosen?.compatible)
      throw new SetupRefusal(
        "incompatible",
        chosen
          ? `Field ${chosen.id} is not compatible: ${chosen.reason}.`
          : `Field ${decision.fieldId} is not among ${discovery.owner?.login ?? "the owner"}'s readable issue fields.`,
        compatible.length
          ? `Compatible: ${compatible.map((f) => f.id).join(", ")}`
          : "Use --create, or create a compatible field in GitHub.",
      );
    return await save(chosen, false);

    async function save(field: DiscoveredField, created: boolean): Promise<number> {
      const write = await updateConfig(target, new Map([["complexity.fieldId", field.id]]), { fs });
      result.mappedFieldId = field.id;
      result.changed = write.changed;
      lines.push(
        write.changed
          ? `Mapped complexity.fieldId = ${field.id} in ${path} (not committed).`
          : `complexity.fieldId already ${field.id}; unchanged.`,
      );
      return finish(created ? "created" : "saved", 0);
    }
  } catch (caught) {
    if (!(caught instanceof ConfigError || caught instanceof SetupRefusal)) throw caught;
    if (!json) throw new Error(`${caught.message}\n${caught.recovery}`, { cause: caught });
    Object.assign(result, {
      code: caught.code,
      message: caught.message,
      recovery: caught.recovery,
    });
    result.kind = "complexity-setup-error";
    await output(JSON.stringify(result, null, 2) + "\n");
    return 1;
  }
}

async function ask(
  prompt: (question: string) => Promise<string>,
  compatible: readonly DiscoveredField[],
  discovery: Discovery,
): Promise<Decision> {
  const choices = compatible.map((f, i) => `  ${i + 1}) use ${f.id} "${f.name}"`);
  const createChoice = discovery.status === "available" && discovery.canCreate === true;
  if (createChoice) choices.push(`  c) create "Complexity" (owner-wide)`);
  if (!choices.length) return { kind: "none" };
  const answer = (
    await prompt(`Choose a complexity field:\n${choices.join("\n")}\n  n) not now\n> `)
  ).trim();
  const index = Number(answer);
  if (Number.isInteger(index) && index >= 1 && index <= compatible.length)
    return { kind: "select", fieldId: compatible[index - 1]!.id };
  if (createChoice && /^c$/i.test(answer)) return { kind: "create" };
  return { kind: "none" };
}

/** A terminal prompt, or null when stdin/stdout are not a TTY (never hang unattended). */
export function terminalPrompt(): ((question: string) => Promise<string>) | null {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  return async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
}
