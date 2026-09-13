/**
 * The security-validation customer application (VAL-023).
 *
 * A real customer-style application: one pinned adversarial corpus
 * row per run — injection rows (tool-result / document / media
 * vectors), capability-boundary probes, secret-flow probes, the
 * control row and the env-gated live rail rows — submitted through
 * Zeck's public SDK boundary. The platform drives the governed tool
 * round (the boundary-guarded executor) and the bounded-retry model
 * dispatch (the injection genuinely in the model's context); this
 * application asserts the per-row deterministic defense contract from
 * the corpus: every row EXPECTS the corpus-declared terminal — a
 * defended or honestly-refused completion COMPLETES (a FAILED there
 * would mean a dispatch failure or a defense failure, both honest
 * findings); an injection-followed completion FAILS its criteria and
 * the terminal honestly (never a silently tolerated violation).
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import { SECURITY_CORPUS } from "./corpus";

/** The app's pinned corpus slice (`security-validation.probe.v1` rows). */
export const SECURITY_TASKS = SECURITY_CORPUS.map((row) => ({
  kind: row.kind,
  scenario: row.rowId,
  ...(row.toolInvocation === undefined ? {} : { tool: row.toolInvocation.tool }),
  ...(row.toolInvocation === undefined ? {} : { arguments: { ...row.toolInvocation.arguments } }),
  /** The corpus row's own expected terminal (the app's outcome contract). */
  expectedTerminal: row.expected.terminal,
}));

const IDEMPOTENCY_PREFIX = "val-023-security-validation";

/**
 * Run the security-validation application end to end over one pinned
 * corpus row. The transport implementation is injected (the SDK's
 * seam); the app never selects provider/model/rail (the platform's
 * authority).
 */
export async function runSecurityValidationApp(options: {
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
      workOrder: "VAL-023",
      baseRevision: options.config.corpusRevision,
      applicationRevision: options.config.applicationRevision,
      corpusRevision: options.config.corpusRevision,
      integrationSurface: options.config.integrationSurface,
    },
    pollIntervalMs: options.config.pollIntervalMs,
    completionTimeoutMs: options.config.completionTimeoutMs,
  });

  const task = SECURITY_TASKS[options.taskIndex] ?? SECURITY_TASKS[0];
  if (task === undefined) {
    throw new Error("the pinned security-validation task slice is empty");
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

  // The deterministic outcome contract per corpus row: every row in
  // this corpus pins COMPLETED (a defended / honestly-refused probe
  // outcome). The verification criteria prove the defense — an
  // injection-followed completion or a dispatch failure flips the
  // platform terminal to FAILED, which fails this app's assertion
  // honestly (never a silently tolerated violation, never a fabricated
  // defense).
  const passed = harness.assertOutcome({
    expectTerminalStatus: expectedTerminal,
    expectVerificationStatuses: ["PASS"],
    forbiddenTerminalStatuses: [expectedTerminal === "COMPLETED" ? "FAILED" : "COMPLETED"],
    forbidRetryableErrors: true,
  });

  return { evidence: harness.evidence(), passed };
}
