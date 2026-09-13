/**
 * VAL-015 acceptance criterion 6 — discrimination tests proving the
 * imagegen derivations against controlled fakes:
 *
 *   * fixture digest mismatches (a tampered/swapped materialization is
 *     detected and the run fails BEFORE any network effect);
 *   * wrong-modality requests (a task whose mode has no configured
 *     rail is rejected BEFORE any network effect);
 *   * provider failures (a REAL 400 shape on genuinely corrupted
 *     source media; a rate-limit) fail the execution honestly — never
 *     a fabricated completion;
 *   * malformed raster payloads (valid base64 of garbage bytes) FAIL
 *     the mechanical container criterion — never a silent completion;
 *   * retry honesty (RETRYABLE failures retried exactly per policy;
 *     non-retryable failures never retried);
 *   * empty-output honesty (a 200 without an image payload fails);
 *   * oracle provenance (a "successful" transformation whose changed
 *     region misses the fixture's declared target region fails its
 *     criterion — no provider-success shortcut);
 *   * request reproducibility (the same task always derives the same
 *     canonical request body; different tasks derive different
 *     request digests).
 */

import { describe, expect, test } from "vitest";
import { createCanvas, imageFixture } from "../../benchmarks/validation/apps/shared/media";
import type { PlatformLifecyclePort } from "../../benchmarks/validation/platform/driver";
import {
  buildImagegenRequestBody,
  createDashscopeImagegenRail,
  createImagegenDispatchBinding,
  deriveImagegenPlan,
  deriveImagegenVerification,
  driveImagegenExecution,
  type HttpTransport,
  type ImagegenTask,
  materializeImagegenInput,
  toImageDataUri,
} from "../../benchmarks/validation/platform/imagegen";
import { decodePngToRgb } from "../../benchmarks/validation/platform/imagegen-raster";

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

function recordingLifecycle(): {
  readonly lifecycle: PlatformLifecyclePort;
  readonly transitions: string[];
  readonly completions: { verdict: string; criteria: { criterionId: string; status: string }[] }[];
} {
  const transitions: string[] = [];
  const completions: { verdict: string; criteria: { criterionId: string; status: string }[] }[] =
    [];
  const lifecycle: PlatformLifecyclePort = {
    async transition({ step }) {
      transitions.push(step);
    },
    async recordPlanningDecision() {
      transitions.push("planning-decision");
    },
    async complete({ verdict, criteria }) {
      completions.push({
        verdict,
        criteria: criteria.map((criterion) => ({
          criterionId: criterion.criterionId,
          status: criterion.status,
        })),
      });
      transitions.push(`complete:${verdict}`);
    },
  };
  return { lifecycle, transitions, completions };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function countingTransport(responses: (Response | Error)[]): {
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
      throw new Error("counting transport exhausted");
    }
    return next;
  };
  return { transport, calls };
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

/** A pixel-faithful source replica plus one controlled patch. */
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

describe("imagegen validation discrimination (VAL-015 AC6)", () => {
  test("a tampered fixture materialization fails the run before ANY network effect", async () => {
    const { transport, calls } = countingTransport([
      jsonResponse(200, {
        output: {
          choices: [
            { message: { content: [{ image: toImageDataUri(syntheticGeneratedPng(256, 128)) }] } },
          ],
        },
      }),
    ]);
    const generation = createDashscopeImagegenRail({
      transport,
      apiKey: "k",
      mode: "text-to-image",
    });
    const binding = createImagegenDispatchBinding({
      generation,
      // The controlled fake: the materialization layer returns a
      // different prompt (and digest) than the plan derived.
      materialize: (task) => ({
        ...materializeImagegenInput(task),
        prompt: "a tampered prompt",
        promptDigest: "deadbeefdeadbeef",
      }),
      transportCalls: { count: 0 },
    });
    const { lifecycle, completions } = recordingLifecycle();
    const result = await driveImagegenExecution({
      executionId: "exec-digest",
      task: GENERATION_TASK,
      provider: "dashscope",
      model: "m",
      ports: { lifecycle, dispatch: binding, now: () => new Date(1_000_000) },
    });
    expect(result.terminal).toBe("FAILED");
    expect(calls).toHaveLength(0);
    expect(completions[0]?.criteria[0]?.criterionId).toBe("provider-dispatch");
    expect(result.criteria[0]?.evidence[0]).toBe("provider-failure:fixture-digest-mismatch");
  });

  test("a wrong-modality request (transform task, generation-only rails) fails before ANY network effect", async () => {
    const { transport, calls } = countingTransport([
      jsonResponse(200, {
        output: {
          choices: [
            { message: { content: [{ image: toImageDataUri(syntheticGeneratedPng(256, 128)) }] } },
          ],
        },
      }),
    ]);
    const generation = createDashscopeImagegenRail({
      transport,
      apiKey: "k",
      mode: "text-to-image",
    });
    const binding = createImagegenDispatchBinding({ generation, transportCalls: { count: 0 } });
    const result = await driveImagegenExecution({
      executionId: "exec-modality",
      task: TRANSFORM_TASK,
      provider: "dashscope",
      model: "m",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: binding,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(calls).toHaveLength(0);
    expect(result.criteria[0]?.evidence[0]).toBe("provider-failure:wrong-modality");
  });

  test("a REAL 400 on genuinely corrupted source media fails the execution (never completed)", async () => {
    // The exact provider response shape a corrupted source PNG produces
    // on the real dashscope rail: HTTP 400, provider code + message.
    const { transport, calls } = countingTransport([
      jsonResponse(400, {
        code: "InvalidParameter.ParameterImageError",
        message: "The input image is corrupted or not a valid image",
        request_id: "req-x",
      }),
    ]);
    const transformation = createDashscopeImagegenRail({
      transport,
      apiKey: "k",
      mode: "image-to-image",
    });
    const binding = createImagegenDispatchBinding({ transformation, transportCalls: { count: 0 } });
    const result = await driveImagegenExecution({
      executionId: "exec-corrupt",
      task: { kind: "transform-image", source: "img-corrupt", edit: "img-edit-004" },
      provider: "dashscope",
      model: "m",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: binding,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.usage).toBeNull();
    expect(result.criteria[0]?.evidence[0]).toBe("provider-failure:invalid-request");
    expect(result.criteria[0]?.evidence).toContain("retryable:false");
    // The dispatched payload WAS the genuine corrupt fixture bytes.
    expect(calls).toHaveLength(1);
    const body = calls[0]?.body as {
      input: { messages: { role: string; content: Record<string, string>[] }[] };
    };
    // 2026-09-12 shape re-pin: the corrupted source rides an image content part.
    const parts = body.input.messages[0]?.content ?? [];
    expect(parts.find((part) => part.image !== undefined)?.image).toBe(
      toImageDataUri(imageFixture("img-corrupt").png),
    );
  });

  test("a malformed raster payload (valid base64 of garbage) fails mechanically", async () => {
    const garbage = Buffer.alloc(512, 0xa5);
    const { transport, calls } = countingTransport([
      jsonResponse(200, {
        output: { choices: [{ message: { content: [{ image: toImageDataUri(garbage) }] } }] },
      }),
    ]);
    const generation = createDashscopeImagegenRail({
      transport,
      apiKey: "k",
      mode: "text-to-image",
    });
    const binding = createImagegenDispatchBinding({ generation, transportCalls: { count: 0 } });
    const result = await driveImagegenExecution({
      executionId: "exec-malformed",
      task: GENERATION_TASK,
      provider: "dashscope",
      model: "m",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: binding,
        now: () => new Date(1_000_000),
      },
    });
    // The dispatch SUCCEEDED at the transport level (one REAL call with
    // a 200), but the delivered payload is not a valid raster: the
    // mechanical criteria fail the execution — never a fabricated
    // completion.
    expect(calls).toHaveLength(1);
    expect(result.terminal).toBe("FAILED");
    const byId = new Map(result.criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("raster-container")).toBe("FAIL");
    expect(byId.get("dimensions-declared")).toBe("FAIL");
  });

  test("retry honesty: retryable failures retried exactly per policy; non-retryable never", async () => {
    // First attempt 429 (retryable), second attempt succeeds.
    const png = syntheticGeneratedPng(1328, 1328);
    const { transport, calls } = countingTransport([
      jsonResponse(429, { code: "Throttling", message: "rate limited" }),
      jsonResponse(200, {
        output: { choices: [{ message: { content: [{ image: toImageDataUri(png) }] } }] },
        usage: { image_count: 1 },
      }),
    ]);
    const generation = createDashscopeImagegenRail({
      transport,
      apiKey: "k",
      mode: "text-to-image",
    });
    const sleeps: number[] = [];
    const binding = createImagegenDispatchBinding({
      generation,
      transportCalls: { count: 0 },
      retry: {
        attempts: 2,
        delayMs: 25,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    });
    const result = await driveImagegenExecution({
      executionId: "exec-retry",
      task: GENERATION_TASK,
      provider: "dashscope",
      model: "m",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: binding,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(calls).toHaveLength(2); // exactly two REAL attempts
    expect(sleeps).toEqual([25]); // one bounded wait

    // A non-retryable 400 is attempted exactly once.
    const failing = countingTransport([
      jsonResponse(400, { code: "InvalidParameter", message: "bad size" }),
    ]);
    const failingRail = createDashscopeImagegenRail({
      transport: failing.transport,
      apiKey: "k",
      mode: "text-to-image",
    });
    const noRetryBinding = createImagegenDispatchBinding({
      generation: failingRail,
      transportCalls: { count: 0 },
      retry: { attempts: 2, delayMs: 0, sleep: async () => {} },
    });
    const failedResult = await driveImagegenExecution({
      executionId: "exec-no-retry",
      task: GENERATION_TASK,
      provider: "dashscope",
      model: "m",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: noRetryBinding,
        now: () => new Date(1_000_000),
      },
    });
    expect(failedResult.terminal).toBe("FAILED");
    expect(failedResult.criteria[0]?.evidence[0]).toBe("provider-failure:invalid-request");
    expect(failing.calls).toHaveLength(1); // never retried
  });

  test("a 'successful' response without an image payload still fails (empty-output honesty)", async () => {
    const { transport } = countingTransport([
      jsonResponse(200, { output: { choices: [{ message: { content: "no image here" } }] } }),
    ]);
    const generation = createDashscopeImagegenRail({
      transport,
      apiKey: "k",
      mode: "text-to-image",
    });
    const binding = createImagegenDispatchBinding({ generation, transportCalls: { count: 0 } });
    const result = await driveImagegenExecution({
      executionId: "exec-empty",
      task: GENERATION_TASK,
      provider: "dashscope",
      model: "m",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: binding,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.criteria[0]?.evidence[0]).toBe("provider-failure:empty-output");
  });

  test("oracle provenance: a 'successful' transform missing the target region fails its criterion", async () => {
    // The dispatch SUCCEEDED (a valid raster arrived) but the change
    // landed only OUTSIDE the fixture's declared target region — the
    // mechanical oracle (the edit fixture's own ground truth) fails the
    // run; there is no success shortcut.
    const offTargetOutput = repaintWithPatch(
      imageFixture("img-c-001").png,
      { x0: 0, y0: 0, x1: 10, y1: 10 },
      [10, 10, 10],
    );
    const { transport } = countingTransport([
      jsonResponse(200, {
        output: {
          choices: [{ message: { content: [{ image: toImageDataUri(offTargetOutput) }] } }],
        },
      }),
    ]);
    const transformation = createDashscopeImagegenRail({
      transport,
      apiKey: "k",
      mode: "image-to-image",
    });
    const binding = createImagegenDispatchBinding({ transformation, transportCalls: { count: 0 } });
    const result = await driveImagegenExecution({
      executionId: "exec-oracle",
      task: TRANSFORM_TASK,
      provider: "dashscope",
      model: "m",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: binding,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    const byId = new Map(result.criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("raster-container")).toBe("PASS"); // the payload was real
    expect(byId.get("change-present")).toBe("PASS"); // something did change
    expect(byId.get("changed-region-intersects-target")).toBe("FAIL");
    const evidence = result.criteria
      .find((c) => c.criterionId === "changed-region-intersects-target")
      ?.evidence.join(" ");
    expect(evidence).toContain("intersection:false");
  });

  test("request reproducibility: the same task always derives the same canonical request", async () => {
    // Same task → byte-identical request bodies (and digests).
    const sourcePng = imageFixture("img-c-001").png;
    const build = () =>
      buildImagegenRequestBody({
        model: "qwen-image-2.0",
        prompt: materializeImagegenInput(TRANSFORM_TASK).prompt,
        sourceDataUri: toImageDataUri(sourcePng),
      });
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
    const planFirst = deriveImagegenPlan(TRANSFORM_TASK, { provider: "p", model: "m" });
    const planSecond = deriveImagegenPlan(TRANSFORM_TASK, { provider: "p", model: "m" });
    expect(planFirst.requestDigest).toBe(planSecond.requestDigest);
    const other = deriveImagegenPlan(GENERATION_TASK, { provider: "p", model: "m" });
    expect(other.requestDigest).not.toBe(planFirst.requestDigest);

    // The dispatched body carries the exact seeded prompt and the
    // exact source data URI (asserted against the fixture bytes).
    const png = syntheticGeneratedPng(256, 128);
    const { transport, calls } = countingTransport([
      jsonResponse(200, {
        output: { choices: [{ message: { content: [{ image: toImageDataUri(png) }] } }] },
      }),
    ]);
    const transformation = createDashscopeImagegenRail({
      transport,
      apiKey: "k",
      mode: "image-to-image",
    });
    const binding = createImagegenDispatchBinding({ transformation, transportCalls: { count: 0 } });
    await binding({ executionId: "e", task: TRANSFORM_TASK, provider: "p", model: "m" });
    const body = calls[0]?.body as {
      model: string;
      input: { messages: { role: string; content: Record<string, string>[] }[] };
      parameters: { n: number };
    };
    // 2026-09-12 shape re-pin: the messages content grammar.
    const parts = body.input.messages[0]?.content ?? [];
    const textPart = parts.find((part) => part.text !== undefined)?.text ?? "";
    expect(textPart).toBe(materializeImagegenInput(TRANSFORM_TASK).prompt);
    expect(textPart).not.toContain("base64"); // prompt stays textual
    expect(parts.find((part) => part.image !== undefined)?.image).toBe(toImageDataUri(sourcePng));
    expect(body.parameters).toEqual({ n: 1 });
    // Evidence references never carry payloads — digest references only.
    const criteria = deriveImagegenVerification(TRANSFORM_TASK, {
      kind: "success",
      image: { bytes: png, mimeType: "image/png", width: 256, height: 128 },
    });
    const evidence = criteria.flatMap((c) => c.evidence).join(" ");
    expect(evidence).toContain("digest:");
    expect(evidence).not.toContain("base64");
    expect(evidence).not.toContain("data:image");
  });
});
