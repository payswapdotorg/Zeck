/**
 * PPR-008 unit tests — the deterministic sandbox substrate's honest labels
 * and its convergence through the REAL execution service.
 *
 * WHAT IS PINNED HERE (the work order's verification battery):
 *  - THE TERMINAL RECEIPT: a created execution is driven to COMPLETED
 *    through the execution service's OWN state machine (the in-memory
 *    fakes of tests/unit/executions/fakes.ts — the same faithful durable
 *    contract: gapless append-only ledger, one-event row writes, idempotency
 *    arbitration), and the create response IS the terminal receipt;
 *  - THE FULL GOVERNED LEDGER: created → authorize → plan → the planning
 *    decision → queue → start → sandbox-admitted → sandbox-completed →
 *    verify → pass, sequences 1..10 gapless, every substrate envelope
 *    carrying the honest origin as its provenance cause;
 *  - THE HONEST LABELS: the execution metadata carries `substrateOrigin`
 *    (the caller's own metadata keys preserved); the verification result is
 *    PASS recorded by the substrate itself, naming the substrate as its
 *    strategy; the sandbox-completed payload records the truthful
 *    zero-cost / zero-usage facts and says plainly that no model was
 *    involved; the planning decision records the deterministic-only
 *    strategy with zero model calls and no provider route;
 *  - THE DETERMINISM: the same task yields the identical output fixture;
 *  - THE CONVERGENCE: an idempotent replay of the create returns the same
 *    terminal execution WITHOUT duplicating a single ledger envelope; a
 *    pre-driven terminal execution is never touched again; and a state the
 *    substrate cannot legally walk (WAITING_*) is refused with the
 *    canonical INVALID_STATE_TRANSITION — never a bypass.
 */

import { describe, expect, test } from "vitest";
import {
  createDeterministicSubstrateExecutions,
  deterministicOutputOf,
  SUBSTRATE_METADATA_KEY,
  SUBSTRATE_ORIGIN,
} from "../../../deploy/preview-substrate";
import { PlatformError } from "../../../src/shared/errors";
import { ACTOR, createInMemoryExecutions } from "../executions/fakes";

const APPLICATION_ID = "00000000-0000-4000-8000-00000000aa01";

function substrateWorld() {
  const world = createInMemoryExecutions();
  world.store.seedApplication(APPLICATION_ID, ACTOR.tenantId);
  const substrate = createDeterministicSubstrateExecutions({
    inner: world.service,
    actor: ACTOR,
    generateId: world.generateId,
    now: () => new Date("2026-09-22T12:00:00Z"),
  });
  return { ...world, substrate };
}

const TASK = { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 };

function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  return promise.then(
    () => {
      throw new Error(`expected PlatformError ${code}, resolved instead`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(PlatformError);
      expect((error as PlatformError).code).toBe(code);
    },
  );
}

describe("PPR-008: the deterministic substrate drives a created execution to an honest terminal receipt", () => {
  test("the create response IS the terminal receipt (COMPLETED, bound verification)", async () => {
    const { substrate } = substrateWorld();
    const receipt = await substrate.createExecution(
      { applicationId: APPLICATION_ID, task: TASK, metadata: { origin: "caller-probe" } },
      "create-1",
      ACTOR,
    );
    expect(receipt.status).toBe("COMPLETED");
    expect(receipt.replayed).toBe(false);
    expect(receipt.terminalAt).not.toBeNull();
    expect(receipt.verificationRefs).toHaveLength(1);
    // The caller's own metadata keys are preserved; the substrate's origin
    // label is ADDED (never overwriting caller provenance).
    const row = await substrate.getExecution(APPLICATION_ID, receipt.executionId);
    expect(row?.metadata).toEqual({
      origin: "caller-probe",
      [SUBSTRATE_METADATA_KEY]: SUBSTRATE_ORIGIN,
    });
  });

  test("the full governed ledger: 10 gapless envelopes, the honest cause on every substrate envelope", async () => {
    const { substrate } = substrateWorld();
    const receipt = await substrate.createExecution(
      { applicationId: APPLICATION_ID, task: TASK },
      "create-2",
      ACTOR,
    );
    const events = await substrate.listEvents(APPLICATION_ID, receipt.executionId);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(events.map((event) => event.type)).toEqual([
      "execution.created",
      "execution.authorize",
      "execution.plan",
      "planning.decision-recorded",
      "execution.queue",
      "execution.start",
      "execution.sandbox-admitted",
      "execution.sandbox-completed",
      "execution.verify",
      "execution.pass",
    ]);
    // Every substrate-driven envelope carries the honest origin cause (the
    // planning-decision envelope keeps the service's structural cause and
    // carries the origin in its payload — asserted below); the create
    // envelope is the service's own (no cause).
    for (const event of events.slice(1)) {
      if (event.type === "planning.decision-recorded") {
        expect(event.cause).toBe("planning-decision");
        expect((event.payload as { readonly origin?: string }).origin).toBe(SUBSTRATE_ORIGIN);
        continue;
      }
      expect(event.cause).toBe(SUBSTRATE_ORIGIN);
    }
    expect(events[0]?.cause).toBeNull();
    // The substrate worker is the provenance actor of every drive envelope.
    for (const event of events.slice(1)) {
      expect(event.actor).toEqual({ actorId: ACTOR.actorId, tenantId: ACTOR.tenantId });
    }
  });

  test("the honest verification outcome: PASS recorded by the substrate, naming the substrate", async () => {
    const { substrate } = substrateWorld();
    const receipt = await substrate.createExecution(
      { applicationId: APPLICATION_ID, task: TASK },
      "create-3",
      ACTOR,
    );
    const results = await substrate.listVerificationResults(APPLICATION_ID, receipt.executionId);
    expect(results).toHaveLength(1);
    const result = results[0];
    expect(result?.status).toBe("PASS");
    expect(result?.strategy).toBe(SUBSTRATE_ORIGIN);
    expect(result?.recordedBy).toBe(SUBSTRATE_ORIGIN);
    expect(result?.criterionId).toBe("deterministic-output-recorded");
    expect(result?.evidence).toContain(`ledger:sandbox-completed:${receipt.executionId}`);
  });

  test("the honest substrate labels: no model, truthful zero cost, deterministic output", async () => {
    const { substrate } = substrateWorld();
    const receipt = await substrate.createExecution(
      { applicationId: APPLICATION_ID, task: TASK },
      "create-4",
      ACTOR,
    );
    const events = await substrate.listEvents(APPLICATION_ID, receipt.executionId);
    const admitted = events.find((event) => event.type === "execution.sandbox-admitted");
    const completed = events.find((event) => event.type === "execution.sandbox-completed");
    expect(admitted?.payload).toMatchObject({
      origin: SUBSTRATE_ORIGIN,
      runtime: "deterministic",
      deterministic: true,
      modelBacked: false,
    });
    expect(completed?.payload).toMatchObject({
      origin: SUBSTRATE_ORIGIN,
      costMicroUsd: "0",
      usage: { inputTokens: 0, outputTokens: 0 },
      modelBacked: false,
    });
    const output = (completed?.payload as { readonly output?: Readonly<Record<string, unknown>> })
      ?.output;
    expect(output).toMatchObject({ kind: "summarize", modelBacked: false });
    expect(JSON.stringify(output)).toContain("no model was involved");
    // The planning decision: deterministic-only, zero model calls, no route.
    const decision = events.find((event) => event.type === "planning.decision-recorded");
    expect(decision?.payload).toMatchObject({
      selectedStrategyId: SUBSTRATE_ORIGIN,
      deterministic: true,
      modelBacked: false,
      candidates: [
        {
          strategyId: SUBSTRATE_ORIGIN,
          plan: { steps: [], strategyClass: "deterministic-only", modelCalls: 0 },
        },
      ],
    });
  });

  test("determinism: the same task yields the identical output fixture", () => {
    const first = deterministicOutputOf(TASK);
    const second = deterministicOutputOf({ ...TASK });
    expect(first).toEqual(second);
    const other = deterministicOutputOf({ kind: "summarize", doc: "another-doc" });
    expect(other).not.toEqual(first);
    // Non-summarize tasks get the honest generic deterministic output.
    const generic = deterministicOutputOf({ kind: "triage", input: "inbox-1" });
    expect(generic).toMatchObject({ kind: "triage", modelBacked: false });
    expect(JSON.stringify(generic)).toContain("no model was involved");
  });

  test("convergence: an idempotent replay returns the same terminal execution with NO duplicated envelope", async () => {
    const { substrate } = substrateWorld();
    const input = { applicationId: APPLICATION_ID, task: TASK };
    const first = await substrate.createExecution(input, "create-5", ACTOR);
    const replay = await substrate.createExecution(input, "create-5", ACTOR);
    expect(replay.executionId).toBe(first.executionId);
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe("COMPLETED");
    const events = await substrate.listEvents(APPLICATION_ID, first.executionId);
    expect(events).toHaveLength(10);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test("the drive is status-driven: an execution left mid-flight is resumed, not restarted", async () => {
    // Create through the REAL service directly (a crash between create and
    // the drive), leaving the execution AUTHORIZED. The manual create uses
    // the EXACT labeled input the substrate composition produces (the
    // substrateOrigin metadata fact is part of its create contract), so the
    // substrate's same-key retry is a fingerprint-identical replay.
    const world = substrateWorld();
    const labeledInput = {
      applicationId: APPLICATION_ID,
      task: TASK,
      metadata: { [SUBSTRATE_METADATA_KEY]: SUBSTRATE_ORIGIN },
    };
    await world.service.createExecution(labeledInput, "create-6", ACTOR);
    const created = [...world.store.executions.values()][0];
    expect(created).toBeDefined();
    const executionId = created?.id as string;
    await world.service.transition(
      {
        command: "authorize",
        actorId: ACTOR.actorId,
        tenantId: ACTOR.tenantId,
        applicationId: APPLICATION_ID,
        executionId,
      },
      `authorize-${executionId}`,
    );
    // The substrate's replay of the SAME idempotency key resumes the walk
    // from AUTHORIZED and completes the execution.
    const receipt = await world.substrate.createExecution(labeledInput, "create-6", ACTOR);
    expect(receipt.executionId).toBe(executionId);
    expect(receipt.status).toBe("COMPLETED");
    expect(receipt.replayed).toBe(true);
    const events = await world.substrate.listEvents(APPLICATION_ID, executionId);
    // created + authorize (manual) + the substrate's remaining 8 envelopes.
    expect(events.map((event) => event.type)).toEqual([
      "execution.created",
      "execution.authorize",
      "execution.plan",
      "planning.decision-recorded",
      "execution.queue",
      "execution.start",
      "execution.sandbox-admitted",
      "execution.sandbox-completed",
      "execution.verify",
      "execution.pass",
    ]);
  });

  test("a state the substrate cannot legally walk is refused with INVALID_STATE_TRANSITION (no bypass)", async () => {
    const world = substrateWorld();
    // Create + drive to RUNNING through the real service, then WAITING_TOOL
    // (a state only an external driver could produce on this plane). The
    // manual create uses the substrate's exact labeled input so the retry is
    // a fingerprint-identical replay.
    const labeledInput = {
      applicationId: APPLICATION_ID,
      task: TASK,
      metadata: { [SUBSTRATE_METADATA_KEY]: SUBSTRATE_ORIGIN },
    };
    await world.service.createExecution(labeledInput, "create-7", ACTOR);
    const created = [...world.store.executions.values()][0];
    const executionId = created?.id as string;
    for (const command of ["authorize", "plan", "queue", "start", "wait-tool"] as const) {
      await world.service.transition(
        {
          command,
          actorId: ACTOR.actorId,
          tenantId: ACTOR.tenantId,
          applicationId: APPLICATION_ID,
          executionId,
        },
        `${command}-${executionId}`,
      );
    }
    // The substrate's drive on the replayed create REFUSES honestly.
    await expectCode(
      world.substrate.createExecution(labeledInput, "create-7", ACTOR),
      "INVALID_STATE_TRANSITION",
    );
    // The execution stays exactly where it was (WAITING_TOOL, untouched).
    const row = await world.substrate.getExecution(APPLICATION_ID, executionId);
    expect(row?.status).toBe("WAITING_TOOL");
  });

  test("executions outside the substrate worker's tenant scope are returned un-driven (honest no-op)", async () => {
    const world = substrateWorld();
    world.store.seedApplication(
      "00000000-0000-4000-8000-00000000bb02",
      "00000000-0000-4000-8000-0000000000dd",
    );
    const receipt = await world.substrate.createExecution(
      {
        applicationId: "00000000-0000-4000-8000-00000000bb02",
        task: TASK,
        metadata: { [SUBSTRATE_METADATA_KEY]: SUBSTRATE_ORIGIN },
      },
      "create-8",
      { actorId: ACTOR.actorId, tenantId: "00000000-0000-4000-8000-0000000000dd" },
    );
    // The metadata label is still merged (the composition labels what it is);
    // the drive itself is scoped to the substrate worker's own tenant.
    expect(receipt.status).toBe("CREATED");
    expect(receipt.terminalAt).toBeNull();
  });
});
