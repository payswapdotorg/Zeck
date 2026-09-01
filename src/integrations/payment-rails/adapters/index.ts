/**
 * Payment-rails integration adapters (WORK-032).
 *
 * The ONLY location where payment-rail client implementations live (the
 * repository's integration adapter convention; the work order's declared
 * `src/integrations/<namespace>/` surface). Currently shipped: the two
 * contract-tested SIMULATED rails proving neutrality/replacement; a real
 * rail client (SDK/HTTP) would be declared as a dependency and confined
 * to this directory, behind the SAME provider-neutral `PaymentRail`
 * port owned by the economics module.
 */
export {
  createConstraintBlindSimulatedRail,
  createSimulatedPaymentRail,
  type SimulatedPaymentRail,
  type SimulatedPaymentRailOptions,
} from "./simulated-rail";
