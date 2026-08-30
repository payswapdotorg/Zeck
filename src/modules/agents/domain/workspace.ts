/**
 * Workspace domain (agents module domain; WORK-011, AGT-002).
 *
 * A workspace is an EXECUTION ENVIRONMENT / CONTEXT BOUNDARY for an agent
 * session — not a new authorization mechanism. Access is:
 *
 *   tenant scoped        (composite FK; wrong tenant fails closed)
 *   application scoped   (composite FK; wrong application fails closed)
 *   execution/session scoped (bound to the parent execution via the
 *                             session's execution identity)
 *
 * There is deliberately NO workspace-local permission model: workspace
 * authorization reuses the existing authorities (auth identity, policy
 * admission, capability resolution, execution binding, artifact/context
 * refs, tool permissions). Cross-tenant and cross-application access
 * fail closed with `TENANT_SCOPE_VIOLATION` — proven in discrimination
 * M3/M4 and the real-PG suites.
 */

/** The workspace identity record (execution-environment boundary). */
export interface AgentWorkspaceRecord {
  /** Durable workspace identity (UUIDv7). */
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** The parent execution this workspace is bound to (via its session). */
  readonly executionId: string;
  readonly sessionId: string;
  readonly createdAt: string;
}

/** The workspace identity as it crosses the runtime contract. */
export interface WorkspaceIdentity {
  readonly workspaceId: string;
  readonly executionId: string;
  readonly sessionId: string;
}

export function toWorkspaceIdentity(workspace: Readonly<AgentWorkspaceRecord>): WorkspaceIdentity {
  return {
    workspaceId: workspace.id,
    executionId: workspace.executionId,
    sessionId: workspace.sessionId,
  };
}

/**
 * Fail-closed workspace scope check: EVERY dimension must match —
 * application, tenant AND execution binding. Any mismatch is a typed
 * `TENANT_SCOPE_VIOLATION` (the canonical cross-scope error), never a
 * silent partial match.
 */
export type WorkspaceScopeError = {
  readonly code: "TENANT_SCOPE_VIOLATION";
  readonly reason: string;
};

export function checkWorkspaceScope(
  workspace: Readonly<AgentWorkspaceRecord>,
  expected: {
    readonly applicationId: string;
    readonly tenantId: string;
    readonly executionId: string;
  },
): WorkspaceScopeError | null {
  if (workspace.tenantId !== expected.tenantId) {
    return {
      code: "TENANT_SCOPE_VIOLATION",
      reason: "workspace belongs to another tenant",
    };
  }
  if (workspace.applicationId !== expected.applicationId) {
    return {
      code: "TENANT_SCOPE_VIOLATION",
      reason: "workspace belongs to another application",
    };
  }
  if (workspace.executionId !== expected.executionId) {
    return {
      code: "TENANT_SCOPE_VIOLATION",
      reason: "workspace is bound to another execution",
    };
  }
  return null;
}
