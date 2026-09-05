/**
 * Unit tests — the S3-compatible `ObjectStorePort` adapter over a
 * FAKE fetch (WORK-043 / D-02).
 *
 * Proves the request surface: correct method/path per verb; the
 * SigV4 authorization header present with the required signed
 * headers (host, x-amz-content-sha256, x-amz-date, content-type when
 * sent); payload hashing on PUT; 404 on GET maps to null; provider
 * failures map to typed `S3ObjectStoreError` (status + code, no
 * silent success); key-shape rejection; and presigned URLs target
 * the right object path.
 */
import { describe, expect, test } from "vitest";
import {
  createS3ObjectStore,
  providerErrorCodeOf,
  type S3ObjectStoreConfig,
  S3ObjectStoreConfigError,
  S3ObjectStoreError,
} from "../../../src/platform/object-store/s3-object-store";

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: Uint8Array;
}

function fakeFetch(
  respond: (request: RecordedRequest) => {
    status: number;
    body?: string;
    headers?: Record<string, string>;
  },
) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      url: String(url),
      headers: Object.fromEntries(
        new Headers(init?.headers ?? {}).entries() as IterableIterator<[string, string]>,
      ),
      body: init?.body instanceof Uint8Array ? init.body : undefined,
    };
    requests.push(request);
    const response = respond(request);
    return new Response(response.body ?? null, {
      status: response.status,
      headers: response.headers ?? {},
    });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const CONFIG: S3ObjectStoreConfig = {
  endpoint: "https://acct.example.r2.cloudflarestorage.com",
  bucket: "zeck-staging-artifacts",
  region: "auto",
  accessKeyId: "AKIATEST",
  secretAccessKey: "testSecretKey",
  now: () => new Date("2026-09-05T12:00:00.000Z"),
};

const BODY = new TextEncoder().encode("artifact bytes");

describe("the S3 object-store adapter (fake fetch)", () => {
  test("put sends a signed PUT with the payload hash and content type", async () => {
    const { fetchImpl, requests } = fakeFetch(() => ({ status: 200 }));
    const store = createS3ObjectStore({ ...CONFIG, fetchImpl });
    await store.put("zeck/artifacts/t1/ab/".concat("a".repeat(64)), BODY, {
      contentType: "application/json",
    });
    const request = requests[0];
    expect(request).toBeDefined();
    expect(request?.method).toBe("PUT");
    expect(request?.url).toContain("/zeck-staging-artifacts/zeck/artifacts/t1/ab/");
    expect(request?.headers["x-amz-content-sha256"]).toBe(
      "4659fc0570122b0e0aa14f4ff7c261b1fe51795a01ba79963f462ebf40d7520d",
    );
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(request?.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(request?.headers.authorization).toContain(
      "SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date",
    );
    expect(request?.headers["x-amz-date"]).toBe("20260905T120000Z");
  });

  test("put rejects non-2xx responses fail closed with status and provider code", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 403,
      body: "<Error><Code>AccessDenied</Code></Error>",
    }));
    const store = createS3ObjectStore({ ...CONFIG, fetchImpl });
    const error = await store
      .put("zeck/artifacts/t1/ab/".concat("a".repeat(64)), BODY)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(S3ObjectStoreError);
    const s3Error = error as S3ObjectStoreError;
    expect(s3Error.status).toBe(403);
    expect(s3Error.providerCode).toBe("AccessDenied");
    expect(s3Error.message).toContain("failed closed");
  });

  test("get returns null on 404 and the stored object on 200", async () => {
    const { fetchImpl } = fakeFetch((request) =>
      request.url.includes("missing") ? { status: 404 } : { status: 200, body: "artifact bytes" },
    );
    const store = createS3ObjectStore({ ...CONFIG, fetchImpl });
    const missing = await store.get("zeck/artifacts/t1/ab/missing");
    expect(missing).toBeNull();
    const stored = await store.get("zeck/artifacts/t1/ab/".concat("a".repeat(64)));
    expect(stored).not.toBeNull();
    expect(new TextDecoder().decode(stored?.body ?? new Uint8Array())).toBe("artifact bytes");
  });

  test("get rejects provider failures fail closed (500 with XML code)", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      status: 500,
      body: "<Error><Code>InternalError</Code></Error>",
    }));
    const store = createS3ObjectStore({ ...CONFIG, fetchImpl });
    const error = await store
      .get("zeck/artifacts/t1/ab/".concat("a".repeat(64)))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(S3ObjectStoreError);
    expect((error as S3ObjectStoreError).providerCode).toBe("InternalError");
  });

  test("delete is idempotent (204/200/404 all succeed)", async () => {
    for (const status of [204, 200, 404]) {
      const { fetchImpl } = fakeFetch(() => ({ status }));
      const store = createS3ObjectStore({ ...CONFIG, fetchImpl });
      await expect(
        store.delete("zeck/artifacts/t1/ab/".concat("a".repeat(64))),
      ).resolves.toBeUndefined();
    }
    const { fetchImpl } = fakeFetch(() => ({ status: 403 }));
    const store = createS3ObjectStore({ ...CONFIG, fetchImpl });
    await expect(store.delete("zeck/artifacts/t1/ab/".concat("a".repeat(64)))).rejects.toThrow(
      S3ObjectStoreError,
    );
  });

  test("headBucket reports ok on 200 and typed failure otherwise", async () => {
    const ok = fakeFetch(() => ({ status: 200 }));
    const okStore = createS3ObjectStore({ ...CONFIG, fetchImpl: ok.fetchImpl });
    await expect(okStore.headBucket()).resolves.toEqual({ status: 200, ok: true });
    const missing = fakeFetch(() => ({ status: 404 }));
    const missingStore = createS3ObjectStore({ ...CONFIG, fetchImpl: missing.fetchImpl });
    await expect(missingStore.headBucket()).resolves.toEqual({ status: 404, ok: false });
  });

  test("object keys outside the safe shape are rejected before transport", async () => {
    const { fetchImpl, requests } = fakeFetch(() => ({ status: 200 }));
    const store = createS3ObjectStore({ ...CONFIG, fetchImpl });
    for (const bad of ["", " leading-space", "a".repeat(901), "key\u0000nul", "../escape"]) {
      await expect(store.put(bad, BODY)).rejects.toThrow(S3ObjectStoreError);
      await expect(store.get(bad)).rejects.toThrow(S3ObjectStoreError);
      await expect(store.delete(bad)).rejects.toThrow(S3ObjectStoreError);
    }
    expect(requests).toHaveLength(0);
  });

  test("configuration validation fails closed on malformed endpoints/buckets/credentials", () => {
    expect(() => createS3ObjectStore({ ...CONFIG, endpoint: "not-a-url" })).toThrow(
      S3ObjectStoreConfigError,
    );
    expect(() => createS3ObjectStore({ ...CONFIG, endpoint: "https://x.example.com/" })).toThrow(
      S3ObjectStoreConfigError,
    );
    expect(() => createS3ObjectStore({ ...CONFIG, bucket: "UPPER" })).toThrow(
      S3ObjectStoreConfigError,
    );
    expect(() => createS3ObjectStore({ ...CONFIG, accessKeyId: "" })).toThrow(
      S3ObjectStoreConfigError,
    );
    expect(() => createS3ObjectStore({ ...CONFIG, secretAccessKey: "" })).toThrow(
      S3ObjectStoreConfigError,
    );
    expect(() => createS3ObjectStore({ ...CONFIG, region: "" })).toThrow(S3ObjectStoreConfigError);
  });

  test("presigned URLs target the object path with query authentication", () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200 }));
    const store = createS3ObjectStore({ ...CONFIG, fetchImpl });
    const key = "zeck/artifacts/t1/ab/".concat("a".repeat(64));
    const getUrl = store.presignGetObject(key, 600);
    expect(getUrl.startsWith(`${CONFIG.endpoint}/${CONFIG.bucket}/${key}?`)).toBe(true);
    expect(getUrl).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
    expect(getUrl).toContain("X-Amz-Expires=600");
    expect(getUrl).toContain("X-Amz-Signature=");
    const putUrl = store.presignPutObject(key, 600, "text/plain");
    expect(putUrl.startsWith(`${CONFIG.endpoint}/${CONFIG.bucket}/${key}?`)).toBe(true);
    expect(putUrl).toContain("X-Amz-SignedHeaders=content-type%3Bhost");
  });

  test("the provider error-code parser extracts <Code> safely", () => {
    expect(providerErrorCodeOf("<Error><Code>NoSuchBucket</Code></Error>")).toBe("NoSuchBucket");
    expect(providerErrorCodeOf("no xml here")).toBeNull();
    expect(providerErrorCodeOf("")).toBeNull();
  });
});
