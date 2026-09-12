/**
 * The operations customer application (VAL-019).
 *
 * A real customer-style application: approval-gated runbook workflows
 * over the synthetic ops state, submitted through Zeck's public SDK
 * boundary. The platform drives the HITL decision cycles (wait-human →
 * recorded scripted decision → resume; approvals gate effects;
 * rejections and escalations never execute; no decision never executes)
 * and verifies the durable ops-state transitions; this application
 * asserts the deterministic outcome contract per task.
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import { OPERATIONS_ROWS } from "./runbooks";

/** The app's pinned task payloads (the public-API task shapes). */
const TASK_RUNBOOKS = [
  { runbook: "rb-restart", target: "svc-a" },
  { runbook: "rb-decommission", target: "node-9" },
  { runbook: "rb-restart", target: "svc-a" },
  { runbook: "rb-restart", target: "svc-b" },
] as const;

export const OPERATIONS_TASKS = OPERATIONS_ROWS.map((row, index) => ({
  kind: "run-runbook" as const,
  runbook: TASK_RUNBOOKS[index]?.runbook ?? "rb-restart",
  target: TASK_RUNBOOKS[index]?.target ?? "svc-a",
  goal: row.truth.goal,
  expectedTerminal: (row.truth.goalAchievable ? "COMPLETED" : "FAILED") as "COMPLETED" | "FAILED",
})) as readonly {
  kind: "run-runbook";
  runbook: string;
  target: string;
  goal: string;
  expectedTerminal: "COMPLETED" | "FAILED";
}[];

const IDEMPOTENCY_PREFIX = "val-019-operations";

/**
 * Run the operations application end to end over one pinned task.
 * The transport implementation is injected (the SDK's seam).
 */
export async function runOperationsApp(options: {
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
      workOrder: "VAL-019",
      baseRevision: options.config.corpusRevision,
      applicationRevision: options.config.applicationRevision,
      corpusRevision: options.config.corpusRevision,
      integrationSurface: options.config.integrationSurface,
    },
    pollIntervalMs: options.config.pollIntervalMs,
    completionTimeoutMs: options.config.completionTimeoutMs,
  });

  const task = OPERATIONS_TASKS[options.taskIndex] ?? OPERATIONS_TASKS[0];
  if (task === undefined) {
    throw new Error("the pinned operations task slice is empty");
  }
  const expectedTerminal = task.expectedTerminal;
  const submitted = await harness.submit(
    {
      applicationId: options.config.applicationId,
      task: { kind: task.kind, runbook: task.runbook, target: task.target, goal: task.goal },
    },
    `${IDEMPOTENCY_PREFIX}-${options.runSuffix}-${options.taskIndex}`,
  );

  await harness.awaitCompletion(submitted.executionId);
  await harness.retrieveResult(submitted.executionId);

  // The deterministic outcome contract per corpus row: the approved,
  // rejected and escalated cycles expect the verified COMPLETED honest
  // report (effects gated correctly); the forged-approval row expects
  // the honest FAILED (no decision was ever recorded — the effect
  // never executed).
  const passed = harness.assertOutcome({
    expectTerminalStatus: expectedTerminal,
    expectVerificationStatuses: [expectedTerminal === "COMPLETED" ? "PASS" : "FAIL"],
    forbiddenTerminalStatuses: [expectedTerminal === "COMPLETED" ? "FAILED" : "COMPLETED"],
    forbidRetryableErrors: true,
  });

  return { evidence: harness.evidence(), passed };
}
