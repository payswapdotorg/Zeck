/**
 * Integration — REAL Cloudflare Queues verification (WORK-044 / D-03).
 *
 * Gated on the real provider credential material being materialized
 * in the environment (credential-shaped, environment-only — never in
 * the repository):
 *
 *   ZECK_CLOUDFLARE_ACCOUNT_ID   the Cloudflare account id
 *   ZECK_QUEUE_ID                the execution queue's REST resource id
 *   ZECK_PROBE_QUEUE_ID          the DEDICATED operator-owned probe
 *                                queue's REST resource id (never the
 *                                execution queue; PR #6 correction)
 *   ZECK_QUEUE_API_TOKEN         the materialized queue-api-token secret
 *                                (Bearer auth, queues read+write)
 *   ZECK_QUEUE_API_BASE_URL      optional (defaults to the public API)
 *
 * When any of them is absent the suite SKIPS with the exact reason —
 * evidence discipline: unavailable provider evidence is NOT RUN with
 * the environmental reason, NEVER a silent PASS (the WORK-044
 * evidence contract).
 *
 * When present, the suite executes the REAL production transport path:
 * the provider round-trip probe on the dedicated probe queue (publish
 * → pull → ack of exactly one self-identifying probe message) plus the
 * full port flow (publish/pull/settle) — ALSO on the probe queue: test
 * traffic never enters the execution queue, and the port-flow loop
 * acknowledges ONLY its own marker message (foreign messages are never
 * acked or re-queued; their leases expire). Pull-consumer
 * prerequisites (both queues exist, HTTP pull consumers enabled, token
 * has queues read+write) are operator-owned account-plane
 * preconditions; attesting the execution queue's own pull path is the
 * governed consumer's job (deploy:queue -- consume), never a probe's.
 */

import { describe, expect, test } from "vitest";
import { createCloudflareQueuesTransport } from "../../../src/platform/queue/cloudflare-queues";

const ACCOUNT_ID = process.env.ZECK_CLOUDFLARE_ACCOUNT_ID ?? "";
const QUEUE_ID = process.env.ZECK_QUEUE_ID ?? "";
const PROBE_QUEUE_ID = process.env.ZECK_PROBE_QUEUE_ID ?? "";
const API_TOKEN = process.env.ZECK_QUEUE_API_TOKEN ?? "";
const GATED =
  ACCOUNT_ID.length > 0 && QUEUE_ID.length > 0 && PROBE_QUEUE_ID.length > 0 && API_TOKEN.length > 0;

describe.skipIf(!GATED)(
  "the real Cloudflare Queues production transport (WORK-044 D-03; gated on ZECK_QUEUE_* materialization)",
  () => {
    // Constructed lazily INSIDE the gated suite: an ungated run never
    // validates empty provider configuration (the skip is the honest
    // outcome, not a collection error).
    const transport = () =>
      createCloudflareQueuesTransport({
        apiBaseUrl: process.env.ZECK_QUEUE_API_BASE_URL,
        accountId: ACCOUNT_ID,
        queueId: QUEUE_ID,
        probeQueueId: PROBE_QUEUE_ID,
        apiToken: API_TOKEN,
        requestTimeoutMs: 15_000,
      });

    test("the provider round-trip probe attests the real transport (on the dedicated probe queue)", {
      timeout: 60_000,
    }, async () => {
      const probe = await transport().probe();
      expect(probe.ok).toBe(true);
    });

    test("the full port flow (publish/pull/settle) against the real probe queue — never acking foreign messages", {
      timeout: 60_000,
    }, async () => {
      // The port flow runs against the DEDICATED probe queue as its
      // configured queue: the same documented wire surface, without
      // injecting test traffic into the execution queue. (No
      // probeQueueId here: this transport does not call probe().)
      const t = createCloudflareQueuesTransport({
        apiBaseUrl: process.env.ZECK_QUEUE_API_BASE_URL,
        accountId: ACCOUNT_ID,
        queueId: PROBE_QUEUE_ID,
        apiToken: API_TOKEN,
        requestTimeoutMs: 15_000,
      });
      const marker = `zeck-d03-verify-${Date.now()}`;
      const receipt = await t.publish({
        body: JSON.stringify({ verify: marker }),
        contentType: "application/json",
      });
      expect(receipt.accepted).toBe(true);
      const deadline = Date.now() + 30_000;
      let leased: string | null = null;
      while (Date.now() < deadline && leased === null) {
        // Short lease: anything we lease but do not own returns to the
        // queue promptly (lease expiry — never acked, never retried).
        const batch = await t.pull({ batchSize: 5, visibilityTimeoutMs: 2_000 });
        const hit = batch.messages.find((message) => {
          try {
            const parsed = JSON.parse(message.body) as Record<string, unknown>;
            return parsed.verify === marker;
          } catch {
            return false;
          }
        });
        if (hit !== undefined) {
          leased = hit.leaseId;
          break;
        }
        // NO settle call for foreign messages: this loop never
        // acknowledges or re-queues anything it did not publish (the
        // PR #6 correction discipline — foreign leases expire).
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
      expect(leased).not.toBeNull();
      await t.settle({ ackLeaseIds: [leased ?? ""], retryLeaseIds: [] });
    });
  },
);

describe.skipIf(GATED)(
  "the real Cloudflare Queues production transport is NOT RUN (gating is honest)",
  () => {
    test("skips with the exact missing-materialization reason", () => {
      const missing = [
        ["ZECK_CLOUDFLARE_ACCOUNT_ID", ACCOUNT_ID],
        ["ZECK_QUEUE_ID", QUEUE_ID],
        ["ZECK_PROBE_QUEUE_ID", PROBE_QUEUE_ID],
        ["ZECK_QUEUE_API_TOKEN", API_TOKEN],
      ]
        .filter((entry) => (entry[1] ?? "").length === 0)
        .map((entry) => entry[0] ?? "");
      expect(missing.length).toBeGreaterThan(0);
      console.info(
        `[queue-live] SKIPPED: real Cloudflare Queues verification NOT RUN — missing credential-shaped materialization: ${missing.join(", ")}`,
      );
    });
  },
);
