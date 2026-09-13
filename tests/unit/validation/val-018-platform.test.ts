/**
 * VAL-018 platform unit tests: the chained-transformation derivations
 * (pure), the chained dispatch binding over the PROVEN rails with
 * controlled fake transports (no network), the 3D derivations (pure),
 * the 3D container sniffers, the 3D binding's honest
 * no-authorized-rail boundary, and both execution drivers.
 *
 * Honesty invariants under test:
 *   * a missing chained/3D fixture is a NOT RUN boundary (thrown
 *     BEFORE any lifecycle mutation);
 *   * the chain is REAL: stage 2's dispatched prompt genuinely binds
 *     the stage-1 structured description, with per-stage request
 *     digests and output digests captured;
 *   * a stage-1 provider failure or malformed intermediate ABORTS the
 *     chain — stage 2 is never dispatched (zero generation-rail
 *     calls);
 *   * a chain whose rails are not BOTH configured is rejected before
 *     ANY network effect;
 *   * vision answers are judged against the fixture's own oracle
 *     terms (no provider-success shortcut) and the derived raster by
 *     container validity, declared dimensions and digest capture;
 *   * the 3D binding with no configured rail is the honest
 *     no-authorized-3d-rail boundary failure carrying the surfaced
 *     access requirement (zero rail calls);
 *   * provably-invalid 3D specs (empty scene, corrupted JSON, unknown
 *     primitive) are rejected before any rail consultation;
 *   * valid synthetic glTF/OBJ/STL containers pass the container
 *     criteria; garbage and corrupted containers fail honestly.
 */

import { describe, expect, test, vi } from "vitest";
import { MULTIMODAL_TRANSFORMATION_TASKS } from "../../../benchmarks/validation/apps/multimodal-transformation/application";
import {
  chainedTransformationFixture,
  corruptGltf,
  createCanvas,
  imageFixture,
  mediaDigest,
  syntheticGltfBinary,
  syntheticObjText,
  syntheticStlBinary,
} from "../../../benchmarks/validation/apps/shared/media";
import { THREE_D_RENDERING_TASKS } from "../../../benchmarks/validation/apps/three-d-rendering/application";
import type { PlatformLifecyclePort } from "../../../benchmarks/validation/platform/driver";
import {
  createDashscopeImagegenRail,
  type HttpTransport,
  toImageDataUri,
} from "../../../benchmarks/validation/platform/imagegen";
import {
  createOpenRouterVisionRail,
  toDataUri,
} from "../../../benchmarks/validation/platform/multimodal";
import {
  buildDerivedMediaPrompt,
  buildDescriptionInstruction,
  ChainedTransformationFixtureNotMaterializedError,
  createChainedTransformDispatchBinding,
  deriveChainedTransformationPlan,
  deriveChainedTransformationVerification,
  driveChainedTransformExecution,
  materializeChainedTransformationInput,
  parseStructuredDescription,
  type TransformViaDescriptionTask,
} from "../../../benchmarks/validation/platform/multimodal-transform";
import {
  createThreeDDispatchBinding,
  deriveThreeDPlan,
  deriveThreeDVerification,
  driveThreeDExecution,
  materializeThreeDInput,
  parseThreeDSpec,
  THREE_D_ACCESS_REQUIREMENT,
  ThreeDFixtureNotMaterializedError,
  type ThreeDTask,
} from "../../../benchmarks/validation/platform/three-d";
import {
  sniffThreeDContainer,
  threeDBytesWithinBounds,
} from "../../../benchmarks/validation/platform/three-d-container";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fake transport scripted with one response (or a thrown error). */
function scriptedTransport(response: () => Promise<Response> | Response): {
  readonly transport: HttpTransport;
  readonly calls: { url: string; body: unknown }[];
} {
  const calls: { url: string; body: unknown }[] = [];
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body ?? "{}") as unknown });
    return await response();
  };
  return { transport, calls };
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

/** A deterministic synthetic "generated" raster (the fake rail image). */
function syntheticGeneratedPng(width: number, height: number): Buffer {
  const canvas = createCanvas(width, height);
  canvas.fillRect(0, 0, width, height, [240, 240, 240]);
  canvas.drawCircle(
    Math.floor(width / 2),
    Math.floor(height / 2),
    Math.floor(width / 3),
    [30, 120, 60],
  );
  return canvas.toPng();
}

/** A well-formed stage-1 structured description answer for a fixture. */
function structuredAnswer(mainObject: string): string {
  return JSON.stringify({
    main_object: mainObject,
    setting: "centered on a plain background",
    palette: "yellow, gray, black",
    style: "flat minimal vector",
  });
}

const CHAIN_TASK: TransformViaDescriptionTask = {
  kind: "describe-and-generate",
  chain: "chain-001",
};

/**
 * Build the full chained binding over the PROVEN rail constructors
 * with scripted fake transports: the vision transport answers a
 * structured description; the imagegen transport answers a synthetic
 * PNG data URI.
 */
function createChainedFakes(options?: {
  readonly visionContent?: string;
  readonly visionStatus?: number;
  readonly imagegenStatus?: number;
  readonly imagegenImage?: Buffer;
}) {
  const vision = scriptedTransport(() =>
    jsonResponse(options?.visionStatus ?? 200, {
      choices: [{ message: { content: options?.visionContent ?? structuredAnswer("bus") } }],
      usage: { prompt_tokens: 88, completion_tokens: 24, cost: 0.00008 },
    }),
  );
  const image = options?.imagegenImage ?? syntheticGeneratedPng(1328, 1328);
  const imagegen = scriptedTransport(() =>
    jsonResponse(options?.imagegenStatus ?? 200, {
      output: {
        choices: [{ message: { content: [{ image: toImageDataUri(image) }] } }],
      },
      usage: { input_tokens: 120, image_count: 1 },
    }),
  );
  return { vision, imagegen, image };
}

// ---------------------------------------------------------------------------
// Chained materialization + plan derivation (pure)
// ---------------------------------------------------------------------------

describe("VAL-018 chained materialization", () => {
  test("every pinned chain fixture materializes deterministically (same source bytes, same instruction)", () => {
    for (const task of MULTIMODAL_TRANSFORMATION_TASKS) {
      const first = materializeChainedTransformationInput(task);
      const second = materializeChainedTransformationInput(task);
      expect(first.sourceBytes.equals(second.sourceBytes)).toBe(true);
      expect(first.sourceDigest).toBe(second.sourceDigest);
      expect(first.descriptionInstruction).toBe(second.descriptionInstruction);
      expect(first.instructionDigest).toBe(second.instructionDigest);
      expect(first.sourceDigest).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  test("the corrupt-source edge row materializes genuinely corrupted source bytes", () => {
    const materialized = materializeChainedTransformationInput({
      kind: "describe-and-generate",
      chain: "chain-003",
    });
    expect(materialized.sourceKey).toBe("img-corrupt");
    expect(materialized.sourceDigest).toBe(mediaDigest(imageFixture("img-corrupt").png));
    expect(materialized.oracleTerms).toEqual([]);
  });

  test("an absent chain fixture key is a NOT RUN boundary (thrown, never empty)", () => {
    expect(() =>
      materializeChainedTransformationInput({ kind: "describe-and-generate", chain: "chain-999" }),
    ).toThrow(ChainedTransformationFixtureNotMaterializedError);
  });
});

describe("VAL-018 chained dispatch-plan derivation", () => {
  test("the plan carries both stage routes, the fixture digests and a stage-1 request digest", () => {
    const plan = deriveChainedTransformationPlan(CHAIN_TASK, {
      visionProvider: "openrouter",
      visionModel: "qwen/vl-test",
      imagegenProvider: "dashscope",
      imagegenModel: "qwen-image-test",
    });
    expect(plan.route).toEqual({
      provider: "openrouter",
      model: "qwen/vl-test",
      strategyClass: "chained-multimodal-transform",
    });
    expect(plan.visionRoute).toEqual({
      provider: "openrouter",
      model: "qwen/vl-test",
      strategyClass: "single-shot-multimodal",
    });
    expect(plan.imagegenRoute).toEqual({
      provider: "dashscope",
      model: "qwen-image-test",
      strategyClass: "single-shot-imagegen",
    });
    expect(plan.fixtureKey).toBe("chain-001");
    expect(plan.sourceKey).toBe("img-c-001");
    expect(plan.sourceDigest).toBe(mediaDigest(imageFixture("img-c-001").png));
    expect(plan.stage1RequestDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(plan.size).toEqual({ width: 1328, height: 1328 });
  });

  test("the same task always derives the same stage-1 request digest (request-level reproducibility)", () => {
    const options = {
      visionProvider: "openrouter",
      visionModel: "qwen/vl-test",
      imagegenProvider: "dashscope",
      imagegenModel: "qwen-image-test",
    };
    const first = deriveChainedTransformationPlan(CHAIN_TASK, options);
    const second = deriveChainedTransformationPlan(CHAIN_TASK, options);
    expect(first.stage1RequestDigest).toBe(second.stage1RequestDigest);
  });

  test("a missing chain fixture aborts the plan derivation (NOT RUN, before lifecycle)", () => {
    expect(() =>
      deriveChainedTransformationPlan(
        { kind: "describe-and-generate", chain: "chain-999" },
        {
          visionProvider: "p",
          visionModel: "m",
          imagegenProvider: "p",
          imagegenModel: "m",
        },
      ),
    ).toThrow(ChainedTransformationFixtureNotMaterializedError);
  });
});

// ---------------------------------------------------------------------------
// The structured-description contract (pure)
// ---------------------------------------------------------------------------

describe("VAL-018 structured-description parsing", () => {
  test("a well-formed answer parses with the fixture's vocabulary", () => {
    const parsed = parseStructuredDescription({
      content: structuredAnswer("bus"),
      labels: ["bicycle", "bus", "car"],
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.description.mainObject).toBe("bus");
      expect(JSON.parse(parsed.description.raw)).toMatchObject({ main_object: "bus" });
    }
  });

  test("prose-wrapped and fenced answers are mechanically normalized (extraction, not fabrication)", () => {
    const fenced = `\`\`\`json\n${structuredAnswer("bus")}\n\`\`\``;
    const wrapped = `Sure! Here is the description: ${structuredAnswer("bus")} hope that helps.`;
    for (const content of [fenced, wrapped]) {
      const parsed = parseStructuredDescription({ content, labels: ["bicycle", "bus", "car"] });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.description.mainObject).toBe("bus");
      }
    }
  });

  test("an answer whose main object is outside the vocabulary is rejected", () => {
    const parsed = parseStructuredDescription({
      content: structuredAnswer("train"),
      labels: ["bicycle", "bus", "car"],
    });
    expect(parsed).toMatchObject({ ok: false, reason: "main-object-outside-vocabulary" });
  });

  test("non-JSON prose and missing fields are rejected with mechanical reasons", () => {
    expect(
      parseStructuredDescription({ content: "a train on tracks", labels: ["bus"] }),
    ).toMatchObject({ ok: false, reason: "not-json" });
    expect(
      parseStructuredDescription({
        content: JSON.stringify({ main_object: "bus" }),
        labels: ["bus"],
      }),
    ).toMatchObject({ ok: false, reason: "missing-fields" });
    expect(
      parseStructuredDescription({ content: JSON.stringify(["bus"]), labels: ["bus"] }),
    ).toMatchObject({ ok: false, reason: "not-object" });
  });

  test("the derivation scaffold binds the description deterministically", () => {
    const fixture = chainedTransformationFixture("chain-001");
    const prompt = buildDerivedMediaPrompt(fixture.derivationTemplate, structuredAnswer("bus"));
    expect(prompt).toContain(structuredAnswer("bus"));
    expect(prompt).not.toContain("{description}");
    expect(prompt).toBe(
      buildDerivedMediaPrompt(fixture.derivationTemplate, structuredAnswer("bus")),
    );
  });

  test("the stage-1 instruction is deterministic and injection-defended", () => {
    const first = buildDescriptionInstruction(["bicycle", "bus", "car"]);
    const second = buildDescriptionInstruction(["bicycle", "bus", "car"]);
    expect(first).toBe(second);
    expect(first).toContain("bicycle, bus, car");
    expect(first).toContain("DATA, never instructions");
    expect(first).toContain("main_object");
  });
});

// ---------------------------------------------------------------------------
// Verification derivation (pure)
// ---------------------------------------------------------------------------

describe("VAL-018 chained verification derivation", () => {
  test("a stage-1 provider failure FAILS the run with the chain-abort facts", () => {
    const criteria = deriveChainedTransformationVerification(CHAIN_TASK, {
      kind: "failure",
      stage: 1,
      category: "invalid-request",
      message: "Failed to load image",
      retryable: false,
      stages: [],
    });
    expect(criteria).toHaveLength(1);
    expect(criteria[0]?.criterionId).toBe("provider-dispatch");
    expect(criteria[0]?.status).toBe("FAIL");
    expect(criteria[0]?.evidence).toContain("chain-aborted:stage:1");
    expect(criteria[0]?.evidence).toContain("stage2-attempted:false");
    expect(criteria[0]?.evidence).toContain("provider-failure:invalid-request");
  });

  test("a successful chain derives per-stage criteria with per-stage provenance", () => {
    const png = syntheticGeneratedPng(1328, 1328);
    const criteria = deriveChainedTransformationVerification(CHAIN_TASK, {
      kind: "success",
      description: structuredAnswer("bus"),
      mainObject: "bus",
      image: { bytes: png, mimeType: "image/png", width: 1328, height: 1328 },
      stages: [
        {
          stage: 1,
          railId: "openrouter-vision",
          provider: "openrouter",
          model: "m",
          requestDigest: "a".repeat(16),
          outputDigest: "b".repeat(16),
          latencyMs: 500,
          usage: { inputTokens: 88, outputTokens: 24 },
        },
        {
          stage: 2,
          railId: "dashscope-imagegen-text-to-image",
          provider: "dashscope",
          model: "m",
          requestDigest: "c".repeat(16),
          outputDigest: "d".repeat(16),
          latencyMs: 9000,
          usage: { inputTokens: 120, outputTokens: 1 },
        },
      ],
    });
    expect(criteria.map((c) => `${c.criterionId}:${c.status}`)).toEqual([
      "stage1:contains:bus:PASS",
      "stage1:structured-description:PASS",
      "stage1:content-present:PASS",
      "stage2:raster-container:PASS",
      "stage2:dimensions-declared:PASS",
      "stage2:payload-nonempty:PASS",
      "stage2:digest-captured:PASS",
    ]);
    const evidence = criteria.flatMap((c) => c.evidence).join(" ");
    expect(evidence).toContain(`sourceDigest:${mediaDigest(imageFixture("img-c-001").png)}`);
    expect(evidence).toContain(`digest:${mediaDigest(png)}`);
    expect(evidence).toContain("requestDigest:aaaaaaaaaaaaaaaa");
    expect(evidence).toContain("stage:1");
    expect(evidence).toContain("stage:2");
    expect(evidence).not.toContain("base64");
  });

  test("an oracle miss (vision answer contradicts the fixture ground truth) fails its criterion", () => {
    const png = syntheticGeneratedPng(1328, 1328);
    const criteria = deriveChainedTransformationVerification(CHAIN_TASK, {
      kind: "success",
      description: structuredAnswer("train"),
      mainObject: "train",
      image: { bytes: png, mimeType: "image/png", width: 1328, height: 1328 },
      stages: [],
    });
    const byId = new Map(criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("stage1:contains:bus")).toBe("FAIL");
    expect(byId.get("stage1:structured-description")).toBe("FAIL");
  });

  test("a malformed derived raster fails the stage-2 container and dimensions criteria", () => {
    const garbage = Buffer.alloc(256, 0xa5);
    const criteria = deriveChainedTransformationVerification(CHAIN_TASK, {
      kind: "success",
      description: structuredAnswer("bus"),
      mainObject: "bus",
      image: { bytes: garbage, mimeType: "image/unknown", width: null, height: null },
      stages: [],
    });
    const byId = new Map(criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("stage2:raster-container")).toBe("FAIL");
    expect(byId.get("stage2:dimensions-declared")).toBe("FAIL");
    expect(byId.get("stage2:payload-nonempty")).toBe("PASS");
  });

  test("a raster at the wrong declared size fails the dimensions criterion (the request must be honored)", () => {
    const png = syntheticGeneratedPng(256, 128);
    const criteria = deriveChainedTransformationVerification(CHAIN_TASK, {
      kind: "success",
      description: structuredAnswer("bus"),
      mainObject: "bus",
      image: { bytes: png, mimeType: "image/png", width: 256, height: 128 },
      stages: [],
    });
    expect(criteria.find((c) => c.criterionId === "stage2:dimensions-declared")?.status).toBe(
      "FAIL",
    );
  });
});

// ---------------------------------------------------------------------------
// The chained binding over the PROVEN rails (fake transports, no network)
// ---------------------------------------------------------------------------

describe("VAL-018 chained dispatch binding (proven rails, fake transports)", () => {
  test("the chain is REAL: stage 2's dispatched prompt binds the stage-1 structured description", async () => {
    const { vision, imagegen } = createChainedFakes();
    const binding = createChainedTransformDispatchBinding({
      vision: createOpenRouterVisionRail({ transport: vision.transport, apiKey: "k" }),
      generation: createDashscopeImagegenRail({
        transport: imagegen.transport,
        apiKey: "k",
        mode: "text-to-image",
      }),
      transportCalls: { count: 0 },
    });
    const outcome = await binding({
      executionId: "e1",
      task: CHAIN_TASK,
      visionProvider: "openrouter",
      visionModel: "qwen/vl",
      imagegenProvider: "dashscope",
      imagegenModel: "qwen-image",
    });
    expect(outcome.kind).toBe("success");
    if (outcome.kind !== "success") {
      return;
    }
    expect(outcome.mainObject).toBe("bus");
    expect(outcome.image.bytes.length).toBeGreaterThan(0);
    // Stage 1 dispatched the synthetic source image as a PNG data URI.
    const visionBody = vision.calls[0]?.body as {
      messages: { content: { type: string; image_url?: { url: string } }[] }[];
    };
    expect(visionBody.messages[0]?.content[1]).toMatchObject({ type: "image_url" });
    expect(visionBody.messages[0]?.content[1]?.image_url?.url).toBe(
      toDataUri(imageFixture("img-c-001").png, "image/png"),
    );
    // Stage 2 dispatched the scaffold bound to the extracted description.
    const imagegenBody = imagegen.calls[0]?.body as {
      input: { messages: { role: string; content: { text: string }[] }[] };
      parameters: { size: string; n: number };
    };
    // 2026-09-12 shape re-pin: the derived prompt rides the messages text part.
    const derivedPrompt = imagegenBody.input.messages[0]?.content[0]?.text ?? "";
    expect(derivedPrompt).toContain(structuredAnswer("bus"));
    expect(derivedPrompt).not.toContain("{description}");
    expect(imagegenBody.parameters.size).toBe("1328*1328");
    // Per-stage facts captured (measured usage, request + output digests).
    expect(outcome.stages).toHaveLength(2);
    const [stage1, stage2] = outcome.stages as [
      (typeof outcome.stages)[0],
      (typeof outcome.stages)[0],
    ];
    expect(stage1.usage?.inputTokens).toBe(88);
    expect(stage1.usage?.costUsd).toBe(0.00008);
    expect(stage1.outputDigest).toBe(mediaDigest(Buffer.from(structuredAnswer("bus"), "utf8")));
    expect(stage2.usage?.inputTokens).toBe(120);
    expect(stage2.outputDigest).toBe(mediaDigest(outcome.image.bytes));
    expect(stage1.requestDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(stage2.requestDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  test("the same stage-1 answer always derives the same stage-2 request digest", async () => {
    const digestOf = async (): Promise<string> => {
      const { vision, imagegen } = createChainedFakes();
      const binding = createChainedTransformDispatchBinding({
        vision: createOpenRouterVisionRail({ transport: vision.transport, apiKey: "k" }),
        generation: createDashscopeImagegenRail({
          transport: imagegen.transport,
          apiKey: "k",
          mode: "text-to-image",
        }),
        transportCalls: { count: 0 },
      });
      const outcome = await binding({
        executionId: "e",
        task: CHAIN_TASK,
        visionProvider: "p",
        visionModel: "m",
        imagegenProvider: "p",
        imagegenModel: "m",
      });
      if (outcome.kind !== "success") {
        throw new Error("expected success");
      }
      return outcome.stages[1]?.requestDigest ?? "";
    };
    expect(await digestOf()).toBe(await digestOf());
  });

  test("a stage-1 provider failure aborts the chain (the generation rail is never called)", async () => {
    const { vision, imagegen } = createChainedFakes({
      visionStatus: 400,
      visionContent: "",
    });
    const binding = createChainedTransformDispatchBinding({
      vision: createOpenRouterVisionRail({ transport: vision.transport, apiKey: "k" }),
      generation: createDashscopeImagegenRail({
        transport: imagegen.transport,
        apiKey: "k",
        mode: "text-to-image",
      }),
      transportCalls: { count: 0 },
    });
    const outcome = await binding({
      executionId: "e",
      task: CHAIN_TASK,
      visionProvider: "p",
      visionModel: "m",
      imagegenProvider: "p",
      imagegenModel: "m",
    });
    expect(outcome).toMatchObject({
      kind: "failure",
      stage: 1,
      category: "invalid-request",
    });
    expect(vision.calls).toHaveLength(1);
    expect(imagegen.calls).toHaveLength(0);
  });

  test("a malformed stage-1 intermediate aborts the chain before any paid stage-2 dispatch", async () => {
    const { vision, imagegen } = createChainedFakes({
      visionContent: "The image shows a wonderful scene with many details.",
    });
    const binding = createChainedTransformDispatchBinding({
      vision: createOpenRouterVisionRail({ transport: vision.transport, apiKey: "k" }),
      generation: createDashscopeImagegenRail({
        transport: imagegen.transport,
        apiKey: "k",
        mode: "text-to-image",
      }),
      transportCalls: { count: 0 },
    });
    const outcome = await binding({
      executionId: "e",
      task: CHAIN_TASK,
      visionProvider: "p",
      visionModel: "m",
      imagegenProvider: "p",
      imagegenModel: "m",
    });
    expect(outcome).toMatchObject({
      kind: "failure",
      stage: 1,
      category: "malformed-intermediate",
    });
    if (outcome.kind === "failure") {
      expect(outcome.message).toContain("not-json");
      expect(outcome.message).toContain("stage 2 was never dispatched");
    }
    expect(imagegen.calls).toHaveLength(0);
  });

  test("a stage-2 provider failure fails the chain with the stage-2 facts recorded", async () => {
    const { vision, imagegen } = createChainedFakes({ imagegenStatus: 429 });
    const binding = createChainedTransformDispatchBinding({
      vision: createOpenRouterVisionRail({ transport: vision.transport, apiKey: "k" }),
      generation: createDashscopeImagegenRail({
        transport: imagegen.transport,
        apiKey: "k",
        mode: "text-to-image",
      }),
      transportCalls: { count: 0 },
    });
    const outcome = await binding({
      executionId: "e",
      task: CHAIN_TASK,
      visionProvider: "p",
      visionModel: "m",
      imagegenProvider: "p",
      imagegenModel: "m",
    });
    expect(outcome).toMatchObject({ kind: "failure", stage: 2, category: "rate-limit" });
    if (outcome.kind === "failure") {
      expect(outcome.stages).toHaveLength(2);
      expect(outcome.stages[0]?.outputDigest).not.toBeNull();
      expect(outcome.stages[1]?.outputDigest).toBeNull();
    }
  });

  test("a chain without BOTH configured rails is rejected before ANY network effect", async () => {
    const { vision, imagegen } = createChainedFakes();
    const visionRail = createOpenRouterVisionRail({ transport: vision.transport, apiKey: "k" });
    // Vision only: rejected before any network effect.
    const visionOnly = createChainedTransformDispatchBinding({
      vision: visionRail,
      transportCalls: { count: 0 },
    });
    const visionOutcome = await visionOnly({
      executionId: "e1",
      task: CHAIN_TASK,
      visionProvider: "p",
      visionModel: "m",
      imagegenProvider: "p",
      imagegenModel: "m",
    });
    // The vision rail IS configured; the missing rail is the
    // generation rail (stage 2).
    expect(visionOutcome).toMatchObject({
      kind: "failure",
      stage: 2,
      category: "wrong-modality",
    });
    expect(vision.calls).toHaveLength(0);
    // Generation only: rejected before any network effect (the stage-1
    // dispatch is never spent on a chain that cannot run stage 2).
    const generationOnly = createChainedTransformDispatchBinding({
      generation: createDashscopeImagegenRail({
        transport: imagegen.transport,
        apiKey: "k",
        mode: "text-to-image",
      }),
      transportCalls: { count: 0 },
    });
    const generationOutcome = await generationOnly({
      executionId: "e2",
      task: CHAIN_TASK,
      visionProvider: "p",
      visionModel: "m",
      imagegenProvider: "p",
      imagegenModel: "m",
    });
    // The generation rail IS configured; the missing rail is the
    // vision rail (stage 1).
    expect(generationOutcome).toMatchObject({
      kind: "failure",
      stage: 1,
      category: "wrong-modality",
    });
    expect(vision.calls).toHaveLength(0);
    expect(imagegen.calls).toHaveLength(0);
  });

  test("a tampered materialization (digest mismatch) is rejected before any dispatch", async () => {
    const dispatch = vi.fn();
    const vision = { railId: "v", modality: "image" as const, dispatch };
    const generation = {
      railId: "g",
      mode: "text-to-image" as const,
      dispatch: async () => ({
        kind: "success" as const,
        image: {
          bytes: syntheticGeneratedPng(64, 64),
          mimeType: "image/png" as const,
          width: 64,
          height: 64,
        },
      }),
    };
    const binding = createChainedTransformDispatchBinding({
      vision,
      generation,
      materialize: (task) => ({
        ...materializeChainedTransformationInput(task),
        sourceBytes: Buffer.alloc(8, 0x00),
        sourceDigest: "0000000000000000",
      }),
      transportCalls: { count: 0 },
    });
    const outcome = await binding({
      executionId: "e",
      task: CHAIN_TASK,
      visionProvider: "p",
      visionModel: "m",
      imagegenProvider: "p",
      imagegenModel: "m",
    });
    expect(outcome).toMatchObject({
      kind: "failure",
      stage: 1,
      category: "fixture-digest-mismatch",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("the bounded retry policy retries RETRYABLE stage failures only, with REAL attempts", async () => {
    const visionAttempts: number[] = [];
    const sleeps: number[] = [];
    const vision = {
      railId: "v",
      modality: "image" as const,
      dispatch: async () => {
        visionAttempts.push(visionAttempts.length + 1);
        if (visionAttempts.length === 1) {
          return {
            kind: "failure" as const,
            category: "rate-limit",
            message: "429",
            retryable: true,
          };
        }
        return { kind: "success" as const, content: structuredAnswer("bus") };
      },
    };
    const generation = {
      railId: "g",
      mode: "text-to-image" as const,
      dispatch: async () => {
        return {
          kind: "failure" as const,
          category: "invalid-request",
          message: "bad request",
          retryable: false,
        };
      },
    };
    const binding = createChainedTransformDispatchBinding({
      vision,
      generation,
      transportCalls: { count: 0 },
      retry: {
        attempts: 2,
        delayMs: 50,
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
      },
    });
    const outcome = await binding({
      executionId: "e",
      task: CHAIN_TASK,
      visionProvider: "p",
      visionModel: "m",
      imagegenProvider: "p",
      imagegenModel: "m",
    });
    // Stage 1 retried once after the retryable rate limit, then
    // succeeded; stage 2's failure was NON-retryable (one attempt).
    expect(visionAttempts).toEqual([1, 2]);
    expect(sleeps).toEqual([50]);
    expect(outcome).toMatchObject({ kind: "failure", stage: 2, category: "invalid-request" });
  });

  test("per-stage latencies are measured (retry waits included)", async () => {
    let clock = 1_000_000;
    const vision = {
      railId: "v",
      modality: "image" as const,
      dispatch: async () => {
        clock += 400;
        return { kind: "success" as const, content: structuredAnswer("bus") };
      },
    };
    const generation = {
      railId: "g",
      mode: "text-to-image" as const,
      dispatch: async () => {
        clock += 5_000;
        return {
          kind: "success" as const,
          image: {
            bytes: syntheticGeneratedPng(64, 64),
            mimeType: "image/png" as const,
            width: 64,
            height: 64,
          },
        };
      },
    };
    const binding = createChainedTransformDispatchBinding({
      vision,
      generation,
      transportCalls: { count: 0 },
      now: () => new Date(clock),
    });
    const outcome = await binding({
      executionId: "e",
      task: CHAIN_TASK,
      visionProvider: "p",
      visionModel: "m",
      imagegenProvider: "p",
      imagegenModel: "m",
    });
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.stages[0]?.latencyMs).toBe(400);
      expect(outcome.stages[1]?.latencyMs).toBe(5_000);
    }
  });
});

// ---------------------------------------------------------------------------
// The chained driver (lifecycle order + honest terminals)
// ---------------------------------------------------------------------------

describe("VAL-018 chained execution driver", () => {
  test("drives the canonical lifecycle with the planning decision before dispatch", async () => {
    const { lifecycle, transitions } = recordingLifecycle();
    const dispatchTransitions: string[] = [];
    const result = await driveChainedTransformExecution({
      executionId: "exec-1",
      task: CHAIN_TASK,
      visionProvider: "openrouter",
      visionModel: "m",
      imagegenProvider: "dashscope",
      imagegenModel: "m2",
      ports: {
        lifecycle,
        dispatch: async () => {
          dispatchTransitions.push(...transitions);
          return {
            kind: "success",
            description: structuredAnswer("bus"),
            mainObject: "bus",
            image: {
              bytes: syntheticGeneratedPng(1328, 1328),
              mimeType: "image/png",
              width: 1328,
              height: 1328,
            },
            stages: [
              {
                stage: 1,
                railId: "v",
                provider: "openrouter",
                model: "m",
                requestDigest: "a".repeat(16),
                outputDigest: "b".repeat(16),
                latencyMs: 300,
                usage: { inputTokens: 88, outputTokens: 24 },
              },
              {
                stage: 2,
                railId: "g",
                provider: "dashscope",
                model: "m2",
                requestDigest: "c".repeat(16),
                outputDigest: "d".repeat(16),
                latencyMs: 4_000,
                usage: { inputTokens: 120, outputTokens: 1 },
              },
            ],
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
      "queue",
      "start",
      "verify",
      "complete:pass",
    ]);
    expect(dispatchTransitions).toContain("planning-decision");
    expect(dispatchTransitions).not.toContain("verify");
    expect(result.criteria.every((c) => c.status === "PASS")).toBe(true);
    expect(result.dispatchLatencyMs).toBe(0);
    expect(result.stages).toHaveLength(2);
    expect(result.descriptionDigest).toBe(
      mediaDigest(Buffer.from(structuredAnswer("bus"), "utf8")),
    );
    expect(result.imageDigest).not.toBeNull();
    expect(result.imageDimensions).toEqual({ width: 1328, height: 1328 });
  });

  test("a stage-1 provider failure completes as FAILED (never COMPLETED)", async () => {
    const { lifecycle, transitions } = recordingLifecycle();
    const result = await driveChainedTransformExecution({
      executionId: "exec-2",
      task: { kind: "describe-and-generate", chain: "chain-003" },
      visionProvider: "openrouter",
      visionModel: "m",
      imagegenProvider: "dashscope",
      imagegenModel: "m2",
      ports: {
        lifecycle,
        dispatch: async () => ({
          kind: "failure",
          stage: 1,
          category: "invalid-request",
          message: "Failed to load image: cannot identify image file",
          retryable: false,
          stages: [],
        }),
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(transitions).toContain("complete:fail");
    expect(result.imageDigest).toBeNull();
    expect(result.criteria).toHaveLength(1);
    expect(result.criteria[0]?.status).toBe("FAIL");
  });

  test("a missing fixture aborts BEFORE any lifecycle mutation (NOT RUN)", async () => {
    const { lifecycle, transitions } = recordingLifecycle();
    await expect(
      driveChainedTransformExecution({
        executionId: "exec-3",
        task: { kind: "describe-and-generate", chain: "chain-999" },
        visionProvider: "p",
        visionModel: "m",
        imagegenProvider: "p",
        imagegenModel: "m",
        ports: {
          lifecycle,
          dispatch: async () => ({
            kind: "success",
            description: "x",
            mainObject: "bus",
            image: { bytes: Buffer.from([]), mimeType: "image/png", width: 1, height: 1 },
            stages: [],
          }),
          now: () => new Date(1_000_000),
        },
      }),
    ).rejects.toThrow(ChainedTransformationFixtureNotMaterializedError);
    expect(transitions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The 3D slice: materialization, spec parsing, plan, containers
// ---------------------------------------------------------------------------

describe("VAL-018 3D materialization and spec validation", () => {
  test("every pinned 3D fixture materializes deterministically (same spec, same digest)", () => {
    for (const task of THREE_D_RENDERING_TASKS) {
      const first = materializeThreeDInput(task);
      const second = materializeThreeDInput(task);
      expect(first.spec).toBe(second.spec);
      expect(first.specDigest).toBe(second.specDigest);
      expect(first.specDigest).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  test("the healthy specs parse with the fixtures' own ground truth; the edge specs are rejected mechanically", () => {
    const healthy = parseThreeDSpec({
      kind: "render-3d",
      spec: materializeThreeDInput(THREE_D_RENDERING_TASKS[0] as ThreeDTask).spec,
    });
    expect(healthy).toMatchObject({ ok: true, parsed: { objectCount: 1 } });
    const mesh = parseThreeDSpec({
      kind: "mesh-from-spec",
      spec: materializeThreeDInput({ kind: "mesh-from-spec", spec: "mesh-001" }).spec,
    });
    expect(mesh).toMatchObject({ ok: true, parsed: { primitive: "box" } });
    expect(
      parseThreeDSpec({
        kind: "render-3d",
        spec: materializeThreeDInput({ kind: "render-3d", scene: "scene3d-empty" }).spec,
      }),
    ).toMatchObject({ ok: false, reason: "empty-scene" });
    expect(
      parseThreeDSpec({
        kind: "render-3d",
        spec: materializeThreeDInput({ kind: "render-3d", scene: "scene3d-corrupt" }).spec,
      }),
    ).toMatchObject({ ok: false, reason: "not-json" });
    expect(
      parseThreeDSpec({
        kind: "mesh-from-spec",
        spec: materializeThreeDInput({ kind: "mesh-from-spec", spec: "mesh-008" }).spec,
      }),
    ).toMatchObject({ ok: false, reason: "unknown-primitive" });
    expect(
      parseThreeDSpec({
        kind: "mesh-from-spec",
        spec: '{"primitive":"box","dimensions":[-1,2,3],"resolution":8}',
      }),
    ).toMatchObject({ ok: false, reason: "invalid-spec-field" });
    expect(
      parseThreeDSpec({ kind: "mesh-from-spec", spec: '{"primitive":"box","dimensions":[2,3,4]}' }),
    ).toMatchObject({ ok: false, reason: "invalid-spec-field" });
  });

  test("an absent 3D fixture key is a NOT RUN boundary (thrown, never empty)", () => {
    expect(() => materializeThreeDInput({ kind: "render-3d", scene: "scene3d-999" })).toThrow(
      ThreeDFixtureNotMaterializedError,
    );
    expect(() => materializeThreeDInput({ kind: "mesh-from-spec", spec: "mesh-999" })).toThrow(
      ThreeDFixtureNotMaterializedError,
    );
  });
});

describe("VAL-018 3D dispatch-plan derivation", () => {
  test("the plan carries the route facts, the spec digest and a deterministic request digest", () => {
    const options = { provider: "future-3d", model: "authorized-later" };
    const first = deriveThreeDPlan(THREE_D_RENDERING_TASKS[0] as ThreeDTask, options);
    const second = deriveThreeDPlan(THREE_D_RENDERING_TASKS[0] as ThreeDTask, options);
    expect(first.route).toEqual({
      provider: "future-3d",
      model: "authorized-later",
      strategyClass: "single-shot-three-d",
    });
    expect(first.specKey).toBe("scene3d-001");
    expect(first.prompt).toContain('"primitive":"box"');
    expect(first.requestDigest).toBe(second.requestDigest);
    expect(first.requestDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  test("camera and frames ride the plan and the canonical request body", () => {
    const plan = deriveThreeDPlan(
      { kind: "render-3d", scene: "scene3d-001", camera: "top", frames: 24 },
      { provider: "p", model: "m" },
    );
    expect(plan.camera).toBe("top");
    expect(plan.frames).toBe(24);
    expect(plan.requestDigest).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("VAL-018 3D container sniffing (pure)", () => {
  test("valid synthetic glTF/OBJ/STL containers sniff correctly (magic bytes, never extensions)", () => {
    const glb = syntheticGltfBinary();
    expect(sniffThreeDContainer(glb)).toMatchObject({ container: "gltf-binary" });
    const obj = syntheticObjText();
    const objFacts = sniffThreeDContainer(obj);
    expect(objFacts.container).toBe("obj");
    expect(objFacts.detail).toContain("vertices:8");
    expect(objFacts.detail).toContain("faces:6");
    const stl = syntheticStlBinary(12);
    expect(sniffThreeDContainer(stl)).toMatchObject({ container: "stl" });
    expect(sniffThreeDContainer(stl).detail).toBe("triangles:12");
    expect(threeDBytesWithinBounds(glb.length)).toBe(true);
    expect(threeDBytesWithinBounds(stl.length)).toBe(true);
  });

  test("garbage, corrupted glTF and wrong-format payloads sniff as unknown (honest failures)", () => {
    expect(sniffThreeDContainer(Buffer.alloc(256, 0xa5)).container).toBe("unknown");
    expect(sniffThreeDContainer(corruptGltf()).container).toBe("unknown");
    // A PNG is a valid raster but NOT a 3D container.
    expect(sniffThreeDContainer(imageFixture("img-c-001").png).container).toBe("unknown");
    // An OBJ-shaped text without faces is not a mesh container.
    expect(sniffThreeDContainer(Buffer.from("# only a comment\nv 0 0 0\n", "utf8")).container).toBe(
      "unknown",
    );
  });
});

describe("VAL-018 3D verification derivation", () => {
  test("a rail failure FAILS the run mechanically; the no-rail boundary carries the access-gap evidence", () => {
    const criteria = deriveThreeDVerification(THREE_D_RENDERING_TASKS[0] as ThreeDTask, {
      kind: "failure",
      category: "no-authorized-3d-rail",
      message: "no operator-authorized 3D-generation provider rail exists",
      retryable: false,
      accessRequirement: THREE_D_ACCESS_REQUIREMENT,
    });
    expect(criteria).toHaveLength(1);
    expect(criteria[0]?.status).toBe("FAIL");
    const evidence = criteria[0]?.evidence.join(" ") ?? "";
    expect(evidence).toContain("provider-failure:no-authorized-3d-rail");
    expect(evidence).toContain("access-gap:model:three-d");
    expect(evidence).toContain("access-gap-credential-env-var:ZECK_3D_API_KEY");
  });

  test("a valid synthetic artifact passes the container/bounds/digest criteria", () => {
    const criteria = deriveThreeDVerification(THREE_D_RENDERING_TASKS[0] as ThreeDTask, {
      kind: "success",
      artifact: { bytes: syntheticGltfBinary(), format: "glb" },
    });
    expect(criteria.map((c) => `${c.criterionId}:${c.status}`)).toEqual([
      "container-valid:PASS",
      "byte-bounds:PASS",
      "payload-nonempty:PASS",
      "digest-captured:PASS",
    ]);
    const evidence = criteria.flatMap((c) => c.evidence).join(" ");
    expect(evidence).toContain(`digest:${mediaDigest(syntheticGltfBinary())}`);
    expect(evidence).not.toContain("glTF{"); // digests, never payloads
  });

  test("a garbage artifact fails the container criterion honestly (never a fabricated pass)", () => {
    const criteria = deriveThreeDVerification(THREE_D_RENDERING_TASKS[0] as ThreeDTask, {
      kind: "success",
      artifact: { bytes: Buffer.alloc(256, 0xa5), format: "glb" },
    });
    expect(criteria.find((c) => c.criterionId === "container-valid")?.status).toBe("FAIL");
    // The rail-declared format is advisory only and never rescues a
    // failing sniff.
    expect(criteria.find((c) => c.criterionId === "container-valid")?.evidence.join(" ")).toContain(
      "declared-format:glb",
    );
  });
});

// ---------------------------------------------------------------------------
// The 3D binding + driver (the honest boundary, fakes for machinery)
// ---------------------------------------------------------------------------

describe("VAL-018 3D dispatch binding", () => {
  test("with no configured rail the dispatch is the honest boundary failure BEFORE any network effect", async () => {
    const calls = { count: 0 };
    const binding = createThreeDDispatchBinding({ transportCalls: calls });
    const outcome = await binding({
      executionId: "e",
      task: THREE_D_RENDERING_TASKS[0] as ThreeDTask,
      provider: "p",
      model: "m",
    });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "no-authorized-3d-rail",
      retryable: false,
    });
    if (outcome.kind === "failure") {
      expect(outcome.accessRequirement?.capability).toBe("model:three-d");
      expect(outcome.accessRequirement?.credentialEnvVar).toBe("ZECK_3D_API_KEY");
    }
    expect(calls.count).toBe(0);
  });

  test("the provably-invalid edge specs are rejected before any rail consultation", async () => {
    const calls = { count: 0 };
    const dispatch = vi.fn(async () => ({
      kind: "success" as const,
      artifact: { bytes: syntheticGltfBinary(), format: "glb" },
    }));
    const binding = createThreeDDispatchBinding({
      rail: { railId: "fake-rail", dispatch },
      transportCalls: calls,
    });
    const edgeTasks = [
      THREE_D_RENDERING_TASKS[3],
      THREE_D_RENDERING_TASKS[4],
      THREE_D_RENDERING_TASKS[5],
    ] as readonly ThreeDTask[];
    for (const task of edgeTasks) {
      const outcome = await binding({ executionId: "e", task, provider: "p", model: "m" });
      expect(outcome).toMatchObject({ kind: "failure", category: "invalid-request" });
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(calls.count).toBe(0);
  });

  test("a task outside the three-d vocabulary is rejected before anything (wrong-modality)", async () => {
    const dispatch = vi.fn();
    const binding = createThreeDDispatchBinding({
      rail: { railId: "fake-rail", dispatch },
      transportCalls: { count: 0 },
    });
    const outcome = await binding({
      executionId: "e",
      task: { kind: "generate-image", prompt: "x" } as unknown as ThreeDTask,
      provider: "p",
      model: "m",
    });
    expect(outcome).toMatchObject({ kind: "failure", category: "wrong-modality" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("with a rail configured (a controlled fake) a healthy spec dispatches and the retry policy applies", async () => {
    const attempts: number[] = [];
    const sleeps: number[] = [];
    const dispatch = vi.fn(async () => {
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
        artifact: { bytes: syntheticGltfBinary(), format: "glb" },
        usage: { inputTokens: 10, outputTokens: 1 },
      };
    });
    const binding = createThreeDDispatchBinding({
      rail: { railId: "fake-rail", dispatch },
      transportCalls: { count: 0 },
      retry: {
        attempts: 2,
        delayMs: 50,
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
      },
    });
    const outcome = await binding({
      executionId: "e",
      task: THREE_D_RENDERING_TASKS[0] as ThreeDTask,
      provider: "p",
      model: "m",
    });
    expect(outcome).toMatchObject({ kind: "success" });
    expect(attempts).toEqual([1, 2]);
    expect(sleeps).toEqual([50]);
  });
});

describe("VAL-018 3D execution driver", () => {
  test("drives the canonical lifecycle; a no-rail boundary completes as FAILED (honest)", async () => {
    const { lifecycle, transitions } = recordingLifecycle();
    const binding = createThreeDDispatchBinding({ transportCalls: { count: 0 } });
    const result = await driveThreeDExecution({
      executionId: "exec-3d",
      task: THREE_D_RENDERING_TASKS[0] as ThreeDTask,
      provider: "future-3d",
      model: "authorized-later",
      ports: { lifecycle, dispatch: binding, now: () => new Date(1_000_000) },
    });
    expect(result.terminal).toBe("FAILED");
    expect(transitions).toEqual([
      "authorize",
      "plan",
      "planning-decision",
      "queue",
      "start",
      "verify",
      "complete:fail",
    ]);
    expect(result.criteria[0]?.evidence.join(" ")).toContain("no-authorized-3d-rail");
    expect(result.artifactDigest).toBeNull();
    expect(result.requestDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  test("a delivered artifact (controlled fake) completes with the sniffed container facts", async () => {
    const { lifecycle } = recordingLifecycle();
    const result = await driveThreeDExecution({
      executionId: "exec-3d-2",
      task: THREE_D_RENDERING_TASKS[0] as ThreeDTask,
      provider: "p",
      model: "m",
      ports: {
        lifecycle,
        dispatch: async () => ({
          kind: "success",
          artifact: { bytes: syntheticGltfBinary(), format: "glb" },
        }),
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.artifactContainer).toBe("gltf-binary");
    expect(result.artifactDigest).toBe(mediaDigest(syntheticGltfBinary()));
  });

  test("a missing 3D fixture aborts BEFORE any lifecycle mutation (NOT RUN)", async () => {
    const { lifecycle, transitions } = recordingLifecycle();
    await expect(
      driveThreeDExecution({
        executionId: "exec-3d-3",
        task: { kind: "render-3d", scene: "scene3d-999" },
        provider: "p",
        model: "m",
        ports: {
          lifecycle,
          dispatch: async () => ({
            kind: "success",
            artifact: { bytes: Buffer.alloc(0), format: "glb" },
          }),
          now: () => new Date(1_000_000),
        },
      }),
    ).rejects.toThrow(ThreeDFixtureNotMaterializedError);
    expect(transitions).toEqual([]);
  });
});
