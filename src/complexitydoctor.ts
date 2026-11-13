/**
 * Ticket Doctor: repository complexity configuration (#120).
 * Contract: doc/design/complexity-estimation.md "Ticket Doctor" and doc/design/diagnostics.md.
 *
 * Read-only. Loads `.github/triage.json` through the configuration service and, when online
 * and enabled, reuses `setup complexity` discovery/classification (complexitysetup.ts) to
 * verify the mapped native issue field. It never creates fields, writes configuration or
 * changes settings. Missing evidence is reported as unknown, never as healthy. Unestimated
 * tickets are normal queue work and are not examined here.
 */
import {
  ConfigError,
  filesystemRefusal,
  loadConfig,
  nodeFileSystem,
  nodeGit,
  resolveRepositoryTarget,
  settingFor,
} from "./config.js";
import type { ConfigFileSystem, EffectiveSetting, GitRunner } from "./config.js";
import { discoverFields, ghFieldApi } from "./complexitysetup.js";
import type { DiscoveredField, Discovery, FieldApi } from "./complexitysetup.js";
import type { Certainty } from "./ticketdoctor.js";

export type ComplexityConfigStatus =
  | "disabled"
  | "unconfigured"
  | "configured-compatible"
  | "incompatible"
  | "missing"
  | "inaccessible"
  | "unsupported"
  | "unknown";

export interface ConfigFinding {
  /** Stable rule ID. */
  rule: string;
  certainty: Certainty;
  detail: string;
  /** Delivered commands only; never unimplemented syntax. */
  next: string[];
}

export interface ComplexityConfigReport {
  scope: "repository";
  status: ComplexityConfigStatus;
  /** Local configuration file path, when a matching checkout was found. */
  path: string | null;
  enabled: EffectiveSetting | null;
  fieldId: string | null;
  /** Live classification of the mapped field, when it was found. */
  field: DiscoveredField | null;
  /** Native issue-field discovery status; null when not attempted. */
  discovery: Discovery["status"] | null;
  /** Whether the status rests on live evidence (false: offline, unavailable or skipped). */
  verified: boolean;
  findings: ConfigFinding[];
}

export interface ComplexityDoctorRuntime {
  readonly fs?: ConfigFileSystem;
  readonly git?: GitRunner;
  readonly cwd?: string;
  readonly api?: FieldApi;
}

const SETUP = "github-triage setup complexity";
const DISABLE = "github-triage config set complexity.enabled false";

/** Diagnose complexity configuration for `repository`. Never throws for missing evidence. */
export async function diagnoseComplexityConfig(
  repository: string,
  { offline = false }: { offline?: boolean } = {},
  runtime: ComplexityDoctorRuntime = {},
): Promise<ComplexityConfigReport> {
  const report: ComplexityConfigReport = {
    scope: "repository",
    status: "unknown",
    path: null,
    enabled: null,
    fieldId: null,
    field: null,
    discovery: null,
    verified: false,
    findings: [],
  };
  const finding = (rule: string, certainty: Certainty, detail: string, next: string[]) =>
    void report.findings.push({ rule, certainty, detail, next });

  let config;
  try {
    const target = await resolveRepositoryTarget(
      runtime.cwd ?? process.cwd(),
      repository,
      runtime.git ?? nodeGit,
    );
    report.path = `${target.root}/.github/triage.json`;
    config = await loadConfig(target.root, runtime.fs ?? nodeFileSystem);
  } catch (caught) {
    const error = filesystemRefusal(caught) ?? caught;
    if (!(error instanceof ConfigError)) throw error;
    const local =
      error.code === "not-a-repository" ||
      error.code === "repository-mismatch" ||
      error.code === "filesystem";
    finding(
      local ? "config-unavailable" : "config-invalid",
      local ? "unknown" : "definite",
      local
        ? `Repository configuration not read: ${error.message} Complexity configuration is unknown, not healthy.`
        : `${error.message} Complexity configuration cannot be evaluated.`,
      [error.recovery],
    );
    return report;
  }

  const enabled = settingFor(config, "complexity.enabled");
  const fieldSetting = settingFor(config, "complexity.fieldId");
  const fieldId = typeof fieldSetting.value === "string" ? fieldSetting.value : null;
  Object.assign(report, { enabled, fieldId });
  if (enabled.value === false) {
    // Disabled: complexity-field findings are suppressed and nothing remote is consulted.
    report.status = "disabled";
    report.verified = true;
    return report;
  }

  let discovery: Discovery | null = null;
  let failure = "";
  if (offline) failure = "offline: native issue fields were not checked live";
  else
    try {
      discovery = await discoverFields(runtime.api ?? ghFieldApi, repository);
      report.discovery = discovery.status;
    } catch (error) {
      failure = `native issue-field discovery failed: ${(error as Error).message}`;
    }
  const compatible = discovery?.fields.filter((f) => f.compatible) ?? [];
  const suggestion = compatible.length
    ? `${SETUP} --select ${compatible[0]!.id}`
    : discovery?.status === "available"
      ? `${SETUP} --create`
      : SETUP;

  if (discovery?.status === "unsupported" || discovery?.status === "inaccessible") {
    report.status = discovery.status;
    report.verified = true;
    finding(
      `complexity-field-api-${discovery.status}`,
      discovery.status === "unsupported" ? "definite" : "unknown",
      `${discovery.detail}${fieldId ? ` Mapped field ${fieldId} cannot be verified.` : ""} Other triage work is unaffected; labels and Project fields are not substitutes.`,
      [SETUP, DISABLE],
    );
    return report;
  }

  if (!fieldId) {
    report.status = "unconfigured";
    report.verified = true;
    finding(
      "complexity-field-unmapped",
      "candidate",
      `Complexity is enabled (${enabled.source}) but complexity.fieldId is not set.${discovery ? ` ${compatible.length} compatible field(s) among ${discovery.owner?.login ?? "the owner"}'s issue fields${discovery.status === "partial" ? " (list incomplete)" : ""}.` : ` ${failure}.`}`,
      [suggestion, DISABLE],
    );
    return report;
  }

  if (!discovery) {
    finding(
      "complexity-field-unverified",
      "unknown",
      `complexity.fieldId = ${fieldId} could not be verified (${failure}).`,
      [SETUP],
    );
    return report;
  }
  const field = discovery.fields.find((f) => f.id === fieldId) ?? null;
  report.field = field;
  if (field?.compatible) {
    report.status = "configured-compatible";
    report.verified = true;
  } else if (field) {
    report.status = "incompatible";
    report.verified = true;
    finding(
      "complexity-field-incompatible",
      "definite",
      `Mapped field ${field.id} "${field.name}" is incompatible: ${field.reason}. This tool never changes existing field options.`,
      [suggestion, DISABLE],
    );
  } else if (discovery.status === "available") {
    report.status = "missing";
    report.verified = true;
    finding(
      "complexity-field-missing",
      "definite",
      `Mapped field ${fieldId} is not among ${discovery.owner?.login ?? "the owner"}'s issue fields (deleted, or owned elsewhere).`,
      [suggestion, DISABLE],
    );
  } else {
    finding(
      "complexity-field-unverified",
      "unknown",
      `Mapped field ${fieldId} was not in the readable part of the field list: ${discovery.detail}`,
      [SETUP],
    );
  }
  return report;
}

/** Text lines for the Ticket Doctor rendering. */
export function complexityConfigText(r: ComplexityConfigReport): string[] {
  const lines = [
    `Repository configuration: complexity ${r.status}${r.fieldId ? ` (complexity.fieldId = ${r.fieldId})` : ""}${r.verified ? "" : " — not verified"}`,
  ];
  for (const f of r.findings) {
    lines.push(`  [${f.certainty}] ${f.rule}: ${f.detail}`);
    for (const command of f.next) lines.push(`    next: ${command}`);
  }
  return lines;
}
