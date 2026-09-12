/**
 * The research customer application (VAL-019).
 *
 * A real customer-style application: multi-step retrieval and synthesis
 * over the local synthetic source corpus with inline citations,
 * submitted through Zeck's public SDK boundary. The platform drives the
 * agent loop (search → read-source → cited answer) and mechanically
 * verifies citation coverage against the fixture's relevance ground
 * truth; this application asserts the deterministic outcome contract
 * per task.
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import { RESEARCH_TASK_GROUND_TRUTHS } from "./sources";

/** The app's pinned task payloads (the public-API task shapes). */
const TASK_TOPICS = ["topic-agree-3", "topic-gap-warranty", "topic-injected"] as const;

export const RESEARCH_TASKS = RESEARCH_TASK_GROUND_TRUTHS.map((truth, index) => ({
  kind: "research-synthesis" as const,
  topic: TASK_TOPICS[index] ?? "topic-agree-3",
  goal: truth.goal,
  expectedTerminal: (truth.goalAchievable ? "COMPLETED" : "FAILED") as "COMPLETED" | "FAILED",
})) as readonly {
  kind: "research-synthesis";
  topic: string;
  goal: string;
  expectedTerminal: "COMPLETED" | "FAILED";
}[];

const IDEMPOTENCY_PREFIX = "val-019-research";

/**
 * Run the research application end to end over one pinned task.
 * The transport implementation is injected (the SDK's seam).
 */
export async function runResearchApp(options: {
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

  const task = RESEARCH_TASKS[options.taskIndex] ?? RESEARCH_TASKS[0];
  if (task === undefined) {
    throw new Error("the pinned research task slice is empty");
  }
  const expectedTerminal = task.expectedTerminal;
  const submitted = await harness.submit(
    {
      applicationId: options.config.applicationId,
      task: { kind: task.kind, topic: task.topic, goal: task.goal },
    },
    `${IDEMPOTENCY_PREFIX}-${options.runSuffix}-${options.taskIndex}`,
  );

  await harness.awaitCompletion(submitted.executionId);
  await harness.retrieveResult(submitted.executionId);

  // The deterministic outcome contract per corpus row: every research
  // row (including the source-gap and injected-source edges) expects
  // the verified COMPLETED synthesis — an honest insufficiency
  // statement or a correctly-cited answer, never fabrication.
  const passed = harness.assertOutcome({
    expectTerminalStatus: expectedTerminal,
    expectVerificationStatuses: [expectedTerminal === "COMPLETED" ? "PASS" : "FAIL"],
    forbiddenTerminalStatuses: [expectedTerminal === "COMPLETED" ? "FAILED" : "COMPLETED"],
    forbidRetryableErrors: true,
  });

  return { evidence: harness.evidence(), passed };
}
