/**
 * Durable, recoverable long-running operation state (executions module
 * domain; WORK-028 — the WORK-024 crash-safety standard applied to the
 * checkpoint/lease/resume/interruption operations themselves).
 *
 * One row per governed long-running operation with the
 * PENDING -> COMPLETED | FAILED machine (the `realtime_operations` /
 * `messaging_operations` pattern of migrations 0018/0020):
 *
 *   * the STABLE operation key arbitrates the durable claim — the first
 *     invocation inserts a PENDING row; every later invocation with the
 *     same key returns the EXISTING row with `attempts` bumped (the
 *     retry ledger, monotonic);
 *   * the request fingerprint makes same-key/different-body key reuse
 *     fail closed (`IDEMPOTENCY_KEY_REUSED`);
 *   * the stage `checkpoint` is bounded jsonb, writable only while
 *     PENDING — the past-the-point-of-no-return facts a crash-resume
 *     completes from;
 *   * COMPLETED/FAILED are fully immutable and completion-timestamped;
 *     rows are never deleted (the physical guard set lives in
 *     migration 0022);
 *   * a crash between the claim and the completion leaves the honest
 *     PENDING row — the retry resumes from its stage checkpoint with
 *     exactly-once side effects per stable key.
 */

/** The governed long-running operation kinds (WORK-028 vocabulary). */
export const LONG_RUNNING_OPERATION_KINDS = [
  "checkpoint",
  "pause",
  "lease-acquire",
  "lease-renew",
  "lease-release",
  "resume",
  "interrupt",
  "terminate",
  "wakeup-schedule",
  "wakeup-apply",
] as const;

export type LongRunningOperationKind = (typeof LONG_RUNNING_OPERATION_KINDS)[number];

export const LONG_RUNNING_OPERATION_STATUSES = ["pending", "completed", "failed"] as const;
export type LongRunningOperationStatus = (typeof LONG_RUNNING_OPERATION_STATUSES)[number];

/** One durable operation record. */
export interface LongRunningOperationRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly operationKind: LongRunningOperationKind;
  readonly operationKey: string;
  readonly requestFingerprint: string;
  readonly status: LongRunningOperationStatus;
  readonly attempts: number;
  readonly stage: Readonly<Record<string, unknown>> | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export function isLongRunningOperationKind(
  value: string,
): value is LongRunningOperationKind {
  return (LONG_RUNNING_OPERATION_KINDS as readonly string[]).includes(value);
}

/**
 * The stable operation-key scheme. The discriminator is ALWAYS
 * execution-scoped (every caller includes the execution id) — the
 * WORK-024 review lesson: keys derived from colliding sub-execution
 * identities must never collapse onto one operation row.
 */
export function longRunningOperationKey(
  kind: LongRunningOperationKind,
  discriminator: string,
): string {
  return `lrop:${kind}:${discriminator}`;
}

/** Discriminator composition helper (execution-scoped by construction). */
export function executionScopedDiscriminator(executionId: string, suffix: string): string {
  return `${executionId}:${suffix}`;
}
