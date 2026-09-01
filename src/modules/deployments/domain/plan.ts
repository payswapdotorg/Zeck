/**
 * Deployment plan domain (deployments module domain; WORK-023,
 * MOD-001/MOD-010, ADR-0014/0015).
 *
 * The IMMUTABLE VERSIONED deployment plan: WHICH agent version, under
 * WHICH profile, in WHICH environment, through WHICH provider-neutral
 * channel bindings — the resolved, deployable configuration a
 * deployment points at (and promotes/rolls back between).
 *
 * Authority properties:
 *   - the plan REFERENCES identities owned by other modules (the
 *     applications environment, the agents version) — it never
 *     re-declares or re-validates their internals; the service
 *     resolves references fail-closed through the module seams;
 *   - channel bindings name provider-neutral channel kinds plus a
 *     NEUTRAL adapter capability identifier — external rail
 *     identifiers never cross this contract (the Work Order's
 *     implementation requirement; vendor rails bind downstream);
 *   - BYOA representation (MOD-010): an agent reference may carry
 *     `agentKind: "byoa"` with an OPAQUE external descriptor
 *     (reference id + descriptor text) — representing an external
 *     agent deployment WITHOUT making the external runtime a Zeck
 *     dependency: there is no SDK, no credential, no execution
 *     surface anywhere in the shape.
 */

import type { DeploymentChannelKind } from "./profile";

/** The provider-neutral agent reference a plan binds. */
export interface PlanAgentRef {
  readonly agentId: string;
  /** Exact agent version (major.minor.patch — the agents vocabulary). */
  readonly agentVersion: string;
  /** Whether the referenced agent is a Zeck-native or external/BYOA agent. */
  readonly agentKind: "zeck" | "byoa";
  /**
   * BYOA-only opaque external descriptor: a neutral reference id and a
   * bounded descriptor. NEVER credentials, tokens or vendor API
   * shapes (validated fail-closed).
   */
  readonly externalDescriptor?: {
    readonly ref: string;
    readonly descriptor: string;
  };
}

/** One provider-neutral channel binding of the plan. */
export interface ChannelBinding {
  readonly channelKind: DeploymentChannelKind;
  /**
   * The neutral adapter CAPABILITY identifier serving this binding
   * (e.g. "realtime-channel-adapter") — resolved against the
   * modality-adapter registry, fail-closed. Never a vendor rail.
   */
  readonly adapterCapabilityId: string;
}

/** Bounded session policy of the deployed agent. */
export interface DeploymentSessionPolicy {
  /** Per-session wall-clock ceiling in milliseconds (1..86400000). */
  readonly maxSessionDurationMs: number;
  /** Concurrent session ceiling (1..10000). */
  readonly maxConcurrentSessions: number;
}

/** The immutable versioned plan artifact. */
export interface DeploymentPlan {
  /** Caller-chosen stable identity slug (unique per application). */
  readonly planId: string;
  /** Monotonic version of this plan identity (starts at 1). */
  readonly version: number;
  readonly applicationId: string;
  readonly tenantId: string;
  /** The referenced immutable profile (identity + version). */
  readonly profileRef: { readonly profileId: string; readonly version: number };
  readonly agentRef: PlanAgentRef;
  /** The applications-module environment the deployment targets. */
  readonly environmentId: string;
  readonly channelBindings: readonly ChannelBinding[];
  readonly sessionPolicy: DeploymentSessionPolicy;
  readonly description: string | null;
  /** Content digest over the canonical plan body. */
  readonly digest: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** The publishable body (before persistence). */
export interface DeploymentPlanInput {
  readonly planId: string;
  readonly profileRef: { readonly profileId: string; readonly version: number };
  readonly agentRef: PlanAgentRef;
  readonly environmentId: string;
  readonly channelBindings: readonly ChannelBinding[];
  readonly sessionPolicy: DeploymentSessionPolicy;
  readonly description?: string;
}

export type PlanValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

const IDENTITY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9-]{1,99}$/;
const EXTERNAL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const MAX_BINDINGS = 16;
const MAX_DESCRIPTOR = 2000;

/** Raw-secret VALUE patterns (the WORK-011 nine-pattern discipline). */
const RAW_SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /bearer\s+[A-Za-z0-9._-]{16,}/i,
  /(api[_-]?key|apikey|secret|password|passwd|token)\s*[:=]\s*["']?[^\s"']{8,}/i,
];

/** Whether a free-text value looks like a raw long-lived secret. */
export function planContainsRawSecretValue(value: string): boolean {
  return RAW_SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pure, fail-closed validation of a plan body. Every reference shape,
 * every binding, the session policy and the free-text fields are
 * checked BEFORE any durable write.
 */
export function validateDeploymentPlanInput(input: unknown): PlanValidation {
  if (!isRecord(input)) {
    return { valid: false, reason: "plan input must be an object" };
  }
  const p = input as unknown as DeploymentPlanInput;
  if (typeof p.planId !== "string" || !IDENTITY_PATTERN.test(p.planId)) {
    return { valid: false, reason: "planId must be a lowercase hyphen-dashed identifier" };
  }
  if (
    !isRecord(p.profileRef) ||
    typeof p.profileRef.profileId !== "string" ||
    !IDENTITY_PATTERN.test(p.profileRef.profileId)
  ) {
    return { valid: false, reason: "profileRef.profileId must be an identifier" };
  }
  if (
    typeof p.profileRef.version !== "number" ||
    !Number.isInteger(p.profileRef.version) ||
    p.profileRef.version < 1
  ) {
    return { valid: false, reason: "profileRef.version must be a positive integer" };
  }
  if (!isRecord(p.agentRef)) {
    return { valid: false, reason: "agentRef is required" };
  }
  const agent = p.agentRef as Record<string, unknown>;
  if (
    typeof agent.agentId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(agent.agentId)
  ) {
    return { valid: false, reason: "agentRef.agentId must be a UUID (the agents module identity)" };
  }
  if (typeof agent.agentVersion !== "string" || !VERSION_PATTERN.test(agent.agentVersion)) {
    return { valid: false, reason: "agentRef.agentVersion must be major.minor.patch numerics" };
  }
  if (agent.agentKind !== "zeck" && agent.agentKind !== "byoa") {
    return { valid: false, reason: "agentRef.agentKind must be zeck or byoa" };
  }
  if (agent.agentKind === "byoa") {
    if (!isRecord(agent.externalDescriptor)) {
      return { valid: false, reason: "a byoa agent reference requires an external descriptor" };
    }
    const descriptor = agent.externalDescriptor as Record<string, unknown>;
    if (typeof descriptor.ref !== "string" || !EXTERNAL_REF_PATTERN.test(descriptor.ref)) {
      return {
        valid: false,
        reason: "externalDescriptor.ref must be an opaque reference (never a credential)",
      };
    }
    if (
      typeof descriptor.descriptor !== "string" ||
      descriptor.descriptor.length > MAX_DESCRIPTOR
    ) {
      return {
        valid: false,
        reason: `externalDescriptor.descriptor must be at most ${MAX_DESCRIPTOR} characters`,
      };
    }
    if (
      planContainsRawSecretValue(descriptor.descriptor) ||
      planContainsRawSecretValue(descriptor.ref)
    ) {
      return {
        valid: false,
        reason: "the external descriptor looks like it embeds a raw secret value",
      };
    }
  } else if (agent.externalDescriptor !== undefined) {
    return { valid: false, reason: "a zeck agent reference must not carry an external descriptor" };
  }
  if (
    typeof p.environmentId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p.environmentId)
  ) {
    return {
      valid: false,
      reason: "environmentId must be a UUID (the applications module identity)",
    };
  }
  if (!Array.isArray(p.channelBindings) || p.channelBindings.length === 0) {
    return { valid: false, reason: "channelBindings must declare at least one binding" };
  }
  if (p.channelBindings.length > MAX_BINDINGS) {
    return { valid: false, reason: `at most ${MAX_BINDINGS} channel bindings are allowed` };
  }
  const channelKinds = new Set<string>();
  for (const binding of p.channelBindings) {
    if (!isRecord(binding)) {
      return { valid: false, reason: "each channel binding must be an object" };
    }
    const b = binding as Record<string, unknown>;
    if (typeof b.channelKind !== "string" || b.channelKind.length === 0) {
      return {
        valid: false,
        reason: "channelBinding.channelKind must be a provider-neutral channel kind",
      };
    }
    if (channelKinds.has(b.channelKind)) {
      return { valid: false, reason: `duplicate binding for channel kind "${b.channelKind}"` };
    }
    channelKinds.add(b.channelKind);
    if (
      typeof b.adapterCapabilityId !== "string" ||
      !CAPABILITY_PATTERN.test(b.adapterCapabilityId)
    ) {
      return {
        valid: false,
        reason:
          "channelBinding.adapterCapabilityId must be a neutral adapter capability identifier",
      };
    }
  }
  if (!isRecord(p.sessionPolicy)) {
    return { valid: false, reason: "sessionPolicy is required" };
  }
  const policy = p.sessionPolicy as Record<string, unknown>;
  if (
    typeof policy.maxSessionDurationMs !== "number" ||
    !Number.isInteger(policy.maxSessionDurationMs) ||
    policy.maxSessionDurationMs < 1 ||
    policy.maxSessionDurationMs > 86_400_000
  ) {
    return {
      valid: false,
      reason: "sessionPolicy.maxSessionDurationMs must be an integer within 1..86400000",
    };
  }
  if (
    typeof policy.maxConcurrentSessions !== "number" ||
    !Number.isInteger(policy.maxConcurrentSessions) ||
    policy.maxConcurrentSessions < 1 ||
    policy.maxConcurrentSessions > 10_000
  ) {
    return {
      valid: false,
      reason: "sessionPolicy.maxConcurrentSessions must be an integer within 1..10000",
    };
  }
  if (
    p.description !== undefined &&
    (typeof p.description !== "string" || p.description.length > MAX_DESCRIPTOR)
  ) {
    return { valid: false, reason: `description must be at most ${MAX_DESCRIPTOR} characters` };
  }
  if (p.description !== undefined && planContainsRawSecretValue(p.description)) {
    return { valid: false, reason: "description looks like it embeds a raw secret value" };
  }
  return { valid: true };
}

/**
 * Deterministic canonical JSON of the plan body (sorted keys; sorted
 * channel bindings) — the content-addressing base.
 */
export function canonicalPlanJson(input: DeploymentPlanInput): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(canonical);
    }
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .map((key) => [key, canonical(record[key])]);
    }
    return value;
  };
  return JSON.stringify([
    "deployments.plan",
    canonical(input.profileRef),
    canonical(input.agentRef),
    input.environmentId,
    [...input.channelBindings].sort((a, b) => a.channelKind.localeCompare(b.channelKind)),
    canonical(input.sessionPolicy),
    canonical(input.description ?? null),
  ]);
}
