/**
 * BYOA interop application service (WORK-016 / AGT-007, ACP-005).
 *
 * THE governed path for externally-built agents — registration and
 * runtime, both THROUGH existing authorities:
 *
 * ```text
 * registerByoaAgent:
 *   neutral BYOA descriptor + requested capabilities
 *     ↓ mapped to the agents module's canonical inputs (pure mapping)
 *   WORK-011's AgentRegistry.registerAgent → publishVersion → promote
 *     (THE identity/version/selection authority — idempotent, actor-
 *      bound, tenant-scoped; NO second registry exists here)
 *
 * createByoaAgentProvider:
 *   ByoaExternalAgent (the neutral external-side implementation)
 *     ↓ sanitization boundary (neutral observations only)
 *   the agents module's public AgentProvider port (the documented seam)
 *     ↓ dispatched ONLY through the agents session service's
 *       admission chain (policy → capability → budget → execution →
 *       verification — every gate stays with its authority)
 * ```
 *
 * The BYOA surface is a PROJECTION + SANITIZATION layer, never an
 * authority: it holds no agent table, no version store, no admission
 * logic, no execution surface and no credential material. External
 * framework code receives only what the governed runtime identity
 * carries — credential-grant REFERENCES, never secret values (the
 * agents module's M7/M8 discipline, preserved end-to-end).
 */

import type {
  AgentDefinition,
  AgentRecord,
  AgentSelectionRecord,
  AgentVersionRecord,
} from "../../../modules/agents/public";
import { PlatformError } from "../../../shared/errors";
import {
  BYOA_RUNTIME_KIND,
  type ByoaAgentProvider,
  type ByoaExternalAgent,
  sanitizeFailureReason,
  validateByoaDescriptor,
} from "../domain";
import type { ByoaAgentsAuthority } from "../ports/agents-authority";

/** The neutral registration descriptor for an externally-built agent. */
export interface ByoaRegistrationRequest {
  /** Registry slug (the authority's canonical namespace). */
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  /** Semantic version of THIS external implementation (authority-managed). */
  readonly version: string;
  /** The agent's standing instruction (never a secret). */
  readonly instructions: string;
  /** Capabilities the external agent REQUESTS (policy decides the effective set). */
  readonly requestedPermissions: {
    readonly tools?: readonly string[];
    readonly secretRefs?: readonly string[];
    readonly models?: readonly string[];
  };
  /** Action classes requiring human approval before dispatch. */
  readonly approvalRequiredActions?: readonly string[];
  /**
   * The maximum autonomy the external agent may request (the policies
   * module's ladder: none | gated | sandboxed | unconstrained).
   */
  readonly maxAutonomy: "none" | "gated" | "sandboxed" | "unconstrained";
  /**
   * Compute isolation the external runtime requires (the policies
   * vocabulary; the POLICY authority may tighten it). Defaults to
   * "container" — external untrusted code runs isolated (ENV-002).
   */
  readonly isolation?: "none" | "process" | "container" | "microvm" | "vm" | "customer-runner";
  /** Per-session wall-clock ceiling (milliseconds). */
  readonly maxSessionDurationMs: number;
}

export interface ByoaRegistrationOutcome {
  readonly agent: AgentRecord;
  readonly version: AgentVersionRecord;
  readonly selection: AgentSelectionRecord;
}

export interface ByoaInteropDeps {
  /** THE agents registry authority (injected; never duplicated). */
  readonly agents: ByoaAgentsAuthority;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Pure, fail-closed validation of a BYOA registration request. */
export function validateByoaRegistration(
  input: unknown,
):
  | { readonly valid: true; readonly value: ByoaRegistrationRequest }
  | { readonly valid: false; readonly reason: string } {
  if (!isPlainObject(input)) {
    return { valid: false, reason: "BYOA registration must be an object" };
  }
  const raw = input as Record<string, unknown>;
  const slug = raw.slug;
  if (typeof slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(slug)) {
    return { valid: false, reason: "slug must match [a-z0-9][a-z0-9-]{0,99}" };
  }
  const name = raw.name;
  if (typeof name !== "string" || name.length === 0 || name.length > 200) {
    return { valid: false, reason: "name must be a string (1..200 chars)" };
  }
  const description = raw.description;
  if (description !== undefined && (typeof description !== "string" || description.length > 500)) {
    return { valid: false, reason: "description must be a string (max 500 chars) when present" };
  }
  const version = raw.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    return { valid: false, reason: "version must be a semver string (x.y.z)" };
  }
  const instructions = raw.instructions;
  if (typeof instructions !== "string" || instructions.length === 0 || instructions.length > 8000) {
    return { valid: false, reason: "instructions must be a string (1..8000 chars)" };
  }
  const requested = raw.requestedPermissions;
  let tools: readonly string[] | undefined;
  let secretRefs: readonly string[] | undefined;
  let models: readonly string[] | undefined;
  if (requested !== undefined) {
    if (!isPlainObject(requested)) {
      return { valid: false, reason: "requestedPermissions must be an object" };
    }
    const stringArrayOf = (
      key: string,
    ): { readonly ok: true; readonly value?: readonly string[] } | { readonly ok: false } => {
      const list = requested[key];
      if (list === undefined) {
        return { ok: true };
      }
      if (!Array.isArray(list) || list.some((item) => typeof item !== "string")) {
        return { ok: false };
      }
      return { ok: true, value: list as readonly string[] };
    };
    for (const key of ["tools", "secretRefs", "models"] as const) {
      const parsed = stringArrayOf(key);
      if (!parsed.ok) {
        return { valid: false, reason: `requestedPermissions.${key} must be a string array` };
      }
      if (key === "tools") {
        tools = parsed.value;
      } else if (key === "secretRefs") {
        secretRefs = parsed.value;
      } else {
        models = parsed.value;
      }
    }
  }
  const approvalRequiredActions = raw.approvalRequiredActions;
  if (
    approvalRequiredActions !== undefined &&
    (!Array.isArray(approvalRequiredActions) ||
      approvalRequiredActions.some((item) => typeof item !== "string"))
  ) {
    return { valid: false, reason: "approvalRequiredActions must be a string array" };
  }
  const maxAutonomy = raw.maxAutonomy;
  if (
    maxAutonomy !== "none" &&
    maxAutonomy !== "gated" &&
    maxAutonomy !== "sandboxed" &&
    maxAutonomy !== "unconstrained"
  ) {
    return {
      valid: false,
      reason: "maxAutonomy must be none | gated | sandboxed | unconstrained (policies vocabulary)",
    };
  }
  const isolation = raw.isolation;
  if (isolation !== undefined) {
    const levels = ["none", "process", "container", "microvm", "vm", "customer-runner"];
    if (typeof isolation !== "string" || !levels.includes(isolation)) {
      return {
        valid: false,
        reason: "isolation must be one of none|process|container|microvm|vm|customer-runner",
      };
    }
  }
  const maxSessionDurationMs = raw.maxSessionDurationMs;
  if (
    typeof maxSessionDurationMs !== "number" ||
    !Number.isInteger(maxSessionDurationMs) ||
    maxSessionDurationMs < 1 ||
    maxSessionDurationMs > 86_400_000
  ) {
    return { valid: false, reason: "maxSessionDurationMs must be an integer (1..86400000)" };
  }

  return {
    valid: true,
    value: {
      slug,
      name,
      ...(description === undefined ? {} : { description }),
      version,
      instructions,
      requestedPermissions: {
        ...(tools === undefined ? {} : { tools }),
        ...(secretRefs === undefined ? {} : { secretRefs }),
        ...(models === undefined ? {} : { models }),
      },
      ...(approvalRequiredActions === undefined
        ? {}
        : { approvalRequiredActions: approvalRequiredActions as readonly string[] }),
      maxAutonomy,
      ...(isolation === undefined
        ? {}
        : { isolation: isolation as ByoaRegistrationRequest["isolation"] }),
      maxSessionDurationMs,
    },
  };
}

/**
 * Register an externally-built agent as a governed execution participant
 * (AGT-007/ACP-005) — THROUGH the WORK-011 registry authority: identity
 * convergence, immutable validated version, promotion selection. The
 * idempotency keys are namespaced per logical step; the authority's own
 * arbitration deduplicates retries.
 */
export async function registerByoaAgent(
  deps: ByoaInteropDeps,
  request: unknown,
  idempotencyKey: string,
  actor: { readonly actorId: string; readonly applicationId: string; readonly tenantId: string },
): Promise<ByoaRegistrationOutcome> {
  const check = validateByoaRegistration(request);
  if (!check.valid) {
    throw new PlatformError({
      code: "AGENT_ERROR",
      message: `invalid BYOA registration: ${check.reason}`,
    });
  }
  const value = check.value;
  if (typeof idempotencyKey !== "string" || !/^[\x21-\x7e]{1,200}$/.test(idempotencyKey)) {
    throw new PlatformError({
      code: "AGENT_ERROR",
      message: "idempotencyKey is required (printable ASCII, 1..200 chars)",
    });
  }

  // 1. Identity through THE registry authority (slug convergence).
  const agent = await deps.agents.registerAgent(
    {
      applicationId: actor.applicationId,
      tenantId: actor.tenantId,
      slug: value.slug,
      name: value.name,
      ...(value.description === undefined ? {} : { description: value.description }),
    },
    `${idempotencyKey}:register`,
    { actorId: actor.actorId, applicationId: actor.applicationId, tenantId: actor.tenantId },
  );

  // 2. The immutable version artifact (the canonical AgentDefinition —
  //    requested capabilities only; policy decides the effective set).
  const definition: AgentDefinition = {
    instructions: value.instructions,
    requestedPermissions: {
      tools: value.requestedPermissions.tools ?? [],
      secretRefs: value.requestedPermissions.secretRefs ?? [],
      ...(value.requestedPermissions.models === undefined
        ? {}
        : { models: value.requestedPermissions.models }),
    },
    approvalRequiredActions: value.approvalRequiredActions ?? [],
    // BYOA agents run external code: the default isolation is the
    // container level (ENV-002: untrusted code runs isolated); the POLICY
    // authority may tighten it further at admission.
    isolation: value.isolation ?? "container",
    maxAutonomy: value.maxAutonomy,
    maxSessionDurationMs: value.maxSessionDurationMs,
  };
  const version = await deps.agents.publishVersion(
    { agentId: agent.id, version: value.version, definition },
    `${idempotencyKey}:version`,
    { actorId: actor.actorId, applicationId: actor.applicationId, tenantId: actor.tenantId },
  );

  // 3. Promotion (the selection authority — a valid version becomes the
  //    current one through the canonical append-only record).
  const selection = await deps.agents.promote(
    {
      agentId: agent.id,
      targetVersionId: version.id,
      reason: "BYOA registration promotion (WORK-016 governed path)",
    },
    `${idempotencyKey}:promote`,
    { actorId: actor.actorId, applicationId: actor.applicationId, tenantId: actor.tenantId },
  );

  return { agent, version, selection };
}

/**
 * Wrap a neutral external agent into the agents module's public
 * `AgentProvider` port (the documented BYOA seam). The wrapper adds ONLY
 * the sanitization boundary:
 *  - observations are normalized (failure reasons sanitized — no stack
 *    traces, no framework internals, no secrets cross back);
 *  - a thrown external error becomes an honest session-failure
 *    observation (never a propagated internals-bearing exception);
 *  - the runtime kind is the neutral BYOA constant (no framework name).
 *
 * The provider is dispatched ONLY through the agents session service
 * (its admission chain: policy → credentials → durable session) — this
 * wrapper holds no authority surface of any kind.
 */
export function createByoaAgentProvider(external: ByoaExternalAgent): ByoaAgentProvider {
  const descriptorCheck = validateByoaDescriptor(external.descriptor);
  if (!descriptorCheck.valid) {
    throw new PlatformError({
      code: "AGENT_ERROR",
      message: `invalid BYOA external descriptor: ${descriptorCheck.reason}`,
    });
  }
  return {
    runtimeKind: BYOA_RUNTIME_KIND,
    async executeSession(identity, task) {
      let observation: Awaited<ReturnType<ByoaExternalAgent["executeSession"]>>;
      try {
        observation = await external.executeSession(identity, task);
      } catch (error) {
        // External code threw: honest failure, no internals disclosure (a
        // PlatformError's canonical message may surface; an arbitrary
        // exception's internals never do).
        const failureReason =
          error instanceof PlatformError
            ? `external agent failed: ${error.message}`
            : "the external agent implementation failed (no further detail is exposed)";
        return {
          outcomeClass: "session-failure" as const,
          outputDigest: null,
          output: null,
          failureReason,
        };
      }
      // Normalize the observation (bounded, disclosure-free).
      const output = isPlainObject(observation.output) ? observation.output : null;
      const outputDigest =
        typeof observation.outputDigest === "string" ? observation.outputDigest : null;
      if (
        observation.outcomeClass !== "session-success" &&
        observation.outcomeClass !== "session-failure"
      ) {
        return {
          outcomeClass: "session-failure" as const,
          outputDigest: null,
          output: null,
          failureReason: "the external agent returned an unknown outcome class",
        };
      }
      return {
        outcomeClass: observation.outcomeClass,
        outputDigest,
        output,
        failureReason: sanitizeFailureReason(observation.failureReason ?? null),
      };
    },
  };
}
