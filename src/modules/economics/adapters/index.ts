/**
 * Economics module adapters (WORK-032).
 *
 * Infrastructure implementations of the module ports:
 *  - in-memory store + idempotency arbitration (unit-test substrate);
 *  - SQL store + idempotency arbitration over the provider-neutral
 *    platform `DatabasePort` (migration 0014);
 *  - the REQUIRED policy-admission seam adapter (delegates to the
 *    WORK-007 policy authority — no decision logic, no default-allow);
 *  - the REQUIRED capability-admission seam adapter (delegates to the
 *    WORK-008 capability registry authority).
 *
 * Payment-rail adapters are NOT here: rails are replaceable integration
 * adapters and live under `src/integrations/payment-rails/adapters/`
 * (the repository's integration adapter convention) — outside this
 * module's authority tree by construction.
 */

export { createCapabilityEconomicAdmission } from "./capability-economic-admission";
export { InMemoryEconomicStore } from "./in-memory-economic-store";
export { InMemoryEconomicsIdempotency } from "./in-memory-economics-idempotency";
export { createPolicyEconomicAdmission } from "./policy-economic-admission";
export {
  createSqlEconomicsModule,
  SqlEconomicStore,
  SqlEconomicsIdempotency,
} from "./sql-economic-store";
