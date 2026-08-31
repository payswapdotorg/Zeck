/**
 * Environment resolver port (deployments module outbound; WORK-023).
 *
 * Resolves the applications module's environment identities
 * (read-only) — deployment identity is bound to an environment
 * (MOD-002), and the binding is resolved fail-closed before any
 * durable write. No environment mutation surface exists here.
 */

export interface EnvironmentRef {
  readonly environmentId: string;
  readonly applicationId: string;
  readonly tenantId: string;
}

export interface DeploymentEnvironmentResolver {
  /** Resolve one environment reference, or null when unknown. */
  resolve(applicationId: string, environmentId: string): Promise<EnvironmentRef | null>;
}
