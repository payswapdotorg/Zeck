/**
 * Residency enforcement at the deployment/adapter seam (policies module
 * adapter; D-08 / WORK-060; SEC-003).
 *
 * THE SEAM: the enforcement consumes the repository-declared
 * environment matrix (the first-class `region` dimension on
 * environments.json, supplied here as PLAIN typed data — the caller
 * maps the deployment manifest; platform types never leak into the
 * policies module) and the tenant-declared residency constraint, then
 * evaluates fail-closed through the domain semantics
 * (`domain/residency.ts`).
 *
 * WHERE IT RUNS: the deployment tooling (deploy:validate proves the
 * region dimension; the drills and future composition call
 * `enforce` before residency-bearing operations). The wiring into the
 * production composition root is a composition Work Order's surface —
 * until it lands, governed operations in a deployed control plane do
 * not yet consult the seam (the honest boundary recorded in the
 * evidence document; the fail-closed evaluation itself is proven by
 * unit + integration + discrimination batteries here).
 *
 * No authority is created: the projection (environment → data-at-rest
 * surfaces) is pure derived data; the evaluation is the domain
 * function; nothing stores residency state; no authorization surface
 * consults it.
 */

import {
  DATA_AT_REST_SURFACES,
  type DataAtRestLocality,
  type DataAtRestSurface,
  evaluateResidencyConstraint,
  type ResidencyConstraint,
  type ResidencyOutcome,
} from "../domain/residency";

/** The deployment-seam projection input: one environment's declared region. */
export interface ResidencyEnvironmentDeclaration {
  readonly id: string;
  readonly region: string;
}

export interface ResidencyEnforcementRequest {
  readonly tenantId: string;
  readonly requiredRegions: readonly string[];
  /** The environment the residency-bearing operation targets. */
  readonly environment: string;
}

export interface ResidencyEnforcement {
  /** The data-at-rest localities of one environment (all durable surfaces). */
  readonly localitiesFor: (environment: string) => readonly DataAtRestLocality[];
  /** Enforce a tenant constraint against an environment's localities (fail closed). */
  readonly enforce: (request: ResidencyEnforcementRequest) => ResidencyOutcome;
}

export class ResidencyEnforcementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResidencyEnforcementError";
  }
}

/**
 * Project an environment's declared region onto the durable
 * data-at-rest surfaces (authoritative state, artifact bytes,
 * evidence). Pure. An environment id that is not declared has NO
 * provable locality — callers treat that as fail-closed via `enforce`.
 */
export function dataAtRestLocalitiesFor(
  environment: ResidencyEnvironmentDeclaration,
): readonly DataAtRestLocality[] {
  return DATA_AT_REST_SURFACES.map((surface: DataAtRestSurface) => ({
    surface,
    region: environment.region,
  }));
}

/**
 * Create the deployment-seam residency enforcement over the declared
 * environments (plain data mapped from the repository manifest by the
 * caller — never a platform import).
 */
export function createResidencyEnforcement(options: {
  readonly environments: readonly ResidencyEnvironmentDeclaration[];
}): ResidencyEnforcement {
  const byId = new Map(options.environments.map((entry) => [entry.id, entry]));

  const localitiesFor = (environment: string): readonly DataAtRestLocality[] => {
    const declared = byId.get(environment);
    if (declared === undefined) {
      throw new ResidencyEnforcementError(
        `environment "${environment}" is not declared in the environment matrix (an undeclared environment has no provable data-at-rest locality — fail closed)`,
      );
    }
    return dataAtRestLocalitiesFor(declared);
  };

  return {
    localitiesFor,
    enforce: (request: ResidencyEnforcementRequest): ResidencyOutcome => {
      const declared = byId.get(request.environment);
      if (declared === undefined) {
        // The unprovable case fails closed through the domain refusal
        // vocabulary (an empty locality list with a declared constraint).
        return evaluateResidencyConstraint(
          { tenantId: request.tenantId, requiredRegions: request.requiredRegions },
          [],
        );
      }
      const constraint: ResidencyConstraint = {
        tenantId: request.tenantId,
        requiredRegions: request.requiredRegions,
      };
      return evaluateResidencyConstraint(constraint, dataAtRestLocalitiesFor(declared));
    },
  };
}
