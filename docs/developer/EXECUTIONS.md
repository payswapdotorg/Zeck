# The Execution lifecycle — create, poll, command, retrieve

**One sentence:** an Execution is a durable, evented state machine that
you drive with exactly one create, one command (cancel) and four reads
(detail, events, verification, results) — everything else is the
platform's authority.

## The API surface (nine-part treatment)

### 1. One-sentence explanation

`POST /executions` creates a governed execution from a task +
constraints; `GET /executions/:id` reads its state;
`POST /executions/:id/cancel` cancels a non-terminal execution;
`GET /executions/:id/events` lists the ordered ledger;
`GET /executions/:id/verification` lists the evidence;
`GET /executions/:id/results` returns the completed result package.

### 2. Conceptual model

See [CONCEPTS.md](CONCEPTS.md). The lifecycle is the platform's state
machine, projected publicly:

```text
CREATED → AUTHORIZED → PLANNING → QUEUED → RUNNING
   ↘ WAITING_TOOL / WAITING_USER / WAITING_HUMAN (legal waits)
   ↘ REPLANNING (the compiler re-plans)
→ VERIFYING → COMPLETED | FAILED | CANCELLED | EXPIRED   (terminal)
```

Terminal statuses (`TERMINAL_STATUSES`): `COMPLETED`, `FAILED`,
`CANCELLED`, `EXPIRED` — no further transitions or events after them.

### 3. Minimal API example

```bash
curl -X POST "$ZECK_API_URL/executions" \
  -H "authorization: Bearer $ZECK_TOKEN" \
  -H "content-type: application/json" \
  -H "idempotency-key: quickstart-1" \
  -d '{
    "applicationId": "'"$ZECK_APPLICATION_ID"'",
    "task": { "kind": "summarize", "doc": "quarterly-report-01", "maxWords": 60 },
    "constraints": { "maxCostMicroUsd": "5000", "maxLatencyMs": 30000 }
  }'
```

Scoped reads add the application selector header:

```bash
curl "$ZECK_API_URL/executions/<executionId>" \
  -H "authorization: Bearer $ZECK_TOKEN" \
  -H "x-zeck-application: $ZECK_APPLICATION_ID"
```

### 4. SDK example

```typescript
import { createZeckClient, TERMINAL_STATUSES } from "../sdk";

const client = createZeckClient({
  baseUrl: process.env.ZECK_API_URL!,
  token: process.env.ZECK_TOKEN!,
  applicationId: process.env.ZECK_APPLICATION_ID!,
});

const { receipt } = await client.createExecution(
  {
    applicationId: process.env.ZECK_APPLICATION_ID!,
    task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
    constraints: { maxCostMicroUsd: "5000", maxLatencyMs: 30_000 },
  },
  "quickstart-1",
);

let status = receipt.status;
while (!TERMINAL_STATUSES.includes(status)) {
  await new Promise((r) => setTimeout(r, 1000));
  status = (await client.getExecution(receipt.executionId)).status;
}

const result = await client.getResult(receipt.executionId);
```

Full runnable path: `examples/quickstart.ts` and
`examples/text-summarization.ts`.

### 5. Request/response schemas

The frozen wire types (`src/shared/wire.ts`; machine projection:
[machine/openapi.json](machine/openapi.json)):

- **ExecutionRequest** (closed vocabulary — unknown keys rejected):
  `applicationId` (required), `environmentId?`, `task` (required
  object), `inputArtifactRefs?`, `constraints? {maxCostMicroUsd?,
  maxLatencyMs?, minQuality?}`, `metadata?`, `userId?`. The keys
  `provider, providerId, model, modelId, rail, connectionId,
  connection, agent, agentId` must NEVER appear.
- **ExecutionReceipt** (201): `executionId, applicationId, status,
  createdAt, replayed, lastEventSequence`.
- **Execution** (GET detail): `id, applicationId, environmentId,
  status, task, constraints, metadata, createdAt, updatedAt,
  terminalAt`.
- **ExecutionEvent[]** (GET events): `eventId, executionId, type,
  sequence, occurredAt, payload` — ascending sequence.
- **ExecutionResult** (GET results): see [EVIDENCE.md](EVIDENCE.md).
- **Errors**: the canonical body `{code, message, retryable}` —
  [machine/error-codes.json](machine/error-codes.json).

### 6. Expected execution lifecycle (what to expect, when)

- Create returns `CREATED` (or a later status on replay) with the
  durable receipt — **synchronous create, asynchronous completion**.
- Typical text-scale executions complete in seconds; media families run
  minutes (video measured ~88 s per clip when live-proven — poll
  patiently, see `examples/video-generation.ts`).
- `WAITING_*` statuses are healthy pauses (tool results, user input,
  human review) — for HITL families the wait IS the feature
  (`examples/human-review-gate.ts`).
- Polling is the pull pattern; webhooks are the push pattern
  ([WEBHOOKS.md](WEBHOOKS.md)). The validation harness's own
  integration pattern — bounded polling with a deadline — is
  `examples/lib/poll.ts`.

### 7. Security and policy notes

- Policy admission happens before dispatch: `POLICY_DENIED` arrives
  before any spend or side effect.
- The create contract is closed — tenant/provider injections through
  request keys are unrepresentable, not merely ignored.
- Scope is server-derived; a scope-checked miss is 404 (another
  application's execution is indistinguishable from a missing one).
- Cancel goes through the lifecycle authority — the API has no direct
  state mutation, and neither do you.

### 8. Cost/latency considerations

- `maxCostMicroUsd` (integer micro-USD string) bounds the execution;
  `BUDGET_EXCEEDED` (402) fails the request when no eligible route
  satisfies the bound.
- The receipt's `lastEventSequence` is a cheap resume cursor for
  incremental event reads.
- Re-reading the detail between polls is one scoped GET — the harness
  pattern uses ~1 s intervals for interactive workloads, 2–5 s for
  long-running ones.

### 9. Common failures and remedies

| Failure | Code | Remedy |
|---|---|---|
| Create rejected: unknown keys | `CAPABILITY_UNAVAILABLE` 422 | Remove provider/model/… keys — the contract is closed |
| Create rejected: budget | `BUDGET_EXCEEDED` 402 | Raise `maxCostMicroUsd` or relax constraints |
| No route satisfies the task | `NO_ELIGIBLE_ROUTE` 422 | Check [AVAILABILITY.md](AVAILABILITY.md) for the family's rail needs |
| Key collision on retry | `IDEMPOTENCY_KEY_REUSED` 409 | Your key collided with a different request — new key, and treat the old one as a client bug |
| Cancel rejected | `INVALID_STATE_TRANSITION` 409 | The execution is already terminal — read the status first |
| Poll never terminates | (none) | Your deadline is too short for the family, or the deployment lacks the family's rails — see [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |

Public contract links: `src/shared/wire.ts`, `sdk/index.ts`,
`src/api/routes/executions.ts`, [machine/openapi.json](machine/openapi.json).
