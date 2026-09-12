/**
 * VAL-015 platform unit tests: the imagegen derivations (pure), the
 * REAL dashscope multimodal-generation rail over controlled fake
 * transports (no network), the dispatch binding's pre-dispatch
 * discriminations and the execution driver.
 *
 * Honesty invariants under test:
 *   * a missing fixture (prompt, edit, source image — or a task kind
 *     outside the vocabulary) is a NOT RUN boundary (thrown BEFORE any
 *     lifecycle mutation);
 *   * the empty-prompt edge row materializes and is rejected BEFORE any
 *     paid dispatch (honest invalid-request, never a fabricated image);
 *   * mechanical verification only: valid raster container, declared
 *     dimensions, non-empty payload, digest capture — plus the
 *     pixel-region change bounds for transformations (change present;
 *     changed region intersects the fixture's declared target region;
 *     identical outputs and off-target-only outputs FAIL);
 *   * the rail normalizes the REAL dashscope response shapes
 *     (synchronous image content; the task API with bounded polling;
 *     data/base64 and URL image references; usage image_count) and maps
 *     HTTP failures to the provider-failure taxonomy honestly;
 *   * the binding rejects digest mismatches, wrong-modality requests,
 *     blank prompts and edit-source mismatches BEFORE any network
 *     effect.
 */

import { describe, expect, test, vi } from "vitest";
import { IMAGE_GENERATION_TASKS } from "../../../benchmarks/validation/apps/image-generation/application";
import { IMAGE_TRANSFORMATION_TASKS } from "../../../benchmarks/validation/apps/image-transformation/application";
import {
  createCanvas,
  generationPromptFixture,
  imageEditFixture,
  imageFixture,
  mediaDigest,
} from "../../../benchmarks/validation/apps/shared/media";
import type { PlatformLifecyclePort } from "../../../benchmarks/validation/platform/driver";
import {
  buildImagegenRequestBody,
  createDashscopeImagegenRail,
  createImagegenDispatchBinding,
  deriveImagegenPlan,
  deriveImagegenVerification,
  driveImagegenExecution,
  type HttpTransport,
  ImagegenFixtureNotMaterializedError,
  type ImagegenTask,
  materializeImagegenInput,
  toImageDataUri,
} from "../../../benchmarks/validation/platform/imagegen";
import { decodePngToRgb } from "../../../benchmarks/validation/platform/imagegen-raster";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pngResponse(png: Buffer): Response {
  return new Response(new Uint8Array(png), {
    status: 200,
    headers: { "content-type": "image/png" },
  });
}

/** A fake transport scripted with a response queue (or thrown errors). */
function scriptedTransport(responses: (Response | Error)[]): {
  readonly transport: HttpTransport;
  readonly calls: { url: string; method: string; body: unknown }[];
} {
  const calls: { url: string; method: string; body: unknown }[] = [];
  let index = 0;
  const transport: HttpTransport = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      body: init.body === undefined ? null : JSON.parse(init.body),
    });
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
  canvas.fillRect(0, 0, width, height, [250, 250, 250]);
  canvas.drawCircle(
    Math.floor(width / 2),
    Math.floor(height / 2),
    Math.floor(width / 4),
    [200, 30, 30],
  );
  return canvas.toPng();
}

const GENERATION_TASK: ImagegenTask = {
  kind: "generate-image",
  prompt: "img-prompt-001",
  width: 1328,
  height: 1328,
};
const TRANSFORM_TASK: ImagegenTask = {
  kind: "transform-image",
  source: "img-c-001",
  edit: "img-edit-001",
};

// ---------------------------------------------------------------------------
// Materialization + fixtures (pure)
// ---------------------------------------------------------------------------

describe("VAL-015 imagegen materialization", () => {
  test("every pinned fixture materializes deterministically (same digests)", () => {
    for (const task of [...IMAGE_GENERATION_TASKS, ...IMAGE_TRANSFORMATION_TASKS]) {
      const first = materializeImagegenInput(task);
      const second = materializeImagegenInput(task);
      expect(first.promptDigest).toBe(second.promptDigest);
      expect(first.promptDigest).toMatch(/^[0-9a-f]{16}$/);
      if (first.sourceBytes !== null) {
        expect(first.sourceBytes.equals(second.sourceBytes ?? Buffer.alloc(0))).toBe(true);
        expect(first.sourceDigest).toBe(second.sourceDigest);
      }
    }
  });

  test("the empty prompt materializes as the corpus's own edge row (never a drop)", () => {
    const materialized = materializeImagegenInput({ kind: "generate-image", prompt: "" });
    expect(materialized.prompt).toBe("");
    expect(materialized.promptDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(materialized.annotation).toBe("empty prompt");
  });

  test("the corrupted-source edit fixture binds the genuinely corrupted bytes", () => {
    const materialized = materializeImagegenInput({
      kind: "transform-image",
      source: "img-corrupt",
      edit: "img-edit-004",
    });
    expect(materialized.sourceBytes?.length).toBe(8 + 64);
    expect(materialized.sourceDigest).toBe(mediaDigest(imageFixture("img-corrupt").png));
  });

  test("absent fixtures (and foreign task kinds) are NOT RUN boundaries (thrown)", () => {
    expect(() =>
      materializeImagegenInput({ kind: "generate-image", prompt: "img-prompt-999" }),
    ).toThrow(ImagegenFixtureNotMaterializedError);
    expect(() =>
      materializeImagegenInput({
        kind: "transform-image",
        source: "img-c-001",
        edit: "img-edit-999",
      }),
    ).toThrow(ImagegenFixtureNotMaterializedError);
    expect(() =>
      materializeImagegenInput({
        kind: "classify-image",
        image: "img-c-001",
      } as unknown as ImagegenTask),
    ).toThrow(ImagegenFixtureNotMaterializedError);
  });

  test("the edit-fixture table is internally consistent (sources exist, regions in bounds)", () => {
    for (const key of ["img-edit-001", "img-edit-002", "img-edit-003", "img-edit-004"]) {
      const edit = imageEditFixture(key);
      const { png } = imageFixture(edit.source); // throws when the source is absent
      if (edit.source === "img-corrupt") {
        // The corrupted source is genuinely undecodable by design —
        // only its existence (and corruption) is asserted here.
        expect(png.length).toBe(8 + 64);
        continue;
      }
      const decoded = decodePngToRgb(png);
      expect(decoded).not.toBeNull();
      const raster = decoded as NonNullable<ReturnType<typeof decodePngToRgb>>;
      const [x0, y0, x1, y1] = edit.targetRegion;
      expect(x0).toBeGreaterThanOrEqual(0);
      expect(y0).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(raster.width);
      expect(y1).toBeLessThanOrEqual(raster.height);
      expect(x1).toBeGreaterThan(x0);
      expect(y1).toBeGreaterThan(y0);
    }
  });

  test("generation prompt fixtures are pinned text (request-level reproducibility)", () => {
    for (const key of ["img-prompt-001", "img-prompt-002", "img-prompt-003"]) {
      const fixture = generationPromptFixture(key);
      expect(fixture.prompt.length).toBeGreaterThan(20);
      expect(generationPromptFixture(key).prompt).toBe(fixture.prompt);
    }
  });
});

// ---------------------------------------------------------------------------
// Dispatch-plan derivation (pure)
// ---------------------------------------------------------------------------

describe("VAL-015 dispatch-plan derivation", () => {
  test("a generation task derives the route, mode, seeded prompt and request digest", () => {
    const plan = deriveImagegenPlan(GENERATION_TASK, {
      provider: "dashscope",
      model: "qwen-image-2.0",
    });
    expect(plan.route).toEqual({
      provider: "dashscope",
      model: "qwen-image-2.0",
      strategyClass: "single-shot-imagegen",
    });
    expect(plan.mode).toBe("text-to-image");
    expect(plan.prompt).toBe(generationPromptFixture("img-prompt-001").prompt);
    expect(plan.promptDigest).toBe(mediaDigest(Buffer.from(plan.prompt, "utf8")));
    expect(plan.size).toEqual({ width: 1328, height: 1328 });
    expect(plan.requestDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(plan.sourceKey).toBeNull();
    expect(plan.targetRegion).toBeNull();
  });

  test("the request digest is reproducible (same task, same canonical body)", () => {
    const first = deriveImagegenPlan(GENERATION_TASK, { provider: "p", model: "m" });
    const second = deriveImagegenPlan(GENERATION_TASK, { provider: "p", model: "m" });
    expect(first.requestDigest).toBe(second.requestDigest);
    const other = deriveImagegenPlan(
      { kind: "generate-image", prompt: "img-prompt-002", width: 1328, height: 1328 },
      { provider: "p", model: "m" },
    );
    expect(other.requestDigest).not.toBe(first.requestDigest);
  });

  test("a transform task derives the image-to-image mode and source ground truth", () => {
    const plan = deriveImagegenPlan(TRANSFORM_TASK, { provider: "dashscope", model: "m" });
    expect(plan.mode).toBe("image-to-image");
    expect(plan.prompt).toBe(imageEditFixture("img-edit-001").instruction);
    expect(plan.sourceKey).toBe("img-c-001");
    expect(plan.sourceDigest).toBe(mediaDigest(imageFixture("img-c-001").png));
    expect(plan.targetRegion).toEqual([24, 46, 216, 120]);
    expect(plan.size).toBeNull();
    expect(plan.requestDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  test("the canonical request body carries the exact prompt, image and size", () => {
    const sourcePng = imageFixture("img-c-001").png;
    const body = buildImagegenRequestBody({
      model: "qwen-image-2.0",
      prompt: "Recolor the bus.",
      sourceDataUri: toImageDataUri(sourcePng),
      size: { width: 1328, height: 1328 },
    });
    expect(body).toEqual({
      model: "qwen-image-2.0",
      input: {
        prompt: "Recolor the bus.",
        image: toImageDataUri(sourcePng),
      },
      parameters: { n: 1, size: "1328*1328" },
    });
    // Byte-stable serialization (request digests depend on it).
    expect(JSON.stringify(body)).toBe(
      JSON.stringify(
        buildImagegenRequestBody({
          model: "qwen-image-2.0",
          prompt: "Recolor the bus.",
          sourceDataUri: toImageDataUri(sourcePng),
          size: { width: 1328, height: 1328 },
        }),
      ),
    );
  });

  test("a missing fixture aborts the plan derivation (NOT RUN, before lifecycle)", () => {
    expect(() =>
      deriveImagegenPlan(
        { kind: "generate-image", prompt: "img-prompt-999" },
        { provider: "p", model: "m" },
      ),
    ).toThrow(ImagegenFixtureNotMaterializedError);
  });
});

// ---------------------------------------------------------------------------
// Mechanical verification derivation (pure)
// ---------------------------------------------------------------------------

describe("VAL-015 verification derivation (generation)", () => {
  test("a provider failure FAILS the run mechanically (single criterion)", () => {
    const criteria = deriveImagegenVerification(GENERATION_TASK, {
      kind: "failure",
      category: "invalid-request",
      message: "blank prompt rejected before any paid dispatch",
      retryable: false,
    });
    expect(criteria).toHaveLength(1);
    expect(criteria[0]?.status).toBe("FAIL");
    expect(criteria[0]?.criterionId).toBe("provider-dispatch");
    expect(criteria[0]?.evidence[0]).toBe("provider-failure:invalid-request");
  });

  test("a valid generated raster at the declared size passes all mechanical criteria", () => {
    const png = syntheticGeneratedPng(1328, 1328);
    const criteria = deriveImagegenVerification(GENERATION_TASK, {
      kind: "success",
      image: {
        bytes: png,
        mimeType: "image/png",
        width: 1328,
        height: 1328,
      },
    });
    expect(criteria.map((c) => `${c.criterionId}:${c.status}`)).toEqual([
      "raster-container:PASS",
      "dimensions-declared:PASS",
      "payload-nonempty:PASS",
      "digest-captured:PASS",
    ]);
    const evidence = criteria.flatMap((c) => c.evidence).join(" ");
    expect(evidence).toContain(`digest:${mediaDigest(png)}`);
    expect(evidence).not.toContain("base64");
  });

  test("a malformed raster payload fails the container and dimensions criteria", () => {
    const garbage = Buffer.alloc(256, 0xa5);
    const criteria = deriveImagegenVerification(GENERATION_TASK, {
      kind: "success",
      image: { bytes: garbage, mimeType: "image/unknown", width: null, height: null },
    });
    const byId = new Map(criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("raster-container")).toBe("FAIL");
    expect(byId.get("dimensions-declared")).toBe("FAIL");
    expect(byId.get("payload-nonempty")).toBe("PASS"); // bytes exist — honest per-criterion
  });

  test("a delivered raster whose dimensions disagree with the request fails", () => {
    const png = syntheticGeneratedPng(256, 128); // task declared 1328x1328
    const criteria = deriveImagegenVerification(GENERATION_TASK, {
      kind: "success",
      image: { bytes: png, mimeType: "image/png", width: 256, height: 128 },
    });
    const dimensionCriterion = criteria.find((c) => c.criterionId === "dimensions-declared");
    expect(dimensionCriterion?.status).toBe("FAIL");
    expect(dimensionCriterion?.evidence.join(" ")).toContain("requested:1328x1328");
    expect(dimensionCriterion?.evidence.join(" ")).toContain("parsed:256x128");
  });

  test("a JPEG raster is a valid container with parseable declared dimensions", () => {
    const jpeg = minimalJpeg(1664, 928);
    const criteria = deriveImagegenVerification(
      { kind: "generate-image", prompt: "img-prompt-003", width: 1664, height: 928 },
      { kind: "success", image: { bytes: jpeg, mimeType: "image/jpeg", width: 1664, height: 928 } },
    );
    const byId = new Map(criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("raster-container")).toBe("PASS");
    expect(byId.get("dimensions-declared")).toBe("PASS");
  });
});

describe("VAL-015 verification derivation (transformation — pixel-region bounds)", () => {
  test("an edit touching the target region passes change-present and intersection", () => {
    // Output: the bus body region repainted over a white canvas — the
    // changed region intersects the fixture's declared target region.
    const canvas = createCanvas(256, 128);
    canvas.fillRect(24, 46, 216, 120, [180, 20, 20]);
    const output = canvas.toPng();
    const criteria = deriveImagegenVerification(TRANSFORM_TASK, {
      kind: "success",
      image: { bytes: output, mimeType: "image/png", width: 256, height: 128 },
    });
    const byId = new Map(criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("change-present")).toBe("PASS");
    expect(byId.get("changed-region-intersects-target")).toBe("PASS");
    expect([...byId.values()].every((status) => status === "PASS")).toBe(true);
  });

  test("an identical output (no real transformation) fails change-present", () => {
    const source = imageFixture("img-c-001").png;
    const criteria = deriveImagegenVerification(TRANSFORM_TASK, {
      kind: "success",
      image: { bytes: source, mimeType: "image/png", width: 256, height: 128 },
    });
    const byId = new Map(criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("change-present")).toBe("FAIL");
    expect(byId.get("changed-region-intersects-target")).toBe("FAIL");
  });

  test("an output changed ONLY outside the target region fails the intersection", () => {
    // Pixel-faithful replica of the source with a small patch in the
    // top-left corner (outside the bus body region).
    const source = imageFixture("img-c-001").png;
    const output = repaintWithPatch(source, { x0: 0, y0: 0, x1: 10, y1: 10 }, [10, 10, 10]);
    const criteria = deriveImagegenVerification(TRANSFORM_TASK, {
      kind: "success",
      image: { bytes: output, mimeType: "image/png", width: 256, height: 128 },
    });
    const byId = new Map(criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("change-present")).toBe("PASS"); // something did change
    expect(byId.get("changed-region-intersects-target")).toBe("FAIL");
    const evidence = criteria
      .find((c) => c.criterionId === "changed-region-intersects-target")
      ?.evidence.join(" ");
    expect(evidence).toContain("intersection:false");
    expect(evidence).toContain("target:[24,46,216,120]");
  });

  test("a transform output scaled to different dimensions still compares on the grid", () => {
    // Same edit, but the model returned 1024x512 (a 4x rescale).
    const canvas = createCanvas(1024, 512);
    canvas.fillRect(96, 184, 864, 568, [180, 20, 20]);
    const output = canvas.toPng();
    const criteria = deriveImagegenVerification(TRANSFORM_TASK, {
      kind: "success",
      image: { bytes: output, mimeType: "image/png", width: 1024, height: 512 },
    });
    const byId = new Map(criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("change-present")).toBe("PASS");
    expect(byId.get("changed-region-intersects-target")).toBe("PASS");
  });

  test("a JPEG transform output fails the pixel-bound criteria honestly (no decoder)", () => {
    const jpeg = minimalJpeg(256, 128);
    const criteria = deriveImagegenVerification(TRANSFORM_TASK, {
      kind: "success",
      image: { bytes: jpeg, mimeType: "image/jpeg", width: 256, height: 128 },
    });
    const byId = new Map(criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("raster-container")).toBe("PASS"); // JPEG IS a valid container
    expect(byId.get("change-present")).toBe("FAIL");
    const evidence = criteria.find((c) => c.criterionId === "change-present")?.evidence.join(" ");
    expect(evidence).toContain("output-not-pixel-decodable");
  });
});

// ---------------------------------------------------------------------------
// The REAL rail over fake transports (no network)
// ---------------------------------------------------------------------------

describe("VAL-015 dashscope multimodal-generation rail (fake transport)", () => {
  test("a synchronous data/base64 image response resolves to raster bytes + usage", async () => {
    const png = syntheticGeneratedPng(1328, 1328);
    const { transport, calls } = scriptedTransport([
      jsonResponse(200, {
        output: {
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: [{ image: toImageDataUri(png) }],
              },
            },
          ],
        },
        usage: { image_count: 1 },
        request_id: "req-1",
      }),
    ]);
    const rail = createDashscopeImagegenRail({
      transport,
      apiKey: "test-key",
      mode: "text-to-image",
    });
    const outcome = await rail.dispatch({
      model: "qwen-image-2.0",
      prompt: generationPromptFixture("img-prompt-001").prompt,
      size: { width: 1328, height: 1328 },
    });
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.image.bytes.equals(png)).toBe(true);
      expect(outcome.image.mimeType).toBe("image/png");
      expect(outcome.image.width).toBe(1328);
      expect(outcome.image.height).toBe(1328);
      expect(outcome.usage?.outputTokens).toBe(1);
      expect(outcome.usage?.inputTokens).toBe(0);
    }
    expect(calls[0]?.url).toBe(
      "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    );
    const body = calls[0]?.body as {
      model: string;
      input: { prompt: string };
      parameters: { n: number; size: string };
    };
    expect(body.model).toBe("qwen-image-2.0");
    expect(body.parameters.size).toBe("1328*1328");
  });

  test("a task-based response polls the REAL task API within the bounded window", async () => {
    const png = syntheticGeneratedPng(1328, 1328);
    const { transport, calls } = scriptedTransport([
      jsonResponse(200, {
        output: { task_id: "task-abc", task_status: "PENDING" },
        request_id: "req-1",
      }),
      jsonResponse(200, {
        output: { task_id: "task-abc", task_status: "RUNNING" },
        request_id: "req-2",
      }),
      jsonResponse(200, {
        output: {
          task_id: "task-abc",
          task_status: "SUCCEEDED",
          results: [{ url: "https://result.example.com/image.png" }],
        },
        usage: { image_count: 1 },
        request_id: "req-3",
      }),
      pngResponse(png),
    ]);
    const rail = createDashscopeImagegenRail({
      transport,
      apiKey: "k",
      mode: "text-to-image",
      pollIntervalMs: 1,
      sleep: async () => {},
    });
    const outcome = await rail.dispatch({
      model: "qwen-image-2.0",
      prompt: "p",
    });
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.image.bytes.equals(png)).toBe(true);
      expect(outcome.usage?.outputTokens).toBe(1);
    }
    expect(calls.map((call) => call.url)).toEqual([
      "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
      "https://dashscope-intl.aliyuncs.com/api/v1/tasks/task-abc",
      "https://dashscope-intl.aliyuncs.com/api/v1/tasks/task-abc",
      "https://result.example.com/image.png",
    ]);
  });

  test("a FAILED task ends the dispatch honestly (non-retryable)", async () => {
    const { transport } = scriptedTransport([
      jsonResponse(200, { output: { task_id: "t", task_status: "PENDING" } }),
      jsonResponse(200, {
        output: { task_id: "t", task_status: "FAILED", code: "InternalError", message: "bad" },
      }),
    ]);
    const rail = createDashscopeImagegenRail({
      transport,
      apiKey: "k",
      mode: "text-to-image",
      pollIntervalMs: 1,
      sleep: async () => {},
    });
    const outcome = await rail.dispatch({ model: "m", prompt: "p" });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "provider-task-failed",
      retryable: false,
    });
  });

  test("a raw base64 image reference (no data: prefix) decodes honestly", async () => {
    const png = syntheticGeneratedPng(256, 128);
    const { transport } = scriptedTransport([
      jsonResponse(200, {
        output: { choices: [{ message: { content: [{ image: png.toString("base64") }] } }] },
      }),
    ]);
    const rail = createDashscopeImagegenRail({ transport, apiKey: "k", mode: "text-to-image" });
    const outcome = await rail.dispatch({ model: "m", prompt: "p" });
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.image.bytes.equals(png)).toBe(true);
      expect(outcome.image.width).toBe(256);
    }
  });

  test("an image edit dispatch carries the source image as the input data URI", async () => {
    const source = imageFixture("img-c-001").png;
    const output = syntheticGeneratedPng(256, 128);
    const { transport, calls } = scriptedTransport([
      jsonResponse(200, {
        output: { choices: [{ message: { content: [{ image: toImageDataUri(output) }] } }] },
      }),
    ]);
    const rail = createDashscopeImagegenRail({
      transport,
      apiKey: "k",
      mode: "image-to-image",
    });
    const outcome = await rail.dispatch({
      model: "qwen-image-2.0",
      prompt: imageEditFixture("img-edit-001").instruction,
      sourceDataUri: toImageDataUri(source),
    });
    expect(outcome.kind).toBe("success");
    const body = calls[0]?.body as {
      input: { prompt: string; image: string };
      parameters: { n: number };
    };
    expect(body.input.image).toBe(toImageDataUri(source));
    expect(body.input.prompt).toContain("Recolor the body of the bus");
    expect(body.parameters).toEqual({ n: 1 });
  });

  test("HTTP failures map to the provider-failure taxonomy honestly", async () => {
    const cases: [number, unknown, { category: string; retryable: boolean }][] = [
      [
        400,
        { code: "InvalidParameter", message: "the input image is corrupted" },
        { category: "invalid-request", retryable: false },
      ],
      [401, { code: "InvalidApiKey", message: "bad key" }, { category: "auth", retryable: false }],
      [
        404,
        { code: "NotFound", message: "model" },
        { category: "model-unavailable", retryable: false },
      ],
      [
        429,
        { code: "Throttling", message: "rate limited" },
        { category: "rate-limit", retryable: true },
      ],
      [
        503,
        { code: "ServiceUnavailable", message: "down" },
        { category: "provider-unavailable", retryable: true },
      ],
    ];
    for (const [status, body, expected] of cases) {
      const { transport } = scriptedTransport([jsonResponse(status, body)]);
      const rail = createDashscopeImagegenRail({ transport, apiKey: "k", mode: "text-to-image" });
      const outcome = await rail.dispatch({ model: "m", prompt: "p" });
      expect(outcome).toMatchObject({ kind: "failure", ...expected });
    }
  });

  test("a transport exception is a retryable transport failure", async () => {
    const { transport } = scriptedTransport([new Error("ECONNRESET")]);
    const rail = createDashscopeImagegenRail({ transport, apiKey: "k", mode: "text-to-image" });
    const outcome = await rail.dispatch({ model: "m", prompt: "p" });
    expect(outcome).toMatchObject({ kind: "failure", category: "transport", retryable: true });
  });

  test("a success response without any image payload is an honest empty-output failure", async () => {
    const shapes: unknown[] = [
      { output: {} },
      { output: { choices: [{ message: { content: "" } }] } },
      { output: { choices: [{ message: { content: [{ image: "" }] } }] } },
      { output: { choices: [{ message: { content: "a text answer with no image" } }] } },
    ];
    for (const body of shapes) {
      const { transport } = scriptedTransport([jsonResponse(200, body)]);
      const rail = createDashscopeImagegenRail({ transport, apiKey: "k", mode: "text-to-image" });
      const outcome = await rail.dispatch({ model: "m", prompt: "p" });
      expect(outcome).toMatchObject({ kind: "failure", category: "empty-output", retryable: true });
    }
  });

  test("mode guards: no source on image-to-image (or source on text-to-image) never dispatches", async () => {
    const { transport, calls } = scriptedTransport([jsonResponse(200, { output: {} })]);
    const editRail = createDashscopeImagegenRail({
      transport,
      apiKey: "k",
      mode: "image-to-image",
    });
    const missing = await editRail.dispatch({ model: "m", prompt: "p" });
    expect(missing).toMatchObject({
      kind: "failure",
      category: "invalid-request",
      retryable: false,
    });
    const genRail = createDashscopeImagegenRail({ transport, apiKey: "k", mode: "text-to-image" });
    const extra = await genRail.dispatch({
      model: "m",
      prompt: "p",
      sourceDataUri: "data:image/png;base64,eA==",
    });
    expect(extra).toMatchObject({ kind: "failure", category: "invalid-request", retryable: false });
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The dispatch binding (pre-dispatch discriminations)
// ---------------------------------------------------------------------------

describe("VAL-015 dispatch binding", () => {
  test("routes generation tasks and transform tasks to their mode's rail", async () => {
    type RailDispatchInput = {
      readonly model: string;
      readonly prompt: string;
      readonly sourceDataUri?: string;
      readonly size?: { readonly width: number; readonly height: number };
    };
    const generationDispatch = vi.fn(async (_input: RailDispatchInput) => ({
      kind: "success" as const,
      image: {
        bytes: syntheticGeneratedPng(256, 128),
        mimeType: "image/png" as const,
        width: 256,
        height: 128,
      },
    }));
    const transformationDispatch = vi.fn(async (_input: RailDispatchInput) => ({
      kind: "success" as const,
      image: {
        bytes: syntheticGeneratedPng(256, 128),
        mimeType: "image/png" as const,
        width: 256,
        height: 128,
      },
    }));
    const binding = createImagegenDispatchBinding({
      generation: { railId: "g", mode: "text-to-image", dispatch: generationDispatch },
      transformation: { railId: "t", mode: "image-to-image", dispatch: transformationDispatch },
      transportCalls: { count: 0 },
    });
    const generated = await binding({
      executionId: "e1",
      task: GENERATION_TASK,
      provider: "dashscope",
      model: "m",
    });
    expect(generated.kind).toBe("success");
    expect(generationDispatch).toHaveBeenCalledTimes(1);
    expect(generationDispatch.mock.calls[0]?.[0]?.size).toEqual({ width: 1328, height: 1328 });
    expect(generationDispatch.mock.calls[0]?.[0]?.sourceDataUri).toBeUndefined();

    const transformed = await binding({
      executionId: "e2",
      task: TRANSFORM_TASK,
      provider: "dashscope",
      model: "m",
    });
    expect(transformed.kind).toBe("success");
    expect(transformationDispatch).toHaveBeenCalledTimes(1);
    expect(transformationDispatch.mock.calls[0]?.[0]?.sourceDataUri).toBe(
      toImageDataUri(imageFixture("img-c-001").png),
    );
  });

  test("a tampered materialization (digest mismatch) is rejected BEFORE any dispatch", async () => {
    const dispatch = vi.fn();
    const binding = createImagegenDispatchBinding({
      generation: { railId: "g", mode: "text-to-image", dispatch },
      materialize: (task) => ({
        ...materializeImagegenInput(task),
        prompt: "a tampered prompt",
        promptDigest: "0000000000000000",
      }),
      transportCalls: { count: 0 },
    });
    const outcome = await binding({
      executionId: "e",
      task: GENERATION_TASK,
      provider: "p",
      model: "m",
    });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "fixture-digest-mismatch",
      retryable: false,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("a wrong-modality request fails BEFORE any network effect", async () => {
    const dispatch = vi.fn();
    // Only the generation rail is configured: transform tasks must be
    // rejected (wrong-modality), mirroring the multimodal pattern.
    const binding = createImagegenDispatchBinding({
      generation: { railId: "g", mode: "text-to-image", dispatch },
      transportCalls: { count: 0 },
    });
    const outcome = await binding({
      executionId: "e",
      task: TRANSFORM_TASK,
      provider: "p",
      model: "m",
    });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "wrong-modality",
      retryable: false,
    });
    expect(dispatch).not.toHaveBeenCalled();

    // A task kind outside the imagegen vocabulary is likewise rejected.
    const foreign = await binding({
      executionId: "e2",
      task: { kind: "classify-image", image: "img-c-001" } as unknown as ImagegenTask,
      provider: "p",
      model: "m",
    });
    expect(foreign).toMatchObject({
      kind: "failure",
      category: "wrong-modality",
      retryable: false,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("the empty-prompt edge row is rejected BEFORE any paid dispatch", async () => {
    const dispatch = vi.fn();
    const binding = createImagegenDispatchBinding({
      generation: { railId: "g", mode: "text-to-image", dispatch },
      transportCalls: { count: 0 },
    });
    const outcome = await binding({
      executionId: "e",
      task: { kind: "generate-image", prompt: "" },
      provider: "p",
      model: "m",
    });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "invalid-request",
      retryable: false,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("an edit task whose declared source disagrees with the fixture is rejected", async () => {
    const dispatch = vi.fn();
    const binding = createImagegenDispatchBinding({
      transformation: { railId: "t", mode: "image-to-image", dispatch },
      transportCalls: { count: 0 },
    });
    const outcome = await binding({
      executionId: "e",
      // img-edit-001 is bound to img-c-001, not img-c-002.
      task: { kind: "transform-image", source: "img-c-002", edit: "img-edit-001" },
      provider: "p",
      model: "m",
    });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "edit-fixture-source-mismatch",
      retryable: false,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("the bounded retry policy retries RETRYABLE failures only, with REAL attempts", async () => {
    const attempts: number[] = [];
    const sleeps: number[] = [];
    const generation = {
      railId: "g",
      mode: "text-to-image" as const,
      dispatch: async () => {
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
            bytes: syntheticGeneratedPng(256, 128),
            mimeType: "image/png" as const,
            width: 256,
            height: 128,
          },
        };
      },
    };
    const binding = createImagegenDispatchBinding({
      generation,
      transportCalls: { count: 0 },
      retry: {
        attempts: 2,
        delayMs: 50,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    });
    const outcome = await binding({
      executionId: "e",
      task: GENERATION_TASK,
      provider: "p",
      model: "m",
    });
    expect(outcome.kind).toBe("success");
    expect(attempts).toEqual([1, 2]);
    expect(sleeps).toEqual([50]);

    // A NON-retryable failure (the corrupted-source 400) is never retried.
    const nonRetryableCalls: number[] = [];
    const transformation = {
      railId: "t",
      mode: "image-to-image" as const,
      dispatch: async () => {
        nonRetryableCalls.push(nonRetryableCalls.length + 1);
        return {
          kind: "failure" as const,
          category: "invalid-request",
          message: "the input image is corrupted",
          retryable: false,
        };
      },
    };
    const failingBinding = createImagegenDispatchBinding({
      transformation,
      transportCalls: { count: 0 },
      retry: { attempts: 2, delayMs: 0, sleep: async () => {} },
    });
    const failedOutcome = await failingBinding({
      executionId: "e2",
      task: { kind: "transform-image", source: "img-corrupt", edit: "img-edit-004" },
      provider: "p",
      model: "m",
    });
    expect(failedOutcome).toMatchObject({ kind: "failure", category: "invalid-request" });
    expect(nonRetryableCalls).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// The driver (lifecycle order + honest terminals)
// ---------------------------------------------------------------------------

describe("VAL-015 execution driver", () => {
  test("drives the canonical lifecycle with the planning decision before dispatch", async () => {
    const { lifecycle, transitions } = recordingLifecycle();
    const dispatchTransitions: string[] = [];
    const png = syntheticGeneratedPng(1328, 1328);
    const result = await driveImagegenExecution({
      executionId: "exec-1",
      task: GENERATION_TASK,
      provider: "dashscope",
      model: "qwen-image-2.0",
      ports: {
        lifecycle,
        dispatch: async () => {
          dispatchTransitions.push(...transitions);
          return {
            kind: "success",
            image: { bytes: png, mimeType: "image/png", width: 1328, height: 1328 },
            usage: { inputTokens: 0, outputTokens: 1 },
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
    expect(result.imageDigest).toBe(mediaDigest(png));
    expect(result.imageDimensions).toEqual({ width: 1328, height: 1328 });
    expect(result.requestDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  test("a provider failure completes as FAILED (never COMPLETED)", async () => {
    const { lifecycle, transitions } = recordingLifecycle();
    const result = await driveImagegenExecution({
      executionId: "exec-2",
      task: { kind: "transform-image", source: "img-corrupt", edit: "img-edit-004" },
      provider: "dashscope",
      model: "m",
      ports: {
        lifecycle,
        dispatch: async () => ({
          kind: "failure",
          category: "invalid-request",
          message: "the input image is corrupted",
          retryable: false,
        }),
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(transitions).toContain("complete:fail");
    expect(result.usage).toBeNull();
    expect(result.imageDigest).toBeNull();
    expect(result.criteria).toHaveLength(1);
    expect(result.criteria[0]?.status).toBe("FAIL");
  });

  test("a missing fixture aborts BEFORE any lifecycle mutation (NOT RUN)", async () => {
    const { lifecycle, transitions } = recordingLifecycle();
    await expect(
      driveImagegenExecution({
        executionId: "exec-3",
        task: { kind: "generate-image", prompt: "img-prompt-999" },
        provider: "p",
        model: "m",
        ports: {
          lifecycle,
          dispatch: async () => ({
            kind: "success",
            image: { bytes: Buffer.alloc(8), mimeType: "image/unknown", width: null, height: null },
          }),
          now: () => new Date(1_000_000),
        },
      }),
    ).rejects.toThrow(ImagegenFixtureNotMaterializedError);
    expect(transitions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal structural JPEG (SOI + SOF0 + EOI) declaring WxH. */
function minimalJpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(17);
  sof[0] = 0xff;
  sof[1] = 0xc0;
  sof.writeUInt16BE(15, 2); // segment length
  sof[4] = 8; // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3; // components
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

/**
 * Re-encode a decoded PNG as a new canvas image with one rectangular
 * patch applied — a pixel-faithful replica plus a controlled change
 * (the discrimination tests' controlled fake outputs).
 */
function repaintWithPatch(
  sourcePng: Buffer,
  patch: { x0: number; y0: number; x1: number; y1: number },
  color: readonly [number, number, number],
): Buffer {
  const decoded = decodePngToRgb(sourcePng);
  expect(decoded).not.toBeNull();
  const raster = decoded as NonNullable<ReturnType<typeof decodePngToRgb>>;
  const canvas = createCanvas(raster.width, raster.height);
  for (let y = 0; y < raster.height; y += 1) {
    let runStart = 0;
    while (runStart < raster.width) {
      const colorAt = (x: number): readonly [number, number, number] => [
        raster.rgb[(y * raster.width + x) * 3] ?? 0,
        raster.rgb[(y * raster.width + x) * 3 + 1] ?? 0,
        raster.rgb[(y * raster.width + x) * 3 + 2] ?? 0,
      ];
      const runColor = colorAt(runStart);
      let runEnd = runStart + 1;
      while (
        runEnd < raster.width &&
        colorAt(runEnd)[0] === runColor[0] &&
        colorAt(runEnd)[1] === runColor[1] &&
        colorAt(runEnd)[2] === runColor[2]
      ) {
        runEnd += 1;
      }
      canvas.fillRect(runStart, y, runEnd, y + 1, runColor);
      runStart = runEnd;
    }
  }
  canvas.fillRect(patch.x0, patch.y0, patch.x1, patch.y1, color);
  return canvas.toPng();
}
