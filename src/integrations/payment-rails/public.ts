/**
 * Public contract barrel of the payment-rails integration (WORK-032).
 *
 * Integrations are adapters for external systems: `public.ts` is the only
 * supported import surface, `adapters/` owns external client
 * implementations (the only location where a real rail SDK would ever be
 * importable, behind a dependency declaration), and `internal/` is never
 * imported from outside.
 *
 * WHAT THIS INTEGRATION IS (ECO-004 / ADR-0018): the payment-rail
 * adapter seam of the platform. Rails are REPLACEABLE ADAPTERS, never
 * Zeck authorities — this tree imports EXACTLY the economics module's
 * public barrel + src/shared (architecture-gated): it cannot decide
 * policy, budgets, capabilities, execution state, verification or
 * learning because those modules are not even importable from here.
 *
 * WHAT SHIPS NOW: the provider-neutral rail CONTRACT (re-exported from
 * the economics module — one contract, no duplication) and the two
 * contract-tested SIMULATED reference rails proving
 * neutrality/replacement mechanically. NO real rail client is wired (no
 * dependency exists) and NO real financial transaction is claimed — the
 * honesty rule of the work order's evidence contract.
 */

export const integrationId = "payment-rails" as const;

export type PaymentRailsIntegrationId = typeof integrationId;

// Reference adapters (simulated — contract-tested only; no network, no
// real money, no credentials anywhere).
export {
  createConstraintBlindSimulatedRail,
  createSimulatedPaymentRail,
  type SimulatedPaymentRail,
  type SimulatedPaymentRailOptions,
} from "./adapters";
// Composition helper (pure, fail-closed rail resolution).
export { type RailRegistry, resolveRailById } from "./application";
// The neutral rail contract (owned by the economics module; consumed here).
export type {
  PaymentRail,
  RailConstraintCapabilities,
  RailPaymentRequest,
  RailSettlementObservation,
  RailSettlementStatus,
} from "./domain";
export {
  RAIL_SETTLEMENT_STATUSES,
  REQUIRED_RAIL_CAPABILITY_KEYS,
  railCanExpressConstraints,
} from "./domain";
