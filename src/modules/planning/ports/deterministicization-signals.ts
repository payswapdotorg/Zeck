/**
 * Deterministicization signals port (planning module outbound; WORK-021 /
 * DTR-001..004).
 *
 * The READ seam through which the planner consults the learning
 * module's deterministicization candidates (the lifecycle's
 * non-authoritative projection). Planning OWNS this consumer-side
 * contract (the WORK-007/009/014/017/020/022 consumer-owned-port
 * precedent): implementations adapt the learning module's public
 * `DeterministicizationSignalSource` to this shape and MUST validate
 * every candidate (provenance/contract anchors — the consumer-side
 * boundary) before it crosses the seam.
 *
 * This port can only ever RETURN evidence. There is no method that
 * could authorize a route, mutate a plan, mutate policy/budget/
 * capability state, dispatch anything, promote a candidate or roll
 * one back — deterministicization candidates are consultable
 * lifecycle evidence, never commands (the contract's Safety clause:
 * "a deterministic replacement cannot bypass policy admission,
 * tenant boundaries, authorization, budgets, verification or
 * customer-domain authority").
 */

import type { ConsultedDeterministicizationSignal } from "../domain/deterministicization-consultation";

export interface DeterministicizationSignalQuery {
  readonly applicationId: string;
  readonly tenantId: string;
  /** Restrict to one task class (optional). */
  readonly taskClass?: string;
}

export interface DeterministicizationSignals {
  consult(
    query: DeterministicizationSignalQuery,
  ): Promise<readonly ConsultedDeterministicizationSignal[]>;
}
