/**
 * Selected END-TO-END public API runs of the integration kit's examples
 * (DEP-020 acceptance criteria 1, 4; the work order's "selected
 * end-to-end public API runs" verification).
 *
 * The battery composes the REAL public API server over the REAL module
 * surfaces (the shared in-memory test world — the same composition the
 * API suites use), listens on a REAL port, and runs the examples' own
 * `main()` functions through the REAL SDK over HTTP. The execution
 * plane's progress is driven through the authority's own transition
 * commands (authorize → plan → queue → start → verify → pass) exactly
 * as the API route suites drive it — so create, lifecycle, result,
 * evidence, cost and replay retrieval are all exercised for real.
 *
 * The webhook receiver's core is exercised against the PLATFORM'S OWN
 * signing path (buildWebhookEvent + signWebhookEvent from src/api):
 * a valid signature applies, a replay acknowledges without re-applying,
 * a bad signature is rejected 401, a header mismatch is rejected 400.
 */

import { afterAll, describe, expect, test } from "vitest";
import { main as runErrorHandling } from "../../../examples/error-handling";
import { main as runHumanReviewGate } from "../../../examples/human-review-gate";
import type { ZeckEnv } from "../../../examples/lib/env";
import { main as runQuickstart } from "../../../examples/quickstart";
import { main as runTextSummarization } from "../../../examples/text-summarization";
import { EventMemory, handleWebhookDelivery } from "../../../examples/webhook-receiver";
import { buildWebhookEvent, signWebhookEvent } from "../../../src/api";
import type { EventEnvelope } from "../../../src/modules/executions/public";
import { ACTOR_ID, type ApiWorld, seedApiWorld } from "../api/world";

/** Drive one execution to COMPLETED through the authority transitions. */
async function driveToCompleted(
  world: ApiWorld,
  applicationId: string,
  executionId: string,
): Promise<void> {
  const actor = { actorId: ACTOR_ID, tenantId: world.tenantId };
  for (const command of ["authorize", "plan", "queue", "start", "verify"] as const) {
    await world.executions.transition(
      { command, applicationId, executionId, ...actor },
      `${command}-${executionId}`,
    );
  }
  await world.executions.transition(
    {
      command: "pass",
      applicationId,
      executionId,
      ...actor,
      verificationResults: [
        {
          criterionId: "quickstart-criterion",
          strategy: "deterministic-oracle",
          status: "PASS",
          recordedBy: "docs-battery",
          evidence: ["docs/developer/QUICKSTART.md"],
        },
      ],
    },
    `pass-${executionId}`,
  );
}

/**
 * Wrap the world service's createExecution so every execution the
 * EXAMPLE creates through HTTP is driven to completion by the
 * authority (the execution-plane seam) before the create returns.
 * Replays are passed through untouched.
 */
function driveCreatesToCompletion(world: ApiWorld): { readonly createdIds: string[] } {
  const createdIds: string[] = [];
  const original = world.executions.createExecution.bind(world.executions);
  const service = world.executions as unknown as {
    createExecution: typeof original;
  };
  service.createExecution = async (input, idempotencyKey, actor) => {
    const receipt = await original(input, idempotencyKey, actor);
    if (!receipt.replayed) {
      createdIds.push(receipt.executionId);
      await driveToCompleted(world, receipt.applicationId, receipt.executionId);
    }
    return receipt;
  };
  return { createdIds };
}

/** Compose a world + listening server + env the examples consume. */
async function composeExampleWorld(): Promise<{
  world: ApiWorld;
  env: ZeckEnv;
  createdIds: string[];
  close: () => Promise<void>;
}> {
  const world = await seedApiWorld();
  const { createdIds } = driveCreatesToCompletion(world);
  const listened: unknown = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
  let apiBaseUrl: string;
  if (typeof listened === "string" && listened.length > 0) {
    apiBaseUrl = listened;
  } else {
    const bound = world.server.app.server.address();
    const port = typeof bound === "object" && bound !== null ? bound.port : 3000;
    apiBaseUrl = `http://127.0.0.1:${port}`;
  }
  const env: ZeckEnv = {
    apiBaseUrl,
    token: world.bearerToken,
    applicationId: world.applicationId,
  };
  return {
    world,
    env,
    createdIds,
    close: async () => {
      await world.server.app.close();
    },
  };
}

const suites: { close: () => Promise<void> }[] = [];
afterAll(async () => {
  for (const suite of suites) {
    await suite.close();
  }
});

describe("the quickstart example runs end-to-end over the real API + SDK", () => {
  test("create → lifecycle → result/evidence/cost → replay all execute", async () => {
    const { world, env, createdIds, close } = await composeExampleWorld();
    suites.push({ close });

    // The example's own main(): SDK client, idempotent create, bounded
    // polling, result package, events, verification, replay create.
    await runQuickstart(env);

    // The example created exactly one NEW execution (plus one replay)
    // and the authority drove it to COMPLETED with verification.
    expect(createdIds).toHaveLength(1);
    const executionId = createdIds[0];
    expect(executionId).toBeDefined();
    const execution = await world.executions.getExecution(world.applicationId, executionId ?? "");
    expect(execution?.status).toBe("COMPLETED");

    // The evidence axis recorded the completion-bound verification.
    const verification = await world.executions.listVerificationResults(
      world.applicationId,
      executionId ?? "",
    );
    expect(verification.length).toBeGreaterThanOrEqual(1);

    // The ledger carries the full lifecycle trail.
    const events = await world.executions.listEvents(world.applicationId, executionId ?? "");
    expect(events.length).toBeGreaterThanOrEqual(7);
  });
});

describe("the text summarization example runs end-to-end", () => {
  test("the family example's code path executes against the real surface", async () => {
    const { env, createdIds, close } = await composeExampleWorld();
    suites.push({ close });
    await runTextSummarization(env);
    expect(createdIds).toHaveLength(1);
  });
});

describe("the human review gate example runs end-to-end", () => {
  test("the HITL family example's code path executes against the real surface", async () => {
    const { env, createdIds, close } = await composeExampleWorld();
    suites.push({ close });
    await runHumanReviewGate(env);
    expect(createdIds).toHaveLength(1);
  });
});

describe("the error-handling example runs end-to-end (taxonomy + idempotency)", () => {
  test("401 path, client-side rejection, resilient create, replay and 409 collision all execute", async () => {
    const { env, createdIds, close } = await composeExampleWorld();
    suites.push({ close });
    await runErrorHandling(env);
    // The resilient create + the two 422/collision attempts: exactly one
    // durable execution was created by this example.
    expect(createdIds).toHaveLength(1);
  });
});

describe("the webhook receiver verifies the platform's own signatures", () => {
  test("a valid signature applies; a replay acks without re-applying; a bad signature is 401", async () => {
    const memory = new EventMemory();
    const secret = "docs-battery-signing-secret";
    const envelope: EventEnvelope = {
      eventId: "evt-00000000-0000-7000-8000-0000000000e1",
      executionId: "00000000-0000-7000-8000-0000000000d1",
      applicationId: "00000000-0000-7000-8000-0000000000a1",
      tenantId: "00000000-0000-7000-8000-00000000a001",
      sequence: 1,
      type: "execution.completed",
      command: "pass",
      actor: { actorId: ACTOR_ID },
      cause: null,
      reference: {},
      payload: { status: "COMPLETED" },
      occurredAt: "2026-09-15T12:00:00Z",
      producerModule: "executions",
      schemaVersion: 1,
    };

    // The PLATFORM'S OWN signing path builds and signs the envelope.
    const event = buildWebhookEvent(envelope, 1, "2026-09-15T12:00:01Z");
    const signature = signWebhookEvent(event, secret);
    const body = JSON.stringify(event);

    // 1. Valid signature → applied.
    const applied = await handleWebhookDelivery(
      { body, signatureHex: signature, eventIdHeader: event.eventId },
      secret,
      memory,
    );
    expect(applied.status).toBe(202);
    expect(memory.size()).toBe(1);

    // 2. Redelivery of the SAME eventId → acknowledged, NOT re-applied.
    const redeliveredEvent = buildWebhookEvent(envelope, 2, "2026-09-15T12:00:05Z");
    const redeliveredSignature = signWebhookEvent(redeliveredEvent, secret);
    const replay = await handleWebhookDelivery(
      {
        body: JSON.stringify(redeliveredEvent),
        signatureHex: redeliveredSignature,
        eventIdHeader: redeliveredEvent.eventId,
      },
      secret,
      memory,
    );
    expect(replay.status).toBe(202);
    expect(memory.size()).toBe(1); // exactly-once semantics held

    // 3. Bad signature → rejected, unsigned webhooks are never trusted.
    const rejected = await handleWebhookDelivery(
      { body, signatureHex: "0".repeat(64), eventIdHeader: event.eventId },
      secret,
      memory,
    );
    expect(rejected.status).toBe(401);

    // 4. Header/event identity mismatch → rejected.
    const mismatched = await handleWebhookDelivery(
      { body, signatureHex: signature, eventIdHeader: "different-event-id" },
      secret,
      memory,
    );
    expect(mismatched.status).toBe(400);

    // 5. Malformed JSON → rejected.
    const malformed = await handleWebhookDelivery(
      { body: "{not-json", signatureHex: signature, eventIdHeader: event.eventId },
      secret,
      memory,
    );
    expect(malformed.status).toBe(400);
  });
});
