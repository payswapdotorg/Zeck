/**
 * The customer-service triage customer application (VAL-019).
 *
 * A real customer-style application: support tickets triaged and routed
 * exactly per the synthetic routing policy, submitted through Zeck's
 * public SDK boundary. The platform drives the agent loop (classify →
 * route / escalate per the policy table — the classifier's signal-derived
 * verdict is the only routing authority) and records the mechanically
 * verified outcome; this application asserts the deterministic outcome
 * contract per task.
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import { CS_TASK_GROUND_TRUTHS } from "./triage";

/** The app's pinned task payloads (the public-API task shapes). */
const TASK_TICKETS = ["ticket-101", "ticket-102", "ticket-104", "ticket-106"] as const;

export const CUSTOMER_SERVICE_TASKS = CS_TASK_GROUND_TRUTHS.map((truth, index) => ({
  kind: "triage-ticket" as const,
  ticket: TASK_TICKETS[index] ?? "ticket-101",
  expectedTerminal: (truth.goalAchievable ? "COMPLETED" : "FAILED") as "COMPLETED" | "FAILED",
})) as readonly {
  kind: "triage-ticket";
  ticket: string;
  expectedTerminal: "COMPLETED" | "FAILED";
}[];

const IDEMPOTENCY_PREFIX = "val-019-customer-service";

/**
 * Run the customer-service application end to end over one pinned task.
 * The transport implementation is injected (the SDK's seam).
 */
export async function runCustomerServiceApp(options: {
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

  const task = CUSTOMER_SERVICE_TASKS[options.taskIndex] ?? CUSTOMER_SERVICE_TASKS[0];
  if (task === undefined) {
    throw new Error("the pinned customer-service task slice is empty");
  }
  const expectedTerminal = task.expectedTerminal;
  const submitted = await harness.submit(
    {
      applicationId: options.config.applicationId,
      task: { kind: task.kind, ticket: task.ticket },
    },
    `${IDEMPOTENCY_PREFIX}-${options.runSuffix}-${options.taskIndex}`,
  );

  await harness.awaitCompletion(submitted.executionId);
  await harness.retrieveResult(submitted.executionId);

  // The deterministic outcome contract per corpus row: every triage row
  // (including the forged-severity edge) expects the verified COMPLETED
  // routing/escalation outcome — a FAILED there means the policy was
  // not followed honestly.
  const passed = harness.assertOutcome({
    expectTerminalStatus: expectedTerminal,
    expectVerificationStatuses: [expectedTerminal === "COMPLETED" ? "PASS" : "FAIL"],
    forbiddenTerminalStatuses: [expectedTerminal === "COMPLETED" ? "FAILED" : "COMPLETED"],
    forbidRetryableErrors: true,
  });

  return { evidence: harness.evidence(), passed };
}
