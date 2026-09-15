# Troubleshooting — the failure taxonomy and the solution playbook

**One sentence:** every failure crosses the wire as
`{code, message, retryable}` with a deterministic HTTP status; this
page is the playbook: the taxonomy, the retry/idempotency semantics,
and the diagnosis flows for the failures integrators actually hit.

Machine-readable twin: [machine/error-codes.json](machine/error-codes.json)
(validated against the wire contract's `ERROR_CODES` and the error
mapper's status table). Runnable retry/discipline pattern:
`examples/error-handling.ts`.

## The error model in one look

```text
{ "code": "BUDGET_EXCEEDED", "message": "…", "retryable": false }
```

- The body is ALWAYS the public error shape — never a stack trace,
  never a SQL error, never a host path, never provider internals.
- `retryable` is the authoritative retry signal.
- `details` (when present) is structured, secret-free detail.
- `requestId` (when present) is the support correlation id.

## Retry and idempotency semantics (the discipline)

1. **Every POST carries an `Idempotency-Key`** (1..256 chars) — yours,
   stable across retries of the SAME logical request.
2. **Same key + same request fingerprint** → the durable outcome
   replays (`replayed: true`) — a network retry cannot double-spend.
3. **Same key + different fingerprint** → `409
   IDEMPOTENCY_KEY_REUSED` — a client bug; surface it, never retry it.
4. **Concurrent identical requests** converge on one durable row.
5. **Retry only when the body says `retryable: true`** (typically
   network/5xx surfaces). The 4xx family is deterministic: fix the
   request, don't resend it.

```typescript
// The resilient create (full version: examples/error-handling.ts)
for (let attempt = 1; attempt <= 3; attempt += 1) {
  try {
    const { receipt } = await client.createExecution(request, idempotencyKey); // SAME key
    break;
  } catch (error) {
    if (error instanceof ZeckApiError && !error.body.retryable) throw error;
    await sleep(100 * 2 ** (attempt - 1)); // bounded backoff
  }
}
```

## Diagnosis flows

### "My create was rejected"

| You see | Meaning | Do this |
|---|---|---|
| `401 AUTHENTICATION_FAILED` | Missing/malformed/unknown credential | Fix `ZECK_TOKEN` (a Zeck credential — never a provider key) |
| `403 POLICY_DENIED` | A published restriction denies it | Platform-side policy amendment — no client workaround exists |
| `402 BUDGET_EXCEEDED` | No eligible route under your bounds, or the budget authority refused | Raise `maxCostMicroUsd` / relax `maxLatencyMs` / `minQuality` |
| `422 CAPABILITY_UNAVAILABLE` (message: unknown keys) | The create contract is closed | Remove extra keys — especially any provider/model/rail/connection/agent key |
| `422 NO_ELIGIBLE_ROUTE` | The deployment lacks the family's rails | [AVAILABILITY.md](AVAILABILITY.md) — resolve with the operator |
| `409 IDEMPOTENCY_KEY_REUSED` | Key collision | New key for the new request; audit your key generation |

### "My execution is stuck / slow"

1. Read the status: `GET /executions/:id` — is it `WAITING_TOOL`,
   `WAITING_USER`, `WAITING_HUMAN`? For HITL families the wait IS the
   feature (`examples/human-review-gate.ts`).
2. Check the family's latency class ([WORKLOADS.md](WORKLOADS.md)):
   video measured ~88 s/clip live-proven; long-running runs minutes —
   your poll deadline must match (`examples/lib/poll.ts` defaults to
   120 s; media examples raise it).
3. Read the events (`GET /executions/:id/events`) — the ledger shows
   exactly where it is; sequences are monotonic.
4. Still non-terminal and past your SLA? Cancel it
   (`POST /executions/:id/cancel`, idempotent) and resubmit with a
   fresh key.

### "My execution FAILED"

1. `GET /executions/:id/results` — the `warnings` array states the
   honest headline (e.g. "execution failed (see events for the failure
   envelope)").
2. `GET /executions/:id/events` — find the failure envelope (the
   event type + payload carry the code-relevant facts).
3. Map the failure to the taxonomy: provider-side (`PROVIDER_ERROR`
   502 — region/quota boundaries are recorded availability facts),
   tool-side (`TOOL_ERROR`), agent-side (`AGENT_ERROR`),
   sandbox-side (`SANDBOX_ERROR` — the failure class is in the event),
   verification-side (`VERIFICATION_FAILED` / `VERIFICATION_INCONCLUSIVE`
   — read the criterion/strategy/evidence refs).
4. Retry only per the discipline above; a FAILED execution is terminal
   — resubmission needs a NEW idempotency key.

### "My verification is INCONCLUSIVE"

Expected for genuinely ambiguous outputs — the platform surfaces
INCONCLUSIVE as a warning, never as a silent pass. Read the
verification result's `strategy` and `confidence`, then either
strengthen the task/constraints or accept the ambiguity explicitly in
your pipeline.

### "My webhooks aren't arriving / aren't trusted"

- 401 loops: wrong secret or non-canonical basis bytes — use
  `verifyWebhookSignature` (the SDK canonicalizes for you) and check
  `ZECK_WEBHOOK_SECRET` ([WEBHOOKS.md](WEBHOOKS.md)).
- Duplicate effects: you are applying replays — dedupe on
  `webhookDedupeKey(event)` with a DURABLE memory.
- Missed events: in-flight retry is bounded — reconcile by polling
  `GET /executions/:id/events` (pull is the fallback of record).

### "My scoped reads 404"

A scope-checked miss is indistinguishable from a missing resource:
either the id is wrong, or it belongs to another application. Check
`ZECK_APPLICATION_ID` and the id; `TEN_SCOPE_VIOLATION` (403) is the
explicit cross-tenant guard.

### "My cancel was rejected"

`409 INVALID_STATE_TRANSITION`: the execution is already terminal
(`COMPLETED | FAILED | CANCELLED | EXPIRED`). Read the status first —
only non-terminal executions accept cancel.

### "My economic action EXPIRED"

`410 EXPIRED`: the intent's TTL elapsed. Create a new intent with a
suitable `expiresAt` — never attempt resurrection
([ECONOMICS.md](ECONOMICS.md)).

## The honest-provider-limitation behavior

Provider limitations (region blocks, quota exhaustion, DNS boundaries,
absent capabilities) are RECORDED facts, not transient errors to retry
blindly: the openai region block (403) and the video quota boundary
are stable facts of the authorized set — see [AVAILABILITY.md](AVAILABILITY.md).
Retrying a provider-availability boundary with the same request will
reproduce the same boundary; the remedy is operator-side (credential,
region, tier or provider), never client-side.

## Support escalation

Attach to any escalation: the execution id, the `requestId` from the
error body (when present), the terminal status, the relevant event
ledger slice, and the exact request fingerprint inputs (task shape +
constraints — never credentials). The platform's own evidence
discipline means those artifacts are always sufficient.
