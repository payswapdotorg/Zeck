/**
 * Tenant, application and environment contracts (applications module domain).
 *
 * Ownership model (migration 0001): a tenant owns applications; an
 * application owns environments. `tenantId` on every row plus the composite
 * unique key `applications (id, tenant_id)` makes cross-tenant ownership
 * ambiguity structurally impossible at the database level.
 */

export interface Tenant {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly createdAt: string;
}

export const ENVIRONMENT_KINDS = ["development", "staging", "production"] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

export interface Application {
  readonly id: string;
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface Environment {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly kind: EnvironmentKind;
  readonly name: string;
  readonly createdAt: string;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const ENV_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

/** Slug/name validation shared by services and tests (single source of truth). */
export function isValidSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}

export function isValidEnvironmentName(value: string): boolean {
  return ENV_NAME_PATTERN.test(value);
}
