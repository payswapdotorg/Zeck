/**
 * Rail registry composition helper (payment-rails integration; WORK-032).
 *
 * The composition root registers the available rails (adapter instances,
 * replaceable per deployment); callers resolve a rail by its opaque
 * neutral id. Resolution is PURE and FAIL-CLOSED: an unknown id resolves
 * to null — the charge path then refuses (never a default rail, never a
 * silent substitution).
 */

import type { PaymentRail } from "../../../modules/economics/public";

/** The registered rails (injected by the composition root). */
export type RailRegistry = readonly PaymentRail[];

export function resolveRailById(registry: RailRegistry, railId: string): PaymentRail | null {
  return registry.find((rail) => rail.railId === railId) ?? null;
}
