/**
 * The provider quota/spend fence (DEP-001 AC5).
 *
 * "Quota exhaustion and provider outage fail safely without silent
 * paid overage."
 *
 * The fence is the provider-neutral decision point between "usage
 * approaching/at a provider limit" and "the next provider operation":
 *
 *  - usage under the warn threshold → ALLOW;
 *  - usage at/over the warn threshold but under the limit → WARN (the
 *    operational alert posture — D1.0 §20 warning thresholds);
 *  - usage at/over the limit → DENY (quota-exhausted): the operation
 *    refuses and the provider's DECLARED degradation mode applies
 *    (providers.json / provider-tiers.json exhaustionBehavior). The
 *    authority role is preserved — an exhausted authoritative store
 *    fails closed; an exhausted non-authoritative dependency degrades
 *    explicitly. No secondary datastore is ever promoted.
 *
 * SILENT PAID OVERAGE IS UNREPRESENTABLE: continuing consumption past
 * the limit requires an EXPLICIT, RECORDED overage approval
 * (overageApproval) naming its authority; without it the fence denies.
 * The default policy is `fail-closed` — the free-tier doctrine's hard
 * edge ("a free-tier resource reaching its limit must degrade
 * predictably rather than silently converting into uncontrolled
 * spend" — ACR-002).
 *
 * UNKNOWN USAGE FAILS CLOSED: a quota probe that cannot report usage
 * (provider outage, probe error) denies spend-incurring operations —
 * never a permissive default on missing telemetry.
 *
 * Provider outage posture is typed from the manifest's provider map:
 * authoritative → fail-closed (the plane is DOWN for
 * authority-bearing work); non-authoritative → the declared degraded
 * mode (degraded-but-alive). An outage NEVER changes authority roles.
 */

import type { DeploymentManifest, ProviderRecord } from "./manifest";
import { providerForConcern } from "./manifest";

/** The closed overage-policy vocabulary. */
export const OVERAGE_POLICIES = ["fail-closed", "explicit-opt-in"] as const;
export type OveragePolicy = (typeof OVERAGE_POLICIES)[number];

export const QUOTA_FENCE_DECISIONS = ["allow", "warn", "deny"] as const;
export type QuotaFenceDecisionKind = (typeof QUOTA_FENCE_DECISIONS)[number];

export const QUOTA_FENCE_DENY_REASONS = [
  "quota-exhausted",
  "usage-unknown",
  "overage-not-approved",
] as const;
export type QuotaFenceDenyReason = (typeof QUOTA_FENCE_DENY_REASONS)[number];

/** A measured usage snapshot for one provider concern/metric. */
export interface QuotaUsageSnapshot {
  /** The manifest concern the usage belongs to (e.g. "artifact-bytes"). */
  readonly concern: string;
  /** The provider metric identifier (e.g. "storage"). */
  readonly metric: string;
  /** Measured usage (same unit as the limit). null = unknown (probe failed/unavailable). */
  readonly used: number | null;
  /** The declared provider limit for the metric. */
  readonly limit: number;
  /** The warn threshold (defaults to 80% of the limit — D1.0 §20 / quota-guards default). */
  readonly warnAt?: number;
}

/** An explicit, recorded overage approval (the only paid-overage path). */
export interface OverageApproval {
  /** The authority that approved continuing past the limit. */
  readonly approvedBy: string;
  /** When the approval was granted (ISO timestamp). */
  readonly approvedAt: string;
  /** The bounded overage amount approved (same unit as the limit). */
  readonly overageAmount: number;
}

export interface QuotaFenceEvaluation {
  readonly decision: QuotaFenceDecisionKind;
  /** The concern/provider the evaluation is about. */
  readonly concern: string;
  readonly metric: string;
  /** Present for deny: the typed reason. */
  readonly denyReason?: QuotaFenceDenyReason;
  /** Present for warn/deny: the applicable degradation mode (providers.json). */
  readonly degradedMode?: string;
  /** Present for deny: the provider's declared degradation effect. */
  readonly degradationEffect?: string;
  /** The authority role of the provider (preserved by every decision). */
  readonly authorityRole: "authoritative" | "non-authoritative";
  /** Present when an explicit overage approval allowed continuation past the limit. */
  readonly overageApproval?: OverageApproval;
  readonly detail: string;
}

export interface QuotaFenceInput {
  readonly snapshot: QuotaUsageSnapshot;
  /** The overage policy in force (default: fail-closed). */
  readonly overagePolicy?: OveragePolicy;
  /** The recorded overage approval, when one exists. */
  readonly overageApproval?: OverageApproval;
}

/**
 * Evaluate the quota fence for one usage snapshot against the manifest
 * provider map. Pure: no I/O, no clock (the approval carries its own
 * timestamps).
 */
export function evaluateQuotaFence(
  manifest: DeploymentManifest,
  input: QuotaFenceInput,
): QuotaFenceEvaluation {
  const { snapshot } = input;
  const provider = providerForConcern(manifest, snapshot.concern);
  if (provider === undefined) {
    throw new Error(
      `quota fence failed closed: concern "${snapshot.concern}" has no declared provider in providers.json`,
    );
  }
  if (!Number.isFinite(snapshot.limit) || snapshot.limit <= 0) {
    throw new Error(
      `quota fence failed closed: metric "${snapshot.metric}" of concern "${snapshot.concern}" declares a non-positive limit (${snapshot.limit})`,
    );
  }
  const authorityRole: "authoritative" | "non-authoritative" =
    provider.degradation.authority === "authoritative" ? "authoritative" : "non-authoritative";
  const degradedMode = provider.degradation.mode;
  const degradationEffect = provider.degradation.effect;
  const warnAt = snapshot.warnAt ?? snapshot.limit * 0.8;

  // Unknown usage: fail closed for the spend decision (never a
  // permissive default on missing telemetry). The degradation posture
  // is the provider's declared outage behavior.
  if (snapshot.used === null) {
    return {
      decision: "deny",
      concern: snapshot.concern,
      metric: snapshot.metric,
      denyReason: "usage-unknown",
      degradedMode,
      degradationEffect,
      authorityRole,
      detail:
        "usage is unknown (probe failed or provider outage): spend-incurring operations are denied fail-closed; the provider's declared outage posture applies",
    };
  }
  if (snapshot.used < 0 || !Number.isFinite(snapshot.used)) {
    throw new Error(
      `quota fence failed closed: metric "${snapshot.metric}" of concern "${snapshot.concern}" reports non-finite/negative usage (${snapshot.used})`,
    );
  }

  if (snapshot.used < warnAt) {
    return {
      decision: "allow",
      concern: snapshot.concern,
      metric: snapshot.metric,
      authorityRole,
      detail: `usage ${snapshot.used}/${snapshot.limit} under the warn threshold ${warnAt}`,
    };
  }

  if (snapshot.used < snapshot.limit) {
    return {
      decision: "warn",
      concern: snapshot.concern,
      metric: snapshot.metric,
      degradedMode,
      authorityRole,
      detail: `usage ${snapshot.used}/${snapshot.limit} at/over the warn threshold ${warnAt}: the operational alert posture applies (D1.0 section 20)`,
    };
  }

  // At or over the limit: the overage policy decides.
  const policy: OveragePolicy = input.overagePolicy ?? "fail-closed";
  if (policy === "explicit-opt-in") {
    const approval = input.overageApproval;
    if (approval === undefined) {
      return {
        decision: "deny",
        concern: snapshot.concern,
        metric: snapshot.metric,
        denyReason: "overage-not-approved",
        degradedMode,
        degradationEffect,
        authorityRole,
        detail:
          "usage at/over the limit and no recorded overage approval exists: continuing paid consumption requires an explicit recorded approval (silent paid overage is unrepresentable)",
      };
    }
    if (approval.overageAmount <= 0 || !Number.isFinite(approval.overageAmount)) {
      throw new Error(
        `quota fence failed closed: the overage approval for "${snapshot.concern}/${snapshot.metric}" declares a non-positive overage amount`,
      );
    }
    if (snapshot.used >= snapshot.limit + approval.overageAmount) {
      return {
        decision: "deny",
        concern: snapshot.concern,
        metric: snapshot.metric,
        denyReason: "quota-exhausted",
        degradedMode,
        degradationEffect,
        authorityRole,
        overageApproval: approval,
        detail: `usage ${snapshot.used} reached the approved overage bound ${snapshot.limit + approval.overageAmount}`,
      };
    }
    return {
      decision: "allow",
      concern: snapshot.concern,
      metric: snapshot.metric,
      authorityRole,
      overageApproval: approval,
      detail: `usage ${snapshot.used}/${snapshot.limit} within the explicitly approved overage bound ${snapshot.limit + approval.overageAmount} (approved by ${approval.approvedBy} at ${approval.approvedAt})`,
    };
  }

  // fail-closed (the default): deny at the limit with the declared
  // degradation mode.
  return {
    decision: "deny",
    concern: snapshot.concern,
    metric: snapshot.metric,
    denyReason: "quota-exhausted",
    degradedMode,
    degradationEffect,
    authorityRole,
    detail: `usage ${snapshot.used}/${snapshot.limit} at/over the limit: the operation is denied and the declared degradation mode "${degradedMode}" applies (no silent paid overage)`,
  };
}

/** The typed provider-outage posture (degraded-but-alive / fail-closed). */
export interface ProviderOutagePosture {
  readonly concern: string;
  readonly provider: string;
  readonly authorityRole: "authoritative" | "non-authoritative";
  readonly onFailure: "fail-closed" | "degraded";
  readonly degradedMode: string;
  readonly effect: string;
  /** Authority roles are manifest-declared and invariant under outage. */
  readonly authorityPreserved: true;
}

/**
 * The outage posture of a declared provider. An outage NEVER promotes a
 * secondary datastore: the authority role is carried straight from the
 * manifest (authorityPreserved is a literal type — there is no code
 * path that could return a changed role).
 */
export function providerOutagePosture(
  manifest: DeploymentManifest,
  concern: string,
): ProviderOutagePosture {
  const provider: ProviderRecord | undefined = providerForConcern(manifest, concern);
  if (provider === undefined) {
    throw new Error(
      `outage posture failed closed: concern "${concern}" has no declared provider in providers.json`,
    );
  }
  const authorityRole: "authoritative" | "non-authoritative" =
    provider.degradation.authority === "authoritative" ? "authoritative" : "non-authoritative";
  return {
    concern,
    provider: provider.id,
    authorityRole,
    onFailure: provider.degradation.onFailure,
    degradedMode: provider.degradation.mode,
    effect: provider.degradation.effect,
    authorityPreserved: true,
  };
}
