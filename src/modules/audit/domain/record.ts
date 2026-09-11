/**
 * The typed audit record (WORK-059 / SEC-004 domain).
 *
 * An audit record is APPEND-ONLY EVIDENCE of ONE governed action with
 * the full who/what/when/why provenance chain:
 *
 *   WHO      actor (actorId + actorKind)
 *   WHAT     action (kind from the closed vocabulary + command +
 *            operation identity) and target (kind + id)
 *   WHEN     occurredAt (when the action happened, per the seam) and
 *            recordedAt (when the projection durably recorded it)
 *   WHY      rationale (bounded why + optional policy provenance:
 *            policy set identity/version/content hash/restriction set
 *            digest)
 *   PROVENANCE the observation seam (which EXISTING authority seam
 *            observed the action) + the authoritative source record
 *            identity (event/decision/hold/policy/export id) — the
 *            record is replayable against that source.
 *
 * Identity discipline (IDENTITY-IDEMPOTENCY):
 *
 *  - `recordId` is content-addressed: sha256 over the canonical
 *    IDENTITY form — everything EXCEPT the volatile `occurredAt` and
 *    the store-assigned fields (recordedAt, chain sequence, chain
 *    digests). Re-observing the same governed action produces the
 *    same `recordId`: the durable append converges to a bounded no-op
 *    (replay), never a duplicate row.
 *  - `recordDigest` is the integrity digest: sha256 over the FULL
 *    record (identity + volatile + chain linkage, excluding itself).
 *    Tampering with any stored byte is detectable at read/verify
 *    time.
 *  - the hash chain: `chainSequence` (gapless, per application) and
 *    `previousRecordDigest` (the predecessor's recordDigest; the
 *    first record's predecessor is the genesis constant). The chain
 *    is extended only under the chain-head lock inside the durable
 *    append transaction (CONCURRENCY-CRASH-SAFETY).
 *
 * EVIDENCE, NEVER AUTHORITY (invariant 2): there is no admission,
 * authorization, allow/deny or reservation surface anywhere on this
 * type, its builder or its store — the projection is consulted by
 * NOBODY for authorization (architecture-boundary-proven).
 */

import { canonicalAuditJson, isCanonicalizable } from "./canonical";
import { auditDetailIsAdmissible } from "./scrub";
import {
  AUDIT_ACTION_KINDS,
  AUDIT_ACTOR_KINDS,
  AUDIT_BOUNDS,
  AUDIT_CHAIN_GENESIS,
  AUDIT_SEAMS,
  AUDIT_TARGET_KINDS,
} from "./vocabularies";

export const AUDIT_RECORD_INVARIANT_CODES = [
  "record-shape",
  "record-vocabulary",
  "record-bounds",
  "record-detail-unrepresentable",
  "record-identity-mismatch",
] as const;
export type AuditRecordInvariantCode = (typeof AUDIT_RECORD_INVARIANT_CODES)[number];

/** The typed, bounded audit validation error (fail closed). */
export class AuditValidationError extends Error {
  readonly invariant: AuditRecordInvariantCode;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    invariant: AuditRecordInvariantCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
    this.name = "AuditValidationError";
    this.invariant = invariant;
    this.details = Object.freeze({ ...details });
  }
}

function reject(
  invariant: AuditRecordInvariantCode,
  message: string,
  details?: Readonly<Record<string, string | number | boolean | null>>,
): never {
  throw new AuditValidationError(invariant, message, details);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

// ---------------------------------------------------------------------------
// The submission (what a seam submits; the domain's inbound shape)
// ---------------------------------------------------------------------------

/** WHO: the actor identity. */
export interface AuditActor {
  readonly actorId: string;
  readonly actorKind: (typeof AUDIT_ACTOR_KINDS)[number];
}

/** WHAT: the action identity. */
export interface AuditAction {
  readonly kind: (typeof AUDIT_ACTION_KINDS)[number];
  /** The governed command/decision code observed (e.g. "authorize", "admission", "retention-purge"). */
  readonly command: string;
  /**
   * The action's operation identity: the caller idempotency key at the
   * observed seam, or the natural content identity of the observed
   * action (e.g. the decision record's decisionId).
   */
  readonly operationKey: string;
}

/** WHAT'S TARGET: the target identity. */
export interface AuditTarget {
  readonly kind: (typeof AUDIT_TARGET_KINDS)[number];
  readonly id: string;
}

/**
 * PROVENANCE: which existing seam observed the action, and the
 * authoritative source record identity the projection is replayable
 * against (the executions event/execution id, the decision record's
 * decisionId, the hold/policy/export id — the authoritative stores
 * remain the sole sources of truth; the projection never replaces
 * them).
 */
export interface AuditProvenance {
  readonly seam: (typeof AUDIT_SEAMS)[number];
  readonly sourceRecordId: string | null;
}

/** WHY: the policy provenance (durable admission evidence shape). */
export interface AuditPolicyContext {
  readonly policySetId: string;
  readonly policySetVersion: number;
  readonly policyContentHash: string;
  readonly restrictionSetDigest?: string;
}

/** WHY: the bounded rationale. */
export interface AuditRationale {
  readonly why: string;
  readonly policyContext?: AuditPolicyContext;
}

/**
 * The audit submission: what an observation seam submits to the
 * projection. `actionDetail` must be scrubbed at the seam (the service
 * re-checks) and DETERMINISTIC per action identity (outcome noise such
 * as idempotency-replay flags must be excluded — the projection
 * records what the action WAS, and the same action observed twice
 * converges to one record).
 */
export interface AuditSubmission {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly environment: string;
  readonly actor: AuditActor;
  readonly action: AuditAction;
  readonly target: AuditTarget;
  readonly provenance: AuditProvenance;
  readonly rationale: AuditRationale;
  /** When the governed action occurred (per the observing seam's clock). */
  readonly occurredAt: string;
  /** Bounded structured evidence detail (reference-typed; scrubbed). */
  readonly actionDetail: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The record (submission + identity + chain linkage)
// ---------------------------------------------------------------------------

/** The durable, append-only audit record. */
export interface AuditRecord extends AuditSubmission {
  /** Content-derived identity: digest over the canonical identity form. */
  readonly recordId: string;
  /** Gapless chain position within the application (starts at 1). */
  readonly chainSequence: number;
  /** The predecessor's recordDigest (genesis for sequence 1). */
  readonly previousRecordDigest: string;
  /** sha256 over the canonical FULL record form. */
  readonly recordDigest: string;
  /** When the projection durably recorded the action. */
  readonly recordedAt: string;
}

/** The digest port the audit domain depends on (provider-neutral). */
export interface AuditDigestPort {
  sha256Hex(value: string): string;
}

/** The fields the identity digest covers (everything but the volatile). */
type AuditIdentityForm = Omit<AuditSubmission, "occurredAt">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  value: unknown,
  what: string,
  bound: { readonly min: number; readonly max: number },
): string {
  if (typeof value !== "string") {
    reject("record-shape", `${what} must be a string`, { got: String(value) });
  }
  const text = value;
  if (text.length < bound.min || text.length > bound.max) {
    reject("record-bounds", `${what} length must be within [${bound.min}, ${bound.max}]`, {
      length: text.length,
    });
  }
  return text;
}

function requireVocabulary<T extends string>(
  value: unknown,
  what: string,
  vocabulary: readonly T[],
): T {
  if (typeof value !== "string" || !(vocabulary as readonly string[]).includes(value)) {
    reject("record-vocabulary", `${what} is outside the closed vocabulary`, {
      got: String(value).slice(0, 80),
    });
  }
  return value as T;
}

function validatePolicyContext(value: Record<string, unknown>): AuditPolicyContext {
  const policySetId = requireString(value.policySetId, "policyContext.policySetId", {
    min: 1,
    max: 128,
  });
  const policySetVersion = value.policySetVersion;
  if (!Number.isInteger(policySetVersion) || (policySetVersion as number) < 1) {
    reject("record-shape", "policyContext.policySetVersion must be a positive integer");
  }
  const policyContentHash = requireString(
    value.policyContentHash,
    "policyContext.policyContentHash",
    {
      min: 64,
      max: 64,
    },
  );
  if (!SHA256_HEX.test(policyContentHash)) {
    reject("record-shape", "policyContext.policyContentHash must be a sha256 hex digest");
  }
  const context: AuditPolicyContext = {
    policySetId,
    policySetVersion: policySetVersion as number,
    policyContentHash,
  };
  if (value.restrictionSetDigest !== undefined) {
    const restrictionSetDigest = requireString(
      value.restrictionSetDigest,
      "policyContext.restrictionSetDigest",
      { min: 64, max: 64 },
    );
    if (!SHA256_HEX.test(restrictionSetDigest)) {
      reject("record-shape", "policyContext.restrictionSetDigest must be a sha256 hex digest");
    }
    return { ...context, restrictionSetDigest };
  }
  return context;
}

function validateSubmissionShape(value: Record<string, unknown>): AuditSubmission {
  const applicationId = value.applicationId;
  if (typeof applicationId !== "string" || !UUID_PATTERN.test(applicationId)) {
    reject("record-shape", "applicationId must be a UUID", { got: String(applicationId) });
  }
  const tenantId = value.tenantId;
  if (typeof tenantId !== "string" || !UUID_PATTERN.test(tenantId)) {
    reject("record-shape", "tenantId must be a UUID", { got: String(tenantId) });
  }
  const environment = requireString(value.environment, "environment", {
    min: 1,
    max: AUDIT_BOUNDS.environmentMax,
  });

  if (!isRecord(value.actor)) {
    reject("record-shape", "actor must be an object");
  }
  const actor: AuditActor = {
    actorId: requireString(value.actor.actorId, "actor.actorId", {
      min: 1,
      max: AUDIT_BOUNDS.actorIdMax,
    }),
    actorKind: requireVocabulary(value.actor.actorKind, "actor.actorKind", AUDIT_ACTOR_KINDS),
  };

  if (!isRecord(value.action)) {
    reject("record-shape", "action must be an object");
  }
  const action: AuditAction = {
    kind: requireVocabulary(value.action.kind, "action.kind", AUDIT_ACTION_KINDS),
    command: requireString(value.action.command, "action.command", {
      min: 1,
      max: AUDIT_BOUNDS.commandMax,
    }),
    operationKey: requireString(value.action.operationKey, "action.operationKey", {
      min: 1,
      max: AUDIT_BOUNDS.operationKeyMax,
    }),
  };

  if (!isRecord(value.target)) {
    reject("record-shape", "target must be an object");
  }
  const target: AuditTarget = {
    kind: requireVocabulary(value.target.kind, "target.kind", AUDIT_TARGET_KINDS),
    id: requireString(value.target.id, "target.id", { min: 1, max: AUDIT_BOUNDS.targetIdMax }),
  };

  if (!isRecord(value.provenance)) {
    reject("record-shape", "provenance must be an object");
  }
  const provenance: AuditProvenance = {
    seam: requireVocabulary(value.provenance.seam, "provenance.seam", AUDIT_SEAMS),
    sourceRecordId:
      value.provenance.sourceRecordId === undefined || value.provenance.sourceRecordId === null
        ? null
        : requireString(value.provenance.sourceRecordId, "provenance.sourceRecordId", {
            min: 1,
            max: AUDIT_BOUNDS.sourceRecordIdMax,
          }),
  };

  if (!isRecord(value.rationale)) {
    reject("record-shape", "rationale must be an object");
  }
  const why = requireString(value.rationale.why, "rationale.why", {
    min: 1,
    max: AUDIT_BOUNDS.whyMax,
  });
  const rationale: AuditRationale =
    value.rationale.policyContext === undefined
      ? { why }
      : isRecord(value.rationale.policyContext)
        ? { why, policyContext: validatePolicyContext(value.rationale.policyContext) }
        : reject("record-shape", "rationale.policyContext must be an object");

  const occurredAt = requireString(value.occurredAt, "occurredAt", { min: 10, max: 64 });
  if (!RFC3339_PATTERN.test(occurredAt)) {
    reject("record-shape", "occurredAt must be an RFC3339 timestamp", { got: occurredAt });
  }

  if (!isRecord(value.actionDetail)) {
    reject("record-shape", "actionDetail must be an object");
  }
  if (!auditDetailIsAdmissible(value.actionDetail)) {
    reject(
      "record-detail-unrepresentable",
      "actionDetail failed the seam scrub gate (secret-shaped keys or unbounded shape are unrepresentable in audit records)",
    );
  }
  if (!isCanonicalizable(value.actionDetail)) {
    reject("record-shape", "actionDetail must be canonicalizable");
  }

  return {
    applicationId,
    tenantId,
    environment,
    actor,
    action,
    target,
    provenance,
    rationale,
    occurredAt,
    actionDetail: value.actionDetail,
  };
}

/**
 * Total validation of a raw submission value (fail closed on any
 * unmet precondition: shape, vocabularies, bounds, scrub gate).
 */
export function validateAuditSubmission(value: unknown): AuditSubmission {
  if (!isRecord(value)) {
    reject("record-shape", "audit submission must be an object");
  }
  return validateSubmissionShape(value);
}

/** The canonical identity form of a submission (identity-covered content). */
export function auditIdentityForm(submission: AuditSubmission): AuditIdentityForm {
  return {
    applicationId: submission.applicationId,
    tenantId: submission.tenantId,
    environment: submission.environment,
    actor: submission.actor,
    action: submission.action,
    target: submission.target,
    provenance: submission.provenance,
    rationale: submission.rationale,
    actionDetail: submission.actionDetail,
  };
}

/** Content-derived identity: the recordId of a submission. */
export function computeAuditRecordId(submission: AuditSubmission, digest: AuditDigestPort): string {
  return digest.sha256Hex(canonicalAuditJson(auditIdentityForm(submission)));
}

/** The full-record form (everything except the derived recordDigest). */
export type AuditRecordForm = Omit<AuditRecord, "recordDigest">;

/** The canonical FULL record form (integrity-covered content). */
export function canonicalAuditRecordForm(record: AuditRecordForm): string {
  return canonicalAuditJson(record);
}

/** The recordDigest of a (chain-linked) record form. */
export function computeAuditRecordDigest(record: AuditRecordForm, digest: AuditDigestPort): string {
  return digest.sha256Hex(canonicalAuditJson(record));
}

/**
 * Chain-link a validated submission into the durable record shape
 * (called under the chain-head lock by the store adapter — the only
 * place chain positions are assigned).
 */
export function chainLinkSubmission(
  submission: AuditSubmission,
  linkage: {
    readonly chainSequence: number;
    readonly previousRecordDigest: string;
    readonly recordedAt: string;
  },
  digest: AuditDigestPort,
): AuditRecord {
  if (!Number.isInteger(linkage.chainSequence) || linkage.chainSequence < 1) {
    reject("record-shape", "chainSequence must be a positive integer", {
      chainSequence: linkage.chainSequence,
    });
  }
  if (!SHA256_HEX.test(linkage.previousRecordDigest)) {
    reject("record-shape", "previousRecordDigest must be a sha256 hex digest");
  }
  if (!RFC3339_PATTERN.test(linkage.recordedAt)) {
    reject("record-shape", "recordedAt must be an RFC3339 timestamp");
  }
  const recordId = computeAuditRecordId(submission, digest);
  const form: AuditRecordForm = {
    ...submission,
    recordId,
    chainSequence: linkage.chainSequence,
    previousRecordDigest: linkage.previousRecordDigest,
    recordedAt: linkage.recordedAt,
  };
  return { ...form, recordDigest: computeAuditRecordDigest(form, digest) };
}

/**
 * Total, deterministic validation of a (deserialized) audit record —
 * the read-side gate: full shape/vocabulary/bounds/scrub validation
 * PLUS both digest verifications (`recordId` must cover the identity
 * form; `recordDigest` must cover the full record). Tampered or
 * foreign rows are rejected at read time, never served.
 */
export function validateAuditRecord(value: unknown, digest: AuditDigestPort): AuditRecord {
  if (!isRecord(value)) {
    reject("record-shape", "audit record must be an object");
  }
  const submission = validateSubmissionShape(value);
  const recordId = requireString(value.recordId, "recordId", { min: 64, max: 64 });
  if (!SHA256_HEX.test(recordId)) {
    reject("record-shape", "recordId must be a sha256 hex digest");
  }
  const chainSequence = value.chainSequence;
  if (!Number.isInteger(chainSequence) || (chainSequence as number) < 1) {
    reject("record-shape", "chainSequence must be a positive integer");
  }
  const previousRecordDigest = requireString(value.previousRecordDigest, "previousRecordDigest", {
    min: 64,
    max: 64,
  });
  if (!SHA256_HEX.test(previousRecordDigest)) {
    reject("record-shape", "previousRecordDigest must be a sha256 hex digest");
  }
  const recordDigest = requireString(value.recordDigest, "recordDigest", { min: 64, max: 64 });
  if (!SHA256_HEX.test(recordDigest)) {
    reject("record-shape", "recordDigest must be a sha256 hex digest");
  }
  const recordedAt = requireString(value.recordedAt, "recordedAt", { min: 10, max: 64 });
  if (!RFC3339_PATTERN.test(recordedAt)) {
    reject("record-shape", "recordedAt must be an RFC3339 timestamp");
  }

  const record: AuditRecord = {
    ...submission,
    recordId,
    chainSequence: chainSequence as number,
    previousRecordDigest,
    recordedAt,
    recordDigest,
  };

  // Identity verification: recordId covers the identity form.
  const computedRecordId = computeAuditRecordId(submission, digest);
  if (computedRecordId !== recordId) {
    reject("record-identity-mismatch", "record content does not digest to the claimed recordId", {
      claimed: recordId,
      computed: computedRecordId,
    });
  }
  // Integrity verification: recordDigest covers the full record.
  const { recordDigest: _excluded, ...form } = record;
  const computedDigest = computeAuditRecordDigest(form as AuditRecordForm, digest);
  if (computedDigest !== recordDigest) {
    reject(
      "record-identity-mismatch",
      "record content does not digest to the claimed recordDigest",
      {
        claimed: recordDigest,
        computed: computedDigest,
      },
    );
  }
  return record;
}

/** The genesis predecessor of the first record in a chain. */
export function auditChainGenesis(): string {
  return AUDIT_CHAIN_GENESIS;
}
