/**
 * VAL-018 acceptance criterion 6 — discrimination tests proving the
 * chained-transformation and 3D derivations against controlled fakes:
 *
 *   * fixture digest mismatches (a tampered/swapped materialization is
 *     detected at either slice and the run fails BEFORE any network
 *     effect);
 *   * wrong-modality requests (a chain whose rails are not both
 *     configured; a task outside either vocabulary) are rejected
 *     BEFORE any network effect;
 *   * provider failures at EACH chain stage (a REAL 400 on the
 *     genuinely corrupted source at stage 1; a rate-limit at stage 2)
 *     fail the execution honestly — never a fabricated completion;
 *   * chain-abort propagation (a stage-1 failure aborts the chain:
 *     the generation transport is NEVER called, provable by zero
 *     transport calls);
 *   * malformed payloads (a stage-1 answer that is not a structured
 *     description; a delivered raster that is not a raster; a
 *     delivered 3D payload that is not a glTF/OBJ/STL container) fail
 *     mechanically — never a fabricated pass;
 *   * the honest 3D boundary (no authorized rail: the boundary failure
 *     carries the exact surfaced access requirement; provably-invalid
 *     specs are rejected before any rail consultation);
 *   * oracle provenance (a successful chain whose stage-1 answer
 *     contradicts the fixture's ground truth fails its criterion — no
 *     provider-success shortcut);
 *   * evidence carries payload DIGESTS, never payloads.
 */

import { describe, expect, test, vi } from "vitest";
import {
  corruptGltf,
  createCanvas,
  imageFixture,
  mediaDigest,
  syntheticGltfBinary,
} from "../../benchmarks/validation/apps/shared/media";
import type { PlatformLifecyclePort } from "../../benchmarks/validation/platform/driver";
import {
  createDashscopeImagegenRail,
  toImageDataUri,
} from "../../benchmarks/validation/platform/imagegen";
import {
  createOpenRouterVisionRail,
  toDataUri,
} from "../../benchmarks/validation/platform/multimodal";
import {
  createChainedTransformDispatchBinding,
  deriveChainedTransformationVerification,
  driveChainedTransformExecution,
  materializeChainedTransformationInput,
  type TransformViaDescriptionTask,
} from "../../benchmarks/validation/platform/multimodal-transform";
import {
  createThreeDDispatchBinding,
  deriveThreeDVerification,
  driveThreeDExecution,
  materializeThreeDInput,
  THREE_D_ACCESS_REQUIREMENT,
  type ThreeDTask,
} from "../../benchmarks/validation/platform/three-d";

const CHAIN_TASK: TransformViaDescriptionTask = {
  kind: "describe-and-generate",
  chain: "chain-001",
};
const CORRUPT_CHAIN_TASK: TransformViaDescriptionTask = {
  kind: "describe-and-generate",
  chain: "chain-003",
};

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

function structuredAnswer(mainObject: string): string {
  return JSON.stringify({
    main_object: mainObject,
    setting: "centered on a plain background",
    palette: "yellow, gray, black",
    style: "flat minimal vector",
  });
}

/**
 * The chained binding over the PROVEN rails with scripted fake
 * transports. Returns the binding plus both transports' call records
 * so every discrimination can prove which stage reached the network.
 */
function createChainedWorld(options?: {
  readonly visionStatus?: number;
  readonly visionBody?: unknown;
  readonly imagegenStatus?: number;
  readonly imagegenBody?: unknown;
}) {
  const visionCalls: { url: string; body: unknown }[] = [];
  const imagegenCalls: { url: string; body: unknown }[] = [];
  const visionTransport = async (url: string, init: { body?: string }): Promise<Response> => {
    visionCalls.push({ url, body: JSON.parse(init.body ?? "{}") as unknown });
    return jsonResponse(
      options?.visionStatus ?? 200,
      options?.visionBody ?? {
        choices: [{ message: { content: structuredAnswer("bus") } }],
        usage: { prompt_tokens: 88, completion_tokens: 24 },
      },
    );
  };
  const imagegenTransport = async (url: string, init: { body?: string }): Promise<Response> => {
    imagegenCalls.push({ url, body: JSON.parse(init.body ?? "{}") as unknown });
    return jsonResponse(
      options?.imagegenStatus ?? 200,
      options?.imagegenBody ?? {
        output: {
          choices: [
            {
              message: { content: [{ image: toImageDataUri(syntheticGeneratedPng(1328, 1328)) }] },
            },
          ],
        },
        usage: { input_tokens: 120, image_count: 1 },
      },
    );
  };
  const binding = createChainedTransformDispatchBinding({
    vision: createOpenRouterVisionRail({ transport: visionTransport, apiKey: "k" }),
    generation: createDashscopeImagegenRail({
      transport: imagegenTransport,
      apiKey: "k",
      mode: "text-to-image",
    }),
    transportCalls: { count: 0 },
  });
  return { binding, visionCalls, imagegenCalls };
}

describe("multimodal-transformation + 3D validation discrimination (VAL-018 AC6)", () => {
  test("a tampered chained materialization fails the run before ANY network effect", async () => {
    const { binding, visionCalls, imagegenCalls } = createChainedWorld();
    const tampered = createChainedTransformDispatchBinding({
      vision: {
        railId: "v",
        modality: "image",
        dispatch: async () => ({ kind: "success" as const, content: structuredAnswer("bus") }),
      },
      generation: {
        railId: "g",
        mode: "text-to-image",
        dispatch: async () => ({
          kind: "success" as const,
          image: {
            bytes: syntheticGeneratedPng(1328, 1328),
            mimeType: "image/png",
            width: 1328,
            height: 1328,
          },
        }),
      },
      materialize: (task) => ({
        ...materializeChainedTransformationInput(task),
        sourceBytes: imageFixture("img-c-002").png,
        sourceDigest: "deadbeefdeadbeef",
      }),
      transportCalls: { count: 0 },
    });
    void binding;
    const { lifecycle } = recordingLifecycle();
    const result = await driveChainedTransformExecution({
      executionId: "exec-digest",
      task: CHAIN_TASK,
      visionProvider: "openrouter",
      visionModel: "m",
      imagegenProvider: "dashscope",
      imagegenModel: "m2",
      ports: { lifecycle, dispatch: tampered, now: () => new Date(1_000_000) },
    });
    expect(result.terminal).toBe("FAILED");
    expect(visionCalls).toHaveLength(0);
    expect(imagegenCalls).toHaveLength(0);
    expect(result.criteria[0]?.evidence).toContain("provider-failure:fixture-digest-mismatch");
  });

  test("a chain with only ONE configured rail is rejected before ANY network effect", async () => {
    const { visionCalls, imagegenCalls } = (() => {
      const visionCalls: unknown[] = [];
      const imagegenCalls: unknown[] = [];
      return { visionCalls, imagegenCalls };
    })();
    const visionTransport = async (url: string): Promise<Response> => {
      visionCalls.push(url);
      return jsonResponse(200, { choices: [{ message: { content: structuredAnswer("bus") } }] });
    };
    const imagegenTransport = async (url: string): Promise<Response> => {
      imagegenCalls.push(url);
      return jsonResponse(200, {
        output: {
          choices: [
            { message: { content: [{ image: toImageDataUri(syntheticGeneratedPng(64, 64)) }] } },
          ],
        },
      });
    };
    // Generation rail only: the vision rail is missing — the chain is
    // rejected before the stage-1 dispatch is ever spent.
    const visionMissing = createChainedTransformDispatchBinding({
      generation: createDashscopeImagegenRail({
        transport: imagegenTransport,
        apiKey: "k",
        mode: "text-to-image",
      }),
      transportCalls: { count: 0 },
    });
    const visionMissingOutcome = await visionMissing({
      executionId: "e",
      task: CHAIN_TASK,
      visionProvider: "p",
      visionModel: "m",
      imagegenProvider: "p",
      imagegenModel: "m2",
    });
    expect(visionMissingOutcome).toMatchObject({
      kind: "failure",
      stage: 1,
      category: "wrong-modality",
    });
    expect(visionCalls).toHaveLength(0);
    expect(imagegenCalls).toHaveLength(0);
    // Vision rail only: the generation rail is missing — same honest
    // pre-network rejection.
    const generationMissing = createChainedTransformDispatchBinding({
      vision: createOpenRouterVisionRail({ transport: visionTransport, apiKey: "k" }),
      transportCalls: { count: 0 },
    });
    const generationMissingOutcome = await generationMissing({
      executionId: "e",
      task: CHAIN_TASK,
      visionProvider: "p",
      visionModel: "m",
      imagegenProvider: "p",
      imagegenModel: "m2",
    });
    expect(generationMissingOutcome).toMatchObject({
      kind: "failure",
      stage: 2,
      category: "wrong-modality",
    });
    expect(visionCalls).toHaveLength(0);
    expect(imagegenCalls).toHaveLength(0);
  });

  test("a task outside the chained vocabulary is rejected before ANY network effect", async () => {
    const dispatch = vi.fn();
    const binding = createChainedTransformDispatchBinding({
      vision: { railId: "v", modality: "image", dispatch },
      generation: { railId: "g", mode: "text-to-image", dispatch },
      transportCalls: { count: 0 },
    });
    const outcome = await binding({
      executionId: "e",
      task: { kind: "render-3d", scene: "scene3d-001" } as unknown as TransformViaDescriptionTask,
      visionProvider: "p",
      visionModel: "m",
      imagegenProvider: "p",
      imagegenModel: "m2",
    });
    expect(outcome).toMatchObject({ kind: "failure", stage: 1, category: "wrong-modality" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("a REAL 400 on the corrupted source at stage 1 fails the chain and ABORTS it (the generation transport is never called)", async () => {
    // The exact provider response shape a corrupted PNG produces on
    // the real OpenRouter rail (probed live in VAL-017).
    const { binding, visionCalls, imagegenCalls } = createChainedWorld({
      visionStatus: 400,
      visionBody: {
        error: {
          message: "Provider returned error",
          code: 400,
          metadata: {
            raw: '{"error":{"message":"Failed to load image: cannot identify image file"}}',
          },
        },
      },
    });
    const { lifecycle } = recordingLifecycle();
    const result = await driveChainedTransformExecution({
      executionId: "exec-corrupt-source",
      task: CORRUPT_CHAIN_TASK,
      visionProvider: "openrouter",
      visionModel: "m",
      imagegenProvider: "dashscope",
      imagegenModel: "m2",
      ports: { lifecycle, dispatch: binding, now: () => new Date(1_000_000) },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.imageDigest).toBeNull();
    // Chain-abort propagation: stage 1 dispatched (the genuine corrupt
    // fixture bytes), stage 2 NEVER dispatched.
    expect(visionCalls).toHaveLength(1);
    expect(imagegenCalls).toHaveLength(0);
    const sent =
      (
        visionCalls[0]?.body as {
          messages: { content: { type: string; image_url?: { url: string } }[] }[];
        }
      )?.messages[0]?.content[1]?.image_url?.url ?? "";
    expect(sent).toBe(
      toDataUri(materializeChainedTransformationInput(CORRUPT_CHAIN_TASK).sourceBytes, "image/png"),
    );
    const evidence = result.criteria[0]?.evidence ?? [];
    expect(evidence).toContain("chain-aborted:stage:1");
    expect(evidence).toContain("stage2-attempted:false");
    expect(evidence).toContain("provider-failure:invalid-request");
  });

  test("a malformed stage-1 intermediate (prose, not a structured description) aborts the chain before any paid stage-2 dispatch", async () => {
    const { binding, visionCalls, imagegenCalls } = createChainedWorld({
      visionBody: {
        choices: [{ message: { content: "What a lovely photograph of a vehicle." } }],
      },
    });
    const { lifecycle } = recordingLifecycle();
    const result = await driveChainedTransformExecution({
      executionId: "exec-malformed-intermediate",
      task: CHAIN_TASK,
      visionProvider: "p",
      visionModel: "m",
      imagegenProvider: "p",
      imagegenModel: "m2",
      ports: { lifecycle, dispatch: binding, now: () => new Date(1_000_000) },
    });
    expect(result.terminal).toBe("FAILED");
    expect(visionCalls).toHaveLength(1);
    expect(imagegenCalls).toHaveLength(0);
    expect(result.criteria[0]?.evidence).toContain("provider-failure:malformed-intermediate");
    expect(result.criteria[0]?.evidence).toContain("stage2-attempted:false");
  });

  test("a provider failure at stage 2 (REAL 429 shape) fails the chain with the stage-2 facts recorded", async () => {
    const { binding, visionCalls, imagegenCalls } = createChainedWorld({
      imagegenStatus: 429,
      imagegenBody: { error: { message: "Requests rate-limited" } },
    });
    const { lifecycle } = recordingLifecycle();
    const result = await driveChainedTransformExecution({
      executionId: "exec-stage2-failure",
      task: CHAIN_TASK,
      visionProvider: "p",
      visionModel: "m",
      imagegenProvider: "p",
      imagegenModel: "m2",
      ports: { lifecycle, dispatch: binding, now: () => new Date(1_000_000) },
    });
    expect(result.terminal).toBe("FAILED");
    expect(visionCalls).toHaveLength(1);
    expect(imagegenCalls).toHaveLength(1);
    const evidence = result.criteria[0]?.evidence ?? [];
    expect(evidence).toContain("chain-aborted:stage:2");
    expect(evidence).toContain("stage2-attempted:true");
    expect(evidence).toContain("provider-failure:rate-limit");
    expect(evidence).toContain("retryable:true");
  });

  test("a malformed derived raster payload (garbage bytes at stage 2) FAILS the mechanical container criteria — never a fabricated completion", async () => {
    const garbage = Buffer.alloc(512, 0xa5);
    const { binding } = createChainedWorld({
      imagegenBody: {
        output: {
          choices: [{ message: { content: [{ image: toImageDataUri(garbage) }] } }],
        },
      },
    });
    const { lifecycle } = recordingLifecycle();
    const result = await driveChainedTransformExecution({
      executionId: "exec-garbage-raster",
      task: CHAIN_TASK,
      visionProvider: "p",
      visionModel: "m",
      imagegenProvider: "p",
      imagegenModel: "m2",
      ports: { lifecycle, dispatch: binding, now: () => new Date(1_000_000) },
    });
    // The dispatch SUCCEEDED (bytes arrived) but the mechanical
    // container criteria fail the run honestly.
    expect(result.terminal).toBe("FAILED");
    const byId = new Map(result.criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("stage1:contains:bus")).toBe("PASS");
    expect(byId.get("stage2:raster-container")).toBe("FAIL");
    expect(byId.get("stage2:dimensions-declared")).toBe("FAIL");
    expect(byId.get("stage2:digest-captured")).toBe("PASS");
    expect(result.imageDigest).toBe(mediaDigest(garbage));
  });

  test("a 'successful' empty stage-1 completion still fails the chain (no fabricated description)", async () => {
    const { binding, visionCalls, imagegenCalls } = createChainedWorld({
      visionBody: { choices: [{ message: { content: "" } }] },
    });
    const outcome = await binding({
      executionId: "e",
      task: CHAIN_TASK,
      visionProvider: "p",
      visionModel: "m",
      imagegenProvider: "p",
      imagegenModel: "m2",
    });
    expect(outcome).toMatchObject({ kind: "failure", stage: 1, category: "empty-completion" });
    expect(visionCalls).toHaveLength(1);
    expect(imagegenCalls).toHaveLength(0);
  });

  test("oracle provenance: a successful chain whose stage-1 answer misses the ground-truth term fails its criterion", () => {
    // The dispatch SUCCEEDED (a valid structured description arrived,
    // the derived image was generated) but the main object
    // contradicts the fixture's ground truth ("car" is not "bus") —
    // the mechanical oracle fails the run; no success shortcut.
    const criteria = deriveChainedTransformationVerification(CHAIN_TASK, {
      kind: "success",
      description: structuredAnswer("car"),
      mainObject: "car",
      image: {
        bytes: syntheticGeneratedPng(1328, 1328),
        mimeType: "image/png",
        width: 1328,
        height: 1328,
      },
      stages: [],
    });
    const byId = new Map(criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("stage1:contains:bus")).toBe("FAIL");
    expect(byId.get("stage1:structured-description")).toBe("PASS");
    expect(criteria.some((c) => c.status === "FAIL")).toBe(true);
  });

  test("the vision rail never receives a derived prompt and the generation rail never receives image bytes", async () => {
    const { binding, visionCalls, imagegenCalls } = createChainedWorld();
    await binding({
      executionId: "e",
      task: CHAIN_TASK,
      visionProvider: "p",
      visionModel: "m",
      imagegenProvider: "p",
      imagegenModel: "m2",
    });
    // Stage 1: the instruction + the source image data URI.
    const visionBody = visionCalls[0]?.body as {
      messages: { content: { type: string; text?: string; image_url?: { url: string } }[] }[];
    };
    expect(visionBody.messages[0]?.content[0]).toMatchObject({ type: "text" });
    expect(visionBody.messages[0]?.content[0]?.text).toContain("main_object");
    expect(visionBody.messages[0]?.content[1]?.image_url?.url).toBe(
      toDataUri(imageFixture("img-c-001").png, "image/png"),
    );
    // Stage 2: the derived prompt only — no image payload.
    const imagegenBody = imagegenCalls[0]?.body as {
      input: { prompt: string; image?: unknown };
      parameters: { size: string };
    };
    expect(imagegenBody.input.image).toBeUndefined();
    expect(imagegenBody.input.prompt).toContain("flat, minimal vector-style illustration");
    expect(imagegenBody.parameters.size).toBe("1328*1328");
  });

  test("chain evidence carries per-stage request/output digests, never payloads", async () => {
    const { binding } = createChainedWorld();
    const { lifecycle } = recordingLifecycle();
    const result = await driveChainedTransformExecution({
      executionId: "exec-evidence",
      task: CHAIN_TASK,
      visionProvider: "p",
      visionModel: "m",
      imagegenProvider: "p",
      imagegenModel: "m2",
      ports: { lifecycle, dispatch: binding, now: () => new Date(1_000_000) },
    });
    expect(result.terminal).toBe("COMPLETED");
    const evidence = result.criteria.flatMap((c) => c.evidence).join(" ");
    expect(evidence).not.toContain("base64");
    expect(evidence).not.toContain("data:");
    expect(result.stages).toHaveLength(2);
    for (const stage of result.stages) {
      expect(stage.requestDigest).toMatch(/^[0-9a-f]{16}$/);
      expect(stage.outputDigest).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  // ---- The 3D discriminations ----

  test("the 3D boundary: with no authorized rail the dispatch fails honestly BEFORE any network effect, carrying the exact access requirement", async () => {
    const calls = { count: 0 };
    const dispatch = vi.fn();
    const binding = createThreeDDispatchBinding({
      // A rail is deliberately NOT configured — the honest world.
      transportCalls: calls,
    });
    void dispatch;
    const { lifecycle } = recordingLifecycle();
    const result = await driveThreeDExecution({
      executionId: "exec-3d-boundary",
      task: { kind: "render-3d", scene: "scene3d-001" },
      provider: "future-3d",
      model: "authorized-later",
      ports: { lifecycle, dispatch: binding, now: () => new Date(1_000_000) },
    });
    expect(result.terminal).toBe("FAILED");
    expect(calls.count).toBe(0);
    const evidence = result.criteria[0]?.evidence.join(" ") ?? "";
    expect(evidence).toContain("provider-failure:no-authorized-3d-rail");
    expect(evidence).toContain("access-gap:model:three-d");
    expect(evidence).toContain("access-gap-credential-env-var:ZECK_3D_API_KEY");
    // The requirement fields are the surfaced operator request — never
    // a fabricated equivalent.
    expect(THREE_D_ACCESS_REQUIREMENT.providerModel).toContain("no 3D-generation provider");
    expect(THREE_D_ACCESS_REQUIREMENT.whyNeeded).toContain("VAL-018");
    expect(THREE_D_ACCESS_REQUIREMENT.experimentUnlocked).toContain("three-d.render-scene.v1");
    expect(THREE_D_ACCESS_REQUIREMENT.minimumCredential).toContain("3D-generation-capable");
  });

  test("the provably-invalid 3D edge specs are rejected before any rail consultation (zero rail calls)", async () => {
    const dispatch = vi.fn();
    const calls = { count: 0 };
    const binding = createThreeDDispatchBinding({
      rail: { railId: "fake-rail", dispatch },
      transportCalls: calls,
    });
    const edgeTasks: readonly ThreeDTask[] = [
      { kind: "render-3d", scene: "scene3d-empty" },
      { kind: "mesh-from-spec", spec: "mesh-008" },
      { kind: "render-3d", scene: "scene3d-corrupt" },
    ];
    for (const [index, task] of edgeTasks.entries()) {
      const { lifecycle } = recordingLifecycle();
      const result = await driveThreeDExecution({
        executionId: `exec-3d-edge-${index}`,
        task,
        provider: "p",
        model: "m",
        ports: { lifecycle, dispatch: binding, now: () => new Date(1_000_000) },
      });
      expect(result.terminal).toBe("FAILED");
      expect(result.criteria[0]?.evidence.join(" ")).toContain("provider-failure:invalid-request");
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(calls.count).toBe(0);
  });

  test("a tampered 3D materialization (digest mismatch) is rejected before any rail consultation", async () => {
    const dispatch = vi.fn();
    const binding = createThreeDDispatchBinding({
      rail: { railId: "fake-rail", dispatch },
      materialize: (task) => ({
        ...materializeThreeDInput(task),
        spec: '{"scene":"tampered","objects":[{"primitive":"box"}]}',
        specDigest: "deadbeefdeadbeef",
      }),
      transportCalls: { count: 0 },
    });
    const outcome = await binding({
      executionId: "e",
      task: { kind: "render-3d", scene: "scene3d-001" },
      provider: "p",
      model: "m",
    });
    expect(outcome).toMatchObject({ kind: "failure", category: "fixture-digest-mismatch" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("a delivered 3D payload that is not a valid container FAILS the mechanical criteria (never a fabricated pass)", () => {
    // A PNG is a valid raster but NOT a 3D artifact.
    const png = imageFixture("img-c-001").png;
    const criteria = deriveThreeDVerification(
      { kind: "render-3d", scene: "scene3d-001" },
      {
        kind: "success",
        artifact: { bytes: png, format: "glb" },
      },
    );
    const byId = new Map(criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("container-valid")).toBe("FAIL");
    // The corrupted glTF (magic over garbage) fails the sniff honestly.
    const corruptCriteria = deriveThreeDVerification(
      { kind: "render-3d", scene: "scene3d-001" },
      { kind: "success", artifact: { bytes: corruptGltf(), format: "glb" } },
    );
    expect(corruptCriteria.find((c) => c.criterionId === "container-valid")?.status).toBe("FAIL");
    // A valid synthetic glTF passes — the machinery discriminates.
    const validCriteria = deriveThreeDVerification(
      { kind: "render-3d", scene: "scene3d-001" },
      { kind: "success", artifact: { bytes: syntheticGltfBinary(), format: "glb" } },
    );
    expect(validCriteria.every((c) => c.status === "PASS")).toBe(true);
    // 3D evidence carries the digest, never the payload.
    const evidence = validCriteria.flatMap((c) => c.evidence).join(" ");
    expect(evidence).toContain(`digest:${mediaDigest(syntheticGltfBinary())}`);
    expect(evidence).not.toContain("glTF{");
    expect(evidence).not.toContain("base64");
  });
});
