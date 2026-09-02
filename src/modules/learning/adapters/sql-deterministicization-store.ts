/**
 * SQL deterministicization store (learning module adapter; WORK-021).
 *
 * The durable implementation of the `DeterministicizationStore` port
 * over the provider-neutral `DatabasePort` (migration
 * `0019_deterministicization_lifecycle.sql`, reading the shared
 * population of migration 0009).
 *
 * The physical invariants live in the migration; this adapter maps
 * rows <-> domain records and converges idempotent operations exactly
 * like the WORK-014/017/020 SQL learning stores + the WORK-024
 * operations-ledger discipline:
 *
 *  - `insertCandidate`: the content-derived PRIMARY KEY converges
 *    retried proposals (replay);
 *  - `transitionCandidateStatus`: the guarded single-row update with
 *    the expected-status arbitration — first writer wins, duplicates
 *    converge on the committed row; trigger guard violations map to
 *    `INVALID_STATE_TRANSITION`;
 *  - `insertStageEvidence`: the evidence_id PRIMARY KEY converges
 *    retried requests; a DIFFERENT record for a settled (candidate,
 *    stage) slot surfaces as `IDEMPOTENCY_KEY_REUSED` (the unique
 *    stage-slot constraint) — a different basis is a different
 *    candidate, never a rewrite;
 *  - `insertRollout` / `concludeRollout`: the (candidate, mode) slot
 *    constraint converges retries; the guarded observing → concluded
 *    update writes the measurable deltas (first writer wins);
 *  - `appendDecision`: the decision_id PRIMARY KEY converges retried
 *    decisions (journal append);
 *  - the operations ledger: `beginOperation` converges on the physical
 *    UNIQUE (application, operation_key) with `ON CONFLICT DO
 *    NOTHING`, bumps `attempts` on PENDING re-claims and replays
 *    terminal rows without a bump; `completeOperation` /
 *    `failOperation` are the guarded PENDING → terminal moves with
 *    idempotent convergence; `recordOperationCheckpoint` is writable
 *    only while PENDING (a terminal row converges on the committed
 *    record);
 *  - every read is scope-filtered (application + tenant) —
 *    cross-tenant/cross-application rows are unreachable;
 *  - rows are immutable by trigger; the adapter has no update path
 *    beyond the guarded status moves.
 */

import type { DatabasePort } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type {
  DeterministicizationCandidate,
  DeterministicizationCandidateStatus,
  PromotionDecisionRecord,
  RolloutRecord,
  StageEvidenceRecord,
} from "../domain/deterministicization";
import type { ExecutionOutcomeTelemetry } from "../domain/telemetry";
import type {
  CandidateInsertOutcome,
  CandidateTransitionOutcome,
  DecisionAppendOutcome,
  DeterministicizationOperationRecord,
  DeterministicizationScope,
  DeterministicizationStore,
  OperationBeginInput,
  OperationBeginOutcome,
  RolloutConclusionInput,
  RolloutInsertOutcome,
  StageEvidenceInsertOutcome,
} from "../ports/deterministicization-store";
import { TELEMETRY_COLUMNS, type TelemetryRow, toTelemetry } from "./sql-learning-store";

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Map migration-trigger guard violations to the typed taxonomy. */
function toTypedGuardError(error: unknown): PlatformError {
  const message = messageOf(error);
  if (message.includes("cannot move from status") || message.includes("terminal-immutable")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "deterministicization-lifecycle" },
    });
  }
  if (message.includes("identity core is immutable")) {
    return new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message,
      details: { guard: "deterministicization-core" },
    });
  }
  if (
    message.includes("FK") ||
    message.includes("foreign key") ||
    message.includes("violates foreign key constraint")
  ) {
    return new PlatformError({
      code: "TENANT_SCOPE_VIOLATION",
      message,
      details: { guard: "scope-binding" },
    });
  }
  return new PlatformError({ code: "PROVIDER_ERROR", message, cause: error });
}

interface CandidateRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly candidate_class: string;
  readonly status: string;
  readonly subgraph: DeterministicizationCandidate["subgraph"];
  readonly provenance: DeterministicizationCandidate["provenance"];
  readonly recurrence: DeterministicizationCandidate["recurrence"];
  readonly incumbent: DeterministicizationCandidate["incumbent"];
  readonly contract: DeterministicizationCandidate["contract"];
  readonly program_source: string | null;
  readonly program_digest: string | null;
  readonly program_language: string | null;
  readonly proposed_by: string;
  readonly proposed_at: Date | string;
}

function toCandidate(row: CandidateRow): DeterministicizationCandidate {
  return {
    candidateId: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    candidateClass: row.candidate_class as DeterministicizationCandidate["candidateClass"],
    status: row.status as DeterministicizationCandidateStatus,
    subgraph: row.subgraph,
    provenance: row.provenance,
    recurrence: row.recurrence,
    incumbent: row.incumbent,
    contract: row.contract,
    program:
      row.program_source === null || row.program_digest === null
        ? null
        : {
            language: "javascript-v1",
            source: row.program_source,
            sourceDigest: row.program_digest,
          },
    proposedBy: row.proposed_by,
    proposedAt: iso(row.proposed_at),
    schemaVersion: 1,
  };
}

const CANDIDATE_COLUMNS = `id, application_id, tenant_id, candidate_class, status, subgraph,
    provenance, recurrence, incumbent, contract, program_source, program_digest,
    program_language, proposed_by, proposed_at`;

interface EvidenceRow {
  readonly evidence_id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly candidate_id: string;
  readonly stage_kind: string;
  readonly status: string;
  readonly basis: StageEvidenceRecord["basis"];
  readonly runs: StageEvidenceRecord["runs"];
  readonly pairs: StageEvidenceRecord["pairs"];
  readonly metrics: StageEvidenceRecord["metrics"];
  readonly criterion_digest: string;
  readonly evidence_refs: string[];
  readonly recorded_at: Date | string;
  readonly recorded_by: string;
  readonly schema_version: number;
}

function toEvidence(row: EvidenceRow): StageEvidenceRecord {
  return {
    evidenceId: row.evidence_id,
    candidateId: row.candidate_id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    stageKind: row.stage_kind as StageEvidenceRecord["stageKind"],
    status: row.status as StageEvidenceRecord["status"],
    basis: row.basis,
    runs: row.runs ?? [],
    pairs: row.pairs ?? [],
    metrics: row.metrics,
    criterionDigest: row.criterion_digest,
    evidenceRefs: row.evidence_refs ?? [],
    recordedAt: iso(row.recorded_at),
    recordedBy: row.recorded_by,
    schemaVersion: row.schema_version,
  };
}

const EVIDENCE_COLUMNS = `evidence_id, application_id, tenant_id, candidate_id, stage_kind, status,
    basis, runs, pairs, metrics, criterion_digest, evidence_refs, recorded_at, recorded_by,
    schema_version`;

interface RolloutRow {
  readonly rollout_id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly candidate_id: string;
  readonly mode: string;
  readonly status: string;
  readonly population: number;
  readonly matched_count: number;
  readonly cost_delta_micro_usd: string;
  readonly quality_delta: number;
  readonly latency_delta_ms: number;
  readonly evidence_refs: string[];
  readonly began_at: Date | string;
  readonly concluded_at: Date | string | null;
}

function toRollout(row: RolloutRow): RolloutRecord {
  return {
    rolloutId: row.rollout_id,
    candidateId: row.candidate_id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    mode: row.mode as RolloutRecord["mode"],
    status: row.status as RolloutRecord["status"],
    population: row.population,
    matchedCount: row.matched_count,
    costDeltaMicroUsd: row.cost_delta_micro_usd,
    qualityDelta: row.quality_delta,
    latencyDeltaMs: row.latency_delta_ms,
    evidenceRefs: row.evidence_refs ?? [],
    beganAt: iso(row.began_at),
    concludedAt: row.concluded_at === null ? null : iso(row.concluded_at),
    schemaVersion: 1,
  };
}

const ROLLOUT_COLUMNS = `rollout_id, application_id, tenant_id, candidate_id, mode, status,
    population, matched_count, cost_delta_micro_usd, quality_delta, latency_delta_ms,
    evidence_refs, began_at, concluded_at`;

interface DecisionRow {
  readonly decision_id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly candidate_id: string;
  readonly decision_kind: string;
  readonly rationale: string;
  readonly gate: PromotionDecisionRecord["gate"];
  readonly incumbent_restored_to: string | null;
  readonly decided_by: string;
  readonly decided_at: Date | string;
}

function toDecision(row: DecisionRow): PromotionDecisionRecord {
  return {
    decisionId: row.decision_id,
    candidateId: row.candidate_id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    kind: row.decision_kind as PromotionDecisionRecord["kind"],
    rationale: row.rationale,
    gate: row.gate,
    incumbentRestoredTo: row.incumbent_restored_to,
    decidedBy: row.decided_by,
    decidedAt: iso(row.decided_at),
    schemaVersion: 1,
  };
}

const DECISION_COLUMNS = `decision_id, application_id, tenant_id, candidate_id, decision_kind,
    rationale, gate, incumbent_restored_to, decided_by, decided_at`;

interface OperationRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly candidate_id: string | null;
  readonly operation_kind: string;
  readonly operation_key: string;
  readonly status: string;
  readonly attempts: number;
  readonly checkpoint: Record<string, unknown> | null;
  readonly failure_reason: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly completed_at: Date | string | null;
}

function toOperation(row: OperationRow): DeterministicizationOperationRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    candidateId: row.candidate_id,
    operationKind: row.operation_kind as DeterministicizationOperationRecord["operationKind"],
    operationKey: row.operation_key,
    status: row.status as DeterministicizationOperationRecord["status"],
    attempts: row.attempts,
    checkpoint: row.checkpoint,
    failureReason: row.failure_reason,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: row.completed_at === null ? null : iso(row.completed_at),
  };
}

const OPERATION_COLUMNS = `id, application_id, tenant_id, candidate_id, operation_kind, operation_key,
    status, attempts, checkpoint, failure_reason, created_at, updated_at, completed_at`;

export class SqlDeterministicizationStore implements DeterministicizationStore {
  constructor(private readonly db: DatabasePort) {}

  async listTelemetry(query: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly recordedFrom: string | null;
    readonly recordedTo: string;
  }): Promise<readonly ExecutionOutcomeTelemetry[]> {
    const result = await this.db.execute<TelemetryRow>({
      sql: `SELECT ${TELEMETRY_COLUMNS}
            FROM learning.execution_telemetry
            WHERE application_id = $1 AND tenant_id = $2
              AND ($3::timestamptz IS NULL OR recorded_at >= $3::timestamptz)
              AND recorded_at <= $4::timestamptz
            ORDER BY recorded_at ASC, id ASC`,
      parameters: [query.applicationId, query.tenantId, query.recordedFrom, query.recordedTo],
    });
    return result.rows.map(toTelemetry);
  }

  async insertCandidate(
    candidate: DeterministicizationCandidate,
  ): Promise<CandidateInsertOutcome> {
    try {
      const inserted = await this.db.execute<{ readonly id: string }>({
        sql: `INSERT INTO learning.deterministicization_candidates
              (id, application_id, tenant_id, candidate_class, status, subgraph, provenance,
               recurrence, incumbent, contract, program_source, program_digest, program_language,
               proposed_by, proposed_at, created_at, updated_at, schema_version)
              VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb,
                      $11, $12, $13, $14, $15, $15, $15, $16)
              ON CONFLICT (id) DO NOTHING
              RETURNING id`,
        parameters: [
          candidate.candidateId,
          candidate.applicationId,
          candidate.tenantId,
          candidate.candidateClass,
          candidate.status,
          JSON.stringify(candidate.subgraph),
          JSON.stringify(candidate.provenance),
          JSON.stringify(candidate.recurrence),
          JSON.stringify(candidate.incumbent),
          JSON.stringify(candidate.contract),
          candidate.program === null ? null : candidate.program.source,
          candidate.program === null ? null : candidate.program.sourceDigest,
          candidate.program === null ? null : candidate.program.language,
          candidate.proposedBy,
          candidate.proposedAt,
          candidate.schemaVersion,
        ],
      });
      if (inserted.rows.length > 0) {
        return { candidateId: candidate.candidateId, replayed: false };
      }
      return { candidateId: candidate.candidateId, replayed: true };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { candidateId: candidate.candidateId, replayed: true };
      }
      throw toTypedGuardError(error);
    }
  }

  async getCandidate(
    scope: DeterministicizationScope,
    candidateId: string,
  ): Promise<DeterministicizationCandidate | null> {
    const result = await this.db.execute<CandidateRow>({
      sql: `SELECT ${CANDIDATE_COLUMNS}
            FROM learning.deterministicization_candidates
            WHERE application_id = $1 AND tenant_id = $2 AND id = $3`,
      parameters: [scope.applicationId, scope.tenantId, candidateId],
    });
    const row = result.rows[0];
    return row === undefined ? null : toCandidate(row);
  }

  async listCandidates(
    scope: DeterministicizationScope,
  ): Promise<readonly DeterministicizationCandidate[]> {
    const result = await this.db.execute<CandidateRow>({
      sql: `SELECT ${CANDIDATE_COLUMNS}
            FROM learning.deterministicization_candidates
            WHERE application_id = $1 AND tenant_id = $2
            ORDER BY proposed_at ASC, id ASC`,
      parameters: [scope.applicationId, scope.tenantId],
    });
    return result.rows.map(toCandidate);
  }

  async transitionCandidateStatus(input: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly candidateId: string;
    readonly expectedStatus: DeterministicizationCandidateStatus | null;
    readonly toStatus: DeterministicizationCandidateStatus;
    readonly updatedAt: string;
  }): Promise<CandidateTransitionOutcome> {
    try {
      const updated = await this.db.execute<CandidateRow>({
        sql: `UPDATE learning.deterministicization_candidates
              SET status = $4, updated_at = $5
              WHERE application_id = $1 AND tenant_id = $2 AND id = $3
                AND (status = $4 OR ($6::text IS NOT NULL AND status = $6))
              RETURNING ${CANDIDATE_COLUMNS}`,
        parameters: [
          input.applicationId,
          input.tenantId,
          input.candidateId,
          input.toStatus,
          input.updatedAt,
          input.expectedStatus,
        ],
      });
      const row = updated.rows[0];
      if (row !== undefined) {
        return {
          status: row.status === input.toStatus ? "applied" : "converged",
          candidate: toCandidate(row),
        };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    // No row matched the guard: either the row does not exist or a
    // concurrent writer moved it first — converge by re-reading.
    const existing = await this.getCandidate(
      { applicationId: input.applicationId, tenantId: input.tenantId },
      input.candidateId,
    );
    if (existing === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "deterministicization candidate not found within the application scope",
        details: { candidateId: input.candidateId },
      });
    }
    if (existing.status === input.toStatus) {
      return { status: "converged", candidate: existing };
    }
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `deterministicization candidate status moved concurrently to '${existing.status}' (first writer wins — converge on the committed row)`,
      details: { candidateId: input.candidateId, committed: existing.status },
    });
  }

  async insertStageEvidence(
    evidence: StageEvidenceRecord,
  ): Promise<StageEvidenceInsertOutcome> {
    try {
      const inserted = await this.db.execute<{ readonly evidence_id: string }>({
        sql: `INSERT INTO learning.deterministicization_stage_evidence
              (evidence_id, application_id, tenant_id, candidate_id, stage_kind, status, basis,
               runs, pairs, metrics, criterion_digest, evidence_refs, recorded_at, recorded_by,
               schema_version)
              VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11,
                      $12::jsonb, $13, $14, $15)
              ON CONFLICT (evidence_id) DO NOTHING
              RETURNING evidence_id`,
        parameters: [
          evidence.evidenceId,
          evidence.applicationId,
          evidence.tenantId,
          evidence.candidateId,
          evidence.stageKind,
          evidence.status,
          JSON.stringify(evidence.basis),
          JSON.stringify([...evidence.runs]),
          JSON.stringify([...evidence.pairs]),
          JSON.stringify(evidence.metrics),
          evidence.criterionDigest,
          JSON.stringify([...evidence.evidenceRefs]),
          evidence.recordedAt,
          evidence.recordedBy,
          evidence.schemaVersion,
        ],
      });
      if (inserted.rows.length > 0) {
        return { evidenceId: evidence.evidenceId, replayed: false };
      }
      return { evidenceId: evidence.evidenceId, replayed: true };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const constraint = messageOf(error);
        if (constraint.includes("dtr_evidence_stage_slot_unique")) {
          // A settled stage claimed by a different record: a different
          // basis is a different candidate, never a rewrite.
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message:
              "the validation stage is already settled for this candidate (a different basis is a different candidate, never a rewrite)",
            details: { candidateId: evidence.candidateId, stageKind: evidence.stageKind },
            cause: error,
          });
        }
        // The evidence_id conflict: a concurrent identical submission
        // landed first — converge (replay).
        return { evidenceId: evidence.evidenceId, replayed: true };
      }
      throw toTypedGuardError(error);
    }
  }

  async listStageEvidence(
    scope: DeterministicizationScope,
    candidateId: string,
  ): Promise<readonly StageEvidenceRecord[]> {
    const result = await this.db.execute<EvidenceRow>({
      sql: `SELECT ${EVIDENCE_COLUMNS}
            FROM learning.deterministicization_stage_evidence
            WHERE application_id = $1 AND tenant_id = $2 AND candidate_id = $3
            ORDER BY recorded_at ASC, evidence_id ASC`,
      parameters: [scope.applicationId, scope.tenantId, candidateId],
    });
    return result.rows.map(toEvidence);
  }

  async insertRollout(rollout: RolloutRecord): Promise<RolloutInsertOutcome> {
    try {
      const inserted = await this.db.execute<{ readonly rollout_id: string }>({
        sql: `INSERT INTO learning.deterministicization_rollouts
              (rollout_id, application_id, tenant_id, candidate_id, mode, status, population,
               matched_count, cost_delta_micro_usd, quality_delta, latency_delta_ms,
               evidence_refs, began_at, concluded_at, schema_version)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15)
              ON CONFLICT (rollout_id) DO NOTHING
              RETURNING rollout_id`,
        parameters: [
          rollout.rolloutId,
          rollout.applicationId,
          rollout.tenantId,
          rollout.candidateId,
          rollout.mode,
          rollout.status,
          rollout.population,
          rollout.matchedCount,
          rollout.costDeltaMicroUsd,
          rollout.qualityDelta,
          rollout.latencyDeltaMs,
          JSON.stringify([...rollout.evidenceRefs]),
          rollout.beganAt,
          rollout.concludedAt,
          rollout.schemaVersion,
        ],
      });
      if (inserted.rows.length > 0) {
        return { rolloutId: rollout.rolloutId, replayed: false };
      }
      return { rolloutId: rollout.rolloutId, replayed: true };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const constraint = messageOf(error);
        if (constraint.includes("dtr_rollouts_mode_slot_unique")) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: `the ${rollout.mode} rollout phase is already recorded for this candidate`,
            details: { candidateId: rollout.candidateId, mode: rollout.mode },
            cause: error,
          });
        }
        return { rolloutId: rollout.rolloutId, replayed: true };
      }
      throw toTypedGuardError(error);
    }
  }

  async getRollout(
    scope: DeterministicizationScope,
    rolloutId: string,
  ): Promise<RolloutRecord | null> {
    const result = await this.db.execute<RolloutRow>({
      sql: `SELECT ${ROLLOUT_COLUMNS}
            FROM learning.deterministicization_rollouts
            WHERE application_id = $1 AND tenant_id = $2 AND rollout_id = $3`,
      parameters: [scope.applicationId, scope.tenantId, rolloutId],
    });
    const row = result.rows[0];
    return row === undefined ? null : toRollout(row);
  }

  async listRollouts(
    scope: DeterministicizationScope,
    candidateId: string,
  ): Promise<readonly RolloutRecord[]> {
    const result = await this.db.execute<RolloutRow>({
      sql: `SELECT ${ROLLOUT_COLUMNS}
            FROM learning.deterministicization_rollouts
            WHERE application_id = $1 AND tenant_id = $2 AND candidate_id = $3
            ORDER BY began_at ASC, rollout_id ASC`,
      parameters: [scope.applicationId, scope.tenantId, candidateId],
    });
    return result.rows.map(toRollout);
  }

  async concludeRollout(input: RolloutConclusionInput): Promise<RolloutRecord> {
    try {
      const updated = await this.db.execute<RolloutRow>({
        sql: `UPDATE learning.deterministicization_rollouts
              SET status = 'concluded', population = $4, matched_count = $5,
                  cost_delta_micro_usd = $6, quality_delta = $7, latency_delta_ms = $8,
                  evidence_refs = $9::jsonb, concluded_at = $10
              WHERE application_id = $1 AND tenant_id = $2 AND rollout_id = $3
                AND status = 'observing'
              RETURNING ${ROLLOUT_COLUMNS}`,
        parameters: [
          input.applicationId,
          input.tenantId,
          input.rolloutId,
          input.population,
          input.matchedCount,
          input.costDeltaMicroUsd,
          input.qualityDelta,
          input.latencyDeltaMs,
          JSON.stringify([...input.evidenceRefs]),
          input.concludedAt,
        ],
      });
      const row = updated.rows[0];
      if (row !== undefined) {
        return toRollout(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    // No row matched: the rollout does not exist or is already
    // concluded — converge on the committed row.
    const existing = await this.getRollout(
      { applicationId: input.applicationId, tenantId: input.tenantId },
      input.rolloutId,
    );
    if (existing === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "rollout not found within the application scope",
        details: { rolloutId: input.rolloutId },
      });
    }
    return existing;
  }

  async appendDecision(
    decision: PromotionDecisionRecord,
  ): Promise<DecisionAppendOutcome> {
    try {
      const inserted = await this.db.execute<{ readonly decision_id: string }>({
        sql: `INSERT INTO learning.deterministicization_decisions
              (decision_id, application_id, tenant_id, candidate_id, decision_kind, rationale,
               gate, incumbent_restored_to, decided_by, decided_at, schema_version)
              VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
              ON CONFLICT (decision_id) DO NOTHING
              RETURNING decision_id`,
        parameters: [
          decision.decisionId,
          decision.applicationId,
          decision.tenantId,
          decision.candidateId,
          decision.kind,
          decision.rationale,
          JSON.stringify(decision.gate),
          decision.incumbentRestoredTo,
          decision.decidedBy,
          decision.decidedAt,
          decision.schemaVersion,
        ],
      });
      if (inserted.rows.length > 0) {
        return { decisionId: decision.decisionId, replayed: false };
      }
      return { decisionId: decision.decisionId, replayed: true };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { decisionId: decision.decisionId, replayed: true };
      }
      throw toTypedGuardError(error);
    }
  }

  async listDecisions(
    scope: DeterministicizationScope,
    candidateId: string,
  ): Promise<readonly PromotionDecisionRecord[]> {
    const result = await this.db.execute<DecisionRow>({
      sql: `SELECT ${DECISION_COLUMNS}
            FROM learning.deterministicization_decisions
            WHERE application_id = $1 AND tenant_id = $2 AND candidate_id = $3
            ORDER BY decided_at ASC, decision_id ASC`,
      parameters: [scope.applicationId, scope.tenantId, candidateId],
    });
    return result.rows.map(toDecision);
  }

  // -- the durable, recoverable operation state --------------------------

  async beginOperation(input: OperationBeginInput): Promise<OperationBeginOutcome> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `INSERT INTO learning.deterministicization_operations
              (${OPERATION_COLUMNS})
              VALUES ($1, $2, $3, $4, $5, $6, 'pending', 1, NULL, NULL, $7, $7, NULL)
              ON CONFLICT (application_id, operation_key) DO NOTHING
              RETURNING ${OPERATION_COLUMNS}`,
        parameters: [
          input.operationId,
          input.applicationId,
          input.tenantId,
          input.candidateId,
          input.operationKind,
          input.operationKey,
          input.createdAt,
        ],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return { status: "begun", record: toOperation(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    // The conflict path: the operation row already exists — bump the
    // attempts ledger (PENDING rows only; a terminal row replays
    // without a bump).
    const existing = await this.findOperation(input.applicationId, input.operationKey);
    if (existing === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "deterministicization operation begin returned no row",
        details: { operationKey: input.operationKey },
      });
    }
    if (existing.status !== "pending") {
      return { status: "existing", record: existing };
    }
    try {
      const bumped = await this.db.execute<OperationRow>({
        sql: `UPDATE learning.deterministicization_operations
              SET attempts = attempts + 1, updated_at = $3
              WHERE application_id = $1 AND operation_key = $2 AND status = 'pending'
              RETURNING ${OPERATION_COLUMNS}`,
        parameters: [input.applicationId, input.operationKey, input.createdAt],
      });
      const row = bumped.rows[0];
      if (row !== undefined) {
        return { status: "existing", record: toOperation(row) };
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    // A concurrent terminal move won the race: replay the committed row.
    const committed = await this.findOperation(input.applicationId, input.operationKey);
    if (committed === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "deterministicization operation row disappeared after begin",
        details: { operationKey: input.operationKey },
      });
    }
    return { status: "existing", record: committed };
  }

  async recordOperationCheckpoint(
    applicationId: string,
    operationKey: string,
    checkpoint: Record<string, unknown>,
    updatedAt: string,
  ): Promise<DeterministicizationOperationRecord> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `UPDATE learning.deterministicization_operations
              SET checkpoint = $3::jsonb, updated_at = $4
              WHERE application_id = $1 AND operation_key = $2 AND status = 'pending'
              RETURNING ${OPERATION_COLUMNS}`,
        parameters: [applicationId, operationKey, JSON.stringify(checkpoint), updatedAt],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return toOperation(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const existing = await this.requireOperation(applicationId, operationKey);
    // Race-tolerant convergence: a terminal row keeps its committed
    // outcome — the duplicate checkpoint converges on it.
    return existing;
  }

  async completeOperation(
    applicationId: string,
    operationKey: string,
    completedAt: string,
  ): Promise<DeterministicizationOperationRecord> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `UPDATE learning.deterministicization_operations
              SET status = 'completed', completed_at = $3, updated_at = $3
              WHERE application_id = $1 AND operation_key = $2 AND status = 'pending'
              RETURNING ${OPERATION_COLUMNS}`,
        parameters: [applicationId, operationKey, completedAt],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return toOperation(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const existing = await this.requireOperation(applicationId, operationKey);
    if (existing.status === "completed") {
      // Idempotent convergence: the durable outcome already exists.
      return existing;
    }
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `deterministicization operation ${operationKey} is ${existing.status}; a failed operation cannot be completed`,
      details: { failureReason: existing.failureReason },
    });
  }

  async failOperation(
    applicationId: string,
    operationKey: string,
    reason: string,
    failedAt: string,
  ): Promise<DeterministicizationOperationRecord> {
    try {
      const result = await this.db.execute<OperationRow>({
        sql: `UPDATE learning.deterministicization_operations
              SET status = 'failed', failure_reason = $3, updated_at = $4
              WHERE application_id = $1 AND operation_key = $2 AND status = 'pending'
              RETURNING ${OPERATION_COLUMNS}`,
        parameters: [applicationId, operationKey, reason.slice(0, 512), failedAt],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return toOperation(row);
      }
    } catch (error) {
      throw toTypedGuardError(error);
    }
    const existing = await this.requireOperation(applicationId, operationKey);
    if (existing.status === "failed") {
      // Idempotent convergence: the recorded failure already exists.
      return existing;
    }
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `deterministicization operation ${operationKey} is ${existing.status}; a completed operation cannot be failed`,
      details: { completedAt: existing.completedAt },
    });
  }

  async findOperation(
    applicationId: string,
    operationKey: string,
  ): Promise<DeterministicizationOperationRecord | null> {
    const result = await this.db.execute<OperationRow>({
      sql: `SELECT ${OPERATION_COLUMNS}
            FROM learning.deterministicization_operations
            WHERE application_id = $1 AND operation_key = $2`,
      parameters: [applicationId, operationKey],
    });
    const row = result.rows[0];
    return row === undefined ? null : toOperation(row);
  }

  private async requireOperation(
    applicationId: string,
    operationKey: string,
  ): Promise<DeterministicizationOperationRecord> {
    const existing = await this.findOperation(applicationId, operationKey);
    if (existing === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "deterministicization operation not found within the application scope",
        details: { operationKey },
      });
    }
    return existing;
  }
}
