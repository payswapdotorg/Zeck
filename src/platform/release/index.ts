/**
 * Platform release-control barrel (WORK-047 / D-06).
 */

export { SqlReleaseControlStore, type SqlReleaseControlStoreDeps } from "./pg-store";
export {
  evaluatePromotion,
  type GateKindContract,
  type GateScope,
  loadReleasePolicy,
  type PromotionEvaluation,
  type ReleasePolicy,
  ReleasePolicyError,
} from "./policy";
export * from "./port";
