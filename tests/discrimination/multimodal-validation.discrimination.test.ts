/**
 * VAL-017 acceptance criterion 6 — discrimination tests proving the
 * multimodal derivations against controlled fakes:
 *
 *   * fixture digest mismatches (a tampered/swapped materialization is
 *     detected and the run fails BEFORE any network effect);
 *   * wrong-modality requests (a task whose modality has no configured
 *     rail is rejected BEFORE any network effect);
 *   * provider failures (a REAL 400 on genuinely corrupted media, a
 *     rate-limit, an empty completion) fail the execution honestly —
 *     never a fabricated completion;
 *   * oracle provenance (a successful dispatch whose output misses the
 *     ground-truth term fails its criterion — no provider-success
 *     shortcut).
 */

import { describe, expect, test, vi } from "vitest";
import { audioFixture, imageFixture } from "../../benchmarks/validation/apps/shared/media";
import type { PlatformLifecyclePort } from "../../benchmarks/validation/platform/driver";
import {
  createDashscopeAudioRail,
  createMultimodalDispatchBinding,
  createOpenRouterVisionRail,
  deriveMultimodalVerification,
  driveMultimodalExecution,
  type HttpTransport,
  type MultimodalTask,
  materializeTaskMedia,
  toDataUri,
} from "../../benchmarks/validation/platform/multimodal";

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

function countingTransport(response: () => Response): {
  readonly transport: HttpTransport;
  readonly calls: { url: string; body: unknown }[];
} {
  const calls: { url: string; body: unknown }[] = [];
  const transport: HttpTransport = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as unknown });
    return response();
  };
  return { transport, calls };
}

describe("multimodal validation discrimination (VAL-017 AC6)", () => {
  test("a tampered fixture materialization fails the run before ANY network effect", async () => {
    const { transport, calls } = countingTransport(() =>
      jsonResponse(200, { choices: [{ message: { content: "bus" } }] }),
    );
    const vision = createOpenRouterVisionRail({ transport, apiKey: "k" });
    const binding = createMultimodalDispatchBinding({
      vision,
      // The controlled fake: the materialization layer returns different
      // bytes (and digest) than the plan derived — the swap is detected.
      materialize: (task) => ({
        ...materializeTaskMedia(task),
        bytes: imageFixture("img-c-002").png,
        digest: "deadbeefdeadbeef",
      }),
      transportCalls: { count: 0 },
    });
    const { lifecycle, completions } = recordingLifecycle();
    const result = await driveMultimodalExecution({
      executionId: "exec-digest",
      task: BUS_TASK,
      provider: "openrouter",
      model: "m",
      oracle: { containsText: ["bus"] },
      ports: { lifecycle, dispatch: binding, now: () => new Date(1_000_000) },
    });
    expect(result.terminal).toBe("FAILED");
    expect(calls).toHaveLength(0);
    expect(completions[0]?.criteria[0]?.criterionId).toBe("provider-dispatch");
    expect(result.criteria[0]?.evidence[0]).toBe("provider-failure:fixture-digest-mismatch");
  });

  test("a wrong-modality request (audio task, vision-only rails) fails before ANY network effect", async () => {
    const { transport, calls } = countingTransport(() =>
      jsonResponse(200, { choices: [{ message: { content: "doorbell" } }] }),
    );
    const vision = createOpenRouterVisionRail({ transport, apiKey: "k" });
    const binding = createMultimodalDispatchBinding({ vision, transportCalls: { count: 0 } });
    const result = await driveMultimodalExecution({
      executionId: "exec-modality",
      task: DOORBELL_TASK,
      provider: "dashscope",
      model: "m",
      oracle: { containsText: ["doorbell"] },
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

  test("a REAL 400 on genuinely corrupted media fails the execution (never completed)", async () => {
    // The exact provider response shape a corrupted PNG produces on the
    // real OpenRouter rail (probed live): HTTP 400, provider message.
    const { transport, calls } = countingTransport(() =>
      jsonResponse(400, {
        error: {
          message: "Provider returned error",
          code: 400,
          metadata: {
            raw: '{"error":{"message":"Failed to load image: cannot identify image file"}}',
          },
        },
      }),
    );
    const vision = createOpenRouterVisionRail({ transport, apiKey: "k" });
    const binding = createMultimodalDispatchBinding({ vision, transportCalls: { count: 0 } });
    const result = await driveMultimodalExecution({
      executionId: "exec-corrupt",
      task: { kind: "classify-image", image: "img-corrupt", labels: ["bicycle", "bus", "car"] },
      provider: "openrouter",
      model: "m",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: binding,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.usage).toBeNull();
    // The dispatched payload WAS the genuine corrupt fixture bytes.
    const body = calls[0]?.body as {
      messages: { content: { type: string; image_url?: { url: string } }[] }[];
    };
    const sent = body.messages[0]?.content[1]?.image_url?.url ?? "";
    expect(sent).toBe(
      toDataUri(
        materializeTaskMedia({ kind: "classify-image", image: "img-corrupt", labels: ["x"] }).bytes,
        "image/png",
      ),
    );
  });

  test("a corrupted-audio 400 on the real dashscope shape fails the execution", async () => {
    const { transport, calls } = countingTransport(() =>
      jsonResponse(400, {
        error: {
          message: "<400> InternalError.Algo.InvalidParameter: The audio is empty",
          type: "invalid_request_error",
          code: "invalid_parameter_error",
        },
      }),
    );
    const audio = createDashscopeAudioRail({ transport, apiKey: "k" });
    const binding = createMultimodalDispatchBinding({ audio, transportCalls: { count: 0 } });
    const result = await driveMultimodalExecution({
      executionId: "exec-audio-corrupt",
      task: {
        kind: "classify-audio",
        clip: "audio-corrupt",
        labels: ["doorbell", "alarm", "music"],
      },
      provider: "dashscope",
      model: "m",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: binding,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.criteria[0]?.evidence[0]).toBe("provider-failure:invalid-request");
    const body = calls[0]?.body as {
      messages: { content: { type: string; input_audio?: { data: string } }[] }[];
    };
    const sent = body.messages[0]?.content[0]?.input_audio?.data ?? "";
    expect(sent).toBe(toDataUri(audioFixture("audio-corrupt").wav, "audio/wav"));
  });

  test("a rate-limit provider failure is honestly classified retryable and fails the run", async () => {
    const { transport } = countingTransport(() =>
      jsonResponse(429, { error: { message: "rate limited" } }),
    );
    const vision = createOpenRouterVisionRail({ transport, apiKey: "k" });
    const binding = createMultimodalDispatchBinding({ vision, transportCalls: { count: 0 } });
    const result = await driveMultimodalExecution({
      executionId: "exec-rate",
      task: BUS_TASK,
      provider: "openrouter",
      model: "m",
      oracle: { containsText: ["bus"] },
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: binding,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.criteria[0]?.evidence).toContain("provider-failure:rate-limit");
    expect(result.criteria[0]?.evidence).toContain("retryable:true");
  });

  test("a 'successful' empty completion still fails (no fabricated content)", async () => {
    const { transport } = countingTransport(() =>
      jsonResponse(200, { choices: [{ message: { content: "" } }] }),
    );
    const vision = createOpenRouterVisionRail({ transport, apiKey: "k" });
    const binding = createMultimodalDispatchBinding({ vision, transportCalls: { count: 0 } });
    const result = await driveMultimodalExecution({
      executionId: "exec-empty",
      task: BUS_TASK,
      provider: "openrouter",
      model: "m",
      oracle: { containsText: ["bus"] },
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: binding,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.criteria[0]?.evidence[0]).toBe("provider-failure:empty-completion");
  });

  test("oracle provenance: a successful dispatch missing the ground-truth term fails its criterion", () => {
    // The dispatch SUCCEEDED (content arrived) but the model output
    // contradicts the fixture's ground truth ("train" is not "bus") —
    // the mechanical oracle fails the run; there is no success shortcut.
    const criteria = deriveMultimodalVerification(
      BUS_TASK,
      { kind: "success", content: "a train on tracks" },
      {
        containsText: ["bus"],
      },
    );
    expect(criteria.map((c) => c.status)).toEqual(["FAIL", "PASS"]);
    const anyFail = criteria.some((c) => c.status === "FAIL");
    expect(anyFail).toBe(true);
  });

  test("the vision rail never receives audio bytes and the audio rail never receives image bytes", async () => {
    type RailDispatchInput = {
      readonly model: string;
      readonly prompt: string;
      readonly mediaDataUri: string;
      readonly maxTokens: number;
      readonly temperature: number;
    };
    const visionDispatch = vi.fn(async (_input: RailDispatchInput) => ({
      kind: "success" as const,
      content: "bus",
    }));
    const audioDispatch = vi.fn(async (_input: RailDispatchInput) => ({
      kind: "success" as const,
      content: "doorbell",
    }));
    const binding = createMultimodalDispatchBinding({
      vision: { railId: "v", modality: "image", dispatch: visionDispatch },
      audio: { railId: "a", modality: "audio", dispatch: audioDispatch },
      transportCalls: { count: 0 },
    });
    await binding({ executionId: "e1", task: BUS_TASK, provider: "p", model: "m" });
    expect(visionDispatch).toHaveBeenCalledTimes(1);
    const visionMedia = visionDispatch.mock.calls[0]?.[0]?.mediaDataUri ?? "";
    expect(visionMedia.startsWith("data:image/png;base64,")).toBe(true);
    await binding({ executionId: "e2", task: DOORBELL_TASK, provider: "p", model: "m" });
    expect(audioDispatch).toHaveBeenCalledTimes(1);
    const audioMedia = audioDispatch.mock.calls[0]?.[0]?.mediaDataUri ?? "";
    expect(audioMedia.startsWith("data:audio/wav;base64,")).toBe(true);
  });
});
