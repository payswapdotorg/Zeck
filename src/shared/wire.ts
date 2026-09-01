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
// Economic actions (WORK-032 / ECO-001..008): the governed agentic
// economic-intent projection. Provider-neutral and secret-safe: recipient
// references are opaque external identifiers, rail preferences are opaque
// neutral strings, and there is NO field where a raw payment credential
// could even appear (bounded/tokenized authorization references only —
// the authorization itself never crosses this wire).
// ---------------------------------------------------------------------------

/** The economic-action lifecycle (the domain vocabulary, projected 1:1). */
export const ECONOMIC_ACTION_STATUSES = [
  "proposed",
  "denied",
  "authorized",
  "executing",
  "settled",
  "failed",
  "expired",
] as const;

export type EconomicActionStatus = (typeof ECONOMIC_ACTION_STATUSES)[number];

/** Bounded amount: exact or an explicit range (integer micro-USD strings). */
export type EconomicAmount =
  | { readonly kind: "exact"; readonly microUsd: MicroUsd }
  | { readonly kind: "range"; readonly minMicroUsd: MicroUsd; readonly maxMicroUsd: MicroUsd };

/** An opaque external recipient/seller reference (never a credential). */
export interface EconomicRecipient {
  readonly kind: string;
  readonly id: string;
}

export interface EconomicCapabilityRef {
  readonly kind: string;
  readonly name: string;
  readonly minVersion: string | null;
}

/** GET /economic-actions/:id — the durable economic-intent record. */
export interface EconomicAction {
  readonly id: string;
  readonly applicationId: string;
  /** The logical execution this economic action is provenance-bound to. */
  readonly executionId: string;
  /** The actor that PROPOSED the intent (provenance, never an approver). */
  readonly proposedBy: string;
  readonly purpose: string;
  readonly recipient: EconomicRecipient;
  readonly amount: EconomicAmount;
  readonly currency: string;
  readonly expiresAt: string;
  readonly requiredCapabilities: readonly EconomicCapabilityRef[];
  readonly railPreference: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly status: EconomicActionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The durable create/refresh outcome of POST /economic-actions. */
export interface EconomicActionReceipt {
  readonly economicActionId: string;
  readonly applicationId: string;
  readonly executionId: string;
  readonly status: EconomicActionStatus;
  readonly createdAt: string;
  /** True when the same idempotency key replayed a durable outcome. */
  readonly replayed: boolean;
}

/** An economic-action provenance event (the per-action ledger). */
export interface EconomicActionEvent {
  readonly eventId: string;
  readonly economicActionId: string;
  readonly sequence: number;
  readonly type: string;
  readonly cause: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * A correlated EXTERNAL settlement observation (evidence only — never a
 * Zeck money-movement truth source; the budgets authority owns that).
 */
export interface EconomicSettlement {
  readonly id: string;
  readonly railId: string;
  readonly railTransactionRef: string;
  readonly status: "observed" | "confirmed" | "failed";
  readonly settledAmountMicroUsd: MicroUsd;
  readonly currency: string;
  readonly observedAt: string;
  readonly evidenceDigest: string;
}

/** Delivery EVIDENCE (the verification authority alone decides delivery). */
export interface EconomicDelivery {
  readonly id: string;
  readonly kind: string;
  readonly digest: string;
  readonly contentRef: string;
  readonly observedAt: string;
}

/**
 * GET /economic-actions/:id/outcome — settlement and delivery reported as
 * SEPARATE axes (payment success != resource delivered != execution
 * success; a settlement alone never proves delivery).
 */
export interface EconomicActionOutcome {
  readonly economicActionId: string;
  readonly executionId: string;
  readonly applicationId: string;
  readonly status: EconomicActionStatus;
  readonly settlement: EconomicSettlement | null;
  readonly deliveries: readonly EconomicDelivery[];
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
// Codebase opportunity analysis (WORK-022 / DTR-005 — advisory, read-only)
// ---------------------------------------------------------------------------

/** The advisory finding states (never 'promoted' — that is not a public state). */
export const CODEBASE_FINDING_STATES = ["advisory", "candidate", "verified"] as const;

export type CodebaseFindingState = (typeof CODEBASE_FINDING_STATES)[number];

/** The public opportunity-class vocabulary (mirrors the learning domain). */
export const CODEBASE_OPPORTUNITY_CLASSES = [
  "ai-addition",
  "ai-removal",
  "deterministic-replacement",
  "tool-replacement",
  "tool-composition",
  "hybrid-decomposition",
  "context-enhancement",
  "verification-enhancement",
  "human-evaluation",
] as const;

export type CodebaseOpportunityClass = (typeof CODEBASE_OPPORTUNITY_CLASSES)[number];

/** Cost/latency impact with the honest basis (measured | estimated | unknown). */
export interface CodebaseImpact {
  readonly currentMicroUsd?: string | null;
  readonly candidateMicroUsd?: string | null;
  readonly expectedSavingsMicroUsd?: string | null;
  readonly basis: "measured" | "estimated" | "unknown";
  readonly currentMs?: number | null;
  readonly candidateMs?: number | null;
}

/** One advisory finding of a codebase analysis (provenance-pinned). */
export interface CodebaseFinding {
  readonly findingId: string;
  readonly analysisId: string;
  readonly class: CodebaseOpportunityClass;
  readonly state: CodebaseFindingState;
  readonly targetNodeIds: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly provenance: {
    readonly repository: string;
    readonly revision: string;
    readonly targets: readonly {
      readonly nodeId: string;
      readonly file: string;
      readonly symbol: string | null;
    }[];
  };
  readonly confidence: {
    readonly level: string;
    readonly population: number;
    readonly basis: string;
  };
  readonly impact: CodebaseImpact;
  readonly deterministicEquivalence: {
    readonly potential: string;
    readonly basis: readonly string[];
  };
  readonly recommendation: {
    readonly strategy: string;
    readonly validationSteps: readonly string[];
  };
  readonly recordedAt: string;
}

/** A selective human-evaluation prompt (value-of-information gated). */
export interface CodebasePrompt {
  readonly promptId: string;
  readonly findingId: string;
  readonly questionKind: string;
  readonly question: string;
  readonly expectedInformationGain: number;
  readonly userFrictionThreshold: number;
  readonly basis: readonly string[];
  readonly emittedAt: string;
}

/** The analysis-run record (bound to the governing analysis execution). */
export interface CodebaseAnalysis {
  readonly analysisId: string;
  readonly applicationId: string;
  readonly executionId: string;
  readonly repository: string;
  readonly revision: string;
  readonly analysisVersion: number;
  readonly findingCount: number;
  readonly promptCount: number;
  readonly digest: string;
  readonly recordedAt: string;
  readonly replayed: boolean;
}

/** GET /codebase-analysis/:id — the full advisory report. */
export interface CodebaseAnalysisReport {
  readonly analysis: CodebaseAnalysis;
  readonly findings: readonly CodebaseFinding[];
  readonly prompts: readonly CodebasePrompt[];
}

/** The immutable evaluation-rating receipt (preference-only answers). */
export interface CodebaseRatingReceipt {
  readonly ratingId: string;
  readonly findingId: string;
  readonly replayed: boolean;
  /** The recorded answer (preference vocabulary — never a verification PASS). */
  readonly answer: string;
}

/** The evidence-gated finding-transition receipt. */
export interface CodebaseFindingTransitionReceipt {
  readonly transitionId: string;
  readonly findingId: string;
  readonly fromState: CodebaseFindingState;
  readonly toState: CodebaseFindingState;
  readonly replayed: boolean;
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
