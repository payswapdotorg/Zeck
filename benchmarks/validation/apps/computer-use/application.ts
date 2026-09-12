/**
 * The computer-use customer application (VAL-019).
 *
 * A real customer-style application: file-organization goals over the
 * synthetic in-memory workspace (the LIVE DESKTOP is an honest NOT RUN
 * boundary: no operator-authorized computer-use rail exists at run
 * time), submitted through Zeck's public SDK boundary. The platform
 * drives the agent loop (list / read / move under the hard data
 * boundary) and verifies the mechanical final tree state; this
 * application asserts the deterministic outcome contract per task.
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import { COMPUTER_TASK_GROUND_TRUTHS } from "./workspace";

/** The app's pinned task payloads (the public-API task shapes). */
export const COMPUTER_USE_TASKS = COMPUTER_TASK_GROUND_TRUTHS.map((truth, index) => ({
  kind: "computer-task" as const,
  workspace: ["ws-001", "ws-006", "ws-empty"][index] ?? "ws-001",
  goal: truth.goal,
  expectedTerminal: (truth.goalAchievable ? "COMPLETED" : "FAILED") as "COMPLETED" | "FAILED",
})) as readonly {
  kind: "computer-task";
  workspace: string;
  goal: string;
  expectedTerminal: "COMPLETED" | "FAILED";
}[];

const IDEMPOTENCY_PREFIX = "val-019-computer-use";

/**
 * Run the computer-use application end to end over one pinned task.
 * The transport implementation is injected (the SDK's seam).
 */
export async function runComputerUseApp(options: {
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

  const task = COMPUTER_USE_TASKS[options.taskIndex] ?? COMPUTER_USE_TASKS[0];
  if (task === undefined) {
    throw new Error("the pinned computer-use task slice is empty");
  }
  const expectedTerminal = task.expectedTerminal;
  const submitted = await harness.submit(
    {
      applicationId: options.config.applicationId,
      task: { kind: task.kind, workspace: task.workspace, goal: task.goal },
    },
    `${IDEMPOTENCY_PREFIX}-${options.runSuffix}-${options.taskIndex}`,
  );

  await harness.awaitCompletion(submitted.executionId);
  await harness.retrieveResult(submitted.executionId);

  // The deterministic outcome contract per corpus row: the healthy
  // organize rows expect the verified COMPLETED tree state; the
  // outside-root edge row expects the honest FAILED (the data boundary
  // refuses the read — never a silent escape).
  const passed = harness.assertOutcome({
    expectTerminalStatus: expectedTerminal,
    expectVerificationStatuses: [expectedTerminal === "COMPLETED" ? "PASS" : "FAIL"],
    forbiddenTerminalStatuses: [expectedTerminal === "COMPLETED" ? "FAILED" : "COMPLETED"],
    forbidRetryableErrors: true,
  });

  return { evidence: harness.evidence(), passed };
}
