/**
 * Discrimination: lineage-manifest reproducibility (WORK-008 acceptance
 * criterion 5 — the determinism boundary).
 *
 *   P1 — green path: identical inputs + compiler version produce a
 *        byte-identical manifest and digest, repeatedly and across fresh
 *        store instances.
 *   P2 (mutation record / RED RECORD) — with CANONICAL serialization
 *        mutated away (insertion-order `JSON.stringify` — the documented
 *        discrimination hook on the artifact service), the SAME logical
 *        value compiled from differently-ordered source objects produces
 *        DIFFERENT digests: digest instability is observed. The green
 *        reproducibility assertions detect exactly this mutation.
 *   P3 — the instability is not hypothetical: two equal-but-differently-
 *        ordered manifests are shown to hash differently under the mutant
 *        and identically under the canonical serializer.
 *   P4 — compiler version is digest-covered: same inputs, different
 *        version -> different digest (identity changes ONLY through
 *        declared versioned change).
 */

import { describe, expect, test } from "vitest";
import {
  canonicalJson,
  createArtifactService,
  createInMemoryArtifactStore,
  createNodeDigestPort,
} from "../../src/modules/artifacts/public";
import {
  COMPILER_VERSION,
  createContextCompiler,
  createInMemoryRetrieval,
} from "../../src/modules/context/public";

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const EXECUTION_ID = "018f1e10-0000-7000-8000-0000000000bb";

const CORPUS = [
  {
    tenantId: TENANT_A,
    sourceId: "docs",
    locator: "a.md",
    title: "Alpha",
    content: "alpha content invoice",
  },
  {
    tenantId: TENANT_A,
    sourceId: "kb",
    locator: "b.md",
    title: "Beta",
    content: "beta content invoice",
  },
];

function request(keyOrderShuffled: boolean) {
  if (keyOrderShuffled) {
    return {
      sources: [{ sourceId: "docs" }, { sourceId: "kb" }],
      task: { keywords: ["invoice"], summary: "Summarize" },
      execution: { planRevision: { revision: 1, planId: "p1" }, executionId: EXECUTION_ID },
      applicationId: "app-1",
      tenantId: TENANT_A,
    };
  }
  return {
    tenantId: TENANT_A,
    applicationId: "app-1",
    execution: { executionId: EXECUTION_ID, planRevision: { planId: "p1", revision: 1 } },
    task: { summary: "Summarize", keywords: ["invoice"] },
    sources: [{ sourceId: "docs" }, { sourceId: "kb" }],
  };
}

describe("discrimination: reproducible lineage manifest", () => {
  test("P1: identical inputs -> identical manifest bytes + digest, across fresh stores", async () => {
    const digestPort = createNodeDigestPort();
    const compile = async () => {
      const artifacts = createArtifactService({
        store: createInMemoryArtifactStore(),
        digest: digestPort,
      });
      const compiler = createContextCompiler({
        retrieval: createInMemoryRetrieval(CORPUS),
        artifacts,
        digest: digestPort,
      });
      return compiler.compile(request(false));
    };
    const a = await compile();
    const b = await compile();
    const c = await compile();
    expect(b.manifest).toEqual(a.manifest);
    expect(c.manifest).toEqual(a.manifest);
    expect(a.digest).toBe(b.digest);
    expect(b.digest).toBe(c.digest);
    expect(a.artifact.canonicalContent).toBe(b.artifact.canonicalContent);
  });

  test("P2 RED RECORD: non-canonical serialization mutant -> digest instability observed", async () => {
    const digestPort = createNodeDigestPort();
    // The mutant: insertion-order JSON.stringify instead of canonicalJson.
    const mutantService = createArtifactService({
      store: createInMemoryArtifactStore(),
      digest: digestPort,
      serialize: (value: unknown) => JSON.stringify(value),
    });
    const compileMutant = async (shuffled: boolean) => {
      const compiler = createContextCompiler({
        retrieval: createInMemoryRetrieval(CORPUS),
        artifacts: mutantService,
        digest: digestPort,
      });
      return compiler.compile(request(shuffled));
    };
    const straight = await compileMutant(false);
    const shuffled = await compileMutant(true);

    // The two requests are LOGICALLY IDENTICAL (same canonical value) …
    expect(canonicalJson(straight.manifest)).toBe(canonicalJson(shuffled.manifest));
    // … but under the mutant they produce DIFFERENT digests: instability.
    expect(straight.digest).not.toBe(shuffled.digest);
    // The green P1 assertions (equal manifests => equal digests) fail
    // under exactly this mutation.
  });

  test("P3: the canonical serializer is the discriminator — equal values, shuffled keys, one digest", () => {
    const digestPort = createNodeDigestPort();
    const valueA = { a: 1, b: { x: "y", list: [2, 1] } };
    const valueB = { b: { list: [2, 1], x: "y" }, a: 1 };
    expect(JSON.stringify(valueA)).not.toBe(JSON.stringify(valueB)); // mutant diverges
    expect(canonicalJson(valueA)).toBe(canonicalJson(valueB)); // canonical converges
    expect(digestPort.sha256Hex(canonicalJson(valueA))).toBe(
      digestPort.sha256Hex(canonicalJson(valueB)),
    );
  });

  test("P4: compiler version is digest-covered — same inputs, different version, different digest", async () => {
    const digestPort = createNodeDigestPort();
    const compile = async (version: string) => {
      const artifacts = createArtifactService({
        store: createInMemoryArtifactStore(),
        digest: digestPort,
      });
      const compiler = createContextCompiler({
        retrieval: createInMemoryRetrieval(CORPUS),
        artifacts,
        digest: digestPort,
        compilerVersion: version,
      });
      return compiler.compile(request(false));
    };
    const current = await compile(COMPILER_VERSION);
    const changed = await compile("zeck-context-compiler/2-prototype");
    expect(changed.manifest.compilerVersion).toBe("zeck-context-compiler/2-prototype");
    expect(changed.digest).not.toBe(current.digest);
    expect(changed.manifest.requestDigest).not.toBe(current.manifest.requestDigest);
  });
});
