/**
 * A minimal in-process S3-compatible server for the D-02 object-store
 * integration tests (WORK-043).
 *
 * This is NOT R2 — it is a local, deterministic stand-in that speaks
 * the S3 REST surface Zeck's adapter uses and VERIFIES every
 * request's SigV4 signature (header auth AND query auth/presigned),
 * so the adapter's wire behavior is proven end-to-end over real HTTP
 * without provider credentials. Real-R2 evidence is separately gated
 * (r2-live.test.ts) and never claimed from this server.
 *
 * Only the verbs the port needs: PUT/GET/DELETE object, HEAD bucket.
 * Authorization failures return the S3 XML error shape.
 */

import { createHash, createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface FakeS3Server {
  readonly port: number;
  readonly url: string;
  readonly bucket: string;
  close(): Promise<void>;
  /** Direct fixture access (tamper/set from tests). */
  readonly objects: Map<string, { body: Uint8Array; contentType: string | undefined }>;
}

export interface FakeS3Options {
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly region: string;
  /** Fail every request with 403 (credential-rejection path). */
  readonly rejectAll?: boolean;
  /** Pretend the bucket does not exist (404 path). */
  readonly bucketMissing?: boolean;
}

function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function uriEncode(value: string, encodeSlash = false): string {
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

/** Verify a request's SigV4 (header or query auth). Returns true/false. */
export function verifySignedRequest(request: {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly options: {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    service: string;
  };
}): boolean {
  const authorization = request.headers.authorization;
  const amzDate = request.headers["x-amz-date"];
  if (authorization !== undefined) {
    const match = /Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})/.exec(
      authorization,
    );
    if (match === null || amzDate === undefined) {
      return false;
    }
    const [, credential, signedHeaders, expectedSignature] = match;
    if (
      credential === undefined ||
      signedHeaders === undefined ||
      expectedSignature === undefined
    ) {
      return false;
    }
    const keyId = credential.split("/")[0];
    if (keyId !== request.options.accessKeyId) {
      return false;
    }
    const names = signedHeaders.split(";");
    const canonicalLines: string[] = [];
    for (const name of names) {
      const value = request.headers[name] ?? "";
      canonicalLines.push(`${name}:${value.trim()}\n`);
    }
    const payloadHash = request.headers["x-amz-content-sha256"] ?? sha256Hex(request.body);
    const canonicalRequest = [
      request.method.toUpperCase(),
      request.path,
      request.query,
      canonicalLines.join(""),
      signedHeaders,
      payloadHash,
    ].join("\n");
    const datestamp = amzDate.slice(0, 8);
    const scope = `${datestamp}/${request.options.region}/${request.options.service}/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join(
      "\n",
    );
    const kDate = createHmac("sha256", `AWS4${request.options.secretAccessKey}`)
      .update(datestamp)
      .digest();
    const kRegion = createHmac("sha256", kDate).update(request.options.region).digest();
    const kService = createHmac("sha256", kRegion).update(request.options.service).digest();
    const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
    const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
    return signature === expectedSignature;
  }
  // Query auth (presigned).
  const params = new URLSearchParams(request.query);
  if (params.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256") {
    return false;
  }
  const credential = params.get("X-Amz-Credential");
  const date = params.get("X-Amz-Date");
  const signedHeaders = params.get("X-Amz-SignedHeaders");
  const expectedSignature = params.get("X-Amz-Signature");
  if (
    credential === null ||
    date === null ||
    signedHeaders === null ||
    expectedSignature === null
  ) {
    return false;
  }
  if (credential.split("/")[0] !== request.options.accessKeyId) {
    return false;
  }
  const entries = [...params.entries()]
    .filter(([name]) => name !== "X-Amz-Signature")
    .map(([name, value]) => [uriEncode(name), uriEncode(value, true)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalQuery = entries.map(([name, value]) => `${name}=${value}`).join("&");
  const names = signedHeaders.split(";");
  const canonicalLines = names.map((name) => {
    const value = name === "host" ? (request.headers.host ?? "") : (request.headers[name] ?? "");
    return `${name}:${value.trim()}\n`;
  });
  const canonicalRequest = [
    request.method.toUpperCase(),
    request.path,
    canonicalQuery,
    canonicalLines.join(""),
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const datestamp = date.slice(0, 8);
  const scope = `${datestamp}/${request.options.region}/${request.options.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = createHmac("sha256", `AWS4${request.options.secretAccessKey}`)
    .update(datestamp)
    .digest();
  const kRegion = createHmac("sha256", kDate).update(request.options.region).digest();
  const kService = createHmac("sha256", kRegion).update(request.options.service).digest();
  const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return signature === expectedSignature;
}

export async function startFakeS3Server(options: FakeS3Options): Promise<FakeS3Server> {
  const objects = new Map<string, { body: Uint8Array; contentType: string | undefined }>();
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const path = decodeURIComponent(url.pathname);
      const query = url.search.startsWith("?") ? url.search.slice(1) : "";
      const body = await readBody(request);
      const headers = Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), String(value)]),
      );
      if (options.rejectAll === true) {
        respondXml(response, 403, "AccessDenied", "credentials rejected by the test server");
        return;
      }
      const verified = verifySignedRequest({
        method: request.method ?? "GET",
        path,
        query,
        headers,
        body,
        options: {
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey,
          region: options.region,
          service: "s3",
        },
      });
      if (!verified) {
        respondXml(
          response,
          403,
          "SignatureDoesNotMatch",
          "the test server could not verify the request signature",
        );
        return;
      }
      const bucket = path.split("/")[1] ?? "";
      if (bucket !== options.bucket || options.bucketMissing === true) {
        respondXml(
          response,
          404,
          "NoSuchBucket",
          `the bucket ${bucket} does not exist on the test server`,
        );
        return;
      }
      const key = path.split("/").slice(2).join("/");
      if (request.method === "HEAD") {
        response.writeHead(200).end();
        return;
      }
      if (request.method === "PUT") {
        objects.set(key, { body, contentType: headers["content-type"] });
        response.writeHead(200).end();
        return;
      }
      if (request.method === "GET") {
        const stored = objects.get(key);
        if (stored === undefined) {
          respondXml(response, 404, "NoSuchKey", `key ${key} not found`);
          return;
        }
        response.writeHead(200, {
          "content-type": stored.contentType ?? "application/octet-stream",
          "content-length": String(stored.body.byteLength),
        });
        response.end(Buffer.from(stored.body));
        return;
      }
      if (request.method === "DELETE") {
        objects.delete(key);
        response.writeHead(204).end();
        return;
      }
      respondXml(response, 400, "InvalidRequest", "unsupported method");
    })();
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    bucket: options.bucket,
    objects,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
      }),
  };
}

function readBody(request: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolveBody(Buffer.concat(chunks)));
    request.on("error", () => resolveBody(new Uint8Array(0)));
  });
}

function respondXml(response: ServerResponse, status: number, code: string, message: string): void {
  response.writeHead(status, { "content-type": "application/xml" });
  response.end(`<Error><Code>${code}</Code><Message>${message}</Message></Error>`);
}
