/**
 * Governed computer-use service (tools module application; WORK-027,
 * CUI-001/002/003).
 *
 * THE admission chain + execution boundary for the computer-use
 * capability family. A computer-use session is explicitly typed, bound
 * to a parent execution, routed deterministic-first, and admitted
 * through the frozen authority chain before ANY environment interaction:
 *
 * ```text
 * request
 *   → pure validation                           (no durable writes)
 *   → idempotent replay / crash recovery         (session key)
 *   → identity/tenant + execution binding        (executions ledger read)
 *   → capability-declaration resolution          (the computer-use
 *                                                 registry — unregistered
 *                                                 ids fail closed; AC-5)
 *   → deterministic-first route evaluation       (pure; zero-GUI when
 *                                                 sufficient; AC-6/AC-7)
 *   → durable operation claim                    (§14: the claim PINS the
 *                                                 session identity before
 *                                                 any duplicate exists)
 *   → POLICY admission                           (REQUIRED seam)
 *   → BUDGET reservation                         (full-route ceiling —
 *                                                 strictly before ANY
 *                                                 stage's spend)
 *   → CAPABILITY admission                       (REQUIRED seam)
 *   → SECRET mediation                           (REQUIRED seam,
 *                                                 reference-only)
 *   → durable session row + ledger intent        (the admitted bundle)
 *   → isolated environment open                  (the FIRST external
 *                                                 interaction; keyed)
 *   → … actions/observations under stable keys …
 *   → termination + budget settlement + evidence
 * ```
 *
 * The claim-first order follows the WORK-026 media admission chain
 * (claim → scope → policy → capability → budget → secret → durable
 * state); the authority order within the chain follows the
 * repository-canonical dispatch sequence (policy → budget →
 * capability — the tool-runtime precedent, this module's own house
 * pattern).
 *
 * CRASH SAFETY (the WORK-024 standard, B6): every side-effecting
 * operation (session creation, environment open, action dispatch,
 * escalation, termination, budget settle/release) flows through the
 * durable `computer_use_operations` state with a STABLE, claim-pinned
 * idempotency key; the environment and terminal seams are keyed
 * (exactly one external effect per key); a crash between claim and
 * completion leaves the honest PENDING row and a retry resumes under
 * the SAME key (replay windows are proven by the C-proofs and the
 * real-PG P-proofs).
 *
 * SECURITY ORDERING (AC-4): policy/tenant/capability/budget/secret
 * refusals occur BEFORE any environment interaction — a denial is
 * journaled (denied session/action row + failed operation) and thrown
 * typed, and the environment's activity journal is provably EMPTY of
 * any external effect for the denied request (the discrimination
 * proofs).
 *
 * ESCALATION (AC-7): deterministic → browser → desktop, one step at a
 * time, each step re-admitted through the full chain with the new
 * mode's facts, each step requiring RECORDED insufficiency evidence of
 * the prior mode (the digest of the prior mode's failing outcome — a
 * fabricated escalation fails closed).
 *
 * PROVENANCE (AC-8/AC-3): every action and observation is a durable row
 * bound to (execution, session, sequence) with digests, side-effect
 * classification, capability identity and ledger sequence bindings; the
 * trajectory read returns the replayable lineage.
 */

import { PlatformError } from "../../../shared/errors";
import type { BudgetAuthority } from "../../budgets/public";
import { containsRawSecretValue } from "../../sandbox/public";
import type {
  ComputerUseActionRecord,
  ComputerUseActionType,
  ComputerUseCapabilityDeclaration,
  ComputerUseMode,
  ComputerUseObservationRecord,
  ComputerUseRouteEvidence,
  ComputerUseSessionRecord,
  ComputerUseSessionRequest,
  ComputerUseTrajectoryEntry,
} from "../domain/computer-use";
import {
  ACTION_OBSERVATION_TYPES,
  ACTION_SIDE_EFFECTS,
  actionConfinementCheck,
  COMPUTER_USE_KEY_PREFIXES,
  COMPUTER_USE_MODES,
  canonicalComputerUseJson,
  computerUseActionDispatchKey,
  computerUseBudgetReleaseKey,
  computerUseBudgetReserveKey,
  computerUseBudgetSettleKey,
  computerUseEnvOpenKey,
  computerUseEscalationKey,
  computerUseObservationDigest,
  computerUseSessionCreateKey,
  computerUseSessionFingerprint,
  computerUseTerminationKey,
  egressConfinementCheck,
  escalationTargetCheck,
  evaluateComputerUseRoute,
  isComputerUseActionType,
  isTerminalComputerUseSessionStatus,
  validateComputerUseSessionRequest,
} from "../domain/computer-use";
import type {
  ComputerUseCapabilityGate,
  ComputerUsePolicyAdmission,
  ComputerUseSecretMediation,
} from "../ports/computer-use-admission";
import type { ComputerUseEnvironment } from "../ports/computer-use-environment";
import type { ComputerUseCapabilityRegistry } from "../ports/computer-use-registry";
import type { ComputerUseSessionInsertInput, ComputerUseStore } from "../ports/computer-use-store";
import type { ComputerUseTerminalExecutor } from "../ports/computer-use-terminal";
import type { ExecutionLedger } from "../ports/execution-ledger";

/** Bounded payloads (the honest-memory discipline; fail-closed). */
export const COMPUTER_USE_INPUT_MAX = 8192;
export const COMPUTER_USE_OBSERVATION_CONTENT_MAX = 16384;

export interface ComputerUseServiceDeps {
  /** The computer-use capability-declaration registry (REQUIRED). */
  readonly registry: ComputerUseCapabilityRegistry;
  /** REQUIRED policy admission seam — no default-allow exists by design. */
  readonly policy: ComputerUsePolicyAdmission;
  /** REQUIRED capability authority seam — no default/skip exists by design. */
  readonly capabilities: ComputerUseCapabilityGate;
  /** REQUIRED secret-mediation seam (reference-only grants). */
  readonly secrets: ComputerUseSecretMediation;
  /**
   * Budget authority (WORK-004 surface). OPTIONAL at construction, but a
   * COSTED route (any stage with a non-zero estimate) fails closed when
   * no authority is wired — costed work never executes unbudgeted.
   */
  readonly budgetAuthority?: BudgetAuthority;
  readonly store: ComputerUseStore;
  /** REQUIRED canonical execution event path (the tools module's own port). */
  readonly ledger: ExecutionLedger;
  /** The isolated computer-use environment seam (REQUIRED). */
  readonly environment: ComputerUseEnvironment;
  /** The approved sandbox terminal seam (REQUIRED for terminal actions). */
  readonly terminal: ComputerUseTerminalExecutor;
  readonly generateId: () => string;
  readonly now: () => Date;
  readonly digest: (input: string) => string;
}

export interface ComputerUseSessionReceipt {
  readonly sessionId: string;
  readonly executionId: string;
  readonly applicationId: string;
  readonly status: ComputerUseSessionRecord["status"];
  readonly mode: ComputerUseMode;
  readonly replayed: boolean;
  /** The planner-facing deterministic-first evidence (AC-6). */
  readonly routeEvidence: ComputerUseRouteEvidence;
  readonly environmentRef: string | null;
}

export interface ComputerUseActionRequest {
  readonly actionType: ComputerUseActionType;
  /** The action's TARGET (url, selector, window id, file path, command). */
  readonly target: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** The host this action would egress to (required for egressing actions). */
  readonly host?: string;
}

export interface ComputerUseActionDispatchResult {
  readonly actionId: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly applicationId: string;
  readonly actionKey: string;
  readonly mode: ComputerUseMode;
  readonly actionType: ComputerUseActionType;
  readonly status: ComputerUseActionRecord["status"];
  readonly sideEffect: ComputerUseActionRecord["sideEffect"];
  readonly resultDigest: string | null;
  readonly usageMicroUsd: string | null;
  readonly sandboxExecutionId: string | null;
  /** Serialized observation evidence (digest-only, retention-tagged). */
  readonly observations: readonly ComputerUseObservationRecord[];
  readonly durationMs: number | null;
  readonly replayed: boolean;
  /** The planner-facing deterministic-first evidence (AC-6). */
  readonly routeEvidence: ComputerUseRouteEvidence;
}

export interface ComputerUseEscalationRequest {
  readonly targetMode: ComputerUseMode;
  /** The RECORDED insufficiency evidence of the prior mode (verified). */
  readonly insufficiency: {
    readonly stage: ComputerUseMode;
    readonly reasonCode: string;
    readonly reasonDetail: string;
    /** The prior mode's failing action (verified against the journal). */
    readonly failedActionId: string | null;
    /** Digest over the referenced action's recorded outcome. */
    readonly evidenceDigest: string | null;
  };
}

export interface ComputerUseTrajectory {
  readonly session: ComputerUseSessionRecord;
  readonly entries: readonly ComputerUseTrajectoryEntry[];
}

export interface ComputerUseService {
  createSession(
    request: ComputerUseSessionRequest,
    idempotencyKey: string,
  ): Promise<ComputerUseSessionReceipt>;
  getSession(applicationId: string, sessionId: string): Promise<ComputerUseSessionRecord | null>;
  dispatchAction(
    applicationId: string,
    sessionId: string,
    request: ComputerUseActionRequest,
    idempotencyKey: string,
  ): Promise<ComputerUseActionDispatchResult>;
  escalate(
    applicationId: string,
    sessionId: string,
    request: ComputerUseEscalationRequest,
    idempotencyKey: string,
  ): Promise<ComputerUseSessionReceipt>;
  terminate(
    applicationId: string,
    sessionId: string,
    cause: "completed" | "failed" | "cancelled",
    idempotencyKey: string,
  ): Promise<ComputerUseSessionReceipt>;
  getTrajectory(applicationId: string, sessionId: string): Promise<ComputerUseTrajectory | null>;
}

const KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;

export function createComputerUseService(deps: ComputerUseServiceDeps): ComputerUseService {
  const { registry, policy, capabilities, secrets, store, ledger, environment, terminal } = deps;
  const budgetAuthority = deps.budgetAuthority;

  const iso = () => deps.now().toISOString();

  // -----------------------------------------------------------------------
  // Ledger events (deterministic payloads; idempotent per stable key)
  // -----------------------------------------------------------------------

  const ledgerKey = (scope: string, phase: string) =>
    `${COMPUTER_USE_KEY_PREFIXES.ledgerEvent}:${scope}:${phase}`;

  const appendEvent = async (
    applicationId: string,
    executionId: string,
    actorId: string,
    tenantId: string,
    command: "tool-requested" | "tool-result" | "tool-denied",
    cause: string,
    reference: Readonly<Record<string, unknown>>,
    payload: Readonly<Record<string, unknown>>,
    key: string,
  ): Promise<number> => {
    const outcome = await ledger.recordStepEvent(
      {
        applicationId,
        executionId,
        actor: { actorId, tenantId },
        command,
        cause,
        reference,
        payload,
      },
      key,
    );
    return outcome.sequence;
  };

  const receiptOf = (
    session: ComputerUseSessionRecord,
    replayed: boolean,
  ): ComputerUseSessionReceipt => ({
    sessionId: session.id,
    executionId: session.executionId,
    applicationId: session.applicationId,
    status: session.status,
    mode: session.currentMode,
    replayed,
    routeEvidence: session.routeEvidence,
    environmentRef: session.environmentRef,
  });

  const denialCodeOf = (denialClass: string | null) => {
    switch (denialClass) {
      case "policy":
        return "POLICY_DENIED" as const;
      case "budget":
        return "BUDGET_EXCEEDED" as const;
      case "capability":
        return "CAPABILITY_UNAVAILABLE" as const;
      default:
        return "AUTHORIZATION_DENIED" as const;
    }
  };

  const modeContextOf = (
    declaration: ComputerUseCapabilityDeclaration,
  ): ComputerUseSessionRecord["modeContext"] => ({
    capabilityId: declaration.capabilityId,
    desktopEnvelope: declaration.desktopEnvelope,
    terminalPolicy: declaration.terminalPolicy,
    browserProfile: declaration.browserProfile,
  });

  // -----------------------------------------------------------------------
  // Journal-then-fail (the denial discipline: durable evidence + typed
  // error + budget release; ZERO environment activity ever happened)
  // -----------------------------------------------------------------------

  const denySession = async (
    input: ComputerUseSessionInsertInput,
    denialClass: "policy" | "budget" | "capability" | "secret-mediation",
    code: "POLICY_DENIED" | "BUDGET_EXCEEDED" | "CAPABILITY_UNAVAILABLE" | "AUTHORIZATION_DENIED",
    reason: string,
    operationKey: string,
    budgetOperationId: string | null,
  ): Promise<never> => {
    const denied = await store.insertSession({ ...input, denialClass, denialReason: reason });
    const record = denied.record;
    if (denied.status === "inserted") {
      await appendEvent(
        record.applicationId,
        record.executionId,
        record.id,
        record.tenantId,
        "tool-denied",
        "computer-use-session",
        {
          sessionId: record.id,
          mode: record.initialMode,
          denialClass,
          code,
          reason,
          ...(budgetOperationId === null ? {} : { budgetOperationId }),
        },
        { denied: true, denialClass, code, reason },
        ledgerKey(record.id, "session-denied"),
      );
    }
    await store.failOperation(
      record.applicationId,
      operationKey,
      `${code}: ${reason}`.slice(0, 512),
      iso(),
    );
    if (budgetAuthority !== undefined && budgetOperationId !== null) {
      try {
        await budgetAuthority.release(
          {
            actorId: record.id,
            applicationId: record.applicationId,
            tenantId: record.tenantId,
            operationId: budgetOperationId,
          },
          computerUseBudgetReleaseKey(record.id),
        );
      } catch {
        // Release is idempotent per operation id; a failure here must not
        // mask the canonical denial (reconciliation by key).
      }
    }
    throw new PlatformError({
      code,
      message: `computer-use session denied (${denialClass}): ${reason}`,
      details: {
        sessionId: record.id,
        denialClass,
        reason,
        ...(budgetOperationId === null ? {} : { budgetOperationId }),
      },
    });
  };

  // -----------------------------------------------------------------------
  // Environment open (the FIRST external interaction; keyed, crash-safe)
  // -----------------------------------------------------------------------

  const openEnvironment = async (
    session: ComputerUseSessionRecord,
    declaration: ComputerUseCapabilityDeclaration,
    operationKey: string,
    externalKey: string,
  ): Promise<ComputerUseSessionRecord> => {
    const begun = await store.beginComputerUseOperation({
      operationId: deps.generateId(),
      applicationId: session.applicationId,
      tenantId: session.tenantId,
      sessionId: session.id,
      executionId: session.executionId,
      operationKind: "env-open",
      operationKey,
      requestFingerprint: canonicalComputerUseJson({
        mode: session.currentMode,
        capabilityId: declaration.capabilityId,
      }),
      createdAt: iso(),
    });
    if (begun.record.status === "completed") {
      // A prior process completed the open: the session row carries the
      // environment reference.
      return (await store.findSession(session.applicationId, session.id)) ?? session;
    }
    const opened = await environment.open(
      {
        applicationId: session.applicationId,
        tenantId: session.tenantId,
        sessionId: session.id,
        executionId: session.executionId,
        mode: session.currentMode,
        capabilityId: declaration.capabilityId,
        browserProfile: declaration.browserProfile,
        desktopEnvelope: declaration.desktopEnvelope,
        terminalPolicy: declaration.terminalPolicy,
      },
      externalKey,
    );
    if ("failureClass" in opened) {
      await store.failOperation(
        session.applicationId,
        operationKey,
        `environment-open failed (${opened.failureClass}): ${opened.message}`.slice(0, 512),
        iso(),
      );
      throw new PlatformError({
        code: "TOOL_ERROR",
        message: `the isolated computer-use environment could not be opened (${opened.failureClass}): ${opened.message}`,
        details: { sessionId: session.id, mode: session.currentMode },
      });
    }
    // The isolation verdict is DURABLE evidence: a context that inherited
    // ANY ambient host state fails closed right here (the proof is that
    // this branch is unreachable for the shipped rail — and reachable for
    // a mutant one).
    if (opened.inheritedHostState.length > 0) {
      await store.failOperation(
        session.applicationId,
        operationKey,
        "environment context inherited ambient host state; isolation violated",
        iso(),
      );
      throw new PlatformError({
        code: "POLICY_DENIED",
        message:
          "the computer-use environment context inherited ambient host state (credentials/cookies/env/mounts/sockets); the session fails closed",
        details: { sessionId: session.id, inherited: opened.inheritedHostState },
      });
    }
    const patched = await store.patchSession({
      applicationId: session.applicationId,
      sessionId: session.id,
      environmentRef: opened.environmentRef,
      environmentOpenedMode: session.currentMode,
      updatedAt: iso(),
    });
    await store.completeOperation(session.applicationId, operationKey, iso());
    await appendEvent(
      session.applicationId,
      session.executionId,
      session.id,
      session.tenantId,
      "tool-result",
      "computer-use-environment",
      {
        sessionId: session.id,
        mode: session.currentMode,
        environmentRef: opened.environmentRef,
        capabilityId: declaration.capabilityId,
      },
      {
        sessionId: session.id,
        phase: "environment-opened",
        mode: session.currentMode,
        environmentRef: opened.environmentRef,
        inheritedHostStateCount: 0,
      },
      ledgerKey(session.id, `env-open:${session.currentMode}`),
    );
    return patched;
  };

  // -----------------------------------------------------------------------
  // createSession
  // -----------------------------------------------------------------------

  const createSession = async (
    request: ComputerUseSessionRequest,
    idempotencyKey: string,
  ): Promise<ComputerUseSessionReceipt> => {
    // ----- 0. Pure validation (no durable writes, no authority calls). ---
    const requestCheck = validateComputerUseSessionRequest(request);
    if (!requestCheck.valid) {
      throw new PlatformError({ code: "POLICY_DENIED", message: requestCheck.reason });
    }
    if (!KEY_PATTERN.test(idempotencyKey)) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message:
          "computer-use session creation requires a non-empty printable idempotency key (max 200 chars)",
      });
    }
    const fingerprint = computerUseSessionFingerprint(request);

    // ----- 1. Idempotent replay / crash-recovery fast path. ---------------
    const existing = await store.findSessionByKey(request.applicationId, idempotencyKey);
    if (existing !== null) {
      if (existing.requestFingerprint !== fingerprint) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "idempotency key was already used with a different session request",
          details: { sessionId: existing.id },
        });
      }
      if (existing.status !== "denied") {
        // Crash-window convergence (the evidence): a process that died
        // between the session insert and the admitted-event append
        // leaves the durable row without its ledger evidence. The
        // KEYED append converges the admission evidence exactly once
        // (the frozen ledger dedups by the stable event key).
        await appendEvent(
          existing.applicationId,
          existing.executionId,
          existing.id,
          existing.tenantId,
          "tool-requested",
          "computer-use-session",
          {
            sessionId: existing.id,
            mode: existing.initialMode,
            capabilityId: existing.modeContext.capabilityId,
            routeStages: existing.routeEvidence.route.map(
              (stage) => `${stage.mode}:${stage.capabilityId}`,
            ),
            deterministicFirst: existing.routeEvidence.deterministicFirst,
            ...(existing.admission.budgetOperationId === null
              ? {}
              : { budgetOperationId: existing.admission.budgetOperationId }),
          },
          {
            sessionId: existing.id,
            phase: "session-admitted",
            mode: existing.initialMode,
            deterministicFirst: existing.routeEvidence.deterministicFirst,
            routeStageCount: existing.routeEvidence.route.length,
          },
          ledgerKey(existing.id, "session-admitted"),
        );
        // Crash-window convergence (the operation ledger): a process
        // that died between the session insert and the operation
        // completion leaves an honest PENDING create claim; the ACTIVE
        // row is the committed-effect proof (the pre-terminal-stage
        // discipline, active-session side) — converge it here, never a
        // dangling PENDING claim on a converged session.
        const createKey = computerUseSessionCreateKey(idempotencyKey);
        const createOperation = await store.findOperation(request.applicationId, createKey);
        if (createOperation !== null && createOperation.status === "pending") {
          await store.completeOperation(request.applicationId, createKey, iso());
        }
      }
      if (isTerminalComputerUseSessionStatus(existing.status)) {
        // Converge the session-create operation onto the committed
        // outcome: a crash between the durable session row and the
        // operation completion leaves the honest PENDING row; the row's
        // terminal status IS the committed-effect proof (the WORK-028
        // pre-terminal-stage discipline).
        const createKey = computerUseSessionCreateKey(idempotencyKey);
        const operation = await store.findOperation(request.applicationId, createKey);
        if (operation !== null && operation.status === "pending") {
          if (existing.status === "denied") {
            await store.failOperation(
              request.applicationId,
              createKey,
              `denied (${existing.denialClass}): ${existing.denialReason ?? ""}`.slice(0, 512),
              iso(),
            );
          } else {
            await store.completeOperation(request.applicationId, createKey, iso());
          }
        }
        if (existing.status === "denied") {
          throw new PlatformError({
            code: denialCodeOf(existing.denialClass),
            message:
              `computer-use session was denied (${existing.denialClass}): ${existing.denialReason ?? ""}`.trim(),
            details: { sessionId: existing.id, denialClass: existing.denialClass },
          });
        }
        return receiptOf(existing, true);
      }
      // Active session: converge the environment open if a prior process
      // died between the session row and the environment boundary.
      const declaration = await registry.resolve(existing.modeContext.capabilityId);
      if (declaration === null) {
        throw new PlatformError({
          code: "CAPABILITY_UNAVAILABLE",
          message: `the session's capability ${existing.modeContext.capabilityId} is no longer registered`,
        });
      }
      if (existing.environmentRef === null) {
        const completed = await openEnvironment(
          existing,
          declaration,
          computerUseEnvOpenKey(existing.id, existing.currentMode),
          `${COMPUTER_USE_KEY_PREFIXES.envOpenExternal}:${existing.id}:${existing.currentMode}`,
        );
        return receiptOf(completed, true);
      }
      return receiptOf(existing, true);
    }

    // ----- 2. Identity/tenant + execution binding (§7 step 1). ------------
    const execution = await ledger.getExecution(request.applicationId, request.executionId);
    if (execution === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message:
          "execution not found in this application (missing or owned by another application)",
        details: { executionId: request.executionId },
      });
    }
    if (execution.tenantId !== request.actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "execution belongs to a different tenant",
        details: { executionId: request.executionId },
      });
    }
    if (["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(execution.status)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `execution is terminal in ${execution.status}; no computer-use session may be created on it`,
        details: { executionId: request.executionId, status: execution.status },
      });
    }

    // ----- 3. Capability-declaration resolution (the registry; AC-5). -----
    const deterministicDeclarations: ComputerUseCapabilityDeclaration[] = [];
    for (const capabilityId of request.candidates.deterministic) {
      const declaration = await registry.resolve(capabilityId);
      if (declaration === null) {
        throw new PlatformError({
          code: "CAPABILITY_UNAVAILABLE",
          message: `computer-use capability ${capabilityId} is not registered (unregistered capabilities cannot dispatch)`,
          details: { capabilityId },
        });
      }
      deterministicDeclarations.push(declaration);
    }
    const browserDeclaration =
      request.candidates.browser === null || request.candidates.browser === undefined
        ? null
        : await registry.resolve(request.candidates.browser);
    if (request.candidates.browser != null && browserDeclaration === null) {
      throw new PlatformError({
        code: "CAPABILITY_UNAVAILABLE",
        message: `computer-use capability ${request.candidates.browser} is not registered (unregistered capabilities cannot dispatch)`,
        details: { capabilityId: request.candidates.browser },
      });
    }
    const desktopDeclaration =
      request.candidates.desktop === null || request.candidates.desktop === undefined
        ? null
        : await registry.resolve(request.candidates.desktop);
    if (request.candidates.desktop != null && desktopDeclaration === null) {
      throw new PlatformError({
        code: "CAPABILITY_UNAVAILABLE",
        message: `computer-use capability ${request.candidates.desktop} is not registered (unregistered capabilities cannot dispatch)`,
        details: { capabilityId: request.candidates.desktop },
      });
    }

    // ----- 4. Deterministic-first route evaluation (pure). ----------------
    const routeEvidence = evaluateComputerUseRoute({
      taskKind: request.task.kind,
      requirementAtoms: request.task.requirementAtoms,
      qualityTarget: request.task.qualityTarget,
      deterministic: deterministicDeclarations,
      browser: browserDeclaration,
      desktop: desktopDeclaration,
    });
    if (routeEvidence.route.length === 0) {
      throw new PlatformError({
        code: "CAPABILITY_UNAVAILABLE",
        message:
          "no computer-use route is available: the deterministic route is insufficient and no GUI capability is registered (fail-closed before any environment interaction)",
        details: {
          decision: routeEvidence.decision,
          reasons: routeEvidence.reasons.map((reason) => reason.code),
        },
      });
    }
    const initialStage = routeEvidence.route[0];
    if (initialStage === undefined) {
      throw new PlatformError({
        code: "CAPABILITY_UNAVAILABLE",
        message: "no computer-use route is available (internal route evaluation divergence)",
      });
    }
    const stageDeclaration = (mode: ComputerUseMode, capabilityId: string) =>
      mode === "deterministic"
        ? (deterministicDeclarations.find((item) => item.capabilityId === capabilityId) ?? null)
        : mode === "browser"
          ? browserDeclaration
          : desktopDeclaration;
    const initialDeclaration = stageDeclaration(initialStage.mode, initialStage.capabilityId);
    if (initialDeclaration === null) {
      throw new PlatformError({
        code: "CAPABILITY_UNAVAILABLE",
        message: `the routed capability ${initialStage.capabilityId} is not resolvable`,
      });
    }
    const initialMode = initialStage.mode;
    const routeHosts = [
      ...new Set(
        routeEvidence.route.flatMap(
          (stage) => stageDeclaration(stage.mode, stage.capabilityId)?.hosts ?? [],
        ),
      ),
    ];
    const routeSecretRef = initialDeclaration.secretRef;
    const costCeilingMicroUsd = routeEvidence.route
      .reduce(
        (total, stage) =>
          total +
          BigInt(stageDeclaration(stage.mode, stage.capabilityId)?.estimatedMicroUsd ?? "0"),
        0n,
      )
      .toString();

    // ----- 5. Durable operation claim (the §14 boundary — the claim PINS
    // the session identity BEFORE any duplicate or authority call). -------
    const operationKey = computerUseSessionCreateKey(idempotencyKey);
    const begun = await store.beginComputerUseOperation({
      operationId: deps.generateId(),
      applicationId: request.applicationId,
      tenantId: request.actor.tenantId,
      sessionId: null,
      executionId: request.executionId,
      operationKind: "session-create",
      operationKey,
      requestFingerprint: fingerprint,
      createdAt: iso(),
    });
    if (begun.record.status === "completed") {
      // A prior process completed this exact creation: pure replay.
      const completed = await store.findSessionByKey(request.applicationId, idempotencyKey);
      if (completed !== null) {
        return receiptOf(completed, true);
      }
      await store.failOperation(
        request.applicationId,
        operationKey,
        "the session-create operation is completed but its session row is missing (durable-state divergence)",
        iso(),
      );
      throw new PlatformError({
        code: "TOOL_ERROR",
        message: "computer-use session state diverged (completed operation without a session row)",
      });
    }
    const durableSessionId =
      (begun.record.stage?.sessionId as string | undefined) ?? deps.generateId();
    if (begun.record.stage?.sessionId === undefined) {
      await store.recordOperationCheckpoint(
        request.applicationId,
        operationKey,
        { sessionId: durableSessionId },
        iso(),
      );
    }
    const budgetOperationId =
      costCeilingMicroUsd === "0" ? null : computerUseBudgetReserveKey(durableSessionId);

    let admissionDraft: ComputerUseSessionRecord["admission"] = {
      taskKind: request.task.kind,
      requirementAtoms: [...request.task.requirementAtoms],
      qualityTarget: request.task.qualityTarget,
      initialMode,
      routeEvidence,
      hosts: routeHosts,
      secretRef: routeSecretRef,
      policyEvidence: null,
      capabilitySatisfaction: null,
      budgetOperationId,
      costCeilingMicroUsd,
      secretGrantRef: null,
    };
    const insertInput: ComputerUseSessionInsertInput = {
      sessionId: durableSessionId,
      applicationId: request.applicationId,
      tenantId: request.actor.tenantId,
      executionId: request.executionId,
      sessionKey: idempotencyKey,
      requestFingerprint: fingerprint,
      taskKind: request.task.kind,
      initialMode,
      routeEvidence,
      admission: admissionDraft,
      modeContext: modeContextOf(initialDeclaration),
      denialClass: null,
      denialReason: null,
      createdAt: iso(),
    };
    /** The insert input carrying the LATEST admission draft (the draft is
     * refined by every admission step; the final row carries them all). */
    const finalInput = (): ComputerUseSessionInsertInput => ({
      ...insertInput,
      admission: admissionDraft,
    });

    // ----- 6. POLICY admission (the gate — before any environment
    // interaction; the denial is journaled and thrown typed). --------------
    const policyDecision = await policy.admit({
      tenantId: request.actor.tenantId,
      applicationId: request.applicationId,
      executionId: request.executionId,
      toolFact: "computer-use:session",
      providerCapabilityId: initialDeclaration.capabilityId,
      hosts: routeHosts,
      secretRef: routeSecretRef,
    });
    if (!policyDecision.allowed) {
      await denySession(
        finalInput(),
        "policy",
        "POLICY_DENIED",
        policyDecision.reason,
        operationKey,
        null,
      );
    }
    admissionDraft = {
      ...admissionDraft,
      policyEvidence:
        policyDecision.allowed && policyDecision.evidence !== undefined
          ? policyDecision.evidence
          : null,
    };

    // ----- 7. BUDGET reservation (the FULL route ceiling — strictly
    // before ANY stage's spend; fail-closed for costed routes). -----------
    const costed = costCeilingMicroUsd !== "0";
    if (costed && budgetAuthority === undefined) {
      await denySession(
        finalInput(),
        "budget",
        "BUDGET_EXCEEDED",
        "the computer-use route declares a non-zero cost ceiling but no budget authority is wired; costed sessions never execute unbudgeted",
        operationKey,
        budgetOperationId,
      );
    }
    if (costed && budgetAuthority !== undefined && budgetOperationId !== null) {
      try {
        await budgetAuthority.reserve(
          {
            actorId: request.actor.actorId,
            applicationId: request.applicationId,
            tenantId: request.actor.tenantId,
            executionId: request.executionId,
            operationId: budgetOperationId,
            userId: execution.userId ?? "",
            amountMicroUsd: costCeilingMicroUsd,
          },
          budgetOperationId,
        );
      } catch (error) {
        if (error instanceof PlatformError && error.code === "BUDGET_EXCEEDED") {
          await denySession(
            finalInput(),
            "budget",
            "BUDGET_EXCEEDED",
            error.message,
            operationKey,
            budgetOperationId,
          );
        }
        throw error;
      }
    }

    // ----- 8. CAPABILITY admission (the capabilities authority). ----------
    const routeAtoms = [
      ...new Set(routeEvidence.route.map((stage) => `computer-use-${stage.mode}`)),
    ];
    const resolution = await capabilities.resolve({ requirementAtoms: routeAtoms });
    if (!resolution.satisfied) {
      await denySession(
        finalInput(),
        "capability",
        "CAPABILITY_UNAVAILABLE",
        `computer-use capability requirement cannot be satisfied: ${resolution.unmet.join(", ")}`,
        operationKey,
        budgetOperationId,
      );
    }
    admissionDraft = {
      ...admissionDraft,
      capabilitySatisfaction: resolution.satisfactions[0] ?? null,
    };

    // ----- 9. SECRET mediation (reference-only; fails closed). ------------
    if (routeSecretRef !== null && request.connectionRef === null) {
      await denySession(
        finalInput(),
        "secret-mediation",
        "AUTHORIZATION_DENIED",
        "the routed capability requires a mediated credential reference but the request carries none",
        operationKey,
        budgetOperationId,
      );
    }
    if (routeSecretRef === null && request.connectionRef !== null) {
      await denySession(
        finalInput(),
        "secret-mediation",
        "AUTHORIZATION_DENIED",
        "the request carries a connection reference but the routed route declares no secret requirement (undisclosed secret access is refused)",
        operationKey,
        budgetOperationId,
      );
    }
    if (routeSecretRef !== null && request.connectionRef !== null) {
      const mediation = await secrets.mediate({
        tenantId: request.actor.tenantId,
        applicationId: request.applicationId,
        connectionRef: request.connectionRef,
      });
      let mediatedGrantRef: string | null = null;
      if (mediation.mediated) {
        mediatedGrantRef = mediation.grantRef;
      } else {
        // Journal-then-fail (always throws; the assignment below is
        // unreachable but keeps the flow analysis honest).
        await denySession(
          finalInput(),
          "secret-mediation",
          "AUTHORIZATION_DENIED",
          mediation.reason,
          operationKey,
          budgetOperationId,
        );
      }
      admissionDraft = { ...admissionDraft, secretGrantRef: mediatedGrantRef };
    }

    // ----- 10. Durable session row + ledger intent. ------------------------
    const inserted = await store.insertSession(finalInput());
    if (inserted.status === "existing") {
      if (inserted.fingerprintMismatch) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "idempotency key was already used with a different session request",
          details: { sessionId: inserted.record.id },
        });
      }
      await store.completeOperation(request.applicationId, operationKey, iso());
      return receiptOf(inserted.record, true);
    }
    const session = inserted.record;
    await appendEvent(
      session.applicationId,
      session.executionId,
      session.id,
      session.tenantId,
      "tool-requested",
      "computer-use-session",
      {
        sessionId: session.id,
        mode: session.initialMode,
        capabilityId: session.modeContext.capabilityId,
        routeStages: session.routeEvidence.route.map(
          (stage) => `${stage.mode}:${stage.capabilityId}`,
        ),
        deterministicFirst: session.routeEvidence.deterministicFirst,
        ...(session.admission.budgetOperationId === null
          ? {}
          : { budgetOperationId: session.admission.budgetOperationId }),
      },
      {
        sessionId: session.id,
        phase: "session-admitted",
        mode: session.initialMode,
        deterministicFirst: session.routeEvidence.deterministicFirst,
        routeStageCount: session.routeEvidence.route.length,
      },
      ledgerKey(session.id, "session-admitted"),
    );
    await store.completeOperation(request.applicationId, operationKey, iso());

    // ----- 11. The isolated environment open (the FIRST external
    // interaction — zero external effects existed before this). -----------
    const withEnvironment = await openEnvironment(
      session,
      initialDeclaration,
      computerUseEnvOpenKey(session.id, session.currentMode),
      `${COMPUTER_USE_KEY_PREFIXES.envOpenExternal}:${session.id}:${session.currentMode}`,
    );
    return receiptOf(withEnvironment, false);
  };

  // -----------------------------------------------------------------------
  // dispatchAction
  // -----------------------------------------------------------------------

  const actionResultOf = (
    session: ComputerUseSessionRecord,
    action: ComputerUseActionRecord,
    observations: readonly ComputerUseObservationRecord[],
    replayed: boolean,
  ): ComputerUseActionDispatchResult => ({
    actionId: action.id,
    sessionId: action.sessionId,
    executionId: action.executionId,
    applicationId: action.applicationId,
    actionKey: action.actionKey,
    mode: action.mode,
    actionType: action.actionType,
    status: action.status,
    sideEffect: action.sideEffect,
    resultDigest: action.resultDigest,
    usageMicroUsd: action.usageMicroUsd,
    sandboxExecutionId: action.sandboxExecutionId,
    observations,
    durationMs: action.durationMs,
    replayed,
    routeEvidence: session.routeEvidence,
  });

  const dispatchAction = async (
    applicationId: string,
    sessionId: string,
    request: ComputerUseActionRequest,
    idempotencyKey: string,
  ): Promise<ComputerUseActionDispatchResult> => {
    // ----- 0. Pure validation. ---------------------------------------------
    if (!KEY_PATTERN.test(idempotencyKey)) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message:
          "computer-use action dispatch requires a non-empty printable idempotency key (max 200 chars)",
      });
    }
    if (!isComputerUseActionType(request.actionType)) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: `unknown computer-use action type ${String(request.actionType)}`,
      });
    }
    if (request.target.length === 0 || request.target.length > 2000) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "action target must be 1..2000 chars",
      });
    }
    const inputJson = JSON.stringify(request.input ?? {});
    if (inputJson.length > COMPUTER_USE_INPUT_MAX) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: `action input exceeds the ${COMPUTER_USE_INPUT_MAX} char bound`,
      });
    }

    // ----- 1. Session read (tenant guard + state guard). -------------------
    const session = await store.findSession(applicationId, sessionId);
    if (session === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "computer-use session not found in this application",
        details: { sessionId },
      });
    }
    if (isTerminalComputerUseSessionStatus(session.status)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `computer-use session is terminal in ${session.status}; no action may be dispatched`,
        details: { sessionId, status: session.status },
      });
    }

    const operationKey = computerUseActionDispatchKey(sessionId, idempotencyKey);
    const actionKey = idempotencyKey;

    /**
     * Fail-closed replay arbitration: an action key already committed
     * with a DIFFERENT request (action type, target, input digest or
     * mode) is key reuse, NOT a replay — IDEMPOTENCY_KEY_REUSED (the
     * same-key/different-body discipline the session axis enforces).
     */
    const assertActionReplayFingerprint = (action: ComputerUseActionRecord): void => {
      if (
        action.actionType !== request.actionType ||
        action.target !== request.target ||
        action.inputDigest !== deps.digest(inputJson) ||
        action.mode !== session.currentMode
      ) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "action key was already used with a different request",
          details: { actionId: action.id },
        });
      }
    };

    // ----- 2. Idempotent replay (terminal action rows). --------------------
    const existingAction = await store.findActionByKey(applicationId, sessionId, actionKey);
    if (existingAction !== null && existingAction.status !== "dispatching") {
      assertActionReplayFingerprint(existingAction);
      return actionResultOf(session, existingAction, [], true);
    }

    // ----- 3. Mode confinement + envelope confinement (pure, fail-closed). -
    const confinement = actionConfinementCheck(
      session.currentMode,
      request.actionType,
      session.modeContext.desktopEnvelope,
    );
    if (!confinement.valid) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: confinement.reason,
        details: { sessionId, actionType: request.actionType, mode: session.currentMode },
      });
    }
    if (request.host !== undefined) {
      const allowlist = [
        ...(session.modeContext.browserProfile?.egressAllowlist ?? []),
        ...(session.modeContext.terminalPolicy?.egressAllowlist ?? []),
      ];
      const declaration = await registry.resolve(session.modeContext.capabilityId);
      if (declaration !== null) {
        allowlist.push(...declaration.hosts);
      }
      const egress = egressConfinementCheck(request.host, allowlist);
      if (!egress.valid) {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: egress.reason,
          details: { sessionId, host: request.host, mode: session.currentMode },
        });
      }
    }

    // ----- 4. POLICY admission per action (the gate — before dispatch). ----
    const actionPolicy = await policy.admit({
      tenantId: session.tenantId,
      applicationId,
      executionId: session.executionId,
      toolFact: `computer-use:action:${request.actionType}`,
      providerCapabilityId: session.modeContext.capabilityId,
      hosts: request.host === undefined ? [] : [request.host],
      secretRef: session.admission.secretRef,
    });

    // ----- 5. Durable action claim (the §14 intent boundary; the claim
    // PINS the action identity before any dispatch). -----------------------
    const begun = await store.beginComputerUseOperation({
      operationId: deps.generateId(),
      applicationId,
      tenantId: session.tenantId,
      sessionId,
      executionId: session.executionId,
      operationKind: "action-dispatch",
      operationKey,
      requestFingerprint: canonicalComputerUseJson({
        actionType: request.actionType,
        target: request.target,
        input: request.input,
        mode: session.currentMode,
      }),
      createdAt: iso(),
    });
    if (begun.record.status === "completed") {
      const completed = await store.findActionByKey(applicationId, sessionId, actionKey);
      if (completed !== null) {
        assertActionReplayFingerprint(completed);
        return actionResultOf(session, completed, [], true);
      }
      await store.failOperation(
        applicationId,
        operationKey,
        "the action-dispatch operation is completed but its action row is missing (durable-state divergence)",
        iso(),
      );
      throw new PlatformError({
        code: "TOOL_ERROR",
        message: "computer-use action state diverged (completed operation without an action row)",
      });
    }
    const durableActionId =
      (begun.record.stage?.actionId as string | undefined) ?? deps.generateId();
    if (begun.record.stage?.actionId === undefined) {
      await store.recordOperationCheckpoint(
        applicationId,
        operationKey,
        { actionId: durableActionId },
        iso(),
      );
    }

    if (!actionPolicy.allowed) {
      // Journal-then-fail: the denial is durable on the action axis; ZERO
      // environment activity happened for this action. The denied row
      // consumes the NEXT gapless action sequence (denied requests are
      // still ordered trajectory evidence).
      await store.insertAction({
        actionId: durableActionId,
        applicationId,
        tenantId: session.tenantId,
        sessionId,
        executionId: session.executionId,
        actionKey,
        sequence: (await store.listActions(applicationId, sessionId)).length + 1,
        mode: session.currentMode,
        actionType: request.actionType,
        target: request.target,
        sideEffect: ACTION_SIDE_EFFECTS[request.actionType],
        capabilityId: session.modeContext.capabilityId,
        inputDigest: deps.digest(inputJson),
        requestedAt: iso(),
      });
      const deniedAction = await store.finalizeAction({
        applicationId,
        actionId: durableActionId,
        status: "denied",
        failureClass: "policy",
        failureMessage: actionPolicy.reason.slice(0, 512),
        resultDigest: null,
        usageMicroUsd: null,
        environmentRef: null,
        sandboxExecutionId: null,
        observationSequences: [],
        dispatchedAt: null,
        completedAt: iso(),
        durationMs: null,
        ledgerResultSequence: null,
      });
      await appendEvent(
        applicationId,
        session.executionId,
        durableActionId,
        session.tenantId,
        "tool-denied",
        "computer-use-action",
        {
          sessionId,
          actionId: durableActionId,
          actionType: request.actionType,
          denialClass: "policy",
        },
        { denied: true, denialClass: "policy", reason: actionPolicy.reason },
        ledgerKey(durableActionId, "action-denied"),
      );
      await store.failOperation(
        applicationId,
        operationKey,
        `POLICY_DENIED: ${actionPolicy.reason}`.slice(0, 512),
        iso(),
      );
      return actionResultOf(session, deniedAction, [], false);
    }

    let actionRecord: ComputerUseActionRecord;
    if (existingAction !== null) {
      // A prior process claimed the action and died mid-dispatch: the
      // keyed environment seam converges the re-dispatch (exactly one
      // external effect per stable key).
      actionRecord = existingAction;
    } else {
      const actionSequence = (await store.listActions(applicationId, sessionId)).length + 1;
      const claimed = await store.insertAction({
        actionId: durableActionId,
        applicationId,
        tenantId: session.tenantId,
        sessionId,
        executionId: session.executionId,
        actionKey,
        sequence: actionSequence,
        mode: session.currentMode,
        actionType: request.actionType,
        target: request.target,
        sideEffect: ACTION_SIDE_EFFECTS[request.actionType],
        capabilityId: session.modeContext.capabilityId,
        inputDigest: deps.digest(inputJson),
        requestedAt: iso(),
      });
      if (claimed.status === "existing") {
        if (claimed.fingerprintMismatch) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "action key was already used with a different request",
            details: { actionId: claimed.record.id },
          });
        }
        return actionResultOf(session, claimed.record, [], true);
      }
      actionRecord = claimed.record;
    }

    // ----- 6. Ledger intent event (deterministic payload, keyed). ----------
    const requestedSequence = await appendEvent(
      applicationId,
      session.executionId,
      durableActionId,
      session.tenantId,
      "tool-requested",
      "computer-use-action",
      {
        sessionId,
        actionId: durableActionId,
        actionType: request.actionType,
        mode: session.currentMode,
        capabilityId: session.modeContext.capabilityId,
        inputDigest: actionRecord.inputDigest,
      },
      {
        sessionId,
        actionId: durableActionId,
        phase: "action-requested",
        actionType: request.actionType,
        mode: session.currentMode,
        sideEffect: actionRecord.sideEffect,
      },
      ledgerKey(durableActionId, "action-requested"),
    );
    actionRecord = await store.bindActionLedgerSequence({
      applicationId,
      actionId: durableActionId,
      phase: "requested",
      sequence: requestedSequence,
    });

    // ----- 7. Budget guard (usage stays under the route ceiling). ----------
    const declaration = await registry.resolve(session.modeContext.capabilityId);
    const actionCost = declaration?.estimatedMicroUsd ?? "0";
    const usageAfter = BigInt(session.usageMicroUsd) + BigInt(actionCost);
    if (
      session.admission.costCeilingMicroUsd !== "0" &&
      usageAfter > BigInt(session.admission.costCeilingMicroUsd)
    ) {
      await store.finalizeAction({
        applicationId,
        actionId: durableActionId,
        status: "denied",
        failureClass: "budget",
        failureMessage: `action usage would exceed the admitted route cost ceiling ${session.admission.costCeilingMicroUsd}`,
        resultDigest: null,
        usageMicroUsd: null,
        environmentRef: null,
        sandboxExecutionId: null,
        observationSequences: [],
        dispatchedAt: null,
        completedAt: iso(),
        durationMs: null,
        ledgerResultSequence: null,
      });
      await appendEvent(
        applicationId,
        session.executionId,
        durableActionId,
        session.tenantId,
        "tool-denied",
        "computer-use-action",
        { sessionId, actionId: durableActionId, denialClass: "budget" },
        { denied: true, denialClass: "budget", reason: "route cost ceiling exceeded" },
        ledgerKey(durableActionId, "action-denied"),
      );
      await store.failOperation(
        applicationId,
        operationKey,
        "BUDGET_EXCEEDED: action usage would exceed the admitted route cost ceiling",
        iso(),
      );
      throw new PlatformError({
        code: "BUDGET_EXCEEDED",
        message: "computer-use action usage would exceed the admitted route cost ceiling",
        details: { sessionId, actionId: durableActionId },
      });
    }

    // ----- 8. Dispatch (terminal → the approved sandbox; everything else
    // → the isolated environment) — the ONLY external interactions. --------
    const dispatchedAt = iso();
    const startedAt = Date.now();
    let outcome:
      | { kind: "env"; result: Awaited<ReturnType<typeof environment.dispatchAction>> }
      | { kind: "terminal"; run: Awaited<ReturnType<typeof terminal.execute>> };
    try {
      if (request.actionType === "terminal-exec") {
        if (session.modeContext.terminalPolicy === null) {
          throw new PlatformError({
            code: "POLICY_DENIED",
            message:
              "the session's current mode declares no terminal policy; terminal actions are confined out",
          });
        }
        const command = typeof request.input.command === "string" ? request.input.command : "";
        const args = Array.isArray(request.input.args)
          ? request.input.args.filter((arg): arg is string => typeof arg === "string")
          : [];
        if (command.length === 0 || command.includes("\0") || command.includes(" ")) {
          throw new PlatformError({
            code: "POLICY_DENIED",
            message:
              "terminal-exec requires a shell-free command in input.command (argv, never a shell)",
          });
        }
        const publicEnv: Record<string, string> = {};
        if (
          request.input.publicEnv !== null &&
          typeof request.input.publicEnv === "object" &&
          !Array.isArray(request.input.publicEnv)
        ) {
          for (const [name, value] of Object.entries(
            request.input.publicEnv as Record<string, unknown>,
          )) {
            if (typeof value === "string" && !containsRawSecretValue(value)) {
              publicEnv[name] = value;
            }
          }
        }
        outcome = {
          kind: "terminal",
          run: await terminal.execute(
            {
              applicationId,
              tenantId: session.tenantId,
              sessionId,
              executionId: session.executionId,
              actionId: durableActionId,
              command,
              args,
              publicEnv,
              terminalPolicy: session.modeContext.terminalPolicy,
              timeoutMs: 60_000,
              actor: { actorId: durableActionId, tenantId: session.tenantId },
            },
            `${COMPUTER_USE_KEY_PREFIXES.envActionExternal}:${sessionId}:${actionKey}`,
          ),
        };
      } else {
        if (session.environmentRef === null) {
          throw new PlatformError({
            code: "INVALID_STATE_TRANSITION",
            message: "the session's isolated environment is not open; no action may be dispatched",
          });
        }
        outcome = {
          kind: "env",
          result: await environment.dispatchAction(
            {
              environmentRef: session.environmentRef,
              sessionId,
              executionId: session.executionId,
              mode: session.currentMode,
              actionType: request.actionType,
              target: request.target,
              input: request.input,
              sideEffect: actionRecord.sideEffect,
            },
            `${COMPUTER_USE_KEY_PREFIXES.envActionExternal}:${sessionId}:${actionKey}`,
          ),
        };
      }
    } catch (error) {
      // The dispatch itself failed (typed): a durable failure record —
      // never a fabricated success (the honest outcome).
      const failureMessage = error instanceof Error ? error.message : String(error);
      actionRecord = await store.finalizeAction({
        applicationId,
        actionId: durableActionId,
        status: "failed",
        failureClass: "environment-dispatch",
        failureMessage: failureMessage.slice(0, 512),
        resultDigest: null,
        usageMicroUsd: null,
        environmentRef: session.environmentRef,
        sandboxExecutionId: null,
        observationSequences: [],
        dispatchedAt,
        completedAt: iso(),
        durationMs: Date.now() - startedAt,
        ledgerResultSequence: null,
      });
      await appendEvent(
        applicationId,
        session.executionId,
        durableActionId,
        session.tenantId,
        "tool-result",
        "computer-use-action",
        { sessionId, actionId: durableActionId, actionType: request.actionType },
        {
          sessionId,
          actionId: durableActionId,
          phase: "action-failed",
          failureClass: "environment-dispatch",
        },
        ledgerKey(durableActionId, "action-result"),
      );
      await store.failOperation(
        applicationId,
        operationKey,
        `environment-dispatch: ${failureMessage}`.slice(0, 512),
        iso(),
      );
      return actionResultOf(session, actionRecord, [], false);
    }

    // ----- 9. Observations (append-only, digest-protected, retention). -----
    const observationSequences: number[] = [];
    const recordedObservations: ComputerUseObservationRecord[] = [];
    // Crash-window convergence (the observation axis): a prior process
    // may have already recorded THIS action's frames before dying (the
    // action row is still `dispatching`); the retry converges onto the
    // SAME observation rows by (action, observation type, content
    // digest) — never a duplicate append.
    const priorObservations = (await store.listObservations(applicationId, sessionId)).filter(
      (observation) => observation.actionId === durableActionId,
    );
    const frames = (
      outcome.kind === "env"
        ? outcome.result.observations
        : [
            {
              observationType: "terminal-output" as const,
              body: {
                stdout: (outcome.run.stdout ?? "").slice(0, COMPUTER_USE_OBSERVATION_CONTENT_MAX),
                stderr: (outcome.run.stderr ?? "").slice(0, COMPUTER_USE_OBSERVATION_CONTENT_MAX),
              },
              retention: "execution" as const,
              redaction: "sensitive-ui" as const,
              artifactRef: null,
            },
          ]
    ).map((frame) => ({ frame }));
    for (const { frame } of frames) {
      const bodyDigest = computerUseObservationDigest(frame.body, deps.digest);
      const serialized = canonicalComputerUseJson(frame.body);
      if (serialized.split("\n").some((line) => containsRawSecretValue(line))) {
        // Secret-bearing observation content is REFUSED before persistence
        // (the evidence model: secrets never persist, never serialize).
        const deniedAction = await store.finalizeAction({
          applicationId,
          actionId: durableActionId,
          status: "failed",
          failureClass: "secret-bearing-observation",
          failureMessage:
            "the observation content matches raw-secret shapes; the action fails closed before persistence",
          resultDigest: null,
          usageMicroUsd: null,
          environmentRef: session.environmentRef,
          sandboxExecutionId: outcome.kind === "terminal" ? outcome.run.sandboxExecutionId : null,
          observationSequences: [...observationSequences],
          dispatchedAt,
          completedAt: iso(),
          durationMs: Date.now() - startedAt,
          ledgerResultSequence: null,
        });
        await store.failOperation(
          applicationId,
          operationKey,
          "secret-bearing-observation: observation content matched raw-secret shapes",
          iso(),
        );
        return actionResultOf(session, deniedAction, [], false);
      }
      const expectedTypes = ACTION_OBSERVATION_TYPES[request.actionType];
      if (!expectedTypes.includes(frame.observationType)) {
        continue;
      }
      const prior = priorObservations.find(
        (observation) =>
          observation.observationType === frame.observationType &&
          observation.contentDigest === bodyDigest,
      );
      if (prior !== undefined) {
        // The prior process's row for this frame: converge onto it.
        observationSequences.push(prior.sequence);
        recordedObservations.push(prior);
        continue;
      }
      const observationSequence =
        (await store.listObservations(applicationId, sessionId)).length + 1;
      const inserted = await store.insertObservation({
        id: deps.generateId(),
        applicationId,
        tenantId: session.tenantId,
        sessionId,
        executionId: session.executionId,
        sequence: observationSequence,
        observationType: frame.observationType,
        mode: session.currentMode,
        contentDigest: bodyDigest,
        retention: frame.retention,
        redaction: frame.redaction,
        content:
          frame.retention === "ephemeral"
            ? null
            : serialized.slice(0, COMPUTER_USE_OBSERVATION_CONTENT_MAX),
        artifactRef: frame.artifactRef,
        capabilityId: session.modeContext.capabilityId,
        actionId: durableActionId,
        observedAt: iso(),
        ledgerSequence: null,
      });
      if (inserted.status === "conflict") {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: `observation sequence conflict: ${inserted.reason}`,
        });
      }
      observationSequences.push(inserted.record.sequence);
      recordedObservations.push(inserted.record);
    }

    // ----- 10. Outcome finalization + ledger evidence. ---------------------
    const succeeded =
      outcome.kind === "env"
        ? outcome.result.outcome === "succeeded"
        : outcome.run.outcome === "succeeded";
    const usageMicroUsd =
      outcome.kind === "env"
        ? outcome.result.usageMicroUsd
        : (declaration?.estimatedMicroUsd ?? "0");
    const resultBody =
      outcome.kind === "env"
        ? (outcome.result.result ?? {})
        : { stdout: outcome.run.stdout, stderr: outcome.run.stderr };
    const resultDigest = succeeded ? deps.digest(canonicalComputerUseJson(resultBody)) : null;
    actionRecord = await store.finalizeAction({
      applicationId,
      actionId: durableActionId,
      status: succeeded ? "succeeded" : "failed",
      failureClass:
        outcome.kind === "env"
          ? (outcome.result.failure?.failureClass ?? null)
          : outcome.run.failureClass,
      failureMessage:
        outcome.kind === "env"
          ? (outcome.result.failure?.message ?? null)
          : outcome.run.failureMessage,
      resultDigest,
      usageMicroUsd: succeeded ? usageMicroUsd : null,
      environmentRef: outcome.kind === "env" ? session.environmentRef : null,
      sandboxExecutionId: outcome.kind === "terminal" ? outcome.run.sandboxExecutionId : null,
      observationSequences: [...observationSequences],
      dispatchedAt,
      completedAt: iso(),
      durationMs: Date.now() - startedAt,
      ledgerResultSequence: null,
    });
    const currentSession = await store.findSession(applicationId, sessionId);
    if (currentSession !== null) {
      await store.patchSession({
        applicationId,
        sessionId,
        environmentRef: session.environmentRef,
        environmentOpenedMode: session.environmentOpenedMode,
        usageMicroUsd: (
          BigInt(currentSession.usageMicroUsd) + BigInt(usageMicroUsd === "" ? "0" : usageMicroUsd)
        ).toString(),
        updatedAt: iso(),
      });
    }
    const resultSequence = await appendEvent(
      applicationId,
      session.executionId,
      durableActionId,
      session.tenantId,
      "tool-result",
      "computer-use-action",
      {
        sessionId,
        actionId: durableActionId,
        actionType: request.actionType,
        mode: session.currentMode,
        resultDigest,
        observationSequences: [...observationSequences],
      },
      {
        sessionId,
        actionId: durableActionId,
        phase: "action-completed",
        actionType: request.actionType,
        mode: session.currentMode,
        sideEffect: actionRecord.sideEffect,
        succeeded,
        observationCount: observationSequences.length,
      },
      ledgerKey(durableActionId, "action-result"),
    );
    actionRecord = await store.bindActionLedgerSequence({
      applicationId,
      actionId: durableActionId,
      phase: "result",
      sequence: resultSequence,
    });
    await store.completeOperation(applicationId, operationKey, iso());
    return actionResultOf(currentSession ?? session, actionRecord, recordedObservations, false);
  };

  // -----------------------------------------------------------------------
  // escalate (deterministic → browser → desktop; full re-admission)
  // -----------------------------------------------------------------------

  /**
   * Verify the escalation's insufficiency evidence against the DURABLE
   * journal: a referenced failing action must exist, belong to this
   * session, belong to the claimed stage, and be failed; the digest must
   * match the recorded outcome digest. Otherwise the escalation must cite
   * the route's recorded non-sufficient decision (replayable from the
   * route evidence). A fabricated escalation fails closed here.
   */
  const verifyInsufficiencyEvidence = (
    session: ComputerUseSessionRecord,
    request: ComputerUseEscalationRequest,
    actions: readonly ComputerUseActionRecord[],
  ): string => {
    const failedActionId = request.insufficiency.failedActionId;
    if (failedActionId !== null) {
      const action = actions.find((item) => item.id === failedActionId);
      if (action === undefined) {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: `the referenced insufficiency action ${failedActionId} is not recorded in this session`,
        });
      }
      if (action.mode !== request.insufficiency.stage) {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: `the referenced insufficiency action belongs to mode ${action.mode}, not ${request.insufficiency.stage}`,
        });
      }
      if (action.status !== "failed") {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: `the referenced insufficiency action ${failedActionId} is ${action.status}; only a recorded failure of the prior stage justifies escalation`,
        });
      }
      const expected = deps.digest(
        canonicalComputerUseJson({
          actionId: action.id,
          status: action.status,
          failureClass: action.failureClass,
          resultDigest: action.resultDigest,
        }),
      );
      if (request.insufficiency.evidenceDigest !== expected) {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message:
            "the insufficiency evidence digest does not match the recorded action outcome (fabricated escalation)",
        });
      }
      return expected;
    }
    // Route-level insufficiency: the recorded decision must be
    // non-sufficient AND the escalating stage must be deterministic.
    if (session.routeEvidence.deterministicFirst === "sufficient") {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message:
          "the route evidence records a SUFFICIENT deterministic route; escalating without a recorded insufficiency would displace a high-confidence deterministic route",
      });
    }
    if (session.currentMode !== "deterministic") {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "route-level insufficiency escalation is only valid from the deterministic stage",
      });
    }
    return deps.digest(
      canonicalComputerUseJson({
        routeDecision: session.routeEvidence.decision,
        stage: session.currentMode,
        reasonCode: request.insufficiency.reasonCode,
      }),
    );
  };

  const escalate = async (
    applicationId: string,
    sessionId: string,
    request: ComputerUseEscalationRequest,
    idempotencyKey: string,
  ): Promise<ComputerUseSessionReceipt> => {
    if (!KEY_PATTERN.test(idempotencyKey)) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "computer-use escalation requires a non-empty printable idempotency key",
      });
    }
    const session = await store.findSession(applicationId, sessionId);
    if (session === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "computer-use session not found in this application",
        details: { sessionId },
      });
    }
    if (isTerminalComputerUseSessionStatus(session.status)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `computer-use session is terminal in ${session.status}; no escalation may occur`,
        details: { sessionId, status: session.status },
      });
    }

    // ----- 0. Committed-escalation replay convergence. --------------------
    // The escalation ROW is the durable commit point of an escalation
    // (physical UNIQUE (session, to_mode)). A retry of an already-committed
    // escalation — a client replay, or a crash AFTER the row landed —
    // converges on the committed outcome REGARDLESS of the session's
    // current mode (the stage/ladder guards below describe only NEW
    // escalations and would otherwise refuse the replay). The convergence
    // also repairs the mid-crash window between the escalation row and
    // the session mode move: the row is the truth, the mode move is
    // convergent side work.
    const committedEscalation = (await store.listEscalations(applicationId, sessionId)).find(
      (escalation) => escalation.toMode === request.targetMode,
    );
    if (committedEscalation !== undefined) {
      const current = (await store.findSession(applicationId, sessionId)) ?? session;
      if (!isTerminalComputerUseSessionStatus(current.status)) {
        let converged = current;
        const committedDeclaration = await registry.resolve(committedEscalation.capabilityId);
        const modeLags =
          COMPUTER_USE_MODES.indexOf(current.currentMode) <
          COMPUTER_USE_MODES.indexOf(committedEscalation.toMode);
        if (modeLags && committedDeclaration !== null) {
          // The mid-crash window: the row committed but the mode move was
          // lost — converge it from the recorded escalation.
          converged = await store.patchSession({
            applicationId,
            sessionId,
            environmentRef: null,
            environmentOpenedMode: null,
            currentMode: committedEscalation.toMode,
            currentCapabilityId: committedEscalation.capabilityId,
            currentEnvelope: modeContextOf(committedDeclaration),
            escalationCount: committedEscalation.sequence,
            updatedAt: iso(),
          });
        }
        if (converged.environmentRef === null) {
          const declaration =
            committedDeclaration ?? (await registry.resolve(converged.modeContext.capabilityId));
          if (declaration === null) {
            throw new PlatformError({
              code: "CAPABILITY_UNAVAILABLE",
              message: `the session's capability ${converged.modeContext.capabilityId} is no longer registered`,
            });
          }
          converged = await openEnvironment(
            converged,
            declaration,
            computerUseEnvOpenKey(sessionId, converged.currentMode),
            `${COMPUTER_USE_KEY_PREFIXES.envOpenExternal}:${sessionId}:${converged.currentMode}`,
          );
        }
        // Crash-window convergence (the evidence): a process that died
        // between the escalation insert and the admitted-event append
        // leaves the committed row without its ledger evidence; the
        // KEYED append converges it exactly once.
        await appendEvent(
          applicationId,
          session.executionId,
          committedEscalation.id,
          session.tenantId,
          "tool-requested",
          "computer-use-escalation",
          {
            sessionId,
            escalationId: committedEscalation.id,
            fromMode: committedEscalation.fromMode,
            toMode: committedEscalation.toMode,
            reasonCode: committedEscalation.reasonCode,
            insufficiencyDigest: committedEscalation.insufficiencyDigest,
            capabilityId: committedEscalation.capabilityId,
          },
          {
            sessionId,
            phase: "escalation-admitted",
            fromMode: committedEscalation.fromMode,
            toMode: committedEscalation.toMode,
            reasonCode: committedEscalation.reasonCode,
          },
          ledgerKey(committedEscalation.id, "escalation-admitted"),
        );
        // Converge the operation row onto the committed outcome.
        const operation = await store.findOperation(
          applicationId,
          computerUseEscalationKey(sessionId, request.targetMode),
        );
        if (operation !== null && operation.status === "pending") {
          await store.completeOperation(
            applicationId,
            computerUseEscalationKey(sessionId, request.targetMode),
            iso(),
          );
        }
      }
      const replayed = (await store.findSession(applicationId, sessionId)) ?? session;
      return receiptOf(replayed, true);
    }

    const targetCheck = escalationTargetCheck(session.currentMode, request.targetMode);
    if (!targetCheck.valid) {
      throw new PlatformError({ code: "POLICY_DENIED", message: targetCheck.reason });
    }
    if (request.insufficiency.stage !== session.currentMode) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: `the insufficiency evidence references stage ${request.insufficiency.stage} but the session's current mode is ${session.currentMode}`,
      });
    }
    const insufficiencyDigest = verifyInsufficiencyEvidence(
      session,
      request,
      await store.listActions(applicationId, sessionId),
    );

    const operationKey = computerUseEscalationKey(sessionId, request.targetMode);
    const begun = await store.beginComputerUseOperation({
      operationId: deps.generateId(),
      applicationId,
      tenantId: session.tenantId,
      sessionId,
      executionId: session.executionId,
      operationKind: "escalation",
      operationKey,
      requestFingerprint: canonicalComputerUseJson({
        targetMode: request.targetMode,
        reasonCode: request.insufficiency.reasonCode,
        insufficiencyDigest,
      }),
      createdAt: iso(),
    });
    if (begun.record.status === "completed") {
      // The operation row says completed but no escalation row exists for
      // this target mode: durable-state divergence (the escalation row is
      // the commit point and always precedes the operation completion).
      await store.failOperation(
        applicationId,
        operationKey,
        "the escalation operation is completed but its escalation row is missing (durable-state divergence)",
        iso(),
      );
      throw new PlatformError({
        code: "TOOL_ERROR",
        message:
          "computer-use escalation state diverged (completed operation without an escalation row)",
      });
    }
    const escalationId =
      (begun.record.stage?.escalationId as string | undefined) ?? deps.generateId();
    if (begun.record.stage?.escalationId === undefined) {
      await store.recordOperationCheckpoint(applicationId, operationKey, { escalationId }, iso());
    }

    // The target stage's capability (from the recorded route evidence).
    const targetStage = session.routeEvidence.route.find(
      (stage) => stage.mode === request.targetMode,
    );
    if (targetStage === undefined) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: `the recorded route contains no ${request.targetMode} stage; the escalation is unrepresentable`,
      });
    }
    const targetDeclaration = await registry.resolve(targetStage.capabilityId);
    if (targetDeclaration === null) {
      throw new PlatformError({
        code: "CAPABILITY_UNAVAILABLE",
        message: `the routed ${request.targetMode} capability ${targetStage.capabilityId} is not registered`,
      });
    }

    // ----- Full re-admission for the NEW stage (gates at EVERY stage). ----
    const policyDecision = await policy.admit({
      tenantId: session.tenantId,
      applicationId,
      executionId: session.executionId,
      toolFact: `computer-use:escalation:${request.targetMode}`,
      providerCapabilityId: targetDeclaration.capabilityId,
      hosts: [...targetDeclaration.hosts],
      secretRef: targetDeclaration.secretRef,
    });
    if (!policyDecision.allowed) {
      await store.failOperation(
        applicationId,
        operationKey,
        `POLICY_DENIED: ${policyDecision.reason}`.slice(0, 512),
        iso(),
      );
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: `computer-use escalation to ${request.targetMode} denied (policy): ${policyDecision.reason}`,
        details: { sessionId, targetMode: request.targetMode },
      });
    }
    const resolution = await capabilities.resolve({
      requirementAtoms: [`computer-use-${request.targetMode}`],
    });
    if (!resolution.satisfied) {
      await store.failOperation(
        applicationId,
        operationKey,
        `CAPABILITY_UNAVAILABLE: ${resolution.unmet.join(", ")}`.slice(0, 512),
        iso(),
      );
      throw new PlatformError({
        code: "CAPABILITY_UNAVAILABLE",
        message: `computer-use escalation to ${request.targetMode} denied (capability): ${resolution.unmet.join(", ")}`,
        details: { sessionId, targetMode: request.targetMode },
      });
    }
    if (targetDeclaration.secretRef !== null && session.admission.secretGrantRef === null) {
      await store.failOperation(
        applicationId,
        operationKey,
        "AUTHORIZATION_DENIED: the escalated stage requires a mediated credential the session never obtained",
        iso(),
      );
      throw new PlatformError({
        code: "AUTHORIZATION_DENIED",
        message: `computer-use escalation to ${request.targetMode} denied: the stage requires a mediated credential the session never obtained`,
      });
    }

    // ----- Durable escalation row + mode move + new environment. ----------
    const existingEscalations = await store.listEscalations(applicationId, sessionId);
    const inserted = await store.insertEscalation({
      id: escalationId,
      applicationId,
      tenantId: session.tenantId,
      sessionId,
      sequence: existingEscalations.length + 1,
      fromMode: session.currentMode,
      toMode: request.targetMode,
      reasonCode: request.insufficiency.reasonCode,
      reasonDetail: request.insufficiency.reasonDetail.slice(0, 500),
      insufficiencyDigest,
      capabilityId: targetDeclaration.capabilityId,
      admittedAt: iso(),
      ledgerSequence: null,
    });
    await appendEvent(
      applicationId,
      session.executionId,
      escalationId,
      session.tenantId,
      "tool-requested",
      "computer-use-escalation",
      {
        sessionId,
        escalationId,
        fromMode: session.currentMode,
        toMode: request.targetMode,
        reasonCode: request.insufficiency.reasonCode,
        insufficiencyDigest,
        capabilityId: targetDeclaration.capabilityId,
      },
      {
        sessionId,
        phase: "escalation-admitted",
        fromMode: session.currentMode,
        toMode: request.targetMode,
        reasonCode: request.insufficiency.reasonCode,
      },
      ledgerKey(escalationId, "escalation-admitted"),
    );
    const patched = await store.patchSession({
      applicationId,
      sessionId,
      environmentRef: null,
      environmentOpenedMode: null,
      currentMode: request.targetMode,
      currentCapabilityId: targetDeclaration.capabilityId,
      currentEnvelope: modeContextOf(targetDeclaration),
      escalationCount: inserted.record.sequence,
      updatedAt: iso(),
    });
    await store.completeOperation(applicationId, operationKey, iso());
    const withEnvironment = await openEnvironment(
      patched,
      targetDeclaration,
      computerUseEnvOpenKey(sessionId, request.targetMode),
      `${COMPUTER_USE_KEY_PREFIXES.envOpenExternal}:${sessionId}:${request.targetMode}`,
    );
    return receiptOf(withEnvironment, inserted.status === "existing");
  };

  // -----------------------------------------------------------------------
  // terminate (terminal move + environment close + budget settlement)
  // -----------------------------------------------------------------------

  const terminate = async (
    applicationId: string,
    sessionId: string,
    cause: "completed" | "failed" | "cancelled",
    idempotencyKey: string,
  ): Promise<ComputerUseSessionReceipt> => {
    if (!KEY_PATTERN.test(idempotencyKey)) {
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "computer-use termination requires a non-empty printable idempotency key",
      });
    }
    const session = await store.findSession(applicationId, sessionId);
    if (session === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "computer-use session not found in this application",
        details: { sessionId },
      });
    }
    if (isTerminalComputerUseSessionStatus(session.status)) {
      if (session.terminalCause !== null && session.terminalCause !== cause) {
        // The session already terminated with a DIFFERENT cause: the
        // guarded mutation would reject the displacement; the replay
        // fast path must not silently converge past it.
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `computer-use session already terminated with cause ${session.terminalCause}; the ${cause} termination is refused`,
          details: { sessionId, status: session.status, terminalCause: session.terminalCause },
        });
      }
      // Crash-window convergence: a process that died between the
      // guarded terminal move and the settlement leaves the wallet
      // reservation dangling; the KEYED settle/release converges
      // exactly once (the terminal row is the committed-effect proof).
      if (
        budgetAuthority !== undefined &&
        session.terminalCause !== null &&
        session.admission.budgetOperationId !== null
      ) {
        const settlementScope = {
          actorId: sessionId,
          applicationId,
          tenantId: session.tenantId,
          operationId: session.admission.budgetOperationId,
        };
        try {
          if (session.terminalCause === "completed") {
            await budgetAuthority.settle(
              { ...settlementScope, actualAmountMicroUsd: session.usageMicroUsd },
              computerUseBudgetSettleKey(sessionId),
            );
          } else {
            await budgetAuthority.release(settlementScope, computerUseBudgetReleaseKey(sessionId));
          }
        } catch {
          // Settle/release are idempotent per key; a failure here must
          // not mask the replayed terminal outcome (reconciliation by
          // key).
        }
      }
      // Crash-window convergence (the evidence): a process that died
      // between the terminal move and the terminal-event append leaves
      // the durable terminal row without its ledger evidence. The
      // KEYED append converges it exactly once.
      if (session.terminalCause !== null) {
        await appendEvent(
          applicationId,
          session.executionId,
          sessionId,
          session.tenantId,
          "tool-result",
          "computer-use-session",
          {
            sessionId,
            mode: session.currentMode,
            status: session.status,
            usageMicroUsd: session.usageMicroUsd,
            escalations: session.escalationCount,
          },
          {
            sessionId,
            phase: "session-terminal",
            status: session.status,
            cause: session.terminalCause,
            usageMicroUsd: session.usageMicroUsd,
          },
          ledgerKey(sessionId, `terminal:${session.terminalCause}`),
        );
      }
      return receiptOf(session, true);
    }
    const operationKey = computerUseTerminationKey(sessionId, cause);
    const begun = await store.beginComputerUseOperation({
      operationId: deps.generateId(),
      applicationId,
      tenantId: session.tenantId,
      sessionId,
      executionId: session.executionId,
      operationKind: "termination",
      operationKey,
      requestFingerprint: canonicalComputerUseJson({ cause }),
      createdAt: iso(),
    });
    if (begun.record.status === "completed") {
      const current = await store.findSession(applicationId, sessionId);
      return receiptOf(current ?? session, true);
    }

    // Close the environment (idempotent per key) — terminal for the rail.
    if (session.environmentRef !== null) {
      const closed = await environment.close(
        { environmentRef: session.environmentRef, sessionId, cause },
        `${COMPUTER_USE_KEY_PREFIXES.envCloseExternal}:${sessionId}`,
      );
      if ("failureClass" in closed) {
        await store.failOperation(
          applicationId,
          operationKey,
          `environment-close failed (${closed.failureClass}): ${closed.message}`.slice(0, 512),
          iso(),
        );
        throw new PlatformError({
          code: "TOOL_ERROR",
          message: `the isolated computer-use environment could not be closed (${closed.failureClass}): ${closed.message}`,
        });
      }
    }

    // The guarded terminal move (first writer wins; duplicates converge).
    const moved = await store.applyGuardedSessionMutation({
      applicationId,
      sessionId,
      expectedStatus: "active",
      targetStatus: cause,
      terminalCause: cause,
      updatedAt: iso(),
    });
    if (moved.status === "rejected") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: moved.reason,
        details: { sessionId, status: moved.record.status },
      });
    }

    // Budget settlement (settle on completion with actual usage; release
    // the unspent reservation on cancel/failure) — idempotent per key.
    if (budgetAuthority !== undefined && session.admission.budgetOperationId !== null) {
      const scope = {
        actorId: sessionId,
        applicationId,
        tenantId: session.tenantId,
        operationId: session.admission.budgetOperationId,
      };
      try {
        if (cause === "completed") {
          await budgetAuthority.settle(
            { ...scope, actualAmountMicroUsd: moved.record.usageMicroUsd },
            computerUseBudgetSettleKey(sessionId),
          );
        } else {
          await budgetAuthority.release(scope, computerUseBudgetReleaseKey(sessionId));
        }
      } catch {
        // Settle/release are idempotent per key; a failure here must not
        // mask the terminal outcome (reconciliation by key).
      }
    }

    await appendEvent(
      applicationId,
      session.executionId,
      sessionId,
      session.tenantId,
      "tool-result",
      "computer-use-session",
      {
        sessionId,
        mode: moved.record.currentMode,
        status: moved.record.status,
        usageMicroUsd: moved.record.usageMicroUsd,
        escalations: moved.record.escalationCount,
      },
      {
        sessionId,
        phase: "session-terminal",
        status: moved.record.status,
        cause,
        usageMicroUsd: moved.record.usageMicroUsd,
      },
      ledgerKey(sessionId, `terminal:${cause}`),
    );
    await store.completeOperation(applicationId, operationKey, iso());
    return receiptOf(moved.record, false);
  };

  // -----------------------------------------------------------------------
  // getTrajectory (the replay/verify read)
  // -----------------------------------------------------------------------

  const getTrajectory = async (
    applicationId: string,
    sessionId: string,
  ): Promise<ComputerUseTrajectory | null> => {
    const session = await store.findSession(applicationId, sessionId);
    if (session === null) {
      return null;
    }
    const escalations = await store.listEscalations(applicationId, sessionId);
    const actions = await store.listActions(applicationId, sessionId);
    const observations = await store.listObservations(applicationId, sessionId);
    const entries: ComputerUseTrajectoryEntry[] = [
      {
        kind: "session-opened",
        sequence: 0,
        sessionId: session.id,
        executionId: session.executionId,
        mode: session.initialMode,
        taskKind: session.taskKind,
        routeDigest: deps.digest(canonicalComputerUseJson(session.routeEvidence)),
        at: session.createdAt,
      },
      ...escalations.map<ComputerUseTrajectoryEntry>((escalation) => ({
        kind: "escalation",
        sequence: escalation.sequence,
        sessionId: escalation.sessionId,
        executionId: escalation.executionId,
        fromMode: escalation.fromMode,
        toMode: escalation.toMode,
        reasonCode: escalation.reasonCode,
        insufficiencyDigest: escalation.insufficiencyDigest,
        at: escalation.admittedAt,
      })),
      ...actions.map<ComputerUseTrajectoryEntry>((action) => ({
        kind: "action",
        sequence: action.sequence,
        sessionId: action.sessionId,
        executionId: action.executionId,
        mode: action.mode,
        actionType: action.actionType,
        actionId: action.id,
        target: action.target,
        sideEffect: action.sideEffect,
        capabilityId: action.capabilityId,
        status: action.status,
        inputDigest: action.inputDigest,
        resultDigest: action.resultDigest,
        observationSequences: action.observationSequences,
        at: action.requestedAt,
      })),
      ...observations.map<ComputerUseTrajectoryEntry>((observation) => ({
        kind: "observation",
        sequence: observation.sequence,
        sessionId: observation.sessionId,
        executionId: observation.executionId,
        mode: observation.mode,
        observationType: observation.observationType,
        observationId: observation.id,
        actionId: observation.actionId,
        contentDigest: observation.contentDigest,
        retention: observation.retention,
        redaction: observation.redaction,
        artifactRef: observation.artifactRef,
        capabilityId: observation.capabilityId,
        at: observation.observedAt,
      })),
    ];
    entries.sort((left, right) => left.sequence - right.sequence);
    return { session, entries };
  };

  return {
    createSession,
    getSession: (applicationId, sessionId) => store.findSession(applicationId, sessionId),
    dispatchAction,
    escalate,
    terminate,
    getTrajectory,
  };
}
