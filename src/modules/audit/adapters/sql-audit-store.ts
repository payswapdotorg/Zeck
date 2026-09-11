/**
 * SQL audit store (audit module adapter; WORK-059 / SEC-004).
 *
 * The durable implementation of the audit ports over the
 * provider-neutral `DatabasePort` (migration `0031_audit_compliance`).
 * PostgreSQL is the SOLE durable authority for audit records — this is
 * the ONLY durable implementation (no second store, cache or ledger
 * of audit evidence exists anywhere).
 *
 * Physical invariants live in the migration; this adapter maps rows
 * <-> domain records and enforces the governed semantics:
 *
 *  - APPEND (`appendRecord`): the chain head row is locked (FOR
 *    UPDATE) — chain extension is serialized per application; the
 *    record identity is content-addressed (`recordId`), so the same
 *    governed action recorded twice (idempotent retry, concurrent
 *    duplicate) converges to a bounded no-op that replays the durable
 *    row; identity + linkage + head update commit in ONE transaction
 *    (crash-safety: no partial chain, no lost head);
 *  - IMMUTABILITY: the table rejects UPDATE/DELETE/TRUNCATE at the
 *    database level (triggers). The ONLY deletion path is
 *    `purgeExpiredRecords` — the governed retention purge — which
 *    sets the transaction-local session marker
 *    (`SET LOCAL audit.governed_purge`) before deleting ONLY expired,
 *    hold-free records, and appends the purge-evidence record (with
 *    the full manifest of purged positions+digests) in the SAME
 *    transaction. A purge that finds nothing deletes nothing and
 *    records nothing (no double-purge, no duplicate evidence);
 *  - READS validate every row on read (total validation incl. both
 *    digests — a tampered or foreign row is rejected, never served);
 *  - HOLDS and POLICIES: placement/release/adoption write the durable
 *    row AND the audit-evidence record in one transaction (governed
 *    procedures are audited by construction).
 */

import type { DatabasePort, Transaction } from "../../../platform/db/port";
import { createUuidv7Generator } from "../../../shared/ids";
import type {
  AdoptPolicyInput,
  AuditDigestPort,
  AuditRecord,
  AuditSubmission,
  LegalHoldRecord,
  PlaceHoldInput,
  PurgeManifest,
  PurgeManifestEntry,
  RetentionPolicyRecord,
} from "../domain";
import {
  AuditValidationError,
  chainLinkSubmission,
  computeAuditRecordId,
  purgeManifestCommitment,
  validateAdoptPolicyInput,
  validateAuditRecord,
  validateAuditSubmission,
  validateLegalHoldRecord,
  validatePlaceHoldInput,
  validateRetentionPolicyRecord,
} from "../domain";
import type {
  AuditAppendOutcome,
  AuditChainHead,
  AuditListOptions,
  AuditRecordStore,
  AuditStoreError,
  GovernedPurgeInput,
  GovernedPurgeOutcome,
  LegalHoldStore,
  RetentionPolicyStore,
} from "../ports/audit-store";
import { AuditStoreError as AuditStoreErrorClass } from "../ports/audit-store";

const generateId = createUuidv7Generator();

const INSERT_RECORD_SQL = `INSERT INTO audit.audit_records
    (id, application_id, tenant_id, record_id, chain_sequence, action_kind,
     actor_id, actor_kind, target_kind, target_id, seam, source_record_id,
     environment, occurred_at, recorded_at, previous_record_digest, record_digest, payload)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`;

const RECORD_COLUMNS = `id, application_id, tenant_id, record_id, chain_sequence, action_kind,
    actor_id, actor_kind, target_kind, target_id, seam, source_record_id, environment,
    occurred_at, recorded_at, previous_record_digest, record_digest, payload`;

interface AuditRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly record_id: string;
  readonly chain_sequence: string | number;
  readonly action_kind: string;
  readonly actor_id: string;
  readonly actor_kind: string;
  readonly target_kind: string;
  readonly target_id: string;
  readonly seam: string;
  readonly source_record_id: string | null;
  readonly environment: string;
  readonly occurred_at: Date | string;
  readonly recorded_at: Date | string;
  readonly previous_record_digest: string;
  readonly record_digest: string;
  readonly payload: unknown;
}

interface ChainHeadRow {
  readonly application_id: string;
  readonly tenant_id: string;
  readonly last_sequence: string | number;
  readonly last_digest: string;
}

interface HoldRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly hold_scope: string;
  readonly target_kind: string | null;
  readonly target_id: string | null;
  readonly reason: string;
  readonly placed_by: string;
  readonly placed_at: Date | string;
  readonly released_at: Date | string | null;
  readonly released_by: string | null;
}

interface PolicyRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly version: number;
  readonly retention_days: number;
  readonly reason: string;
  readonly adopted_by: string;
  readonly adopted_at: Date | string;
}

function iso(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/** Fail-closed typed store error. */
function fail(code: AuditStoreError["code"], message: string): never {
  throw new AuditStoreErrorClass(code, message);
}

/** Insert an (already chain-linked) record + advance the head. */
async function insertRecordAndAdvanceHead(tx: Transaction, record: AuditRecord): Promise<void> {
  await tx.execute({
    sql: INSERT_RECORD_SQL,
    parameters: [
      generateId(),
      record.applicationId,
      record.tenantId,
      record.recordId,
      record.chainSequence,
      record.action.kind,
      record.actor.actorId,
      record.actor.actorKind,
      record.target.kind,
      record.target.id,
      record.provenance.seam,
      record.provenance.sourceRecordId,
      record.environment,
      record.occurredAt,
      record.recordedAt,
      record.previousRecordDigest,
      record.recordDigest,
      JSON.stringify(record),
    ],
  });
  await tx.execute({
    sql: `UPDATE audit.chain_heads
             SET last_sequence = $2, last_digest = $3, updated_at = now()
           WHERE application_id = $1`,
    parameters: [record.applicationId, record.chainSequence, record.recordDigest],
  });
}

/**
 * The SQL adapter implementing all three audit store ports (one
 * module, one durable surface — the audit schema).
 */
export class SqlAuditStore implements AuditRecordStore, LegalHoldStore, RetentionPolicyStore {
  constructor(
    private readonly db: DatabasePort,
    private readonly digest: AuditDigestPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // -------------------------------------------------------------------------
  // AuditRecordStore — append (identity idempotent, chain serialized)
  // -------------------------------------------------------------------------

  async appendRecord(submission: AuditSubmission): Promise<AuditAppendOutcome> {
    validateAuditSubmission(submission);

    return this.db.transaction(async (tx) => {
      const head = await this.lockHead(tx, submission.applicationId, submission.tenantId);
      const recordId = computeAuditRecordId(submission, this.digest);

      // Idempotent convergence: the same governed action recorded
      // twice is a bounded no-op (the durable row replays).
      const existing = await this.selectRecord(tx, submission.applicationId, recordId);
      if (existing !== null) {
        const record = this.rowToRecord(existing);
        return { recordId, chainSequence: record.chainSequence, replayed: true };
      }

      const record = chainLinkSubmission(
        submission,
        {
          chainSequence: Number(head.last_sequence) + 1,
          previousRecordDigest: head.last_digest,
          recordedAt: this.now().toISOString(),
        },
        this.digest,
      );
      await insertRecordAndAdvanceHead(tx, record);
      return { recordId, chainSequence: record.chainSequence, replayed: false };
    });
  }

  async getRecord(applicationId: string, recordId: string): Promise<AuditRecord | null> {
    const result = await this.db.execute<AuditRow>({
      sql: `SELECT ${RECORD_COLUMNS} FROM audit.audit_records
             WHERE application_id = $1 AND record_id = $2`,
      parameters: [applicationId, recordId],
    });
    const row = result.rows[0];
    return row === undefined ? null : this.rowToRecord(row);
  }

  async listRecords(
    applicationId: string,
    options: AuditListOptions = {},
  ): Promise<readonly AuditRecord[]> {
    const limit = Math.min(options.limit ?? 500, 5000);
    const result = await this.db.execute<AuditRow>({
      sql: `SELECT ${RECORD_COLUMNS} FROM audit.audit_records
             WHERE application_id = $1
               AND chain_sequence >= $2
               AND chain_sequence <= $3
             ORDER BY chain_sequence ASC
             LIMIT $4`,
      parameters: [
        applicationId,
        options.fromSequence ?? 1,
        options.toSequence ?? 9_000_000_000,
        limit,
      ],
    });
    return result.rows.map((row) => this.rowToRecord(row));
  }

  async chainHead(applicationId: string): Promise<AuditChainHead | null> {
    const result = await this.db.execute<ChainHeadRow>({
      sql: `SELECT application_id, tenant_id, last_sequence, last_digest
              FROM audit.chain_heads WHERE application_id = $1`,
      parameters: [applicationId],
    });
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      applicationId: row.application_id,
      lastSequence: Number(row.last_sequence),
      lastDigest: row.last_digest,
    };
  }

  // -------------------------------------------------------------------------
  // AuditRecordStore — the governed retention purge (the only deletion)
  // -------------------------------------------------------------------------

  async purgeExpiredRecords(input: GovernedPurgeInput): Promise<GovernedPurgeOutcome> {
    return this.db.transaction(async (tx) => {
      // Lock the chain head: purges serialize against appends (and
      // each other) — no double-purge window, no interleaved evidence.
      const headRow = await tx.execute<{ tenant_id: string }>({
        sql: "SELECT tenant_id FROM audit.chain_heads WHERE application_id = $1 FOR UPDATE",
        parameters: [input.applicationId],
      });
      const tenantId = headRow.rows[0]?.tenant_id;
      if (tenantId === undefined) {
        // No audit activity for this application: nothing can expire.
        return { purged: false, purgedCount: 0, evidence: null };
      }

      // The governed session gate: the ONLY code path that sets it.
      // Everything deleted below is expired + hold-free, and the
      // evidence record commits with it (or nothing commits).
      await tx.execute({ sql: "SET LOCAL audit.governed_purge = 'governed'", parameters: [] });

      const deleted = await tx.execute<{
        record_id: string;
        chain_sequence: string;
        record_digest: string;
      }>({
        sql: `DELETE FROM audit.audit_records
               WHERE application_id = $1
                 AND recorded_at < $2::timestamptz
                 AND action_kind <> 'retention.purge-executed'
                 AND NOT EXISTS (
                     SELECT 1 FROM audit.legal_holds h
                      WHERE h.application_id = $1
                        AND h.released_at IS NULL
                        AND (h.hold_scope = 'application'
                             OR (h.hold_scope = 'target'
                                 AND h.target_kind = audit.audit_records.target_kind
                                 AND h.target_id = audit.audit_records.target_id)))
               RETURNING record_id, chain_sequence, record_digest`,
        parameters: [input.applicationId, input.cutoff],
      });

      if (deleted.rows.length === 0) {
        // Nothing purge-eligible (all current, held, or already
        // purged): no deletion happened, no evidence is recorded —
        // the procedure converged without side effects.
        return { purged: false, purgedCount: 0, evidence: null };
      }

      const entries: PurgeManifestEntry[] = deleted.rows
        .map((row) => ({ sequence: Number(row.chain_sequence), recordDigest: row.record_digest }))
        .sort((left, right) => left.sequence - right.sequence);
      const manifest: PurgeManifest = {
        policyVersion: input.policyVersion,
        cutoff: input.cutoff,
        entries,
        commitment: purgeManifestCommitment(
          { policyVersion: input.policyVersion, cutoff: input.cutoff, entries },
          this.digest,
        ),
      };

      const head = await this.lockHead(tx, input.applicationId, tenantId);
      const submission: AuditSubmission = {
        applicationId: input.applicationId,
        tenantId,
        environment: input.environment,
        actor: { actorId: input.procedureActorId, actorKind: "system-procedure" },
        action: {
          kind: "retention.purge-executed",
          command: "retention-purge",
          operationKey: `purge:v${input.policyVersion}:${input.cutoff}:${manifest.commitment}`,
        },
        target: { kind: "application", id: input.applicationId },
        provenance: { seam: "retention.purge", sourceRecordId: null },
        rationale: { why: input.reason },
        occurredAt: input.asOf,
        actionDetail: {
          policyVersion: input.policyVersion,
          cutoff: input.cutoff,
          purgedCount: entries.length,
          purge: manifest,
        },
      };
      const recordId = computeAuditRecordId(submission, this.digest);
      const existing = await this.selectRecord(tx, input.applicationId, recordId);
      if (existing !== null) {
        // The exact purge evidence already exists (batch content
        // identity): replay — nothing further to record.
        return { purged: true, purgedCount: 0, evidence: this.rowToRecord(existing) };
      }
      const evidence = chainLinkSubmission(
        submission,
        {
          chainSequence: Number(head.last_sequence) + 1,
          previousRecordDigest: head.last_digest,
          recordedAt: this.now().toISOString(),
        },
        this.digest,
      );
      await insertRecordAndAdvanceHead(tx, evidence);
      return { purged: true, purgedCount: entries.length, evidence };
    });
  }

  async listPurgeManifests(
    applicationId: string,
    window: { readonly fromSequence: number; readonly toSequence: number },
  ): Promise<readonly PurgeManifest[]> {
    const result = await this.db.execute<AuditRow>({
      sql: `SELECT ${RECORD_COLUMNS} FROM audit.audit_records
             WHERE application_id = $1 AND action_kind = 'retention.purge-executed'
             ORDER BY chain_sequence ASC`,
      parameters: [applicationId],
    });
    const manifests: PurgeManifest[] = [];
    for (const row of result.rows) {
      const record = this.rowToRecord(row);
      const purge = (record.actionDetail as Record<string, unknown>).purge;
      if (purge === undefined || purge === null) {
        throw new AuditValidationError(
          "record-identity-mismatch",
          `purge evidence record ${record.recordId} carries no manifest (tampered or foreign row)`,
        );
      }
      const manifest = purge as PurgeManifest;
      if (
        manifest.entries.some(
          (entry) => entry.sequence >= window.fromSequence && entry.sequence <= window.toSequence,
        )
      ) {
        manifests.push(manifest);
      }
    }
    return manifests;
  }

  // -------------------------------------------------------------------------
  // LegalHoldStore — governed, audited procedures
  // -------------------------------------------------------------------------

  async placeHold(input: PlaceHoldInput): Promise<LegalHoldRecord> {
    const validated = validatePlaceHoldInput(input);
    return this.db.transaction(async (tx) => {
      // Idempotent placement: the same ACTIVE hold (scope + target)
      // with the same rationale replays; a live hold with different
      // content fails closed (identity conflict).
      const existing = await tx.execute<HoldRow>({
        sql: `SELECT * FROM audit.legal_holds
               WHERE application_id = $1 AND hold_scope = $2
                 AND COALESCE(target_kind, '') = COALESCE($3, '')
                 AND COALESCE(target_id, '') = COALESCE($4, '')
               ORDER BY placed_at DESC LIMIT 1 FOR UPDATE`,
        parameters: [
          validated.applicationId,
          validated.holdScope,
          validated.targetKind ?? null,
          validated.targetId ?? null,
        ],
      });
      const prior = existing.rows[0];
      if (prior !== undefined && prior.released_at === null) {
        if (prior.reason === validated.reason) {
          return this.rowToHold(prior);
        }
        fail(
          "AUDIT_HOLD_IDENTITY_CONFLICT",
          "an active hold already covers this scope with a different rationale (release it first)",
        );
      }

      const holdId = generateId();
      const placedAt = validated.placedAt ?? this.now().toISOString();
      await tx.execute({
        sql: `INSERT INTO audit.legal_holds
                    (id, application_id, tenant_id, hold_scope, target_kind, target_id,
                     reason, placed_by, placed_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)`,
        parameters: [
          holdId,
          validated.applicationId,
          validated.tenantId,
          validated.holdScope,
          validated.targetKind ?? null,
          validated.targetId ?? null,
          validated.reason,
          validated.placedBy,
          placedAt,
        ],
      });

      // The placement is AUDITED (governed procedure evidence).
      await this.appendInternal(tx, {
        applicationId: validated.applicationId,
        tenantId: validated.tenantId,
        environment: "control-plane",
        actor: { actorId: validated.placedBy, actorKind: "service-principal" },
        action: {
          kind: "audit.legal-hold-placed",
          command: "legal-hold-place",
          operationKey: `hold:${holdId}`,
        },
        target:
          validated.holdScope === "target" &&
          validated.targetKind !== undefined &&
          validated.targetId !== undefined
            ? { kind: validated.targetKind, id: validated.targetId }
            : { kind: "application", id: validated.applicationId },
        provenance: { seam: "audit.legal-hold", sourceRecordId: holdId },
        rationale: { why: validated.reason },
        occurredAt: placedAt,
        actionDetail: { holdId, holdScope: validated.holdScope },
      });

      return {
        holdId,
        applicationId: validated.applicationId,
        tenantId: validated.tenantId,
        holdScope: validated.holdScope,
        targetKind: validated.targetKind ?? null,
        targetId: validated.targetId ?? null,
        reason: validated.reason,
        placedBy: validated.placedBy,
        placedAt,
        releasedAt: null,
        releasedBy: null,
      };
    });
  }

  async releaseHold(
    applicationId: string,
    holdId: string,
    releasedBy: string,
    releasedAt?: string,
  ): Promise<LegalHoldRecord> {
    return this.db.transaction(async (tx) => {
      const existing = await tx.execute<HoldRow>({
        sql: `SELECT * FROM audit.legal_holds
               WHERE application_id = $1 AND id = $2::uuid FOR UPDATE`,
        parameters: [applicationId, holdId],
      });
      const row = existing.rows[0];
      if (row === undefined) {
        fail("AUDIT_HOLD_UNKNOWN", `legal hold ${holdId} was not found for this application`);
      }
      if (row.released_at !== null) {
        fail("AUDIT_HOLD_ALREADY_RELEASED", `legal hold ${holdId} is already released`);
      }
      const releasedAtValue = releasedAt ?? this.now().toISOString();
      await tx.execute({
        sql: `UPDATE audit.legal_holds
                 SET released_at = $3::timestamptz, released_by = $4
               WHERE application_id = $1 AND id = $2::uuid`,
        parameters: [applicationId, holdId, releasedAtValue, releasedBy],
      });

      // The release is AUDITED.
      await this.appendInternal(tx, {
        applicationId,
        tenantId: row.tenant_id,
        environment: "control-plane",
        actor: { actorId: releasedBy, actorKind: "service-principal" },
        action: {
          kind: "audit.legal-hold-released",
          command: "legal-hold-release",
          operationKey: `hold-release:${holdId}:${releasedAtValue}`,
        },
        target: { kind: "application", id: applicationId },
        provenance: { seam: "audit.legal-hold", sourceRecordId: holdId },
        rationale: { why: "legal hold released" },
        occurredAt: releasedAtValue,
        actionDetail: { holdId },
      });

      return this.rowToHold({ ...row, released_at: releasedAtValue, released_by: releasedBy });
    });
  }

  async getHold(applicationId: string, holdId: string): Promise<LegalHoldRecord | null> {
    const result = await this.db.execute<HoldRow>({
      sql: "SELECT * FROM audit.legal_holds WHERE application_id = $1 AND id = $2::uuid",
      parameters: [applicationId, holdId],
    });
    const row = result.rows[0];
    return row === undefined ? null : this.rowToHold(row);
  }

  async listActiveHolds(applicationId: string): Promise<readonly LegalHoldRecord[]> {
    const result = await this.db.execute<HoldRow>({
      sql: "SELECT * FROM audit.legal_holds WHERE application_id = $1 AND released_at IS NULL ORDER BY placed_at ASC",
      parameters: [applicationId],
    });
    return result.rows.map((row) => this.rowToHold(row));
  }

  // -------------------------------------------------------------------------
  // RetentionPolicyStore — governed, audited adoption
  // -------------------------------------------------------------------------

  async adoptPolicy(input: AdoptPolicyInput): Promise<RetentionPolicyRecord> {
    const validated = validateAdoptPolicyInput(input);
    return this.db.transaction(async (tx) => {
      const existing = await tx.execute<PolicyRow>({
        sql: "SELECT * FROM audit.retention_policies WHERE application_id = $1 AND version = $2",
        parameters: [validated.applicationId, validated.version],
      });
      const prior = existing.rows[0];
      if (prior !== undefined) {
        if (prior.retention_days === validated.retentionDays && prior.reason === validated.reason) {
          return this.rowToPolicy(prior);
        }
        fail(
          "AUDIT_POLICY_IDENTITY_CONFLICT",
          `policy version ${validated.version} already holds different content (adopt a new version; policies are never rewritten)`,
        );
      }

      const policyId = generateId();
      const adoptedAt = validated.adoptedAt ?? this.now().toISOString();
      await tx.execute({
        sql: `INSERT INTO audit.retention_policies
                    (id, application_id, tenant_id, version, retention_days, reason, adopted_by, adopted_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
        parameters: [
          policyId,
          validated.applicationId,
          validated.tenantId,
          validated.version,
          validated.retentionDays,
          validated.reason,
          validated.adoptedBy,
          adoptedAt,
        ],
      });

      // The adoption is AUDITED.
      await this.appendInternal(tx, {
        applicationId: validated.applicationId,
        tenantId: validated.tenantId,
        environment: "control-plane",
        actor: { actorId: validated.adoptedBy, actorKind: "service-principal" },
        action: {
          kind: "retention.policy-adopted",
          command: "retention-policy-adopt",
          operationKey: `policy:${validated.applicationId}:v${validated.version}`,
        },
        target: { kind: "application", id: validated.applicationId },
        provenance: { seam: "retention.policy", sourceRecordId: policyId },
        rationale: { why: validated.reason },
        occurredAt: adoptedAt,
        actionDetail: {
          policyId,
          version: validated.version,
          retentionDays: validated.retentionDays,
        },
      });

      return {
        policyId,
        applicationId: validated.applicationId,
        tenantId: validated.tenantId,
        version: validated.version,
        retentionDays: validated.retentionDays,
        reason: validated.reason,
        adoptedBy: validated.adoptedBy,
        adoptedAt,
      };
    });
  }

  async latestPolicy(applicationId: string): Promise<RetentionPolicyRecord | null> {
    const result = await this.db.execute<PolicyRow>({
      sql: `SELECT * FROM audit.retention_policies
             WHERE application_id = $1 ORDER BY version DESC LIMIT 1`,
      parameters: [applicationId],
    });
    const row = result.rows[0];
    return row === undefined ? null : this.rowToPolicy(row);
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Lock (or create) the chain head row inside a transaction. */
  private async lockHead(
    tx: Transaction,
    applicationId: string,
    tenantId: string,
  ): Promise<ChainHeadRow> {
    // INSERT ... ON CONFLICT DO NOTHING + re-select FOR UPDATE: two
    // concurrent FIRST appends converge (the loser waits on the lock).
    await tx.execute({
      sql: `INSERT INTO audit.chain_heads (application_id, tenant_id, last_sequence, last_digest)
            VALUES ($1, $2, 0, $3)
            ON CONFLICT (application_id) DO NOTHING`,
      parameters: [applicationId, tenantId, "0".repeat(64)],
    });
    const head = await tx.execute<ChainHeadRow>({
      sql: `SELECT application_id, tenant_id, last_sequence, last_digest
              FROM audit.chain_heads WHERE application_id = $1 FOR UPDATE`,
      parameters: [applicationId],
    });
    const row = head.rows[0];
    if (row === undefined) {
      fail(
        "AUDIT_PROJECTION_UNAVAILABLE",
        "audit chain head row missing after upsert (unreachable while the schema holds)",
      );
    }
    return row;
  }

  private async selectRecord(
    tx: Transaction,
    applicationId: string,
    recordId: string,
  ): Promise<AuditRow | null> {
    const result = await tx.execute<AuditRow>({
      sql: `SELECT ${RECORD_COLUMNS} FROM audit.audit_records
             WHERE application_id = $1 AND record_id = $2 FOR UPDATE`,
      parameters: [applicationId, recordId],
    });
    return result.rows[0] ?? null;
  }

  /** Append an audit-evidence record for the module's own procedures (inside a caller transaction). */
  private async appendInternal(
    tx: Transaction,
    submission: AuditSubmission,
  ): Promise<AuditAppendOutcome> {
    validateAuditSubmission(submission);
    const head = await this.lockHead(tx, submission.applicationId, submission.tenantId);
    const recordId = computeAuditRecordId(submission, this.digest);
    const existing = await this.selectRecord(tx, submission.applicationId, recordId);
    if (existing !== null) {
      const record = this.rowToRecord(existing);
      return { recordId, chainSequence: record.chainSequence, replayed: true };
    }
    const record = chainLinkSubmission(
      submission,
      {
        chainSequence: Number(head.last_sequence) + 1,
        previousRecordDigest: head.last_digest,
        recordedAt: this.now().toISOString(),
      },
      this.digest,
    );
    await insertRecordAndAdvanceHead(tx, record);
    return { recordId, chainSequence: record.chainSequence, replayed: false };
  }

  /**
   * Validate a durable row on read: the payload IS the full record —
   * total validation (shape + both digests) then column agreement.
   * Tampered or foreign rows are rejected, never served.
   */
  private rowToRecord(row: AuditRow): AuditRecord {
    let payload: unknown = row.payload;
    if (typeof payload === "string") {
      payload = JSON.parse(payload) as unknown;
    }
    const record = validateAuditRecord(payload, this.digest);
    const occurredAtColumn = new Date(iso(row.occurred_at)).getTime();
    const recordedAtColumn = new Date(iso(row.recorded_at)).getTime();
    if (
      record.recordId !== row.record_id ||
      record.recordDigest !== row.record_digest ||
      record.chainSequence !== Number(row.chain_sequence) ||
      record.previousRecordDigest !== row.previous_record_digest ||
      record.applicationId !== row.application_id ||
      record.action.kind !== row.action_kind ||
      record.actor.actorId !== row.actor_id ||
      record.target.kind !== row.target_kind ||
      record.target.id !== row.target_id ||
      record.provenance.seam !== row.seam ||
      new Date(record.occurredAt).getTime() !== occurredAtColumn ||
      new Date(record.recordedAt).getTime() !== recordedAtColumn
    ) {
      throw new AuditValidationError(
        "record-identity-mismatch",
        "durable audit row columns disagree with the validated payload (tampered or foreign row)",
        { recordId: row.record_id },
      );
    }
    return record;
  }

  private rowToHold(row: HoldRow): LegalHoldRecord {
    return validateLegalHoldRecord({
      holdId: row.id,
      applicationId: row.application_id,
      tenantId: row.tenant_id,
      holdScope: row.hold_scope,
      targetKind: row.target_kind,
      targetId: row.target_id,
      reason: row.reason,
      placedBy: row.placed_by,
      placedAt: iso(row.placed_at),
      releasedAt: row.released_at === null ? null : iso(row.released_at),
      releasedBy: row.released_by,
    });
  }

  private rowToPolicy(row: PolicyRow): RetentionPolicyRecord {
    return validateRetentionPolicyRecord({
      policyId: row.id,
      applicationId: row.application_id,
      tenantId: row.tenant_id,
      version: row.version,
      retentionDays: row.retention_days,
      reason: row.reason,
      adoptedBy: row.adopted_by,
      adoptedAt: iso(row.adopted_at),
    });
  }
}
