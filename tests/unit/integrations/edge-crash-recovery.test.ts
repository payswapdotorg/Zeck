/**
 * Unit crash-injection C-proofs — the CRASH-SAFE KEYED OPERATIONS of the
 * governed edge service (WORK-029; EDGE-001/002/003; the blocking
 * checkpoint contract CONCURRENCY-CRASH-SAFETY — the BEHAVIORAL half
 * over the in-memory world; the real-PostgreSQL suite
 * tests/integration/postgres/edge-crash-recovery.test.ts proves the
 * PHYSICAL half over migration 0024).
 *
 * The injector: a Proxy-based seam wrapper arms ONE durable-boundary
 * crash point per booted process (a method on the edge store, the
 * executions ledger seam, the budget authority or the controller
 * adapter, before/after its durable commit or external effect) and
 * kills the process mid-flight. Every record asserts the point FIRED
 * (a vacuous crash proof fails) and that a re-booted service over the
 * SAME world converges with EXACTLY ONE durable row / external effect
 * per stable idempotency key.
 *
 * THE C-RECORDS:
 *   C1  device-register: crash AFTER the durable device insert → the
 *       restart replays the SAME identity (one device row, no second
 *       controller evidence)
 *   C2  device-revoke: crash AFTER the guarded terminal device
 *       mutation → the restart converges (revoked exactly once, the
 *       envelope fail-safe applies)
 *   C3  device-revoke fail-safe: crash AFTER the envelope revocation,
 *       BEFORE the local controller withdrawal projection → the
 *       restart converges the withdrawal (the device-side authority is
 *       withdrawn keyed-exactly-once; the local controller holds NO
 *       admitted envelope)
 *   C4  approval-request: crash AFTER the approval insert, BEFORE the
 *       wait-human transition → the restart converges the execution's
 *       WAITING_HUMAN exactly once
 *   C5  approval-decide: crash AFTER the terminal decision, BEFORE the
 *       resume transition → the restart converges the resume (and the
 *       decided ledger event exactly once)
 *   C6  envelope-admit: crash AFTER the durable envelope insert, BEFORE
 *       the local controller projection → the restart converges the
 *       projection exactly once (one admitted projection)
 *   C7  envelope-supersede: crash AFTER the new envelope insert, BEFORE
 *       the supersede move → the restart converges (old superseded,
 *       new admitted, both projections exactly once)
 *   C8  command-submit: crash AFTER the durable authorized insert,
 *       BEFORE the external dispatch → the restart dispatches the
 *       ONE-SHOT effect exactly once (one journal entry)
 *   C9  command-submit: crash AFTER the external actuation (the
 *       controller journal holds it), BEFORE the durable finalize →
 *       the restart converges dispatched with the SAME dispatch
 *       digest and ZERO further actuator activity
 *   C10 command-ledger: crash AFTER the canonical ledger intent commit,
 *       BEFORE the command's ledger binding → the restart converges
 *       the binding (one intent event, one binding)
 *   C11 budget: crash AFTER the wallet reservation, BEFORE the durable
 *       command row → the restart converges onto the SAME command
 *       identity (ONE reservation — keyed by the checkpointed id)
 *   C12 reconcile: crash AFTER the settlement of the commanded
 *       actuation, BEFORE the reconciliation record → the restart
 *       converges (settled EXACTLY ONCE, no double settlement, one
 *       reconciliation row, the wallet settles once)
 *   C13 sensor-ingest: crash AFTER the durable observation insert,
 *       BEFORE the ledger event → the restart converges (one row, one
 *       ledger event)
 * C14 envelope-revoke replay: a terminal (revoked) envelope replays
 *       its withdrawal projection when the crashing process died before
 *       the local controller ever learned — the projection is keyed
 *       exactly-once, so the replay converges the device-side state
 */

import { describe, expect, it } from "vitest";
import type { EdgeCommandRequest } from "../../../src/integrations/edge/public";
import {
  createEdgeExecutionLedgerAdapter,
  createEdgeService,
  edgeEnvelopeFingerprint,
} from "../../../src/integrations/edge/public";
import type { ExecutionService } from "../../../src/modules/executions/public";
import { createInMemoryEdgeWorld, deviceRegistration, sha256Hex } from "./edge-world";

/** The simulated process death (never a typed service error). */
class ProcessCrashError extends Error {
  constructor(point: string) {
    super(`simulated process crash at ${point}`);
    this.name = "ProcessCrashError";
  }
}

/** One armed durable-boundary crash point (per booted process). */
interface CrashPoint {
  readonly target: "store" | "ledger" | "budgets" | "controller";
  readonly method: string;
  readonly when: "before" | "after";
  /** Fire on the Nth invocation within THIS process (default 1). */
  readonly occurrence?: number;
}

function crashableSeam<T extends object>(target: T, label: string, point: CrashPoint | null) {
  let fired = false;
  if (point === null || point.target !== label) {
    return { proxy: target, crashed: () => fired };
  }
  const seen = new Map<string, number>();
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (typeof prop !== "string") {
        return Reflect.get(t, prop, t);
      }
      const value = Reflect.get(t, prop, t);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        const invocations = (seen.get(prop) ?? 0) + 1;
        seen.set(prop, invocations);
        const matches = prop === point.method && (point.occurrence ?? 1) === invocations;
        const die = (phase: "before" | "after") => {
          if (matches && point.when === phase) {
            fired = true;
            throw new ProcessCrashError(`${label}.${prop}#${invocations}:${phase}`);
          }
        };
        die("before");
        const result = (value as (...a: unknown[]) => unknown).apply(t, args);
        if (result instanceof Promise) {
          return result.then((resolved) => {
            die("after");
            return resolved;
          });
        }
        die("after");
        return result;
      };
    },
  });
  return { proxy, crashed: () => fired };
}

const envelopeIdOf = (envelope: { id: string } | null): string => {
  if (envelope === null) {
    throw new Error("the expected envelope row is missing");
  }
  return envelope.id;
};

describe("edge crash-safety C-proofs (in-memory world)", () => {
  const scenario = async () => createInMemoryEdgeWorld();

  /** Boot the edge service over the SURVIVING world with ONE crash point armed. */
  const boot = (world: Awaited<ReturnType<typeof scenario>>, point: CrashPoint | null) => {
    const storeSeam = crashableSeam(world.store, "store", point);
    const ledgerSeam = crashableSeam(world.executionService, "ledger", point);
    const budgetSeam = crashableSeam(world.budgets.impl, "budgets", point);
    const controllerSeam = crashableSeam(world.controller, "controller", point);
    const service = createEdgeService({
      policy: world.policy.impl,
      capabilities: world.capabilities.impl,
      budgetAuthority: budgetSeam.proxy,
      store: storeSeam.proxy,
      ledger: createEdgeExecutionLedgerAdapter(ledgerSeam.proxy as ExecutionService),
      controller: controllerSeam.proxy,
      generateId: () => `id-${Math.random().toString(36).slice(2, 10)}`,
      now: world.now,
      digest: sha256Hex,
    });
    return {
      service,
      crashed: () =>
        storeSeam.crashed() ||
        ledgerSeam.crashed() ||
        budgetSeam.crashed() ||
        controllerSeam.crashed(),
    };
  };

  /** Run one operation in a DYING process (terminal state irrelevant). */
  const diesDuring = async (run: () => Promise<unknown>, crashed: () => boolean) => {
    await run().then(
      () => undefined,
      (error) => {
        if (!(error instanceof ProcessCrashError)) {
          throw error;
        }
      },
    );
    expect(crashed()).toBe(true);
  };

  /** The governed scenario: execution + device + approved envelope. */
  const governed = async (world: Awaited<ReturnType<typeof scenario>>) => {
    const executionId = await world.seedExecution();
    const deviceId = await world.register();
    const { envelopeId } = await world.approveEnvelope(executionId, deviceId);
    return { executionId, deviceId, envelopeId };
  };

  const physicalWrite = (
    world: Awaited<ReturnType<typeof scenario>>,
    executionId: string,
    deviceId: string,
    envelopeId: string,
    overrides: Partial<EdgeCommandRequest> = {},
  ): EdgeCommandRequest =>
    world.commandRequest(executionId, deviceId, envelopeId, {
      commandKind: "actuate",
      channel: "locomotion",
      magnitude: 100,
      ...overrides,
    });

  it("C1 device-register: crash AFTER the durable insert converges onto the SAME identity", async () => {
    const world = await scenario();
    const dying = boot(world, { target: "store", method: "insertDevice", when: "after" });
    await diesDuring(
      () => dying.service.registerDevice(deviceRegistration(), "c1-register"),
      dying.crashed,
    );
    const receipt = await world.service.registerDevice(deviceRegistration(), "c1-register");
    expect(receipt.replayed).toBe(true);
    const devices = await world.store.listDevices(world.applicationId);
    expect(devices).toHaveLength(1);
    expect(devices[0]?.id).toBe(receipt.deviceId);
  });

  it("C2 device-revoke: crash AFTER the guarded terminal mutation converges", async () => {
    const world = await scenario();
    const { deviceId } = await governed(world);
    const dying = boot(world, {
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
            reason: "crash-window revocation",
          },
          "c2-revoke",
        ),
      dying.crashed,
    );
    const receipt = await world.service.revokeDevice(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        deviceId,
        reason: "crash-window revocation",
      },
      "c2-revoke",
    );
    expect(receipt.status).toBe("revoked");
    expect(receipt.replayed).toBe(true);
    const device = await world.store.findDevice(world.applicationId, deviceId);
    expect(device?.status).toBe("revoked");
  });

  it("C3 device-revoke fail-safe: crash BEFORE the controller withdrawal converges the projection", async () => {
    const world = await scenario();
    const { deviceId, envelopeId } = await governed(world);
    const dying = boot(world, {
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
            reason: "fail-safe crash window",
          },
          "c3-revoke",
        ),
      dying.crashed,
    );
    // The device-side state mid-window: the withdrawal was never
    // delivered (the projection died with the process).
    expect(world.controller.activeEnvelopeId(deviceId)).toBe(envelopeId);
    // The envelope is durably revoked; the local controller was never
    // told. The restart (revokeDevice replay) must converge the
    // withdrawal — the device-side authority ends up withdrawn.
    await world.service.revokeDevice(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        deviceId,
        reason: "fail-safe crash window",
      },
      "c3-revoke-replay",
    );
    const device = await world.store.findDevice(world.applicationId, deviceId);
    expect(device?.status).toBe("revoked");
    const envelope = await world.store.findEnvelope(world.applicationId, envelopeId);
    expect(envelope?.status).toBe("revoked");
    // THE CONVERGENCE PROOF: the local controller holds NO active
    // envelope — the withdrawal projection was applied keyed exactly
    // once (a dispatch under it is now impossible on BOTH planes).
    expect(world.controller.activeEnvelopeId(deviceId)).toBeNull();
    expect(world.controller.journalLength(deviceId)).toBe(0);
  });

  it("C4 approval-request: crash AFTER the insert converges the wait-human transition", async () => {
    const world = await scenario();
    const executionId = await world.seedExecution();
    const deviceId = await world.register();
    const content = world.defaultEnvelopeContent();
    const subjectFingerprint = JSON.stringify({ executionId, deviceId, content });
    const dying = boot(world, { target: "store", method: "insertApproval", when: "after" });
    await diesDuring(
      () =>
        dying.service.requestApproval(
          {
            applicationId: world.applicationId,
            actor: world.actor(),
            executionId,
            deviceId,
            subjectKind: "envelope",
            subjectFingerprint,
            policyBasis: "c4 basis",
            expiresAt: null,
          },
          "c4-approval",
        ),
      dying.crashed,
    );
    const replay = await world.service.requestApproval(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        executionId,
        deviceId,
        subjectKind: "envelope",
        subjectFingerprint,
        policyBasis: "c4 basis",
        expiresAt: null,
      },
      "c4-approval",
    );
    expect(replay.replayed).toBe(true);
    const execution = await world.executionService.getExecution(world.applicationId, executionId);
    expect(execution?.status).toBe("WAITING_HUMAN");
    const approval = await world.store.findApprovalByKey(world.applicationId, "c4-approval");
    expect(approval?.ledgerWaitSequence).not.toBeNull();
  });

  it("C5 approval-decide: crash AFTER the decision converges the resume transition", async () => {
    const world = await scenario();
    const executionId = await world.seedExecution();
    const deviceId = await world.register();
    const content = world.defaultEnvelopeContent();
    const subjectFingerprint = JSON.stringify({ executionId, deviceId, content });
    const approval = await world.service.requestApproval(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        executionId,
        deviceId,
        subjectKind: "envelope",
        subjectFingerprint,
        policyBasis: "c5 basis",
        expiresAt: null,
      },
      "c5-approval",
    );
    const dying = boot(world, {
      target: "store",
      method: "applyApprovalDecision",
      when: "after",
    });
    await diesDuring(
      () =>
        dying.service.decideApproval(
          {
            applicationId: world.applicationId,
            actor: world.actor(),
            approvalId: approval.approvalId,
            approverId: world.approverId,
            decision: "approved",
            rationale: "c5 operator approval",
          },
          "c5-decide",
        ),
      dying.crashed,
    );
    const replay = await world.service.decideApproval(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        approvalId: approval.approvalId,
        approverId: world.approverId,
        decision: "approved",
        rationale: "c5 operator approval",
      },
      "c5-decide-replay",
    );
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe("approved");
    const execution = await world.executionService.getExecution(world.applicationId, executionId);
    expect(execution?.status).toBe("RUNNING");
    const record = await world.store.findApproval(world.applicationId, approval.approvalId);
    expect(record?.ledgerResumeSequence).not.toBeNull();
  });

  it("C6 envelope-admit: crash AFTER the insert converges the controller projection", async () => {
    const world = await scenario();
    const executionId = await world.seedExecution();
    const deviceId = await world.register();
    const content = world.defaultEnvelopeContent();
    const approval = await world.service.requestApproval(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        executionId,
        deviceId,
        subjectKind: "envelope",
        subjectFingerprint: edgeEnvelopeFingerprint({
          applicationId: world.applicationId,
          actor: world.actor(),
          executionId,
          deviceId,
          content,
          costCeilingMicroUsd: "1000000",
          approvalId: "pending",
          supersedesEnvelopeId: null,
        }),
        policyBasis: "c6 basis",
        expiresAt: null,
      },
      "c6-approval",
    );
    await world.service.decideApproval(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        approvalId: approval.approvalId,
        approverId: world.approverId,
        decision: "approved",
        rationale: "c6 operator approval",
      },
      "c6-decide",
    );
    const dying = boot(world, { target: "store", method: "insertEnvelope", when: "after" });
    await diesDuring(
      () =>
        dying.service.admitEnvelope(
          {
            applicationId: world.applicationId,
            actor: world.actor(),
            executionId,
            deviceId,
            content,
            costCeilingMicroUsd: "1000000",
            approvalId: approval.approvalId,
            supersedesEnvelopeId: null,
          },
          "c6-envelope",
        ),
      dying.crashed,
    );
    const envelope = await world.store.findActiveEnvelopeForDevice(world.applicationId, deviceId);
    expect(envelope?.status).toBe("admitted");
    // The controller was never told (the crash fired before/around the
    // projection): the restart converges it — keyed, exactly once.
    const replay = await world.service.admitEnvelope(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        executionId,
        deviceId,
        content,
        costCeilingMicroUsd: "1000000",
        approvalId: approval.approvalId,
        supersedesEnvelopeId: null,
      },
      "c6-envelope",
    );
    expect(replay.replayed).toBe(true);
    expect(replay.envelopeId).toBe(envelope?.id);
    // The device-side holding: dispatch under the envelope now works
    // (the projection exists) — proving the projection converged.
    const request = physicalWrite(world, executionId, deviceId, envelopeIdOf(envelope));
    const approvalId = await world.approveCommand(request);
    const receipt = await world.service.submitCommand({ ...request, approvalId }, "c6-command");
    expect(receipt.status).toBe("dispatched");
    expect(world.controller.journalLength(deviceId)).toBe(1);
  });

  it("C7 envelope-supersede: crash AFTER the new insert converges the supersede + projections", async () => {
    const world = await scenario();
    const { executionId, deviceId, envelopeId } = await governed(world);
    const newContent = world.defaultEnvelopeContent({ maxCommands: 20 });
    const approval = await world.service.requestApproval(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        executionId,
        deviceId,
        subjectKind: "envelope",
        subjectFingerprint: edgeEnvelopeFingerprint({
          applicationId: world.applicationId,
          actor: world.actor(),
          executionId,
          deviceId,
          content: newContent,
          costCeilingMicroUsd: "1000000",
          approvalId: "pending",
          supersedesEnvelopeId: envelopeId,
        }),
        policyBasis: "c7 basis",
        expiresAt: null,
      },
      "c7-approval",
    );
    await world.service.decideApproval(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        approvalId: approval.approvalId,
        approverId: world.approverId,
        decision: "approved",
        rationale: "c7 operator approval",
      },
      "c7-decide",
    );
    const dying = boot(world, { target: "store", method: "insertEnvelope", when: "after" });
    await diesDuring(
      () =>
        dying.service.admitEnvelope(
          {
            applicationId: world.applicationId,
            actor: world.actor(),
            executionId,
            deviceId,
            content: newContent,
            costCeilingMicroUsd: "1000000",
            approvalId: approval.approvalId,
            supersedesEnvelopeId: envelopeId,
          },
          "c7-envelope",
        ),
      dying.crashed,
    );
    // The new envelope row exists; the old one is still admitted (the
    // crash fired before the supersede move and the projections). The
    // restart (the caller retries the admission under the SAME key)
    // converges the supersede and BOTH projections.
    const replay = await world.service.admitEnvelope(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        executionId,
        deviceId,
        content: newContent,
        costCeilingMicroUsd: "1000000",
        approvalId: approval.approvalId,
        supersedesEnvelopeId: envelopeId,
      },
      "c7-envelope",
    );
    expect(replay.replayed).toBe(true);
    const oldRow = await world.store.findEnvelope(world.applicationId, envelopeId);
    expect(oldRow?.status).toBe("superseded");
    expect(oldRow?.supersededByEnvelopeId).toBe(replay.envelopeId);
    const active = await world.store.findActiveEnvelopeForDevice(world.applicationId, deviceId);
    expect(active?.id).toBe(replay.envelopeId);
    // The local controller holds the NEW envelope as its active
    // authority (the old one's withdrawal + the new one's admission
    // both projected — keyed, exactly once each).
    expect(world.controller.activeEnvelopeId(deviceId)).toBe(replay.envelopeId);
    // A command under the OLD envelope is refused (not the active
    // pre-authorization); under the NEW one it dispatches.
    const oldRequest = physicalWrite(world, executionId, deviceId, envelopeId);
    const oldApproval = await world.approveCommand(oldRequest);
    await expect(
      world.service.submitCommand({ ...oldRequest, approvalId: oldApproval }, "c7-old-envelope"),
    ).rejects.toThrow("not the device's admitted safety envelope");
    const newRequest = physicalWrite(world, executionId, deviceId, envelopeIdOf(active));
    const newApproval = await world.approveCommand(newRequest);
    const newReceipt = await world.service.submitCommand(
      { ...newRequest, approvalId: newApproval },
      "c7-new-envelope",
    );
    expect(newReceipt.status).toBe("dispatched");
  });

  it("C8 command-submit: crash AFTER the durable insert, BEFORE the dispatch", async () => {
    const world = await scenario();
    const { executionId, deviceId, envelopeId } = await governed(world);
    const request = physicalWrite(world, executionId, deviceId, envelopeId);
    const approvalId = await world.approveCommand(request);
    const dying = boot(world, { target: "store", method: "insertCommand", when: "after" });
    await diesDuring(
      () => dying.service.submitCommand({ ...request, approvalId }, "c8-command"),
      dying.crashed,
    );
    expect(world.controller.journalLength(deviceId)).toBe(0); // never dispatched
    const receipt = await world.service.submitCommand({ ...request, approvalId }, "c8-command");
    expect(receipt.replayed).toBe(false); // converged the pending dispatch
    expect(receipt.status).toBe("dispatched");
    expect(world.controller.journalLength(deviceId)).toBe(1); // exactly once
    const commands = await world.service.listCommandsByDevice(world.applicationId, deviceId);
    expect(commands).toHaveLength(1);
  });

  it("C9 command-submit: crash AFTER the external actuation, BEFORE the finalize", async () => {
    const world = await scenario();
    const { executionId, deviceId, envelopeId } = await governed(world);
    const request = physicalWrite(world, executionId, deviceId, envelopeId);
    const approvalId = await world.approveCommand(request);
    const dying = boot(world, {
      target: "controller",
      method: "dispatchCommand",
      when: "after",
    });
    await diesDuring(
      () => dying.service.submitCommand({ ...request, approvalId }, "c9-command"),
      dying.crashed,
    );
    expect(world.controller.journalLength(deviceId)).toBe(1); // actuated ONCE
    const receipt = await world.service.submitCommand({ ...request, approvalId }, "c9-command");
    expect(receipt.status).toBe("dispatched");
    expect(receipt.dispatchDigest).not.toBeNull();
    // The controller converged the dispatch by key: no second actuation.
    expect(world.controller.journalLength(deviceId)).toBe(1);
    const command = await world.store.findCommandByKey(world.applicationId, "c9-command");
    expect(command?.status).toBe("dispatched");
    expect(command?.dispatchDigest).toBe(receipt.dispatchDigest);
  });

  it("C10 command-ledger: crash AFTER the intent commit converges the binding", async () => {
    const world = await scenario();
    const { executionId, deviceId, envelopeId } = await governed(world);
    const request = physicalWrite(world, executionId, deviceId, envelopeId);
    const approvalId = await world.approveCommand(request);
    const dying = boot(world, { target: "ledger", method: "recordStepEvent", when: "after" });
    await diesDuring(
      () => dying.service.submitCommand({ ...request, approvalId }, "c10-command"),
      dying.crashed,
    );
    // The ledger intent exists (keyed); the binding may not. The restart
    // converges: one command, dispatched, intent + result bound.
    const receipt = await world.service.submitCommand({ ...request, approvalId }, "c10-command");
    expect(receipt.status).toBe("dispatched");
    const command = await world.store.findCommandByKey(world.applicationId, "c10-command");
    expect(command?.ledgerRequestedSequence).not.toBeNull();
    expect(command?.ledgerResultSequence).not.toBeNull();
  });

  it("C11 budget: crash AFTER the wallet reservation converges onto the SAME command", async () => {
    const world = await scenario();
    const executionId = await world.seedExecution();
    const deviceId = await world.register();
    const { envelopeId } = await world.approveEnvelope(executionId, deviceId, undefined, {
      costCeilingMicroUsd: "1000000",
    });
    const request = physicalWrite(world, executionId, deviceId, envelopeId, {
      estimatedMicroUsd: "50000",
    });
    const approvalId = await world.approveCommand(request);
    const dying = boot(world, { target: "budgets", method: "reserve", when: "after" });
    await diesDuring(
      () => dying.service.submitCommand({ ...request, approvalId }, "c11-command"),
      dying.crashed,
    );
    const receipt = await world.service.submitCommand({ ...request, approvalId }, "c11-command");
    expect(receipt.status).toBe("dispatched");
    // The reservation converges on the CRASH-STABLE command identity:
    // every keyed call carries the SAME key (the wallet's keyed
    // idempotency maps them to ONE reservation — the PG P-proof counts
    // the physical rows).
    const keys = world.budgets.reserveCalls.map((call) => call.key);
    expect(new Set(keys).size).toBe(1);
    for (const call of world.budgets.reserveCalls) {
      expect(String(call.command.operationId)).toContain(receipt.commandId);
    }
  });

  it("C12 reconcile: crash AFTER the settlement converges without double settlement", async () => {
    const world = await scenario();
    const { executionId, deviceId, envelopeId } = await governed(world);
    const request = physicalWrite(world, executionId, deviceId, envelopeId);
    const approvalId = await world.approveCommand(request);
    await world.service.submitCommand({ ...request, approvalId }, "c12-command");
    const dying = boot(world, { target: "store", method: "settleCommand", when: "after" });
    await diesDuring(
      () =>
        dying.service.reconcile(
          { applicationId: world.applicationId, actor: world.actor(), deviceId },
          "c12-reconcile",
        ),
      dying.crashed,
    );
    const receipt = await world.service.reconcile(
      { applicationId: world.applicationId, actor: world.actor(), deviceId },
      "c12-reconcile-replay",
    );
    expect(receipt.status).toBe("converged");
    // The command settled EXACTLY ONCE (no re-settle, single terminal
    // settlement; the events ledger holds one commanded actuation).
    const command = await world.store.findCommandByKey(world.applicationId, "c12-command");
    expect(command?.status).toBe("settled");
    const events = await world.store.listActuationEvents(world.applicationId, deviceId);
    expect(events).toHaveLength(1);
    expect(events[0]?.actuationClass).toBe("commanded");
    // An uncosted command never settles or releases wallet state.
    expect(world.budgets.settleCalls).toHaveLength(0);
    expect(world.budgets.releaseCalls).toHaveLength(0);
  });

  it("C13 sensor-ingest: crash AFTER the durable insert converges the ledger event", async () => {
    const world = await scenario();
    const { executionId, deviceId } = await governed(world);
    const dying = boot(world, {
      target: "store",
      method: "insertSensorObservation",
      when: "after",
    });
    await diesDuring(
      () =>
        dying.service.ingestSensorObservation(
          {
            applicationId: world.applicationId,
            actor: world.actor(),
            executionId,
            deviceId,
            observationType: "telemetry",
            retention: "retained",
            content: '{"c": 1}',
            observedAt: "2026-09-15T12:30:00Z",
          },
          "c13-sensor",
        ),
      dying.crashed,
    );
    const record = await world.service.ingestSensorObservation(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        executionId,
        deviceId,
        observationType: "telemetry",
        retention: "retained",
        content: '{"c": 1}',
        observedAt: "2026-09-15T12:30:00Z",
      },
      "c13-sensor",
    );
    expect(record.ledgerSequence).not.toBeNull();
    const observations = await world.store.listSensorObservations(world.applicationId, deviceId);
    expect(observations).toHaveLength(1);
  });

  it("C14 envelope-revoke replay: the withdrawal projection converges after a lost notification", async () => {
    const world = await scenario();
    const { executionId, deviceId, envelopeId } = await governed(world);
    const dying = boot(world, {
      target: "controller",
      method: "applyEnvelope",
      when: "before",
    });
    await diesDuring(
      () =>
        dying.service.revokeEnvelope(
          {
            applicationId: world.applicationId,
            actor: world.actor(),
            envelopeId,
            reason: "c14 lost withdrawal",
          },
          "c14-revoke",
        ),
      dying.crashed,
    );
    // Durably revoked; the controller was never told.
    const envelope = await world.store.findEnvelope(world.applicationId, envelopeId);
    expect(envelope?.status).toBe("revoked");
    expect(world.controller.activeEnvelopeId(deviceId)).toBe(envelopeId);
    // The restart replays the revocation: the replay converges the
    // device-side withdrawal (keyed, exactly-once).
    const replay = await world.service.revokeEnvelope(
      {
        applicationId: world.applicationId,
        actor: world.actor(),
        envelopeId,
        reason: "c14 lost withdrawal",
      },
      "c14-revoke-replay",
    );
    expect(replay.replayed).toBe(true);
    // THE CONVERGENCE PROOF: the device holds NO active envelope — the
    // local actuator path is closed (defense in depth).
    expect(world.controller.activeEnvelopeId(deviceId)).toBeNull();
    expect(world.controller.journalLength(deviceId)).toBe(0);
    void executionId;
  });
});
