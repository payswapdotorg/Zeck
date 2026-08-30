/**
 * Executions planning-decision recording tests (executions module
 * extension; WORK-009).
 *
 * `recordPlanningDecision` — the durable ledger surface the planner
 * consumes: state guard (PLANNING/REPLANNING only), tenant scope
 * rejection-before-write, gapless append through the single write path
 * (identity-preserving sequence advance), idempotency arbitration and
 * typed failures.
 */

import { describe, expect, test } from "vitest";
import { PLANNING_DECISION_EVENT_TYPE } from "../../../src/modules/executions/public";
import { PlatformError } from "../../../src/shared/errors";
import { ACTOR, createInMemoryExecutions } from "./fakes";

const APP_ID = "00000000-0000-7000-8000-0000000000e1";

let receiptCounter = 0;

async function executionInPlanning(world: ReturnType<typeof createInMemoryExecutions>) {
  receiptCounter += 1;
  const receipt = await world.service.createExecution(
    { applicationId: APP_ID, task: { kind: "arithmetic", input: {} } },
    `create-${receiptCounter}`,
    ACTOR,
  );
  const executionId = receipt.executionId;
  await world.service.transition(
    { ...ACTOR, applicationId: APP_ID, executionId, command: "authorize" },
    `auth-${executionId}`,
  );
  await world.service.transition(
    { ...ACTOR, applicationId: APP_ID, executionId, command: "plan" },
    `plan-${executionId}`,
  );
  return executionId;
}

function decisionInput(executionId: string, overrides: Record<string, unknown> = {}) {
  return {
    applicationId: APP_ID,
    executionId,
    tenantId: ACTOR.tenantId,
    actorId: ACTOR.actorId,
    decisionId: "decision-1",
    planId: "a".repeat(64),
    payload: {
      decisionId: "decision-1",
      selectedStrategyId: "deterministic-only",
      candidates: [{ strategyId: "deterministic-only" }],
    },
    ...overrides,
  };
}

describe("recordPlanningDecision (executions ledger extension, WORK-009)", () => {
  test("appends a planning.decision-recorded envelope with gapless sequence and preserved status", async () => {
    const world = createInMemoryExecutions();
    world.store.seedApplication(APP_ID, ACTOR.tenantId);
    const executionId = await executionInPlanning(world);
    const outcome = await world.service.recordPlanningDecision(
      decisionInput(executionId),
      "pd-key-1",
    );
    expect(outcome.decisionId).toBe("decision-1");
    expect(outcome.replayed).toBe(false);
    const events = await world.service.listEvents(APP_ID, executionId);
    expect(events).toHaveLength(4); // created, authorize, plan, decision
    const envelope = events[3];
    expect(envelope?.type).toBe(PLANNING_DECISION_EVENT_TYPE);
    expect(envelope?.command).toBe("plan");
    expect(envelope?.cause).toBe("planning-decision");
    expect(envelope?.sequence).toBe(4);
    expect((envelope?.reference as Record<string, unknown>)?.decisionId).toBe("decision-1");
    expect((envelope?.reference as Record<string, unknown>)?.planId).toBe("a".repeat(64));
    const row = await world.service.getExecution(APP_ID, executionId);
    expect(row?.status).toBe("PLANNING"); // identity-preserving advance
    expect(row?.lastEventSequence).toBe(4);
  });

  test("idempotent retry replays the same outcome without a second envelope", async () => {
    const world = createInMemoryExecutions();
    world.store.seedApplication(APP_ID, ACTOR.tenantId);
    const executionId = await executionInPlanning(world);
    const first = await world.service.recordPlanningDecision(
      decisionInput(executionId),
      "pd-key-2",
    );
    const second = await world.service.recordPlanningDecision(
      decisionInput(executionId),
      "pd-key-2",
    );
    expect(second.replayed).toBe(true);
    expect(second.sequence).toBe(first.sequence);
    expect(second.decisionId).toBe(first.decisionId);
    const events = await world.service.listEvents(APP_ID, executionId);
    expect(events.filter((e) => e.type === PLANNING_DECISION_EVENT_TYPE)).toHaveLength(1);
  });

  test("the same key with a different fingerprint fails IDEMPOTENCY_KEY_REUSED", async () => {
    const world = createInMemoryExecutions();
    world.store.seedApplication(APP_ID, ACTOR.tenantId);
    const executionId = await executionInPlanning(world);
    await world.service.recordPlanningDecision(decisionInput(executionId), "pd-key-3");
    await expect(
      world.service.recordPlanningDecision(
        decisionInput(executionId, { decisionId: "decision-2" }),
        "pd-key-3",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("out-of-phase recording (RUNNING) fails INVALID_STATE_TRANSITION with ZERO writes", async () => {
    const world = createInMemoryExecutions();
    world.store.seedApplication(APP_ID, ACTOR.tenantId);
    const executionId = await executionInPlanning(world);
    await world.service.transition(
      { ...ACTOR, applicationId: APP_ID, executionId, command: "queue" },
      "q-1",
    );
    await world.service.transition(
      { ...ACTOR, applicationId: APP_ID, executionId, command: "start" },
      "s-1",
    );
    await expect(
      world.service.recordPlanningDecision(decisionInput(executionId), "pd-key-4"),
    ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
    const events = await world.service.listEvents(APP_ID, executionId);
    expect(events.filter((e) => e.type === PLANNING_DECISION_EVENT_TYPE)).toHaveLength(0);
  });

  test("a cross-tenant recording attempt fails TENANT_SCOPE_VIOLATION before any write", async () => {
    const world = createInMemoryExecutions();
    world.store.seedApplication(APP_ID, ACTOR.tenantId);
    const executionId = await executionInPlanning(world);
    await expect(
      world.service.recordPlanningDecision(
        decisionInput(executionId, { tenantId: "00000000-0000-7000-8000-0000000000dd" }),
        "pd-key-5",
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
    const events = await world.service.listEvents(APP_ID, executionId);
    expect(events.filter((e) => e.type === PLANNING_DECISION_EVENT_TYPE)).toHaveLength(0);
  });

  test("an unknown execution fails TENANT_SCOPE_VIOLATION (missing or other application)", async () => {
    const world = createInMemoryExecutions();
    world.store.seedApplication(APP_ID, ACTOR.tenantId);
    await expect(
      world.service.recordPlanningDecision(
        decisionInput("00000000-0000-7000-8000-0000000000ff"),
        "pd-key-6",
      ),
    ).rejects.toMatchObject({ code: "TENANT_SCOPE_VIOLATION" });
  });

  test("malformed inputs are rejected typed before any durable interaction", async () => {
    const world = createInMemoryExecutions();
    world.store.seedApplication(APP_ID, ACTOR.tenantId);
    const executionId = await executionInPlanning(world);
    await expect(
      world.service.recordPlanningDecision(decisionInput(executionId, { decisionId: "" }), "x-1"),
    ).rejects.toBeInstanceOf(PlatformError);
    await expect(
      world.service.recordPlanningDecision(decisionInput(executionId, { planId: "" }), "x-2"),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(
      world.service.recordPlanningDecision(decisionInput(executionId, { payload: {} }), "x-3"),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await expect(
      world.service.recordPlanningDecision(
        decisionInput(executionId, { executionId: "not-a-uuid" }),
        "x-4",
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  });

  test("REPLANNING accepts a decision carrying replanOf provenance", async () => {
    const world = createInMemoryExecutions();
    world.store.seedApplication(APP_ID, ACTOR.tenantId);
    const executionId = await executionInPlanning(world);
    await world.service.recordPlanningDecision(decisionInput(executionId), "pd-key-7");
    await world.service.transition(
      { ...ACTOR, applicationId: APP_ID, executionId, command: "queue" },
      "q-2",
    );
    await world.service.transition(
      { ...ACTOR, applicationId: APP_ID, executionId, command: "start" },
      "s-2",
    );
    await world.service.transition(
      { ...ACTOR, applicationId: APP_ID, executionId, command: "verify" },
      "v-2",
    );
    await world.service.transition(
      {
        ...ACTOR,
        applicationId: APP_ID,
        executionId,
        command: "replan",
        reason: "verification-failed",
      },
      "r-2",
    );
    const replanned = await world.service.recordPlanningDecision(
      decisionInput(executionId, { decisionId: "decision-2", replanOf: "decision-1" }),
      "pd-key-8",
    );
    expect(replanned.sequence).toBe(9);
    const events = await world.service.listEvents(APP_ID, executionId);
    const replanEnvelope = events.find(
      (e) => e.type === PLANNING_DECISION_EVENT_TYPE && e.sequence === 9,
    );
    expect((replanEnvelope?.reference as Record<string, unknown>)?.replanOf).toBe("decision-1");
    const row = await world.service.getExecution(APP_ID, executionId);
    expect(row?.status).toBe("REPLANNING"); // preserved through the replan record
  });
});
