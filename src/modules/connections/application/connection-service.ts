/**
 * Connection service (connections module application).
 *
 * Provider-neutral connection lifecycle (CON-001) with first-class BYOK
 * (CON-002): registration, enable/disable, credential rotation and removal —
 * every mutation idempotent through the module ledger (replay / key-reuse
 * rejection / concurrent convergence) and every state-derived decision taken
 * under the per-connection lock boundary inside the arbitration transaction
 * (WORK-002 discipline).
 *
 * Authorization: scope is resolved SERVER-SIDE via the auth public resolver;
 * callers never select tenant scope. Write operations require the
 * application-scoped `applications:write` permission (owner/admin), reads
 * require `applications:read`. Dedicated `connections:*` permissions are an
 * auth-surface change reserved for a future Work Order — recorded as a design
 * decision in the WORK-003 evidence.
 *
 * Secret hygiene: BYOK plaintext crosses the boundary exactly once (inward,
 * `registerCredential.material`); it is stored through the vault inside the
 * transaction and never returned, logged or journaled. Rotation destroys the
 * superseded material in the same transaction as the reference swap.
 */

import { PlatformError } from "../../../shared/errors";
import type {
  IdentityStore,
  MembershipRecord,
  Principal,
  ScopeResolver,
  TenantScope,
} from "../../auth/public";
import { canonicalFingerprint } from "../../auth/public";
import type {
  ConnectionDispatchFacts,
  ConnectionRecord,
  ConnectionStatus,
  CredentialKind,
  StoredConnection,
} from "../domain/connection";
import { toPublicConnection } from "../domain/connection";
import {
  isProviderRail,
  isValidConnectionLabel,
  isValidEndpointUrl,
  type RailSlug,
} from "../domain/rails";
import type { ConnectionStore } from "../ports/connection-store";
import type { ConnectionsIdempotencyPort } from "../ports/idempotency";

export interface RegisterConnectionCommand {
  readonly principal: Principal;
  readonly applicationId: string;
  readonly rail: RailSlug;
  readonly label: string;
  readonly endpointUrl?: string | null;
  /**
   * BYOK material — write-only. `null`/absent registers a platform-credential
   * connection (no per-connection material).
   */
  readonly registerCredential?: { readonly material: string } | null;
}

export interface UpdateConnectionStatusCommand {
  readonly principal: Principal;
  readonly applicationId: string;
  readonly connectionId: string;
  readonly status: ConnectionStatus;
}

export interface RotateCredentialCommand {
  readonly principal: Principal;
  readonly applicationId: string;
  readonly connectionId: string;
  /** Replacement BYOK material — write-only, never returned. */
  readonly material: string;
}

export interface RemoveConnectionCommand {
  readonly principal: Principal;
  readonly applicationId: string;
  readonly connectionId: string;
}

export interface ConnectionService {
  registerConnection(
    command: RegisterConnectionCommand,
    idempotencyKey: string,
  ): Promise<{ connection: ConnectionRecord }>;
  updateStatus(
    command: UpdateConnectionStatusCommand,
    idempotencyKey: string,
  ): Promise<{ connection: ConnectionRecord; changed: boolean }>;
  rotateCredential(
    command: RotateCredentialCommand,
    idempotencyKey: string,
  ): Promise<{ connection: ConnectionRecord }>;
  removeConnection(
    command: RemoveConnectionCommand,
    idempotencyKey: string,
  ): Promise<{ removed: boolean }>;
  listConnections(
    principal: Principal,
    applicationId: string,
  ): Promise<readonly ConnectionRecord[]>;
  /** Dispatch-time facts for the models fabric (scope is server-derived). */
  getConnectionForDispatch(
    scope: { readonly tenantId: string; readonly applicationId: string },
    connectionId: string,
  ): Promise<ConnectionDispatchFacts>;
}

/**
 * One-way digest of credential material for idempotency fingerprints. The
 * digest distinguishes logical operations (same key + different material is
 * key reuse) without ever embedding material in the ledger.
 */
export type MaterialDigester = (material: string) => Promise<string>;

const defaultDigester: MaterialDigester = async (material) => {
  const bytes = new TextEncoder().encode(material);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(digest).toString("hex");
};

export function createConnectionService(
  store: ConnectionStore,
  idempotency: ConnectionsIdempotencyPort,
  resolver: ScopeResolver,
  memberships: Pick<IdentityStore, "findMembershipWithApplicationTenant">,
  generateId: () => string,
  options?: { readonly digestMaterial?: MaterialDigester },
): ConnectionService {
  const digestMaterial = options?.digestMaterial ?? defaultDigester;

  const authorize = async (
    principal: Principal,
    applicationId: string,
    permission: "applications:read" | "applications:write",
  ): Promise<{ scope: TenantScope; membership: MembershipRecord }> => {
    const scope = await resolver.resolveApplicationScope(principal, applicationId);
    const row = await memberships.findMembershipWithApplicationTenant(
      principal.actorId,
      applicationId,
    );
    if (row === null) {
      throw new PlatformError({
        code: "AUTHORIZATION_DENIED",
        message: "actor holds no membership for this application",
      });
    }
    // Scope guard: the membership's own tenant must be the scope tenant.
    if (row.membership.tenantId !== scope.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "membership tenant disagrees with the resolved application scope",
      });
    }
    resolver.requirePermission(scope, row.membership, permission);
    return { scope, membership: row.membership };
  };

  const credentialKindOf = (command: RegisterConnectionCommand): CredentialKind =>
    command.registerCredential && command.registerCredential.material.length > 0
      ? "byok"
      : "platform";

  const validateRegistration = (command: RegisterConnectionCommand): void => {
    if (!isProviderRail(command.rail)) {
      throw new PlatformError({
        code: "AUTHORIZATION_DENIED",
        message: `unknown provider rail: ${command.rail}`,
        details: { rail: command.rail },
      });
    }
    if (!isValidConnectionLabel(command.label)) {
      throw new PlatformError({
        code: "AUTHORIZATION_DENIED",
        message: "connection label must be a lowercase slug (2-40 chars)",
        details: { label: command.label },
      });
    }
    const endpoint = command.endpointUrl ?? null;
    if (endpoint !== null && !isValidEndpointUrl(endpoint)) {
      throw new PlatformError({
        code: "AUTHORIZATION_DENIED",
        message: "endpoint url must be a valid http(s) url",
      });
    }
    if (command.rail === "custom" && endpoint === null) {
      throw new PlatformError({
        code: "AUTHORIZATION_DENIED",
        message: "custom rail connections require an endpoint url",
      });
    }
  };

  /** Cross-tenant + cross-application guard for a locked/loaded row. */
  const guardInScope = (connection: StoredConnection, scope: TenantScope): void => {
    if (
      connection.applicationId !== scope.applicationId ||
      connection.tenantId !== scope.tenantId
    ) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "connection belongs to a different application or tenant",
        details: { connectionId: connection.id },
      });
    }
  };

  return {
    async registerConnection(command, idempotencyKey) {
      validateRegistration(command);
      const { scope } = await authorize(
        command.principal,
        command.applicationId,
        "applications:write",
      );

      const kind = credentialKindOf(command);
      const fingerprint = canonicalFingerprint([
        "connections.registerConnection",
        {
          applicationId: command.applicationId,
          rail: command.rail,
          label: command.label,
          endpointUrl: command.endpointUrl ?? null,
          credentialKind: kind,
          materialDigest:
            kind === "byok"
              ? await digestMaterial(command.registerCredential?.material ?? "")
              : null,
        },
      ]);

      const arbitration = await idempotency.arbitrate(
        { actorId: command.principal.actorId, applicationId: command.applicationId },
        "connections.registerConnection",
        idempotencyKey,
        fingerprint,
        async (tx) => {
          let credentialRef: string | null = null;
          if (kind === "byok") {
            const stored = await tx.vault.store(command.registerCredential?.material ?? "", {
              description: `${command.rail}:${command.label}`,
            });
            credentialRef = stored.reference;
          }
          const inserted = await tx.store.insertConnection({
            id: generateId(),
            applicationId: command.applicationId,
            // Tenant is derived from durable scope, never from the caller.
            tenantId: scope.tenantId,
            rail: command.rail,
            label: command.label,
            endpointUrl: command.endpointUrl ?? null,
            credentialKind: kind,
            credentialRef,
          });
          if (inserted !== null) {
            return { connection: toPublicConnection(inserted) };
          }
          // Label uniqueness collided: converge on an identical registration,
          // reject a conflicting one. The stray vault row (if any) is
          // destroyed in the SAME transaction — no orphaned material.
          if (credentialRef !== null) {
            await tx.vault.destroy(credentialRef);
          }
          const existing = await tx.store.findConnectionByLabel(
            command.applicationId,
            scope.tenantId,
            command.label,
          );
          if (existing === null) {
            throw new PlatformError({
              code: "PROVIDER_ERROR",
              message: "connection label collision without an existing row",
            });
          }
          const identical =
            existing.applicationId === command.applicationId &&
            existing.tenantId === scope.tenantId &&
            existing.rail === command.rail &&
            existing.endpointUrl === (command.endpointUrl ?? null) &&
            existing.credentialKind === kind;
          if (!identical) {
            throw new PlatformError({
              code: "AUTHORIZATION_DENIED",
              message: "connection label already in use with a different configuration",
              details: { label: command.label, connectionId: existing.id },
            });
          }
          return { connection: toPublicConnection(existing) };
        },
      );
      return arbitration.outcome;
    },

    async updateStatus(command, idempotencyKey) {
      const { scope } = await authorize(
        command.principal,
        command.applicationId,
        "applications:write",
      );
      const fingerprint = canonicalFingerprint([
        "connections.updateStatus",
        {
          connectionId: command.connectionId,
          applicationId: command.applicationId,
          status: command.status,
        },
      ]);
      const arbitration = await idempotency.arbitrate(
        { actorId: command.principal.actorId, applicationId: command.applicationId },
        "connections.updateStatus",
        idempotencyKey,
        fingerprint,
        async (tx) => {
          const locked = await tx.store.lockConnection(command.connectionId);
          if (locked === null) {
            return { connection: null, changed: false };
          }
          guardInScope(locked, scope);
          if (locked.status === command.status) {
            return { connection: toPublicConnection(locked), changed: false };
          }
          const updated = await tx.store.updateStatus(command.connectionId, command.status);
          if (updated === null) {
            throw new PlatformError({
              code: "PROVIDER_ERROR",
              message: "connection vanished during status update",
            });
          }
          return { connection: toPublicConnection(updated), changed: true };
        },
      );
      if (arbitration.outcome.connection === null) {
        throw new PlatformError({
          code: "AUTHORIZATION_DENIED",
          message: "connection not found",
          details: { connectionId: command.connectionId },
        });
      }
      return arbitration.outcome;
    },

    async rotateCredential(command, idempotencyKey) {
      const { scope } = await authorize(
        command.principal,
        command.applicationId,
        "applications:write",
      );
      const fingerprint = canonicalFingerprint([
        "connections.rotateCredential",
        {
          applicationId: command.applicationId,
          connectionId: command.connectionId,
          materialDigest: await digestMaterial(command.material),
        },
      ]);
      const arbitration = await idempotency.arbitrate(
        { actorId: command.principal.actorId, applicationId: command.applicationId },
        "connections.rotateCredential",
        idempotencyKey,
        fingerprint,
        async (tx) => {
          const locked = await tx.store.lockConnection(command.connectionId);
          if (locked === null) {
            throw new PlatformError({
              code: "AUTHORIZATION_DENIED",
              message: "connection not found",
              details: { connectionId: command.connectionId },
            });
          }
          guardInScope(locked, scope);
          if (locked.credentialKind !== "byok" || locked.credentialRef === null) {
            throw new PlatformError({
              code: "AUTHORIZATION_DENIED",
              message: "connection has no byok credential to rotate",
              details: { connectionId: command.connectionId },
            });
          }
          const previousRef = locked.credentialRef;
          const stored = await tx.vault.store(command.material, {
            description: `rotation:${command.connectionId}`,
          });
          const updated = await tx.store.updateCredentialRef(
            command.connectionId,
            stored.reference,
          );
          if (updated === null) {
            throw new PlatformError({
              code: "PROVIDER_ERROR",
              message: "connection vanished during credential rotation",
            });
          }
          // Superseded material is destroyed in the SAME transaction as the
          // reference swap: rotation is atomic destruction + replacement.
          const destroyed = await tx.vault.destroy(previousRef);
          if (!destroyed) {
            throw new PlatformError({
              code: "PROVIDER_ERROR",
              message: "superseded credential material vanished during rotation",
            });
          }
          return { connection: toPublicConnection(updated) };
        },
      );
      return arbitration.outcome;
    },

    async removeConnection(command, idempotencyKey) {
      const { scope } = await authorize(
        command.principal,
        command.applicationId,
        "applications:write",
      );
      const fingerprint = canonicalFingerprint([
        "connections.removeConnection",
        { connectionId: command.connectionId, applicationId: command.applicationId },
      ]);
      const arbitration = await idempotency.arbitrate(
        { actorId: command.principal.actorId, applicationId: command.applicationId },
        "connections.removeConnection",
        idempotencyKey,
        fingerprint,
        async (tx) => {
          const locked = await tx.store.lockConnection(command.connectionId);
          if (locked === null) {
            return { removed: false };
          }
          guardInScope(locked, scope);
          const removed = await tx.store.deleteConnection(command.connectionId);
          if (!removed) {
            throw new PlatformError({
              code: "PROVIDER_ERROR",
              message: "connection vanished during removal",
            });
          }
          // Material destruction happens AFTER the connection row delete
          // (the FK would block it otherwise) — same transaction, so a crash
          // rolls both back together: no dangling references, no orphaned
          // material.
          if (locked.credentialRef !== null) {
            const destroyed = await tx.vault.destroy(locked.credentialRef);
            if (!destroyed) {
              throw new PlatformError({
                code: "PROVIDER_ERROR",
                message: "credential material vanished during connection removal",
              });
            }
          }
          return { removed: true };
        },
      );
      return arbitration.outcome;
    },

    async listConnections(principal, applicationId) {
      const { scope } = await authorize(principal, applicationId, "applications:read");
      const rows = await store.listConnectionsByApplication(applicationId, scope.tenantId);
      // Defense in depth: a foreign-tenant row that could ever appear fails
      // closed instead of leaking. Public views never carry the vault
      // reference (stripped here — architecture-lock invariant 9).
      return rows
        .filter((row) => row.tenantId === scope.tenantId)
        .map((row) => toPublicConnection(row));
    },

    async getConnectionForDispatch(scope, connectionId) {
      const facts = await store.findDispatchFacts(connectionId);
      if (facts === null) {
        throw new PlatformError({
          code: "AUTHORIZATION_DENIED",
          message: "connection not found",
          details: { connectionId },
        });
      }
      if (facts.tenantId !== scope.tenantId || facts.applicationId !== scope.applicationId) {
        throw new PlatformError({
          code: "TENANT_SCOPE_VIOLATION",
          message: "connection belongs to a different application or tenant",
          details: { connectionId, scopeTenantId: scope.tenantId, targetTenantId: facts.tenantId },
        });
      }
      if (facts.status !== "active") {
        throw new PlatformError({
          code: "AUTHORIZATION_DENIED",
          message: "connection is disabled",
          details: { connectionId, status: facts.status },
        });
      }
      return facts;
    },
  };
}
