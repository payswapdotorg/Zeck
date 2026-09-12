/**
 * The 3D generation/rendering customer application (VAL-018).
 *
 * A real customer-style application: scene rendering and parametric
 * mesh generation over seeded spec fixtures. Integrates with Zeck
 * exactly as a customer would — through the public SDK boundary (the
 * validation harness), with a repository-reproducible, secret-free
 * configuration and one environment secret. It never imports Zeck
 * internals and never selects a provider/model (API-001: routing is
 * the platform's authority).
 *
 * The honest 3D boundary: NO operator-authorized 3D-generation
 * provider rail exists today (the capability matrix's `model:three-d`
 * row has zero candidate providers), so the REAL 3D dispatches are
 * recorded NOT RUN boundaries with the exact missing access
 * requirement surfaced (provider/model, why needed, experiment
 * unlocked, minimum credential — see platform/three-d.ts) — never a
 * fabricated equivalent. This application's offline paths (the SDK
 * boundary integration over controlled fakes, the derivations and the
 * discrimination tests) still execute and pass.
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";

/**
 * The app's pinned corpus slice (three-d.render-scene.v1 /
 * three-d.mesh-from-spec.v1 rows). Each task keys a deterministic
 * seeded spec fixture (the exact spec text + the fixture's own
 * mechanical ground truth); the provably-invalid edge rows expect the
 * honest FAILED terminal (rejected before any paid dispatch).
 */
export const THREE_D_RENDERING_TASKS = [
  { kind: "render-3d", scene: "scene3d-001" },
  { kind: "render-3d", scene: "scene3d-002" },
  { kind: "mesh-from-spec", spec: "mesh-001" },
  // The corpus's own expected-FAILED edge rows: empty scene, unknown
  // primitive (never silently substituted), corrupted spec — each
  // rejected BEFORE any paid dispatch.
  { kind: "render-3d", scene: "scene3d-empty" },
  { kind: "mesh-from-spec", spec: "mesh-008" },
  { kind: "render-3d", scene: "scene3d-corrupt" },
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
 * Run the 3D rendering application end to end over one pinned task.
 * The transport implementation is injected (the SDK's seam).
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
