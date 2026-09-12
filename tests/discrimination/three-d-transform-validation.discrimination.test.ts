/**
 * VAL-018 acceptance criterion 6 — discrimination tests proving the
 * multimodal-transformation chain and the three-d derivations against
 * controlled fakes:
 *
 *   * fixture digest mismatches (a tampered/swapped materialization is
 *     detected and the run fails BEFORE any network effect — chain and
 *     three-d alike);
 *   * wrong-modality requests (a task whose kind is outside the chain
 *     vocabulary — and one outside the three-d vocabulary — are
 *     rejected BEFORE any network effect);
 *   * provider failures at EACH chain stage: a REAL 400 shape on
 *     genuinely corrupted source media fails stage 1 (the dispatched
 *     payload proven to be the genuine corrupt fixture bytes); a
 *     malformed structured description fails stage 2; a REAL imagegen
 *     failure shape fails stage 3 — each aborting the chain with the
 *     exact stage recorded;
 *   * malformed payloads (a valid base64 raster of garbage bytes at
 *     stage 3; a garbage 3D artifact) FAIL the mechanical criteria —
 *     never a fabricated completion;
 *   * chain-abort propagation (a stage-1 failure means stages 2 and 3
 *     NEVER execute — asserted by zero rail calls and executed flags);
 *   * retry honesty (RETRYABLE stage-3 failures retried exactly per
 *     policy; non-retryable never retried);
 *   * oracle provenance (a "successful" chain whose structured
 *     description misses the ground-truth term fails at stage 2 — no
 *     provider-success shortcut);
 *   * request reproducibility (the same task always derives the same
 *     per-stage request digests; the chaining itself is visible —
 *     stage 2's request digest IS stage 1's response digest; evidence
 *     carries digests, never payloads);
 *   * the three-d rail absence is an honest NOT RUN boundary (zero
 *     rail calls, the access requirement surfaced — never a
 *     fabricated 3D artifact).
 */

import { describe, expect, test } from "vitest";
import {
  createMultimodalTransformationBinding,
  deriveTransformationChainPlan,
  driveMultimodalTransformationExecution,
  materializeTransformationInput,
  type TransformMultimodalTask,
} from "../../benchmarks/validation/apps/multimodal-transformation/chain";
import {
  createCanvas,
  imageFixture,
  mediaDigest,
} from "../../benchmarks/validation/apps/shared/media";
import { threeDPromptFixture } from "../../benchmarks/validation/apps/shared/three-d-scenes";
import type {
  LabDispatchOutcome,
  LabVerificationCriterion,
} from "../../benchmarks/validation/platform/derive";
import type { PlatformLifecyclePort } from "../../benchmarks/validation/platform/driver";
import {
  createDashscopeImagegenRail,
  toImageDataUri,
} from "../../benchmarks/validation/platform/imagegen";
import {
  createMultimodalDispatchBinding,
  createOpenRouterVisionRail,
  deriveMultimodalPlan,
  toDataUri,
  type HttpTransport as VisionHttpTransport,
} from "../../benchmarks/validation/platform/multimodal";
import {
  createThreeDDispatchBinding,
  deriveThreeDPlan,
  deriveThreeDVerification,
  driveThreeDExecution,
  materializeThreeDInput,
  THREE_D_ACCESS_REQUIREMENT,
  type ThreeDRail,
} from "../../benchmarks/validation/platform/three-d";

const CHAIN_TASK: TransformMultimodalTask = {
  kind: "transform-multimodal",
  source: "img-c-001",
  instruction: "mm-instruction-001",
};

const CORRUPTED_TASK: TransformMultimodalTask = {
  kind: "transform-multimodal",
  source: "img-corrupt",
  instruction: "mm-instruction-001",
};

const THREE_D_TASK = {
  kind: "generate-3d" as const,
  prompt: "prompt-3d-001",
  geometry: {
    primitive: "box" as const,
    dimensions: [2, 1, 2] as const,
    resolution: 2,
    format: "glb" as const,
  },
};

const ROUTE = {
  visionProvider: "openrouter",
  visionModel: "qwen/qwen2.5-vl-72b-instruct",
  imagegenProvider: "dashscope",
  imagegenModel: "qwen-image-2.0",
};

const ORACLE = { containsText: ["bus"] };

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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The loose transport shape (body optional — imagegen GET polls send none). */
type LooseHttpTransport = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<Response>;

/** A scripted transport recording every call (responses in order). */
function scriptedTransport(responses: (Response | Error)[]): {
  readonly transport: LooseHttpTransport;
  readonly calls: { url: string; body: unknown }[];
} {
  const calls: { url: string; body: unknown }[] = [];
  let index = 0;
  const transport: LooseHttpTransport = async (url, init) => {
    calls.push({ url, body: init.body === undefined ? null : JSON.parse(init.body) });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) {
      throw next;
    }
    if (next === undefined) {
      throw new Error("scripted transport exhausted");
    }
    return next;
  };
  return { transport, calls };
}

/** The canonical valid vision answer (schema-conformant, oracle-carrying). */
function validVisionAnswer(): string {
  return JSON.stringify({
    subject: "bus",
    colors: ["yellow", "gray"],
    background: "street",
    composition: "the bus is centered on the road",
  });
}

/** A deterministic synthetic "generated" raster. */
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

/** A minimal well-formed GLB (header + one JSON chunk). */
function syntheticGlb(): Buffer {
  const json = Buffer.from('{"asset":{"version":"2.0"},"scenes":[{}],"scene":0}', "utf8");
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + json.length, 8);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(json.length, 0);
  chunkHeader.writeUInt32LE(0x4e4f534a, 4);
  return Buffer.concat([header, chunkHeader, json]);
}

/** Build the chain binding over the REAL rail constructors + scripted transports. */
function buildRealRailsChain(options: {
  readonly visionResponses: (Response | Error)[];
  readonly imagegenResponses: (Response | Error)[];
  readonly imagegenRailEnabled?: boolean;
}): {
  readonly dispatch: ReturnType<typeof createMultimodalTransformationBinding>;
  readonly visionCalls: { url: string; body: unknown }[];
  readonly imagegenCalls: { url: string; body: unknown }[];
} {
  const vision = scriptedTransport(options.visionResponses);
  const imagegen = scriptedTransport(options.imagegenResponses);
  // The vision rail always POSTs with a body — the loose transport is
  // runtime-compatible; the cast reconciles the two declared shapes.
  const visionRail = createOpenRouterVisionRail({
    transport: vision.transport as unknown as VisionHttpTransport,
    apiKey: "k",
  });
  const visionDispatch = createMultimodalDispatchBinding({ vision: visionRail });
  const imagegenRail =
    options.imagegenRailEnabled === false
      ? undefined
      : createDashscopeImagegenRail({
          transport: imagegen.transport,
          apiKey: "k",
          mode: "text-to-image",
        });
  const dispatch = createMultimodalTransformationBinding({
    visionDispatch,
    visionProvider: ROUTE.visionProvider,
    visionModel: ROUTE.visionModel,
    imagegenRail,
    imagegenProvider: ROUTE.imagegenProvider,
    imagegenModel: ROUTE.imagegenModel,
    derivedMediaSize: { width: 64, height: 64 },
    now: () => new Date(1_000_000),
  });
  return { dispatch, visionCalls: vision.calls, imagegenCalls: imagegen.calls };
}

/** Fresh success responses (Response bodies are single-use: one per dispatch). */
function visionSuccess(): Response {
  return jsonResponse(200, {
    choices: [{ message: { content: validVisionAnswer() } }],
    usage: { prompt_tokens: 88, completion_tokens: 23 },
  });
}

function imagegenSuccess(): Response {
  return jsonResponse(200, {
    output: {
      choices: [{ message: { content: [{ image: toImageDataUri(syntheticPng(64, 64)) }] } }],
    },
    usage: { image_count: 1 },
  });
}

describe("three-d-transform validation discrimination (VAL-018 AC6)", () => {
  test("a tampered chain materialization fails the run before ANY network effect", async () => {
    const chain = buildRealRailsChain({
      visionResponses: [visionSuccess()],
      imagegenResponses: [imagegenSuccess()],
    });
    const dispatch = createMultimodalTransformationBinding({
      visionDispatch: async () => ({ kind: "success", content: validVisionAnswer() }),
      visionProvider: ROUTE.visionProvider,
      visionModel: ROUTE.visionModel,
      imagegenRail: undefined,
      imagegenProvider: ROUTE.imagegenProvider,
      imagegenModel: ROUTE.imagegenModel,
      derivedMediaSize: { width: 64, height: 64 },
      materialize: (task) => ({
        ...materializeTransformationInput(task),
        instruction: "a tampered instruction",
        instructionDigest: "deadbeefdeadbeef",
      }),
      now: () => new Date(1_000_000),
    });
    void chain;
    const { lifecycle, transitions } = recordingLifecycle();
    const result = await driveMultimodalTransformationExecution({
      executionId: "exec-digest",
      task: CHAIN_TASK,
      route: ROUTE,
      oracle: ORACLE,
      ports: { lifecycle, dispatch, now: () => new Date(1_000_000) },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.stages.every((stage) => !stage.executed)).toBe(true);
    expect(transitions).toContain("complete:fail");
    const rejected = result.criteria.find((c) => c.criterionId === "chain-rejected");
    expect(rejected?.evidence[0]).toBe("category:fixture-digest-mismatch");
  });

  test("a tampered three-d materialization fails before ANY rail call", async () => {
    const railCalls = { count: 0 };
    const binding = createThreeDDispatchBinding({
      rail: {
        railId: "fake",
        dispatch: async () => ({
          kind: "success" as const,
          artifact: { bytes: syntheticGlb(), container: "glb" as const },
        }),
      },
      materialize: (task) => ({
        ...materializeThreeDInput(task),
        prompt: "a tampered prompt",
        promptDigest: "deadbeefdeadbeef",
      }),
      railCalls,
    });
    const { lifecycle } = recordingLifecycle();
    const result = await driveThreeDExecution({
      executionId: "exec-3d-digest",
      task: THREE_D_TASK,
      provider: "p",
      model: "m",
      ports: { lifecycle, dispatch: binding, now: () => new Date(1_000_000) },
    });
    expect(result.terminal).toBe("FAILED");
    expect(railCalls.count).toBe(0);
    expect(result.criteria[0]?.evidence[0]).toBe("provider-failure:fixture-digest-mismatch");
  });

  test("wrong-modality requests fail before ANY network effect (chain and three-d)", async () => {
    const { dispatch, visionCalls, imagegenCalls } = buildRealRailsChain({
      visionResponses: [visionSuccess()],
      imagegenResponses: [imagegenSuccess()],
    });
    const result = await driveMultimodalTransformationExecution({
      executionId: "exec-modality",
      task: { kind: "transform-image", source: "img-c-001", edit: "img-edit-001" },
      route: ROUTE,
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(visionCalls).toHaveLength(0);
    expect(imagegenCalls).toHaveLength(0);
    const rejected = result.criteria.find((c) => c.criterionId === "chain-rejected");
    expect(rejected?.evidence[0]).toBe("category:wrong-modality");

    // The three-d vocabulary is equally closed: a chain task is
    // wrong-modality there — proven at the BINDING level (the driver's
    // pre-lifecycle materialization honestly aborts NOT RUN for
    // out-of-vocabulary kinds, mirroring the imagegen slice).
    const railCalls = { count: 0 };
    const threeDBinding = createThreeDDispatchBinding({
      rail: {
        railId: "fake",
        dispatch: async () => ({
          kind: "success" as const,
          artifact: { bytes: syntheticGlb(), container: "glb" as const },
        }),
      },
      railCalls,
    });
    const threeDOutcome = await threeDBinding({
      executionId: "exec-3d-modality",
      task: CHAIN_TASK as never,
      provider: "p",
      model: "m",
    });
    expect(threeDOutcome).toMatchObject({ kind: "failure", category: "wrong-modality" });
    expect(railCalls.count).toBe(0);
  });

  test("provider failure at stage 1: a REAL 400 on genuinely corrupted source media (payload proven)", async () => {
    // The exact provider response shape a corrupted source PNG produces
    // on the real OpenRouter vision rail (live-verified by VAL-017):
    // HTTP 400 with the "cannot identify image file" message.
    const { dispatch, visionCalls } = buildRealRailsChain({
      visionResponses: [
        jsonResponse(400, {
          error: { message: "Failed to load image: cannot identify image file" },
        }),
      ],
      imagegenResponses: [imagegenSuccess()],
    });
    const result = await driveMultimodalTransformationExecution({
      executionId: "exec-corrupt",
      task: CORRUPTED_TASK,
      route: ROUTE,
      oracle: { containsText: [] },
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.abortedAtStage).toBe("vision");
    expect(result.usage).toBeNull();
    const aborted = result.criteria.find((c) => c.criterionId === "chain-aborted");
    expect(aborted?.evidence).toContain("stage:vision");
    expect(aborted?.evidence).toContain("category:invalid-request");
    // The dispatched payload WAS the genuine corrupt fixture bytes.
    expect(visionCalls).toHaveLength(1);
    const body = visionCalls[0]?.body as {
      messages: { content: { image_url?: { url: string } }[] }[];
    };
    expect(body.messages[0]?.content[1]?.image_url?.url).toBe(
      toDataUri(imageFixture("img-corrupt").png, "image/png"),
    );
  });

  test("provider failure at stage 2: a malformed structured description aborts the chain", async () => {
    const { dispatch, imagegenCalls } = buildRealRailsChain({
      visionResponses: [
        jsonResponse(200, {
          choices: [{ message: { content: "The image shows a yellow bus on a street." } }],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        }),
      ],
      imagegenResponses: [imagegenSuccess()],
    });
    const result = await driveMultimodalTransformationExecution({
      executionId: "exec-malformed-description",
      task: CHAIN_TASK,
      route: ROUTE,
      oracle: ORACLE,
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.abortedAtStage).toBe("structured-description");
    expect(imagegenCalls).toHaveLength(0); // the derived-media stage never dispatched
    const aborted = result.criteria.find((c) => c.criterionId === "chain-aborted");
    expect(aborted?.evidence).toContain("stage:structured-description");
    expect(aborted?.evidence).toContain("category:malformed-structured-description");
  });

  test("provider failure at stage 3: a REAL imagegen failure shape aborts the chain there", async () => {
    const { dispatch, visionCalls } = buildRealRailsChain({
      visionResponses: [visionSuccess()],
      imagegenResponses: [
        jsonResponse(400, {
          code: "InvalidParameter.ParameterImageError",
          message: "The input prompt is invalid",
          request_id: "req-x",
        }),
      ],
    });
    const result = await driveMultimodalTransformationExecution({
      executionId: "exec-imagegen-failure",
      task: CHAIN_TASK,
      route: ROUTE,
      oracle: ORACLE,
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.abortedAtStage).toBe("derived-media");
    expect(visionCalls).toHaveLength(1); // the vision stage DID run (measured)
    const aborted = result.criteria.find((c) => c.criterionId === "chain-aborted");
    expect(aborted?.evidence).toContain("stage:derived-media");
    expect(aborted?.evidence).toContain("category:invalid-request");
  });

  test("malformed payloads fail mechanically — never a fabricated completion (chain and three-d)", async () => {
    // Stage 3 delivers a 200 with a valid base64 of GARBAGE raster bytes.
    const garbage = Buffer.alloc(512, 0xa5);
    const { dispatch, imagegenCalls } = buildRealRailsChain({
      visionResponses: [visionSuccess()],
      imagegenResponses: [
        jsonResponse(200, {
          output: {
            choices: [{ message: { content: [{ image: toImageDataUri(garbage) }] } }],
          },
        }),
      ],
    });
    const result = await driveMultimodalTransformationExecution({
      executionId: "exec-malformed-raster",
      task: CHAIN_TASK,
      route: ROUTE,
      oracle: ORACLE,
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch,
        now: () => new Date(1_000_000),
      },
    });
    expect(imagegenCalls).toHaveLength(1); // the dispatch DID happen (REAL 200)...
    expect(result.terminal).toBe("FAILED"); // ...but the mechanical criteria fail it.
    expect(result.abortedAtStage).toBe("derived-media");
    const rasterCriterion = result.criteria.find((c) => c.criterionId === "raster-container");
    expect(rasterCriterion?.status).toBe("FAIL");

    // The three-d side: a garbage 3D artifact fails its container criterion.
    const threeDCriteria = deriveThreeDVerification(THREE_D_TASK, {
      kind: "success",
      artifact: { bytes: Buffer.alloc(512, 0xa5), container: "unknown" },
    });
    expect(threeDCriteria.find((c) => c.criterionId === "three-d-container")?.status).toBe("FAIL");
  });

  test("chain-abort propagation: a stage-1 failure means stages 2 and 3 NEVER execute", async () => {
    const { dispatch, imagegenCalls } = buildRealRailsChain({
      visionResponses: [
        jsonResponse(400, {
          error: { message: "Failed to load image: cannot identify image file" },
        }),
      ],
      imagegenResponses: [imagegenSuccess()],
    });
    const outcome = await dispatch({ executionId: "e", task: CORRUPTED_TASK, oracle: ORACLE });
    expect(outcome.kind).toBe("failure");
    expect(outcome.abortedAtStage).toBe("vision");
    expect(outcome.stages.map((stage) => stage.executed)).toEqual([true, false, false]);
    expect(outcome.stages[1]?.criteria).toEqual([]);
    expect(outcome.stages[2]?.criteria).toEqual([]);
    expect(imagegenCalls).toHaveLength(0);
    // Per-stage provenance still records the executed stage honestly.
    expect(outcome.stages[0]?.requestDigest).not.toBeNull();
    expect(outcome.stages[0]?.failure?.category).toBe("invalid-request");
  });

  test("retry honesty: retryable stage-3 failures retried exactly per policy; non-retryable never", async () => {
    // First attempt 429 (retryable), second attempt succeeds.
    const { dispatch, imagegenCalls } = (() => {
      const imagegen = scriptedTransport([
        jsonResponse(429, { code: "Throttling", message: "rate limited" }),
        imagegenSuccess(),
      ]);
      const visionRail = createOpenRouterVisionRail({
        transport: scriptedTransport([visionSuccess()]).transport as unknown as VisionHttpTransport,
        apiKey: "k",
      });
      const visionDispatch = createMultimodalDispatchBinding({ vision: visionRail });
      const imagegenRail = createDashscopeImagegenRail({
        transport: imagegen.transport,
        apiKey: "k",
        mode: "text-to-image",
      });
      const dispatch = createMultimodalTransformationBinding({
        visionDispatch,
        visionProvider: ROUTE.visionProvider,
        visionModel: ROUTE.visionModel,
        imagegenRail,
        imagegenProvider: ROUTE.imagegenProvider,
        imagegenModel: ROUTE.imagegenModel,
        derivedMediaSize: { width: 64, height: 64 },
        imagegenRetry: { attempts: 2, delayMs: 5, sleep: async () => {} },
        now: () => new Date(1_000_000),
      });
      return { dispatch, imagegenCalls: imagegen.calls };
    })();
    const result = await driveMultimodalTransformationExecution({
      executionId: "exec-retry",
      task: CHAIN_TASK,
      route: ROUTE,
      oracle: ORACLE,
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(imagegenCalls).toHaveLength(2); // exactly two REAL attempts

    // A non-retryable stage-3 400 is attempted exactly once.
    const single = (() => {
      const imagegen = scriptedTransport([
        jsonResponse(400, { code: "InvalidParameter", message: "bad size" }),
      ]);
      const visionRail = createOpenRouterVisionRail({
        transport: scriptedTransport([visionSuccess()]).transport as unknown as VisionHttpTransport,
        apiKey: "k",
      });
      const visionDispatch = createMultimodalDispatchBinding({ vision: visionRail });
      const imagegenRail = createDashscopeImagegenRail({
        transport: imagegen.transport,
        apiKey: "k",
        mode: "text-to-image",
      });
      const dispatch = createMultimodalTransformationBinding({
        visionDispatch,
        visionProvider: ROUTE.visionProvider,
        visionModel: ROUTE.visionModel,
        imagegenRail,
        imagegenProvider: ROUTE.imagegenProvider,
        imagegenModel: ROUTE.imagegenModel,
        derivedMediaSize: { width: 64, height: 64 },
        imagegenRetry: { attempts: 2, delayMs: 0, sleep: async () => {} },
        now: () => new Date(1_000_000),
      });
      return { dispatch, imagegenCalls: imagegen.calls };
    })();
    const failedResult = await driveMultimodalTransformationExecution({
      executionId: "exec-no-retry",
      task: CHAIN_TASK,
      route: ROUTE,
      oracle: ORACLE,
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: single.dispatch,
        now: () => new Date(1_000_000),
      },
    });
    expect(failedResult.terminal).toBe("FAILED");
    expect(failedResult.abortedAtStage).toBe("derived-media");
    expect(single.imagegenCalls).toHaveLength(1); // never retried
  });

  test("oracle provenance: a 'successful' chain missing the ground-truth term in the description fails at stage 2", async () => {
    // The RAW vision answer contains "bus" (stage 1's oracle passes) —
    // but the JSON object describes a "vehicle" with no "bus" anywhere
    // (stage 2's chain-of-custody oracle fails). No provider-success
    // shortcut exists.
    const { dispatch, imagegenCalls } = buildRealRailsChain({
      visionResponses: [
        jsonResponse(200, {
          choices: [
            {
              message: {
                content: `The image shows a bus. ${JSON.stringify({
                  subject: "vehicle",
                  colors: ["yellow"],
                  background: "street",
                  composition: "centered on the road",
                })}`,
              },
            },
          ],
          usage: { prompt_tokens: 88, completion_tokens: 23 },
        }),
      ],
      imagegenResponses: [imagegenSuccess()],
    });
    const result = await driveMultimodalTransformationExecution({
      executionId: "exec-oracle",
      task: CHAIN_TASK,
      route: ROUTE,
      oracle: ORACLE,
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.abortedAtStage).toBe("structured-description");
    // The STAGE-2 criteria (not stage 1's — the raw answer did contain
    // the term) carry the chain-of-custody failure.
    expect(result.stages[1]?.criteria.find((c) => c.criterionId === "contains:bus")?.status).toBe(
      "FAIL",
    );
    expect(imagegenCalls).toHaveLength(0); // stage 3 never ran
  });

  test("request reproducibility: the same task derives the same per-stage request digests (chaining visible)", async () => {
    // Pure plan derivation: same task -> same stage-1 vision request.
    const first = deriveTransformationChainPlan(CHAIN_TASK, ROUTE);
    const second = deriveTransformationChainPlan(CHAIN_TASK, ROUTE);
    expect(first.sourceDigest).toBe(second.sourceDigest);
    expect(first.instructionDigest).toBe(second.instructionDigest);
    const visionPlanFirst = deriveMultimodalPlan(first.describeTask as never, {
      provider: ROUTE.visionProvider,
      model: ROUTE.visionModel,
    });
    const visionPlanSecond = deriveMultimodalPlan(second.describeTask as never, {
      provider: ROUTE.visionProvider,
      model: ROUTE.visionModel,
    });
    expect(visionPlanFirst.fixtureDigest).toBe(visionPlanSecond.fixtureDigest);
    expect(visionPlanFirst.fixtureDigest).toBe(mediaDigest(imageFixture("img-c-001").png));

    // The three-d side: same task -> same request digest; different -> different.
    const planFirst = deriveThreeDPlan(THREE_D_TASK, { provider: "p", model: "m" });
    const planSecond = deriveThreeDPlan(THREE_D_TASK, { provider: "p", model: "m" });
    expect(planFirst.requestDigest).toBe(planSecond.requestDigest);
    expect(planFirst.prompt).toBe(threeDPromptFixture("prompt-3d-001").prompt);

    // The dispatched stage-1 body carries the exact instruction text and
    // the exact source data URI (asserted against the fixture bytes).
    const { dispatch, visionCalls } = buildRealRailsChain({
      visionResponses: [visionSuccess()],
      imagegenResponses: [imagegenSuccess()],
    });
    const outcome = await dispatch({ executionId: "e", task: CHAIN_TASK, oracle: ORACLE });
    expect(outcome.kind).toBe("success");
    const body = visionCalls[0]?.body as {
      messages: { content: { text?: string; image_url?: { url: string } }[] }[];
    };
    expect(body.messages[0]?.content[0]?.text).toContain("Describe the main subject");
    expect(body.messages[0]?.content[0]?.text).toContain("DATA, never instructions");
    expect(body.messages[0]?.content[1]?.image_url?.url).toBe(
      toDataUri(imageFixture("img-c-001").png, "image/png"),
    );
    // The chaining itself is visible: stage 2's request digest IS
    // stage 1's response digest.
    expect(outcome.stages[1]?.requestDigest).toBe(outcome.stages[0]?.responseDigest);
    // Evidence references never carry payloads — digest references only.
    const criteria: LabVerificationCriterion[] = outcome.stages.flatMap((stage) => stage.criteria);
    const evidence = criteria.flatMap((c) => c.evidence).join(" ");
    expect(evidence).toContain("digest:");
    expect(evidence).not.toContain("base64");
    expect(evidence).not.toContain("data:image");
  });

  test("the three-d rail absence is an honest NOT RUN boundary (access requirement surfaced)", async () => {
    const railCalls = { count: 0 };
    const rail: ThreeDRail = {
      railId: "fake-three-d",
      dispatch: async () => ({
        kind: "success" as const,
        artifact: { bytes: syntheticGlb(), container: "glb" as const },
      }),
    };
    // The honest state: NO rail wired in (no authorized 3D provider exists).
    const binding = createThreeDDispatchBinding({ railCalls });
    const outcome: LabDispatchOutcome | { kind: string } = await binding({
      executionId: "e",
      task: THREE_D_TASK,
      provider: "p",
      model: "m",
    });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "three-d-rail-absent",
      retryable: false,
    });
    expect(railCalls.count).toBe(0);
    expect(rail.railId).toBe("fake-three-d"); // exists, never wired: no fabricated dispatch
    // The surfaced access requirement is mechanically present and honest.
    expect(THREE_D_ACCESS_REQUIREMENT.capability).toBe("model:three-d");
    expect(THREE_D_ACCESS_REQUIREMENT.providerCandidates.length).toBeGreaterThanOrEqual(2);
    expect(THREE_D_ACCESS_REQUIREMENT.minimumCredential).toContain("env");
  });
});
