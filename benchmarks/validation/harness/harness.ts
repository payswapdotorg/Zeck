/**
 * The customer-style validation harness (VAL-002, acceptance criteria
 * 1, 2, 4, 5).
 *
 * The harness rides EXACTLY the public developer boundary a customer
 * integrates through: the `sdk/` execution-centric client (with an
 * injected transport implementation), over the public wire contract —
 * request submission (create), asynchronous completion (polling the
 * public execution read), result retrieval, and error reporting
 * (the public error taxonomy). It never imports internal Zeck modules:
 * the harness is what a customer would write, plus evidence capture.
 *
 * Deterministic assertions (criterion 5) run against returned outcomes;
 * every run carries the stable experiment identity and records
 * application and Zeck revisions (criterion 4 — the identity contract
 * from VAL-001's run-identity module).
 */

import {
  createZeckClient,
  type ExecutionRequest,
  type ExecutionResult,
  TERMINAL_STATUSES,
  type ZeckClient,
} from "../../../sdk";
import { deriveRunId, type RunEnvironmentDescriptor } from "../run-identity";
import { digestResult, type HarnessEvidence } from "./evidence";

/** The injected transport implementation (the SDK seam). */
/** The injected transport implementation (the SDK seam). */
export type TransportImplementation = NonNullable<
  Parameters<typeof createZeckClient>[0]["fetchImpl"]
>;

/** Clock and identity injection for deterministic tests. */
export interface HarnessRuntime {
  readonly now: () => Date;
  /** Sleep between completion polls (milliseconds). */
  readonly sleep: (ms: number) => Promise<void>;
  readonly environment: RunEnvironmentDescriptor;
}

/** Expectations for the deterministic outcome assertions. */
export interface OutcomeExpectations {
  /** The terminal status the app requires for success. */
  readonly expectTerminalStatus?: string;
  /**
   * Required verification statuses on the retrieved result (all must be
   * present — each expected entry must appear among the result's
   * verification statuses).
   */
  readonly expectVerificationStatuses?: readonly string[];
  /** Forbidden outcomes: terminal statuses the app must never see. */
  readonly forbiddenTerminalStatuses?: readonly string[];
  /** The run must surface no retryable transport errors. */
  readonly forbidRetryableErrors?: boolean;
}

/** Everything a submitted run needs (AC2: submission + identity). */
export interface SubmittedRun {
  readonly executionId: string;
  readonly idempotencyKey: string;
  readonly initialStatus: string;
  readonly replayed: boolean;
}

/** The harness handle for one customer-style application run. */
export class ValidationHarness {
  private readonly client: ZeckClient;
  private readonly runtime: HarnessRuntime;
  private readonly identity: {
    readonly program: string;
    readonly workOrder: string;
    readonly baseRevision: string;
    readonly applicationRevision: string;
    readonly corpusRevision: string;
    readonly integrationSurface: string;
  };
  private readonly pollIntervalMs: number;
  private readonly completionTimeoutMs: number;
  private readonly timeline: { at: string; status: string }[] = [];
  private readonly errors: {
    at: string;
    status: number | null;
    code: string;
    message: string;
    retryable: boolean;
  }[] = [];
  private readonly assertions: { name: string; passed: boolean; detail: string }[] = [];
  private request: HarnessEvidence["request"] = null;
  private terminalStatus: string | null = null;
  private resultDigest: string | null = null;
  private verificationStatuses: string[] = [];
  private submitMs: number | null = null;
  private completionMs: number | null = null;
  private retrievalMs: number | null = null;
  private startedAt = 0;

  constructor(options: {
    readonly baseUrl: string;
    readonly token: string;
    readonly applicationId: string;
    readonly transport: TransportImplementation;
    readonly runtime: HarnessRuntime;
    readonly identity: {
      readonly program: string;
      readonly workOrder: string;
      readonly baseRevision: string;
      readonly applicationRevision: string;
      readonly corpusRevision: string;
      readonly integrationSurface: string;
    };
    readonly pollIntervalMs: number;
    readonly completionTimeoutMs: number;
  }) {
    this.client = createZeckClient({
      baseUrl: options.baseUrl,
      token: options.token,
      applicationId: options.applicationId,
      fetchImpl: options.transport,
    });
    this.runtime = options.runtime;
    this.identity = options.identity;
    this.pollIntervalMs = options.pollIntervalMs;
    this.completionTimeoutMs = options.completionTimeoutMs;
    this.startedAt = this.runtime.now().getTime();
  }

  /** AC2 + AC4: submit through the public create mode. */
  async submit(request: ExecutionRequest, idempotencyKey: string): Promise<SubmittedRun> {
    const started = this.runtime.now().getTime();
    try {
      const { receipt } = await this.client.createExecution(request, idempotencyKey);
      this.submitMs = this.runtime.now().getTime() - started;
      this.request = {
        taskKind: String((request.task as { kind?: unknown })?.kind ?? "unknown"),
        idempotencyKey,
        constraints: request.constraints ?? null,
      };
      this.recordObservation(receipt.status);
      return {
        executionId: receipt.executionId,
        idempotencyKey,
        initialStatus: receipt.status,
        replayed: receipt.replayed,
      };
    } catch (error) {
      this.submitMs = this.runtime.now().getTime() - started;
      this.recordError(error);
      throw error;
    }
  }

  /** AC2: asynchronous completion — poll the public read until terminal. */
  async awaitCompletion(executionId: string): Promise<string | null> {
    const deadline = this.runtime.now().getTime() + this.completionTimeoutMs;
    const started = this.runtime.now().getTime();
    for (;;) {
      try {
        const execution = await this.client.getExecution(executionId);
        this.recordObservation(execution.status);
        if (TERMINAL_STATUSES.includes(execution.status)) {
          this.terminalStatus = execution.status;
          this.completionMs = this.runtime.now().getTime() - started;
          return execution.status;
        }
      } catch (error) {
        this.recordError(error);
        throw error;
      }
      if (this.runtime.now().getTime() >= deadline) {
        this.completionMs = this.runtime.now().getTime() - started;
        return null;
      }
      await this.runtime.sleep(this.pollIntervalMs);
    }
  }

  /** AC2: result retrieval through the public result read. */
  async retrieveResult(executionId: string): Promise<ExecutionResult | null> {
    const started = this.runtime.now().getTime();
    try {
      const result = await this.client.getResult(executionId);
      this.retrievalMs = this.runtime.now().getTime() - started;
      this.resultDigest = digestResult(result);
      this.verificationStatuses = result.verification.map((entry) => entry.status as string);
      return result;
    } catch (error) {
      this.retrievalMs = this.runtime.now().getTime() - started;
      this.recordError(error);
      return null;
    }
  }

  /** AC5: deterministic assertions against the returned outcome. */
  assertOutcome(expectations: OutcomeExpectations): boolean {
    let allPassed = true;
    const record = (name: string, passed: boolean, detail: string): void => {
      this.assertions.push({ name, passed, detail });
      if (!passed) {
        allPassed = false;
      }
    };

    if (expectations.expectTerminalStatus !== undefined) {
      const passed = this.terminalStatus === expectations.expectTerminalStatus;
      record(
        "terminal-status",
        passed,
        `expected ${expectations.expectTerminalStatus}, observed ${this.terminalStatus ?? "TIMEOUT"}`,
      );
    }
    for (const forbidden of expectations.forbiddenTerminalStatuses ?? []) {
      const passed = this.terminalStatus !== forbidden;
      record(
        `forbidden-${forbidden}`,
        passed,
        passed ? `${forbidden} not observed` : `forbidden terminal status ${forbidden} observed`,
      );
    }
    if (expectations.expectVerificationStatuses !== undefined) {
      const missing = expectations.expectVerificationStatuses.filter(
        (status) => !this.verificationStatuses.includes(status),
      );
      record(
        "verification-statuses",
        missing.length === 0,
        missing.length === 0
          ? `all expected verification statuses present (${this.verificationStatuses.join(", ") || "none"})`
          : `missing verification statuses: ${missing.join(", ")}`,
      );
    }
    if (expectations.forbidRetryableErrors === true) {
      const retryable = this.errors.filter((error) => error.retryable);
      record(
        "no-retryable-errors",
        retryable.length === 0,
        retryable.length === 0
          ? "no retryable transport errors surfaced"
          : `${retryable.length} retryable error(s) surfaced`,
      );
    }
    return allPassed;
  }

  /** AC6: evidence consumable by the universal recorder and report. */
  evidence(): HarnessEvidence {
    const runId = deriveRunId({
      program: this.identity.program,
      workOrder: this.identity.workOrder,
      baseRevision: this.identity.baseRevision,
      applicationRevision: this.identity.applicationRevision,
      corpusRevision: this.identity.corpusRevision,
      integrationSurface: this.identity.integrationSurface,
      environment: this.runtime.environment,
      observedAt: new Date(this.startedAt).toISOString(),
    });
    return {
      runId,
      program: this.identity.program,
      workOrder: this.identity.workOrder,
      baseRevision: this.identity.baseRevision,
      applicationRevision: this.identity.applicationRevision,
      corpusRevision: this.identity.corpusRevision,
      integrationSurface: this.identity.integrationSurface,
      request: this.request,
      timeline: [...this.timeline],
      terminalStatus: this.terminalStatus,
      resultDigest: this.resultDigest,
      verificationStatuses: [...this.verificationStatuses],
      errors: [...this.errors],
      assertions: [...this.assertions],
      timings: {
        submitMs: this.submitMs,
        completionMs: this.completionMs,
        retrievalMs: this.retrievalMs,
        totalMs: this.runtime.now().getTime() - this.startedAt,
      },
    };
  }

  private recordObservation(status: string): void {
    this.timeline.push({ at: this.runtime.now().toISOString(), status });
  }

  private recordError(error: unknown): void {
    const asZeckError = error as {
      status?: number;
      body?: { code?: string; message?: string; retryable?: boolean };
    };
    this.errors.push({
      at: this.runtime.now().toISOString(),
      status: typeof asZeckError?.status === "number" ? asZeckError.status : null,
      code: asZeckError?.body?.code ?? "UNEXPECTED",
      message: error instanceof Error ? error.message : String(error),
      retryable: asZeckError?.body?.retryable ?? false,
    });
  }
}
