/**
 * Application store port (applications module outbound).
 *
 * Implemented by the SQL adapter over the platform `DatabasePort`. Reads
 * that take a scope are tenant-guarded at the service layer; the port
 * returns the durable facts (including the owning tenant) so guards can
 * reject cross-tenant targets explicitly rather than silently missing them.
 */

import type { Application, Environment, EnvironmentKind, Tenant } from "../domain/ownership";

export interface CreateTenantInput {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface CreateApplicationInput {
  readonly id: string;
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
}

export interface CreateEnvironmentInput {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly kind: EnvironmentKind;
  readonly name: string;
}

export interface ApplicationStore {
  /**
   * Create a tenant and its tenant-scope owner membership for `ownerId` in
   * ONE durable write (adapter transaction). The ownership contract:
   * a tenant never exists without an owning actor.
   */
  insertTenantWithOwner(input: CreateTenantInput & { ownerId: string }): Promise<Tenant>;

  findTenantBySlug(slug: string): Promise<Tenant | null>;

  findTenant(id: string): Promise<Tenant | null>;

  /**
   * Create an application and an owner membership for `ownerId` in ONE
   * durable write (adapter transaction). Returns null when the (tenant,
   * slug) pair or the id is already taken; a converging duplicate resolves
   * at the service layer.
   */
  insertApplicationWithOwner(
    input: CreateApplicationInput & { ownerId: string },
  ): Promise<Application | null>;

  /** Load an application by id WITHOUT tenant filtering (guards need the owning tenant). */
  findApplication(id: string): Promise<Application | null>;

  /** Load an application by (tenant, slug) — convergence lookups for duplicates. */
  findApplicationByTenantSlug(tenantId: string, slug: string): Promise<Application | null>;

  insertEnvironment(input: CreateEnvironmentInput): Promise<Environment | null>;

  listEnvironments(applicationId: string): Promise<readonly Environment[]>;

  /** Load an environment by id without tenant filtering (guards need the owning tenant). */
  findEnvironment(id: string): Promise<Environment | null>;
}
