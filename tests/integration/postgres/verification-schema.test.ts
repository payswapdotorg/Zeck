/**
 * Real-PostgreSQL: verification schema physical invariants (WORK-013;
 * migration 0007; the storage half of VERIFICATION-SEPARATION and
 * IDENTITY-IDEMPOTENCY).
 *
 * Proves the storage boundary itself rejects:
 *   * provider-axis and tool-axis outcome classes in result statuses —
 *     "classify a provider/tool success as verification PASS" is
 *     unrepresentable (CHECK) (M1/M3);
 *   * PASS without evidence / without criteria binding (M4/M21);
 *   * results without evaluator identity+version (M20) or detached from
 *     their evaluation journal (M24);
 *   * result mutation after recording (M23 — append-only trigger);
 *   * the second execution state machine (M14): the evaluation journal
 *     only knows the evaluator-job vocabulary (denied|evaluating|
 *     concluded), terminal journal rows are immutable, and the only
 *     legal UPDATE is the exactly-once finalization;
 *   * human evaluation answer shape (all-or-none + decided_by mandatory,
 *     M19) and the exactly-once answer binding;
 *   * comparisons with a forced winner under INCONCLUSIVE (M16/M22) and
 *     without planner authorization (M16);
 *   * cross-tenant / cross-execution evidence rows (M9/M10 — composite
 *     FKs) and duplicate request keys (unique idempotency anchors).
 */

import { expect, test } from "vitest";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { definePgSuite } from "./harness";
import { seedVerificationWorld, type VerificationPgWorld } from "./verification-world";

const generateId = createUuidv7Generator();

definePgSuite("verification schema constraints (real PG)", (ctx) => {
  interface Seeded {
    readonly world: VerificationPgWorld;
    readonly executionId: string;
    readonly evaluationId: string;
  }

  async function seed(): Promise<Seeded> {
    const world = await seedVerificationWorld(ctx.port);
    const executionId = await world.seedExecution();
    const evaluationId = generateId();
    await ctx.port.execute({
      sql: `INSERT INTO verification.evaluations
            (id, application_id, tenant_id, execution_id, evaluation_key, request_fingerprint,
             target_kind, target_ref, status, criteria_set)
            VALUES ($1, $2, $3, $4::uuid, $5, 'fp-1', 'execution-output', $4::text, 'evaluating', $6::jsonb)`,
      parameters: [
        evaluationId,
        world.applicationId,
        world.tenantId,
        executionId,
        `key-${evaluationId.slice(-8)}`,
        JSON.stringify([{ criterionId: "c", version: 1 }]),
      ],
    });
    return { world, executionId, evaluationId };
  }

  function resultRow(seeded: Seeded, overrides: Record<string, unknown>) {
    return {
      id: generateId(),
      application_id: seeded.world.applicationId,
      tenant_id: seeded.world.tenantId,
      execution_id: seeded.executionId,
      evaluation_id: seeded.evaluationId,
      target_kind: "execution-output",
      target_ref: seeded.executionId,
      criterion_id: "c",
      criteria_version: 1,
      evaluator_kind: "deterministic",
      evaluator_id: "invariant-evaluator",
      evaluator_version: "1",
      status: "PASS",
      observations: "[]" as const,
      evidence: '["artifact:a"]' as const,
      recorded_by: "deterministic:invariant-evaluator@1",
      ...overrides,
    };
  }

  async function insertResult(seeded: Seeded, overrides: Record<string, unknown>): Promise<void> {
    const base = resultRow(seeded, overrides);
    await ctx.port.execute({
      sql: `INSERT INTO verification.results
            (id, application_id, tenant_id, execution_id, evaluation_id, target_kind, target_ref,
             criterion_id, criteria_version, evaluator_kind, evaluator_id, evaluator_version,
             status, observations, evidence, recorded_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16)`,
      parameters: [
        base.id,
        base.application_id,
        base.tenant_id,
        base.execution_id,
        base.evaluation_id,
        base.target_kind,
        base.target_ref,
        base.criterion_id,
        base.criteria_version,
        base.evaluator_kind,
        base.evaluator_id,
        base.evaluator_version,
        base.status,
        base.observations,
        base.evidence,
        base.recorded_by,
      ],
    });
  }

  async function expectInsertFailure(
    seeded: Seeded,
    overrides: Record<string, unknown>,
    ...fragments: string[]
  ): Promise<void> {
    // PostgreSQL may fire an equivalent rejecting constraint first; any
    // of the listed fragments proves the boundary rejects the row.
    let message = "";
    try {
      await insertResult(seeded, overrides);
    } catch (error) {
      message = (error as { message: string }).message;
    }
    expect(message, `expected the insert to be rejected: ${message}`).not.toBe("");
    expect(
      fragments.some((fragment) => message.includes(fragment)),
      `unexpected rejecting constraint: ${message}`,
    ).toBe(true);
  }

  test("the result status vocabulary is the verification axis only (M1/M3)", async () => {
    const seeded = await seed();
    await expectInsertFailure(seeded, { status: "provider-success" }, "results_status_vocabulary");
    await expectInsertFailure(seeded, { status: "tool-success" }, "results_status_vocabulary");
    await expectInsertFailure(seeded, { status: "SUCCEEDED" }, "results_status_vocabulary");
    await expectInsertFailure(seeded, { status: "OK" }, "results_status_vocabulary");
  });

  test("PASS requires evidence and a criteria binding (M4/M21)", async () => {
    const seeded = await seed();
    await expectInsertFailure(
      seeded,
      { status: "PASS", evidence: "[]" },
      "results_pass_requires_evidence",
    );
    await expectInsertFailure(
      seeded,
      { status: "PASS", criterion_id: "" },
      "results_pass_requires_criteria",
      "results_criteria_shape",
    );
    // FAIL/INCONCLUSIVE may carry empty evidence.
    await insertResult(seeded, { status: "FAIL", evidence: "[]" });
    await insertResult(seeded, { status: "INCONCLUSIVE", evidence: "[]" });
  });

  test("the evaluator identity AND version are mandatory (M20)", async () => {
    const seeded = await seed();
    await expectInsertFailure(
      seeded,
      { evaluator_version: "" },
      "results_evaluator_identity_shape",
    );
    await expectInsertFailure(seeded, { evaluator_id: "" }, "results_evaluator_identity_shape");
    await expectInsertFailure(seeded, { recorded_by: "" }, "results_evaluator_identity_shape");
    await expectInsertFailure(seeded, { evaluator_kind: "vibes" }, "results_evaluator_vocabulary");
  });

  test("a result detached from its evaluation journal is unrepresentable (M24)", async () => {
    const seeded = await seed();
    await expectInsertFailure(seeded, { evaluation_id: generateId() }, "results_evaluation_fk");
  });

  test("results are physically append-only — mutation after recording is rejected (M23)", async () => {
    const seeded = await seed();
    const id = generateId();
    await insertResult(seeded, { id });
    await expect(
      ctx.port.execute({
        sql: "UPDATE verification.results SET status = 'FAIL' WHERE id = $1",
        parameters: [id],
      }),
    ).rejects.toThrow(/immutable after recording/);
    await expect(
      ctx.port.execute({
        sql: "DELETE FROM verification.results WHERE id = $1",
        parameters: [id],
      }),
    ).rejects.toThrow(/never deleted/);
  });

  test("the evaluation journal is an evaluator-job lifecycle, not an execution state machine (M14)", async () => {
    const seeded = await seed();
    // Execution lifecycle states are unrepresentable journal statuses.
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO verification.evaluations
              (id, application_id, tenant_id, execution_id, evaluation_key, request_fingerprint,
               target_kind, target_ref, status, criteria_set)
              VALUES ($1, $2, $3, $4::uuid, $5, 'fp-2', 'execution-output', $4::text, 'RUNNING', '[{"criterionId":"c","version":1}]'::jsonb)`,
        parameters: [
          generateId(),
          seeded.world.applicationId,
          seeded.world.tenantId,
          seeded.executionId,
          `key-${generateId().slice(-8)}`,
        ],
      }),
    ).rejects.toThrow(
      /evaluations_status_vocabulary|evaluations_evaluating_shape|evaluations_denied_shape|evaluations_concluded_shape/,
    );
    // Terminal journal rows are immutable; evaluating rows finalize once.
    const row = await ctx.port.execute<{ id: string }>({
      sql: `UPDATE verification.evaluations
            SET status = 'concluded',
                conclusion = '{"criteriaMet": true, "requiredUnmet": [], "completed": true}'::jsonb,
                concluded_at = now()
            WHERE id = $1 AND status = 'evaluating'
            RETURNING id`,
      parameters: [seeded.evaluationId],
    });
    expect(row.rows).toHaveLength(1);
    await expect(
      ctx.port.execute({
        sql: "UPDATE verification.evaluations SET denial_reason = 'x' WHERE id = $1",
        parameters: [seeded.evaluationId],
      }),
    ).rejects.toThrow(/terminal-immutable/);
    await expect(
      ctx.port.execute({
        sql: "DELETE FROM verification.evaluations WHERE id = $1",
        parameters: [seeded.evaluationId],
      }),
    ).rejects.toThrow(/never deleted/);
  });

  test("criteria are append-only and identity-keyed", async () => {
    const seeded = await seed();
    const id = generateId();
    const insert = async (criterionId: string) =>
      ctx.port.execute({
        sql: `INSERT INTO verification.criteria
              (id, application_id, tenant_id, criterion_id, version, kind, required, description, definition)
              VALUES ($1, $2, $3, $4, 1, 'invariant', true, 'd', '{"assertions":[{"path":"a","op":"exists"}]}'::jsonb)`,
        parameters: [generateId(), seeded.world.applicationId, seeded.world.tenantId, criterionId],
      });
    await insert("c-schema-1");
    await expect(insert("c-schema-1")).rejects.toThrow(/criteria_identity/);
    await expect(
      ctx.port.execute({
        sql: "UPDATE verification.criteria SET description = 'changed' WHERE criterion_id = $1",
        parameters: ["c-schema-1"],
      }),
    ).rejects.toThrow(/immutable after declaration/);
    void id;
  });

  test("human evaluation answers are exactly-once, shape-pinned and attributable (M19)", async () => {
    const seeded = await seed();
    const requestId = generateId();
    await ctx.port.execute({
      sql: `INSERT INTO verification.human_evaluation_requests
            (id, application_id, tenant_id, execution_id, request_key, request_fingerprint,
             target_kind, target_ref, criterion_id, criteria_version, question, requested_by)
            VALUES ($1, $2, $3, $4::uuid, $5, 'fp-h', 'execution-output', $4::text, 'c', 1, 'ok?', $6)`,
      parameters: [
        requestId,
        seeded.world.applicationId,
        seeded.world.tenantId,
        seeded.executionId,
        `key-${requestId.slice(-8)}`,
        seeded.world.actor().actorId,
      ],
    });
    // Partial answers are unrepresentable (all-or-none shape).
    await expect(
      ctx.port.execute({
        sql: "UPDATE verification.human_evaluation_requests SET answered_by = 'someone' WHERE id = $1",
        parameters: [requestId],
      }),
    ).rejects.toThrow(/answered_shape|answer must set result binding/);
    // A full answer binds exactly once.
    await ctx.port.execute({
      sql: `UPDATE verification.human_evaluation_requests
            SET answered_by_result_id = $2, answered_by = 'decider-1', answered_at = now()
            WHERE id = $1`,
      parameters: [requestId, generateId()],
    });
    await expect(
      ctx.port.execute({
        sql: `UPDATE verification.human_evaluation_requests
              SET answered_by_result_id = $2, answered_by = 'decider-2', answered_at = now()
              WHERE id = $1`,
        parameters: [requestId, generateId()],
      }),
    ).rejects.toThrow(/already answered/);
    // An answer without the deciding actor identity is unrepresentable.
    const second = generateId();
    await ctx.port.execute({
      sql: `INSERT INTO verification.human_evaluation_requests
            (id, application_id, tenant_id, execution_id, request_key, request_fingerprint,
             target_kind, target_ref, criterion_id, criteria_version, question, requested_by)
            VALUES ($1, $2, $3, $4::uuid, $5, 'fp-h2', 'execution-output', $4::text, 'c', 1, 'ok?', $6)`,
      parameters: [
        second,
        seeded.world.applicationId,
        seeded.world.tenantId,
        seeded.executionId,
        `key-${second.slice(-8)}`,
        seeded.world.actor().actorId,
      ],
    });
    await expect(
      ctx.port.execute({
        sql: `UPDATE verification.human_evaluation_requests
              SET answered_by_result_id = $2, answered_at = now()
              WHERE id = $1`,
        parameters: [second, generateId()],
      }),
    ).rejects.toThrow(/answered_shape|answer must set result binding/);
  });

  test("comparisons never carry a forced winner or skip planner authorization (M16/M22)", async () => {
    const seeded = await seed();
    const base = {
      application_id: seeded.world.applicationId,
      tenant_id: seeded.world.tenantId,
      execution_id: seeded.executionId,
      criterion_id: "c",
      criteria_version: 1,
      candidates:
        '[{"candidateId":"a","evidenceRefs":[],"facts":{}},{"candidateId":"b","evidenceRefs":[],"facts":{}}]' as const,
      per_candidate: "[]" as const,
      evaluator_kind: "deterministic",
      evaluator_id: "invariant-evaluator",
      evaluator_version: "1",
      planner_authorization:
        '{"initiator":"planner","decisionRef":"d-1","reason":"bounded comparison"}' as const,
    };
    const insert = (overrides: Record<string, unknown>) =>
      ctx.port.execute({
        sql: `INSERT INTO verification.comparisons
              (id, application_id, tenant_id, execution_id, comparison_key, request_fingerprint,
               criterion_id, criteria_version, candidates, status, winner, per_candidate,
               evaluator_kind, evaluator_id, evaluator_version, planner_authorization)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb, $13, $14, $15, $16::jsonb)`,
        parameters: [
          generateId(),
          base.application_id,
          base.tenant_id,
          base.execution_id,
          `key-${generateId().slice(-8)}`,
          "fp-c",
          base.criterion_id,
          base.criteria_version,
          base.candidates,
          overrides.status ?? "INCONCLUSIVE",
          overrides.winner ?? null,
          '[{"candidateId":"a","status":"INCONCLUSIVE","observations":[]},{"candidateId":"b","status":"INCONCLUSIVE","observations":[]}]',
          base.evaluator_kind,
          base.evaluator_id,
          base.evaluator_version,
          overrides.planner_authorization ?? base.planner_authorization,
        ],
      });
    // A winner under INCONCLUSIVE is unrepresentable.
    await expect(insert({ winner: "a" })).rejects.toThrow(/comparisons_winner_shape/);
    // PASS without a winner is equally unrepresentable.
    await expect(insert({ status: "PASS" })).rejects.toThrow(/comparisons_winner_shape/);
    // Non-planner authorization is unrepresentable.
    await expect(
      insert({ planner_authorization: '{"initiator":"user","decisionRef":"x","reason":"y"}' }),
    ).rejects.toThrow(/comparisons_planner_authorization_shape/);
    // The legal shapes commit.
    await insert({});
    await insert({ status: "PASS", winner: "a" });
  });

  test("cross-tenant and cross-execution evidence rows are unrepresentable (M9/M10)", async () => {
    const seeded = await seed();
    await expectInsertFailure(seeded, { tenant_id: generateId() }, "results_tenant_fk");
    await expectInsertFailure(seeded, { execution_id: generateId() }, "results_execution_fk");
  });

  test("duplicate request keys are rejected (idempotency anchors)", async () => {
    const seeded = await seed();
    const evaluationKey = `dup-${generateId().slice(-8)}`;
    const insert = () =>
      ctx.port.execute({
        sql: `INSERT INTO verification.evaluations
              (id, application_id, tenant_id, execution_id, evaluation_key, request_fingerprint,
               target_kind, target_ref, status, criteria_set)
              VALUES ($1, $2, $3, $4::uuid, $5, 'fp-d', 'execution-output', $4::text, 'evaluating', '[{"criterionId":"c","version":1}]'::jsonb)`,
        parameters: [
          generateId(),
          seeded.world.applicationId,
          seeded.world.tenantId,
          seeded.executionId,
          evaluationKey,
        ],
      });
    await insert();
    await expect(insert()).rejects.toThrow(/evaluations_request_key/);
  });
});
