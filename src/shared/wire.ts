/**
 * The public wire contract of AI Execution OS (WORK-015 / API-001,
 * API-002, API-004, API-005).
 *
 * This is the ONE canonical source of the public developer-facing wire
 * shapes — shared by the API transport (src/api serializes INTO these
 * shapes) and the SDK (sdk/ re-exports them as the client-side
 * contract). It lives in src/shared because it is exactly what shared
 * is for: a truly cross-cutting, dependency-light contract with NO
 * imports (pure data shapes + pure functions).
 *
 * EXECUTION-CENTRIC (API-002): the stable public primitive is an
 * `Execution`, never a model/provider call. PROVIDER-NEUTRAL (M17):
 * provider/model identifiers cross only as opaque neutral strings.
 * SECRET-SAFE (M5): no wire type carries secret material — there is no
 * field where plaintext credentials could even appear.
 */

/** The wire contract schema version (versioned; breaking changes bump). */
export const WIRE_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Execution lifecycle (the platform state machine, public projection)
// ---------------------------------------------------------------------------

/** The execution lifecycle statuses (spec/contracts.md transition table). */
export const EXECUTION_STATUSES = [
  "CREATED",
  "AUTHORIZED",
  "PLANNING",
  "QUEUED",
  "RUNNING",
  "WAITING_TOOL",
  "WAITING_USER",
  "WAITING_HUMAN",
  "VERIFYING",
  "REPLANNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/** Terminal statuses (no further transitions or events). */
export const TERMINAL_STATUSES: readonly ExecutionStatus[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
];

// ---------------------------------------------------------------------------
// Money discipline: integer micro-USD strings (never floats)
// ---------------------------------------------------------------------------

/** Integer micro-USD (1e-6 USD) string — the platform money convention. */
export type MicroUsd = string;

export interface CostSummary {
  readonly totalMicroUsd: MicroUsd;
  readonly currency: "usd";
}

export interface UsageSummary {
  /** Provider-reported model usage (input/output tokens, when known). */
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface RouteSummary {
  /** Opaque provider/model identifiers (neutral strings — never SDK types). */
  readonly provider: string | null;
  readonly model: string | null;
  /** Strategy class of the executed plan (deterministic-only | hybrid | …). */
  readonly strategyClass: string | null;
  readonly modelCalls: number;
}

// ---------------------------------------------------------------------------
// Verification evidence (the public projection of the verification axis)
// ---------------------------------------------------------------------------

export const VERIFICATION_STATUSES = ["PASS", "FAIL", "INCONCLUSIVE"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export interface VerificationResult {
  readonly id: string;
  readonly executionId: string;
  readonly criterionId: string;
  /** How the criterion was evaluated (strategy identity, neutral). */
  readonly strategy: string;
  readonly status: VerificationStatus;
  readonly confidence: number | null;
  readonly evaluator: { readonly kind: string; readonly id: string; readonly version: string };
  readonly evidenceRefs: readonly string[];
  readonly recordedAt: string;
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export interface ArtifactReference {
  readonly id: string;
  /** Content digest (sha256 hex) when the platform recorded one. */
  readonly digest: string | null;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface ExecutionEvent {
  readonly eventId: string;
  readonly executionId: string;
  readonly type: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// The execution record (GET /executions/:id) — policy-visible metadata only
// ---------------------------------------------------------------------------

export interface Execution {
  readonly id: string;
  readonly applicationId: string;
  readonly environmentId: string | null;
  readonly status: ExecutionStatus;
  readonly task: Readonly<Record<string, unknown>>;
  readonly constraints: Readonly<Record<string, unknown>> | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt: string | null;
}

/** The durable create/refresh outcome of POST /executions. */
export interface ExecutionReceipt {
  readonly executionId: string;
  readonly applicationId: string;
  readonly status: ExecutionStatus;
  readonly createdAt: string;
  /** True when the same idempotency key replayed a durable outcome. */
  readonly replayed: boolean;
  readonly lastEventSequence: number;
}

// ---------------------------------------------------------------------------
// Execution creation input (API-001: provider selection is FORBIDDEN)
// ---------------------------------------------------------------------------

/**
 * The execution request. There is NO provider/model/rail/connection field
 * — the platform plans the route (API-001, the frozen create contract).
 */
export interface ExecutionRequest {
  readonly applicationId: string;
  readonly environmentId?: string;
  readonly task: Readonly<Record<string, unknown>>;
  readonly inputArtifactRefs?: readonly string[];
  readonly constraints?: {
    readonly maxCostMicroUsd?: MicroUsd;
    readonly maxLatencyMs?: number;
    readonly minQuality?: number;
  };
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** End user the execution (and any spend) is attributed to. */
  readonly userId?: string;
}

/**
 * Vocabulary that must NEVER appear in an execution request — the server
 * rejects it fail-closed (the executions create contract's own rule);
 * the SDK rejects it client-side as a convenience.
 */
export const FORBIDDEN_REQUEST_KEYS: readonly string[] = [
  "provider",
  "providerId",
  "model",
  "modelId",
  "rail",
  "connectionId",
  "connection",
  "agent",
  "agentId",
];

// ---------------------------------------------------------------------------
// The completed result package (IMPLEMENTATION.md §6)
// ---------------------------------------------------------------------------

export interface ExecutionResult {
  readonly executionId: string;
  readonly status: ExecutionStatus;
  readonly route: RouteSummary | null;
  readonly cost: CostSummary | null;
  readonly usage: UsageSummary | null;
  readonly outputArtifacts: readonly ArtifactReference[];
  readonly verification: readonly VerificationResult[];
  readonly warnings: readonly string[];
  readonly terminalAt: string | null;
}

// ---------------------------------------------------------------------------
// Agent inventory projection (read-only, ACP-001/002 via WORK-015)
// ---------------------------------------------------------------------------

export type AgentLifecycleStatus = "active" | "suspended" | "retired";
export type VersionValidationState = "pending" | "validated" | "invalid";
export type AgentSelectionKind = "promotion" | "rollback";

/** The governed agent inventory record (projection over /agents). */
export interface AgentSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: AgentLifecycleStatus;
  readonly activeVersionId: string | null;
  readonly activeVersion: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentVersion {
  readonly id: string;
  readonly agentId: string;
  readonly version: string;
  readonly definitionDigest: string;
  readonly validationState: VersionValidationState;
  readonly validationNotes: string | null;
  readonly createdAt: string;
}

export interface AgentPromotionStatus {
  readonly selectionId: string;
  readonly kind: AgentSelectionKind;
  readonly selectedVersionId: string;
  readonly rollbackOf: string | null;
  readonly selectedBy: string;
  readonly selectedAt: string;
}

export interface AgentStatusView {
  readonly agent: AgentSummary;
  readonly activeVersion: AgentVersion | null;
  readonly latestSelection: AgentPromotionStatus | null;
  readonly availableVersions: readonly AgentVersion[];
}

// ---------------------------------------------------------------------------
// Webhooks (API-004): signed, versioned, idempotently receivable
// ---------------------------------------------------------------------------

/** The signed webhook envelope delivered to customer endpoints. */
export interface WebhookEvent {
  /** The webhook payload schema version (payload compatibility anchor). */
  readonly schemaVersion: number;
  /** The execution this event is about. */
  readonly executionId: string;
  /** Durable event identity (dedupe key for idempotent receivers). */
  readonly eventId: string;
  readonly type: string;
  readonly sequence: number;
  /** The delivery attempt number (1 = first attempt). */
  readonly attempt: number;
  readonly occurredAt: string;
  readonly deliveredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** The canonical bytes a sender signs and a receiver verifies. */
export function webhookSignatureBasis(event: WebhookEvent): string {
  return JSON.stringify({
    schemaVersion: event.schemaVersion,
    executionId: event.executionId,
    eventId: event.eventId,
    type: event.type,
    sequence: event.sequence,
    attempt: event.attempt,
    occurredAt: event.occurredAt,
    deliveredAt: event.deliveredAt,
    payload: event.payload,
  });
}

/**
 * RECEIVER-SIDE IDEMPOTENCY GUIDANCE (API-004/M10): the durable event
 * identity of a webhook is `eventId`; a receiver should process each
 * event EXACTLY ONCE keyed by `eventId`, treating later attempts of the
 * SAME eventId as replays (ack them, do not re-apply effects). The
 * `attempt` field distinguishes redeliveries (retry policy) from new
 * events.
 */
export function webhookDedupeKey(event: WebhookEvent): string {
  return event.eventId;
}

// ---------------------------------------------------------------------------
// The public error model (the canonical taxonomy, stable codes)
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  "AUTHENTICATION_FAILED",
  "AUTHORIZATION_DENIED",
  "TENANT_SCOPE_VIOLATION",
  "POLICY_DENIED",
  "BUDGET_EXCEEDED",
  "IDEMPOTENCY_KEY_REUSED",
  "CAPABILITY_UNAVAILABLE",
  "NO_ELIGIBLE_ROUTE",
  "PROVIDER_ERROR",
  "TOOL_ERROR",
  "AGENT_ERROR",
  "SANDBOX_ERROR",
  "VERIFICATION_FAILED",
  "VERIFICATION_INCONCLUSIVE",
  "NON_CONVERGENT_EXTERNAL_EFFECT",
  "INVALID_STATE_TRANSITION",
  "EXPIRED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** The machine-readable public error body (never a stack trace). */
export interface PublicError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  /** Structured machine-readable detail (never secret material). */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Correlation identifier for support (never internal host paths). */
  readonly requestId?: string;
}
