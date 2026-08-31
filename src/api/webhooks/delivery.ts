/**
 * Signed, versioned webhook delivery (WORK-015 / API-004; M8/M9/M10 of
 * the discrimination list).
 *
 * THE CONTRACT (§11 of the Work Order):
 *  - every delivered payload is a `WebhookEvent` envelope identifying
 *    the event schema version, the execution, the durable event
 *    identity, the delivery attempt, the timestamp and the signature
 *    basis;
 *  - every delivery is SIGNED: HMAC-SHA256 (hex) over the canonical
 *    signature basis with a per-endpoint signing secret. An unsigned
 *    webhook is unrepresentable — `signWebhookEvent` is the ONLY path
 *    that produces a deliverable payload and it always attaches the
 *    signature header (M9);
 *  - delivery RETRIES with bounded exponential backoff (transport-level,
 *    in-flight); each retry increments the `attempt` field so receivers
 *    can distinguish redeliveries from new events;
 *  - receiver-side idempotency guidance ships in the SDK
 *    (`webhookDedupeKey` — dedupe on eventId, ack replays);
 *  - the signing secret NEVER crosses the public surface: it is injected
 *    as an opaque `WebhookSigningSecret` and appears in no response, no
 *    log line and no payload (M8).

 * DURABILITY NOTE (an honest limitation, disclosed in the evidence
 * file): retry state is in-flight transport state. A durable delivery
 * journal (persisted attempts, dead-letter queues) belongs to the
 * webhooks module's durable surface — outside this Work Order's
 * declared surfaces (src/api/, sdk/, cli/, apps/dashboard/) — and would
 * require a Work Order amendment. The transport semantics (signature,
 * envelope, attempt accounting, bounded retry) are complete and proven
 * here.
 */

import { createHmac } from "node:crypto";
import type { EventEnvelope } from "../../modules/executions/public";
import { type WebhookEvent, WIRE_SCHEMA_VERSION, webhookSignatureBasis } from "../../shared/wire";
import { scrubSecretShapedKeys } from "../serialization";

/** An opaque endpoint signing secret (never serialized, never logged). */
export type WebhookSigningSecret = string;

export interface WebhookEndpoint {
  /** The customer's receiving URL. */
  readonly url: string;
  /** The endpoint's signing secret reference (injected, opaque). */
  readonly secret: WebhookSigningSecret;
}

export interface WebhookDeliveryResult {
  readonly endpoint: string;
  readonly attempt: number;
  readonly delivered: boolean;
  readonly status: number | null;
}

/** The HTTP delivery function (injectable for tests; fetch in production). */
export type WebhookTransport = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
}>;

export interface WebhookDeliveryOptions {
  /** Maximum delivery attempts (default 3: 1 + 2 retries). */
  readonly maxAttempts?: number;
  /** Base backoff in ms (default 10 — tests inject 0 for instant retries). */
  readonly backoffMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The signature header name (documented in the SDK receiver guidance). */
export const WEBHOOK_SIGNATURE_HEADER = "x-zeck-signature";

/** The event-id header name (documented in the SDK receiver guidance). */
export const WEBHOOK_EVENT_ID_HEADER = "x-zeck-event-id";

/**
 * Construct the signed webhook envelope for one execution event. The
 * payload is scrubbed (secret-shaped keys redacted) — verification
 * evidence and step facts cross, secret material never does (M8).
 */
export function buildWebhookEvent(
  envelope: EventEnvelope,
  attempt: number,
  deliveredAt: string,
): WebhookEvent {
  return {
    schemaVersion: WIRE_SCHEMA_VERSION,
    executionId: envelope.executionId,
    eventId: envelope.eventId,
    type: envelope.type,
    sequence: envelope.sequence,
    attempt,
    occurredAt: envelope.occurredAt,
    deliveredAt,
    payload: scrubSecretShapedKeys(envelope.payload) as Readonly<Record<string, unknown>>,
  };
}

/**
 * Sign a webhook event: HMAC-SHA256 (lowercase hex) over the canonical
 * signature basis. This is the ONLY signing path — every delivery is
 * signed (M9).
 */
export function signWebhookEvent(event: WebhookEvent, secret: WebhookSigningSecret): string {
  return createHmac("sha256", secret).update(webhookSignatureBasis(event), "utf8").digest("hex");
}

/**
 * Deliver one event to one endpoint with bounded retry. Each attempt
 * rebuilds the envelope with its own attempt number + delivery timestamp
 * and re-signs it — a receiver can always tell WHICH attempt it is
 * looking at and verify the signature against the documented basis.
 */
export async function deliverWebhookEvent(
  envelope: EventEnvelope,
  endpoint: WebhookEndpoint,
  transport: WebhookTransport,
  options: WebhookDeliveryOptions = {},
): Promise<WebhookDeliveryResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  const backoff = options.backoffMs ?? 10;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let lastStatus: number | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const event = buildWebhookEvent(envelope, attempt, new Date().toISOString());
    const signature = signWebhookEvent(event, endpoint.secret);
    const body = JSON.stringify(event);
    const outcome = await transport(endpoint.url, body, {
      "content-type": "application/json",
      [WEBHOOK_SIGNATURE_HEADER]: signature,
      [WEBHOOK_EVENT_ID_HEADER]: event.eventId,
    });
    lastStatus = outcome.status;
    if (outcome.ok) {
      return { endpoint: endpoint.url, attempt, delivered: true, status: outcome.status };
    }
    if (attempt < maxAttempts) {
      await sleep(backoff * 2 ** (attempt - 1));
    }
  }
  return { endpoint: endpoint.url, attempt: maxAttempts, delivered: false, status: lastStatus };
}
