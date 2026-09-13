/**
 * VAL-016 platform unit tests: the videogen derivations (pure), the
 * REAL dashscope-international video-synthesis rail (the async
 * `wan2.2-t2v-plus` task API) over controlled fake transports (no
 * network), the typed asynchronous lifecycle state machine, the
 * dispatch binding's pre-dispatch discriminations and the execution
 * driver.
 *
 * The five REQUIRED DISCRIMINATION CLASSES (the governed spec's AC6):
 *   * D1 fixture digest mismatches — a tampered materialization is
 *     rejected BEFORE any network effect (zero transport calls);
 *   * D2 wrong-modality requests — a task kind outside the videogen
 *     vocabulary (or a rail not serving text-to-video) is rejected
 *     BEFORE any network effect;
 *   * D3 provider failures — auth / rate-limit / provider-unavailable
 *     / task-not-found / artifact-fetch failures map to the honest
 *     provider-failure taxonomy and FAIL runs mechanically;
 *   * D4 malformed containers — a non-MP4 or out-of-bounds payload
 *     FAILS the mechanical verification (never a completed run);
 *   * D5 task-failure terminal states — FAILED / CANCELED / UNKNOWN
 *     task statuses, SUCCEEDED-without-artifact, and the bounded
 *     budget exhaustion end in honest failures (never fabricated
 *     completions, never unbounded waits).
 *
 * Honesty invariants under test additionally:
 *   * a missing fixture is a NOT RUN boundary thrown BEFORE any
 *     lifecycle mutation (the driver records zero transitions);
 *   * the empty-prompt edge row materializes (never a silent drop)
 *     and is rejected BEFORE any paid dispatch;
 *   * the async wait is BOUNDED: budget exhaustion ends in
 *     `task-timeout` after exactly maxPolls poll attempts;
 *   * evidence carries payload DIGESTS, never payloads.
 */

import { describe, expect, test } from "vitest";
import {
  jobDefinitionIsConsistent,
  MEDIA_GENERATION_JOBS,
} from "../../../benchmarks/validation/apps/media-generation-jobs/jobs";
import {
  VIDEO_PROMPT_FIXTURE_KEYS,
  videoPromptDigest,
  videoPromptFixture,
} from "../../../benchmarks/validation/apps/video-generation/prompts";
import type { PlatformLifecyclePort } from "../../../benchmarks/validation/platform/driver";
import {
  advanceVideogenAsyncState,
  buildVideogenRequestBody,
  createDashscopeVideogenRail,
  createVideogenDispatchBinding,
  deriveVideogenPlan,
  deriveVideogenVerification,
  driveVideogenExecution,
  type GenerateVideoTask,
  type HttpTransport,
  materializeVideogenInput,
  type VideogenAsyncState,
  VideogenFixtureNotMaterializedError,
  type VideogenRail,
  type VideogenRailOutcome,
} from "../../../benchmarks/validation/platform/videogen";
import {
  mediaDigest,
  parseRailResolution,
  sniffMp4Container,
  VIDEO_BYTE_BOUNDS,
} from "../../../benchmarks/validation/platform/videogen-container";

// ---------------------------------------------------------------------------
// Fakes and synthetic artifacts (deterministic)
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bytesResponse(bytes: Buffer, contentType = "video/mp4"): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": contentType },
  });
}

/**
 * A fake transport scripted with a response queue (the queue's last
 * entry repeats when exhausted; thrown Errors propagate). Records
 * every call — the network-effect ground truth for the zero-call
 * discriminations.
 */
function scriptedTransport(responses: (Response | Error)[]): {
  readonly transport: HttpTransport;
  readonly calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[];
} {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] =
    [];
  let index = 0;
  const transport: HttpTransport = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: { ...init.headers },
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

/** A mutable deterministic clock (sleep advances it — measured latencies). */
function fakeClock(startMs = 0): {
  readonly now: () => Date;
  readonly advance: (ms: number) => void;
} {
  let current = startMs;
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms;
    },
  };
}

/**
 * A deterministic synthetic "generated" MP4: a valid ISO-BMFF `ftyp`
 * box (size 32, major brand `isom`, minor 0x0200, four compatible
 * brands) followed by opaque filler to the requested size. The same
 * bytes always derive the same digest — mechanical ground truth only
 * (no frame-level claims, per the work order).
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

/** Deterministic NON-MP4 bytes (a PNG-magic payload — wrong modality bytes). */
function syntheticPng(byteLength = 2048): Buffer {
  const bytes = Buffer.alloc(byteLength, 0x33);
  bytes.writeUInt32BE(byteLength - 8, 0);
  bytes.write("PNG\r\n\x1a\n".slice(0, 4), 4, "latin1");
  bytes.write("\x89PNG", 0, "latin1");
  bytes.write("\r\n\x1a\n", 4, "latin1");
  return bytes;
}

/** A fake rail answering from a scripted outcome queue (counts dispatches). */
function queueRail(
  outcomes: VideogenRailOutcome[],
  mode: "text-to-video" = "text-to-video",
): {
  readonly rail: VideogenRail;
  readonly dispatchCount: () => number;
} {
  let index = 0;
  let count = 0;
  const rail: VideogenRail = {
    railId: "fake-videogen-rail",
    mode,
    async dispatch() {
      count += 1;
      const next = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      if (next === undefined) {
        throw new Error("queue rail exhausted");
      }
      return next;
    },
  };
  return { rail, dispatchCount: () => count };
}

const MP4 = syntheticMp4();

function healthyOutcome(overrides?: {
  readonly bytes?: Buffer;
  readonly reported?: {
    readonly durationSeconds: number | null;
    readonly resolution: { readonly width: number; readonly height: number } | null;
  };
}): Extract<VideogenRailOutcome, { kind: "success" }> {
  return {
    kind: "success",
    video: {
      bytes: overrides?.bytes ?? MP4,
      container: "mp4",
      majorBrand: "isom",
      byteLength: (overrides?.bytes ?? MP4).length,
    },
    taskId: "task-77",
    artifactUrl: "https://assets.local/clip.mp4",
    polls: 3,
    submissionToTerminalMs: 6_000,
    reported: overrides?.reported ?? {
      durationSeconds: 5,
      resolution: { width: 1920, height: 1080 },
    },
    usage: { inputTokens: 0, outputTokens: 1 },
  };
}

function failureOutcome(
  category: string,
  retryable: boolean,
): Extract<VideogenRailOutcome, { kind: "failure" }> {
  return {
    kind: "failure",
    category,
    message: `scripted ${category}`,
    retryable,
    taskId: null,
    polls: 0,
  };
}

const TASK: GenerateVideoTask = {
  kind: "generate-video",
  prompt: "vid-prompt-001",
  seconds: 5,
  aspect: "16:9",
};

// ---------------------------------------------------------------------------
// Materialization + fixtures (pure, deterministic)
// ---------------------------------------------------------------------------

describe("VAL-016 videogen materialization", () => {
  test("every pinned fixture materializes deterministically (same digests)", () => {
    for (const key of ["vid-prompt-001", "vid-prompt-003", "vid-prompt-005", "vid-prompt-006"]) {
      const first = materializeVideogenInput({ kind: "generate-video", prompt: key });
      const second = materializeVideogenInput({ kind: "generate-video", prompt: key });
      expect(first.promptDigest).toBe(second.promptDigest);
      expect(first.promptDigest).toMatch(/^[0-9a-f]{16}$/);
      expect(first.prompt).toBe(second.prompt);
      expect(first.annotation.length).toBeGreaterThan(0);
    }
  });

  test("the declared parameters map to the rail's bounded generation parameters", () => {
    const landscape = materializeVideogenInput({
      kind: "generate-video",
      prompt: "vid-prompt-001",
      seconds: 5,
      aspect: "16:9",
    });
    expect(landscape.duration).toBe(5);
    expect(landscape.sizeString).toBe("1920*1080");
    expect(landscape.size).toEqual({ width: 1920, height: 1080 });

    const vertical = materializeVideogenInput({
      kind: "generate-video",
      prompt: "vid-prompt-006",
      seconds: 5,
      aspect: "9:16",
    });
    expect(vertical.sizeString).toBe("1080*1920");
    expect(vertical.size).toEqual({ width: 1080, height: 1920 });

    // Defaults: 5 seconds, landscape, when the task declares neither.
    const defaults = materializeVideogenInput({ kind: "generate-video", prompt: "vid-prompt-001" });
    expect(defaults.duration).toBe(5);
    expect(defaults.sizeString).toBe("1920*1080");
  });

  test("the empty prompt materializes as the corpus's own edge row (never a drop)", () => {
    const materialized = materializeVideogenInput({ kind: "generate-video", prompt: "" });
    expect(materialized.prompt).toBe("");
    expect(materialized.promptKey).toBe("(empty prompt)");
    expect(materialized.promptDigest).toBe(videoPromptDigest(""));
    expect(materialized.promptDigest).toMatch(/^[0-9a-f]{16}$/);
  });

  test("absent fixtures are NOT RUN boundaries (thrown, never empty dispatches)", () => {
    expect(() =>
      materializeVideogenInput({ kind: "generate-video", prompt: "vid-prompt-999" }),
    ).toThrow(VideogenFixtureNotMaterializedError);
  });

  test("the fixture table keys are unique and cover the pinned slices", () => {
    expect(new Set(VIDEO_PROMPT_FIXTURE_KEYS).size).toBe(VIDEO_PROMPT_FIXTURE_KEYS.length);
    for (const key of ["vid-prompt-001", "vid-prompt-003", "vid-prompt-005", "vid-prompt-006"]) {
      expect(VIDEO_PROMPT_FIXTURE_KEYS).toContain(key);
    }
    // The jobs app's items reference materializable fixtures too.
    for (const job of MEDIA_GENERATION_JOBS) {
      expect(jobDefinitionIsConsistent(job)).toBe(true);
      for (const item of job.items) {
        expect(() => videoPromptFixture(item.task.prompt)).not.toThrow();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Canonical request + dispatch-plan derivation (pure)
// ---------------------------------------------------------------------------

describe("VAL-016 canonical rail request and plan derivation", () => {
  test("the canonical request body is the dashscope video-synthesis shape", () => {
    const body = buildVideogenRequestBody({
      model: "wan2.2-t2v-plus",
      prompt: "storyboard text",
      sizeString: "1920*1080",
      duration: 5,
    });
    expect(body).toEqual({
      model: "wan2.2-t2v-plus",
      input: { prompt: "storyboard text" },
      parameters: { size: "1920*1080", duration: 5 },
    });
  });

  test("the parameters object appears only when parameters are declared", () => {
    expect(buildVideogenRequestBody({ model: "m", prompt: "p" })).toEqual({
      model: "m",
      input: { prompt: "p" },
    });
    expect(buildVideogenRequestBody({ model: "m", prompt: "p", duration: 5 }).parameters).toEqual({
      duration: 5,
    });
  });

  test("the plan is byte-stable (request-level reproducibility)", () => {
    const first = deriveVideogenPlan(TASK, { provider: "dashscope", model: "wan2.2-t2v-plus" });
    const second = deriveVideogenPlan(TASK, { provider: "dashscope", model: "wan2.2-t2v-plus" });
    expect(first.requestDigest).toBe(second.requestDigest);
    expect(first.requestDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(first.promptDigest).toBe(videoPromptDigest(videoPromptFixture("vid-prompt-001").prompt));
    expect(first.route).toEqual({
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
      strategyClass: "async-text-to-video",
    });
    expect(first.mode).toBe("text-to-video");
    expect(first.duration).toBe(5);
    expect(first.sizeString).toBe("1920*1080");
  });
});

// ---------------------------------------------------------------------------
// The typed asynchronous lifecycle state machine (pure reducer)
// ---------------------------------------------------------------------------

describe("VAL-016 typed async lifecycle state machine", () => {
  const LIMITS = { maxPolls: 5 };
  const SUBMITTED: VideogenAsyncState = { phase: "submitted", polls: 0 };

  test("submitted + task-issued records the task identity", () => {
    const state = advanceVideogenAsyncState(
      SUBMITTED,
      { type: "task-issued", taskId: "t-1" },
      LIMITS,
    );
    expect(state).toEqual({ phase: "task-issued", taskId: "t-1", polls: 0 });
  });

  test("submitted + submit-failed fails with the submission taxonomy (no task id)", () => {
    const state = advanceVideogenAsyncState(
      SUBMITTED,
      { type: "submit-failed", category: "auth", message: "bad key", retryable: false },
      LIMITS,
    );
    expect(state).toEqual({
      phase: "failed",
      taskId: null,
      category: "auth",
      message: "bad key",
      retryable: false,
      polls: 0,
    });
  });

  test("non-terminal observations keep polling within the bounded budget", () => {
    let state: VideogenAsyncState = advanceVideogenAsyncState(
      SUBMITTED,
      { type: "task-issued", taskId: "t-1" },
      LIMITS,
    );
    state = advanceVideogenAsyncState(state, { type: "poll-observed", status: "PENDING" }, LIMITS);
    expect(state).toEqual({ phase: "polling", taskId: "t-1", polls: 1 });
    state = advanceVideogenAsyncState(state, { type: "poll-observed", status: "RUNNING" }, LIMITS);
    expect(state).toEqual({ phase: "polling", taskId: "t-1", polls: 2 });
  });

  test("SUCCEEDED with an artifact URL is terminal", () => {
    let state: VideogenAsyncState = advanceVideogenAsyncState(
      SUBMITTED,
      { type: "task-issued", taskId: "t-1" },
      LIMITS,
    );
    state = advanceVideogenAsyncState(
      state,
      { type: "poll-observed", status: "SUCCEEDED", artifactUrl: "https://a/clip.mp4" },
      LIMITS,
    );
    expect(state).toEqual({
      phase: "succeeded",
      taskId: "t-1",
      artifactUrl: "https://a/clip.mp4",
      polls: 1,
    });
    // Stale events after a terminal state are ignored.
    expect(
      advanceVideogenAsyncState(state, { type: "poll-observed", status: "RUNNING" }, LIMITS),
    ).toBe(state);
  });

  test("SUCCEEDED without an artifact URL is an honest empty-output failure (D5)", () => {
    let state: VideogenAsyncState = advanceVideogenAsyncState(
      SUBMITTED,
      { type: "task-issued", taskId: "t-1" },
      LIMITS,
    );
    state = advanceVideogenAsyncState(
      state,
      { type: "poll-observed", status: "SUCCEEDED" },
      LIMITS,
    );
    expect(state).toMatchObject({
      phase: "failed",
      taskId: "t-1",
      category: "empty-output",
      retryable: true,
      polls: 1,
    });
  });

  test("FAILED / CANCELED / UNKNOWN task statuses fail with the provider taxonomy (D5)", () => {
    for (const [status, expectedMessage] of [
      ["FAILED", "provider said no"],
      ["CANCELED", "canceled-by-user"],
      ["UNKNOWN", "task ended in UNKNOWN"],
    ] as const) {
      let state: VideogenAsyncState = advanceVideogenAsyncState(
        SUBMITTED,
        { type: "task-issued", taskId: "t-1" },
        LIMITS,
      );
      state = advanceVideogenAsyncState(
        state,
        {
          type: "poll-observed",
          status,
          ...(status === "UNKNOWN" ? {} : { message: expectedMessage }),
        },
        LIMITS,
      );
      expect(state).toMatchObject({
        phase: "failed",
        taskId: "t-1",
        category: "provider-task-failed",
        retryable: false,
        polls: 1,
        message: expectedMessage,
      });
    }
  });

  test("the bounded budget ends in budget-exhausted at exactly maxPolls (never unbounded)", () => {
    let state: VideogenAsyncState = advanceVideogenAsyncState(
      SUBMITTED,
      { type: "task-issued", taskId: "t-1" },
      LIMITS,
    );
    for (let poll = 1; poll <= 4; poll += 1) {
      state = advanceVideogenAsyncState(
        state,
        { type: "poll-observed", status: "RUNNING" },
        LIMITS,
      );
      expect(state.phase).toBe("polling");
    }
    state = advanceVideogenAsyncState(state, { type: "poll-observed", status: "RUNNING" }, LIMITS);
    expect(state).toEqual({ phase: "budget-exhausted", taskId: "t-1", polls: 5 });
    // Terminal — stale observations are ignored.
    expect(
      advanceVideogenAsyncState(
        state,
        { type: "poll-observed", status: "SUCCEEDED", artifactUrl: "x" },
        LIMITS,
      ),
    ).toBe(state);
  });

  test("retryable poll failures consume the budget; non-retryable fail immediately", () => {
    let state: VideogenAsyncState = advanceVideogenAsyncState(
      SUBMITTED,
      { type: "task-issued", taskId: "t-1" },
      LIMITS,
    );
    state = advanceVideogenAsyncState(
      state,
      { type: "poll-failed", category: "transport", message: "flake", retryable: true },
      LIMITS,
    );
    expect(state).toEqual({ phase: "polling", taskId: "t-1", polls: 1 });
    state = advanceVideogenAsyncState(
      state,
      { type: "poll-failed", category: "task-not-found", message: "gone", retryable: false },
      LIMITS,
    );
    expect(state).toMatchObject({
      phase: "failed",
      category: "task-not-found",
      retryable: false,
      polls: 2,
    });
  });

  test("events before the task identity (or after failure) are ignored", () => {
    expect(
      advanceVideogenAsyncState(SUBMITTED, { type: "poll-observed", status: "RUNNING" }, LIMITS),
    ).toBe(SUBMITTED);
    const failed: VideogenAsyncState = advanceVideogenAsyncState(
      SUBMITTED,
      { type: "submit-failed", category: "auth", message: "x", retryable: false },
      LIMITS,
    );
    expect(advanceVideogenAsyncState(failed, { type: "task-issued", taskId: "t-9" }, LIMITS)).toBe(
      failed,
    );
  });
});

// ---------------------------------------------------------------------------
// Mechanical verification derivation (pure)
// ---------------------------------------------------------------------------

describe("VAL-016 mechanical verification derivation", () => {
  test("a healthy artifact passes every mechanical criterion (digests, not payloads)", () => {
    const criteria = deriveVideogenVerification(TASK, healthyOutcome());
    const byId = new Map(criteria.map((criterion) => [criterion.criterionId, criterion]));
    expect(byId.get("mp4-container")?.status).toBe("PASS");
    expect(byId.get("payload-bounds")?.status).toBe("PASS");
    expect(byId.get("digest-captured")?.status).toBe("PASS");
    expect(byId.get("duration-reported-honored")?.status).toBe("PASS");
    expect(byId.get("dimensions-reported-honored")?.status).toBe("PASS");
    const digest = mediaDigest(MP4);
    expect(byId.get("digest-captured")?.evidence).toContain(`digest:${digest}`);
    // Digest, never payload: no evidence entry ever contains raw bytes.
    for (const criterion of criteria) {
      for (const entry of criterion.evidence) {
        expect(entry.length).toBeLessThan(512);
      }
    }
  });

  test("rail-reported bounds are enforced exactly WHERE reported (absent = honestly absent)", () => {
    const unreported = deriveVideogenVerification(TASK, {
      ...healthyOutcome(),
      reported: { durationSeconds: null, resolution: null },
    });
    expect(
      unreported.some((criterion) => criterion.criterionId.startsWith("duration-reported")),
    ).toBe(false);
    expect(
      unreported.some((criterion) => criterion.criterionId.startsWith("dimensions-reported")),
    ).toBe(false);
    expect(unreported.map((c) => c.criterionId)).toEqual([
      "mp4-container",
      "payload-bounds",
      "digest-captured",
    ]);
  });

  test("a rail-reported duration outside the declared tolerance FAILS", () => {
    const criteria = deriveVideogenVerification(TASK, {
      ...healthyOutcome(),
      reported: { durationSeconds: 8, resolution: { width: 1920, height: 1080 } },
    });
    const duration = criteria.find((c) => c.criterionId === "duration-reported-honored");
    expect(duration?.status).toBe("FAIL");
    expect(duration?.evidence).toContain("railDuration:8");
    expect(duration?.evidence).toContain("tolerance:1");
  });

  test("a rail-reported resolution that disagrees with the request FAILS", () => {
    const criteria = deriveVideogenVerification(TASK, {
      ...healthyOutcome(),
      reported: { durationSeconds: 5, resolution: { width: 1080, height: 1920 } },
    });
    const dimensions = criteria.find((c) => c.criterionId === "dimensions-reported-honored");
    expect(dimensions?.status).toBe("FAIL");
  });

  test("D4: a malformed (non-MP4) payload FAILS the container criterion mechanically", () => {
    const png = syntheticPng();
    const criteria = deriveVideogenVerification(TASK, healthyOutcome({ bytes: png }));
    const container = criteria.find((c) => c.criterionId === "mp4-container");
    expect(container?.status).toBe("FAIL");
    expect(container?.evidence).toContain("container:unknown");
    // The run as a whole fails: any FAIL criterion fails the verdict.
    expect(criteria.some((c) => c.status === "FAIL")).toBe(true);
  });

  test("D4: an out-of-bounds payload (too small) FAILS the bounds criterion", () => {
    const tiny = syntheticMp4(100); // valid ftyp, but 100 bytes < 1024
    expect(sniffMp4Container(tiny).container).toBe("mp4");
    const criteria = deriveVideogenVerification(TASK, healthyOutcome({ bytes: tiny }));
    const bounds = criteria.find((c) => c.criterionId === "payload-bounds");
    expect(bounds?.status).toBe("FAIL");
    expect(bounds?.evidence).toContain(`bytes:${VIDEO_BYTE_BOUNDS.minBytes - 924}`);
  });

  test("a provider failure fails the run mechanically (no shortcut)", () => {
    const criteria = deriveVideogenVerification(TASK, failureOutcome("auth", false));
    expect(criteria).toHaveLength(1);
    expect(criteria[0]?.criterionId).toBe("provider-dispatch");
    expect(criteria[0]?.status).toBe("FAIL");
    expect(criteria[0]?.evidence).toContain("provider-failure:auth");
  });

  test("the container sniffer and resolution parser are pure byte-level facts", () => {
    expect(sniffMp4Container(MP4)).toEqual({
      container: "mp4",
      majorBrand: "isom",
      ftypBoxSize: 32,
    });
    expect(sniffMp4Container(syntheticPng()).container).toBe("unknown");
    expect(sniffMp4Container(Buffer.alloc(8)).container).toBe("unknown");
    expect(parseRailResolution("1280x720")).toEqual({ width: 1280, height: 720 });
    expect(parseRailResolution("1920*1080")).toEqual({ width: 1920, height: 1080 });
    expect(parseRailResolution("720p")).toBeNull();
    expect(parseRailResolution("0x0")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The REAL dashscope video-synthesis rail over controlled fake transports
// ---------------------------------------------------------------------------

describe("VAL-016 dashscope videogen rail (async task API over a fake transport)", () => {
  test("the happy asynchronous lifecycle end to end: submit -> poll -> retrieve -> fetch", async () => {
    const clock = fakeClock();
    const { transport, calls } = scriptedTransport([
      jsonResponse(200, { output: { task_id: "task-77" } }),
      jsonResponse(200, { output: { task_status: "PENDING" } }),
      jsonResponse(200, { output: { task_status: "RUNNING" } }),
      jsonResponse(200, {
        output: {
          task_status: "SUCCEEDED",
          video_url: "https://assets.local/clip.mp4",
          video_duration: 5,
          resolution: "1280x720",
        },
        usage: { video_count: 1 },
      }),
      bytesResponse(MP4),
    ]);
    const rail = createDashscopeVideogenRail({
      transport,
      apiKey: "test-key",
      sleep: (ms) => {
        clock.advance(ms);
        return Promise.resolve();
      },
      now: () => clock.now().getTime(),
    });

    const outcome = await rail.dispatch({
      model: "wan2.2-t2v-plus",
      prompt: "storyboard text",
      sizeString: "1920*1080",
      duration: 5,
    });

    expect(outcome.kind).toBe("success");
    if (outcome.kind !== "success") {
      return;
    }
    expect(outcome.taskId).toBe("task-77");
    expect(outcome.artifactUrl).toBe("https://assets.local/clip.mp4");
    expect(outcome.polls).toBe(3);
    expect(outcome.video.container).toBe("mp4");
    expect(outcome.video.majorBrand).toBe("isom");
    expect(outcome.video.byteLength).toBe(MP4.length);
    expect(outcome.video.bytes.equals(MP4)).toBe(true);
    expect(outcome.submissionToTerminalMs).toBe(6_000); // 3 polls x 2000ms
    expect(outcome.usage).toEqual({ inputTokens: 0, outputTokens: 1 });
    expect(outcome.reported).toEqual({
      durationSeconds: 5,
      // the rail-REPORTED resolution parses the TASK's response string
      // (the fake answers "1280x720") — the reported fact, not the
      // fixture's declared size.
      resolution: { width: 1280, height: 720 },
    });

    // The REAL wire shapes (the async contract):
    expect(calls).toHaveLength(5);
    const submit = calls[0];
    expect(submit?.url).toBe(
      "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
    );
    expect(submit?.method).toBe("POST");
    expect(submit?.headers["X-DashScope-Async"]).toBe("enable");
    expect(submit?.headers.Authorization).toBe("Bearer test-key");
    expect(submit?.body).toEqual({
      model: "wan2.2-t2v-plus",
      input: { prompt: "storyboard text" },
      parameters: { size: "1920*1080", duration: 5 },
    });
    expect(calls[1]?.url).toBe("https://dashscope-intl.aliyuncs.com/api/v1/tasks/task-77");
    expect(calls[1]?.method).toBe("GET");
    expect(calls[4]?.url).toBe("https://assets.local/clip.mp4");
  });

  test("D3: HTTP failures map to the honest provider-failure taxonomy at submission", async () => {
    const cases: readonly [number, string, boolean][] = [
      [401, "auth", false],
      [404, "model-unavailable", false],
      [429, "rate-limit", true],
      [500, "provider-unavailable", true],
    ];
    for (const [status, category, retryable] of cases) {
      const { transport } = scriptedTransport([
        jsonResponse(status, { code: "Err", message: `http ${status}` }),
      ]);
      const rail = createDashscopeVideogenRail({
        transport,
        apiKey: "test-key",
        sleep: () => Promise.resolve(),
      });
      const outcome = await rail.dispatch({ model: "wan2.2-t2v-plus", prompt: "p" });
      expect(outcome).toMatchObject({ kind: "failure", category, retryable, polls: 0 });
      if (outcome.kind === "failure") {
        expect(outcome.taskId).toBeNull();
        expect(outcome.message).toBe(`http ${status}`);
      }
    }
  });

  test("D3: transport faults at submission are retryable transport failures", async () => {
    const { transport } = scriptedTransport([new Error("ECONNRESET")]);
    const rail = createDashscopeVideogenRail({
      transport,
      apiKey: "test-key",
      sleep: () => Promise.resolve(),
    });
    const outcome = await rail.dispatch({ model: "wan2.2-t2v-plus", prompt: "p" });
    expect(outcome).toMatchObject({ kind: "failure", category: "transport", retryable: true });
  });

  test("D3/D5: a malformed submission body or a missing task id is an honest failure", async () => {
    const malformed = createDashscopeVideogenRail({
      transport: scriptedTransport([new Response("not json", { status: 200 })]).transport,
      apiKey: "test-key",
      sleep: () => Promise.resolve(),
    });
    expect(await malformed.dispatch({ model: "m", prompt: "p" })).toMatchObject({
      kind: "failure",
      category: "malformed-provider-response",
    });

    const noTaskId = createDashscopeVideogenRail({
      transport: scriptedTransport([jsonResponse(200, { output: {} })]).transport,
      apiKey: "test-key",
      sleep: () => Promise.resolve(),
    });
    expect(await noTaskId.dispatch({ model: "m", prompt: "p" })).toMatchObject({
      kind: "failure",
      category: "empty-output",
      retryable: true,
    });
  });

  test("D3: an invalid/expired task identity (poll 404) is a non-retryable task-not-found", async () => {
    const { transport } = scriptedTransport([
      jsonResponse(200, { output: { task_id: "task-gone" } }),
      jsonResponse(404, { code: "TaskNotFound", message: "task not found" }),
    ]);
    const rail = createDashscopeVideogenRail({
      transport,
      apiKey: "test-key",
      sleep: () => Promise.resolve(),
    });
    const outcome = await rail.dispatch({ model: "m", prompt: "p" });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "task-not-found",
      retryable: false,
      taskId: "task-gone",
      polls: 1,
    });
  });

  test("D5: a FAILED provider task is a non-retryable provider-task-failure with the provider's message", async () => {
    const { transport } = scriptedTransport([
      jsonResponse(200, { output: { task_id: "task-1" } }),
      jsonResponse(200, {
        output: { task_status: "FAILED", code: "InternalError", message: "generation failed" },
      }),
    ]);
    const rail = createDashscopeVideogenRail({
      transport,
      apiKey: "test-key",
      sleep: () => Promise.resolve(),
    });
    const outcome = await rail.dispatch({ model: "m", prompt: "p" });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "provider-task-failed",
      retryable: false,
      taskId: "task-1",
      polls: 1,
    });
    if (outcome.kind === "failure") {
      expect(outcome.message).toBe("generation failed");
    }
  });

  test("D5: SUCCEEDED without a video reference is an honest empty-output failure", async () => {
    const { transport } = scriptedTransport([
      jsonResponse(200, { output: { task_id: "task-1" } }),
      jsonResponse(200, { output: { task_status: "SUCCEEDED" } }),
    ]);
    const rail = createDashscopeVideogenRail({
      transport,
      apiKey: "test-key",
      sleep: () => Promise.resolve(),
    });
    const outcome = await rail.dispatch({ model: "m", prompt: "p" });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "empty-output",
      retryable: true,
      taskId: "task-1",
    });
  });

  test("D3: artifact-fetch failures are honest (never a fabricated artifact)", async () => {
    const fetchFails = createDashscopeVideogenRail({
      transport: scriptedTransport([
        jsonResponse(200, { output: { task_id: "task-1" } }),
        jsonResponse(200, {
          output: { task_status: "SUCCEEDED", video_url: "https://assets.local/clip.mp4" },
        }),
        jsonResponse(503, { code: "Unavailable", message: "gone" }),
      ]).transport,
      apiKey: "test-key",
      sleep: () => Promise.resolve(),
    });
    expect(await fetchFails.dispatch({ model: "m", prompt: "p" })).toMatchObject({
      kind: "failure",
      category: "artifact-fetch",
      retryable: true,
      taskId: "task-1",
    });

    const emptyArtifact = createDashscopeVideogenRail({
      transport: scriptedTransport([
        jsonResponse(200, { output: { task_id: "task-1" } }),
        jsonResponse(200, {
          output: { task_status: "SUCCEEDED", video_url: "https://assets.local/clip.mp4" },
        }),
        bytesResponse(Buffer.alloc(0)),
      ]).transport,
      apiKey: "test-key",
      sleep: () => Promise.resolve(),
    });
    expect(await emptyArtifact.dispatch({ model: "m", prompt: "p" })).toMatchObject({
      kind: "failure",
      category: "empty-output",
      taskId: "task-1",
    });
  });

  test("the bounded budget ends in an honest task-timeout after exactly maxPolls polls", async () => {
    const { transport, calls } = scriptedTransport([
      jsonResponse(200, { output: { task_id: "task-slow" } }),
      jsonResponse(200, { output: { task_status: "RUNNING" } }),
    ]);
    const rail = createDashscopeVideogenRail({
      transport,
      apiKey: "test-key",
      timeoutMs: 10, // ceil(10/2) = 5 polls, then the declared boundary
      pollIntervalMs: 2,
      sleep: () => Promise.resolve(),
    });
    const outcome = await rail.dispatch({ model: "m", prompt: "p" });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "task-timeout",
      retryable: true,
      taskId: "task-slow",
      polls: 5,
    });
    if (outcome.kind === "failure") {
      expect(outcome.message).toContain("bounded budget");
    }
    expect(calls).toHaveLength(1 + 5); // one submission + five bounded polls
  });
});

// ---------------------------------------------------------------------------
// The dispatch binding: pre-dispatch discriminations (D1, D2) + retries
// ---------------------------------------------------------------------------

describe("VAL-016 dispatch binding discriminations and bounded retry", () => {
  function bindingOverScriptedTransport(responses: (Response | Error)[]) {
    const scripted = scriptedTransport(responses);
    const rail = createDashscopeVideogenRail({
      transport: scripted.transport,
      apiKey: "test-key",
      sleep: () => Promise.resolve(),
    });
    const binding = createVideogenDispatchBinding({ rail });
    return { binding, calls: scripted.calls };
  }

  test("D2: a wrong-modality task kind is rejected BEFORE any network effect", async () => {
    const { binding, calls } = bindingOverScriptedTransport([bytesResponse(MP4)]);
    const outcome = await binding({
      executionId: "exec-1",
      task: { kind: "generate-image", prompt: "img-prompt-001" } as never,
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
    });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "wrong-modality",
      retryable: false,
    });
    expect(calls).toHaveLength(0); // zero network effects
  });

  test("D2: a rail that does not serve text-to-video is a wrong-modality rejection", async () => {
    const lying = queueRail([healthyOutcome()], "image-to-video" as never);
    const binding = createVideogenDispatchBinding({
      rail: { ...lying.rail, mode: "image-to-image" as never },
    });
    const outcome = await binding({
      executionId: "exec-1",
      task: TASK,
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
    });
    expect(outcome).toMatchObject({ kind: "failure", category: "wrong-modality" });
    expect(lying.dispatchCount()).toBe(0);
  });

  test("D2: an absent rail configuration is a wrong-modality rejection (never a crash)", async () => {
    const binding = createVideogenDispatchBinding({});
    const outcome = await binding({
      executionId: "exec-1",
      task: TASK,
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
    });
    expect(outcome).toMatchObject({ kind: "failure", category: "wrong-modality" });
  });

  test("D1: a tampered materialization (digest mismatch) is rejected BEFORE any network effect", async () => {
    // The tampered binding rides the SAME scripted transport the REAL
    // rail would ride — so `calls` is the genuine network-effect truth.
    const scripted = scriptedTransport([bytesResponse(MP4)]);
    const rail = createDashscopeVideogenRail({
      transport: scripted.transport,
      apiKey: "test-key",
      sleep: () => Promise.resolve(),
    });
    const tampered = createVideogenDispatchBinding({
      rail,
      materialize: (task) => ({
        ...materializeVideogenInput(task),
        promptDigest: "deadbeefdeadbeef",
      }),
    });
    const outcome = await tampered({
      executionId: "exec-1",
      task: TASK,
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
    });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "fixture-digest-mismatch",
      retryable: false,
    });
    expect(scripted.calls).toHaveLength(0); // zero REAL network effects
  });

  test("D1: a swapped materialization (fixture key mismatch) is rejected likewise", async () => {
    const swapped = createVideogenDispatchBinding({
      rail: queueRail([healthyOutcome()]).rail,
      materialize: (task) => ({
        ...materializeVideogenInput(task),
        promptKey: "vid-prompt-999",
      }),
    });
    const outcome = await swapped({
      executionId: "exec-1",
      task: TASK,
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
    });
    expect(outcome).toMatchObject({ kind: "failure", category: "fixture-digest-mismatch" });
  });

  test("the blank-prompt edge row is rejected BEFORE any paid dispatch", async () => {
    const blank = createVideogenDispatchBinding({ rail: queueRail([healthyOutcome()]).rail });
    const outcome = await blank({
      executionId: "exec-1",
      task: { kind: "generate-video", prompt: "" },
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
    });
    expect(outcome).toMatchObject({
      kind: "failure",
      category: "invalid-request",
      retryable: false,
    });
  });

  test("the zero-seconds edge row is rejected BEFORE any paid dispatch", async () => {
    const zero = createVideogenDispatchBinding({ rail: queueRail([healthyOutcome()]).rail });
    for (const seconds of [0, -1]) {
      const outcome = await zero({
        executionId: "exec-1",
        task: { kind: "generate-video", prompt: "vid-prompt-005", seconds },
        provider: "dashscope",
        model: "wan2.2-t2v-plus",
      });
      expect(outcome).toMatchObject({ kind: "failure", category: "invalid-request" });
    }
  });

  test("the binding dispatches through the REAL rail end to end (binding + rail + transport)", async () => {
    const { binding, calls } = bindingOverScriptedTransport([
      jsonResponse(200, { output: { task_id: "task-9" } }),
      jsonResponse(200, {
        output: { task_status: "SUCCEEDED", video_url: "https://assets.local/clip.mp4" },
      }),
      bytesResponse(MP4),
    ]);
    const outcome = await binding({
      executionId: "exec-1",
      task: TASK,
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
    });
    expect(outcome.kind).toBe("success");
    expect(calls.length).toBeGreaterThanOrEqual(3);
    if (outcome.kind === "success") {
      expect(outcome.taskId).toBe("task-9");
      expect(mediaDigest(outcome.video.bytes)).toBe(mediaDigest(MP4));
    }
  });

  test("retryable provider failures get the bounded retry policy; non-retryable never retry", async () => {
    // Retryable: first attempt rate-limited, second succeeds.
    const transient = queueRail([failureOutcome("rate-limit", true), healthyOutcome()]);
    const sleptMs: number[] = [];
    const retryable = createVideogenDispatchBinding({
      rail: transient.rail,
      retry: {
        attempts: 1,
        delayMs: 25,
        sleep: (ms) => {
          sleptMs.push(ms);
          return Promise.resolve();
        },
      },
    });
    const recovered = await retryable({
      executionId: "exec-1",
      task: TASK,
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
    });
    expect(recovered.kind).toBe("success");
    expect(transient.dispatchCount()).toBe(2);
    expect(sleptMs).toEqual([25]);

    // Non-retryable: never retried, even with attempts available.
    const permanent = queueRail([failureOutcome("auth", false), healthyOutcome()]);
    const noRetry = createVideogenDispatchBinding({
      rail: permanent.rail,
      retry: { attempts: 3, delayMs: 1, sleep: () => Promise.resolve() },
    });
    const failed = await noRetry({
      executionId: "exec-2",
      task: TASK,
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
    });
    expect(failed).toMatchObject({ kind: "failure", category: "auth" });
    expect(permanent.dispatchCount()).toBe(1);

    // Retryable but the budget is exhausted: honest failure after attempts+1.
    const alwaysDown = queueRail([failureOutcome("provider-unavailable", true)]);
    const exhausted = createVideogenDispatchBinding({
      rail: alwaysDown.rail,
      retry: { attempts: 2, delayMs: 1, sleep: () => Promise.resolve() },
    });
    const gaveUp = await exhausted({
      executionId: "exec-3",
      task: TASK,
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
    });
    expect(gaveUp).toMatchObject({ kind: "failure", category: "provider-unavailable" });
    expect(alwaysDown.dispatchCount()).toBe(3); // 1 + 2 retries, bounded
  });
});

// ---------------------------------------------------------------------------
// The platform-side execution driver
// ---------------------------------------------------------------------------

describe("VAL-016 execution driver", () => {
  test("a healthy dispatch completes the canonical lifecycle with mechanical verification", async () => {
    const { lifecycle, transitions } = recordingLifecycle();
    let currentMs = 1_000;
    const result = await driveVideogenExecution({
      executionId: "exec-1",
      task: TASK,
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
      ports: {
        lifecycle,
        dispatch: async () => {
          currentMs += 4_500; // the measured dispatch latency
          return healthyOutcome();
        },
        now: () => new Date(currentMs),
      },
    });
    expect(transitions).toEqual([
      "authorize",
      "plan",
      "planning-decision",
      "queue",
      "start",
      "verify",
      "complete:pass",
    ]);
    expect(result.terminal).toBe("COMPLETED");
    expect(result.dispatchLatencyMs).toBe(4_500);
    expect(result.videoDigest).toBe(mediaDigest(MP4));
    expect(result.videoByteLength).toBe(MP4.length);
    expect(result.videoContainer).toBe("mp4");
    expect(result.taskId).toBe("task-77");
    expect(result.polls).toBe(3);
    expect(result.submissionToTerminalMs).toBe(6_000);
    expect(result.requestDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(result.failureCategory).toBeNull();
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 1 });
    expect(result.criteria.every((c) => c.status === "PASS")).toBe(true);
  });

  test("a provider failure completes as FAILED (honest, never completed)", async () => {
    const { lifecycle, transitions } = recordingLifecycle();
    const result = await driveVideogenExecution({
      executionId: "exec-2",
      task: TASK,
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
      ports: {
        lifecycle,
        dispatch: async () => failureOutcome("auth", false),
        now: () => new Date(0),
      },
    });
    expect(transitions.at(-1)).toBe("complete:fail");
    expect(result.terminal).toBe("FAILED");
    expect(result.failureCategory).toBe("auth");
    expect(result.videoDigest).toBeNull();
    expect(result.criteria).toHaveLength(1);
    expect(result.criteria[0]?.status).toBe("FAIL");
  });

  test("D4: a delivered malformed container FAILS the run (mechanically, never aesthetically)", async () => {
    const { lifecycle, transitions } = recordingLifecycle();
    const result = await driveVideogenExecution({
      executionId: "exec-3",
      task: TASK,
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
      ports: {
        lifecycle,
        dispatch: async () => healthyOutcome({ bytes: syntheticPng() }),
        now: () => new Date(0),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(transitions.at(-1)).toBe("complete:fail");
    const container = result.criteria.find((c) => c.criterionId === "mp4-container");
    expect(container?.status).toBe("FAIL");
    // The delivered bytes' digest is still captured (digest, never payload).
    expect(container?.evidence.some((entry) => entry.startsWith("digest:"))).toBe(true);
  });

  test("D2: a foreign task KIND completes as an honest wrong-modality FAILED run (not a thrown NOT RUN)", async () => {
    // A foreign kind with a foreign prompt key: the modality is
    // determined by the KIND — the driver rejects it as wrong-modality
    // through the canonical lifecycle (no planning decision: nothing
    // was plannable; no network effect), never a thrown NOT RUN.
    const { lifecycle, transitions } = recordingLifecycle();
    const result = await driveVideogenExecution({
      executionId: "exec-5",
      task: { kind: "generate-image", prompt: "img-prompt-001" } as never,
      provider: "dashscope",
      model: "wan2.2-t2v-plus",
      ports: {
        lifecycle,
        dispatch: async () => healthyOutcome(),
        now: () => new Date(0),
      },
    });
    expect(result.terminal).toBe("FAILED");
    expect(result.failureCategory).toBe("wrong-modality");
    expect(result.taskId).toBeNull();
    expect(result.requestDigest).toBeNull();
    expect(result.criteria[0]?.criterionId).toBe("provider-dispatch");
    expect(result.criteria[0]?.evidence[0]).toBe("provider-failure:wrong-modality");
    expect(transitions).toEqual(["authorize", "plan", "queue", "start", "verify", "complete:fail"]); // NO planning-decision: no route existed to record
  });

  test("a missing fixture aborts BEFORE any lifecycle mutation (NOT RUN boundary)", async () => {
    const { lifecycle, transitions } = recordingLifecycle();
    await expect(
      driveVideogenExecution({
        executionId: "exec-4",
        task: { kind: "generate-video", prompt: "vid-prompt-999" },
        provider: "dashscope",
        model: "wan2.2-t2v-plus",
        ports: {
          lifecycle,
          dispatch: async () => healthyOutcome(),
          now: () => new Date(0),
        },
      }),
    ).rejects.toThrow(VideogenFixtureNotMaterializedError);
    expect(transitions).toHaveLength(0); // nothing was driven
  });
});
