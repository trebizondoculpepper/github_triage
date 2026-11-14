/**
 * The registered estimate metrics (doc/design/impact-estimation.md "Reuse audit", #245).
 *
 * A metric descriptor is data, not a framework: it names the label prefix, colour, provenance
 * marker, guidance, configuration key, Ticket Doctor finding kinds and invalid-suffix suggestion
 * table that the shared label classifier, writer, provenance parser and reader are parameterised
 * by. Exactly two descriptors are registered (complexity and impact); no third metric is in scope.
 */
import { complexityGuidance } from "./complexity.js";
import type { ComplexityGuidance, ComplexitySize } from "./complexity.js";
import { impactGuidance } from "./impact.js";

export type EstimateMetric = "complexity" | "impact";

export interface MetricDescriptor {
  readonly metric: EstimateMetric;
  /** Lowercase label prefix including the colon, e.g. `impact:`. */
  readonly labelPrefix: string;
  /** Colour for a label this tool creates; existing definitions are never restyled. */
  readonly labelColor: string;
  /** Provenance marker text inside `<!-- ... {json} -->`, including its version. */
  readonly marker: string;
  readonly provenanceKind: "complexity-estimate" | "impact-estimate";
  readonly provenanceSchemaVersion: number;
  readonly guidance: ComplexityGuidance;
  readonly enabledKey: "complexity.enabled" | "impact.enabled";
  readonly invalidFindingKinds: {
    readonly conflict: string;
    readonly invalid: string;
    readonly incomplete: string;
  };
  /** Invalid-suffix suggestions (lowercase keys); suggestions only, never applied. */
  readonly suggestionTable: Readonly<Record<string, ComplexitySize>>;
}

/**
 * Registered suggestion table (#178): common words people use as an invalid size suffix, mapped
 * to the size they usually mean. Shared by both metrics; impact adds its own extras.
 */
export const INVALID_SIZE_SUGGESTIONS: Readonly<Record<string, ComplexitySize>> = Object.freeze({
  tiny: "XS",
  trivial: "XS",
  xsmall: "XS",
  "extra-small": "XS",
  small: "S",
  sm: "S",
  medium: "M",
  med: "M",
  large: "L",
  lg: "L",
  big: "L",
  huge: "XL",
  xlarge: "XL",
  "extra-large": "XL",
  xxlarge: "XXL",
  enormous: "XXL",
  massive: "XXL",
});

/** Neutral colour for a created complexity label. */
export const COMPLEXITY_LABEL_COLOR = "c5def5";
/** Distinct colour for a created impact label. */
export const IMPACT_LABEL_COLOR = "f9d0c4";

export const complexityMetric: MetricDescriptor = {
  metric: "complexity",
  labelPrefix: "complexity:",
  labelColor: COMPLEXITY_LABEL_COLOR,
  marker: "github-triage:complexity-estimate v2",
  provenanceKind: "complexity-estimate",
  provenanceSchemaVersion: 2,
  guidance: complexityGuidance,
  enabledKey: "complexity.enabled",
  invalidFindingKinds: {
    conflict: "complexity-label-conflict",
    invalid: "complexity-label-invalid",
    incomplete: "complexity-labels-incomplete",
  },
  suggestionTable: INVALID_SIZE_SUGGESTIONS,
};

export const impactMetric: MetricDescriptor = {
  metric: "impact",
  labelPrefix: "impact:",
  labelColor: IMPACT_LABEL_COLOR,
  marker: "github-triage:impact-estimate v1",
  provenanceKind: "impact-estimate",
  provenanceSchemaVersion: 1,
  guidance: impactGuidance,
  enabledKey: "impact.enabled",
  invalidFindingKinds: {
    conflict: "impact-label-conflict",
    invalid: "impact-label-invalid",
    incomplete: "impact-labels-incomplete",
  },
  suggestionTable: Object.freeze({ ...INVALID_SIZE_SUGGESTIONS, low: "S", high: "L" }),
};

/** Exactly the two registered metrics. */
export const METRICS: Readonly<Record<EstimateMetric, MetricDescriptor>> = Object.freeze({
  complexity: complexityMetric,
  impact: impactMetric,
});
