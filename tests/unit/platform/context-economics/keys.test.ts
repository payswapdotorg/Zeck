/**
 * Tenant-safe cache key derivation tests (WORK-052 AC 5 /
 * TENANT-ISOLATION): tenant identity is a STRUCTURAL key component —
 * the same semantics under different tenants derive DIFFERENT keys;
 * keys without tenant identity are unrepresentable; foreign keys
 * are typed rejections (never filtered accidents).
 */

import { describe, expect, test } from "vitest";
import { ContextEconomicsError } from "../../../../src/platform/context-economics/catalog";
import {
  deriveTenantScopedCacheKey,
  sameTenantCacheKey,
  scopedLookupKey,
  validateTenantCacheScope,
  validateTenantScopedCacheKey,
} from "../../../../src/platform/context-economics/keys";
import { nodeDigest, OTHER_TENANT_SCOPE, SCOPE } from "./helpers";

const SEMANTICS = { work: "summarize", input: "artifact-9" };

describe("tenant-safe cache keys", () => {
  test("derives a content-addressed key carrying the structural scope", () => {
    const key = deriveTenantScopedCacheKey(SCOPE, "memo-entry", SEMANTICS, nodeDigest);
    expect(key.tenantId).toBe(SCOPE.tenantId);
    expect(key.applicationId).toBe(SCOPE.applicationId);
    expect(key.keyClass).toBe("memo-entry");
    expect(key.key).toMatch(/^[0-9a-f]{64}$/);
    expect(key.semanticsDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("STRUCTURAL tenant safety: identical semantics, different tenants → different keys", () => {
    const mine = deriveTenantScopedCacheKey(SCOPE, "memo-entry", SEMANTICS, nodeDigest);
    const theirs = deriveTenantScopedCacheKey(
      OTHER_TENANT_SCOPE,
      "memo-entry",
      SEMANTICS,
      nodeDigest,
    );
    expect(mine.key).not.toBe(theirs.key);
    expect(scopedLookupKey(mine)).not.toBe(scopedLookupKey(theirs));
    // The tenant-free semantics digests are equal (the content is the
    // same) — but the KEYS differ because the tenant is inside the
    // digested material: no filter could reconcile them.
    expect(mine.semanticsDigest).toBe(theirs.semanticsDigest);
    expect(sameTenantCacheKey(mine, theirs)).toBe(false);
  });

  test("different key classes over identical semantics never collide", () => {
    const memo = deriveTenantScopedCacheKey(SCOPE, "memo-entry", SEMANTICS, nodeDigest);
    const group = deriveTenantScopedCacheKey(SCOPE, "coalesce-group", SEMANTICS, nodeDigest);
    expect(memo.key).not.toBe(group.key);
  });

  test("the lookup handle structurally prefixes the tenant identity", () => {
    const key = deriveTenantScopedCacheKey(SCOPE, "prefix-cache", SEMANTICS, nodeDigest);
    expect(scopedLookupKey(key).startsWith(`${SCOPE.tenantId}:`)).toBe(true);
    // The tenant prefix is structural: a same-scope application
    // change also changes the handle.
    const other = deriveTenantScopedCacheKey(
      { tenantId: SCOPE.tenantId, applicationId: OTHER_TENANT_SCOPE.applicationId },
      "prefix-cache",
      SEMANTICS,
      nodeDigest,
    );
    expect(scopedLookupKey(key)).not.toBe(scopedLookupKey(other));
  });

  test("a key WITHOUT tenant identity is unrepresentable (validation fails closed)", () => {
    expect(() =>
      validateTenantCacheScope({ tenantId: "not-a-uuid", applicationId: SCOPE.applicationId }),
    ).toThrow(ContextEconomicsError);
    expect(() =>
      deriveTenantScopedCacheKey(
        { tenantId: "", applicationId: SCOPE.applicationId },
        "memo-entry",
        SEMANTICS,
        nodeDigest,
      ),
    ).toThrow(/tenantId must be a UUID/);
  });

  test("a FOREIGN key (tenant-claim mismatch) is a typed identity rejection", () => {
    const real = deriveTenantScopedCacheKey(SCOPE, "memo-entry", SEMANTICS, nodeDigest);
    // A mutation: claim the other tenant's scope over the same key.
    const forged = { ...real, tenantId: OTHER_TENANT_SCOPE.tenantId };
    expect(() => validateTenantScopedCacheKey(forged, nodeDigest)).toThrow(ContextEconomicsError);
    expect(() => validateTenantScopedCacheKey(forged, nodeDigest)).toThrow(
      /does not cover its claimed tenant identity/,
    );
  });

  test("a valid key round-trips through validation unchanged", () => {
    const key = deriveTenantScopedCacheKey(SCOPE, "artifact-result", SEMANTICS, nodeDigest);
    const roundTripped = validateTenantScopedCacheKey(key, nodeDigest);
    expect(roundTripped).toEqual(key);
  });

  test("deterministic derivation: same inputs → the identical key", () => {
    const first = deriveTenantScopedCacheKey(SCOPE, "memo-entry", SEMANTICS, nodeDigest);
    const second = deriveTenantScopedCacheKey(SCOPE, "memo-entry", SEMANTICS, nodeDigest);
    expect(first).toEqual(second);
  });
});
