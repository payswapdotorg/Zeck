/**
 * The signed-webhook RECEIVER example (DEP-020 / API-004 / M9 / M10).
 *
 * One sentence: a minimal, production-shaped HTTP receiver that (1)
 * verifies the HMAC-SHA256 signature over the documented basis BEFORE
 * trusting anything, (2) dedupes on the durable eventId so every event
 * applies exactly once, and (3) acknowledges redeliveries without
 * re-applying effects.
 *
 * THE RULES THIS RECEIVER MODELS:
 *  - an UNSIGNED webhook is never trusted — reject with 401;
 *  - the signature is HMAC-SHA256 (hex) over the canonical signature
 *    basis (see webhookSignatureBasis in src/shared/wire.ts), delivered
 *    in the x-zeck-signature header, with the event id in
 *    x-zeck-event-id;
 *  - receiver-side idempotency keys on eventId (webhookDedupeKey):
 *    later attempts of the SAME eventId are replays — ack them, do not
 *    re-apply effects; the `attempt` field distinguishes redeliveries
 *    from new events;
 *  - the signing secret arrives out-of-band (here: the environment
 *    variable ZECK_WEBHOOK_SECRET) — never in a URL, never logged.
 *
 * Classification: runnable (signature verification is exercised
 * end-to-end in the documentation battery against the platform's own
 * signing path).
 *
 * Run it (from the repository root):
 *   ZECK_WEBHOOK_SECRET=… ZECK_WEBHOOK_PORT=9090 bun run examples/webhook-receiver.ts
 *   curl -X POST localhost:9090/webhooks/zeck -H 'content-type: application/json' \
 *     -H 'x-zeck-signature: <hex>' -H 'x-zeck-event-id: <eventId>' -d @event.json
 */

import { createServer } from "node:http";
import { verifyWebhookSignature, type WebhookEvent, webhookDedupeKey } from "../sdk";
import { coreEnvVars, type ExampleMeta } from "./lib/env";
import { runWhenInvoked } from "./lib/run";

export const EXAMPLE: ExampleMeta = {
  name: "webhook-receiver",
  family: "workflow",
  title: "Webhooks — signature-verifying, idempotent receiver",
  classification: { kind: "runnable" },
  envVars: [...coreEnvVars(["ZECK_WEBHOOK_SECRET", "ZECK_WEBHOOK_PORT"])],
};

/** The receiver's durable event memory (a real receiver persists this). */
export class EventMemory {
  private readonly applied = new Set<string>();

  /** Returns true when the eventId is NEW (apply effects), false on replay. */
  markApplied(eventId: string): boolean {
    if (this.applied.has(eventId)) {
      return false;
    }
    this.applied.add(eventId);
    return true;
  }

  size(): number {
    return this.applied.size;
  }
}

export interface WebhookResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * Handle ONE webhook delivery: verify the signature first, then dedupe.
 * Exported so the documentation battery exercises the exact receiver
 * logic against the platform's own signing path.
 */
export async function handleWebhookDelivery(
  request: {
    readonly body: string;
    readonly signatureHex: string;
    readonly eventIdHeader: string | null;
  },
  secret: string,
  memory: EventMemory,
): Promise<WebhookResponse> {
  // 1. Parse the envelope. The body IS the signed bytes' source — the
  //    signature basis is a canonical re-serialization of the envelope
  //    fields (schemaVersion, executionId, eventId, type, sequence,
  //    attempt, occurredAt, deliveredAt, payload).
  let event: WebhookEvent;
  try {
    event = JSON.parse(request.body) as WebhookEvent;
  } catch {
    return { status: 400, body: "malformed JSON envelope" };
  }

  // 2. VERIFY BEFORE TRUSTING (M9): an unsigned webhook is never
  //    trusted. A bad signature is indistinguishable from an attack.
  const valid = await verifyWebhookSignature(event, request.signatureHex, secret);
  if (!valid) {
    return { status: 401, body: "invalid signature (unsigned webhooks are never trusted)" };
  }

  // 3. Header/event identity must agree (the x-zeck-event-id header).
  if (request.eventIdHeader !== null && request.eventIdHeader !== event.eventId) {
    return { status: 400, body: "event id header does not match the envelope" };
  }

  // 4. DEDUPE ON eventId (M10): apply effects exactly once. A later
  //    attempt of the SAME eventId is a replay — ack, do not re-apply.
  const dedupeKey = webhookDedupeKey(event);
  if (!memory.markApplied(dedupeKey)) {
    return {
      status: 202,
      body: `replay acknowledged (eventId ${dedupeKey}, attempt ${event.attempt})`,
    };
  }

  // 5. Apply the effect (here: log; a real receiver updates its state).
  console.log(
    `applied webhook event ${event.type} (execution ${event.executionId}, ` +
      `sequence ${event.sequence}, attempt ${event.attempt})`,
  );
  return { status: 202, body: `applied (eventId ${dedupeKey})` };
}

export async function main(): Promise<void> {
  const secret = process.env.ZECK_WEBHOOK_SECRET;
  if (secret === undefined || secret.length === 0) {
    throw new Error(
      "missing environment variable ZECK_WEBHOOK_SECRET — the endpoint's " +
        "signing secret arrives out-of-band; it is never embedded in code",
    );
  }
  const port = Number.parseInt(process.env.ZECK_WEBHOOK_PORT ?? "9090", 10);
  const memory = new EventMemory();

  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/webhooks/zeck") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const headers = req.headers as Record<string, string | string[] | undefined>;
      const signature = headers["x-zeck-signature"];
      const eventId = headers["x-zeck-event-id"];
      void handleWebhookDelivery(
        {
          body,
          signatureHex: Array.isArray(signature) ? (signature[0] ?? "") : (signature ?? ""),
          eventIdHeader: Array.isArray(eventId) ? (eventId[0] ?? null) : (eventId ?? null),
        },
        secret,
        memory,
      ).then((response) => {
        res.writeHead(response.status, { "content-type": "text/plain" });
        res.end(response.body);
      });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });
  console.log(
    `webhook receiver listening on http://127.0.0.1:${port}/webhooks/zeck ` +
      "(verify → dedupe → apply; replays acknowledged without re-application)",
  );
}

runWhenInvoked(import.meta.url, () => main());
