/**
 * QUICKSTART — your first five minutes on Zeck (DEP-020).
 *
 * One file walks the complete integration spine:
 *   1. connection identity  (ZECK_API_URL + ZECK_TOKEN + ZECK_APPLICATION_ID)
 *   2. the SDK client       (execution-centric, provider-neutral)
 *   3. first Execution      (task + constraints, idempotent create)
 *   4. the lifecycle        (poll the public read to a terminal status)
 *   5. the result package   (route, cost, usage, artifacts, verification,
 *                            warnings — the honest end-state)
 *   6. the evidence trail   (events + verification results)
 *   7. idempotent replay    (the same key replays the durable outcome)
 *
 * Run it (from the repository root):
 *   ZECK_API_URL=… ZECK_TOKEN=… ZECK_APPLICATION_ID=… \
 *     bun run examples/quickstart.ts
 *
 * NEVER a provider API key in ZECK_TOKEN — that credential is a Zeck
 * transport credential. Provider connections are BYOK references the
 * platform holds server-side (see docs/developer/CONFIGURATION.md).
 */

import {
  createZeckClient,
  type ExecutionRequest,
  TERMINAL_STATUSES,
  type ZeckClient,
} from "../sdk";
import { coreEnvVars, type ExampleMeta, loadZeckEnv, type ZeckEnv } from "./lib/env";
import { awaitTerminalStatus, printExecutionSummary } from "./lib/poll";
import { runWhenInvoked } from "./lib/run";

export const EXAMPLE: ExampleMeta = {
  name: "quickstart",
  family: "text",
  title: "Quickstart — first execution, result, evidence and cost",
  classification: { kind: "runnable" },
  envVars: coreEnvVars(),
};

/** Step 2: the execution-centric client (provider-neutral by construction). */
export function createClient(env: ZeckEnv): ZeckClient {
  return createZeckClient({
    baseUrl: env.apiBaseUrl,
    token: env.token,
    applicationId: env.applicationId,
  });
}

/** Step 3: the first execution request — a task + constraints, nothing else. */
export function firstExecutionRequest(env: ZeckEnv): ExecutionRequest {
  return {
    applicationId: env.applicationId,
    ...(env.environmentId === undefined ? {} : { environmentId: env.environmentId }),
    task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
    constraints: {
      maxCostMicroUsd: "5000", // $0.005 — integer micro-USD string, never a float
      maxLatencyMs: 30_000,
    },
    metadata: { origin: "docs/developer/QUICKSTART.md" },
  };
}

export async function main(env: ZeckEnv = loadZeckEnv()): Promise<void> {
  console.log(`Zeck quickstart → ${env.apiBaseUrl} (application ${env.applicationId})`);

  // 2. The client. A scoped method on a client without an application
  //    scope fails fast client-side — the scope is required by the wire.
  const client = createClient(env);

  // 3. First execution. The create is IDEMPOTENT: supply a stable key
  //    (here derived from a run label) and a network retry replays the
  //    durable outcome instead of double-spending.
  const idempotencyKey = `quickstart-${new Date().toISOString().slice(0, 10)}`;
  const { receipt } = await client.createExecution(firstExecutionRequest(env), idempotencyKey);
  console.log(
    `created execution ${receipt.executionId} (status ${receipt.status}, ` +
      `replayed=${receipt.replayed})`,
  );

  // 4. The lifecycle: poll the public read until a terminal status.
  //    TERMINAL_STATUSES = COMPLETED | FAILED | CANCELLED | EXPIRED.
  const status = await awaitTerminalStatus(client, receipt.executionId, {
    timeoutMs: 120_000,
    intervalMs: 1_000,
  });
  console.log(`terminal status: ${status}`);

  // 5. The result package — route/cost/usage/artifacts/verification/warnings.
  const result = await client.getResult(receipt.executionId);
  printExecutionSummary(receipt.executionId, result);

  // 6. The evidence trail: the event ledger (lifecycle visibility) and
  //    the verification results (the evidence axis).
  const events = await client.listEvents(receipt.executionId);
  console.log(`event ledger: ${events.length} event(s)`);
  for (const event of events) {
    console.log(`  #${event.sequence} ${event.type} at ${event.occurredAt}`);
  }
  const verification = await client.listVerification(receipt.executionId);
  console.log(
    `verification evidence: ${verification.length} result(s)` +
      (verification.length === 0 ? " (none recorded)" : ""),
  );

  // 7. Idempotent replay: the SAME key + SAME request replays the SAME
  //    durable outcome (replayed=true, no second spend). A DIFFERENT
  //    request under the same key is rejected (409 IDEMPOTENCY_KEY_REUSED).
  const replay = await client.createExecution(firstExecutionRequest(env), idempotencyKey);
  console.log(
    `idempotent replay: replayed=${replay.receipt.replayed}, ` +
      `executionId=${replay.receipt.executionId}`,
  );

  if (!TERMINAL_STATUSES.includes(status) || status !== "COMPLETED") {
    console.log(
      "note: the execution did not COMPLETED — inspect the events above; " +
        "see docs/developer/TROUBLESHOOTING.md",
    );
  }
}

runWhenInvoked(import.meta.url, () => main());
