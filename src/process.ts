/**
 * Workflow help and compact process guide (#71). Contract: doc/design/workflow-guide.md.
 *
 * The guide is generated from the registered policy the tool already enforces (readiness and
 * pickup labels, ordering modes, claim outcomes, role sections, stale-claim threshold) and from
 * the registry of implemented commands, so wording cannot drift from behaviour. It explains;
 * it never grants authority, claims, releases or executes anything.
 *
 * The recurring briefing guide is on by default. Precedence: `--guide`/`--no-guide`, then the
 * registered `processGuide` repository setting (.github/triage.toml, or the earlier .github/triage.json), then the default. An
 * unreadable or mismatched configuration never breaks a briefing: it falls back to the default
 * and reports a diagnostic. `--help` and `github-triage process` are always available, local
 * and credential-free.
 */
import { createHash } from "node:crypto";
import { workflow, briefingStaleHours } from "./briefing.js";
import { claimPolicy } from "./claims.js";
import { pickupOrders, pickupPolicy } from "./ranking.js";
import { roleRegistry } from "./roles.js";
import {
  ConfigError,
  filesystemRefusal,
  loadConfig,
  nodeFileSystem,
  nodeGit,
  resolveRepositoryTarget,
  settingFor,
} from "./config.js";
import type { ConfigFileSystem, GitRunner } from "./config.js";

/** Version of the `process` object's own shape. */
export const PROCESS_SCHEMA_VERSION = 1;
/** Maximum guide text, pointer included, in Unicode code points. */
export const MAX_GUIDE_CODE_POINTS = 900;
/** Registered repository setting that opts a project out of the recurring guide. */
export const GUIDE_CONFIG_KEY = "processGuide";
export const PROCESS_COMMAND = "github-triage process";

/** An implemented command. Only these may appear as executable advice. */
export interface CommandSpec {
  readonly name: string;
  /** Invocation with clearly marked placeholders (N, NAME, TEXT). */
  readonly template: string;
  /** Whether it changes GitHub state. */
  readonly mutatesGitHub: boolean;
}

/** Implemented commands referenced by the guide and help footer. */
export const commandRegistry: readonly CommandSpec[] = [
  {
    name: "deps add/remove",
    template: "github-triage deps add|remove N --on M --note WHY",
    mutatesGitHub: true,
  },
  {
    name: "claim",
    template: "github-triage claim N --agent NAME",
    mutatesGitHub: true,
  },
  {
    name: "release",
    template: `github-triage release N --agent NAME --as ${claimPolicy.outcomes.join("|")}`,
    mutatesGitHub: true,
  },
  {
    name: "needs-human",
    template: "github-triage needs-human N --agent NAME --designer NAME --why TEXT --question TEXT",
    mutatesGitHub: true,
  },
  {
    name: "estimate N",
    template: "github-triage estimate N --size S --rationale TEXT",
    mutatesGitHub: true,
  },
  { name: "who", template: "github-triage who N", mutatesGitHub: false },
  { name: "process", template: PROCESS_COMMAND, mutatesGitHub: false },
  // Changes only the local repository settings file, never GitHub.
  { name: "config set", template: "github-triage config set KEY VALUE", mutatesGitHub: false },
];
const command = (name: string): CommandSpec => {
  const found = commandRegistry.find((spec) => spec.name === name);
  if (!found) throw new Error(`Unregistered command ${name}`);
  return found;
};
/** Commands that change GitHub, generated for help and guide text. */
export const mutatingCommands = (): string[] =>
  commandRegistry.filter((spec) => spec.mutatesGitHub).map((spec) => spec.name);

/** One guidance-bearing rule: stable ID, the policy parameters it explains, and text. */
export interface GuideRule {
  readonly id: string;
  readonly parameters: Record<string, unknown>;
  /** One compact sentence for the recurring guide. */
  readonly summary: string;
  /** Extra explanation for the full `process` guide. */
  readonly detail: string;
}

const implementer = roleRegistry.get("implementer");
const firstSections = (implementer?.sections ?? []).slice(0, 3).map((s) => s.title.toLowerCase());

/** The registered guide, generated from live policy objects. */
export function guideRules(): GuideRule[] {
  const attention = claimPolicy.attention("NAME");
  const owner = claimPolicy.owner("NAME");
  return [
    {
      id: "attention-first",
      parameters: { attention, owner, sections: firstSections },
      summary: `Order: ${attention} work, then PR follow-up and your ${owner} claim, then pickup.`,
      detail: `Implementer sections start with: ${firstSections.join("; ")}. Attention asks for a response; it never reserves work.`,
    },
    {
      id: "pickup-eligibility",
      parameters: { available: pickupPolicy.available, prerequisites: pickupPolicy.prerequisites },
      summary: `Pick up unclaimed ${pickupPolicy.available.join(" or ")} with no open native blockers.`,
      detail: `${pickupPolicy.incomplete} is partial work and stays pickable. Not pickup: ${pickupPolicy.prerequisites.join(", ")}, ${claimPolicy.awaitingReview}. Unknown evidence is never eligibility; platform:* tickets need a matching --platform.`,
    },
    {
      id: "pickup-order",
      parameters: { orders: pickupOrders, urgency: pickupPolicy.urgency },
      summary: `Default order: ${pickupPolicy.urgency.high} first, then most immediate unlocks; --order ${pickupOrders.filter((o) => o !== "impact").join("|")} sorts by age only.`,
      detail:
        "Ordering never changes eligibility, claims or addressed attention; there is no automatic bug-first override.",
    },
    {
      id: "one-claim",
      parameters: { staleHours: briefingStaleHours },
      summary: `Hold one claim; release before switching. Claims idle ${briefingStaleHours}h+ are inspection only, never takeover.`,
      detail: `Stale claims are listed for inspection; check ${command("who").template} and ask the owner on the ticket.`,
    },
    {
      id: "claim",
      parameters: { command: command("claim").template },
      summary: `Claim: ${command("claim").template}.`,
      detail: "Claiming refuses ineligible, blocked or already-claimed tickets with the reason.",
    },
    {
      id: "release",
      parameters: {
        command: command("release").template,
        awaitingReview: claimPolicy.awaitingReview,
      },
      summary: `Hand over: ${command("release").template} (done + open PR -> ${claimPolicy.awaitingReview}).`,
      detail: `incomplete/parked keep the ticket pickable (${claimPolicy.incomplete}), never ${workflow.parked}. Release never closes a ticket.`,
    },
    {
      id: "questions-on-ticket",
      parameters: { command: command("needs-human").template, label: claimPolicy.decisionNeeded },
      summary:
        "Ask questions on the ticket; github-triage needs-human N records them for a designer.",
      detail: `Full form: ${command("needs-human").template}. It adds ${claimPolicy.decisionNeeded}. Designer and owner discussion remains welcome.`,
    },
    {
      id: "read-only",
      parameters: { mutating: mutatingCommands() },
      summary: `Briefings are read-only; only ${mutatingCommands().join(", ")} change GitHub.`,
      detail: "Suggested commands are advice: inspect, then run them yourself.",
    },
  ];
}

/** Scope statement: what the guide covers and what is not implemented yet. */
export const guideLimitations = [
  "Shared guide for all roles; per-role guides are not implemented.",
  "Explains implemented policy only; it does not enforce lifecycle transitions.",
];

/** Deterministic hash of guidance-bearing policy and command metadata (sorted keys). */
export function policyVersion(rules: readonly GuideRule[] = guideRules()): string {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
          )
        : value;
  const material = canonical({ rules, commands: commandRegistry });
  return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 12);
}

// The contract budgets Unicode code points (not graphemes or UTF-16 units).
const codePoints = (text: string): number => Array.from(text).length;

export const pointerText = (version: string, enabled: boolean): string =>
  enabled
    ? `Full guide: ${PROCESS_COMMAND} (policy ${version}). Hide: --no-guide or github-triage config set ${GUIDE_CONFIG_KEY} false.`
    : `Workflow guide off (policy ${version}); see ${PROCESS_COMMAND}.`;

/** Compact guide text including its pointer; always within MAX_GUIDE_CODE_POINTS. */
export function compactGuide(rules = guideRules(), version = policyVersion(rules)): string {
  const lines = [
    "WORKFLOW",
    ...rules.map((rule) => `- ${rule.summary}`),
    pointerText(version, true),
  ];
  const text = lines.join("\n");
  if (codePoints(text) > MAX_GUIDE_CODE_POINTS)
    throw new Error(`Compact guide exceeds ${MAX_GUIDE_CODE_POINTS} code points.`);
  return text;
}

/** Full on-demand guide for `github-triage process`. */
export function fullGuideText(): string {
  const rules = guideRules();
  const version = policyVersion(rules);
  return [
    `github-triage workflow guide (policy ${version})`,
    ...rules.map((rule) => `\n${rule.id}\n  ${rule.summary}\n  ${rule.detail}`),
    "\nCommands",
    ...commandRegistry.map(
      (spec) => `  ${spec.template}${spec.mutatesGitHub ? "  [changes GitHub]" : ""}`,
    ),
    "\nLimitations",
    ...guideLimitations.map((line) => `  ${line}`),
    `\nOpt out of the briefing guide: --no-guide, or github-triage config set ${GUIDE_CONFIG_KEY} false.`,
    "",
  ].join("\n");
}

/** Structured `process` command output. */
export function fullGuideJson() {
  const rules = guideRules();
  return {
    schemaVersion: PROCESS_SCHEMA_VERSION,
    policyVersion: policyVersion(rules),
    rules: rules.map(({ id, summary, detail }) => ({ id, summary, detail })),
    commands: commandRegistry,
    limitations: guideLimitations,
    maxGuideCodePoints: MAX_GUIDE_CODE_POINTS,
  };
}

export type GuideSource = "cli" | "config" | "default";
export interface GuideSetting {
  enabled: boolean;
  source: GuideSource;
  /** Why configuration was not applied, when it was not. Never echoes file contents. */
  diagnostics: string[];
}

export interface GuideRuntime {
  readonly fs?: ConfigFileSystem;
  readonly git?: GitRunner;
  readonly cwd?: string;
}

/** Resolve the recurring-guide setting. Never throws for configuration problems. */
export async function resolveGuideSetting(
  repository: string,
  flag: boolean | undefined,
  runtime: GuideRuntime = {},
): Promise<GuideSetting> {
  if (flag !== undefined) return { enabled: flag, source: "cli", diagnostics: [] };
  try {
    const target = await resolveRepositoryTarget(
      runtime.cwd ?? process.cwd(),
      repository,
      runtime.git ?? nodeGit,
    );
    const config = await loadConfig(target.root, runtime.fs ?? nodeFileSystem);
    const setting = settingFor(config, GUIDE_CONFIG_KEY);
    return setting.source === "explicit"
      ? { enabled: setting.value !== false, source: "config", diagnostics: [] }
      : { enabled: true, source: "default", diagnostics: [] };
  } catch (caught) {
    const error = filesystemRefusal(caught) ?? caught;
    if (!(error instanceof ConfigError)) throw error;
    const local = error.code === "not-a-repository" || error.code === "repository-mismatch";
    return {
      enabled: true,
      source: "default",
      diagnostics: [
        local
          ? `No matching local project setting applied (${error.code}); workflow guide uses the default.`
          : `Repository configuration not applied (${error.message}); workflow guide uses the default. ${error.recovery}`,
      ],
    };
  }
}

/** The additive `process` object for a briefing. */
export function briefingProcess(setting: GuideSetting) {
  const rules = guideRules();
  const version = policyVersion(rules);
  const guide = setting.enabled ? compactGuide(rules, version) : null;
  const pointer = pointerText(version, setting.enabled);
  return {
    schemaVersion: PROCESS_SCHEMA_VERSION,
    policyVersion: version,
    enabled: setting.enabled,
    source: setting.source,
    limitations: guideLimitations,
    rules: rules.map((rule) => rule.id),
    guide,
    pointer,
    omitted: setting.enabled ? null : ("disabled" as string | null),
    command: PROCESS_COMMAND,
    guideCodePoints: guide ? codePoints(guide) : 0,
    guideBytes: guide ? Buffer.byteLength(guide, "utf8") : 0,
    diagnostics: setting.diagnostics,
  };
}
export type BriefingProcess = ReturnType<typeof briefingProcess>;
