/**
 * The media-generation JOBS customer application (VAL-016).
 *
 * A real customer-style media-generation JOB application: pinned jobs
 * whose ordered items are dispatched asynchronously through Zeck's
 * public SDK boundary — per item: submission → bounded polling →
 * result retrieval → deterministic assertions — with mechanical
 * job-level accounting on top:
 *   * NO LOST TASKS: every submitted item must reach a terminal
 *     status within the bounded completion window; an item that does
 *     not is reported as LOST and fails the job (never silently
 *     dropped, never an unbounded wait);
 *   * HONEST TASK-FAILURE PROPAGATION: an item that lands FAILED is
 *     recorded as a failed item and fails the job mechanically (a
 *     healthy sibling item still completes and is accounted);
 *   * MEASURED ASYNC ECONOMICS: per-item and whole-job async wall
 *     time, per-item poll observation counts (the poll cadence) and
 *     per-item result digests are measured and recorded — payload
 *     DIGESTS only, never payloads.
 *
 * Integrates with Zeck exactly as a customer would — through the
 * public SDK boundary (the validation harness), with a
 * repository-reproducible, secret-free configuration and one
 * environment secret. It never imports Zeck internals and never
 * selects a provider/model (routing is the platform's authority).
 */

import type { AppHarnessConfig } from "../../harness/config";
import type { HarnessEvidence } from "../../harness/evidence";
import { type TransportImplementation, ValidationHarness } from "../../harness/harness";
import { deriveMediaJobTerminal, MEDIA_GENERATION_JOBS } from "./jobs";

const IDEMPOTENCY_PREFIX = "val-016-media-generation-jobs";

/** One item's accounted outcome inside a job run. */
export interface MediaJobItemOutcome {
  readonly itemKey: string;
  /** The seeded fixture key the item's task referenced. */
  readonly fixtureKey: string;
  /** The observed terminal status (null ⇒ LOST: never reached terminal). */
  readonly terminalStatus: string | null;
  /** True when the item never reached a terminal status in the window. */
  readonly lost: boolean;
  /** The item's per-item deterministic assertions all passed. */
  readonly assertionsPassed: boolean;
  /** Verification statuses of the retrieved result (when present). */
  readonly verificationStatuses: readonly string[];
  /** Digest of the retrieved result package (digest, never payload). */
  readonly resultDigest: string | null;
  /** The item's measured async timings (submit/completion/retrieval). */
  readonly timings: HarnessEvidence["timings"];
  /** The item's completion-poll observation count (the poll cadence). */
  readonly pollObservations: number;
  /** The recorder-consumable evidence of the item's harness run. */
  readonly evidence: HarnessEvidence;
}

/** One whole job run's accounted outcome. */
export interface MediaJobRunOutcome {
  readonly jobId: string;
  /** The mechanically derived job terminal (no lost tasks, honest failures). */
  readonly jobTerminal: "COMPLETED" | "FAILED";
  /** The job fixture's pinned expected terminal. */
  readonly expectedJobTerminal: "COMPLETED" | "FAILED";
  /** The app-level assertion: derived terminal matches the pinned expectation. */
  readonly jobPassed: boolean;
  readonly items: readonly MediaJobItemOutcome[];
  readonly completedItemCount: number;
  readonly failedItemCount: number;
  readonly lostItemCount: number;
  /** Measured wall time of the whole job (all items, end to end). */
  readonly jobWallMs: number;
  /** Total completion-poll observations across items (the cadence numerator). */
  readonly pollObservations: number;
}

/**
 * Run one pinned media-generation job end to end: submit each item
 * through the public SDK, await its asynchronous completion within
 * the bounded window, retrieve its result, assert the item's
 * deterministic outcome contract, and derive the job's terminal
 * mechanically. The transport implementation is injected (the SDK's
 * seam).
 */
export async function runMediaGenerationJobsApp(options: {
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
  readonly jobIndex: number;
}): Promise<MediaJobRunOutcome> {
  const job = MEDIA_GENERATION_JOBS[options.jobIndex];
  if (job === undefined) {
    throw new Error(`media-generation job not pinned: index ${options.jobIndex}`);
  }

  const jobStartedAt = options.now().getTime();
  const items: MediaJobItemOutcome[] = [];

  for (const [itemIndex, item] of job.items.entries()) {
    // One harness run per item — each item is its own SDK submission
    // -> polling -> retrieval cycle, with its own evidence record.
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
        workOrder: "VAL-016",
        baseRevision: options.config.corpusRevision,
        applicationRevision: options.config.applicationRevision,
        corpusRevision: options.config.corpusRevision,
        integrationSurface: options.config.integrationSurface,
      },
      pollIntervalMs: options.config.pollIntervalMs,
      completionTimeoutMs: options.config.completionTimeoutMs,
    });

    const submitted = await harness.submit(
      {
        applicationId: options.config.applicationId,
        task: { ...item.task },
      },
      `${IDEMPOTENCY_PREFIX}-${options.runSuffix}-${options.jobIndex}-${itemIndex}`,
    );

    // Bounded asynchronous completion: null ⇒ the item never reached
    // a terminal status within the window (LOST — accounted below,
    // never dropped).
    const terminalStatus = await harness.awaitCompletion(submitted.executionId);
    await harness.retrieveResult(submitted.executionId);

    // The item's deterministic outcome contract (the corpus row's own
    // expectation): healthy items COMPLETED+PASS; the zero-duration
    // edge item FAILED+FAIL (a COMPLETED there would be a fabricated
    // success — the assertion fails it).
    const assertionsPassed = harness.assertOutcome({
      expectTerminalStatus: item.expectedItemTerminal,
      expectVerificationStatuses: [item.expectedItemTerminal === "COMPLETED" ? "PASS" : "FAIL"],
      forbiddenTerminalStatuses: [
        item.expectedItemTerminal === "COMPLETED" ? "FAILED" : "COMPLETED",
      ],
      forbidRetryableErrors: true,
    });

    const evidence = harness.evidence();
    items.push({
      itemKey: item.itemKey,
      fixtureKey: item.task.prompt,
      terminalStatus,
      lost: terminalStatus === null,
      assertionsPassed,
      verificationStatuses: [...evidence.verificationStatuses],
      resultDigest: evidence.resultDigest,
      timings: evidence.timings,
      pollObservations: evidence.timeline.length,
      evidence,
    });
  }

  // Mechanical job accounting (no lost tasks; honest failures).
  const jobTerminal = deriveMediaJobTerminal(items);
  const lostItemCount = items.filter((item) => item.lost).length;
  const jobPassed =
    jobTerminal === job.expectedJobTerminal &&
    lostItemCount === 0 &&
    items.every((item) => item.assertionsPassed);

  return {
    jobId: job.jobId,
    jobTerminal,
    expectedJobTerminal: job.expectedJobTerminal,
    jobPassed,
    items,
    completedItemCount: items.filter((item) => item.terminalStatus === "COMPLETED").length,
    failedItemCount: items.filter(
      (item) => item.terminalStatus !== null && item.terminalStatus !== "COMPLETED",
    ).length,
    lostItemCount,
    jobWallMs: options.now().getTime() - jobStartedAt,
    pollObservations: items.reduce((sum, item) => sum + item.pollObservations, 0),
  };
}
