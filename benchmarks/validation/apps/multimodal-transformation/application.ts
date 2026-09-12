/**
 * The multimodal-transformation customer application (VAL-018).
 *
 * A real customer-style application: image -> structured description
 * -> derived media. Each row submits a synthetic source image plus a
 * seeded structured-description instruction; the platform chains the
 * proven vision rail and the proven image-generation rail and returns
 * a mechanically verified derived image. Integrates with Zeck exactly
 * as a customer would — through the public SDK boundary (the
 * validation harness), with a repository-reproducible, secret-free
 * configuration and one environment secret. It never imports Zeck
 * internals and never selects a provider/model (API-001: routing is
 * the platform's authority).
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";

/**
 * The app's pinned corpus slice (multimodal transformation rows,
 * adapted to the materialized synthetic sources). Each task pairs a
 * deterministic synthetic source image with a seeded
 * structured-description instruction.
 */
export const MULTIMODAL_TRANSFORMATION_TASKS = [
  { kind: "transform-multimodal", source: "img-c-001", instruction: "mm-instruction-001" },
  { kind: "transform-multimodal", source: "scene-001", instruction: "mm-instruction-001" },
  // The chart row rides the trend-focused instruction variant: the
  // structured description's composition field must state the trend
  // direction (the fixture's own ground-truth term).
  { kind: "transform-multimodal", source: "scene-004", instruction: "mm-instruction-002" },
  // The corrupted-source edge row: the platform's honest expectation
  // is FAILED (the REAL vision provider rejects genuinely undecodable
  // media; the chain aborts at the vision stage with the exact stage
  // recorded) — never a fabricated description, never a silent pass.
  { kind: "transform-multimodal", source: "img-corrupt", instruction: "mm-instruction-001" },
  // The wrong-modality rejection row: an imagegen task submitted to
  // the multimodal-transformation chain is rejected BEFORE any
  // network effect (wrong-modality) — the honest expected-FAILED row.
  { kind: "transform-image", source: "img-c-001", edit: "img-edit-001" },
] as const;

/** Per-task outcome contracts (the corpus rows' own expectations). */
const TASK_EXPECTATIONS = [
  {
    expectTerminalStatus: "COMPLETED" as const,
    expectVerificationStatuses: ["PASS" as const],
    forbiddenTerminalStatuses: ["FAILED", "CANCELLED", "EXPIRED"] as const,
  },
  {
    expectTerminalStatus: "COMPLETED" as const,
    expectVerificationStatuses: ["PASS" as const],
    forbiddenTerminalStatuses: ["FAILED", "CANCELLED", "EXPIRED"] as const,
  },
  {
    expectTerminalStatus: "COMPLETED" as const,
    expectVerificationStatuses: ["PASS" as const],
    forbiddenTerminalStatuses: ["FAILED", "CANCELLED", "EXPIRED"] as const,
  },
  {
    expectTerminalStatus: "FAILED" as const,
    expectVerificationStatuses: ["FAIL" as const],
    forbiddenTerminalStatuses: ["COMPLETED"] as const,
  },
  {
    expectTerminalStatus: "FAILED" as const,
    expectVerificationStatuses: ["FAIL" as const],
    forbiddenTerminalStatuses: ["COMPLETED"] as const,
  },
];

const IDEMPOTENCY_PREFIX = "val-018-multimodal-transformation";

/**
 * Run the multimodal-transformation application end to end over one
 * pinned task. The transport implementation is injected (the SDK's
 * seam).
 */
export async function runMultimodalTransformationApp(options: {
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
      workOrder: "VAL-018",
      baseRevision: options.config.corpusRevision,
      applicationRevision: options.config.applicationRevision,
      corpusRevision: options.config.corpusRevision,
      integrationSurface: options.config.integrationSurface,
    },
    pollIntervalMs: options.config.pollIntervalMs,
    completionTimeoutMs: options.config.completionTimeoutMs,
  });

  const task =
    MULTIMODAL_TRANSFORMATION_TASKS[options.taskIndex] ?? MULTIMODAL_TRANSFORMATION_TASKS[0];
  const submitted = await harness.submit(
    {
      applicationId: options.config.applicationId,
      task: { ...task },
    },
    `${IDEMPOTENCY_PREFIX}-${options.runSuffix}-${options.taskIndex}`,
  );

  await harness.awaitCompletion(submitted.executionId);
  await harness.retrieveResult(submitted.executionId);

  const expectations = TASK_EXPECTATIONS[options.taskIndex] ?? TASK_EXPECTATIONS[0];
  const passed = harness.assertOutcome({
    ...expectations,
    forbidRetryableErrors: true,
  });

  return { evidence: harness.evidence(), passed };
}
