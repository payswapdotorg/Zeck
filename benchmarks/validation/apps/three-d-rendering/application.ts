/**
 * The three-d-rendering customer application (VAL-018).
 *
 * A real customer-style application: 3D generation from a seeded
 * prompt plus declared geometry parameters. Integrates with Zeck
 * exactly as a customer would — through the public SDK boundary (the
 * validation harness), with a repository-reproducible, secret-free
 * configuration and one environment secret. It never imports Zeck
 * internals and never selects a provider/model (API-001: routing is
 * the platform's authority).
 *
 * NO authorized 3D generation provider rail exists in the program's
 * access set: the REAL dispatch of these rows is an honest NOT RUN
 * boundary (surfaced to the operator in the evidence document per the
 * roadmap's provider-access policy — never a fabricated equivalent).
 * The application, its offline derivations and its discrimination
 * tests all execute; the platform-side driver/binding light up over a
 * REAL rail when operator-authorized 3D access later exists.
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";

/**
 * The app's pinned corpus slice (three-d generation rows: seeded
 * prompt + declared geometry parameters — the task's own mechanical
 * ground truth). The empty-prompt and invalid-geometry rows are the
 * corpus's own expected-FAILED edge rows: they are rejected by the
 * platform BEFORE any paid dispatch — the honest failure, never a
 * silently substituted primitive.
 */
export const THREE_D_RENDERING_TASKS = [
  {
    kind: "generate-3d",
    prompt: "prompt-3d-001",
    geometry: { primitive: "box", dimensions: [2, 1, 2], resolution: 2, format: "glb" },
  },
  {
    kind: "generate-3d",
    prompt: "prompt-3d-002",
    geometry: { primitive: "composite", dimensions: [4, 2, 4], resolution: 2, format: "glb" },
  },
  {
    kind: "generate-3d",
    prompt: "prompt-3d-003",
    geometry: { primitive: "cylinder", dimensions: [1, 2, 1], resolution: 3, format: "obj" },
  },
  // The corpus's own edge rows (scene3d-empty / mesh-005 / mesh-006,
  // adapted): each is mechanically invalid and must genuinely FAIL.
  {
    kind: "generate-3d",
    prompt: "",
    geometry: { primitive: "box", dimensions: [1, 1, 1], resolution: 1, format: "glb" },
  },
  {
    kind: "generate-3d",
    prompt: "prompt-3d-001",
    geometry: { primitive: "box", dimensions: [-1, 1, 1], resolution: 2, format: "glb" },
  },
  {
    kind: "generate-3d",
    prompt: "prompt-3d-001",
    geometry: { primitive: "sphere", dimensions: [1, 1, 1], resolution: 0, format: "glb" },
  },
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
  {
    expectTerminalStatus: "FAILED" as const,
    expectVerificationStatuses: ["FAIL" as const],
    forbiddenTerminalStatuses: ["COMPLETED"] as const,
  },
];

const IDEMPOTENCY_PREFIX = "val-018-three-d-rendering";

/**
 * Run the three-d-rendering application end to end over one pinned
 * task. The transport implementation is injected (the SDK's seam).
 */
export async function runThreeDRenderingApp(options: {
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

  const task = THREE_D_RENDERING_TASKS[options.taskIndex] ?? THREE_D_RENDERING_TASKS[0];
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
