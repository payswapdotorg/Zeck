/**
 * Payment-rails integration ports barrel (WORK-032).
 *
 * The seam this integration IMPLEMENTS: the economics module's
 * provider-neutral `PaymentRail` port (the entire rail surface the
 * governed charge path knows about). Rail adapters are replaceable,
 * injected per charge, hold no Zeck authority (policy, budget,
 * capability, execution, verification, learning are not importable from
 * this tree — architecture-gated), and are refused when they cannot
 * express the required safety constraints.
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
