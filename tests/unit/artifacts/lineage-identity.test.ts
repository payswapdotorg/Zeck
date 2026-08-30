/**
 * Artifact lineage identity regression (WORK-008 remediation / issue #13).
 *
 * The governance finding: artifact identity hashed only `{kind, payload}`
 * while `parents` / `sourceRefs` stayed outside the digest-covered identity;
 * because the store converges on `(tenantId, digest)` with put-if-absent,
 * a second put with identical kind/payload but DIFFERENT lineage converged
 * to the first record and SILENTLY LOST the requested lineage.
 *
 * The remediated model (Option a): the canonical digest-covered identity
 * form is `{kind, payload, parents, sourceRefs}` with the lineage fields in
 * their deterministic NORMALIZED stored shape — provenance is identity-
 * bearing, so two semantically different lineage records can never converge.
 *
 * This suite is the mandatory regression test from issue #13 requirement 2:
 * same tenant + same kind/payload + different parents/sourceRefs must NOT
 * silently converge while losing lineage; identical FULL inputs must still
 * converge idempotently (true idempotency, now stronger).
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

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

const PAYLOAD = { note: "identical content", n: 7 } as const;
const REFS_A = [{ kind: "source" as const, id: "s1", locator: "a.md" }];
const REFS_B = [{ kind: "source" as const, id: "s2", locator: "b.md" }];

function service(): {
  service: ArtifactService;
  store: ReturnType<typeof createInMemoryArtifactStore>;
} {
  const store = createInMemoryArtifactStore();
  return { service: createArtifactService({ store, digest: createNodeDigestPort() }), store };
}

/** A put with fully explicit lineage (the identity-relevant full input). */
async function putFull(
  svc: ArtifactService,
  tenantId: string,
  payload: unknown,
  opts: {
    readonly parents?: readonly ArtifactDigest[];
    readonly sourceRefs?: readonly {
      kind: "source" | "request" | "artifact";
      id: string;
      locator: string;
    }[];
  } = {},
) {
  return svc.putArtifact({
    tenantId,
    kind: "task-output",
    payload,
    sourceRefs: opts.sourceRefs ?? [],
    parents: opts.parents ?? [],
  });
}

describe("lineage identity regression (issue #13): lineage is digest-covered identity", () => {
  test("same tenant + same kind/payload + DIFFERENT parents -> two records, each keeps its own parents (no silent convergence)", async () => {
    const { service: svc, store } = service();
    const p1 = await putFull(svc, TENANT_A, { gen: 1 });
    const p2 = await putFull(svc, TENANT_A, { gen: 2 });

    const c1 = await putFull(svc, TENANT_A, PAYLOAD, { parents: [p1.digest], sourceRefs: REFS_A });
    const c2 = await putFull(svc, TENANT_A, PAYLOAD, { parents: [p2.digest], sourceRefs: REFS_A });

    // NOT converged: distinct identities, both durably stored.
    expect(c1.status).toBe("stored");
    expect(c2.status).toBe("stored");
    expect(c1.digest).not.toBe(c2.digest);
    expect(store.totalRecords).toBe(4); // p1, p2, c1, c2 — nothing lost

    // Each record carries exactly the lineage that was requested.
    expect(c1.record.parents).toEqual([p1.digest]);
    expect(c2.record.parents).toEqual([p2.digest]);

    // describeLineage reflects EACH record's own parents and children.
    const l1 = await svc.describeLineage({ tenantId: TENANT_A }, c1.digest);
    expect(l1.parents.map((p) => p.digest)).toEqual([p1.digest]);
    const l2 = await svc.describeLineage({ tenantId: TENANT_A }, c2.digest);
    expect(l2.parents.map((p) => p.digest)).toEqual([p2.digest]);
    const pl1 = await svc.describeLineage({ tenantId: TENANT_A }, p1.digest);
    expect(pl1.children.map((c) => c.digest)).toEqual([c1.digest]);
    const pl2 = await svc.describeLineage({ tenantId: TENANT_A }, p2.digest);
    expect(pl2.children.map((c) => c.digest)).toEqual([c2.digest]);
  });

  test("same tenant + same kind/payload + DIFFERENT sourceRefs -> two records, each keeps its own sourceRefs", async () => {
    const { service: svc, store } = service();
    const a = await putFull(svc, TENANT_A, PAYLOAD, { sourceRefs: REFS_A });
    const b = await putFull(svc, TENANT_A, PAYLOAD, { sourceRefs: REFS_B });

    expect(a.status).toBe("stored");
    expect(b.status).toBe("stored");
    expect(a.digest).not.toBe(b.digest);
    expect(store.totalRecords).toBe(2);
    expect(a.record.sourceRefs).toEqual(REFS_A);
    expect(b.record.sourceRefs).toEqual(REFS_B);
  });

  test("parents AND sourceRefs each independently change identity (each alone diverges the digest)", async () => {
    const { service: svc } = service();
    const p1 = await putFull(svc, TENANT_A, { gen: 1 });
    const p2 = await putFull(svc, TENANT_A, { gen: 2 });
    const base = await putFull(svc, TENANT_A, PAYLOAD, {
      parents: [p1.digest],
      sourceRefs: REFS_A,
    });
    const otherParents = await putFull(svc, TENANT_A, PAYLOAD, {
      parents: [p2.digest],
      sourceRefs: REFS_A,
    });
    const otherRefs = await putFull(svc, TENANT_A, PAYLOAD, {
      parents: [p1.digest],
      sourceRefs: REFS_B,
    });
    expect(otherParents.digest).not.toBe(base.digest);
    expect(otherRefs.digest).not.toBe(base.digest);
    expect(otherParents.digest).not.toBe(otherRefs.digest);
  });

  test("identical FULL inputs (kind+payload+parents+sourceRefs) converge idempotently — true idempotency preserved", async () => {
    const { service: svc, store } = service();
    const p1 = await putFull(svc, TENANT_A, { gen: 1 });
    const a = await putFull(svc, TENANT_A, PAYLOAD, { parents: [p1.digest], sourceRefs: REFS_A });
    const b = await putFull(svc, TENANT_A, PAYLOAD, { parents: [p1.digest], sourceRefs: REFS_A });
    expect(a.status).toBe("stored");
    expect(b.status).toBe("converged");
    expect(a.digest).toBe(b.digest);
    expect(b.record).toEqual(a.record);
    expect(store.totalRecords).toBe(2); // p1 + the one converged artifact
  });

  test("deterministic normalization keeps digests stable: parent/sourceRef order and duplicates are identity-irrelevant", async () => {
    const { service: svc } = service();
    const p1 = await putFull(svc, TENANT_A, { gen: 1 });
    const p2 = await putFull(svc, TENANT_A, { gen: 2 });
    const neat = await putFull(svc, TENANT_A, PAYLOAD, {
      parents: [p1.digest, p2.digest],
      sourceRefs: [...REFS_A, ...REFS_B],
    });
    const shuffledDuplicated = await putFull(svc, TENANT_A, PAYLOAD, {
      parents: [p2.digest, p1.digest, p2.digest, p1.digest],
      sourceRefs: [...REFS_B, ...REFS_A, { kind: "source", id: "s2", locator: "b.md" }],
    });
    expect(shuffledDuplicated.status).toBe("converged");
    expect(shuffledDuplicated.digest).toBe(neat.digest);
    expect(shuffledDuplicated.record.parents).toEqual([p1.digest, p2.digest].sort());
    expect(shuffledDuplicated.record.sourceRefs).toEqual(
      [...REFS_A, ...REFS_B].sort((x, y) =>
        `${x.kind}\u0000${x.id}\u0000${x.locator}` < `${y.kind}\u0000${y.id}\u0000${y.locator}`
          ? -1
          : 1,
      ),
    );
  });

  test("the digest is exactly sha256 over the canonical identity form {kind, payload, parents, sourceRefs}", async () => {
    const { service: svc } = service();
    const p1 = await putFull(svc, TENANT_A, { gen: 1 });
    const c = await putFull(svc, TENANT_A, PAYLOAD, { parents: [p1.digest], sourceRefs: REFS_A });
    const expectedForm = {
      kind: "task-output",
      payload: PAYLOAD,
      parents: [p1.digest],
      sourceRefs: REFS_A,
    };
    // canonicalContent IS the exact digest-covered identity form...
    expect(c.record.canonicalContent).toBe(canonicalJson(expectedForm));
    // ...and the digest is its sha256 (server-derived identity).
    expect(c.digest).toBe(createNodeDigestPort().sha256Hex(c.record.canonicalContent));
  });

  test("concurrent divergent-lineage puts store BOTH records (no convergence loss under concurrency)", async () => {
    const { service: svc, store } = service();
    const p1 = await putFull(svc, TENANT_A, { gen: 1 });
    const p2 = await putFull(svc, TENANT_A, { gen: 2 });
    const outcomes = await Promise.all([
      putFull(svc, TENANT_A, PAYLOAD, { parents: [p1.digest], sourceRefs: REFS_A }),
      putFull(svc, TENANT_A, PAYLOAD, { parents: [p2.digest], sourceRefs: REFS_A }),
      putFull(svc, TENANT_A, PAYLOAD, { parents: [p1.digest], sourceRefs: REFS_B }),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(["stored", "stored", "stored"]);
    expect(new Set(outcomes.map((o) => o.digest)).size).toBe(3);
    expect(store.totalRecords).toBe(5); // p1, p2 + the three divergent records
  });

  test("x8 concurrent IDENTICAL full inputs converge to exactly one record (idempotency under concurrency, mirror of the original x8 proof)", async () => {
    const { service: svc, store } = service();
    const p1 = await putFull(svc, TENANT_A, { gen: 1 });
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        putFull(svc, TENANT_A, PAYLOAD, { parents: [p1.digest], sourceRefs: REFS_A }),
      ),
    );
    expect(outcomes.filter((o) => o.status === "stored")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "converged")).toHaveLength(7);
    expect(new Set(outcomes.map((o) => o.digest)).size).toBe(1);
    expect(store.totalRecords).toBe(2);
  });

  test("cross-tenant divergence stays isolated: same full input in two tenants -> same digest, one record per namespace", async () => {
    const { service: svc, store } = service();
    const a = await putFull(svc, TENANT_A, PAYLOAD, { sourceRefs: REFS_A });
    const b = await putFull(svc, TENANT_B, PAYLOAD, { sourceRefs: REFS_A });
    expect(a.digest).toBe(b.digest); // digest-covered identity is tenant-independent
    expect(store.totalRecords).toBe(2); // ownership is tenant-namespaced
    expect((await svc.describeLineage({ tenantId: TENANT_A }, a.digest)).children).toHaveLength(0);
  });

  test("cross-tenant rejection-before-write is preserved under the lineage-covered identity (adoption still rejected, zero writes)", async () => {
    const { service: svc, store } = service();
    const foreign = await putFull(svc, TENANT_B, { secret: "b" }, { sourceRefs: REFS_B });
    const before = store.totalRecords;
    const error = await putFull(svc, TENANT_A, PAYLOAD, { parents: [foreign.digest] }).catch(
      (e: unknown) => e,
    );
    expect((error as { code?: string }).code).toBe("TENANT_SCOPE_VIOLATION");
    expect(store.totalRecords).toBe(before); // rejection BEFORE any write
  });
});
