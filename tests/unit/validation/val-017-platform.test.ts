/**
 * VAL-017 platform unit tests: the multimodal derivations (pure), the
 * REAL rails over controlled fake transports (no network), and the
 * dispatch binding's pre-dispatch discriminations.
 *
 * Honesty invariants under test:
 *   * a missing media fixture is a NOT RUN boundary (thrown BEFORE any
 *     lifecycle mutation);
 *   * verification oracles come from the fixture/corpus ground truth —
 *     a provider failure FAILS the run, a missing oracle term fails its
 *     criterion, empty content fails the presence criterion;
 *   * the rails normalize REAL provider response shapes (string or
 *     parts-array content; usage; cost) and map HTTP failures to the
 *     provider-failure taxonomy honestly (400 invalid-request is NOT
 *     retryable — the corrupted-media edge is a genuine failure);
 *   * the binding rejects digest mismatches and wrong-modality requests
 *     BEFORE any network effect.
 */

import { describe, expect, test, vi } from "vitest";
import { AUDIO_UNDERSTANDING_TASKS } from "../../../benchmarks/validation/apps/audio-understanding/application";
import { IMAGE_RECOGNITION_TASKS } from "../../../benchmarks/validation/apps/image-recognition/application";
import {
  audioFixture,
  imageFixture,
  mediaDigest,
} from "../../../benchmarks/validation/apps/shared/media";
import { VLM_TASKS } from "../../../benchmarks/validation/apps/vlm/application";
import type { PlatformLifecyclePort } from "../../../benchmarks/validation/platform/driver";
import {
  createDashscopeAudioRail,
  createMultimodalDispatchBinding,
  createOpenRouterVisionRail,
  deriveMultimodalPlan,
  deriveMultimodalVerification,
  driveMultimodalExecution,
  type HttpTransport,
  MediaNotMaterializedError,
  type MultimodalTask,
  materializeTaskMedia,
  toDataUri,
} from "../../../benchmarks/validation/platform/multimodal";

// (import hoisting above; vi is used by the binding discrimination tests)

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
    calls.push({ url, body: JSON.parse(init.body) as unknown });
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

const BUS_TASK: MultimodalTask = {
  kind: "classify-image",
  image: "img-c-001",
  labels: ["bicycle", "bus", "car"],
};
const DOORBELL_TASK: MultimodalTask = {
  kind: "classify-audio",
  clip: "event-001",
  labels: ["doorbell", "alarm", "music"],
};

// ---------------------------------------------------------------------------
// Materialization + plan derivation (pure)
// ---------------------------------------------------------------------------

describe("VAL-017 media materialization", () => {
  test("every pinned fixture materializes deterministically (same bytes, same digest)", () => {
    for (const task of [...IMAGE_RECOGNITION_TASKS, ...VLM_TASKS, ...AUDIO_UNDERSTANDING_TASKS]) {
      const first = materializeTaskMedia(task);
      const second = materializeTaskMedia(task);
      expect(first.bytes.equals(second.bytes)).toBe(true);
      expect(first.digest).toBe(second.digest);
      expect(first.digest).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  test("corrupt fixtures materialize as genuinely corrupted bytes", () => {
    const corruptImage = materializeTaskMedia({
      kind: "classify-image",
      image: "img-corrupt",
      labels: ["x"],
    });
    expect(corruptImage.annotation).toBe("corrupt");
    expect(corruptImage.bytes.length).toBe(8 + 64);
    const corruptAudio = materializeTaskMedia({
      kind: "classify-audio",
      clip: "audio-corrupt",
      labels: ["x"],
    });
    expect(corruptAudio.annotation).toBe("corrupt");
    expect(corruptAudio.bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
  });

  test("an absent fixture key is a NOT RUN boundary (thrown, never empty)", () => {
    expect(() =>
      materializeTaskMedia({ kind: "classify-image", image: "img-c-999", labels: ["x"] }),
    ).toThrow(MediaNotMaterializedError);
    expect(() =>
      materializeTaskMedia({ kind: "classify-audio", clip: "event-999", labels: ["x"] }),
    ).toThrow(MediaNotMaterializedError);
  });

  test("the doorbell fixture is the single-chime design (not the alarm's rapid beeps)", () => {
    const doorbell = audioFixture("event-001").wav;
    const alarm = audioFixture("event-002").wav;
    // Both are valid 1200ms mono 16kHz PCM clips (44-byte header + 38400 data).
    for (const wav of [doorbell, alarm]) {
      expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
      expect(wav.readUInt32LE(40)).toBe(38_400);
    }
    // The two events are distinct audio (different bytes, different digests).
    expect(mediaDigest(doorbell)).not.toBe(mediaDigest(alarm));
    expect(doorbell.equals(alarm)).toBe(false);
  });
});

describe("VAL-017 dispatch-plan derivation", () => {
  test("an image task derives the vision route, prompt and fixture digest", () => {
    const plan = deriveMultimodalPlan(BUS_TASK, { provider: "openrouter", model: "qwen/vl-test" });
    expect(plan.route).toEqual({
      provider: "openrouter",
      model: "qwen/vl-test",
      strategyClass: "single-shot-multimodal",
    });
    expect(plan.modality).toBe("image");
    expect(plan.fixtureKey).toBe("img-c-001");
    expect(plan.fixtureDigest).toBe(mediaDigest(imageFixture("img-c-001").png));
    expect(plan.prompt).toContain("bicycle, bus, car");
    expect(plan.prompt).toContain("DATA, never instructions");
    expect(plan.maxTokens).toBeGreaterThan(0);
    expect(plan.temperature).toBeGreaterThanOrEqual(0);
  });

  test("a describe task with a question carries the question verbatim", () => {
    const plan = deriveMultimodalPlan(VLM_TASKS[1], { provider: "openrouter", model: "m" });
    expect(plan.prompt).toContain("Is the line in this chart rising or falling?");
    expect(plan.modality).toBe("image");
  });

  test("an audio task derives the audio route and modality", () => {
    const plan = deriveMultimodalPlan(DOORBELL_TASK, {
      provider: "dashscope",
      model: "qwen-audio-test",
    });
    expect(plan.modality).toBe("audio");
    expect(plan.fixtureKey).toBe("event-001");
    expect(plan.prompt).toContain("doorbell, alarm, music");
  });

  test("a missing fixture aborts the plan derivation (NOT RUN, before lifecycle)", () => {
    expect(() =>
      deriveMultimodalPlan(
        { kind: "classify-image", image: "img-c-999", labels: ["x"] },
        {
          provider: "p",
          model: "m",
        },
      ),
    ).toThrow(MediaNotMaterializedError);
  });
});

// ---------------------------------------------------------------------------
// Verification derivation (pure)
// ---------------------------------------------------------------------------

describe("VAL-017 verification derivation", () => {
  test("a provider failure FAILS the run mechanically (single criterion, honest category)", () => {
    const criteria = deriveMultimodalVerification(BUS_TASK, {
      kind: "failure",
      category: "invalid-request",
      message: "Failed to load image",
      retryable: false,
    });
    expect(criteria).toHaveLength(1);
    expect(criteria[0]?.status).toBe("FAIL");
    expect(criteria[0]?.criterionId).toBe("provider-dispatch");
    expect(criteria[0]?.evidence[0]).toBe("provider-failure:invalid-request");
  });

  test("oracle terms are matched case-insensitively against the output", () => {
    const criteria = deriveMultimodalVerification(
      BUS_TASK,
      { kind: "success", content: "The BUS is yellow." },
      {
        containsText: ["bus"],
      },
    );
    expect(criteria.map((c) => c.status)).toEqual(["PASS", "PASS"]);
    expect(criteria[0]?.criterionId).toBe("contains:bus");
  });

  test("a missing oracle term fails its criterion (ground truth, never re-derived)", () => {
    const criteria = deriveMultimodalVerification(
      BUS_TASK,
      { kind: "success", content: "a train" },
      {
        containsText: ["bus"],
      },
    );
    expect(criteria.map((c) => c.status)).toEqual(["FAIL", "PASS"]);
  });

  test("empty content fails the presence criterion", () => {
    const criteria = deriveMultimodalVerification(
      BUS_TASK,
      { kind: "success", content: "   " },
      {
        containsText: ["bus"],
      },
    );
    expect(criteria.map((c) => c.status)).toEqual(["FAIL", "FAIL"]);
  });

  test("criteria evidence carries the fixture digest, never the payload", () => {
    const criteria = deriveMultimodalVerification(
      DOORBELL_TASK,
      { kind: "success", content: "doorbell" },
      {
        containsText: ["doorbell"],
      },
    );
    const evidence = criteria.flatMap((c) => c.evidence).join(" ");
    expect(evidence).toContain(`digest:${mediaDigest(audioFixture("event-001").wav)}`);
    expect(evidence).not.toContain("base64");
    expect(evidence).not.toContain("RIFF");
  });
});

// ---------------------------------------------------------------------------
// The REAL rails over fake transports (no network)
// ---------------------------------------------------------------------------

describe("VAL-017 OpenRouter vision rail (fake transport)", () => {
  test("a success outcome parses content (string shape), usage and cost", async () => {
    const { transport, calls } = scriptedTransport(() =>
      jsonResponse(200, {
        choices: [{ message: { content: "bus" } }],
        usage: { prompt_tokens: 89, completion_tokens: 2, cost: 0.0000668 },
      }),
    );
    const rail = createOpenRouterVisionRail({ transport, apiKey: "test-key" });
    const outcome = await rail.dispatch({
      model: "qwen/vl",
      prompt: "Classify.",
      mediaDataUri: toDataUri(imageFixture("img-c-001").png, "image/png"),
      maxTokens: 96,
      temperature: 0.1,
    });
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.content).toBe("bus");
      expect(outcome.usage?.inputTokens).toBe(89);
      expect(outcome.usage?.costUsd).toBe(0.0000668);
    }
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = calls[0]?.body as { messages: { content: unknown[] }[] };
    expect(body.messages[0]?.content[1]).toMatchObject({ type: "image_url" });
  });

  test("a parts-array content shape normalizes to joined text", async () => {
    const { transport } = scriptedTransport(() =>
      jsonResponse(200, {
        choices: [{ message: { content: [{ type: "text", text: "bicycle" }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 1 },
      }),
    );
    const rail = createOpenRouterVisionRail({ transport, apiKey: "k" });
    const outcome = await rail.dispatch({
      model: "m",
      prompt: "p",
      mediaDataUri: toDataUri(imageFixture("img-c-002").png, "image/png"),
      maxTokens: 96,
      temperature: 0.1,
    });
    expect(outcome.kind === "success" ? outcome.content : "").toBe("bicycle");
  });

  test("an empty completion is an honest failure (retryable), not a fabricated pass", async () => {
    const { transport } = scriptedTransport(() =>
      jsonResponse(200, { choices: [{ message: { content: "" } }] }),
    );
    const rail = createOpenRouterVisionRail({ transport, apiKey: "k" });
    const outcome = await rail.dispatch({
      model: "m",
      prompt: "p",
      mediaDataUri: "data:image/png;base64,eA==",
      maxTokens: 96,
      temperature: 0.1,
    });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "empty-completion",
      retryable: true,
    });
  });

  test("HTTP failures map to the provider-failure taxonomy honestly", async () => {
    const cases: [number, unknown, { category: string; retryable: boolean }][] = [
      [
        400,
        { error: { message: "Failed to load image" } },
        { category: "invalid-request", retryable: false },
      ],
      [401, { error: { message: "bad key" } }, { category: "auth", retryable: false }],
      [
        404,
        { error: { message: "no endpoints" } },
        { category: "model-unavailable", retryable: false },
      ],
      [429, { error: { message: "rate limited" } }, { category: "rate-limit", retryable: true }],
      [
        503,
        { error: { message: "upstream down" } },
        { category: "provider-unavailable", retryable: true },
      ],
    ];
    for (const [status, body, expected] of cases) {
      const { transport } = scriptedTransport(() => jsonResponse(status, body));
      const rail = createOpenRouterVisionRail({ transport, apiKey: "k" });
      const outcome = await rail.dispatch({
        model: "m",
        prompt: "p",
        mediaDataUri: "data:image/png;base64,eA==",
        maxTokens: 96,
        temperature: 0.1,
      });
      expect(outcome).toMatchObject({ kind: "failure", ...expected });
    }
  });

  test("a transport exception is a retryable transport failure", async () => {
    const { transport } = scriptedTransport(() => {
      throw new Error("ECONNRESET");
    });
    const rail = createOpenRouterVisionRail({ transport, apiKey: "k" });
    const outcome = await rail.dispatch({
      model: "m",
      prompt: "p",
      mediaDataUri: "data:image/png;base64,eA==",
      maxTokens: 96,
      temperature: 0.1,
    });
    expect(outcome).toMatchObject({ kind: "failure", category: "transport", retryable: true });
  });
});

describe("VAL-017 dashscope audio rail (fake transport)", () => {
  test("a success outcome parses content and usage (audio parts wire shape)", async () => {
    const { transport, calls } = scriptedTransport(() =>
      jsonResponse(200, {
        choices: [{ message: { content: "doorbell" } }],
        usage: { prompt_tokens: 43, completion_tokens: 1 },
      }),
    );
    const rail = createDashscopeAudioRail({ transport, apiKey: "test-key" });
    const outcome = await rail.dispatch({
      model: "qwen3-omni-flash",
      prompt: "Classify.",
      mediaDataUri: toDataUri(audioFixture("event-001").wav, "audio/wav"),
      maxTokens: 96,
      temperature: 0.1,
    });
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.content).toBe("doorbell");
      expect(outcome.usage?.inputTokens).toBe(43);
      expect(outcome.usage?.costUsd).toBeUndefined();
    }
    expect(calls[0]?.url).toBe(
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
    );
    const body = calls[0]?.body as { messages: { content: unknown[] }[]; temperature: number };
    expect(body.messages[0]?.content[0]).toMatchObject({ type: "input_audio" });
    expect(body.temperature).toBe(0.1);
  });

  test("a 400 on corrupted audio is an honest invalid-request failure (not retryable)", async () => {
    const { transport } = scriptedTransport(() =>
      jsonResponse(400, {
        error: {
          message: "The audio is empty",
          type: "invalid_request_error",
          code: "invalid_parameter_error",
        },
      }),
    );
    const rail = createDashscopeAudioRail({ transport, apiKey: "k" });
    const outcome = await rail.dispatch({
      model: "m",
      prompt: "p",
      mediaDataUri: "data:audio/wav;base64,eA==",
      maxTokens: 96,
      temperature: 0.1,
    });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "invalid-request",
      retryable: false,
    });
  });
});

// ---------------------------------------------------------------------------
// The dispatch binding (pre-dispatch discriminations)
// ---------------------------------------------------------------------------

describe("VAL-017 dispatch binding", () => {
  test("routes image tasks to the vision rail and audio tasks to the audio rail", async () => {
    const vision = {
      railId: "v",
      modality: "image" as const,
      dispatch: async () => ({ kind: "success" as const, content: "bus" }),
    };
    const audio = {
      railId: "a",
      modality: "audio" as const,
      dispatch: async () => ({ kind: "success" as const, content: "doorbell" }),
    };
    const calls = { count: 0 };
    const binding = createMultimodalDispatchBinding({ vision, audio, transportCalls: calls });
    const imageOutcome = await binding({
      executionId: "e1",
      task: BUS_TASK,
      provider: "openrouter",
      model: "m",
    });
    expect(imageOutcome).toMatchObject({ kind: "success", content: "bus" });
    const audioOutcome = await binding({
      executionId: "e2",
      task: DOORBELL_TASK,
      provider: "dashscope",
      model: "m",
    });
    expect(audioOutcome).toMatchObject({ kind: "success", content: "doorbell" });
    expect(calls.count).toBe(2);
  });

  test("a tampered materialization (digest mismatch) is rejected BEFORE any dispatch", async () => {
    const dispatch = vi.fn();
    const vision = { railId: "v", modality: "image" as const, dispatch };
    const binding = createMultimodalDispatchBinding({
      vision,
      materialize: (task) => ({
        ...materializeTaskMedia(task),
        bytes: Buffer.alloc(8, 0x00),
        digest: "0000000000000000",
      }),
      transportCalls: { count: 0 },
    });
    const outcome = await binding({ executionId: "e", task: BUS_TASK, provider: "p", model: "m" });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "fixture-digest-mismatch",
      retryable: false,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("a task whose modality has no rail is rejected BEFORE any dispatch", async () => {
    const dispatch = vi.fn();
    const vision = { railId: "v", modality: "image" as const, dispatch };
    // Only the vision rail is configured: audio tasks must be rejected.
    const binding = createMultimodalDispatchBinding({ vision, transportCalls: { count: 0 } });
    const outcome = await binding({
      executionId: "e",
      task: DOORBELL_TASK,
      provider: "p",
      model: "m",
    });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "wrong-modality",
      retryable: false,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("the bounded retry policy retries RETRYABLE failures only, with REAL attempts", async () => {
    const attempts: number[] = [];
    const sleeps: number[] = [];
    const vision = {
      railId: "v",
      modality: "image" as const,
      dispatch: async () => {
        attempts.push(attempts.length + 1);
        if (attempts.length === 1) {
          // First attempt: a retryable rate limit.
          return {
            kind: "failure" as const,
            category: "rate-limit",
            message: "429",
            retryable: true,
          };
        }
        return { kind: "success" as const, content: "bus" };
      },
    };
    const binding = createMultimodalDispatchBinding({
      vision,
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
      task: BUS_TASK,
      provider: "p",
      model: "m",
    });
    expect(outcome).toMatchObject({ kind: "success", content: "bus" });
    expect(attempts).toEqual([1, 2]);
    expect(sleeps).toEqual([50]);

    // A NON-retryable failure (the corrupted-media 400) is never retried.
    const nonRetryableCalls: number[] = [];
    const failingVision = {
      railId: "v",
      modality: "image" as const,
      dispatch: async () => {
        nonRetryableCalls.push(nonRetryableCalls.length + 1);
        return {
          kind: "failure" as const,
          category: "invalid-request",
          message: "bad image",
          retryable: false,
        };
      },
    };
    const failingBinding = createMultimodalDispatchBinding({
      vision: failingVision,
      transportCalls: { count: 0 },
      retry: { attempts: 2, delayMs: 0, sleep: async () => {} },
    });
    const failedOutcome = await failingBinding({
      executionId: "e2",
      task: BUS_TASK,
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

describe("VAL-017 execution driver", () => {
  test("drives the canonical lifecycle with the planning decision before dispatch", async () => {
    const { lifecycle, transitions } = recordingLifecycle();
    const dispatchTransitions: string[] = [];
    const result = await driveMultimodalExecution({
      executionId: "exec-1",
      task: BUS_TASK,
      provider: "openrouter",
      model: "m",
      oracle: { containsText: ["bus"] },
      ports: {
        lifecycle,
        dispatch: async () => {
          // Snapshot the lifecycle state AT dispatch time: the planning
          // decision must already be recorded (intent before effect).
          dispatchTransitions.push(...transitions);
          return { kind: "success", content: "bus" };
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
  });

  test("a provider failure completes as FAILED (never COMPLETED)", async () => {
    const { lifecycle, transitions } = recordingLifecycle();
    const result = await driveMultimodalExecution({
      executionId: "exec-2",
      task: { kind: "classify-image", image: "img-corrupt", labels: ["bicycle", "bus", "car"] },
      provider: "openrouter",
      model: "m",
      ports: {
        lifecycle,
        dispatch: async () => ({
          kind: "failure",
          category: "invalid-request",
          message: "Failed to load image: cannot identify image file",
          retryable: false,
        }),
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(transitions).toContain("complete:fail");
    expect(result.usage).toBeNull();
    expect(result.criteria).toHaveLength(1);
    expect(result.criteria[0]?.status).toBe("FAIL");
  });

  test("a missing fixture aborts BEFORE any lifecycle mutation (NOT RUN)", async () => {
    const { lifecycle, transitions } = recordingLifecycle();
    await expect(
      driveMultimodalExecution({
        executionId: "exec-3",
        task: { kind: "classify-image", image: "img-c-999", labels: ["x"] },
        provider: "p",
        model: "m",
        ports: {
          lifecycle,
          dispatch: async () => ({ kind: "success", content: "x" }),
          now: () => new Date(1_000_000),
        },
      }),
    ).rejects.toThrow(MediaNotMaterializedError);
    expect(transitions).toEqual([]);
  });
});
