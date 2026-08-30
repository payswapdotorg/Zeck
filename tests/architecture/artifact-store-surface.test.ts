/**
 * Artifact substrate surface gate (WORK-008 / CTX-002) — static proofs
 * over the REAL source tree:
 *
 *  A. No mutation path exists anywhere under `src/modules/artifacts/`:
 *     no unlink/rm/rmdir/truncate calls, no non-exclusive artifact writes
 *     (the only writeFile flag permitted is "wx" = exclusive create).
 *  B. The store port surface is exactly put/get/list/ownerOf — no
 *     update/delete method can be added without breaking this gate AND the
 *     compile-time `STORE_HAS_NO_MUTATION_METHODS` assertion.
 *  C. Every digest computation flows through the DigestPort (node:crypto
 *     is confined to the owning adapter file).
 */

import { describe, expect, test } from "vitest";
import {
  type ArtifactStore,
  createFilesystemArtifactStore,
  createInMemoryArtifactStore,
  STORE_HAS_NO_MUTATION_METHODS,
} from "../../src/modules/artifacts/public";
import { collectSourceFiles } from "./lib/collect";
import { extractImportSpecifiers } from "./lib/dependency-rules";

const files = collectSourceFiles(process.cwd()).filter((file) =>
  file.path.startsWith("src/modules/artifacts/"),
);

describe("artifact substrate: immutability surface (static gate over real sources)", () => {
  test("the artifacts module tree is scanned (non-empty)", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  test("A. no delete/update/unlink/truncate site exists in the artifacts module", () => {
    const forbidden =
      /\.(unlink|rmSync|rmdir|truncate|appendFile|copyFile|rename)\s*\(|\bfs\.rm\b|["']rm["']\s*:/
        .source;
    const offenders = files.filter((file) => new RegExp(forbidden).test(file.content));
    expect(
      offenders.map((file) => file.path),
      `mutation sites found: ${offenders.map((file) => file.path).join(", ")}`,
    ).toEqual([]);
  });

  test("A2. the only writeFile flag in the artifacts module is the exclusive create (wx)", () => {
    for (const file of files) {
      const writeFlags = [...file.content.matchAll(/flag:\s*"([^"]+)"/g)].map((m) => m[1]);
      for (const flag of writeFlags) {
        expect(flag, `${file.path}: non-exclusive write flag ${flag}`).toBe("wx");
      }
    }
  });

  test("B. store instances expose exactly put/get/list/ownerOf (compile-time + runtime surface)", () => {
    expect(STORE_HAS_NO_MUTATION_METHODS).toBe(true);
    const inMemory = createInMemoryArtifactStore();
    const methodsOf = (instance: unknown): string[] =>
      Object.keys(instance as Record<string, unknown>)
        .filter((key) => typeof (instance as Record<string, unknown>)[key] === "function")
        .sort();
    expect(methodsOf(inMemory)).toEqual(["get", "list", "ownerOf", "put"]);
    const fsStore = createFilesystemArtifactStore({ rootDir: "/tmp/zeck-arch-surface-probe" });
    expect(methodsOf(fsStore)).toEqual(["get", "list", "ownerOf", "put"]);
    void (null as unknown as ArtifactStore); // the port type stays referenced
  });

  test("C. node:crypto is imported ONLY by the digest adapter inside artifacts", () => {
    const offenders = files.filter(
      (file) =>
        !file.path.endsWith("adapters/node-digest.ts") &&
        extractImportSpecifiers(file.content).includes("node:crypto"),
    );
    expect(offenders.map((file) => file.path)).toEqual([]);
    const digestAdapter = files.find((file) => file.path.endsWith("adapters/node-digest.ts"));
    expect(digestAdapter).toBeDefined();
    expect(extractImportSpecifiers(digestAdapter?.content ?? "")).toContain("node:crypto");
  });

  test("C2. the context module never hashes directly — digests flow through the DigestPort", () => {
    const contextFiles = collectSourceFiles(process.cwd()).filter((file) =>
      file.path.startsWith("src/modules/context/"),
    );
    const offenders = contextFiles.filter((file) =>
      extractImportSpecifiers(file.content).includes("node:crypto"),
    );
    expect(offenders.map((file) => file.path)).toEqual([]);
    expect(contextFiles.length).toBeGreaterThan(5);
  });
});
