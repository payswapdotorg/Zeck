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
 *
 * DEP-011 extends the authority with the credential lifecycle: the
 * metadata-only credential record (secret material NEVER appears in any
 * exported type), the credential store/idempotency/secret ports, the
 * credential application service, and the SQL/in-memory adapters. The
 * barrel stays provider-neutral: factories accept module-owned ports; SQL
 * adapter wiring lives in `adapters/` and is composed by the transport
 * Work Order that owns the API layer.
 */

import type { ModuleDescriptor } from "../../shared/module";
import { type CredentialService, createCredentialService } from "./application/credential-service";
import { createMembershipService, type MembershipService } from "./application/membership-service";
import { createScopeResolver, type ScopeResolver } from "./application/scope-resolver";
import type { Actor, Principal, ProvisionActorInput } from "./domain/actor";
import type { ApplicationRole, Permission } from "./domain/roles";
import type { MembershipRecord, TenantScope } from "./domain/scope";
import type { CredentialTx } from "./ports/credential-idempotency";
import type {
  CredentialSecretStore,
  CredentialStore,
  CredentialStoreRow,
} from "./ports/credential-store";
import type { IdempotencyPort } from "./ports/idempotency";
import type { IdentityStore } from "./ports/identity-store";

export const moduleDescriptor: ModuleDescriptor = { id: "auth" };

export { InMemoryCredentialIdempotency } from "./adapters/in-memory-credential-idempotency";
/** The credential-lifecycle adapters (in-memory test doubles + SQL composition). */
export { InMemoryCredentialStore } from "./adapters/in-memory-credential-store";
export {
  CREDENTIAL_SECRET_CLASSIFICATION,
  createPlatformCredentialSecretStore,
  InMemoryCredentialSecretStore,
  randomCredentialSecret,
} from "./adapters/platform-secret-store";
export {
  createSqlCredentialModule,
  createTxCredentialStore,
  type SqlCredentialModule,
} from "./adapters/sql-credential-store";
export type {
  CredentialServiceDeps,
  IssueCredentialCommand,
  IssueCredentialOutcome,
  RevokeCredentialCommand,
  RevokeCredentialOutcome,
  RotateCredentialCommand,
} from "./application/credential-service";
/** The cross-tenant guard: fails `TENANT_SCOPE_VIOLATION` before downstream execution. */
export { assertScopeCovers } from "./application/scope-resolver";
export type { CredentialRecord, CredentialStatus } from "./domain/credential";
/** The credential lifecycle vocabulary (DEP-011 — statuses + label shape). */
export {
  CREDENTIAL_LABEL_PATTERN,
  CREDENTIAL_STATUSES,
  isValidCredentialLabel,
} from "./domain/credential";
/** Authorization decisions other modules consume via scope resolution. */
export {
  APPLICATION_ROLES,
  ASSIGNABLE_ROLES,
  PERMISSIONS,
  roleHasPermission,
  rolePermissions,
  tenantScopePermissions,
} from "./domain/roles";
export type {
  CredentialIdempotencyArbitration,
  CredentialIdempotencyScope,
} from "./ports/credential-idempotency";
export type {
  InsertCredentialInput,
  ListCredentialsFilter,
  RetireCredentialInput,
} from "./ports/credential-store";
/** Canonical fingerprint helper shared with callers that build idempotent mutations. */
export { canonicalFingerprint } from "./ports/idempotency";
// Domain contracts (acceptance criterion 1).
// Module ports (provider-neutral; implemented by adapters).
// Application services.
export type {
  Actor,
  ApplicationRole,
  CredentialSecretStore,
  CredentialService,
  CredentialStore,
  CredentialStoreRow,
  CredentialTx,
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
export { createCredentialService, createMembershipService, createScopeResolver };
