/**
 * The image-transformation customer application (VAL-015).
 *
 * A real customer-style application: image-plus-instruction editing
 * over deterministic synthetic source images. Integrates with Zeck
 * exactly as a customer would — through the public SDK boundary (the
 * validation harness), with a repository-reproducible, secret-free
 * configuration and one environment secret. It never imports Zeck
 * internals and never selects a provider/model (API-001: routing is
 * the platform's authority).
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";

/**
 * The app's pinned corpus slice (`image-generation.transform.v1`
 * rows, adapted to the materialized synthetic sources). Each task
 * pairs a deterministic synthetic source image with a seeded edit
 * instruction (the edit fixture binds its own source and target
 * region — the mechanical ground truth).
 */
export const IMAGE_TRANSFORMATION_TASKS = [
  { kind: "transform-image", source: "img-c-001", edit: "img-edit-001" },
  { kind: "transform-image", source: "scene-001", edit: "img-edit-002" },
  { kind: "transform-image", source: "img-c-002", edit: "img-edit-003" },
  // The corrupted-source edge row: the platform's honest expectation
  // is FAILED (the real provider rejects genuinely undecodable media)
  // — never a fabricated edit, never a silent pass.
  { kind: "transform-image", source: "img-corrupt", edit: "img-edit-004" },
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
];

const IDEMPOTENCY_PREFIX = "val-015-image-transformation";

/**
 * Run the image-transformation application end to end over one pinned
 * task. The transport implementation is injected (the SDK's seam).
 */
export async function runImageTransformationApp(options: {
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
      workOrder: "VAL-015",
      baseRevision: options.config.corpusRevision,
      applicationRevision: options.config.applicationRevision,
      corpusRevision: options.config.corpusRevision,
      integrationSurface: options.config.integrationSurface,
    },
    pollIntervalMs: options.config.pollIntervalMs,
    completionTimeoutMs: options.config.completionTimeoutMs,
  });

  const task = IMAGE_TRANSFORMATION_TASKS[options.taskIndex] ?? IMAGE_TRANSFORMATION_TASKS[0];
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
