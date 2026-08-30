/**
 * Membership mutations (auth module application).
 *
 * Acceptance criterion 5: every mutation is idempotent via the ledger port —
 * retries replay the durable outcome, key reuse with a different payload
 * fails `IDEMPOTENCY_KEY_REUSED`, and concurrent identical requests converge.
 *
 * Authorization: `memberships:write` for add/remove; ownership transfer is
 * `ownership:transfer`; the last owner of an application can never be removed
 * or demoted (owner-retention).
 *
 * Concurrency (PR #4 architect finding): the owner-retention decision and
 * the mutation are serialized per application INSIDE the arbitration
 * transaction via `lockApplicationMemberships` — a row-lock boundary over
 * the application's full membership set. The retention predicate (target
 * role + owner count) is always RE-DERIVED from the locked rows, never from
 * a pre-lock read: every owner-count-reducing mutation therefore totally
 * orders, and the loser of a race observes the winner's committed mutation
 * and rejects. No interleaving can commit a zero-owner application.
 */

import { PlatformError } from "../../../shared/errors";
import type { Principal } from "../domain/actor";
import { type ApplicationRole, ASSIGNABLE_ROLES } from "../domain/roles";
import type { MembershipRecord, TenantScope } from "../domain/scope";
import { canonicalFingerprint, type IdempotencyPort } from "../ports/idempotency";
import type { IdentityStore } from "../ports/identity-store";
import type { ScopeResolver } from "./scope-resolver";
import { assertScopeCovers } from "./scope-resolver";

export interface AddMembershipCommand {
  readonly principal: Principal;
  readonly applicationId: string;
  readonly actorId: string;
  readonly role: ApplicationRole;
}

export interface RemoveMembershipCommand {
  readonly principal: Principal;
  readonly applicationId: string;
  readonly membershipId: string;
}

export interface MembershipMutationOutcome {
  readonly membership: MembershipRecord;
}

export interface MembershipService {
  addMember(
    command: AddMembershipCommand,
    idempotencyKey: string,
  ): Promise<MembershipMutationOutcome>;
  removeMember(
    command: RemoveMembershipCommand,
    idempotencyKey: string,
  ): Promise<{ removed: boolean }>;
  listMembers(principal: Principal, applicationId: string): Promise<readonly MembershipRecord[]>;
}

export function createMembershipService(
  store: IdentityStore,
  idempotency: IdempotencyPort,
  resolver: ScopeResolver,
  generateId: () => string,
): MembershipService {
  const membershipOfScope = async (
    principal: Principal,
    scope: TenantScope,
  ): Promise<MembershipRecord> => {
    if (scope.applicationId === null) {
      throw new PlatformError({
        code: "AUTHORIZATION_DENIED",
        message: "membership operations are application-scoped",
      });
    }
    const row = await store.findMembershipWithApplicationTenant(
      principal.actorId,
      scope.applicationId,
    );
    if (row === null) {
      throw new PlatformError({
        code: "AUTHORIZATION_DENIED",
        message: "actor holds no membership for this application",
      });
    }
    // Scope 4 guard: the membership's own tenant must be the scope tenant.
    assertScopeCovers(scope, row.membership.tenantId, {
      kind: "membership-owner",
      id: row.membership.id,
    });
    return row.membership;
  };

  return {
    async addMember(command, idempotencyKey) {
      if (!ASSIGNABLE_ROLES.includes(command.role)) {
        throw new PlatformError({
          code: "AUTHORIZATION_DENIED",
          message: `role ${command.role} is not assignable`,
        });
      }
      const scope = await resolver.resolveApplicationScope(
        command.principal,
        command.applicationId,
      );
      const callerMembership = await membershipOfScope(command.principal, scope);
      resolver.requirePermission(scope, callerMembership, "memberships:write");

      const fingerprint = canonicalFingerprint([
        "identity.addMember",
        { actorId: command.actorId, applicationId: command.applicationId, role: command.role },
      ]);

      const arbitration = await idempotency.arbitrate(
        { actorId: command.principal.actorId, applicationId: scope.applicationId },
        "identity.addMember",
        idempotencyKey,
        fingerprint,
        async (txStore) => {
          if ((await txStore.findActor(command.actorId)) === null) {
            throw new PlatformError({
              code: "AUTHORIZATION_DENIED",
              message: "target actor does not exist",
            });
          }
          const stored = await txStore.insertMembership({
            id: generateId(),
            actorId: command.actorId,
            applicationId: scope.applicationId,
            tenantId: scope.tenantId,
            role: command.role,
          });
          if (stored === null) {
            // Same (actor, application) already durably present: same role
            // converges (retry); a DIFFERENT role is a role CHANGE — a
            // legitimate mutation, applied explicitly (never silently
            // converged away).
            //
            // Serialization boundary FIRST: lock the application's full
            // membership set and derive every fact of the decision from
            // these locked rows. A concurrent owner demotion/removal or a
            // concurrent promotion of THIS row blocks until the other
            // transaction commits; the locked read then reflects it.
            const members = await txStore.lockApplicationMemberships(command.applicationId);
            const existing = members.find((row) => row.actorId === command.actorId);
            if (existing === undefined) {
              throw new PlatformError({
                code: "PROVIDER_ERROR",
                message: "membership vanished during arbitration",
              });
            }
            if (existing.role === command.role) {
              return { membership: existing };
            }
            // Owner-retention applies to demotions too: demoting the last
            // owner away from the owner role is forbidden. The count comes
            // from the locked rows — never a plain pre-mutation query.
            if (existing.role === "owner" && command.role !== "owner") {
              const owners = members.filter((row) => row.role === "owner");
              if (owners.length <= 1) {
                throw new PlatformError({
                  code: "AUTHORIZATION_DENIED",
                  message: "an application must retain at least one owner",
                });
              }
            }
            const updated = await txStore.updateMembershipRole(existing.id, command.role);
            if (updated === null) {
              throw new PlatformError({
                code: "PROVIDER_ERROR",
                message: "membership vanished during role update",
              });
            }
            return { membership: updated };
          }
          // A NEW membership insert is additive: it cannot reduce the owner
          // count, so it needs no retention arbitration (inserts do not
          // participate in the lock domain and cannot starve it).
          return { membership: stored };
        },
      );
      return arbitration.outcome;
    },

    async removeMember(command, idempotencyKey) {
      const scope = await resolver.resolveApplicationScope(
        command.principal,
        command.applicationId,
      );
      const callerMembership = await membershipOfScope(command.principal, scope);
      resolver.requirePermission(scope, callerMembership, "memberships:write");

      const fingerprint = canonicalFingerprint([
        "identity.removeMember",
        { membershipId: command.membershipId, applicationId: command.applicationId },
      ]);

      return idempotency
        .arbitrate(
          { actorId: command.principal.actorId, applicationId: scope.applicationId },
          "identity.removeMember",
          idempotencyKey,
          fingerprint,
          async (txStore) => {
            // Look up by id WITHOUT application filtering first: a foreign
            // membership id must be REJECTED explicitly (cross-tenant), never
            // silently no-op'ed as "not found".
            const members = await txStore.listMemberships({});
            const target = members.find((row) => row.id === command.membershipId);
            if (target === undefined) {
              return { removed: false };
            }
            // Cross-tenant guard: the membership must belong to the scope's
            // application/tenant — reject before any downstream execution.
            // (tenant_id / application_id are immutable per row, so this
            // pre-lock read is safe for the guard; ROLE is not — see below.)
            assertScopeCovers(scope, target.tenantId, { kind: "membership", id: target.id });
            if (target.applicationId !== command.applicationId) {
              throw new PlatformError({
                code: "TENANT_SCOPE_VIOLATION",
                message: "membership belongs to a different application",
                details: { membershipId: target.id },
              });
            }
            // Serialization boundary BEFORE the retention decision: lock the
            // application's full membership set and re-derive BOTH facts of
            // the decision (the target's CURRENT role — a concurrent
            // promotion may have changed it after the read above — and the
            // owner count) from the locked rows. A concurrent demotion,
            // removal, or promotion of the target blocks until this
            // transaction's predecessor commits, and this read reflects it.
            const locked = await txStore.lockApplicationMemberships(command.applicationId);
            const current = locked.find((row) => row.id === command.membershipId);
            if (current === undefined) {
              // Deleted by a concurrent committed transaction: converge to
              // the durable outcome instead of failing.
              return { removed: false };
            }
            if (
              current.role === "owner" &&
              locked.filter((row) => row.role === "owner").length <= 1
            ) {
              throw new PlatformError({
                code: "AUTHORIZATION_DENIED",
                message: "an application must retain at least one owner",
              });
            }
            return { removed: await txStore.deleteMembership(command.membershipId) };
          },
        )
        .then((arbitration) => arbitration.outcome);
    },

    async listMembers(principal, applicationId) {
      const scope = await resolver.resolveApplicationScope(principal, applicationId);
      const callerMembership = await membershipOfScope(principal, scope);
      resolver.requirePermission(scope, callerMembership, "memberships:read");
      const rows = await store.listMemberships({ applicationId: scope.applicationId ?? undefined });
      // Reads are tenant-filtered by the guard: any foreign-tenant row that
      // could ever appear here fails closed instead of leaking.
      return rows.filter((row) => row.tenantId === scope.tenantId);
    },
  };
}
