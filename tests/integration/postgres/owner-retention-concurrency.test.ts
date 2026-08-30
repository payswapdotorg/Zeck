/**
 * Real-PG: CONCURRENT owner-retention safety (architect PR #4 blocking
 * finding remediation).
 *
 * The architect's adversarial sequence, exercised for real against two
 * concurrent PostgreSQL transactions:
 *
 *   Application has owners A + B
 *   T1: count owners -> 2          T2: count owners -> 2
 *   T1: demote/remove A -> commit  T2: demote/remove B -> commit
 *   Final state -> 0 owners        <- must be UNREACHABLE
 *
 * Each round starts from exactly two owners and fires the two mutations
 * concurrently (independent pool clients -> genuinely concurrent
 * transactions; the harness pool allows 4). Required committed result per
 * round and in aggregate:
 *
 *   - exactly ONE mutation commits;
 *   - the other is rejected with AUTHORIZATION_DENIED (owner retention);
 *   - the durable final state retains >= 1 owner — no interleaving may
 *     commit a zero-owner application.
 *
 * These tests use ONLY the public membership-service API (no new port
 * surface), which lets them run unchanged against the pre-remediation
 * implementation — the recorded failing run (zero owners observed) is the
 * discrimination proof that they actually detect the race.
 */

import { expect, test } from "vitest";
import { createSqlApplicationsModule } from "../../../src/modules/applications/adapters/sql-application-store";
import { createOwnershipServices } from "../../../src/modules/applications/public";
import { createSqlAuthModule } from "../../../src/modules/auth/adapters/sql-identity-store";
import { createMembershipService, createScopeResolver } from "../../../src/modules/auth/public";
import type { DatabasePort } from "../../../src/platform/db/port";
import { PlatformError } from "../../../src/shared/errors";
import { uuidv7 } from "../../../src/shared/ids";
import { definePgSuite } from "./harness";

function principalOf(actorId: string) {
  return { actorId, authenticatedAt: new Date().toISOString() };
}

function fullWiring(db: DatabasePort) {
  const auth = createSqlAuthModule(db, uuidv7);
  const applications = createSqlApplicationsModule(db, uuidv7);
  const resolver = createScopeResolver(auth.store);
  const membershipsFacts = {
    findApplicationMembership: async (actorId: string, applicationId: string) =>
      (await auth.store.findMembershipWithApplicationTenant(actorId, applicationId))?.membership ??
      null,
  };
  return {
    auth,
    ownership: createOwnershipServices(
      applications.store,
      applications.idempotency,
      resolver,
      membershipsFacts,
      uuidv7,
    ),
    memberships: createMembershipService(auth.store, auth.idempotency, resolver, uuidv7),
  };
}

interface TwoOwnerApp {
  readonly appId: string;
  readonly ownerA: string;
  readonly ownerB: string;
  readonly membershipA: string;
  readonly membershipB: string;
}

/** Create a tenant + application whose ONLY memberships are owners A and B. */
async function appWithExactlyTwoOwners(
  wiring: ReturnType<typeof fullWiring>,
  round: number,
): Promise<TwoOwnerApp> {
  const { auth, ownership, memberships } = wiring;
  const alice = await auth.store.provisionActor({ id: uuidv7(), displayName: `Alice r${round}` });
  const bob = await auth.store.provisionActor({ id: uuidv7(), displayName: `Bob r${round}` });
  const tenant = await ownership.createTenant(
    {
      principal: principalOf(alice.id),
      slug: `conc-${round}-${uuidv7().slice(-8)}`,
      name: `Concurrency ${round}`,
    },
    uuidv7(),
  );
  const app = await ownership.createApplication(
    { principal: principalOf(alice.id), tenantId: tenant.id, slug: "core", name: "Core" },
    uuidv7(),
  );
  // Promote bob to a SECOND owner: the application now has exactly two.
  await memberships.addMember(
    {
      principal: principalOf(alice.id),
      applicationId: app.id,
      actorId: bob.id,
      role: "owner",
    },
    uuidv7(),
  );
  const rows = await memberships.listMembers(principalOf(alice.id), app.id);
  const ownerRows = rows.filter((row) => row.role === "owner");
  if (ownerRows.length !== 2) {
    throw new Error(`setup failed: expected exactly 2 owners, found ${ownerRows.length}`);
  }
  const membershipOf = (actorId: string) => {
    const row = ownerRows.find((candidate) => candidate.actorId === actorId);
    if (row === undefined) {
      throw new Error(`setup failed: no owner membership for ${actorId}`);
    }
    return row.id;
  };
  return {
    appId: app.id,
    ownerA: alice.id,
    ownerB: bob.id,
    membershipA: membershipOf(alice.id),
    membershipB: membershipOf(bob.id),
  };
}

interface ConcurrentOutcome {
  /** Index of the single fulfilled promise, or -1 when neither/both fulfilled. */
  fulfilled: number;
  rejectionCodes: string[];
}

function settlePair(operations: readonly Promise<unknown>[]): Promise<ConcurrentOutcome> {
  return Promise.all(
    operations.map((op) =>
      op.then(
        () => 0,
        (error: unknown) => error,
      ),
    ),
  ).then((settled) => {
    let fulfilled = -1;
    const rejectionCodes: string[] = [];
    settled.forEach((result, index) => {
      if (result === 0) {
        if (fulfilled !== -1) {
          fulfilled = -2; // more than one fulfilled — invalid for this pair
        } else {
          fulfilled = index;
        }
      } else {
        rejectionCodes.push(
          result instanceof PlatformError ? result.code : `unexpected:${String(result)}`,
        );
      }
    });
    return { fulfilled, rejectionCodes };
  });
}

async function committedOwnerCount(db: DatabasePort, applicationId: string): Promise<number> {
  const auth = createSqlAuthModule(db, uuidv7);
  const rows = await auth.store.listMemberships({ applicationId });
  return rows.filter((row) => row.role === "owner").length;
}

const ROUNDS = 25;

definePgSuite("concurrent owner retention on real PostgreSQL", (ctx) => {
  test("two owners concurrently DEMOTED: no interleaving commits a zero-owner application", async () => {
    const { port } = ctx;
    for (let round = 0; round < ROUNDS; round += 1) {
      const wiring = fullWiring(port);
      const setup = await appWithExactlyTwoOwners(wiring, round);
      const { memberships } = wiring;

      // Two concurrent demotions of the two DIFFERENT owners (distinct
      // idempotency keys — different logical operations). Both run through
      // the full public service path: authorization, idempotency
      // arbitration, retention decision, mutation.
      const outcome = await settlePair([
        memberships.addMember(
          {
            principal: principalOf(setup.ownerA),
            applicationId: setup.appId,
            actorId: setup.ownerA,
            role: "admin",
          },
          `demote-A-${round}-${uuidv7()}`,
        ),
        memberships.addMember(
          {
            principal: principalOf(setup.ownerA),
            applicationId: setup.appId,
            actorId: setup.ownerB,
            role: "admin",
          },
          `demote-B-${round}-${uuidv7()}`,
        ),
      ]);

      const owners = await committedOwnerCount(port, setup.appId);
      expect(
        owners,
        `round ${round}: committed application must retain >= 1 owner (got ${owners}; outcome ${JSON.stringify(outcome)})`,
      ).toBeGreaterThanOrEqual(1);
      // Exactly one demotion commits; the loser must be the retention
      // rejection — never a provider failure or an unexplained code.
      expect(
        outcome.fulfilled,
        `round ${round}: exactly one demotion commits`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        outcome.rejectionCodes,
        `round ${round}: the loser rejects with owner retention`,
      ).toEqual(["AUTHORIZATION_DENIED"]);
      if (outcome.fulfilled === -2) {
        throw new Error(`round ${round}: both demotions committed — retention boundary absent`);
      }
    }
  });

  test("two owners concurrently REMOVED: no interleaving commits a zero-owner application", async () => {
    const { port } = ctx;
    for (let round = 0; round < ROUNDS; round += 1) {
      const wiring = fullWiring(port);
      const setup = await appWithExactlyTwoOwners(wiring, round);
      const { memberships } = wiring;

      const outcome = await settlePair([
        memberships.removeMember(
          {
            principal: principalOf(setup.ownerA),
            applicationId: setup.appId,
            membershipId: setup.membershipA,
          },
          `remove-A-${round}-${uuidv7()}`,
        ),
        memberships.removeMember(
          {
            principal: principalOf(setup.ownerA),
            applicationId: setup.appId,
            membershipId: setup.membershipB,
          },
          `remove-B-${round}-${uuidv7()}`,
        ),
      ]);

      const owners = await committedOwnerCount(port, setup.appId);
      expect(
        owners,
        `round ${round}: committed application must retain >= 1 owner (got ${owners}; outcome ${JSON.stringify(outcome)})`,
      ).toBeGreaterThanOrEqual(1);
      expect(
        outcome.fulfilled,
        `round ${round}: exactly one removal commits`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        outcome.rejectionCodes,
        `round ${round}: the loser rejects with owner retention`,
      ).toEqual(["AUTHORIZATION_DENIED"]);
      if (outcome.fulfilled === -2) {
        throw new Error(`round ${round}: both removals committed — retention boundary absent`);
      }
    }
  });

  test("mixed adversarial pair (demote A concurrently with remove B): final state retains an owner", async () => {
    const { port } = ctx;
    for (let round = 0; round < ROUNDS; round += 1) {
      const wiring = fullWiring(port);
      const setup = await appWithExactlyTwoOwners(wiring, round);
      const { memberships } = wiring;

      const outcome = await settlePair([
        memberships.addMember(
          {
            principal: principalOf(setup.ownerA),
            applicationId: setup.appId,
            actorId: setup.ownerA,
            role: "member",
          },
          `mix-demote-${round}-${uuidv7()}`,
        ),
        memberships.removeMember(
          {
            principal: principalOf(setup.ownerA),
            applicationId: setup.appId,
            membershipId: setup.membershipB,
          },
          `mix-remove-${round}-${uuidv7()}`,
        ),
      ]);

      const owners = await committedOwnerCount(port, setup.appId);
      expect(
        owners,
        `round ${round}: mixed pair must retain >= 1 owner (got ${owners}; outcome ${JSON.stringify(outcome)})`,
      ).toBeGreaterThanOrEqual(1);
      expect(
        outcome.fulfilled,
        `round ${round}: exactly one of the mixed pair commits`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        outcome.rejectionCodes,
        `round ${round}: the loser rejects with owner retention`,
      ).toEqual(["AUTHORIZATION_DENIED"]);
    }
  });

  test("retained behaviors under the concurrency boundary: last-owner rejection and same-role idempotent convergence", async () => {
    const { port } = ctx;
    const wiring = fullWiring(port);
    const setup = await appWithExactlyTwoOwners(wiring, 99);
    const { memberships } = wiring;

    // Demote B first (two owners -> one owner commits).
    const demoted = await memberships.addMember(
      {
        principal: principalOf(setup.ownerA),
        applicationId: setup.appId,
        actorId: setup.ownerB,
        role: "admin",
      },
      `retain-demote-${uuidv7()}`,
    );
    expect(demoted.membership.role).toBe("admin");

    // NOW the surviving sole owner cannot be demoted...
    const rejection = await memberships
      .addMember(
        {
          principal: principalOf(setup.ownerA),
          applicationId: setup.appId,
          actorId: setup.ownerA,
          role: "admin",
        },
        `retain-demote-last-${uuidv7()}`,
      )
      .then(
        () => {
          throw new Error("expected sole-owner demotion to be rejected");
        },
        (error: unknown) => error as PlatformError,
      );
    expect(rejection.code).toBe("AUTHORIZATION_DENIED");

    // ...nor removed.
    const removalRejection = await memberships
      .removeMember(
        {
          principal: principalOf(setup.ownerA),
          applicationId: setup.appId,
          membershipId: setup.membershipA,
        },
        `retain-remove-last-${uuidv7()}`,
      )
      .then(
        () => {
          throw new Error("expected sole-owner removal to be rejected");
        },
        (error: unknown) => error as PlatformError,
      );
    expect(removalRejection.code).toBe("AUTHORIZATION_DENIED");

    // Same-role re-invocation converges idempotently (no error, same row).
    const key = `idem-${uuidv7()}`;
    const first = await memberships.addMember(
      {
        principal: principalOf(setup.ownerA),
        applicationId: setup.appId,
        actorId: setup.ownerB,
        role: "admin",
      },
      key,
    );
    const replay = await memberships.addMember(
      {
        principal: principalOf(setup.ownerA),
        applicationId: setup.appId,
        actorId: setup.ownerB,
        role: "admin",
      },
      key,
    );
    expect(replay.membership.id).toBe(first.membership.id);

    const owners = await committedOwnerCount(port, setup.appId);
    expect(owners).toBe(1);
  });
});
