/**
 * Reservation entity and lifecycle (budgets module domain; BUD-004/BUD-005).
 *
 * A reservation is the transactional hold placed BEFORE an operation that
 * can incur billable usage (`IMPLEMENTATION.md` §8): unique per logical
 * billable operation, idempotent, concurrency-safe. Lifecycle:
 *
 * ```text
 *   active --settle(actual)--> settled    (terminal; actual usage exactly once)
 *   active --release------->  released   (terminal; unused hold returned once)
 * ```
 *
 * Both terminal transitions are compensating/append-only in their money
 * effects: settlement credits the unused hold (or debits an overage) as
 * NEW ledger entries; release credits the full hold. Nothing is ever
 * mutated in the ledger; the reservation row itself only ever moves
 * forward (`active` -> terminal), which the physical shape CHECK enforces.
 */

export type ReservationStatus = "active" | "settled" | "released";

import type { FundingMode, FundingSourceKind } from "./funding";

/** The durable reservation (public shape; money is a decimal string). */
export interface ReservationRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** The logical execution the billable operation belongs to (WORK-006 passes the executionId). */
  readonly executionId: string;
  /** The logical billable operation — unique per application (no double hold). */
  readonly operationId: string;
  /** End user the spend is attributed to ('' when userless). */
  readonly userId: string;
  readonly fundingMode: FundingMode;
  readonly sourceKind: FundingSourceKind;
  /** Drawn wallet; null for BYOK (no platform wallet involved). */
  readonly walletId: string | null;
  readonly amountMicroUsd: string;
  readonly status: ReservationStatus;
  /** Actual settled usage; set exactly once at settlement. */
  readonly settledAmountMicroUsd: string | null;
  /** Deterministic UTC month of creation (`YYYY-MM`) — the monthly window. */
  readonly monthKey: string;
  readonly createdAt: string;
  readonly finalizedAt: string | null;
}

export const RESERVATION_STATUSES: readonly ReservationStatus[] = ["active", "settled", "released"];

export function isReservationStatus(value: string): value is ReservationStatus {
  return (RESERVATION_STATUSES as readonly string[]).includes(value);
}
