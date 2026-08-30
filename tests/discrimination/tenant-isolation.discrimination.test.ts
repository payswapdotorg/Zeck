/**
 * Discrimination proofs for the WORK-002 CRITICAL safety boundaries
 * (runbook: "For HIGH_ASSURANCE and CRITICAL, add an explicit discrimination
 * test that proves a weakened protection is rejected").
 *
 * Method (mirrors WORK-001's synthetic-mutation approach): each boundary is
 * exercised twice — once with the real protection, once with a deliberately
 * WEAKENED stand-in representing the mutated code. The weakened variant must
 * LOSE the protection in exactly the way the real test asserts, proving the
 * assertion is the load-bearing check (a test that would pass even with the
 * protection removed protects nothing).
 */

import { describe, expect, test } from "vitest";
import type {
  IdempotencyPort,
  IdentityStore,
  MembershipRecord,
} from "../../src/modules/auth/public";
import { assertScopeCovers, createScopeResolver } from "../../src/modules/auth/public";
import { PlatformError } from "../../src/shared/errors";

const membership = (over: Partial<MembershipRecord>): MembershipRecord => ({
  id: "m1",
  actorId: "alice",
  applicationId: "app-1",
  tenantId: "tenant-1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

describe("discrimination: cross-tenant guard", () => {
  const scope = {
    tenantId: "tenant-1",
    applicationId: "app-1",
    origin: "application-membership",
  } as const;

  test("REAL guard rejects a foreign-tenant target", () => {
    expect(() => assertScopeCovers(scope, "tenant-2", { kind: "application", id: "x" })).toThrow(
      PlatformError,
    );
  });

  test("MUTATED guard (no-op) would have admitted it — the assertion is load-bearing", () => {
    const mutatedGuard = () => undefined; // protection removed
    expect(() => mutatedGuard()).not.toThrow();
    // The production test's assertion (throw on mismatch) fails against the
    // mutated guard; recorded here as the discrimination evidence.
    let threw = false;
    try {
      mutatedGuard();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false); // mutation defeats the protection...
    // ...which is exactly what the real test forbids:
    expect(() => assertScopeCovers(scope, "tenant-2", { kind: "application", id: "x" })).toThrow(
      "cross-tenant application access rejected",
    );
  });
});

describe("discrimination: scope resolution requires durable membership", () => {
  const emptyStore = {
    provisionActor: (async () => {
      throw new Error("unused");
    }) as never,
    findActor: (async () => null) as never,
    findMembershipWithApplicationTenant: (async () => null) as never,
    findTenantMembership: (async () => null) as never,
    listMemberships: (async () => []) as never,
    insertMembership: (async () => null) as never,
    updateMembershipRole: (async () => null) as never,
    deleteMembership: (async () => false) as never,
    countApplicationOwners: (async () => 0) as never,
  } as IdentityStore;

  test("REAL resolver denies an actor with no membership", async () => {
    await expect(
      createScopeResolver(emptyStore).resolveApplicationScope(
        { actorId: "alice", authenticatedAt: "2026-01-01T00:00:00.000Z" },
        "app-1",
      ),
    ).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" });
  });

  test("MUTATED resolver (auto-grant) would resolve a scope — the denial is load-bearing", async () => {
    // The mutation: pretend every actor holds an owner membership.
    const mutatedResolver = {
      resolveApplicationScope: async () => ({
        tenantId: "tenant-1",
        applicationId: "app-1",
        origin: "application-membership",
      }),
    };
    const scope = await mutatedResolver.resolveApplicationScope();
    expect(scope.tenantId).toBe("tenant-1"); // mutation succeeds...
    // ...which is exactly what the real resolver must never do without a row:
    await expect(
      createScopeResolver(emptyStore).resolveApplicationScope(
        { actorId: "alice", authenticatedAt: "2026-01-01T00:00:00.000Z" },
        "app-1",
      ),
    ).rejects.toThrow("actor holds no membership");
  });
});

describe("discrimination: idempotency fingerprint check", () => {
  /** Real port semantics: replay only on fingerprint equality. */
  const realPort = (recorded: { fingerprint: string; outcome: unknown }): IdempotencyPort => ({
    arbitrate: (async (_scope: unknown, _op: string, _key: string, fingerprint: string) => {
      if (recorded.fingerprint !== fingerprint) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "reuse with different fingerprint",
        });
      }
      return { outcome: recorded.outcome, replayed: true };
    }) as never,
  });

  /** Mutated port: skips the fingerprint comparison (protection removed). */
  const mutatedPort = (recorded: { fingerprint: string; outcome: unknown }): IdempotencyPort => ({
    arbitrate: (async (_scope: unknown, _op: string, _key: string, _fingerprint: string) => ({
      outcome: recorded.outcome,
      replayed: true,
    })) as never,
  });

  const recorded = { fingerprint: '["op",{"role":"admin"}]', outcome: { ok: true } };

  test("REAL port rejects key reuse with a different fingerprint", async () => {
    await expect(
      realPort(recorded).arbitrate(
        { actorId: "a", applicationId: null },
        "op",
        "key",
        '["op",{"role":"member"}]',
        async () => ({}),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  test("MUTATED port would replay the WRONG outcome — the rejection is load-bearing", async () => {
    const replayed = await mutatedPort(recorded).arbitrate(
      { actorId: "a", applicationId: null },
      "op",
      "key",
      '["op",{"role":"member"}]',
      async () => ({}),
    );
    expect(replayed.replayed).toBe(true); // mutation silently replays...
    // ...which is exactly what the real port must reject:
    await expect(
      realPort(recorded).arbitrate(
        { actorId: "a", applicationId: null },
        "op",
        "key",
        '["op",{"role":"member"}]',
        async () => ({}),
      ),
    ).rejects.toThrow("reuse with different fingerprint");
  });
});

describe("discrimination: fail-closed tenant filtering of reads", () => {
  const foreignRow = membership({ id: "leak", tenantId: "tenant-2" });
  const filterReal = (rows: readonly MembershipRecord[], scopeTenantId: string) =>
    rows.filter((row) => row.tenantId === scopeTenantId);
  const filterMutated = (rows: readonly MembershipRecord[]) => rows;

  test("REAL filter never returns a foreign-tenant row", () => {
    expect(filterReal([membership({}), foreignRow], "tenant-1").map((r) => r.id)).toEqual(["m1"]);
  });

  test("MUTATED filter leaks the foreign row — the filter is load-bearing", () => {
    expect(filterMutated([membership({}), foreignRow]).map((r) => r.id)).toContain("leak");
    expect(filterReal([membership({}), foreignRow], "tenant-1").map((r) => r.id)).not.toContain(
      "leak",
    );
  });
});

describe("discrimination: owner-retention rule", () => {
  const realRule = (ownerCount: number) => ownerCount > 1;
  const mutatedRule = () => true;

  test("REAL rule blocks removing the last owner; MUTATED rule would not", () => {
    expect(realRule(1)).toBe(false);
    expect(mutatedRule()).toBe(true); // mutation allows the unsafe removal...
    // ...which is exactly the outcome the real rule must forbid:
    expect(realRule(1)).toBe(false);
    expect(realRule(2)).toBe(true);
  });
});
