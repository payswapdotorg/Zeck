/**
 * Artifact service — content-addressed identity, put-if-absent
 * convergence, tenant adoption boundary, lineage (WORK-008 / CTX-002).
 */

import { describe, expect, test } from "vitest";
import {
  type ArtifactDigest,
  type ArtifactService,
  canonicalJson,
  createArtifactService,
  createInMemoryArtifactStore,
  createNodeDigestPort,
} from "../../../src/modules/artifacts/public";
import { PlatformError } from "../../../src/shared/errors";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

async function newService(): Promise<{
  service: ArtifactService;
  store: ReturnType<typeof createInMemoryArtifactStore>;
}> {
  const store = createInMemoryArtifactStore();
  const service = createArtifactService({ store, digest: createNodeDigestPort() });
  return { service, store };
}

async function put(
  service: ArtifactService,
  tenantId: string,
  payload: unknown,
  parents: ArtifactDigest[] = [],
) {
  return service.putArtifact({
    tenantId,
    kind: "task-output",
    payload,
    sourceRefs: [{ kind: "request", id: "req-1", locator: "test" }],
    parents,
  });
}

async function PlatformErrorCode(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    if (error instanceof PlatformError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("expected a PlatformError");
}

describe("artifact service: content addressing + immutability", () => {
  test("digest = identity: server-derived from canonical content, not caller-supplied", async () => {
    const { service, store } = await newService();
    const a = await put(service, TENANT_A, { note: "hello", n: 1 });
    const b = await put(service, TENANT_A, { n: 1, note: "hello" }); // same canonical value
    expect(a.status).toBe("stored");
    expect(b.status).toBe("converged");
    expect(a.digest).toBe(b.digest);
    expect(b.record.canonicalContent).toBe(a.record.canonicalContent);
    expect(store.totalRecords).toBe(1);
    // The digest is exactly sha256 over the canonical {kind, payload} bytes.
    const expected = createNodeDigestPort().sha256Hex(
      canonicalJson({ kind: "task-output", payload: { n: 1, note: "hello" } }),
    );
    expect(a.digest).toBe(expected);
  });

  test("different content -> different digest; kind participates in identity", async () => {
    const { service } = await newService();
    const x = await put(service, TENANT_A, { v: 1 });
    const y = await put(service, TENANT_A, { v: 2 });
    expect(x.digest).not.toBe(y.digest);
    const k = await service.putArtifact({
      tenantId: TENANT_A,
      kind: "source-document",
      payload: { v: 1 },
      sourceRefs: [],
    });
    expect(k.digest).not.toBe(x.digest);
  });

  test("NO mutation API exists — port surface is put/get/list/ownerOf exactly", async () => {
    const { store, service } = await newService();
    const storeMethods = Object.keys(store).filter(
      (key) => typeof (store as unknown as Record<string, unknown>)[key] === "function",
    );
    expect([...storeMethods].sort()).toEqual(["get", "list", "ownerOf", "put"]);
    const serviceMethods = Object.keys(service).filter(
      (key) => typeof (service as unknown as Record<string, unknown>)[key] === "function",
    );
    expect([...serviceMethods].sort()).toEqual(["describeLineage", "getArtifact", "putArtifact"]);
  });

  test("concurrent identical puts converge to exactly one record", async () => {
    const { service, store } = await newService();
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => put(service, TENANT_A, { c: "same" })),
    );
    expect(outcomes.filter((o) => o.status === "stored")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "converged")).toHaveLength(7);
    expect(store.totalRecords).toBe(1);
    expect(new Set(outcomes.map((o) => o.digest)).size).toBe(1);
  });

  test("identical content under two tenants yields one record PER namespace, same digest", async () => {
    const { service, store } = await newService();
    const a = await put(service, TENANT_A, { shared: true });
    const b = await put(service, TENANT_B, { shared: true });
    expect(a.digest).toBe(b.digest); // content addressing is tenant-independent
    expect(store.totalRecords).toBe(2); // namespaces are isolated
    expect((await service.describeLineage({ tenantId: TENANT_A }, a.digest)).children).toHaveLength(
      0,
    );
  });
});

describe("artifact service: tenant adoption boundary", () => {
  test("cross-tenant parent reference (adoption) is rejected TENANT_SCOPE_VIOLATION, zero writes", async () => {
    const { service, store } = await newService();
    const foreign = await put(service, TENANT_B, { secret: "b" });
    const code = await PlatformErrorCode(() =>
      service.putArtifact({
        tenantId: TENANT_A,
        kind: "task-output",
        payload: { p: 1 },
        sourceRefs: [],
        parents: [foreign.digest],
      }),
    );
    expect(code).toBe("TENANT_SCOPE_VIOLATION");
    expect(store.totalRecords).toBe(1); // only the foreign artifact — zero writes for the caller
  });

  test("cross-tenant read of a foreign digest is rejected TENANT_SCOPE_VIOLATION", async () => {
    const { service } = await newService();
    const foreign = await put(service, TENANT_B, { secret: "b" });
    const code = await PlatformErrorCode(() =>
      service.getArtifact({ tenantId: TENANT_A }, foreign.digest),
    );
    expect(code).toBe("TENANT_SCOPE_VIOLATION");
  });

  test("dangling parent reference (owned nowhere) is rejected POLICY_DENIED, zero writes", async () => {
    const { service, store } = await newService();
    const dangling = createNodeDigestPort().sha256Hex("never-stored");
    const code = await PlatformErrorCode(() => put(service, TENANT_A, { x: 1 }, [dangling]));
    expect(code).toBe("POLICY_DENIED");
    expect(store.totalRecords).toBe(0);
  });

  test("own-namespace parent creates a legal lineage edge", async () => {
    const { service } = await newService();
    const parent = await put(service, TENANT_A, { gen: 1 });
    const child = await put(service, TENANT_A, { gen: 2 }, [parent.digest]);
    const lineage = await service.describeLineage({ tenantId: TENANT_A }, child.digest);
    expect(lineage.parents.map((p) => p.digest)).toEqual([parent.digest]);
    expect(lineage.children.map((c) => c.digest)).toEqual([]);
    const parentLineage = await service.describeLineage({ tenantId: TENANT_A }, parent.digest);
    expect(parentLineage.children.map((c) => c.digest)).toEqual([child.digest]);
  });

  test("non-canonicalizable payload is rejected before any write", async () => {
    const { service, store } = await newService();
    const code = await PlatformErrorCode(() => put(service, TENANT_A, { bad: 0.5 }));
    expect(code).toBe("PROVIDER_ERROR");
    expect(store.totalRecords).toBe(0);
  });

  test("source refs are normalized (sorted, unique) on the stored record", async () => {
    const { service } = await newService();
    const outcome = await service.putArtifact({
      tenantId: TENANT_A,
      kind: "task-output",
      payload: {},
      sourceRefs: [
        { kind: "source", id: "s2", locator: "z" },
        { kind: "source", id: "s1", locator: "a" },
        { kind: "source", id: "s1", locator: "a" },
      ],
    });
    expect(outcome.record.sourceRefs).toEqual([
      { kind: "source", id: "s1", locator: "a" },
      { kind: "source", id: "s2", locator: "z" },
    ]);
    expect(outcome.record.parents).toEqual([]);
  });
});
