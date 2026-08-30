/**
 * Filesystem-backed content-addressed artifact store (artifacts module
 * adapter; WORK-008).
 *
 * Durability WITHOUT schema changes (the WORK-005 no-migration precedent,
 * applied to CTX-002): each artifact is one file at
 *
 *   <rootDir>/<tenantId>/<digest[0:2]>/<digest>.json
 *
 * - put-if-absent is the OS-level exclusive create (`flag: "wx"`): if the
 *   file exists the put converges to the EXISTING bytes and never rewrites;
 * - there is NO unlink/rmdir/truncate/rewrite path in this adapter — the
 *   only writes are exclusive creates (append-only discipline at the
 *   adapter level, statically gated);
 * - durability across process restarts = a new store instance over the same
 *   directory observes the identical records (proven by tests);
 * - `ownerOf` scans tenant directories (bounded by tenant count; recorded
 *   limitation) to serve the cross-tenant adoption boundary.
 *
 * Path safety: tenant ids are restricted to `[A-Za-z0-9._-]+` and digests to
 * 64-hex BEFORE any path interpolation — traversal is unrepresentable.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ArtifactDigest,
  ArtifactPutInput,
  ArtifactPutOutcome,
  ArtifactRecord,
} from "../domain/artifact";
import { isArtifactDigest } from "../domain/artifact";
import { canonicalJson } from "../domain/canonical";
import { byDigest } from "../domain/lineage";
import type { ArtifactScope, ArtifactStore } from "../ports/artifact-store";

const SAFE_TENANT = /^[A-Za-z0-9._-]+$/;

export interface FilesystemArtifactStoreOptions {
  readonly rootDir: string;
}

function tenantDir(rootDir: string, tenantId: string): string {
  if (!SAFE_TENANT.test(tenantId)) {
    throw new Error(`tenant id is not path-safe: ${JSON.stringify(tenantId)}`);
  }
  return join(rootDir, tenantId);
}

function artifactPath(rootDir: string, tenantId: string, digest: ArtifactDigest): string {
  if (!isArtifactDigest(digest)) {
    throw new Error("digest must be 64 lowercase hex characters");
  }
  return join(tenantDir(rootDir, tenantId), digest.slice(0, 2), `${digest}.json`);
}

async function readRecord(path: string): Promise<ArtifactRecord> {
  return JSON.parse(await readFile(path, "utf8")) as ArtifactRecord;
}

export function createFilesystemArtifactStore(
  options: FilesystemArtifactStoreOptions,
): ArtifactStore {
  const rootDir = options.rootDir;

  async function collectTenantRecords(tenantId: string): Promise<ArtifactRecord[]> {
    try {
      const shardDirs = await readdir(tenantDir(rootDir, tenantId), { withFileTypes: true });
      const records: ArtifactRecord[] = [];
      for (const shard of shardDirs) {
        if (!shard.isDirectory()) {
          continue;
        }
        const files = await readdir(join(tenantDir(rootDir, tenantId), shard.name));
        for (const file of files) {
          if (file.endsWith(".json")) {
            records.push(await readRecord(join(tenantDir(rootDir, tenantId), shard.name, file)));
          }
        }
      }
      return records.sort(byDigest);
    } catch {
      return []; // absent tenant directory == empty namespace
    }
  }

  return {
    async put(input: ArtifactPutInput): Promise<ArtifactPutOutcome> {
      const path = artifactPath(rootDir, input.tenantId, input.digest);
      const record: ArtifactRecord = {
        tenantId: input.tenantId,
        digest: input.digest,
        kind: input.kind,
        canonicalContent: input.canonicalContent,
        sourceRefs: input.sourceRefs,
        parents: input.parents,
        createdAt: new Date().toISOString(),
      };
      const body = `${canonicalJson(record)}\n`;
      try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, body, { flag: "wx" });
        return { status: "stored", digest: record.digest, record };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          // Put-if-absent converged: NEVER rewrite existing bytes.
          const existing = await readRecord(path);
          return { status: "converged", digest: existing.digest, record: existing };
        }
        throw error;
      }
    },

    async get(scope: ArtifactScope, digest: ArtifactDigest): Promise<ArtifactRecord | null> {
      const path = artifactPath(rootDir, scope.tenantId, digest); // throws on unsafe ids
      try {
        return await readRecord(path);
      } catch {
        return null;
      }
    },

    async list(scope: ArtifactScope): Promise<readonly ArtifactRecord[]> {
      return collectTenantRecords(scope.tenantId);
    },

    async ownerOf(digest: ArtifactDigest): Promise<readonly string[]> {
      if (!isArtifactDigest(digest)) {
        return [];
      }
      let tenants: import("node:fs").Dirent[];
      try {
        tenants = await readdir(rootDir, { withFileTypes: true });
      } catch {
        return [];
      }
      const owners: string[] = [];
      for (const entry of tenants) {
        if (!entry.isDirectory()) {
          continue;
        }
        try {
          await readFile(artifactPath(rootDir, entry.name, digest), "utf8");
          owners.push(entry.name);
        } catch {
          // not owned by this tenant
        }
      }
      return owners.sort();
    },
  };
}
