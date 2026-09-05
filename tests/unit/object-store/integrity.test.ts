/**
 * Unit tests — artifact content-integrity verification over the
 * ObjectStorePort (WORK-043 / D-02, AC6).
 *
 * Proves: the digest is verified BEFORE transport on put (a
 * mismatching body never reaches the store); downloaded content is
 * verified against the authoritative digest; an integrity violation
 * FAILS CLOSED and deletes/mutates NOTHING (the authority
 * reconciles, never the storage path); and malformed digests are
 * rejected before any I/O.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  ArtifactIntegrityError,
  contentDigestOf,
  createVerifyingObjectStore,
} from "../../../src/platform/object-store/integrity";
import type {
  ObjectStorePort,
  PutOptions,
  StoredObject,
} from "../../../src/platform/object-store/port";

const DIGEST = createHash("sha256").update("artifact bytes").digest("hex");
const OTHER_DIGEST = createHash("sha256").update("tampered bytes").digest("hex");

function recordingStore(initial: Map<string, Uint8Array>): {
  store: ObjectStorePort;
  puts: { key: string; body: Uint8Array }[];
  gets: string[];
  deletes: string[];
} {
  const puts: { key: string; body: Uint8Array }[] = [];
  const gets: string[] = [];
  const deletes: string[] = [];
  return {
    puts,
    gets,
    deletes,
    store: {
      put: async (key: string, body: Uint8Array, _options?: PutOptions) => {
        puts.push({ key, body });
        initial.set(key, body);
      },
      get: async (key: string): Promise<StoredObject | null> => {
        gets.push(key);
        const body = initial.get(key);
        return body === undefined ? null : { key, body, contentType: "application/octet-stream" };
      },
      delete: async (key: string) => {
        deletes.push(key);
        initial.delete(key);
      },
    },
  };
}

describe("the verifying object store (integrity wrapper)", () => {
  test("putVerified stores matching content and never transports mismatching content", async () => {
    const { store, puts } = recordingStore(new Map());
    const verifying = createVerifyingObjectStore(store);
    await verifying.putVerified(
      "zeck/artifacts/t1/ab/x",
      new TextEncoder().encode("artifact bytes"),
      DIGEST,
    );
    expect(puts).toHaveLength(1);
    await expect(
      verifying.putVerified(
        "zeck/artifacts/t1/ab/x",
        new TextEncoder().encode("tampered bytes"),
        DIGEST,
      ),
    ).rejects.toThrow(ArtifactIntegrityError);
    // The mismatching body NEVER reached the underlying store.
    expect(puts).toHaveLength(1);
  });

  test("getVerified returns verified content and null for absent keys", async () => {
    const { store } = recordingStore(
      new Map([["zeck/artifacts/t1/ab/x", new TextEncoder().encode("artifact bytes")]]),
    );
    const verifying = createVerifyingObjectStore(store);
    const stored = await verifying.getVerified("zeck/artifacts/t1/ab/x", DIGEST);
    expect(stored).not.toBeNull();
    expect(new TextDecoder().decode(stored?.body ?? new Uint8Array())).toBe("artifact bytes");
    expect(await verifying.getVerified("zeck/artifacts/t1/ab/absent", DIGEST)).toBeNull();
  });

  test("an integrity violation fails closed WITHOUT deleting or mutating anything", async () => {
    const { store, deletes, gets } = recordingStore(
      new Map([["zeck/artifacts/t1/ab/x", new TextEncoder().encode("tampered bytes")]]),
    );
    const verifying = createVerifyingObjectStore(store);
    const error = await verifying
      .getVerified("zeck/artifacts/t1/ab/x", DIGEST)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArtifactIntegrityError);
    expect((error as ArtifactIntegrityError).key).toBe("zeck/artifacts/t1/ab/x");
    expect((error as Error).message).toContain("integrity violation");
    expect((error as Error).message).toContain("never repaired");
    // Nothing was deleted; nothing was overwritten (the tampered bytes
    // stay in place for the authority to reconcile).
    expect(deletes).toHaveLength(0);
    expect(store.get("zeck/artifacts/t1/ab/x")).resolves.not.toBeNull();
    expect(gets).toContain("zeck/artifacts/t1/ab/x");
  });

  test("malformed digests are rejected before any transport", async () => {
    const { store, puts, gets } = recordingStore(new Map());
    const verifying = createVerifyingObjectStore(store);
    for (const bad of ["", "abc", "XYZ".repeat(22), "g".repeat(64)]) {
      await expect(verifying.putVerified("k", new TextEncoder().encode("x"), bad)).rejects.toThrow(
        ArtifactIntegrityError,
      );
      await expect(verifying.getVerified("k", bad)).rejects.toThrow(ArtifactIntegrityError);
    }
    expect(puts).toHaveLength(0);
    expect(gets).toHaveLength(0);
  });

  test("contentDigestOf is the sha256 hex digest", () => {
    expect(contentDigestOf(new TextEncoder().encode("artifact bytes"))).toBe(DIGEST);
    expect(contentDigestOf(new TextEncoder().encode("tampered bytes"))).toBe(OTHER_DIGEST);
  });
});
