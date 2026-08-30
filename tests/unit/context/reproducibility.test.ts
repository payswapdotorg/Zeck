/**
 * Reproducible lineage manifest (WORK-008 acceptance criterion 5):
 * identical inputs + compiler version -> byte-identical manifest and
 * digest — across repeated compilations AND across fresh store instances
 * (including the filesystem adapter).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  type ArtifactStore,
  canonicalJson,
  createArtifactService,
  createFilesystemArtifactStore,
  createInMemoryArtifactStore,
  createNodeDigestPort,
} from "../../../src/modules/artifacts/public";
import {
  createContextCompiler,
  createInMemoryRetrieval,
} from "../../../src/modules/context/public";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const EXECUTION_ID = "018f1e10-0000-7000-8000-000000000042";

const CORPUS = [
  {
    tenantId: TENANT_A,
    sourceId: "docs",
    locator: "a.md",
    title: "Alpha",
    content: "alpha invoice content one",
  },
  {
    tenantId: TENANT_A,
    sourceId: "docs",
    locator: "b.md",
    title: "Beta",
    content: "beta invoice content two",
  },
];

const REQUEST = {
  tenantId: TENANT_A,
  applicationId: "app-1",
  execution: { executionId: EXECUTION_ID, planRevision: { planId: "plan-1", revision: 1 } },
  task: { summary: "Summarize invoices", keywords: ["invoice"] },
  sources: [{ sourceId: "docs" }],
} as const;

function compileOver(store: ArtifactStore) {
  const artifacts = createArtifactService({ store, digest: createNodeDigestPort() });
  const compiler = createContextCompiler({
    retrieval: createInMemoryRetrieval(CORPUS),
    artifacts,
    digest: createNodeDigestPort(),
  });
  return compiler.compile({ ...REQUEST });
}

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("reproducible lineage manifest (CTX-001 criterion 5)", () => {
  test("repeated compilations over the SAME store: byte-identical manifest, same digest, put converges", async () => {
    const store = createInMemoryArtifactStore();
    const first = await compileOver(store);
    const second = await compileOver(store);
    expect(second.outcome).toBe("converged");
    expect(second.digest).toBe(first.digest);
    expect(second.manifest).toEqual(first.manifest);
    expect(second.artifact.canonicalContent).toBe(first.artifact.canonicalContent);
    expect(store.totalRecords).toBe(1);
  });

  test("repeated compilations over FRESH store instances: same digest (identity is store-independent)", async () => {
    const a = await compileOver(createInMemoryArtifactStore());
    const b = await compileOver(createInMemoryArtifactStore());
    expect(a.digest).toBe(b.digest);
    expect(a.manifest).toEqual(b.manifest);
    expect(a.outcome).toBe("stored");
    expect(b.outcome).toBe("stored");
  });

  test("fresh FILESYSTEM store instances over the same/different dirs produce the identical digest", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "zeck-repro-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "zeck-repro-b-"));
    tempRoots.push(rootA, rootB);
    const a = await compileOver(createFilesystemArtifactStore({ rootDir: rootA }));
    const b = await compileOver(createFilesystemArtifactStore({ rootDir: rootB }));
    expect(a.digest).toBe(b.digest);
    expect(a.artifact.canonicalContent).toBe(b.artifact.canonicalContent);
    // and a second compile over the SAME directory converges without a second file
    const again = await compileOver(createFilesystemArtifactStore({ rootDir: rootA }));
    expect(again.outcome).toBe("converged");
    expect(again.digest).toBe(a.digest);
  });

  test("key-order shuffled requests (same logical value) still converge to the same digest", async () => {
    const artifacts = createArtifactService({
      store: createInMemoryArtifactStore(),
      digest: createNodeDigestPort(),
    });
    const compiler = createContextCompiler({
      retrieval: createInMemoryRetrieval(CORPUS),
      artifacts,
      digest: createNodeDigestPort(),
    });
    const straight = await compiler.compile({ ...REQUEST });
    const shuffled = await compiler.compile({
      sources: [{ sourceId: "docs" }],
      task: { keywords: ["invoice"], summary: "Summarize invoices" },
      execution: { planRevision: { revision: 1, planId: "plan-1" }, executionId: EXECUTION_ID },
      applicationId: "app-1",
      tenantId: TENANT_A,
    });
    expect(shuffled.digest).toBe(straight.digest);
    expect(shuffled.artifact.canonicalContent).toBe(straight.artifact.canonicalContent);
  });

  test("different compiler version -> different manifest bytes -> different digest (version is digest-covered)", async () => {
    const run = async (version: string): Promise<string> => {
      const artifacts = createArtifactService({
        store: createInMemoryArtifactStore(),
        digest: createNodeDigestPort(),
      });
      const compiler = createContextCompiler({
        retrieval: createInMemoryRetrieval(CORPUS),
        artifacts,
        digest: createNodeDigestPort(),
        compilerVersion: version,
      });
      const result = await compiler.compile({ ...REQUEST });
      return result.digest;
    };
    const v1 = await run("zeck-context-compiler/1");
    const v1again = await run("zeck-context-compiler/1");
    const v2 = await run("zeck-context-compiler/2");
    expect(v1).toBe(v1again);
    expect(v2).not.toBe(v1);
  });

  test("different inputs -> different digests (execution binding, task, parents each matter)", async () => {
    const artifacts = createArtifactService({
      store: createInMemoryArtifactStore(),
      digest: createNodeDigestPort(),
    });
    const compiler = createContextCompiler({
      retrieval: createInMemoryRetrieval(CORPUS),
      artifacts,
      digest: createNodeDigestPort(),
    });
    const base = await compiler.compile({ ...REQUEST });
    const otherExecution = await compiler.compile({
      ...REQUEST,
      execution: {
        executionId: "018f1e10-0000-7000-8000-000000000099",
        planRevision: { planId: "plan-1", revision: 1 },
      },
    });
    const otherTask = await compiler.compile({
      ...REQUEST,
      task: { summary: "Different summary", keywords: ["invoice"] },
    });
    const noPlan = await compiler.compile({
      ...REQUEST,
      execution: { executionId: EXECUTION_ID },
    });
    expect(otherExecution.digest).not.toBe(base.digest);
    expect(otherTask.digest).not.toBe(base.digest);
    expect(noPlan.digest).not.toBe(base.digest);
    expect(JSON.stringify(noPlan.manifest.consumption)).not.toContain("planRevision");
    expect(canonicalJson(noPlan.manifest)).not.toContain("planRevision");
  });
});
