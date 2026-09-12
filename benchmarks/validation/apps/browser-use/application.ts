/**
 * The browser-use customer application (VAL-019).
 *
 * A real customer-style application: interaction goals over the synthetic
 * shop-fixture site (an in-memory page graph — the LIVE WEB is an honest
 * NOT RUN boundary: no operator-authorized browser rail exists at run
 * time), submitted through Zeck's public SDK boundary. The platform
 * drives the agent loop (navigate / read / click / coupon / checkout)
 * and verifies the mechanical fixture-session state; this application
 * asserts the deterministic outcome contract per task.
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import { BROWSER_TASK_GROUND_TRUTHS } from "./web";

/** The app's pinned task payloads (the public-API task shapes). */
export const BROWSER_USE_TASKS = BROWSER_TASK_GROUND_TRUTHS.map((truth) => ({
  kind: "browser-task" as const,
  site: "shop-fixture" as const,
  goal: truth.goal,
  expectedTerminal: (truth.goalAchievable ? "COMPLETED" : "FAILED") as "COMPLETED" | "FAILED",
})) as readonly {
  kind: "browser-task";
  site: "shop-fixture";
  goal: string;
  expectedTerminal: "COMPLETED" | "FAILED";
}[];

const IDEMPOTENCY_PREFIX = "val-019-browser-use";

/**
 * Run the browser-use application end to end over one pinned task.
 * The transport implementation is injected (the SDK's seam).
 */
export async function runBrowserUseApp(options: {
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

  const task = BROWSER_USE_TASKS[options.taskIndex] ?? BROWSER_USE_TASKS[0];
  if (task === undefined) {
    throw new Error("the pinned browser-use task slice is empty");
  }
  const expectedTerminal = task.expectedTerminal;
  const submitted = await harness.submit(
    {
      applicationId: options.config.applicationId,
      task: { kind: task.kind, site: task.site, goal: task.goal },
    },
    `${IDEMPOTENCY_PREFIX}-${options.runSuffix}-${options.taskIndex}`,
  );

  await harness.awaitCompletion(submitted.executionId);
  await harness.retrieveResult(submitted.executionId);

  // The deterministic outcome contract per corpus row: the two healthy
  // checkout rows expect the verified COMPLETED order state; the
  // fake-payment-instrument edge row expects the honest FAILED (the
  // platform refuses raw card numbers — never a fabricated order).
  const passed = harness.assertOutcome({
    expectTerminalStatus: expectedTerminal,
    expectVerificationStatuses: [expectedTerminal === "COMPLETED" ? "PASS" : "FAIL"],
    forbiddenTerminalStatuses: [expectedTerminal === "COMPLETED" ? "FAILED" : "COMPLETED"],
    forbidRetryableErrors: true,
  });

  return { evidence: harness.evidence(), passed };
}
