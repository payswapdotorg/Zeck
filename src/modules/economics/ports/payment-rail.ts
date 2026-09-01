/**
 * Payment-rail port (economics module outbound contract; WORK-032, ECO-004).
 *
 * The domain contract re-exported as the module port: rail adapters are
 * replaceable, injected per charge, hold no Zeck authority, and are
 * refused when they cannot express the required safety constraints.
 * Implementations live under `src/integrations/payment-rails/adapters/`
 * (the repository's integration adapter convention) — never inside this
 * module's authority tree.
 */

export type {
  PaymentRail,
  RailConstraintCapabilities,
  RailPaymentRequest,
  RailSettlementObservation,
  RailSettlementStatus,
} from "../domain/rail";
export {
  RAIL_SETTLEMENT_STATUSES,
  REQUIRED_RAIL_CAPABILITY_KEYS,
  railCanExpressConstraints,
} from "../domain/rail";
