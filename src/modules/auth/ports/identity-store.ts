/**
 * Identity store port (auth module outbound).
 *
 * Implemented by adapters (SQL over the platform `DatabasePort`). The
 * application layer depends on this interface only — never on platform
 * types (`IMPLEMENTATION.md` §3).
 */

import type { Actor, Principal, ProvisionActorInput } from "../domain/actor";
import type { ApplicationRole } from "../domain/roles";
import type { MembershipRecord } from "../domain/scope";

/** The tenant + membership facts the scope resolver needs, read atomically. */
export interface MembershipScopeRow {
  readonly membership: MembershipRecord;
  /** Tenant of the membership's application, from the applications ownership row. */
  readonly applicationTenantId: string | null;
}

export interface ListMembershipsFilter {
  readonly applicationId?: string;
  readonly tenantId?: string;
}

export interface InsertMembershipInput {
  readonly actorId: string;
  readonly applicationId: string | null;
  readonly tenantId: string;
  readonly role: ApplicationRole;
}

export interface IdentityStore {
  /** Provision (or return the existing) actor for an external subject. */
  provisionActor(input: ProvisionActorInput & { id: string }): Promise<Actor>;

  findActor(id: string): Promise<Actor | null>;

  /**
   * Membership of `actorId` for `applicationId` together with the
   * application's owning tenant (read atomically from durable state).
   */
  findMembershipWithApplicationTenant(
    actorId: string,
    applicationId: string,
  ): Promise<MembershipScopeRow | null>;

  /** Tenant-scope membership of `actorId` for `tenantId` (application_id IS NULL). */
  findTenantMembership(actorId: string, tenantId: string): Promise<MembershipRecord | null>;

  listMemberships(filter: ListMembershipsFilter): Promise<readonly MembershipRecord[]>;

  /**
   * Insert a membership; rejects a duplicate (actor, application) pair.
   * Returns the stored record or null when the pair already exists.
   */
  insertMembership(input: InsertMembershipInput & { id: string }): Promise<MembershipRecord | null>;

  /**
   * Change an existing membership's role. Returns the updated record, or
   * null when the membership does not exist. A role change is a legitimate
   * mutation (e.g. promoting a member to owner) — never silently converged.
   */
  updateMembershipRole(
    membershipId: string,
    role: ApplicationRole,
  ): Promise<MembershipRecord | null>;

  /** Delete a membership by id. Returns true when a row was deleted. */
  deleteMembership(membershipId: string): Promise<boolean>;

  /**
   * Owner-retention serialization boundary (PR #4 architect finding).
   *
   * Locks EVERY membership row of the application for the remainder of the
   * enclosing transaction and returns the rows as committed at lock
   * acquisition. Any concurrent role-change or deletion for the same
   * application blocks here until this transaction commits/aborts — so the
   * retention decision the caller derives from the returned rows (target
   * role + owner count) cannot race another owner-affecting mutation.
   *
   * The lock set is the FULL membership set (not only current owner rows):
   * a concurrent promotion (member -> owner) updates a row that is not yet
   * an owner row, so owner-set-only locking would leave a window where a
   * stale pre-lock role read drives a deletion. Locking all rows of the
   * application closes every mutating interleaving; inserts (new
   * memberships) are additive and cannot reduce the owner count.
   *
   * MUST be called inside the same transaction as the subsequent mutation
   * (the idempotency arbiter's transaction-bound store provides it). SQL
   * adapters implement this with `SELECT ... FOR UPDATE` in deterministic
   * id order (deadlock-free against other full-set lockers and single-row
   * updates); in-memory fakes may treat it as a plain read (they are
   * sequential by construction).
   */
  lockApplicationMemberships(applicationId: string): Promise<readonly MembershipRecord[]>;
}

/**
 * Scope resolution is the auth application service's own job; the port only
 * carries durable facts. `Principal` is re-exported for adapter implementors.
 */
export type { Principal };
