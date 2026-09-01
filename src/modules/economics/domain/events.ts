/**
 * Economic-action event vocabulary (economics module domain; WORK-032,
 * ECO-007 provenance).
 *
 * The append-only per-action evidence ledger vocabulary (migration 0014
 * `economics.economic_action_events`, gapless per action, physically
 * append-only). Every material step of the economic chain is journaled:
 * intent recorded, policy denial (journal-then-fail), authorization
 * issued, charge dispatched, settlement correlated, delivery evidence
 * recorded, terminal outcome.
 *
 * Execution-bound evidence ADDITIONALLY rides the canonical executions
 * ledger through the executions module's `recordStepEvent` seam (the
 * additive step-event vocabulary WORK-032 extends there): the economic
 * action retains its execution/tenant/application identity on the
 * platform's single execution evidence surface.
 */

export const ECONOMIC_EVENT_TYPES = [
  "action.recorded",
  "action.denied",
  "authorization.issued",
  "authorization.consumed",
  "authorization.expired",
  "payment.dispatched",
  "payment.rejected",
  "settlement.correlated",
  "settlement.externally-recorded",
  "delivery.recorded",
] as const;

export type EconomicEventType = (typeof ECONOMIC_EVENT_TYPES)[number];

export function isEconomicEventType(value: string): value is EconomicEventType {
  return (ECONOMIC_EVENT_TYPES as readonly string[]).includes(value);
}

export interface EconomicActionEvent {
  readonly eventId: string;
  readonly economicActionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** Gapless per-action sequence (1 is the creation event). */
  readonly sequence: number;
  readonly type: EconomicEventType;
  /**
   * Provenance cause class (the closed vocabulary bound physically in
   * migration 0014): economic-intent | policy | capability | budget |
   * rail | platform | authorization | external | delivery-evidence |
   * caller.
   */
  readonly cause: string;
  /** Durable facts the event is bound to (authorization id, refs, digests). */
  readonly reference: Readonly<Record<string, unknown>>;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}
