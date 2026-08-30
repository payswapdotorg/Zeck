/**
 * Filesystem content-addressed artifact store — durability across
 * "restart", put-if-absent immutability, path safety (WORK-008 / CTX-002).
 *
 * Uses tmp directories ONLY (never repository files).
 */

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  type ArtifactDigest,
  canonicalJson,
  createArtifactService,
  createFilesystemArtifactStore,
  createNodeDigestPort,
} from "../../../src/modules/artifacts/public";
import { PlatformError } from "../../../src/shared/errors";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

const tempRoots: string[] = [];
async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zeck-artifacts-"));
  tempRoots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function putTask(
  root: string,
  tenantId: string,
  payload: unknown,
  parents: ArtifactDigest[] = [],
) {
  const service = createArtifactService({
    store: createFilesystemArtifactStore({ rootDir: root }),
    digest: createNodeDigestPort(),
  });
  return service.putArtifact({
    tenantId,
    kind: "task-output",
    payload,
    sourceRefs: [{ kind: "request", id: "r", locator: "l" }],
    parents,
  });
}

describe("filesystem artifact store", () => {
  test("artifacts persist across restart: a fresh store instance over the same directory observes identical records", async () => {
    const root = await freshRoot();
    const first = await putTask(root, TENANT_A, { restart: 1 });
    expect(first.status).toBe("stored");

    // "Restart": brand-new store + service instances over the same rootDir.
    const reopened = createFilesystemArtifactStore({ rootDir: root });
    const record = await reopened.get({ tenantId: TENANT_A }, first.digest);
    expect(record).not.toBeNull();
    expect(record?.canonicalContent).toBe(first.record.canonicalContent);
    expect(record?.digest).toBe(first.digest);
    const all = await reopened.list({ tenantId: TENANT_A });
    expect(all.map((r) => r.digest)).toEqual([first.digest]);
  });

  test("second put of the same content is a no-op converging to the SAME digest and bytes", async () => {
    const root = await freshRoot();
    const a = await putTask(root, TENANT_A, { v: 7 });
    const b = await putTask(root, TENANT_A, { v: 7 });
    expect(a.status).toBe("stored");
    expect(b.status).toBe("converged");
    expect(a.digest).toBe(b.digest);
    expect(b.record.canonicalContent).toBe(a.record.canonicalContent);
    // exactly one file on disk for this artifact
    const shardDir = join(root, TENANT_A, a.digest.slice(0, 2));
    expect((await readdir(shardDir)).sort()).toEqual([`${a.digest}.json`]);
  });

  test("files are digest-named under tenant/shard directories; never repository files", async () => {
    const root = await freshRoot();
    const a = await putTask(root, TENANT_A, { where: 1 });
    const path = join(root, TENANT_A, a.digest.slice(0, 2), `${a.digest}.json`);
    const body = await readFile(path, "utf8");
    expect(body).toBe(`${canonicalJson(a.record)}\n`);
    expect(root.startsWith(tmpdir())).toBe(true);
  });

  test("tenant namespaces are isolated on disk; ownerOf finds only the owning tenant", async () => {
    const root = await freshRoot();
    const a = await putTask(root, TENANT_A, { ns: 1 });
    await putTask(root, TENANT_B, { ns: 2 });
    const store = createFilesystemArtifactStore({ rootDir: root });
    expect(await store.ownerOf(a.digest)).toEqual([TENANT_A]);
    expect(await store.get({ tenantId: TENANT_B }, a.digest)).toBeNull();
  });

  test("the service over the filesystem store enforces the same adoption boundary", async () => {
    const root = await freshRoot();
    const foreign = await putTask(root, TENANT_B, { secret: 1 });
    await expect(putTask(root, TENANT_A, { adopt: 1 }, [foreign.digest])).rejects.toMatchObject({
      code: "TENANT_SCOPE_VIOLATION",
    });
  });

  test("path-unsafe tenant ids are rejected before touching the filesystem", async () => {
    const root = await freshRoot();
    const store = createFilesystemArtifactStore({ rootDir: root });
    await expect(
      store.get({ tenantId: "../escape" }, createNodeDigestPort().sha256Hex("x")),
    ).rejects.toThrow(/path-safe/);
  });

  test("record shape survives a JSON round trip byte-identically (digest-stable identity)", async () => {
    const root = await freshRoot();
    const a = await putTask(root, TENANT_A, { round: "trip" });
    const store = createFilesystemArtifactStore({ rootDir: root });
    const again = await store.get({ tenantId: TENANT_A }, a.digest);
    expect(again).not.toBeNull();
    expect(again?.canonicalContent).toBe(a.record.canonicalContent);
    // digest still matches the re-derived content hash
    expect(createNodeDigestPort().sha256Hex(again?.canonicalContent ?? "")).toBe(a.digest);
  });

  test("missing tenant namespace behaves as empty (no throws, no phantoms)", async () => {
    const root = await freshRoot();
    const store = createFilesystemArtifactStore({ rootDir: root });
    expect(await store.list({ tenantId: "never-seen" })).toEqual([]);
    expect(await store.ownerOf(createNodeDigestPort().sha256Hex("ghost"))).toEqual([]);
    expect(
      await store.get({ tenantId: "never-seen" }, createNodeDigestPort().sha256Hex("ghost")),
    ).toBeNull();
  });

  test("PlatformError shape preserved for service-level misses over fs store", async () => {
    const root = await freshRoot();
    const service = createArtifactService({
      store: createFilesystemArtifactStore({ rootDir: root }),
      digest: createNodeDigestPort(),
    });
    const ghost = createNodeDigestPort().sha256Hex("ghost");
    await expect(service.getArtifact({ tenantId: TENANT_A }, ghost)).rejects.toBeInstanceOf(
      PlatformError,
    );
  });
});
