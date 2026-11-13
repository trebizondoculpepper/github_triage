/**
 * Bundled complexity-estimation guidance (doc/design/complexity-estimation.md, #118).
 *
 * One versioned definition; every renderer (CLI help, JSON, a future MCP guidance surface)
 * derives from it so the prose is never maintained twice. The guidance is structural and
 * repository-neutral: it names no ticket from any repository, because anchors belong to a
 * repository's own calibration and are optional.
 */

/** Ordered size categories; categories, not hours or numeric ratios. */
export const COMPLEXITY_SIZES = ["XS", "S", "M", "L", "XL", "XXL"] as const;
export type ComplexitySize = (typeof COMPLEXITY_SIZES)[number];

export interface ComplexityBand {
  readonly size: ComplexitySize;
  readonly guidance: string;
  readonly example: string;
}

export interface ComplexityGuidance {
  readonly guidanceVersion: number;
  readonly sizes: readonly ComplexitySize[];
  readonly scale: string;
  readonly bands: readonly ComplexityBand[];
  readonly dimensions: readonly string[];
  readonly method: readonly string[];
  readonly reasons: string;
  readonly anchors: string;
  readonly blockedTickets: readonly string[];
  readonly prerequisites: readonly string[];
  readonly boundaries: readonly string[];
}

/** The single bundled guidance definition. Bump guidanceVersion on any semantic change. */
export const complexityGuidance: ComplexityGuidance = {
  guidanceVersion: 1,
  sizes: COMPLEXITY_SIZES,
  scale:
    "Ordered categories XS < S < M < L < XL < XXL; not hours, elapsed time or arithmetic ratios. " +
    "Calibration is repository-relative: an M here need not equal an M elsewhere.",
  bands: [
    {
      size: "XS",
      guidance: "Small presentation/constant change; no new behavior, interface or I/O.",
      example: "Reword a help message or adjust a default constant.",
    },
    {
      size: "S",
      guidance: "One bounded behavior in one implementation module using existing contracts.",
      example: "Add a guard for one edge case in an existing command.",
    },
    {
      size: "M",
      guidance: "A contained capability across a few modules with bounded integration/testing.",
      example: "A new read-only check wired into an existing command and its output.",
    },
    {
      size: "L",
      guidance: "Significant lifecycle/integration change with interacting failure paths.",
      example: "A mutating workflow with ownership races, retries and recovery behavior.",
    },
    {
      size: "XL",
      guidance: "Systematic change across many modules or the toolchain.",
      example: "Migrating the codebase to a new language mode or build system.",
    },
    {
      size: "XXL",
      guidance:
        "System-wide change affecting several foundational contracts with substantial consequences.",
      example: "Replacing the storage model and the interfaces that depend on it.",
    },
  ],
  dimensions: [
    "behavioral scope",
    "module reach",
    "changed contracts and interfaces",
    "external integration (APIs, I/O, other agents)",
    "validation complexity (tests, failure paths)",
  ],
  method: [
    "Estimate the complete deliverable, including integration, tests and necessary documentation.",
    "Choose the highest clearly triggered band and explain departures from nearby anchors.",
    "Module/line counts are clues, not the rule; tests/docs do not inflate size by adding files.",
    "Missing information is not automatically XXL.",
    "Re-estimate when scope changes; unchanged commits do not require a new estimate.",
  ],
  reasons:
    "Every estimate states its reasons and assumptions: which dimensions triggered the band, " +
    "and any reference tickets compared against.",
  anchors:
    "Repository-history anchors (reference tickets per size) are optional calibration. A new " +
    "repository uses these structural defaults with no anchors; say that local calibration is " +
    "incomplete. Never use another repository's anchors as benchmarks.",
  blockedTickets: [
    "Blocked tickets can be sized: assume stated prerequisites are satisfied.",
    "Exclude time spent waiting for prerequisites.",
    'State the condition, e.g. "M if blocker B supplies the documented API; waiting excluded."',
    "If an unresolved choice changes scope materially, give alternatives or report it cannot be sized.",
  ],
  prerequisites: [
    "A size is the repository label complexity:XS..complexity:XXL; no setup or native field is " +
      "needed. Recording creates the requested label if missing (label write access required).",
  ],
  boundaries: [
    "Estimating does not claim, unblock, reserve, split or re-rank a ticket.",
    "An estimate is not a compulsory implementation gate.",
  ],
};

/** Plain-text rendering used by `github-triage estimate --help`. */
export function complexityGuidanceText(g: ComplexityGuidance = complexityGuidance): string {
  const list = (items: readonly string[]) => items.map((item) => `  - ${item}`).join("\n");
  const width = Math.max(...g.bands.map((b) => b.size.length));
  const bands = g.bands
    .map(
      (b) => `  ${b.size.padEnd(width)}  ${b.guidance}\n  ${"".padEnd(width)}  e.g. ${b.example}`,
    )
    .join("\n");
  return `Complexity estimation guidance (version ${g.guidanceVersion}):

Scale: ${g.scale}
${bands}

Compare:
${list(g.dimensions)}
Method:
${list(g.method)}
Reasons: ${g.reasons}
Anchors: ${g.anchors}
Blocked tickets:
${list(g.blockedTickets)}
Prerequisites:
${list(g.prerequisites)}
Boundaries:
${list(g.boundaries)}
With --help: --json gives the versioned structured guidance (schemaVersion 1).
`;
}

/** Structured rendering for --json and an MCP guidance surface. */
export function complexityGuidanceJson(g: ComplexityGuidance = complexityGuidance): string {
  return JSON.stringify({ schemaVersion: 1, kind: "complexity-guidance", ...g }, null, 2) + "\n";
}
