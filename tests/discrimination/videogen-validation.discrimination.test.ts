/**
 * VAL-016 acceptance criterion 6 — discrimination tests proving the
 * videogen derivations against controlled fakes (the five REQUIRED
 * classes of the governed spec, driven end to end through the
 * execution driver over scripted transports):
 *
 *   * fixture digest mismatches (a tampered materialization fails the
 *     run BEFORE any network effect — zero transport calls);
 *   * wrong-modality requests (a task kind outside the videogen
 *     vocabulary fails BEFORE any network effect);
 *   * provider failures (REAL dashscope error shapes: 401 auth, 429
 *     rate-limit with retry honesty, a poll-phase failure) fail the
 *     execution honestly — never a fabricated completion;
 *   * malformed containers (a transport-level success delivering
 *     non-MP4 bytes) FAIL the mechanical container criterion — the
 *     run fails mechanically, never a silent completion;
 *   * task-failure terminal states (a FAILED provider task with the
 *     provider's own code/message; SUCCEEDED-without-artifact; the
 *     bounded budget exhaustion) end in honest failures.
 *
 *   * additionally: the zero-duration edge row is rejected BEFORE any
 *     paid dispatch (the platform never spends a paid dispatch on a
 *     provably-invalid request);
 *   * request reproducibility (the same task always derives the same
 *     canonical request body on the wire and the same request digest;
 *     different tasks derive different digests).
 */

import { describe, expect, test } from "vitest";
import type { PlatformLifecyclePort } from "../../benchmarks/validation/platform/driver";
import {
  createDashscopeVideogenRail,
  createVideogenDispatchBinding,
  deriveVideogenPlan,
  driveVideogenExecution,
  type GenerateVideoTask,
  type HttpTransport,
  materializeVideogenInput,
} from "../../benchmarks/validation/platform/videogen";

const GENERATION_TASK: GenerateVideoTask = {
  kind: "generate-video",
  prompt: "vid-prompt-001",
  seconds: 5,
  aspect: "16:9",
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

function bytesResponse(bytes: Buffer): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": "video/mp4" },
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

/**
 * A deterministic synthetic "generated" MP4 (a valid `ftyp` box +
 * filler) — the fake rail's delivered artifact. Mechanical ground
 * truth only: no frame-level claims, per the work order.
 */
function syntheticMp4(byteLength = 2048): Buffer {
  const bytes = Buffer.alloc(byteLength, 0x5a);
  bytes.writeUInt32BE(32, 0);
  bytes.write("ftyp", 4, "latin1");
  bytes.write("isom", 8, "latin1");
  bytes.writeUInt32BE(0x0200, 12);
  bytes.write("isomiso2avc1mp41", 16, "latin1");
  return bytes;
}

/** Deterministic NON-MP4 bytes (a PNG-magic payload). */
function syntheticPng(byteLength = 2048): Buffer {
  const bytes = Buffer.alloc(byteLength, 0x33);
  bytes.write("\x89PNG", 0, "latin1");
  bytes.write("\r\n\x1a\n", 4, "latin1");
  return bytes;
}

const MP4 = syntheticMp4();

/** The full happy async wire sequence for one dispatched generation. */
function happyAsyncSequence(bytes = MP4): Response[] {
  return [
    jsonResponse(200, { output: { task_id: "task-d" } }),
    jsonResponse(200, { output: { task_status: "PENDING" } }),
    jsonResponse(200, {
      output: {
        task_status: "SUCCEEDED",
        video_url: "https://assets.local/clip.mp4",
        video_duration: 5,
        // 2026-09-12 size re-pin: a wan2.2-t2v-plus task requested at
        // 1920*1080 reports 1920x1080 (the dimension-bound criterion is
        // exact equality with the declared request size).
        resolution: "1920x1080",
      },
      usage: { video_count: 1 },
    }),
    bytesResponse(bytes),
  ];
}

describe("videogen validation discrimination (VAL-016 AC6)", () => {
  test("a tampered fixture materialization fails the run before ANY network effect", async () => {
    const { transport, calls } = countingTransport(happyAsyncSequence());
    const rail = createDashscopeVideogenRail({
      transport,
      apiKey: "k",
      sleep: () => Promise.resolve(),
    });
    const binding = createVideogenDispatchBinding({
      rail,
      // The controlled fake: the materialization layer returns a
      // different prompt digest than the plan derived.
      materialize: (task) => ({
        ...materializeVideogenInput(task),
        promptDigest: "deadbeefdeadbeef",
      }),
    });
    const { lifecycle, transitions } = recordingLifecycle();
    const result = await driveVideogenExecution({
      executionId: "exec-digest",
      task: GENERATION_TASK,
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
      ports: { lifecycle, dispatch: binding, now: () => new Date(1_000_000) },
    });
    expect(result.terminal).toBe("FAILED");
    expect(calls).toHaveLength(0); // zero REAL network effects
    expect(transitions.at(-1)).toBe("complete:fail");
    expect(result.criteria[0]?.criterionId).toBe("provider-dispatch");
    expect(result.criteria[0]?.evidence[0]).toBe("provider-failure:fixture-digest-mismatch");
    expect(result.videoDigest).toBeNull();
  });

  test("a wrong-modality request fails before ANY network effect", async () => {
    const { transport, calls } = countingTransport(happyAsyncSequence());
    const rail = createDashscopeVideogenRail({
      transport,
      apiKey: "k",
      sleep: () => Promise.resolve(),
    });
    const binding = createVideogenDispatchBinding({ rail });
    const result = await driveVideogenExecution({
      executionId: "exec-modality",
      task: { kind: "generate-image", prompt: "img-prompt-001" } as never,
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: binding,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(calls).toHaveLength(0); // zero REAL network effects
    expect(result.criteria[0]?.evidence[0]).toBe("provider-failure:wrong-modality");
  });

  test("the zero-duration edge row is rejected before ANY paid dispatch", async () => {
    const { transport, calls } = countingTransport(happyAsyncSequence());
    const rail = createDashscopeVideogenRail({
      transport,
      apiKey: "k",
      sleep: () => Promise.resolve(),
    });
    const binding = createVideogenDispatchBinding({ rail });
    const result = await driveVideogenExecution({
      executionId: "exec-zero-seconds",
      task: { kind: "generate-video", prompt: "vid-prompt-005", seconds: 0 },
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: binding,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(calls).toHaveLength(0); // never a paid dispatch
    expect(result.criteria[0]?.evidence[0]).toBe("provider-failure:invalid-request");
    expect(result.taskId).toBeNull();
    expect(result.polls).toBe(0);
  });

  test("a REAL 401 shape at submission fails the execution honestly (never completed)", async () => {
    // The exact provider response shape an invalid credential produces
    // on the real dashscope rail: HTTP 401, provider code + message.
    const { transport, calls } = countingTransport([
      jsonResponse(401, {
        code: "InvalidApiKey",
        message: "Invalid API-key provided",
        request_id: "req-x",
      }),
    ]);
    const rail = createDashscopeVideogenRail({
      transport,
      apiKey: "k",
      sleep: () => Promise.resolve(),
    });
    const binding = createVideogenDispatchBinding({ rail });
    const result = await driveVideogenExecution({
      executionId: "exec-auth",
      task: GENERATION_TASK,
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: binding,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.usage).toBeNull();
    expect(result.criteria[0]?.evidence[0]).toBe("provider-failure:auth");
    expect(result.criteria[0]?.evidence).toContain("retryable:false");
    expect(result.criteria[0]?.evidence).toContain("taskId:none");
    expect(calls).toHaveLength(1); // exactly one REAL attempt, no retry
  });

  test("retry honesty: a retryable 429 is retried exactly per policy and then completes", async () => {
    // First attempt 429 (retryable), second attempt succeeds end to end.
    const { transport, calls } = countingTransport([
      jsonResponse(429, { code: "Throttling", message: "Requests rate limited" }),
      ...happyAsyncSequence(),
    ]);
    const rail = createDashscopeVideogenRail({
      transport,
      apiKey: "k",
      sleep: () => Promise.resolve(),
    });
    const binding = createVideogenDispatchBinding({
      rail,
      retry: { attempts: 1, delayMs: 1, sleep: () => Promise.resolve() },
    });
    const result = await driveVideogenExecution({
      executionId: "exec-throttle",
      task: GENERATION_TASK,
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: binding,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.criteria.every((c) => c.status === "PASS")).toBe(true);
    expect(result.videoDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 1 });
    // Exactly the honest wire footprint: 1 rejected submission + 1
    // accepted submission + 2 bounded polls + 1 artifact fetch.
    expect(calls).toHaveLength(5);
    expect(calls[1]?.body).toEqual(calls[0]?.body); // identical canonical retry body
  });

  test("a malformed container (transport-level success, non-MP4 bytes) fails mechanically", async () => {
    const { transport, calls } = countingTransport(happyAsyncSequence(syntheticPng()));
    const rail = createDashscopeVideogenRail({
      transport,
      apiKey: "k",
      sleep: () => Promise.resolve(),
    });
    const binding = createVideogenDispatchBinding({ rail });
    const result = await driveVideogenExecution({
      executionId: "exec-malformed",
      task: GENERATION_TASK,
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: binding,
        now: () => new Date(1_000_000),
      },
    });
    // The dispatch SUCCEEDED at the transport level (a REAL 200 task
    // lifecycle with an artifact fetch), but the delivered payload is
    // not a valid MP4 container: the mechanical criteria fail the
    // execution — never a fabricated completion.
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(result.terminal).toBe("FAILED");
    const byId = new Map(result.criteria.map((c) => [c.criterionId, c.status]));
    expect(byId.get("mp4-container")).toBe("FAIL");
    expect(byId.get("payload-bounds")).toBe("PASS"); // 2048 bytes is in bounds
    // The malformed bytes' digest is still captured (digest, never payload).
    const container = result.criteria.find((c) => c.criterionId === "mp4-container");
    expect(container?.evidence.some((entry) => entry.startsWith("digest:"))).toBe(true);
  });

  test("a FAILED provider task terminal state fails with the provider's own message (never retried)", async () => {
    const { transport, calls } = countingTransport([
      jsonResponse(200, { output: { task_id: "task-f" } }),
      jsonResponse(200, {
        output: {
          task_status: "FAILED",
          code: "InternalError",
          message: "Video generation failed due to internal error",
        },
      }),
      jsonResponse(200, { output: { task_id: "task-f2" } }), // would be the retry
    ]);
    const rail = createDashscopeVideogenRail({
      transport,
      apiKey: "k",
      sleep: () => Promise.resolve(),
    });
    const binding = createVideogenDispatchBinding({
      rail,
      retry: { attempts: 2, delayMs: 1, sleep: () => Promise.resolve() },
    });
    const result = await driveVideogenExecution({
      executionId: "exec-task-failed",
      task: GENERATION_TASK,
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: binding,
        now: () => new Date(1_000_000),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.criteria[0]?.evidence[0]).toBe("provider-failure:provider-task-failed");
    expect(result.criteria[0]?.evidence).toContain("retryable:false");
    expect(result.criteria[0]?.evidence).toContain("taskId:task-f");
    expect(result.criteria[0]?.evidence).toContain("polls:1");
    // The taxonomy message is the provider's own, truncated honestly.
    expect(
      result.criteria[0]?.evidence.some((entry) =>
        entry.includes("Video generation failed due to internal error"),
      ),
    ).toBe(true);
    // Non-retryable: exactly one submission — never retried.
    expect(calls).toHaveLength(2); // one submission + one poll
  });

  test("SUCCEEDED-without-artifact and budget exhaustion are honest terminal failures", async () => {
    // SUCCEEDED with no video reference: empty-output.
    const noArtifact = countingTransport([
      jsonResponse(200, { output: { task_id: "task-e1" } }),
      jsonResponse(200, { output: { task_status: "SUCCEEDED" } }),
    ]);
    const railEmpty = createDashscopeVideogenRail({
      transport: noArtifact.transport,
      apiKey: "k",
      sleep: () => Promise.resolve(),
    });
    const empty = await driveVideogenExecution({
      executionId: "exec-empty-output",
      task: GENERATION_TASK,
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: createVideogenDispatchBinding({ rail: railEmpty }),
        now: () => new Date(1_000_000),
      },
    });
    expect(empty.terminal).toBe("FAILED");
    expect(empty.criteria[0]?.evidence[0]).toBe("provider-failure:empty-output");
    expect(empty.taskId).toBe("task-e1");

    // The bounded budget: task never terminal within the declared
    // window (timeoutMs 10 / pollIntervalMs 2 → exactly 5 polls).
    const neverTerminal = countingTransport([
      jsonResponse(200, { output: { task_id: "task-slow" } }),
      jsonResponse(200, { output: { task_status: "RUNNING" } }),
    ]);
    const railSlow = createDashscopeVideogenRail({
      transport: neverTerminal.transport,
      apiKey: "k",
      timeoutMs: 10,
      pollIntervalMs: 2,
      sleep: () => Promise.resolve(),
    });
    const timeout = await driveVideogenExecution({
      executionId: "exec-timeout",
      task: GENERATION_TASK,
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
      ports: {
        lifecycle: recordingLifecycle().lifecycle,
        dispatch: createVideogenDispatchBinding({ rail: railSlow }),
        now: () => new Date(1_000_000),
      },
    });
    expect(timeout.terminal).toBe("FAILED");
    expect(timeout.criteria[0]?.evidence[0]).toBe("provider-failure:task-timeout");
    expect(timeout.criteria[0]?.evidence).toContain("taskId:task-slow");
    expect(timeout.criteria[0]?.evidence).toContain("polls:5");
    // Never an unbounded wait: exactly 1 submission + 5 bounded polls.
    expect(neverTerminal.calls).toHaveLength(6);
  });

  test("request reproducibility: same task → identical canonical wire bodies and digests; different tasks differ", () => {
    const first = deriveVideogenPlan(GENERATION_TASK, {
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
    });
    const second = deriveVideogenPlan(GENERATION_TASK, {
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
    });
    expect(first.requestDigest).toBe(second.requestDigest);
    expect(first.promptDigest).toBe(second.promptDigest);

    const other = deriveVideogenPlan(
      { kind: "generate-video", prompt: "vid-prompt-003", seconds: 5, aspect: "16:9" },
      { provider: "dashscope", model: "wan2.2-t2v-plus" },
    );
    expect(other.requestDigest).not.toBe(first.requestDigest);
    expect(other.promptDigest).not.toBe(first.promptDigest);

    // And on the wire: the dispatched canonical bodies are identical
    // for the same task (byte-stable JSON), different for the other.
    const bodyOf = (task: GenerateVideoTask): string => {
      const materialized = materializeVideogenInput(task);
      return JSON.stringify({
        model: "wan2.2-t2v-plus",
        input: { prompt: materialized.prompt },
        parameters: { size: materialized.sizeString, duration: materialized.duration },
      });
    };
    expect(bodyOf(GENERATION_TASK)).toBe(bodyOf(GENERATION_TASK));
    expect(bodyOf(GENERATION_TASK)).not.toBe(
      bodyOf({ kind: "generate-video", prompt: "vid-prompt-003", seconds: 5, aspect: "16:9" }),
    );
  });
});
