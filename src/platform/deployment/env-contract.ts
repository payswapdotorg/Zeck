/**
 * Environment contract evaluation (Work Order WORK-042 AC3/AC4).
 *
 * Validates a concrete process environment (the operator/CI runtime)
 * against the repository-resident variable and secret-reference
 * contracts:
 *
 * - required variables are present;
 * - `ZECK_SECRET_*_REF` variables hold REFERENCE URIs of the form
 *   `zeck-secret://<environment>/<name>` — never plaintext: a value
 *   that is not a reference for THIS environment is rejected fail
 *   closed (this is the runtime secret-reference check: credential
 *   material in a reference variable is unrepresentable);
 * - cross-environment references are rejected: production material is
 *   not addressable from a non-production environment (AC3);
 * - values of credential-shaped variables are never read, copied or
 *   reported — only their presence is recorded.
 *
 * The evaluation result NEVER contains environment values: only
 * variable names, reference URIs (non-secret by construction) and
 * precise problem statements.
 */

import type { DeploymentManifest } from "./manifest";
import type { EnvironmentId } from "./naming";

export interface MaterializedReference {
  readonly reference: string;
  readonly variable: string;
  readonly classification: string;
}

export interface EnvironmentContractEvaluation {
  readonly environment: EnvironmentId;
  readonly satisfied: boolean;
  readonly problems: readonly string[];
  /** Reference URIs present in the environment (URIs only, never values). */
  readonly materializedReferences: readonly MaterializedReference[];
}

const REFERENCE_URI_PATTERN = /^zeck-secret:\/\/([a-z]+)\/([a-z0-9-]+)$/;

/**
 * Evaluate the environment contract for one environment.
 *
 * @param manifest the loaded deployment manifest set
 * @param environment the environment identity being evaluated
 * @param env the concrete process environment (read-only)
 */
export function evaluateEnvironmentContract(
  manifest: DeploymentManifest,
  environment: EnvironmentId,
  env: Readonly<Record<string, string | undefined>>,
): EnvironmentContractEvaluation {
  const problems: string[] = [];
  const materialized: MaterializedReference[] = [];

  const declared = env.ZECK_ENVIRONMENT;
  if (declared === undefined || declared.trim().length === 0) {
    problems.push(
      "ZECK_ENVIRONMENT is required (the environment identity this process represents)",
    );
  } else if (declared !== environment) {
    problems.push(
      `ZECK_ENVIRONMENT is "${declared}" but the invocation targets "${environment}" (environment identity mismatch)`,
    );
  }

  for (const variable of manifest.variables) {
    if (variable.required && (env[variable.name] === undefined || env[variable.name] === "")) {
      problems.push(`${variable.name} is required and not set`);
    }
  }

  for (const reference of manifest.secretReferences[environment]) {
    const value = env[reference.variable];
    if (value === undefined || value === "") {
      continue; // Absent references are reported by provisioning preconditions, not here.
    }
    const match = REFERENCE_URI_PATTERN.exec(value);
    if (match === null) {
      problems.push(
        `${reference.variable} must hold a zeck-secret://<environment>/<name> reference URI; a non-reference value (plaintext credential material) is rejected fail closed`,
      );
      continue;
    }
    const [, referenceEnvironment, referenceName] = match;
    if (referenceEnvironment !== environment) {
      problems.push(
        `${reference.variable} holds a ${referenceEnvironment}-scoped reference (${value}); ${environment} cannot materialize ${referenceEnvironment} credentials (environment isolation)`,
      );
      continue;
    }
    if (referenceName !== reference.name) {
      problems.push(
        `${reference.variable} holds a reference to "${referenceName}" but the ${environment} inventory declares "${reference.name}"`,
      );
      continue;
    }
    materialized.push({
      reference: value,
      variable: reference.variable,
      classification: reference.classification,
    });
  }

  // NOTE: credential-shaped variables (ZECK_PG_ADMIN_URL, ZECK_TOKEN, …)
  // are never inspected here: presence may be recorded by callers, but
  // values are not read, copied or reported by this module.

  return {
    environment,
    satisfied: problems.length === 0,
    problems,
    materializedReferences: materialized,
  };
}

/**
 * The precondition inventory for provisioning an environment: every
 * secret reference the manifest declares, with the variable expected to
 * materialize it (fail-closed check BEFORE any infrastructure
 * mutation — the WORK-042 readiness checkpoint contract).
 */
export function provisioningPreconditions(
  manifest: DeploymentManifest,
  environment: EnvironmentId,
): readonly {
  readonly reference: string;
  readonly variable: string;
  readonly classification: string;
}[] {
  return manifest.secretReferences[environment].map((record) => ({
    reference: `zeck-secret://<present-in-inventory>/${record.name}`,
    variable: record.variable,
    classification: record.classification,
  }));
}
