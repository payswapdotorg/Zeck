/**
 * Ownership services (applications module application layer).
 *
 * Cross-module contract usage: this module consumes the `auth` module's
 * public barrel ONLY (`ScopeResolver`, `assertScopeCovers`,
 * `MembershipRecord`) — never auth internals. Scope resolution and
 * permission checks always precede durable writes; cross-tenant targets are
 * rejected with `TENANT_SCOPE_VIOLATION` BEFORE any downstream execution
 * (acceptance criteria 3 and 4).
 *
 * All mutations are idempotent (acceptance criterion 5): the ledger port
 * arbitrates by (application scope, operation, key) or (actor scope for
 * pre-application operations), converging concurrent duplicates to one
 * durable identity.
 */

import { PlatformError } from "../../../shared/errors";
import {
  assertScopeCovers,
  type MembershipRecord,
  type Principal,
  type ScopeResolver,
} from "../../auth/public";
import {
  type Application,
  type Environment,
  type EnvironmentKind,
  isValidEnvironmentName,
  isValidSlug,
  type Tenant,
} from "../domain/ownership";
import type { ApplicationStore } from "../ports/application-store";
import { canonicalFingerprint, type IdempotencyPort } from "../ports/idempotency";

export interface CreateTenantCommand {
  readonly principal: Principal;
  readonly slug: string;
  readonly name: string;
}

export interface CreateApplicationCommand {
  readonly principal: Principal;
  /** The target tenant the caller claims tenant-scope authority over — verified against durable membership, never trusted. */
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
}

export interface CreateEnvironmentCommand {
  readonly principal: Principal;
  readonly applicationId: string;
  readonly kind: EnvironmentKind;
  readonly name: string;
}

export interface OwnershipServices {
  createTenant(command: CreateTenantCommand, idempotencyKey: string): Promise<Tenant>;
  createApplication(
    command: CreateApplicationCommand,
    idempotencyKey: string,
  ): Promise<Application>;
  createEnvironment(
    command: CreateEnvironmentCommand,
    idempotencyKey: string,
  ): Promise<Environment>;
  getApplication(principal: Principal, applicationId: string): Promise<Application>;
  getEnvironment(principal: Principal, environmentId: string): Promise<Environment>;
  listEnvironments(principal: Principal, applicationId: string): Promise<readonly Environment[]>;
}

/**
 * Caller membership for an application scope, fetched via the auth-facing
 * membership facts this module may see (auth public contract).
 */
export interface MembershipFacts {
  findApplicationMembership(
    actorId: string,
    applicationId: string,
  ): Promise<MembershipRecord | null>;
}

export function createOwnershipServices(
  store: ApplicationStore,
  idempotency: IdempotencyPort,
  resolver: ScopeResolver,
  memberships: MembershipFacts,
  generateId: () => string,
): OwnershipServices {
  const requireAppPermission = async (
    principal: Principal,
    applicationId: string,
    permission: Parameters<ScopeResolver["requirePermission"]>[2],
  ) => {
    const scope = await resolver.resolveApplicationScope(principal, applicationId);
    const membership = await memberships.findApplicationMembership(
      principal.actorId,
      applicationId,
    );
    if (membership !== null) {
      assertScopeCovers(scope, membership.tenantId, { kind: "membership", id: membership.id });
    }
    resolver.requirePermission(scope, membership, permission);
    return { scope, membership };
  };

  return {
    async createTenant(command, idempotencyKey) {
      if (!isValidSlug(command.slug)) {
        throw new PlatformError({
          code: "AUTHORIZATION_DENIED",
          message: "tenant slug is invalid",
          details: { slug: command.slug },
        });
      }
      const fingerprint = canonicalFingerprint([
        "applications.createTenant",
        { slug: command.slug, name: command.name },
      ]);
      const arbitration = await idempotency.arbitrate(
        { actorId: command.principal.actorId, applicationId: null },
        "applications.createTenant",
        idempotencyKey,
        fingerprint,
        async (txStore) => {
          const existing = await txStore.findTenantBySlug(command.slug);
          if (existing !== null) {
            // Converging duplicate (lost an arbitration race or a natural
            // retry): the tenant already exists; surface it as the outcome.
            return existing;
          }
          return txStore.insertTenantWithOwner({
            id: generateId(),
            slug: command.slug,
            name: command.name,
            ownerId: command.principal.actorId,
          });
        },
      );
      return arbitration.outcome;
    },

    async createApplication(command, idempotencyKey) {
      if (!isValidSlug(command.slug)) {
        throw new PlatformError({
          code: "AUTHORIZATION_DENIED",
          message: "application slug is invalid",
          details: { slug: command.slug },
        });
      }
      // Tenant-scope authority: the caller must hold tenant-scope ownership
      // of the target tenant — resolved server-side, never caller-asserted.
      const scope = await resolver.resolveTenantScope(command.principal, command.tenantId);
      const fingerprint = canonicalFingerprint([
        "applications.createApplication",
        { tenantId: scope.tenantId, slug: command.slug, name: command.name },
      ]);
      const arbitration = await idempotency.arbitrate(
        { actorId: command.principal.actorId, applicationId: null },
        "applications.createApplication",
        idempotencyKey,
        fingerprint,
        async (txStore) => {
          const created = await txStore.insertApplicationWithOwner({
            id: generateId(),
            tenantId: scope.tenantId,
            slug: command.slug,
            name: command.name,
            ownerId: command.principal.actorId,
          });
          if (created !== null) {
            return created;
          }
          // (tenant, slug) taken: converge to the existing application.
          const bySlug = await txStore.findApplicationByTenantSlug(scope.tenantId, command.slug);
          if (bySlug !== null) {
            return bySlug;
          }
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message: "application vanished during arbitration",
          });
        },
      );
      return arbitration.outcome;
    },

    async createEnvironment(command, idempotencyKey) {
      if (!isValidEnvironmentName(command.name)) {
        throw new PlatformError({
          code: "AUTHORIZATION_DENIED",
          message: "environment name is invalid",
          details: { name: command.name },
        });
      }
      const { scope } = await requireAppPermission(
        command.principal,
        command.applicationId,
        "environments:write",
      );
      const fingerprint = canonicalFingerprint([
        "applications.createEnvironment",
        { applicationId: command.applicationId, kind: command.kind, name: command.name },
      ]);
      const arbitration = await idempotency.arbitrate(
        { actorId: command.principal.actorId, applicationId: command.applicationId },
        "applications.createEnvironment",
        idempotencyKey,
        fingerprint,
        async (txStore) => {
          const created = await txStore.insertEnvironment({
            id: generateId(),
            applicationId: command.applicationId,
            tenantId: scope.tenantId,
            kind: command.kind,
            name: command.name,
          });
          if (created !== null) {
            return created;
          }
          const existing = (await txStore.listEnvironments(command.applicationId)).find(
            (row) => row.name === command.name,
          );
          if (existing === undefined) {
            throw new PlatformError({
              code: "PROVIDER_ERROR",
              message: "environment creation returned no row",
            });
          }
          return existing;
        },
      );
      return arbitration.outcome;
    },

    async getApplication(principal, applicationId) {
      const { scope } = await requireAppPermission(principal, applicationId, "applications:read");
      const application = await store.findApplication(applicationId);
      if (application === null) {
        throw new PlatformError({ code: "AUTHORIZATION_DENIED", message: "application not found" });
      }
      // Acceptance criterion 4: cross-tenant READ rejected before any
      // downstream execution — the durable tenant of the target must equal
      // the server-resolved scope tenant.
      assertScopeCovers(scope, application.tenantId, { kind: "application", id: application.id });
      return application;
    },

    async getEnvironment(principal, environmentId) {
      const environment = await store.findEnvironment(environmentId);
      if (environment === null) {
        throw new PlatformError({ code: "AUTHORIZATION_DENIED", message: "environment not found" });
      }
      // The application scope is resolved FIRST (authorization), then the
      // environment's durable tenant is checked against it.
      const { scope } = await requireAppPermission(
        principal,
        environment.applicationId,
        "environments:read",
      );
      assertScopeCovers(scope, environment.tenantId, { kind: "environment", id: environment.id });
      return environment;
    },

    async listEnvironments(principal, applicationId) {
      const { scope } = await requireAppPermission(principal, applicationId, "environments:read");
      const rows = await store.listEnvironments(applicationId);
      // Fail closed: any foreign-tenant row is a scope leak, not data.
      return rows.filter((row) => row.tenantId === scope.tenantId);
    },
  };
}
