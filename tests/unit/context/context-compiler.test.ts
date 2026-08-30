/**
 * Context compiler end-to-end (WORK-008 / CTX-001/002): orchestration of
 * the five stages, execution/plan-revision binding, lineage edges to
 * parent artifacts, validation and tenant rejections with zero writes.
 */

import { describe, expect, test } from "vitest";
import {
  type ArtifactService,
  canonicalJson,
  createArtifactService,
  createInMemoryArtifactStore,
  createNodeDigestPort,
} from "../../../src/modules/artifacts/public";
import {
  COMPILER_VERSION,
  createContextCompiler,
  createInMemoryRetrieval,
  DEFAULT_COMPILE_POLICY,
} from "../../../src/modules/context/public";
import { PlatformError } from "../../../src/shared/errors";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";
const EXECUTION_ID = "018f1e10-0000-7000-8000-000000000001";

function fixture(corpusOverrides: Parameters<typeof createInMemoryRetrieval>[0] = []) {
  const corpus = [
    {
      tenantId: TENANT_A,
      sourceId: "docs",
      locator: "a.md",
      title: "Invoice policy",
      content: "invoice refund policy terms and conditions",
    },
    {
      tenantId: TENANT_A,
      sourceId: "docs",
      locator: "b.md",
      title: "Newsletter",
      content: "weekly newsletter about unrelated things",
    },
    {
      tenantId: TENANT_A,
      sourceId: "kb",
      locator: "c.md",
      title: "Refund flow",
      content: "refund flow steps invoice",
    },
    ...corpusOverrides,
  ];
  const retrieval = createInMemoryRetrieval(corpus);
  const store = createInMemoryArtifactStore();
  const artifacts: ArtifactService = createArtifactService({
    store,
    digest: createNodeDigestPort(),
  });
  const compiler = createContextCompiler({ retrieval, artifacts, digest: createNodeDigestPort() });
  return { retrieval, store, artifacts, compiler };
}

const REQUEST = {
  tenantId: TENANT_A,
  applicationId: "app-1",
  execution: {
    executionId: EXECUTION_ID,
    planRevision: { planId: "plan-7", revision: 2 },
  },
  task: { summary: "Answer the refund question", keywords: ["invoice", "refund"] },
  sources: [{ sourceId: "docs" }, { sourceId: "kb" }],
} as const;

async function errorCode(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    if (error instanceof PlatformError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("expected PlatformError");
}

describe("context compiler", () => {
  test("compiles a task context through all five stages with recorded statistics", async () => {
    const { compiler } = fixture();
    const result = await compiler.compile({ ...REQUEST });

    expect(result.outcome).toBe("stored");
    expect(result.manifest.compilerVersion).toBe(COMPILER_VERSION);
    expect(result.manifest.kind).toBe("compiled-context");
    // relevance: newsletter excluded (score 0 < 1)
    expect(result.manifest.stages.relevance).toEqual({ kept: 2, excluded: 1 });
    expect(result.manifest.stages.retrieval).toEqual({ candidates: 3, foreignRejected: 0 });
    expect(result.manifest.stages.structure.sections).toBe(2);
    expect(result.manifest.stages.structure.items).toBe(3); // task + 2 sources
    const sources = result.manifest.taskContext.sections[1]?.items ?? [];
    expect(sources.map((i) => i.title)).toEqual(["Invoice policy", "Refund flow"]); // tied scores -> deterministic retrieval order
    expect(sources.every((i) => i.sourceRef.kind === "source")).toBe(true);
  });

  test("execution + plan revision binding is recorded on the manifest AND survives persistence", async () => {
    const { compiler, artifacts } = fixture();
    const result = await compiler.compile({ ...REQUEST });
    expect(result.manifest.consumption).toEqual({
      executionId: EXECUTION_ID,
      applicationId: "app-1",
      planRevision: { planId: "plan-7", revision: 2 },
    });
    const stored = await artifacts.getArtifact({ tenantId: TENANT_A }, result.digest);
    expect(stored.canonicalContent).toContain(EXECUTION_ID);
    expect(stored.canonicalContent).toContain("plan-7");
    const parsed = JSON.parse(stored.canonicalContent) as { payload: { consumption: unknown } };
    expect(parsed.payload.consumption).toEqual(result.manifest.consumption);
  });

  test("parent artifact refs become lineage edges parent -> compiled context", async () => {
    const { compiler, artifacts } = fixture();
    const parent = await artifacts.putArtifact({
      tenantId: TENANT_A,
      kind: "source-document",
      payload: { doc: "seed" },
      sourceRefs: [],
    });
    const result = await compiler.compile({ ...REQUEST, inputArtifactRefs: [parent.digest] });
    expect(result.manifest.parents).toEqual([parent.digest]);
    expect(result.artifact.parents).toEqual([parent.digest]);
    const lineage = await artifacts.describeLineage({ tenantId: TENANT_A }, result.digest);
    expect(lineage.parents.map((p) => p.digest)).toEqual([parent.digest]);
    const parentLineage = await artifacts.describeLineage({ tenantId: TENANT_A }, parent.digest);
    expect(parentLineage.children.map((c) => c.digest)).toEqual([result.digest]);
  });

  test("negative: cross-tenant source retrieval is rejected TENANT_SCOPE_VIOLATION with zero writes", async () => {
    const { store } = fixture();
    // A mutated/careless retrieval adapter that leaks a foreign-tenant
    // candidate into the compiling tenant's result set.
    const leaky = {
      retrieve: async (query: { tenantId: string; sources: readonly { sourceId: string }[] }) => {
        const legitimate = await createInMemoryRetrieval([
          {
            tenantId: TENANT_A,
            sourceId: "docs",
            locator: "a.md",
            title: "Invoice policy",
            content: "invoice refund policy",
          },
        ]).retrieve(query);
        return [
          ...legitimate,
          {
            tenantId: TENANT_B,
            sourceId: "docs",
            locator: "foreign.md",
            title: "Foreign",
            content: "invoice refund secrets from another tenant",
          },
        ];
      },
    };
    const compiler = createContextCompiler({
      retrieval: leaky,
      artifacts: createArtifactService({ store, digest: createNodeDigestPort() }),
      digest: createNodeDigestPort(),
    });
    const code = await errorCode(() => compiler.compile({ ...REQUEST }));
    expect(code).toBe("TENANT_SCOPE_VIOLATION");
    expect(store.totalRecords).toBe(0);
  });

  test("negative: cross-tenant parent artifact adoption is rejected TENANT_SCOPE_VIOLATION before retrieval/persistence", async () => {
    const { store, compiler } = fixture();
    const foreign = await createArtifactService({
      store,
      digest: createNodeDigestPort(),
    }).putArtifact({
      tenantId: TENANT_B,
      kind: "source-document",
      payload: { secret: true },
      sourceRefs: [],
    });
    const code = await errorCode(() =>
      compiler.compile({ ...REQUEST, inputArtifactRefs: [foreign.digest] }),
    );
    expect(code).toBe("TENANT_SCOPE_VIOLATION");
    expect(store.totalRecords).toBe(1); // only the pre-existing foreign artifact
  });

  test("negative: invalid requests are rejected POLICY_DENIED with zero writes (shape discipline)", async () => {
    const { store, compiler } = fixture();
    const badRequests = [
      { ...REQUEST, execution: { executionId: "not-a-uuid" } },
      {
        ...REQUEST,
        execution: { executionId: EXECUTION_ID, planRevision: { planId: "", revision: 1 } },
      },
      {
        ...REQUEST,
        execution: { executionId: EXECUTION_ID, planRevision: { planId: "p", revision: 0 } },
      },
      { ...REQUEST, task: { summary: "", keywords: ["x"] } },
      { ...REQUEST, sources: [] },
      { ...REQUEST, policy: { perItemCharBudget: 10.5 } },
    ];
    for (const bad of badRequests) {
      const code = await errorCode(() => compiler.compile(bad));
      expect(code).toBe("POLICY_DENIED");
    }
    expect(store.totalRecords).toBe(0);
  });

  test("negative: malformed artifact refs are rejected before any store interaction", async () => {
    const { store, compiler } = fixture();
    const code = await errorCode(() =>
      compiler.compile({ ...REQUEST, inputArtifactRefs: ["deadbeef"] }),
    );
    expect(code).toBe("POLICY_DENIED");
    expect(store.totalRecords).toBe(0);
  });

  test("the stored artifact carries normalized source references of every compiled item", async () => {
    const { compiler } = fixture();
    const result = await compiler.compile({ ...REQUEST });
    expect(result.artifact.sourceRefs).toEqual([
      { kind: "request", id: EXECUTION_ID, locator: "app-1" },
      { kind: "source", id: "docs", locator: "a.md" },
      { kind: "source", id: "kb", locator: "c.md" },
    ]);
  });

  test("artifact content is the canonical serialization of the manifest (digest = identity)", async () => {
    const { compiler } = fixture();
    const result = await compiler.compile({ ...REQUEST });
    expect(result.artifact.canonicalContent).toBe(
      canonicalJson({ kind: "compiled-context", payload: result.manifest }),
    );
    expect(createNodeDigestPort().sha256Hex(result.artifact.canonicalContent)).toBe(result.digest);
  });

  test("policy defaults apply when no override is given; overrides change the compiled result", async () => {
    const { compiler } = fixture();
    const withDefaults = await compiler.compile({ ...REQUEST });
    expect(
      withDefaults.manifest.taskContext.sections[1]?.items[0]?.content.length,
    ).toBeLessThanOrEqual(DEFAULT_COMPILE_POLICY.perItemCharBudget);
    const tight = await compiler.compile({
      ...REQUEST,
      policy: { perItemCharBudget: 10, totalCharBudget: 1000, minRelevanceScore: 2 },
    });
    expect(tight.manifest.stages.relevance).toEqual({ kept: 2, excluded: 1 }); // both score 2
    const tightSources = tight.manifest.taskContext.sections[1]?.items ?? [];
    expect(tightSources.every((item) => item.content.length <= 10)).toBe(true);
    expect(tight.manifest.stages.compression.outputChars).toBeLessThan(
      withDefaults.manifest.stages.compression.outputChars,
    );
    expect(tight.digest).not.toBe(withDefaults.digest);
  });
});
