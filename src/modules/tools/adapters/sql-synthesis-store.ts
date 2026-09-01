/**
 * SQL synthesis store (tools module adapter; WORK-018).
 *
 * The durable implementation of the `SynthesisStore` port over the
 * provider-neutral `DatabasePort` (migration
 * `0011_tool_synthesis.sql`). The physical invariants live in the
 * migration (identity-core immutability, the frozen lifecycle, the
 * one-write evidence discipline, submission idempotency); this
 * adapter maps rows <-> domain records and converges exactly like
 * the WORK-012/017 SQL stores:
 *
 *  - `insert`: UNIQUE (application, idempotency_key) arbitration
 *    surfaces as `IDEMPOTENCY_KEY_REUSED` when the fingerprint
 *    disagrees; the same fingerprint re-reads and converges (replay);
 *  - `transition`: the guarded UPDATE requires the expected `from`
 *    status; a concurrent winner surfaces as
 *    `INVALID_STATE_TRANSITION` (the caller re-reads — first writer
 *    wins, duplicates converge);
 *  - every read is scope-filtered (application + tenant);
 *  - rows are immutable-by-trigger; the adapter has no delete path.
 */

import type { DatabasePort } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type { SynthesizedProgramRecord } from "../domain/synthesis";
import type {
  SynthesisInsertInput,
  SynthesisInsertOutcome,
  SynthesisStore,
  SynthesisTransitionInput,
} from "../ports/synthesis-store";

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
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

interface ProgramRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly tool_id: string;
  readonly version: string;
  readonly language: string;
  readonly source: string;
  readonly source_digest: string;
  readonly contract: SynthesizedProgramRecord["contract"];
  readonly test_cases: SynthesizedProgramRecord["testCases"];
  readonly status: string;
  readonly static_validation: SynthesizedProgramRecord["staticValidation"];
  readonly runtime_tests: SynthesizedProgramRecord["runtimeTests"];
  readonly rejection: SynthesizedProgramRecord["rejection"];
  readonly expires_at: Date | string;
  readonly submitted_by: string;
  readonly idempotency_key: string;
  readonly submission_fingerprint: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

function toProgram(row: ProgramRow): SynthesizedProgramRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    toolId: row.tool_id,
    version: row.version,
    language: row.language as SynthesizedProgramRecord["language"],
    source: row.source,
    sourceDigest: row.source_digest,
    contract: row.contract,
    testCases: row.test_cases,
    status: row.status as SynthesizedProgramRecord["status"],
    staticValidation: row.static_validation,
    runtimeTests: row.runtime_tests,
    rejection: row.rejection,
    expiresAt: iso(row.expires_at) ?? "",
    submittedBy: row.submitted_by,
    submissionIdempotencyKey: row.idempotency_key,
    createdAt: iso(row.created_at) ?? "",
    updatedAt: iso(row.updated_at) ?? "",
  };
}

const PROGRAM_COLUMNS = `id, application_id, tenant_id, tool_id, version, language, source,
    source_digest, contract, test_cases, status, static_validation, runtime_tests, rejection,
    expires_at, submitted_by, idempotency_key, submission_fingerprint, created_at, updated_at`;

export class SqlSynthesisStore implements SynthesisStore {
  constructor(private readonly db: DatabasePort) {}

  async insert(input: SynthesisInsertInput): Promise<SynthesisInsertOutcome> {
    const program = input.program;
    try {
      const inserted = await this.db.execute<ProgramRow>({
        sql: `INSERT INTO tools.synthesized_programs (
    id, application_id, tenant_id, tool_id, version, language, source, source_digest,
    contract, test_cases, status, static_validation, runtime_tests, rejection,
    expires_at, submitted_by, idempotency_key, submission_fingerprint, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, 'draft', NULL, NULL, NULL,
    $11, $12, $13, $14, $15, $15)
RETURNING ${PROGRAM_COLUMNS}`,
        parameters: [
          program.id,
          program.applicationId,
          program.tenantId,
          program.toolId,
          program.version,
          program.language,
          program.source,
          program.sourceDigest,
          JSON.stringify(program.contract),
          JSON.stringify(program.testCases),
          program.expiresAt,
          program.submittedBy,
          program.submissionIdempotencyKey,
          input.submissionFingerprint,
          program.createdAt,
        ],
      });
      const row = inserted.rows[0];
      if (row !== undefined) {
        return { status: "inserted", program: toProgram(row) };
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Arbitration: converge on the committed row when the fingerprint
        // matches; fail closed when it does not.
        const existing = await this.findByKeyRow(
          program.applicationId,
          program.submissionIdempotencyKey,
        );
        if (existing === null) {
          throw new PlatformError({
            code: "TOOL_ERROR",
            message:
              "synthesized-program insert arbitration failed but the committed row is unreadable",
          });
        }
        if (existing.submission_fingerprint !== input.submissionFingerprint) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "idempotency key was already used with a different submission fingerprint",
            details: { programId: existing.id },
          });
        }
        return { status: "converged", program: toProgram(existing) };
      }
      throw error;
    }
    throw new PlatformError({
      code: "TOOL_ERROR",
      message: "synthesized-program insert returned no row",
    });
  }

  async transition(input: SynthesisTransitionInput): Promise<SynthesizedProgramRecord> {
    const evidence = {
      staticValidation:
        input.staticValidation === undefined ? undefined : JSON.stringify(input.staticValidation),
      runtimeTests:
        input.runtimeTests === undefined ? undefined : JSON.stringify(input.runtimeTests),
      rejection: input.rejection === undefined ? undefined : JSON.stringify(input.rejection),
    };
    const updated = await this.db.execute<ProgramRow>({
      sql: `UPDATE tools.synthesized_programs
SET status = $1,
    static_validation = COALESCE($2::jsonb, static_validation),
    runtime_tests = COALESCE($3::jsonb, runtime_tests),
    rejection = COALESCE($4::jsonb, rejection),
    updated_at = $5
WHERE application_id = $6 AND id = $7 AND status = $8
RETURNING ${PROGRAM_COLUMNS}`,
      parameters: [
        input.to,
        evidence.staticValidation ?? null,
        evidence.runtimeTests ?? null,
        evidence.rejection ?? null,
        new Date().toISOString(),
        input.applicationId,
        input.programId,
        input.from,
      ],
    });
    const row = updated.rows[0];
    if (row !== undefined) {
      return toProgram(row);
    }
    // First writer already advanced (or the expected state disagrees):
    // converge on the committed row — the caller re-reads the truth.
    const existing = await this.get(input.applicationId, input.programId);
    if (existing === null) {
      throw new PlatformError({
        code: "TOOL_ERROR",
        message: `synthesized program ${input.programId} not found`,
      });
    }
    if (existing.status === input.to) {
      return existing;
    }
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `program ${existing.toolId} is ${existing.status}; the guarded transition expected ${input.from} (replay converges on the committed state)`,
    });
  }

  async get(applicationId: string, programId: string): Promise<SynthesizedProgramRecord | null> {
    const result = await this.db.execute<ProgramRow>({
      sql: `SELECT ${PROGRAM_COLUMNS} FROM tools.synthesized_programs
WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, programId],
    });
    const row = result.rows[0];
    return row === undefined ? null : toProgram(row);
  }

  async listByApplication(applicationId: string): Promise<readonly SynthesizedProgramRecord[]> {
    const result = await this.db.execute<ProgramRow>({
      sql: `SELECT ${PROGRAM_COLUMNS} FROM tools.synthesized_programs
WHERE application_id = $1 ORDER BY created_at, id`,
      parameters: [applicationId],
    });
    return result.rows.map(toProgram);
  }

  async listUsable(
    applicationId: string,
    asOf: Date,
  ): Promise<readonly SynthesizedProgramRecord[]> {
    const result = await this.db.execute<ProgramRow>({
      sql: `SELECT ${PROGRAM_COLUMNS} FROM tools.synthesized_programs
WHERE application_id = $1 AND status = 'usable' AND expires_at > $2
ORDER BY created_at, id`,
      parameters: [applicationId, asOf.toISOString()],
    });
    return result.rows.map(toProgram);
  }

  private async findByKeyRow(
    applicationId: string,
    idempotencyKey: string,
  ): Promise<ProgramRow | null> {
    const result = await this.db.execute<ProgramRow>({
      sql: `SELECT ${PROGRAM_COLUMNS} FROM tools.synthesized_programs
WHERE application_id = $1 AND idempotency_key = $2`,
      parameters: [applicationId, idempotencyKey],
    });
    const row = result.rows[0];
    return row === undefined ? null : row;
  }
}
