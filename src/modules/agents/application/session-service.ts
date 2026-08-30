/**
 * Agent session service (agents module application; WORK-011).
 *
 * THE governed lifecycle of agent sessions — the admission chain and the
 * side-effect boundary of the agent fabric (the WORK-010 tool-runtime
 * discipline applied to agent sessions):
 *
 * ```text
 * createSession
 *   → identity/tenant + agent/selection resolution   (store + registry)
 *   → execution binding                              (tenant-guarded
 *                                                     executions read)
 *   → POLICY admission                               (REQUIRED seam —
 *                                                     the WORK-007 engine
 *                                                     decides effective
 *                                                     permissions and
 *                                                     autonomy)
 *   → durable session + workspace + scoped grants    (ONE transaction,
 *                                                     unique-key arbitration)
 *   → ledger evidence                                (agent-session-started:
 *                                                     inputs + authorization
 *                                                     context)
 * ```
 *
 * Authority preservation (Work Order "do not create a second …"):
 *   - policy: decided ONLY by the REQUIRED `AgentAdmission` seam — no
 *     default-allow exists (M10 unrepresentable); the effective
 *     permission set is the policy-approved INTERSECTION, never the
 *     requested set (M9);
 *   - execution lifecycle: ONLY through the executions public service —
 *     `wait-human`/`resume` transitions for approval gates, step events
 *     for evidence; agents never write execution status directly
 *     (M19/M20);
 *   - credentials: the runtime receives grant REFERENCES only — raw
 *     long-lived secrets are structurally absent from every runtime
 *     shape (M7); grants are revocable and dispatch re-validates them
 *     (M8);
 *   - approval: a policy-designated gate — a gated action cannot
 *     dispatch without an APPROVED, unexpired, unrevoked approval bound
 *     to the SAME session, execution and tenant (M12/M13/M14);
 *   - tenant: server-derived scope validated at every boundary;
 *     cross-tenant workspace/session/execution/approval access fails
 *     closed with `TENANT_SCOPE_VIOLATION`.
 *
 * Idempotency & concurrency: the session row keyed by
 * (application_id, session_key) IS the durable outcome; same key + same
 * fingerprint replays, same key + different fingerprint fails
 * `IDEMPOTENCY_KEY_REUSED`, concurrent identical creates converge
 * through PostgreSQL uniqueness arbitration (M18).
 */

import { PlatformError } from "../../../shared/errors";
import { isUuid } from "../../../shared/ids";
import type { ExecutionStatus } from "../../executions/public";
import { isTerminal } from "../../executions/public";
import { agentMayStartSessions } from "../domain/agent";
import type { AgentVersionRecord } from "../domain/agent-version";
import type { AgentApprovalRecord } from "../domain/approval";
import { approvalAuthorizesDispatch } from "../domain/approval";
import type { CredentialGrantRecord } from "../domain/credential";
import { grantIsUsable } from "../domain/credential";
import {
  type AgentSessionRecord,
  actionRequiresApproval,
  autonomyEngagesApprovalGate,
  canTransitionSession,
  type SessionLifecycleStatus,
  sessionRequestFingerprint,
} from "../domain/session";
import type { AgentWorkspaceRecord } from "../domain/workspace";
import { checkWorkspaceScope } from "../domain/workspace";
import type { AgentAdmission } from "../ports/agent-admission";
import type { AgentExecutionLedger } from "../ports/agent-execution-ledger";
import type {
  AgentProvider,
  AgentRuntimeIdentity,
  AgentSessionObservation,
  AgentSessionTask,
} from "../ports/agent-provider";
import type { AgentStore } from "../ports/agent-store";

export interface SessionActor {
  readonly actorId: string;
  readonly applicationId: string;
  readonly tenantId: string;
}

export interface CreateSessionInput {
  readonly executionId: string;
  readonly agentId: string;
  /** One-way digest of the session input (caller-derived). */
  readonly inputDigest: string;
  readonly inputArtifactRefs?: readonly string[];
}

export interface SessionActionInput {
  readonly sessionId: string;
  /** The action class (e.g. "external-write", "tool-call", "publish"). */
  readonly actionClass: string;
  /** Structured descriptor of the action (never a secret). */
  readonly descriptor: Readonly<Record<string, unknown>>;
  /** Tool capability the action exercises (validated against effective permissions). */
  readonly toolRef?: string;
}

export interface RequestApprovalInput {
  readonly sessionId: string;
  readonly actionClass: string;
  readonly descriptor: Readonly<Record<string, unknown>>;
  readonly policyBasis: string;
  readonly expiresAt?: string;
}

export interface DecideApprovalInput {
  readonly approvalId: string;
  readonly decision: "approved" | "denied";
  readonly approverId: string;
}

export interface ActionDispatchOutcome {
  readonly sessionId: string;
  readonly actionClass: string;
  readonly sequence: number;
  readonly approvalId: string | null;
}

export interface AgentSessionServiceDeps {
  readonly store: AgentStore;
  /** REQUIRED policy admission seam — no default-allow exists by design. */
  readonly admission: AgentAdmission;
  /** REQUIRED canonical execution event path — no no-op implementation exists. */
  readonly ledger: AgentExecutionLedger;
  readonly generateId: () => string;
  readonly now: () => Date;
  /** One-way digest helper for action descriptors (adapters own crypto). */
  readonly hashValue: (value: string) => string;
}

const KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;
const ACTION_CLASS_PATTERN = /^[a-z0-9][a-z0-9:-]{0,99}$/;

export function createAgentSessionService(deps: AgentSessionServiceDeps) {
  const { store, admission, ledger, generateId, now } = deps;

  const iso = () => now().toISOString();

  /** Execution statuses an agent session may be created under (live parents). */
  const sessionCreatableExecutionStatus = (status: ExecutionStatus): boolean => !isTerminal(status);

  const requireScopedSession = async (
    actor: SessionActor,
    sessionId: string,
  ): Promise<AgentSessionRecord> => {
    if (!isUuid(sessionId)) {
      throw new PlatformError({ code: "AGENT_ERROR", message: "sessionId must be a UUID" });
    }
    const session = await store.findSessionById(actor.applicationId, sessionId);
    if (session === null) {
      throw new PlatformError({
        code: "AGENT_ERROR",
        message: `agent session ${sessionId} does not exist in this application`,
        details: { sessionId },
      });
    }
    if (session.tenantId !== actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "agent session belongs to another tenant",
        details: { sessionId },
      });
    }
    return session;
  };

  const requireVersion = async (
    applicationId: string,
    versionId: string,
  ): Promise<AgentVersionRecord> => {
    const version = await store.findVersionById(applicationId, versionId);
    if (version === null) {
      throw new PlatformError({
        code: "AGENT_ERROR",
        message: "the selected agent version no longer exists",
        details: { versionId },
      });
    }
    return version;
  };

  /** Assemble the governed runtime identity (grants usable at NOW only). */
  const runtimeIdentityOf = async (session: AgentSessionRecord): Promise<AgentRuntimeIdentity> => {
    const workspace = await store.findWorkspaceBySession(session.applicationId, session.id);
    if (workspace === null) {
      throw new PlatformError({
        code: "AGENT_ERROR",
        message: "session workspace is missing",
        details: { sessionId: session.id },
      });
    }
    const scopeError = checkWorkspaceScope(workspace, {
      applicationId: session.applicationId,
      tenantId: session.tenantId,
      executionId: session.executionId,
    });
    if (scopeError !== null) {
      throw new PlatformError({ code: scopeError.code, message: scopeError.reason });
    }
    const grants = await store.listGrantsBySession(session.applicationId, session.id);
    const at = iso();
    // ONLY usable grants cross the runtime contract: revoked/expired
    // credentials are absent from the runtime identity (M8).
    const usable = grants.filter((grant) => grantIsUsable(grant.status, grant.expiresAt, at));
    return {
      executionId: session.executionId,
      sessionId: session.id,
      agentId: session.agentId,
      agentVersionId: session.agentVersionId,
      applicationId: session.applicationId,
      tenantId: session.tenantId,
      workspace: {
        workspaceId: workspace.id,
        executionId: workspace.executionId,
        sessionId: workspace.sessionId,
      },
      permissions: session.effectivePermissions,
      credentials: usable.map((grant) => ({
        grantId: grant.id,
        scopeKind: grant.scopeKind,
        scopeRef: grant.scopeRef,
      })),
      autonomy: session.autonomy,
    };
  };

  const transitionSessionRow = async (
    applicationId: string,
    sessionId: string,
    from: SessionLifecycleStatus,
    to: SessionLifecycleStatus,
    fields: Parameters<AgentStore["transitionSession"]>[3],
  ): Promise<AgentSessionRecord> => {
    if (!canTransitionSession(from, to)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `agent session cannot move ${from} -> ${to}`,
        details: { sessionId, from, to },
      });
    }
    return store.transitionSession(applicationId, sessionId, to, fields);
  };

  /** The single ledger append path for agent session evidence. */
  const appendLedgerEvent = async (
    session: AgentSessionRecord,
    command: "agent-session-started" | "agent-action-recorded" | "agent-session-completed",
    payload: Readonly<Record<string, unknown>>,
    reference: Readonly<Record<string, unknown>>,
    idempotencyKey: string,
  ): Promise<{ readonly sequence: number; readonly replayed: boolean }> => {
    // Payloads are DETERMINISTIC per logical event (no timing values) so
    // retries replay the SAME envelope; the envelope's occurredAt is the
    // authoritative "when".
    const outcome = await ledger.recordStepEvent(
      {
        applicationId: session.applicationId,
        executionId: session.executionId,
        // The session's own durable identity is the provenance actor: the
        // session acts on behalf of the requesting principal, bound to
        // the parent execution (the tools invocation-actor precedent).
        actor: { actorId: session.id, tenantId: session.tenantId },
        command,
        cause: `agent-session:${command}`,
        reference,
        payload,
      },
      idempotencyKey,
    );
    return { sequence: outcome.sequence, replayed: outcome.replayed };
  };

  return {
    /** Create the governed session identity (admission chain + durable bundle + evidence). */
    async createSession(
      input: CreateSessionInput,
      idempotencyKey: string,
      actor: SessionActor,
    ): Promise<AgentSessionRecord> {
      if (typeof idempotencyKey !== "string" || !KEY_PATTERN.test(idempotencyKey)) {
        throw new PlatformError({
          code: "AGENT_ERROR",
          message: "idempotency key must be 1..200 printable ASCII characters",
        });
      }
      if (!isUuid(input.executionId)) {
        throw new PlatformError({ code: "AGENT_ERROR", message: "executionId must be a UUID" });
      }
      if (!isUuid(input.agentId)) {
        throw new PlatformError({ code: "AGENT_ERROR", message: "agentId must be a UUID" });
      }
      if (typeof input.inputDigest !== "string" || input.inputDigest.length === 0) {
        throw new PlatformError({ code: "AGENT_ERROR", message: "inputDigest is required" });
      }
      const artifactRefs = [...(input.inputArtifactRefs ?? [])];

      // 1. Agent identity + lifecycle (registry discipline, tenant-guarded).
      const agent = await store.findAgentById(actor.applicationId, input.agentId);
      if (agent === null) {
        throw new PlatformError({
          code: "AGENT_ERROR",
          message: "agent is not registered in this application",
          details: { agentId: input.agentId },
        });
      }
      if (agent.tenantId !== actor.tenantId) {
        throw new PlatformError({
          code: "TENANT_SCOPE_VIOLATION",
          message: "agent belongs to another tenant",
          details: { agentId: agent.id },
        });
      }
      if (!agentMayStartSessions(agent.status)) {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: `agent is not available for sessions (status ${agent.status})`,
          details: { agentId: agent.id, status: agent.status },
        });
      }

      // 2. Current selection must resolve to a VALID immutable version.
      const selection = await store.latestSelectionForAgent(actor.applicationId, agent.id);
      if (selection === null) {
        throw new PlatformError({
          code: "AGENT_ERROR",
          message: "agent has no selected version; promote one first",
          details: { agentId: agent.id },
        });
      }
      const version = await requireVersion(actor.applicationId, selection.selectedVersionId);
      if (version.validationState !== "valid") {
        throw new PlatformError({
          code: "AGENT_ERROR",
          message: "the selected agent version is not validated",
          details: { versionId: version.id },
        });
      }

      // 3. Execution binding: tenant-guarded public read; the parent must
      //    be a live execution in the SAME tenant (M5/M19).
      const execution = await ledger.getExecution(actor.applicationId, input.executionId);
      if (execution === null) {
        throw new PlatformError({
          code: "TENANT_SCOPE_VIOLATION",
          message: "execution does not exist in this application",
          details: { executionId: input.executionId },
        });
      }
      if (execution.tenantId !== actor.tenantId) {
        throw new PlatformError({
          code: "TENANT_SCOPE_VIOLATION",
          message: "execution belongs to another tenant",
          details: { executionId: execution.id },
        });
      }
      if (!sessionCreatableExecutionStatus(execution.status)) {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `cannot bind an agent session to a terminal execution (${execution.status})`,
          details: { executionId: execution.id, status: execution.status },
        });
      }

      // 4. POLICY admission — the required seam decides everything the
      //    runtime will see (effective permissions, autonomy, evidence).
      const decision = await admission.admit({
        tenantId: actor.tenantId,
        applicationId: actor.applicationId,
        executionId: execution.id,
        agentId: agent.id,
        agentVersionId: version.id,
        requestedPermissions: version.definition.requestedPermissions,
        requestedAutonomy: version.definition.maxAutonomy,
      });
      if (!decision.allowed) {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message: `agent session denied by the effective policy: ${decision.reason}`,
          details: { agentId: agent.id, executionId: execution.id },
        });
      }

      // 5. Durable bundle (session + workspace + scoped grants) with
      //    unique-key arbitration; same key + same fingerprint replays.
      const fingerprint = sessionRequestFingerprint({
        applicationId: actor.applicationId,
        executionId: execution.id,
        agentId: agent.id,
        inputDigest: input.inputDigest,
        inputArtifactRefs: artifactRefs,
      });
      const existing = await store.findSessionByKey(actor.applicationId, idempotencyKey);
      if (existing !== null) {
        if (existing.requestFingerprint !== fingerprint) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "session key was already used for a different request",
            details: { sessionId: existing.id },
          });
        }
        return existing;
      }
      const sessionId = generateId();
      const workspaceId = generateId();
      const createdAt = iso();
      const claim = await store.createSessionBundle({
        session: {
          id: sessionId,
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          executionId: execution.id,
          agentId: agent.id,
          agentVersionId: version.id,
          workspaceId,
          sessionKey: idempotencyKey,
          requestFingerprint: fingerprint,
          inputDigest: input.inputDigest,
          inputArtifactRefs: artifactRefs,
          effectivePermissions: decision.effectivePermissions,
          policyEvidence: decision.evidence,
          autonomy: decision.autonomy,
          createdAt,
        },
        workspace: {
          id: workspaceId,
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          executionId: execution.id,
          sessionId,
          createdAt,
        },
        // Scoped grants issued ONLY for policy-approved refs (the
        // intersection — never the requested superset).
        grants: [
          ...decision.effectivePermissions.tools.map((tool) => ({
            id: generateId(),
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            sessionId,
            scopeKind: "tool" as const,
            scopeRef: tool,
            issuedAt: createdAt,
            expiresAt: null,
          })),
          ...decision.effectivePermissions.secretRefs.map((ref) => ({
            id: generateId(),
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            sessionId,
            scopeKind: "secret" as const,
            scopeRef: ref,
            issuedAt: createdAt,
            expiresAt: null,
          })),
          ...decision.effectivePermissions.models.map((model) => ({
            id: generateId(),
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            sessionId,
            scopeKind: "model" as const,
            scopeRef: model,
            issuedAt: createdAt,
            expiresAt: null,
          })),
        ],
      });
      if (!claim.claimed) {
        const converged = claim.record;
        if (converged.requestFingerprint !== fingerprint) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "session key was already used for a different request",
            details: { sessionId: converged.id },
          });
        }
        return converged;
      }
      const session = claim.record;

      // 6. Execution evidence: session start with inputs + authorization
      //    context (who/what/when/why provenance on the canonical ledger).
      const start = await appendLedgerEvent(
        session,
        "agent-session-started",
        {
          sessionId: session.id,
          agentId: session.agentId,
          agentVersionId: session.agentVersionId,
          workspaceId,
          inputDigest: session.inputDigest,
          inputArtifactRefs: [...session.inputArtifactRefs],
          effectivePermissions: {
            tools: [...session.effectivePermissions.tools],
            secretRefs: [...session.effectivePermissions.secretRefs],
            models: [...session.effectivePermissions.models],
          },
          autonomy: session.autonomy,
          policyEvidence: { ...session.policyEvidence },
        },
        {
          sessionId: session.id,
          agentId: session.agentId,
          agentVersionId: session.agentVersionId,
          workspaceId,
          executionId: session.executionId,
          inputDigest: session.inputDigest,
        },
        `${session.id}:agent-session-started`,
      );
      await store.bindSessionLedgerSequences(actor.applicationId, session.id, start.sequence);
      return (await store.findSessionById(actor.applicationId, session.id)) ?? session;
    },

    /** Run the governed session through an AgentProvider (the adapter seam). */
    async runSession(
      sessionId: string,
      provider: AgentProvider,
      idempotencyKey: string,
      actor: SessionActor,
    ): Promise<AgentSessionObservation> {
      const session = await requireScopedSession(actor, sessionId);
      if (session.status === "pending") {
        await transitionSessionRow(actor.applicationId, session.id, "pending", "running", {
          startedAt: iso(),
        });
      } else if (session.status !== "running") {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `agent session cannot run from status ${session.status}`,
          details: { sessionId: session.id, status: session.status },
        });
      }
      const current = (await store.findSessionById(actor.applicationId, session.id)) ?? session;
      const version = await requireVersion(actor.applicationId, current.agentVersionId);
      const identity = await runtimeIdentityOf(current);
      const task: AgentSessionTask = {
        instructions: version.definition.instructions,
        inputDigest: current.inputDigest,
        inputArtifactRefs: [...current.inputArtifactRefs],
        maxDurationMs: version.definition.maxSessionDurationMs,
      };
      const observation = await provider.executeSession(identity, task);
      const completedAt = iso();
      const terminalStatus: SessionLifecycleStatus =
        observation.outcomeClass === "session-success" ? "completed" : "failed";
      // Append the completion evidence FIRST (idempotent per key — a crash
      // between the envelope and the terminal row converges on retry),
      // then finalize the row WITH the ledger sequence bound in the same
      // guarded update (terminal rows are physically immutable after).
      const end = await appendLedgerEvent(
        current,
        "agent-session-completed",
        {
          sessionId: current.id,
          agentId: current.agentId,
          agentVersionId: current.agentVersionId,
          status: terminalStatus,
          outcomeClass: observation.outcomeClass,
          outputDigest: observation.outputDigest,
          failureReason: observation.failureReason,
        },
        {
          sessionId: current.id,
          agentId: current.agentId,
          agentVersionId: current.agentVersionId,
          executionId: current.executionId,
        },
        `${current.id}:agent-session-completed:${idempotencyKey}`,
      );
      await transitionSessionRow(actor.applicationId, current.id, "running", terminalStatus, {
        completedAt,
        outputDigest: observation.outputDigest,
        output: observation.output,
        failureReason: observation.failureReason,
        ledgerEndSequence: end.sequence,
      });
      return observation;
    },

    /**
     * THE side-effect boundary of significant agent actions (the §14
     * auditable execution boundary): every dispatch re-validates the
     * session, the effective permissions, the credential grants and —
     * for gated actions — the approval chain, BEFORE the durable action
     * evidence lands on the ledger. No other action path exists.
     */
    async recordAction(
      input: SessionActionInput,
      idempotencyKey: string,
      actor: SessionActor,
    ): Promise<ActionDispatchOutcome> {
      if (typeof input.actionClass !== "string" || !ACTION_CLASS_PATTERN.test(input.actionClass)) {
        throw new PlatformError({
          code: "AGENT_ERROR",
          message: "actionClass must be a lowercase action identifier",
        });
      }
      if (typeof idempotencyKey !== "string" || !KEY_PATTERN.test(idempotencyKey)) {
        throw new PlatformError({
          code: "AGENT_ERROR",
          message: "idempotency key must be 1..200 printable ASCII characters",
        });
      }
      const session = await requireScopedSession(actor, input.sessionId);
      if (session.status !== "running") {
        // waiting-approval blocks ALL dispatch (side effect impossible
        // before the approval decision — M13).
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `agent session cannot dispatch actions from status ${session.status}`,
          details: { sessionId: session.id, status: session.status },
        });
      }
      const version = await requireVersion(actor.applicationId, session.agentVersionId);

      // Tool actions: the effective permission set AND a usable grant are
      // BOTH required (M11 permission bypass + M8 revoked credential).
      let grantId: string | null = null;
      if (input.toolRef !== undefined) {
        if (!session.effectivePermissions.tools.includes(input.toolRef)) {
          throw new PlatformError({
            code: "AUTHORIZATION_DENIED",
            message: `tool "${input.toolRef}" is not in the session's effective permissions`,
            details: { sessionId: session.id, toolRef: input.toolRef },
          });
        }
        const grants = await store.listGrantsBySession(actor.applicationId, session.id);
        const grant = grants.find(
          (candidate) =>
            candidate.scopeKind === "tool" &&
            candidate.scopeRef === input.toolRef &&
            grantIsUsable(candidate.status, candidate.expiresAt, iso()),
        );
        if (grant === undefined) {
          throw new PlatformError({
            code: "AUTHORIZATION_DENIED",
            message: `no usable credential grant for tool "${input.toolRef}"`,
            details: { sessionId: session.id, toolRef: input.toolRef },
          });
        }
        grantId = grant.id;
      }

      // Approval gate: policy-designated for configured high-risk actions.
      const gated =
        actionRequiresApproval(input.actionClass, version.definition) &&
        autonomyEngagesApprovalGate(session.autonomy);
      let approvalId: string | null = null;
      if (gated) {
        const approvals = await store.listApprovalsBySession(actor.applicationId, session.id);
        const approval = approvals.find(
          (candidate) =>
            candidate.actionClass === input.actionClass &&
            approvalAuthorizesDispatch(candidate, iso()),
        );
        if (approval === undefined) {
          // THE side effect is impossible without an approved gate
          // (M12/M13): missing / revoked / expired / wrong-action
          // approvals all land here.
          throw new PlatformError({
            code: "POLICY_DENIED",
            message: `action "${input.actionClass}" requires an approved human approval before dispatch`,
            details: { sessionId: session.id, actionClass: input.actionClass },
          });
        }
        // The approval must bind to THIS session's execution and tenant —
        // a cross-tenant/cross-execution approval never authorizes here
        // (M14): listApprovalsBySession is application+session scoped,
        // and the session row's execution/tenant are server-derived.
        approvalId = approval.id;
      }

      const outcome = await appendLedgerEvent(
        session,
        "agent-action-recorded",
        {
          sessionId: session.id,
          agentId: session.agentId,
          agentVersionId: session.agentVersionId,
          actionClass: input.actionClass,
          descriptorDigest: deps.hashValue(JSON.stringify(input.descriptor)),
          toolRef: input.toolRef ?? null,
          gated,
          approvalId,
        },
        {
          sessionId: session.id,
          agentId: session.agentId,
          agentVersionId: session.agentVersionId,
          executionId: session.executionId,
          actionClass: input.actionClass,
          ...(input.toolRef === undefined ? {} : { toolRef: input.toolRef, grantId }),
          ...(approvalId === null ? {} : { approvalId }),
        },
        `${session.id}:agent-action:${idempotencyKey}`,
      );
      return {
        sessionId: session.id,
        actionClass: input.actionClass,
        sequence: outcome.sequence,
        approvalId,
      };
    },

    /** Engage the human-approval gate for a configured high-risk action. */
    async requestApproval(
      input: RequestApprovalInput,
      idempotencyKey: string,
      actor: SessionActor,
    ): Promise<AgentApprovalRecord> {
      if (typeof idempotencyKey !== "string" || !KEY_PATTERN.test(idempotencyKey)) {
        throw new PlatformError({
          code: "AGENT_ERROR",
          message: "idempotency key must be 1..200 printable ASCII characters",
        });
      }
      if (typeof input.actionClass !== "string" || !ACTION_CLASS_PATTERN.test(input.actionClass)) {
        throw new PlatformError({
          code: "AGENT_ERROR",
          message: "actionClass must be a lowercase action identifier",
        });
      }
      const session = await requireScopedSession(actor, input.sessionId);
      if (session.status !== "running") {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `approval can only be requested from a running session (status ${session.status})`,
          details: { sessionId: session.id },
        });
      }
      const version = await requireVersion(actor.applicationId, session.agentVersionId);
      const gated =
        actionRequiresApproval(input.actionClass, version.definition) &&
        autonomyEngagesApprovalGate(session.autonomy);
      if (!gated) {
        throw new PlatformError({
          code: "POLICY_DENIED",
          message:
            "approval gate is not engaged for this action (policy-designated gates only; agents cannot fabricate approval requirements)",
          details: { actionClass: input.actionClass },
        });
      }
      const existing = await store.findApprovalByKey(actor.applicationId, idempotencyKey);
      if (existing !== null) {
        return existing;
      }
      const approvalId = generateId();
      const requestedAt = iso();
      const claim = await store.insertApproval({
        id: approvalId,
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        executionId: session.executionId,
        sessionId: session.id,
        actionClass: input.actionClass,
        actionDescriptor: input.descriptor,
        policyBasis: input.policyBasis,
        approvalKey: idempotencyKey,
        requestedAt,
        expiresAt: input.expiresAt ?? null,
      });
      if (!claim.claimed) {
        return claim.record;
      }
      // The gate manifests on the EXECUTION lifecycle (public transition):
      // RUNNING -> WAITING_HUMAN. The side effect cannot dispatch while
      // the session is waiting-approval.
      const wait = await ledger.waitHuman(
        {
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          actorId: actor.actorId,
          executionId: session.executionId,
          reason: `agent approval required: ${input.actionClass}`,
          reference: { approvalId, sessionId: session.id, actionClass: input.actionClass },
        },
        `agents.wait-human:${approvalId}`,
      );
      await store.bindApprovalLedgerSequence(actor.applicationId, approvalId, wait.sequence);
      await transitionSessionRow(
        actor.applicationId,
        session.id,
        "running",
        "waiting-approval",
        {},
      );
      return (await store.findApprovalById(actor.applicationId, approvalId)) ?? claim.record;
    },

    /** Record the human decision with full provenance and resolve the gate. */
    async decideApproval(
      input: DecideApprovalInput,
      idempotencyKey: string,
      actor: SessionActor,
    ): Promise<AgentApprovalRecord> {
      if (!isUuid(input.approvalId)) {
        throw new PlatformError({ code: "AGENT_ERROR", message: "approvalId must be a UUID" });
      }
      if (typeof idempotencyKey !== "string" || !KEY_PATTERN.test(idempotencyKey)) {
        throw new PlatformError({
          code: "AGENT_ERROR",
          message: "idempotency key must be 1..200 printable ASCII characters",
        });
      }
      const approval = await store.findApprovalById(actor.applicationId, input.approvalId);
      if (approval === null) {
        throw new PlatformError({
          code: "AGENT_ERROR",
          message: "approval request does not exist in this application",
          details: { approvalId: input.approvalId },
        });
      }
      if (approval.tenantId !== actor.tenantId) {
        // Cross-tenant approval decisions fail closed (M14).
        throw new PlatformError({
          code: "TENANT_SCOPE_VIOLATION",
          message: "approval request belongs to another tenant",
          details: { approvalId: approval.id },
        });
      }
      if (
        approval.status !== "pending" &&
        approval.status !== "approved" &&
        approval.status !== "denied"
      ) {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `approval request is ${approval.status} and cannot be decided`,
          details: { approvalId: approval.id },
        });
      }
      const decided = await store.decideApproval(
        actor.applicationId,
        approval.id,
        input.decision,
        input.approverId,
        iso(),
      );
      const session = await store.findSessionById(actor.applicationId, approval.sessionId);
      if (session !== null && session.status === "waiting-approval") {
        // Resolve the execution gate (public transition): the human gate
        // has an outcome either way.
        await ledger.resume(
          {
            applicationId: actor.applicationId,
            tenantId: actor.tenantId,
            actorId: actor.actorId,
            executionId: approval.executionId,
            reason: `agent approval ${input.decision}: ${approval.actionClass}`,
            reference: { approvalId: approval.id, decision: input.decision },
          },
          `agents.resume:${approval.id}:${input.decision}`,
        );
        if (input.decision === "approved") {
          await transitionSessionRow(
            actor.applicationId,
            session.id,
            "waiting-approval",
            "running",
            {},
          );
        } else {
          await transitionSessionRow(
            actor.applicationId,
            session.id,
            "waiting-approval",
            "failed",
            { completedAt: iso(), failureReason: `approval denied for ${approval.actionClass}` },
          );
        }
      }
      return decided;
    },

    /** Revoke an approval (post-approval revocation blocks dispatch again). */
    async revokeApproval(approvalId: string, actor: SessionActor): Promise<AgentApprovalRecord> {
      if (!isUuid(approvalId)) {
        throw new PlatformError({ code: "AGENT_ERROR", message: "approvalId must be a UUID" });
      }
      const approval = await store.findApprovalById(actor.applicationId, approvalId);
      if (approval === null) {
        throw new PlatformError({
          code: "AGENT_ERROR",
          message: "approval request does not exist in this application",
          details: { approvalId },
        });
      }
      if (approval.tenantId !== actor.tenantId) {
        throw new PlatformError({
          code: "TENANT_SCOPE_VIOLATION",
          message: "approval request belongs to another tenant",
          details: { approvalId },
        });
      }
      return store.revokeApproval(actor.applicationId, approval.id, iso());
    },

    /** Monotonic credential-grant revocation (takes effect immediately). */
    async revokeCredentialGrant(
      grantId: string,
      actor: SessionActor,
    ): Promise<CredentialGrantRecord> {
      if (!isUuid(grantId)) {
        throw new PlatformError({ code: "AGENT_ERROR", message: "grantId must be a UUID" });
      }
      // The store revocation is application-scoped and converges on the
      // committed row; tenant equality is enforced by the grant's
      // session binding (composite identity from migration 0006).
      const record = await store.revokeGrant(actor.applicationId, grantId, iso());
      if (record.tenantId !== actor.tenantId) {
        throw new PlatformError({
          code: "TENANT_SCOPE_VIOLATION",
          message: "credential grant belongs to another tenant",
          details: { grantId },
        });
      }
      return record;
    },

    async getSession(applicationId: string, sessionId: string): Promise<AgentSessionRecord | null> {
      if (!isUuid(sessionId)) {
        return null;
      }
      return store.findSessionById(applicationId, sessionId);
    },

    async listSessionsByExecution(
      applicationId: string,
      executionId: string,
    ): Promise<readonly AgentSessionRecord[]> {
      return store.listSessionsByExecution(applicationId, executionId);
    },

    async getWorkspace(
      applicationId: string,
      workspaceId: string,
    ): Promise<AgentWorkspaceRecord | null> {
      if (!isUuid(workspaceId)) {
        return null;
      }
      return store.findWorkspaceById(applicationId, workspaceId);
    },

    async listGrants(
      applicationId: string,
      sessionId: string,
    ): Promise<readonly CredentialGrantRecord[]> {
      return store.listGrantsBySession(applicationId, sessionId);
    },

    async listApprovals(
      applicationId: string,
      sessionId: string,
    ): Promise<readonly AgentApprovalRecord[]> {
      return store.listApprovalsBySession(applicationId, sessionId);
    },

    /** The governed runtime identity assembly (evidence/test surface). */
    async runtimeIdentity(sessionId: string, actor: SessionActor): Promise<AgentRuntimeIdentity> {
      const session = await requireScopedSession(actor, sessionId);
      return runtimeIdentityOf(session);
    },
  };
}

export type AgentSessionService = ReturnType<typeof createAgentSessionService>;
