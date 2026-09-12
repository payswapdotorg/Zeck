/**
 * The RAG / knowledge-assistant customer application (VAL-011).
 *
 * A real customer-style application: questions answered strictly from
 * the provisioned knowledge base with citations, submitted through
 * Zeck's public SDK boundary. The platform performs deterministic
 * retrieval (recorded on the ledger), one REAL model dispatch with the
 * retrieved context, and mechanically derived verification; this
 * application asserts the deterministic outcome contract per task.
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import { RAG_PINNED_ROWS } from "./knowledge-bases";

/** The app's pinned task payloads (the public-API task shapes). */
export const RAG_TASKS = RAG_PINNED_ROWS.map((row) => ({
  kind: "kb-qa" as const,
  kb: row.kb,
  question: row.question,
})) as readonly { kind: "kb-qa"; kb: string; question: string }[];

const IDEMPOTENCY_PREFIX = "val-011-rag";

/**
 * Run the RAG application end to end over one pinned task.
 * The transport implementation is injected (the SDK's seam).
 */
export async function runRagApp(options: {
  readonly config: AppHarnessConfig;
  readonly token: string;
  readonly transport: TransportImplementation;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly environment: {
    readonly runtime: string;
    readonly toolchain: string;
    readonly database: string;
    readonly configuration: Readonly<Record<string, string>>;
  };
  readonly runSuffix: string;
  readonly taskIndex: number;
}): Promise<{ readonly evidence: HarnessEvidence; readonly passed: boolean }> {
  const harness = new ValidationHarness({
    baseUrl: options.config.baseUrl,
    token: options.token,
    applicationId: options.config.applicationId,
    transport: options.transport,
    runtime: {
      now: options.now,
      sleep: options.sleep,
      environment: options.environment,
    },
    identity: {
      program: "zeck-validation",
      workOrder: "VAL-011",
      baseRevision: options.config.corpusRevision,
      applicationRevision: options.config.applicationRevision,
      corpusRevision: options.config.corpusRevision,
      integrationSurface: options.config.integrationSurface,
    },
    pollIntervalMs: options.config.pollIntervalMs,
    completionTimeoutMs: options.config.completionTimeoutMs,
  });

  const task = RAG_TASKS[options.taskIndex] ?? RAG_TASKS[0];
  if (task === undefined) {
    throw new Error("the pinned RAG task slice is empty");
  }
  const submitted = await harness.submit(
    {
      applicationId: options.config.applicationId,
      task: { ...task },
    },
    `${IDEMPOTENCY_PREFIX}-${options.runSuffix}-${options.taskIndex}`,
  );

  await harness.awaitCompletion(submitted.executionId);
  await harness.retrieveResult(submitted.executionId);

  // Every pinned RAG row (including the out-of-KB edge) expects the
  // deterministic verified outcome: COMPLETED with PASS verification.
  const passed = harness.assertOutcome({
    expectTerminalStatus: "COMPLETED",
    expectVerificationStatuses: ["PASS"],
    forbiddenTerminalStatuses: ["FAILED", "CANCELLED", "EXPIRED"],
    forbidRetryableErrors: true,
  });

  return { evidence: harness.evidence(), passed };
}
