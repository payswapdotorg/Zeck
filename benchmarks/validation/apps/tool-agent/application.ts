/**
 * The tool-using agent customer application (VAL-012).
 *
 * A real customer-style application: business goals that require
 * governed tool invocation (single tools, chained tools, and policy
 * workflows), submitted through Zeck's public SDK boundary. The
 * platform drives the multi-step agent loop (model rounds, tool
 * execution, wait-tool/resume cycles) and records the mechanically
 * verified outcome; this application asserts the deterministic outcome
 * contract per task.
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import { TOOL_TASK_GROUND_TRUTHS, WORKFLOW_TASK_GROUND_TRUTHS } from "./tools";

/** The app's pinned task payloads (the public-API task shapes). */
export const TOOL_AGENT_TASKS = [
  ...TOOL_TASK_GROUND_TRUTHS.map((truth) => ({
    kind: "use-tool" as const,
    goal: truth.goal,
    tools: [...truth.exposedTools],
    /** The corpus row's own expected terminal (unachievable goals FAIL). */
    expectedTerminal: (truth.goalAchievable ? "COMPLETED" : "FAILED") as "COMPLETED" | "FAILED",
  })),
  ...WORKFLOW_TASK_GROUND_TRUTHS.map((truth) => ({
    kind: "run-workflow" as const,
    workflow: "invoice-approval" as const,
    invoice: truth.invoiceId,
    expectedTerminal: (truth.goalAchievable ? "COMPLETED" : "FAILED") as "COMPLETED" | "FAILED",
  })),
] as const;

const IDEMPOTENCY_PREFIX = "val-012-tool-agent";

/**
 * Run the tool-agent application end to end over one pinned task.
 * The transport implementation is injected (the SDK's seam).
 */
export async function runToolAgentApp(options: {
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
      workOrder: "VAL-012",
      baseRevision: options.config.corpusRevision,
      applicationRevision: options.config.applicationRevision,
      corpusRevision: options.config.corpusRevision,
      integrationSurface: options.config.integrationSurface,
    },
    pollIntervalMs: options.config.pollIntervalMs,
    completionTimeoutMs: options.config.completionTimeoutMs,
  });

  const task = TOOL_AGENT_TASKS[options.taskIndex] ?? TOOL_AGENT_TASKS[0];
  if (task === undefined) {
    throw new Error("the pinned tool-agent task slice is empty");
  }
  const { expectedTerminal, ...payload } = task;
  const submitted = await harness.submit(
    {
      applicationId: options.config.applicationId,
      task: { ...payload },
    },
    `${IDEMPOTENCY_PREFIX}-${options.runSuffix}-${options.taskIndex}`,
  );

  await harness.awaitCompletion(submitted.executionId);
  await harness.retrieveResult(submitted.executionId);

  // The deterministic outcome contract per corpus row: an achievable
  // goal must COMPLETED+PASS; an unachievable one (the corpus's
  // expected-failure rows) must FAILED — a COMPLETED there would mean a
  // fabricated success.
  const passed = harness.assertOutcome({
    expectTerminalStatus: expectedTerminal,
    expectVerificationStatuses: [expectedTerminal === "COMPLETED" ? "PASS" : "FAIL"],
    forbiddenTerminalStatuses: [expectedTerminal === "COMPLETED" ? "FAILED" : "COMPLETED"],
    forbidRetryableErrors: true,
  });

  return { evidence: harness.evidence(), passed };
}
