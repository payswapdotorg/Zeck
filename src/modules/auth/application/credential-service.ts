/**
 * Credential lifecycle service (auth module application; DEP-011).
 *
 * THE ONE CREDENTIAL AUTHORITY'S APPLICATION SERVICE — the
 * membership-service house pattern (application service + neutral ports +
 * SQL/in-memory adapters + public barrel export). Every mutation:
 *   1. resolves the application scope SERVER-SIDE through the scope
 *      resolver (durable membership rows; a caller never selects tenant);
 *   2. requires the caller's membership to carry the permission
 *      (`credentials:write` for issue/rotate/revoke, `credentials:read`
 *      for listing);
 *   3. re-derives the target's tenant from the durable row and guards it
 *      with `assertScopeCovers` — a cross-tenant target fails
 *      `TENANT_SCOPE_VIOLATION` BEFORE any durable write;
 *   4. executes inside idempotency arbitration (same key + same
 *      fingerprint replays the durable outcome; key reuse with a different
 *      payload fails `IDEMPOTENCY_KEY_REUSED`).
 *
 * THE SHOW-ONCE SECRET CONTRACT (DEP-011 AC1): `issue` and `rotate` return
 * the secret material exactly once — captured inside the arbitration's work
 * closure and returned alongside the metadata outcome ONLY on the
 * non-replayed execution. The durable outcome (what the ledger stores and
 * what a replay returns) is the metadata-only `CredentialRecord` projection:
 * no route, log or render path built on this service can retrieve the
 * secret afterwards. A replay of the same idempotent key returns the record
 * with NO secret — a caller that lost the first response rotates to obtain
 * a successor secret.
 *
 * ISSUANCE GATE (DEP-011): a deployment whose secret store cannot store
 * credentials (the environment-materialization adapter is read-only)
 * composes this service with `issuanceEnabled: false`. The gate is honest
 * and explicit: `issue`/`rotate` fail `CAPABILITY_UNAVAILABLE` and the
 * listing carries the gate fact so the console renders the unavailable
 * state BEFORE any form is submitted.
 */

import { PlatformError } from "../../../shared/errors";
import type { Principal } from "../domain/actor";
import type { CredentialRecord } from "../domain/credential";
import { isValidCredentialLabel } from "../domain/credential";
import type { ApplicationRole } from "../domain/roles";
import { APPLICATION_ROLES, rolePermissions } from "../domain/roles";
import type { MembershipRecord, TenantScope } from "../domain/scope";
import type { CredentialIdempotencyPort, CredentialTx } from "../ports/credential-idempotency";
import type { CredentialSecretStore, CredentialStore } from "../ports/credential-store";
import { toCredentialRecord } from "../ports/credential-store";
import { canonicalFingerprint } from "../ports/idempotency";
import type { IdentityStore } from "../ports/identity-store";
import type { ScopeResolver } from "./scope-resolver";
import { assertScopeCovers } from "./scope-resolver";

export interface IssueCredentialCommand {
  readonly principal: Principal;
  readonly applicationId: string;
  readonly label: string;
  readonly role: ApplicationRole;
}

export interface RotateCredentialCommand {
  readonly principal: Principal;
  readonly applicationId: string;
  readonly credentialId: string;
}

export interface RevokeCredentialCommand {
  readonly principal: Principal;
  readonly applicationId: string;
  readonly credentialId: string;
}

/** The metadata-only mutation outcome; `secret` is present on the FIRST execution only. */
export interface IssueCredentialOutcome {
  readonly record: CredentialRecord;
  /** Show-once secret: present iff this call was the durable first execution. */
  readonly secret: string | null;
  readonly replayed: boolean;
}

export interface RevokeCredentialOutcome {
  readonly record: CredentialRecord;
  readonly replayed: boolean;
}

export interface CredentialService {
  /** The deployment's issuance capability fact (composition-owned gate). */
  issuanceEnabled(): boolean;
  issue(command: IssueCredentialCommand, idempotencyKey: string): Promise<IssueCredentialOutcome>;
  rotate(command: RotateCredentialCommand, idempotencyKey: string): Promise<IssueCredentialOutcome>;
  revoke(
    command: RevokeCredentialCommand,
    idempotencyKey: string,
  ): Promise<RevokeCredentialOutcome>;
  list(principal: Principal, applicationId: string): Promise<readonly CredentialRecord[]>;
  /** The permission scope a credential's role carries (the authority's vocabulary). */
  permissionsOf(role: ApplicationRole): readonly string[];
}

export interface CredentialServiceDeps {
  /** The durable identity store (the same surface the scope resolver reads). */
  readonly identityStore: IdentityStore;
  /** The credential store (durable records; SQL or in-memory adapter). */
  readonly credentialStore: CredentialStore;
  /** The credential idempotency ledger. */
  readonly idempotency: CredentialIdempotencyPort;
  /** The server-side scope resolver (the ONLY producer of TenantScope). */
  readonly resolver: ScopeResolver;
  /** Durable id generator (uuidv7 in compositions; deterministic in tests). */
  readonly generateId: () => string;
  /** Secret-material generator (credential-shaped; never logged). */
  readonly generateSecret: () => string;
  readonly now: () => Date;
  /** Write-only secret materialization through the neutral port. */
  readonly secretStore: CredentialSecretStore;
  /** The deployment's issuance gate (honest, composition-owned). */
  readonly issuanceEnabled: boolean;
}

export function createCredentialService(deps: CredentialServiceDeps): CredentialService {
  const membershipOfScope = async (
    principal: Principal,
    scope: TenantScope,
  ): Promise<MembershipRecord> => {
    if (scope.applicationId === null) {
      throw new PlatformError({
        code: "AUTHORIZATION_DENIED",
        message: "credential operations are application-scoped",
      });
    }
    const row = await deps.identityStore.findMembershipWithApplicationTenant(
      principal.actorId,
      scope.applicationId,
    );
    if (row === null) {
      throw new PlatformError({
        code: "AUTHORIZATION_DENIED",
        message: "actor holds no membership for this application",
      });
    }
    // Scope guard: the caller's own membership must be the scope's tenant.
    assertScopeCovers(scope, row.membership.tenantId, {
      kind: "membership-owner",
      id: row.membership.id,
    });
    return row.membership;
  };

  const scoped = async (
    principal: Principal,
    applicationId: string,
    permission: "credentials:read" | "credentials:write",
  ): Promise<TenantScope> => {
    const scope = await deps.resolver.resolveApplicationScope(principal, applicationId);
    const membership = await membershipOfScope(principal, scope);
    deps.resolver.requirePermission(scope, membership, permission);
    return scope;
  };

  const requireIssuanceEnabled = (): void => {
    if (!deps.issuanceEnabled) {
      throw new PlatformError({
        code: "CAPABILITY_UNAVAILABLE",
        message:
          "credential issuance is not enabled for this deployment (the composition's secret store cannot hold issued credentials)",
      });
    }
  };

  const validateLabel = (label: string): string => {
    if (!isValidCredentialLabel(label)) {
      throw new PlatformError({
        code: "CAPABILITY_UNAVAILABLE",
        message:
          "credential label must match the recorded shape: 1..64 chars, starts with a letter or digit, then letters/digits/spaces/._-",
      });
    }
    return label;
  };

  const validateRole = (role: string): ApplicationRole => {
    if (!(APPLICATION_ROLES as readonly string[]).includes(role)) {
      throw new PlatformError({
        code: "CAPABILITY_UNAVAILABLE",
        message: `credential role must be one of the assignable roles (${APPLICATION_ROLES.join(", ")})`,
      });
    }
    return role as ApplicationRole;
  };

  return {
    issuanceEnabled() {
      return deps.issuanceEnabled;
    },

    async issue(command, idempotencyKey) {
      const scope = await scoped(command.principal, command.applicationId, "credentials:write");
      requireIssuanceEnabled();
      const label = validateLabel(command.label);
      const role = validateRole(command.role);

      const fingerprint = canonicalFingerprint([
        "credentials.issue",
        { applicationId: command.applicationId, label, role },
      ]);

      // SHOW-ONCE capture: the secret material is generated and stored
      // INSIDE the arbitration's work closure, captured in this local
      // variable, and returned ONLY when this call executed the work. The
      // ledger's durable outcome (the work's return value) is metadata-only.
      let showOnceSecret: string | null = null;

      const arbitration = await deps.idempotency.arbitrate(
        {
          actorId: command.principal.actorId,
          applicationId: scope.applicationId ?? command.applicationId,
        },
        "credentials.issue",
        idempotencyKey,
        fingerprint,
        async (tx: CredentialTx) => {
          const material = deps.generateSecret();
          const { reference } = await deps.secretStore.store({
            material,
            description: `application transport credential ${label} (${role})`,
          });
          const credentialId = deps.generateId();
          const row = await tx.store.insertCredential({
            id: credentialId,
            credentialId,
            applicationId: command.applicationId,
            tenantId: scope.tenantId,
            label,
            role,
            secretReference: reference,
          });
          showOnceSecret = material;
          return { record: toCredentialRecord(row) };
        },
      );
      return {
        record: arbitration.outcome.record,
        secret: arbitration.replayed ? null : showOnceSecret,
        replayed: arbitration.replayed,
      };
    },

    async rotate(command, idempotencyKey) {
      const scope = await scoped(command.principal, command.applicationId, "credentials:write");
      requireIssuanceEnabled();

      const fingerprint = canonicalFingerprint([
        "credentials.rotate",
        { applicationId: command.applicationId, credentialId: command.credentialId },
      ]);

      let showOnceSecret: string | null = null;

      const arbitration = await deps.idempotency.arbitrate(
        {
          actorId: command.principal.actorId,
          applicationId: scope.applicationId ?? command.applicationId,
        },
        "credentials.rotate",
        idempotencyKey,
        fingerprint,
        async (tx: CredentialTx) => {
          // Lookup WITHOUT application filtering first: a foreign credential
          // identity is REJECTED explicitly (cross-tenant), never silently
          // no-op'ed as "not found".
          const current = await tx.store.findCurrentByCredentialId(command.credentialId);
          if (current === null) {
            throw new PlatformError({
              code: "AUTHENTICATION_FAILED",
              message: "credential identity does not exist",
            });
          }
          assertScopeCovers(scope, current.tenantId, {
            kind: "credential",
            id: current.id,
          });
          if (current.applicationId !== command.applicationId) {
            throw new PlatformError({
              code: "TENANT_SCOPE_VIOLATION",
              message: "credential belongs to a different application",
            });
          }
          if (current.status !== "active") {
            // Revoked credentials cannot rotate; a retired record means the
            // identity's ACTIVE record should have been addressed instead.
            throw new PlatformError({
              code: "INVALID_STATE_TRANSITION",
              message: `a ${current.status} credential cannot be rotated`,
            });
          }
          // The successor: a NEW record under the SAME credential identity.
          // The predecessor is retired FIRST (inside this transaction —
          // the one-active-per-identity invariant holds at every commit
          // boundary; the SQL partial unique index enforces it durably and
          // both statements share the arbitration transaction).
          const material = deps.generateSecret();
          const { reference } = await deps.secretStore.store({
            material,
            description: `application transport credential ${current.label} (${current.role}) — rotation successor`,
          });
          const successorId = deps.generateId();
          const retired = await tx.store.retireCredential(current.id, {
            rotatedAt: deps.now().toISOString(),
            supersededBy: successorId,
          });
          if (retired === null) {
            throw new PlatformError({
              code: "PROVIDER_ERROR",
              message: "credential vanished during rotation retirement",
            });
          }
          const successor = await tx.store.insertCredential({
            id: successorId,
            credentialId: current.credentialId,
            applicationId: current.applicationId,
            tenantId: current.tenantId,
            label: current.label,
            role: current.role,
            secretReference: reference,
          });
          showOnceSecret = material;
          return { record: toCredentialRecord(successor) };
        },
      );
      return {
        record: arbitration.outcome.record,
        secret: arbitration.replayed ? null : showOnceSecret,
        replayed: arbitration.replayed,
      };
    },

    async revoke(command, idempotencyKey) {
      const scope = await scoped(command.principal, command.applicationId, "credentials:write");

      const fingerprint = canonicalFingerprint([
        "credentials.revoke",
        { applicationId: command.applicationId, credentialId: command.credentialId },
      ]);

      const arbitration = await deps.idempotency.arbitrate(
        {
          actorId: command.principal.actorId,
          applicationId: scope.applicationId ?? command.applicationId,
        },
        "credentials.revoke",
        idempotencyKey,
        fingerprint,
        async (tx: CredentialTx) => {
          const current = await tx.store.findCurrentByCredentialId(command.credentialId);
          if (current === null) {
            throw new PlatformError({
              code: "AUTHENTICATION_FAILED",
              message: "credential identity does not exist",
            });
          }
          assertScopeCovers(scope, current.tenantId, {
            kind: "credential",
            id: current.id,
          });
          if (current.applicationId !== command.applicationId) {
            throw new PlatformError({
              code: "TENANT_SCOPE_VIOLATION",
              message: "credential belongs to a different application",
            });
          }
          if (current.status === "revoked") {
            // Idempotent convergence: the durable outcome already holds.
            return { record: toCredentialRecord(current) };
          }
          const revoked = await tx.store.revokeCredential(current.id);
          if (revoked === null) {
            throw new PlatformError({
              code: "PROVIDER_ERROR",
              message: "credential vanished during revocation",
            });
          }
          return { record: toCredentialRecord(revoked) };
        },
      );
      return { record: arbitration.outcome.record, replayed: arbitration.replayed };
    },

    async list(principal, applicationId) {
      const scope = await scoped(principal, applicationId, "credentials:read");
      const rows = await deps.credentialStore.listCredentials({
        applicationId: scope.applicationId ?? applicationId,
      });
      // Reads are tenant-filtered by the guard: any foreign-tenant row that
      // could ever appear here fails closed instead of leaking.
      return rows
        .filter((row) => row.tenantId === scope.tenantId)
        .map((row) => toCredentialRecord(row));
    },

    permissionsOf(role) {
      return rolePermissions(role);
    },
  };
}
