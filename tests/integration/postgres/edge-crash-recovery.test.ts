/**
 * Real-PostgreSQL crash-injection proofs — the PHYSICAL half of the
 * CONCURRENCY-CRASH-SAFETY checkpoint contract for the governed edge
 * fabric (WORK-029; EDGE-001/002/003; the blocking checkpoints
 * SELF-HOSTING-BOUNDARY + EXECUTION-PROVENANCE).
 *
 * The unit suite (tests/unit/integrations/edge-crash-recovery.test.ts,
 * C1–C14) proves the behavioral half over the in-memory world. THIS
 * suite proves the kill/restart discipline against REAL PostgreSQL
 * (migrations 0001..0024): every authority is REAL and SURVIVES the
 * process death (the WORK-007 policy engine, the WORK-005 capability
 * registry, the WORK-004 budgets SQL wallet and the FROZEN executions
 * module with the canonical EventEnvelope ledger). The world's
 * `boot(point)` primitive arms ONE durable-boundary crash point per
 * booted process (before/after the durable commit or the external
 * effect); the process dies mid-flight and a re-booted service over
 * the SAME PG store must converge with EXACTLY ONE durable row /
 * ledger event / wallet mutation / actuation per stable idempotency
 * key. The simulated controller is the DURABLE external substrate (a
 * real local controller outlives the Zeck process): its keyed
 * external-effects journal converges re-submissions across process
 * death — exactly one external effect per stable key.
 *
 * THE PROOF RECORDS (the required critical boundaries):
 *   DEVICE REGISTER   P1 crash-after the durable device insert → the
 *                     restart replays the SAME identity (one row)
 *   DEVICE REVOKE     P2 crash-after the guarded terminal device
   mutation → the
 *                     restart converges (revoked exactly once)
 *   FAIL-SAFE         P3 crash-after the envelope revocation, BEFORE
 *                     the local controller withdrawal → the restart
 *                     converges the withdrawal (the device-side
 *                     authority is withdrawn — zero further dispatch)
 *   APPROVAL          P4 crash-after the approval insert, before the
 *                     wait-human transition → the restart converges it
 *                     (one approval row, one transition, WAITING_HUMAN)
 *   APPROVAL DECIDE   P5 crash-after the terminal decision, before the
 *                     resume → the restart converges the resume
 *   ENVELOPE ADMIT    P6 crash-after the durable insert, before the
 *                     projection → the restart converges (one row, the
 *                     local controller holds the admitted authority)
 *   SUPERSEDE         P7 crash-after the new insert, before the
 *                     supersede move → the restart converges (old
 *                     superseded exactly once, new active, both
 *                     projections exactly once)
 *   COMMAND SUBMIT    P8 crash-after the durable authorized insert,
 *                     before the external dispatch → the restart
 *                     dispatches the ONE-SHOT effect exactly once
 *   COMMAND ACTUATION P9 crash-after the external actuation (the
 *                     controller journal holds it), before the durable
 *                     finalize → the restart converges dispatched with
 *                     the SAME digest, ZERO further actuation
 *   COMMAND LEDGER    P10 crash-after the canonical ledger intent →
 *                     the restart converges the binding (one intent
 *                     event, one result event, both bound)
 *   BUDGET            P11 crash-after the wallet reservation, before
 *                     the durable command row → the restart converges
 *                     onto the SAME command identity (ONE physical
 *                     reservation row)
 *   RECONCILE         P12 crash-after the settlement, before the
 *                     reconciliation record → the restart converges
 *                     (settled EXACTLY ONCE, ONE actuation event row,
 *                     ONE reconciliation row)
 *   SENSOR            P13 crash-after the durable observation insert,
 *                     before the ledger event → the restart converges
 *                     (one row, the ledger sequence bound)
 */

import { describe, expect, test } from "vitest";
import { count, diesDuring, type EdgePgWorld, one, seedEdgeWorld } from "./edge-world";
import { definePgSuite, type PgContext } from "./harness";

definePgSuite("edge crash-injection proofs (WORK-029) on real PostgreSQL", (ctx: PgContext) => {
  let world: EdgePgWorld;

  const freshWorld = async () => {
    world = await seedEdgeWorld(ctx.port);
    return world;
  };

  // ---- durable-state counters (the physical side-effect proofs) ----

  const devicesOf = () =>
    count(world.db, "SELECT 1 FROM edge.devices WHERE application_id = $1", [world.applicationId]);

  const commandsOf = (deviceId: string) =>
    count(world.db, "SELECT 1 FROM edge.commands WHERE application_id = $1 AND device_id = $2", [
      world.applicationId,
      deviceId,
    ]);

  const envelopesOf = (deviceId: string) =>
    count(world.db, "SELECT 1 FROM edge.envelopes WHERE application_id = $1 AND device_id = $2", [
      world.applicationId,
      deviceId,
    ]);

  const actuationEventsOf = (deviceId: string) =>
    count(
      world.db,
      "SELECT 1 FROM edge.actuation_events WHERE application_id = $1 AND device_id = $2",
      [world.applicationId, deviceId],
    );

  const reconciliationsOf = (deviceId: string) =>
    count(
      world.db,
      "SELECT 1 FROM edge.reconciliations WHERE application_id = $1 AND device_id = $2",
      [world.applicationId, deviceId],
    );

  const sensorObservationsOf = (deviceId: string) =>
    count(
      world.db,
      "SELECT 1 FROM edge.sensor_observations WHERE application_id = $1 AND device_id = $2",
      [world.applicationId, deviceId],
    );

  const reservationsOf = () =>
    count(
      world.db,
      "SELECT 1 FROM budgets.reservations r JOIN budgets.wallets w ON w.id = r.wallet_id WHERE w.application_id = $1",
      [world.applicationId],
    );

  const commandRow = (commandKey: string) =>
    one<{
      id: string;
      status: string;
      dispatch_digest: string | null;
      ledger_requested_sequence: number | null;
      ledger_result_sequence: number | null;
    }>(world.db, "SELECT * FROM edge.commands WHERE application_id = $1 AND command_key = $2", [
      world.applicationId,
      commandKey,
    ]);

  const commandEvents = (commandId: string) =>
    count(
      world.db,
      "SELECT 1 FROM executions.execution_events WHERE application_id = $1 AND payload->>'commandId' = $2",
      [world.applicationId, commandId],
    );

  const envelopeless = (): string => {
    throw new Error("the crashed envelope row is missing");
  };

  const governed = async () => {
    const executionId = await world.driveToRunning(world.boot(null).executions);
    const deviceId = await world.register();
    const { envelopeId } = await world.approveEnvelope(executionId, deviceId);
    return { executionId, deviceId, envelopeId };
  };

  describe("device identity + fail-safe convergence", () => {
    test("P1 device-register: crash-after the durable insert converges onto the SAME identity", async () => {
      world = await freshWorld();
      const dying = world.boot({ target: "store", method: "insertDevice", when: "after" });
      await diesDuring(
        () => dying.service.registerDevice(world.deviceRegistration(), "p1-device"),
        dying.crashed,
      );
      expect(await devicesOf()).toBe(1);
      const receipt = await world.service.registerDevice(world.deviceRegistration(), "p1-device");
      expect(receipt.replayed).toBe(true);
      expect(await devicesOf()).toBe(1);
    });

    test("P2 device-revoke: crash-after the guarded terminal mutation converges", async () => {
      world = await freshWorld();
      const { deviceId } = await governed();
      const dying = world.boot({
        target: "store",
        method: "applyGuardedDeviceRevocation",
        when: "after",
      });
      await diesDuring(
        () =>
          dying.service.revokeDevice(
            {
              applicationId: world.applicationId,
              actor: world.actor(),
              deviceId,
              reason: "p2 crash-window revocation",
            },
            "p2-revoke",
          ),
        dying.crashed,
      );
      const receipt = await world.service.revokeDevice(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          deviceId,
          reason: "p2 crash-window revocation",
        },
        "p2-revoke",
      );
      expect(receipt.status).toBe("revoked");
      expect(receipt.replayed).toBe(true);
      const row = await one<{ status: string }>(
        world.db,
        "SELECT status FROM edge.devices WHERE id = $1",
        [deviceId],
      );
      expect(row?.status).toBe("revoked");
    });

    test("P3 device-revoke fail-safe: crash-before the controller withdrawal converges the projection", async () => {
      world = await freshWorld();
      const { deviceId, envelopeId } = await governed();
      const dying = world.boot({
        target: "controller",
        method: "applyEnvelope",
        when: "before",
      });
      await diesDuring(
        () =>
          dying.service.revokeDevice(
            {
              applicationId: world.applicationId,
              actor: world.actor(),
              deviceId,
              reason: "p3 fail-safe crash window",
            },
            "p3-revoke",
          ),
        dying.crashed,
      );
      // Durably revoked; the local controller was never told.
      const envelope = await one<{ status: string }>(
        world.db,
        "SELECT status FROM edge.envelopes WHERE id = $1",
        [envelopeId],
      );
      expect(envelope?.status).toBe("revoked");
      expect(world.controller.activeEnvelopeId(deviceId)).toBe(envelopeId);
      // The restart converges the withdrawal: the device-side authority
      // is withdrawn keyed exactly-once.
      await world.service.revokeDevice(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          deviceId,
          reason: "p3 fail-safe crash window",
        },
        "p3-revoke-replay",
      );
      expect(world.controller.activeEnvelopeId(deviceId)).toBeNull();
      expect(world.controller.journalLength(deviceId)).toBe(0);
    });
  });

  describe("approval human-gate convergence", () => {
    test("P4 approval-request: crash-after the insert converges the wait-human transition", async () => {
      world = await freshWorld();
      const executionId = await world.driveToRunning(world.boot(null).executions);
      const deviceId = await world.register();
      const dying = world.boot({ target: "store", method: "insertApproval", when: "after" });
      const request = {
        applicationId: world.applicationId,
        actor: world.actor(),
        executionId,
        deviceId,
        subjectKind: "envelope" as const,
        subjectFingerprint: "p4-subject-fingerprint",
        policyBasis: "p4 basis",
        expiresAt: null,
      };
      await diesDuring(() => dying.service.requestApproval(request, "p4-approval"), dying.crashed);
      const replay = await world.service.requestApproval(request, "p4-approval");
      expect(replay.replayed).toBe(true);
      const row = await one<{ status: string; ledger_wait_sequence: number | null }>(
        world.db,
        "SELECT * FROM edge.approvals WHERE application_id = $1 AND approval_key = $2",
        [world.applicationId, "p4-approval"],
      );
      expect(row?.status).toBe("pending");
      expect(row?.ledger_wait_sequence).not.toBeNull();
      const execution = await one<{ status: string }>(
        world.db,
        "SELECT status FROM executions.executions WHERE id = $1",
        [executionId],
      );
      expect(execution?.status).toBe("WAITING_HUMAN");
    });

    test("P5 approval-decide: crash-after the decision converges the resume", async () => {
      world = await freshWorld();
      const executionId = await world.driveToRunning(world.boot(null).executions);
      const deviceId = await world.register();
      const approval = await world.service.requestApproval(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          executionId,
          deviceId,
          subjectKind: "envelope",
          subjectFingerprint: "p5-subject-fingerprint",
          policyBasis: "p5 basis",
          expiresAt: null,
        },
        "p5-approval",
      );
      const dying = world.boot({
        target: "store",
        method: "applyApprovalDecision",
        when: "after",
      });
      const decision = {
        applicationId: world.applicationId,
        actor: world.actor(),
        approvalId: approval.approvalId,
        approverId: world.approverId,
        decision: "approved" as const,
        rationale: "p5 operator approval",
      };
      await diesDuring(() => dying.service.decideApproval(decision, "p5-decide"), dying.crashed);
      const replay = await world.service.decideApproval(decision, "p5-decide-replay");
      expect(replay.replayed).toBe(true);
      const row = await one<{
        status: string;
        decision: string | null;
        ledger_resume_sequence: number | null;
      }>(world.db, "SELECT * FROM edge.approvals WHERE application_id = $1 AND approval_key = $2", [
        world.applicationId,
        "p5-approval",
      ]);
      expect(row?.status).toBe("approved");
      expect(row?.decision).toBe("approved");
      expect(row?.ledger_resume_sequence).not.toBeNull();
      const execution = await one<{ status: string }>(
        world.db,
        "SELECT status FROM executions.executions WHERE id = $1",
        [executionId],
      );
      expect(execution?.status).toBe("RUNNING");
    });
  });

  describe("envelope admission + supersede convergence", () => {
    test("P6 envelope-admit: crash-after the insert converges the controller projection", async () => {
      world = await freshWorld();
      const executionId = await world.driveToRunning(world.boot(null).executions);
      const deviceId = await world.register();
      const content = world.defaultEnvelopeContent();
      const dying = world.boot({ target: "store", method: "insertEnvelope", when: "after" });
      await diesDuring(
        () =>
          world.approveEnvelope(executionId, deviceId, content, {
            service: dying.service,
          }),
        dying.crashed,
      );
      // The durable row exists; the local controller was never told.
      expect(await envelopesOf(deviceId)).toBe(1);
      expect(world.controller.activeEnvelopeId(deviceId)).toBeNull();
      // The restart (same envelope key) converges the projection — the
      // local controller holds the admitted authority exactly once.
      const crashedRow = await one<{ id: string; envelope_key: string }>(
        world.db,
        "SELECT * FROM edge.envelopes WHERE application_id = $1 AND device_id = $2",
        [world.applicationId, deviceId],
      );
      expect(crashedRow).not.toBeNull();
      const replay = await world.service.admitEnvelope(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          executionId,
          deviceId,
          content,
          costCeilingMicroUsd: "1000000",
          approvalId: "pending",
          supersedesEnvelopeId: null,
        },
        crashedRow?.envelope_key ?? "missing-envelope-key",
      );
      expect(replay.replayed).toBe(true);
      expect(replay.envelopeId).toBe(crashedRow?.id);
      expect(world.controller.activeEnvelopeId(deviceId)).toBe(crashedRow?.id);
      // The physical proof that the envelope's authority works: one
      // dispatched command, one actuation.
      const request = world.commandRequest(executionId, deviceId, crashedRow?.id ?? envelopeless());
      const approvalId = await world.approveCommand(request);
      const receipt = await world.service.submitCommand({ ...request, approvalId }, "p6-command");
      expect(receipt.status).toBe("dispatched");
      expect(world.controller.journalLength(deviceId)).toBe(1);
    });

    test("P7 envelope-supersede: crash-after the new insert converges the supersede", async () => {
      world = await freshWorld();
      const { executionId, deviceId, envelopeId } = await governed();
      const newContent = world.defaultEnvelopeContent({ maxCommands: 20 });
      const dying = world.boot({ target: "store", method: "insertEnvelope", when: "after" });
      await diesDuring(
        () =>
          world.approveEnvelope(executionId, deviceId, newContent, {
            supersedesEnvelopeId: envelopeId,
            service: dying.service,
          }),
        dying.crashed,
      );
      expect(await envelopesOf(deviceId)).toBe(2);
      // The restart (the same envelope key) converges: old superseded,
      // new active, both projections exactly once.
      const pendingRow = await one<{ id: string; envelope_key: string; status: string }>(
        world.db,
        "SELECT * FROM edge.envelopes WHERE application_id = $1 AND device_id = $2 AND supersedes_envelope_id = $3",
        [world.applicationId, deviceId, envelopeId],
      );
      expect(pendingRow).not.toBeNull();
      const converged = await world.service.admitEnvelope(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          executionId,
          deviceId,
          content: newContent,
          costCeilingMicroUsd: "1000000",
          approvalId: "pending",
          supersedesEnvelopeId: envelopeId,
        },
        pendingRow?.envelope_key ?? "missing-envelope-key",
      );
      expect(converged.replayed).toBe(true);
      const oldRow = await one<{ status: string; superseded_by_envelope_id: string | null }>(
        world.db,
        "SELECT * FROM edge.envelopes WHERE id = $1",
        [envelopeId],
      );
      expect(oldRow?.status).toBe("superseded");
      expect(oldRow?.superseded_by_envelope_id).toBe(pendingRow?.id);
      expect(world.controller.activeEnvelopeId(deviceId)).toBe(pendingRow?.id);
      expect(await envelopesOf(deviceId)).toBe(2);
    });
  });

  describe("command submission + actuation convergence", () => {
    test("P8 command-submit: crash-after the durable insert, before the dispatch", async () => {
      world = await freshWorld();
      const { executionId, deviceId, envelopeId } = await governed();
      const request = world.commandRequest(executionId, deviceId, envelopeId);
      const approvalId = await world.approveCommand(request);
      const dying = world.boot({ target: "store", method: "insertCommand", when: "after" });
      await diesDuring(
        () => dying.service.submitCommand({ ...request, approvalId }, "p8-command"),
        dying.crashed,
      );
      expect(await commandsOf(deviceId)).toBe(1);
      expect(world.controller.journalLength(deviceId)).toBe(0);
      const receipt = await world.service.submitCommand({ ...request, approvalId }, "p8-command");
      expect(receipt.status).toBe("dispatched");
      expect(await commandsOf(deviceId)).toBe(1);
      expect(world.controller.journalLength(deviceId)).toBe(1);
    });

    test("P9 command-submit: crash-after the external actuation, before the finalize", async () => {
      world = await freshWorld();
      const { executionId, deviceId, envelopeId } = await governed();
      const request = world.commandRequest(executionId, deviceId, envelopeId);
      const approvalId = await world.approveCommand(request);
      const dying = world.boot({
        target: "controller",
        method: "dispatchCommand",
        when: "after",
      });
      await diesDuring(
        () => dying.service.submitCommand({ ...request, approvalId }, "p9-command"),
        dying.crashed,
      );
      // The external actuation happened ONCE (the durable substrate's
      // journal); the durable row never finalized.
      expect(world.controller.journalLength(deviceId)).toBe(1);
      const midRow = await commandRow("p9-command");
      expect(midRow?.status).toBe("authorized");
      const receipt = await world.service.submitCommand({ ...request, approvalId }, "p9-command");
      expect(receipt.status).toBe("dispatched");
      expect(receipt.dispatchDigest).not.toBeNull();
      // The keyed external effect converged: NO second actuation.
      expect(world.controller.journalLength(deviceId)).toBe(1);
      const row = await commandRow("p9-command");
      expect(row?.status).toBe("dispatched");
      expect(row?.dispatch_digest).toBe(receipt.dispatchDigest);
    });

    test("P10 command-ledger: crash-after the canonical ledger intent converges the binding", async () => {
      world = await freshWorld();
      const { executionId, deviceId, envelopeId } = await governed();
      const request = world.commandRequest(executionId, deviceId, envelopeId);
      const approvalId = await world.approveCommand(request);
      const dying = world.boot({
        target: "executions",
        method: "recordStepEvent",
        when: "after",
      });
      await diesDuring(
        () => dying.service.submitCommand({ ...request, approvalId }, "p10-command"),
        dying.crashed,
      );
      const receipt = await world.service.submitCommand({ ...request, approvalId }, "p10-command");
      expect(receipt.status).toBe("dispatched");
      const row = await commandRow("p10-command");
      expect(row?.ledger_requested_sequence).not.toBeNull();
      expect(row?.ledger_result_sequence).not.toBeNull();
      // The command's ledger evidence exists EXACTLY ONCE per phase.
      expect(await commandEvents(receipt.commandId)).toBe(2);
      void executionId;
    });

    test("P11 budget: crash-after the wallet reservation converges onto the SAME command", async () => {
      world = await freshWorld();
      const executionId = await world.driveToRunning(world.boot(null).executions);
      const deviceId = await world.register();
      const { envelopeId } = await world.approveEnvelope(executionId, deviceId, undefined, {
        costCeilingMicroUsd: "1000000",
      });
      const request = world.commandRequest(executionId, deviceId, envelopeId, {
        estimatedMicroUsd: "250000",
      });
      const approvalId = await world.approveCommand(request);
      const dying = world.boot({ target: "budgets", method: "reserve", when: "after" });
      await diesDuring(
        () => dying.service.submitCommand({ ...request, approvalId }, "p11-command"),
        dying.crashed,
      );
      // ONE physical reservation survived the crash.
      expect(await reservationsOf()).toBe(1);
      const receipt = await world.service.submitCommand({ ...request, approvalId }, "p11-command");
      expect(receipt.status).toBe("dispatched");
      // The keyed reservation converged — STILL exactly one row.
      expect(await reservationsOf()).toBe(1);
      const row = await commandRow("p11-command");
      expect(row?.id).toBe(receipt.commandId);
    });
  });

  describe("reconciliation + sensor convergence", () => {
    test("P12 reconcile: crash-after the settlement converges without double settlement", async () => {
      world = await freshWorld();
      const { executionId, deviceId, envelopeId } = await governed();
      const request = world.commandRequest(executionId, deviceId, envelopeId);
      const approvalId = await world.approveCommand(request);
      const command = await world.service.submitCommand({ ...request, approvalId }, "p12-command");
      expect(command.status).toBe("dispatched");
      const dying = world.boot({ target: "store", method: "settleCommand", when: "after" });
      await diesDuring(
        () =>
          dying.service.reconcile(
            { applicationId: world.applicationId, actor: world.actor(), deviceId },
            "p12-reconcile",
          ),
        dying.crashed,
      );
      // The settlement is durable; the reconciliation record is not.
      const midRow = await commandRow("p12-command");
      expect(midRow?.status).toBe("settled");
      expect(await reconciliationsOf(deviceId)).toBe(0);
      // The restart converges: settled EXACTLY ONCE (no re-settle, one
      // commanded actuation evidence row, ONE reconciliation row).
      const receipt = await world.service.reconcile(
        { applicationId: world.applicationId, actor: world.actor(), deviceId },
        "p12-reconcile-replay",
      );
      expect(receipt.status).toBe("converged");
      expect(receipt.settledCount).toBe(0);
      expect(await actuationEventsOf(deviceId)).toBe(1);
      expect(await reconciliationsOf(deviceId)).toBe(1);
      const row = await commandRow("p12-command");
      expect(row?.status).toBe("settled");
    });

    test("P13 sensor-ingest: crash-after the durable insert converges the ledger event", async () => {
      world = await freshWorld();
      const { executionId, deviceId } = await governed();
      const dying = world.boot({
        target: "store",
        method: "insertSensorObservation",
        when: "after",
      });
      const input = {
        applicationId: world.applicationId,
        actor: world.actor(),
        executionId,
        deviceId,
        observationType: "telemetry" as const,
        retention: "retained" as const,
        content: '{"p13": true}',
        observedAt: new Date().toISOString(),
      };
      await diesDuring(
        () => dying.service.ingestSensorObservation(input, "p13-sensor"),
        dying.crashed,
      );
      expect(await sensorObservationsOf(deviceId)).toBe(1);
      const record = await world.service.ingestSensorObservation(input, "p13-sensor");
      expect(record.ledgerSequence).not.toBeNull();
      expect(await sensorObservationsOf(deviceId)).toBe(1);
    });
  });
});
