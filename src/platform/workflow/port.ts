/**
 * Workflow orchestration port (provider-neutral durable orchestration;
 * WORK-045 / D-04, `docs/DEPLOYMENT-ARCHITECTURE.md` §10).
 *
 * D1.0's orchestration model, as one owned port:
 *
 *  - an orchestration WAIT is durable intent: the PostgreSQL wait
 *    record (`correlation.ts`) commits BEFORE any provider workflow
 *    instance is created or relied upon (correlation-before-reliance);
 *  - the provider workflow INSTANCE is a non-authoritative durable
 *    engine that holds the wait across process and provider-worker
 *    restarts. Instance state is ORCHESTRATION/PROGRESS EVIDENCE
 *    ONLY: it never establishes execution success or authoritative
 *    status — PostgreSQL stays the sole durable Zeck authority;
 *  - RESOLUTION notifications (external callbacks, human approval
 *    decisions, deadline elapse) are recorded durably FIRST, then the
 *    governed effect re-enters the EXISTING execution write path
 *    (the `GovernedOrchestrationEffect` seam), and only then is the
 *    provider instance signaled (a transport fact, never authority);
 *  - every retry/replacement budget is bounded and repository-defined:
 *    exhaustion produces an explicit terminal outcome, never an
 *    infinite orchestration loop;
 *  - provider outage degrades orchestration (the declared
 *    `orchestration-paused` mode) without fabricating authoritative
 *    execution progress.
 *
 * The port is PROVIDER-NEUTRAL by construction: no vendor concept
 * appears here. Instance ids and observation statuses are neutral
 * handles/vocabulary mapped by the owning adapter; provider SDKs and
 * workflow types stay behind the adapter module (pinned by the
 * architecture tests).
 *
 * Payload discipline: orchestration payloads are REFERENCE-ONLY —
 * ids, keys and provenance digests. Large artifact bytes and secret
 * values never enter workflow state (bounded by the state bounds
 * below and proven by the test battery).
 */

/** Failure classification the adapters must produce (fail closed). */
export type WorkflowFailureKind = "transient" | "permanent";

/** Provider-neutral orchestration error. Never carries secret material. */
export class WorkflowTransportError extends Error {
  readonly failureKind: WorkflowFailureKind;
  /** HTTP status when the provider answered (for evidence only). */
  readonly status: number | null;
  /** Provider-side error code when present (for evidence only). */
  readonly providerCode: string | null;

  constructor(
    message: string,
    failureKind: WorkflowFailureKind,
    options?: { readonly status?: number; readonly providerCode?: string | null },
  ) {
    super(message);
    this.name = "WorkflowTransportError";
    this.failureKind = failureKind;
    this.status = options?.status ?? null;
    this.providerCode = options?.providerCode ?? null;
  }
}

/** Invalid orchestration configuration (fail closed before any wire call). */
export class WorkflowConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowConfigError";
  }
}

/**
 * The governed wait kinds. `timer` = the wait elapses at its deadline
 * (bounded sleep); `callback` = the wait resolves when an external
 * party notifies the intake; `approval` = the wait resolves when a
 * human records an approval decision (approve resumes, reject cancels
 * — both through the governed execution path).
 */
export const ORCHESTRATION_WAIT_KINDS = ["timer", "callback", "approval"] as const;
export type OrchestrationWaitKind = (typeof ORCHESTRATION_WAIT_KINDS)[number];

export function isOrchestrationWaitKind(value: string): value is OrchestrationWaitKind {
  return (ORCHESTRATION_WAIT_KINDS as readonly string[]).includes(value);
}

/**
 * The orchestration wait progress vocabulary. DELIBERATELY DISJOINT
 * from the frozen execution state vocabulary (case-insensitively —
 * the D-03 lesson): there is no mapping between the two vocabularies
 * and no second execution state machine.
 *
 *   recorded   durable intent committed; no provider instance yet
 *   deferred   start attempts exhausted against an unavailable
 *              provider (recoverable, explicit — the declared
 *              orchestration-paused degradation)
 *   armed      provider instance created; the wait is durably held
 *   signaled   a resolution notification is durably recorded; the
 *              governed effect is pending
 *   settled    terminal: the governed effect was applied
 *   elapsed    terminal: the deadline passed and the governed
 *              expiration was applied
 *   superseded terminal: the execution moved on by another governed
 *              path (the wait is stale, never fired)
 *   abandoned  terminal: bounded failure exhaustion or an explicit
 *              governed refusal
 */
export const ORCHESTRATION_WAIT_STATES = [
  "recorded",
  "deferred",
  "armed",
  "signaled",
  "settled",
  "elapsed",
  "superseded",
  "abandoned",
] as const;
export type OrchestrationWaitState = (typeof ORCHESTRATION_WAIT_STATES)[number];

export function isOrchestrationWaitState(value: string): value is OrchestrationWaitState {
  return (ORCHESTRATION_WAIT_STATES as readonly string[]).includes(value);
}

/** Terminal wait states — immutable once reached (physical guard). */
export const TERMINAL_WAIT_STATES: readonly OrchestrationWaitState[] = [
  "settled",
  "elapsed",
  "superseded",
  "abandoned",
];

export function isTerminalWaitState(state: OrchestrationWaitState): boolean {
  return TERMINAL_WAIT_STATES.includes(state);
}

/**
 * The legal wait progress transitions (trigger-enforced in the
 * physical schema; the engine never writes state directly).
 */
export const WAIT_STATE_TRANSITIONS: Readonly<
  Record<OrchestrationWaitState, readonly OrchestrationWaitState[]>
> = Object.freeze({
  recorded: ["deferred", "armed", "abandoned"],
  deferred: ["armed", "abandoned"],
  armed: ["signaled", "elapsed", "superseded", "abandoned"],
  signaled: ["settled", "superseded", "abandoned"],
  settled: [],
  elapsed: [],
  superseded: [],
  abandoned: [],
});

export function canTransitionWait(
  from: OrchestrationWaitState,
  to: OrchestrationWaitState,
): boolean {
  return WAIT_STATE_TRANSITIONS[from].includes(to);
}

/**
 * Provider-OBSERVED instance status (a neutral observation
 * vocabulary mapped by the adapter from the provider's own states).
 * This is evidence about the provider engine, NEVER an authority
 * claim about executions.
 */
export const OBSERVED_INSTANCE_STATUSES = [
  "active",
  "paused",
  "errored",
  "terminated",
  "complete",
  "unknown",
] as const;
export type ObservedInstanceStatus = (typeof OBSERVED_INSTANCE_STATUSES)[number];

export function isObservedInstanceStatus(value: string): value is ObservedInstanceStatus {
  return (OBSERVED_INSTANCE_STATUSES as readonly string[]).includes(value);
}

/** One provider-observed instance snapshot (evidence only). */
export interface InstanceObservation {
  readonly status: ObservedInstanceStatus;
  /** Scrubbed observational detail (never secret material). */
  readonly detail: string | null;
}

/** Receipt of an accepted instance start. A transport fact, NOT success. */
export interface InstanceReceipt {
  /** Opaque provider instance handle (ephemeral; never authority). */
  readonly instanceId: string;
}

/** The input to one instance start. */
export interface StartInstanceInput {
  /**
   * A stable, traceable instance hint derived from the wait identity
   * (the adapter passes it as the provider's optional instance id).
   */
  readonly instanceHint: string;
  /**
   * The REFERENCE-ONLY pointer payload (ids, keys, digests, dates —
   * bounded by the state bounds; secrets and artifact bytes are
   * unrepresentable by construction and rejected fail-closed).
   */
  readonly params: Readonly<Record<string, unknown>>;
}

/** The input to one instance signal (resolution notification). */
export interface SignalInstanceInput {
  readonly instanceId: string;
  /** Application-defined neutral event type (e.g. "zeck.callback"). */
  readonly eventType: string;
  /** REFERENCE-ONLY signal body (bounded by the state bounds). */
  readonly body: Readonly<Record<string, unknown>>;
}

/** The input to one instance termination (provider-state compaction). */
export interface TerminateInstanceInput {
  readonly instanceId: string;
  readonly reason: string;
}

/**
 * Provider limits, explicitly declared and inspectable (the work
 * order's provider-limit invariant: limits are never implicit).
 * `documented` carries the provider-documented facts verbatim
 * (human-readable); the numeric bounds are what this machinery
 * actually enforces.
 */
export interface WorkflowProviderLimits {
  /** Documented provider limit facts (evidence, provider-sourced). */
  readonly documented: Readonly<Record<string, string>>;
  /** Maximum signal/params payload bytes the adapter allows on the wire. */
  readonly maxPayloadBytes: number;
  /** Whether instance termination is supported (compaction capability). */
  readonly supportsTermination: boolean;
}

/**
 * The provider-neutral workflow orchestration port (application
 * boundary). Implementations: the production REST adapter and test
 * doubles implementing the same contract.
 */
export interface WorkflowOrchestrationPort {
  /** Start one instance. Fails closed with a typed error on failure. */
  startInstance(input: StartInstanceInput): Promise<InstanceReceipt>;
  /** Observe one instance (evidence only; never authority). */
  describeInstance(instanceId: string): Promise<InstanceObservation>;
  /** Deliver one resolution signal to an instance (transport fact). */
  signalInstance(input: SignalInstanceInput): Promise<void>;
  /** Terminate one instance (bounded provider state; transport fact). */
  terminateInstance(input: TerminateInstanceInput): Promise<void>;
  /** The explicit, inspectable provider limits. */
  describeLimits(): WorkflowProviderLimits;
}

/**
 * Bounded orchestration retry policy — repository configuration,
 * never hidden defaults, never unbounded. All budgets are STRICT
 * upper bounds: reaching them produces an explicit terminal outcome
 * (deferred / abandoned / delivery-exhaustion evidence), never an
 * infinite loop.
 */
export interface WorkflowRetryPolicy {
  /** Maximum instance-start attempts for one wait before `deferred`. */
  readonly maxStartAttempts: number;
  /** Maximum provider-signal delivery attempts for one notification. */
  readonly maxSignalAttempts: number;
  /**
   * Maximum governed-effect application attempts for one resolution
   * (transient failures only; permanent refusals land immediately).
   */
  readonly maxEffectAttempts: number;
  /** Maximum replacements issued from one wait lineage (bounded). */
  readonly maxReplacements: number;
  /** Deterministic linear backoff base (attempt * base, capped at 60s). */
  readonly retryBackoffMs: number;
}

/**
 * Bounded orchestration state: the reference-only payload byte cap
 * and the per-wait retained-notification bound (the compaction fold
 * threshold beyond which refused/stale notifications only increment
 * the durable folded counter — bounded state by construction).
 */
export interface WorkflowStateBounds {
  /** Maximum canonical pointer/signal payload bytes (fail-closed). */
  readonly maxPayloadBytes: number;
  /**
   * Maximum notification rows retained per wait before folding into
   * the durable counter (bounded, inspectable compaction).
   */
  readonly maxRetainedNotifications: number;
}

/** Failing closed on unbounded/non-positive policy is a property. */
export const MIN_RETRY_BOUND = 1;
export const MAX_RETRY_BOUND = 100;
export const MAX_RETRY_BACKOFF_MS = 60_000;
/** Reference payloads are pointer-sized; large bytes are unrepresentable. */
export const MAX_PAYLOAD_BYTES_BOUND = 65_536;
export const MIN_PAYLOAD_BYTES_BOUND = 256;
export const MIN_RETAINED_NOTIFICATIONS = 1;
export const MAX_RETAINED_NOTIFICATIONS = 10_000;

/** Validate a retry policy: bounded, positive, deterministic. */
export function validateRetryPolicy(policy: WorkflowRetryPolicy): WorkflowRetryPolicy {
  const problems: string[] = [];
  for (const [name, value] of [
    ["maxStartAttempts", policy.maxStartAttempts],
    ["maxSignalAttempts", policy.maxSignalAttempts],
    ["maxEffectAttempts", policy.maxEffectAttempts],
    ["maxReplacements", policy.maxReplacements],
  ] as const) {
    if (!Number.isInteger(value) || value < MIN_RETRY_BOUND || value > MAX_RETRY_BOUND) {
      problems.push(`${name} must be an integer in [${MIN_RETRY_BOUND}, ${MAX_RETRY_BOUND}]`);
    }
  }
  if (
    !Number.isInteger(policy.retryBackoffMs) ||
    policy.retryBackoffMs < MIN_RETRY_BOUND ||
    policy.retryBackoffMs > MAX_RETRY_BACKOFF_MS
  ) {
    problems.push(
      `retryBackoffMs must be an integer in [${MIN_RETRY_BOUND}, ${MAX_RETRY_BACKOFF_MS}]`,
    );
  }
  if (problems.length > 0) {
    throw new WorkflowConfigError(`invalid workflow retry policy: ${problems.join("; ")}`);
  }
  return policy;
}

/** Validate the state bounds (bounded, inspectable compaction). */
export function validateStateBounds(bounds: WorkflowStateBounds): WorkflowStateBounds {
  const problems: string[] = [];
  if (
    !Number.isInteger(bounds.maxPayloadBytes) ||
    bounds.maxPayloadBytes < MIN_PAYLOAD_BYTES_BOUND ||
    bounds.maxPayloadBytes > MAX_PAYLOAD_BYTES_BOUND
  ) {
    problems.push(
      `maxPayloadBytes must be an integer in [${MIN_PAYLOAD_BYTES_BOUND}, ${MAX_PAYLOAD_BYTES_BOUND}] (reference-only pointer payloads; large bytes never enter workflow state)`,
    );
  }
  if (
    !Number.isInteger(bounds.maxRetainedNotifications) ||
    bounds.maxRetainedNotifications < MIN_RETAINED_NOTIFICATIONS ||
    bounds.maxRetainedNotifications > MAX_RETAINED_NOTIFICATIONS
  ) {
    problems.push(
      `maxRetainedNotifications must be an integer in [${MIN_RETAINED_NOTIFICATIONS}, ${MAX_RETAINED_NOTIFICATIONS}]`,
    );
  }
  if (problems.length > 0) {
    throw new WorkflowConfigError(`invalid workflow state bounds: ${problems.join("; ")}`);
  }
  return bounds;
}

/** Deterministic bounded backoff between attempts (milliseconds). */
export function backoffDelayMs(policy: WorkflowRetryPolicy, nextAttempt: number): number {
  const attempt = Math.max(1, nextAttempt);
  return Math.min(policy.retryBackoffMs * attempt, MAX_RETRY_BACKOFF_MS);
}

/**
 * The governed-effect seam: how a resolved wait re-enters the EXISTING
 * governed execution path.
 *
 * The platform orchestration machinery never imports domain modules
 * (platform isolation). The composition root wires an implementation
 * of this seam (the executions module adapter
 * `src/modules/executions/adapters/workflow-effect.ts`) that applies
 * the authoritative mutation through the single execution write path
 * with ALL admission gates intact. The seam is the entire integration
 * surface between the orchestration and the execution authority.
 */
export interface GovernedWaitResolution {
  /** The authoritative wait record for this resolution. */
  readonly wait: OrchestrationWait;
  /** What resolved the wait. */
  readonly cause:
    | { readonly kind: "callback"; readonly notificationKey: string }
    | {
        readonly kind: "approval";
        readonly decision: "approve" | "reject";
        readonly approverId: string;
        readonly notificationKey: string;
      }
    | { readonly kind: "deadline" };
}

export type GovernedResolutionOutcome =
  | { readonly outcome: "applied"; readonly detail?: string }
  | { readonly outcome: "already-applied"; readonly detail?: string }
  | {
      /**
       * The governed path itself refused the resolution (permanent).
       *
       * `movedOn` is the DOMAIN-side classification that the refusal
       * means the execution already progressed by another governed
       * path (the wait is stale, not failed). The classification is
       * domain knowledge — the platform plane never interprets
       * governed rejection codes.
       */
      readonly outcome: "rejected";
      readonly reason: string;
      readonly movedOn?: boolean;
    };

export interface GovernedOrchestrationEffect {
  /**
   * Apply the authoritative effect for one resolved wait. MUST be
   * idempotent: the same resolution MAY be handed over more than
   * once (duplicate notifications, crash-after-mutation, restart
   * recovery). The implementation converges through the existing
   * PostgreSQL idempotency semantics — a repeated handoff replays
   * the durable outcome, never a second authoritative effect.
   *
   * Transient failures propagate as exceptions; the engine retries
   * them within the bounded effect budget. A thrown error is NEVER
   * interpreted as success.
   */
  apply(
    resolution: GovernedWaitResolution,
    idempotencyKey: string,
  ): Promise<GovernedResolutionOutcome>;
}

/**
 * The durable orchestration wait record (read shape).
 *
 * One row exists in PostgreSQL for every orchestration wait BEFORE
 * any provider instance is relied upon. This is ORCHESTRATION
 * PROGRESS state only — it never defines execution status; the
 * authoritative execution lifecycle stays in the executions module's
 * single write path. The vocabulary above is deliberately disjoint
 * from the execution state vocabulary (no second state machine).
 */
export interface OrchestrationWait {
  readonly id: string;
  /**
   * Stable authoritative correlation identity (deterministic, unique).
   * The provider instance receives this key in its pointer params;
   * every continuation path resolves the authoritative record from
   * PostgreSQL by it — provider state is never authority.
   */
  readonly waitKey: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly executionId: string;
  readonly waitKind: OrchestrationWaitKind;
  /** Replacement ordinal within the wait lineage (0 = original). */
  readonly waitOrdinal: number;
  /** The wait this one replaces, when a bounded replacement. */
  readonly replacementOf: string | null;
  /** REFERENCE-ONLY pointer payload (ids + provenance; never bytes). */
  readonly pointerPayload: Readonly<Record<string, unknown>>;
  /** sha256 of the canonical pointer payload (provenance without trust). */
  readonly payloadDigest: string;
  /** The deadline the timer elapses at (null = no deadline). */
  readonly deadline: string | null;
  readonly state: OrchestrationWaitState;
  /** The provider instance this wait armed (transport handle). */
  readonly providerInstanceId: string | null;
  /** Last provider-observed instance status (evidence only). */
  readonly providerObservedStatus: string | null;
  readonly providerObservedAt: string | null;
  /** When compaction terminated the provider instance (bounded state). */
  readonly providerTerminatedAt: string | null;
  /** Instance-start attempts consumed (bounded by the retry policy). */
  readonly startAttempts: number;
  /** Provider-signal delivery attempts for the resolving notification. */
  readonly signalDeliveryAttempts: number;
  /** Notification rows retained for this wait (compaction-bounded). */
  readonly retainedNotifications: number;
  /** Folded (unmaterialized) notification count — the compaction counter. */
  readonly foldedNotifications: number;
  /** The governed effect's deterministic idempotency key, when applied. */
  readonly appliedOperationKey: string | null;
  readonly appliedAt: string | null;
  readonly settledAt: string | null;
  readonly elapsedAt: string | null;
  readonly supersededAt: string | null;
  readonly abandonedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Outcome vocabulary for durable notification records. */
export const NOTIFICATION_OUTCOMES = [
  /** The notification resolved the wait (first resolution wins). */
  "accepted",
  /** Same logical notification delivered again (deterministic key). */
  "duplicate",
  /** A late notification after the wait resolved (stale, refused). */
  "refused-stale",
  /** A conflicting approval decision after the first was recorded. */
  "refused-conflict",
  /** A wrong-tenant claim (forged scope; refused fail-closed). */
  "refused-scope",
  /** Beyond the retained-notification bound (folded to the counter). */
  "refused-folded",
] as const;
export type NotificationOutcome = (typeof NOTIFICATION_OUTCOMES)[number];

/**
 * The stable wait identity for one logical orchestration.
 * Deterministic so the SAME logical wait (same execution, kind,
 * lineage ordinal) always correlates to the SAME key — the
 * duplicate-suppression and idempotency anchor.
 */
export function orchestrationWaitKey(
  executionId: string,
  kind: OrchestrationWaitKind,
  ordinal: number,
): string {
  return `wait:${executionId}:${kind}:${ordinal}`;
}

/**
 * The deterministic governed-effect idempotency key for one wait.
 * Exactly one authoritative effect ever applies per wait (first
 * resolution wins; duplicates converge through the executions
 * idempotency arbitration).
 */
export function waitEffectIdempotencyKey(waitKey: string): string {
  return `workflow-effect:${waitKey}`;
}

/**
 * Canonical payload digest: sha256 over the canonical JSON (sorted
 * keys) of the payload. Two pointer payloads are the same logical
 * message iff their digests are byte-equal — mismatch on intake is
 * a fail-closed integrity signal.
 */
export function canonicalPayloadJson(payload: Readonly<Record<string, unknown>>): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(sorted);
    }
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .map((key) => [key, sorted(record[key])]);
    }
    return value;
  };
  return JSON.stringify(sorted(payload));
}

/**
 * The pointer payload the engine builds for one armed wait
 * (secret-free, reference-only by construction).
 */
export type OrchestrationPointerPayload = {
  readonly v: 1;
  /** The authoritative wait key — the continuation lookup handle. */
  readonly waitKey: string;
  readonly waitKind: OrchestrationWaitKind;
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly deadline: string | null;
  readonly armedAt: string;
};

/**
 * The waiting-execution source seam: how the engine learns which
 * authoritative executions currently sit in a governed wait state
 * and which wait kind each maps to. Implemented by the executions
 * module adapter (the status→wait-kind mapping is DOMAIN knowledge
 * and stays out of the platform plane); the engine reconciles this
 * list against its own durable wait records.
 */
export interface OrchestrationCandidate {
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly waitKind: OrchestrationWaitKind;
  /** The deadline the engine should arm (null = no deadline). */
  readonly deadline: string | null;
  /** When the authoritative execution entered the wait state. */
  readonly enteredWaitAt: string;
}

export interface WaitingExecutionSource {
  /**
   * List executions currently in a governed wait state (read-only;
   * ordered oldest-first). Never authority for anything except the
   * candidate scan itself.
   */
  listOrchestrationCandidates(limit: number): Promise<readonly OrchestrationCandidate[]>;
}

/**
 * The neutral event types the engine delivers to provider instances
 * (the operator-deployed workflow code listens for exactly these —
 * the account-plane contract documented in deploy/README.md).
 */
export const SIGNAL_EVENT_TYPES = {
  callback: "zeck.callback",
  approval: "zeck.approval",
  deadline: "zeck.deadline",
  supersede: "zeck.supersede",
} as const;
