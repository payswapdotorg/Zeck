/**
 * The accounting layer public barrel (VAL-006).
 *
 * Declared resolution thresholds (quality/safety/reliability/latency),
 * per-arm aggregates with measured-vs-estimated cost separation and
 * Wilson confidence intervals, and the mechanical report feed.
 */

export {
  type AccountedRun,
  type ArmAggregate,
  aggregateArm,
  wilsonInterval,
} from "./aggregate";
export {
  type EconomicReportEntry,
  economicEntryOf,
  economicMarkdownRows,
} from "./report";
export {
  DEFAULT_RESOLUTION_THRESHOLDS,
  isResolvedOutcome,
  type ResolutionFacts,
  type ResolutionThresholds,
  thresholdsFor,
} from "./thresholds";
