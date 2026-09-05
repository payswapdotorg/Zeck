/**
 * S3-compatible `ObjectStorePort` adapter — the Cloudflare R2
 * production path (WORK-043 / D-02, acceptance criterion 4).
 *
 * R2 speaks the S3 REST API; this adapter implements the existing
 * provider-neutral `ObjectStorePort` (put/get/delete) over that API
 * with SigV4 request signing (`sigv4.ts`). R2 concepts stop HERE:
 * domain modules see only the port (enforced by the architecture
 * tests); no `@aws-sdk` dependency exists, so the SDK boundary table
 * needs no expansion — the provider surface is exactly this file.
 *
 * Signed/delegated flows (AC5): every request is SigV4-signed, and
 * the adapter exports `presignGetObject`/`presignPutObject` (SigV4
 * query authentication) as the delegated upload/download seam for
 * the Work Orders that need browser/direct-client transfer. No
 * existing contract REQUIRES delegation today (the port transports
 * bytes directly); the capability is implemented and tested now.
 *
 * Artifact bytes NEVER pass through PostgreSQL: this module has no
 * database dependency at all (pinned by architecture tests) — bytes
 * cross the wire to object storage only.
 */
import { createHash } from "node:crypto";
import type { ObjectStorePort, PutOptions, StoredObject } from "./port";
import {
  authorizationHeaderOf,
  EMPTY_PAYLOAD_SHA256,
  presignedUrlQuery,
  type SigV4KeyMaterial,
  type SigV4RequestInput,
  type SigV4SigningContext,
} from "./sigv4";

const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,899}$/;

export interface S3ObjectStoreConfig {
  /** S3 endpoint, e.g. `https://<account-id>.r2.cloudflarestorage.com`. */
  readonly endpoint: string;
  readonly bucket: string;
  /** Region (`auto` for R2). */
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Injectable transport (tests substitute a local S3 server). */
  readonly fetchImpl?: typeof fetch;
  /** Injectable clock (deterministic signing in tests). */
  readonly now?: () => Date;
}

export class S3ObjectStoreConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "S3ObjectStoreConfigError";
  }
}

/** Raised when the provider rejects an operation (fail closed). */
export class S3ObjectStoreError extends Error {
  readonly status: number;
  readonly providerCode: string | null;
  constructor(message: string, status: number, providerCode: string | null) {
    super(message);
    this.name = "S3ObjectStoreError";
    this.status = status;
    this.providerCode = providerCode;
  }
}

export function validateS3ObjectStoreConfig(config: S3ObjectStoreConfig): void {
  const problems: string[] = [];
  if (!/^https?:\/\//.test(config.endpoint) || config.endpoint.includes(" ")) {
    problems.push("endpoint must be an http(s) URL");
  }
  if (config.endpoint.endsWith("/")) {
    problems.push("endpoint must not end with a slash");
  }
  if (!BUCKET_PATTERN.test(config.bucket)) {
    problems.push("bucket must be 3-63 lowercase alphanumeric/hyphen/dot characters");
  }
  if (config.region.length === 0) {
    problems.push("region is required (use 'auto' for R2)");
  }
  if (config.accessKeyId.length === 0 || config.secretAccessKey.length === 0) {
    problems.push("access key id and secret access key are required (resolved secret material)");
  }
  if (problems.length > 0) {
    throw new S3ObjectStoreConfigError(
      `invalid object-store configuration: ${problems.join("; ")}`,
    );
  }
}

interface SignedRequestSpec {
  readonly method: string;
  readonly path: string;
  readonly query?: string;
  readonly body?: Uint8Array;
  readonly contentType?: string;
}

function amzTimestamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function encodeKeyPath(key: string): string {
  return key
    .split("/")
    .map((segment) =>
      [...Buffer.from(segment, "utf8")]
        .map((byte) => {
          const char = String.fromCharCode(byte);
          return /[A-Za-z0-9\-_.~]/.test(char)
            ? char
            : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
        })
        .join(""),
    )
    .join("/");
}

/** Parse the `<Code>` element out of an S3 XML error body. */
export function providerErrorCodeOf(errorBody: string): string | null {
  const match = /<Code>([^<]{1,128})<\/Code>/.exec(errorBody);
  return match === null || match[1] === undefined ? null : match[1];
}

export interface ObjectStorePortWithCapabilities extends ObjectStorePort {
  /** Signed URL for a delegated download (read access to the bytes). */
  presignGetObject(key: string, expiresInSeconds: number): string;
  /** Signed URL for a delegated upload (write access to the bytes). */
  presignPutObject(key: string, expiresInSeconds: number, contentType?: string): string;
  /**
   * Liveness/authorization probe: HEAD the bucket. 200 ⇒ the bucket
   * exists and the credentials authorize it; anything else is a typed
   * failure (403 credentials; 404 bucket).
   */
  headBucket(): Promise<{ readonly status: number; readonly ok: boolean }>;
}

export function createS3ObjectStore(config: S3ObjectStoreConfig): ObjectStorePortWithCapabilities {
  validateS3ObjectStoreConfig(config);
  const doFetch = config.fetchImpl ?? fetch;
  const now = config.now ?? (() => new Date());

  const keyMaterial: SigV4KeyMaterial = {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  };

  function signingContext(): SigV4SigningContext {
    return {
      key: keyMaterial,
      amzDate: amzTimestamp(now()),
      region: config.region,
      service: "s3",
    };
  }

  function endpointUrl(): URL {
    // The endpoint host is the SigV4 host header target.
    return new URL(config.endpoint);
  }

  async function signedFetch(spec: SignedRequestSpec): Promise<Response> {
    const url = endpointUrl();
    const path = spec.path;
    const body = spec.body ?? new Uint8Array(0);
    const payloadHash = spec.body === undefined ? EMPTY_PAYLOAD_SHA256 : sha256Hex(body);
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
    };
    if (spec.contentType !== undefined) {
      headers["content-type"] = spec.contentType;
    }
    const context = signingContext();
    // The x-amz-date must be in the signed header set.
    const withDate: Record<string, string> = { ...headers, "x-amz-date": context.amzDate };
    const input: SigV4RequestInput = {
      method: spec.method,
      canonicalUri: path,
      canonicalQuery: spec.query ?? "",
      headers: withDate,
      payloadHash,
    };
    const authorization = authorizationHeaderOf(input, context);
    const requestHeaders: Record<string, string> = { ...withDate, authorization };
    const query = spec.query === undefined || spec.query.length === 0 ? "" : `?${spec.query}`;
    return doFetch(`${config.endpoint}${path}${query}`, {
      method: spec.method,
      headers: requestHeaders,
      body: spec.method === "GET" || spec.method === "HEAD" ? undefined : body,
    });
  }

  async function failClosed(response: Response, operation: string): Promise<never> {
    const text = await response.text().catch(() => "");
    const code = providerErrorCodeOf(text);
    // Never include the endpoint's error detail blindly: it is
    // provider output, but the message may echo request material.
    // Status + provider code + operation are safe diagnostics.
    throw new S3ObjectStoreError(
      `object-store ${operation} failed closed: provider status ${response.status}${
        code === null ? "" : ` (code ${code})`
      }`,
      response.status,
      code,
    );
  }

  function assertKeyShape(key: string): void {
    if (!KEY_PATTERN.test(key)) {
      throw new S3ObjectStoreError(
        "object key rejected: keys are 1-900 chars of [A-Za-z0-9._-/] with a safe start (got 901)",
        0,
        null,
      );
    }
  }

  return {
    async put(key: string, body: Uint8Array, options?: PutOptions): Promise<void> {
      assertKeyShape(key);
      const response = await signedFetch({
        method: "PUT",
        path: `/${config.bucket}/${encodeKeyPath(key)}`,
        body,
        contentType: options?.contentType,
      });
      if (response.status !== 200 && response.status !== 201) {
        await failClosed(response, `put ${key}`);
      }
    },

    async get(key: string): Promise<StoredObject | null> {
      assertKeyShape(key);
      const response = await signedFetch({
        method: "GET",
        path: `/${config.bucket}/${encodeKeyPath(key)}`,
      });
      if (response.status === 404) {
        return null;
      }
      if (response.status !== 200) {
        await failClosed(response, `get ${key}`);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        key,
        body: bytes,
        contentType: response.headers.get("content-type") ?? undefined,
      };
    },

    async delete(key: string): Promise<void> {
      assertKeyShape(key);
      const response = await signedFetch({
        method: "DELETE",
        path: `/${config.bucket}/${encodeKeyPath(key)}`,
      });
      // S3 DELETE is idempotent: a missing object is success (204).
      if (response.status !== 204 && response.status !== 200 && response.status !== 404) {
        await failClosed(response, `delete ${key}`);
      }
    },

    presignGetObject(key: string, expiresInSeconds: number): string {
      assertKeyShape(key);
      const context = signingContext();
      const { query } = presignedUrlQuery(
        {
          method: "GET",
          canonicalUri: `/${config.bucket}/${encodeKeyPath(key)}`,
          canonicalQuery: "",
          headers: { host: endpointUrl().host },
          expiresInSeconds,
        },
        context,
      );
      return `${config.endpoint}/${config.bucket}/${encodeKeyPath(key)}?${query}`;
    },

    presignPutObject(key: string, expiresInSeconds: number, contentType?: string): string {
      assertKeyShape(key);
      const context = signingContext();
      const headers: Record<string, string> = { host: endpointUrl().host };
      if (contentType !== undefined) {
        headers["content-type"] = contentType;
      }
      const { query } = presignedUrlQuery(
        {
          method: "PUT",
          canonicalUri: `/${config.bucket}/${encodeKeyPath(key)}`,
          canonicalQuery: "",
          headers,
          expiresInSeconds,
        },
        context,
      );
      return `${config.endpoint}/${config.bucket}/${encodeKeyPath(key)}?${query}`;
    },

    async headBucket(): Promise<{ readonly status: number; readonly ok: boolean }> {
      const response = await signedFetch({
        method: "HEAD",
        path: `/${config.bucket}`,
      });
      return { status: response.status, ok: response.status === 200 };
    },
  };
}
