/**
 * SQL adapter for the agents module (WORK-011).
 *
 * Bridges `AgentStore` to the provider-neutral platform `DatabasePort`
 * (the WORK-010 `sql-tool-store` discipline). No driver/SDK import happens
 * here — `pg` is owned by the platform DB layer; this file only speaks the
 * neutral port.
 *
 * Physical invariants (migration 0006) mirrored by this adapter:
 *   - one agent per (application_id, slug) — duplicate registrations
 *     converge through the unique-index arbitration (M17);
 *   - versions are WRITE-ONCE (INSERT + read only; physical triggers
 *     reject UPDATE/DELETE — M15/M16); convergence requires the identical
 *     definition digest;
 *   - selections are append-only with (application_id, selection_key)
 *     arbitration;
 *   - one session per (application_id, session_key) — concurrent
 *     duplicate creates converge on ONE durable identity (M18);
 *     fingerprint mismatch on convergence → IDEMPOTENCY_KEY_REUSED;
 *     terminal sessions are immutable (guarded UPDATE converges);
 *   - workspaces/grants/approvals bind to their session by composite FKs;
 *     grants/selections/versions/workspaces never update-or-delete
 *     (revocation is the only grant UPDATE and is monotonic);
 *   - approval decisions are guarded pending → terminal transitions
 *     (exactly-once; terminal approvals immutable).
 */

import type { DatabasePort } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type { AgentLifecycleStatus, AgentRecord } from "../domain/agent";
import type {
  AgentDefinition,
  AgentSelectionKind,
  AgentSelectionRecord,
  AgentVersionRecord,
} from "../domain/agent-version";
import type { AgentApprovalRecord, ApprovalDecision, ApprovalStatus } from "../domain/approval";
import type { CredentialGrantRecord, CredentialGrantStatus } from "../domain/credential";
import type { EffectivePermissions, SessionPolicyEvidence } from "../domain/permissions";
import type { AgentSessionRecord, SessionLifecycleStatus } from "../domain/session";
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

interface AgentRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface VersionRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly version: string;
  readonly definition: Record<string, unknown>;
  readonly definition_digest: string;
  readonly validation_state: string;
  readonly validation_notes: string | null;
  readonly created_at: Date | string;
}

interface SelectionRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly selected_version_id: string;
  readonly kind: string;
  readonly rollback_of: string | null;
  readonly selected_by: string;
  readonly reason: string | null;
  readonly selected_at: Date | string;
}

interface SessionRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly agent_id: string;
  readonly agent_version_id: string;
  readonly workspace_id: string;
  readonly session_key: string;
  readonly request_fingerprint: string;
  readonly status: string;
  readonly input_digest: string;
  readonly input_artifact_refs: string[] | null;
  readonly effective_permissions: EffectivePermissions;
  readonly policy_evidence: SessionPolicyEvidence;
  readonly autonomy: string;
  readonly output_digest: string | null;
  readonly output: Record<string, unknown> | null;
  readonly failure_reason: string | null;
  readonly created_at: Date | string;
  readonly started_at: Date | string | null;
  readonly completed_at: Date | string | null;
  readonly ledger_start_sequence: string | number | null;
  readonly ledger_end_sequence: string | number | null;
}

interface WorkspaceRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly session_id: string;
  readonly created_at: Date | string;
}

interface GrantRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly session_id: string;
  readonly scope_kind: string;
  readonly scope_ref: string;
  readonly status: string;
  readonly issued_at: Date | string;
  readonly expires_at: Date | string | null;
  readonly revoked_at: Date | string | null;
}

interface ApprovalRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly execution_id: string;
  readonly session_id: string;
  readonly action_class: string;
  readonly action_descriptor: Record<string, unknown>;
  readonly policy_basis: string;
  readonly status: string;
  readonly approval_key: string;
  readonly requested_at: Date | string;
  readonly decided_at: Date | string | null;
  readonly approver_id: string | null;
  readonly decision: string | null;
  readonly expires_at: Date | string | null;
  readonly ledger_wait_sequence: string | number | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function seq(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function first<T>(rows: readonly T[]): T | undefined {
  return rows.length > 0 ? rows[0] : undefined;
}

function toAgent(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status as AgentLifecycleStatus,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toVersion(row: VersionRow): AgentVersionRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    version: row.version,
    definition: row.definition as unknown as AgentDefinition,
    definitionDigest: row.definition_digest,
    validationState: row.validation_state as AgentVersionRecord["validationState"],
    validationNotes: row.validation_notes,
    createdAt: iso(row.created_at),
  };
}

function toSelection(row: SelectionRow): AgentSelectionRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    selectedVersionId: row.selected_version_id,
    kind: row.kind as AgentSelectionKind,
    rollbackOf: row.rollback_of,
    selectedBy: row.selected_by,
    reason: row.reason,
    selectedAt: iso(row.selected_at),
  };
}

function toSession(row: SessionRow): AgentSessionRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    agentId: row.agent_id,
    agentVersionId: row.agent_version_id,
    workspaceId: row.workspace_id,
    sessionKey: row.session_key,
    requestFingerprint: row.request_fingerprint,
    status: row.status as SessionLifecycleStatus,
    inputDigest: row.input_digest,
    inputArtifactRefs: row.input_artifact_refs ?? [],
    effectivePermissions: row.effective_permissions,
    policyEvidence: row.policy_evidence,
    autonomy: row.autonomy as AgentSessionRecord["autonomy"],
    outputDigest: row.output_digest,
    output: row.output ?? null,
    failureReason: row.failure_reason,
    createdAt: iso(row.created_at),
    startedAt: isoOrNull(row.started_at),
    completedAt: isoOrNull(row.completed_at),
    ledgerStartSequence: seq(row.ledger_start_sequence),
    ledgerEndSequence: seq(row.ledger_end_sequence),
  };
}

function toWorkspace(row: WorkspaceRow): AgentWorkspaceRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    sessionId: row.session_id,
    createdAt: iso(row.created_at),
  };
}

function toGrant(row: GrantRow): CredentialGrantRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    scopeKind: row.scope_kind as CredentialGrantRecord["scopeKind"],
    scopeRef: row.scope_ref,
    status: row.status as CredentialGrantStatus,
    issuedAt: iso(row.issued_at),
    expiresAt: isoOrNull(row.expires_at),
    revokedAt: isoOrNull(row.revoked_at),
  };
}

function toApproval(row: ApprovalRow): AgentApprovalRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    executionId: row.execution_id,
    sessionId: row.session_id,
    actionClass: row.action_class,
    actionDescriptor: row.action_descriptor,
    policyBasis: row.policy_basis,
    status: row.status as ApprovalStatus,
    approvalKey: row.approval_key,
    requestedAt: iso(row.requested_at),
    decidedAt: isoOrNull(row.decided_at),
    approverId: row.approver_id,
    decision: row.decision === null ? null : (row.decision as ApprovalDecision),
    expiresAt: isoOrNull(row.expires_at),
    ledgerWaitSequence: seq(row.ledger_wait_sequence),
  };
}

const AGENT_COLUMNS = `id, application_id, tenant_id, slug, name, description, status, created_at, updated_at`;
const VERSION_COLUMNS = `id, application_id, tenant_id, agent_id, version, definition, definition_digest, validation_state, validation_notes, created_at`;
const SELECTION_COLUMNS = `id, application_id, tenant_id, agent_id, selected_version_id, kind, rollback_of, selected_by, reason, selected_at`;
const SESSION_COLUMNS = `id, application_id, tenant_id, execution_id, agent_id, agent_version_id, workspace_id, session_key, request_fingerprint, status, input_digest, input_artifact_refs, effective_permissions, policy_evidence, autonomy, output_digest, output, failure_reason, created_at, started_at, completed_at, ledger_start_sequence, ledger_end_sequence`;
const WORKSPACE_COLUMNS = `id, application_id, tenant_id, execution_id, session_id, created_at`;
const GRANT_COLUMNS = `id, application_id, tenant_id, session_id, scope_kind, scope_ref, status, issued_at, expires_at, revoked_at`;
const APPROVAL_COLUMNS = `id, application_id, tenant_id, execution_id, session_id, action_class, action_descriptor, policy_basis, status, approval_key, requested_at, decided_at, approver_id, decision, expires_at, ledger_wait_sequence`;

export class SqlAgentStore implements AgentStore {
  constructor(private readonly db: DatabasePort) {}

  // ---- agents ----

  async insertAgent(input: InsertAgentInput): Promise<ClaimOutcome<AgentRecord>> {
    const inserted = await this.db.execute<AgentRow>({
      sql: `INSERT INTO agents.agents (id, application_id, tenant_id, slug, name, description, status, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, 'registered', $7, $7)
ON CONFLICT (application_id, slug) DO NOTHING
RETURNING ${AGENT_COLUMNS}`,
      parameters: [
        input.id,
        input.applicationId,
        input.tenantId,
        input.slug,
        input.name,
        input.description,
        input.createdAt,
      ],
    });
    const row = first(inserted.rows);
    if (row !== undefined) {
      return { claimed: true, record: toAgent(row) };
    }
    const existing = await this.expectAgentBySlug(input.applicationId, input.slug);
    return { claimed: false, record: existing };
  }

  async findAgentBySlug(applicationId: string, slug: string): Promise<AgentRecord | null> {
    const result = await this.db.execute<AgentRow>({
      sql: `SELECT ${AGENT_COLUMNS} FROM agents.agents WHERE application_id = $1 AND slug = $2`,
      parameters: [applicationId, slug],
    });
    const row = first(result.rows);
    return row === undefined ? null : toAgent(row);
  }

  async findAgentById(applicationId: string, agentId: string): Promise<AgentRecord | null> {
    const result = await this.db.execute<AgentRow>({
      sql: `SELECT ${AGENT_COLUMNS} FROM agents.agents WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, agentId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toAgent(row);
  }

  async transitionAgentLifecycle(
    applicationId: string,
    agentId: string,
    next: AgentLifecycleStatus,
    updatedAt: string,
  ): Promise<AgentRecord> {
    const updated = await this.db.execute<AgentRow>({
      sql: `UPDATE agents.agents SET status = $3, updated_at = $4
WHERE application_id = $1 AND id = $2 AND status <> $3
RETURNING ${AGENT_COLUMNS}`,
      parameters: [applicationId, agentId, next, updatedAt],
    });
    const row = first(updated.rows);
    if (row !== undefined) {
      return toAgent(row);
    }
    // Converge: the row already carries the target status (or is gone).
    return this.expectAgentById(applicationId, agentId);
  }

  // ---- versions ----

  async insertVersion(input: InsertVersionInput): Promise<ClaimOutcome<AgentVersionRecord>> {
    const inserted = await this.db.execute<VersionRow>({
      sql: `INSERT INTO agents.agent_versions (id, application_id, tenant_id, agent_id, version, definition, definition_digest, validation_state, validation_notes, created_at)
VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
ON CONFLICT (application_id, agent_id, version) DO NOTHING
RETURNING ${VERSION_COLUMNS}`,
      parameters: [
        input.id,
        input.applicationId,
        input.tenantId,
        input.agentId,
        input.version,
        JSON.stringify(input.definition),
        input.definitionDigest,
        input.validationState,
        input.validationNotes,
        input.createdAt,
      ],
    });
    const row = first(inserted.rows);
    if (row !== undefined) {
      return { claimed: true, record: toVersion(row) };
    }
    // The (application, agent, version) identity is owned by an existing
    // row (the unique-index arbitration). Convergence requires the SAME
    // definition digest; a different digest is key reuse.
    const existingResult = await this.db.execute<VersionRow>({
      sql: `SELECT ${VERSION_COLUMNS} FROM agents.agent_versions WHERE application_id = $1 AND agent_id = $2 AND version = $3`,
      parameters: [input.applicationId, input.agentId, input.version],
    });
    const existingRow = first(existingResult.rows);
    if (existingRow === undefined) {
      throw new PlatformError({
        code: "AGENT_ERROR",
        message: "agent version claim vanished after arbitration",
      });
    }
    const existing = toVersion(existingRow);
    if (existing.definitionDigest !== input.definitionDigest) {
      throw new PlatformError({
        code: "IDEMPOTENCY_KEY_REUSED",
        message: `version ${input.version} already exists with a different definition`,
        details: { versionId: existing.id },
      });
    }
    return { claimed: false, record: existing };
  }

  async findVersionById(
    applicationId: string,
    versionId: string,
  ): Promise<AgentVersionRecord | null> {
    const result = await this.db.execute<VersionRow>({
      sql: `SELECT ${VERSION_COLUMNS} FROM agents.agent_versions WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, versionId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toVersion(row);
  }

  async listVersionsByAgent(
    applicationId: string,
    agentId: string,
  ): Promise<readonly AgentVersionRecord[]> {
    const result = await this.db.execute<VersionRow>({
      sql: `SELECT ${VERSION_COLUMNS} FROM agents.agent_versions WHERE application_id = $1 AND agent_id = $2 ORDER BY created_at ASC`,
      parameters: [applicationId, agentId],
    });
    return result.rows.map(toVersion);
  }

  // ---- selections ----

  async insertSelection(input: InsertSelectionInput): Promise<ClaimOutcome<AgentSelectionRecord>> {
    const inserted = await this.db.execute<SelectionRow>({
      sql: `INSERT INTO agents.agent_selections (id, application_id, tenant_id, agent_id, selected_version_id, kind, rollback_of, selected_by, reason, selected_at, selection_key)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
ON CONFLICT (application_id, selection_key) DO NOTHING
RETURNING ${SELECTION_COLUMNS}`,
      parameters: [
        input.id,
        input.applicationId,
        input.tenantId,
        input.agentId,
        input.selectedVersionId,
        input.kind,
        input.rollbackOf,
        input.selectedBy,
        input.reason,
        input.selectedAt,
        input.selectionKey,
      ],
    });
    const row = first(inserted.rows);
    if (row !== undefined) {
      return { claimed: true, record: toSelection(row) };
    }
    const existing = await this.db.execute<SelectionRow>({
      sql: `SELECT ${SELECTION_COLUMNS} FROM agents.agent_selections WHERE application_id = $1 AND selection_key = $2`,
      parameters: [input.applicationId, input.selectionKey],
    });
    const existingRow = first(existing.rows);
    if (existingRow === undefined) {
      throw new PlatformError({
        code: "AGENT_ERROR",
        message: "selection claim vanished after arbitration",
      });
    }
    return { claimed: false, record: toSelection(existingRow) };
  }

  async latestSelectionForAgent(
    applicationId: string,
    agentId: string,
  ): Promise<AgentSelectionRecord | null> {
    const result = await this.db.execute<SelectionRow>({
      sql: `SELECT ${SELECTION_COLUMNS} FROM agents.agent_selections WHERE application_id = $1 AND agent_id = $2 ORDER BY selected_at DESC, id DESC LIMIT 1`,
      parameters: [applicationId, agentId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toSelection(row);
  }

  async listSelectionsForAgent(
    applicationId: string,
    agentId: string,
  ): Promise<readonly AgentSelectionRecord[]> {
    const result = await this.db.execute<SelectionRow>({
      sql: `SELECT ${SELECTION_COLUMNS} FROM agents.agent_selections WHERE application_id = $1 AND agent_id = $2 ORDER BY selected_at ASC, id ASC`,
      parameters: [applicationId, agentId],
    });
    return result.rows.map(toSelection);
  }

  // ---- sessions ----

  async createSessionBundle(
    input: CreateSessionBundleInput,
  ): Promise<ClaimOutcome<AgentSessionRecord>> {
    // ONE transaction: session + workspace + scoped grants commit atomically
    // (crash-atomicity of the governed session identity — a converged
    // loser re-reads the winner's committed bundle).
    return this.db.transaction(async (tx) => {
      const inserted = await tx.execute<SessionRow>({
        sql: `INSERT INTO agents.agent_sessions (id, application_id, tenant_id, execution_id, agent_id, agent_version_id, workspace_id, session_key, request_fingerprint, status, input_digest, input_artifact_refs, effective_permissions, policy_evidence, autonomy, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15)
ON CONFLICT (application_id, session_key) DO NOTHING
RETURNING ${SESSION_COLUMNS}`,
        parameters: [
          input.session.id,
          input.session.applicationId,
          input.session.tenantId,
          input.session.executionId,
          input.session.agentId,
          input.session.agentVersionId,
          input.session.workspaceId,
          input.session.sessionKey,
          input.session.requestFingerprint,
          input.session.inputDigest,
          JSON.stringify([...input.session.inputArtifactRefs]),
          JSON.stringify(input.session.effectivePermissions),
          JSON.stringify(input.session.policyEvidence),
          input.session.autonomy,
          input.session.createdAt,
        ],
      });
      const row = first(inserted.rows);
      if (row !== undefined) {
        // The session row claimed the key inside this transaction; bind
        // the workspace + scoped grants atomically with it.
        await tx.execute({
          sql: `INSERT INTO agents.agent_workspaces (id, application_id, tenant_id, execution_id, session_id, created_at)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (application_id, session_id) DO NOTHING`,
          parameters: [
            input.workspace.id,
            input.workspace.applicationId,
            input.workspace.tenantId,
            input.workspace.executionId,
            input.workspace.sessionId,
            input.workspace.createdAt,
          ],
        });
        for (const grant of input.grants) {
          await tx.execute({
            sql: `INSERT INTO agents.agent_credential_grants (id, application_id, tenant_id, session_id, scope_kind, scope_ref, status, issued_at, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8)
ON CONFLICT (session_id, scope_kind, scope_ref) DO NOTHING`,
            parameters: [
              grant.id,
              grant.applicationId,
              grant.tenantId,
              grant.sessionId,
              grant.scopeKind,
              grant.scopeRef,
              grant.issuedAt,
              grant.expiresAt,
            ],
          });
        }
        return { claimed: true as const, record: toSession(row) };
      }
      const existing = await tx.execute<SessionRow>({
        sql: `SELECT ${SESSION_COLUMNS} FROM agents.agent_sessions WHERE application_id = $1 AND session_key = $2`,
        parameters: [input.session.applicationId, input.session.sessionKey],
      });
      const existingRow = first(existing.rows);
      if (existingRow === undefined) {
        throw new PlatformError({
          code: "AGENT_ERROR",
          message: "session claim vanished after arbitration",
        });
      }
      return { claimed: false as const, record: toSession(existingRow) };
    });
  }

  async findSessionById(
    applicationId: string,
    sessionId: string,
  ): Promise<AgentSessionRecord | null> {
    const result = await this.db.execute<SessionRow>({
      sql: `SELECT ${SESSION_COLUMNS} FROM agents.agent_sessions WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, sessionId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toSession(row);
  }

  async findSessionByKey(
    applicationId: string,
    sessionKey: string,
  ): Promise<AgentSessionRecord | null> {
    const result = await this.db.execute<SessionRow>({
      sql: `SELECT ${SESSION_COLUMNS} FROM agents.agent_sessions WHERE application_id = $1 AND session_key = $2`,
      parameters: [applicationId, sessionKey],
    });
    const row = first(result.rows);
    return row === undefined ? null : toSession(row);
  }

  async listSessionsByExecution(
    applicationId: string,
    executionId: string,
  ): Promise<readonly AgentSessionRecord[]> {
    const result = await this.db.execute<SessionRow>({
      sql: `SELECT ${SESSION_COLUMNS} FROM agents.agent_sessions WHERE application_id = $1 AND execution_id = $2 ORDER BY created_at ASC`,
      parameters: [applicationId, executionId],
    });
    return result.rows.map(toSession);
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
    },
  ): Promise<AgentSessionRecord> {
    const updated = await this.db.execute<SessionRow>({
      sql: `UPDATE agents.agent_sessions SET
  status = $3,
  started_at = COALESCE($4::timestamptz, started_at),
  completed_at = COALESCE($5::timestamptz, completed_at),
  output_digest = COALESCE($6, output_digest),
  output = COALESCE($7::jsonb, output),
  failure_reason = COALESCE($8, failure_reason)
WHERE application_id = $1 AND id = $2 AND status <> $3
RETURNING ${SESSION_COLUMNS}`,
      parameters: [
        applicationId,
        sessionId,
        next,
        fields.startedAt ?? null,
        fields.completedAt ?? null,
        fields.outputDigest ?? null,
        fields.output === undefined || fields.output === null
          ? null
          : JSON.stringify(fields.output),
        fields.failureReason ?? null,
      ],
    });
    const row = first(updated.rows);
    if (row !== undefined) {
      return toSession(row);
    }
    // Converge on the committed row (a concurrent writer moved it, or it
    // already carries the target status).
    return this.expectSessionById(applicationId, sessionId);
  }

  async bindSessionLedgerSequences(
    applicationId: string,
    sessionId: string,
    sequence: number,
  ): Promise<void> {
    // Idempotent bookkeeping on LIVE rows only; the completion sequence is
    // bound in the finalizing transitionSession update itself (terminal
    // rows are physically immutable afterwards).
    await this.db.execute({
      sql: `UPDATE agents.agent_sessions SET ledger_start_sequence = $3
WHERE application_id = $1 AND id = $2 AND ledger_start_sequence IS NULL
  AND status NOT IN ('completed', 'failed', 'cancelled')`,
      parameters: [applicationId, sessionId, sequence],
    });
  }

  // ---- workspaces ----

  async findWorkspaceById(
    applicationId: string,
    workspaceId: string,
  ): Promise<AgentWorkspaceRecord | null> {
    const result = await this.db.execute<WorkspaceRow>({
      sql: `SELECT ${WORKSPACE_COLUMNS} FROM agents.agent_workspaces WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, workspaceId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toWorkspace(row);
  }

  async findWorkspaceBySession(
    applicationId: string,
    sessionId: string,
  ): Promise<AgentWorkspaceRecord | null> {
    const result = await this.db.execute<WorkspaceRow>({
      sql: `SELECT ${WORKSPACE_COLUMNS} FROM agents.agent_workspaces WHERE application_id = $1 AND session_id = $2`,
      parameters: [applicationId, sessionId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toWorkspace(row);
  }

  // ---- grants ----

  async listGrantsBySession(
    applicationId: string,
    sessionId: string,
  ): Promise<readonly CredentialGrantRecord[]> {
    const result = await this.db.execute<GrantRow>({
      sql: `SELECT ${GRANT_COLUMNS} FROM agents.agent_credential_grants WHERE application_id = $1 AND session_id = $2 ORDER BY issued_at ASC`,
      parameters: [applicationId, sessionId],
    });
    return result.rows.map(toGrant);
  }

  async revokeGrant(
    applicationId: string,
    grantId: string,
    revokedAt: string,
  ): Promise<CredentialGrantRecord> {
    const updated = await this.db.execute<GrantRow>({
      sql: `UPDATE agents.agent_credential_grants SET status = 'revoked', revoked_at = $3
WHERE application_id = $1 AND id = $2 AND status = 'active'
RETURNING ${GRANT_COLUMNS}`,
      parameters: [applicationId, grantId, revokedAt],
    });
    const row = first(updated.rows);
    if (row !== undefined) {
      return toGrant(row);
    }
    return this.expectGrantById(applicationId, grantId);
  }

  // ---- approvals ----

  async insertApproval(input: InsertApprovalInput): Promise<ClaimOutcome<AgentApprovalRecord>> {
    const inserted = await this.db.execute<ApprovalRow>({
      sql: `INSERT INTO agents.agent_approval_requests (id, application_id, tenant_id, execution_id, session_id, action_class, action_descriptor, policy_basis, status, approval_key, requested_at, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'pending', $9, $10, $11)
ON CONFLICT (application_id, approval_key) DO NOTHING
RETURNING ${APPROVAL_COLUMNS}`,
      parameters: [
        input.id,
        input.applicationId,
        input.tenantId,
        input.executionId,
        input.sessionId,
        input.actionClass,
        JSON.stringify(input.actionDescriptor),
        input.policyBasis,
        input.approvalKey,
        input.requestedAt,
        input.expiresAt,
      ],
    });
    const row = first(inserted.rows);
    if (row !== undefined) {
      return { claimed: true, record: toApproval(row) };
    }
    const existing = await this.expectApprovalByKey(input.applicationId, input.approvalKey);
    return { claimed: false, record: existing };
  }

  async findApprovalById(
    applicationId: string,
    approvalId: string,
  ): Promise<AgentApprovalRecord | null> {
    const result = await this.db.execute<ApprovalRow>({
      sql: `SELECT ${APPROVAL_COLUMNS} FROM agents.agent_approval_requests WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, approvalId],
    });
    const row = first(result.rows);
    return row === undefined ? null : toApproval(row);
  }

  async findApprovalByKey(
    applicationId: string,
    approvalKey: string,
  ): Promise<AgentApprovalRecord | null> {
    const result = await this.db.execute<ApprovalRow>({
      sql: `SELECT ${APPROVAL_COLUMNS} FROM agents.agent_approval_requests WHERE application_id = $1 AND approval_key = $2`,
      parameters: [applicationId, approvalKey],
    });
    const row = first(result.rows);
    return row === undefined ? null : toApproval(row);
  }

  async listApprovalsBySession(
    applicationId: string,
    sessionId: string,
  ): Promise<readonly AgentApprovalRecord[]> {
    const result = await this.db.execute<ApprovalRow>({
      sql: `SELECT ${APPROVAL_COLUMNS} FROM agents.agent_approval_requests WHERE application_id = $1 AND session_id = $2 ORDER BY requested_at ASC`,
      parameters: [applicationId, sessionId],
    });
    return result.rows.map(toApproval);
  }

  async decideApproval(
    applicationId: string,
    approvalId: string,
    decision: "approved" | "denied",
    approverId: string,
    decidedAt: string,
  ): Promise<AgentApprovalRecord> {
    const updated = await this.db.execute<ApprovalRow>({
      sql: `UPDATE agents.agent_approval_requests SET status = $3, decision = $3, decided_at = $4, approver_id = $5
WHERE application_id = $1 AND id = $2 AND status = 'pending'
RETURNING ${APPROVAL_COLUMNS}`,
      parameters: [applicationId, approvalId, decision, decidedAt, approverId],
    });
    const row = first(updated.rows);
    if (row !== undefined) {
      return toApproval(row);
    }
    const existing = await this.expectApprovalById(applicationId, approvalId);
    if (existing.decision !== decision) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `approval is ${existing.status} and cannot be decided ${decision}`,
        details: { approvalId, status: existing.status },
      });
    }
    return existing;
  }

  async revokeApproval(
    applicationId: string,
    approvalId: string,
    revokedAt: string,
  ): Promise<AgentApprovalRecord> {
    const updated = await this.db.execute<ApprovalRow>({
      sql: `UPDATE agents.agent_approval_requests SET status = 'revoked', decided_at = $3
WHERE application_id = $1 AND id = $2 AND status IN ('pending', 'approved')
RETURNING ${APPROVAL_COLUMNS}`,
      parameters: [applicationId, approvalId, revokedAt],
    });
    const row = first(updated.rows);
    if (row !== undefined) {
      return toApproval(row);
    }
    return this.expectApprovalById(applicationId, approvalId);
  }

  async bindApprovalLedgerSequence(
    applicationId: string,
    approvalId: string,
    sequence: number,
  ): Promise<void> {
    await this.db.execute({
      sql: `UPDATE agents.agent_approval_requests SET ledger_wait_sequence = $3 WHERE application_id = $1 AND id = $2 AND ledger_wait_sequence IS NULL`,
      parameters: [applicationId, approvalId, sequence],
    });
  }

  // ---- helpers ----

  private async expectAgentBySlug(applicationId: string, slug: string): Promise<AgentRecord> {
    const agent = await this.findAgentBySlug(applicationId, slug);
    if (agent === null) {
      throw new PlatformError({
        code: "AGENT_ERROR",
        message: `agent slug "${slug}" claim vanished after arbitration`,
      });
    }
    return agent;
  }

  private async expectAgentById(applicationId: string, agentId: string): Promise<AgentRecord> {
    const agent = await this.findAgentById(applicationId, agentId);
    if (agent === null) {
      throw new PlatformError({
        code: "AGENT_ERROR",
        message: `agent ${agentId} vanished after arbitration`,
      });
    }
    return agent;
  }

  private async expectSessionById(
    applicationId: string,
    sessionId: string,
  ): Promise<AgentSessionRecord> {
    const session = await this.findSessionById(applicationId, sessionId);
    if (session === null) {
      throw new PlatformError({
        code: "AGENT_ERROR",
        message: `agent session ${sessionId} vanished after arbitration`,
      });
    }
    return session;
  }

  private async expectGrantById(
    applicationId: string,
    grantId: string,
  ): Promise<CredentialGrantRecord> {
    const result = await this.db.execute<GrantRow>({
      sql: `SELECT ${GRANT_COLUMNS} FROM agents.agent_credential_grants WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, grantId],
    });
    const row = first(result.rows);
    if (row === undefined) {
      throw new PlatformError({
        code: "AGENT_ERROR",
        message: `credential grant ${grantId} does not exist in this application`,
      });
    }
    return toGrant(row);
  }

  private async expectApprovalById(
    applicationId: string,
    approvalId: string,
  ): Promise<AgentApprovalRecord> {
    const approval = await this.findApprovalById(applicationId, approvalId);
    if (approval === null) {
      throw new PlatformError({
        code: "AGENT_ERROR",
        message: `approval ${approvalId} vanished after arbitration`,
      });
    }
    return approval;
  }

  private async expectApprovalByKey(
    applicationId: string,
    approvalKey: string,
  ): Promise<AgentApprovalRecord> {
    const approval = await this.findApprovalByKey(applicationId, approvalKey);
    if (approval === null) {
      throw new PlatformError({
        code: "AGENT_ERROR",
        message: `approval key "${approvalKey}" claim vanished after arbitration`,
      });
    }
    return approval;
  }
}
