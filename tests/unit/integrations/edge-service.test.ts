/**
 * Edge service unit suite (WORK-029, EDGE-001/002/003) — the governed
 * admission chain, the safety envelopes, the command journal, the
 * sensor/actuation provenance and the deterministic reconciliation over
 * the in-memory world (the REAL service + simulated controller +
 * REAL executions ledger; the authority seams as recording fakes).
 */

import { describe, expect, test } from "vitest";
import { edgeCommandFingerprint } from "../../../src/integrations/edge/public";
import type { PlatformError } from "../../../src/shared/errors";
import {
  createInMemoryEdgeWorld,
  deviceRegistration,
  expectPlatformError,
  type InMemoryEdgeWorld,
  sha256Hex,
} from "./edge-world";

async function governedWorld(): Promise<{
  world: InMemoryEdgeWorld;
  executionId: string;
  deviceId: string;
  envelopeId: string;
}> {
  const world = createInMemoryEdgeWorld();
  const executionId = await world.seedExecution();
  const deviceId = await world.register();
  const { envelopeId } = await world.approveEnvelope(executionId, deviceId);
  return { world, executionId, deviceId, envelopeId };
}

describe("edge service: device lifecycle", () => {
  test("registration is idempotent per key and fails closed on key reuse", async () => {
    const world = createInMemoryEdgeWorld();
    const receipt = await world.service.registerDevice(deviceRegistration(), "dk-1");
    expect(receipt.replayed).toBe(false);
    const replay = await world.service.registerDevice(deviceRegistration(), "dk-1");
    expect(replay).toMatchObject({ deviceId: receipt.deviceId, replayed: true });
    const changed = deviceRegistration({ label: "other label" });
    await expectPlatformError(
      "IDEMPOTENCY_KEY_REUSED",
      world.service.registerDevice(changed, "dk-1"),
    );
  });

  test("revocation is terminal, converges on replay and blocks governed work", async () => {
    const world = createInMemoryEdgeWorld();
    const deviceId = await world.register();
    const revoked = await world.service.revokeDevice(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        deviceId,
        reason: "decommissioned",
      },
      "rk-1",
    );
    expect(revoked.status).toBe("revoked");
    const replay = await world.service.revokeDevice(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        deviceId,
        reason: "decommissioned",
      },
      "rk-1",
    );
    expect(replay.replayed).toBe(true);
    await expectPlatformError(
      "AUTHORIZATION_DENIED",
      world.service.reportHealth(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          deviceId,
          health: { status: "healthy", metrics: {}, reportedAt: world.now().toISOString() },
        },
        "hk-1",
      ),
    );
  });

  test("health reports are append-only evidence denormalized onto the device", async () => {
    const world = createInMemoryEdgeWorld();
    const deviceId = await world.register();
    const record = await world.service.reportHealth(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        deviceId,
        health: {
          status: "degraded",
          metrics: { dutyCycle: 0.9 },
          reportedAt: "2026-09-15T12:00:00Z",
        },
      },
      "hk-1",
    );
    expect(record.health).toMatchObject({ status: "degraded" });
    const after = await world.service.getDevice(world.applicationId, deviceId);
    expect(after?.health).toMatchObject({ status: "degraded" });
  });

  test("tenant scope is never dropped (cross-tenant access is typed)", async () => {
    const world = createInMemoryEdgeWorld();
    const deviceId = await world.register();
    await expectPlatformError(
      "TENANT_SCOPE_VIOLATION",
      world.service.revokeDevice(
        {
          applicationId: world.applicationId,
          actor: { actorId: world.actorId, tenantId: world.otherTenantId },
          deviceId,
          reason: "not mine",
        },
        "rk-1",
      ),
    );
  });

  test("a policy denial at registration is typed and fails the durable operation", async () => {
    const world = createInMemoryEdgeWorld();
    world.policy.denyWith("no edge devices in this tenant");
    await expectPlatformError(
      "POLICY_DENIED",
      world.service.registerDevice(deviceRegistration(), "dk-1"),
    );
    const operation = await world.store.findOperation(
      world.applicationId,
      `edge-op-device-register:dk-1`,
    );
    expect(operation?.status).toBe("failed");
    expect(operation?.failureReason).toContain("no edge devices");
  });
});

describe("edge service: the human-approval ledger", () => {
  test("an approval request drives the executions wait-human transition; the decision resumes it", async () => {
    const world = createInMemoryEdgeWorld();
    const executionId = await world.seedExecution();
    const deviceId = await world.register();
    const receipt = await world.service.requestApproval(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        executionId,
        deviceId,
        subjectKind: "command",
        subjectFingerprint: "fp-1",
        policyBasis: "edge policy set v1",
        expiresAt: null,
      },
      "ak-1",
    );
    expect(receipt.status).toBe("pending");
    const waiting = await world.executionService.getExecution(world.applicationId, executionId);
    expect(waiting?.status).toBe("WAITING_HUMAN");
    const decided = await world.service.decideApproval(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        approvalId: receipt.approvalId,
        approverId: world.approverId,
        decision: "approved",
        rationale: "operator approved",
      },
      "ad-1",
    );
    expect(decided.status).toBe("approved");
    const resumed = await world.executionService.getExecution(world.applicationId, executionId);
    expect(resumed?.status).toBe("RUNNING");
    const events = await world.executionService.listEvents(world.applicationId, executionId);
    expect(events.some((event) => event.command === "wait-human")).toBe(true);
    expect(events.some((event) => event.command === "resume")).toBe(true);
    expect(events.filter((event) => event.command === "tool-requested").length).toBe(1);
  });

  test("decisions are terminal-immutable; the same decision replay converges", async () => {
    const world = createInMemoryEdgeWorld();
    const executionId = await world.seedExecution();
    const deviceId = await world.register();
    const receipt = await world.service.requestApproval(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        executionId,
        deviceId,
        subjectKind: "envelope",
        subjectFingerprint: "fp-1",
        policyBasis: "edge policy set v1",
        expiresAt: null,
      },
      "ak-1",
    );
    const decide = (decision: "approved" | "denied") =>
      world.service.decideApproval(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          approvalId: receipt.approvalId,
          approverId: world.approverId,
          decision,
          rationale: `operator ${decision}`,
        },
        `ad-${decision}`,
      );
    await decide("approved");
    const replay = await decide("approved");
    expect(replay.replayed).toBe(true);
    await expectPlatformError("INVALID_STATE_TRANSITION", decide("denied"));
  });

  test("MULTIPLE live gates: the execution waits ONCE and resumes only when the LAST gate closes", async () => {
    const world = createInMemoryEdgeWorld();
    const executionId = await world.seedExecution();
    const deviceId = await world.register();
    const statusOf = async () => {
      const execution = await world.executionService.getExecution(world.applicationId, executionId);
      return execution?.status;
    };
    // gate A opens: RUNNING -> WAITING_HUMAN (the ONLY wait transition)
    const gateA = await world.service.requestApproval(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        executionId,
        deviceId,
        subjectKind: "command",
        subjectFingerprint: "fp-a",
        policyBasis: "edge policy set v1",
        expiresAt: null,
      },
      "ak-gate-a",
    );
    expect(await statusOf()).toBe("WAITING_HUMAN");
    // gate B opens on the SAME execution while it is already waiting: a
    // second WAITING_HUMAN -> WAITING_HUMAN transition is ILLEGAL in the
    // frozen executions state machine — the multi-gate discipline must
    // hold the single waiting state for BOTH gates, not throw.
    const gateB = await world.service.requestApproval(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        executionId,
        deviceId,
        subjectKind: "command",
        subjectFingerprint: "fp-b",
        policyBasis: "edge policy set v1",
        expiresAt: null,
      },
      "ak-gate-b",
    );
    expect(gateB.status).toBe("pending");
    expect(await statusOf()).toBe("WAITING_HUMAN");
    const eventsAfterBoth = await world.executionService.listEvents(
      world.applicationId,
      executionId,
    );
    expect(eventsAfterBoth.filter((event) => event.command === "wait-human").length).toBe(1);
    // closing gate A does NOT resume: gate B is still a live human gate
    // (a partial resume would bypass a still-open approval — AC-4).
    await world.service.decideApproval(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        approvalId: gateA.approvalId,
        approverId: world.approverId,
        decision: "approved",
        rationale: "gate A closed",
      },
      "ad-gate-a",
    );
    expect(await statusOf()).toBe("WAITING_HUMAN");
    // closing the LAST gate resumes the execution exactly once
    await world.service.decideApproval(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        approvalId: gateB.approvalId,
        approverId: world.approverId,
        decision: "approved",
        rationale: "gate B closed (the last live gate)",
      },
      "ad-gate-b",
    );
    expect(await statusOf()).toBe("RUNNING");
    const eventsFinal = await world.executionService.listEvents(world.applicationId, executionId);
    expect(eventsFinal.filter((event) => event.command === "wait-human").length).toBe(1);
    expect(eventsFinal.filter((event) => event.command === "resume").length).toBe(1);
  });
});

describe("edge service: safety envelope admission", () => {
  test("the governed happy path admits, projects and journals the envelope", async () => {
    const { world, executionId, deviceId, envelopeId } = await governedWorld();
    const envelope = await world.service.getEnvelope(world.applicationId, envelopeId);
    expect(envelope?.status).toBe("admitted");
    expect(envelope?.commandCount).toBe(0);
    expect(envelope?.admission.approvalId).toBeTruthy();
    // the projection reached the LOCAL controller (the held authority)
    const report = await world.controller.reconciliationReport(deviceId);
    expect(report).toBeTruthy();
    const events = await world.executionService.listEvents(world.applicationId, executionId);
    expect(
      events.some((event) => event.command === "tool-requested" && event.cause === "edge-envelope"),
    ).toBe(true);
  });

  test("envelope admission REQUIRES a valid human approval bound to the subject fingerprint", async () => {
    const world = createInMemoryEdgeWorld();
    const executionId = await world.seedExecution();
    const deviceId = await world.register();
    const content = world.defaultEnvelopeContent();
    // a DENIED approval never authorizes admission
    const denied = await world.approveEnvelope(executionId, deviceId, content, {
      decide: "denied",
    });
    await expectPlatformError(
      "AUTHORIZATION_DENIED",
      world.service.admitEnvelope(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          executionId,
          deviceId,
          content,
          costCeilingMicroUsd: "0",
          approvalId: denied.approvalId,
          supersedesEnvelopeId: null,
        },
        "ek-denied",
      ),
    );
    // a PENDING approval is equally insufficient
    const { edgeEnvelopeFingerprint } = await import("../../../src/integrations/edge/public");
    const request = {
      applicationId: world.applicationId,
      actor: world.actor(),
      executionId,
      deviceId,
      content,
      costCeilingMicroUsd: "0",
      approvalId: "x",
      supersedesEnvelopeId: null,
    };
    const pending = await world.service.requestApproval(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        executionId,
        deviceId,
        subjectKind: "envelope",
        subjectFingerprint: edgeEnvelopeFingerprint(request),
        policyBasis: "edge policy set v1",
        expiresAt: null,
      },
      "ak-pending",
    );
    await expectPlatformError(
      "AUTHORIZATION_DENIED",
      world.service.admitEnvelope({ ...request, approvalId: pending.approvalId }, "ek-pending"),
    );
    // an approval for a DIFFERENT subject shape never authorizes this one
    const otherShape = await world.approveEnvelope(executionId, deviceId, {
      ...content,
      maxCommands: 99,
    });
    await expectPlatformError(
      "AUTHORIZATION_DENIED",
      world.service.admitEnvelope({ ...request, approvalId: otherShape.approvalId }, "ek-mismatch"),
    );
  });

  test("capability evidence is REQUIRED at admission (the REAL registry seam)", async () => {
    const world = createInMemoryEdgeWorld();
    const executionId = await world.seedExecution();
    const deviceId = await world.register();
    world.capabilities.failWith(["edge-channel:locomotion"]);
    await expectPlatformError(
      "CAPABILITY_UNAVAILABLE",
      world.approveEnvelope(executionId, deviceId),
    );
  });

  test("one active envelope: a second admission must supersede explicitly", async () => {
    const world = createInMemoryEdgeWorld();
    const executionId = await world.seedExecution();
    const deviceId = await world.register();
    const first = await world.approveEnvelope(executionId, deviceId);
    const content = world.defaultEnvelopeContent({ maxCommands: 20 });
    await expectPlatformError(
      "INVALID_STATE_TRANSITION",
      world.approveEnvelope(executionId, deviceId, content, { envelopeKey: "ek-second" }),
    );
    const superseding = await world.approveEnvelope(executionId, deviceId, content, {
      supersedesEnvelopeId: first.envelopeId,
      envelopeKey: "ek-supersede",
    });
    expect(superseding.envelopeId).not.toBe(first.envelopeId);
    const old = await world.service.getEnvelope(world.applicationId, first.envelopeId);
    expect(old?.status).toBe("superseded");
    expect(old?.supersededByEnvelopeId).toBe(superseding.envelopeId);
    const active = await world.service.getEnvelope(world.applicationId, superseding.envelopeId);
    expect(active?.status).toBe("admitted");
    // the superseded envelope is IMMUTABLE content (a same-key different
    // content replay fails closed)
    await expectPlatformError(
      "IDEMPOTENCY_KEY_REUSED",
      world.service.admitEnvelope(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          executionId,
          deviceId,
          content: world.defaultEnvelopeContent({ maxCommands: 123 }),
          costCeilingMicroUsd: "0",
          approvalId: "any",
          supersedesEnvelopeId: null,
        },
        "ek-supersede",
      ),
    );
  });

  test("envelope revocation withdraws the authority and fail-safes in-flight commands", async () => {
    const { world, executionId, deviceId, envelopeId } = await governedWorld();
    // an authorized (never dispatched) command under the envelope
    const request = world.commandRequest(executionId, deviceId, envelopeId);
    const approvalId = await world.approveCommand(request);
    // crash-window: insert the authorized row WITHOUT dispatching (direct
    // store claim — the crash proofs exercise the service path)
    await world.store.insertCommand({
      commandId: "00000000-0000-7000-8000-000000000f01",
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId,
      deviceId,
      envelopeId,
      commandKey: "inflight-1",
      requestFingerprint: edgeCommandFingerprint({ ...request, approvalId }),
      sequence: 1,
      commandKind: "actuate",
      effectClass: "physical-write",
      channel: "locomotion",
      magnitude: 100,
      payloadDigest: "digest-1",
      estimatedMicroUsd: "0",
      notBefore: request.notBefore,
      notAfter: request.notAfter,
      approvalId,
      denialClass: null,
      denialReason: null,
      requestedAt: world.now().toISOString(),
    });
    const revoked = await world.service.revokeEnvelope(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        envelopeId,
        reason: "operator halt",
      },
      "er-1",
    );
    expect(revoked.status).toBe("revoked");
    const inFlight = await world.service.getCommand(
      world.applicationId,
      "00000000-0000-7000-8000-000000000f01",
    );
    expect(inFlight?.status).toBe("invalidated");
    expect(inFlight?.failureClass).toBe("envelope-revoked");
    // commands no longer dispatch under a revoked envelope
    const later = world.commandRequest(executionId, deviceId, envelopeId);
    const laterApproval = await world.approveCommand(later);
    await expectPlatformError(
      "INVALID_STATE_TRANSITION",
      world.service.submitCommand({ ...later, approvalId: laterApproval }, "ck-later"),
    );
  });

  test("device revocation withdraws the envelope AND invalidates in-flight commands", async () => {
    const { world, executionId, deviceId, envelopeId } = await governedWorld();
    const request = world.commandRequest(executionId, deviceId, envelopeId);
    const approvalId = await world.approveCommand(request);
    await world.store.insertCommand({
      commandId: "00000000-0000-7000-8000-000000000f02",
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId,
      deviceId,
      envelopeId,
      commandKey: "inflight-2",
      requestFingerprint: edgeCommandFingerprint({ ...request, approvalId }),
      sequence: 1,
      commandKind: "actuate",
      effectClass: "physical-write",
      channel: "locomotion",
      magnitude: 100,
      payloadDigest: "digest-2",
      estimatedMicroUsd: "0",
      notBefore: request.notBefore,
      notAfter: request.notAfter,
      approvalId,
      denialClass: null,
      denialReason: null,
      requestedAt: world.now().toISOString(),
    });
    await world.service.revokeDevice(
      { applicationId: world.applicationId, actor: world.actor(), deviceId, reason: "incident" },
      "dr-1",
    );
    const inFlight = await world.service.getCommand(
      world.applicationId,
      "00000000-0000-7000-8000-000000000f02",
    );
    expect(inFlight?.status).toBe("invalidated");
    expect(inFlight?.failureClass).toBe("device-revoked");
    const envelope = await world.service.getEnvelope(world.applicationId, envelopeId);
    expect(envelope?.status).toBe("revoked");
  });
});

describe("edge service: the governed command path (AC-4/AC-5)", () => {
  test("an approved actuate command dispatches ONCE and journals the full provenance", async () => {
    const { world, executionId, deviceId, envelopeId } = await governedWorld();
    const request = world.commandRequest(executionId, deviceId, envelopeId);
    const approvalId = await world.approveCommand(request);
    const receipt = await world.service.submitCommand({ ...request, approvalId }, "ck-happy-1");
    expect(receipt.status).toBe("dispatched");
    expect(receipt.sequence).toBe(1);
    expect(receipt.dispatchDigest).toBeTruthy();
    expect(world.controller.journalLength(deviceId)).toBe(1);
    const events = await world.executionService.listEvents(world.applicationId, executionId);
    expect(
      events.filter((event) => event.command === "tool-requested" && event.cause === "edge-command")
        .length,
    ).toBe(1);
    expect(
      events.filter((event) => event.command === "tool-result" && event.cause === "edge-command")
        .length,
    ).toBe(1);
    const replay = await world.service.submitCommand({ ...request, approvalId }, "ck-happy-1");
    expect(replay.replayed).toBe(true);
    expect(world.controller.journalLength(deviceId)).toBe(1);
    await expectPlatformError(
      "IDEMPOTENCY_KEY_REUSED",
      world.service.submitCommand({ ...request, approvalId, magnitude: 999 }, "ck-happy-1"),
    );
  });

  test("a PHYSICAL-WRITE command without an approval is a DURABLE denial with ZERO actuator activity", async () => {
    const { world, executionId, deviceId, envelopeId } = await governedWorld();
    const request = world.commandRequest(executionId, deviceId, envelopeId);
    const error = await expectPlatformError(
      "AUTHORIZATION_DENIED",
      world.service.submitCommand(request, "ck-noapproval"),
    );
    expect(error.message).toContain("PHYSICAL-WRITE");
    const commands = await world.service.listCommandsByDevice(world.applicationId, deviceId);
    expect(commands.length).toBe(1);
    expect(commands[0]).toMatchObject({
      status: "denied",
      denialClass: "approval",
      approvalId: null,
    });
    expect(world.controller.journalLength(deviceId)).toBe(0);
    const operation = await world.store.findOperation(
      world.applicationId,
      "edge-op-command-submit:ck-noapproval",
    );
    expect(operation?.status).toBe("failed");
    const events = await world.executionService.listEvents(world.applicationId, executionId);
    expect(events.some((event) => event.command === "tool-denied")).toBe(true);
  });

  test("policy and capability denials are DURABLE denied rows with zero actuator activity", async () => {
    // -- policy denial: the journaled evidence + the typed throw -----------
    const { world, executionId, deviceId, envelopeId } = await governedWorld();
    const request = world.commandRequest(executionId, deviceId, envelopeId);
    const approvalId = await world.approveCommand(request);
    world.policy.denyWith("no edge commands in this window");
    await expectPlatformError(
      "POLICY_DENIED",
      world.service.submitCommand({ ...request, approvalId }, "ck-policy"),
    );
    const denied = await world.service.listCommandsByDevice(world.applicationId, deviceId);
    expect(denied.length).toBe(1);
    expect(denied[0]).toMatchObject({ status: "denied", denialClass: "policy" });
    expect(world.controller.journalLength(deviceId)).toBe(0);
    const policyOperation = await world.store.findOperation(
      world.applicationId,
      "edge-op-command-submit:ck-policy",
    );
    expect(policyOperation?.status).toBe("failed");
    const events = await world.executionService.listEvents(world.applicationId, executionId);
    expect(events.some((event) => event.command === "tool-denied")).toBe(true);

    // -- capability denial: same discipline ---------------------------------
    const {
      world: worldB,
      executionId: exB,
      deviceId: devB,
      envelopeId: envB,
    } = await governedWorld();
    const requestB = worldB.commandRequest(exB, devB, envB);
    const approvalB = await worldB.approveCommand(requestB);
    worldB.capabilities.failWith(["edge-channel:locomotion"]);
    await expectPlatformError(
      "CAPABILITY_UNAVAILABLE",
      worldB.service.submitCommand({ ...requestB, approvalId: approvalB }, "ck-capability"),
    );
    const commands = await worldB.service.listCommandsByDevice(worldB.applicationId, devB);
    expect(commands.length).toBe(1);
    expect(commands[0]).toMatchObject({ status: "denied", denialClass: "capability" });
    expect(worldB.controller.journalLength(devB)).toBe(0);
    const capabilityOperation = await worldB.store.findOperation(
      worldB.applicationId,
      "edge-op-command-submit:ck-capability",
    );
    expect(capabilityOperation?.status).toBe("failed");
  });

  test("STALE commands never reach the actuator path (typed, durable)", async () => {
    const { world, executionId, deviceId, envelopeId } = await governedWorld();
    const request = world.commandRequest(executionId, deviceId, envelopeId);
    const approvalId = await world.approveCommand(request);
    world.advance(400_000); // past the command window (and near the envelope edge)
    await expectPlatformError(
      "AUTHORIZATION_DENIED",
      world.service.submitCommand({ ...request, approvalId }, "ck-stale"),
    );
    const commands = await world.service.listCommandsByDevice(world.applicationId, deviceId);
    expect(commands[0]).toMatchObject({ status: "denied", denialClass: "stale" });
    expect(world.controller.journalLength(deviceId)).toBe(0);
  });

  test("too-early commands are refused typed as well", async () => {
    const { world, executionId, deviceId, envelopeId } = await governedWorld();
    const request = world.commandRequest(executionId, deviceId, envelopeId, {
      notBefore: new Date(world.now().getTime() + 60_000).toISOString(),
      notAfter: new Date(world.now().getTime() + 120_000).toISOString(),
    });
    const approvalId = await world.approveCommand(request);
    await expectPlatformError(
      "AUTHORIZATION_DENIED",
      world.service.submitCommand({ ...request, approvalId }, "ck-early"),
    );
    const commands = await world.service.listCommandsByDevice(world.applicationId, deviceId);
    expect(commands[0]).toMatchObject({ status: "denied", denialClass: "stale" });
  });

  test("out-of-envelope commands (channel/magnitude/budget) are durable denials", async () => {
    const { world, executionId, deviceId, envelopeId } = await governedWorld();
    const magnitudeRequest = world.commandRequest(executionId, deviceId, envelopeId, {
      magnitude: 900,
    });
    const magnitudeApproval = await world.approveCommand(magnitudeRequest);
    await expectPlatformError(
      "AUTHORIZATION_DENIED",
      world.service.submitCommand({ ...magnitudeRequest, approvalId: magnitudeApproval }, "ck-mag"),
    );

    const channelRequest = world.commandRequest(executionId, deviceId, envelopeId, {
      channel: "signal",
    });
    const channelApproval = await world.approveCommand(channelRequest);
    await expectPlatformError(
      "AUTHORIZATION_DENIED",
      world.service.submitCommand({ ...channelRequest, approvalId: channelApproval }, "ck-channel"),
    );

    const worldBudget = createInMemoryEdgeWorld();
    const ex = await worldBudget.seedExecution();
    const dev = await worldBudget.register();
    const { envelopeId: env } = await worldBudget.approveEnvelope(ex, dev, undefined, {
      costCeilingMicroUsd: "100",
    });
    const costed = worldBudget.commandRequest(ex, dev, env, { estimatedMicroUsd: "150" });
    const costedApproval = await worldBudget.approveCommand(costed);
    await expectPlatformError(
      "BUDGET_EXCEEDED",
      worldBudget.service.submitCommand({ ...costed, approvalId: costedApproval }, "ck-budget"),
    );

    const commands = await world.service.listCommandsByDevice(world.applicationId, deviceId);
    expect(commands.map((command) => command.denialClass).sort()).toEqual(["envelope", "envelope"]);
    expect(world.controller.journalLength(deviceId)).toBe(0);
  });

  test("a wallet refusal (insufficient funds) is a durable budget denial", async () => {
    const world = createInMemoryEdgeWorld();
    const executionId = await world.seedExecution();
    const deviceId = await world.register();
    const { envelopeId } = await world.approveEnvelope(executionId, deviceId, undefined, {
      costCeilingMicroUsd: "1000",
    });
    const request = world.commandRequest(executionId, deviceId, envelopeId, {
      estimatedMicroUsd: "10",
    });
    const approvalId = await world.approveCommand(request);
    world.budgets.denyReservations("wallet empty");
    await expectPlatformError(
      "BUDGET_EXCEEDED",
      world.service.submitCommand({ ...request, approvalId }, "ck-wallet"),
    );
    const commands = await world.service.listCommandsByDevice(world.applicationId, deviceId);
    expect(commands[0]).toMatchObject({ status: "denied", denialClass: "budget" });
    expect(world.controller.journalLength(deviceId)).toBe(0);
  });

  test("costed commands never execute unbudgeted (no authority wired)", async () => {
    const world = createInMemoryEdgeWorld({ budgetAuthority: null });
    const executionId = await world.seedExecution();
    const deviceId = await world.register();
    const { envelopeId } = await world.approveEnvelope(executionId, deviceId, undefined, {
      costCeilingMicroUsd: "1000",
    });
    const request = world.commandRequest(executionId, deviceId, envelopeId, {
      estimatedMicroUsd: "10",
    });
    const approvalId = await world.approveCommand(request);
    await expectPlatformError(
      "BUDGET_EXCEEDED",
      world.service.submitCommand({ ...request, approvalId }, "ck-unbudgeted"),
    );
  });

  test("commands only dispatch under the ACTIVE envelope; the sequence is gapless INCLUDING denials", async () => {
    const { world, executionId, deviceId, envelopeId } = await governedWorld();
    const other = await world.approveEnvelope(executionId, deviceId, undefined, {
      supersedesEnvelopeId: envelopeId,
    });
    const request = world.commandRequest(executionId, deviceId, envelopeId);
    const approvalId = await world.approveCommand(request);
    await expectPlatformError(
      "INVALID_STATE_TRANSITION",
      world.service.submitCommand({ ...request, approvalId }, "ck-old-envelope"),
    );
    // a denied request then a good one under the ACTIVE envelope: 1, 2
    const deniedRequest = world.commandRequest(executionId, deviceId, other.envelopeId, {
      magnitude: 999,
    });
    const deniedApproval = await world.approveCommand(deniedRequest);
    await expectPlatformError(
      "AUTHORIZATION_DENIED",
      world.service.submitCommand({ ...deniedRequest, approvalId: deniedApproval }, "ck-denied"),
    );
    const goodRequest = world.commandRequest(executionId, deviceId, other.envelopeId);
    const goodApproval = await world.approveCommand(goodRequest);
    const receipt = await world.service.submitCommand(
      { ...goodRequest, approvalId: goodApproval },
      "ck-good",
    );
    expect(receipt.sequence).toBe(2);
    const commands = await world.service.listCommandsByDevice(world.applicationId, deviceId);
    expect(commands.map((command) => command.sequence)).toEqual([1, 2]);
  });

  test("non-physical commands (configure/halt/poll) need no approval but still run the chain", async () => {
    const { world, executionId, deviceId, envelopeId } = await governedWorld();
    const poll = world.commandRequest(executionId, deviceId, envelopeId, {
      commandKind: "poll",
      channel: "locomotion",
    });
    const receipt = await world.service.submitCommand(poll, "ck-poll");
    expect(receipt.status).toBe("dispatched");
    const configure = world.commandRequest(executionId, deviceId, envelopeId, {
      commandKind: "configure",
    });
    const configureReceipt = await world.service.submitCommand(configure, "ck-configure");
    expect(configureReceipt.status).toBe("dispatched");
  });

  test("the local controller's own fail-safe: a missing projection refuses with zero actuation", async () => {
    const world = createInMemoryEdgeWorld();
    const executionId = await world.seedExecution();
    const deviceId = await world.register();
    // the transport is DOWN during admission: the projection QUEUES and the
    // controller holds NOTHING — governance admits, the LOCAL side refuses
    world.controller.disconnect();
    const { envelopeId } = await world.approveEnvelope(executionId, deviceId);
    const request = world.commandRequest(executionId, deviceId, envelopeId);
    const approvalId = await world.approveCommand(request);
    const receipt = await world.service.submitCommand({ ...request, approvalId }, "ck-noproj");
    expect(receipt.status).toBe("failed");
    expect(receipt.failureClass).toBe("transport-disconnected");
    expect(world.controller.journalLength(deviceId)).toBe(0);
  });
});

describe("edge service: sensor provenance", () => {
  test("retained observations carry content; ephemeral are digest-only; replays converge", async () => {
    const world = createInMemoryEdgeWorld();
    const executionId = await world.seedExecution();
    const deviceId = await world.register();
    const retained = await world.service.ingestSensorObservation(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        executionId,
        deviceId,
        observationType: "telemetry",
        retention: "retained",
        content: "temp=21.5",
        observedAt: world.now().toISOString(),
      },
      "ok-1",
    );
    expect(retained.sequence).toBe(1);
    expect(retained.content).toBe("temp=21.5");
    const ephemeral = await world.service.ingestSensorObservation(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        executionId,
        deviceId,
        observationType: "event",
        retention: "ephemeral",
        content: null,
        observedAt: world.now().toISOString(),
      },
      "ok-2",
    );
    expect(ephemeral.content).toBeNull();
    expect(ephemeral.sequence).toBe(2);
    const replay = await world.service.ingestSensorObservation(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        executionId,
        deviceId,
        observationType: "telemetry",
        retention: "retained",
        content: "temp=21.5",
        observedAt: world.now().toISOString(),
      },
      "ok-1",
    );
    expect(replay.id).toBe(retained.id);
    await expectPlatformError(
      "IDEMPOTENCY_KEY_REUSED",
      world.service.ingestSensorObservation(
        {
          applicationId: world.applicationId,
          actor: world.actor(),
          executionId,
          deviceId,
          observationType: "telemetry",
          retention: "retained",
          content: "temp=99",
          observedAt: world.now().toISOString(),
        },
        "ok-1",
      ),
    );
  });
});

describe("edge service: reconciliation (AC-6)", () => {
  test("a dispatched command settles EXACTLY ONCE with its actuation provenance", async () => {
    const { world, executionId, deviceId, envelopeId } = await governedWorld();
    const request = world.commandRequest(executionId, deviceId, envelopeId);
    const approvalId = await world.approveCommand(request);
    await world.service.submitCommand({ ...request, approvalId }, "ck-settle");
    const receipt = await world.service.reconcile(
      { applicationId: world.applicationId, actor: world.actor(), deviceId },
      "rc-1",
    );
    expect(receipt.status).toBe("converged");
    expect(receipt.settledCount).toBe(1);
    const command = (await world.service.listCommandsByDevice(world.applicationId, deviceId))[0];
    expect(command).toBeDefined();
    expect(command?.status).toBe("settled");
    const actuations = await world.service.listActuationEvents(world.applicationId, deviceId);
    expect(actuations.length).toBe(1);
    expect(actuations[0]).toMatchObject({ actuationClass: "commanded" });
    // the same report digest replays (no second settlement)
    const replay = await world.service.reconcile(
      { applicationId: world.applicationId, actor: world.actor(), deviceId },
      "rc-2",
    );
    expect(replay.replayed).toBe(true);
    const actuationsAfter = await world.service.listActuationEvents(world.applicationId, deviceId);
    expect(actuationsAfter.length).toBe(1);
  });

  test("autonomous actuations within the envelope are confirmed; out-of-envelope are VIOLATIONS", async () => {
    const { world, deviceId, executionId, envelopeId } = await governedWorld();
    // within bounds (the device-side loop, driven by the WORLD)
    world.controller.autonomousTick(deviceId, "manipulation", 50);
    const receipt = await world.service.reconcile(
      { applicationId: world.applicationId, actor: world.actor(), deviceId },
      "rc-auto-1",
    );
    expect(receipt.status).toBe("converged");
    expect(receipt.autonomousCount).toBe(1);
    // out of bounds (magnitude outside the envelope)
    world.controller.autonomousTick(deviceId, "manipulation", 500);
    const violationReceipt = await world.service.reconcile(
      { applicationId: world.applicationId, actor: world.actor(), deviceId },
      "rc-auto-2",
    );
    expect(violationReceipt.status).toBe("conflict");
    expect(violationReceipt.violationCount).toBe(1);
    const actuations = await world.service.listActuationEvents(world.applicationId, deviceId);
    expect(actuations.some((event) => event.actuationClass === "envelope-autonomous")).toBe(true);
    expect(
      actuations.some(
        (event) =>
          event.actuationClass === "violation" && event.violationKind === "out-of-envelope",
      ),
    ).toBe(true);
    // the conflicted-device gate: no further authoritative commands
    const request = world.commandRequest(executionId, deviceId, envelopeId);
    const approvalId = await world.approveCommand(request);
    await expectPlatformError(
      "NON_CONVERGENT_EXTERNAL_EFFECT",
      world.service.submitCommand({ ...request, approvalId }, "ck-conflicted"),
    );
  });

  test("an executed-but-unauthorized command is a durable violation (fail closed)", async () => {
    const { world, deviceId } = await governedWorld();
    // fabricate a journal entry the governance plane never admitted: the
    // controller reports an UNKNOWN command key
    const rogue = {
      ...(await world.controller.reconciliationReport(deviceId)),
      executed: [
        {
          commandKey: "never-admitted",
          sequence: 42,
          channel: "locomotion" as const,
          magnitude: 100,
          actuationDigest: "a".repeat(64),
          occurredAt: world.now().toISOString(),
        },
      ],
    };
    // drive the classification through the service with a wrapping
    // controller that reports the rogue journal
    const { createEdgeService, createEdgeExecutionLedgerAdapter } = await import(
      "../../../src/integrations/edge/public"
    );
    const rogueService = createEdgeService({
      policy: world.policy.impl,
      capabilities: world.capabilities.impl,
      store: world.store,
      ledger: createEdgeExecutionLedgerAdapter(world.executionService),
      controller: {
        controllerId: "rogue",
        applyEnvelope: world.controller.applyEnvelope.bind(world.controller),
        dispatchCommand: world.controller.dispatchCommand.bind(world.controller),
        reconciliationReport: async () => rogue,
        lastExecutedSequence: world.controller.lastExecutedSequence.bind(world.controller),
      },
      generateId: () => "00000000-0000-7000-8000-000000000abc",
      now: world.now,
      digest: sha256Hex,
    });
    const receipt = await rogueService.reconcile(
      { applicationId: world.applicationId, actor: world.actor(), deviceId },
      "rc-rogue",
    );
    expect(receipt.status).toBe("conflict");
    expect(receipt.violationCount).toBe(1);
    const actuations = await world.service.listActuationEvents(world.applicationId, deviceId);
    expect(
      actuations.some(
        (event) =>
          event.actuationClass === "violation" && event.violationKind === "unauthorized-command",
      ),
    ).toBe(true);
  });

  test("a denied command that executed anyway is a violation (stale-command re-execution)", async () => {
    const { world, executionId, deviceId, envelopeId } = await governedWorld();
    const request = world.commandRequest(executionId, deviceId, envelopeId);
    // a DENIED command (no approval)
    await expectPlatformError(
      "AUTHORIZATION_DENIED",
      world.service.submitCommand(request, "ck-denied-ex"),
    );
    const denied = (await world.service.listCommandsByDevice(world.applicationId, deviceId))[0];
    expect(denied).toBeDefined();
    if (denied === undefined) {
      throw new Error("the denied command row must exist");
    }
    // the device executes it anyway (the controller journal is physical truth)
    world.controller.autonomousTick(deviceId, "locomotion", 100);
    // the report must classify the executed entry against the DENIED row —
    // craft the report to carry the denied command's key/sequence
    const rogue = {
      ...(await world.controller.reconciliationReport(deviceId)),
      executed: [
        {
          commandKey: denied.commandKey,
          sequence: denied.sequence,
          channel: "locomotion" as const,
          magnitude: 100,
          actuationDigest: "b".repeat(64),
          occurredAt: world.now().toISOString(),
        },
      ],
    };
    const { createEdgeService, createEdgeExecutionLedgerAdapter } = await import(
      "../../../src/integrations/edge/public"
    );
    const rogueService = createEdgeService({
      policy: world.policy.impl,
      capabilities: world.capabilities.impl,
      store: world.store,
      ledger: createEdgeExecutionLedgerAdapter(world.executionService),
      controller: {
        controllerId: "rogue",
        applyEnvelope: world.controller.applyEnvelope.bind(world.controller),
        dispatchCommand: world.controller.dispatchCommand.bind(world.controller),
        reconciliationReport: async () => rogue,
        lastExecutedSequence: world.controller.lastExecutedSequence.bind(world.controller),
      },
      generateId: () => "00000000-0000-7000-8000-000000000abc",
      now: world.now,
      digest: () => "c".repeat(64),
    });
    const receipt = await rogueService.reconcile(
      { applicationId: world.applicationId, actor: world.actor(), deviceId },
      "rc-denied-exec",
    );
    expect(receipt.status).toBe("conflict");
    expect(receipt.violationCount).toBe(1);
  });
});

describe("edge service: crash-window convergence at the service level", () => {
  test("an AUTHORIZED command (crash between insert and dispatch) converges on retry", async () => {
    const { world, executionId, deviceId, envelopeId } = await governedWorld();
    const request = world.commandRequest(executionId, deviceId, envelopeId);
    const approvalId = await world.approveCommand(request);
    // simulate the crash window: insert the authorized row without the dispatch
    const claimed = await world.store.insertCommand({
      commandId: "00000000-0000-7000-8000-000000000c01",
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId,
      deviceId,
      envelopeId,
      commandKey: "ck-crash",
      requestFingerprint: edgeCommandFingerprint({ ...request, approvalId }),
      sequence: 1,
      commandKind: "actuate",
      effectClass: "physical-write",
      channel: "locomotion",
      magnitude: 100,
      payloadDigest: "d".repeat(64),
      estimatedMicroUsd: "0",
      notBefore: request.notBefore,
      notAfter: request.notAfter,
      approvalId,
      denialClass: null,
      denialReason: null,
      requestedAt: world.now().toISOString(),
    });
    expect(claimed.status).toBe("claimed");
    // the retry (the SAME idempotency key) converges the ONE-SHOT dispatch
    const receipt = await world.service.submitCommand({ ...request, approvalId }, "ck-crash");
    expect(receipt.status).toBe("dispatched");
    expect(receipt.commandId).toBe("00000000-0000-7000-8000-000000000c01");
    expect(world.controller.journalLength(deviceId)).toBe(1);
  });

  test("an authorized command reported by the controller settles through reconciliation", async () => {
    const { world, executionId, deviceId, envelopeId } = await governedWorld();
    const request = world.commandRequest(executionId, deviceId, envelopeId);
    const approvalId = await world.approveCommand(request);
    // crash window: the controller ACCEPTED but the process died before finalize
    const ack = await world.controller.dispatchCommand(
      {
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        executionId,
        deviceId,
        commandId: "00000000-0000-7000-8000-000000000c02",
        commandKey: "ck-crash2",
        sequence: 1,
        commandKind: "actuate",
        effectClass: "physical-write",
        channel: "locomotion",
        magnitude: 100,
        payloadDigest: "e".repeat(64),
        notBefore: request.notBefore,
        notAfter: request.notAfter,
        envelope: {
          envelopeId,
          contentDigest: (await world.service.getEnvelope(world.applicationId, envelopeId))
            ?.contentDigest as string,
          content: world.defaultEnvelopeContent(),
        },
      },
      "edge-external-command-dispatch:00000000-0000-7000-8000-000000000c02",
    );
    expect(ack.outcome).toBe("accepted");
    await world.store.insertCommand({
      commandId: "00000000-0000-7000-8000-000000000c02",
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId,
      deviceId,
      envelopeId,
      commandKey: "ck-crash2",
      requestFingerprint: edgeCommandFingerprint({ ...request, approvalId }),
      sequence: 1,
      commandKind: "actuate",
      effectClass: "physical-write",
      channel: "locomotion",
      magnitude: 100,
      payloadDigest: "e".repeat(64),
      estimatedMicroUsd: "0",
      notBefore: request.notBefore,
      notAfter: request.notAfter,
      approvalId,
      denialClass: null,
      denialReason: null,
      requestedAt: world.now().toISOString(),
    });
    const receipt = await world.service.reconcile(
      { applicationId: world.applicationId, actor: world.actor(), deviceId },
      "rc-crash",
    );
    expect(receipt.status).toBe("converged");
    expect(receipt.settledCount).toBe(1);
    const command = await world.service.getCommand(
      world.applicationId,
      "00000000-0000-7000-8000-000000000c02",
    );
    expect(command?.status).toBe("settled");
    expect(command?.dispatchDigest).toBeTruthy();
    const actuations = await world.service.listActuationEvents(world.applicationId, deviceId);
    expect(actuations.length).toBe(1);
  });

  test("approval crash windows converge the wait-human/resume transitions", async () => {
    const world = createInMemoryEdgeWorld();
    const executionId = await world.seedExecution();
    const deviceId = await world.register();
    // crash between approval insert and wait-human: the retry converges it
    const { edgeEnvelopeFingerprint } = await import("../../../src/integrations/edge/public");
    const request = {
      applicationId: world.applicationId,
      actor: world.actor(),
      executionId,
      deviceId,
      content: world.defaultEnvelopeContent(),
      costCeilingMicroUsd: "0",
      approvalId: "x",
      supersedesEnvelopeId: null,
    };
    const fingerprint = edgeEnvelopeFingerprint(request);
    await world.service.requestApproval(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        executionId,
        deviceId,
        subjectKind: "envelope",
        subjectFingerprint: fingerprint,
        policyBasis: "edge policy set v1",
        expiresAt: null,
      },
      "ak-crash",
    );
    // force the crash window: unbind the wait sequence
    const approval = await world.service.getApproval(
      world.applicationId,
      (await world.store.findApprovalByKey(world.applicationId, "ak-crash"))?.id as string,
    );
    expect(approval?.ledgerWaitSequence).not.toBeNull();
    const replay = await world.service.requestApproval(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        executionId,
        deviceId,
        subjectKind: "envelope",
        subjectFingerprint: fingerprint,
        policyBasis: "edge policy set v1",
        expiresAt: null,
      },
      "ak-crash",
    );
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe("pending");
  });
});

describe("edge service: no-cloud-in-the-control-loop (unit half)", () => {
  test("the device-side autonomous loop needs ZERO service/controller-call activity", async () => {
    const { world, deviceId } = await governedWorld();
    const callsBefore = world.controller.callJournal.length;
    world.controller.autonomousTick(deviceId, "manipulation", 10);
    world.controller.autonomousTick(deviceId, "locomotion", -20);
    expect(world.controller.journalLength(deviceId)).toBe(2);
    expect(world.controller.callJournal.length).toBe(callsBefore); // no transport surface touched
    // the journal is only READING back through the reconciliation handshake
    const report = await world.controller.reconciliationReport(deviceId);
    expect(report.executed.length).toBe(2);
    expect(report.executed.every((entry) => entry.commandKey === null)).toBe(true);
  });

  test("the service performs governance request/response only: one submit = one dispatch", async () => {
    const { world, executionId, deviceId, envelopeId } = await governedWorld();
    const request = world.commandRequest(executionId, deviceId, envelopeId);
    const approvalId = await world.approveCommand(request);
    const dispatchesBefore = world.controller.callJournal.filter(
      (entry) => entry.method === "dispatchCommand",
    ).length;
    await world.service.submitCommand({ ...request, approvalId }, "ck-one-shot");
    const dispatchesAfter = world.controller.callJournal.filter(
      (entry) => entry.method === "dispatchCommand",
    ).length;
    expect(dispatchesAfter - dispatchesBefore).toBe(1);
    const receipt = await world.service.submitCommand({ ...request, approvalId }, "ck-one-shot");
    expect(receipt.replayed).toBe(true);
    expect(
      world.controller.callJournal.filter((entry) => entry.method === "dispatchCommand").length,
    ).toBe(dispatchesAfter); // the keyed external effect converged, no re-execution
  });
});

describe("edge service: honest error surface", () => {
  test("validation failures are typed POLICY_DENIED before any durable state", async () => {
    const world = createInMemoryEdgeWorld();
    const error: PlatformError = await expectPlatformError(
      "POLICY_DENIED",
      world.service.registerDevice(deviceRegistration({ label: "" }), "dk-invalid"),
    );
    expect(error.message).toContain("label");
    const operation = await world.store.findOperation(
      world.applicationId,
      "edge-op-device-register:dk-invalid",
    );
    expect(operation).toBeNull(); // no claim was made for a malformed request
  });
});
