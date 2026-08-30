/**
 * In-memory agent store (agents module test adapter; WORK-011).
 *
 * Mirrors the SQL adapter's arbitration/immutability semantics exactly
 * (the WORK-010 in-memory-store discipline): unique-key convergence,
 * fingerprint-mismatch rejection, write-once versions, terminal-session
 * immutability, monotonic grant revocation and guarded approval
 * decisions. Unit suites use this; real-PG suites prove the physical
 * invariants against the actual schema.
 */

import { PlatformError } from "../../../shared/errors";
import type { AgentLifecycleStatus, AgentRecord } from "../domain/agent";
import { AGENT_LIFECYCLE_TRANSITIONS } from "../domain/agent";
import type { AgentSelectionRecord, AgentVersionRecord } from "../domain/agent-version";
import type { AgentApprovalRecord } from "../domain/approval";
import type { CredentialGrantRecord } from "../domain/credential";
import type { AgentSessionRecord, SessionLifecycleStatus } from "../domain/session";
import { canTransitionSession, isTerminalSessionStatus } from "../domain/session";
import type { AgentWorkspaceRecord } from "../domain/workspace";
import type {
  AgentStore,
  ClaimOutcome,
  CreateSessionBundleInput,
  InsertAgentInput,
  InsertApprovalInput,
  InsertSelectionInput,
  InsertVersionInput,
} from "../ports/agent-store";

interface SessionState {
  record: AgentSessionRecord;
}

export class InMemoryAgentStore implements AgentStore {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly versions = new Map<string, AgentVersionRecord>();
  private readonly selections = new Map<string, AgentSelectionRecord>();
  private readonly sessions = new Map<string, SessionState>();
  private readonly sessionsByKey = new Map<string, string>();
  private readonly workspaces = new Map<string, AgentWorkspaceRecord>();
  private readonly grants = new Map<string, CredentialGrantRecord>();
  private readonly approvals = new Map<string, AgentApprovalRecord>();
  private readonly approvalsByKey = new Map<string, string>();

  // ---- agents ----

  async insertAgent(input: InsertAgentInput): Promise<ClaimOutcome<AgentRecord>> {
    for (const agent of this.agents.values()) {
      if (agent.applicationId === input.applicationId && agent.slug === input.slug) {
        return { claimed: false, record: agent };
      }
    }
    const record: AgentRecord = {
      id: input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      slug: input.slug,
      name: input.name,
      description: input.description,
      status: "registered",
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    this.agents.set(record.id, record);
    return { claimed: true, record };
  }

  async findAgentBySlug(applicationId: string, slug: string): Promise<AgentRecord | null> {
    for (const agent of this.agents.values()) {
      if (agent.applicationId === applicationId && agent.slug === slug) {
        return agent;
      }
    }
    return null;
  }

  async findAgentById(applicationId: string, agentId: string): Promise<AgentRecord | null> {
    const agent = this.agents.get(agentId);
    return agent !== undefined && agent.applicationId === applicationId ? agent : null;
  }

  async transitionAgentLifecycle(
    applicationId: string,
    agentId: string,
    next: AgentLifecycleStatus,
    updatedAt: string,
  ): Promise<AgentRecord> {
    const agent = await this.expectAgent(applicationId, agentId);
    if (agent.status === next) {
      return agent;
    }
    if (!AGENT_LIFECYCLE_TRANSITIONS[agent.status].includes(next)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `agent lifecycle cannot move ${agent.status} -> ${next}`,
      });
    }
    const updated: AgentRecord = { ...agent, status: next, updatedAt };
    this.agents.set(agentId, updated);
    return updated;
  }

  // ---- versions ----

  async insertVersion(input: InsertVersionInput): Promise<ClaimOutcome<AgentVersionRecord>> {
    for (const version of this.versions.values()) {
      if (
        version.applicationId === input.applicationId &&
        version.agentId === input.agentId &&
        version.version === input.version
      ) {
        if (version.definitionDigest !== input.definitionDigest) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: `version ${input.version} already exists with a different definition`,
          });
        }
        return { claimed: false, record: version };
      }
    }
    const record: AgentVersionRecord = {
      id: input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      agentId: input.agentId,
      version: input.version,
      definition: input.definition as unknown as AgentVersionRecord["definition"],
      definitionDigest: input.definitionDigest,
      validationState: input.validationState,
      validationNotes: input.validationNotes,
      createdAt: input.createdAt,
    };
    this.versions.set(record.id, record);
    return { claimed: true, record };
  }

  async findVersionById(
    applicationId: string,
    versionId: string,
  ): Promise<AgentVersionRecord | null> {
    const version = this.versions.get(versionId);
    return version !== undefined && version.applicationId === applicationId ? version : null;
  }

  async listVersionsByAgent(
    applicationId: string,
    agentId: string,
  ): Promise<readonly AgentVersionRecord[]> {
    return [...this.versions.values()]
      .filter((v) => v.applicationId === applicationId && v.agentId === agentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // ---- selections ----

  async insertSelection(input: InsertSelectionInput): Promise<ClaimOutcome<AgentSelectionRecord>> {
    const key = `selection:${input.applicationId}:${input.selectionKey}`;
    const existingId = this.selectionKeys.get(key);
    if (existingId !== undefined) {
      const existing = this.selections.get(existingId);
      if (existing !== undefined) {
        return { claimed: false, record: existing };
      }
    }
    const record: AgentSelectionRecord = {
      id: input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      agentId: input.agentId,
      selectedVersionId: input.selectedVersionId,
      kind: input.kind,
      rollbackOf: input.rollbackOf,
      selectedBy: input.selectedBy,
      reason: input.reason,
      selectedAt: input.selectedAt,
    };
    this.selections.set(record.id, record);
    this.selectionKeys.set(key, record.id);
    return { claimed: true, record };
  }

  private readonly selectionKeys = new Map<string, string>();

  async latestSelectionForAgent(
    applicationId: string,
    agentId: string,
  ): Promise<AgentSelectionRecord | null> {
    const all = [...this.selections.values()]
      .filter((s) => s.applicationId === applicationId && s.agentId === agentId)
      .sort((a, b) =>
        a.selectedAt === b.selectedAt
          ? a.id.localeCompare(b.id)
          : a.selectedAt.localeCompare(b.selectedAt),
      );
    return all.length > 0 ? (all[all.length - 1] ?? null) : null;
  }

  async listSelectionsForAgent(
    applicationId: string,
    agentId: string,
  ): Promise<readonly AgentSelectionRecord[]> {
    return [...this.selections.values()]
      .filter((s) => s.applicationId === applicationId && s.agentId === agentId)
      .sort((a, b) =>
        a.selectedAt === b.selectedAt
          ? a.id.localeCompare(b.id)
          : a.selectedAt.localeCompare(b.selectedAt),
      );
  }

  // ---- sessions ----

  async createSessionBundle(
    input: CreateSessionBundleInput,
  ): Promise<ClaimOutcome<AgentSessionRecord>> {
    const existingId = this.sessionsByKey.get(
      `${input.session.applicationId}:${input.session.sessionKey}`,
    );
    if (existingId !== undefined) {
      const existing = this.sessions.get(existingId);
      if (existing !== undefined) {
        return { claimed: false, record: existing.record };
      }
    }
    const record: AgentSessionRecord = {
      id: input.session.id,
      applicationId: input.session.applicationId,
      tenantId: input.session.tenantId,
      executionId: input.session.executionId,
      agentId: input.session.agentId,
      agentVersionId: input.session.agentVersionId,
      workspaceId: input.session.workspaceId,
      sessionKey: input.session.sessionKey,
      requestFingerprint: input.session.requestFingerprint,
      status: "pending",
      inputDigest: input.session.inputDigest,
      inputArtifactRefs: [...input.session.inputArtifactRefs],
      effectivePermissions: input.session.effectivePermissions,
      policyEvidence: input.session.policyEvidence,
      autonomy: input.session.autonomy,
      outputDigest: null,
      output: null,
      failureReason: null,
      createdAt: input.session.createdAt,
      startedAt: null,
      completedAt: null,
      ledgerStartSequence: null,
      ledgerEndSequence: null,
    };
    this.sessions.set(record.id, { record });
    this.sessionsByKey.set(`${record.applicationId}:${record.sessionKey}`, record.id);
    const workspace: AgentWorkspaceRecord = {
      id: input.workspace.id,
      applicationId: input.workspace.applicationId,
      tenantId: input.workspace.tenantId,
      executionId: input.workspace.executionId,
      sessionId: input.workspace.sessionId,
      createdAt: input.workspace.createdAt,
    };
    this.workspaces.set(workspace.id, workspace);
    for (const grant of input.grants) {
      this.grants.set(grant.id, {
        id: grant.id,
        applicationId: grant.applicationId,
        tenantId: grant.tenantId,
        sessionId: grant.sessionId,
        scopeKind: grant.scopeKind,
        scopeRef: grant.scopeRef,
        status: "active",
        issuedAt: grant.issuedAt,
        expiresAt: grant.expiresAt,
        revokedAt: null,
      });
    }
    return { claimed: true, record };
  }

  async findSessionById(
    applicationId: string,
    sessionId: string,
  ): Promise<AgentSessionRecord | null> {
    const state = this.sessions.get(sessionId);
    return state !== undefined && state.record.applicationId === applicationId
      ? state.record
      : null;
  }

  async findSessionByKey(
    applicationId: string,
    sessionKey: string,
  ): Promise<AgentSessionRecord | null> {
    const id = this.sessionsByKey.get(`${applicationId}:${sessionKey}`);
    if (id === undefined) {
      return null;
    }
    const state = this.sessions.get(id);
    return state !== undefined ? state.record : null;
  }

  async listSessionsByExecution(
    applicationId: string,
    executionId: string,
  ): Promise<readonly AgentSessionRecord[]> {
    return [...this.sessions.values()]
      .map((s) => s.record)
      .filter((s) => s.applicationId === applicationId && s.executionId === executionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async transitionSession(
    applicationId: string,
    sessionId: string,
    next: SessionLifecycleStatus,
    fields: {
      readonly startedAt?: string;
      readonly completedAt?: string;
      readonly outputDigest?: string | null;
      readonly output?: Readonly<Record<string, unknown>> | null;
      readonly failureReason?: string | null;
      readonly ledgerEndSequence?: number;
    },
  ): Promise<AgentSessionRecord> {
    const state = this.sessions.get(sessionId);
    if (state === undefined || state.record.applicationId !== applicationId) {
      throw new PlatformError({ code: "AGENT_ERROR", message: "session vanished" });
    }
    const current = state.record;
    if (current.status === next) {
      return current;
    }
    if (isTerminalSessionStatus(current.status)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `agent session is terminal-immutable in state ${current.status}`,
      });
    }
    if (!canTransitionSession(current.status, next)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `agent session cannot move ${current.status} -> ${next}`,
      });
    }
    const updated: AgentSessionRecord = {
      ...current,
      status: next,
      startedAt: fields.startedAt ?? current.startedAt,
      completedAt: fields.completedAt ?? current.completedAt,
      outputDigest: fields.outputDigest ?? current.outputDigest,
      output: fields.output === undefined ? current.output : fields.output,
      failureReason: fields.failureReason ?? current.failureReason,
      ledgerEndSequence: fields.ledgerEndSequence ?? current.ledgerEndSequence,
    };
    this.sessions.set(sessionId, { record: updated });
    return updated;
  }

  async bindSessionLedgerSequences(
    applicationId: string,
    sessionId: string,
    sequence: number,
  ): Promise<void> {
    const state = this.sessions.get(sessionId);
    if (state === undefined || state.record.applicationId !== applicationId) {
      return;
    }
    const current = state.record;
    if (isTerminalSessionStatus(current.status)) {
      return;
    }
    this.sessions.set(sessionId, {
      record: { ...current, ledgerStartSequence: current.ledgerStartSequence ?? sequence },
    });
  }

  // ---- workspaces ----

  async findWorkspaceById(
    applicationId: string,
    workspaceId: string,
  ): Promise<AgentWorkspaceRecord | null> {
    const workspace = this.workspaces.get(workspaceId);
    return workspace !== undefined && workspace.applicationId === applicationId ? workspace : null;
  }

  async findWorkspaceBySession(
    applicationId: string,
    sessionId: string,
  ): Promise<AgentWorkspaceRecord | null> {
    for (const workspace of this.workspaces.values()) {
      if (workspace.applicationId === applicationId && workspace.sessionId === sessionId) {
        return workspace;
      }
    }
    return null;
  }

  // ---- grants ----

  async listGrantsBySession(
    applicationId: string,
    sessionId: string,
  ): Promise<readonly CredentialGrantRecord[]> {
    return [...this.grants.values()]
      .filter((g) => g.applicationId === applicationId && g.sessionId === sessionId)
      .sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
  }

  async revokeGrant(
    applicationId: string,
    grantId: string,
    revokedAt: string,
  ): Promise<CredentialGrantRecord> {
    const grant = this.grants.get(grantId);
    if (grant === undefined || grant.applicationId !== applicationId) {
      throw new PlatformError({
        code: "AGENT_ERROR",
        message: `credential grant ${grantId} does not exist in this application`,
      });
    }
    if (grant.status === "revoked") {
      return grant; // monotonic convergence
    }
    const updated: CredentialGrantRecord = { ...grant, status: "revoked", revokedAt };
    this.grants.set(grantId, updated);
    return updated;
  }

  // ---- approvals ----

  async insertApproval(input: InsertApprovalInput): Promise<ClaimOutcome<AgentApprovalRecord>> {
    const existingId = this.approvalsByKey.get(`${input.applicationId}:${input.approvalKey}`);
    if (existingId !== undefined) {
      const existing = this.approvals.get(existingId);
      if (existing !== undefined) {
        return { claimed: false, record: existing };
      }
    }
    const record: AgentApprovalRecord = {
      id: input.id,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      executionId: input.executionId,
      sessionId: input.sessionId,
      actionClass: input.actionClass,
      actionDescriptor: input.actionDescriptor,
      policyBasis: input.policyBasis,
      status: "pending",
      approvalKey: input.approvalKey,
      requestedAt: input.requestedAt,
      decidedAt: null,
      approverId: null,
      decision: null,
      expiresAt: input.expiresAt,
      ledgerWaitSequence: null,
    };
    this.approvals.set(record.id, record);
    this.approvalsByKey.set(`${record.applicationId}:${record.approvalKey}`, record.id);
    return { claimed: true, record };
  }

  async findApprovalById(
    applicationId: string,
    approvalId: string,
  ): Promise<AgentApprovalRecord | null> {
    const approval = this.approvals.get(approvalId);
    return approval !== undefined && approval.applicationId === applicationId ? approval : null;
  }

  async findApprovalByKey(
    applicationId: string,
    approvalKey: string,
  ): Promise<AgentApprovalRecord | null> {
    const id = this.approvalsByKey.get(`${applicationId}:${approvalKey}`);
    if (id === undefined) {
      return null;
    }
    return this.approvals.get(id) ?? null;
  }

  async listApprovalsBySession(
    applicationId: string,
    sessionId: string,
  ): Promise<readonly AgentApprovalRecord[]> {
    return [...this.approvals.values()]
      .filter((a) => a.applicationId === applicationId && a.sessionId === sessionId)
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  async decideApproval(
    applicationId: string,
    approvalId: string,
    decision: "approved" | "denied",
    approverId: string,
    decidedAt: string,
  ): Promise<AgentApprovalRecord> {
    const approval = this.approvals.get(approvalId);
    if (approval === undefined || approval.applicationId !== applicationId) {
      throw new PlatformError({ code: "AGENT_ERROR", message: "approval vanished" });
    }
    if (approval.status === "pending") {
      const updated: AgentApprovalRecord = {
        ...approval,
        status: decision,
        decision,
        decidedAt,
        approverId,
      };
      this.approvals.set(approvalId, updated);
      return updated;
    }
    if (approval.decision !== decision) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `approval is ${approval.status} and cannot be decided ${decision}`,
      });
    }
    return approval;
  }

  async revokeApproval(
    applicationId: string,
    approvalId: string,
    revokedAt: string,
  ): Promise<AgentApprovalRecord> {
    const approval = this.approvals.get(approvalId);
    if (approval === undefined || approval.applicationId !== applicationId) {
      throw new PlatformError({ code: "AGENT_ERROR", message: "approval vanished" });
    }
    if (approval.status === "pending" || approval.status === "approved") {
      const updated: AgentApprovalRecord = { ...approval, status: "revoked", decidedAt: revokedAt };
      this.approvals.set(approvalId, updated);
      return updated;
    }
    return approval;
  }

  async bindApprovalLedgerSequence(
    applicationId: string,
    approvalId: string,
    sequence: number,
  ): Promise<void> {
    const approval = this.approvals.get(approvalId);
    if (approval === undefined || approval.applicationId !== applicationId) {
      return;
    }
    if (approval.ledgerWaitSequence === null) {
      this.approvals.set(approvalId, { ...approval, ledgerWaitSequence: sequence });
    }
  }

  // ---- helpers ----

  private async expectAgent(applicationId: string, agentId: string): Promise<AgentRecord> {
    const agent = await this.findAgentById(applicationId, agentId);
    if (agent === null) {
      throw new PlatformError({ code: "AGENT_ERROR", message: "agent vanished" });
    }
    return agent;
  }
}
