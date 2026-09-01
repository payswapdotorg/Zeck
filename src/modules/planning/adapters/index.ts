/**
 * Planning module adapters barrel (WORK-009 + WORK-014 learning seam +
 * WORK-017 composition seam).
 */

export { createCapabilityAuthorityAdapter } from "./capability-authority-adapter";
export { createCompositionRecommendationsAdapter } from "./composition-recommendations-adapter";
export { publishDeterministicCapabilityFacts } from "./deterministic-capability-publisher";
export {
  createInMemoryDeterministicCatalog,
  DETERMINISTIC_CATALOG_SEED,
} from "./in-memory-deterministic-catalog";
export type { LearningSignalsAdapterOptions } from "./learning-signals-adapter";
export { createLearningSignalsAdapter } from "./learning-signals-adapter";
export { createNodeDigest } from "./node-digest";
export { createPlanningSinkAdapter } from "./planning-sink-adapter";
export { createPolicyInputsAdapter } from "./policy-inputs-adapter";
export { createRouteTableExplorer } from "./route-table-explorer";
export { createSubstrateCatalogAdapter } from "./substrate-catalog-adapter";
