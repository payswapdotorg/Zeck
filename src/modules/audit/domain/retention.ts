/**
 * Retention policy (WORK-059 / SEC-004 domain).
 *
 * Policy-driven BOUNDED retention: a typed, versioned policy per
 * application declares a finite retention horizon (days). Records
 * older than the horizon are EXPIRED and are purged only by the
 * GOVERNED purge procedure (the store's purge transaction: expired +
 * hold-free records only, evidence record + head update in the same
 * transaction).
 *
 * UNBOUNDED RETENTION IS UNREPRESENTABLE: `retentionDays` is bounded
 * in [1, 3650] by validation AND by the migration's CHECK constraint.
 * A scope without an adopted policy simply never purges (the purge
 * service fails closed) — that state is reported honestly by the
 * services and disclosed as an explicit boundary, never silently
 * treated as an infinite horizon.
 */

import { AUDIT_BOUNDS } from "./vocabularies";

/** A durable retention policy (the latest version per application is active). */
export interface RetentionPolicyRecord {
  readonly policyId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly version: number;
  readonly retentionDays: number;
  readonly reason: string;
  readonly adoptedBy: string;
  readonly adoptedAt: string;
}

/** The governed adoption command. */
export interface AdoptPolicyInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly version: number;
  readonly retentionDays: number;
  readonly reason: string;
  readonly adoptedBy: string;
  readonly adoptedAt?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export class RetentionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetentionValidationError";
  }
}

function requireUuid(value: unknown, what: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new RetentionValidationError(`${what} must be a UUID`);
  }
  return value;
}

function requireBounded(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new RetentionValidationError(
      `${what} must be a non-empty string of at most ${max} characters`,
    );
  }
  return value;
}

/** Total validation of a policy adoption (fail closed — bounded horizon enforced). */
export function validateAdoptPolicyInput(value: unknown): AdoptPolicyInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RetentionValidationError("policy adoption must be an object");
  }
  const input = value as Record<string, unknown>;
  const applicationId = requireUuid(input.applicationId, "policy applicationId");
  const tenantId = requireUuid(input.tenantId, "policy tenantId");
  if (!Number.isInteger(input.version) || (input.version as number) < 1) {
    throw new RetentionValidationError("policy version must be a positive integer");
  }
  const retentionDays = input.retentionDays;
  if (
    !Number.isInteger(retentionDays) ||
    (retentionDays as number) < AUDIT_BOUNDS.retentionDaysMin ||
    (retentionDays as number) > AUDIT_BOUNDS.retentionDaysMax
  ) {
    throw new RetentionValidationError(
      `retentionDays must be an integer in [${AUDIT_BOUNDS.retentionDaysMin}, ${AUDIT_BOUNDS.retentionDaysMax}] (unbounded retention is unrepresentable)`,
    );
  }
  const reason = requireBounded(input.reason, "policy reason", AUDIT_BOUNDS.reasonMax);
  const adoptedBy = requireBounded(input.adoptedBy, "policy adoptedBy", AUDIT_BOUNDS.actorIdMax);
  let adoptedAt: string | undefined;
  if (input.adoptedAt !== undefined) {
    if (typeof input.adoptedAt !== "string" || !RFC3339_PATTERN.test(input.adoptedAt)) {
      throw new RetentionValidationError("policy adoptedAt must be an RFC3339 timestamp");
    }
    adoptedAt = input.adoptedAt;
  }
  return {
    applicationId,
    tenantId,
    version: input.version as number,
    retentionDays: retentionDays as number,
    reason,
    adoptedBy,
    ...(adoptedAt === undefined ? {} : { adoptedAt }),
  };
}

/** Total validation of a durable policy row (read-side gate). */
export function validateRetentionPolicyRecord(value: unknown): RetentionPolicyRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RetentionValidationError("retention policy must be an object");
  }
  const policy = value as Record<string, unknown>;
  const policyId = requireUuid(policy.policyId, "policyId");
  const applicationId = requireUuid(policy.applicationId, "policy applicationId");
  const tenantId = requireUuid(policy.tenantId, "policy tenantId");
  if (!Number.isInteger(policy.version) || (policy.version as number) < 1) {
    throw new RetentionValidationError("policy version must be a positive integer");
  }
  const retentionDays = policy.retentionDays;
  if (
    !Number.isInteger(retentionDays) ||
    (retentionDays as number) < AUDIT_BOUNDS.retentionDaysMin ||
    (retentionDays as number) > AUDIT_BOUNDS.retentionDaysMax
  ) {
    throw new RetentionValidationError(
      "retentionDays is outside the bounded horizon (unbounded retention is unrepresentable)",
    );
  }
  const reason = requireBounded(policy.reason, "policy reason", AUDIT_BOUNDS.reasonMax);
  const adoptedBy = requireBounded(policy.adoptedBy, "policy adoptedBy", AUDIT_BOUNDS.actorIdMax);
  if (typeof policy.adoptedAt !== "string" || !RFC3339_PATTERN.test(policy.adoptedAt)) {
    throw new RetentionValidationError("policy adoptedAt must be an RFC3339 timestamp");
  }
  return {
    policyId,
    applicationId,
    tenantId,
    version: policy.version as number,
    retentionDays: retentionDays as number,
    reason,
    adoptedBy,
    adoptedAt: policy.adoptedAt,
  };
}

/**
 * The purge cutoff for a policy at a point in time: records recorded
 * STRICTLY BEFORE the cutoff are expired. Pure date arithmetic
 * (UTC-day precision — the horizon is declared in days).
 */
export function computePurgeCutoff(policy: RetentionPolicyRecord, asOf: Date): string {
  const cutoff = new Date(asOf.getTime() - policy.retentionDays * 24 * 60 * 60 * 1000);
  return cutoff.toISOString().replace(/\.\d{3}Z$/, ".000Z");
}
