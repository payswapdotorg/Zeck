/**
 * `audit` ports layer (WORK-059 / SEC-004).
 *
 * Provider-neutral outbound contracts owned by this module. Ports are
 * the ONLY surfaces the application layer may reach through; adapters
 * (in `adapters/`) implement them over the platform
 * (`IMPLEMENTATION.md` §2–§3).
 *
 * THE EVIDENCE-ONLY SHAPE (architecture invariant 2): these ports
 * carry APPEND and READ vocabulary only. There is no admission,
 * authorization, allow/deny, reservation or settlement surface, and
 * none may be added without an architecture change — the audit
 * projection is evidence, never an authorization source.
 */

import type {
  AdoptPolicyInput,
  AuditRecord,
  AuditSubmission,
  LegalHoldRecord,
  PlaceHoldInput,
  PurgeManifest,
  RetentionPolicyRecord,
} from "../domain";

/** The outcome of an append: replayed=true for the idempotent no-op. */
export interface AuditAppendOutcome {
  /** The content-derived identity of the recorded action. */
  readonly recordId: string;
  /** The chain position the record occupies (replays report the original). */
  readonly chainSequence: number;
  /** True when the identical durable record was replayed (no new row). */
  readonly replayed: boolean;
}

/** Bounded listing options (sequence-ordered reads). */
export interface AuditListOptions {
  readonly fromSequence?: number;
  readonly toSequence?: number;
  /** Upper bound on returned records (bounded reads by construction). */
  readonly limit?: number;
}

/** The chain head (a derived pointer — evidence reads never use it as truth). */
export interface AuditChainHead {
  readonly applicationId: string;
  readonly lastSequence: number;
  readonly lastDigest: string;
}

/** The governed purge input (the ONLY deletion path in the module). */
export interface GovernedPurgeInput {
  readonly applicationId: string;
  /** Records recorded strictly BEFORE this instant are purge candidates. */
  readonly cutoff: string;
  /** The retention policy version authorizing the purge (evidence). */
  readonly policyVersion: number;
  /** WHO/WHY: the procedure actor and rationale for the evidence record. */
  readonly procedureActorId: string;
  readonly reason: string;
  readonly environment: string;
  /** The instant the purge procedure runs at. */
  readonly asOf: string;
}

/** The governed purge outcome. */
export interface GovernedPurgeOutcome {
  /** True when records were purged AND evidence was recorded. */
  readonly purged: boolean;
  /** Number of records deleted in this batch. */
  readonly purgedCount: number;
  /** The purge-evidence audit record (null when nothing was purge-eligible). */
  readonly evidence: AuditRecord | null;
}

/**
 * The durable audit-record store: append + read + the governed purge.
 * Append-only by construction; the SQL adapter enforces it at the
 * database level (triggers) — see `adapters/sql-audit-store.ts`.
 */
export interface AuditRecordStore {
  /**
   * Append one audit submission. Idempotent by content identity: the
   * same governed action recorded twice is a bounded no-op (replay).
   * Chain extension is serialized under the chain-head lock; the
   * record identity, linkage and head update commit atomically.
   */
  appendRecord(submission: AuditSubmission): Promise<AuditAppendOutcome>;
  getRecord(applicationId: string, recordId: string): Promise<AuditRecord | null>;
  listRecords(applicationId: string, options?: AuditListOptions): Promise<readonly AuditRecord[]>;
  chainHead(applicationId: string): Promise<AuditChainHead | null>;
  /**
   * The GOVERNED retention purge (the only deletion path): deletes
   * expired, hold-free records in a bounded batch, and — when anything
   * was deleted — appends the purge-evidence record (manifest + head
   * update) in the SAME transaction. A concurrent/retried purge that
   * finds nothing deletes nothing and records nothing (no
   * double-purge, no duplicate evidence).
   */
  purgeExpiredRecords(input: GovernedPurgeInput): Promise<GovernedPurgeOutcome>;
  /**
   * The purge manifests covering a sequence window (bounded read of
   * `retention.purge-executed` evidence records whose entries overlap
   * the window — export assembly input).
   */
  listPurgeManifests(
    applicationId: string,
    window: { readonly fromSequence: number; readonly toSequence: number },
  ): Promise<readonly PurgeManifest[]>;
}

/** Legal-hold store: placement/release are governed, audited procedures. */
export interface LegalHoldStore {
  /** Place a hold (idempotent per hold identity; evidence record in the same transaction). */
  placeHold(input: PlaceHoldInput): Promise<LegalHoldRecord>;
  /** Release a hold (fail closed on unknown/already-released; evidence record in the same transaction). */
  releaseHold(
    applicationId: string,
    holdId: string,
    releasedBy: string,
    releasedAt?: string,
  ): Promise<LegalHoldRecord>;
  getHold(applicationId: string, holdId: string): Promise<LegalHoldRecord | null>;
  listActiveHolds(applicationId: string): Promise<readonly LegalHoldRecord[]>;
}

/** Retention-policy store: adoption is a governed, audited procedure. */
export interface RetentionPolicyStore {
  /** Adopt a policy version (idempotent per (application, version); evidence record in the same transaction). */
  adoptPolicy(input: AdoptPolicyInput): Promise<RetentionPolicyRecord>;
  /** The latest adopted version (the active policy; null when none was adopted). */
  latestPolicy(applicationId: string): Promise<RetentionPolicyRecord | null>;
}

/** Typed failures of the audit durable surface (fail closed, never silent). */
export class AuditStoreError extends Error {
  readonly code:
    | "AUDIT_RECORD_IDENTITY_CONFLICT"
    | "AUDIT_CHAIN_BROKEN"
    | "AUDIT_HOLD_UNKNOWN"
    | "AUDIT_HOLD_ALREADY_RELEASED"
    | "AUDIT_HOLD_IDENTITY_CONFLICT"
    | "AUDIT_POLICY_IDENTITY_CONFLICT"
    | "AUDIT_TENANT_MISMATCH"
    | "AUDIT_PROJECTION_UNAVAILABLE";
  readonly details: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: AuditStoreError["code"],
    message: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ) {
    super(message);
    this.name = "AuditStoreError";
    this.code = code;
    this.details = Object.freeze({ ...(details ?? {}) });
  }
}

/** The projection failure an observation seam surfaces (fail closed). */
export class AuditProjectionError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AuditProjectionError";
    this.cause = cause;
  }
}
