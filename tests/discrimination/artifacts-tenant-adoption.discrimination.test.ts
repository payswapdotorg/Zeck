/**
 * Discrimination: cross-tenant artifact adoption (WORK-008 acceptance
 * criterion 4, second half — the named discrimination boundary).
 *
 *   A1 — adoption via compile-time parent refs: referencing another
 *        tenant's digest is rejected with canonical
 *        `TENANT_SCOPE_VIOLATION`, zero writes.
 *   A2 — adoption via direct read: `getArtifact` on a foreign digest is
 *        rejected `TENANT_SCOPE_VIOLATION` (loud, never an ambiguous miss).
 *   A3 (mutation record / RED RECORD) — with the ownership probe REMOVED
 *        from the service (the exact protection mutated away: a store
 *        whose `get` serves ANY tenant's digest), the SAME adoption
 *        attempt SUCCEEDS and the foreign content becomes readable/derivable
 *        in tenant A — the violation the green assertions detect.
 *   A4 — dangling (nowhere-owned) refs are `POLICY_DENIED`, distinct from
 *        the tenant violation.
 *   A5 — the filesystem adapter enforces the identical boundary (the
 *        protection is in the service, adapter-independent).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  type ArtifactDigest,
  type ArtifactRecord,
  type ArtifactScope,
  type ArtifactStore,
  canonicalJson,
  createArtifactService,
  createFilesystemArtifactStore,
  createInMemoryArtifactStore,
  createNodeDigestPort,
} from "../../src/modules/artifacts/public";
import { PlatformError } from "../../src/shared/errors";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

async function seedForeign(serviceScope: ArtifactStore): Promise<ArtifactDigest> {
  const artifacts = createArtifactService({ store: serviceScope, digest: createNodeDigestPort() });
  const outcome = await artifacts.putArtifact({
    tenantId: TENANT_B,
    kind: "source-document",
    payload: { confidential: "tenant-b-secrets" },
    sourceRefs: [],
  });
  return outcome.digest;
}

describe("discrimination: cross-tenant artifact adoption", () => {
  test("A1: adopting a foreign digest as a parent is rejected TENANT_SCOPE_VIOLATION with zero writes", async () => {
    const store = createInMemoryArtifactStore();
    const foreign = await seedForeign(store);
    const artifacts = createArtifactService({ store, digest: createNodeDigestPort() });
    const error = await artifacts
      .putArtifact({
        tenantId: TENANT_A,
        kind: "compiled-context",
        payload: { tries: "adoption" },
        sourceRefs: [],
        parents: [foreign],
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).code).toBe("TENANT_SCOPE_VIOLATION");
    expect((error as PlatformError).details?.ownerTenants).toEqual([TENANT_B]);
    expect(store.totalRecords).toBe(1); // only the foreign record — zero caller writes
  });

  test("A2: direct cross-tenant read is rejected TENANT_SCOPE_VIOLATION", async () => {
    const store = createInMemoryArtifactStore();
    const foreign = await seedForeign(store);
    const artifacts = createArtifactService({ store, digest: createNodeDigestPort() });
    const error = await artifacts
      .getArtifact({ tenantId: TENANT_A }, foreign)
      .catch((e: unknown) => e);
    expect((error as PlatformError).code).toBe("TENANT_SCOPE_VIOLATION");
  });

  test("A3 RED RECORD: ownership probe removed -> the same adoption attempt succeeds (violation observed)", async () => {
    const realStore = createInMemoryArtifactStore();
    const foreign = await seedForeign(realStore);

    // The mutant: a store whose tenant-scoped get serves ANY tenant's
    // digest (i.e. the ownership discipline mutated away).
    const mutantStore: ArtifactStore = {
      async put(input) {
        return realStore.put(input);
      },
      async get(scope: ArtifactScope, digest: ArtifactDigest): Promise<ArtifactRecord | null> {
        // MUTATION: cross-namespace lookup allowed.
        const own = await realStore.get(scope, digest);
        if (own !== null) {
          return own;
        }
        for (const tenant of await realStore.ownerOf(digest)) {
          const foreignRecord = await realStore.get({ tenantId: tenant }, digest);
          if (foreignRecord !== null) {
            return foreignRecord;
          }
        }
        return null;
      },
      async list(scope) {
        return realStore.list(scope);
      },
      async ownerOf() {
        return []; // MUTATION: ownership probe disabled
      },
    };
    const mutantService = createArtifactService({
      store: mutantStore,
      digest: createNodeDigestPort(),
    });

    // The SAME adoption attempt as A1 now SUCCEEDS: the foreign record is
    // readable and a child of it is persisted in tenant A.
    const readable = await mutantService.getArtifact({ tenantId: TENANT_A }, foreign);
    expect(readable.canonicalContent).toContain("tenant-b-secrets");
    const adopted = await mutantService.putArtifact({
      tenantId: TENANT_A,
      kind: "compiled-context",
      payload: { adopted: true },
      sourceRefs: [],
      parents: [foreign],
    });
    expect(adopted.status).toBe("stored");
    expect(adopted.record.parents).toEqual([foreign]);
    // ...which is exactly the outcome A1's assertions reject.
  });

  test("A4: dangling (nowhere-owned) parent refs are POLICY_DENIED — distinct from the tenant violation", async () => {
    const store = createInMemoryArtifactStore();
    const artifacts = createArtifactService({ store, digest: createNodeDigestPort() });
    const dangling = createNodeDigestPort().sha256Hex(canonicalJson({ never: "stored" }));
    const error = await artifacts
      .putArtifact({
        tenantId: TENANT_A,
        kind: "task-output",
        payload: { x: 1 },
        sourceRefs: [],
        parents: [dangling],
      })
      .catch((e: unknown) => e);
    expect((error as PlatformError).code).toBe("POLICY_DENIED");
    expect(store.totalRecords).toBe(0);
  });

  test("A5: the filesystem adapter enforces the identical adoption boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "zeck-adopt-"));
    tempRoots.push(root);
    const store = createFilesystemArtifactStore({ rootDir: root });
    const foreign = await seedForeign(store);
    const artifacts = createArtifactService({ store, digest: createNodeDigestPort() });
    const error = await artifacts
      .putArtifact({
        tenantId: TENANT_A,
        kind: "compiled-context",
        payload: { via: "filesystem" },
        sourceRefs: [],
        parents: [foreign],
      })
      .catch((e: unknown) => e);
    expect((error as PlatformError).code).toBe("TENANT_SCOPE_VIOLATION");
  });
});

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});
