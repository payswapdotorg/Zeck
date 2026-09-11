/**
 * The comparator harness public barrel (VAL-005).
 *
 * Fair-comparison guards (pinned plans, mechanical drift detection),
 * the baseline application contract, the direct-provider and optimized
 * baseline templates, and the competing-stack integration contract
 * with honest NOT RUN boundaries.
 */

export type {
  BaselineRunReport,
  BaselineTemplate,
  BaselineTransport,
  BaselineTransportRequest,
  BaselineTransportResponse,
} from "./baseline";
export {
  type CompetingStackAccessRequirement,
  competingStackBaseline,
  declareCompetingStackNotRun,
} from "./competing-stack";
export {
  type DirectProviderChatRequest,
  directProviderBaseline,
  runDirectTask,
} from "./direct-provider";
export {
  type ComparisonArm,
  type ComparisonPlan,
  type PinnedComparisonPlan,
  pinComparisonPlan,
  taskSlice,
  verifyFairExecution,
} from "./guards";
export {
  OPTIMIZED_BASELINE_OPTIMIZATIONS,
  optimizedBaseline,
  ResponseCache,
} from "./optimized-baseline";
