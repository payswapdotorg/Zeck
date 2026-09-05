/**
 * Integration — the S3-compatible object-store production path over
 * REAL HTTP (WORK-043 / D-02, AC4–7).
 *
 * An in-process S3-compatible server (lib/fake-s3-server.ts — NOT
 * R2; a deterministic stand-in that VERIFIES every request's SigV4
 * signature, header and query/presigned forms) exercises the
 * adapter end-to-end:
 *
 * - the full `ObjectStorePort` flow (put/get/delete roundtrip,
 *   content types, 404→null) with every request signature-verified;
 * - the SIGNED/DELEGATED flows: presigned GET and PUT URLs fetched
 *   directly (query-auth verification server-side) — the delegated
 *   upload/download seam;
 * - artifact integrity: hash-verified put/get with the authoritative
 *   digest; a tampered server-side body FAILS CLOSED without
 *   deleting anything;
 * - retention/cleanup: the bounded sweep deletes exactly the planned
 *   keys through the real store and refuses the retained key;
 * - fail-closed provider paths: rejected credentials (403), missing
 *   bucket (404) — no silent success anywhere.
 *
 * Real-R2 endpoint evidence is separately gated (r2-live.test.ts).
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createVerifyingObjectStore } from "../../../src/platform/object-store/integrity";
import {
  DEFAULT_ARTIFACT_NAMESPACE,
  executeRetentionSweep,
} from "../../../src/platform/object-store/retention";
import {
  createS3ObjectStore,
  type ObjectStorePortWithCapabilities,
  S3ObjectStoreError,
} from "../../../src/platform/object-store/s3-object-store";
import { type FakeS3Server, startFakeS3Server } from "./lib/fake-s3-server";

const BUCKET = "zeck-test-artifacts";
const ACCESS_KEY_ID = "AKIATESTLOCALKEY";
const SECRET_ACCESS_KEY = "localTestSecretAccessKeyValue";

const KEY_A = `zeck/artifacts/tenant-a/ab/${"a".repeat(64)}`;
const KEY_B = `zeck/artifacts/tenant-b/cd/${"b".repeat(64)}`;
const KEY_C = `zeck/artifacts/tenant-c/ef/${"c".repeat(64)}`;

let server: FakeS3Server;
let store: ObjectStorePortWithCapabilities;

beforeAll(async () => {
  server = await startFakeS3Server({
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
    region: "auto",
  });
  store = createS3ObjectStore({
    endpoint: server.url,
    bucket: BUCKET,
    region: "auto",
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
  });
});

afterAll(async () => {
  await server.close();
});

describe("the ObjectStorePort production flow over real HTTP (signature-verified)", () => {
  test("put/get/delete roundtrip with content type; get of a missing key is null", async () => {
    const body = new TextEncoder().encode('{"artifact":"body"}');
    await store.put(KEY_A, body, { contentType: "application/json" });
    expect(server.objects.get(KEY_A)?.contentType).toBe("application/json");
    const stored = await store.get(KEY_A);
    expect(stored).not.toBeNull();
    expect(new TextDecoder().decode(stored?.body ?? new Uint8Array())).toBe('{"artifact":"body"}');
    expect(stored?.contentType).toContain("application/json");
    expect(await store.get("zeck/artifacts/tenant-a/ab/missing")).toBeNull();
    await store.delete(KEY_A);
    expect(server.objects.has(KEY_A)).toBe(false);
    // DELETE of an absent key is idempotent success.
    await expect(store.delete(KEY_A)).resolves.toBeUndefined();
  });

  test("headBucket attests the bucket with valid credentials", async () => {
    const probe = await store.headBucket();
    expect(probe).toEqual({ status: 200, ok: true });
  });

  test("the presigned GET/PUT flows execute delegated transfer (query auth verified server-side)", async () => {
    // Delegated upload: a plain fetch PUT to the presigned URL (no
    // Authorization header — the signature is in the query).
    const putUrl = store.presignPutObject(KEY_B, 300, "text/plain");
    const uploaded = await fetch(putUrl, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "delegated bytes",
    });
    expect(uploaded.status).toBe(200);
    expect(new TextDecoder().decode(server.objects.get(KEY_B)?.body ?? new Uint8Array())).toBe(
      "delegated bytes",
    );
    // Delegated download: a plain fetch GET to the presigned URL.
    const getUrl = store.presignGetObject(KEY_B, 300);
    const downloaded = await fetch(getUrl);
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe("delegated bytes");
    // An unsigned plain fetch to the object path is REJECTED by the
    // server (signature enforcement is real).
    const unsigned = await fetch(`${server.url}/${BUCKET}/${KEY_B}`);
    expect(unsigned.status).toBe(403);
  });

  test("wrong credentials fail closed (403 — no silent success)", async () => {
    const wrongCredentials = createS3ObjectStore({
      endpoint: server.url,
      bucket: BUCKET,
      region: "auto",
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: "wrong-secret",
    });
    const error = await wrongCredentials
      .put(KEY_A, new TextEncoder().encode("x"))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(S3ObjectStoreError);
    expect((error as S3ObjectStoreError).status).toBe(403);
    expect((error as S3ObjectStoreError).providerCode).toBe("SignatureDoesNotMatch");
  });

  test("a missing bucket fails closed (404 on the mutation path; GET stays null-safe)", async () => {
    const missingBucket = createS3ObjectStore({
      endpoint: server.url,
      bucket: "zeck-other-artifacts",
      region: "auto",
      accessKeyId: ACCESS_KEY_ID,
      secretAccessKey: SECRET_ACCESS_KEY,
    });
    // GET on a missing bucket maps to the port's null (absent key
    // semantics) — the read path is null-safe by contract.
    await expect(missingBucket.get(KEY_A)).resolves.toBeNull();
    // The MUTATION path fails closed with the typed provider error.
    const error = await missingBucket
      .put(KEY_A, new TextEncoder().encode("x"))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(S3ObjectStoreError);
    expect((error as S3ObjectStoreError).status).toBe(404);
    expect((error as S3ObjectStoreError).providerCode).toBe("NoSuchBucket");
  });
});

describe("artifact integrity over the real HTTP path (AC6)", () => {
  test("hash-verified put/get with the authoritative digest; tampering fails closed without mutation", async () => {
    const verifying = createVerifyingObjectStore(store);
    const body = new TextEncoder().encode("integrity-checked artifact bytes");
    const digest = createHash("sha256").update(body).digest("hex");
    await verifying.putVerified(KEY_A, body, digest);
    const stored = await verifying.getVerified(KEY_A, digest);
    expect(stored).not.toBeNull();

    // Tamper with the stored bytes SERVER-SIDE (provider corruption):
    server.objects.set(KEY_A, {
      body: new TextEncoder().encode("tampered artifact bytes"),
      contentType: "application/octet-stream",
    });
    const error = await verifying.getVerified(KEY_A, digest).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("integrity violation");
    // Fail closed WITHOUT deleting or repairing: the tampered bytes
    // stay in place for the authority to reconcile.
    expect(server.objects.has(KEY_A)).toBe(true);
    expect(new TextDecoder().decode(server.objects.get(KEY_A)?.body ?? new Uint8Array())).toBe(
      "tampered artifact bytes",
    );
  });
});

describe("retention/cleanup over the real HTTP path (AC7)", () => {
  test("the sweep deletes exactly the planned unretained keys and refuses the retained one", async () => {
    // Store three artifacts; KEY_B is retained by the authority.
    await store.put(KEY_A, new TextEncoder().encode("a"));
    await store.put(KEY_B, new TextEncoder().encode("b"));
    await store.put(KEY_C, new TextEncoder().encode("c"));

    const outcome = await executeRetentionSweep(
      store,
      {
        namespace: DEFAULT_ARTIFACT_NAMESPACE,
        authoritativeRetainedKeys: new Set([KEY_B]),
        candidateKeys: [KEY_A, KEY_B, KEY_C],
        authoritativeInventoryConfirmed: true,
      },
      { dryRun: false },
    );
    expect(outcome.deleted).toEqual([KEY_A, KEY_C]);
    expect(outcome.failures).toEqual([]);
    expect(outcome.refusals.map((refusal) => refusal.key)).toEqual([KEY_B]);
    // The retained key's bytes are untouched; the others are gone.
    expect(server.objects.has(KEY_B)).toBe(true);
    expect(server.objects.has(KEY_A)).toBe(false);
    expect(server.objects.has(KEY_C)).toBe(false);

    // Dry-run (the default) never deletes.
    await store.put(KEY_A, new TextEncoder().encode("a-again"));
    const dry = await executeRetentionSweep(store, {
      namespace: DEFAULT_ARTIFACT_NAMESPACE,
      authoritativeRetainedKeys: new Set(),
      candidateKeys: [KEY_A],
      authoritativeInventoryConfirmed: true,
    });
    expect(dry.dryRun).toBe(true);
    expect(server.objects.has(KEY_A)).toBe(true);
    await store.delete(KEY_A);
  });

  test("an unconfirmed inventory refuses deletion even with candidates present", async () => {
    await store.put(KEY_A, new TextEncoder().encode("a"));
    const outcome = await executeRetentionSweep(
      store,
      {
        namespace: DEFAULT_ARTIFACT_NAMESPACE,
        authoritativeRetainedKeys: new Set(),
        candidateKeys: [KEY_A],
        authoritativeInventoryConfirmed: false,
      },
      { dryRun: false },
    );
    expect(outcome.deleted).toEqual([]);
    expect(outcome.refusals).toHaveLength(1);
    expect(server.objects.has(KEY_A)).toBe(true);
    await store.delete(KEY_A);
  });
});
