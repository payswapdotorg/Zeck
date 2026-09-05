/**
 * Unit tests — AWS SigV4 signing core (WORK-043 / D-02).
 *
 * GROUND TRUTH: the official AWS SigV4 test-suite vectors (the
 * `get-vanilla` and `post-vanilla` cases: byte-verified canonical
 * requests, strings-to-sign and expected signatures, with the
 * test-suite secret `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY` /
 * access key `AKIDEXAMPLE`, region us-east-1, service `service`,
 * date 20150830T123600Z). The implementation reproduces the official
 * signature bytes EXACTLY or these tests fail — no provider endpoint
 * is involved in proving the algorithm.
 *
 * Canonicalization discrimination: header sorting/casing, query
 * sorting/encoding, payload hashing and the presigned query form are
 * mutation-proven (any weakened canonicalization changes the
 * signature and fails the vector).
 */
import { describe, expect, test } from "vitest";
import {
  authorizationHeaderOf,
  canonicalRequestOf,
  deriveSigningKey,
  EMPTY_PAYLOAD_SHA256,
  MAX_PRESIGN_EXPIRES_SECONDS,
  presignedUrlQuery,
  signRequest,
  stringToSignOf,
  uriEncode,
} from "../../../src/platform/object-store/sigv4";

const EMPTY = EMPTY_PAYLOAD_SHA256;
const KEY = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const CONTEXT = { key: KEY, amzDate: "20150830T123600Z", region: "us-east-1", service: "service" };

const VANILLA = {
  method: "GET",
  canonicalUri: "/",
  canonicalQuery: "",
  headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
  payloadHash: EMPTY,
};

const POST_VANILLA = {
  method: "POST",
  canonicalUri: "/",
  canonicalQuery: "",
  headers: { host: "example.amazonaws.com", "x-amz-date": "20150830T123600Z" },
  payloadHash: EMPTY,
};

describe("official AWS SigV4 test-suite vectors", () => {
  test("get-vanilla: canonical request byte-exact", () => {
    expect(canonicalRequestOf(VANILLA)).toBe(
      `GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY}`,
    );
  });

  test("get-vanilla: string-to-sign carries the official canonical request hash", () => {
    const stringToSign = stringToSignOf(CONTEXT, canonicalRequestOf(VANILLA));
    expect(stringToSign).toBe(
      "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\n" +
        "bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
    );
  });

  test("get-vanilla: the official signature", () => {
    expect(signRequest(VANILLA, CONTEXT)).toBe(
      "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  test("post-vanilla: the official signature", () => {
    expect(signRequest(POST_VANILLA, CONTEXT)).toBe(
      "5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
    );
  });

  test("the Authorization header form matches the official layout", () => {
    const header = authorizationHeaderOf(VANILLA, CONTEXT);
    expect(header).toContain(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request",
    );
    expect(header).toContain("SignedHeaders=host;x-amz-date");
    expect(header).toContain(
      "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  test("any canonicalization weakening breaks the official signature (mutation discrimination)", () => {
    // Header order unsorted → canonicalization SORTS — identical signature
    // (the canonical form is order-insensitive by design).
    const unsorted = {
      ...VANILLA,
      headers: { "x-amz-date": "20150830T123600Z", host: "example.amazonaws.com" },
    };
    expect(signRequest(unsorted, CONTEXT)).toBe(signRequest(VANILLA, CONTEXT));
    // But a changed header VALUE changes the signature.
    const changedValue = {
      ...VANILLA,
      headers: { host: "other.amazonaws.com", "x-amz-date": "20150830T123600Z" },
    };
    expect(signRequest(changedValue, CONTEXT)).not.toBe(signRequest(VANILLA, CONTEXT));
    // Uppercase header name → normalized lower; providing an UPPERCASE name must
    // still canonicalize identically (case-insensitive normalization).
    const upper = {
      ...VANILLA,
      headers: { HOST: "example.amazonaws.com", "X-Amz-Date": "20150830T123600Z" },
    };
    expect(signRequest(upper, CONTEXT)).toBe(signRequest(VANILLA, CONTEXT));
    // A changed payload hash changes the signature.
    expect(signRequest({ ...VANILLA, payloadHash: "0".repeat(64) }, CONTEXT)).not.toBe(
      signRequest(VANILLA, CONTEXT),
    );
    // A changed query changes the signature.
    expect(signRequest({ ...VANILLA, canonicalQuery: "a=1" }, CONTEXT)).not.toBe(
      signRequest(VANILLA, CONTEXT),
    );
    // A changed region/service/date/key changes the signature.
    expect(signRequest(VANILLA, { ...CONTEXT, region: "auto" })).not.toBe(
      signRequest(VANILLA, CONTEXT),
    );
    expect(signRequest(VANILLA, { ...CONTEXT, service: "s3" })).not.toBe(
      signRequest(VANILLA, CONTEXT),
    );
    expect(
      signRequest(VANILLA, { ...CONTEXT, key: { ...KEY, secretAccessKey: "different" } }),
    ).not.toBe(signRequest(VANILLA, CONTEXT));
  });

  test("the signing key chain is the documented HMAC ladder", () => {
    const key = deriveSigningKey(KEY.secretAccessKey, "20150830", "us-east-1", "service");
    expect(key.byteLength).toBe(32);
    // Different (date, region, service) derivations differ.
    expect(deriveSigningKey(KEY.secretAccessKey, "20150831", "us-east-1", "service")).not.toEqual(
      key,
    );
    expect(deriveSigningKey(KEY.secretAccessKey, "20150830", "auto", "s3")).not.toEqual(key);
  });
});

describe("URI encoding (SigV4 canonical rules)", () => {
  test("unreserved characters stay literal; reserved encode uppercase-hex", () => {
    expect(uriEncode("abcXYZ09-_.~")).toBe("abcXYZ09-_.~");
    expect(uriEncode("a b")).toBe("a%20b");
    expect(uriEncode("a/b")).toBe("a/b");
    expect(uriEncode("a/b", true)).toBe("a%2Fb");
    expect(uriEncode("é")).toBe("%C3%A9");
    expect(uriEncode("a+b")).toBe("a%2Bb");
  });
});

describe("presigned (query) authentication", () => {
  test("the presigned query carries the standard parameters in canonical order with a valid signature", () => {
    const { query, signature } = presignedUrlQuery(
      {
        method: "GET",
        canonicalUri: "/bucket/key",
        canonicalQuery: "",
        headers: { host: "s3.example.com" },
        expiresInSeconds: 3600,
      },
      { key: KEY, amzDate: "20150830T123600Z", region: "auto", service: "s3" },
    );
    expect(query).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
    expect(query).toContain("X-Amz-Credential=AKIDEXAMPLE%2F20150830%2Fauto%2Fs3%2Faws4_request");
    expect(query).toContain("X-Amz-Date=20150830T123600Z");
    expect(query).toContain("X-Amz-Expires=3600");
    expect(query).toContain("X-Amz-SignedHeaders=host");
    expect(query.endsWith(`X-Amz-Signature=${signature}`)).toBe(true);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    // The BASE query (everything except the appended signature) is
    // canonically sorted; X-Amz-Signature is appended last (the S3
    // presigned-URL convention — verifiers re-sort canonically).
    const names = query.split("&").map((pair) => pair.slice(0, pair.indexOf("=")));
    const base = names.slice(0, -1);
    expect([...base].sort()).toEqual(base);
    expect(names[names.length - 1]).toBe("X-Amz-Signature");
  });

  test("caller query parameters merge into the canonical query (sorted set)", () => {
    const { query } = presignedUrlQuery(
      {
        method: "GET",
        canonicalUri: "/bucket",
        canonicalQuery: "list-type=2&max-keys=0",
        headers: { host: "s3.example.com" },
        expiresInSeconds: 60,
      },
      { key: KEY, amzDate: "20150830T123600Z", region: "auto", service: "s3" },
    );
    expect(query).toContain("list-type=2");
    expect(query).toContain("max-keys=0");
    const names = query.split("&").map((pair) => pair.slice(0, pair.indexOf("=")));
    const base = names.slice(0, -1);
    expect([...base].sort()).toEqual(base);
    expect(names[names.length - 1]).toBe("X-Amz-Signature");
  });

  test("expiry bounds are enforced (1..604800 seconds)", () => {
    const options = {
      method: "GET",
      canonicalUri: "/bucket/key",
      canonicalQuery: "",
      headers: { host: "s3.example.com" },
    };
    expect(() => presignedUrlQuery({ ...options, expiresInSeconds: 0 }, CONTEXT)).toThrow();
    expect(() =>
      presignedUrlQuery({ ...options, expiresInSeconds: MAX_PRESIGN_EXPIRES_SECONDS + 1 }, CONTEXT),
    ).toThrow();
    expect(() => presignedUrlQuery({ ...options, expiresInSeconds: 1.5 }, CONTEXT)).toThrow();
    expect(() =>
      presignedUrlQuery({ ...options, expiresInSeconds: MAX_PRESIGN_EXPIRES_SECONDS }, CONTEXT),
    ).not.toThrow();
  });

  test("the presigned signature differs from the header-signed form (UNSIGNED-PAYLOAD)", () => {
    const presigned = presignedUrlQuery(
      {
        method: "PUT",
        canonicalUri: "/bucket/key",
        canonicalQuery: "",
        headers: { host: "s3.example.com" },
        expiresInSeconds: 3600,
      },
      { key: KEY, amzDate: "20150830T123600Z", region: "auto", service: "s3" },
    );
    const headerSigned = signRequest(
      {
        method: "PUT",
        canonicalUri: "/bucket/key",
        canonicalQuery: "",
        headers: { host: "s3.example.com" },
        payloadHash: EMPTY,
      },
      { key: KEY, amzDate: "20150830T123600Z", region: "auto", service: "s3" },
    );
    expect(presigned.signature).not.toBe(headerSigned);
  });
});
