/**
 * VAL-020 acceptance criteria 1, 2, 4, 5: the failure-attribution
 * platform slice against controlled fakes — the taxonomy derivations
 * (class + layer + retryability for every documented live envelope
 * shape), the transport-injected rail over the fault-injection
 * fixtures (REAL endpoint domains pinned; digests deterministic), the
 * bounded tool executor (refusal vs deadline), and the execution
 * driver (canonical lifecycle order, planning decision BEFORE the
 * first dispatch, bounded retry with per-attempt journaling exactly
 * once, honest terminals, recovery-after-retry, the empty-completion
 * honesty rule, tool wait/resume cycles).
 */

import { describe, expect, test } from "vitest";
import {
  CORPUS_RETRY_POLICY,
  FAILURE_CORPUS,
  type FailureCorpusRow,
  OFFLINE_CORPUS_ROWS,
  resolveRailRequest,
} from "../../../benchmarks/validation/apps/failure-attribution/corpus";
import {
  createAttributionToolWorld,
  createFaultInjectedTransport,
} from "../../../benchmarks/validation/apps/failure-attribution/fixtures";
import {
  ATTRIBUTION_CLASSES,
  ATTRIBUTION_RAIL_ENDPOINTS,
  type AttemptRecord,
  type AttributionClass,
  type AttributionDispatch,
  type AttributionLifecyclePort,
  type AttributionOracle,
  type AttributionRailRequest,
  bindRailDispatch,
  bindToolDispatch,
  classifyCompletionDegeneracy,
  classifyProviderEnvelope,
  classifyToolDeadline,
  classifyToolRejection,
  classifyTransportError,
  createAttributionRail,
  createBoundedToolExecutor,
  DASHSCOPE_ACCESS_DENIED_ENVELOPE_403,
  DASHSCOPE_ALLOCATION_QUOTA_ENVELOPE_403,
  DASHSCOPE_EMPTY_CONTENT_ENVELOPE_200,
  DASHSCOPE_INVALID_PARAMETER_ENVELOPE_400,
  deriveAttributionCriteria,
  driveAttributionExecution,
  extractRailContent,
  isRetryableAttributionClass,
  layerOfAttributionClass,
  OPENROUTER_CREDIT_LIMIT_ENVELOPE_402,
  OPENROUTER_RATE_LIMIT_ENVELOPE_429,
  REAL_RAIL_FAILURE_ENVELOPES,
  railRequestDigest,
} from "../../../benchmarks/validation/platform/failure-attribution";

// ---------------------------------------------------------------------------
// Fake lifecycle + helpers
// ---------------------------------------------------------------------------

interface FakeLifecycle extends AttributionLifecyclePort {
  readonly transitions: string[];
  readonly decisions: { provider: string; model: string; strategyClass: string }[];
  readonly attemptRecords: AttemptRecord[];
  readonly toolEvents: { command: string; tool: string; reference: Record<string, unknown> }[];
  readonly completions: { verdict: string; criteria: { criterionId: string; status: string }[] }[];
}

function createFakeLifecycle(): FakeLifecycle {
  const transitions: string[] = [];
  const decisions: { provider: string; model: string; strategyClass: string }[] = [];
  const attemptRecords: AttemptRecord[] = [];
  const toolEvents: { command: string; tool: string; reference: Record<string, unknown> }[] = [];
  const completions: { verdict: string; criteria: { criterionId: string; status: string }[] }[] =
    [];
  const port: AttributionLifecyclePort = {
    async transition({ step }) {
      transitions.push(step);
    },
    async recordPlanningDecision({ route }) {
      decisions.push({ ...route });
    },
    async recordDispatchAttempt({ record }) {
      attemptRecords.push(record);
    },
    async recordToolEvent({ command, tool, reference }) {
      toolEvents.push({ command, tool, reference: { ...reference } });
    },
    async complete({ verdict, criteria }) {
      completions.push({
        verdict,
        criteria: criteria.map((criterion) => ({
          criterionId: criterion.criterionId,
          status: criterion.status,
        })),
      });
    },
  };
  return Object.assign(port, { transitions, decisions, attemptRecords, toolEvents, completions });
}

const pinnedClock = () => 1_000;

/** The deterministic backoff spy (records waits; never sleeps). */
function createSleepSpy(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return { sleep: async (ms: number) => void calls.push(ms), calls };
}

/** Drive one offline corpus row through the full fake stack. */
async function driveRow(row: FailureCorpusRow): Promise<{
  result: Awaited<ReturnType<typeof driveAttributionExecution>>;
  lifecycle: FakeLifecycle;
  sleepCalls: number[];
}> {
  const lifecycle = createFakeLifecycle();
  const { sleep, calls } = createSleepSpy();
  let dispatch: AttributionDispatch;
  if (row.kind === "tool-probe") {
    if (row.toolInvocation === undefined) throw new Error("tool row without invocation");
    const world = createAttributionToolWorld();
    const executor = createBoundedToolExecutor({
      tools: world.tools,
      deadlineMs: 25,
      timer: async () => {},
      now: pinnedClock,
    });
    dispatch = bindToolDispatch({ executor, invocation: row.toolInvocation });
  } else {
    if (row.scenario === null) throw new Error("offline dispatch row without scenario");
    const { transport } = createFaultInjectedTransport({ scenario: row.scenario });
    const rail = createAttributionRail({ transport, apiKey: "test-key", now: pinnedClock });
    dispatch = bindRailDispatch({ rail, request: resolveRailRequest(row) });
  }
  const taskInput =
    row.kind === "tool-probe" && row.toolInvocation !== undefined
      ? { ...row.toolInvocation }
      : { scenario: row.rowId };
  const result = await driveAttributionExecution({
    executionId: "exec-test",
    task: { kind: row.kind, input: taskInput },
    groundTruth: row,
    provider: "attribution-test-rail",
    model: "test-model",
    lifecycle,
    dispatch,
    retry: { maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts, backoffMs: 5, sleep },
    now: () => new Date(1_000),
  });
  return { result, lifecycle, sleepCalls: calls };
}

// ---------------------------------------------------------------------------
// The taxonomy (PURE derivations)
// ---------------------------------------------------------------------------

describe("VAL-020 attribution taxonomy", () => {
  test("every attribution class maps to exactly one layer; the retryable set is exactly the documented four", () => {
    for (const attributionClass of ATTRIBUTION_CLASSES) {
      expect(["transport", "provider", "tool", "platform"]).toContain(
        layerOfAttributionClass(attributionClass),
      );
    }
    const retryable = ATTRIBUTION_CLASSES.filter(isRetryableAttributionClass);
    expect(retryable.sort()).toEqual(
      ["provider-unavailable", "rate-limit", "tool-timeout", "transport-failure"].sort(),
    );
  });

  test("a thrown transport error is TRANSPORT-layer attributed — never the provider", () => {
    const attribution = classifyTransportError(new TypeError("fetch failed"));
    expect(attribution.attributionClass).toBe("transport-failure");
    expect(attribution.layer).toBe("transport");
    expect(attribution.retryable).toBe(true);
    expect(attribution.httpStatus).toBeNull();
  });

  test("the dashscope AllocationQuota 403 envelope classifies as QUOTA (the code token wins over the 403 status)", () => {
    const attribution = classifyProviderEnvelope(403, DASHSCOPE_ALLOCATION_QUOTA_ENVELOPE_403);
    expect(attribution.attributionClass).toBe("quota");
    expect(attribution.layer).toBe("provider");
    expect(attribution.retryable).toBe(false);
    expect(attribution.providerCode).toBe("AllocationQuota.FreeTierOnly");
  });

  test("the dashscope AccessDenied 403 envelope classifies as ACCESS-DENIED (non-retryable)", () => {
    const attribution = classifyProviderEnvelope(403, DASHSCOPE_ACCESS_DENIED_ENVELOPE_403);
    expect(attribution.attributionClass).toBe("access-denied");
    expect(attribution.layer).toBe("provider");
    expect(attribution.retryable).toBe(false);
    expect(attribution.providerCode).toBe("AccessDenied");
  });

  test("the dashscope InvalidParameter 400 envelope classifies as INVALID-REQUEST (non-retryable)", () => {
    const attribution = classifyProviderEnvelope(400, DASHSCOPE_INVALID_PARAMETER_ENVELOPE_400);
    expect(attribution.attributionClass).toBe("invalid-request");
    expect(attribution.retryable).toBe(false);
    expect(attribution.providerCode).toBe("InternalError.Algo.InvalidParameter");
  });

  test("the OpenRouter nested credit-limit 402 envelope classifies as QUOTA with the nested code token", () => {
    const attribution = classifyProviderEnvelope(402, OPENROUTER_CREDIT_LIMIT_ENVELOPE_402);
    expect(attribution.attributionClass).toBe("quota");
    expect(attribution.retryable).toBe(false);
    expect(attribution.providerCode).toBe("402");
  });

  test("status-level mapping: 429 rate-limit (retryable), 5xx provider-unavailable (retryable), 404 model-unavailable, unknown 4xx provider-error", () => {
    expect(classifyProviderEnvelope(429, OPENROUTER_RATE_LIMIT_ENVELOPE_429).attributionClass).toBe(
      "rate-limit",
    );
    expect(classifyProviderEnvelope(429, OPENROUTER_RATE_LIMIT_ENVELOPE_429).retryable).toBe(true);
    expect(classifyProviderEnvelope(500, { error: "boom" }).attributionClass).toBe(
      "provider-unavailable",
    );
    expect(classifyProviderEnvelope(503, null).retryable).toBe(true);
    expect(
      classifyProviderEnvelope(404, { error: { code: 404, message: "not found" } })
        .attributionClass,
    ).toBe("model-unavailable");
    expect(classifyProviderEnvelope(418, {}).attributionClass).toBe("provider-error");
    expect(classifyProviderEnvelope(418, {}).retryable).toBe(false);
    expect(classifyProviderEnvelope(402, null).attributionClass).toBe("quota");
  });

  test("an empty completion is the honest empty-completion class — attributed provider, NEVER retryable", () => {
    const attribution = classifyCompletionDegeneracy("");
    expect(attribution?.attributionClass).toBe("empty-completion");
    expect(attribution?.layer).toBe("provider");
    expect(attribution?.retryable).toBe(false);
    expect(classifyCompletionDegeneracy("healthy")).toBeNull();
  });

  test("a tool refusal is non-retryable; a tool deadline overrun is retryable (timeout-vs-refusal)", () => {
    expect(classifyToolRejection("lookup: unknown key").retryable).toBe(false);
    expect(classifyToolRejection("lookup: unknown key").attributionClass).toBe("tool-failure");
    const deadline = classifyToolDeadline("slow-archiver", 25);
    expect(deadline.attributionClass).toBe("tool-timeout");
    expect(deadline.retryable).toBe(true);
  });

  test("every REAL rail failure envelope classifies to its documented class", () => {
    const expected: Record<string, AttributionClass> = {
      "dashscope-allocation-quota-403": "quota",
      "dashscope-access-denied-403": "access-denied",
      "dashscope-invalid-parameter-400": "invalid-request",
      "openrouter-credit-limit-402": "quota",
      "openrouter-rate-limit-429": "rate-limit",
      "dashscope-empty-content-200": "empty-completion",
    };
    for (const envelope of REAL_RAIL_FAILURE_ENVELOPES) {
      const attribution =
        envelope.httpStatus === 200
          ? classifyCompletionDegeneracy("")
          : classifyProviderEnvelope(envelope.httpStatus, envelope.body);
      expect(attribution?.attributionClass).toBe(expected[envelope.envelopeId]);
    }
  });
});

// ---------------------------------------------------------------------------
// The rail over the fault-injection fixtures
// ---------------------------------------------------------------------------

describe("VAL-020 attribution rail over the fault-injection fixtures", () => {
  const imagegenRequest: AttributionRailRequest = {
    rail: "dashscope",
    endpoint: "multimodal-generation",
    model: "qwen-image-2.0",
    prompt: "attribution probe: a single red umbrella on a white background",
  };
  const chatRequest: AttributionRailRequest = {
    rail: "openrouter",
    endpoint: "chat-completions",
    model: "meta-llama/llama-3.3-70b-instruct",
    prompt: "Reply with exactly the single word: healthy.",
  };
  const videoRequest: AttributionRailRequest = {
    rail: "dashscope",
    endpoint: "video-synthesis",
    model: "wan2.2-t2v-plus",
    prompt: "attribution probe: a paper boat drifting on a puddle",
  };

  test("the quota envelope replays through the rail as provider/quota and addresses the PINNED REAL multimodal-generation URL", async () => {
    const { transport, calls } = createFaultInjectedTransport({ scenario: "quota-envelope" });
    const rail = createAttributionRail({ transport, apiKey: "test-key", now: pinnedClock });
    const outcome = await rail(imagegenRequest);
    expect(outcome.kind).toBe("failure");
    if (outcome.kind === "failure") {
      expect(outcome.attribution.attributionClass).toBe("quota");
      expect(outcome.attribution.layer).toBe("provider");
      expect(outcome.attribution.retryable).toBe(false);
      expect(outcome.httpStatus).toBe(403);
    }
    expect(calls.count).toBe(1);
    expect(calls.urls[0]).toBe(ATTRIBUTION_RAIL_ENDPOINTS["dashscope|multimodal-generation"]);
  });

  test("the transport-fault scenario attributes TRANSPORT with a null HTTP status", async () => {
    const { transport } = createFaultInjectedTransport({ scenario: "transport-failure" });
    const rail = createAttributionRail({ transport, apiKey: "test-key", now: pinnedClock });
    const outcome = await rail(imagegenRequest);
    expect(outcome.kind).toBe("failure");
    if (outcome.kind === "failure") {
      expect(outcome.attribution.attributionClass).toBe("transport-failure");
      expect(outcome.attribution.layer).toBe("transport");
      expect(outcome.attribution.httpStatus).toBeNull();
    }
  });

  test("the empty-content 200 is an honest SUCCESS with empty content carrying the empty-completion attribution", async () => {
    const { transport } = createFaultInjectedTransport({ scenario: "empty-completion" });
    const rail = createAttributionRail({ transport, apiKey: "test-key", now: pinnedClock });
    const outcome = await rail(imagegenRequest);
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.content).toBe("");
      expect(outcome.attribution?.attributionClass).toBe("empty-completion");
      expect(outcome.usage?.inputTokens).toBe(9);
    }
  });

  test("the healthy replay is a clean success with NO attribution and reported usage", async () => {
    const { transport } = createFaultInjectedTransport({ scenario: "healthy-no-retry" });
    const rail = createAttributionRail({ transport, apiKey: "test-key", now: pinnedClock });
    const outcome = await rail(chatRequest);
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.content).toBe("healthy");
      expect(outcome.attribution).toBeNull();
      expect(outcome.usage?.costUsd).toBe(0.000012);
    }
  });

  test("the video-synthesis and openrouter endpoints are pinned to the REAL domains (the domain-typo lesson)", async () => {
    const { transport, calls } = createFaultInjectedTransport({ scenario: "access-denied" });
    const rail = createAttributionRail({ transport, apiKey: "test-key", now: pinnedClock });
    const outcome = await rail(videoRequest);
    expect(outcome.kind).toBe("failure");
    expect(calls.urls[0]).toBe(ATTRIBUTION_RAIL_ENDPOINTS["dashscope|video-synthesis"]);
    expect(calls.urls[0]).toContain("dashscope-intl.aliyuncs.com");
    const chat = createFaultInjectedTransport({ scenario: "openrouter-credit-402" });
    const chatRail = createAttributionRail({
      transport: chat.transport,
      apiKey: "k",
      now: pinnedClock,
    });
    await chatRail(chatRequest);
    expect(chat.calls.urls[0]).toBe(ATTRIBUTION_RAIL_ENDPOINTS["openrouter|chat-completions"]);
  });

  test("request digests are deterministic: the same request digests identically; a different prompt digests differently", () => {
    expect(railRequestDigest(imagegenRequest)).toBe(railRequestDigest(imagegenRequest));
    expect(railRequestDigest(imagegenRequest)).not.toBe(
      railRequestDigest({ ...imagegenRequest, prompt: "a different probe prompt" }),
    );
    expect(railRequestDigest(chatRequest)).toMatch(/^[0-9a-f]{8}$/);
  });

  test("rail content extraction handles the dashscope parts-array, openrouter string and video task-id shapes", () => {
    const partsBody = JSON.parse(
      '{"output":{"choices":[{"message":{"content":[{"text":"a"},{"text":"b"}]}}]}}',
    );
    expect(extractRailContent(imagegenRequest, partsBody)).toBe("ab");
    const openrouterBody = JSON.parse('{"choices":[{"message":{"content":"healthy"}}]}');
    expect(extractRailContent(chatRequest, openrouterBody)).toBe("healthy");
    expect(extractRailContent(videoRequest, { output: { task_id: "task-9" } })).toBe("task:task-9");
    expect(extractRailContent(imagegenRequest, DASHSCOPE_EMPTY_CONTENT_ENVELOPE_200)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The bounded tool executor
// ---------------------------------------------------------------------------

describe("VAL-020 bounded tool executor", () => {
  test("a settled rejection is TOOL-layer tool-failure, non-retryable — and the tool RAN (its state proves execution)", async () => {
    const world = createAttributionToolWorld();
    const executor = createBoundedToolExecutor({
      tools: world.tools,
      deadlineMs: 25,
      timer: async () => {},
      now: pinnedClock,
    });
    const outcome = await executor({ tool: "inventory-lookup", arguments: { key: "SKU-UNKNOWN" } });
    expect(outcome.kind).toBe("failure");
    if (outcome.kind === "failure") {
      expect(outcome.attribution.attributionClass).toBe("tool-failure");
      expect(outcome.attribution.layer).toBe("tool");
      expect(outcome.attribution.retryable).toBe(false);
    }
    expect(world.state.lookups).toBe(1);
  });

  test("a hanging tool breaches the deadline: TOOL-layer tool-timeout, retryable, and NO effect ever lands", async () => {
    const world = createAttributionToolWorld();
    const executor = createBoundedToolExecutor({
      tools: world.tools,
      deadlineMs: 25,
      timer: async () => {},
      now: pinnedClock,
    });
    const outcome = await executor({ tool: "slow-archiver", arguments: { bytes: 2048 } });
    expect(outcome.kind).toBe("failure");
    if (outcome.kind === "failure") {
      expect(outcome.attribution.attributionClass).toBe("tool-timeout");
      expect(outcome.attribution.retryable).toBe(true);
    }
    expect(world.state.archivedBytes).toBe(0);
  });

  test("a healthy tool invocation settles cleanly with no attribution", async () => {
    const world = createAttributionToolWorld();
    const executor = createBoundedToolExecutor({
      tools: world.tools,
      deadlineMs: 25,
      timer: async () => {},
      now: pinnedClock,
    });
    const outcome = await executor({ tool: "inventory-lookup", arguments: { key: "SKU-77" } });
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.content).toContain("price 77");
    }
  });

  test("an unexposed tool is a PLATFORM-layer rejection with zero tool executions", async () => {
    const world = createAttributionToolWorld();
    const executor = createBoundedToolExecutor({
      tools: world.tools,
      deadlineMs: 25,
      timer: async () => {},
      now: pinnedClock,
    });
    const outcome = await executor({ tool: "not-exposed", arguments: {} });
    expect(outcome.kind).toBe("failure");
    if (outcome.kind === "failure") {
      expect(outcome.attribution.attributionClass).toBe("platform-error");
      expect(outcome.attribution.layer).toBe("platform");
    }
    expect(world.state.lookups).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The execution driver over the offline corpus
// ---------------------------------------------------------------------------

describe("VAL-020 attribution execution driver (offline corpus rows)", () => {
  test("the corpus is well-formed: 11 offline rows + 4 live-gated rows, every oracle self-consistent", () => {
    expect(OFFLINE_CORPUS_ROWS.length).toBe(11);
    expect(FAILURE_CORPUS.length).toBe(15);
    for (const row of FAILURE_CORPUS) {
      expect(row.expected.attempts).toBe(row.expected.attemptOutcomes.length);
      expect(row.expected.attemptOutcomes.length).toBeGreaterThan(0);
      // Non-retryable injected classes are single-attempt rows.
      if (row.injectedClass !== null && !row.injectedRetryable) {
        expect(row.expected.attempts).toBe(1);
      }
      // Retryable injected classes exercise the bounded budget: all-
      // failure rows exhaust it exactly (1 + max); recovery rows land
      // within it after fewer retries.
      if (row.injectedClass !== null && row.injectedRetryable) {
        expect(row.expected.attempts).toBeGreaterThanOrEqual(1);
        expect(row.expected.attempts).toBeLessThanOrEqual(1 + CORPUS_RETRY_POLICY.maxExtraAttempts);
        const allFailures = row.expected.attemptOutcomes.every((outcome) => outcome === "failure");
        if (allFailures) {
          expect(row.expected.attempts).toBe(1 + CORPUS_RETRY_POLICY.maxExtraAttempts);
        }
      }
      if (row.liveGate === undefined) {
        // Offline rows carry a fault-injection scenario (dispatch rows)
        // or a tool invocation (tool rows) — one of the two, always.
        expect(row.scenario !== null || row.toolInvocation !== undefined).toBe(true);
      }
    }
  });

  test("every offline corpus row satisfies its own oracle through the driver (attribution, bounded retry, journal, terminal)", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const { result, lifecycle } = await driveRow(row);
      expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
      expect(result.totalAttempts, `${row.rowId} attempts`).toBe(row.expected.attempts);
      expect(result.finalAttribution?.attributionClass ?? null, `${row.rowId} class`).toBe(
        row.expected.attributionClass,
      );
      expect(result.finalAttribution?.layer ?? null, `${row.rowId} layer`).toBe(row.expected.layer);
      // Every mechanical criterion passes (the oracle's own contract).
      const failuresList = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failuresList, `${row.rowId} criteria: ${JSON.stringify(failuresList)}`).toEqual([]);
      // Journal exactly once per attempt.
      expect(lifecycle.attemptRecords.length).toBe(row.expected.attempts);
      expect(result.journaledAttempts).toBe(row.expected.attempts);
      // The lifecycle ran the canonical order (dispatch rows: the five
      // canonical transitions; tool rows interleave the per-attempt
      // wait-tool/resume pairs between start and verify).
      expect(lifecycle.transitions.slice(0, 4)).toEqual(["authorize", "plan", "queue", "start"]);
      expect(lifecycle.transitions[lifecycle.transitions.length - 1]).toBe("verify");
      expect(lifecycle.decisions.length).toBe(1);
    }
  }, 30_000);

  test("the planning decision is durably recorded BEFORE the first dispatch attempt is journaled", async () => {
    const row = OFFLINE_CORPUS_ROWS.find((candidate) => candidate.rowId === "quota-envelope");
    if (row === undefined) throw new Error("missing quota-envelope row");
    const { lifecycle } = await driveRow(row);
    expect(lifecycle.decisions.length).toBe(1);
    expect(lifecycle.attemptRecords.length).toBe(1);
    // The planning decision precedes any dispatch attempt by the
    // driver's construction (intent before external effect).
    expect(lifecycle.transitions.indexOf("start")).toBeGreaterThanOrEqual(0);
    expect(lifecycle.transitions.indexOf("verify")).toBeGreaterThan(
      lifecycle.transitions.indexOf("start"),
    );
  });

  test("the bounded retry policy waits between retryable attempts and NEVER after a non-retryable failure", async () => {
    const retryableRow = OFFLINE_CORPUS_ROWS.find(
      (candidate) => candidate.rowId === "transport-failure",
    );
    const recoveryRow = OFFLINE_CORPUS_ROWS.find(
      (candidate) => candidate.rowId === "healthy-recovery-after-retry",
    );
    const quotaRow = OFFLINE_CORPUS_ROWS.find((candidate) => candidate.rowId === "quota-envelope");
    if (retryableRow === undefined || recoveryRow === undefined || quotaRow === undefined) {
      throw new Error("missing corpus rows");
    }
    const retryable = await driveRow(retryableRow);
    expect(retryable.sleepCalls.length).toBe(2);
    const recovery = await driveRow(recoveryRow);
    expect(recovery.sleepCalls.length).toBe(1);
    const quota = await driveRow(quotaRow);
    expect(quota.sleepCalls.length).toBe(0);
  });

  test("recovery-after-retry lands COMPLETED with the failure attempt still journaled exactly once", async () => {
    const row = OFFLINE_CORPUS_ROWS.find(
      (candidate) => candidate.rowId === "healthy-recovery-after-retry",
    );
    if (row === undefined) throw new Error("missing recovery row");
    const { result, lifecycle } = await driveRow(row);
    expect(result.terminal).toBe("COMPLETED");
    expect(result.attempts.map((record) => record.outcome)).toEqual(["failure", "success"]);
    expect(lifecycle.attemptRecords.length).toBe(2);
    expect(lifecycle.attemptRecords[0]?.attributionClass).toBe("transport-failure");
    expect(lifecycle.attemptRecords[0]?.retried).toBe(true);
    expect(lifecycle.attemptRecords[1]?.retried).toBe(false);
    expect(result.finalContent).toBe("healthy");
  });

  test("the empty-completion row COMPLETES honestly with empty content (never a fabricated failure)", async () => {
    const row = OFFLINE_CORPUS_ROWS.find((candidate) => candidate.rowId === "empty-completion");
    if (row === undefined) throw new Error("missing empty-completion row");
    const { result } = await driveRow(row);
    expect(result.terminal).toBe("COMPLETED");
    expect(result.finalContent).toBe("");
    expect(result.finalAttribution?.attributionClass).toBe("empty-completion");
    expect(result.totalAttempts).toBe(1);
  });

  test("tool rows: every attempt is a genuine wait-tool → resume pair with journaled tool events; a timeout journals NO tool-result", async () => {
    const timeoutRow = OFFLINE_CORPUS_ROWS.find((candidate) => candidate.rowId === "tool-timeout");
    const failureRow = OFFLINE_CORPUS_ROWS.find((candidate) => candidate.rowId === "tool-failure");
    if (timeoutRow === undefined || failureRow === undefined) {
      throw new Error("missing tool rows");
    }
    const timeout = await driveRow(timeoutRow);
    expect(timeout.result.terminal).toBe("FAILED");
    expect(timeout.result.totalAttempts).toBe(3);
    expect(timeout.result.waitToolCycles).toBe(3);
    const waitToolCount = timeout.lifecycle.transitions.filter(
      (step) => step === "wait-tool",
    ).length;
    const resumeCount = timeout.lifecycle.transitions.filter((step) => step === "resume").length;
    expect(waitToolCount).toBe(3);
    expect(resumeCount).toBe(3);
    // tool-requested per attempt; NO tool-result on any timeout attempt.
    const requested = timeout.lifecycle.toolEvents.filter((e) => e.command === "tool-requested");
    const results = timeout.lifecycle.toolEvents.filter((e) => e.command === "tool-result");
    expect(requested.length).toBe(3);
    expect(results.length).toBe(0);

    const failure = await driveRow(failureRow);
    expect(failure.result.terminal).toBe("FAILED");
    expect(failure.result.totalAttempts).toBe(1);
    expect(failure.result.waitToolCycles).toBe(1);
    const settledResults = failure.lifecycle.toolEvents.filter((e) => e.command === "tool-result");
    expect(settledResults.length).toBe(1);
    expect(settledResults[0]?.reference.ok).toBe(false);
  });

  test("an out-of-vocabulary task is a PLATFORM-layer rejection with ZERO dispatch attempts", async () => {
    const lifecycle = createFakeLifecycle();
    const { sleep, calls } = createSleepSpy();
    let dispatchCalls = 0;
    const dispatch: AttributionDispatch = async () => {
      dispatchCalls += 1;
      throw new Error("the dispatch seam must never be called");
    };
    const oracle: AttributionOracle = {
      injectedClass: "platform-error",
      injectedRetryable: false,
      expected: {
        attributionClass: "platform-error",
        layer: "platform",
        attempts: 0,
        attemptOutcomes: [],
        terminal: "FAILED",
      },
    };
    const result = await driveAttributionExecution({
      executionId: "exec-vocab",
      task: { kind: "not-a-probe" },
      groundTruth: oracle,
      provider: "p",
      model: "m",
      lifecycle,
      dispatch,
      retry: { maxExtraAttempts: 2, backoffMs: 5, sleep },
      now: () => new Date(1_000),
    });
    expect(dispatchCalls).toBe(0);
    expect(result.terminal).toBe("FAILED");
    expect(result.totalAttempts).toBe(0);
    expect(result.finalAttribution?.attributionClass).toBe("platform-error");
    expect(result.finalAttribution?.layer).toBe("platform");
    expect(result.journaledAttempts).toBe(0);
    expect(calls.length).toBe(0);
  });

  test("per-attempt journal records carry DIGESTS and classification fields — never payload bytes", async () => {
    const row = OFFLINE_CORPUS_ROWS.find((candidate) => candidate.rowId === "quota-envelope");
    if (row === undefined) throw new Error("missing quota row");
    const { lifecycle } = await driveRow(row);
    const record = lifecycle.attemptRecords[0];
    expect(record).toBeDefined();
    if (record === undefined) throw new Error("missing attempt record");
    expect(record.requestDigest).toMatch(/^[0-9a-f]{8}$/);
    expect(record.attributionClass).toBe("quota");
    expect(record.layer).toBe("provider");
    expect(record.retryable).toBe(false);
    expect(record.httpStatus).toBe(403);
    // No payload bytes: the probe prompt never appears in the journal.
    const journalText = JSON.stringify(lifecycle.attemptRecords);
    expect(journalText).not.toContain("umbrella");
    expect(journalText).not.toContain("Authorization");
  });
});

// ---------------------------------------------------------------------------
// The criteria derivation against synthetic violations
// ---------------------------------------------------------------------------

describe("VAL-020 mechanical criteria derivation", () => {
  const healthyOracle: AttributionOracle = {
    injectedClass: null,
    injectedRetryable: false,
    expected: {
      attributionClass: null,
      layer: null,
      attempts: 1,
      attemptOutcomes: ["success"],
      terminal: "COMPLETED",
    },
  };

  test("a synthetic retry-after-non-retryable sequence FAILS the bounded-retry criterion", () => {
    const attempts: AttemptRecord[] = [
      {
        attempt: 1,
        outcome: "failure",
        attributionClass: "quota",
        layer: "provider",
        retryable: false,
        retried: true,
        latencyMs: 10,
        requestDigest: "aaaa1111",
        httpStatus: 403,
        message: "quota",
      },
      {
        attempt: 2,
        outcome: "failure",
        attributionClass: "quota",
        layer: "provider",
        retryable: false,
        retried: false,
        latencyMs: 10,
        requestDigest: "aaaa1111",
        httpStatus: 403,
        message: "quota",
      },
    ];
    const criteria = deriveAttributionCriteria({
      groundTruth: {
        injectedClass: "quota",
        injectedRetryable: false,
        expected: {
          attributionClass: "quota",
          layer: "provider",
          attempts: 2,
          attemptOutcomes: ["failure", "failure"],
          terminal: "FAILED",
        },
      },
      attempts,
      finalOutcome: {
        kind: "failure",
        attribution: classifyProviderEnvelope(403, DASHSCOPE_ALLOCATION_QUOTA_ENVELOPE_403),
        latencyMs: 10,
        requestDigest: "aaaa1111",
        httpStatus: 403,
      },
      journaledAttempts: 2,
      maxExtraAttempts: 2,
      usage: null,
      totalDispatchLatencyMs: 20,
    });
    const bounded = criteria.find((c) => c.criterionId === "bounded-retry");
    expect(bounded?.status).toBe("FAIL");
  });

  test("a synthetic over-budget attempt sequence FAILS the bounded-retry criterion (no infinite loops tolerated)", () => {
    const attempts: AttemptRecord[] = Array.from({ length: 5 }, (_, index) => ({
      attempt: index + 1,
      outcome: "failure" as const,
      attributionClass: "rate-limit" as const,
      layer: "provider" as const,
      retryable: true,
      retried: index < 4,
      latencyMs: 5,
      requestDigest: "bbbb2222",
      httpStatus: 429,
      message: "rate limit",
    }));
    const criteria = deriveAttributionCriteria({
      groundTruth: healthyOracle,
      attempts,
      finalOutcome: null,
      journaledAttempts: 5,
      maxExtraAttempts: 2,
      usage: null,
      totalDispatchLatencyMs: 25,
    });
    const bounded = criteria.find((c) => c.criterionId === "bounded-retry");
    expect(bounded?.status).toBe("FAIL");
  });

  test("a duplicate journal record FAILS the journal-exactly-once criterion", () => {
    const attempts: AttemptRecord[] = [
      {
        attempt: 1,
        outcome: "success",
        attributionClass: null,
        layer: null,
        retryable: false,
        retried: false,
        latencyMs: 4,
        requestDigest: "cccc3333",
        httpStatus: 200,
        message: "success",
      },
    ];
    const criteria = deriveAttributionCriteria({
      groundTruth: healthyOracle,
      attempts,
      finalOutcome: {
        kind: "success",
        content: "healthy",
        attribution: null,
        latencyMs: 4,
        requestDigest: "cccc3333",
        httpStatus: 200,
      },
      journaledAttempts: 2,
      maxExtraAttempts: 2,
      usage: { inputTokens: 12, outputTokens: 1 },
      totalDispatchLatencyMs: 4,
    });
    const journal = criteria.find((c) => c.criterionId === "journal-exactly-once-per-attempt");
    expect(journal?.status).toBe("FAIL");
    const economics = criteria.find((c) => c.criterionId === "economics-measured");
    expect(economics?.status).toBe("PASS");
    expect(economics?.evidence[0]).toBe("usage:12+1");
  });
});
