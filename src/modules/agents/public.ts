/**
 * Public contract barrel of the `agents` module.
 *
 * This file is the ONLY supported import surface for other modules and for
 * the API layer (`IMPLEMENTATION.md` §2, `spec/contracts.md` "Public module
 * rule"). Everything else under `src/modules/agents/` is private to this
 * module.
 *
 * WORK-011 introduces the agent fabric, sessions and workspaces
 * (AGT-001..006/008, ACP-001..004/006; ADR-0013 is normative): the agent
 * as a governed EXECUTION PARTICIPANT — never a second execution system,
 * never a new authority:
 *
 *  - `AgentProvider`: the neutral agent-RUNTIME contract, deliberately
 *    DISTINCT from the models module's `ModelProvider` (inference
 *    capability vs. runtime capable of executing a governed session);
 *    local/customer-hosted/hosted adapters implement the same seam
 *    without changing the Execution abstraction (WORK-016 owns BYOA
 *    interoperability adapters);
 *  - the agent registry: stable identity + catalog record (ACP-001),
 *    immutable versioned artifacts with validation state and append-only
 *    promotion/rollback selections (ACP-002);
 *  - the session service: the governed admission chain (policy admission
 *    REQUIRED — the WORK-007 engine decides the effective permission
 *    intersection and the effective autonomy), execution-bound session +
 *    workspace identity (AGT-002), scoped revocable credential grants
 *    (references only — raw long-lived secrets are structurally absent,
 *    ACP-003), policy-designated human approval gates (ACP-004) and
 *    session evidence on the executions EventEnvelope ledger through the
 *    step-event seam (ACP-006).
 *
 * Authority seams (consulted, never bypassed, never reimplemented):
 *  - policy admission: `AgentAdmission` (REQUIRED at service
 *    construction — no default-allow exists);
 *  - execution identity/lifecycle/evidence: `AgentExecutionLedger`
 *    (REQUIRED — the executions public service behind it);
 *  - capability/budget authorities stay at their owning modules and are
 *    consulted downstream of this module's seams where applicable.
 */

import type { ModuleDescriptor } from "../../shared/module";
import { createAgentExecutionLedgerAdapter } from "./adapters/execution-ledger";
import { InMemoryAgentStore } from "./adapters/in-memory-agent-store";
import { createPolicyAgentAdmission } from "./adapters/policy-agent-admission";
import { SqlAgentStore } from "./adapters/sql-agent-store";
import type { AgentRegistry, AgentRegistryDeps } from "./application/agent-registry";
import { createAgentRegistry } from "./application/agent-registry";
import type { AgentSessionServiceDeps } from "./application/session-service";
import { createAgentSessionService } from "./application/session-service";
import type { AgentLifecycleStatus, AgentRecord, AgentRegistrationInput } from "./domain/agent";
import {
  AGENT_LIFECYCLE_STATUSES,
  AGENT_LIFECYCLE_TRANSITIONS,
  agentMayStartSessions,
  isAgentLifecycleStatus,
  isTerminalAgentStatus,
  validateAgentRegistration,
} from "./domain/agent";
import type {
  AgentDefinition,
  AgentSelectionRecord,
  AgentVersionRecord,
  CredentialScopeKind,
  VersionValidationState,
} from "./domain/agent-version";
import {
  AGENT_SELECTION_KINDS,
  CREDENTIAL_SCOPE_KINDS,
  canonicalDefinitionJson,
  containsRawSecretValue,
  isVersionValidationState,
  VERSION_VALIDATION_STATES,
  validateAgentDefinition,
} from "./domain/agent-version";
import type {
  AgentApprovalRecord,
  ApprovalDecision,
  ApprovalProvenance,
  ApprovalStatus,
} from "./domain/approval";
import {
  APPROVAL_DECISIONS,
  APPROVAL_STATUSES,
  approvalAuthorizesDispatch,
  approvalProvenanceOf,
  isApprovalDecision,
  isApprovalStatus,
  isTerminalApprovalStatus,
} from "./domain/approval";
import type {
  CredentialGrantRecord,
  CredentialGrantReference,
  CredentialGrantStatus,
} from "./domain/credential";
import { grantIsUsable, isCredentialGrantStatus, isCredentialScopeKind } from "./domain/credential";
import type { EffectivePermissions, SessionPolicyEvidence } from "./domain/permissions";
import { effectivePermissionsOf, toSessionPolicyEvidence } from "./domain/permissions";
import type { AgentSessionRecord, SessionLifecycleStatus } from "./domain/session";
import {
  autonomyEngagesApprovalGate,
  canTransitionSession,
  isSessionLifecycleStatus,
  isTerminalSessionStatus,
  SESSION_LIFECYCLE_STATUSES,
  SESSION_TRANSITIONS,
  sessionRequestFingerprint,
  TERMINAL_SESSION_STATUSES,
} from "./domain/session";
import type { AgentWorkspaceRecord, WorkspaceIdentity } from "./domain/workspace";
import { checkWorkspaceScope, toWorkspaceIdentity } from "./domain/workspace";
import type {
  AgentAdmission,
  AgentAdmissionDecision,
  AgentAdmissionRequest,
} from "./ports/agent-admission";
import type {
  AgentExecutionLedger,
  AgentStepEventCommand,
  LedgerStepEvent,
  LedgerStepEventOutcome,
} from "./ports/agent-execution-ledger";
import type {
  AgentProvider,
  AgentProviderRegistry,
  AgentRuntimeIdentity,
  AgentSessionObservation,
  AgentSessionTask,
} from "./ports/agent-provider";
import { AGENT_SESSION_OUTCOME_CLASSES } from "./ports/agent-provider";
import type {
  AgentStore,
  ClaimOutcome,
  CreateSessionBundleInput,
  InsertAgentInput,
  InsertApprovalInput,
  InsertSelectionInput,
  InsertVersionInput,
} from "./ports/agent-store";

export const moduleDescriptor: ModuleDescriptor = { id: "agents" };

export { actionRequiresApproval } from "./domain/session";
// Application services (the registry + the governed session lifecycle).
// Domain: agent identity + lifecycle, immutable versions + selections.
// Domain: sessions/workspaces, scoped grants, approvals, permissions.
// Ports: the neutral AgentProvider runtime contract + the authority seams.
// Adapters: SQL/in-memory stores, policy admission, execution ledger.
export type {
  AgentAdmission,
  AgentAdmissionDecision,
  AgentAdmissionRequest,
  AgentApprovalRecord,
  AgentDefinition,
  AgentExecutionLedger,
  AgentLifecycleStatus,
  AgentProvider,
  AgentProviderRegistry,
  AgentRecord,
  AgentRegistrationInput,
  AgentRegistry,
  AgentRegistryDeps,
  AgentRuntimeIdentity,
  AgentSelectionRecord,
  AgentSessionObservation,
  AgentSessionRecord,
  AgentSessionServiceDeps,
  AgentSessionTask,
  AgentStepEventCommand,
  AgentStore,
  AgentVersionRecord,
  AgentWorkspaceRecord,
  ApprovalDecision,
  ApprovalProvenance,
  ApprovalStatus,
  ClaimOutcome,
  CreateSessionBundleInput,
  CredentialGrantRecord,
  CredentialGrantReference,
  CredentialGrantStatus,
  CredentialScopeKind,
  EffectivePermissions,
  InsertAgentInput,
  InsertApprovalInput,
  InsertSelectionInput,
  InsertVersionInput,
  LedgerStepEvent,
  LedgerStepEventOutcome,
  SessionLifecycleStatus,
  SessionPolicyEvidence,
  VersionValidationState,
  WorkspaceIdentity,
};
export {
  AGENT_LIFECYCLE_STATUSES,
  AGENT_LIFECYCLE_TRANSITIONS,
  AGENT_SELECTION_KINDS,
  AGENT_SESSION_OUTCOME_CLASSES,
  APPROVAL_DECISIONS,
  APPROVAL_STATUSES,
  agentMayStartSessions,
  approvalAuthorizesDispatch,
  approvalProvenanceOf,
  autonomyEngagesApprovalGate,
  CREDENTIAL_SCOPE_KINDS,
  canonicalDefinitionJson,
  canTransitionSession,
  checkWorkspaceScope,
  containsRawSecretValue,
  createAgentExecutionLedgerAdapter,
  createAgentRegistry,
  createAgentSessionService,
  createPolicyAgentAdmission,
  effectivePermissionsOf,
  grantIsUsable,
  InMemoryAgentStore,
  isAgentLifecycleStatus,
  isApprovalDecision,
  isApprovalStatus,
  isCredentialGrantStatus,
  isCredentialScopeKind,
  isSessionLifecycleStatus,
  isTerminalAgentStatus,
  isTerminalApprovalStatus,
  isTerminalSessionStatus,
  isVersionValidationState,
  SESSION_LIFECYCLE_STATUSES,
  SESSION_TRANSITIONS,
  SqlAgentStore,
  sessionRequestFingerprint,
  TERMINAL_SESSION_STATUSES,
  toSessionPolicyEvidence,
  toWorkspaceIdentity,
  VERSION_VALIDATION_STATES,
  validateAgentDefinition,
  validateAgentRegistration,
};
