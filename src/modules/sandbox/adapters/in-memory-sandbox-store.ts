/**
 * In-memory sandbox store (sandbox module; WORK-012 unit-test
 * infrastructure — the agents/tools fakes discipline).
 *
 * A faithful in-memory realization of the `SandboxStore` port including
 * the convergence arbitration (unique (application, slug) /
 * (application, sandboxKey) keys), the guarded one-shot transitions and
 * the write-once immutability of specifications and runtime metadata.
 * True cross-connection concurrency/locking cannot be simulated here —
 * the real-PostgreSQL suites own those proofs.
 */

import { PlatformError } from "../../../shared/errors";
import type { ComputeEnvironmentRecord, EnvironmentLifecycleStatus } from "../domain/environment";
import { canTransitionEnvironment } from "../domain/environment";
import type { SandboxExecutionRecord } from "../domain/sandbox";
import { canTransitionSandbox, isTerminalSandboxStatus } from "../domain/sandbox";
import type {
  BindLedgerSequenceInput,
  ClaimOutcome,
  InsertEnvironmentInput,
  InsertSandboxInput,
  RecordOutcomeInput,
  SandboxStore,
  UpdateEnvironmentStatusInput,
} from "../ports/sandbox-store";

interface EnvironmentEntry {
  record: ComputeEnvironmentRecord;
}

interface SandboxEntry {
  record: SandboxExecutionRecord;
}

export class InMemorySandboxStore implements SandboxStore {
  private readonly environments = new Map<string, EnvironmentEntry>();
  private readonly sandboxes = new Map<string, SandboxEntry>();

  private environmentKey(applicationId: string, slug: string): string {
    return `${applicationId}:${slug}`;
  }

  private sandboxKey(applicationId: string, key: string): string {
    return `${applicationId}:${key}`;
  }

  async insertEnvironment(
    input: InsertEnvironmentInput,
  ): Promise<ClaimOutcome<ComputeEnvironmentRecord>> {
    const key = this.environmentKey(input.applicationId, input.slug);
    const existing = this.environments.get(key);
    if (existing !== undefined) {
      return { claimed: false, record: existing.record };
    }
    const record: ComputeEnvironmentRecord = {
      id: input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      slug: input.slug,
      name: input.name,
      description: input.description,
      kind: input.spec.kind as ComputeEnvironmentRecord["kind"],
      spec: input.spec as unknown as ComputeEnvironmentRecord["spec"],
      specDigest: input.specDigest,
      status: "available",
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    this.environments.set(key, { record });
    return { claimed: true, record };
  }

  async findEnvironmentBySlug(
    applicationId: string,
    slug: string,
  ): Promise<ComputeEnvironmentRecord | null> {
    return this.environments.get(this.environmentKey(applicationId, slug))?.record ?? null;
  }

  async findEnvironment(
    applicationId: string,
    environmentId: string,
  ): Promise<ComputeEnvironmentRecord | null> {
    for (const entry of this.environments.values()) {
      if (entry.record.applicationId === applicationId && entry.record.id === environmentId) {
        return entry.record;
      }
    }
    return null;
  }

  async listEnvironments(applicationId: string): Promise<readonly ComputeEnvironmentRecord[]> {
    return [...this.environments.values()]
      .map((entry) => entry.record)
      .filter((record) => record.applicationId === applicationId)
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.id.localeCompare(b.id)
          : a.createdAt.localeCompare(b.createdAt),
      );
  }

  async updateEnvironmentStatus(
    input: UpdateEnvironmentStatusInput,
  ): Promise<ClaimOutcome<ComputeEnvironmentRecord>> {
    for (const [key, entry] of this.environments.entries()) {
      const record = entry.record;
      if (record.applicationId === input.applicationId && record.id === input.environmentId) {
        if (record.status === input.from) {
          if (!canTransitionEnvironment(record.status, input.to)) {
            throw new PlatformError({
              code: "INVALID_STATE_TRANSITION",
              message: `compute environment cannot move from ${record.status} to ${input.to}`,
            });
          }
          const next: ComputeEnvironmentRecord = {
            ...record,
            status: input.to as EnvironmentLifecycleStatus,
            updatedAt: input.updatedAt,
          };
          this.environments.set(key, { record: next });
          return { claimed: true, record: next };
        }
        return { claimed: false, record };
      }
    }
    throw new PlatformError({
      code: "SANDBOX_ERROR",
      message: "environment status transition target not found",
    });
  }

  async insertSandbox(input: InsertSandboxInput): Promise<ClaimOutcome<SandboxExecutionRecord>> {
    const key = this.sandboxKey(input.applicationId, input.sandboxKey);
    const existing = this.sandboxes.get(key);
    if (existing !== undefined) {
      return { claimed: false, record: existing.record };
    }
    const record: SandboxExecutionRecord = {
      id: input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      executionId: input.executionId,
      sandboxKey: input.sandboxKey,
      requestFingerprint: input.requestFingerprint,
      environmentId: input.environmentId,
      kind: input.kind as SandboxExecutionRecord["kind"],
      status: input.status,
      runtimeMetadata:
        input.runtimeMetadata as unknown as SandboxExecutionRecord["runtimeMetadata"],
      denialClass: (input.denialClass as SandboxExecutionRecord["denialClass"]) ?? null,
      denialCode: (input.denialCode as SandboxExecutionRecord["denialCode"]) ?? null,
      denialReason: input.denialReason,
      outcomeClass: null,
      failureClass: null,
      failureMessage: null,
      retryable: false,
      outputDigest: null,
      output: null,
      usageMicroUsd: null,
      budgetOperationId: input.budgetOperationId,
      ledgerAdmittedSequence: null,
      ledgerCompletedSequence: null,
      createdAt: input.createdAt,
      dispatchedAt: null,
      completedAt: null,
      durationMs: null,
    };
    this.sandboxes.set(key, { record });
    return { claimed: true, record };
  }

  async findSandboxByKey(
    applicationId: string,
    sandboxKey: string,
  ): Promise<SandboxExecutionRecord | null> {
    return this.sandboxes.get(this.sandboxKey(applicationId, sandboxKey))?.record ?? null;
  }

  async findSandbox(
    applicationId: string,
    sandboxId: string,
  ): Promise<SandboxExecutionRecord | null> {
    for (const entry of this.sandboxes.values()) {
      if (entry.record.applicationId === applicationId && entry.record.id === sandboxId) {
        return entry.record;
      }
    }
    return null;
  }

  async listSandboxesByExecution(
    applicationId: string,
    executionId: string,
  ): Promise<readonly SandboxExecutionRecord[]> {
    return [...this.sandboxes.values()]
      .map((entry) => entry.record)
      .filter(
        (record) => record.applicationId === applicationId && record.executionId === executionId,
      )
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.id.localeCompare(b.id)
          : a.createdAt.localeCompare(b.createdAt),
      );
  }

  async claimDispatching(
    applicationId: string,
    sandboxKey: string,
  ): Promise<ClaimOutcome<SandboxExecutionRecord>> {
    const key = this.sandboxKey(applicationId, sandboxKey);
    const entry = this.sandboxes.get(key);
    if (entry === undefined) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "sandbox dispatch claim target not found",
      });
    }
    const record = entry.record;
    if (record.status === "admitted") {
      const next: SandboxExecutionRecord = {
        ...record,
        status: "dispatching",
        dispatchedAt: new Date().toISOString(),
      };
      this.sandboxes.set(key, { record: next });
      return { claimed: true, record: next };
    }
    return { claimed: false, record };
  }

  async bindLedgerSequence(input: BindLedgerSequenceInput): Promise<SandboxExecutionRecord> {
    const key = this.sandboxKey(input.applicationId, input.sandboxKey);
    const entry = this.sandboxes.get(key);
    if (entry === undefined) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "sandbox sequence binding target not found",
      });
    }
    const record = entry.record;
    if (isTerminalSandboxStatus(record.status)) {
      return record; // terminal rows are immutable — the committed binding stands
    }
    const next: SandboxExecutionRecord =
      input.phase === "admitted"
        ? { ...record, ledgerAdmittedSequence: input.sequence }
        : { ...record, ledgerCompletedSequence: input.sequence };
    this.sandboxes.set(key, { record: next });
    return next;
  }

  async recordOutcome(input: RecordOutcomeInput): Promise<SandboxExecutionRecord> {
    const key = this.sandboxKey(input.applicationId, input.sandboxKey);
    const entry = this.sandboxes.get(key);
    if (entry === undefined) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "sandbox outcome target not found",
      });
    }
    const record = entry.record;
    if (record.status === "dispatching" && canTransitionSandbox("dispatching", input.status)) {
      const next: SandboxExecutionRecord = {
        ...record,
        status: input.status,
        outcomeClass: input.outcomeClass as SandboxExecutionRecord["outcomeClass"],
        failureClass: (input.failureClass as SandboxExecutionRecord["failureClass"]) ?? null,
        failureMessage: input.failureMessage,
        retryable: input.retryable,
        outputDigest: input.outputDigest,
        output: input.output,
        usageMicroUsd: input.usageMicroUsd,
        ledgerCompletedSequence: input.completedLedgerSequence ?? record.ledgerCompletedSequence,
        dispatchedAt: input.dispatchedAt,
        completedAt: input.completedAt,
        durationMs: input.durationMs,
      };
      this.sandboxes.set(key, { record: next });
      return next;
    }
    // First writer already finalized: converge on the committed outcome.
    return record;
  }
}
