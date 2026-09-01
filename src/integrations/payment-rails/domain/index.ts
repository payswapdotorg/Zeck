/**
 * Payment-rails integration domain barrel (WORK-032).
 *
 * The integration owns NO rail domain of its own: the provider-neutral
 * `PaymentRail` contract (request/observation/capability shapes) is
 * authored and frozen by the economics module — this barrel re-exports
 * the CONSUMED contract for adapter implementors (delegation, never
 * duplication: there is exactly ONE rail contract in the platform).
 */
export type {
  PaymentRail,
  RailConstraintCapabilities,
  RailPaymentRequest,
  RailSettlementObservation,
  RailSettlementStatus,
} from "../../../modules/economics/public";
export {
  RAIL_SETTLEMENT_STATUSES,
  REQUIRED_RAIL_CAPABILITY_KEYS,
  railCanExpressConstraints,
} from "../../../modules/economics/public";
