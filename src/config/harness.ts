/**
 * Current-harness detection and agent-entry resolution (#38, doc/design/identity.md).
 *
 * One registry of verified signals decides which harness is running; one resolver turns
 * explicit selection or that detection into an exact `[agents.KEY]` entry of the root
 * `agent-inbox.toml` (read through identity.ts, never parsed here).
 *
 * Precedence: explicit `--entry KEY`, then explicit supported `--harness KEY`, then verified
 * detection. Missing, conflicting or ambiguous evidence is "unresolved", never a guess:
 * - a harness selects only its exact entry key (`codex`, `claude`); when the file also holds
 *   other logical entries for that harness (`codex.review`), explicit selection is required;
 * - the first or only unrelated entry is never borrowed;
 * - Ori entries are per MCP server (`ori.<server>`). A shell under Ori only carries a session
 *   marker, which identifies the harness but not a server entry, so it always needs `--entry`;
 * - signals of several harnesses at once (an inherited parent marker plus a child's) are
 *   reported as a conflict rather than resolved by picking one.
 * `--agent NAME` stays a per-call identity override and is not an entry key.
 *
 * Results name the signals that were present, never their values or other environment data.
 */

import { ConfigError } from "./config.js";
import type { ConfigFileSystem } from "./config.js";
import { listEntryKeys, validateEntryKey } from "./identity.js";

export type HarnessId = "claude" | "codex" | "ori";

/** A registered harness and the evidence that verifies it. */
export interface HarnessDetector {
  readonly harness: HarnessId;
  /**
   * Environment variables set in the live session (presence, non-empty, decides). Weak
   * installation settings such as `CODEX_HOME` are deliberately absent: they describe an
   * installation, not a running session.
   */
  readonly environment: readonly string[];
  /** The exact entry key this harness selects, or null when it cannot name one entry. */
  readonly entryKey: string | null;
  /** Where the signals were verified. */
  readonly evidence: string;
}

/** The single detector registry. Order is irrelevant: several matches are a conflict. */
export const HARNESS_DETECTORS: readonly HarnessDetector[] = [
  {
    harness: "claude",
    environment: ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"],
    entryKey: "claude",
    evidence: "Claude Code sets these in every command it runs (doc/design/identity.md).",
  },
  {
    harness: "codex",
    environment: ["CODEX_THREAD_ID", "CODEX_SANDBOX", "CODEX_MANAGED_BY_NPM", "CODEX_CI"],
    entryKey: "codex",
    evidence: "Codex runtime and thread markers (doc/design/identity.md); not CODEX_HOME.",
  },
  {
    harness: "ori",
    environment: ["ORI_SESSION_ID"],
    entryKey: null,
    evidence:
      "Ori sets ORI_SESSION_ID for sessions it runs; it names no MCP server entry, so a shell under Ori needs --entry ori.SERVER.",
  },
];

export const SUPPORTED_HARNESSES: readonly HarnessId[] = HARNESS_DETECTORS.map((d) => d.harness);

/** Prefix Ori puts on its MCP clientInfo name: `ori-${serverName}`. */
const ORI_CLIENT_PREFIX = "ori-";

export type Environment = Readonly<Record<string, string | undefined>>;

/** What the environment shows. Only signal names are reported, never values. */
export type HarnessDetection =
  | { readonly status: "none"; readonly signals: readonly [] }
  | { readonly status: "detected"; readonly harness: HarnessId; readonly signals: string[] }
  | {
      readonly status: "conflict";
      readonly harnesses: HarnessId[];
      readonly signals: string[];
    };

/** Detect the current harness from an injected environment. */
export function detectHarness(env: Environment): HarnessDetection {
  const matches = HARNESS_DETECTORS.map((detector) => ({
    harness: detector.harness,
    signals: detector.environment.filter((name) => (env[name] ?? "") !== ""),
  })).filter((match) => match.signals.length > 0);
  const signals = matches.flatMap((match) => match.signals);
  if (matches.length === 0) return { status: "none", signals: [] };
  if (matches.length === 1) return { status: "detected", harness: matches[0]!.harness, signals };
  return { status: "conflict", harnesses: matches.map((match) => match.harness), signals };
}

/**
 * Map MCP client metadata to a harness/entry. The Ori server prefix is matched before any
 * embedded generic name, so `ori-claude-helper` is the Ori server entry `ori.claude-helper`,
 * never Claude. Other client names are unknown: no other client name is verified.
 */
export function detectClientEntry(
  clientName: string,
): { readonly harness: HarnessId; readonly entry: string } | null {
  if (!clientName.startsWith(ORI_CLIENT_PREFIX)) return null;
  const server = clientName.slice(ORI_CLIENT_PREFIX.length);
  if (server === "") return null;
  const entry = `ori.${server}`;
  try {
    validateEntryKey(entry);
  } catch {
    return null;
  }
  return { harness: "ori", entry };
}

/** Validate an explicit `--harness`. */
export function validateHarness(harness: string): HarnessId {
  if (!(SUPPORTED_HARNESSES as readonly string[]).includes(harness)) {
    throw new ConfigError(
      "invalid-value",
      `Unsupported --harness ${JSON.stringify(harness)}.`,
      `Supported harnesses: ${SUPPORTED_HARNESSES.join(", ")}. Or select the entry with --entry KEY.`,
    );
  }
  return harness as HarnessId;
}

export type EntrySource = "--entry" | "--harness" | "environment";

export type EntryResolution =
  | {
      readonly status: "resolved";
      readonly entry: string;
      readonly source: EntrySource;
      readonly harness: HarnessId | null;
      readonly signals: string[];
    }
  | {
      readonly status: "unresolved";
      readonly reason: "no-signal" | "conflict" | "several-entries" | "no-entry-key";
      readonly message: string;
      readonly harnesses: HarnessId[];
      readonly signals: string[];
      /** Existing entry keys for the harness when several logical entries share it. */
      readonly candidates: string[];
    };

const harnessEntries = (keys: readonly string[], harness: HarnessId): string[] =>
  keys.filter((key) => key === harness || key.startsWith(`${harness}.`));

/**
 * The shared resolver (#38). Root selection happens first (the caller passes the resolved
 * working-tree root); only entry keys of that one file are consulted, read-only.
 */
export async function resolveEntry(options: {
  readonly entry?: string;
  readonly harness?: string;
  readonly env: Environment;
  readonly root: string;
  readonly fs?: ConfigFileSystem;
}): Promise<EntryResolution> {
  if (options.entry !== undefined) {
    return {
      status: "resolved",
      entry: validateEntryKey(options.entry),
      source: "--entry",
      harness: null,
      signals: [],
    };
  }
  let harness: HarnessId;
  let source: EntrySource;
  let signals: string[] = [];
  if (options.harness !== undefined) {
    harness = validateHarness(options.harness);
    source = "--harness";
  } else {
    const detection = detectHarness(options.env);
    if (detection.status === "none") {
      return {
        status: "unresolved",
        reason: "no-signal",
        message: "No supported harness was detected, so no agent identity entry is selected.",
        harnesses: [],
        signals: [],
        candidates: [],
      };
    }
    if (detection.status === "conflict") {
      return {
        status: "unresolved",
        reason: "conflict",
        message: `Signals of several harnesses are present (${detection.harnesses.join(", ")}; possibly inherited from a parent), so no entry is chosen.`,
        harnesses: detection.harnesses,
        signals: detection.signals,
        candidates: [],
      };
    }
    harness = detection.harness;
    signals = detection.signals;
    source = "environment";
  }
  const detector = HARNESS_DETECTORS.find((d) => d.harness === harness)!;
  const candidates = harnessEntries(await listEntryKeys(options.root, options.fs), harness);
  if (detector.entryKey === null) {
    return {
      status: "unresolved",
      reason: "no-entry-key",
      message: `The ${harness} harness has one entry per configured server and this call does not say which, so no entry is chosen.`,
      harnesses: [harness],
      signals,
      candidates,
    };
  }
  if (candidates.some((key) => key !== detector.entryKey)) {
    return {
      status: "unresolved",
      reason: "several-entries",
      message: `Several logical agent entries use the ${harness} harness, so no entry is chosen.`,
      harnesses: [harness],
      signals,
      candidates,
    };
  }
  return { status: "resolved", entry: detector.entryKey, source, harness, signals };
}
