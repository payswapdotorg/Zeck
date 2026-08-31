/**
 * Deployment + lifecycle domain (deployments module domain; WORK-023,
 * MOD-002/MOD-003, ADR-0014).
 *
 * `Deployment` is the Execution-adjacent CONTROL-PLANE object: the
 * durable identity binding (application, environment, agent,
 * agent-version) that points at ONE immutable plan version and moves
 * between plan versions through APPEND-ONLY lifecycle events. It is
 * NOT a second execution system:
 *
 *   - there is NO execution state machine here (no transitions into
 *     execution statuses; deployments govern configuration, not
 *     runs — executions remain the runs, in /executions);
 *   - the lifecycle is small and subordinate: `active | suspended |
 *     retired` with `retired` terminal-immutable;
 *   - every mutation is an AUDITED journal append (actor, cause,
 *     prior/current plan version, optional execution provenance) —
 *     promotion and rollback NEVER rewrite history (a rollback is a
 *     new event pointing at the prior version, the agent-selection
 *     precedent);
 *   - deployment identity is MOD-002: bound to application +
 *     environment + agent + agent-version; a DIFFERENT agent version
 *     is a different deployment (parallel identities), so promotion
 *     (which preserves identity) can only move between plans whose
 *     agent reference MATCHES the deployment's binding.
 */

/** The deployment lifecycle statuses (the control-plane states). */
export const DEPLOYMENT_STATUSES = ["active", "suspended", "retired"] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export function isDeploymentStatus(value: string): value is DeploymentStatus {
  return (DEPLOYMENT_STATUSES as readonly string[]).includes(value);
}

/**
 * The legal control-plane STATUS transitions. PLAN MOVES (promote/
 * rollback) do not change status and are guarded by the plan-version
 * guard instead — the strict table governs status changes only.
 */
export const DEPLOYMENT_STATUS_TRANSITIONS: Readonly<
  Record<DeploymentStatus, readonly DeploymentStatus[]>
> = {
  active: ["suspended", "retired"],
  suspended: ["active", "retired"],
  retired: [],
};

export function canTransitionDeployment(from: DeploymentStatus, to: DeploymentStatus): boolean {
  return DEPLOYMENT_STATUS_TRANSITIONS[from].includes(to);
}

/** Terminal: no further transitions; the journal is history. */
export function isTerminalDeploymentStatus(status: DeploymentStatus): boolean {
  return status === "retired";
}

/**
 * The lifecycle event kinds (MOD-3: every lifecycle change is
 * idempotent, auditable, concurrency-safe; the journal vocabulary).
 */
export const DEPLOYMENT_EVENT_KINDS = [
  "create",
  "promote",
  "rollback",
  "suspend",
  "resume",
  "retire",
] as const;
export type DeploymentEventKind = (typeof DEPLOYMENT_EVENT_KINDS)[number];

export function isDeploymentEventKind(value: string): value is DeploymentEventKind {
  return (DEPLOYMENT_EVENT_KINDS as readonly string[]).includes(value);
}

/** The immutable durable deployment record. */
export interface DeploymentRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** MOD-002: identity binding. */
  readonly environmentId: string;
  readonly agentId: string;
  readonly agentVersion: string;
  readonly agentKind: "zeck" | "byoa";
  /** Caller-chosen stable slug (unique per application). */
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: DeploymentStatus;
  /** The currently active plan identity + version (the pointer). */
  readonly currentPlanId: string;
  readonly currentPlanVersion: number;
  /** Number of applied plan advances (create = 0). */
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The append-only lifecycle journal record (MOD-003's audit). */
export interface DeploymentEventRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly deploymentId: string;
  readonly kind: DeploymentEventKind;
  /** Who performed the lifecycle operation. */
  readonly actorId: string;
  /** Why (bounded free text, secret-scanned). */
  readonly cause: string | null;
  /** The plan version before the event (null on create). */
  readonly priorPlanVersion: number | null;
  /** The plan version after the event (null on suspend/resume/retire). */
  readonly currentPlanVersion: number | null;
  /**
   * Execution provenance (MOD-003): the execution that commanded or
   * observed the lifecycle change, when one exists (control-plane
   * operations may also be operator-driven).
   */
  readonly executionId: string | null;
  /** Journal order (identity-ordered append sequence per deployment). */
  readonly eventSeq: number;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

/** Deployment creation input (validated fail-closed). */
export interface CreateDeploymentInput {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly environmentId: string;
  readonly agentId: string;
  readonly agentVersion: string;
  readonly agentKind: "zeck" | "byoa";
  /** The initial plan (its agent reference MUST match the binding). */
  readonly planId: string;
}

/**
 * Lifecycle mutation input (shared by promote/rollback/suspend/…).
 * `tenantId` is the SERVER-DERIVED actor scope (never a caller
 * assertion — the durable row's tenant decides).
 */
export interface DeploymentMutationInput {
  readonly applicationId: string;
  readonly deploymentId: string;
  readonly idempotencyKey: string;
  readonly actorId: string;
  readonly tenantId: string;
  readonly cause?: string;
  /** Execution provenance when the mutation is execution-driven. */
  readonly executionId?: string;
}

/** Promotion input (the target plan version). */
export interface PromoteDeploymentInput extends DeploymentMutationInput {
  readonly toPlanVersion: number;
}

export type DeploymentValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
export const DEPLOYMENT_KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;
const MAX_CAUSE = 2000;

/** Fail-closed validation of the creation input. */
export function validateCreateDeploymentInput(input: unknown): DeploymentValidation {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, reason: "deployment input must be an object" };
  }
  const c = input as unknown as CreateDeploymentInput;
  if (typeof c.slug !== "string" || !SLUG_PATTERN.test(c.slug)) {
    return { valid: false, reason: "slug must be a lowercase hyphen-dashed identifier" };
  }
  if (typeof c.name !== "string" || c.name.length < 1 || c.name.length > 200) {
    return { valid: false, reason: "name must be 1..200 characters" };
  }
  if (
    c.description !== undefined &&
    (typeof c.description !== "string" || c.description.length > 2000)
  ) {
    return { valid: false, reason: "description must be at most 2000 characters" };
  }
  if (typeof c.environmentId !== "string" || !UUID_PATTERN.test(c.environmentId)) {
    return { valid: false, reason: "environmentId must be a UUID" };
  }
  if (typeof c.agentId !== "string" || !UUID_PATTERN.test(c.agentId)) {
    return { valid: false, reason: "agentId must be a UUID" };
  }
  if (typeof c.agentVersion !== "string" || !VERSION_PATTERN.test(c.agentVersion)) {
    return { valid: false, reason: "agentVersion must be major.minor.patch numerics" };
  }
  if (c.agentKind !== "zeck" && c.agentKind !== "byoa") {
    return { valid: false, reason: "agentKind must be zeck or byoa" };
  }
  if (typeof c.planId !== "string" || !SLUG_PATTERN.test(c.planId)) {
    return { valid: false, reason: "planId must be an identifier" };
  }
  return { valid: true };
}

/** Bounded, secret-scanned cause validation. */
export function validateCause(cause: string | undefined): DeploymentValidation {
  if (cause === undefined || cause === null) {
    return { valid: true };
  }
  if (typeof cause !== "string" || cause.length > MAX_CAUSE) {
    return { valid: false, reason: `cause must be at most ${MAX_CAUSE} characters` };
  }
  if (/sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}/.test(cause)) {
    return { valid: false, reason: "cause looks like it embeds a raw secret value" };
  }
  return { valid: true };
}

/**
 * Deterministic creation fingerprint (the idempotency discriminator):
 * the same logical creation under the same key replays; a different
 * creation under a reused key fails `IDEMPOTENCY_KEY_REUSED`.
 */
export function deploymentCreationFingerprint(
  applicationId: string,
  input: CreateDeploymentInput,
): string {
  return JSON.stringify([
    applicationId,
    input.slug,
    input.environmentId,
    input.agentId,
    input.agentVersion,
    input.agentKind,
    input.planId,
  ]);
}
