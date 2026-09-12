/**
 * VAL-018 chain unit tests: the multimodal-transformation chain
 * orchestration (apps/multimodal-transformation/chain.ts) over
 * controlled fakes — the vision dispatch function and the imagegen
 * rail are faked; the stage-2 derivation is pure.
 *
 * Honesty invariants under test:
 *   * the full chain (vision -> structured description -> derived
 *     media) succeeds with per-stage provenance (request digests,
 *     response digests, measured latencies, summed usage) and the
 *     chaining itself visible (stage 2's request digest IS stage 1's
 *     response digest);
 *   * a stage failure aborts the chain with the EXACT stage recorded
 *     and later stages never executed (chain-abort propagation);
 *   * the oracle floor: a vision answer missing the ground-truth term
 *     fails stage 1; a structured description missing the term fails
 *     stage 2 (no provider-success shortcut);
 *   * the pre-chain discriminations (wrong modality, fixture-digest
 *     mismatch) reject before ANY network effect;
 *   * the derived-media stage's bounded retry retries RETRYABLE
 *     failures only;
 *   * the driver records BOTH stage planning decisions BEFORE the
 *     dispatch and completes honestly.
 */

import { describe, expect, test } from "vitest";
import { MULTIMODAL_TRANSFORMATION_TASKS } from "../../../benchmarks/validation/apps/multimodal-transformation/application";
import {
  createMultimodalTransformationBinding,
  deriveDerivedMediaPrompt,
  deriveDerivedMediaVerification,
  deriveTransformationChainPlan,
  driveMultimodalTransformationExecution,
  materializeTransformationInput,
  TransformationFixtureNotMaterializedError,
  type TransformMultimodalTask,
} from "../../../benchmarks/validation/apps/multimodal-transformation/chain";
import { DERIVED_MEDIA_SIZE } from "../../../benchmarks/validation/apps/multimodal-transformation/fixtures";
import { createCanvas } from "../../../benchmarks/validation/apps/shared/media";
import type { LabDispatchOutcome } from "../../../benchmarks/validation/platform/derive";
import type { PlatformLifecyclePort } from "../../../benchmarks/validation/platform/driver";
import type {
  ImagegenRail,
  ImagegenRailOutcome,
} from "../../../benchmarks/validation/platform/imagegen";
import { materializeTaskMedia } from "../../../benchmarks/validation/platform/multimodal";
import {
  deriveStructuredDescription,
  type StructuredDescription,
} from "../../../benchmarks/validation/platform/three-d";

// ---------------------------------------------------------------------------
// Fakes (controlled, deterministic)
// ---------------------------------------------------------------------------

const SIZE = { width: 64, height: 64 };

/** A deterministic synthetic "generated" raster at the declared size. */
function syntheticPng(width: number, height: number): Buffer {
  const canvas = createCanvas(width, height);
  canvas.fillRect(0, 0, width, height, [250, 250, 250]);
  canvas.drawCircle(
    Math.floor(width / 2),
    Math.floor(height / 2),
    Math.floor(width / 4),
    [30, 90, 200],
  );
  return canvas.toPng();
}

/** The canonical valid vision answer (schema-conformant, oracle-carrying). */
function validVisionAnswer(subject = "bus"): string {
  return JSON.stringify({
    subject,
    colors: ["yellow", "gray"],
    background: "street",
    composition: `the ${subject} is centered on the road`,
  });
}

/** A fake vision dispatch recording every call. */
function fakeVisionDispatch(handler: () => Promise<LabDispatchOutcome>): {
  readonly dispatch: (input: {
    readonly executionId: string;
    readonly task: unknown;
    readonly provider: string;
    readonly model: string;
  }) => Promise<LabDispatchOutcome>;
  readonly calls: { task: unknown; provider: string; model: string }[];
} {
  const calls: { task: unknown; provider: string; model: string }[] = [];
  return {
    calls,
    dispatch: async (input) => {
      calls.push({ task: input.task, provider: input.provider, model: input.model });
      return await handler();
    },
  };
}

/** A fake text-to-image imagegen rail recording every dispatch. */
function fakeImagegenRail(handler: () => Promise<ImagegenRailOutcome>): {
  readonly rail: ImagegenRail;
  readonly calls: { model: string; prompt: string; size?: unknown }[];
} {
  const calls: { model: string; prompt: string; size?: unknown }[] = [];
  const rail: ImagegenRail = {
    railId: "fake-imagegen",
    mode: "text-to-image",
    async dispatch(input) {
      calls.push({ model: input.model, prompt: input.prompt, size: input.size });
      return await handler();
    },
  };
  return { rail, calls };
}

const ROUTE = {
  visionProvider: "openrouter",
  visionModel: "qwen/vl-test",
  imagegenProvider: "dashscope",
  imagegenModel: "qwen-image-test",
};

const CHAIN_TASK: TransformMultimodalTask = {
  kind: "transform-multimodal",
  source: "img-c-001",
  instruction: "mm-instruction-001",
};

const ORACLE = { containsText: ["bus"] };

/** Build the chain binding over the fakes with per-call counters. */
function buildChain(options: {
  readonly visionOutcome: () => Promise<LabDispatchOutcome>;
  readonly railOutcome: () => Promise<ImagegenRailOutcome>;
  readonly withRail?: boolean;
  readonly retry?: { attempts: number; delayMs: number; sleep?: (ms: number) => Promise<void> };
  readonly materialize?: Parameters<typeof createMultimodalTransformationBinding>[0]["materialize"];
}): {
  readonly binding: ReturnType<typeof createMultimodalTransformationBinding>;
  readonly vision: { calls: { task: unknown; provider: string; model: string }[] };
  readonly rail: { calls: { model: string; prompt: string; size?: unknown }[] };
  readonly railCalls: { count: number };
} {
  const vision = fakeVisionDispatch(options.visionOutcome);
  const rail = fakeImagegenRail(options.railOutcome);
  const railCalls = { count: 0 };
  const binding = createMultimodalTransformationBinding({
    visionDispatch: vision.dispatch,
    visionProvider: ROUTE.visionProvider,
    visionModel: ROUTE.visionModel,
    imagegenRail: options.withRail === false ? undefined : rail.rail,
    imagegenProvider: ROUTE.imagegenProvider,
    imagegenModel: ROUTE.imagegenModel,
    derivedMediaSize: SIZE,
    railCalls,
    ...(options.retry === undefined ? {} : { imagegenRetry: options.retry }),
    ...(options.materialize === undefined ? {} : { materialize: options.materialize }),
    now: () => new Date(1_000_000),
  });
  return { binding, vision, rail, railCalls };
}

function recordingLifecycle(): {
  readonly lifecycle: PlatformLifecyclePort;
  readonly transitions: string[];
} {
  const transitions: string[] = [];
  const lifecycle: PlatformLifecyclePort = {
    async transition({ step }) {
      transitions.push(step);
    },
    async recordPlanningDecision() {
      transitions.push("planning-decision");
    },
    async complete({ verdict }) {
      transitions.push(`complete:${verdict}`);
    },
  };
  return { lifecycle, transitions };
}

// ---------------------------------------------------------------------------
// Plan derivation + pure derivations
// ---------------------------------------------------------------------------

describe("VAL-018 chain plan derivation", () => {
  test("a chain task derives the describe-image stage task and both stage routes", () => {
    const plan = deriveTransformationChainPlan(CHAIN_TASK, ROUTE);
    expect(plan.kind).toBe("chain");
    expect(plan.stageRoutes).toHaveLength(2);
    expect(plan.stageRoutes[0]).toMatchObject({
      provider: "openrouter",
      strategyClass: "chained-multimodal-transformation-vision",
    });
    expect(plan.stageRoutes[1]).toMatchObject({
      provider: "dashscope",
      strategyClass: "chained-multimodal-transformation-derived-media",
    });
    expect(plan.describeTask).toEqual({
      kind: "describe-image",
      image: "img-c-001",
      question: materializeTransformationInput(CHAIN_TASK).instruction,
    });
    expect(plan.sourceDigest).toBe(materializeTransformationInput(CHAIN_TASK).sourceDigest);
  });

  test("the describe task materializes through the EXISTING multimodal materializer", () => {
    const plan = deriveTransformationChainPlan(CHAIN_TASK, ROUTE);
    expect(plan.describeTask).not.toBeNull();
    if (plan.describeTask !== null) {
      const media = materializeTaskMedia(plan.describeTask);
      expect(media.key).toBe("img-c-001");
      expect(media.modality).toBe("image");
      expect(media.annotation).toBe("bus");
    }
  });

  test("a foreign task derives the honest wrong-modality rejection plan", () => {
    const plan = deriveTransformationChainPlan(
      { kind: "transform-image", source: "img-c-001", edit: "img-edit-001" },
      ROUTE,
    );
    expect(plan.kind).toBe("wrong-modality");
    expect(plan.describeTask).toBeNull();
    expect(plan.stageRoutes).toEqual([
      { provider: "none", model: "none", strategyClass: "wrong-modality-rejection" },
    ]);
    expect(plan.rejectionReason).toContain("transform-image");
  });

  test("absent source or instruction fixtures throw (NOT RUN, before lifecycle)", () => {
    expect(() =>
      deriveTransformationChainPlan(
        { kind: "transform-multimodal", source: "img-c-999", instruction: "mm-instruction-001" },
        ROUTE,
      ),
    ).toThrow(TransformationFixtureNotMaterializedError);
    expect(() =>
      deriveTransformationChainPlan(
        { kind: "transform-multimodal", source: "img-c-001", instruction: "mm-instruction-999" },
        ROUTE,
      ),
    ).toThrow(TransformationFixtureNotMaterializedError);
  });
});

describe("VAL-018 derived-media derivation", () => {
  const description: StructuredDescription = {
    subject: "bus",
    colors: ["yellow", "gray"],
    background: "street",
    composition: "the bus is centered on the road",
  };

  test("the derived prompt is deterministic and grounded in the description fields", () => {
    const first = deriveDerivedMediaPrompt(description);
    const second = deriveDerivedMediaPrompt(description);
    expect(first).toBe(second);
    expect(first).toContain("bus");
    expect(first).toContain("yellow and gray");
    expect(first).toContain("street");
    expect(first).toContain("no watermark");
  });

  test("a successful rail outcome passes the mechanical criteria (container/dims/digest)", () => {
    const png = syntheticPng(64, 64);
    const prompt = deriveDerivedMediaPrompt(description);
    const criteria = deriveDerivedMediaVerification(
      { derivedPrompt: prompt, requestDigest: "abc123def456abc1", declaredSize: SIZE },
      { kind: "success", image: { bytes: png, mimeType: "image/png", width: 64, height: 64 } },
    );
    const byId = new Map(criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("raster-container")).toBe("PASS");
    expect(byId.get("dimensions-declared")).toBe("PASS");
    expect(byId.get("payload-nonempty")).toBe("PASS");
    expect(byId.get("digest-captured")).toBe("PASS");
  });

  test("a dimension-mismatched raster fails the dimensions criterion (request honored)", () => {
    const png = syntheticPng(32, 32);
    const criteria = deriveDerivedMediaVerification(
      {
        derivedPrompt: deriveDerivedMediaPrompt(description),
        requestDigest: "abc123def456abc1",
        declaredSize: SIZE,
      },
      { kind: "success", image: { bytes: png, mimeType: "image/png", width: 32, height: 32 } },
    );
    const byId = new Map(criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("raster-container")).toBe("PASS");
    expect(byId.get("dimensions-declared")).toBe("FAIL");
  });

  test("a provider failure FAILS the stage mechanically", () => {
    const criteria = deriveDerivedMediaVerification(
      {
        derivedPrompt: deriveDerivedMediaPrompt(description),
        requestDigest: "abc123def456abc1",
        declaredSize: SIZE,
      },
      { kind: "failure", category: "rate-limit", message: "429", retryable: true },
    );
    expect(criteria).toHaveLength(1);
    expect(criteria[0]?.criterionId).toBe("provider-dispatch");
    expect(criteria[0]?.status).toBe("FAIL");
    expect(criteria[0]?.evidence).toContain("requestDigest:abc123def456abc1");
  });
});

// ---------------------------------------------------------------------------
// The chained dispatch binding (full chain + aborts + discriminations)
// ---------------------------------------------------------------------------

describe("VAL-018 chain binding over controlled fakes", () => {
  test("the full chain succeeds with per-stage provenance and summed usage", async () => {
    const { binding, vision, rail } = buildChain({
      visionOutcome: async () => ({
        kind: "success",
        content: validVisionAnswer(),
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.0001 },
      }),
      railOutcome: async () => ({
        kind: "success",
        image: {
          bytes: syntheticPng(64, 64),
          mimeType: "image/png" as const,
          width: 64,
          height: 64,
        },
        usage: { inputTokens: 10, outputTokens: 1 },
      }),
    });
    const outcome = await binding({ executionId: "e1", task: CHAIN_TASK, oracle: ORACLE });
    expect(outcome.kind).toBe("success");
    expect(outcome.stages.map((s) => s.executed)).toEqual([true, true, true]);
    expect(outcome.abortedAtStage).toBeNull();
    expect(outcome.rejection).toBeNull();

    // Stage 1: the describe task rode the vision dispatch verbatim.
    expect(vision.calls).toHaveLength(1);
    expect(vision.calls[0]?.task).toEqual({
      kind: "describe-image",
      image: "img-c-001",
      question: materializeTransformationInput(CHAIN_TASK).instruction,
    });
    // Stage 3: the rail received the deterministic derived prompt.
    expect(rail.calls).toHaveLength(1);
    const descriptionResult = deriveStructuredDescription(validVisionAnswer());
    expect(descriptionResult.kind).toBe("valid");
    const expectedPrompt =
      descriptionResult.kind === "valid"
        ? deriveDerivedMediaPrompt(descriptionResult.description)
        : "";
    expect(rail.calls[0]?.prompt).toBe(expectedPrompt);

    // The chaining is visible: stage 2's request digest IS stage 1's
    // response digest (stage 2 consumes stage 1's output).
    expect(outcome.stages[1]?.requestDigest).toBe(outcome.stages[0]?.responseDigest);
    // Per-stage provenance: request/response digests everywhere.
    for (const stage of outcome.stages) {
      expect(stage.requestDigest).not.toBeNull();
      expect(stage.latencyMs).not.toBeNull();
    }
    expect(outcome.stages[0]?.responseDigest).not.toBeNull();
    expect(outcome.stages[1]?.responseDigest).not.toBeNull();
    expect(outcome.stages[2]?.responseDigest).not.toBeNull();
    // Summed usage across the two dispatch stages.
    expect(outcome.usage).toEqual({ inputTokens: 110, outputTokens: 21, costUsd: 0.0001 });
    // All stage criteria PASS.
    for (const stage of outcome.stages) {
      for (const criterion of stage.criteria) {
        expect(criterion.status).toBe("PASS");
      }
    }
    expect(outcome.derivedMedia).toMatchObject({ width: 64, height: 64, container: "png" });
  });

  test("chain-abort at stage 1 (vision failure): later stages never execute", async () => {
    const { binding, vision, rail, railCalls } = buildChain({
      visionOutcome: async () => ({
        kind: "failure",
        category: "invalid-request",
        message: "Failed to load image: cannot identify image file",
        retryable: false,
      }),
      railOutcome: async () => ({
        kind: "success",
        image: {
          bytes: syntheticPng(64, 64),
          mimeType: "image/png" as const,
          width: 64,
          height: 64,
        },
      }),
    });
    const outcome = await binding({ executionId: "e2", task: CHAIN_TASK, oracle: ORACLE });
    expect(outcome.kind).toBe("failure");
    expect(outcome.abortedAtStage).toBe("vision");
    expect(outcome.stages.map((s) => s.executed)).toEqual([true, false, false]);
    expect(outcome.stages[1]?.criteria).toEqual([]);
    expect(outcome.stages[2]?.criteria).toEqual([]);
    expect(vision.calls).toHaveLength(1);
    expect(rail.calls).toHaveLength(0); // the derived-media rail was NEVER reached
    expect(railCalls.count).toBe(0);
    expect(outcome.stages[0]?.failure?.category).toBe("invalid-request");
    expect(outcome.usage).toBeNull();
  });

  test("chain-abort at stage 2 (malformed structured description)", async () => {
    const { binding, rail, railCalls } = buildChain({
      // A fluent, oracle-carrying answer that is NOT schema JSON.
      visionOutcome: async () => ({
        kind: "success",
        content: "The image shows a yellow bus on a street.",
      }),
      railOutcome: async () => ({
        kind: "success",
        image: {
          bytes: syntheticPng(64, 64),
          mimeType: "image/png" as const,
          width: 64,
          height: 64,
        },
      }),
    });
    const outcome = await binding({ executionId: "e3", task: CHAIN_TASK, oracle: ORACLE });
    expect(outcome.kind).toBe("failure");
    expect(outcome.abortedAtStage).toBe("structured-description");
    expect(outcome.stages.map((s) => s.executed)).toEqual([true, true, false]);
    expect(outcome.stages[1]?.failure?.category).toBe("malformed-structured-description");
    expect(rail.calls).toHaveLength(0);
    expect(railCalls.count).toBe(0);
  });

  test("chain-abort at stage 3 (derived-media rail failure)", async () => {
    const { binding } = buildChain({
      visionOutcome: async () => ({ kind: "success", content: validVisionAnswer() }),
      railOutcome: async () => ({
        kind: "failure",
        category: "provider-unavailable",
        message: "upstream down",
        retryable: true,
      }),
    });
    const outcome = await binding({ executionId: "e4", task: CHAIN_TASK, oracle: ORACLE });
    expect(outcome.kind).toBe("failure");
    expect(outcome.abortedAtStage).toBe("derived-media");
    expect(outcome.stages.map((s) => s.executed)).toEqual([true, true, true]);
    expect(outcome.stages[2]?.failure?.category).toBe("provider-unavailable");
  });

  test("oracle provenance: an answer missing the oracle term fails stage 1 (no shortcut)", async () => {
    const { binding, rail } = buildChain({
      visionOutcome: async () => ({
        kind: "success" as const,
        content: validVisionAnswer("truck"),
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      railOutcome: async () => ({
        kind: "success",
        image: {
          bytes: syntheticPng(64, 64),
          mimeType: "image/png" as const,
          width: 64,
          height: 64,
        },
      }),
    });
    const outcome = await binding({ executionId: "e5", task: CHAIN_TASK, oracle: ORACLE });
    // Stage 1 executed and the provider succeeded, but the oracle term
    // "bus" is missing from the answer: the stage FAILS its criterion
    // and the chain aborts (mechanical verification before consumption).
    expect(outcome.kind).toBe("failure");
    expect(outcome.abortedAtStage).toBe("vision");
    const stage1 = outcome.stages[0];
    expect(stage1?.criteria.find((c) => c.criterionId === "contains:bus")?.status).toBe("FAIL");
    expect(rail.calls).toHaveLength(0);
  });

  test("oracle provenance: a valid description missing the term fails stage 2", async () => {
    const { binding, rail } = buildChain({
      visionOutcome: async () => ({
        // The RAW answer contains "bus" in surrounding prose (stage 1's
        // oracle passes)... but the JSON object itself carries no "bus"
        // (stage 2's chain-of-custody oracle fails).
        kind: "success" as const,
        content: `The image shows a bus as its main subject. ${validVisionAnswer("vehicle")}`,
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      railOutcome: async () => ({
        kind: "success",
        image: {
          bytes: syntheticPng(64, 64),
          mimeType: "image/png" as const,
          width: 64,
          height: 64,
        },
      }),
    });
    const outcome = await binding({ executionId: "e6", task: CHAIN_TASK, oracle: ORACLE });
    // ...but the STRUCTURED description does not (stage 2 fails the
    // chain-of-custody oracle; stage 3 is never reached).
    expect(outcome.kind).toBe("failure");
    expect(outcome.abortedAtStage).toBe("structured-description");
    expect(outcome.stages[1]?.criteria.find((c) => c.criterionId === "contains:bus")?.status).toBe(
      "FAIL",
    );
    expect(rail.calls).toHaveLength(0);
  });

  test("a wrong-modality task is rejected before ANY network effect", async () => {
    const { binding, vision, rail } = buildChain({
      visionOutcome: async () => ({ kind: "success", content: validVisionAnswer() }),
      railOutcome: async () => ({
        kind: "success",
        image: {
          bytes: syntheticPng(64, 64),
          mimeType: "image/png" as const,
          width: 64,
          height: 64,
        },
      }),
    });
    const outcome = await binding({
      executionId: "e7",
      task: { kind: "transform-image", source: "img-c-001", edit: "img-edit-001" },
    });
    expect(outcome.rejection).toMatchObject({ category: "wrong-modality" });
    expect(outcome.stages.every((s) => !s.executed)).toBe(true);
    expect(vision.calls).toHaveLength(0);
    expect(rail.calls).toHaveLength(0);
  });

  test("a tampered materialization is rejected before ANY network effect", async () => {
    const { binding, vision, rail } = buildChain({
      visionOutcome: async () => ({ kind: "success", content: validVisionAnswer() }),
      railOutcome: async () => ({
        kind: "success",
        image: {
          bytes: syntheticPng(64, 64),
          mimeType: "image/png" as const,
          width: 64,
          height: 64,
        },
      }),
      materialize: (task) => ({
        ...materializeTransformationInput(task),
        instruction: "a tampered instruction",
        instructionDigest: "deadbeefdeadbeef",
      }),
    });
    const outcome = await binding({ executionId: "e8", task: CHAIN_TASK, oracle: ORACLE });
    expect(outcome.rejection).toMatchObject({ category: "fixture-digest-mismatch" });
    expect(vision.calls).toHaveLength(0);
    expect(rail.calls).toHaveLength(0);
  });

  test("no imagegen rail (partial credential) fails stage 3 honestly (NOT RUN boundary)", async () => {
    const { binding, vision } = buildChain({
      visionOutcome: async () => ({
        kind: "success",
        content: validVisionAnswer(),
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      railOutcome: async () => ({
        kind: "success",
        image: {
          bytes: syntheticPng(64, 64),
          mimeType: "image/png" as const,
          width: 64,
          height: 64,
        },
      }),
      withRail: false,
    });
    const outcome = await binding({ executionId: "e9", task: CHAIN_TASK, oracle: ORACLE });
    expect(outcome.kind).toBe("failure");
    expect(outcome.abortedAtStage).toBe("derived-media");
    expect(outcome.stages[2]?.failure?.category).toBe("wrong-modality");
    expect(outcome.stages[2]?.failure?.message).toContain("no imagegen rail configured");
    // The vision stage DID run (measured usage recorded honestly).
    expect(outcome.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(vision.calls).toHaveLength(1);
  });

  test("stage-3 retry honesty: retryable retried exactly per policy; non-retryable never", async () => {
    const attempts: number[] = [];
    const sleeps: number[] = [];
    const { binding, rail } = buildChain({
      visionOutcome: async () => ({ kind: "success", content: validVisionAnswer() }),
      railOutcome: async () => {
        attempts.push(attempts.length + 1);
        if (attempts.length === 1) {
          return {
            kind: "failure" as const,
            category: "rate-limit",
            message: "429",
            retryable: true,
          };
        }
        return {
          kind: "success" as const,
          image: {
            bytes: syntheticPng(64, 64),
            mimeType: "image/png" as const,
            width: 64,
            height: 64,
          },
        };
      },
      retry: {
        attempts: 2,
        delayMs: 25,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    });
    const outcome = await binding({ executionId: "e10", task: CHAIN_TASK, oracle: ORACLE });
    expect(outcome.kind).toBe("success");
    expect(attempts).toEqual([1, 2]);
    expect(sleeps).toEqual([25]);
    expect(rail.calls).toHaveLength(2);

    // A NON-retryable stage-3 failure is attempted exactly once.
    const singleAttempts: number[] = [];
    const failing = buildChain({
      visionOutcome: async () => ({ kind: "success", content: validVisionAnswer() }),
      railOutcome: async () => {
        singleAttempts.push(singleAttempts.length + 1);
        return {
          kind: "failure" as const,
          category: "invalid-request",
          message: "bad size",
          retryable: false,
        };
      },
      retry: { attempts: 2, delayMs: 0, sleep: async () => {} },
    });
    const failedOutcome = await failing.binding({
      executionId: "e11",
      task: CHAIN_TASK,
      oracle: ORACLE,
    });
    expect(failedOutcome.abortedAtStage).toBe("derived-media");
    expect(singleAttempts).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// The chain execution driver
// ---------------------------------------------------------------------------

describe("VAL-018 chain execution driver", () => {
  test("records BOTH stage planning decisions BEFORE the dispatch, completes honestly", async () => {
    const { lifecycle, transitions } = recordingLifecycle();
    const dispatchTransitions: string[] = [];
    const result = await driveMultimodalTransformationExecution({
      executionId: "exec-1",
      task: CHAIN_TASK,
      route: ROUTE,
      oracle: ORACLE,
      ports: {
        lifecycle,
        dispatch: async () => {
          dispatchTransitions.push(...transitions);
          return {
            kind: "success",
            abortedAtStage: null,
            rejection: null,
            stages: [
              {
                stageId: "vision",
                executed: true,
                requestDigest: "a",
                responseDigest: "b",
                latencyMs: 5,
                usage: { inputTokens: 10, outputTokens: 2 },
                criteria: [
                  {
                    criterionId: "contains:bus",
                    strategy: "deterministic",
                    status: "PASS",
                    evidence: [],
                  },
                ],
                failure: null,
              },
              {
                stageId: "structured-description",
                executed: true,
                requestDigest: "b",
                responseDigest: "c",
                latencyMs: 0,
                usage: null,
                criteria: [
                  {
                    criterionId: "structured-description-valid",
                    strategy: "deterministic",
                    status: "PASS",
                    evidence: [],
                  },
                ],
                failure: null,
              },
              {
                stageId: "derived-media",
                executed: true,
                requestDigest: "d",
                responseDigest: "e",
                latencyMs: 7,
                usage: { inputTokens: 1, outputTokens: 1 },
                criteria: [
                  {
                    criterionId: "raster-container",
                    strategy: "deterministic",
                    status: "PASS",
                    evidence: [],
                  },
                ],
                failure: null,
              },
            ],
            usage: { inputTokens: 11, outputTokens: 3 },
            derivedMedia: {
              digest: "e",
              width: 64,
              height: 64,
              container: "png",
              requestDigest: "d",
            },
          };
        },
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(transitions).toEqual([
      "authorize",
      "plan",
      "planning-decision",
      "planning-decision",
      "queue",
      "start",
      "verify",
      "complete:pass",
    ]);
    // Both planning decisions (and the queue/start transitions) precede
    // the dispatch (intent before effect, per stage).
    expect(dispatchTransitions).toEqual([
      "authorize",
      "plan",
      "planning-decision",
      "planning-decision",
      "queue",
      "start",
    ]);
    expect(result.criteria.at(-1)?.criterionId).toBe("chain-integrity");
    expect(result.criteria.at(-1)?.status).toBe("PASS");
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 3 });
    expect(result.dispatchLatencyMs).toBe(0);
  });

  test("a stage failure completes as FAILED with the exact abort stage recorded", async () => {
    const { lifecycle, transitions } = recordingLifecycle();
    const result = await driveMultimodalTransformationExecution({
      executionId: "exec-2",
      task: { ...CHAIN_TASK, source: "img-corrupt" },
      route: ROUTE,
      ports: {
        lifecycle,
        dispatch: async () => ({
          kind: "failure",
          abortedAtStage: "vision",
          rejection: null,
          stages: [
            {
              stageId: "vision",
              executed: true,
              requestDigest: "a",
              responseDigest: null,
              latencyMs: 4,
              usage: null,
              criteria: [
                {
                  criterionId: "provider-dispatch",
                  strategy: "deterministic",
                  status: "FAIL",
                  evidence: ["provider-failure:invalid-request"],
                },
              ],
              failure: {
                category: "invalid-request",
                message: "Failed to load image: cannot identify image file",
                retryable: false,
              },
            },
            {
              stageId: "structured-description",
              executed: false,
              requestDigest: null,
              responseDigest: null,
              latencyMs: null,
              usage: null,
              criteria: [],
              failure: null,
            },
            {
              stageId: "derived-media",
              executed: false,
              requestDigest: null,
              responseDigest: null,
              latencyMs: null,
              usage: null,
              criteria: [],
              failure: null,
            },
          ],
          usage: null,
          derivedMedia: null,
        }),
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(transitions).toContain("complete:fail");
    const abort = result.criteria.find((c) => c.criterionId === "chain-aborted");
    expect(abort?.status).toBe("FAIL");
    expect(abort?.evidence).toContain("stage:vision");
    expect(abort?.evidence).toContain("category:invalid-request");
    expect(result.abortedAtStage).toBe("vision");
  });

  test("a wrong-modality task completes as FAILED (drivable, zero dispatches)", async () => {
    const { lifecycle } = recordingLifecycle();
    const result = await driveMultimodalTransformationExecution({
      executionId: "exec-3",
      task: { kind: "transform-image", source: "img-c-001", edit: "img-edit-001" },
      route: ROUTE,
      ports: {
        lifecycle,
        dispatch: async () => ({
          kind: "failure",
          abortedAtStage: null,
          rejection: {
            category: "wrong-modality",
            message:
              "task kind transform-image is outside the multimodal-transformation vocabulary",
          },
          stages: [
            {
              stageId: "vision",
              executed: false,
              requestDigest: null,
              responseDigest: null,
              latencyMs: null,
              usage: null,
              criteria: [],
              failure: null,
            },
            {
              stageId: "structured-description",
              executed: false,
              requestDigest: null,
              responseDigest: null,
              latencyMs: null,
              usage: null,
              criteria: [],
              failure: null,
            },
            {
              stageId: "derived-media",
              executed: false,
              requestDigest: null,
              responseDigest: null,
              latencyMs: null,
              usage: null,
              criteria: [],
              failure: null,
            },
          ],
          usage: null,
          derivedMedia: null,
        }),
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    const rejected = result.criteria.find((c) => c.criterionId === "chain-rejected");
    expect(rejected?.status).toBe("FAIL");
    expect(rejected?.evidence[0]).toBe("category:wrong-modality");
  });

  test("a missing fixture aborts BEFORE any lifecycle mutation (NOT RUN)", async () => {
    const { lifecycle, transitions } = recordingLifecycle();
    await expect(
      driveMultimodalTransformationExecution({
        executionId: "exec-4",
        task: {
          kind: "transform-multimodal",
          source: "img-c-999",
          instruction: "mm-instruction-001",
        },
        route: ROUTE,
        ports: {
          lifecycle,
          dispatch: async () => {
            throw new Error("never reached");
          },
          now: () => new Date(1_000_000),
        },
      }),
    ).rejects.toThrow(TransformationFixtureNotMaterializedError);
    expect(transitions).toEqual([]);
  });

  test("the pinned app rows all materialize (fixture table integrity)", () => {
    for (const task of MULTIMODAL_TRANSFORMATION_TASKS) {
      if (task.kind === "transform-multimodal") {
        const materialized = materializeTransformationInput(task);
        expect(materialized.sourceKey).toBe(task.source);
        expect(materialized.instructionKey).toBe(task.instruction);
        expect(materialized.instruction.length).toBeGreaterThan(0);
      }
    }
    expect(DERIVED_MEDIA_SIZE).toEqual({ width: 1328, height: 1328 });
  });
});
