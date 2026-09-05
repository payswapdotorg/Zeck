/**
 * Integration — REAL Cloudflare R2 verification (WORK-043 / D-02).
 *
 * Gated on the real provider credential material being materialized
 * in the environment (credential-shaped, environment-only — never in
 * the repository):
 *
 *   ZECK_R2_ENDPOINT              https://<account-id>.r2.cloudflarestorage.com
 *   ZECK_R2_ACCESS_KEY_ID         the R2 S3 access key id
 *   ZECK_R2_SECRET_ACCESS_KEY     the R2 S3 secret access key
 *   ZECK_R2_BUCKET                the target bucket name
 *
 * When any of them is absent the suite SKIPS with the exact reason —
 * evidence discipline: unavailable provider evidence is NOT RUN with
 * the environmental reason, NEVER a silent PASS (WORK-043 evidence
 * contract).
 *
 * When present, the suite executes the real production path: the
 * signed bucket probe, the full port flow, the presigned delegated
 * flows, integrity verification and the bounded retention sweep
 * against the real provider.
 */

import { createHash } from "node:crypto";
import { beforeAll, describe, expect, test } from "vitest";
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

const ENDPOINT = process.env.ZECK_R2_ENDPOINT ?? "";
const ACCESS_KEY_ID = process.env.ZECK_R2_ACCESS_KEY_ID ?? "";
const SECRET_ACCESS_KEY = process.env.ZECK_R2_SECRET_ACCESS_KEY ?? "";
const BUCKET = process.env.ZECK_R2_BUCKET ?? "";
const GATED =
  ENDPOINT.length > 0 &&
  ACCESS_KEY_ID.length > 0 &&
  SECRET_ACCESS_KEY.length > 0 &&
  BUCKET.length > 0;

const KEY = `zeck/artifacts/work043-verify/${"d".repeat(64)}`;

describe.skipIf(!GATED)(
  "the real Cloudflare R2 production path (WORK-043 D-02; gated on ZECK_R2_* materialization)",
  () => {
    let store: ObjectStorePortWithCapabilities;

    beforeAll(() => {
      store = createS3ObjectStore({
        endpoint: ENDPOINT,
        bucket: BUCKET,
        region: process.env.ZECK_R2_REGION ?? "auto",
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET_ACCESS_KEY,
      });
    });

    test("the signed bucket probe attests the real bucket", { timeout: 30_000 }, async () => {
      const probe = await store.headBucket();
      expect(probe.ok).toBe(true);
    });

    test("the full port flow against real R2 (put/get/delete, 404→null)", {
      timeout: 60_000,
    }, async () => {
      const body = new TextEncoder().encode("WORK-043 real R2 verification bytes");
      await store.put(KEY, body, { contentType: "text/plain" });
      const stored = await store.get(KEY);
      expect(stored).not.toBeNull();
      expect(new TextDecoder().decode(stored?.body ?? new Uint8Array())).toBe(
        "WORK-043 real R2 verification bytes",
      );
      await store.delete(KEY);
      expect(await store.get(KEY)).toBeNull();
    });

    test("the presigned delegated flows against real R2", { timeout: 60_000 }, async () => {
      const putUrl = store.presignPutObject(KEY, 300, "text/plain");
      const uploaded = await fetch(putUrl, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: "WORK-043 delegated upload",
      });
      expect(uploaded.status).toBe(200);
      const getUrl = store.presignGetObject(KEY, 300);
      const downloaded = await fetch(getUrl);
      expect(downloaded.status).toBe(200);
      expect(await downloaded.text()).toBe("WORK-043 delegated upload");
      await store.delete(KEY);
    });

    test("integrity verification + bounded retention sweep against real R2", {
      timeout: 60_000,
    }, async () => {
      const verifying = createVerifyingObjectStore(store);
      const body = new TextEncoder().encode("WORK-043 integrity bytes");
      const digest = createHash("sha256").update(body).digest("hex");
      await verifying.putVerified(KEY, body, digest);
      const stored = await verifying.getVerified(KEY, digest);
      expect(stored).not.toBeNull();
      const outcome = await executeRetentionSweep(
        store,
        {
          namespace: DEFAULT_ARTIFACT_NAMESPACE,
          authoritativeRetainedKeys: new Set(),
          candidateKeys: [KEY],
          authoritativeInventoryConfirmed: true,
        },
        { dryRun: false },
      );
      expect(outcome.deleted).toEqual([KEY]);
      expect(await store.get(KEY)).toBeNull();
    });

    test("invalid credentials fail closed against real R2 (negative path)", {
      timeout: 30_000,
    }, async () => {
      const wrong = createS3ObjectStore({
        endpoint: ENDPOINT,
        bucket: BUCKET,
        region: "auto",
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: "definitely-not-the-real-secret",
      });
      const error = await wrong.get(KEY).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(S3ObjectStoreError);
      expect((error as S3ObjectStoreError).status).toBe(403);
    });
  },
);

test("evidence discipline: the real-R2 gate records NOT RUN with the exact reason", () => {
  if (GATED) {
    // Credentials are materialized: the gated suite above is the
    // evidence; this test simply confirms the gate state.
    expect(GATED).toBe(true);
  } else {
    const variables: readonly [string, string][] = [
      ["ZECK_R2_ENDPOINT", ENDPOINT],
      ["ZECK_R2_ACCESS_KEY_ID", ACCESS_KEY_ID],
      ["ZECK_R2_SECRET_ACCESS_KEY", SECRET_ACCESS_KEY],
      ["ZECK_R2_BUCKET", BUCKET],
    ];
    const missing = variables.filter((entry) => entry[1].length === 0).map((entry) => entry[0]);
    // The honest record: real-R2 evidence is NOT RUN because the
    // credential material is absent from this environment.
    console.info(
      `[r2-live] SKIPPED: real R2 verification NOT RUN — credential material absent: ${missing.join(", ")}`,
    );
    expect(missing.length).toBeGreaterThan(0);
  }
});
