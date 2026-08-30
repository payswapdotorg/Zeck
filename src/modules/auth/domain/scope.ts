/**
 * Tenant scope — the server-derived isolation boundary (auth module domain).
 *
 * Acceptance criterion 3: application scope is resolved SERVER-SIDE on every
 * protected command; callers may not select arbitrary tenant scope. The
 * tenant of a `TenantScope` is therefore never a caller input: it is derived
 * from durable membership + application ownership rows (see
 * `application/scope-resolver.ts`).
 *
 * Protected-command inputs in this module and in `applications` deliberately
 * carry NO tenant selector field. `tests/unit/scope-contract.test.ts` enforces
 * this statically over the contract sources (a tenant selector added to a
 * command input fails that test), and the resolver tests enforce it
 * dynamically.
 */

import type { Principal } from "./actor";
import type { ApplicationRole } from "./roles";

/**
 * The resolved, authorized scope of a protected command.
 * `origin` records how the scope was derived — always durable state.
 */
export interface TenantScope {
  readonly tenantId: string;
  readonly applicationId: string | null;
  readonly origin: "application-membership" | "tenant-membership";
}

/** Scope resolution failure, typed with the canonical taxonomy. */
export type ScopeResolutionFailureCode =
  | "AUTHENTICATION_FAILED"
  | "AUTHORIZATION_DENIED"
  | "TENANT_SCOPE_VIOLATION";

/**
 * A membership record as seen by authorization decisions.
 */
export interface MembershipRecord {
  readonly id: string;
  readonly actorId: string;
  readonly applicationId: string | null;
  readonly tenantId: string;
  readonly role: ApplicationRole;
  readonly createdAt: string;
}

/** Shape every protected command shares: principal + target, never a tenant id. */
export interface ProtectedCommand {
  readonly principal: Principal;
}
