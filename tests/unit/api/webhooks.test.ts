/**
 * Webhook delivery tests (WORK-015 / API-004; M8/M9/M10).
 *
 * Required-test mapping:
 *  - the envelope carries the FULL identity set: event schema version,
 *    execution, event identity, type, sequence, attempt, timestamps;
 *  - EVERY delivery is signed (M9): HMAC-SHA256 over the documented
 *    signature basis — the SDK's verification helper round-trips it;
 *  - tampered payloads FAIL verification (M9);
 *  - retry semantics: failed deliveries retry up to the bound; each
 *    attempt increments the attempt field (M10);
 *  - the signing secret never appears in the payload or headers (M8);
 *  - receiver idempotency guidance: the dedupe key is the event id.
 */

import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
import { verifyWebhookSignature, webhookDedupeKey, webhookSignatureBasis } from "../../../sdk";
import {
  buildWebhookEvent,
  deliverWebhookEvent,
  signWebhookEvent,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  type WebhookTransport,
} from "../../../src/api";
import type { EventEnvelope } from "../../../src/modules/executions/public";

const SECRET = "whsec_test_endpoint_secret";

function envelope(over: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    eventId: "00000000-0000-7000-8000-0000000000e1",
    executionId: "00000000-0000-7000-8000-0000000000d1",
    applicationId: "00000000-0000-7000-8000-0000000000a1",
    tenantId: "00000000-0000-7000-8000-0000000000b1",
    type: "execution.completed",
    sequence: 7,
    occurredAt: "2026-09-15T12:00:07Z",
    command: "pass",
    actor: { actorId: "actor-1", tenantId: "00000000-0000-7000-8000-0000000000b1" },
    cause: "verification",
    reference: {},
    payload: { costMicroUsd: "1250", summary: "done" },
    producerModule: "executions",
    schemaVersion: 1,
    ...over,
  };
}

describe("the webhook envelope (API-004 identity set)", () => {
  test("carries the event schema version, identities, attempt and timestamps", () => {
    const event = buildWebhookEvent(envelope(), 2, "2026-09-15T12:00:09Z");
    expect(event.schemaVersion).toBe(1);
    expect(event.executionId).toBe("00000000-0000-7000-8000-0000000000d1");
    expect(event.eventId).toBe("00000000-0000-7000-8000-0000000000e1");
    expect(event.type).toBe("execution.completed");
    expect(event.sequence).toBe(7);
    expect(event.attempt).toBe(2);
    expect(event.occurredAt).toBe("2026-09-15T12:00:07Z");
    expect(event.deliveredAt).toBe("2026-09-15T12:00:09Z");
    expect(event.payload).toEqual({ costMicroUsd: "1250", summary: "done" });
  });

  test("M8: secret-shaped payload keys are scrubbed before delivery", () => {
    const event = buildWebhookEvent(
      envelope({ payload: { apiKey: "super-secret-value", ok: "fine" } }),
      1,
      "2026-09-15T12:00:09Z",
    );
    expect(event.payload).toEqual({ apiKey: "[redacted]", ok: "fine" });
    expect(JSON.stringify(event)).not.toContain("super-secret-value");
  });
});

describe("webhook signatures (M9 — every delivery signed)", () => {
  test("the signature verifies through the SDK helper (the documented basis)", async () => {
    const event = buildWebhookEvent(envelope(), 1, "2026-09-15T12:00:09Z");
    const signature = signWebhookEvent(event, SECRET);
    expect(await verifyWebhookSignature(event, signature, SECRET)).toBe(true);
  });

  test("a tampered payload FAILS verification", async () => {
    const event = buildWebhookEvent(envelope(), 1, "2026-09-15T12:00:09Z");
    const signature = signWebhookEvent(event, SECRET);
    const tampered = { ...event, payload: { ...event.payload, costMicroUsd: "0" } };
    expect(await verifyWebhookSignature(tampered, signature, SECRET)).toBe(false);
  });

  test("the signature basis is exactly the documented canonical serialization", () => {
    const event = buildWebhookEvent(envelope(), 3, "2026-09-15T12:00:09Z");
    expect(webhookSignatureBasis(event)).toBe(
      JSON.stringify({
        schemaVersion: event.schemaVersion,
        executionId: event.executionId,
        eventId: event.eventId,
        type: event.type,
        sequence: event.sequence,
        attempt: event.attempt,
        occurredAt: event.occurredAt,
        deliveredAt: event.deliveredAt,
        payload: event.payload,
      }),
    );
    // The secret NEVER appears in the basis or the payload.
    expect(webhookSignatureBasis(event)).not.toContain(SECRET);
  });

  test("independent HMAC computation agrees (the basis is unambiguous)", () => {
    const event = buildWebhookEvent(envelope(), 1, "2026-09-15T12:00:09Z");
    const expected = createHmac("sha256", SECRET)
      .update(webhookSignatureBasis(event), "utf8")
      .digest("hex");
    expect(signWebhookEvent(event, SECRET)).toBe(expected);
  });
});

describe("delivery with retry (M10 — attempt accounting)", () => {
  function recordingTransport(
    outcomes: readonly { ok: boolean; status: number }[],
  ): WebhookTransport & {
    readonly calls: { url: string; body: string; headers: Record<string, string> }[];
  } {
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    let index = 0;
    const transport: WebhookTransport = async (url, body, headers) => {
      calls.push({ url, body, headers });
      const outcome = outcomes[Math.min(index, outcomes.length - 1)] ?? { ok: true, status: 200 };
      index += 1;
      return outcome;
    };
    return Object.assign(transport, { calls });
  }

  test("a first-attempt success delivers once with the signature headers", async () => {
    const transport = recordingTransport([{ ok: true, status: 200 }]);
    const result = await deliverWebhookEvent(
      envelope(),
      { url: "https://customer.example/hook", secret: SECRET },
      transport,
      { backoffMs: 0, sleep: async () => {} },
    );
    expect(result.delivered).toBe(true);
    expect(result.attempt).toBe(1);
    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0];
    expect(call?.headers[WEBHOOK_SIGNATURE_HEADER]).toMatch(/^[0-9a-f]{64}$/);
    expect(call?.headers[WEBHOOK_EVENT_ID_HEADER]).toBe("00000000-0000-7000-8000-0000000000e1");
    expect(call?.headers["content-type"]).toBe("application/json");
  });

  test("failed deliveries retry up to the bound; the attempt field increments", async () => {
    const transport = recordingTransport([
      { ok: false, status: 500 },
      { ok: false, status: 500 },
      { ok: true, status: 200 },
    ]);
    const result = await deliverWebhookEvent(
      envelope(),
      { url: "https://customer.example/hook", secret: SECRET },
      transport,
      { maxAttempts: 3, backoffMs: 0, sleep: async () => {} },
    );
    expect(result.delivered).toBe(true);
    expect(result.attempt).toBe(3);
    expect(transport.calls).toHaveLength(3);
    const attempts = transport.calls.map((call) => {
      const body = JSON.parse(call.body) as { attempt: number };
      return body.attempt;
    });
    expect(attempts).toEqual([1, 2, 3]);
  });

  test("exhausted retries report the final failure honestly", async () => {
    const transport = recordingTransport([{ ok: false, status: 500 }]);
    const result = await deliverWebhookEvent(
      envelope(),
      { url: "https://customer.example/hook", secret: SECRET },
      transport,
      { maxAttempts: 2, backoffMs: 0, sleep: async () => {} },
    );
    expect(result.delivered).toBe(false);
    expect(result.attempt).toBe(2);
    expect(result.status).toBe(500);
  });

  test("M8: the signing secret never crosses the delivery surface", async () => {
    const transport = recordingTransport([{ ok: true, status: 200 }]);
    await deliverWebhookEvent(
      envelope(),
      { url: "https://customer.example/hook", secret: SECRET },
      transport,
      { backoffMs: 0, sleep: async () => {} },
    );
    for (const call of transport.calls) {
      expect(JSON.stringify(call.headers)).not.toContain(SECRET);
      expect(call.body).not.toContain(SECRET);
    }
  });

  test("M10: the receiver dedupe key is the durable event identity", () => {
    const event = buildWebhookEvent(envelope(), 1, "2026-09-15T12:00:09Z");
    const replay = buildWebhookEvent(envelope(), 2, "2026-09-15T12:01:00Z");
    expect(webhookDedupeKey(event)).toBe(webhookDedupeKey(replay));
    expect(webhookDedupeKey(event)).toBe(event.eventId);
  });
});
