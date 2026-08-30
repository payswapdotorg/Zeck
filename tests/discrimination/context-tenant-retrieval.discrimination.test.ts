/**
 * Discrimination: cross-tenant source retrieval (WORK-008 acceptance
 * criterion 4, first half — the named discrimination boundary).
 *
 *   T1 — the GREEN path: a compiling tenant's request compiles only its
 *        own candidates; a foreign candidate present in the corpus is
 *        never returned by the honoring adapter and never reaches the
 *        manifest.
 *   T2 — a careless/mutated adapter that DOES return a foreign-tenant
 *        candidate is rejected with the canonical
 *        `TENANT_SCOPE_VIOLATION` BEFORE any artifact write (zero records).
 *   T3 (mutation record / RED RECORD) — with the retrieval-stage tenant
 *        assertion REMOVED (the exact protection mutated away), the SAME
 *        foreign candidate is compiled into the manifest and persisted:
 *        cross-tenant content observation happens. The green assertions of
 *        T2 therefore discriminate — they fail under exactly this
 *        mutation.
 *   T4 — the violation detail is machine-readable (foreign candidate
 *        coordinates are in `details`), never silent.
 */

import { describe, expect, test } from "vitest";
import {
  canonicalJson,
  createArtifactService,
  createInMemoryArtifactStore,
  createNodeDigestPort,
} from "../../src/modules/artifacts/public";
import {
  applyRetrievalStage,
  type ContextCandidate,
  type ContextRetrievalPort,
  createContextCompiler,
  createInMemoryRetrieval,
} from "../../src/modules/context/public";
import { PlatformError } from "../../src/shared/errors";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const EXECUTION_ID = "018f1e10-0000-7000-8000-0000000000aa";

const OWN: ContextCandidate = {
  tenantId: TENANT_A,
  sourceId: "docs",
  locator: "own.md",
  title: "Own",
  content: "invoice refund own tenant content",
};

const FOREIGN: ContextCandidate = {
  tenantId: TENANT_B,
  sourceId: "docs",
  locator: "foreign.md",
  title: "Foreign",
  content: "invoice refund foreign tenant secrets",
};

const REQUEST = {
  tenantId: TENANT_A,
  applicationId: "app-1",
  execution: { executionId: EXECUTION_ID },
  task: { summary: "s", keywords: ["invoice", "refund"] },
  sources: [{ sourceId: "docs" }],
} as const;

/** The mutated (protection-removed) retrieval stage: accepts everything. */
function mutatedRetrievalStageAcceptingAll(
  candidates: readonly ContextCandidate[],
): ContextCandidate[] {
  return [...candidates].sort((a, b) => (a.locator < b.locator ? -1 : 1));
}

describe("discrimination: cross-tenant source retrieval", () => {
  test("T1: green path — honoring adapter serves only same-tenant candidates", async () => {
    const store = createInMemoryArtifactStore();
    const compiler = createContextCompiler({
      retrieval: createInMemoryRetrieval([OWN, FOREIGN]),
      artifacts: createArtifactService({ store, digest: createNodeDigestPort() }),
      digest: createNodeDigestPort(),
    });
    const result = await compiler.compile({ ...REQUEST });
    const sources = result.manifest.taskContext.sections[1]?.items ?? [];
    expect(sources).toHaveLength(1);
    expect(sources[0]?.sourceRef.locator).toBe("own.md");
    expect(result.manifest.stages.retrieval).toEqual({ candidates: 1, foreignRejected: 0 });
    expect(store.totalRecords).toBe(1);
  });

  test("T2: careless adapter leaking a foreign candidate -> canonical TENANT_SCOPE_VIOLATION, zero writes", async () => {
    const store = createInMemoryArtifactStore();
    const leaky: ContextRetrievalPort = {
      async retrieve() {
        return [OWN, FOREIGN];
      },
    };
    const compiler = createContextCompiler({
      retrieval: leaky,
      artifacts: createArtifactService({ store, digest: createNodeDigestPort() }),
      digest: createNodeDigestPort(),
    });
    const error = await compiler.compile({ ...REQUEST }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).code).toBe("TENANT_SCOPE_VIOLATION");
    expect(store.totalRecords).toBe(0);
  });

  test("T3 RED RECORD: tenant assertion removed -> foreign content IS compiled and persisted (violation observed)", async () => {
    // Simulate the production compiler with ONLY the retrieval-stage tenant
    // assertion mutated away (applyRetrievalStage replaced by an accept-all).
    const store = createInMemoryArtifactStore();
    const artifacts = createArtifactService({ store, digest: createNodeDigestPort() });
    const digestPort = createNodeDigestPort();

    // Reproduce the compiler pipeline manually with the mutated stage 1
    // (identical downstream stages) to observe the violation.
    const candidates = mutatedRetrievalStageAcceptingAll([OWN, FOREIGN]);
    const {
      applyRelevanceStage,
      applyDeduplicationStage,
      applyCompressionStage,
      applyStructureStage,
      buildManifest,
    } = await import("../../src/modules/context/public");
    const relevance = applyRelevanceStage({
      candidates,
      taskKeywords: ["invoice", "refund"],
      policy: { minScore: 1 },
    });
    const dedup = applyDeduplicationStage({ ranked: relevance.kept });
    const compression = applyCompressionStage({
      ranked: dedup.unique,
      policy: { perItemCharBudget: 2000, totalCharBudget: 20000 },
    });
    const taskContext = applyStructureStage({
      task: REQUEST.task,
      applicationId: "app-1",
      execution: { executionId: EXECUTION_ID, applicationId: "app-1" },
      items: compression.items,
    });
    const manifest = buildManifest({
      compilerVersion: "zeck-context-compiler/1",
      consumption: { executionId: EXECUTION_ID, applicationId: "app-1" },
      requestDigest: digestPort.sha256Hex(canonicalJson({ mutated: true })),
      parents: [],
      taskContext,
      stages: {
        retrieval: { candidates: 2, foreignRejected: 0 },
        relevance: { kept: 2, excluded: 0 },
        deduplication: { collapsed: 0 },
        compression: { inputChars: 0, outputChars: 0, dropped: 0 },
        structure: { sections: 2, items: 3 },
      },
    });
    const persisted = await artifacts.putArtifact({
      tenantId: TENANT_A,
      kind: "compiled-context",
      payload: manifest,
      sourceRefs: [],
    });

    // VIOLATION OBSERVED: the foreign document's content is now durable in
    // tenant A's compiled context — exactly what T2's assertions prevent.
    expect(persisted.status).toBe("stored");
    expect(persisted.record.canonicalContent).toContain("foreign tenant secrets");
    expect(persisted.record.canonicalContent).toContain("foreign.md");
  });

  test("T4: the rejection carries machine-readable foreign-candidate coordinates", async () => {
    const leaky: ContextRetrievalPort = {
      async retrieve() {
        return [FOREIGN];
      },
    };
    const compiler = createContextCompiler({
      retrieval: leaky,
      artifacts: createArtifactService({
        store: createInMemoryArtifactStore(),
        digest: createNodeDigestPort(),
      }),
      digest: createNodeDigestPort(),
    });
    const error = (await compiler
      .compile({ ...REQUEST })
      .catch((e: unknown) => e)) as PlatformError;
    expect(error.code).toBe("TENANT_SCOPE_VIOLATION");
    expect(error.details?.foreignCandidates).toEqual([
      { tenantId: TENANT_B, sourceId: "docs", locator: "foreign.md" },
    ]);
  });

  test("scanner honesty: the real retrieval stage still discriminates (canonical shape, zero violations)", () => {
    const out = applyRetrievalStage({ tenantId: TENANT_A, candidates: [OWN, FOREIGN] });
    expect(out.accepted).toEqual([OWN]);
    expect(out.foreign).toEqual([{ candidate: FOREIGN, reason: "tenant-mismatch" }]);
  });
});
