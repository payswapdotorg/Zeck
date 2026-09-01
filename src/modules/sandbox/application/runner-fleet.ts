/**
 * Runner fleet service (sandbox module application; WORK-019, ENV-003).
 *
 * THE governed lifecycle for customer-controlled runners: registration →
 * explicit authorization → health observation → assignment (idempotent,
 * exclusive, health-guarded) → dispatch handoff → remote execution →
 * disconnect → reconnect → result report → release/expiry → revocation.
 *
 * The fleet is an execution SUBSTRATE, never a second authority and never
 * a second execution system (the WORK-012 discipline, restated):
 *
 *   - the canonical chain stays Execution → Policy → Capability → Budget →
 *     Sandbox/ComputeEnvironment → Runner → Verification → Evidence: a
 *     runner assignment anchors an ALREADY-ADMITTED `SandboxExecution`
 *     (policy/capability/budget admission happened in the sandbox service
 *     BEFORE the dispatch the assignment rides) and its parent execution
 *     identity (composite FKs — a runner can never fabricate or fork one);
 *   - no executions-module surface is imported: the fleet holds no
 *     transition/creation call and no execution status vocabulary — the
 *     runner axis is assignment bookkeeping ONLY;
 *   - a reconnect NEVER creates a second logical execution: it re-binds
 *     the runner to its EXISTING active assignment (count + trail only);
 *   - external identity is never authorization: the registration token
 *     (hashed fingerprint) proves channel continuity at reconnect, while
 *     WHAT a runner may do is the explicit authorization state;
 *   - every rejection is typed (`spec/contracts.md` taxonomy): tenant and
 *     application scope, environment mismatch, authorization, capability
 *     mismatch and health are all rejected BEFORE assignment.
 *
 * Crash safety (`spec/contracts.md` idempotency rule): the assignment row
 * keyed by (application, assignment key) IS the durable outcome. Same key
 * + same fingerprint replays; different fingerprint fails
 * `IDEMPOTENCY_KEY_REUSED`; concurrent duplicates converge on the
 * committed row through unique-index arbitration. A crash between the
 * dispatch claim and the report leaves the honest `dispatched` row: the
 * lease deadline is the reconciliation bound and expiry is terminal
 * (fail-closed, never silently re-executed).
 */

import { PlatformError } from "../../../shared/errors";
import { isUuid } from "../../../shared/ids";
import type {
  RunnerAssignmentRecord,
  RunnerHandoff,
  RunnerRecord,
  RunnerResultReport,
} from "../domain/runner";
import {
  isRunnerHealthyForAssignment,
  RUNNER_ASSIGNMENT_KEY_PATTERN,
  RUNNER_TOKEN_PATTERN,
  runnerAssignmentFingerprint,
  runnerRegistrationFingerprint,
  runnerSupportsRequirements,
  validateRunnerCapabilities,
  validateRunnerLease,
  validateRunnerRegistration,
  validateRunnerResultReport,
} from "../domain/runner";
import type {
  RunnerAssignmentEventName,
  RunnerAssignmentEventRecord,
  RunnerStore,
} from "../ports/runner-store";
import type { SandboxStore } from "../ports/sandbox-store";

export interface RunnerFleetActor {
  readonly actorId: string;
  readonly applicationId: string;
  readonly tenantId: string;
}

export interface RunnerFleetDeps {
  readonly store: RunnerStore;
  /** The sandbox module's own store: the admitted-parent sandbox row. */
  readonly sandboxStore: SandboxStore;
  readonly generateId: () => string;
  readonly now: () => Date;
  /** Heartbeat freshness window (ms): older heartbeats are unassignable (M20). */
  readonly heartbeatWindowMs: number;
  /** Lease duration (ms) used when the assignment request carries none. */
  readonly leaseDurationMs: number;
  /** One-way digest of registration tokens (stored hashed, never raw). */
  readonly hashToken: (token: string) => string;
}

export interface RunnerFleetService {
  registerRunner(
    input: {
      readonly applicationId: string;
      readonly tenantId: string;
      readonly environmentId: string;
      readonly slug: string;
      readonly name: string;
      readonly runnerVersion: string;
      readonly declaredCapabilities: readonly string[];
      readonly registrationToken: string;
    },
    idempotencyKey: string,
    actor: RunnerFleetActor,
  ): Promise<RunnerRecord>;
  authorizeRunner(
    input: { readonly applicationId: string; readonly runnerId: string },
    idempotencyKey: string,
    actor: RunnerFleetActor,
  ): Promise<RunnerRecord>;
  revokeRunner(
    input: { readonly applicationId: string; readonly runnerId: string; readonly reason: string },
    idempotencyKey: string,
    actor: RunnerFleetActor,
  ): Promise<RunnerRecord>;
  observeHeartbeat(
    input: {
      readonly applicationId: string;
      readonly runnerId: string;
      readonly health?: "healthy" | "degraded" | "unhealthy";
    },
    actor: RunnerFleetActor,
  ): Promise<RunnerRecord>;
  markDisconnected(
    input: { readonly applicationId: string; readonly runnerId: string },
    actor: RunnerFleetActor,
  ): Promise<RunnerRecord>;
  /**
   * Reconnect a runner (identity-proof by registration-token fingerprint;
   * re-binds to the EXISTING active assignment — never a new one, never a
   * second logical execution).
   */
  reconnectRunner(
    input: {
      readonly applicationId: string;
      readonly runnerId: string;
      readonly registrationToken: string;
    },
    actor: RunnerFleetActor,
  ): Promise<{ readonly runner: RunnerRecord; readonly assignment: RunnerAssignmentRecord | null }>;
  /** Deterministic eligible-runner selection (first registered wins). */
  selectEligibleRunner(input: {
    readonly applicationId: string;
    readonly environmentId: string;
    readonly requiredCapabilities: readonly string[];
  }): Promise<RunnerRecord | null>;
  /** THE guarded assignment (idempotent, exclusive, health- and trust-gated). */
  assignRunner(
    input: {
      readonly applicationId: string;
      readonly executionId: string;
      readonly sandboxId: string;
      readonly environmentId: string;
      readonly runnerId: string;
      readonly requiredCapabilities: readonly string[];
      readonly leaseDurationMs?: number;
    },
    assignmentKey: string,
    actor: RunnerFleetActor,
  ): Promise<RunnerAssignmentRecord>;
  /** The one-shot dispatch claim producing the remote execution handoff. */
  dispatchAssignment(
    input: { readonly applicationId: string; readonly assignmentId: string },
    actor: RunnerFleetActor,
  ): Promise<RunnerHandoff>;
  /** The one-shot result report (authorization- and lease-bounded). */
  reportResult(
    input: {
      readonly applicationId: string;
      readonly assignmentId: string;
      readonly report: RunnerResultReport;
    },
    actor: RunnerFleetActor,
  ): Promise<RunnerAssignmentRecord>;
  releaseAssignment(
    input: {
      readonly applicationId: string;
      readonly assignmentId: string;
      readonly reason: string;
    },
    actor: RunnerFleetActor,
  ): Promise<RunnerAssignmentRecord>;
  /** Lease-deadline reconciliation: assigned/dispatched → expired. */
  expireAssignment(
    input: { readonly applicationId: string; readonly assignmentId: string },
    actor: RunnerFleetActor,
  ): Promise<RunnerAssignmentRecord>;
  getRunner(applicationId: string, runnerId: string): Promise<RunnerRecord | null>;
  listRunners(applicationId: string): Promise<readonly RunnerRecord[]>;
  getAssignment(
    applicationId: string,
    assignmentId: string,
  ): Promise<RunnerAssignmentRecord | null>;
  getAssignmentByKey(
    applicationId: string,
    assignmentKey: string,
  ): Promise<RunnerAssignmentRecord | null>;
  listAssignmentsBySandbox(
    applicationId: string,
    sandboxId: string,
  ): Promise<readonly RunnerAssignmentRecord[]>;
  listAssignmentsByExecution(
    applicationId: string,
    executionId: string,
  ): Promise<readonly RunnerAssignmentRecord[]>;
  listAssignmentEvents(
    applicationId: string,
    assignmentId: string,
  ): Promise<readonly RunnerAssignmentEventRecord[]>;
}

export function createRunnerFleetService(deps: RunnerFleetDeps): RunnerFleetService {
  const { store, sandboxStore, generateId, now, hashToken } = deps;
  const iso = () => now().toISOString();
  const nowMs = () => now().getTime();

  const requireActor = (actor: RunnerFleetActor, applicationId: string): void => {
    if (
      !isUuid(actor?.actorId) ||
      !isUuid(actor?.tenantId) ||
      actor.applicationId !== applicationId
    ) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "runner fleet operations require a server-derived actor scope",
      });
    }
  };

  const appendEvent = (
    record: RunnerAssignmentRecord,
    event: RunnerAssignmentEventName,
    detail: Readonly<Record<string, unknown>>,
    actorId: string,
    cause: string,
  ): Promise<void> =>
    store.appendRunnerAssignmentEvent({
      applicationId: record.applicationId,
      assignmentId: record.id,
      runnerId: record.runnerId,
      executionId: record.executionId,
      event,
      actorId,
      cause,
      detail,
      occurredAt: iso(),
    });

  const requireRunner = async (
    applicationId: string,
    runnerId: string,
    tenantId: string,
  ): Promise<RunnerRecord> => {
    const runner = await store.findRunner(applicationId, runnerId);
    if (runner === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message:
          "runner not found in this application (unregistered or owned by another application)",
        details: { runnerId },
      });
    }
    if (runner.tenantId !== tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "runner belongs to a different tenant",
        details: { runnerId },
      });
    }
    return runner;
  };

  const requireAssignment = async (
    applicationId: string,
    assignmentId: string,
    tenantId: string,
  ): Promise<RunnerAssignmentRecord> => {
    const record = await store.findRunnerAssignment(applicationId, assignmentId);
    if (record === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message:
          "assignment not found in this application (missing or owned by another application)",
        details: { assignmentId },
      });
    }
    if (record.tenantId !== tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "assignment belongs to a different tenant",
        details: { assignmentId },
      });
    }
    return record;
  };

  // -------------------------------------------------------------------------
  // Registration → authorization → revocation
  // -------------------------------------------------------------------------

  const registerRunner: RunnerFleetService["registerRunner"] = async (
    input,
    idempotencyKey,
    actor,
  ) => {
    void idempotencyKey; // registration identity is anchored by (application, slug)
    requireActor(actor, input.applicationId);
    const tokenFingerprint = hashToken(input.registrationToken);
    const check = validateRunnerRegistration({
      ...input,
      provenance: {
        actorId: actor.actorId,
        cause: "runner-registration",
        channel: "runner-fleet",
        registeredAt: iso(),
      },
    });
    if (!check.valid) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: `invalid runner registration: ${check.reason}`,
      });
    }
    if (!isUuid(input.environmentId)) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "runner registration requires a valid environmentId",
      });
    }
    // Scope guard: the environment must exist in THIS application + tenant.
    const environment = await sandboxStore.findEnvironment(
      actor.applicationId,
      input.environmentId,
    );
    if (environment === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message:
          "compute environment not found in this application (missing or owned by another application)",
        details: { environmentId: input.environmentId },
      });
    }
    if (environment.tenantId !== actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "compute environment belongs to a different tenant",
        details: { environmentId: environment.id },
      });
    }
    if (environment.kind !== "customer-runner") {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: `runners can only register against customer-runner environments (environment kind: ${environment.kind})`,
        details: { environmentId: environment.id, kind: environment.kind },
      });
    }

    const existing = await store.findRunnerBySlug(actor.applicationId, input.slug);
    if (existing !== null) {
      // Content-addressed convergence: the identical identity core converges
      // on the durable record; a DIFFERENT core under the same slug is an
      // identity conflict — registration is write-once.
      const existingFingerprint = runnerRegistrationFingerprint(
        {
          applicationId: existing.applicationId,
          tenantId: existing.tenantId,
          environmentId: existing.environmentId,
          slug: existing.slug,
          name: existing.name,
          runnerVersion: existing.runnerVersion,
          declaredCapabilities: [...existing.declaredCapabilities],
          provenance: existing.provenance,
        },
        existing.tokenFingerprint,
      );
      const nextFingerprint = runnerRegistrationFingerprint(
        {
          ...input,
          provenance: {
            actorId: actor.actorId,
            cause: "runner-registration",
            channel: "runner-fleet",
            registeredAt: iso(),
          },
        },
        tokenFingerprint,
      );
      if (existingFingerprint !== nextFingerprint) {
        throw new PlatformError({
          code: "SANDBOX_ERROR",
          message:
            "runner slug is already registered with a different identity core; runner registration is write-once (register a new slug)",
          details: { slug: input.slug },
        });
      }
      return existing;
    }

    const claim = await store.insertRunner({
      id: generateId(),
      applicationId: actor.applicationId,
      tenantId: actor.tenantId,
      environmentId: input.environmentId,
      slug: input.slug,
      name: input.name,
      runnerVersion: input.runnerVersion,
      declaredCapabilities: [...input.declaredCapabilities],
      tokenFingerprint,
      provenance: {
        actorId: actor.actorId,
        cause: "runner-registration",
        channel: "runner-fleet",
        registeredAt: iso(),
      },
      createdAt: iso(),
    });
    return claim.record;
  };

  const authorizeRunner: RunnerFleetService["authorizeRunner"] = async (
    input,
    idempotencyKey,
    actor,
  ) => {
    void idempotencyKey;
    requireActor(actor, input.applicationId);
    const runner = await requireRunner(input.applicationId, input.runnerId, actor.tenantId);
    if (runner.authorizationStatus === "authorized") {
      return runner; // idempotent re-grant
    }
    const claim = await store.authorizeRunner({
      applicationId: input.applicationId,
      runnerId: input.runnerId,
      actorId: actor.actorId,
      authorizedAt: iso(),
    });
    if (!claim.claimed) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `runner cannot be authorized from state ${claim.record.authorizationStatus} (a revoked runner is never re-authorized; register a new runner)`,
        details: { runnerId: claim.record.id, status: claim.record.authorizationStatus },
      });
    }
    return claim.record;
  };

  const revokeRunner: RunnerFleetService["revokeRunner"] = async (input, idempotencyKey, actor) => {
    void idempotencyKey;
    requireActor(actor, input.applicationId);
    const runner = await requireRunner(input.applicationId, input.runnerId, actor.tenantId);
    if (runner.authorizationStatus === "revoked") {
      return runner; // idempotent
    }
    const claim = await store.revokeRunner({
      applicationId: input.applicationId,
      runnerId: input.runnerId,
      reason: input.reason,
      revokedAt: iso(),
    });
    if (!claim.claimed) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `runner cannot be revoked from state ${claim.record.authorizationStatus}`,
        details: { runnerId: claim.record.id, status: claim.record.authorizationStatus },
      });
    }
    // Any ACTIVE assignment of a revoked runner is released (fail-closed:
    // the runner can no longer dispatch or report).
    const active = await store.findActiveAssignmentByRunner(input.applicationId, input.runnerId);
    if (active !== null) {
      const release = await store.releaseRunnerAssignment({
        applicationId: active.applicationId,
        assignmentId: active.id,
        from: active.status as "assigned" | "dispatched",
        reason: `runner revoked: ${input.reason}`,
        releasedAt: iso(),
      });
      // Only the WINNING release journals the event — a concurrent
      // finalization (report/expiry) owns the committed terminal state.
      if (release.claimed) {
        await appendEvent(
          release.record,
          "released",
          { reason: `runner revoked: ${input.reason}`, revocation: input.reason },
          actor.actorId,
          "runner-revocation",
        );
      }
    }
    return claim.record;
  };

  // -------------------------------------------------------------------------
  // Health + connection observation
  // -------------------------------------------------------------------------

  const observeHeartbeat: RunnerFleetService["observeHeartbeat"] = async (input, actor) => {
    requireActor(actor, input.applicationId);
    const runner = await requireRunner(input.applicationId, input.runnerId, actor.tenantId);
    void runner;
    return store.observeRunnerHealth({
      applicationId: input.applicationId,
      runnerId: input.runnerId,
      health: input.health ?? "healthy",
      heartbeatAt: iso(),
    });
  };

  const markDisconnected: RunnerFleetService["markDisconnected"] = async (input, actor) => {
    requireActor(actor, input.applicationId);
    await requireRunner(input.applicationId, input.runnerId, actor.tenantId);
    return store.observeRunnerConnection({
      applicationId: input.applicationId,
      runnerId: input.runnerId,
      connection: "disconnected",
      observedAt: iso(),
    });
  };

  const reconnectRunner: RunnerFleetService["reconnectRunner"] = async (input, actor) => {
    requireActor(actor, input.applicationId);
    const runner = await requireRunner(input.applicationId, input.runnerId, actor.tenantId);
    if (!RUNNER_TOKEN_PATTERN.test(input.registrationToken)) {
      throw new PlatformError({
        code: "AUTHORIZATION_DENIED",
        message:
          "reconnect requires the runner's registration token (external identifiers are not authorization)",
        details: { runnerId: runner.id },
      });
    }
    if (hashToken(input.registrationToken) !== runner.tokenFingerprint) {
      throw new PlatformError({
        code: "AUTHORIZATION_DENIED",
        message:
          "registration token does not match this runner's identity fingerprint; reconnect is refused (external identifiers are not authorization)",
        details: { runnerId: runner.id },
      });
    }
    if (runner.authorizationStatus === "revoked") {
      throw new PlatformError({
        code: "AUTHORIZATION_DENIED",
        message: "a revoked runner cannot reconnect",
        details: { runnerId: runner.id },
      });
    }
    const reconnected = await store.observeRunnerConnection({
      applicationId: input.applicationId,
      runnerId: input.runnerId,
      connection: "connected",
      observedAt: iso(),
    });
    // Reconnect re-binds to the EXISTING dispatched assignment — never a new
    // one, never a second logical execution (M11).
    const active = await store.findActiveAssignmentByRunner(input.applicationId, input.runnerId);
    if (active === null) {
      return { runner: reconnected, assignment: null };
    }
    if (active.status !== "dispatched") {
      return { runner: reconnected, assignment: active };
    }
    const assignment = await store.recordRunnerReconnect({
      applicationId: active.applicationId,
      assignmentId: active.id,
      reconnectedAt: iso(),
    });
    // Only the WINNING re-bind journals the event (a concurrent terminal
    // transition converged first — the committed record replays).
    if (assignment.claimed) {
      await appendEvent(
        assignment.record,
        "reconnected",
        { reconnectCount: assignment.record.reconnectCount },
        runner.id,
        "runner-reconnect",
      );
    }
    return { runner: reconnected, assignment: assignment.record };
  };

  // -------------------------------------------------------------------------
  // Eligibility + assignment (the guarded fleet core)
  // -------------------------------------------------------------------------

  const isEligible = (
    runner: RunnerRecord,
    environmentId: string,
    required: readonly string[],
  ): boolean =>
    runner.environmentId === environmentId &&
    runner.authorizationStatus === "authorized" &&
    isRunnerHealthyForAssignment(runner, nowMs(), deps.heartbeatWindowMs) &&
    runnerSupportsRequirements(runner.declaredCapabilities, required);

  const selectEligibleRunner: RunnerFleetService["selectEligibleRunner"] = async (input) => {
    const merged = [...new Set([...input.requiredCapabilities, "customer-runner"])];
    const capabilityCheck = validateRunnerCapabilities(merged);
    if (!capabilityCheck.valid) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: `invalid capability requirements: ${capabilityCheck.reason}`,
      });
    }
    const runners = await store.listRunners(input.applicationId);
    const candidates = runners
      .filter((runner) => isEligible(runner, input.environmentId, input.requiredCapabilities))
      .sort((a, b) =>
        a.createdAt === b.createdAt
          ? a.id.localeCompare(b.id)
          : a.createdAt.localeCompare(b.createdAt),
      );
    for (const candidate of candidates) {
      const active = await store.findActiveAssignmentByRunner(input.applicationId, candidate.id);
      if (active === null) {
        return candidate;
      }
    }
    return null;
  };

  const assignRunner: RunnerFleetService["assignRunner"] = async (input, assignmentKey, actor) => {
    requireActor(actor, input.applicationId);
    if (typeof assignmentKey !== "string" || !RUNNER_ASSIGNMENT_KEY_PATTERN.test(assignmentKey)) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "runner assignment requires a non-empty printable assignment key (max 200 chars)",
      });
    }
    const requiredCapabilities = [...input.requiredCapabilities];
    const capabilityCheck = validateRunnerCapabilities(requiredCapabilities);
    if (!capabilityCheck.valid) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: `invalid required capabilities: ${capabilityCheck.reason}`,
      });
    }
    if (!isUuid(input.executionId) || !isUuid(input.sandboxId) || !isUuid(input.environmentId)) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "runner assignment requires valid executionId, sandboxId and environmentId",
      });
    }

    const fingerprint = runnerAssignmentFingerprint(actor.applicationId, {
      executionId: input.executionId,
      sandboxId: input.sandboxId,
      environmentId: input.environmentId,
      requiredCapabilities,
    });

    // ----- 1. Idempotent replay fast path. ---------------------------------
    const existing = await store.findRunnerAssignmentByKey(actor.applicationId, assignmentKey);
    if (existing !== null) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "assignment key was already used with a different request fingerprint",
          details: { assignmentId: existing.id, runnerId: existing.runnerId },
        });
      }
      return existing;
    }

    // ----- 2. Identity chain validation (BEFORE any write). ----------------
    const sandbox = await sandboxStore.findSandbox(actor.applicationId, input.sandboxId);
    if (sandbox === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message:
          "sandbox execution not found in this application (missing or owned by another application)",
        details: { sandboxId: input.sandboxId },
      });
    }
    if (sandbox.tenantId !== actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "sandbox execution belongs to a different tenant",
        details: { sandboxId: sandbox.id },
      });
    }
    if (sandbox.executionId !== input.executionId) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "assignment execution identity does not match the parent sandbox execution",
        details: { sandboxId: sandbox.id, executionId: input.executionId },
      });
    }
    if (sandbox.environmentId !== input.environmentId) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message:
          "assignment environment does not match the sandbox's compute environment (environment mismatch)",
        details: { sandboxId: sandbox.id, environmentId: input.environmentId },
      });
    }
    if (sandbox.status !== "dispatching") {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: `runner assignment anchors a dispatched sandbox execution (sandbox status: ${sandbox.status}; the enclosing sandbox service claims the dispatch intent)`,
        details: { sandboxId: sandbox.id, status: sandbox.status },
      });
    }
    const environment = await sandboxStore.findEnvironment(
      actor.applicationId,
      input.environmentId,
    );
    if (environment === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message:
          "compute environment not found in this application (missing or owned by another application)",
        details: { environmentId: input.environmentId },
      });
    }
    if (environment.tenantId !== actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "compute environment belongs to a different tenant",
        details: { environmentId: environment.id },
      });
    }
    if (environment.kind !== "customer-runner") {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: `the runner fleet serves customer-runner environments only (environment kind: ${environment.kind})`,
        details: { environmentId: environment.id, kind: environment.kind },
      });
    }
    if (environment.status !== "available") {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: `compute environment is not available for assignment (status: ${environment.status})`,
        details: { environmentId: environment.id, status: environment.status },
      });
    }

    // ----- 3. Runner trust/health/capability gates (typed rejections). -----
    const runner = await store.findRunner(actor.applicationId, input.runnerId);
    if (runner === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message:
          "runner not found in this application (unregistered or owned by another application)",
        details: { runnerId: input.runnerId },
      });
    }
    if (runner.tenantId !== actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "runner belongs to a different tenant",
        details: { runnerId: runner.id },
      });
    }
    if (runner.environmentId !== input.environmentId) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "runner is not registered for this compute environment (environment mismatch)",
        details: { runnerId: runner.id, environmentId: input.environmentId },
      });
    }
    if (runner.authorizationStatus !== "authorized") {
      throw new PlatformError({
        code: "AUTHORIZATION_DENIED",
        message: `runner is not authorized to accept assignments (authorization: ${runner.authorizationStatus}; registration is never trust)`,
        details: { runnerId: runner.id, authorizationStatus: runner.authorizationStatus },
      });
    }
    if (!isRunnerHealthyForAssignment(runner, nowMs(), deps.heartbeatWindowMs)) {
      throw new PlatformError({
        code: "NO_ELIGIBLE_ROUTE",
        message: `runner is not health-eligible (health: ${runner.healthStatus}; heartbeat older than the freshness window)`,
        details: { runnerId: runner.id, healthStatus: runner.healthStatus },
        retryable: true,
      });
    }
    if (!runnerSupportsRequirements(runner.declaredCapabilities, requiredCapabilities)) {
      throw new PlatformError({
        code: "CAPABILITY_UNAVAILABLE",
        message: "runner does not declare every required capability (capability mismatch)",
        details: {
          runnerId: runner.id,
          required: requiredCapabilities,
          declared: [...runner.declaredCapabilities],
        },
      });
    }
    const busy = await store.findActiveAssignmentByRunner(actor.applicationId, input.runnerId);
    if (busy !== null) {
      if (busy.assignmentKey === assignmentKey) {
        // The runner's active slot IS this logical assignment (a concurrent
        // duplicate of THIS key won the insert): replay the converged row —
        // the same key + request NEVER mints a second logical assignment.
        if (busy.requestFingerprint !== fingerprint) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "assignment key was already used with a different request fingerprint",
            details: { assignmentId: busy.id, runnerId: busy.runnerId },
          });
        }
        return busy;
      }
      throw new PlatformError({
        code: "NO_ELIGIBLE_ROUTE",
        message: "runner already holds an active assignment (one active assignment per runner)",
        details: { runnerId: input.runnerId, activeAssignmentId: busy.id },
        retryable: true,
      });
    }

    // ----- 4. Durable, guarded, exclusive assignment. -----------------------
    const leaseDurationMs = input.leaseDurationMs ?? deps.leaseDurationMs;
    const leasedAt = iso();
    const lease = {
      leasedAt,
      leaseDurationMs,
      leaseExpiresAt: new Date(now().getTime() + leaseDurationMs).toISOString(),
    };
    const leaseCheck = validateRunnerLease(lease);
    if (!leaseCheck.valid) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: `invalid lease: ${leaseCheck.reason}`,
      });
    }
    const heartbeatCutoff = new Date(nowMs() - deps.heartbeatWindowMs).toISOString();
    const claim = await store.insertRunnerAssignment({
      id: generateId(),
      applicationId: actor.applicationId,
      tenantId: actor.tenantId,
      executionId: input.executionId,
      sandboxId: input.sandboxId,
      environmentId: input.environmentId,
      runnerId: input.runnerId,
      assignmentKey,
      requestFingerprint: fingerprint,
      requiredCapabilities,
      lease,
      provenance: {
        executionId: input.executionId,
        sandboxId: input.sandboxId,
        environmentId: input.environmentId,
        sandboxLedgerAdmittedSequence: sandbox.ledgerAdmittedSequence,
        runnerId: input.runnerId,
        runnerVersion: runner.runnerVersion,
        actorId: actor.actorId,
        cause: "runner-assignment",
        assignedAt: leasedAt,
        requiredCapabilities,
      },
      createdAt: leasedAt,
      heartbeatCutoff,
    });
    if (!claim.claimed) {
      const committed = await store.findRunnerAssignmentByKey(actor.applicationId, assignmentKey);
      if (committed !== null) {
        if (committed.requestFingerprint !== fingerprint) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "assignment key was already used with a different request fingerprint",
            details: { assignmentId: committed.id, runnerId: committed.runnerId },
          });
        }
        return committed; // concurrent duplicate converged on the committed row
      }
      // The insert was refused by the physical runner guards (health/lease
      // slot raced between the pre-checks and the insert): re-read and fail
      // with the CURRENT state's typed rejection.
      const current = await store.findRunner(actor.applicationId, input.runnerId);
      if (current !== null && current.authorizationStatus !== "authorized") {
        throw new PlatformError({
          code: "AUTHORIZATION_DENIED",
          message: `runner was revoked while the assignment was being claimed (authorization: ${current.authorizationStatus})`,
          details: { runnerId: input.runnerId },
        });
      }
      if (
        current !== null &&
        !isRunnerHealthyForAssignment(current, nowMs(), deps.heartbeatWindowMs)
      ) {
        throw new PlatformError({
          code: "NO_ELIGIBLE_ROUTE",
          message:
            "runner's health changed while the assignment was being claimed; it is not assignable now",
          details: { runnerId: input.runnerId, healthStatus: current.healthStatus },
          retryable: true,
        });
      }
      throw new PlatformError({
        code: "NO_ELIGIBLE_ROUTE",
        message:
          "runner's assignment slot was claimed concurrently (one active assignment per runner)",
        details: { runnerId: input.runnerId },
        retryable: true,
      });
    }
    const claimed = claim.claimed ? claim.record : null;
    if (claimed === null) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message:
          "runner assignment was refused by the physical runner guards and no committed row exists",
        details: { runnerId: input.runnerId, assignmentKey },
      });
    }
    await appendEvent(
      claimed,
      "assigned",
      { lease, requiredCapabilities },
      actor.actorId,
      "runner-assignment",
    );
    return claimed;
  };

  // -------------------------------------------------------------------------
  // Dispatch handoff → report → release/expiry
  // -------------------------------------------------------------------------

  const buildHandoff = async (record: RunnerAssignmentRecord): Promise<RunnerHandoff> => {
    const sandbox = await sandboxStore.findSandbox(record.applicationId, record.sandboxId);
    if (sandbox === null) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "the parent sandbox execution disappeared; the handoff cannot be constructed",
        details: { sandboxId: record.sandboxId },
      });
    }
    const runner = await store.findRunner(record.applicationId, record.runnerId);
    if (runner === null) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: "the assigned runner disappeared; the handoff cannot be constructed",
        details: { runnerId: record.runnerId },
      });
    }
    const metadata = sandbox.runtimeMetadata;
    return {
      assignmentId: record.id,
      applicationId: record.applicationId,
      tenantId: record.tenantId,
      executionId: record.executionId,
      sandboxId: record.sandboxId,
      environmentId: record.environmentId,
      runnerId: record.runnerId,
      runnerVersion: runner.runnerVersion,
      kind: sandbox.kind,
      task: metadata.task,
      limits: metadata.limits,
      network: metadata.network,
      filesystem: metadata.filesystem,
      secretRefs: [...metadata.secretRefs],
      leaseExpiresAt: record.lease.leaseExpiresAt,
      handoffNonce: record.handoffNonce ?? "",
      reconnectCount: record.reconnectCount,
      provenance: record.provenance,
    };
  };

  const dispatchAssignment: RunnerFleetService["dispatchAssignment"] = async (input, actor) => {
    requireActor(actor, input.applicationId);
    const record = await requireAssignment(input.applicationId, input.assignmentId, actor.tenantId);
    if (record.status === "dispatched") {
      // Idempotent replay: the SAME handoff (same nonce) is returned for the
      // durable dispatch intent — a retry never mints a second handoff.
      return buildHandoff(record);
    }
    if (record.status !== "assigned") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `assignment cannot dispatch from status ${record.status}`,
        details: { assignmentId: record.id, status: record.status },
      });
    }
    if (nowMs() > Date.parse(record.lease.leaseExpiresAt)) {
      throw new PlatformError({
        code: "EXPIRED",
        message: "the assignment lease expired before the dispatch handoff",
        details: { assignmentId: record.id, leaseExpiresAt: record.lease.leaseExpiresAt },
      });
    }
    const handoffNonce = generateId();
    const claim = await store.claimRunnerDispatch({
      applicationId: input.applicationId,
      assignmentId: input.assignmentId,
      handoffNonce,
      dispatchedAt: iso(),
    });
    if (!claim.claimed) {
      if (claim.record.status === "dispatched") {
        return buildHandoff(claim.record); // concurrent dispatcher won — replay its handoff
      }
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `assignment cannot dispatch from status ${claim.record.status}`,
        details: { assignmentId: claim.record.id, status: claim.record.status },
      });
    }
    await appendEvent(
      claim.record,
      "dispatched",
      { handoffNonce, leaseExpiresAt: claim.record.lease.leaseExpiresAt },
      actor.actorId,
      "runner-dispatch",
    );
    return buildHandoff(claim.record);
  };

  const reportResult: RunnerFleetService["reportResult"] = async (input, actor) => {
    requireActor(actor, input.applicationId);
    const record = await requireAssignment(input.applicationId, input.assignmentId, actor.tenantId);
    const reportCheck = validateRunnerResultReport(input.report);
    if (!reportCheck.valid) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: `invalid result report: ${reportCheck.reason}`,
      });
    }
    if (record.status === "expired") {
      throw new PlatformError({
        code: "EXPIRED",
        message:
          "the assignment lease expired; a late report fails closed (the runner's outcome cannot be proven convergent)",
        details: { assignmentId: record.id },
      });
    }
    if (record.status !== "dispatched") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `assignment cannot report from status ${record.status} (only a dispatched assignment reports)`,
        details: { assignmentId: record.id, status: record.status },
      });
    }
    if (nowMs() > Date.parse(record.lease.leaseExpiresAt)) {
      throw new PlatformError({
        code: "EXPIRED",
        message: "the assignment lease expired before the report was accepted",
        details: { assignmentId: record.id, leaseExpiresAt: record.lease.leaseExpiresAt },
      });
    }
    // Authorization re-check AT report time: a runner revoked mid-flight
    // cannot land an outcome (M4).
    const runner = await store.findRunner(input.applicationId, record.runnerId);
    if (runner === null || runner.authorizationStatus !== "authorized") {
      throw new PlatformError({
        code: "AUTHORIZATION_DENIED",
        message:
          "the runner's authorization is not valid at report time (revoked or missing runners cannot report)",
        details: { assignmentId: record.id, runnerId: record.runnerId },
      });
    }
    const status = input.report.outcomeClass === "sandbox-success" ? "completed" : "failed";
    const finalization = await store.recordRunnerResult({
      applicationId: input.applicationId,
      assignmentId: input.assignmentId,
      status,
      report: input.report,
      reportedAt: iso(),
    });
    // Only the WINNING finalization journals the event — a concurrent
    // duplicate report converged on the committed outcome (first writer
    // wins; the loser replays the SAME terminal record, never a second
    // logical outcome).
    if (finalization.claimed) {
      await appendEvent(
        finalization.record,
        status,
        {
          outcomeClass: input.report.outcomeClass,
          outputDigest: input.report.outputDigest,
          ...(input.report.failure === null
            ? {}
            : { failureClass: input.report.failure.failureClass }),
        },
        record.runnerId,
        "runner-report",
      );
    }
    return finalization.record;
  };

  const releaseAssignment: RunnerFleetService["releaseAssignment"] = async (input, actor) => {
    requireActor(actor, input.applicationId);
    const record = await requireAssignment(input.applicationId, input.assignmentId, actor.tenantId);
    if (record.status !== "assigned" && record.status !== "dispatched") {
      return record; // terminal rows are inert — release is idempotent
    }
    const release = await store.releaseRunnerAssignment({
      applicationId: input.applicationId,
      assignmentId: input.assignmentId,
      from: record.status,
      reason: input.reason,
      releasedAt: iso(),
    });
    // Only the WINNING release journals the event — a concurrent
    // finalization (report/expiry) owns the committed terminal state.
    if (release.claimed) {
      await appendEvent(
        release.record,
        "released",
        { reason: input.reason },
        actor.actorId,
        "runner-release",
      );
    }
    return release.record;
  };

  const expireAssignment: RunnerFleetService["expireAssignment"] = async (input, actor) => {
    requireActor(actor, input.applicationId);
    const record = await requireAssignment(input.applicationId, input.assignmentId, actor.tenantId);
    if (record.status !== "assigned" && record.status !== "dispatched") {
      return record; // terminal rows are inert — expiry is idempotent
    }
    const expiredAt = iso();
    if (nowMs() <= Date.parse(record.lease.leaseExpiresAt)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: "the assignment lease has not expired yet",
        details: { assignmentId: record.id, leaseExpiresAt: record.lease.leaseExpiresAt },
      });
    }
    const expiry = await store.expireRunnerAssignment({
      applicationId: input.applicationId,
      assignmentId: input.assignmentId,
      expiredAt,
    });
    // Only the WINNING expiry journals the event — a concurrent
    // finalization (report/release) owns the committed terminal state.
    if (expiry.claimed) {
      await appendEvent(
        expiry.record,
        "expired",
        { leaseExpiresAt: expiry.record.lease.leaseExpiresAt },
        actor.actorId,
        "lease-expiry",
      );
    }
    return expiry.record;
  };

  return {
    registerRunner,
    authorizeRunner,
    revokeRunner,
    observeHeartbeat,
    markDisconnected,
    reconnectRunner,
    selectEligibleRunner,
    assignRunner,
    dispatchAssignment,
    reportResult,
    releaseAssignment,
    expireAssignment,
    async getRunner(applicationId, runnerId) {
      return store.findRunner(applicationId, runnerId);
    },
    async listRunners(applicationId) {
      return store.listRunners(applicationId);
    },
    async getAssignment(applicationId, assignmentId) {
      return store.findRunnerAssignment(applicationId, assignmentId);
    },
    async getAssignmentByKey(applicationId, assignmentKey) {
      return store.findRunnerAssignmentByKey(applicationId, assignmentKey);
    },
    async listAssignmentsBySandbox(applicationId, sandboxId) {
      return store.listRunnerAssignmentsBySandbox(applicationId, sandboxId);
    },
    async listAssignmentsByExecution(applicationId, executionId) {
      return store.listRunnerAssignmentsByExecution(applicationId, executionId);
    },
    async listAssignmentEvents(applicationId, assignmentId) {
      return store.listRunnerAssignmentEvents(applicationId, assignmentId);
    },
  };
}

export { isRunnerHealthyForAssignment };
