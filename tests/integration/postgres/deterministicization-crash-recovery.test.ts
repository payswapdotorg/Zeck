/**
 * Real-PostgreSQL crash-injection proofs — the DURABLE, RECOVERABLE
 * DETERMINISTICIZATION OPERATION STATE and the STABLE content-derived
 * operation keys (WORK-021; checkpoint contract CONCURRENCY-CRASH-SAFETY
 * — the PHYSICAL half).
 *
 * The unit suite (tests/unit/learning/deterministicization-
 * crash-recovery.test.ts) proves the behavioral half over the in-memory
 * world. THIS suite proves the same kill/restart discipline against
 * REAL PostgreSQL (migrations 0001..0019): the process dies
 * mid-lifecycle-operation, the durable rows (the candidate / stage
 * evidence / rollout / decision journal, and the
 * `deterministicization_operations` ledger with its PENDING status,
 * checkpoint and attempts) physically SURVIVE, and a re-booted service
 * (the process restart over the SAME PG store) converges the operation
 * to COMPLETED with EXACTLY ONE durable side effect per stable
 * content-derived key.
 *
 * THE PROOF RECORDS (the lifecycle's critical boundaries):
 *   REGISTRATION   P1 insert-after crash → converged re-propose ·
 *                  P2 double crash → attempts ledger honest
 *   STAGE EVIDENCE P3 insert-after crash → converged re-record + the
 *                  status tail lands on resume · P4 checkpoint-after
 *                  crash → resume completes
 *   SHADOW ROLLOUT P5 begin-insert-after crash → converged re-begin ·
 *                  P6 conclude-after crash → converged re-conclusion
 *   PROMOTION      P7 decision-after crash → re-derived decisionId
 *                  converges (one decision, one promotion) · P8
 *                  transition-after crash → the top-level idempotent
 *                  replay NEVER re-runs the gate and converges the
 *                  crash-window PENDING operation row
 *   ROLLBACK       P9 decision-after crash → converged re-rollback
 *                  (exactly one rolled-back decision; the incumbent
 *                  restoration is durable)
 *   DISCIPLINE     P10 the operations ledger physical discipline
 *                  (pending-only attempts bump, terminal immutability,
 *                  core immutability, no delete)
 */

import { describe, expect, test } from "vitest";
import {
  type DeterministicizationPgWorld,
  driveTo,
  seedDeterministicizationWorld,
  stageRuns,
} from "./deterministicization-world";
import { definePgSuite } from "./harness";

definePgSuite("deterministicization crash-injection proofs on real PostgreSQL", (ctx) => {
  async function freshWorld(): Promise<DeterministicizationPgWorld> {
    return seedDeterministicizationWorld(ctx.port);
  }

  /** Run one operation in a DYING process (the outcome is irrelevant — the process is gone). */
  async function diesDuring(run: () => Promise<unknown>, crashed: () => boolean): Promise<void> {
    await run().then(
      () => undefined,
      () => undefined,
    );
    expect(crashed()).toBe(true);
  }

  async function operationRow(applicationId: string, operationKey: string) {
    const result = await ctx.port.execute<Record<string, unknown>>({
      sql: `SELECT * FROM learning.deterministicization_operations
            WHERE application_id = $1 AND operation_key = $2`,
      parameters: [applicationId, operationKey],
    });
    return result.rows[0] ?? null;
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

  const stageEvidenceRequest = (world: DeterministicizationPgWorld, candidateId: string) => ({
    applicationId: world.applicationId,
    tenantId: world.tenantId,
    candidateId,
    stageKind: "offline-replay" as const,
    runs: stageRuns(24, "success", "offline-replay"),
    recordedBy: "validator-1",
  });

  describe("P-records: kill/restart at the durable boundaries", () => {
    test("P1 REGISTRATION: crash AFTER insertCandidate — the candidate row survives; the restart converges the re-propose and completes the operation", async () => {
      const world = await freshWorld();
      const dying = world.boot({ method: "insertCandidate", when: "after" });
      await diesDuring(
        () => dying.service.proposeCandidate(world.proposalRequest()),
        dying.crashed,
      );
      // The candidate row physically exists; the operation row is
      // PENDING (the completion never ran before the crash).
      const request = world.proposalRequest();
      expect(await countRows("deterministicization_candidates", world.applicationId)).toBe(1);
      const candidateId = request.provenance.corpusDigest; // placeholder — real id below
      void candidateId;
      const row = await ctx.port.execute<Record<string, unknown>>({
        sql: `SELECT id FROM learning.deterministicization_candidates
              WHERE application_id = $1`,
        parameters: [world.applicationId],
      });
      const durableCandidateId = String(row.rows[0]?.id);
      const opKey = `dtr-candidate-registration:${durableCandidateId}`;
      const pending = await operationRow(world.applicationId, opKey);
      expect(pending?.status).toBe("pending");
      expect(pending?.attempts).toBe(1);
      // RESTART: the same logical proposal re-derives the same identity.
      const restarted = world.boot(null);
      const outcome = await restarted.service.proposeCandidate(request);
      expect(outcome.replayed).toBe(true);
      expect(outcome.candidate.candidateId).toBe(durableCandidateId);
      expect(await countRows("deterministicization_candidates", world.applicationId)).toBe(1);
      // The operation row converged to COMPLETED with the honest
      // attempts ledger (the re-claim bumped it).
      const completed = await operationRow(world.applicationId, opKey);
      expect(completed?.status).toBe("completed");
      expect(completed?.attempts).toBe(2);
      expect(completed?.completed_at).not.toBeNull();
    });

    test("P2 REGISTRATION double crash: two successive dying processes leave the attempts ledger honest; the third boot completes", async () => {
      const world = await freshWorld();
      const request = world.proposalRequest();
      const first = world.boot({ method: "insertCandidate", when: "after" });
      await diesDuring(() => first.service.proposeCandidate(request), first.crashed);
      const row = await ctx.port.execute<Record<string, unknown>>({
        sql: `SELECT id FROM learning.deterministicization_candidates
              WHERE application_id = $1`,
        parameters: [world.applicationId],
      });
      const durableCandidateId = String(row.rows[0]?.id);
      const opKey = `dtr-candidate-registration:${durableCandidateId}`;
      expect((await operationRow(world.applicationId, opKey))?.attempts).toBe(1);
      // A SECOND dying process dies at the same boundary (the converged
      // insert replays, the crash fires again after it).
      const second = world.boot({ method: "insertCandidate", when: "after", occurrence: 1 });
      await diesDuring(() => second.service.proposeCandidate(request), second.crashed);
      expect((await operationRow(world.applicationId, opKey))?.attempts).toBe(2);
      expect((await operationRow(world.applicationId, opKey))?.status).toBe("pending");
      // The THIRD boot completes.
      const third = world.boot(null);
      const outcome = await third.service.proposeCandidate(request);
      expect(outcome.replayed).toBe(true);
      const completed = await operationRow(world.applicationId, opKey);
      expect(completed?.status).toBe("completed");
      expect(completed?.attempts).toBe(3);
      expect(await countRows("deterministicization_candidates", world.applicationId)).toBe(1);
    });

    test("P3 STAGE EVIDENCE: crash AFTER insertStageEvidence — the evidence row survives; the restart converges the re-record AND lands the status tail", async () => {
      const world = await freshWorld();
      const clean = world.boot(null);
      const { candidate } = await clean.service.proposeCandidate(world.proposalRequest());
      const candidateId = candidate.candidateId;
      const dying = world.boot({ method: "insertStageEvidence", when: "after" });
      await diesDuring(
        () => dying.service.recordStageEvidence(stageEvidenceRequest(world, candidateId)),
        dying.crashed,
      );
      // The evidence row is durable; the candidate status tail did NOT
      // land (still 'proposed'); the operation row is PENDING.
      expect(await countRows("deterministicization_stage_evidence", world.applicationId)).toBe(1);
      const state = await world.boot(null).service.getCandidate({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        candidateId,
      });
      expect(state.candidate.status).toBe("proposed");
      const evidenceId = state.evidence[0]?.evidenceId ?? "";
      const opKey = `dtr-stage-evidence:${evidenceId}`;
      const pending = await operationRow(world.applicationId, opKey);
      expect(pending?.status).toBe("pending");
      // RESTART: the re-record converges AND the status tail lands.
      const restarted = world.boot(null);
      const outcome = await restarted.service.recordStageEvidence(
        stageEvidenceRequest(world, candidateId),
      );
      expect(outcome.replayed).toBe(true);
      expect(await countRows("deterministicization_stage_evidence", world.applicationId)).toBe(1);
      const resumed = await restarted.service.getCandidate({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        candidateId,
      });
      expect(resumed.candidate.status).toBe("validating");
      expect((await operationRow(world.applicationId, opKey))?.status).toBe("completed");
    });

    test("P4 STAGE EVIDENCE: crash AFTER the operation checkpoint — the checkpoint survives; the restart resumes and completes", async () => {
      const world = await freshWorld();
      const clean = world.boot(null);
      const { candidate } = await clean.service.proposeCandidate(world.proposalRequest());
      const candidateId = candidate.candidateId;
      const dying = world.boot({ method: "recordOperationCheckpoint", when: "after" });
      await diesDuring(
        () => dying.service.recordStageEvidence(stageEvidenceRequest(world, candidateId)),
        dying.crashed,
      );
      const state = await world.boot(null).service.getCandidate({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        candidateId,
      });
      const evidenceId = state.evidence[0]?.evidenceId ?? "";
      const opKey = `dtr-stage-evidence:${evidenceId}`;
      const pending = await operationRow(world.applicationId, opKey);
      expect(pending?.status).toBe("pending");
      // The checkpoint carries the resume facts (bounded stage kind).
      const checkpoint = pending?.checkpoint as Record<string, unknown> | null;
      expect(checkpoint?.stageKind).toBe("offline-replay");
      expect(checkpoint?.evidenceId).toBe(evidenceId);
      // RESTART completes.
      const restarted = world.boot(null);
      await restarted.service.recordStageEvidence(stageEvidenceRequest(world, candidateId));
      expect((await operationRow(world.applicationId, opKey))?.status).toBe("completed");
      expect((await operationRow(world.applicationId, opKey))?.attempts).toBe(2);
    });

    test("P5 SHADOW ROLLOUT: crash AFTER insertRollout — the observing rollout survives; the restart converges and moves the tail", async () => {
      const world = await freshWorld();
      const clean = world.boot(null);
      const candidateId = await driveTo(clean.service, world, "validated");
      const dying = world.boot({ method: "insertRollout", when: "after" });
      await diesDuring(
        () =>
          dying.service.beginShadowRollout({
            applicationId: world.applicationId,
            tenantId: world.tenantId,
            candidateId,
            requestedBy: "operator-1",
          }),
        dying.crashed,
      );
      // The observing rollout row is durable; the candidate is still
      // 'validated' (the tail did not land).
      expect(await countRows("deterministicization_rollouts", world.applicationId)).toBe(1);
      const state = await world.boot(null).service.getCandidate({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        candidateId,
      });
      expect(state.candidate.status).toBe("validated");
      expect(state.rollouts[0]?.mode).toBe("shadow");
      expect(state.rollouts[0]?.status).toBe("observing");
      // RESTART converges: one rollout row, the tail lands, completed.
      const restarted = world.boot(null);
      const outcome = await restarted.service.beginShadowRollout({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        candidateId,
        requestedBy: "operator-1",
      });
      expect(outcome.replayed).toBe(true);
      expect(await countRows("deterministicization_rollouts", world.applicationId)).toBe(1);
      const resumed = await restarted.service.getCandidate({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        candidateId,
      });
      expect(resumed.candidate.status).toBe("shadow");
    });

    test("P6 SHADOW CONCLUSION: crash AFTER concludeRollout — the concluded rollout survives; the restart converges on the committed row", async () => {
      const world = await freshWorld();
      const clean = world.boot(null);
      const candidateId = await driveTo(clean.service, world, "validated");
      await clean.service.beginShadowRollout({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        candidateId,
        requestedBy: "operator-1",
      });
      const dying = world.boot({ method: "concludeRollout", when: "after" });
      const conclusion = {
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        candidateId,
        mode: "shadow" as const,
        population: 12,
        matchedCount: 12,
        costDeltaMicroUsd: "2200",
        qualityDelta: 1,
        latencyDeltaMs: -140,
        evidenceRefs: ["ev-shadow"],
        requestedBy: "operator-1",
      };
      await diesDuring(() => dying.service.concludeShadowRollout(conclusion), dying.crashed);
      // The concluded rollout (with its deltas) is durable.
      const state = await world.boot(null).service.getCandidate({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        candidateId,
      });
      const shadow = state.rollouts.find((rollout) => rollout.mode === "shadow");
      expect(shadow?.status).toBe("concluded");
      expect(shadow?.population).toBe(12);
      expect(shadow?.costDeltaMicroUsd).toBe("2200");
      const opKey = `dtr-shadow-rollout:${shadow?.rolloutId}:conclude`;
      expect((await operationRow(world.applicationId, opKey))?.status).toBe("pending");
      // RESTART: the re-conclusion converges on the committed row
      // (exactly one rollout row; the deltas are the committed ones).
      const restarted = world.boot(null);
      const outcome = await restarted.service.concludeShadowRollout(conclusion);
      expect(outcome.rollout.status).toBe("concluded");
      expect(outcome.rollout.population).toBe(12);
      expect(await countRows("deterministicization_rollouts", world.applicationId)).toBe(1);
      expect((await operationRow(world.applicationId, opKey))?.status).toBe("completed");
    });

    test("P7 PROMOTION: crash AFTER appendDecision — the decision survives; the restart re-derives the same decisionId and converges (exactly ONE promotion)", async () => {
      const world = await freshWorld();
      const clean = world.boot(null);
      const candidateId = await driveTo(clean.service, world, "canary");
      const dying = world.boot({ method: "appendDecision", when: "after" });
      await diesDuring(
        () =>
          dying.service.applyPromotion({
            applicationId: world.applicationId,
            tenantId: world.tenantId,
            candidateId,
            decidedBy: "architect-1",
          }),
        dying.crashed,
      );
      // The promoted decision is durable; the candidate is still
      // 'canary' (the tail did not land); the operation row is PENDING.
      expect(
        await countRows(
          "deterministicization_decisions",
          world.applicationId,
          "AND decision_kind = 'promoted'",
        ),
      ).toBe(1);
      const state = await world.boot(null).service.getCandidate({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        candidateId,
      });
      expect(state.candidate.status).toBe("canary");
      const decisionId = state.decisions[0]?.decisionId ?? "";
      const opKey = `dtr-promotion:${decisionId}`;
      expect((await operationRow(world.applicationId, opKey))?.status).toBe("pending");
      // RESTART: the same logical promotion re-derives the same
      // decisionId → the append converges, the tail lands, the
      // operation completes — exactly ONE promotion decision.
      const restarted = world.boot(null);
      const outcome = await restarted.service.applyPromotion({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        candidateId,
        decidedBy: "architect-1",
      });
      expect(outcome.decision.decisionId).toBe(decisionId);
      expect(
        await countRows(
          "deterministicization_decisions",
          world.applicationId,
          "AND decision_kind = 'promoted'",
        ),
      ).toBe(1);
      const resumed = await restarted.service.getCandidate({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        candidateId,
      });
      expect(resumed.candidate.status).toBe("promoted");
      expect((await operationRow(world.applicationId, opKey))?.status).toBe("completed");
      expect((await operationRow(world.applicationId, opKey))?.attempts).toBe(2);
    });

    test("P8 PROMOTION REPLAY: crash AFTER the promoted transition — the restart NEVER re-runs the gate; the recorded decision is the authority and the crash-window PENDING operation row converges", async () => {
      const world = await freshWorld();
      const clean = world.boot(null);
      const candidateId = await driveTo(clean.service, world, "canary");
      // The dying process dies AFTER the canary → promoted transition
      // (the first transitionCandidateStatus invocation in THIS
      // process).
      const dying = world.boot({ method: "transitionCandidateStatus", when: "after" });
      await diesDuring(
        () =>
          dying.service.applyPromotion({
            applicationId: world.applicationId,
            tenantId: world.tenantId,
            candidateId,
            decidedBy: "architect-1",
          }),
        dying.crashed,
      );
      // Everything durable: the decision AND the promoted status; the
      // operation row is PENDING (the completion never ran).
      const state = await world.boot(null).service.getCandidate({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        candidateId,
      });
      expect(state.candidate.status).toBe("promoted");
      const decisionId = state.decisions[0]?.decisionId ?? "";
      const opKey = `dtr-promotion:${decisionId}`;
      expect((await operationRow(world.applicationId, opKey))?.status).toBe("pending");
      // RESTART: the top-level idempotent replay — the recorded
      // decision is the authority. The replay arm converges the
      // crash-window PENDING operation row.
      const restarted = world.boot(null);
      const outcome = await restarted.service.applyPromotion({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        candidateId,
        decidedBy: "architect-1",
      });
      expect(outcome.replayed).toBe(true);
      expect(outcome.decision.decisionId).toBe(decisionId);
      expect(outcome.decision.decidedBy).toBe("architect-1");
      // The operation row CONVERGED to completed (no stuck pending row).
      const converged = await operationRow(world.applicationId, opKey);
      expect(converged?.status).toBe("completed");
      expect(converged?.completed_at).not.toBeNull();
      // Exactly ONE promotion decision (the gate was never re-run into
      // a second decision).
      expect(
        await countRows(
          "deterministicization_decisions",
          world.applicationId,
          "AND decision_kind = 'promoted'",
        ),
      ).toBe(1);
    });

    test("P9 ROLLBACK: crash AFTER appendDecision — the rollback decision survives; the restart converges (exactly ONE rolled-back decision; the incumbent restoration is durable)", async () => {
      const world = await freshWorld();
      const clean = world.boot(null);
      const candidateId = await driveTo(clean.service, world, "promoted");
      const dying = world.boot({ method: "appendDecision", when: "after" });
      await diesDuring(
        () =>
          dying.service.rollbackCandidate({
            applicationId: world.applicationId,
            tenantId: world.tenantId,
            candidateId,
            rationale: "canary quality degraded after a corpus shift",
            decidedBy: "architect-1",
          }),
        dying.crashed,
      );
      // The rolled-back decision is durable; the candidate is still
      // 'promoted' (the tail did not land).
      expect(
        await countRows(
          "deterministicization_decisions",
          world.applicationId,
          "AND decision_kind = 'rolled-back'",
        ),
      ).toBe(1);
      const state = await world.boot(null).service.getCandidate({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        candidateId,
      });
      expect(state.candidate.status).toBe("promoted");
      const rolledBack = state.decisions.find((decision) => decision.kind === "rolled-back");
      expect(rolledBack?.incumbentRestoredTo).toBe("incumbent:generative-route@v1");
      const decisionId = rolledBack?.decisionId ?? "";
      const opKey = `dtr-rollback:${decisionId}`;
      expect((await operationRow(world.applicationId, opKey))?.status).toBe("pending");
      // RESTART converges: exactly one rolled-back decision; the
      // candidate is rolled back; the operation completes.
      const restarted = world.boot(null);
      const outcome = await restarted.service.rollbackCandidate({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        candidateId,
        rationale: "canary quality degraded after a corpus shift",
        decidedBy: "architect-1",
      });
      expect(outcome.decision.decisionId).toBe(decisionId);
      expect(
        await countRows(
          "deterministicization_decisions",
          world.applicationId,
          "AND decision_kind = 'rolled-back'",
        ),
      ).toBe(1);
      const resumed = await restarted.service.getCandidate({
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        candidateId,
      });
      expect(resumed.candidate.status).toBe("rolled-back");
      expect((await operationRow(world.applicationId, opKey))?.status).toBe("completed");
    });

    test("P10 DISCIPLINE: the operations ledger — pending-only attempts bump, terminal immutability, core immutability, no delete", async () => {
      const world = await freshWorld();
      const clean = world.boot(null);
      const { candidate } = await clean.service.proposeCandidate(world.proposalRequest());
      const candidateId = candidate.candidateId;
      const rows = await ctx.port.execute<Record<string, unknown>>({
        sql: `SELECT * FROM learning.deterministicization_operations
              WHERE application_id = $1 AND candidate_id = $2`,
        parameters: [world.applicationId, candidateId],
      });
      const operation = rows.rows[0];
      const operationId = String(operation?.id);
      const operationKey = String(operation?.operation_key);
      expect(operation?.status).toBe("completed");
      // A terminal row replays WITHOUT an attempts bump.
      const reClaim = await world.store.beginOperation({
        operationId: "00000000-0000-7000-b000-0000000000b1",
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        candidateId,
        operationKind: "candidate-registration",
        operationKey,
        createdAt: new Date().toISOString(),
      });
      expect(reClaim.status).toBe("existing");
      expect(reClaim.record.attempts).toBe(1);
      // Terminal immutability: no outcome rewrite on a COMPLETED row.
      await expect(
        ctx.port.execute({
          sql: `UPDATE learning.deterministicization_operations
                SET status = 'failed', failure_reason = 'rewrite attempt'
                WHERE id = $1`,
          parameters: [operationId],
        }),
      ).rejects.toThrow(/terminal-immutable/);
      // The identity core never moves.
      await expect(
        ctx.port.execute({
          sql: `UPDATE learning.deterministicization_operations
                SET operation_key = 'dtr-mutant:key'
                WHERE id = $1`,
          parameters: [operationId],
        }),
      ).rejects.toThrow(/identity core is immutable/);
      // Rows are never deleted.
      await expect(
        ctx.port.execute({
          sql: `DELETE FROM learning.deterministicization_operations WHERE id = $1`,
          parameters: [operationId],
        }),
      ).rejects.toThrow(/never deleted/);
      // The PENDING-only attempts bump: a fresh pending row bumps.
      const pendingInsert = await world.store.beginOperation({
        operationId: "00000000-0000-7000-b000-0000000000b2",
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        candidateId,
        operationKind: "stage-evidence",
        operationKey: "dtr-stage-evidence:pending-probe",
        createdAt: new Date().toISOString(),
      });
      expect(pendingInsert.status).toBe("begun");
      const bumped = await world.store.beginOperation({
        operationId: "00000000-0000-7000-b000-0000000000b3",
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        candidateId,
        operationKind: "stage-evidence",
        operationKey: "dtr-stage-evidence:pending-probe",
        createdAt: new Date().toISOString(),
      });
      expect(bumped.status).toBe("existing");
      expect(bumped.record.attempts).toBe(2);
    });
  });
});
