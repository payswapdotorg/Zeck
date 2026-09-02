/**
 * INHERITED EDGE-GATE STRESS REGRESSION (WORK-030; briefing B6 — the
 * required regression proof for the inherited defect fixed forward in
 * migration 0025).
 *
 * DEFECT (root-caused on the orchestrator's baseline stress runs, ~3 of
 * 11 runs failing): the migration-0024 BEFORE-INSERT trigger functions
 * `edge.ec_commands_sequence_gate` and `edge.es_observations_sequence_gate`
 * ran MULTIPLE separate SELECT statements (by-sequence existence, by-key
 * existence, then COUNT(*)); under READ COMMITTED each statement takes
 * its own snapshot, so one trigger invocation could observe the
 * PRE-commit snapshots for the existence checks and a POST-commit
 * snapshot for the COUNT — statement-snapshot tearing — raising the
 * spurious `command sequence must be gapless (expected 2, got 1)`
 * error instead of same-key convergence.
 *
 * FIX (migration 0025, forward-only CREATE OR REPLACE FUNCTION — 0024
 * never edited): each gate's lookups are collapsed into ONE statement
 * (a single SELECT of scalar subqueries), so every check sees one
 * snapshot; the decision logic and the error messages are unchanged
 * (semantics-preserving — the edge lifecycle/crash suites must stay
 * green, which they are).
 *
 * THIS SUITE is the stress pinner: it repeats the N=8 same-key
 * convergence ~15 times for commands and ~15 times for sensor
 * observations, concurrently. It is a PROBABILISTIC pinner (honestly
 * labeled): each iteration races 8 concurrent same-key INSERTs through
 * the gate — the torn-snapshot defect fired on roughly 3 of 11 such
 * races at baseline, so 15 iterations × 2 classes make a recurrence
 * overwhelmingly likely to fire here if the fix regressed. The
 * DETERMINISTIC proof of the fix is the single-statement collapse
 * itself (one snapshot per trigger invocation, by construction); this
 * suite pins that the observable behavior — every same-key racer
 * converging onto the ONE durable row, ZERO spurious gapless errors —
 * holds under sustained concurrency.
 */

import { describe, expect, test } from "vitest";
import { count, type EdgePgWorld, seedEdgeWorld } from "./edge-world";
import { definePgSuite, type PgContext } from "./harness";

const ITERATIONS = 15;
const CONCURRENCY = 8;

definePgSuite("edge sequence-gate stress regression (WORK-030 inherited fix)", (ctx: PgContext) => {
  let world: EdgePgWorld;

  const freshWorld = async () => {
    world = await seedEdgeWorld(ctx.port);
    return world;
  };

  const commandsOf = (deviceId: string) =>
    count(world.db, "SELECT 1 FROM edge.commands WHERE application_id = $1 AND device_id = $2", [
      world.applicationId,
      deviceId,
    ]);

  const observationsOf = (deviceId: string) =>
    count(
      world.db,
      "SELECT 1 FROM edge.sensor_observations WHERE application_id = $1 AND device_id = $2",
      [world.applicationId, deviceId],
    );

  test("N=8 same-key command submissions converge ~15 iterations in a row (the ec gate never tears)", async () => {
    const w = await freshWorld();
    // One running execution serves the whole stress loop.
    const executionId = await w.driveToRunning(w.boot(null).executions);
    for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
      // A fresh governed device + approved command request per
      // iteration (each device's gate sequence starts cold).
      const deviceId = await w.register();
      const { approvalId, envelopeId } = await w.approveEnvelope(executionId, deviceId);
      const request = w.commandRequest(executionId, deviceId, envelopeId);
      const commandApprovalId = await w.approveCommand(request);
      const key = `stress-command-${iteration}`;
      // THE RACE: 8 concurrent same-key submissions through the gate.
      const receipts = await Promise.all(
        Array.from({ length: CONCURRENCY }, () =>
          w.service.submitCommand({ ...request, approvalId: commandApprovalId }, key),
        ),
      );
      const ids = new Set(receipts.map((receipt) => receipt.commandId));
      expect(ids.size, `iteration ${iteration}: the same-key racers diverged`).toBe(1);
      expect(
        await commandsOf(deviceId),
        `iteration ${iteration}: the command journal did not converge`,
      ).toBe(1);
      expect(
        w.controller.journalLength(deviceId),
        `iteration ${iteration}: the actuation journal did not converge`,
      ).toBe(1);
      void approvalId;
    }
  });

  test("N=8 same-key sensor-observation ingests converge ~15 iterations in a row (the es gate never tears)", async () => {
    const w = await freshWorld();
    const executionId = await w.driveToRunning(w.boot(null).executions);
    for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
      const deviceId = await w.register();
      const input = {
        applicationId: w.applicationId,
        actor: w.actor(),
        executionId,
        deviceId,
        observationType: "telemetry",
        retention: "retained",
        content: `{"stress": ${iteration}, "battery": 0.82}`,
        observedAt: new Date().toISOString(),
      };
      const key = `stress-observation-${iteration}`;
      // THE RACE: 8 concurrent same-key observation ingests through the
      // gate (the digest-by-key check + the COUNT in ONE statement now).
      const receipts = await Promise.all(
        Array.from({ length: CONCURRENCY }, () => w.service.ingestSensorObservation(input, key)),
      );
      const ids = new Set(receipts.map((receipt) => receipt.id));
      expect(ids.size, `iteration ${iteration}: the same-key observations diverged`).toBe(1);
      expect(
        await observationsOf(deviceId),
        `iteration ${iteration}: the observation journal did not converge`,
      ).toBe(1);
    }
  });

  test("the replacement gates are semantics-preserving: the same decision logic still REJECTS the violations typed (by-sequence, key reuse, gapless)", async () => {
    // The semantics-preservation half of the fix disclosure: the
    // collapsed gates keep the EXACT decision logic and error
    // messages — direct inserts prove each branch still rejects typed.
    const w = await freshWorld();
    const executionId = await w.driveToRunning(w.boot(null).executions);
    const deviceId = await w.register();
    const { approvalId, envelopeId } = await w.approveEnvelope(executionId, deviceId);
    const request = w.commandRequest(executionId, deviceId, envelopeId);
    const commandApprovalId = await w.approveCommand(request);
    await w.service.submitCommand({ ...request, approvalId: commandApprovalId }, "semantics-1");
    // The full-column direct-insert shape (the raw gate surface).
    const insertCommand = (id: string, key: string, fingerprint: string, sequence: number) =>
      w.db.execute({
        sql: `INSERT INTO edge.commands (id, application_id, tenant_id, execution_id, device_id,
             envelope_id, command_key, request_fingerprint, sequence, command_kind, effect_class,
             channel, magnitude, payload_digest, not_before, not_after, status, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'actuate', 'physical-write', 'signal', 10,
             repeat('0', 64), now() - interval '1 hour', now() + interval '1 hour', 'authorized', now())`,
        parameters: [
          id,
          w.applicationId,
          w.tenantId,
          executionId,
          deviceId,
          envelopeId,
          key,
          fingerprint,
          sequence,
        ],
      });
    // 1. A DIFFERENT key at the existing sequence 1 is rejected typed
    //    (the gate's by-sequence branch).
    await expect(
      insertCommand("00000000-0000-7000-8000-0000000000a1", "semantics-alt-1", "fp-alt-1", 1),
    ).rejects.toThrow(/command sequence 1 already exists with a different key/);
    // 2. The SAME command key with a DIFFERENT request fingerprint is
    //    rejected typed (the gate's key-reuse branch).
    await expect(
      insertCommand("00000000-0000-7000-8000-0000000000a2", "semantics-1", "fp-different", 2),
    ).rejects.toThrow(
      /edge command key semantics-1 was already used with a different request \(key reuse\)/,
    );
    // 3. A genuinely gapped sequence is rejected typed (the gapless
    //    branch).
    await expect(
      insertCommand("00000000-0000-7000-8000-0000000000a3", "semantics-gap", "fp-gap", 3),
    ).rejects.toThrow(/command sequence must be gapless \(expected 2, got 3\)/);
    // And the journal still holds exactly the ONE converged command.
    expect(await commandsOf(deviceId)).toBe(1);
  });
});
