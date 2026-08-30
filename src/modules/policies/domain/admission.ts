/**
 * Admission fact evaluation (policies module domain; WORK-007).
 *
 * Machine-readable evaluation of concrete request/dispatch facts against an
 * EFFECTIVE restriction set (`domain/policy.ts` resolves it; this file
 * decides). Pure and total: every check is a typed comparison over the
 * nine-dimension vocabulary — no provider knowledge, no I/O.
 *
 * Two fact shapes:
 *  - `ExecutionAdmissionFacts` — what the executions `authorize` seam knows
 *    (the execution's own declared constraints). Provider/tool/network/
 *    secret/autonomy/isolation facts do not exist yet at CREATED — they are
 *    carried by the effective set (digest-recorded as admission evidence)
 *    and evaluated at the dispatch seams through `DispatchFacts`.
 *  - `DispatchFacts` — what a dispatch seam (provider, tool, agent, sandbox,
 *    secret materialization) knows at dispatch time.
 */

import type { AutonomyMode, IsolationLevel, RestrictionSet } from "./policy";
import { AUTONOMY_MODES, EGRESS_MODES, ISOLATION_LEVELS, SECRET_ACCESS_MODES } from "./policy";

/** Facts available at the execution authorize boundary (CREATED → AUTHORIZED). */
export interface ExecutionAdmissionFacts {
  /** Requested cost ceiling for this execution (its own constraint). */
  readonly maxCostMicroUsd?: string;
  readonly maxLatencyMs?: number;
  readonly minQuality?: number;
}

/** Facts available at a dispatch boundary (provider/tool/agent/sandbox/secret). */
export interface DispatchFacts {
  /** Provider rail identifier (a provider-neutral rail string, never an SDK type). */
  readonly provider?: string;
  readonly model?: string;
  readonly tool?: string;
  /** Network host the work would egress to. */
  readonly host?: string;
  /** Secret reference the work would materialize (never a secret value). */
  readonly secretRef?: string;
  /** Autonomy mode the dispatched work would run with. */
  readonly autonomy?: AutonomyMode;
  /** Isolation level the dispatched work would run in. */
  readonly isolation?: IsolationLevel;
}

export interface FactDenial {
  readonly dimension: string;
  readonly message: string;
}

export interface FactsCheck {
  readonly ok: boolean;
  readonly denial?: FactDenial;
}

function notOn(list: readonly string[] | undefined, value: string): boolean {
  return list !== undefined && !list.includes(value);
}

function on(list: readonly string[] | undefined, value: string): boolean {
  return list?.includes(value) ?? false;
}

/**
 * Evaluate authorize-boundary facts. A declared request constraint VIOLATES
 * the effective policy when it exceeds a ceiling the policy imposes (asking
 * for more spend/latency than allowed). A request may always ask for LESS.
 * Quality: a request asking for quality BELOW the policy floor tightens
 * nothing but would silently under-deliver — the floor applies instead (no
 * denial); the digest-recorded effective set carries the floor.
 */
export function evaluateExecutionFacts(
  effective: RestrictionSet,
  facts: ExecutionAdmissionFacts,
): FactsCheck {
  const cost = effective.cost?.maxCostMicroUsd;
  if (
    cost !== undefined &&
    facts.maxCostMicroUsd !== undefined &&
    BigInt(facts.maxCostMicroUsd) > BigInt(cost)
  ) {
    return {
      ok: false,
      denial: {
        dimension: "cost",
        message: `requested cost ceiling ${facts.maxCostMicroUsd} micro-USD exceeds the effective policy ceiling ${cost}`,
      },
    };
  }
  const latency = effective.latency?.maxLatencyMs;
  if (latency !== undefined && facts.maxLatencyMs !== undefined && facts.maxLatencyMs > latency) {
    return {
      ok: false,
      denial: {
        dimension: "latency",
        message: `requested latency ceiling ${facts.maxLatencyMs}ms exceeds the effective policy ceiling ${latency}ms`,
      },
    };
  }
  return { ok: true };
}

/**
 * Evaluate dispatch facts against the effective restrictions — the
 * POLICY-BEFORE-DISPATCH decision every dispatch seam consults. Denylists
 * always win; allowlists bind only when declared; ladders compare rank.
 */
export function evaluateDispatchFacts(effective: RestrictionSet, facts: DispatchFacts): FactsCheck {
  const providerModel = effective.providerModel;
  if (providerModel !== undefined) {
    if (facts.provider !== undefined) {
      if (on(providerModel.deniedProviders, facts.provider)) {
        return {
          ok: false,
          denial: {
            dimension: "providerModel",
            message: `provider "${facts.provider}" is prohibited by the effective policy`,
          },
        };
      }
      if (notOn(providerModel.allowedProviders, facts.provider)) {
        return {
          ok: false,
          denial: {
            dimension: "providerModel",
            message: `provider "${facts.provider}" is not on the effective provider allowlist`,
          },
        };
      }
    }
    if (facts.model !== undefined) {
      if (on(providerModel.deniedModels, facts.model)) {
        return {
          ok: false,
          denial: {
            dimension: "providerModel",
            message: `model "${facts.model}" is prohibited by the effective policy`,
          },
        };
      }
      if (notOn(providerModel.allowedModels, facts.model)) {
        return {
          ok: false,
          denial: {
            dimension: "providerModel",
            message: `model "${facts.model}" is not on the effective model allowlist`,
          },
        };
      }
    }
  }

  const tool = effective.tool;
  if (tool !== undefined && facts.tool !== undefined) {
    if (on(tool.deniedTools, facts.tool)) {
      return {
        ok: false,
        denial: { dimension: "tool", message: `tool "${facts.tool}" is prohibited` },
      };
    }
    if (notOn(tool.allowedTools, facts.tool)) {
      return {
        ok: false,
        denial: {
          dimension: "tool",
          message: `tool "${facts.tool}" is not on the effective tool allowlist`,
        },
      };
    }
  }

  const network = effective.network;
  if (network !== undefined && facts.host !== undefined) {
    if (on(network.deniedHosts, facts.host)) {
      return {
        ok: false,
        denial: { dimension: "network", message: `host "${facts.host}" is prohibited` },
      };
    }
    const egress = network.egress ?? "open";
    if (egress === "none") {
      return {
        ok: false,
        denial: {
          dimension: "network",
          message: `network egress is prohibited (host "${facts.host}")`,
        },
      };
    }
    if (egress === "allowlist" && notOn(network.allowedHosts, facts.host)) {
      return {
        ok: false,
        denial: {
          dimension: "network",
          message: `host "${facts.host}" is not on the effective network allowlist`,
        },
      };
    }
  }

  const secrets = effective.secrets;
  if (secrets !== undefined && facts.secretRef !== undefined) {
    if (on(secrets.deniedSecretRefs, facts.secretRef)) {
      return {
        ok: false,
        denial: { dimension: "secrets", message: `secret "${facts.secretRef}" is prohibited` },
      };
    }
    const access = secrets.access ?? "all";
    if (access === "none") {
      return {
        ok: false,
        denial: {
          dimension: "secrets",
          message: `secret access is prohibited (secret "${facts.secretRef}")`,
        },
      };
    }
    if (access === "allowlist" && notOn(secrets.allowedSecretRefs, facts.secretRef)) {
      return {
        ok: false,
        denial: {
          dimension: "secrets",
          message: `secret "${facts.secretRef}" is not on the effective secret allowlist`,
        },
      };
    }
  }

  const autonomy = effective.autonomy?.maxAutonomy;
  if (autonomy !== undefined && facts.autonomy !== undefined) {
    const requested = AUTONOMY_MODES.indexOf(facts.autonomy);
    const allowed = AUTONOMY_MODES.indexOf(autonomy);
    if (requested > allowed) {
      return {
        ok: false,
        denial: {
          dimension: "autonomy",
          message: `autonomy "${facts.autonomy}" exceeds the effective maximum "${autonomy}"`,
        },
      };
    }
  }

  const isolation = effective.isolation?.minIsolation;
  if (isolation !== undefined && facts.isolation !== undefined) {
    const requested = ISOLATION_LEVELS.indexOf(facts.isolation);
    const required = ISOLATION_LEVELS.indexOf(isolation);
    if (requested < required) {
      return {
        ok: false,
        denial: {
          dimension: "isolation",
          message: `isolation "${facts.isolation}" is below the effective minimum "${isolation}"`,
        },
      };
    }
  }

  return { ok: true };
}

/** Ladder re-exports for fact builders (single vocabulary source). */
export const FACT_LADDERS = {
  autonomy: AUTONOMY_MODES,
  egress: EGRESS_MODES,
  isolation: ISOLATION_LEVELS,
  secretAccess: SECRET_ACCESS_MODES,
} as const;
