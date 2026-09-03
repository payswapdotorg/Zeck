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
 *
 * ROUND 5 (the first complete-gate run at c42c2ff caught a SECOND,
 * sibling defect — root-caused from the PostgreSQL server log): a
 * same-key racer that reuses the CRASH-STABLE STAGED COMMAND ID (the
 * identity checkpointed on the durable operation, so the wallet
 * reservation keyed by it converges across retries) collides on the
 * edge.commands PRIMARY KEY before the (application_id, command_key)
 * arbiter is consulted — ON CONFLICT with an explicit arbiter does not
 * suppress a non-arbiter unique violation — surfacing the keyed
 * convergence as a hard `commands_pkey` error. The store's
 * insertCommand now treats the identity-carrying indexes
 * (commands_pkey / ec_identity_unique) as the keyed-convergence path
 * (fall through to the keyed re-read, which arbitrates the
 * fingerprint); the deterministic fourth test below pins the exact
 * mechanism, and the N=8 stress loop above exercises it under
 * sustained concurrency (every post-checkpoint racer reuses the
 * staged id).
 */

import { expect, test } from "vitest";
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
        observationType: "telemetry" as const,
        retention: "retained" as const,
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

  test("the crash-stable staged command id converges by key when the same-key row already claimed it (the commands_pkey collision — DETERMINISTIC)", async () => {
    // The round-5 defect (found by the first complete-gate run at
    // c42c2ff, root-caused from the PostgreSQL server log): a same-key
    // racer that reuses the checkpointed command id (the crash-stable
    // identity staged on the durable operation) collides on the
    // PRIMARY KEY before the (application_id, command_key) arbiter is
    // consulted — ON CONFLICT with an explicit arbiter does NOT
    // suppress a non-arbiter unique violation — so the keyed
    // convergence surfaced as a hard `commands_pkey` error (mis-typed
    // as key reuse). This is the DETERMINISTIC pinner of the
    // mechanism: the staged-id insert shape replayed against the
    // committed same-key row must converge by key.
    const w = await freshWorld();
    const executionId = await w.driveToRunning(w.boot(null).executions);
    const deviceId = await w.register();
    const { envelopeId } = await w.approveEnvelope(executionId, deviceId);
    const request = w.commandRequest(executionId, deviceId, envelopeId);
    const commandApprovalId = await w.approveCommand(request);
    await w.service.submitCommand({ ...request, approvalId: commandApprovalId }, "staged-id-1");
    const committed = await w.store.findCommandByKey(w.applicationId, "staged-id-1");
    expect(committed).not.toBeNull();
    if (committed === null) {
      return;
    }
    // The racer's physical insert shape: the SAME staged id, the SAME
    // key, the SAME fingerprint, AFTER the first insert committed.
    // The speculative insert checks the unique indexes in index order,
    // so commands_pkey fires before the key arbiter; the store must
    // converge by key (the in-memory twin's by-key-first semantics),
    // never raise.
    const racerInsert = (overrides: { commandId?: string; requestFingerprint?: string }) => ({
      commandId: committed.id,
      applicationId: committed.applicationId,
      tenantId: committed.tenantId,
      executionId: committed.executionId,
      deviceId: committed.deviceId,
      envelopeId: committed.envelopeId,
      commandKey: committed.commandKey,
      requestFingerprint: committed.requestFingerprint,
      sequence: committed.sequence,
      commandKind: committed.commandKind,
      effectClass: committed.effectClass,
      channel: committed.channel,
      magnitude: committed.magnitude,
      payloadDigest: committed.payloadDigest,
      estimatedMicroUsd: committed.estimatedMicroUsd,
      notBefore: committed.notBefore,
      notAfter: committed.notAfter,
      approvalId: committed.approvalId,
      denialClass: null,
      denialReason: null,
      requestedAt: committed.createdAt,
      ...overrides,
    });
    const replay = await w.store.insertCommand(racerInsert({}));
    expect(replay.status).toBe("existing");
    if (replay.status === "existing") {
      expect(replay.fingerprintMismatch).toBe(false);
      expect(replay.record.id).toBe(committed.id);
    }
    // The convergence catch cannot mask a fingerprint violation. (The
    // gate's by-sequence branch passes this same-key/same-sequence
    // shape through before the fingerprint check, so the physical
    // convergence path — the commands_pkey collision — must surface
    // the mismatch itself; the SERVICE turns it into the typed
    // IDEMPOTENCY_KEY_REUSED key-reuse rejection, pinned in the edge
    // lifecycle suite. The different-SEQUENCE key-reuse shape is
    // rejected typed by the gate itself — the third test below.)
    const mismatched = await w.store.insertCommand(
      racerInsert({ requestFingerprint: `${committed.requestFingerprint}x` }),
    );
    expect(mismatched.status).toBe("existing");
    if (mismatched.status === "existing") {
      expect(mismatched.fingerprintMismatch).toBe(true);
    }
    // A fresh-id same-key racer still converges through the arbiter
    // (the pre-existing physical discipline, unchanged by the fix).
    const freshId = await w.store.insertCommand(
      racerInsert({ commandId: "00000000-0000-7000-8000-0000000000f1" }),
    );
    expect(freshId.status).toBe("existing");
    // And the journal still holds exactly the ONE converged command.
    expect(await commandsOf(deviceId)).toBe(1);
  });

  test("the replacement gates are semantics-preserving: the same decision logic still REJECTS the violations typed (by-sequence, key reuse, gapless)", async () => {
    // The semantics-preservation half of the fix disclosure: the
    // collapsed gates keep the EXACT decision logic and error
    // messages — direct inserts prove each branch still rejects typed.
    const w = await freshWorld();
    const executionId = await w.driveToRunning(w.boot(null).executions);
    const deviceId = await w.register();
    const { envelopeId } = await w.approveEnvelope(executionId, deviceId);
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
