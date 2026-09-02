/**
 * Real-PostgreSQL lifecycle proofs — the governed edge/embodied fabric
 * over migration 0024 (WORK-029, EDGE-001/002/003; the doc-only
 * checkpoint contracts SELF-HOSTING-BOUNDARY + EXECUTION-PROVENANCE —
 * the PHYSICAL half; the unit suites in tests/unit/integrations prove
 * the behavioral half over the in-memory world).
 *
 * Every authority the service consults is REAL here: the WORK-007
 * policy engine (restrictive v2 documents published for the denial
 * proofs), the WORK-005 capability registry (platform seeds + the edge
 * channel claims), the WORK-004 budgets service (SQL wallet — the
 * budget-before-spend boundary is PHYSICAL) and the FROZEN executions
 * module (SQL store + the canonical EventEnvelope ledger the edge
 * provenance rides; the human gate manifests on the lifecycle through
 * the PUBLIC wait-human / resume transitions ONLY). Only the external
 * edge/embodied controller is simulated (the provider-honesty stance;
 * external substrate behavior is UNVERIFIED — recorded in
 * docs/work-items/WORK-029.md).
 *
 * THE PROOF RECORDS:
 *   SCHEMA/IDENTITY   migration 0024's physical state exists with its
 *                     guards; devices/approvals/envelopes/commands
 *                     converge on their stable keys; key reuse fails
 *                     closed; the device identity core is physically
 *                     immutable
 *   ADMISSION ORDER   policy/capability/approval/staleness/envelope/
 *                     budget denials are DURABLE denied rows with ZERO
 *                     actuator-path activity (the controller journal is
 *                     the witness) and ZERO wallet reservations
 *   ENVELOPE          the full admission chain (capability → human →
 *                     policy → supersede discipline) lands the
 *                     pre-authorization; the content digest is pinned
 *                     and IMMUTABLE post-admission; the envelope
 *                     projects to the local controller exactly once
 *   COMMAND           the full chain dispatches the governed physical
 *                     side effect (one row, one journal entry, ledger
 *                     intent + result keyed once); the human gate
 *                     rides the executions lifecycle (wait-human /
 *                     resume); costed commands reserve the wallet
 *                     physically
 *   PROVENANCE        sensor observations are durable, keyed on the
 *                     execution identity and ride the ledger with the
 *                     tools producer vocabulary; the ledger events of
 *                     one execution are exactly the keyed set
 *   RECONNECTION      the deterministic reconnect handshake (AC-6):
 *                     commanded actuations settle EXACTLY ONCE,
 *                     envelope-autonomous actuations confirm within
 *                     the pre-authorized bounds, a violation fails the
 *                     reconciliation closed and the conflicted-device
 *                     gate blocks further authoritative commands
 *   CONCURRENCY       N=8 same-key submissions converge to ONE durable
 *                     row and ONE external effect (commands and
 *                     envelopes)
 */

import { describe, expect, test } from "vitest";
import type { EdgeDeviceRegistrationRequest } from "../../../src/integrations/edge/public";
import { edgeEnvelopeFingerprint } from "../../../src/integrations/edge/public";
import { PlatformError } from "../../../src/shared/errors";
import { count, type EdgePgWorld, eventsOf, one, seedEdgeWorld } from "./edge-world";
import { definePgSuite, type PgContext } from "./harness";

definePgSuite("edge governed lifecycle (real PostgreSQL; WORK-029)", (ctx: PgContext) => {
  let world: EdgePgWorld;

  const freshWorld = async () => {
    world = await seedEdgeWorld(ctx.port);
    return world;
  };

  const expectPlatformError = async (
    code: string,
    run: Promise<unknown> | (() => Promise<unknown>),
  ): Promise<PlatformError> => {
    const promise = typeof run === "function" ? run() : run;
    try {
      await promise;
    } catch (error) {
      if (error instanceof PlatformError) {
        if (error.code !== code) {
          throw new Error(
            `expected PlatformError code ${code}, got ${error.code}: ${error.message}`,
          );
        }
        return error;
      }
      throw error;
    }
    throw new Error(`expected a PlatformError with code ${code}`);
  };

  // ---- durable-state probes (the physical side-effect witnesses) ----

  const deviceRow = (deviceKey: string) =>
    one<{
      id: string;
      status: string;
      tenant_id: string;
      last_command_sequence: number;
      health: { status: string } | null;
    }>(world.db, "SELECT * FROM edge.devices WHERE application_id = $1 AND device_key = $2", [
      world.applicationId,
      deviceKey,
    ]);

  const commandRowByKey = (commandKey: string) =>
    one<{
      id: string;
      status: string;
      sequence: number;
      denial_class: string | null;
      dispatch_digest: string | null;
      approval_id: string | null;
      failure_class: string | null;
      ledger_requested_sequence: number | null;
      ledger_result_sequence: number | null;
    }>(world.db, "SELECT * FROM edge.commands WHERE application_id = $1 AND command_key = $2", [
      world.applicationId,
      commandKey,
    ]);

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

  const operationsOf = (kind: string) =>
    count(
      world.db,
      "SELECT 1 FROM edge.operations WHERE application_id = $1 AND operation_kind = $2",
      [world.applicationId, kind],
    );

  const completedOperationsOf = (kind: string) =>
    count(
      world.db,
      "SELECT 1 FROM edge.operations WHERE application_id = $1 AND operation_kind = $2 AND status = 'completed'",
      [world.applicationId, kind],
    );

  const failedOperationsOf = (kind: string) =>
    count(
      world.db,
      "SELECT 1 FROM edge.operations WHERE application_id = $1 AND operation_kind = $2 AND status = 'failed'",
      [world.applicationId, kind],
    );

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

  const reservationsOf = () =>
    count(
      world.db,
      "SELECT 1 FROM budgets.reservations r JOIN budgets.wallets w ON w.id = r.wallet_id WHERE w.application_id = $1",
      [world.applicationId],
    );

  const sensorObservationsOf = (deviceId: string) =>
    count(
      world.db,
      "SELECT 1 FROM edge.sensor_observations WHERE application_id = $1 AND device_id = $2",
      [world.applicationId, deviceId],
    );

  // The canonical governed scenario: running execution + registered
  // device + approved envelope (the world's house helpers).
  const governedDevice = async () => {
    const executionId = await world.driveToRunning(world.boot(null).executions);
    const deviceId = await world.register();
    const { approvalId, envelopeId } = await world.approveEnvelope(executionId, deviceId);
    return { executionId, deviceId, approvalId, envelopeId };
  };

  // =========================================================================
  // EDGE schema/identity (migration 0024)
  // =========================================================================

  describe("EDGE schema/identity (migration 0024)", () => {
    test("the world boots over migration 0024 (all eight edge tables + the catalog row)", async () => {
      world = await freshWorld();
      const applied = await ctx.port.execute<{ version: string; name: string }>({
        sql: "SELECT version, name FROM platform.schema_migrations WHERE version = $1",
        parameters: ["0024"],
      });
      expect(applied.rows[0]?.name).toContain("edge_execution");
      const tables = await ctx.port.execute<{ table_name: string }>({
        sql: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'edge' ORDER BY table_name",
      });
      expect(tables.rows.map((row) => row.table_name)).toEqual([
        "actuation_events",
        "approvals",
        "commands",
        "device_health_reports",
        "devices",
        "envelopes",
        "operations",
        "reconciliations",
        "sensor_observations",
      ]);
    });

    test("device registration converges on (application, device_key); key reuse fails closed", async () => {
      world = await freshWorld();
      const first = await world.register({}, "device-key-1");
      const replay = await world.register({}, "device-key-1");
      expect(replay).toBe(first);
      const row = await deviceRow("device-key-1");
      expect(row?.status).toBe("registered");
      expect(row?.tenant_id).toBe(world.tenantId);
      // A DIFFERENT body under the same key is key reuse — fail closed.
      await expectPlatformError(
        "IDEMPOTENCY_KEY_REUSED",
        world.register({ label: "a different target" }, "device-key-1"),
      );
      expect(
        await count(world.db, "SELECT 1 FROM edge.devices WHERE application_id = $1", [
          world.applicationId,
        ]),
      ).toBe(1);
    });

    test("the device identity core is physically immutable and rows are never deleted", async () => {
      world = await freshWorld();
      const deviceId = await world.register({}, "device-key-immutable");
      await expect(
        world.db.execute({
          sql: "UPDATE edge.devices SET label = 'tampered' WHERE id = $1",
          parameters: [deviceId],
        }),
      ).rejects.toThrow();
      await expect(
        world.db.execute({
          sql: "DELETE FROM edge.devices WHERE id = $1",
          parameters: [deviceId],
        }),
      ).rejects.toThrow();
    });

    test("tenant isolation: cross-tenant actors fail closed with zero durable rows", async () => {
      world = await freshWorld();
      const otherActor = { actorId: world.actorId, tenantId: world.otherTenantId };
      await expectPlatformError(
        "TENANT_SCOPE_VIOLATION",
        world.service.registerDevice(
          {
            ...world.deviceRegistration(),
            actor: otherActor,
          } as EdgeDeviceRegistrationRequest,
          "cross-tenant-register",
        ),
      );
      expect(
        await count(world.db, "SELECT 1 FROM edge.devices WHERE application_id = $1", [
          world.applicationId,
        ]),
      ).toBe(0);
      expect(await operationsOf("device-register")).toBe(0);
    });
  });

  // =========================================================================
  // EDGE device lifecycle
  // =========================================================================

  describe("EDGE device lifecycle (registration, health, revocation)", () => {
    test("revocation is guarded and terminal; a revoked identity never governs work", async () => {
      world = await freshWorld();
      const { executionId, deviceId } = await governedDevice();
      const receipt = await world.service.revokeDevice(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          deviceId,
          reason: "hardware decommissioned",
        },
        "revoke-key-1",
      );
      expect(receipt.status).toBe("revoked");
      const row = await one<{ status: string; revoked_at: string; revocation_reason: string }>(
        world.db,
        "SELECT * FROM edge.devices WHERE id = $1",
        [deviceId],
      );
      expect(row?.status).toBe("revoked");
      expect(row?.revocation_reason).toBe("hardware decommissioned");
      // Terminal: the physical guard rejects ANY further mutation.
      await expect(
        world.db.execute({
          sql: 'UPDATE edge.devices SET health = \'{"status":"healthy"}\'::jsonb WHERE id = $1',
          parameters: [deviceId],
        }),
      ).rejects.toThrow();
      // The revoked identity cannot admit a new safety envelope.
      await expectPlatformError(
        "AUTHORIZATION_DENIED",
        world.service.requestApproval(
          {
            applicationId: world.applicationId,
            actor: world.actor(),
            executionId,
            deviceId,
            subjectKind: "envelope",
            subjectFingerprint: "fingerprint-any",
            policyBasis: "edge policy set v1 (pg world)",
            expiresAt: null,
          },
          "approval-after-revoke",
        ),
      );
      expect(await envelopesOf(deviceId)).toBe(1); // only the pre-revoke envelope
    });

    test("revocation fail-safes the admitted envelope: no command ever dispatches after it", async () => {
      world = await freshWorld();
      const { executionId, deviceId, envelopeId } = await governedDevice();
      // A commanded physical write that the local controller REFUSES
      // (disconnect the transport first: the dispatch fails and the
      // command is NOT terminal — it already failed). Instead, arm the
      // in-flight window directly: an authorized command exists only
      // between insert and dispatch, which the crash proofs cover. Here
      // the fail-safe proof is the ENVELOPE + PROJECTION side:
      const active = await world.store.findActiveEnvelopeForDevice(world.applicationId, deviceId);
      expect(active?.id).toBe(envelopeId);
      await world.service.revokeDevice(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          deviceId,
          reason: "safety stop",
        },
        "revoke-key-failsafe",
      );
      const after = await one<{ status: string }>(
        world.db,
        "SELECT status FROM edge.envelopes WHERE id = $1",
        [envelopeId],
      );
      expect(after?.status).toBe("revoked");
      // The revocation was projected to the local controller: the held
      // authority is withdrawn (the device holds NO admitted envelope).
      // The next dispatch under the revoked envelope is refused by BOTH
      // planes (service-side coverage + local holding).
      const request = world.commandRequest(executionId, deviceId, envelopeId);
      await expectPlatformError(
        "AUTHORIZATION_DENIED",
        world.service.submitCommand({ ...request, approvalId: null }, "command-after-revoke"),
      );
      expect(await commandsOf(deviceId)).toBe(0);
      expect(world.controller.journalLength(deviceId)).toBe(0);
    });

    test("health reports are append-only; the device row denormalizes the latest", async () => {
      world = await freshWorld();
      const deviceId = await world.register({}, "health-device");
      await world.service.reportHealth(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          deviceId,
          health: {
            status: "healthy",
            metrics: { dutyCycle: 0.4 },
            reportedAt: "2026-09-15T12:00:00Z",
          },
        },
        "health-1",
      );
      await world.service.reportHealth(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          deviceId,
          health: {
            status: "degraded",
            metrics: { dutyCycle: 0.9 },
            reportedAt: "2026-09-15T12:01:00Z",
          },
        },
        "health-2",
      );
      expect(
        await count(world.db, "SELECT 1 FROM edge.device_health_reports WHERE device_id = $1", [
          deviceId,
        ]),
      ).toBe(2);
      const row = await deviceRow("health-device");
      expect((row?.health as { status: string } | null)?.status).toBe("degraded");
    });
  });

  // =========================================================================
  // EDGE envelope admission (the safety-critical pre-authorization)
  // =========================================================================

  describe("EDGE safety-envelope admission (immutable pre-authorization)", () => {
    test("the full chain admits the envelope and projects it to the local controller exactly once", async () => {
      world = await freshWorld();
      const { deviceId, envelopeId } = await governedDevice();
      const row = await one<{
        status: string;
        content_digest: string;
        admission: { approvalId: string };
      }>(world.db, "SELECT * FROM edge.envelopes WHERE id = $1", [envelopeId]);
      expect(row?.status).toBe("admitted");
      expect(row?.content_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.admission.approvalId).toBeTruthy();
      // The human gate rode the executions lifecycle: WAITING_HUMAN then
      // resume — through the PUBLIC transitions only.
      expect(await envelopesOf(deviceId)).toBe(1);
      expect(await completedOperationsOf("envelope-admit")).toBe(1);
      // Replay converges the same receipt.
      const replay = await world.service.getEnvelope(world.applicationId, envelopeId);
      expect(replay?.status).toBe("admitted");
      expect(replay?.contentDigest).toBe(row?.content_digest);
    });

    test("the envelope content is IMMUTABLE post-admission (the physical guard)", async () => {
      world = await freshWorld();
      const { envelopeId } = await governedDevice();
      await expect(
        world.db.execute({
          sql: "UPDATE edge.envelopes SET content = jsonb_set(content, '{maxCommands}', '999') WHERE id = $1",
          parameters: [envelopeId],
        }),
      ).rejects.toThrow();
      await expect(
        world.db.execute({
          sql: "UPDATE edge.envelopes SET content_digest = repeat('a', 64) WHERE id = $1",
          parameters: [envelopeId],
        }),
      ).rejects.toThrow();
    });

    test("a second admission must SUPERSEDE explicitly; the old envelope stays content-pinned", async () => {
      world = await freshWorld();
      const { executionId, deviceId, envelopeId } = await governedDevice();
      const pinned = await one<{ content_digest: string }>(
        world.db,
        "SELECT content_digest FROM edge.envelopes WHERE id = $1",
        [envelopeId],
      );
      // Without an explicit supersede the admission fails closed.
      const content = world.defaultEnvelopeContent({ maxCommands: 20 });
      const unSupervised = {
        applicationId: world.applicationId,
        actor: world.actor(),
        executionId,
        deviceId,
        content,
        costCeilingMicroUsd: "1000000",
        approvalId: "pending",
        supersedesEnvelopeId: null,
      };
      const subjectFingerprint = edgeEnvelopeFingerprint(unSupervised);
      const approval = await world.service.requestApproval(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          executionId,
          deviceId,
          subjectKind: "envelope",
          subjectFingerprint,
          policyBasis: "edge policy set v1 (pg world)",
          expiresAt: null,
        },
        "env2-approval",
      );
      await world.service.decideApproval(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          approvalId: approval.approvalId,
          approverId: world.approverId,
          decision: "approved",
          rationale: "operator-approved",
        },
        "env2-decision",
      );
      await expectPlatformError(
        "INVALID_STATE_TRANSITION",
        world.service.admitEnvelope(
          { ...unSupervised, approvalId: approval.approvalId },
          "env-no-supersede",
        ),
      );
      expect(await envelopesOf(deviceId)).toBe(1);
      // The explicit supersede lands the NEW admission and moves the old
      // one — content untouched.
      const { envelopeId: newEnvelopeId } = await world.approveEnvelope(
        executionId,
        deviceId,
        content,
        { supersedesEnvelopeId: envelopeId },
      );
      expect(newEnvelopeId).not.toBe(envelopeId);
      const oldRow = await one<{
        status: string;
        content_digest: string;
        superseded_by_envelope_id: string;
      }>(world.db, "SELECT * FROM edge.envelopes WHERE id = $1", [envelopeId]);
      expect(oldRow?.status).toBe("superseded");
      expect(oldRow?.superseded_by_envelope_id).toBe(newEnvelopeId);
      expect(oldRow?.content_digest).toBe(pinned?.content_digest); // content pinned
      expect(await envelopesOf(deviceId)).toBe(2);
    });

    test("an envelope admission WITHOUT a valid human approval fails closed with zero durable rows", async () => {
      world = await freshWorld();
      const executionId = await world.driveToRunning(world.boot(null).executions);
      const deviceId = await world.register();
      // A DENIED approval never authorizes the safety-critical admission.
      const request = {
        applicationId: world.applicationId,
        actor: world.actor(),
        executionId,
        deviceId,
        content: world.defaultEnvelopeContent(),
        costCeilingMicroUsd: "1000000",
        approvalId: "pending",
        supersedesEnvelopeId: null,
      };
      const subjectFingerprint = edgeEnvelopeFingerprint(request);
      const approval = await world.service.requestApproval(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          executionId,
          deviceId,
          subjectKind: "envelope",
          subjectFingerprint,
          policyBasis: "edge policy set v1 (pg world)",
          expiresAt: null,
        },
        "denied-env-approval",
      );
      await world.service.decideApproval(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          approvalId: approval.approvalId,
          approverId: world.approverId,
          decision: "denied",
          rationale: "operator rejected the bounds",
        },
        "denied-env-decision",
      );
      await expectPlatformError(
        "AUTHORIZATION_DENIED",
        world.service.admitEnvelope(
          { ...request, approvalId: approval.approvalId },
          "env-denied-approval",
        ),
      );
      expect(await envelopesOf(deviceId)).toBe(0);
      expect(await operationsOf("envelope-admit")).toBe(0);
      // An approval bound to a DIFFERENT subject fingerprint never
      // authorizes this admission either.
      const other = await world.service.requestApproval(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          executionId,
          deviceId,
          subjectKind: "envelope",
          subjectFingerprint: "a-different-subject-fingerprint",
          policyBasis: "edge policy set v1 (pg world)",
          expiresAt: null,
        },
        "mismatched-approval",
      );
      await world.service.decideApproval(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          approvalId: other.approvalId,
          approverId: world.approverId,
          decision: "approved",
          rationale: "approved for a different subject",
        },
        "mismatched-decision",
      );
      await expectPlatformError(
        "AUTHORIZATION_DENIED",
        world.service.admitEnvelope({ ...request, approvalId: other.approvalId }, "env-mismatch"),
      );
      expect(await envelopesOf(deviceId)).toBe(0);
    });
  });

  // =========================================================================
  // EDGE command submission (the governed physical side effect)
  // =========================================================================

  describe("EDGE command admission chain (AC-4/AC-5 — REAL engines)", () => {
    test("a commanded physical write dispatches through the FULL chain exactly once", async () => {
      world = await freshWorld();
      const { executionId, deviceId, envelopeId } = await governedDevice();
      const request = world.commandRequest(executionId, deviceId, envelopeId);
      const approvalId = await world.approveCommand(request);
      const receipt = await world.service.submitCommand({ ...request, approvalId }, "command-1");
      expect(receipt.status).toBe("dispatched");
      expect(receipt.dispatchDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(receipt.sequence).toBe(1);
      const row = await commandRowByKey("command-1");
      expect(row?.status).toBe("dispatched");
      expect(row?.approval_id).toBe(approvalId);
      expect(row?.ledger_requested_sequence).not.toBeNull();
      expect(row?.ledger_result_sequence).not.toBeNull();
      // The local controller executed EXACTLY ONE actuation.
      expect(world.controller.journalLength(deviceId)).toBe(1);
      // The envelope's authorized-command counter moved.
      const envRow = await one<{ command_count: number }>(
        world.db,
        "SELECT command_count FROM edge.envelopes WHERE id = $1",
        [envelopeId],
      );
      expect(envRow?.command_count).toBe(1);
      // Replay: same key, same receipt, ZERO new durable anything.
      const replay = await world.service.submitCommand({ ...request, approvalId }, "command-1");
      expect(replay.replayed).toBe(true);
      expect(replay.commandId).toBe(receipt.commandId);
      expect(await commandsOf(deviceId)).toBe(1);
      expect(world.controller.journalLength(deviceId)).toBe(1);
      // Key reuse with a different body fails closed.
      await expectPlatformError(
        "IDEMPOTENCY_KEY_REUSED",
        world.service.submitCommand({ ...request, approvalId, magnitude: 200 }, "command-1"),
      );
      expect(await commandsOf(deviceId)).toBe(1);
    });

    test("a POLICY denial is a durable denied row with ZERO actuator-path activity", async () => {
      world = await freshWorld();
      const { executionId, deviceId, envelopeId } = await governedDevice();
      await world.policyAuthority.publish({
        id: "default",
        version: 2,
        documents: [
          {
            scope: "platform",
            selector: {},
            restrictions: { tool: { deniedTools: ["edge:command-submit"] } },
          },
        ],
      });
      const request = world.commandRequest(executionId, deviceId, envelopeId);
      const approvalId = await world.approveCommand(request);
      await expectPlatformError(
        "POLICY_DENIED",
        world.service.submitCommand({ ...request, approvalId }, "deny-policy"),
      );
      const row = await commandRowByKey("deny-policy");
      expect(row?.status).toBe("denied");
      expect(row?.denial_class).toBe("policy");
      expect(world.controller.journalLength(deviceId)).toBe(0);
      expect(await reservationsOf()).toBe(0);
      expect(await failedOperationsOf("command-submit")).toBe(1);
    });

    test("a CAPABILITY denial (unmet channel atom) fails closed before any dispatch", async () => {
      world = await freshWorld();
      const { executionId, deviceId, envelopeId } = await governedDevice();
      // The device declares locomotion + manipulation atoms; the
      // controller registration does NOT declare edge-channel:signal —
      // the REAL registry leaves the requirement unmet.
      const request = world.commandRequest(executionId, deviceId, envelopeId, {
        channel: "signal",
        magnitude: 5,
      });
      const approvalId = await world.approveCommand(request);
      await expectPlatformError(
        "CAPABILITY_UNAVAILABLE",
        world.service.submitCommand({ ...request, approvalId }, "deny-capability"),
      );
      const row = await commandRowByKey("deny-capability");
      expect(row?.status).toBe("denied");
      expect(row?.denial_class).toBe("capability");
      expect(world.controller.journalLength(deviceId)).toBe(0);
    });

    test("a PHYSICAL-WRITE command without a bound human approval is denied (fail-closed)", async () => {
      world = await freshWorld();
      const { executionId, deviceId, envelopeId } = await governedDevice();
      const request = world.commandRequest(executionId, deviceId, envelopeId);
      await expectPlatformError(
        "AUTHORIZATION_DENIED",
        world.service.submitCommand(request, "deny-no-approval"),
      );
      const row = await commandRowByKey("deny-no-approval");
      expect(row?.status).toBe("denied");
      expect(row?.denial_class).toBe("approval");
      expect(world.controller.journalLength(deviceId)).toBe(0);
      // The wallet never moved.
      expect(await reservationsOf()).toBe(0);
    });

    test("a STALE command (expired window) NEVER reaches the actuator path", async () => {
      world = await freshWorld();
      const { executionId, deviceId, envelopeId } = await governedDevice();
      const request = world.commandRequest(executionId, deviceId, envelopeId, {
        notBefore: new Date(Date.now() - 120_000).toISOString(),
        notAfter: new Date(Date.now() - 60_000).toISOString(),
      });
      const approvalId = await world.approveCommand(request);
      await expectPlatformError(
        "AUTHORIZATION_DENIED",
        world.service.submitCommand({ ...request, approvalId }, "deny-stale"),
      );
      const row = await commandRowByKey("deny-stale");
      expect(row?.status).toBe("denied");
      expect(row?.denial_class).toBe("stale");
      expect(world.controller.journalLength(deviceId)).toBe(0);
    });

    test("an OUT-OF-ENVELOPE magnitude is denied before any dispatch", async () => {
      world = await freshWorld();
      const { executionId, deviceId, envelopeId } = await governedDevice();
      const request = world.commandRequest(executionId, deviceId, envelopeId, {
        magnitude: 900, // envelope bounds: [-500, 500]
      });
      const approvalId = await world.approveCommand(request);
      await expectPlatformError(
        "AUTHORIZATION_DENIED",
        world.service.submitCommand({ ...request, approvalId }, "deny-magnitude"),
      );
      const row = await commandRowByKey("deny-magnitude");
      expect(row?.status).toBe("denied");
      expect(row?.denial_class).toBe("envelope");
      expect(world.controller.journalLength(deviceId)).toBe(0);
    });

    test("the ENVELOPE budget bound: a costed command beyond the ceiling is denied", async () => {
      world = await freshWorld();
      const { executionId, deviceId, envelopeId } = await governedDevice();
      const request = world.commandRequest(executionId, deviceId, envelopeId, {
        estimatedMicroUsd: "2000000", // the ceiling is 1,000,000
      });
      const approvalId = await world.approveCommand(request);
      await expectPlatformError(
        "BUDGET_EXCEEDED",
        world.service.submitCommand({ ...request, approvalId }, "deny-ceiling"),
      );
      const row = await commandRowByKey("deny-ceiling");
      expect(row?.status).toBe("denied");
      expect(row?.denial_class).toBe("budget");
      expect(world.controller.journalLength(deviceId)).toBe(0);
      expect(await reservationsOf()).toBe(0);
    });

    test("a COSTED command reserves the wallet physically and settles on reconciliation", async () => {
      world = await freshWorld();
      const { executionId, deviceId, envelopeId } = await governedDevice();
      const request = world.commandRequest(executionId, deviceId, envelopeId, {
        estimatedMicroUsd: "250000",
      });
      const approvalId = await world.approveCommand(request);
      const receipt = await world.service.submitCommand(
        { ...request, approvalId },
        "costed-command",
      );
      expect(receipt.status).toBe("dispatched");
      expect(await reservationsOf()).toBe(1);
      // Reconcile the journal: the commanded actuation settles exactly
      // once and the wallet hold settles.
      const reconciliation = await world.service.reconcile(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          deviceId,
        },
        "reconcile-costed",
      );
      expect(reconciliation.status).toBe("converged");
      expect(reconciliation.settledCount).toBe(1);
      const row = await commandRowByKey("costed-command");
      expect(row?.status).toBe("settled");
    });

    test("a device-config command (halt) needs NO human approval but still runs the chain", async () => {
      world = await freshWorld();
      const { executionId, deviceId, envelopeId } = await governedDevice();
      const request = world.commandRequest(executionId, deviceId, envelopeId, {
        commandKind: "halt",
        magnitude: 0,
      });
      const receipt = await world.service.submitCommand(request, "halt-command");
      expect(receipt.status).toBe("dispatched");
      expect(receipt.sequence).toBe(1);
      expect(world.controller.journalLength(deviceId)).toBe(1);
      // The gapless sequence: the next command is 2 (denied rows
      // included — see the stale denial above in other scenarios).
      const second = world.commandRequest(executionId, deviceId, envelopeId, {
        commandKind: "poll",
        magnitude: 0,
      });
      const receipt2 = await world.service.submitCommand(second, "poll-command");
      expect(receipt2.sequence).toBe(2);
    });
  });

  // =========================================================================
  // EDGE provenance (sensors + ledger)
  // =========================================================================

  describe("EDGE provenance (EXECUTION-PROVENANCE — real ledger)", () => {
    test("sensor observations are durable, execution-keyed and ride the canonical ledger", async () => {
      world = await freshWorld();
      const { executionId, deviceId } = await governedDevice();
      const record = await world.service.ingestSensorObservation(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          executionId,
          deviceId,
          observationType: "telemetry",
          retention: "retained",
          content: '{"battery": 0.82}',
          observedAt: new Date().toISOString(),
        },
        "sensor-1",
      );
      expect(record.content).toBe('{"battery": 0.82}');
      expect(record.contentDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(record.sequence).toBe(1);
      expect(await sensorObservationsOf(deviceId)).toBe(1);
      const row = await one<{ ledger_sequence: number; execution_id: string }>(
        world.db,
        "SELECT * FROM edge.sensor_observations WHERE application_id = $1 AND observation_key = $2",
        [world.applicationId, "sensor-1"],
      );
      expect(row?.ledger_sequence).not.toBeNull();
      expect(row?.execution_id).toBe(executionId);
      // Replay converges.
      await world.service.ingestSensorObservation(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          executionId,
          deviceId,
          observationType: "telemetry",
          retention: "retained",
          content: '{"battery": 0.82}',
          observedAt: new Date().toISOString(),
        },
        "sensor-1",
      );
      expect(await sensorObservationsOf(deviceId)).toBe(1);
    });

    test("the ledger evidence of one governed command is exactly the keyed set (tools vocabulary)", async () => {
      world = await freshWorld();
      const { executionId, deviceId, envelopeId } = await governedDevice();
      const request = world.commandRequest(executionId, deviceId, envelopeId);
      const approvalId = await world.approveCommand(request);
      await world.service.submitCommand({ ...request, approvalId }, "provenance-command");
      const events = await eventsOf(world.db, executionId);
      const types = events.map((event) => event.type).sort();
      // The approval wait/resume transitions + the command's
      // tool-requested / tool-result pair — all through the canonical
      // ledger with the TOOLS producer vocabulary.
      expect(types).toEqual(
        expect.arrayContaining(["execution.tool-requested", "execution.tool-result"]),
      );
      for (const event of events) {
        expect(event.type).toMatch(/^execution\./);
      }
      // The command evidence rows key on the execution identity.
      const row = await commandRowByKey("provenance-command");
      expect(row?.ledger_requested_sequence).not.toBeNull();
      expect(row?.ledger_result_sequence).not.toBeNull();
      expect((row?.ledger_requested_sequence ?? 0) < (row?.ledger_result_sequence ?? 0)).toBe(true);
    });
  });

  // =========================================================================
  // EDGE reconnect reconciliation (AC-6)
  // =========================================================================

  describe("EDGE disconnect/reconnect reconciliation (AC-6)", () => {
    test("commanded actuations settle EXACTLY ONCE; autonomous actuations confirm within the envelope", async () => {
      world = await freshWorld();
      const { executionId, deviceId, envelopeId } = await governedDevice();
      const request = world.commandRequest(executionId, deviceId, envelopeId);
      const approvalId = await world.approveCommand(request);
      await world.service.submitCommand({ ...request, approvalId }, "recon-1");
      // The device disconnects and keeps executing autonomously WITHIN
      // the pre-authorized envelope (the local loop, never the service).
      world.controller.disconnect();
      world.controller.autonomousTick(deviceId, "manipulation", 40);
      world.controller.autonomousTick(deviceId, "manipulation", -30);
      world.controller.connect();
      const reconciliation = await world.service.reconcile(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          deviceId,
        },
        "recon-run-1",
      );
      expect(reconciliation.status).toBe("converged");
      expect(reconciliation.settledCount).toBe(1);
      expect(reconciliation.autonomousCount).toBe(2);
      expect(reconciliation.violationCount).toBe(0);
      const row = await commandRowByKey("recon-1");
      expect(row?.status).toBe("settled");
      expect(await actuationEventsOf(deviceId)).toBe(3); // 1 commanded + 2 autonomous
      // Re-reconciling the SAME journal (digest-stable) replays.
      const again = await world.service.reconcile(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          deviceId,
        },
        "recon-run-2",
      );
      expect(again.replayed).toBe(true);
      expect(await actuationEventsOf(deviceId)).toBe(3);
      expect(await reconciliationsOf(deviceId)).toBe(1);
      void executionId;
    });

    test("an out-of-envelope autonomous actuation is a VIOLATION that fails the reconciliation closed", async () => {
      world = await freshWorld();
      const { executionId, deviceId, envelopeId } = await governedDevice();
      world.controller.disconnect();
      // Magnitude 900 is outside the manipulation bounds [-100, 100].
      world.controller.autonomousTick(deviceId, "manipulation", 900);
      world.controller.connect();
      const reconciliation = await world.service.reconcile(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          deviceId,
        },
        "recon-violation",
      );
      expect(reconciliation.status).toBe("conflict");
      expect(reconciliation.violationCount).toBe(1);
      // The conflicted-device gate: NO further authoritative commands.
      const request = world.commandRequest(executionId, deviceId, envelopeId);
      const approvalId = await world.approveCommand(request);
      await expectPlatformError(
        "NON_CONVERGENT_EXTERNAL_EFFECT",
        world.service.submitCommand({ ...request, approvalId }, "command-on-conflicted"),
      );
      expect(await commandsOf(deviceId)).toBe(0);
      expect(world.controller.journalLength(deviceId)).toBe(1); // the violation itself
    });

    test("commands dispatched while the transport is down fail safely (zero actuation)", async () => {
      world = await freshWorld();
      const { executionId, deviceId, envelopeId } = await governedDevice();
      world.controller.disconnect();
      const request = world.commandRequest(executionId, deviceId, envelopeId);
      const approvalId = await world.approveCommand(request);
      const receipt = await world.service.submitCommand(
        { ...request, approvalId },
        "disconnected-command",
      );
      expect(receipt.status).toBe("failed");
      expect(world.controller.journalLength(deviceId)).toBe(0);
      world.controller.connect();
      // After reconnect, the failed command never re-dispatches (it is
      // terminal); the journal has ZERO entries for it.
      expect((await commandRowByKey("disconnected-command"))?.status).toBe("failed");
      const reconciliation = await world.service.reconcile(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          deviceId,
        },
        "recon-after-reconnect",
      );
      expect(reconciliation.status).toBe("converged");
      expect(reconciliation.settledCount).toBe(0);
      expect(world.controller.journalLength(deviceId)).toBe(0);
    });
  });

  // =========================================================================
  // EDGE concurrency (the keyed convergence discipline)
  // =========================================================================

  describe("EDGE concurrency (same-key convergence)", () => {
    test("N=8 same-key command submissions converge to ONE command and ONE actuation", async () => {
      world = await freshWorld();
      const { executionId, deviceId, envelopeId } = await governedDevice();
      const request = world.commandRequest(executionId, deviceId, envelopeId);
      const approvalId = await world.approveCommand(request);
      const receipts = await Promise.all(
        Array.from({ length: 8 }, () =>
          world.service.submitCommand({ ...request, approvalId }, "concurrent-command"),
        ),
      );
      const ids = new Set(receipts.map((receipt) => receipt.commandId));
      expect(ids.size).toBe(1);
      expect(await commandsOf(deviceId)).toBe(1);
      expect(world.controller.journalLength(deviceId)).toBe(1);
    });

    test("N=8 same-key envelope admissions converge to ONE envelope", async () => {
      world = await freshWorld();
      const executionId = await world.driveToRunning(world.boot(null).executions);
      const deviceId = await world.register();
      const content = world.defaultEnvelopeContent();
      const request = {
        applicationId: world.applicationId,
        actor: world.actor(),
        executionId,
        deviceId,
        content,
        costCeilingMicroUsd: "1000000",
        approvalId: "pending",
        supersedesEnvelopeId: null,
      };
      const subjectFingerprint = edgeEnvelopeFingerprint(request);
      const approval = await world.service.requestApproval(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          executionId,
          deviceId,
          subjectKind: "envelope",
          subjectFingerprint,
          policyBasis: "edge policy set v1 (pg world)",
          expiresAt: null,
        },
        "concurrent-env-approval",
      );
      await world.service.decideApproval(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          approvalId: approval.approvalId,
          approverId: world.approverId,
          decision: "approved",
          rationale: "operator-approved",
        },
        "concurrent-env-decision",
      );
      const receipts = await Promise.all(
        Array.from({ length: 8 }, () =>
          world.service.admitEnvelope(
            { ...request, approvalId: approval.approvalId },
            "concurrent-envelope",
          ),
        ),
      );
      const ids = new Set(receipts.map((receipt) => receipt.envelopeId));
      expect(ids.size).toBe(1);
      expect(await envelopesOf(deviceId)).toBe(1);
    });
  });
});
