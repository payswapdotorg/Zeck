/**
 * Discrimination: artifact lineage identity (WORK-008 remediation / issue
 * #13 requirement 3 — the protection's mutation evidence).
 *
 *   L1 — green: same tenant + same kind/payload + different parents produce
 *        DISTINCT digests and records, each keeping its own lineage (the
 *        remediated protection over the production service).
 *   L2 (mutation record / RED RECORD) — the mutant: identity reverted to
 *        CONTENT-ONLY (lineage fields removed from the digest-covered
 *        canonical form — exactly the pre-remediation model, applied through
 *        the documented `serialize` discrimination hook). Under the mutant
 *        the SAME divergent-lineage puts CONVERGE: identical digests, the
 *        second outcome is "converged", and the stored record keeps the
 *        FIRST put's parents — the requested lineage is SILENTLY LOST.
 *        The green L1 assertions fail under exactly this mutation.
 *   L3 — the same loss is observed for divergent sourceRefs (provenance
 *        silently dropped under the mutant).
 *   L4 — mutant honesty: the mutant is EXACTLY the content-only identity
 *        model (its digests equal sha256 over canonical {kind, payload}),
 *        while the production service's digests cover the full identity
 *        form {kind, payload, parents, sourceRefs}.
 *   L5 — the protection is adapter-independent (filesystem store).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  type ArtifactDigest,
  type ArtifactService,
  canonicalJson,
  createArtifactService,
  createFilesystemArtifactStore,
  createInMemoryArtifactStore,
  createNodeDigestPort,
} from "../../src/modules/artifacts/public";

const TENANT_A = "11111111-1111-1111-1111-111111111111";

const PAYLOAD = { note: "identical content", n: 7 } as const;
const REFS_A = [{ kind: "source" as const, id: "s1", locator: "a.md" }];
const REFS_B = [{ kind: "source" as const, id: "s2", locator: "b.md" }];

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

/**
 * THE MUTANT (issue #13's defect): the identity model reverted to
 * content-only — the digest-covered canonical form drops the lineage
 * fields. Applied through the documented `serialize` discrimination hook
 * (WORK-005 injection-point precedent); it is byte-for-byte the
 * pre-remediation digest computation.
 */
function createContentOnlyMutantService(): ArtifactService {
  return createArtifactService({
    store: createInMemoryArtifactStore(),
    digest: createNodeDigestPort(),
    serialize: (value: unknown) => {
      const form = value as { kind: unknown; payload: unknown };
      return canonicalJson({ kind: form.kind, payload: form.payload });
    },
  });
}

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("discrimination: artifact lineage identity (issue #13)", () => {
  test("L1: same kind/payload + different parents -> distinct identities, lineage preserved for each (green protection)", async () => {
    const svc = createArtifactService({
      store: createInMemoryArtifactStore(),
      digest: createNodeDigestPort(),
    });
    const p1 = await putFull(svc, TENANT_A, { gen: 1 });
    const p2 = await putFull(svc, TENANT_A, { gen: 2 });
    const c1 = await putFull(svc, TENANT_A, PAYLOAD, { parents: [p1.digest], sourceRefs: REFS_A });
    const c2 = await putFull(svc, TENANT_A, PAYLOAD, { parents: [p2.digest], sourceRefs: REFS_A });
    expect(c1.status).toBe("stored");
    expect(c2.status).toBe("stored");
    expect(c1.digest).not.toBe(c2.digest);
    expect(c1.record.parents).toEqual([p1.digest]);
    expect(c2.record.parents).toEqual([p2.digest]);
  });

  test("L2 RED RECORD: content-only identity mutant -> divergent parents converge, requested lineage SILENTLY LOST", async () => {
    const mutant = createContentOnlyMutantService();
    const p1 = await putFull(mutant, TENANT_A, { gen: 1 });
    const p2 = await putFull(mutant, TENANT_A, { gen: 2 });
    const c1 = await putFull(mutant, TENANT_A, PAYLOAD, {
      parents: [p1.digest],
      sourceRefs: REFS_A,
    });
    const c2 = await putFull(mutant, TENANT_A, PAYLOAD, {
      parents: [p2.digest],
      sourceRefs: REFS_A,
    });

    // VIOLATION OBSERVED: identical digests for semantically different
    // lineage records — the store converged on (tenantId, digest)...
    expect(c2.digest).toBe(c1.digest);
    expect(c2.status).toBe("converged");
    // ...and the converged record keeps the FIRST put's parents: the
    // requested parent p2 is SILENTLY LOST (c2 asked for [p2], got [p1]).
    expect(c2.record.parents).toEqual([p1.digest]);
    expect(c2.record.parents).not.toContain(p2.digest);
    // ...which is exactly the outcome L1's assertions reject.
  });

  test("L3 RED RECORD: content-only identity mutant -> divergent sourceRefs converge, requested provenance SILENTLY LOST", async () => {
    const mutant = createContentOnlyMutantService();
    const a = await putFull(mutant, TENANT_A, PAYLOAD, { sourceRefs: REFS_A });
    const b = await putFull(mutant, TENANT_A, PAYLOAD, { sourceRefs: REFS_B });
    expect(b.digest).toBe(a.digest);
    expect(b.status).toBe("converged");
    // the converged record keeps the FIRST put's sourceRefs; the requested
    // REFS_B provenance is SILENTLY LOST.
    expect(b.record.sourceRefs).toEqual(REFS_A);
    expect(b.record.sourceRefs).not.toEqual(REFS_B);
  });

  test("L4: mutant honesty — the mutant is exactly the content-only identity; production covers the full identity form", async () => {
    const digestPort = createNodeDigestPort();

    // The mutant's digest equals sha256 over canonical {kind, payload} ONLY
    // (the pre-remediation model), i.e. lineage is outside its identity.
    // p1 lives in the mutant's OWN namespace so the parent check passes.
    const mutant = createContentOnlyMutantService();
    const mParent = await putFull(mutant, TENANT_A, { gen: 1 });
    const m1 = await putFull(mutant, TENANT_A, PAYLOAD, {
      parents: [mParent.digest],
      sourceRefs: REFS_A,
    });
    expect(m1.digest).toBe(
      digestPort.sha256Hex(canonicalJson({ kind: "task-output", payload: PAYLOAD })),
    );

    // The production service's digest covers the full identity form
    // {kind, payload, parents, sourceRefs}: identical payload, same lineage
    // shape, but a digest that differs from the content-only digest — the
    // lineage fields are inside the covered bytes.
    const production = createArtifactService({
      store: createInMemoryArtifactStore(),
      digest: digestPort,
    });
    const gParent = await putFull(production, TENANT_A, { gen: 1 });
    const g1 = await putFull(production, TENANT_A, PAYLOAD, {
      parents: [gParent.digest],
      sourceRefs: REFS_A,
    });
    expect(g1.digest).not.toBe(m1.digest);
    expect(g1.digest).toBe(
      digestPort.sha256Hex(
        canonicalJson({
          kind: "task-output",
          payload: PAYLOAD,
          parents: [gParent.digest],
          sourceRefs: REFS_A,
        }),
      ),
    );
  });

  test("L5: the lineage-identity protection is adapter-independent (filesystem store)", async () => {
    const root = await mkdtemp(join(tmpdir(), "zeck-lineage-id-"));
    tempRoots.push(root);
    const svc = createArtifactService({
      store: createFilesystemArtifactStore({ rootDir: root }),
      digest: createNodeDigestPort(),
    });
    const p1 = await putFull(svc, TENANT_A, { gen: 1 });
    const p2 = await putFull(svc, TENANT_A, { gen: 2 });
    const c1 = await putFull(svc, TENANT_A, PAYLOAD, { parents: [p1.digest], sourceRefs: REFS_A });
    const c2 = await putFull(svc, TENANT_A, PAYLOAD, { parents: [p2.digest], sourceRefs: REFS_A });
    expect(c1.status).toBe("stored");
    expect(c2.status).toBe("stored");
    expect(c1.digest).not.toBe(c2.digest);
    expect(c2.record.parents).toEqual([p2.digest]);
    // distinct digests -> distinct digest-named files (no convergence loss)
    expect(
      (await createFilesystemArtifactStore({ rootDir: root }).list({ tenantId: TENANT_A })).map(
        (r) => r.digest,
      ),
    ).toEqual([p1.digest, p2.digest, c1.digest, c2.digest].sort());
  });
});
