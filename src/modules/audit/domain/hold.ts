/**
 * Legal hold (WORK-059 / SEC-004 domain).
 *
 * A hold placed on a scope SUSPENDS retention expiry for that scope:
 * while a hold is active, the governed purge never deletes records the
 * hold covers. Holds are GOVERNED PROCEDURE rows: their placement and
 * release are themselves audited as append-only audit records
 * (architecture invariant 4).
 *
 * Scope: an application-wide hold covers every record of the
 * application; a target hold covers the records whose target identity
 * matches. Release is the only mutable transition (single write path
 * in the store adapter, inside the same transaction as the release
 * evidence record).
 */

import { AUDIT_BOUNDS, AUDIT_HOLD_SCOPES, AUDIT_TARGET_KINDS } from "./vocabularies";

/** A durable legal hold. */
export interface LegalHoldRecord {
  readonly holdId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly holdScope: (typeof AUDIT_HOLD_SCOPES)[number];
  readonly targetKind: (typeof AUDIT_TARGET_KINDS)[number] | null;
  readonly targetId: string | null;
  readonly reason: string;
  readonly placedBy: string;
  readonly placedAt: string;
  readonly releasedAt: string | null;
  readonly releasedBy: string | null;
}

/** The governed placement command. */
export interface PlaceHoldInput {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly holdScope: (typeof AUDIT_HOLD_SCOPES)[number];
  readonly targetKind?: (typeof AUDIT_TARGET_KINDS)[number];
  readonly targetId?: string;
  readonly reason: string;
  readonly placedBy: string;
  readonly placedAt?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

export class LegalHoldValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegalHoldValidationError";
  }
}

function requireUuid(value: unknown, what: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new LegalHoldValidationError(`${what} must be a UUID`);
  }
  return value;
}

function requireBounded(value: unknown, what: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new LegalHoldValidationError(
      `${what} must be a non-empty string of at most ${max} characters`,
    );
  }
  return value;
}

/** Total validation of a hold placement (fail closed). */
export function validatePlaceHoldInput(value: unknown): PlaceHoldInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LegalHoldValidationError("hold placement must be an object");
  }
  const input = value as Record<string, unknown>;
  const applicationId = requireUuid(input.applicationId, "hold applicationId");
  const tenantId = requireUuid(input.tenantId, "hold tenantId");
  if (
    typeof input.holdScope !== "string" ||
    !(AUDIT_HOLD_SCOPES as readonly string[]).includes(input.holdScope)
  ) {
    throw new LegalHoldValidationError("holdScope is outside the closed vocabulary");
  }
  const holdScope = input.holdScope as PlaceHoldInput["holdScope"];
  let targetKind: PlaceHoldInput["targetKind"];
  let targetId: string | undefined;
  if (holdScope === "target") {
    if (
      typeof input.targetKind !== "string" ||
      !(AUDIT_TARGET_KINDS as readonly string[]).includes(input.targetKind)
    ) {
      throw new LegalHoldValidationError(
        "a target hold requires a targetKind inside the vocabulary",
      );
    }
    targetKind = input.targetKind as PlaceHoldInput["targetKind"];
    targetId = requireBounded(input.targetId, "hold targetId", AUDIT_BOUNDS.targetIdMax);
  } else if (input.targetKind !== undefined || input.targetId !== undefined) {
    throw new LegalHoldValidationError("an application-wide hold carries no target identity");
  }
  const reason = requireBounded(input.reason, "hold reason", AUDIT_BOUNDS.reasonMax);
  const placedBy = requireBounded(input.placedBy, "hold placedBy", AUDIT_BOUNDS.actorIdMax);
  let placedAt: string | undefined;
  if (input.placedAt !== undefined) {
    if (typeof input.placedAt !== "string" || !RFC3339_PATTERN.test(input.placedAt)) {
      throw new LegalHoldValidationError("hold placedAt must be an RFC3339 timestamp");
    }
    placedAt = input.placedAt;
  }
  return {
    applicationId,
    tenantId,
    holdScope,
    ...(targetKind === undefined ? {} : { targetKind }),
    ...(targetId === undefined ? {} : { targetId }),
    reason,
    placedBy,
    ...(placedAt === undefined ? {} : { placedAt }),
  };
}

/**
 * Does an active hold cover an audit record's target? (Application
 * holds cover everything; target holds match the record's target
 * identity.)
 */
export function holdCoversTarget(
  hold: LegalHoldRecord,
  target: { readonly kind: string; readonly id: string },
): boolean {
  if (hold.holdScope === "application") {
    return true;
  }
  return hold.targetKind === target.kind && hold.targetId === target.id;
}

/** Total validation of a durable hold row (read-side gate). */
export function validateLegalHoldRecord(value: unknown): LegalHoldRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LegalHoldValidationError("legal hold must be an object");
  }
  const hold = value as Record<string, unknown>;
  const holdId = requireUuid(hold.holdId, "holdId");
  const applicationId = requireUuid(hold.applicationId, "hold applicationId");
  const tenantId = requireUuid(hold.tenantId, "hold tenantId");
  if (
    typeof hold.holdScope !== "string" ||
    !(AUDIT_HOLD_SCOPES as readonly string[]).includes(hold.holdScope)
  ) {
    throw new LegalHoldValidationError("holdScope is outside the closed vocabulary");
  }
  if (hold.holdScope === "target") {
    if (
      typeof hold.targetKind !== "string" ||
      !(AUDIT_TARGET_KINDS as readonly string[]).includes(hold.targetKind) ||
      typeof hold.targetId !== "string"
    ) {
      throw new LegalHoldValidationError("a target hold must carry a valid target identity");
    }
  } else if (hold.targetKind !== null || hold.targetId !== null) {
    throw new LegalHoldValidationError("an application-wide hold carries no target identity");
  }
  const reason = requireBounded(hold.reason, "hold reason", AUDIT_BOUNDS.reasonMax);
  const placedBy = requireBounded(hold.placedBy, "hold placedBy", AUDIT_BOUNDS.actorIdMax);
  for (const stamp of [hold.placedAt, hold.releasedAt]) {
    if (stamp !== null && (typeof stamp !== "string" || !RFC3339_PATTERN.test(stamp))) {
      throw new LegalHoldValidationError("hold timestamps must be RFC3339 or null");
    }
  }
  if (
    (hold.releasedAt === null && hold.releasedBy !== null) ||
    (hold.releasedAt !== null && hold.releasedBy === null)
  ) {
    throw new LegalHoldValidationError(
      "a released hold records who released it; an active one does not",
    );
  }
  if (hold.releasedBy !== null) {
    requireBounded(hold.releasedBy, "hold releasedBy", AUDIT_BOUNDS.actorIdMax);
  }
  return {
    holdId,
    applicationId,
    tenantId,
    holdScope: hold.holdScope as LegalHoldRecord["holdScope"],
    targetKind: (hold.targetKind ?? null) as LegalHoldRecord["targetKind"],
    targetId: (hold.targetId ?? null) as LegalHoldRecord["targetId"],
    reason,
    placedBy,
    placedAt: hold.placedAt as string,
    releasedAt: (hold.releasedAt ?? null) as string | null,
    releasedBy: (hold.releasedBy ?? null) as string | null,
  };
}
