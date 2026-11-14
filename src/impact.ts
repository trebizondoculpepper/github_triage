/**
 * Bundled impact-estimation guidance (doc/design/impact-estimation.md "Impact guidance (rubric)",
 * #244/#245).
 *
 * One versioned definition, the same shape as `ComplexityGuidance`, so the same renderers can
 * serve it. It describes the judged benefit of the completed outcome, not effort, and never the
 * computed unlock utility (`immediateUnlocks`). #246 renders it in CLI help
 * (`estimate --help --metric impact [--json]`) and MCP help (`github-triage-mcp --help`) through
 * the shared renderer, so the prose is never maintained twice.
 */
import { COMPLEXITY_SIZES, guidanceText } from "./complexity.js";
import type { ComplexityGuidance } from "./complexity.js";

/** The single bundled impact guidance. Bump guidanceVersion on any semantic change. */
export const impactGuidance: ComplexityGuidance = {
  guidanceVersion: 1,
  sizes: COMPLEXITY_SIZES,
  scale:
    "Ordered categories XS < S < M < L < XL < XXL of judged benefit; not hours, money or " +
    "arithmetic ratios. Calibration is repository-relative: an L here need not equal an L elsewhere.",
  bands: [
    {
      size: "XS",
      guidance:
        "Cosmetic or wording improvement; no user or contributor would change how they work.",
      example: "Fix a typo in a rarely read message.",
    },
    {
      size: "S",
      guidance: "Removes a minor friction or edge case for some users; local benefit.",
      example: "Handle an uncommon input that currently needs a manual workaround.",
    },
    {
      size: "M",
      guidance: "Noticeably improves one common workflow, or unblocks a contained capability.",
      example: "Make a frequently used command report what it skipped.",
    },
    {
      size: "L",
      guidance:
        "Materially improves a core workflow for most users, or enables a planned capability others depend on.",
      example: "A shared mechanism several planned features are waiting for.",
    },
    {
      size: "XL",
      guidance:
        "Changes what the product can do for its main audience, or is the prerequisite for a major line of planned work.",
      example: "A new capability the project's main users have been asking for.",
    },
    {
      size: "XXL",
      guidance: "Foundational: the project's direction or several major capabilities depend on it.",
      example: "The core model the rest of the product is built on.",
    },
  ],
  dimensions: [
    "reach (who benefits)",
    "frequency (how often)",
    "depth (how much better per use)",
    "enablement (planned work this makes possible)",
    "risk reduced for users or contributors",
  ],
  method: [
    "Estimate the benefit of the completed outcome, assuming stated prerequisites are delivered.",
    "Meaningful downstream value it enables may count, as a judgment.",
    "Do not count dependants, add their labels or copy the unlock count.",
    "Choose the highest clearly triggered band and explain it.",
    "Missing information is not XS and not M.",
  ],
  reasons:
    "Every estimate states its reasons and assumptions: which dimensions triggered the band, " +
    "and any reference tickets compared against.",
  anchors:
    "Repository-history anchors (reference tickets per size) are optional calibration. The " +
    "bundled guidance names no tickets; never use another repository's anchors as benchmarks.",
  blockedTickets: [
    "Blocked tickets can be assessed: assume stated prerequisites are delivered.",
    "Assessing a blocked ticket does not unblock it; it stays implementation-ineligible.",
  ],
  prerequisites: [
    "An impact estimate is the repository label impact:XS..impact:XXL; no setup or native " +
      "field is needed. Recording creates the requested label if missing (label write access required).",
  ],
  boundaries: [
    "Estimating does not claim, unblock, reserve, split or re-rank a ticket.",
    "Impact is a judged benefit, distinct from complexity (effort) and unlock utility (computed).",
  ],
};

/** Plain-text rendering used by `github-triage estimate --help --metric impact`. */
export function impactGuidanceText(g: ComplexityGuidance = impactGuidance): string {
  return guidanceText(
    "Impact estimation guidance",
    g,
    "With --help --metric impact: --json gives the versioned structured guidance (schemaVersion 1).",
  );
}

/** Structured rendering for `estimate --help --metric impact --json`. */
export function impactGuidanceJson(g: ComplexityGuidance = impactGuidance): string {
  return JSON.stringify({ schemaVersion: 1, kind: "impact-guidance", ...g }, null, 2) + "\n";
}

/**
 * The bounded MCP-help rendering (#246): the same definition's scale, bands, method and
 * boundaries, without examples, and the CLI commands for the full guidance and for recording.
 * The MCP server itself stays read-only and advertises no recording tool.
 */
export function impactGuidanceSummary(g: ComplexityGuidance = impactGuidance): string {
  const width = Math.max(...g.bands.map((b) => b.size.length));
  return `Impact estimation guidance (version ${g.guidanceVersion}): ${g.scale}
${g.bands.map((b) => `  ${b.size.padEnd(width)}  ${b.guidance}`).join("\n")}
${[...g.method, ...g.boundaries].map((line) => `  - ${line}`).join("\n")}
Full guidance: github-triage estimate --help --metric impact [--json]
Record (CLI): github-triage estimate N --metric impact --size SIZE --rationale TEXT --repo owner/name
`;
}
