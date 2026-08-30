/**
 * Public contract barrel of the `auth` module.
 *
 * This file is the ONLY supported import surface for other modules and for
 * the API layer (`IMPLEMENTATION.md` §2, `spec/contracts.md` "Public
 * module rule"). Everything else under `src/modules/auth/` is private to
 * this module.
 *
 * WORK-002 introduces the identity/authorization contracts: actors,
 * principals, membership roles/permissions, server-derived tenant scope,
 * membership mutations with idempotent semantics, and the scope-resolution
 * guard other modules must resolve before executing protected commands.
 * The barrel stays provider-neutral: factories accept module-owned ports;
 * SQL adapter wiring lives in `adapters/` and is composed by the transport
 * Work Order that owns the API layer.
 */

import type { ModuleDescriptor } from "../../shared/module";
import { createMembershipService, type MembershipService } from "./application/membership-service";
import { createScopeResolver, type ScopeResolver } from "./application/scope-resolver";
import type { Actor, Principal, ProvisionActorInput } from "./domain/actor";
import type { ApplicationRole, Permission } from "./domain/roles";
import type { MembershipRecord, TenantScope } from "./domain/scope";
import type { IdempotencyPort } from "./ports/idempotency";
import type { IdentityStore } from "./ports/identity-store";

export const moduleDescriptor: ModuleDescriptor = { id: "auth" };

/** The cross-tenant guard: fails `TENANT_SCOPE_VIOLATION` before downstream execution. */
export { assertScopeCovers } from "./application/scope-resolver";
/** Authorization decisions other modules consume via scope resolution. */
export {
  APPLICATION_ROLES,
  ASSIGNABLE_ROLES,
  PERMISSIONS,
  roleHasPermission,
  rolePermissions,
  tenantScopePermissions,
} from "./domain/roles";
/** Canonical fingerprint helper shared with callers that build idempotent mutations. */
export { canonicalFingerprint } from "./ports/idempotency";
// Domain contracts (acceptance criterion 1).
// Module ports (provider-neutral; implemented by adapters).
// Application services.
export type {
  Actor,
  ApplicationRole,
  IdempotencyPort,
  IdentityStore,
  MembershipRecord,
  MembershipService,
  Permission,
  Principal,
  ProvisionActorInput,
  ScopeResolver,
  TenantScope,
};
export { createMembershipService, createScopeResolver };
