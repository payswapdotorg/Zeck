/**
 * Tenant-safe cache key derivation (platform context-economics
 * plane; WORK-052 / E1.1).
 *
 * Architecture invariant 2: "Cache keys are tenant-safe by
 * construction (tenant identity is a structural key component, not a
 * filter)." This module makes cross-tenant reuse STRUCTURALLY
 * UNREPRESENTABLE:
 *
 *  - every derivation REQUIRES a validated tenant scope (UUIDs);
 *    a key without tenant identity cannot be constructed (the
 *    derivation rejects it typed — `cache-key-tenant`);
 *  - the tenant identity is INSIDE the digested canonical content of
 *    the key — two tenants deriving over IDENTICAL semantic content
 *    produce DIFFERENT keys (a collision would require a sha256
 *    collision over content that differs in the tenant field);
 *  - the returned `TenantScopedCacheKey` carries the tenant scope as
 *    part of its value; every lookup goes through
 *    `scopedLookupKey` which structurally prefixes the tenant — a
 *    bare key string is never a lookup handle at the type level;
 *  - cache facts are validated against the scope on every plan
 *    (`validateCacheFact`): a fact whose key was derived under a
 *    different tenant is a typed identity rejection, never a
 *    filtered-out accident.
 *
 * Deterministic and content-addressed: the same (scope, class,
 * semantics, digest) always derive the identical key.
 */

import { canonicalJson } from "../execution-ir/canonical";
import type { IrDigestPort } from "../execution-ir/ir";
import { type CacheKeyClass, reject } from "./catalog";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// The tenant scope (structural, validated)
// ---------------------------------------------------------------------------

/**
 * The tenant identity scope every cache key derivation requires.
 * `tenantId` is the STRUCTURAL isolation component; `applicationId`
 * additionally separates applications inside a tenant.
 */
export interface TenantCacheScope {
  readonly tenantId: string;
  readonly applicationId: string;
}

/** Total validation of a tenant cache scope. */
export function validateTenantCacheScope(value: unknown): TenantCacheScope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("cache-key-shape", "tenant cache scope must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.tenantId !== "string" || !UUID_PATTERN.test(record.tenantId)) {
    reject("cache-key-tenant", "tenant cache scope tenantId must be a UUID", {
      got: String(record.tenantId),
    });
  }
  if (typeof record.applicationId !== "string" || !UUID_PATTERN.test(record.applicationId)) {
    reject("cache-key-shape", "tenant cache scope applicationId must be a UUID", {
      got: String(record.applicationId),
    });
  }
  return { tenantId: record.tenantId, applicationId: record.applicationId };
}

// ---------------------------------------------------------------------------
// The tenant-scoped key
// ---------------------------------------------------------------------------

/**
 * A tenant-scoped cache key. The `key` digest COVERS the tenant
 * identity (it is a component of the digested content), and the
 * scope travels WITH the key — a key is never a bare string.
 */
export interface TenantScopedCacheKey {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly keyClass: CacheKeyClass;
  /** sha256 over the canonical {tenant, application, class, semantics}. */
  readonly key: string;
  /** sha256 over the tenant-free semantic content (equivalence display). */
  readonly semanticsDigest: string;
}

/**
 * Derive a tenant-scoped cache key over semantic content. The tenant
 * identity is a STRUCTURAL component of the digested content: the
 * same semantics under a different tenant derive a DIFFERENT key,
 * by construction. The semantic content must be canonicalizable
 * (the closed JSON universe — the foundation discipline).
 */
export function deriveTenantScopedCacheKey(
  scope: TenantCacheScope,
  keyClass: CacheKeyClass,
  semantics: unknown,
  digest: IrDigestPort,
): TenantScopedCacheKey {
  const validated = validateTenantCacheScope(scope);
  const semanticsDigest = digest.sha256Hex(canonicalJson({ semantics }));
  const key = digest.sha256Hex(
    canonicalJson({
      tenantId: validated.tenantId,
      applicationId: validated.applicationId,
      keyClass,
      semanticsDigest,
    }),
  );
  return {
    tenantId: validated.tenantId,
    applicationId: validated.applicationId,
    keyClass,
    key,
    semanticsDigest,
  };
}

/**
 * The lookup handle of a tenant-scoped key: the tenant identity is
 * structurally PREFIXED — a durable index keyed by this string can
 * never mix tenants, and a bare `key` digest alone is not a lookup.
 */
export function scopedLookupKey(value: TenantScopedCacheKey): string {
  return `${value.tenantId}:${value.applicationId}:${value.keyClass}:${value.key}`;
}

/**
 * Total validation of a (deserialized) tenant-scoped key: shape,
 * UUIDs, digests, and the RE-DERIVATION of both digests from the
 * scope and the carried semantics digest — a key whose `key` digest
 * does not cover its own claimed tenant identity is a typed
 * identity rejection (`cache-key-tenant`): foreign or tampered keys
 * are rejected, never served.
 */
export function validateTenantScopedCacheKey(
  value: unknown,
  digest: IrDigestPort,
): TenantScopedCacheKey {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    reject("cache-key-shape", "tenant-scoped cache key must be an object");
  }
  const record = value as Record<string, unknown>;
  const scope = validateTenantCacheScope({
    tenantId: record.tenantId,
    applicationId: record.applicationId,
  });
  if (typeof record.keyClass !== "string") {
    reject("cache-key-shape", "tenant-scoped cache key must carry a keyClass");
  }
  if (typeof record.key !== "string" || !SHA256_HEX.test(record.key)) {
    reject("cache-key-shape", "tenant-scoped cache key must carry a sha256 key digest");
  }
  if (typeof record.semanticsDigest !== "string" || !SHA256_HEX.test(record.semanticsDigest)) {
    reject("cache-key-shape", "tenant-scoped cache key must carry a semantics digest");
  }
  // The structural re-derivation proof: the key digest must cover the
  // claimed tenant identity. A key that does not is foreign by
  // construction.
  const expected = digest.sha256Hex(
    canonicalJson({
      tenantId: scope.tenantId,
      applicationId: scope.applicationId,
      keyClass: record.keyClass,
      semanticsDigest: record.semanticsDigest,
    }),
  );
  if (record.key !== expected) {
    reject(
      "cache-key-tenant",
      "tenant-scoped cache key does not cover its claimed tenant identity (foreign key)",
      { keyClass: String(record.keyClass) },
    );
  }
  return {
    tenantId: scope.tenantId,
    applicationId: scope.applicationId,
    keyClass: record.keyClass as CacheKeyClass,
    key: record.key,
    semanticsDigest: record.semanticsDigest,
  };
}

/**
 * The identity equality of two tenant-scoped keys: BOTH the scope
 * (tenant + application) and the key digest must match. Keys from
 * different tenants are NEVER equal even when their semantics
 * digests coincide (the structural isolation).
 */
export function sameTenantCacheKey(
  left: TenantScopedCacheKey,
  right: TenantScopedCacheKey,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.applicationId === right.applicationId &&
    left.keyClass === right.keyClass &&
    left.key === right.key
  );
}
