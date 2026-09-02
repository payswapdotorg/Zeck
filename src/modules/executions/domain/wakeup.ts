/**
 * Wake-up domain (executions module domain; WORK-028, LNG-002).
 *
 * Scheduling/wake-up metadata: a wake-up record drives the
 * resumability of SLEEPING executions (WAITING_TOOL / WAITING_USER /
 * WAITING_HUMAN). Each record carries the earliest-wake time, the
 * cause and a STABLE wake key; the physical ledger orders due wake-ups
 * deterministically by (earliestWakeAt, id) and the application of a
 * wake is IDEMPOTENT (applied is write-once; the resume it triggers
 * carries its own durable operation key). Superseded wake-ups (human
 * interruption, termination, or an execution already resumed by other
 * means) never fire — stale workers and superseded schedules are never
 * authoritative.
 */

/** The frozen wake-up status vocabulary. */
export const WAKE_UP_STATUSES = ["scheduled", "applied", "superseded"] as const;
export type WakeUpStatus = (typeof WAKE_UP_STATUSES)[number];

/** One durable wake-up record. */
export interface WakeUpRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  /** The stable identity of this wake-up (idempotent application key). */
  readonly wakeKey: string;
  readonly cause: string;
  readonly earliestWakeAt: string;
  readonly status: WakeUpStatus;
  readonly appliedAt: string | null;
  /** The durable operation key that performed the wake application. */
  readonly appliedOperationKey: string | null;
  readonly supersedeCause: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function isWakeUpStatus(value: string): value is WakeUpStatus {
  return (WAKE_UP_STATUSES as readonly string[]).includes(value);
}

/** Deterministic due-ordering comparator: (earliestWakeAt, id). */
export function compareWakeUpOrder(a: WakeUpRecord, b: WakeUpRecord): number {
  if (a.earliestWakeAt !== b.earliestWakeAt) {
    return a.earliestWakeAt < b.earliestWakeAt ? -1 : 1;
  }
  if (a.id !== b.id) {
    return a.id < b.id ? -1 : 1;
  }
  return 0;
}

/**
 * The wake-up status machine: scheduled -> applied | superseded, and
 * NOTHING leaves applied/superseded (write-once terminal states).
 */
const WAKE_UP_TRANSITIONS: Readonly<Record<WakeUpStatus, readonly WakeUpStatus[]>> = {
  scheduled: ["applied", "superseded"],
  applied: [],
  superseded: [],
};

export function canTransitionWakeUp(from: WakeUpStatus, to: WakeUpStatus): boolean {
  return WAKE_UP_TRANSITIONS[from].includes(to);
}
