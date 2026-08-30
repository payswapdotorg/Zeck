/**
 * Server-side scope resolution (auth module application).
 *
 * Acceptance criterion 3: application scope is resolved server-side on every
 * protected command; callers may not select arbitrary tenant scope. The
 * resolver is the ONLY producer of `TenantScope`. Tenant identity is always
 * read from durable ownership/membership rows — a command input never
 * carries a tenant selector (statically enforced by
 * `tests/unit/scope-contract.test.ts`).
 *
 * Acceptance criterion 4: a resolved scope that disagrees with the durable
 * tenant of a target resource fails `TENANT_SCOPE_VIOLATION` BEFORE any
 * downstream module execution (`assertScopeCovers`).
 */

import { PlatformError } from "../../../shared/errors";
import type { Principal } from "../domain/actor";
import type { Permission } from "../domain/roles";
import { roleHasPermission, tenantScopePermissions } from "../domain/roles";
import type { MembershipRecord, TenantScope } from "../domain/scope";
import type { IdentityStore } from "../ports/identity-store";

export interface ScopeResolver {
  /**
   * Resolve the application scope of a protected command: the principal's
   * membership for `applicationId` must exist, and the tenant is the
   * application's OWNING tenant from durable state.
   */
  resolveApplicationScope(principal: Principal, applicationId: string): Promise<TenantScope>;

  /**
   * Resolve tenant-level scope (tenant-wide authority). Only a tenant-scope
   * owner membership qualifies.
   */
  resolveTenantScope(principal: Principal, tenantId: string): Promise<TenantScope>;

  /**
   * Guard a resolved scope with a permission requirement (authorization).
   * Membership role supplies the permission; tenant-scope supplies all of
   * them. Fails `AUTHORIZATION_DENIED` otherwise.
   */
  requirePermission(
    scope: TenantScope,
    membership: MembershipRecord | null,
    permission: Permission,
  ): void;
}

function deny(message: string, details?: Record<string, unknown>): never {
  throw new PlatformError({ code: "AUTHORIZATION_DENIED", message, details });
}

export function createScopeResolver(store: IdentityStore): ScopeResolver {
  const principalShape = (principal: Principal): void => {
    if (!principal || typeof principal.actorId !== "string" || principal.actorId.length === 0) {
      throw new PlatformError({
        code: "AUTHENTICATION_FAILED",
        message: "protected command requires an authenticated principal",
      });
    }
  };

  return {
    async resolveApplicationScope(principal, applicationId) {
      principalShape(principal);
      const row = await store.findMembershipWithApplicationTenant(principal.actorId, applicationId);
      if (row === null) {
        throw deny("actor holds no membership for this application", { applicationId });
      }
      if (row.applicationTenantId === null || row.applicationTenantId !== row.membership.tenantId) {
        // Durable-state inconsistency between membership tenant and the
        // application's owning tenant must never yield a usable scope.
        throw new PlatformError({
          code: "TENANT_SCOPE_VIOLATION",
          message: "membership tenant disagrees with the application's owning tenant",
          details: { applicationId },
        });
      }
      return {
        tenantId: row.applicationTenantId,
        applicationId,
        origin: "application-membership",
      };
    },

    async resolveTenantScope(principal, tenantId) {
      principalShape(principal);
      const membership = await store.findTenantMembership(principal.actorId, tenantId);
      if (membership === null || membership.role !== "owner") {
        throw deny("actor holds no tenant-scope authority for this tenant", { tenantId });
      }
      return { tenantId, applicationId: null, origin: "tenant-membership" };
    },

    requirePermission(scope, membership, permission) {
      if (scope.origin === "tenant-membership") {
        if (membership && tenantScopePermissions(membership.role)?.includes(permission)) {
          return;
        }
        deny("tenant-scope authority does not include this permission", { permission });
      }
      if (scope.origin === "application-membership") {
        if (
          membership &&
          membership.applicationId === scope.applicationId &&
          membership.tenantId === scope.tenantId
        ) {
          if (roleHasPermission(membership.role, permission)) {
            return;
          }
          deny("membership role does not include this permission", {
            permission,
            role: membership.role,
          });
        }
        deny("permission check requires the scope's own membership record");
      }
      deny("scope origin is not authorized");
    },
  };
}

/**
 * Cross-tenant guard (acceptance criterion 4). Throws `TENANT_SCOPE_VIOLATION`
 * when a target resource's durable tenant is not the scope's tenant — before
 * any downstream execution continues.
 */
export function assertScopeCovers(
  scope: TenantScope,
  targetTenantId: string,
  target: { readonly kind: string; readonly id: string },
): void {
  if (scope.tenantId !== targetTenantId) {
    throw new PlatformError({
      code: "TENANT_SCOPE_VIOLATION",
      message: `cross-tenant ${target.kind} access rejected before execution`,
      details: { targetId: target.id, scopeTenantId: scope.tenantId, targetTenantId },
    });
  }
}
