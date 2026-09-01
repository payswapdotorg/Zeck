/**
 * In-memory runner fleet store (sandbox module; WORK-019 unit-test
 * infrastructure — the sandbox store fakes discipline).
 *
 * A faithful in-memory realization of the `RunnerStore` port including the
 * convergence arbitration (unique (application, slug) /
 * (application, assignment_key) keys), the runner's single-active-slot
 * exclusivity, the guarded one-shot transitions, the write-once identity
 * cores and the append-only assignment evidence with per-assignment
 * sequences. True cross-connection concurrency/locking cannot be simulated
 * here — the real-PostgreSQL suites own those proofs.
 */

import { PlatformError } from "../../../shared/errors";
import { uuidv7 } from "../../../shared/ids";
import type { RunnerAssignmentRecord, RunnerRecord } from "../domain/runner";
import { canTransitionRunnerAssignment, canTransitionRunnerAuthorization } from "../domain/runner";
import type {
  AppendRunnerAssignmentEventInput,
  AuthorizeRunnerInput,
  ClaimOutcome,
  ClaimRunnerDispatchInput,
  ExpireRunnerAssignmentInput,
  InsertRunnerAssignmentInput,
  InsertRunnerInput,
  ObserveRunnerConnectionInput,
  ObserveRunnerHealthInput,
  RecordRunnerReconnectInput,
  RecordRunnerResultInput,
  ReleaseRunnerAssignmentInput,
  RevokeRunnerInput,
  RunnerAssignmentEventRecord,
  RunnerStore,
} from "../ports/runner-store";

interface RunnerEntry {
  record: RunnerRecord;
}

interface AssignmentEntry {
  record: RunnerAssignmentRecord;
}

export class InMemoryRunnerStore implements RunnerStore {
  private readonly runners = new Map<string, RunnerEntry>();
  private readonly assignments = new Map<string, AssignmentEntry>();
  private readonly events = new Map<string, RunnerAssignmentEventRecord[]>();

  private runnerBySlug(applicationId: string, slug: string): RunnerEntry | undefined {
    for (const entry of this.runners.values()) {
      if (entry.record.applicationId === applicationId && entry.record.slug === slug) {
        return entry;
      }
    }
    return undefined;
  }

  private assignmentByKey(applicationId: string, key: string): AssignmentEntry | undefined {
    for (const entry of this.assignments.values()) {
      if (entry.record.applicationId === applicationId && entry.record.assignmentKey === key) {
        return entry;
      }
    }
    return undefined;
  }

  private activeAssignmentByRunner(
    applicationId: string,
    runnerId: string,
  ): AssignmentEntry | undefined {
    for (const entry of this.assignments.values()) {
      if (
        entry.record.applicationId === applicationId &&
        entry.record.runnerId === runnerId &&
        (entry.record.status === "assigned" || entry.record.status === "dispatched")
      ) {
        return entry;
      }
    }
    return undefined;
  }

  private mustReadAssignment(applicationId: string, assignmentId: string): RunnerAssignmentRecord {
    const record = this.assignments.get(`${applicationId}:${assignmentId}`)?.record;
    if (record === undefined) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "assignment transition converged but the committed row is unreadable",
      });
    }
    return record;
  }

  // ---- runner identity -------------------------------------------------------

  async insertRunner(input: InsertRunnerInput): Promise<ClaimOutcome<RunnerRecord>> {
    const existing = this.runnerBySlug(input.applicationId, input.slug);
    if (existing !== undefined) {
      return { claimed: false, record: existing.record };
    }
    const record: RunnerRecord = {
      id: input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      environmentId: input.environmentId,
      slug: input.slug,
      name: input.name,
      runnerVersion: input.runnerVersion,
      declaredCapabilities: [...input.declaredCapabilities],
      tokenFingerprint: input.tokenFingerprint,
      provenance: input.provenance as unknown as RunnerRecord["provenance"],
      authorizationStatus: "untrusted",
      authorizedAt: null,
      authorizedByActorId: null,
      revokedAt: null,
      revocationReason: null,
      healthStatus: "unknown",
      lastHeartbeatAt: null,
      connectionStatus: "offline",
      lastConnectedAt: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    this.runners.set(`${input.applicationId}:${input.id}`, { record });
    return { claimed: true, record };
  }

  async findRunner(applicationId: string, runnerId: string): Promise<RunnerRecord | null> {
    return this.runners.get(`${applicationId}:${runnerId}`)?.record ?? null;
  }

  async findRunnerBySlug(applicationId: string, slug: string): Promise<RunnerRecord | null> {
    return this.runnerBySlug(applicationId, slug)?.record ?? null;
  }

  async listRunners(applicationId: string): Promise<readonly RunnerRecord[]> {
    return [...this.runners.values()]
      .map((entry) => entry.record)
      .filter((record) => record.applicationId === applicationId)
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.id.localeCompare(b.id)
          : a.createdAt.localeCompare(b.createdAt),
      );
  }

  private updateRunner(
    applicationId: string,
    runnerId: string,
    mutate: (record: RunnerRecord) => RunnerRecord,
    guard: (record: RunnerRecord) => boolean,
  ): ClaimOutcome<RunnerRecord> {
    const key = `${applicationId}:${runnerId}`;
    const entry = this.runners.get(key);
    if (entry === undefined) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "runner transition converged but the committed row is unreadable",
      });
    }
    if (!guard(entry.record)) {
      return { claimed: false, record: entry.record };
    }
    entry.record = mutate(entry.record);
    return { claimed: true, record: entry.record };
  }

  async authorizeRunner(input: AuthorizeRunnerInput): Promise<ClaimOutcome<RunnerRecord>> {
    return this.updateRunner(
      input.applicationId,
      input.runnerId,
      (record) => ({
        ...record,
        authorizationStatus: "authorized",
        authorizedAt: input.authorizedAt,
        authorizedByActorId: input.actorId,
        updatedAt: input.authorizedAt,
      }),
      (record) => record.authorizationStatus === "untrusted",
    );
  }

  async revokeRunner(input: RevokeRunnerInput): Promise<ClaimOutcome<RunnerRecord>> {
    return this.updateRunner(
      input.applicationId,
      input.runnerId,
      (record) => ({
        ...record,
        authorizationStatus: "revoked",
        authorizedAt: null,
        authorizedByActorId: null,
        revokedAt: input.revokedAt,
        revocationReason: input.reason,
        updatedAt: input.revokedAt,
      }),
      (record) => canTransitionRunnerAuthorization(record.authorizationStatus, "revoked"),
    );
  }

  async observeRunnerHealth(input: ObserveRunnerHealthInput): Promise<RunnerRecord> {
    const entry = this.runners.get(`${input.applicationId}:${input.runnerId}`);
    if (entry === undefined) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "runner heartbeat converged but the committed row is unreadable",
      });
    }
    if (entry.record.authorizationStatus !== "revoked") {
      entry.record = {
        ...entry.record,
        healthStatus: input.health,
        lastHeartbeatAt: input.heartbeatAt,
        updatedAt: input.heartbeatAt,
      };
    }
    return entry.record;
  }

  async observeRunnerConnection(input: ObserveRunnerConnectionInput): Promise<RunnerRecord> {
    const entry = this.runners.get(`${input.applicationId}:${input.runnerId}`);
    if (entry === undefined) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "runner connection observation converged but the committed row is unreadable",
      });
    }
    if (entry.record.authorizationStatus !== "revoked") {
      entry.record = {
        ...entry.record,
        connectionStatus: input.connection,
        lastConnectedAt:
          input.connection === "connected" ? input.observedAt : entry.record.lastConnectedAt,
        updatedAt: input.observedAt,
      };
    }
    return entry.record;
  }

  // ---- assignment journal ------------------------------------------------------

  async insertRunnerAssignment(
    input: InsertRunnerAssignmentInput,
  ): Promise<ClaimOutcome<RunnerAssignmentRecord | null>> {
    const existing = this.assignmentByKey(input.applicationId, input.assignmentKey);
    if (existing !== undefined) {
      return { claimed: false, record: existing.record };
    }
    const runner = this.runners.get(`${input.applicationId}:${input.runnerId}`)?.record;
    if (
      runner === undefined ||
      runner.authorizationStatus !== "authorized" ||
      runner.healthStatus !== "healthy" ||
      runner.lastHeartbeatAt === null ||
      Date.parse(runner.lastHeartbeatAt) < Date.parse(input.heartbeatCutoff)
    ) {
      return { claimed: false, record: null };
    }
    if (this.activeAssignmentByRunner(input.applicationId, input.runnerId) !== undefined) {
      return { claimed: false, record: null };
    }
    const record: RunnerAssignmentRecord = {
      id: input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      executionId: input.executionId,
      sandboxId: input.sandboxId,
      environmentId: input.environmentId,
      runnerId: input.runnerId,
      assignmentKey: input.assignmentKey,
      requestFingerprint: input.requestFingerprint,
      status: "assigned",
      requiredCapabilities: [...input.requiredCapabilities],
      lease: { ...input.lease },
      dispatchedAt: null,
      handoffNonce: null,
      reportedAt: null,
      outcomeClass: null,
      failureClass: null,
      outputDigest: null,
      usageMicroUsd: null,
      provenance: input.provenance,
      reconnectCount: 0,
      releasedReason: null,
      releasedAt: null,
      expiredAt: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    this.assignments.set(`${input.applicationId}:${input.id}`, { record });
    return { claimed: true, record };
  }

  async findRunnerAssignment(
    applicationId: string,
    assignmentId: string,
  ): Promise<RunnerAssignmentRecord | null> {
    return this.assignments.get(`${applicationId}:${assignmentId}`)?.record ?? null;
  }

  async findRunnerAssignmentByKey(
    applicationId: string,
    assignmentKey: string,
  ): Promise<RunnerAssignmentRecord | null> {
    return this.assignmentByKey(applicationId, assignmentKey)?.record ?? null;
  }

  async findActiveAssignmentByRunner(
    applicationId: string,
    runnerId: string,
  ): Promise<RunnerAssignmentRecord | null> {
    return this.activeAssignmentByRunner(applicationId, runnerId)?.record ?? null;
  }

  async listRunnerAssignmentsBySandbox(
    applicationId: string,
    sandboxId: string,
  ): Promise<readonly RunnerAssignmentRecord[]> {
    return [...this.assignments.values()]
      .map((entry) => entry.record)
      .filter((record) => record.applicationId === applicationId && record.sandboxId === sandboxId)
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.id.localeCompare(b.id)
          : a.createdAt.localeCompare(b.createdAt),
      );
  }

  async listRunnerAssignmentsByExecution(
    applicationId: string,
    executionId: string,
  ): Promise<readonly RunnerAssignmentRecord[]> {
    return [...this.assignments.values()]
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

  private updateAssignment(
    applicationId: string,
    assignmentId: string,
    mutate: (record: RunnerAssignmentRecord) => RunnerAssignmentRecord,
    guard: (record: RunnerAssignmentRecord) => boolean,
  ): ClaimOutcome<RunnerAssignmentRecord> {
    const key = `${applicationId}:${assignmentId}`;
    const entry = this.assignments.get(key);
    if (entry === undefined) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "assignment transition converged but the committed row is unreadable",
      });
    }
    if (!guard(entry.record)) {
      return { claimed: false, record: entry.record }; // first writer wins — converge on the committed row
    }
    entry.record = mutate(entry.record);
    return { claimed: true, record: entry.record };
  }

  async claimRunnerDispatch(
    input: ClaimRunnerDispatchInput,
  ): Promise<ClaimOutcome<RunnerAssignmentRecord>> {
    const current = this.mustReadAssignment(input.applicationId, input.assignmentId);
    if (current.status !== "assigned") {
      return { claimed: false, record: current };
    }
    const record = this.updateAssignment(
      input.applicationId,
      input.assignmentId,
      (row) => ({
        ...row,
        status: "dispatched",
        dispatchedAt: input.dispatchedAt,
        handoffNonce: input.handoffNonce,
        updatedAt: input.dispatchedAt,
      }),
      () => true,
    );
    return { claimed: true, record: record.record };
  }

  async recordRunnerResult(
    input: RecordRunnerResultInput,
  ): Promise<ClaimOutcome<RunnerAssignmentRecord>> {
    return this.updateAssignment(
      input.applicationId,
      input.assignmentId,
      (row) => ({
        ...row,
        status: input.status,
        outcomeClass: input.report.outcomeClass,
        failureClass: input.report.failure === null ? null : input.report.failure.failureClass,
        outputDigest: input.report.outputDigest,
        usageMicroUsd: input.report.usageMicroUsd,
        reportedAt: input.reportedAt,
        updatedAt: input.reportedAt,
      }),
      (row) => row.status === "dispatched",
    );
  }

  async releaseRunnerAssignment(
    input: ReleaseRunnerAssignmentInput,
  ): Promise<ClaimOutcome<RunnerAssignmentRecord>> {
    return this.updateAssignment(
      input.applicationId,
      input.assignmentId,
      (row) => ({
        ...row,
        status: "released",
        releasedReason: input.reason,
        releasedAt: input.releasedAt,
        updatedAt: input.releasedAt,
      }),
      (row) => row.status === input.from && canTransitionRunnerAssignment(row.status, "released"),
    );
  }

  async expireRunnerAssignment(
    input: ExpireRunnerAssignmentInput,
  ): Promise<ClaimOutcome<RunnerAssignmentRecord>> {
    return this.updateAssignment(
      input.applicationId,
      input.assignmentId,
      (row) => ({
        ...row,
        status: "expired",
        expiredAt: input.expiredAt,
        updatedAt: input.expiredAt,
      }),
      (row) =>
        (row.status === "assigned" || row.status === "dispatched") &&
        Date.parse(row.lease.leaseExpiresAt) < Date.parse(input.expiredAt),
    );
  }

  async recordRunnerReconnect(
    input: RecordRunnerReconnectInput,
  ): Promise<ClaimOutcome<RunnerAssignmentRecord>> {
    return this.updateAssignment(
      input.applicationId,
      input.assignmentId,
      (row) => ({
        ...row,
        reconnectCount: row.reconnectCount + 1,
        updatedAt: input.reconnectedAt,
      }),
      (row) => row.status === "dispatched",
    );
  }

  // ---- append-only evidence ------------------------------------------------------

  async appendRunnerAssignmentEvent(input: AppendRunnerAssignmentEventInput): Promise<void> {
    const key = `${input.applicationId}:${input.assignmentId}`;
    const trail = this.events.get(key) ?? [];
    const sequence = trail.length === 0 ? 1 : (trail[trail.length - 1]?.sequence ?? 0) + 1;
    trail.push({
      id: uuidv7(),
      applicationId: input.applicationId,
      assignmentId: input.assignmentId,
      runnerId: input.runnerId,
      executionId: input.executionId,
      sequence,
      event: input.event,
      actorId: input.actorId,
      cause: input.cause,
      detail: input.detail,
      occurredAt: input.occurredAt,
    });
    this.events.set(key, trail);
  }

  async listRunnerAssignmentEvents(
    applicationId: string,
    assignmentId: string,
  ): Promise<readonly RunnerAssignmentEventRecord[]> {
    return [...(this.events.get(`${applicationId}:${assignmentId}`) ?? [])];
  }
}
