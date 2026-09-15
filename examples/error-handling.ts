/**
 * The error-handling example (DEP-020): the canonical error taxonomy,
 * retry semantics and idempotency discipline a resilient integrator
 * needs — expressed against the real surface.
 *
 * One sentence: every failure crosses the wire as the public error
 * body {code, message, retryable} with a deterministic HTTP status, and
 * a retry policy retries ONLY retryable failures with the SAME
 * idempotency key (a durable outcome replays instead of double-spending).
 *
 * Classification: runnable (the error paths exercised here — 401, the
 * client-side provider-selection rejection, replay-acknowledged create —
 * are durable platform behaviors).
 */

import {
  createZeckClient,
  ERROR_CODES,
  type ExecutionReceipt,
  type PublicError,
  TERMINAL_STATUSES,
  ZeckApiError,
  type ZeckClient,
} from "../sdk";
import { coreEnvVars, type ExampleMeta, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus, describeZeckError, printExecutionSummary } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";
import { createClient } from "./quickstart";

export const EXAMPLE: ExampleMeta = {
  name: "error-handling",
  family: "text",
  title: "Errors — taxonomy, retryability and idempotent replay discipline",
  classification: { kind: "runnable" },
  envVars: coreEnvVars(),
};

/** The create-request type of the execution-centric client. */
type CreateRequest = Parameters<ZeckClient["createExecution"]>[0];

/**
 * The resilient create: retry ONLY retryable failures (network and 5xx
 * surfaces), keep the SAME idempotency key across attempts, and give
 * up fast on the deterministic client errors (4xx) — those need a code
 * change, not a retry.
 */
export async function createExecutionResilient(
  client: ZeckClient,
  request: CreateRequest,
  idempotencyKey: string,
  options: { readonly attempts?: number; readonly sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ readonly receipt: ExecutionReceipt; readonly attempts: number }> {
  const attempts = options.attempts ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      // SAME key on every attempt — that is the whole discipline.
      const { receipt } = await client.createExecution(request, idempotencyKey);
      return { receipt, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (error instanceof ZeckApiError && !error.body.retryable) {
        // Deterministic failure: retrying cannot change the answer.
        throw error;
      }
      if (attempt < attempts) {
        // Bounded exponential backoff before the next attempt.
        await sleep(100 * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  console.log(`canonical error codes (${ERROR_CODES.length}): ${ERROR_CODES.join(", ")}`);

  // 1. AUTHENTICATION_FAILED (401, not retryable): a bad credential is
  //    a deterministic failure — fail fast, never retry.
  const badClient = createZeckClient({
    baseUrl: env.apiBaseUrl,
    token: "not-a-real-zeck-credential",
    applicationId: env.applicationId,
  });
  try {
    await badClient.listAgents();
  } catch (error) {
    console.log(`observed: ${describeZeckError(error)}`);
  }

  // 2. The public error body shape ({code, message, retryable}) — typed
  //    with the canonical codes; a stack trace never crosses the wire.
  const asPublicError = (error: unknown): PublicError | null =>
    error instanceof ZeckApiError ? error.body : null;

  // 3. Provider-selection attempt rejected CLIENT-side (API-001): the
  //    SDK fails before the wire — no request is issued. (The poisoned
  //    key is cast in deliberately: a real integrator simply never
  //    writes it — the closed vocabulary makes it unrepresentable.)
  const client = createClient(env);
  const poisonedRequest = {
    applicationId: env.applicationId,
    task: { kind: "summarize", doc: "quarterly-report-01" },
    model: "some-provider-model",
  } as unknown as CreateRequest;
  try {
    await client.createExecution(poisonedRequest, "error-handling-rejected-1");
  } catch (error) {
    const message = describeZeckError(error);
    console.log(`provider-selection rejection (client-side, API-001): ${message}`);
    const body = asPublicError(error);
    if (body === null) {
      console.log("  (the request was never issued — no wire error exists)");
    }
  }

  // 4. The resilient create + idempotent replay discipline.
  const request: CreateRequest = {
    applicationId: env.applicationId,
    task: { kind: "summarize", doc: "changelog-01", maxWords: 25 },
    constraints: { maxCostMicroUsd: "3000" },
    metadata: { example: EXAMPLE.name },
  };
  const { receipt, attempts } = await createExecutionResilient(
    client,
    request,
    "error-handling-resilient-1",
  );
  console.log(`resilient create finished in ${attempts} attempt(s): ${receipt.executionId}`);

  // 5. Same key + SAME request → replay of the durable outcome.
  const replay = await createExecutionResilient(client, request, "error-handling-resilient-1");
  console.log(
    `replay: replayed=${replay.receipt.replayed}, executionId=${replay.receipt.executionId} ` +
      "(the durable outcome, not a second execution)",
  );

  // 6. Same key + DIFFERENT request → 409 IDEMPOTENCY_KEY_REUSED (a
  //    key collision is a client bug — surface it, never retry it).
  try {
    await client.createExecution(
      {
        applicationId: env.applicationId,
        task: { kind: "summarize", doc: "research-abstract-01", maxWords: 40 },
        constraints: { maxCostMicroUsd: "3000" },
        metadata: { example: EXAMPLE.name },
      },
      "error-handling-resilient-1",
    );
  } catch (error) {
    console.log(`key collision observed: ${describeZeckError(error)}`);
  }

  // 7. A clean finish for the resilient execution (bounded polling).
  const status = await awaitTerminalStatus(client, receipt.executionId);
  const result = await client.getResult(receipt.executionId);
  printExecutionSummary(receipt.executionId, result);
  console.log(
    `error-handling example finished: ${status} ` +
      `(terminal vocabulary: ${TERMINAL_STATUSES.join(" | ")})`,
  );
}

runWhenInvoked(import.meta.url, () => main());
