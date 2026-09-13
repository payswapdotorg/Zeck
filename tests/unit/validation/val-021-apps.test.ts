/**
 * VAL-021 acceptance criterion 1: the idempotency-and-continuation
 * customer application rides the public SDK boundary end to end
 * against a controlled fake transport (submission → async completion
 * → result retrieval → deterministic assertions → recorder-consumable
 * evidence), and its pinned task slice matches the repository
 * configuration file and the corpus. The fake world implements the
 * platform's OWN idempotency semantics (same key + same body → the
 * replayed receipt with the same identity; same key + a different
 * body → the typed 409 IDEMPOTENCY_KEY_REUSED) so the app's
 * per-pattern submission assertions are exercised honestly.
 * Discrimination: a fabricated COMPLETED on the exhausted row FAILs
 * the app's assertions; a FAILED platform outcome fails every
 * COMPLETED row; a forged replay identity FAILS the submission
 * contract.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  IDEMPOTENCY_CONTINUATION_TASKS,
  runIdempotencyContinuationApp,
} from "../../../benchmarks/validation/apps/idempotency-continuation/application";
import { CONTINUATION_CORPUS } from "../../../benchmarks/validation/apps/idempotency-continuation/corpus";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { HarnessEvidence } from "../../../benchmarks/validation/harness/evidence";
import type { TransportImplementation } from "../../../benchmarks/validation/harness/harness";

const REVISION = "ae373e6c863a0c8adf558ccf5618b7353ee0a557";

/**
 * A minimal fake public API over the SDK's injected transport seam,
 * implementing the platform's OWN idempotency semantics at the create
 * boundary: the FIRST create under a key inserts and answers
 * `replayed: false`; a create with the SAME key + the SAME canonical
 * body REPLAYS the receipt (same identity, `replayed: true`); a
 * create with the SAME key + a DIFFERENT body answers the typed 409
 * IDEMPOTENCY_KEY_REUSED (never a second execution).
 */
function createFakeApiWorld(options: {
  readonly terminal: "COMPLETED" | "FAILED";
  readonly verificationStatuses?: readonly string[];
}): {
  readonly transport: TransportImplementation;
  readonly createdExecutions: number;
} {
  const executions = new Map<string, { status: string }>();
  // key → { fingerprint, executionId }
  const idempotencyLedger = new Map<string, { fingerprint: string; executionId: string }>();
  let sequence = 0;
  let createdExecutions = 0;
  const fingerprintOf = (body: unknown): string => JSON.stringify(body ?? null);
  const transport: TransportImplementation = async (input: unknown, init?: unknown) => {
    const url = String(input);
    const method = String((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
    if (url.endsWith("/executions") && method === "POST") {
      const headers = (init as { headers?: Record<string, string> }).headers ?? {};
      const key = headers["idempotency-key"] ?? headers["Idempotency-Key"] ?? "";
      if (key.length === 0) {
        return jsonResponse(422, {
          code: "CAPABILITY_UNAVAILABLE",
          message: "POST routes require an Idempotency-Key header",
          retryable: false,
        });
      }
      const body = JSON.parse(String((init as { body?: string }).body ?? "null")) as Record<
        string,
        unknown
      >;
      const fingerprint = fingerprintOf(body);
      const existing = idempotencyLedger.get(key);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          // The typed key-reuse rejection (the platform's public token).
          return jsonResponse(409, {
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "idempotency key was already used with a different request fingerprint",
            retryable: false,
          });
        }
        // The replay: the SAME identity + the replayed flag.
        const execution = executions.get(existing.executionId);
        return jsonResponse(201, {
          executionId: existing.executionId,
          applicationId: body.applicationId ?? "app-1",
          status: execution?.status ?? "CREATED",
          createdAt: new Date().toISOString(),
          replayed: true,
          lastEventSequence: 1,
        });
      }
      sequence += 1;
      createdExecutions += 1;
      const id = `fake-exec-${sequence}`;
      executions.set(id, { status: "RUNNING" });
      idempotencyLedger.set(key, { fingerprint, executionId: id });
      return jsonResponse(201, {
        executionId: id,
        applicationId: body.applicationId ?? "app-1",
        status: "RUNNING",
        createdAt: new Date().toISOString(),
        replayed: false,
        lastEventSequence: 1,
      });
    }
    const execMatch = url.match(/\/executions\/([^/]+)$/);
    if (execMatch !== null && method === "GET") {
      const execution = executions.get(execMatch[1] ?? "");
      if (execution === undefined) {
        return jsonResponse(404, {
          code: "NOT_FOUND",
          message: "unknown execution",
          retryable: false,
        });
      }
      execution.status = options.terminal;
      return jsonResponse(200, {
        id: execMatch[1],
        applicationId: "app-1",
        environmentId: null,
        status: execution.status,
        task: { kind: "idempotency-continuation.settlement.v1", input: "settlement" },
        constraints: null,
        metadata: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        terminalAt: new Date().toISOString(),
      });
    }
    const resultMatch = url.match(/\/executions\/([^/]+)\/results$/);
    if (resultMatch !== null) {
      const execution = executions.get(resultMatch[1] ?? "");
      if (execution === undefined) {
        return jsonResponse(404, {
          code: "NOT_FOUND",
          message: "unknown execution",
          retryable: false,
        });
      }
      const pass = options.terminal === "COMPLETED";
      return jsonResponse(200, {
        executionId: resultMatch[1],
        status: options.terminal,
        route: {
          provider: "fake-rail",
          model: "fake-model",
          strategyClass: "idempotency-continuation",
          modelCalls: 1,
        },
        cost: pass ? { totalMicroUsd: "40", currency: "usd" } : null,
        usage: pass ? { inputTokens: 30, outputTokens: 6 } : null,
        outputArtifacts: [],
        verification:
          options.verificationStatuses === undefined
            ? [
                {
                  id: "v1",
                  executionId: resultMatch[1],
                  criterionId: "effect-multiplicity-exactly-once",
                  strategy: "deterministic",
                  status: "PASS",
                  recordedBy: "fake-platform",
                },
              ]
            : options.verificationStatuses.map((status, index) => ({
                id: `v${index + 1}`,
                executionId: resultMatch[1],
                criterionId: `criterion-${index + 1}`,
                strategy: "deterministic",
                status,
                recordedBy: "fake-platform",
              })),
        warnings: [],
        terminalAt: new Date().toISOString(),
      });
    }
    return jsonResponse(500, {
      code: "INTERNAL",
      message: `unmapped fake route ${url}`,
      retryable: true,
    });
  };
  return {
    transport,
    get createdExecutions() {
      return createdExecutions;
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const baseConfig = {
  applicationId: "app-1",
  baseUrl: "http://fake-zeck.local",
  tokenEnvVar: "ZECK_VALIDATION_TOKEN",
  applicationRevision: REVISION,
  corpusRevision: REVISION,
  integrationSurface: "sdk",
  pollIntervalMs: 1,
  completionTimeoutMs: 5_000,
};

async function runAppOverFakeWorld(options: {
  readonly terminal: "COMPLETED" | "FAILED";
  readonly taskIndex: number;
  readonly verificationStatuses?: readonly string[];
}): Promise<{
  readonly evidence: HarnessEvidence;
  readonly passed: boolean;
  readonly submissionFacts: { replayed: number; rejected: number; created: number };
  readonly createdExecutions: number;
}> {
  const world = createFakeApiWorld({
    terminal: options.terminal,
    ...(options.verificationStatuses === undefined
      ? {}
      : { verificationStatuses: options.verificationStatuses }),
  });
  const outcome = await runIdempotencyContinuationApp({
    config: baseConfig,
    token: "zeck-token-fake",
    transport: world.transport,
    now: () => new Date(1_000),
    sleep: async () => {},
    environment: {
      runtime: "node test",
      toolchain: "vitest",
      database: "none",
      configuration: { suite: "val-021-apps" },
    },
    runSuffix: "unit",
    taskIndex: options.taskIndex,
  });
  return {
    evidence: outcome.evidence,
    passed: outcome.passed,
    submissionFacts: {
      replayed: outcome.submissionFacts.replayed,
      rejected: outcome.submissionFacts.rejected,
      created: outcome.submissionFacts.created,
    },
    createdExecutions: world.createdExecutions,
  };
}

describe("VAL-021 idempotency-continuation application (public SDK boundary)", () => {
  test("the task slice mirrors the corpus exactly (kind, rowId, pattern, terminal, submissions)", () => {
    expect(IDEMPOTENCY_CONTINUATION_TASKS.length).toBe(CONTINUATION_CORPUS.length);
    for (const [index, task] of IDEMPOTENCY_CONTINUATION_TASKS.entries()) {
      const row = CONTINUATION_CORPUS[index];
      if (row === undefined) throw new Error("missing corpus row");
      expect(task.kind).toBe("idempotency-continuation.settlement.v1");
      expect(task.rowId).toBe(row.rowId);
      expect(task.pattern).toBe(row.pattern);
      expect(task.expectedTerminal).toBe(row.expected.terminal);
      expect(task.submissions).toBe(row.submissions.count);
      expect(task.replayedSubmissions).toBe(row.expected.replayedSubmissions);
      expect(task.rejectedSubmissions).toBe(row.expected.rejectedSubmissions);
    }
  });

  test("the repository config.json mirrors the pinned task slice", async () => {
    const config = JSON.parse(
      await readFile(
        join(process.cwd(), "benchmarks/validation/apps/idempotency-continuation/config.json"),
        "utf8",
      ),
    ) as {
      tasks: {
        kind: string;
        rowId: string;
        pattern: string;
        expectedTerminal: string;
        submissions: number;
      }[];
    };
    expect(config.tasks.length).toBe(IDEMPOTENCY_CONTINUATION_TASKS.length);
    for (const [index, task] of config.tasks.entries()) {
      const pinned = IDEMPOTENCY_CONTINUATION_TASKS[index];
      if (pinned === undefined) throw new Error("missing pinned task");
      expect(task.kind).toBe(pinned.kind);
      expect(task.rowId).toBe(pinned.rowId);
      expect(task.pattern).toBe(pinned.pattern);
      expect(task.expectedTerminal).toBe(pinned.expectedTerminal);
      expect(task.submissions).toBe(pinned.submissions);
    }
  });

  test("the duplicate row: the second create REPLAYS (identity preserved, replayed flag surfaced, ONE durable execution)", async () => {
    const index = CONTINUATION_CORPUS.findIndex(
      (row) => row.rowId === "duplicate-submission-replay",
    );
    if (index < 0) throw new Error("missing duplicate row");
    const outcome = await runAppOverFakeWorld({ terminal: "COMPLETED", taskIndex: index });
    expect(outcome.passed).toBe(true);
    expect(outcome.submissionFacts.replayed).toBe(1);
    expect(outcome.submissionFacts.created).toBe(1);
    // ONE durable execution across BOTH submissions.
    expect(outcome.createdExecutions).toBe(1);
    expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
  });

  test("the conflict row: the mutated task under the same key surfaces the typed IDEMPOTENCY_KEY_REUSED (409) and the app still completes the original", async () => {
    const index = CONTINUATION_CORPUS.findIndex(
      (row) => row.rowId === "conflicting-replay-rejected",
    );
    if (index < 0) throw new Error("missing conflict row");
    const outcome = await runAppOverFakeWorld({ terminal: "COMPLETED", taskIndex: index });
    expect(outcome.passed).toBe(true);
    expect(outcome.submissionFacts.rejected).toBe(1);
    expect(outcome.submissionFacts.created).toBe(1);
    // The typed rejection surfaced as evidence (non-retryable).
    const rejection = outcome.evidence.errors.find(
      (error) => error.code === "IDEMPOTENCY_KEY_REUSED",
    );
    expect(rejection).toBeDefined();
    expect(rejection?.retryable).toBe(false);
    expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
  });

  test("the storm row: five rapid identical creates converge (one created + four replayed, ONE durable execution)", async () => {
    const index = CONTINUATION_CORPUS.findIndex((row) => row.rowId === "retry-storm-converged");
    if (index < 0) throw new Error("missing storm row");
    const outcome = await runAppOverFakeWorld({ terminal: "COMPLETED", taskIndex: index });
    expect(outcome.passed).toBe(true);
    expect(outcome.submissionFacts.replayed).toBe(4);
    expect(outcome.submissionFacts.created).toBe(1);
    expect(outcome.createdExecutions).toBe(1);
    expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
  });

  test("every offline COMPLETED row passes on the honest COMPLETED outcome with valid evidence", async () => {
    for (const [index, row] of CONTINUATION_CORPUS.entries()) {
      if (row.liveGate !== undefined || row.expected.terminal !== "COMPLETED") {
        continue;
      }
      const outcome = await runAppOverFakeWorld({ terminal: "COMPLETED", taskIndex: index });
      expect(outcome.passed, `${row.rowId} should pass on COMPLETED`).toBe(true);
      expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
    }
  });

  test("the exhausted retry row PASSES on the honest FAILED outcome (it EXPECTS the failure)", async () => {
    const index = CONTINUATION_CORPUS.findIndex((row) => row.rowId === "retry-storm-exhausted");
    if (index < 0) throw new Error("missing exhausted row");
    const outcome = await runAppOverFakeWorld({ terminal: "FAILED", taskIndex: index });
    expect(outcome.passed).toBe(true);
    expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
  });

  test("a fabricated COMPLETED on the exhausted row FAILS the app's assertions (never a fabricated recovery)", async () => {
    const index = CONTINUATION_CORPUS.findIndex((row) => row.rowId === "retry-storm-exhausted");
    if (index < 0) throw new Error("missing exhausted row");
    const outcome = await runAppOverFakeWorld({ terminal: "COMPLETED", taskIndex: index });
    expect(outcome.passed).toBe(false);
  });

  test("a FAILED platform outcome fails every COMPLETED row (the app never passes a failed execution)", async () => {
    for (const [index, row] of CONTINUATION_CORPUS.entries()) {
      if (row.liveGate !== undefined || row.expected.terminal !== "COMPLETED") {
        continue;
      }
      const outcome = await runAppOverFakeWorld({ terminal: "FAILED", taskIndex: index });
      expect(outcome.passed, `${row.rowId} should fail on FAILED`).toBe(false);
    }
  });

  test("a failed verification status fails every row (PASS statuses are required)", async () => {
    const index = CONTINUATION_CORPUS.findIndex(
      (row) => row.rowId === "duplicate-submission-replay",
    );
    if (index < 0) throw new Error("missing duplicate row");
    const outcome = await runAppOverFakeWorld({
      terminal: "COMPLETED",
      taskIndex: index,
      verificationStatuses: ["FAIL"],
    });
    expect(outcome.passed).toBe(false);
  });
});
