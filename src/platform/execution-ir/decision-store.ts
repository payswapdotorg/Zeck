/**
 * The durable optimization decision-record store (platform execution-ir
 * plane; WORK-049).
 *
 * PostgreSQL is the SOLE durable authority for optimization decision
 * records (Work Order AC 7): the SQL adapter in this plane owns the
 * single durable table (migration `0030_execution_ir_decision_records`),
 * physically append-only and idempotent by decision identity. There is
 * deliberately no second store, cache or ledger for decision evidence.
 *
 * The store contract is EVIDENCE-shaped and evidence-shaped ONLY
 * (architecture invariant 5 / ADR-0020):
 *
 *  - `append` — idempotent, append-only: re-recording the SAME decision
 *    (same `decisionId`, same `recordDigest`) is a bounded no-op that
 *    replays the durable row; a different record under a live
 *    `decisionId` is a typed identity conflict (never an overwrite);
 *  - `get` / `listByPlan` / `listByExecution` — read paths that
 *    validate every row on read (shape + both digests), so tampered or
 *    foreign rows are rejected instead of served;
 *  - there is NO admission, authorization, allow/deny or reservation
 *    surface: no execution path may consult decision records for
 *    authorization — the store makes that consultation impossible by
 *    construction (boundary-proven by the architecture tests).
 */

import type { DatabasePort, Transaction } from "../db/port";
import type { OptimizationDecisionRecord } from "./decision-record";
import { DecisionValidationError, validateOptimizationDecision } from "./decision-record";
import type { IrDigestPort } from "./ir";

/** The outcome of an append: replayed=true for the idempotent no-op. */
export interface DecisionAppendOutcome {
  readonly decisionId: string;
  /** True when the identical durable decision was replayed (no new row). */
  readonly replayed: boolean;
}

/**
 * The decision-record store port. Append + read only — no
 * authorization-shaped method exists, and none may be added without an
 * architecture change (ADR-0020: decision records are evidence, never
 * authorization).
 */
export interface OptimizationDecisionStore {
  append(record: OptimizationDecisionRecord): Promise<DecisionAppendOutcome>;
  get(applicationId: string, decisionId: string): Promise<OptimizationDecisionRecord | null>;
  listByPlan(applicationId: string, planId: string): Promise<readonly OptimizationDecisionRecord[]>;
  listByExecution(
    applicationId: string,
    executionId: string,
  ): Promise<readonly OptimizationDecisionRecord[]>;
}

/** Identity conflict: a live decisionId reused for different content. */
export class DecisionIdentityConflictError extends Error {
  readonly decisionId: string;
  readonly applicationId: string;

  constructor(decisionId: string, applicationId: string) {
    super(
      `optimization decision identity already holds different content (decisionId reuse is rejected, never overwritten)`,
    );
    this.name = "DecisionIdentityConflictError";
    this.decisionId = decisionId;
    this.applicationId = applicationId;
  }
}

interface DecisionRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string | null;
  readonly decision_id: string;
  readonly plan_id: string;
  readonly ir_id: string;
  readonly record_digest: string;
  readonly payload: unknown;
  readonly recorded_at: Date;
}

/**
 * The SQL adapter over the provider-neutral `DatabasePort` — the ONLY
 * durable implementation of the store (PostgreSQL is the sole durable
 * authority). The table is physically append-only (trigger) and unique
 * on (application_id, decision_id); every read validates the row's
 * closed shape and both content digests.
 */
export class SqlOptimizationDecisionStore implements OptimizationDecisionStore {
  constructor(
    private readonly db: DatabasePort,
    private readonly digest: IrDigestPort,
    private readonly generateId: () => string,
  ) {}

  async append(record: OptimizationDecisionRecord): Promise<DecisionAppendOutcome> {
    // Validate the record BEFORE it can touch the durable authority
    // (total validation includes both digest checks).
    validateOptimizationDecision(record, this.digest);

    return this.db.transaction(async (tx) => {
      const existing = await this.selectForUpdate(tx, record.applicationId, record.decisionId);
      if (existing !== null) {
        return this.convergeAgainstExisting(existing, record);
      }
      // ON CONFLICT DO NOTHING makes the append physically race-safe: if a
      // concurrent appender of the same (application_id, decision_id) wins
      // the unique race, this insert becomes a no-op (0 rows) instead of an
      // error, and the re-read below converges against the winner under the
      // lock — replay (identical content) or typed conflict (drift). Never
      // overwrite, never duplicate, never an unguarded raw error.
      const inserted = await tx.execute<{ id: string }>({
        sql: `INSERT INTO execution_ir.optimization_decision_records
                    (id, application_id, tenant_id, execution_id, decision_id, plan_id, ir_id,
                     plan_revision, selected_candidate_id, quality_threshold,
                     transformation_basis_code, payload, record_digest)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
              ON CONFLICT (application_id, decision_id) DO NOTHING
              RETURNING id`,
        parameters: [
          this.generateId(),
          record.applicationId,
          record.tenantId,
          record.executionId ?? null,
          record.decisionId,
          record.planId,
          record.irId,
          record.provenance.planProvenance.planRevision,
          record.selectedCandidateId,
          record.qualityThreshold,
          record.transformationBasis.code,
          JSON.stringify(record),
          record.recordDigest,
        ],
      });
      if (inserted.rows.length === 0) {
        // A concurrent appender won the identity race: converge against
        // the durable winner (replay or typed conflict).
        const winner = await this.selectForUpdate(tx, record.applicationId, record.decisionId);
        if (winner !== null) {
          return this.convergeAgainstExisting(winner, record);
        }
        // Unreachable while the unique index exists (0 rows returned means
        // a conflicting row won the race); fail closed rather than guess.
        throw new DecisionIdentityConflictError(record.decisionId, record.applicationId);
      }
      return { decisionId: record.decisionId, replayed: false };
    });
  }

  private async selectForUpdate(
    tx: Transaction,
    applicationId: string,
    decisionId: string,
  ): Promise<DecisionRow | null> {
    const existing = await tx.execute<DecisionRow>({
      sql: `SELECT id, application_id, tenant_id, execution_id, decision_id, plan_id, ir_id, record_digest, payload, recorded_at
              FROM execution_ir.optimization_decision_records
             WHERE application_id = $1 AND decision_id = $2
             FOR UPDATE`,
      parameters: [applicationId, decisionId],
    });
    return existing.rows[0] ?? null;
  }

  private convergeAgainstExisting(
    row: DecisionRow,
    record: OptimizationDecisionRecord,
  ): DecisionAppendOutcome {
    if (row.record_digest !== record.recordDigest) {
      // Same decision identity, different content: fail closed —
      // decision rows are never overwritten.
      throw new DecisionIdentityConflictError(record.decisionId, record.applicationId);
    }
    // Idempotent bounded no-op: the identical decision replays.
    return { decisionId: record.decisionId, replayed: true };
  }

  async get(applicationId: string, decisionId: string): Promise<OptimizationDecisionRecord | null> {
    const result = await this.db.execute<DecisionRow>({
      sql: `SELECT id, application_id, tenant_id, execution_id, decision_id, plan_id, ir_id, record_digest, payload, recorded_at
              FROM execution_ir.optimization_decision_records
             WHERE application_id = $1 AND decision_id = $2`,
      parameters: [applicationId, decisionId],
    });
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return this.validateRow(row);
  }

  async listByPlan(
    applicationId: string,
    planId: string,
  ): Promise<readonly OptimizationDecisionRecord[]> {
    const result = await this.db.execute<DecisionRow>({
      sql: `SELECT id, application_id, tenant_id, execution_id, decision_id, plan_id, ir_id, record_digest, payload, recorded_at
              FROM execution_ir.optimization_decision_records
             WHERE application_id = $1 AND plan_id = $2
             ORDER BY recorded_at ASC, decision_id ASC`,
      parameters: [applicationId, planId],
    });
    return result.rows.map((row) => this.validateRow(row));
  }

  async listByExecution(
    applicationId: string,
    executionId: string,
  ): Promise<readonly OptimizationDecisionRecord[]> {
    const result = await this.db.execute<DecisionRow>({
      sql: `SELECT id, application_id, tenant_id, execution_id, decision_id, plan_id, ir_id, record_digest, payload, recorded_at
              FROM execution_ir.optimization_decision_records
             WHERE application_id = $1 AND execution_id = $2
             ORDER BY recorded_at ASC, decision_id ASC`,
      parameters: [applicationId, executionId],
    });
    return result.rows.map((row) => this.validateRow(row));
  }

  /**
   * Validate a durable row on read: the payload must be a fully valid
   * decision record whose digests match the stored columns — tampered
   * or foreign rows are rejected (typed), never served.
   */
  private validateRow(row: DecisionRow): OptimizationDecisionRecord {
    const payload =
      typeof row.payload === "string" ? (JSON.parse(row.payload) as unknown) : row.payload;
    try {
      const record = validateOptimizationDecision(payload, this.digest);
      if (record.decisionId !== row.decision_id || record.recordDigest !== row.record_digest) {
        throw new DecisionValidationError(
          "decision-identity-mismatch",
          "durable row identity columns disagree with the validated payload",
          { decisionId: row.decision_id },
        );
      }
      if (record.applicationId !== row.application_id || record.planId !== row.plan_id) {
        throw new DecisionValidationError(
          "decision-identity-mismatch",
          "durable row scope columns disagree with the validated payload",
          { decisionId: row.decision_id },
        );
      }
      return record;
    } catch (error) {
      if (error instanceof DecisionValidationError) {
        throw error;
      }
      throw new DecisionValidationError(
        "decision-identity-mismatch",
        "durable decision row failed read validation",
        { decisionId: row.decision_id, reason: String(error) },
      );
    }
  }
}
