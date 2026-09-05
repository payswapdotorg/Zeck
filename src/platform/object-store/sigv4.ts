/**
 * AWS Signature Version 4 signing (WORK-043 / D-02).
 *
 * The R2 adapter speaks the S3 REST API; S3 request authentication is
 * SigV4. This module is the PURE signing core: canonical request
 * construction, string-to-sign, the HMAC-SHA256 signing-key chain,
 * the `Authorization` header form and the query-string (presigned)
 * form. It is provider-neutral: it signs any HTTP method/URL/header
 * set for the `s3` service of any region — R2 uses region `auto`.
 *
 * CORRECTNESS PROOF: the implementation is pinned to the official
 * AWS SigV4 test-suite vectors (`get-vanilla`, `post-vanilla` —
 * byte-verified expected canonical requests and signatures) in
 * `tests/unit/object-store/sigv4.test.ts`; no provider endpoint is
 * needed to prove the algorithm.
 *
 * Zero provider SDK: node:crypto + this module replace the
 * `@aws-sdk/*` family for the S3 verbs Zeck uses (PUT/GET/DELETE/
 * HEAD and presigned URLs), so no SDK boundary-table expansion is
 * required for D-02.
 */
import { createHash, createHmac } from "node:crypto";

export const EMPTY_PAYLOAD_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface SigV4KeyMaterial {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface SigV4RequestInput {
  readonly method: string;
  /** Path (canonical URI), already URI-encoded per S3 rules. */
  readonly canonicalUri: string;
  /** Canonical query string WITHOUT the leading `?` (sorted, encoded). */
  readonly canonicalQuery: string;
  /** Signed headers, lowercase names, sorted. */
  readonly headers: Readonly<Record<string, string>>;
  /** Hex sha256 of the payload (`UNSIGNED-PAYLOAD` for presigned forms). */
  readonly payloadHash: string;
}

export interface SigV4SigningContext {
  readonly key: SigV4KeyMaterial;
  /** ISO basic date-time, e.g. `20150830T123600Z`. */
  readonly amzDate: string;
  readonly region: string;
  readonly service: string;
}

function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function hmac(key: Buffer | string, message: string): Buffer {
  return createHmac("sha256", key).update(message, "utf8").digest();
}

/** The SigV4 signing key chain (AWS4<secret> → date → region → service → aws4_request). */
export function deriveSigningKey(
  secretAccessKey: string,
  datestamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, datestamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function canonicalHeadersOf(headers: Readonly<Record<string, string>>): {
  readonly canonicalHeaders: string;
  readonly signedHeaders: string;
} {
  // Lowercase the header NAMES (HTTP headers are case-insensitive; the
  // canonical form is lowercase+sorted) while preserving each value
  // under its lowercased key.
  const lowercased = new Map<string, string>();
  for (const [name, value] of Object.entries(headers)) {
    lowercased.set(name.toLowerCase(), value);
  }
  const names = [...lowercased.keys()].sort();
  const canonicalLines: string[] = [];
  for (const name of names) {
    const value = lowercased.get(name) ?? "";
    // Trim leading/trailing spaces and collapse sequential spaces.
    const normalized = value.trim().replaceAll(/ {2,}/g, " ");
    canonicalLines.push(`${name}:${normalized}\n`);
  }
  return {
    canonicalHeaders: canonicalLines.join(""),
    signedHeaders: names.join(";"),
  };
}

/** Build the canonical request string (SigV4 grammar, byte-exact). */
export function canonicalRequestOf(input: SigV4RequestInput): string {
  const { canonicalHeaders, signedHeaders } = canonicalHeadersOf(input.headers);
  return [
    input.method.toUpperCase(),
    input.canonicalUri,
    input.canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
}

/** Build the string to sign. */
export function stringToSignOf(context: SigV4SigningContext, canonicalRequest: string): string {
  const datestamp = context.amzDate.slice(0, 8);
  const scope = `${datestamp}/${context.region}/${context.service}/aws4_request`;
  return ["AWS4-HMAC-SHA256", context.amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
}

/** Compute the hex signature of a fully specified request. */
export function signRequest(input: SigV4RequestInput, context: SigV4SigningContext): string {
  const canonicalRequest = canonicalRequestOf(input);
  const stringToSign = stringToSignOf(context, canonicalRequest);
  const datestamp = context.amzDate.slice(0, 8);
  const signingKey = deriveSigningKey(
    context.key.secretAccessKey,
    datestamp,
    context.region,
    context.service,
  );
  return createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
}

/**
 * Build the SigV4 `Authorization` header value for a request. The
 * host header MUST be included (HTTP/1.1) — the S3 caller passes it.
 */
export function authorizationHeaderOf(
  input: SigV4RequestInput,
  context: SigV4SigningContext,
): string {
  const signature = signRequest(input, context);
  const { signedHeaders } = canonicalHeadersOf(input.headers);
  const datestamp = context.amzDate.slice(0, 8);
  return (
    `AWS4-HMAC-SHA256 Credential=${context.key.accessKeyId}/${datestamp}/${context.region}` +
    `/${context.service}/aws4_request, SignedHeaders=${signedHeaders}, Signature=${signature}`
  );
}

export interface PresignOptions {
  readonly method: string;
  readonly canonicalUri: string;
  readonly canonicalQuery: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresInSeconds: number;
}

/** Presign-query parameter validation bounds (S3/R2 limit: 1..604800). */
export const MAX_PRESIGN_EXPIRES_SECONDS = 604_800;

/**
 * Build the presigned URL query parameters (SigV4 query
 * authentication — the delegated upload/download flow: the signature
 * travels in the query string, no Authorization header). The
 * returned parameters are URI-ENCODED and in canonical order; append
 * `X-Amz-Signature` (computed over the request WITHOUT it) last.
 */
export function presignedUrlQuery(
  options: PresignOptions,
  context: SigV4SigningContext,
): { readonly query: string; readonly signature: string } {
  if (
    !Number.isInteger(options.expiresInSeconds) ||
    options.expiresInSeconds < 1 ||
    options.expiresInSeconds > MAX_PRESIGN_EXPIRES_SECONDS
  ) {
    throw new Error(
      `presign expiry must be an integer in [1, ${MAX_PRESIGN_EXPIRES_SECONDS}] seconds`,
    );
  }
  const datestamp = context.amzDate.slice(0, 8);
  const credential = `${context.key.accessKeyId}/${datestamp}/${context.region}/${context.service}/aws4_request`;
  const { signedHeaders } = canonicalHeadersOf(options.headers);
  const baseQuery: readonly [string, string][] = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", credential],
    ["X-Amz-Date", context.amzDate],
    ["X-Amz-Expires", String(options.expiresInSeconds)],
    ["X-Amz-SignedHeaders", signedHeaders],
  ];
  // Query-component encoding: slashes ARE encoded here (unlike canonical
  // URI paths) — the presigned URL's X-Amz-Credential carries %2F.
  const encodedBase = baseQuery
    .map(([name, value]) => `${uriEncode(name)}=${uriEncode(value, true)}`)
    .sort()
    .join("&");
  // Canonical query = the base parameters, sorted, WITHOUT the signature.
  // Merge any caller-supplied query (e.g. list-type=2) into the sorted set.
  const merged = mergeCanonicalQuery(options.canonicalQuery, encodedBase);
  const signature = signRequest(
    {
      method: options.method.toUpperCase(),
      canonicalUri: options.canonicalUri,
      canonicalQuery: merged,
      headers: options.headers,
      payloadHash: "UNSIGNED-PAYLOAD",
    },
    context,
  );
  return { query: `${merged}&${uriEncode("X-Amz-Signature")}=${signature}`, signature };
}

/** Merge two canonical (sorted, encoded) query strings into one sorted string. */
function mergeCanonicalQuery(callerQuery: string, presignQuery: string): string {
  if (callerQuery.length === 0) {
    return presignQuery;
  }
  const all = [...callerQuery.split("&"), ...presignQuery.split("&")];
  const seen = new Map<string, string>();
  for (const pair of all) {
    const equals = pair.indexOf("=");
    if (equals === -1) {
      seen.set(pair, "");
    } else {
      seen.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
  }
  return [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

/**
 * URI-encode per the SigV4 canonical rules: unreserved characters
 * (`A-Z a-z 0-9 - _ . ~`) stay literal; everything else becomes
 * `%XX` (uppercase hex). The forward slash is NOT encoded for
 * canonical paths but IS encoded for query components — the caller
 * chooses by passing the already-encoded path or using
 * `encodeCanonicalUri`.
 */
export function uriEncode(value: string, encodeSlash = false): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(char) || (char === "/" && !encodeSlash)) {
      out += char;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** Canonical URI encoding for an object key path (slashes preserved, each segment encoded). */
export function encodeCanonicalUri(path: string): string {
  return uriEncode(path, false);
}
