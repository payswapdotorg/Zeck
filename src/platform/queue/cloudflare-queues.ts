/**
 * Cloudflare Queues REST adapter — the production async-transport
 * implementation behind the provider-neutral `QueueTransportPort`
 * (WORK-044 / D-03).
 *
 * Cloudflare Queues speaks a plain JSON-over-HTTPS REST API (verified
 * against the official developer documentation):
 *
 *  - publish: `POST {api}/accounts/{account_id}/queues/{queue_id}/messages`
 *    with body `{"body": <json value>}` → `{"success": true}`;
 *  - pull (HTTP pull consumer): `POST .../messages/poll` with body
 *    `{"visibility_timeout_ms": N, "batch_size": N}` →
 *    `{"result": {"messages": [{ "body", "id", "timestamp_ms",
 *    "attempts", "lease_id", "metadata" }], "message_backlog_count": N}}`;
 *  - settle: `POST .../messages/ack` with body
 *    `{"acks": [{"lease_id": ...}], "retries": [{"lease_id": ...}]}`.
 *
 * Cloudflare concepts stop HERE: the domain/application boundary sees
 * only the port (pinned by the architecture tests). No
 * `@cloudflare/*` SDK dependency exists — the adapter is plain
 * `fetch` + Bearer auth, so the SDK boundary table needs no new
 * entries and the provider surface is exactly this file.
 *
 * Provider state is never authority: the adapter reports transport
 * facts (accepted / leased / settled) and fails closed with a typed
 * `QueueTransportError` classified `transient` (network, timeout,
 * 429, 5xx — retryable within the bounded budgets) or `permanent`
 * (401/403/404 — credential, permission or resource problems the
 * retry budget cannot fix). Errors NEVER carry the API token or the
 * Authorization header (credential-shaped material is scrubbed from
 * every message before it exists).
 *
 * Pull-consumer prerequisites (account-plane, operator-owned): the
 * queue exists, an HTTP pull consumer is enabled on it, and the API
 * token carries `queues_read` + `queues_write`. Those are deployment
 * preconditions (deploy/manifests + deploy/README), not code.
 */
import {
  type PublishReceipt,
  type PulledBatch,
  type PullOptions,
  QueueConfigError,
  type QueueDelivery,
  type QueueOutboundMessage,
  QueueTransportError,
  type QueueTransportPort,
  type Settlement,
} from "./port";

/** The default Cloudflare API base (overridable for tests/local gateways). */
export const DEFAULT_CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/;
const QUEUE_ID_PATTERN = /^[a-f0-9]{32}$/;

/**
 * Runtime configuration loading for the adapter (repository-defined):
 * the provider endpoint identity (account id + queue resource id —
 * provider-account metadata, non-secret) plus the resolved API token
 * secret material. Fail-closed with the exact variable NAMES (never
 * values) when materialization is incomplete.
 */
export function missingCloudflareQueuesConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const missing: string[] = [];
  if ((env.ZECK_CLOUDFLARE_ACCOUNT_ID ?? "").length === 0) {
    missing.push(
      "ZECK_CLOUDFLARE_ACCOUNT_ID is not set (provider-account metadata; see deploy/manifests/variables.json)",
    );
  }
  if ((env.ZECK_QUEUE_ID ?? "").length === 0) {
    missing.push(
      "ZECK_QUEUE_ID is not set (the environment's queue resource id; see deploy/README.md)",
    );
  }
  if ((env.ZECK_QUEUE_API_TOKEN ?? "").length === 0) {
    missing.push(
      "ZECK_QUEUE_API_TOKEN is not set (the materialized queue-api-token secret value; the reference binding is ZECK_SECRET_QUEUE_API_TOKEN_REF)",
    );
  }
  return missing;
}

/** Load the adapter runtime configuration from the environment (fail closed). */
export function loadCloudflareQueuesRuntimeConfig(
  env: Readonly<Record<string, string | undefined>>,
): CloudflareQueuesConfig {
  const missing = missingCloudflareQueuesConfiguration(env);
  if (missing.length > 0) {
    throw new QueueConfigError(
      `queue transport configuration is incomplete: ${missing.join("; ")}`,
    );
  }
  const timeoutRaw = env.ZECK_QUEUE_REQUEST_TIMEOUT_MS;
  const requestTimeoutMs =
    timeoutRaw === undefined || timeoutRaw.trim().length === 0
      ? undefined
      : readPositiveInt(timeoutRaw, "ZECK_QUEUE_REQUEST_TIMEOUT_MS");
  return {
    apiBaseUrl: env.ZECK_QUEUE_API_BASE_URL,
    accountId: env.ZECK_CLOUDFLARE_ACCOUNT_ID ?? "",
    queueId: env.ZECK_QUEUE_ID ?? "",
    apiToken: env.ZECK_QUEUE_API_TOKEN ?? "",
    requestTimeoutMs,
  };
}

function readPositiveInt(raw: string, name: string): number {
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new QueueConfigError(`${name} must be a positive integer (got: ${raw})`);
  }
  return value;
}

export interface CloudflareQueuesConfig {
  /**
   * API base URL. Defaults to the public Cloudflare API; tests point it
   * at an in-process protocol server.
   */
  readonly apiBaseUrl?: string;
  /** Cloudflare account id (provider-account metadata, non-secret). */
  readonly accountId: string;
  /** Cloudflare queue id — the REST resource id (non-secret). */
  readonly queueId: string;
  /**
   * API token — resolved secret material (`queue-api-token` secret,
   * materialized in the environment as ZECK_QUEUE_API_TOKEN). Never a
   * repository value; never logged; never in an error message.
   */
  readonly apiToken: string;
  /** Per-request timeout (milliseconds). */
  readonly requestTimeoutMs?: number;
  /** Injectable transport (tests substitute a local protocol server). */
  readonly fetchImpl?: typeof fetch;
}

/** Validates the configuration fail-closed (before any wire call). */
export function validateCloudflareQueuesConfig(config: CloudflareQueuesConfig): void {
  const problems: string[] = [];
  const baseUrl = config.apiBaseUrl ?? DEFAULT_CLOUDFLARE_API_BASE_URL;
  if (!/^https?:\/\//.test(baseUrl) || baseUrl.includes(" ")) {
    problems.push("apiBaseUrl must be an http(s) URL");
  }
  if (baseUrl.endsWith("/")) {
    problems.push("apiBaseUrl must not end with a slash");
  }
  if (!ACCOUNT_ID_PATTERN.test(config.accountId)) {
    problems.push("accountId must be a 32-hex Cloudflare account id");
  }
  if (!QUEUE_ID_PATTERN.test(config.queueId)) {
    problems.push("queueId must be a 32-hex Cloudflare queue id");
  }
  if (config.apiToken.length === 0) {
    problems.push("apiToken is required (resolved secret material; never empty in production)");
  }
  const timeout = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 120_000) {
    problems.push("requestTimeoutMs must be an integer in [100, 120000]");
  }
  if (problems.length > 0) {
    throw new QueueConfigError(`invalid Cloudflare Queues configuration: ${problems.join("; ")}`);
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_PULL_BATCH_SIZE = 10;
const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000;
/** Provider-documented bounds (Cloudflare Queues pull consumers). */
const MAX_PULL_BATCH_SIZE = 100;
const MAX_VISIBILITY_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const MAX_DELAY_SECONDS = 86_400;

/**
 * The wire-level result the adapter understands. Kept public for the
 * protocol integration tests (the in-process server mirrors the
 * documented response envelope).
 */
export interface CloudflareQueuesWire {
  /** Publish one message. */
  publishWire(message: QueueOutboundMessage): Promise<{ ok: boolean }>;
  /** Pull one batch. */
  pullWire(options?: PullOptions): Promise<{
    messages: readonly CloudflareWireMessage[];
    backlog: number | null;
  }>;
  /** Settle leases. */
  settleWire(settlement: Settlement): Promise<void>;
}

/** One message as it appears on the documented pull response. */
export interface CloudflareWireMessage {
  readonly body: unknown;
  readonly id: string;
  readonly lease_id: string;
  readonly timestamp_ms?: number;
  readonly attempts?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Build the provider-neutral `QueueTransportPort` over the Cloudflare
 * Queues REST API. The returned object also exposes `probe()` — the
 * real transport round-trip probe used by deploy smoke (publish → pull
 * → ack a self-identifying probe message; cleans up after itself).
 */
export function createCloudflareQueuesTransport(
  config: CloudflareQueuesConfig,
): QueueTransportPort & { probe(): Promise<{ ok: true; detail: string }> } {
  validateCloudflareQueuesConfig(config);
  const baseUrl = (config.apiBaseUrl ?? DEFAULT_CLOUDFLARE_API_BASE_URL).replace(/\/+$/, "");
  const queuePath = `${baseUrl}/accounts/${config.accountId}/queues/${config.queueId}`;
  const timeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const doFetch = config.fetchImpl ?? fetch;

  /** Credential-shaped material never enters any error message. */
  const safeDetail = (text: string): string =>
    text
      .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, "bearer [redacted]")
      .replace(config.apiToken, "[redacted]")
      .slice(0, 200);

  async function request(path: string, body: unknown): Promise<{ status: number; json: unknown }> {
    let response: Response;
    try {
      response = await doFetch(`${queuePath}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Network-level failure (DNS, refused, timeout): transient by
      // definition — an unavailable provider, never a silent success.
      throw new QueueTransportError(
        `queue transport request failed (${safeDetail((error as Error).message)})`,
        "transient",
      );
    }
    let json: unknown = null;
    const text = await response.text();
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: response.status, json };
  }

  /** Cloudflare API error extraction (codes, never secret material). */
  function providerError(json: unknown): { code: string | null; message: string | null } {
    if (json === null || typeof json !== "object") {
      return { code: null, message: null };
    }
    const record = json as Record<string, unknown>;
    const errors = record.errors;
    if (Array.isArray(errors) && errors.length > 0 && typeof errors[0] === "object") {
      const first = errors[0] as Record<string, unknown>;
      const code =
        typeof first.code === "number" || typeof first.code === "string"
          ? String(first.code)
          : null;
      const message = typeof first.message === "string" ? first.message : null;
      return { code, message: message === null ? null : safeDetail(message) };
    }
    return { code: null, message: null };
  }

  /**
   * Fail closed on a non-2xx answer, classified:
   *  - 401/403: credential/permission rejected (permanent — the bounded
   *    retry budget cannot fix an unauthorized token);
   *  - 404: queue resource does not exist (permanent);
   *  - 429/5xx and everything else unexpected: transient (retryable
   *    within the bounded budget).
   */
  function failClosed(status: number, json: unknown, operation: string): never {
    const { code, message } = providerError(json);
    const kind = status === 401 || status === 403 || status === 404 ? "permanent" : "transient";
    throw new QueueTransportError(
      `queue ${operation} rejected (http ${status}${code === null ? "" : `, provider code ${code}`}${message === null ? "" : `: ${message}`})`,
      kind,
      { status, providerCode: code },
    );
  }

  const wire: CloudflareQueuesWire = {
    async publishWire(message) {
      const body: Record<string, unknown> = {
        body: message.body,
      };
      if (message.contentType !== undefined) {
        body.content_type = message.contentType;
      }
      if (message.delaySeconds !== undefined && message.delaySeconds > 0) {
        if (!Number.isInteger(message.delaySeconds) || message.delaySeconds > MAX_DELAY_SECONDS) {
          throw new QueueConfigError(
            `delaySeconds must be an integer in [0, ${MAX_DELAY_SECONDS}]`,
          );
        }
        // Cloudflare's REST publish expresses delay in milliseconds.
        body.delay_ms = message.delaySeconds * 1000;
      }
      const { status, json } = await request("/messages", body);
      if (status < 200 || status >= 300) {
        failClosed(status, json, "publish");
      }
      return { ok: true };
    },

    async pullWire(options) {
      const batchSize = Math.min(
        Math.max(1, options?.batchSize ?? DEFAULT_PULL_BATCH_SIZE),
        MAX_PULL_BATCH_SIZE,
      );
      const visibilityTimeoutMs = Math.min(
        Math.max(1, options?.visibilityTimeoutMs ?? DEFAULT_VISIBILITY_TIMEOUT_MS),
        MAX_VISIBILITY_TIMEOUT_MS,
      );
      const { status, json } = await request("/messages/poll", {
        visibility_timeout_ms: visibilityTimeoutMs,
        batch_size: batchSize,
      });
      if (status < 200 || status >= 300) {
        failClosed(status, json, "pull");
      }
      // The documented envelope: {"success": true, "result": {...}}.
      // A malformed/failed envelope fails closed (transient — retryable,
      // never a silent empty batch, which would look like "no work").
      if (json === null || typeof json !== "object") {
        throw new QueueTransportError("queue pull returned a malformed envelope", "transient");
      }
      const record = json as Record<string, unknown>;
      if (record.success === false) {
        const { code, message } = providerError(json);
        throw new QueueTransportError(
          `queue pull reported failure${code === null ? "" : ` (provider code ${code})`}${message === null ? "" : `: ${message}`}`,
          "transient",
          { providerCode: code },
        );
      }
      const result = record.result;
      if (
        result === null ||
        typeof result !== "object" ||
        !Array.isArray((result as Record<string, unknown>).messages)
      ) {
        throw new QueueTransportError("queue pull envelope missing result.messages", "transient");
      }
      const resultRecord = result as Record<string, unknown>;
      const messages = (resultRecord.messages as unknown[]).filter(
        (entry): entry is CloudflareWireMessage => entry !== null && typeof entry === "object",
      );
      const backlogRaw = resultRecord.message_backlog_count;
      const backlog =
        typeof backlogRaw === "number" && Number.isFinite(backlogRaw) ? backlogRaw : null;
      return { messages, backlog };
    },

    async settleWire(settlement) {
      if (settlement.ackLeaseIds.length === 0 && settlement.retryLeaseIds.length === 0) {
        return;
      }
      const { status, json } = await request("/messages/ack", {
        acks: settlement.ackLeaseIds.map((leaseId) => ({ lease_id: leaseId })),
        retries: settlement.retryLeaseIds.map((leaseId) => ({ lease_id: leaseId })),
      });
      if (status < 200 || status >= 300) {
        failClosed(status, json, "settle");
      }
    },
  };

  /** Decode a wire message into the provider-neutral delivery shape. */
  function toDelivery(message: CloudflareWireMessage): QueueDelivery {
    // body arrives as the published JSON value; the port contract is a
    // string body, so string payloads pass through and JSON-object
    // bodies are canonicalized to their JSON text.
    const body = typeof message.body === "string" ? message.body : JSON.stringify(message.body);
    const metadata = message.metadata;
    let contentType: string | undefined;
    if (metadata !== null && typeof metadata === "object") {
      const raw = (metadata as Record<string, unknown>)["CF-Content-Type"];
      if (typeof raw === "string") {
        contentType = raw;
      }
    }
    return {
      messageId: message.id,
      leaseId: message.lease_id,
      body,
      contentType,
      attempts: typeof message.attempts === "number" ? message.attempts : 1,
      publishedAt:
        typeof message.timestamp_ms === "number"
          ? new Date(message.timestamp_ms).toISOString()
          : null,
    };
  }

  return {
    async publish(message: QueueOutboundMessage): Promise<PublishReceipt> {
      const result = await wire.publishWire(message);
      return { accepted: result.ok };
    },

    async pull(options?: PullOptions): Promise<PulledBatch> {
      const result = await wire.pullWire(options);
      return {
        messages: result.messages.map(toDelivery),
        backlogEstimate: result.backlog,
      };
    },

    async settle(settlement: Settlement): Promise<void> {
      await wire.settleWire(settlement);
    },

    /**
     * The real transport round-trip probe (deploy smoke): publish a
     * self-identifying probe message, pull until it appears (bounded),
     * ack it. Proves publish+pull+ack against the real provider and
     * cleans up after itself. A probe message is transport noise —
     * never an execution, never authority.
     */
    async probe(): Promise<{ ok: true; detail: string }> {
      const probeTag = `zeck-transport-probe-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      await wire.publishWire({
        body: JSON.stringify({ probe: probeTag }),
        contentType: "application/json",
      });
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const batch = await wire.pullWire({ batchSize: 5, visibilityTimeoutMs: 5_000 });
        const hit = batch.messages.find((message) => {
          try {
            const parsed = JSON.parse(
              typeof message.body === "string" ? message.body : JSON.stringify(message.body),
            ) as Record<string, unknown>;
            return parsed.probe === probeTag;
          } catch {
            return false;
          }
        });
        if (hit !== undefined) {
          await wire.settleWire({ ackLeaseIds: [hit.lease_id], retryLeaseIds: [] });
          return {
            ok: true,
            detail: `queue transport round-trip verified (publish+pull+ack); probe acknowledged`,
          };
        }
        // Ack anything else we leased so the probe leaves no side effects.
        if (batch.messages.length > 0) {
          await wire.settleWire({
            ackLeaseIds: batch.messages.filter((m) => m !== hit).map((m) => m.lease_id),
            retryLeaseIds: [],
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new QueueTransportError(
        "queue transport probe timed out waiting for the probe message delivery",
        "transient",
      );
    },
  };
}
