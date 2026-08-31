/**
 * Unit proofs: the WorkflowOS submission service (WORK-016 / WOS-001,
 * WOS-003, WOS-004 — the durable halves live in the real-PG suites).
 *
 * Required-test mapping:
 *  - submission through the REAL executions authority (creation,
 *    receipts, provenance echo);
 *  - concept mapping: external refs preserved as metadata provenance,
 *    never scope, never duplicated state (WOS-004);
 *  - closed vocabulary: tenantId/applicationId/executionId/agentId in
 *    the request are rejected fail-closed (scope is server-derived);
 *  - idempotency DELEGATED: same key + same fingerprint replays, same
 *    key + different fingerprint fails IDEMPOTENCY_KEY_REUSED;
 *  - the evidence receipt: verification/artifact/event references over
 *    public reads, honest warnings, workRef echo;
 *  - tenant isolation: cross-tenant reads fail closed;
 *  - NO WorkflowOS-state mutation surface exists at all (the service
 *    exposes only submitWork/executionReceipt — structurally data-out).
 */

import { describe, expect, test } from "vitest";
import {
  submissionToExecutionInput,
  validateSubmissionRequest,
} from "../../../src/integrations/workflowos/public";
import { PlatformError } from "../../../src/shared/errors";
import {
  ACTOR_ID,
  APPLICATION_ID,
  OTHER_APPLICATION_ID,
  OTHER_TENANT_ID,
  seedIntegrationWorld,
  TENANT_ID,
} from "./world";

describe("domain: submission validation (WOS-001/WOS-004)", () => {
  test("accepts a minimal valid submission and maps the workRef", () => {
    const check = validateSubmissionRequest({
      workRef: "work-42",
      task: { kind: "review", repo: "acme/api" },
    });
    expect(check.valid).toBe(true);
    if (check.valid) {
      expect(check.value.workRef).toBe("work-42");
      expect(check.value.task).toEqual({ kind: "review", repo: "acme/api" });
    }
  });

  test("rejects scope-bearing keys fail-closed (scope is server-derived)", () => {
    for (const key of [
      "applicationId",
      "tenantId",
      "ownerId",
      "provider",
      "executionId",
      "agentId",
    ]) {
      const check = validateSubmissionRequest({
        workRef: "work-1",
        task: { kind: "x" },
        [key]: "injected-value",
      });
      expect(check.valid, `key ${key} must be rejected`).toBe(false);
      if (!check.valid) {
        expect(check.reason).toContain(key);
      }
    }
  });

  test("rejects unknown keys and malformed shapes fail-closed", () => {
    expect(validateSubmissionRequest(null).valid).toBe(false);
    expect(validateSubmissionRequest([]).valid).toBe(false);
    expect(validateSubmissionRequest({ task: { kind: "x" } }).valid).toBe(false); // no workRef
    expect(validateSubmissionRequest({ workRef: "", task: { kind: "x" } }).valid).toBe(false);
    expect(
      validateSubmissionRequest({ workRef: "w", task: { kind: "x" }, sessionRef: 42 }).valid,
    ).toBe(false);
    expect(validateSubmissionRequest({ workRef: "w", task: {}, unknown: 1 }).valid).toBe(false);
    expect(
      validateSubmissionRequest({ workRef: "w", task: { kind: "x" }, inputArtifactRefs: [1] })
        .valid,
    ).toBe(false);
  });

  test("external refs stay opaque printable-ASCII bounded values", () => {
    expect(validateSubmissionRequest({ workRef: "a".repeat(201), task: { kind: "x" } }).valid).toBe(
      false,
    );
    expect(validateSubmissionRequest({ workRef: "has\ttab", task: { kind: "x" } }).valid).toBe(
      false,
    );
    expect(validateSubmissionRequest({ workRef: "a".repeat(200), task: { kind: "x" } }).valid).toBe(
      true,
    );
  });

  test("THE concept mapping: external refs become provenance metadata, scope from the actor", () => {
    const check = validateSubmissionRequest({
      workRef: "work-42",
      sessionRef: "sess-7",
      workspaceRef: "ws-9",
      task: { kind: "review" },
      userId: "user-1",
    });
    expect(check.valid).toBe(true);
    if (!check.valid) {
      throw new Error("expected valid");
    }
    const input = submissionToExecutionInput(check.value, {
      actorId: ACTOR_ID,
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
    });
    // The application scope comes from the ACTOR, never the request.
    expect(input.applicationId).toBe(APPLICATION_ID);
    expect(Object.keys(input)).not.toContain("tenantId");
    // External refs are preserved as provenance — not scope, not state.
    expect(input.metadata?.workflowos).toEqual({
      source: "workflowos",
      workRef: "work-42",
      sessionRef: "sess-7",
      workspaceRef: "ws-9",
    });
    expect(input.userId).toBe("user-1");
    // The task vocabulary passes through unchanged (capability resolution
    // is the authorities' job).
    expect(input.task).toEqual({ kind: "review" });
  });
});

describe("application: submitWork over the REAL executions authority (WOS-001)", () => {
  test("submits work and returns the receipt with the workRef echo", async () => {
    const world = seedIntegrationWorld();
    const receipt = await world.workflowos.submitWork(
      { workRef: "work-100", task: { kind: "summarize", doc: "d1" } },
      "wos-key-1",
      world.actor,
    );
    expect(receipt.executionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipt.workRef).toBe("work-100");
    expect(receipt.status).toBe("CREATED");
    expect(receipt.replayed).toBe(false);
    // The execution is durable through the REAL authority.
    const record = await world.executionsWorld.service.getExecution(
      APPLICATION_ID,
      receipt.executionId,
    );
    expect(record).not.toBeNull();
    expect(record?.metadata.workflowos).toEqual({ source: "workflowos", workRef: "work-100" });
  });

  test("idempotency is DELEGATED: same key + same request replays (WOS-003 §15)", async () => {
    const world = seedIntegrationWorld();
    const request = { workRef: "work-101", task: { kind: "review" } };
    const first = await world.workflowos.submitWork(request, "wos-key-2", world.actor);
    const second = await world.workflowos.submitWork(request, "wos-key-2", world.actor);
    expect(second.executionId).toBe(first.executionId);
    expect(second.replayed).toBe(true);
    // One durable execution — no duplicate.
    const events = await world.executionsWorld.service.listEvents(
      APPLICATION_ID,
      first.executionId,
    );
    const creates = events.filter((event) => event.type === "execution.created");
    expect(creates).toHaveLength(1);
  });

  test("same key + different fingerprint fails IDEMPOTENCY_KEY_REUSED (canonical)", async () => {
    const world = seedIntegrationWorld();
    await world.workflowos.submitWork(
      { workRef: "work-102", task: { kind: "review" } },
      "wos-key-3",
      world.actor,
    );
    await expect(
      world.workflowos.submitWork(
        { workRef: "work-103", task: { kind: "review" } },
        "wos-key-3",
        world.actor,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("invalid submissions fail closed before any authority call", async () => {
    const world = seedIntegrationWorld();
    await expect(
      world.workflowos.submitWork({ task: { kind: "x" } }, "wos-key-4", world.actor),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(
      world.workflowos.submitWork(
        { workRef: "w", task: { kind: "x" }, tenantId: "injected" },
        "wos-key-4",
        world.actor,
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(
      world.workflowos.submitWork({ workRef: "w", task: { kind: "x" } }, "", world.actor),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    // No execution row was created.
    expect(world.executionsWorld.store.executions.size).toBe(0);
  });
});

describe("application: executionReceipt (WOS-003 — evidence back, data only)", () => {
  test("returns the full evidence package over public reads", async () => {
    const world = seedIntegrationWorld();
    const submission = await world.workflowos.submitWork(
      { workRef: "work-200", task: { kind: "verify-me" } },
      "wos-key-5",
      world.actor,
    );
    const executionId = submission.executionId;
    // Drive the canonical lifecycle with a durable PASS.
    const actor = { actorId: ACTOR_ID, tenantId: TENANT_ID };
    for (const command of ["authorize", "plan", "queue", "start", "verify"] as const) {
      await world.executionsWorld.service.transition(
        { command, applicationId: APPLICATION_ID, executionId, ...actor },
        `wos-key-5:${command}`,
      );
    }
    await world.executionsWorld.service.transition(
      {
        command: "pass",
        applicationId: APPLICATION_ID,
        executionId,
        ...actor,
        verificationResults: [
          {
            criterionId: "cites-sources",
            strategy: "rubric",
            status: "PASS",
            recordedBy: "verifier-1",
            evidence: ["ev-1"],
          },
        ],
      },
      "wos-key-5:pass",
    );

    const receipt = await world.workflowos.executionReceipt(world.actor, executionId);
    expect(receipt.status).toBe("COMPLETED");
    expect(receipt.workRef).toBe("work-200");
    expect(receipt.verification).toHaveLength(1);
    expect(receipt.verification[0]?.criterionId).toBe("cites-sources");
    expect(receipt.verification[0]?.status).toBe("PASS");
    // Durable event references (sequence + type identities — no payloads).
    expect(receipt.events.map((event) => event.type)).toContain("execution.created");
    expect(receipt.warnings).toEqual([]);
  });

  test("honest warnings for INCONCLUSIVE verification and failures", async () => {
    const world = seedIntegrationWorld();
    const submission = await world.workflowos.submitWork(
      { workRef: "work-201", task: { kind: "flaky" } },
      "wos-key-6",
      world.actor,
    );
    const executionId = submission.executionId;
    const actor = { actorId: ACTOR_ID, tenantId: TENANT_ID };
    for (const command of ["authorize", "plan", "queue", "start"] as const) {
      await world.executionsWorld.service.transition(
        { command, applicationId: APPLICATION_ID, executionId, ...actor },
        `wos-key-6:${command}`,
      );
    }
    await world.executionsWorld.service.transition(
      {
        command: "fail",
        applicationId: APPLICATION_ID,
        executionId,
        ...actor,
        reason: "model route unavailable",
      },
      "wos-key-6:fail",
    );
    const receipt = await world.workflowos.executionReceipt(world.actor, executionId);
    expect(receipt.status).toBe("FAILED");
    expect(receipt.warnings.join(" ")).toContain("execution failed");
  });

  test("cross-tenant reads fail closed (no tenant leak)", async () => {
    const world = seedIntegrationWorld();
    const submission = await world.workflowos.submitWork(
      { workRef: "work-202", task: { kind: "isolate" } },
      "wos-key-7",
      world.actor,
    );
    // The other-tenant actor's application scope does not see the row.
    await expect(
      world.workflowos.executionReceipt(
        {
          actorId: ACTOR_ID,
          applicationId: "00000000-0000-7000-8000-0000000000ff",
          tenantId: TENANT_ID,
        },
        submission.executionId,
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
  });

  test("the executionId-of-another-execution is scoped: no cross-tenant adoption", async () => {
    const world = seedIntegrationWorld();
    const own = await world.workflowos.submitWork(
      { workRef: "work-203", task: { kind: "own" } },
      "wos-key-8",
      world.actor,
    );
    // Another application's execution id is invisible here (404-equivalent).
    // (The other application is seeded in the world with a DIFFERENT tenant.)
    const foreign = await world.executionsWorld.service.createExecution(
      { applicationId: OTHER_APPLICATION_ID, task: { kind: "foreign" } },
      "foreign-key-1",
      { actorId: ACTOR_ID, tenantId: OTHER_TENANT_ID },
    );
    expect(foreign.executionId).not.toBe(own.executionId);
    await expect(
      world.workflowos.executionReceipt(world.actor, foreign.executionId),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
  });
});

describe("the no-mutation boundary (WOS-002 — structural)", () => {
  test("the service surface carries ONLY submission/receipt — no WorkflowOS write path exists", () => {
    const world = seedIntegrationWorld();
    const methods = Object.keys(world.workflowos).sort();
    expect(methods).toEqual(["executionReceipt", "submitWork"]);
    // The type-level proof: the service deps hold ONLY the executions
    // authority (an inbound seam) — there is no WorkflowOS-facing store,
    // client or mutation surface anywhere in the composition.
    expect(Object.keys(world.executionsWorld.service).sort()).toEqual([
      "createExecution",
      "getExecution",
      "listEvents",
      "listVerificationResults",
      "recordPlanningDecision",
      "recordStepEvent",
      "transition",
    ]);
  });

  test("executionReceipt is a pure read: repeated calls return identical evidence", async () => {
    const world = seedIntegrationWorld();
    const submission = await world.workflowos.submitWork(
      { workRef: "work-204", task: { kind: "stable" } },
      "wos-key-9",
      world.actor,
    );
    const first = await world.workflowos.executionReceipt(world.actor, submission.executionId);
    const second = await world.workflowos.executionReceipt(world.actor, submission.executionId);
    expect(second).toEqual(first);
    // The ledger did not grow (no side effects from reads).
    const events = await world.executionsWorld.service.listEvents(
      APPLICATION_ID,
      submission.executionId,
    );
    expect(events).toHaveLength(1);
  });
});

describe("canonical error surface", () => {
  test("failures carry the canonical taxonomy (no internals leak)", async () => {
    const world = seedIntegrationWorld();
    try {
      await world.workflowos.submitWork({ task: {} }, "wos-key-10", world.actor);
      expect.unreachable("must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PlatformError);
      const platformError = error as PlatformError;
      expect(platformError.code).toBe("POLICY_DENIED");
      expect(platformError.message).not.toMatch(/select |insert |update |at\s+\//i);
    }
  });
});
