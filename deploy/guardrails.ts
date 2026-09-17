/**
 * deploy/guardrails — the spend/quota guardrail evaluation core
 * (DEP-003 AC3: "Quota/spend guardrail negative paths are tested:
 * ceiling refusal, alert threshold, no silent overage; thresholds
 * come from the manifests").
 *
 * THE MANIFEST IS THE ONLY LIMIT CARRIER: every guardrail threshold
 * and default limit resolves from deploy/manifests/quota-guards.json
 * (loaded fail-closed by the platform loader) — this tool never
 * hard-codes a limit the manifest does not carry. Operator overrides
 * (the ZECK_*_BOUND / ZECK_*_LIMIT_BYTES variables) sit ON TOP of the
 * manifest row and must be well-formed: a malformed override ABORTS
 * fail-closed instead of silently falling back.
 *
 * The evaluation composes the two fixed-on-main enforcement surfaces:
 *  - the provider quota/spend fence (src/platform/deployment/
 *    quota-fence.ts — ceiling refusal with the provider's declared
 *    degradation mode; silent paid overage unrepresentable without an
 *    explicit recorded approval);
 *  - the quota/operational alert evaluator
 *    (src/platform/observability/alerts.ts — warn/critical per the
 *    manifest thresholds) and the promotion guardrail (a CRITICAL
 *    alert blocks promotion, the D-06 semantics).
 *
 * Guardrails bind per environment class: the environment label of the
 * evaluation (the environments.json class the operator is guarding)
 * travels into every alert subject, and the snapshots come from the
 * authoritative stores of that environment — never a provider
 * dashboard.
 */

import type { DeploymentManifest } from "../src/platform/deployment/manifest";
import {
  type OverageApproval,
  type OveragePolicy,
  type QuotaFenceEvaluation,
  type QuotaUsageSnapshot,
  evaluateQuotaFence,
} from "../src/platform/deployment/quota-fence";
import {
  type QuotaGuardsPolicy,
  evaluateQuotaAlerts,
  hasCriticalAlert,
} from "../src/platform/observability/alerts";
import type {
  OperationalAlert,
  QuotaUtilizationSnapshot,
} from "../src/platform/observability/port";

/** Where a guard's evaluation limit came from (auditable). */
export type GuardLimitSource = "operator-override" | "manifest" | "authority-owned";

export interface GuardLimitResolution {
  readonly guard: string;
  readonly limit: number | null;
  readonly source: GuardLimitSource;
}

/**
 * Resolve one guard's evaluation limit. Order: the operator's explicit
 * environment override (must parse to a positive finite number — a
 * malformed override ABORTS fail-closed), then the manifest-carried
 * defaultLimitBytes row, then null for guards whose limit is owned by
 * an authority store (e.g. compute-claims: the compute-plane
 * environment quota IS the limit — no manifest default exists and none
 * is invented).
 */
export function resolveGuardLimit(
  guard: string,
  policy: QuotaGuardsPolicy,
  operatorOverride?: string,
): GuardLimitResolution {
  if (operatorOverride !== undefined && operatorOverride.trim() !== "") {
    const parsed = Number.parseInt(operatorOverride, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `the operator override for guard "${guard}" ("${operatorOverride}") is not a positive integer — refusing to evaluate guardrails on a malformed limit (fail closed; the manifest-carried default is never silently substituted)`,
      );
    }
    return { guard, limit: parsed, source: "operator-override" };
  }
  const rule = policy.guards.find((entry) => entry.guard === guard);
  if (rule?.defaultLimitBytes !== null && rule?.defaultLimitBytes !== undefined) {
    return { guard, limit: rule.defaultLimitBytes, source: "manifest" };
  }
  return { guard, limit: null, source: "authority-owned" };
}

export interface GuardrailEvaluationInput {
  /** The environment class the guardrails bind to (alert subjects carry it). */
  readonly environment: string;
  /**
   * Quota utilization snapshots (guard-keyed) sourced from the
   * AUTHORITATIVE stores of that environment class.
   */
  readonly quotaSnapshots: readonly QuotaUtilizationSnapshot[];
  /**
   * Provider-concern usage snapshots (concern/metric-keyed) for the
   * spend fence — the enforcement answers of the operations plane.
   */
  readonly fenceSnapshots: readonly QuotaUsageSnapshot[];
  /** The overage policy in force for the fence (default: fail-closed). */
  readonly overagePolicy?: OveragePolicy;
  /** Recorded overage approvals keyed by concern (the only paid-overage path). */
  readonly overageApprovals?: Readonly<Record<string, OverageApproval>>;
}

export interface GuardrailReport {
  readonly environment: string;
  /** The spend-fence enforcement answers (ceiling refusals carry the declared degradation mode). */
  readonly fenceDecisions: readonly QuotaFenceEvaluation[];
  /** The alert set evaluated against the MANIFEST thresholds. */
  readonly alerts: readonly OperationalAlert[];
  /** The D-06 promotion guardrail: a CRITICAL alert blocks promotion. */
  readonly promotionBlocked: boolean;
  readonly blockReasons: readonly string[];
  /** The manifest thresholds that governed the evaluation (auditable). */
  readonly thresholdsApplied: Readonly<Record<string, { warnAtPct: number; criticalAtPct: number }>>;
}

/**
 * Evaluate the spend/quota guardrails for one environment class.
 * Pure over its inputs: no I/O, no clock — the snapshots arrive from
 * the authoritative stores (or from tests exercising the negative
 * paths); the thresholds ALWAYS come from the loaded quota-guards
 * policy (the manifest), never from tool-local constants.
 */
export function evaluateEnvironmentGuardrails(
  manifest: DeploymentManifest,
  policy: QuotaGuardsPolicy,
  input: GuardrailEvaluationInput,
): GuardrailReport {
  // Thresholds: the manifest rows, verbatim (a snapshot whose guard is
  // not declared falls back to the loader-documented DEFAULT — the
  // closed platform vocabulary, still not a tool-local constant).
  const guards: Record<string, { warnAtPct: number; criticalAtPct: number }> = {};
  for (const rule of policy.guards) {
    guards[rule.guard] = { ...rule.thresholds };
  }
  const alerts = evaluateQuotaAlerts(input.quotaSnapshots, { guards });
  const fenceDecisions = input.fenceSnapshots.map((snapshot) =>
    evaluateQuotaFence(manifest, {
      snapshot,
      ...(input.overagePolicy === undefined ? {} : { overagePolicy: input.overagePolicy }),
      ...(input.overageApprovals?.[snapshot.concern] === undefined
        ? {}
        : { overageApproval: input.overageApprovals[snapshot.concern] }),
    }),
  );
  const criticalAlerts = alerts.filter((alert) => alert.severity === "critical");
  return {
    environment: input.environment,
    fenceDecisions,
    alerts,
    promotionBlocked: hasCriticalAlert(alerts),
    blockReasons: criticalAlerts.map((alert) => `${alert.subject}: ${alert.detail}`),
    thresholdsApplied: guards,
  };
}
