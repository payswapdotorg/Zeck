# Webhooks — signed delivery and the idempotent receiver

**One sentence:** Zeck pushes execution events to your endpoint as
signed, versioned `WebhookEvent` envelopes — HMAC-SHA256 over a
canonical basis — and your receiver MUST verify the signature before
trusting anything and dedupe on `eventId` so every event applies
exactly once.

## The delivery contract (nine-part treatment)

### 1. One-sentence explanation

Every delivery is a POST of a `WebhookEvent` envelope to your endpoint
with the signature in `x-zeck-signature` (hex HMAC-SHA256) and the
durable event id in `x-zeck-event-id`; deliveries retry with bounded
exponential backoff, each attempt re-signed with its own attempt
number.

### 2. Conceptual model

```text
WebhookEvent {
  schemaVersion, executionId, eventId, type, sequence,
  attempt (1 = first), occurredAt, deliveredAt, payload
}
```

- **Signed, always**: an unsigned webhook is unrepresentable —
  `signWebhookEvent` is the only path that produces a deliverable
  payload and it always attaches the signature header (M9).
- **The canonical signature basis** (the bytes that are signed): the
  JSON re-serialization of `{schemaVersion, executionId, eventId, type,
  sequence, attempt, occurredAt, deliveredAt, payload}` — exactly
  `webhookSignatureBasis(event)` in `src/shared/wire.ts`.
- **The signing secret** is per-endpoint, injected server-side, and
  NEVER crosses the public surface (no response, no log, no payload).
- **Receiver-side idempotency** (M10): the durable event identity is
  `eventId` — process each event EXACTLY ONCE keyed by it; later
  attempts of the SAME eventId are replays (ack, do not re-apply);
  `attempt` distinguishes redeliveries from new events.
- **Honest limitation** (recorded in the delivery contract itself):
  retry state is in-flight transport state; a durable delivery journal
  belongs to the webhooks module's durable surface.

### 3. Minimal receiver example

```typescript
import { verifyWebhookSignature, webhookDedupeKey, type WebhookEvent } from "../sdk";

const event = JSON.parse(body) as WebhookEvent;
const valid = await verifyWebhookSignature(event, request.headers["x-zeck-signature"], secret);
if (!valid) {
  return respond(401, "invalid signature (unsigned webhooks are never trusted)");
}
const key = webhookDedupeKey(event); // === event.eventId
if (alreadyApplied(key)) {
  return respond(202, "replay acknowledged");
}
applyEffects(event);
return respond(202, "applied");
```

### 4. SDK example (the full receiver)

The production-shaped receiver — verify → dedupe → apply, with the
HTTP server, the out-of-band secret (`ZECK_WEBHOOK_SECRET`) and replay
acknowledgment — is `examples/webhook-receiver.ts`
(`handleWebhookDelivery` is the testable core). The battery exercises
it against the platform's own signing path.

### 5. Request/response schemas

`WebhookEvent` is a frozen wire type (`src/shared/wire.ts`; machine
projection: [machine/openapi.json](machine/openapi.json) →
`WebhookEvent`). Headers: `x-zeck-signature` (lowercase hex),
`x-zeck-event-id`. Recommended receiver responses: `2xx` to
acknowledge (replays included); `401` on bad signatures; anything else
(or timeouts) is treated as a failed attempt and retried with backoff.

### 6. Expected lifecycle

Default retry policy: up to 3 attempts (1 + 2 retries) with bounded
exponential backoff; each attempt rebuilds the envelope with its own
`attempt` + `deliveredAt` and re-signs it — you can always tell WHICH
attempt you are looking at and verify it against the documented basis.

### 7. Security and policy notes

- **Never trust an unsigned webhook** — reject with 401 (M9).
- Compare the `x-zeck-event-id` header against the envelope's
  `eventId` (the receiver example does).
- The signing secret arrives out-of-band; never in a URL, never
  logged.
- Payloads are scrubbed server-side (secret-shaped keys redacted) —
  but scrubbing is the sender's defense; verification is yours.

### 8. Cost/latency considerations

Webhook delivery is the platform's push channel — it costs you an
endpoint, not polling. Keep receivers fast (ack, then process
asynchronously) so retries are rare; the dedupe memory must be durable
in production (a real receiver persists applied event ids).

### 9. Common failures and remedies

| Failure | Cause | Remedy |
|---|---|---|
| 401 loops on every delivery | Wrong secret or wrong basis bytes | Verify with `verifyWebhookSignature` (the SDK canonicalizes the basis for you); check `ZECK_WEBHOOK_SECRET` |
| Duplicate effects | Receiver applied replays | Dedupe on `webhookDedupeKey(event)` — persist applied ids |
| Event id header mismatch | Envelope/header disagreement | Reject (400) — the example shows the check |
| Missed events during downtime | In-flight retry only (bounded) | Reconcile by polling `GET /executions/:id/events` (pull is the fallback of record) |

Public contract links: `src/shared/wire.ts` (`WebhookEvent`,
`webhookSignatureBasis`, `webhookDedupeKey`), `sdk/index.ts`
(`verifyWebhookSignature`), `src/api/webhooks/delivery.ts`
(`WEBHOOK_SIGNATURE_HEADER`, `WEBHOOK_EVENT_ID_HEADER`,
`signWebhookEvent`, `deliverWebhookEvent`),
`examples/webhook-receiver.ts`.
