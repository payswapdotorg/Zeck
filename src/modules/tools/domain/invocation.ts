/**
 * Tool invocation domain (tools module domain; WORK-010, TOL-001/TOL-002).
 *
 * The durable vocabulary of a governed tool invocation. This is a JOURNAL,
 * not a state machine: an invocation row is created in one of two ways —
 * `dispatching` (all admissions passed; durable intent immediately before
 * the adapter call) or `denied` (an admission refused; journal-then-fail)
 * — and may finalize exactly once (`succeeded` | `tool-failed`). There is
 * no public transition API, no branching, no replanning: the EXECUTION
 * state machine (executions module) remains the only lifecycle authority.
 *
 * Outcome classification is the load-bearing part of the failure-model
 * contract (Work Order: tool failures must remain distinguishable from
 * provider/model failure, verification failure, task-quality failure,
 * policy denial and authorization failure):
 *
 *   - `outcomeClass` draws from a TOOL-ONLY vocabulary
 *     (`tool-success` | `tool-failure`) that is physically disjoint from
 *     the verification vocabulary (`PASS`/`FAIL`/`INCONCLUSIVE`) and from
 *     the provider-axis classes — migration 0005 CHECKs this at the
 *     storage boundary, so "classify a tool failure as verification
 *     success" is unrepresentable, not merely discouraged;
 *   - admission refusals are `denialClass`ed by WHICH authority refused
 *     (policy | budget | capability | tenant | validation) and surface as
 *     the matching canonical error codes (`POLICY_DENIED`,
 *     `BUDGET_EXCEEDED`, `CAPABILITY_UNAVAILABLE`, `TENANT_SCOPE_VIOLATION`,
 *     `AUTHORIZATION_DENIED`) — never as `TOOL_ERROR`;
 *   - `TOOL_ERROR` is reserved for the tool axis itself: execution
 *     failures, output-contract violations, adapter crashes and timeouts.
 *
 * Provenance: every record is bound to its parent execution
 * (executionId/applicationId/tenantId), carries the request fingerprint
 * and one-way input digest, the exact tool contract identity
 * (toolId/version/capability), the admission evidence (policy set identity
 * + restriction digest), timing, ledger sequence bindings and artifact
 * references — the structured evidence downstream steps consume (TOL-002).
 */

/** Durable journal status of one invocation (not a lifecycle state machine). */
export const TOOL_INVOCATION_STATUSES = [
  "denied",
  "dispatching",
  "succeeded",
  "tool-failed",
] as const;
export type ToolInvocationStatus = (typeof TOOL_INVOCATION_STATUSES)[number];

/** Which admission authority refused the invocation (admission refusals
 * that occur AFTER tool resolution — journaled denials). Tenant-scope and
 * pure request-validation failures surface as typed errors WITHOUT a
 * journal row, the executions-transition precedent: they precede tool
 * resolution and claim nothing. */
export const TOOL_DENIAL_CLASSES = ["policy", "budget", "capability"] as const;
export type ToolDenialClass = (typeof TOOL_DENIAL_CLASSES)[number];

/**
 * The tool-axis outcome vocabulary — PHYSICALLY DISJOINT from the
 * verification vocabulary (PASS | FAIL | INCONCLUSIVE) and the
 * provider-axis classes by migration 0005's CHECK constraint.
 */
export const TOOL_OUTCOME_CLASSES = ["tool-success", "tool-failure"] as const;
export type ToolOutcomeClass = (typeof TOOL_OUTCOME_CLASSES)[number];

/** Typed failure categories of the tool axis (canonical `TOOL_ERROR`). */
export const TOOL_FAILURE_CLASSES = [
  "tool-execution",
  "output-contract",
  "adapter-error",
  "timeout",
  "unknown-outcome",
] as const;
export type ToolFailureClass = (typeof TOOL_FAILURE_CLASSES)[number];

/** A normalized tool failure observation (never a thrown provider error). */
export interface ToolFailure {
  readonly failureClass: ToolFailureClass;
  readonly message: string;
  readonly retryable: boolean;
}

/** Admission policy evidence carried onto the durable record (WORK-007 shape). */
export interface ToolPolicyEvidence {
  readonly policySetId: string;
  readonly policySetVersion: number;
  readonly policyContentHash: string;
  readonly restrictionSetDigest: string;
}

/** The invocation request the runtime admits and executes. */
export interface ToolInvocationRequest {
  readonly applicationId: string;
  readonly executionId: string;
  /** Server-derived scope (never caller-asserted tenant identity). */
  readonly actor: {
    readonly actorId: string;
    readonly tenantId: string;
  };
  readonly toolId: string;
  /** Input validated against the contract's inputSchema before admission. */
  readonly input: Readonly<Record<string, unknown>>;
  /**
   * Upstream evidence references (e.g. artifact refs produced by earlier
   * steps) — recorded as input provenance (TOL-002 linkage).
   */
  readonly inputArtifactRefs?: readonly string[];
}

/**
 * The durable invocation record — THE execution evidence of a tool call
 * (acceptance criterion 3): request identity, outcome, timing, artifact
 * references and error class, provenance-bound to the parent execution.
 */
export interface ToolInvocationRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  /** The caller's idempotency key (request identity within the application). */
  readonly invocationKey: string;
  readonly requestFingerprint: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly capabilityId: string;
  readonly status: ToolInvocationStatus;
  readonly outcomeClass: ToolOutcomeClass | null;
  readonly denialClass: ToolDenialClass | null;
  readonly denialReason: string | null;
  readonly denialCode: string | null;
  readonly failureClass: ToolFailureClass | null;
  readonly failureMessage: string | null;
  readonly retryable: boolean;
  readonly inputDigest: string;
  readonly inputArtifacts: readonly string[];
  readonly output: Readonly<Record<string, unknown>> | null;
  readonly outputArtifacts: readonly string[];
  readonly usageMicroUsd: string | null;
  readonly budgetOperationId: string | null;
  readonly policyEvidence: ToolPolicyEvidence | null;
  readonly capabilitySatisfaction: string | null;
  readonly requestedAt: string;
  readonly dispatchedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly ledgerRequestedSequence: number | null;
  readonly ledgerResultSequence: number | null;
}

/** The typed result handed back to the caller (provenance always present). */
export interface ToolInvocationResult {
  readonly invocationId: string;
  readonly executionId: string;
  readonly applicationId: string;
  readonly toolId: string;
  readonly toolVersion: string;
  readonly capabilityId: string;
  readonly status: ToolInvocationStatus;
  readonly outcomeClass: ToolOutcomeClass | null;
  readonly output: Readonly<Record<string, unknown>> | null;
  readonly outputArtifacts: readonly string[];
  readonly failureClass: ToolFailureClass | null;
  readonly retryable: boolean;
  readonly durationMs: number | null;
  /** Ledger sequence of the `execution.tool-requested` envelope (or null). */
  readonly ledgerRequestedSequence: number | null;
  /** Ledger sequence of the `execution.tool-result`/`tool-denied` envelope. */
  readonly ledgerEvidenceSequence: number | null;
  /** True when a previous request's durable outcome was replayed. */
  readonly replayed: boolean;
}

export function isToolInvocationStatus(value: string): value is ToolInvocationStatus {
  return (TOOL_INVOCATION_STATUSES as readonly string[]).includes(value);
}

export function isToolDenialClass(value: string): value is ToolDenialClass {
  return (TOOL_DENIAL_CLASSES as readonly string[]).includes(value);
}

export function isToolOutcomeClass(value: string): value is ToolOutcomeClass {
  return (TOOL_OUTCOME_CLASSES as readonly string[]).includes(value);
}

export function isToolFailureClass(value: string): value is ToolFailureClass {
  return (TOOL_FAILURE_CLASSES as readonly string[]).includes(value);
}
