/**
 * Unit: execution service — creation, idempotency, lifecycle, provenance
 * (WORK-006 acceptance criteria 1, 2, 3, 5 over in-memory fakes; API-003;
 * checkpoints IDENTITY-IDEMPOTENCY and IMPLEMENTATION-COMPLETENESS).
 *
 * Real-PostgreSQL suites own the physical + concurrency proofs
 * (convergence, crash-atomicity, schema constraints).
 */

import { describe, expect, test } from "vitest";
import type { EventEnvelope } from "../../../src/modules/executions/domain/event";
import type { ExecutionRecord } from "../../../src/modules/executions/domain/execution";
import { PlatformError } from "../../../src/shared/errors";
import {
  ACTOR,
  baseCreateInput,
  createInMemoryExecutions,
  denyAllAuthorization,
  InMemoryExecutionsIdempotency,
  OTHER_TENANT_ACTOR,
  transitionScope,
} from "./fakes";

const APP_ID = "11111111-1111-7000-8000-000000000001";
const ENV_ID = "22222222-2222-7000-8000-000000000002";

function seed(): ReturnType<typeof createInMemoryExecutions> {
  const world = createInMemoryExecutions();
  world.store.seedApplication(APP_ID, ACTOR.tenantId);
  world.store.seedEnvironment(ENV_ID, APP_ID);
  return world;
}

async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "none";
  } catch (error) {
    return String((error as PlatformError).code ?? "unknown");
  }
}

/** Drive an execution through the canonical happy path to VERIFYING. */
async function driveToVerifying(
  world: ReturnType<typeof createInMemoryExecutions>,
  executionId: string,
): Promise<void> {
  await world.service.transition(
    { ...transitionScope(APP_ID, executionId), command: "authorize" },
    "k-a",
  );
  await world.service.transition(
    { ...transitionScope(APP_ID, executionId), command: "plan" },
    "k-p",
  );
  await world.service.transition(
    { ...transitionScope(APP_ID, executionId), command: "queue" },
    "k-q",
  );
  await world.service.transition(
    { ...transitionScope(APP_ID, executionId), command: "start" },
    "k-s",
  );
  await world.service.transition(
    { ...transitionScope(APP_ID, executionId), command: "verify" },
    "k-v",
  );
}

describe("unit: createExecution (API-003 idempotency; criterion 1)", () => {
  test("creates a UUIDv7 ExecutionId once, status CREATED, sequence-1 creation event", async () => {
    const world = seed();
    const receipt = await world.service.createExecution(baseCreateInput(APP_ID), "key-1", ACTOR);
    expect(receipt.status).toBe("CREATED");
    expect(receipt.replayed).toBe(false);
    expect(receipt.executionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const events = await world.service.listEvents(APP_ID, receipt.executionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.sequence).toBe(1);
    expect(events[0]?.type).toBe("execution.created");
    expect(events[0]?.command).toBe("create");
    expect(events[0]?.actor).toEqual({ actorId: ACTOR.actorId, tenantId: ACTOR.tenantId });
  });

  test("same key + same fingerprint replays the same logical outcome (no second identity/event)", async () => {
    const world = seed();
    const first = await world.service.createExecution(baseCreateInput(APP_ID), "key-1", ACTOR);
    const replay = await world.service.createExecution(baseCreateInput(APP_ID), "key-1", ACTOR);
    expect(replay.executionId).toBe(first.executionId);
    expect(replay.replayed).toBe(true);
    expect(world.store.executions.size).toBe(1);
    expect(world.store.events).toHaveLength(1);
  });

  test("same key + different fingerprint fails IDEMPOTENCY_KEY_REUSED", async () => {
    const world = seed();
    await world.service.createExecution(baseCreateInput(APP_ID), "key-1", ACTOR);
    const error = await errorCode(
      world.service.createExecution(
        { ...baseCreateInput(APP_ID), task: { kind: "translate" } },
        "key-1",
        ACTOR,
      ),
    );
    expect(error).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(world.store.executions.size).toBe(1);
  });

  test("provider selection is unrepresentable in the create contract (frozen rule)", async () => {
    const world = seed();
    for (const field of ["provider", "model", "rail", "connectionId"]) {
      const error = await errorCode(
        world.service.createExecution(
          { ...baseCreateInput(APP_ID), [field]: "openrouter" } as never,
          `key-${field}`,
          ACTOR,
        ),
      );
      expect(error).toBe("POLICY_DENIED");
    }
    const unknown = await errorCode(
      world.service.createExecution(
        { ...baseCreateInput(APP_ID), banana: 1 } as never,
        "key-x",
        ACTOR,
      ),
    );
    expect(unknown).toBe("POLICY_DENIED");
    expect(world.store.executions.size).toBe(0);
  });

  test("input validation: task shape, micro-USD constraints, artifact refs", async () => {
    const world = seed();
    expect(
      await errorCode(
        world.service.createExecution({ ...baseCreateInput(APP_ID), task: {} }, "v1", ACTOR),
      ),
    ).toBe("POLICY_DENIED");
    expect(
      await errorCode(
        world.service.createExecution(
          { ...baseCreateInput(APP_ID), constraints: { maxCostMicroUsd: "1.5" } },
          "v2",
          ACTOR,
        ),
      ),
    ).toBe("POLICY_DENIED");
    expect(
      await errorCode(
        world.service.createExecution(
          {
            ...baseCreateInput(APP_ID),
            constraints: { maxCostMicroUsd: "100" },
            inputArtifactRefs: [7] as never,
          },
          "v3",
          ACTOR,
        ),
      ),
    ).toBe("POLICY_DENIED");
  });

  test("tenant scope: unknown application, foreign tenant, foreign environment", async () => {
    const world = seed();
    expect(
      await errorCode(
        world.service.createExecution(
          baseCreateInput("99999999-9999-7000-8000-000000000099"),
          "s1",
          ACTOR,
        ),
      ),
    ).toBe("AUTHORIZATION_DENIED");
    expect(
      await errorCode(
        world.service.createExecution(baseCreateInput(APP_ID), "s2", OTHER_TENANT_ACTOR),
      ),
    ).toBe("TENANT_SCOPE_VIOLATION");
    // Environment of another application (same tenant app not seeded): unresolvable.
    expect(
      await errorCode(
        world.service.createExecution(
          { ...baseCreateInput(APP_ID), environmentId: "33333333-3333-7000-8000-000000000003" },
          "s3",
          ACTOR,
        ),
      ),
    ).toBe("TENANT_SCOPE_VIOLATION");
    // Environment bound to a DIFFERENT application id.
    const otherApp = "44444444-4444-7000-8000-000000000044";
    world.store.seedApplication(otherApp, ACTOR.tenantId);
    world.store.seedEnvironment(ENV_ID, otherApp);
    expect(
      await errorCode(
        world.service.createExecution(
          { ...baseCreateInput(APP_ID), environmentId: ENV_ID },
          "s4",
          ACTOR,
        ),
      ),
    ).toBe("TENANT_SCOPE_VIOLATION");
  });

  test("create with environment + artifacts + constraints persists them on the record", async () => {
    const world = seed();
    const receipt = await world.service.createExecution(
      {
        ...baseCreateInput(APP_ID),
        environmentId: ENV_ID,
        inputArtifactRefs: ["art-1", "art-2"],
        constraints: { maxCostMicroUsd: "500", maxLatencyMs: 30000 },
        metadata: { requestId: "ext-17" },
        userId: "user-9",
      },
      "key-env",
      ACTOR,
    );
    const record = await world.service.getExecution(APP_ID, receipt.executionId);
    expect(record?.environmentId).toBe(ENV_ID);
    expect(record?.inputArtifactRefs).toEqual(["art-1", "art-2"]);
    expect(record?.constraints?.maxCostMicroUsd).toBe("500");
    expect(record?.userId).toBe("user-9");
    const created = world.store.events[0];
    expect(created?.reference).toEqual({
      inputArtifactRefs: ["art-1", "art-2"],
      environmentId: ENV_ID,
      userId: "user-9",
    });
  });
});

describe("unit: transitions (criterion 2 — single write path over the table)", () => {
  test("full lifecycle CREATED -> ... -> COMPLETED with gapless event sequence + provenance", async () => {
    const world = seed();
    const { executionId } = await world.service.createExecution(
      baseCreateInput(APP_ID),
      "c1",
      ACTOR,
    );
    await driveToVerifying(world, executionId);
    const pass = await world.service.transition(
      {
        ...transitionScope(APP_ID, executionId),
        command: "pass",
        verificationResults: [
          {
            criterionId: "answer-cited",
            strategy: "rubric",
            status: "PASS",
            recordedBy: "verifier-1",
            evidence: ["ev-1"],
          },
        ],
      },
      "k-pass",
    );
    expect(pass.execution.status).toBe("COMPLETED");
    expect(pass.execution.verificationRefs).toHaveLength(1);
    expect(pass.execution.terminalAt).not.toBeNull();

    const events = await world.service.listEvents(APP_ID, executionId);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(events.map((e) => e.command)).toEqual([
      "create",
      "authorize",
      "plan",
      "queue",
      "start",
      "verify",
      "pass",
    ]);
    // Provenance chain on every envelope.
    for (const event of events) {
      expect(event.actor.actorId).toBe(ACTOR.actorId);
      expect(event.producerModule).toBe("executions");
      expect(event.schemaVersion).toBe(1);
      expect(typeof event.command).toBe("string");
    }
    const passEvent = events[6];
    expect(passEvent?.payload).toEqual({ from: "VERIFYING", to: "COMPLETED" });
    const verificationIds = (passEvent?.reference.verificationResultIds ?? []) as string[];
    expect(verificationIds).toHaveLength(1);
    const results = await world.service.listVerificationResults(APP_ID, executionId);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("PASS");
  });

  test("illegal edge rejected INVALID_STATE_TRANSITION, no event, no state change", async () => {
    const world = seed();
    const { executionId } = await world.service.createExecution(
      baseCreateInput(APP_ID),
      "c1",
      ACTOR,
    );
    const error = await errorCode(
      world.service.transition(
        { ...transitionScope(APP_ID, executionId), command: "start" },
        "bad-1",
      ),
    );
    expect(error).toBe("INVALID_STATE_TRANSITION");
    expect(world.store.events).toHaveLength(1);
    const record = await world.service.getExecution(APP_ID, executionId);
    expect(record?.status).toBe("CREATED");
  });

  test("terminal finality: no command leaves COMPLETED/FAILED/CANCELLED/EXPIRED (criterion 5)", async () => {
    const world = seed();
    const { executionId } = await world.service.createExecution(
      baseCreateInput(APP_ID),
      "c1",
      ACTOR,
    );
    await driveToVerifying(world, executionId);
    await world.service.transition(
      {
        ...transitionScope(APP_ID, executionId),
        command: "pass",
        verificationResults: [{ criterionId: "c", strategy: "s", status: "PASS", recordedBy: "v" }],
      },
      "k-pass",
    );
    for (const command of ["authorize", "resume", "cancel", "fail", "plan", "verify"]) {
      const error = await errorCode(
        world.service.transition(
          { ...transitionScope(APP_ID, executionId), command } as never,
          `post-${command}`,
        ),
      );
      expect(error).toBe("INVALID_STATE_TRANSITION");
    }
    // Retry of the ORIGINAL pass key replays the recorded outcome (no rewind).
    const replay = await world.service.transition(
      {
        ...transitionScope(APP_ID, executionId),
        command: "pass",
        verificationResults: [{ criterionId: "c", strategy: "s", status: "PASS", recordedBy: "v" }],
      },
      "k-pass",
    );
    expect(replay.replayed).toBe(true);
    expect(replay.execution.status).toBe("COMPLETED");
    expect(replay.execution.lastEventSequence).toBe(7);
  });

  test("waiting sub-states round-trip RUNNING <-> WAITING_* via resume", async () => {
    const world = seed();
    const { executionId } = await world.service.createExecution(
      baseCreateInput(APP_ID),
      "c1",
      ACTOR,
    );
    await driveToVerifying(world, executionId);
    // back to RUNNING is not legal from VERIFYING; drive a fresh execution.
    const second = await world.service.createExecution(baseCreateInput(APP_ID), "c2", ACTOR);
    await world.service.transition(
      { ...transitionScope(APP_ID, second.executionId), command: "authorize" },
      "a",
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, second.executionId), command: "plan" },
      "p",
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, second.executionId), command: "queue" },
      "q",
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, second.executionId), command: "start" },
      "s",
    );
    for (const command of ["wait-tool", "wait-user", "wait-human"] as const) {
      const stepped = await world.service.transition(
        { ...transitionScope(APP_ID, second.executionId), command },
        `w-${command}`,
      );
      expect(stepped.execution.status).toBe(
        command === "wait-tool"
          ? "WAITING_TOOL"
          : command === "wait-user"
            ? "WAITING_USER"
            : "WAITING_HUMAN",
      );
      const resumed = await world.service.transition(
        { ...transitionScope(APP_ID, second.executionId), command: "resume" },
        `r-${command}`,
      );
      expect(resumed.execution.status).toBe("RUNNING");
    }
    // replanning loop: REPLANNING -> queue -> QUEUED
    await world.service.transition(
      { ...transitionScope(APP_ID, second.executionId), command: "verify" },
      "v",
    );
    const replanned = await world.service.transition(
      { ...transitionScope(APP_ID, second.executionId), command: "replan" },
      "rp",
    );
    expect(replanned.execution.status).toBe("REPLANNING");
    const requeued = await world.service.transition(
      { ...transitionScope(APP_ID, second.executionId), command: "queue" },
      "rq",
    );
    expect(requeued.execution.status).toBe("QUEUED");
  });

  test("cancel and expire are legal from every non-terminal state (sweep)", async () => {
    for (const command of ["cancel", "expire"] as const) {
      for (const target of [
        "CREATED",
        "AUTHORIZED",
        "PLANNING",
        "QUEUED",
        "RUNNING",
        "WAITING_TOOL",
        "WAITING_USER",
        "WAITING_HUMAN",
        "VERIFYING",
        "REPLANNING",
      ]) {
        const world = seed();
        const { executionId } = await world.service.createExecution(
          baseCreateInput(APP_ID),
          "c",
          ACTOR,
        );
        // Seed the row directly into the target state through the store fake
        // (the state field is the machine's output; the sweep exercises the
        // command legality for each source state).
        const row = world.store.executions.get(executionId);
        if (row === undefined) throw new Error("missing seeded row");
        world.store.executions.set(executionId, {
          ...row,
          status: target as ExecutionRecord["status"],
        });
        const outcome = await world.service.transition(
          { ...transitionScope(APP_ID, executionId), command, reason: `sweep-${target}` },
          `k-${command}-${target}`,
        );
        expect(outcome.execution.status).toBe(command === "cancel" ? "CANCELLED" : "EXPIRED");
        expect(outcome.execution.terminalAt).not.toBeNull();
      }
    }
  });

  test("fail from RUNNING and from VERIFYING; unknown execution is TENANT_SCOPE_VIOLATION", async () => {
    const world = seed();
    const { executionId } = await world.service.createExecution(
      baseCreateInput(APP_ID),
      "c1",
      ACTOR,
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "authorize" },
      "a",
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "plan" },
      "p",
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "queue" },
      "q",
    );
    const started = await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "start" },
      "s",
    );
    expect(started.execution.status).toBe("RUNNING");
    const failed = await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "fail", reason: "tool-crash" },
      "f1",
    );
    expect(failed.execution.status).toBe("FAILED");

    const second = await world.service.createExecution(baseCreateInput(APP_ID), "c2", ACTOR);
    await driveToVerifying(world, second.executionId);
    const failedFromVerifying = await world.service.transition(
      {
        ...transitionScope(APP_ID, second.executionId),
        command: "fail",
        verificationResults: [{ criterionId: "c", strategy: "s", status: "FAIL", recordedBy: "v" }],
      },
      "f2",
    );
    expect(failedFromVerifying.execution.status).toBe("FAILED");
    const results = await world.service.listVerificationResults(APP_ID, second.executionId);
    expect(results).toHaveLength(1);

    expect(
      await errorCode(
        world.service.transition(
          { ...transitionScope(APP_ID, "99999999-9999-7000-8000-000000000099"), command: "cancel" },
          "f3",
        ),
      ),
    ).toBe("TENANT_SCOPE_VIOLATION");
  });
});

describe("unit: authority seams (policy precedes dispatch; budget consulted not bypassed)", () => {
  // WORK-007 adaptation: the authorize seam is now wired to the policy
  // engine contract — a policy denial is typed `POLICY_DENIED` and is
  // DURABLE (one `execution.policy-denied` envelope, row stays CREATED).
  test("authorize consults the REQUIRED authorization port; denial is POLICY_DENIED, blocked at CREATED, durably journaled", async () => {
    const world = createInMemoryExecutions({ authorization: denyAllAuthorization("task-quota") });
    world.store.seedApplication(APP_ID, ACTOR.tenantId);
    const { executionId } = await world.service.createExecution(
      baseCreateInput(APP_ID),
      "c1",
      ACTOR,
    );
    const error = await errorCode(
      world.service.transition(
        { ...transitionScope(APP_ID, executionId), command: "authorize" },
        "a1",
      ),
    );
    expect(error).toBe("POLICY_DENIED");
    // Durable denial evidence: exactly one policy-denied envelope appended;
    // the execution CANNOT pass CREATED (no dispatch is possible).
    expect(world.store.events).toHaveLength(2);
    const denial = world.store.events[1];
    expect(denial?.type).toBe("execution.policy-denied");
    expect(denial?.command).toBe("authorize");
    expect(denial?.reference).toMatchObject({ denied: true, reason: "task-quota" });
    expect(denial?.payload).toMatchObject({ from: "CREATED", to: "CREATED", denied: true });
    expect((await world.service.getExecution(APP_ID, executionId))?.status).toBe("CREATED");
    // Same-key retry replays the SAME durable denial (no second envelope).
    const replayError = await errorCode(
      world.service.transition(
        { ...transitionScope(APP_ID, executionId), command: "authorize" },
        "a1",
      ),
    );
    expect(replayError).toBe("POLICY_DENIED");
    expect(world.store.events).toHaveLength(2);
    expect((await world.service.getExecution(APP_ID, executionId))?.status).toBe("CREATED");
  });

  test("a denial reason from the authority is surfaced in the typed error details", async () => {
    const world = createInMemoryExecutions({
      authorization: denyAllAuthorization("cost ceiling exceeded"),
    });
    world.store.seedApplication(APP_ID, ACTOR.tenantId);
    const { executionId } = await world.service.createExecution(
      baseCreateInput(APP_ID),
      "c1",
      ACTOR,
    );
    const attempt = world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "authorize" },
      "a1",
    );
    await expect(attempt).rejects.toMatchObject({
      code: "POLICY_DENIED",
      details: { reason: "cost ceiling exceeded" },
    });
  });

  test("an allow with evidence records the effective-policy provenance on the authorize envelope", async () => {
    const evidence = {
      policySetId: "default",
      policySetVersion: 3,
      policyContentHash: "a".repeat(64),
      restrictionSetDigest: "b".repeat(64),
    };
    const world = createInMemoryExecutions({
      authorization: { evaluate: async () => ({ allowed: true, evidence }) },
    });
    world.store.seedApplication(APP_ID, ACTOR.tenantId);
    const { executionId } = await world.service.createExecution(
      baseCreateInput(APP_ID),
      "c1",
      ACTOR,
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "authorize" },
      "a1",
    );
    const authorizeEvent = world.store.events.find((event) => event.type === "execution.authorize");
    expect(authorizeEvent?.reference).toMatchObject({ policy: evidence });
    expect((await world.service.getExecution(APP_ID, executionId))?.status).toBe("AUTHORIZED");
  });

  test("admission is consulted BEFORE any write of the authorize transition (ordering probe)", async () => {
    let eventsAtConsult: number | undefined;
    const world = createInMemoryExecutions({
      authorization: {
        evaluate: async () => {
          eventsAtConsult = world.store.events.length;
          return { allowed: true };
        },
      },
    });
    world.store.seedApplication(APP_ID, ACTOR.tenantId);
    const { executionId } = await world.service.createExecution(
      baseCreateInput(APP_ID),
      "c1",
      ACTOR,
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "authorize" },
      "a1",
    );
    expect(eventsAtConsult).toBe(1); // only the creation envelope existed at decision time
  });

  test("the authorize seam is consulted ONLY on authorize (other commands never consult policy)", async () => {
    let consultations = 0;
    const world = createInMemoryExecutions({
      authorization: {
        evaluate: async () => {
          consultations += 1;
          return { allowed: true };
        },
      },
    });
    world.store.seedApplication(APP_ID, ACTOR.tenantId);
    const { executionId } = await world.service.createExecution(
      baseCreateInput(APP_ID),
      "c1",
      ACTOR,
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "authorize" },
      "a",
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "plan" },
      "p",
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "queue" },
      "q",
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "start" },
      "s",
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "fail", reason: "done" },
      "f",
    );
    expect(consultations).toBe(1);
    expect((await world.service.getExecution(APP_ID, executionId))?.status).toBe("FAILED");
  });

  test("authorize seam sees the execution + actor (admission facts)", async () => {
    const seen: string[] = [];
    const world = createInMemoryExecutions({
      authorization: {
        evaluate: async (input) => {
          seen.push(`${input.execution.id}:${input.actorId}`);
          return { allowed: true };
        },
      },
    });
    world.store.seedApplication(APP_ID, ACTOR.tenantId);
    const { executionId } = await world.service.createExecution(
      baseCreateInput(APP_ID),
      "c1",
      ACTOR,
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "authorize" },
      "a1",
    );
    expect(seen).toEqual([`${executionId}:${ACTOR.actorId}`]);
  });

  test("start with a dispatch estimate reserves through BudgetAuthority BEFORE the transition commits", async () => {
    const world = seed();
    const { executionId } = await world.service.createExecution(
      { ...baseCreateInput(APP_ID), userId: "user-7" },
      "c1",
      ACTOR,
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "authorize" },
      "a",
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "plan" },
      "p",
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "queue" },
      "q",
    );
    const started = await world.service.transition(
      {
        ...transitionScope(APP_ID, executionId),
        command: "start",
        dispatch: { operationId: `bill-${executionId}`, amountMicroUsd: "250", userId: "user-7" },
      },
      "s",
    );
    expect(started.execution.status).toBe("RUNNING");
    expect(world.budgets.reserveCalls).toHaveLength(1);
    expect(world.budgets.reserveCalls[0]).toMatchObject({
      executionId,
      operationId: `bill-${executionId}`,
      amountMicroUsd: "250",
      userId: "user-7",
      tenantId: ACTOR.tenantId,
    });
    // The reservation id is durable provenance on the start envelope.
    const events = await world.service.listEvents(APP_ID, executionId);
    expect(events[4]?.command).toBe("start");
    expect(events[4]?.reference.reservationId).toBe("reservation-1");
  });

  test("start without dispatch facts never consults the budget authority", async () => {
    const world = seed();
    const { executionId } = await world.service.createExecution(
      baseCreateInput(APP_ID),
      "c1",
      ACTOR,
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "authorize" },
      "a",
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "plan" },
      "p",
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "queue" },
      "q",
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "start" },
      "s",
    );
    expect(world.budgets.reserveCalls).toHaveLength(0);
  });

  test("budget denial on start rejects the transition (no event, no state change)", async () => {
    const world = createInMemoryExecutions({
      budgetAuthority: {
        reserve: async () => {
          throw new PlatformError({ code: "BUDGET_EXCEEDED", message: "monthly-budget" });
        },
        settle: async () => {
          throw new Error("unused");
        },
        release: async () => {
          throw new Error("unused");
        },
      },
    });
    world.store.seedApplication(APP_ID, ACTOR.tenantId);
    const { executionId } = await world.service.createExecution(
      baseCreateInput(APP_ID),
      "c1",
      ACTOR,
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "authorize" },
      "a",
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "plan" },
      "p",
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "queue" },
      "q",
    );
    const error = await errorCode(
      world.service.transition(
        {
          ...transitionScope(APP_ID, executionId),
          command: "start",
          dispatch: { operationId: "bill-1", amountMicroUsd: "100" },
        },
        "s",
      ),
    );
    expect(error).toBe("BUDGET_EXCEEDED");
    expect((await world.service.getExecution(APP_ID, executionId))?.status).toBe("QUEUED");
    expect((await world.service.listEvents(APP_ID, executionId)).length).toBe(4);
  });
});

describe("unit: retry at non-terminal boundaries (criterion 5)", () => {
  test("transition retry with same key replays the recorded outcome (no duplicated event)", async () => {
    const world = seed();
    const { executionId } = await world.service.createExecution(
      baseCreateInput(APP_ID),
      "c1",
      ACTOR,
    );
    const first = await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "authorize" },
      "k-auth",
    );
    const replay = await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "authorize" },
      "k-auth",
    );
    expect(replay.replayed).toBe(true);
    expect(replay.applied).toEqual(first.applied);
    expect(world.store.events.filter((e) => e.command === "authorize")).toHaveLength(1);
  });

  test("transition key reuse with different fingerprint fails IDEMPOTENCY_KEY_REUSED", async () => {
    const world = seed();
    const { executionId } = await world.service.createExecution(
      baseCreateInput(APP_ID),
      "c1",
      ACTOR,
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "authorize" },
      "k-auth",
    );
    expect(
      await errorCode(
        world.service.transition(
          { ...transitionScope(APP_ID, executionId), command: "authorize", reason: "different" },
          "k-auth",
        ),
      ),
    ).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  test("create retry at a progressed (non-terminal) state returns the current durable outcome", async () => {
    const world = seed();
    const created = await world.service.createExecution(baseCreateInput(APP_ID), "k-create", ACTOR);
    await world.service.transition(
      { ...transitionScope(APP_ID, created.executionId), command: "authorize" },
      "a",
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, created.executionId), command: "plan" },
      "p",
    );
    const retried = await world.service.createExecution(baseCreateInput(APP_ID), "k-create", ACTOR);
    expect(retried.executionId).toBe(created.executionId);
    expect(retried.status).toBe("PLANNING"); // current durable state — no rewind
    expect(retried.replayed).toBe(true);
    expect(world.store.events).toHaveLength(3); // no new events
    expect(world.store.executions.size).toBe(1); // no second execution
  });

  test("concurrent-create convergence invariant over the guard-removed mutant (R1 support)", async () => {
    // The production fake arbitrates: N identical creates converge to ONE
    // identity. (The discrimination suite runs the SAME scenario against
    // the always-run-work mutant and observes the violation.)
    const world = seed();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        world.service.createExecution(baseCreateInput(APP_ID), "same-key", {
          ...ACTOR,
          actorId: `00000000-0000-7000-8000-${String(i).padStart(12, "0")}`,
        }),
      ),
    );
    const identities = new Set(results.map((r) => r.executionId));
    expect(identities.size).toBe(1);
    expect(world.store.events).toHaveLength(1);
    expect(results.filter((r) => r.replayed).length).toBe(7);
    // Guard-removed mutant: the arbitration record map is bypassed.
    const mutantWorld = seed();
    const mutantIdempotency = new InMemoryExecutionsIdempotency({ alwaysRunWork: true });
    mutantIdempotency.store = mutantWorld.store;
    const mutantService = createInMemoryExecutions({
      idempotency: mutantIdempotency,
      store: mutantWorld.store,
    });
    mutantWorld.store.seedApplication(APP_ID, ACTOR.tenantId);
    const mutantResults = await Promise.all(
      Array.from({ length: 8 }, () =>
        mutantService.service.createExecution(baseCreateInput(APP_ID), "same-key", ACTOR),
      ),
    );
    expect(new Set(mutantResults.map((r) => r.executionId)).size).toBe(8); // violation OBSERVED under the mutant
  });
});

describe("unit: event ledger + provenance fields (criterion 3; EXECUTION-PROVENANCE)", () => {
  test("every envelope carries the full provenance chain and EventEnvelope fields", async () => {
    const world = seed();
    const { executionId } = await world.service.createExecution(
      { ...baseCreateInput(APP_ID), inputArtifactRefs: ["art-1"] },
      "c1",
      ACTOR,
    );
    await world.service.transition(
      { ...transitionScope(APP_ID, executionId), command: "cancel", reason: "user-requested" },
      "k-cancel",
    );
    const events: readonly EventEnvelope[] = await world.service.listEvents(APP_ID, executionId);
    expect(events).toHaveLength(2);
    const cancel = events[1];
    expect(cancel).toMatchObject({
      executionId,
      applicationId: APP_ID,
      tenantId: ACTOR.tenantId,
      sequence: 2,
      type: "execution.cancel",
      command: "cancel",
      cause: "user-requested",
      payload: { from: "CREATED", to: "CANCELLED" },
      producerModule: "executions",
      schemaVersion: 1,
    });
    expect(cancel?.eventId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
