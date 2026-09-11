/**
 * VAL-002 acceptance criteria 1, 2, 4, 5, 6: the full harness flow
 * against a controlled fake transport (the SDK's injected seam) —
 * submission, asynchronous completion, result retrieval, error
 * reporting, deterministic assertions, run identity and the evidence
 * contract. Discrimination: transport failures are surfaced, weakened
 * evidence is rejected, forbidden outcomes fail assertions.
 */

import { describe, expect, test } from "vitest";
import {
  digestResult,
  type HarnessEvidence,
  validateHarnessEvidence,
} from "../../../benchmarks/validation/harness";
import {
  type TransportImplementation,
  ValidationHarness,
} from "../../../benchmarks/validation/harness/harness";
import type { PublicError } from "../../../sdk";
import { ZeckApiError } from "../../../sdk";

const REVISION = "90ceeddd1c6e5553254eaaade3155be391670787";

/** Deterministic fake clock. */
class FakeClock {
  private current = 1_000_000;
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

interface FakeExecution {
  id: string;
  status: string;
}

/**
 * A fake public API world driven through the SDK's injected transport:
 * create → receipt; get → execution view; result → packaged outcome.
 * The lifecycle advances when the test advances the world.
 */
function createFakeWorld(): {
  readonly harness: ValidationHarness;
  readonly advanceLifecycleTo: (status: string) => void;
  readonly clock: FakeClock;
  readonly failNextWith: (status: number, body: PublicError) => void;
} {
  const clock = new FakeClock();
  const executions = new Map<string, FakeExecution>();
  let sequence = 0;
  let nextFailure: { status: number; body: PublicError } | null = null;

  const world = {
    advanceLifecycleTo(status: string): void {
      for (const execution of executions.values()) {
        execution.status = status;
      }
    },
    failNextWith(status: number, body: PublicError): void {
      nextFailure = { status, body };
    },
    clock,
  };

  const harness = new ValidationHarness({
    baseUrl: "http://fake.local",
    token: "test-token",
    applicationId: "app-1",
    transport: (async (input: unknown, init?: unknown) => {
      if (nextFailure !== null) {
        const failure = nextFailure;
        nextFailure = null;
        return new Response(JSON.stringify(failure.body), {
          status: failure.status,
          headers: { "content-type": "application/json" },
        });
      }
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? "GET";
      if (method === "POST" && url.endsWith("/executions")) {
        sequence += 1;
        const id = `exec-${sequence}`;
        executions.set(id, { id, status: "CREATED" });
        return Response.json({
          executionId: id,
          applicationId: "app-1",
          status: "CREATED",
          createdAt: clock.now().toISOString(),
          replayed: false,
          lastEventSequence: 1,
        });
      }
      const executionMatch = /\/executions\/([^/]+)$/.exec(url);
      if (method === "GET" && executionMatch !== null) {
        const id = executionMatch[1] ?? "";
        const execution = executions.get(id);
        if (execution === undefined) {
          return Response.json(
            { code: "NOT_FOUND", message: `unknown execution ${id}`, retryable: false },
            { status: 404 },
          );
        }
        return Response.json({
          id,
          applicationId: "app-1",
          environmentId: null,
          status: execution.status,
          task: { kind: "summarize", input: "x" },
          constraints: null,
          metadata: {},
          createdAt: clock.now().toISOString(),
          updatedAt: clock.now().toISOString(),
          terminalAt: null,
        });
      }
      const resultMatch = /\/executions\/([^/]+)\/results$/.exec(url);
      if (method === "GET" && resultMatch !== null) {
        const id = resultMatch[1] ?? "";
        const execution = executions.get(id);
        if (execution === undefined || execution.status !== "COMPLETED") {
          return Response.json(
            { code: "NOT_FOUND", message: "result unavailable", retryable: false },
            { status: 404 },
          );
        }
        return Response.json({
          executionId: id,
          status: "COMPLETED",
          route: null,
          cost: null,
          usage: null,
          outputArtifacts: [],
          verification: [
            { criterionId: "c1", status: "PASS", strategy: "s", evidence: [], recordedAt: "t" },
          ],
          warnings: [],
          terminalAt: clock.now().toISOString(),
        });
      }
      return Response.json(
        { code: "NOT_FOUND", message: `unhandled ${method} ${url}`, retryable: false },
        { status: 404 },
      );
    }) as unknown as TransportImplementation,
    runtime: {
      now: () => clock.now(),
      sleep: async () => {
        clock.advance(10);
      },
      environment: {
        runtime: "bun",
        toolchain: "vitest",
        database: "fake",
        configuration: {},
      },
    },
    identity: {
      program: "zeck-validation",
      workOrder: "VAL-002",
      baseRevision: REVISION,
      applicationRevision: REVISION,
      corpusRevision: REVISION,
      integrationSurface: "sdk",
    },
    pollIntervalMs: 10,
    completionTimeoutMs: 500,
  });
  return { harness, ...world };
}

describe("validation: harness flow (VAL-002 AC1/2/4/5/6)", () => {
  test("submission, async completion, retrieval, assertions, valid evidence", async () => {
    const { harness, advanceLifecycleTo } = createFakeWorld();
    const submitted = await harness.submit(
      { applicationId: "app-1", task: { kind: "summarize", input: "x" } },
      "idem-1",
    );
    expect(submitted.initialStatus).toBe("CREATED");
    expect(submitted.replayed).toBe(false);

    advanceLifecycleTo("RUNNING");
    const mid = await harness.awaitCompletion(submitted.executionId);
    expect(mid).toBeNull(); // RUNNING is not terminal and the timeout is short

    advanceLifecycleTo("COMPLETED");
    const terminal = await harness.awaitCompletion(submitted.executionId);
    expect(terminal).toBe("COMPLETED");

    const result = await harness.retrieveResult(submitted.executionId);
    expect(result?.status).toBe("COMPLETED");

    const passed = harness.assertOutcome({
      expectTerminalStatus: "COMPLETED",
      expectVerificationStatuses: ["PASS"],
      forbiddenTerminalStatuses: ["FAILED"],
    });
    expect(passed).toBe(true);

    const evidence = harness.evidence();
    expect(evidence.terminalStatus).toBe("COMPLETED");
    expect(evidence.resultDigest).toBe(
      digestResult({
        executionId: submitted.executionId,
        status: "COMPLETED",
        route: null,
        cost: null,
        usage: null,
        outputArtifacts: [],
        verification: [
          { criterionId: "c1", status: "PASS", strategy: "s", evidence: [], recordedAt: "t" },
        ],
        warnings: [],
        terminalAt: evidence.timeline[evidence.timeline.length - 1]?.at ?? "",
      }),
    );
    expect(validateHarnessEvidence(evidence)).toEqual([]);
    expect(evidence.runId).toMatch(/^val-run-[0-9a-f]{64}$/);
  });

  test("error reporting: transport errors are surfaced with taxonomy (AC2)", async () => {
    const { harness, failNextWith, advanceLifecycleTo } = createFakeWorld();
    failNextWith(409, {
      code: "INVALID_STATE_TRANSITION",
      message: "terminal execution rejects the transition",
      retryable: false,
    } as PublicError);
    await expect(harness.submit({ applicationId: "app-1", task: {} }, "idem-2")).rejects.toThrow(
      ZeckApiError,
    );

    // a second, healthy submission for the retrieval-error surface
    const submitted = await harness.submit(
      { applicationId: "app-1", task: { kind: "summarize", input: "x" } },
      "idem-3",
    );
    advanceLifecycleTo("COMPLETED");
    await harness.awaitCompletion(submitted.executionId);
    const missing = await harness.retrieveResult("exec-does-not-exist");
    expect(missing).toBeNull();

    const evidence = harness.evidence();
    expect(evidence.errors.length).toBeGreaterThanOrEqual(2);
    expect(
      evidence.errors.some((e) => e.status === 409 && e.code === "INVALID_STATE_TRANSITION"),
    ).toBe(true);
    expect(evidence.errors.some((e) => e.status === 404)).toBe(true);
  });

  test("deterministic assertions FAIL on forbidden outcomes (discrimination)", async () => {
    const { harness, advanceLifecycleTo } = createFakeWorld();
    const submitted = await harness.submit(
      { applicationId: "app-1", task: { kind: "summarize", input: "x" } },
      "idem-4",
    );
    advanceLifecycleTo("FAILED");
    await harness.awaitCompletion(submitted.executionId);
    await harness.retrieveResult(submitted.executionId);
    const passed = harness.assertOutcome({
      expectTerminalStatus: "COMPLETED",
      forbiddenTerminalStatuses: ["FAILED"],
    });
    expect(passed).toBe(false);
    const evidence = harness.evidence();
    expect(evidence.assertions.some((a) => a.name === "terminal-status" && !a.passed)).toBe(true);
    expect(evidence.assertions.some((a) => a.name === "forbidden-FAILED" && !a.passed)).toBe(true);
    // the evidence itself remains structurally VALID — the verdict is FAIL
    expect(validateHarnessEvidence(evidence)).toEqual([]);
  });

  test("weakened evidence is rejected by the consumption gate (discrimination)", () => {
    const base: HarnessEvidence = {
      runId: `val-run-${"a".repeat(64)}`,
      program: "zeck-validation",
      workOrder: "VAL-002",
      baseRevision: REVISION,
      applicationRevision: REVISION,
      corpusRevision: REVISION,
      integrationSurface: "sdk",
      request: { taskKind: "summarize", idempotencyKey: "k", constraints: null },
      timeline: [{ at: "2026-09-11T20:00:00.000Z", status: "COMPLETED" }],
      terminalStatus: "COMPLETED",
      resultDigest: digestResult({}),
      verificationStatuses: ["PASS"],
      errors: [],
      assertions: [{ name: "terminal-status", passed: true, detail: "ok" }],
      timings: { submitMs: 1, completionMs: 1, retrievalMs: 1, totalMs: 3 },
    };
    expect(validateHarnessEvidence(base)).toEqual([]);

    const noTimeline: HarnessEvidence = { ...base, timeline: [] };
    expect(validateHarnessEvidence(noTimeline).some((v) => v.path === "timeline")).toBe(true);

    const badRunId: HarnessEvidence = { ...base, runId: "not-a-run-id" };
    expect(validateHarnessEvidence(badRunId).some((v) => v.path === "runId")).toBe(true);

    const unchronological: HarnessEvidence = {
      ...base,
      timeline: [
        { at: "2026-09-11T20:00:02.000Z", status: "RUNNING" },
        { at: "2026-09-11T20:00:01.000Z", status: "COMPLETED" },
      ],
    };
    expect(validateHarnessEvidence(unchronological).some((v) => v.path === "timeline[1].at")).toBe(
      true,
    );

    const undecided: HarnessEvidence = {
      ...base,
      assertions: [{ name: "x", passed: "yes" as unknown as boolean, detail: "d" }],
    };
    expect(validateHarnessEvidence(undecided).some((v) => v.path === "assertions[0].passed")).toBe(
      true,
    );
  });
});
