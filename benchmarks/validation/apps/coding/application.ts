/**
 * The coding customer application (VAL-019).
 *
 * A real customer-style application: small deterministic code-generation
 * tasks (implement a specified word-function as a rule table) verified
 * by the fixture runner's embedded unit tests — the completion
 * authority — submitted through Zeck's public SDK boundary. This
 * application asserts the deterministic outcome contract per task,
 * including the impossible-spec edge row's honest FAILED.
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import { CODING_TASK_GROUND_TRUTHS } from "./specs";

/** The app's pinned task payloads (the public-API task shapes). */
const TASK_SPECS = ["fn-fizzmod", "fn-wordmod", "fn-impossible"] as const;

export const CODING_TASKS = CODING_TASK_GROUND_TRUTHS.map((truth, index) => ({
  kind: "implement-function" as const,
  spec: TASK_SPECS[index] ?? "fn-fizzmod",
  goal: truth.goal,
  expectedTerminal: (truth.goalAchievable ? "COMPLETED" : "FAILED") as "COMPLETED" | "FAILED",
})) as readonly {
  kind: "implement-function";
  spec: string;
  goal: string;
  expectedTerminal: "COMPLETED" | "FAILED";
}[];

const IDEMPOTENCY_PREFIX = "val-019-coding";

/**
 * Run the coding application end to end over one pinned task.
 * The transport implementation is injected (the SDK's seam).
 */
export async function runCodingApp(options: {
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

  const task = CODING_TASKS[options.taskIndex] ?? CODING_TASKS[0];
  if (task === undefined) {
    throw new Error("the pinned coding task slice is empty");
  }
  const expectedTerminal = task.expectedTerminal;
  const submitted = await harness.submit(
    {
      applicationId: options.config.applicationId,
      task: { kind: task.kind, spec: task.spec, goal: task.goal },
    },
    `${IDEMPOTENCY_PREFIX}-${options.runSuffix}-${options.taskIndex}`,
  );

  await harness.awaitCompletion(submitted.executionId);
  await harness.retrieveResult(submitted.executionId);

  // The deterministic outcome contract per corpus row: the two healthy
  // specs expect the verified COMPLETED (all embedded tests passing);
  // the impossible spec expects the honest FAILED — no fabricated pass.
  const passed = harness.assertOutcome({
    expectTerminalStatus: expectedTerminal,
    expectVerificationStatuses: [expectedTerminal === "COMPLETED" ? "PASS" : "FAIL"],
    forbiddenTerminalStatuses: [expectedTerminal === "COMPLETED" ? "FAILED" : "COMPLETED"],
    forbidRetryableErrors: true,
  });

  return { evidence: harness.evidence(), passed };
}
