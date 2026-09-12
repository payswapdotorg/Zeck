/**
 * VAL-020 acceptance criterion 6 — discrimination tests proving the
 * failure-attribution derivations against controlled fakes:
 *
 *   * envelope-shape confusion — the dashscope AllocationQuota 403 is
 *     QUOTA (the code token wins over the raw status), never
 *     access-denied; a 200 is NEVER a provider-error envelope failure
 *     (empty content is the honest empty-completion success); a 429
 *     with a success-shaped body is rate-limit, never a success; a
 *     402 without any envelope is still quota;
 *   * wrong-layer attribution — a transport throw is TRANSPORT layer
 *     (never the provider); a tool refusal is TOOL layer (never the
 *     provider); an oracle expecting the WRONG layer fails its
 *     criterion mechanically (mis-attribution cannot pass);
 *   * retry-policy boundary violations — a synthetic retry after a
 *     non-retryable failure FAILS the bounded-retry criterion; a
 *     synthetic over-budget attempt sequence FAILS it (no infinite
 *     loops tolerated); the real driver produces neither shape;
 *   * timeout-vs-refusal classification — a deadline overrun is the
 *     RETRYABLE tool-timeout (retried within the budget, zero
 *     effects); a settled refusal is the NON-retryable tool-failure
 *     (exactly one attempt, the tool demonstrably RAN);
 *   * pre-effect rejection — out-of-vocabulary tasks and unexposed
 *     tools are platform-layer rejections with ZERO transport calls
 *     and ZERO tool executions;
 *   * journal digest isolation — the per-attempt journal carries
 *     digests only; payload text and credential material never appear;
 *   * recovery honesty — the recovery row's failed attempt stays
 *     journaled (never silently swallowed) with retried recorded;
 *   * request reproducibility — identical inputs produce identical
 *     request digests; every attempt (retries included) addresses the
 *     PINNED REAL endpoint domains.
 */

import { describe, expect, test } from "vitest";
import {
  CORPUS_RETRY_POLICY,
  type FailureCorpusRow,
  OFFLINE_CORPUS_ROWS,
  resolveRailRequest,
} from "../../benchmarks/validation/apps/failure-attribution/corpus";
import {
  createAttributionToolWorld,
  createFaultInjectedTransport,
} from "../../benchmarks/validation/apps/failure-attribution/fixtures";
import {
  type AttemptRecord,
  type AttributionDispatch,
  type AttributionLifecyclePort,
  type AttributionOracle,
  bindRailDispatch,
  bindToolDispatch,
  classifyCompletionDegeneracy,
  classifyProviderEnvelope,
  classifyTransportError,
  createAttributionRail,
  createBoundedToolExecutor,
  DASHSCOPE_ACCESS_DENIED_ENVELOPE_403,
  DASHSCOPE_ALLOCATION_QUOTA_ENVELOPE_403,
  deriveAttributionCriteria,
  driveAttributionExecution,
} from "../../benchmarks/validation/platform/failure-attribution";

const pinnedClock = () => 1_000;
const noSleep = async () => {};

function recordingLifecycle(): {
  readonly lifecycle: AttributionLifecyclePort;
  readonly attemptRecords: AttemptRecord[];
  readonly toolEvents: { command: string; tool: string; reference: Record<string, unknown> }[];
} {
  const attemptRecords: AttemptRecord[] = [];
  const toolEvents: { command: string; tool: string; reference: Record<string, unknown> }[] = [];
  const lifecycle: AttributionLifecyclePort = {
    async transition() {},
    async recordPlanningDecision() {},
    async recordDispatchAttempt({ record }) {
      attemptRecords.push(record);
    },
    async recordToolEvent({ command, tool, reference }) {
      toolEvents.push({ command, tool, reference: { ...reference } });
    },
    async complete() {},
  };
  return { lifecycle, attemptRecords, toolEvents };
}

function railDispatchFor(row: FailureCorpusRow): {
  readonly dispatch: AttributionDispatch;
  readonly calls: { count: number; urls: string[] };
} {
  if (row.scenario === null) throw new Error("dispatch row without scenario");
  const { transport, calls } = createFaultInjectedTransport({ scenario: row.scenario });
  const rail = createAttributionRail({ transport, apiKey: "discrimination-key", now: pinnedClock });
  return { dispatch: bindRailDispatch({ rail, request: resolveRailRequest(row) }), calls };
}

async function driveRowWithLifecycle(
  row: FailureCorpusRow,
  groundTruth: AttributionOracle,
): Promise<{
  readonly result: Awaited<ReturnType<typeof driveAttributionExecution>>;
  readonly attemptRecords: readonly AttemptRecord[];
  readonly calls: { count: number; urls: string[] };
}> {
  const { lifecycle, attemptRecords } = recordingLifecycle();
  const { dispatch, calls } = railDispatchFor(row);
  const result = await driveAttributionExecution({
    executionId: "exec-disc",
    task: { kind: row.kind, input: { scenario: row.rowId } },
    groundTruth,
    provider: "attribution-discrimination-rail",
    model: "discrimination-model",
    lifecycle,
    dispatch,
    retry: { maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts, backoffMs: 0, sleep: noSleep },
    now: () => new Date(1_000),
  });
  return { result, attemptRecords, calls };
}

const row = (rowId: string): FailureCorpusRow => {
  const found = OFFLINE_CORPUS_ROWS.find((candidate) => candidate.rowId === rowId);
  if (found === undefined) throw new Error(`missing corpus row ${rowId}`);
  return found;
};

describe("failure-attribution discrimination (VAL-020 AC6)", () => {
  test("envelope-shape confusion: the AllocationQuota 403 is QUOTA (the code token wins over the 403 status), never access-denied — and vice versa", () => {
    const quota = classifyProviderEnvelope(403, DASHSCOPE_ALLOCATION_QUOTA_ENVELOPE_403);
    const denied = classifyProviderEnvelope(403, DASHSCOPE_ACCESS_DENIED_ENVELOPE_403);
    expect(quota.attributionClass).toBe("quota");
    expect(quota.attributionClass).not.toBe("access-denied");
    expect(denied.attributionClass).toBe("access-denied");
    expect(denied.attributionClass).not.toBe("quota");
    // The discrimination is exactly the envelope: identical statuses,
    // disjoint classes.
    expect(quota.httpStatus).toBe(denied.httpStatus);
  });

  test("envelope-shape confusion: a 200 is NEVER a provider-error envelope failure; a 429 with a success-shaped body is rate-limit, never a success; a bare 402 is still quota", () => {
    const empty200 = classifyCompletionDegeneracy("");
    expect(empty200?.attributionClass).toBe("empty-completion");
    expect(empty200?.attributionClass).not.toBe("provider-error");
    // A 200 with stray error-ish fields but NON-empty content is a
    // clean success (no attribution at all).
    expect(classifyCompletionDegeneracy("healthy")).toBeNull();
    // A 429 carrying choices-shaped content is still the rate-limit
    // failure (non-2xx status wins over any body shape).
    const rateLimited = classifyProviderEnvelope(429, {
      choices: [{ message: { content: "looks fine" } }],
    });
    expect(rateLimited.attributionClass).toBe("rate-limit");
    expect(rateLimited.retryable).toBe(true);
    // A 402 with NO envelope body at all is still the quota class.
    expect(classifyProviderEnvelope(402, null).attributionClass).toBe("quota");
  });

  test("wrong-layer attribution: a transport throw is TRANSPORT layer — an oracle expecting the provider layer fails its criterion mechanically", async () => {
    const transportRow = row("transport-failure");
    // The CORRECT oracle passes (already covered by the unit suite);
    // here the deliberately WRONG layer oracle must FAIL.
    const wrongLayerOracle: AttributionOracle = {
      injectedClass: "transport-failure",
      injectedRetryable: true,
      expected: {
        attributionClass: "transport-failure",
        layer: "provider",
        attempts: 3,
        attemptOutcomes: ["failure", "failure", "failure"],
        terminal: "FAILED",
      },
    };
    const { result } = await driveRowWithLifecycle(transportRow, wrongLayerOracle);
    const layerCriterion = result.criteria.find((c) => c.criterionId === "attribution-layer");
    expect(layerCriterion?.status).toBe("FAIL");
    expect(result.terminal).toBe("FAILED");
    // And the direct derivation: the transport class is never provider.
    expect(classifyTransportError(new Error("boom")).layer).not.toBe("provider");
  });

  test("wrong-layer attribution: a tool refusal is TOOL layer — an oracle expecting provider fails; the tool demonstrably RAN", async () => {
    const toolRow = row("tool-failure");
    const world = createAttributionToolWorld();
    const executor = createBoundedToolExecutor({
      tools: world.tools,
      deadlineMs: 25,
      timer: async () => {},
      now: pinnedClock,
    });
    const { lifecycle, attemptRecords } = recordingLifecycle();
    const wrongOracle: AttributionOracle = {
      injectedClass: "tool-failure",
      injectedRetryable: false,
      expected: {
        attributionClass: "tool-failure",
        layer: "provider",
        attempts: 1,
        attemptOutcomes: ["failure"],
        terminal: "FAILED",
      },
    };
    const result = await driveAttributionExecution({
      executionId: "exec-tool-disc",
      task: { kind: "tool-probe", input: toolRow.toolInvocation },
      groundTruth: wrongOracle,
      provider: "p",
      model: "m",
      lifecycle,
      dispatch: bindToolDispatch({
        executor,
        invocation: toolRow.toolInvocation ?? { tool: "inventory-lookup", arguments: {} },
      }),
      retry: { maxExtraAttempts: 2, backoffMs: 0, sleep: noSleep },
      now: () => new Date(1_000),
    });
    const layerCriterion = result.criteria.find((c) => c.criterionId === "attribution-layer");
    expect(layerCriterion?.status).toBe("FAIL");
    // The tool layer actually executed (its state proves it) — the
    // failure is genuinely the tool's, never the provider's.
    expect(world.state.lookups).toBe(1);
    expect(attemptRecords[0]?.layer).toBe("tool");
  });

  test("retry-policy boundary violations: a synthetic retry after a non-retryable failure FAILS bounded-retry; a synthetic over-budget sequence FAILS it; the real driver produces neither", async () => {
    // (a) Synthetic: attempt 2 exists after a non-retryable attempt 1.
    const nonRetryableFirst: AttemptRecord[] = [
      {
        attempt: 1,
        outcome: "failure",
        attributionClass: "quota",
        layer: "provider",
        retryable: false,
        retried: true,
        latencyMs: 3,
        requestDigest: "aaaa0000",
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
        latencyMs: 3,
        requestDigest: "aaaa0000",
        httpStatus: 403,
        message: "quota",
      },
    ];
    const violated = deriveAttributionCriteria({
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
      attempts: nonRetryableFirst,
      finalOutcome: null,
      journaledAttempts: 2,
      maxExtraAttempts: 2,
      usage: null,
      totalDispatchLatencyMs: 6,
    });
    expect(violated.find((c) => c.criterionId === "bounded-retry")?.status).toBe("FAIL");

    // (b) Synthetic: five attempts under a 1+2 budget (the infinite-
    // loop shape an unbounded policy would produce).
    const overBudget: AttemptRecord[] = Array.from({ length: 5 }, (_, index) => ({
      attempt: index + 1,
      outcome: "failure" as const,
      attributionClass: "rate-limit" as const,
      layer: "provider" as const,
      retryable: true,
      retried: index < 4,
      latencyMs: 2,
      requestDigest: "bbbb1111",
      httpStatus: 429,
      message: "rate limit",
    }));
    const unbounded = deriveAttributionCriteria({
      groundTruth: {
        injectedClass: "rate-limit",
        injectedRetryable: true,
        expected: {
          attributionClass: "rate-limit",
          layer: "provider",
          attempts: 5,
          attemptOutcomes: ["failure", "failure", "failure", "failure", "failure"],
          terminal: "FAILED",
        },
      },
      attempts: overBudget,
      finalOutcome: null,
      journaledAttempts: 5,
      maxExtraAttempts: 2,
      usage: null,
      totalDispatchLatencyMs: 10,
    });
    expect(unbounded.find((c) => c.criterionId === "bounded-retry")?.status).toBe("FAIL");

    // (c) The real driver over the always-retryable fake stops at
    // exactly 1 + maxExtraAttempts — never the violating shapes.
    const rateRow = row("rate-limit");
    const { result, attemptRecords } = await driveRowWithLifecycle(rateRow, rateRow);
    expect(result.totalAttempts).toBe(1 + CORPUS_RETRY_POLICY.maxExtraAttempts);
    expect(attemptRecords.every((record) => record.retried === false || record.retryable)).toBe(
      true,
    );
    expect(result.criteria.find((c) => c.criterionId === "bounded-retry")?.status).toBe("PASS");
  });

  test("timeout-vs-refusal: a deadline overrun is the RETRYABLE tool-timeout (bounded retries, zero effects); a settled refusal is the NON-retryable tool-failure (exactly one attempt)", async () => {
    const world = createAttributionToolWorld();
    const executor = createBoundedToolExecutor({
      tools: world.tools,
      deadlineMs: 25,
      timer: async () => {},
      now: pinnedClock,
    });
    const timeoutRow = row("tool-timeout");
    const timeoutLifecycle = recordingLifecycle();
    const timeoutResult = await driveAttributionExecution({
      executionId: "exec-timeout-disc",
      task: { kind: "tool-probe", input: timeoutRow.toolInvocation },
      groundTruth: timeoutRow,
      provider: "p",
      model: "m",
      lifecycle: timeoutLifecycle.lifecycle,
      dispatch: bindToolDispatch({
        executor,
        invocation: timeoutRow.toolInvocation ?? { tool: "slow-archiver", arguments: {} },
      }),
      retry: {
        maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts,
        backoffMs: 0,
        sleep: noSleep,
      },
      now: () => new Date(1_000),
    });
    expect(timeoutResult.totalAttempts).toBe(3);
    expect(timeoutResult.attempts.every((r) => r.attributionClass === "tool-timeout")).toBe(true);
    // Zero effects ever landed for the timed-out tool.
    expect(world.state.archivedBytes).toBe(0);
    // NO tool-result events for the timed-out attempts (no fabricated
    // results) — only tool-requested per attempt.
    const timeoutResults = timeoutLifecycle.toolEvents.filter((e) => e.command === "tool-result");
    expect(timeoutResults.length).toBe(0);

    const refusalRow = row("tool-failure");
    const refusalLifecycle = recordingLifecycle();
    const refusalResult = await driveAttributionExecution({
      executionId: "exec-refusal-disc",
      task: { kind: "tool-probe", input: refusalRow.toolInvocation },
      groundTruth: refusalRow,
      provider: "p",
      model: "m",
      lifecycle: refusalLifecycle.lifecycle,
      dispatch: bindToolDispatch({
        executor,
        invocation: refusalRow.toolInvocation ?? { tool: "inventory-lookup", arguments: {} },
      }),
      retry: {
        maxExtraAttempts: CORPUS_RETRY_POLICY.maxExtraAttempts,
        backoffMs: 0,
        sleep: noSleep,
      },
      now: () => new Date(1_000),
    });
    // The refusal NEVER retried: exactly one attempt; the tool RAN
    // (its lookup state proves execution, attributing the failure to
    // the tool layer, not to an unreachable seam).
    expect(refusalResult.totalAttempts).toBe(1);
    expect(world.state.lookups).toBe(1);
    expect(refusalResult.attempts[0]?.attributionClass).toBe("tool-failure");
    expect(refusalResult.attempts[0]?.retryable).toBe(false);
  });

  test("pre-effect rejection: an out-of-vocabulary task and an unexposed tool never touch the transport or the tool world", async () => {
    const quotaRow = row("quota-envelope");
    const { dispatch, calls } = railDispatchFor(quotaRow);
    const { lifecycle } = recordingLifecycle();
    let sleepCount = 0;
    const result = await driveAttributionExecution({
      executionId: "exec-vocab-disc",
      task: { kind: "teleport-probe" },
      groundTruth: {
        injectedClass: "platform-error",
        injectedRetryable: false,
        expected: {
          attributionClass: "platform-error",
          layer: "platform",
          attempts: 0,
          attemptOutcomes: [],
          terminal: "FAILED",
        },
      },
      provider: "p",
      model: "m",
      lifecycle,
      dispatch,
      retry: {
        maxExtraAttempts: 2,
        backoffMs: 0,
        sleep: async () => {
          sleepCount += 1;
        },
      },
      now: () => new Date(1_000),
    });
    expect(calls.count).toBe(0);
    expect(result.totalAttempts).toBe(0);
    expect(sleepCount).toBe(0);
    expect(result.finalAttribution?.layer).toBe("platform");

    const world = createAttributionToolWorld();
    const executor = createBoundedToolExecutor({
      tools: world.tools,
      deadlineMs: 25,
      timer: async () => {},
      now: pinnedClock,
    });
    const unexposed = await executor({ tool: "remote-control", arguments: {} });
    expect(unexposed.kind).toBe("failure");
    expect(world.state.lookups).toBe(0);
    expect(world.state.archivedBytes).toBe(0);
  });

  test("journal digest isolation: the per-attempt journal carries digests and classifications only — payload text and credential material never appear", async () => {
    const quotaRow = row("quota-envelope");
    const { attemptRecords } = await driveRowWithLifecycle(quotaRow, quotaRow);
    expect(attemptRecords.length).toBe(1);
    const journalText = JSON.stringify(attemptRecords);
    expect(journalText).not.toContain("umbrella");
    expect(journalText).not.toContain("discrimination-key");
    expect(journalText).not.toContain("Bearer");
    expect(attemptRecords[0]?.requestDigest).toMatch(/^[0-9a-f]{8}$/);
  });

  test("recovery honesty: the recovery row's failed attempt stays journaled exactly once with retried recorded — never silently swallowed", async () => {
    const recoveryRow = row("healthy-recovery-after-retry");
    const { result, attemptRecords } = await driveRowWithLifecycle(recoveryRow, recoveryRow);
    expect(result.terminal).toBe("COMPLETED");
    expect(attemptRecords.length).toBe(2);
    expect(attemptRecords[0]?.outcome).toBe("failure");
    expect(attemptRecords[0]?.attributionClass).toBe("transport-failure");
    expect(attemptRecords[0]?.retried).toBe(true);
    expect(attemptRecords[1]?.outcome).toBe("success");
    expect(attemptRecords[1]?.retried).toBe(false);
    // The failure is attributed honestly even though the run completed.
    expect(result.attempts[0]?.attributionClass).toBe("transport-failure");
  });

  test("request reproducibility and REAL-domain pinning: identical inputs produce identical digests, and EVERY attempt (retries included) addresses the pinned REAL endpoint domain", async () => {
    const transportRow = row("transport-failure");
    const { attemptRecords, calls } = await driveRowWithLifecycle(transportRow, transportRow);
    // All three attempts journaled the SAME canonical request digest.
    const digests = new Set(attemptRecords.map((record) => record.requestDigest));
    expect(digests.size).toBe(1);
    // Every transport call (retries included) hit the pinned REAL
    // dashscope-intl domain — the fake-transport DNS lesson.
    expect(calls.urls.length).toBe(3);
    for (const url of calls.urls) {
      expect(url).toContain("https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/");
    }
    // A different rail request digests differently (the quota row and
    // the transport row share a request deliberately — same canonical
    // probe — so the OpenRouter 402 row provides the differing one).
    const creditRow = row("openrouter-credit-402");
    const credit = await driveRowWithLifecycle(creditRow, creditRow);
    expect(credit.attemptRecords[0]?.requestDigest).not.toBe(attemptRecords[0]?.requestDigest);
  });
});
