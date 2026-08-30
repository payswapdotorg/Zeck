/**
 * Unit — execution step events (executions module, WORK-010): the
 * non-transition ledger seam the governed tool runtime rides.
 *
 * Proves: gapless sequences interleaved with real transitions; the
 * status-preserving row write (the state machine cannot be moved by a step
 * event); terminal executions accept none; tenant scope; request
 * idempotency (same key replays the same envelope, different fingerprint
 * fails IDEMPOTENCY_KEY_REUSED); the event vocabulary is owned by the
 * executions domain.
 */

import { describe, expect, test } from "vitest";
import type { EventEnvelope } from "../../../src/modules/executions/domain/event";
import {
  isStepEventCommand,
  STEP_EVENT_COMMANDS,
} from "../../../src/modules/executions/domain/event";
import { PlatformError } from "../../../src/shared/errors";
import { ACTOR, baseCreateInput, createInMemoryExecutions, transitionScope } from "./fakes";

const APP_ID = "11111111-1111-7000-8000-000000000001";

async function runningExecution(world: ReturnType<typeof createInMemoryExecutions>) {
  world.store.seedApplication(APP_ID, ACTOR.tenantId);
  const receipt = await world.service.createExecution(baseCreateInput(APP_ID), "k-create", ACTOR);
  const executionId = receipt.executionId;
  const scope = transitionScope(APP_ID, executionId);
  await world.service.transition({ ...scope, command: "authorize" }, "k-auth");
  await world.service.transition({ ...scope, command: "plan" }, "k-plan");
  await world.service.transition({ ...scope, command: "queue" }, "k-queue");
  await world.service.transition({ ...scope, command: "start" }, "k-start");
  return executionId;
}

describe("execution step events", () => {
  test("step-event vocabulary is owned by the executions domain", () => {
    expect(STEP_EVENT_COMMANDS).toEqual(["tool-requested", "tool-result", "tool-denied"]);
    expect(isStepEventCommand("tool-requested")).toBe(true);
    expect(isStepEventCommand("authorize")).toBe(false);
    expect(isStepEventCommand("tool-bogus")).toBe(false);
  });

  test("a step event appends a gapless envelope and preserves status exactly", async () => {
    const world = createInMemoryExecutions();
    const executionId = await runningExecution(world);
    const before = await world.service.getExecution(APP_ID, executionId);
    expect(before?.status).toBe("RUNNING");

    const outcome = await world.service.recordStepEvent(
      {
        executionId,
        applicationId: APP_ID,
        actor: ACTOR,
        command: "tool-requested",
        cause: "tool-invocation",
        reference: { invocationId: "inv-1", toolId: "calculator" },
        payload: { invocationId: "inv-1", toolId: "calculator" },
      },
      "step-1",
    );

    expect(outcome).toMatchObject({
      executionId,
      sequence: 6, // create + authorize + plan + queue + start = 5, next is 6
      type: "execution.tool-requested",
      command: "tool-requested",
      status: "RUNNING",
      replayed: false,
    });
    const after = await world.service.getExecution(APP_ID, executionId);
    expect(after?.status).toBe("RUNNING"); // the state machine did not move
    expect(after?.lastEventSequence).toBe(6);

    const events = await world.service.listEvents(APP_ID, executionId);
    expect(events.map((event: EventEnvelope) => event.type)).toEqual([
      "execution.created",
      "execution.authorize",
      "execution.plan",
      "execution.queue",
      "execution.start",
      "execution.tool-requested",
    ]);
    const stepEvent = events[5];
    expect(stepEvent).toBeDefined();
    expect(stepEvent?.producerModule).toBe("executions");
    expect(stepEvent?.cause).toBe("tool-invocation");
    expect(stepEvent?.reference).toEqual({ invocationId: "inv-1", toolId: "calculator" });
  });

  test("step events interleave gaplessly with subsequent transitions", async () => {
    const world = createInMemoryExecutions();
    const executionId = await runningExecution(world);
    const scope = transitionScope(APP_ID, executionId);
    await world.service.recordStepEvent(
      {
        executionId,
        applicationId: APP_ID,
        actor: ACTOR,
        command: "tool-requested",
        payload: { invocationId: "inv-1" },
      },
      "s1",
    );
    await world.service.recordStepEvent(
      {
        executionId,
        applicationId: APP_ID,
        actor: ACTOR,
        command: "tool-result",
        payload: { invocationId: "inv-1", outcomeClass: "tool-success" },
      },
      "s2",
    );
    await world.service.transition({ ...scope, command: "wait-tool" }, "k-wait");
    await world.service.transition({ ...scope, command: "resume" }, "k-resume");

    const events = await world.service.listEvents(APP_ID, executionId);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(events.map((event) => event.type)).toEqual([
      "execution.created",
      "execution.authorize",
      "execution.plan",
      "execution.queue",
      "execution.start",
      "execution.tool-requested",
      "execution.tool-result",
      "execution.wait-tool",
      "execution.resume",
    ]);
    expect((await world.service.getExecution(APP_ID, executionId))?.status).toBe("RUNNING");
  });

  test("same key replays the same envelope; different fingerprint fails key-reuse", async () => {
    const world = createInMemoryExecutions();
    const executionId = await runningExecution(world);
    const input = {
      executionId,
      applicationId: APP_ID,
      actor: ACTOR,
      command: "tool-result" as const,
      payload: { invocationId: "inv-1", outcomeClass: "tool-success" },
    };
    const first = await world.service.recordStepEvent(input, "same-key");
    const replay = await world.service.recordStepEvent(input, "same-key");
    expect(replay.replayed).toBe(true);
    expect(replay.sequence).toBe(first.sequence);
    const events = await world.service.listEvents(APP_ID, executionId);
    expect(events.filter((event) => event.type === "execution.tool-result")).toHaveLength(1);

    await expect(
      world.service.recordStepEvent(
        { ...input, payload: { invocationId: "inv-1", outcomeClass: "tool-failure" } },
        "same-key",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("terminal executions accept no step events; unknown commands are typed errors", async () => {
    const world = createInMemoryExecutions();
    const executionId = await runningExecution(world);
    const scope = transitionScope(APP_ID, executionId);
    await world.service.transition(
      {
        ...scope,
        command: "fail",
        verificationResults: [{ criterionId: "c", strategy: "s", status: "FAIL", recordedBy: "t" }],
      },
      "k-fail",
    );
    await expect(
      world.service.recordStepEvent(
        {
          executionId,
          applicationId: APP_ID,
          actor: ACTOR,
          command: "tool-result",
          payload: {},
        },
        "s-late",
      ),
    ).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      message: expect.stringContaining("terminal"),
    });

    await expect(
      world.service.recordStepEvent(
        {
          executionId,
          applicationId: APP_ID,
          actor: ACTOR,
          command: "tool-bogus" as never,
          payload: {},
        },
        "s-bogus",
      ),
    ).rejects.toBeInstanceOf(PlatformError);
  });

  test("tenant scope is asserted before any append", async () => {
    const world = createInMemoryExecutions();
    const executionId = await runningExecution(world);
    await expect(
      world.service.recordStepEvent(
        {
          executionId,
          applicationId: APP_ID,
          actor: {
            actorId: "00000000-0000-7000-8000-0000000000cc",
            tenantId: "00000000-0000-7000-8000-0000000000dd",
          },
          command: "tool-requested",
          payload: {},
        },
        "s-foreign",
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });

    await expect(
      world.service.recordStepEvent(
        {
          executionId: "00000000-0000-7000-8000-0000000000ff",
          applicationId: APP_ID,
          actor: ACTOR,
          command: "tool-requested",
          payload: {},
        },
        "s-missing",
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
  });
});
