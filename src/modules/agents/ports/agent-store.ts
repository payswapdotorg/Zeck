/**
 * Agent store port (agents module outbound; WORK-011).
 *
 * The durable identity/inventory/session/approval surface of the agent
 * fabric. Authority discipline:
 *
 *   - agent VERSIONS are WRITE-ONCE artifacts: insert + read only —
 *     there is NO update/delete method, and migration 0006 enforces
 *     physical immutability besides (discrimination M15/M16:
 *     in-place mutation is unrepresentable at both the API and the
 *     storage boundary);
 *   - SELECTIONS are append-only promotion/rollback records;
 *   - SESSION rows transition through the explicit session lifecycle
 *     (guarded, first-writer-wins); terminal rows are immutable;
 *   - WORKSPACES/GRANTS/APPROVALS are durable rows bound to their
 *     session by composite (application_id, session_id) identity —
 *     cross-scope rows are unrepresentable (composite FKs, migration
 *     0006);
 *   - grants are revocable (monotonic to `revoked`); approval
 *     decisions are guarded pending → terminal transitions.
 *
 * Idempotency contract (`spec/contracts.md` "Idempotency response
 * rule"): sessions are keyed by `(application_id, session_key)`,
 * approvals by `(application_id, approval_key)`, versions by
 * `(application_id, agent_id, version)`, agents by
 * `(application_id, slug)`. The first writer claims the key; same key +
 * same request fingerprint/digest replays the SAME durable outcome;
 * same key + different fingerprint fails `IDEMPOTENCY_KEY_REUSED`;
 * concurrent identical requests converge through PostgreSQL uniqueness
 * arbitration (the WORK-002/004/006/010 discipline — durable
 * constraints, never application-level mutexes).
 */

import type { AutonomyMode } from "../../policies/public";
import type { AgentLifecycleStatus, AgentRecord } from "../domain/agent";
import type {
  AgentSelectionKind,
  AgentSelectionRecord,
  AgentVersionRecord,
} from "../domain/agent-version";
import type { AgentApprovalRecord } from "../domain/approval";
import type { CredentialGrantRecord } from "../domain/credential";
import type { EffectivePermissions, SessionPolicyEvidence } from "../domain/permissions";
import type { AgentSessionRecord, SessionLifecycleStatus } from "../domain/session";
import type { AgentWorkspaceRecord } from "../domain/workspace";

/** First-writer-wins claim result (converge on the committed row). */
export type ClaimOutcome<T> =
  | { readonly claimed: true; readonly record: T }
  | { readonly claimed: false; readonly record: T };

export interface InsertAgentInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly createdAt: string;
}

export interface InsertVersionInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly version: string;
  readonly definition: Readonly<Record<string, unknown>>;
  readonly definitionDigest: string;
  readonly validationState: "valid" | "invalid";
  readonly validationNotes: string | null;
  readonly createdAt: string;
}

export interface InsertSelectionInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly selectedVersionId: string;
  readonly kind: AgentSelectionKind;
  readonly rollbackOf: string | null;
  readonly selectedBy: string;
  readonly reason: string | null;
  readonly selectedAt: string;
  readonly selectionKey: string;
}

/** The complete create-session bundle (session + workspace + grants). */
export interface CreateSessionBundleInput {
  readonly session: {
    readonly id: string;
    readonly applicationId: string;
    readonly tenantId: string;
    readonly executionId: string;
    readonly agentId: string;
    readonly agentVersionId: string;
    readonly workspaceId: string;
    readonly sessionKey: string;
    readonly requestFingerprint: string;
    readonly inputDigest: string;
    readonly inputArtifactRefs: readonly string[];
    readonly effectivePermissions: Readonly<EffectivePermissions>;
    readonly policyEvidence: Readonly<SessionPolicyEvidence>;
    readonly autonomy: AutonomyMode;
    readonly createdAt: string;
  };
  readonly workspace: {
    readonly id: string;
    readonly applicationId: string;
    readonly tenantId: string;
    readonly executionId: string;
    readonly sessionId: string;
    readonly createdAt: string;
  };
  readonly grants: readonly {
    readonly id: string;
    readonly applicationId: string;
    readonly tenantId: string;
    readonly sessionId: string;
    readonly scopeKind: "model" | "tool" | "endpoint" | "secret";
    readonly scopeRef: string;
    readonly issuedAt: string;
    readonly expiresAt: string | null;
  }[];
}

export interface InsertApprovalInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly sessionId: string;
  readonly actionClass: string;
  readonly actionDescriptor: Readonly<Record<string, unknown>>;
  readonly policyBasis: string;
  readonly approvalKey: string;
  readonly requestedAt: string;
  readonly expiresAt: string | null;
}

export interface AgentStore {
  // ---- agents (identity + lifecycle) ----
  /** Insert one agent identity; converges on the existing slug row. */
  insertAgent(input: InsertAgentInput): Promise<ClaimOutcome<AgentRecord>>;
  findAgentBySlug(applicationId: string, slug: string): Promise<AgentRecord | null>;
  findAgentById(applicationId: string, agentId: string): Promise<AgentRecord | null>;
  /**
   * Guarded lifecycle transition (registered→validated→available⇄suspended→
   * retired): fails on illegal current→next pairs; converges when the row
   * already carries the target status.
   */
  transitionAgentLifecycle(
    applicationId: string,
    agentId: string,
    next: AgentLifecycleStatus,
    updatedAt: string,
  ): Promise<AgentRecord>;

  // ---- versions (immutable artifacts) ----
  /** Insert one immutable version; converges on identical (agent, version, digest). */
  insertVersion(input: InsertVersionInput): Promise<ClaimOutcome<AgentVersionRecord>>;
  findVersionById(applicationId: string, versionId: string): Promise<AgentVersionRecord | null>;
  listVersionsByAgent(
    applicationId: string,
    agentId: string,
  ): Promise<readonly AgentVersionRecord[]>;

  // ---- selections (promotion/rollback journal) ----
  /** Append one selection record; idempotent per selectionKey. */
  insertSelection(input: InsertSelectionInput): Promise<ClaimOutcome<AgentSelectionRecord>>;
  /** The latest selection of an agent (its currently-running version), if any. */
  latestSelectionForAgent(
    applicationId: string,
    agentId: string,
  ): Promise<AgentSelectionRecord | null>;
  listSelectionsForAgent(
    applicationId: string,
    agentId: string,
  ): Promise<readonly AgentSelectionRecord[]>;

  // ---- sessions (governed session lifecycle) ----
  /** Atomically insert session + workspace + credential grants; converges on the key. */
  createSessionBundle(input: CreateSessionBundleInput): Promise<ClaimOutcome<AgentSessionRecord>>;
  findSessionById(applicationId: string, sessionId: string): Promise<AgentSessionRecord | null>;
  findSessionByKey(applicationId: string, sessionKey: string): Promise<AgentSessionRecord | null>;
  listSessionsByExecution(
    applicationId: string,
    executionId: string,
  ): Promise<readonly AgentSessionRecord[]>;
  /**
   * Guarded session lifecycle transition (the domain transition table is
   * the legality oracle): updates status (+ terminal fields on finalize,
   * including the completion ledger sequence bound in the SAME update —
   * terminal rows are physically immutable afterwards) and converges on
   * the committed row when a concurrent writer moved it.
   */
  transitionSession(
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
  ): Promise<AgentSessionRecord>;
  /** Bind the session-start ledger sequence (live rows only, idempotent). */
  bindSessionLedgerSequences(
    applicationId: string,
    sessionId: string,
    sequence: number,
  ): Promise<void>;

  // ---- workspaces ----
  findWorkspaceById(
    applicationId: string,
    workspaceId: string,
  ): Promise<AgentWorkspaceRecord | null>;
  findWorkspaceBySession(
    applicationId: string,
    sessionId: string,
  ): Promise<AgentWorkspaceRecord | null>;

  // ---- credential grants ----
  listGrantsBySession(
    applicationId: string,
    sessionId: string,
  ): Promise<readonly CredentialGrantRecord[]>;
  /** Monotonic revocation: active → revoked (never back). */
  revokeGrant(
    applicationId: string,
    grantId: string,
    revokedAt: string,
  ): Promise<CredentialGrantRecord>;

  // ---- approvals ----
  /** Insert one approval request; converges on the existing approvalKey row. */
  insertApproval(input: InsertApprovalInput): Promise<ClaimOutcome<AgentApprovalRecord>>;
  findApprovalById(applicationId: string, approvalId: string): Promise<AgentApprovalRecord | null>;
  findApprovalByKey(
    applicationId: string,
    approvalKey: string,
  ): Promise<AgentApprovalRecord | null>;
  listApprovalsBySession(
    applicationId: string,
    sessionId: string,
  ): Promise<readonly AgentApprovalRecord[]>;
  /**
   * Guarded decision: pending → approved | denied with the approver
   * provenance; converges when the record already carries the decision.
   */
  decideApproval(
    applicationId: string,
    approvalId: string,
    decision: "approved" | "denied",
    approverId: string,
    decidedAt: string,
  ): Promise<AgentApprovalRecord>;
  /** Guarded revocation: pending → revoked (post-approval revocation is a separate status transition). */
  revokeApproval(
    applicationId: string,
    approvalId: string,
    revokedAt: string,
  ): Promise<AgentApprovalRecord>;
  /** Bind the wait-human ledger sequence onto the approval record. */
  bindApprovalLedgerSequence(
    applicationId: string,
    approvalId: string,
    sequence: number,
  ): Promise<void>;
}
