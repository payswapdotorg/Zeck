/**
 * Real-PG: DETERMINISTIC serialization-boundary proofs for owner retention
 * (architect PR #4 blocking-finding remediation, mechanism level).
 *
 * The service-level races in `owner-retention-concurrency.test.ts` prove the
 * invariant end-to-end but rely on scheduling to actually interleave. These
 * tests drive the interleaving DETERMINISTICALLY at the adapter level with
 * two open transactions and deferred gates, so the mechanism itself is
 * pinned down:
 *
 * 1. While T1 holds the application's membership-row locks, T2's
 *    `lockApplicationMemberships` CANNOT complete (the architect's
 *    "T2 counts 2 owners" step is unreachable before T1 commits).
 * 2. After T1 commits its demotion/removal, T2's locked read reflects the
 *    committed mutation (owner count 1) — so the retention decision taken
 *    from those rows MUST reject the second demotion/removal.
 * 3. Stale pre-lock role reads can never drive a deletion: a target that a
 *    pre-lock snapshot saw as `member` but a concurrent committed
 *    transaction promoted to `owner` IS an owner in the locked rows.
 */

import { expect, test } from "vitest";
import { createTxIdentityStore } from "../../../src/modules/auth/adapters/sql-identity-store";
import type { MembershipRecord } from "../../../src/modules/auth/public";
import type { DatabasePort } from "../../../src/platform/db/port";
import { uuidv7 } from "../../../src/shared/ids";
import { definePgSuite } from "./harness";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

interface Fixture {
  readonly appId: string;
  readonly membershipA: MembershipRecord;
  readonly membershipB: MembershipRecord;
}

/** Tenant + application with exactly two owners (A and B). */
async function twoOwnerFixture(db: DatabasePort, slug: string): Promise<Fixture> {
  const store = createTxIdentityStore(db);
  const alice = await store.provisionActor({ id: uuidv7(), displayName: "Alice" });
  const bob = await store.provisionActor({ id: uuidv7(), displayName: "Bob" });
  const tenantId = uuidv7();
  const appId = uuidv7();
  await db.execute({
    sql: `INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)`,
    parameters: [tenantId, slug, "Serialization"],
  });
  await db.execute({
    sql: `INSERT INTO applications.applications (id, tenant_id, slug, name) VALUES ($1, $2, $3, $4)`,
    parameters: [appId, tenantId, "core", "Core"],
  });
  const insertOwner = async (actorId: string) => {
    const id = uuidv7();
    await db.execute({
      sql: `INSERT INTO identity.memberships (id, actor_id, application_id, tenant_id, role)
            VALUES ($1, $2, $3, $4, 'owner')`,
      parameters: [id, actorId, appId, tenantId],
    });
  };
  await insertOwner(alice.id);
  await insertOwner(bob.id);
  const rows = await store.listMemberships({ applicationId: appId });
  const membershipA = rows.find((row) => row.actorId === alice.id);
  const membershipB = rows.find((row) => row.actorId === bob.id);
  if (membershipA === undefined || membershipB === undefined) {
    throw new Error("serialization fixture setup failed");
  }
  return { appId, membershipA, membershipB };
}

/**
 * Drive the deterministic interleaving: T1 locks + mutates while T2's lock
 * is pending; T1 commits; T2's locked read resolves afterwards.
 */
async function interleavedPair(
  db: DatabasePort,
  fixture: Fixture,
  t1Mutate: (store: ReturnType<typeof createTxIdentityStore>) => Promise<unknown>,
): Promise<{
  t1LockedRows: readonly MembershipRecord[];
  t2LockedRows: readonly MembershipRecord[];
}> {
  const t1Locked = deferred<readonly MembershipRecord[]>();
  const t1Proceed = deferred<void>();

  const t1 = db.transaction(async (tx) => {
    const s1 = createTxIdentityStore(tx);
    const rows = await s1.lockApplicationMemberships(fixture.appId);
    t1Locked.resolve(rows); // T1 now HOLDS the row locks
    await t1Proceed.promise; // keep the transaction (and locks) open
    await t1Mutate(s1);
    return undefined;
  });

  const t1LockedRows = await t1Locked.promise;

  // T2 starts strictly AFTER T1 holds the locks: its boundary call cannot
  // observe the pre-mutation owner set.
  const t2 = db.transaction(async (tx) => {
    const s2 = createTxIdentityStore(tx);
    return await s2.lockApplicationMemberships(fixture.appId);
  });

  // Prove T2 is BLOCKED while T1 holds the locks (no busy-poll: a single
  // generous window is enough because T1 is provably not committing — it is
  // awaiting our gate, which we have not released).
  const winner = await Promise.race([
    t2.then(
      () => "resolved",
      () => "rejected",
    ),
    sleep(750).then(() => "still-blocked"),
  ]);
  expect(winner).toBe("still-blocked");

  t1Proceed.resolve(); // T1 mutates + commits; T2 unblocks with fresh rows
  await t1;
  const t2LockedRows = await t2;
  return { t1LockedRows, t2LockedRows };
}

definePgSuite("owner-retention serialization boundary (deterministic interleavings)", (ctx) => {
  test("T2's boundary read cannot complete while T1 holds the locks; after T1's DEMOTION commits, T2 sees 1 owner", async () => {
    const port = ctx.port;
    const fixture = await twoOwnerFixture(port, `ser-demote-${uuidv7().slice(-8)}`);
    const { t1LockedRows, t2LockedRows } = await interleavedPair(port, fixture, (s1) =>
      s1.updateMembershipRole(fixture.membershipA.id, "admin"),
    );

    const ownersOf = (rows: readonly MembershipRecord[]) =>
      rows.filter((row) => row.role === "owner");

    expect(ownersOf(t1LockedRows)).toHaveLength(2); // T1 decided from {A,B}
    // T2's locked read reflects T1's committed demotion:
    expect(ownersOf(t2LockedRows)).toHaveLength(1);
    expect(t2LockedRows.find((row) => row.id === fixture.membershipA.id)?.role).toBe("admin");
    // => the retention decision derived from t2LockedRows (owners <= 1)
    //    MUST reject demoting B: zero owners is unreachable.

    const committed = await createTxIdentityStore(port).listMemberships({
      applicationId: fixture.appId,
    });
    expect(committed.filter((row) => row.role === "owner")).toHaveLength(1);
  });

  test("after T1's REMOVAL commits, T2's boundary read no longer contains the deleted owner", async () => {
    const port = ctx.port;
    const fixture = await twoOwnerFixture(port, `ser-remove-${uuidv7().slice(-8)}`);
    const { t2LockedRows } = await interleavedPair(port, fixture, (s1) =>
      s1.deleteMembership(fixture.membershipA.id),
    );

    expect(t2LockedRows.some((row) => row.id === fixture.membershipA.id)).toBe(false);
    expect(t2LockedRows.filter((row) => row.role === "owner")).toHaveLength(1);
    // => removing B from these rows MUST be rejected (owners <= 1).

    const committed = await createTxIdentityStore(port).listMemberships({
      applicationId: fixture.appId,
    });
    expect(committed).toHaveLength(1);
    expect(committed[0]?.role).toBe("owner");
  });

  test("stale pre-lock role reads never drive the decision: a concurrently PROMOTED member is an owner in the locked rows", async () => {
    const port = ctx.port;
    const fixture = await twoOwnerFixture(port, `ser-promote-${uuidv7().slice(-8)}`);
    const promoterLocked = deferred<void>();
    const promoterProceed = deferred<void>();
    const staleSnapshot = deferred<readonly MembershipRecord[]>();

    // Demote A first (sequential setup): owners = {B}, A is a member.
    const setup = createTxIdentityStore(port);
    await setup.updateMembershipRole(fixture.membershipA.id, "member");

    // T1 (promoter): locks the set, promotes A to owner, holds the tx open.
    const promoter = port.transaction(async (tx) => {
      const s1 = createTxIdentityStore(tx);
      const rows = await s1.lockApplicationMemberships(fixture.appId);
      await s1.updateMembershipRole(fixture.membershipA.id, "owner");
      promoterLocked.resolve();
      await promoterProceed.promise;
      return rows;
    });
    await promoterLocked.promise;

    // T2 (remover): reads its snapshot BEFORE the promotion commits —
    // it sees A as a member. The pre-lock snapshot is deliberately stale.
    const remover = port.transaction(async (tx) => {
      const s2 = createTxIdentityStore(tx);
      const stale = await s2.listMemberships({ applicationId: fixture.appId });
      staleSnapshot.resolve(stale);
      // ... after the promotion commits, take the serialization boundary:
      const locked = await s2.lockApplicationMemberships(fixture.appId);
      const current = locked.find((row) => row.id === fixture.membershipA.id);
      // The decision MUST be derived from `locked`, not `stale`:
      return { staleRole: current === undefined ? "gone" : current.role, locked };
    });

    const staleRows = await staleSnapshot.promise;
    expect(staleRows.find((row) => row.id === fixture.membershipA.id)?.role).toBe("member");

    promoterProceed.resolve(); // promotion commits NOW
    await promoter;
    const { staleRole, locked } = await remover;

    // The stale snapshot said member; the locked rows say OWNER — the
    // retention predicate evaluated over `locked` protects A:
    expect(staleRole).toBe("owner");
    expect(locked.filter((row) => row.role === "owner")).toHaveLength(2);

    const committed = await createTxIdentityStore(port).listMemberships({
      applicationId: fixture.appId,
    });
    expect(committed.filter((row) => row.role === "owner")).toHaveLength(2);
  });
});
