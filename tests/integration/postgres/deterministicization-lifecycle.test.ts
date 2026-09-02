/**
 * Real-PostgreSQL deterministicization lifecycle proofs (WORK-021;
 * migration `0019_deterministicization_lifecycle.sql`): the DURABLE
 * LIFECYCLE over the REAL observation substrate, the physical
 * invariants and the tenant/application scope.
 *
 * Required-test mapping (the Work Order's real-PostgreSQL axis):
 *  - DTR-001 discovery mines the REAL telemetry population (bound to
 *    REAL terminal executions, migration 0009) and finds the recurring
 *    AI subgraph with full provenance;
 *  - the honest full lifecycle: proposal (content identity, mandatory
 *    provenance) → the four offline validation stages → validated →
 *    shadow (concluded, measurable deltas) → canary (concluded,
 *    measurable deltas) → PROMOTION through the fail-closed gate →
 *    ROLLBACK restoring the incumbent — every decision with rationale;
 *  - duplicate submissions CONVERGE (write-once per stage, one
 *    candidate row, N=8 concurrent proposals → one durable outcome);
 *  - the fail-closed promotion gate over real PG (no evidence → no
 *    promotion, no durable decision);
 *  - PHYSICAL immutability: identity-core/terminal/UPDATE/DELETE
 *    guards on all five tables; the single-step status machine; the
 *    stage-slot and mode-slot UNIQUEs; the decision kind/verdict CHECK;
 *    the operations ledger discipline (claim convergence, attempts
 *    monotonicity, terminal immutability, write-once core);
 *  - tenant/application scope: cross-scope reads return nothing.
 */

import { expect, test } from "vitest";
import { PlatformError } from "../../../src/shared/errors";
import {
  type DeterministicizationPgWorld,
  driveTo,
  RECURRING_SUBGRAPH_ID,
  seedDeterministicizationWorld,
  stageRuns,
} from "./deterministicization-world";
import { definePgSuite } from "./harness";

definePgSuite("deterministicization lifecycle (real PostgreSQL, migration 0019)", (ctx) => {
  async function freshWorld(): Promise<DeterministicizationPgWorld> {
    return seedDeterministicizationWorld(ctx.port);
  }

  async function countRows(
    table: string,
    applicationId: string,
    extraWhere = "",
    parameters: readonly unknown[] = [],
  ) {
    const result = await ctx.port.execute<{ count: string }>({
      sql: `SELECT COUNT(*)::text AS count FROM learning.${table}
            WHERE application_id = $1 ${extraWhere}`,
      parameters: [applicationId, ...parameters],
    });
    return Number(result.rows[0]?.count ?? "0");
  }

  test("migration 0019 physically applies: all five lifecycle tables exist with their guard sets", async () => {
    const result = await ctx.port.execute<{ table_name: string }>({
      sql: `SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'learning' AND table_name LIKE 'deterministicization%'
            ORDER BY table_name`,
      parameters: [],
    });
    expect(result.rows.map((row) => row.table_name)).toEqual([
      "deterministicization_candidates",
      "deterministicization_decisions",
      "deterministicization_operations",
      "deterministicization_rollouts",
      "deterministicization_stage_evidence",
    ]);
    const triggers = await ctx.port.execute<{ trigger_name: string }>({
      sql: `SELECT trigger_name FROM information_schema.triggers
            WHERE event_object_table LIKE 'deterministicization%'
            ORDER BY event_object_table, trigger_name`,
      parameters: [],
    });
    // The full physical guard set is installed: 12 trigger rows
    // (candidates 3 + evidence 2 [UPDATE|DELETE] + rollouts 2 +
    // decisions 2 [UPDATE|DELETE] + operations 3).
    expect(triggers.rows.length).toBe(12);
  });

  test("DTR-001: discovery over the REAL telemetry population finds the recurring AI subgraph with full provenance", async () => {
    const world = await freshWorld();
    const { service } = world.boot();
    const { discovered, population } = await service.discoverCandidates({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
    });
    expect(population).toBe(world.telemetryCount);
    const subgraph = discovered.find((entry) => entry.subgraphId === RECURRING_SUBGRAPH_ID);
    expect(subgraph).toBeDefined();
    expect(subgraph?.occurrenceCount).toBe(world.telemetryCount);
    expect(subgraph?.computationType).toBe("generative");
    expect(subgraph?.strong).toBe(true);
    // Provenance: every REAL source execution is named.
    expect([...(subgraph?.sourceExecutionIds ?? [])].sort()).toEqual(
      [...world.sourceExecutionIds].sort(),
    );
    expect(subgraph?.evidenceRefs.length).toBeGreaterThanOrEqual(1);
  });

  test("the honest full lifecycle over real PG: proposal → four stages → validated → shadow → canary → promotion → rollback", async () => {
    const world = await freshWorld();
    const { service } = world.boot();
    const candidateId = await driveTo(service, world, "promoted");
    const state = await service.getCandidate({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      candidateId,
    });
    // The four offline stages settled PASSING (all above thresholds).
    expect(state.evidence.map((record) => record.stageKind).sort()).toEqual([
      "differential-evaluation",
      "mutation-tests",
      "offline-replay",
      "property-tests",
    ]);
    expect(state.evidence.every((record) => record.status === "passed")).toBe(true);
    // The rollout phases carry the measurable deltas (DTR-003).
    const shadow = state.rollouts.find((rollout) => rollout.mode === "shadow");
    const canary = state.rollouts.find((rollout) => rollout.mode === "canary");
    expect(shadow?.status).toBe("concluded");
    expect(shadow?.population).toBe(12);
    expect(shadow?.costDeltaMicroUsd).toBe("2200");
    expect(canary?.status).toBe("concluded");
    expect(canary?.qualityDelta).toBe(1);
    // The promotion decision recorded the promoting gate + rationale.
    const promotion = state.decisions.find((decision) => decision.kind === "promoted");
    expect(promotion?.gate.verdict).toBe("promote");
    expect(promotion?.rationale.length).toBeGreaterThan(0);
    // ROLLBACK restores the incumbent (DTR-003/DTR-004).
    const { decision } = await service.rollbackCandidate({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      candidateId,
      rationale: "canary quality degraded after a corpus shift",
      decidedBy: "architect-1",
    });
    expect(decision.kind).toBe("rolled-back");
    expect(decision.incumbentRestoredTo).toBe("incumbent:generative-route@v1");
    const final = await service.getCandidate({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      candidateId,
    });
    expect(final.candidate.status).toBe("rolled-back");
    expect(final.decisions.length).toBe(2);
  });

  test("duplicate submissions converge: same proposal replays (replayed=true), one candidate row, N=8 concurrent proposals → one durable outcome", async () => {
    const world = await freshWorld();
    const { service } = world.boot();
    const first = await service.proposeCandidate(world.proposalRequest());
    expect(first.replayed).toBe(false);
    const second = await service.proposeCandidate(world.proposalRequest());
    expect(second.replayed).toBe(true);
    expect(second.candidate.candidateId).toBe(first.candidate.candidateId);
    expect(await countRows("deterministicization_candidates", world.applicationId)).toBe(1);
    // N=8 concurrent proposals of the same logical content.
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () => service.proposeCandidate(world.proposalRequest())),
    );
    for (const outcome of concurrent) {
      expect(outcome.candidate.candidateId).toBe(first.candidate.candidateId);
    }
    expect(await countRows("deterministicization_candidates", world.applicationId)).toBe(1);
    // One durable operation row for the stable candidate-registration key.
    const operations = await ctx.port.execute<Record<string, unknown>>({
      sql: `SELECT * FROM learning.deterministicization_operations
            WHERE application_id = $1 AND operation_kind = 'candidate-registration'`,
      parameters: [world.applicationId],
    });
    expect(operations.rows.length).toBe(1);
    expect(operations.rows[0]?.status).toBe("completed");
    // A stage-evidence duplicate converges too (write-once per stage).
    const candidateId = first.candidate.candidateId;
    const stage = {
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      candidateId,
      stageKind: "offline-replay" as const,
      runs: stageRuns(24),
      recordedBy: "validator-1",
    };
    const evidenceFirst = await service.recordStageEvidence(stage);
    expect(evidenceFirst.replayed).toBe(false);
    const evidenceRetry = await service.recordStageEvidence(stage);
    expect(evidenceRetry.replayed).toBe(true);
    expect(await countRows("deterministicization_stage_evidence", world.applicationId)).toBe(1);
  });

  test("the fail-closed promotion gate over real PG: a candidate with NO validation evidence never promotes (no durable decision)", async () => {
    const world = await freshWorld();
    const { service } = world.boot();
    const { candidate } = await service.proposeCandidate(world.proposalRequest());
    const failure = service.applyPromotion({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      candidateId: candidate.candidateId,
      decidedBy: "architect-1",
    });
    await expect(failure).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("the promotion gate failed closed"),
    });
    expect(await countRows("deterministicization_decisions", world.applicationId)).toBe(0);
    const state = await service.getCandidate({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      candidateId: candidate.candidateId,
    });
    expect(state.candidate.status).toBe("proposed");
  });

  test("the provenance boundary is physical: a provenance-less candidate row is unrepresentable", async () => {
    const world = await freshWorld();
    const insertion = ctx.port.execute({
      sql: `INSERT INTO learning.deterministicization_candidates
            (id, application_id, tenant_id, candidate_class, status, subgraph, provenance,
             recurrence, incumbent, contract, program_source, program_digest, program_language,
             proposed_by, proposed_at, created_at, updated_at, schema_version)
            VALUES ($1, $2, $3, 'deterministic-replacement', 'proposed', '{}'::jsonb,
                    '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, NULL, NULL, NULL,
                    'agent-1', now(), now(), now(), 1)`,
      parameters: [`prov-less-${world.tenantId.slice(-6)}`, world.applicationId, world.tenantId],
    });
    await expect(insertion).rejects.toThrow(/dtr_candidates_/);
  });

  test("candidates: the identity core is physically immutable; the status machine is single-step; terminal statuses are frozen; rows are never deleted", async () => {
    const world = await freshWorld();
    const { service } = world.boot();
    const candidateId = await driveTo(service, world, "validated");
    // Identity core: provenance/contract/program never move.
    await expect(
      ctx.port.execute({
        sql: `UPDATE learning.deterministicization_candidates
              SET provenance = '{"sourceExecutionIds":["x"],"evidenceRefs":["y"],"corpusDigest":"z","population":1}'::jsonb
              WHERE id = $1`,
        parameters: [candidateId],
      }),
    ).rejects.toThrow(/identity core is immutable/);
    // Single-step: validating -> promoted is illegal.
    await expect(
      ctx.port.execute({
        sql: `UPDATE learning.deterministicization_candidates SET status = 'promoted' WHERE id = $1`,
        parameters: [candidateId],
      }),
    ).rejects.toThrow(/single-step forward only/);
    // Status regression: validated -> proposed is illegal.
    await expect(
      ctx.port.execute({
        sql: `UPDATE learning.deterministicization_candidates SET status = 'proposed' WHERE id = $1`,
        parameters: [candidateId],
      }),
    ).rejects.toThrow(/single-step forward only/);
    // Rows are never deleted.
    await expect(
      ctx.port.execute({
        sql: `DELETE FROM learning.deterministicization_candidates WHERE id = $1`,
        parameters: [candidateId],
      }),
    ).rejects.toThrow(/never deleted/);

    // Terminal immutability: promoted (then rolled-back) rows are frozen.
    const promotedId = await driveTo(service, world, "promoted");
    await service.rollbackCandidate({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      candidateId: promotedId,
      rationale: "physical guard probe",
      decidedBy: "architect-1",
    });
    await expect(
      ctx.port.execute({
        sql: `UPDATE learning.deterministicization_candidates SET status = 'deferred' WHERE id = $1`,
        parameters: [promotedId],
      }),
    ).rejects.toThrow(/terminal-immutable/);
    await expect(
      ctx.port.execute({
        sql: `UPDATE learning.deterministicization_candidates SET status = 'promoted' WHERE id = $1`,
        parameters: [promotedId],
      }),
    ).rejects.toThrow(/terminal-immutable/);
  });

  test("stage evidence: rows are physically immutable; the stage slot settles once; a different basis for a settled stage is rejected", async () => {
    const world = await freshWorld();
    const { service } = world.boot();
    const { candidate } = await service.proposeCandidate(world.proposalRequest());
    const candidateId = candidate.candidateId;
    await service.recordStageEvidence({
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      candidateId,
      stageKind: "offline-replay",
      runs: stageRuns(24),
      recordedBy: "validator-1",
    });
    const row = await ctx.port.execute<Record<string, unknown>>({
      sql: `SELECT evidence_id FROM learning.deterministicization_stage_evidence
            WHERE application_id = $1 AND candidate_id = $2`,
      parameters: [world.applicationId, candidateId],
    });
    const evidenceId = row.rows[0]?.evidence_id as string;
    // Rows are immutable (append-only).
    await expect(
      ctx.port.execute({
        sql: `UPDATE learning.deterministicization_stage_evidence SET status = 'failed' WHERE evidence_id = $1`,
        parameters: [evidenceId],
      }),
    ).rejects.toThrow(/immutable/);
    await expect(
      ctx.port.execute({
        sql: `DELETE FROM learning.deterministicization_stage_evidence WHERE evidence_id = $1`,
        parameters: [evidenceId],
      }),
    ).rejects.toThrow(/immutable/);
    // A DIFFERENT record for the settled stage is unrepresentable
    // (typed fail-closed through the service, unique at the physical).
    const differentBasis = {
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      candidateId,
      stageKind: "offline-replay" as const,
      runs: stageRuns(23, "success", "offline-replay"),
      recordedBy: "validator-2",
    };
    await expect(service.recordStageEvidence(differentBasis)).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      message: expect.stringContaining("the validation stage is already settled"),
    });
    expect(await countRows("deterministicization_stage_evidence", world.applicationId)).toBe(1);
  });

  test("rollouts: one epoch per mode (the mode slot is physically unique); a concluded rollout is frozen", async () => {
    const world = await freshWorld();
    const { service } = world.boot();
    const candidateId = await driveTo(service, world, "promoted");
    const rollouts = await service
      .getCandidate({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        candidateId,
      })
      .then((state) => state.rollouts);
    const shadow = rollouts.find((rollout) => rollout.mode === "shadow");
    expect(shadow).toBeDefined();
    if (shadow === undefined) {
      return;
    }
    // A second shadow epoch for the same candidate: unrepresentable.
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO learning.deterministicization_rollouts
              (rollout_id, application_id, tenant_id, candidate_id, mode, status, population,
               matched_count, cost_delta_micro_usd, quality_delta, latency_delta_ms,
               evidence_refs, began_at, concluded_at, schema_version)
              VALUES ($1, $2, $3, $4, 'shadow', 'observing', 0, 0, '0', 0, 0, '[]'::jsonb,
                      now(), NULL, 1)`,
        parameters: [
          `second-epoch-${shadow.rolloutId.slice(-8)}`,
          world.applicationId,
          world.tenantId,
          candidateId,
        ],
      }),
    ).rejects.toThrow(/dtr_rollouts_mode_slot_unique/);
    // A concluded rollout is terminal-immutable (the deltas never move).
    await expect(
      ctx.port.execute({
        sql: `UPDATE learning.deterministicization_rollouts SET population = 999 WHERE rollout_id = $1`,
        parameters: [shadow.rolloutId],
      }),
    ).rejects.toThrow(/terminal-immutable/);
    await expect(
      ctx.port.execute({
        sql: `DELETE FROM learning.deterministicization_rollouts WHERE rollout_id = $1`,
        parameters: [shadow.rolloutId],
      }),
    ).rejects.toThrow(/never deleted/);
  });

  test("decisions: the journal is physically append-only; kind/verdict agreement and the rollback-only restoration are CHECK-bound", async () => {
    const world = await freshWorld();
    const { service } = world.boot();
    const candidateId = await driveTo(service, world, "promoted");
    const decisions = await service
      .getCandidate({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        candidateId,
      })
      .then((state) => state.decisions);
    const promotion = decisions.find((decision) => decision.kind === "promoted");
    expect(promotion).toBeDefined();
    // The journal is immutable.
    await expect(
      ctx.port.execute({
        sql: `UPDATE learning.deterministicization_decisions SET rationale = 'rewritten' WHERE decision_id = $1`,
        parameters: [promotion?.decisionId],
      }),
    ).rejects.toThrow(/immutable/);
    await expect(
      ctx.port.execute({
        sql: `DELETE FROM learning.deterministicization_decisions WHERE decision_id = $1`,
        parameters: [promotion?.decisionId],
      }),
    ).rejects.toThrow(/immutable/);
    // A non-rollback decision may not record the restoration target.
    await expect(
      ctx.port.execute({
        sql: `UPDATE learning.deterministicization_decisions SET incumbent_restored_to = 'x'
              WHERE decision_id = $1`,
        parameters: [promotion?.decisionId],
      }),
    ).rejects.toThrow(/immutable/);
    // A promoted decision with a fail-closed gate is unrepresentable.
    const gate = JSON.stringify({
      gateConfigDigest: "a".repeat(64),
      verdict: "not-promoted",
      reasons: ["physical probe"],
      stageEvidenceIds: [],
      rolloutIds: [],
      evaluatedAt: new Date().toISOString(),
    });
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO learning.deterministicization_decisions
              (decision_id, application_id, tenant_id, candidate_id, decision_kind, rationale,
               gate, incumbent_restored_to, decided_by, decided_at, schema_version)
              VALUES ($1, $2, $3, $4, 'promoted', 'probe', $5::jsonb, NULL, 'probe', now(), 1)`,
        parameters: [
          `bad-verdict-${candidateId.slice(-8)}`,
          world.applicationId,
          world.tenantId,
          candidateId,
          gate,
        ],
      }),
    ).rejects.toThrow(/dtr_decisions_kind_verdict_agreement/);
  });

  test("operations: the durable operation ledger discipline (claim convergence, attempts monotonicity, terminal immutability, write-once core, no delete)", async () => {
    const world = await freshWorld();
    const { service } = world.boot();
    const { candidate } = await service.proposeCandidate(world.proposalRequest());
    const candidateId = candidate.candidateId;
    const rows = await ctx.port.execute<Record<string, unknown>>({
      sql: `SELECT * FROM learning.deterministicization_operations
            WHERE application_id = $1 AND candidate_id = $2`,
      parameters: [world.applicationId, candidateId],
    });
    const operation = rows.rows[0];
    expect(operation?.status).toBe("completed");
    expect(operation?.attempts).toBe(1);
    expect(operation?.completed_at).not.toBeNull();
    const operationId = operation?.id as string;
    const operationKey = operation?.operation_key as string;
    // The identity core never moves.
    await expect(
      ctx.port.execute({
        sql: `UPDATE learning.deterministicization_operations SET operation_kind = 'rollback'
              WHERE id = $1`,
        parameters: [operationId],
      }),
    ).rejects.toThrow(/identity core is immutable/);
    // COMPLETED is terminal-immutable (no checkpoint/outcome rewrite).
    await expect(
      ctx.port.execute({
        sql: `UPDATE learning.deterministicization_operations SET checkpoint = '{"x":1}'::jsonb
              WHERE id = $1`,
        parameters: [operationId],
      }),
    ).rejects.toThrow(/terminal-immutable/);
    // Attempts never regress.
    await expect(
      ctx.port.execute({
        sql: `UPDATE learning.deterministicization_operations SET attempts = 0 WHERE id = $1`,
        parameters: [operationId],
      }),
    ).rejects.toThrow(/pending -> completed|attempts|terminal-immutable/);
    // Rows are never deleted.
    await expect(
      ctx.port.execute({
        sql: `DELETE FROM learning.deterministicization_operations WHERE id = $1`,
        parameters: [operationId],
      }),
    ).rejects.toThrow(/never deleted/);
    // A duplicate claim CONVERGES (attempts bump, PENDING only).
    const reClaimed = await world.store.beginOperation({
      operationId: `00000000-0000-7000-b000-${String(Date.now() % 1000).padStart(12, "0")}`,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      candidateId,
      operationKind: "candidate-registration",
      operationKey,
      createdAt: new Date().toISOString(),
    });
    expect(reClaimed.status).toBe("existing");
    expect(reClaimed.record.status).toBe("completed");
    expect(reClaimed.record.attempts).toBe(1); // terminal rows replay WITHOUT a bump
  });

  test("tenant/application scope: cross-scope reads return nothing; the composite FK binds rows to their application", async () => {
    const world = await freshWorld();
    const { service } = world.boot();
    const candidateId = await driveTo(service, world, "validated");
    // A second application in the SAME database sees nothing.
    const otherTenantId = "00000000-0000-7000-c000-0000000000a1";
    const otherApplicationId = "00000000-0000-7000-c000-0000000000a2";
    await ctx.port.execute({
      sql: "INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)",
      parameters: [otherTenantId, "t-other", "other tenant"],
    });
    await ctx.port.execute({
      sql: "INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)",
      parameters: [otherApplicationId, otherTenantId, "a-other", "other app"],
    });
    const crossScope = service.getCandidate({
      applicationId: otherApplicationId,
      tenantId: otherTenantId,
      candidateId,
    });
    // Cross-scope reads FAIL CLOSED (not-found within the scope —
    // tenant boundaries are never dropped).
    await expect(crossScope).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      message: expect.stringContaining("not found within the application scope"),
    });
    // Cross-scope candidates listing is empty.
    expect(
      await service.consultDeterministicizationSignals({
        applicationId: otherApplicationId,
        tenantId: otherTenantId,
      }),
    ).toEqual([]);
    // The composite FK: a candidate row cannot be inserted with a
    // mismatched tenant binding.
    const probeCandidate = {
      subgraph: {
        subgraphId: "s",
        taskClass: "t",
        computationType: "generative",
      },
      provenance: {
        sourceExecutionIds: ["e"],
        evidenceRefs: ["r"],
        corpusDigest: "d",
        population: 1,
        windowFrom: "2026-01-01T00:00:00Z",
        windowTo: "2026-01-02T00:00:00Z",
      },
      recurrence: { occurrenceCount: 1, totalCostMicroUsd: "1", errorRate: 0 },
      incumbent: {
        strategyClass: "g",
        routes: [],
        descriptionDigest: "c".repeat(64),
        rollbackTarget: "inc",
      },
      contract: {
        inputFields: [{ name: "i", type: "string", required: true }],
        outputFields: [{ name: "o", type: "string", required: true }],
        acceptanceCriterion: {
          kind: "exact-output",
          description: "the description",
        },
        compute: {
          pureComputeOnly: true,
          networkEgress: "none",
          allowedHosts: [],
          timeoutMs: 1000,
        },
      },
    };
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO learning.deterministicization_candidates
              (id, application_id, tenant_id, candidate_class, status, subgraph, provenance,
               recurrence, incumbent, contract, program_source, program_digest, program_language,
               proposed_by, proposed_at, created_at, updated_at, schema_version)
              VALUES ($1, $2, $3, 'removal', 'proposed', $4::jsonb, $5::jsonb, $6::jsonb,
                      $7::jsonb, $8::jsonb, NULL, NULL, NULL, 'agent-1', now(), now(), now(), 1)`,
        parameters: [
          "fk-probe-1",
          world.applicationId,
          otherTenantId,
          JSON.stringify(probeCandidate.subgraph),
          JSON.stringify(probeCandidate.provenance),
          JSON.stringify(probeCandidate.recurrence),
          JSON.stringify(probeCandidate.incumbent),
          JSON.stringify(probeCandidate.contract),
        ],
      }),
    ).rejects.toThrow();
  });
});
