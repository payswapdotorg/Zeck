# Economic actions — governed agentic payment intents

**One sentence:** `/economic-actions` lets an execution propose a
**bounded, capability-gated payment intent** provenance-bound to that
execution — and proposing is *never* an authorization: the governed
admission chain (policy → capability → budget) decides, settlement is
an external observation, and delivery is decided by the verification
authority alone.

> **SDK note (honest surface mapping):** the execution-centric SDK
> client covers the execution core. The economic-action REST surface is
> ridden directly with `fetch`, using the SAME wire types the SDK
> re-exports and the SAME conventions (bearer auth,
> `X-Zeck-Application` on scoped reads, `Idempotency-Key` on POST).
> Complete runnable path: `examples/economic-actions.ts`.

## The API surface (nine-part treatment)

### 1. One-sentence explanation

`POST /economic-actions` proposes an intent; `GET /economic-actions/:id`
reads the durable record; `GET /economic-actions/:id/events` reads the
intent's own provenance ledger; `GET /economic-actions/:id/outcome`
reads settlement and delivery **as separate axes**.

### 2. Conceptual model

```text
proposed → denied | authorized → executing → settled | failed | expired
                (the governed admission chain)      (external observation)
```

- The **recipient** is an opaque external reference `{kind, id}` —
  there is no field where a raw payment credential could even appear
  (bounded/tokenized references only; the authorization itself never
  crosses this wire).
- The **amount** is exact or an explicit range — integer micro-USD
  strings.
- The intent is **execution-bound** (`executionId` is required): spend
  provenance chains back to the logical execution that proposed it.
- **Settlement ≠ delivery ≠ execution success**: a settlement alone
  never proves delivery.

### 3. Minimal API example

```bash
curl -X POST "$ZECK_API_URL/economic-actions" \
  -H "authorization: Bearer $ZECK_TOKEN" \
  -H "content-type: application/json" \
  -H "idempotency-key: intent-1" \
  -d '{
    "applicationId": "'"$ZECK_APPLICATION_ID"'",
    "executionId": "<a-completed-execution-id>",
    "purpose": "purchase dataset access",
    "recipient": { "kind": "external-account", "id": "vendor-001" },
    "amount": { "kind": "exact", "microUsd": "1500000" },
    "currency": "usd",
    "expiresAt": "2026-12-31T00:00:00Z",
    "requiredCapabilities": [{ "kind": "tool", "name": "human-review" }]
  }'
```

### 4. SDK-types example

```typescript
import type { EconomicAction, EconomicActionReceipt } from "../sdk";

const response = await fetch(`${baseUrl}/economic-actions`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "idempotency-key": "intent-1",
  },
  body: JSON.stringify({
    applicationId,
    executionId,
    purpose: "purchase dataset access",
    recipient: { kind: "external-account", id: "vendor-001" },
    amount: { kind: "exact", microUsd: "1500000" },
    currency: "usd",
    expiresAt,
    requiredCapabilities: [{ kind: "tool", name: "human-review" }],
  }),
});
const receipt = (await response.json()) as EconomicActionReceipt;
```

Runnable: `examples/economic-actions.ts` (proposal → record → ledger →
outcome, end to end).

### 5. Request/response schemas

Frozen wire types (`src/shared/wire.ts`): `EconomicActionRequest`
shape (closed key set: `applicationId, executionId, purpose, recipient,
amount, currency, expiresAt, requiredCapabilities?, railPreference?,
metadata?`), `EconomicActionReceipt` (`economicActionId, applicationId,
executionId, status, createdAt, replayed`), `EconomicAction`,
`EconomicActionEvent` (`eventId, economicActionId, sequence, type,
cause, occurredAt, payload`), `EconomicActionOutcome` (`status,
settlement, deliveries`), `EconomicSettlement` (`railId,
railTransactionRef, status (observed|confirmed|failed),
settledAmountMicroUsd, evidenceDigest`), `EconomicDelivery` (`kind,
digest, contentRef`). Machine projection:
[machine/openapi.json](machine/openapi.json).

The status vocabulary: `proposed, denied, authorized, executing,
settled, failed, expired`.

### 6. Expected lifecycle

Proposal is synchronous and durable (the receipt lands immediately,
`proposed`); the admission chain and any external settlement progress
asynchronously — poll `GET /economic-actions/:id` and read the
per-action ledger for the causal chain (`cause` links every event).

### 7. Security and policy notes

- **Proposing is never an authorization** — admission is the platform's
  governed chain, never a client assertion.
- No secret material: recipients are opaque references; the signing
  secret for any rail interaction never crosses this surface.
- `requiredCapabilities` is the neutral requirement vocabulary — the
  registry arbitrates it exactly like execution capabilities.
- `EXPIRED` (410) is the honest end of an intent whose TTL elapsed —
  create a new one; never attempt resurrection.

### 8. Cost/latency considerations

- Amounts are integer micro-USD strings; ranges express bounded
  uncertainty (`minMicroUsd`/`maxMicroUsd`).
- The budgets authority owns money-movement truth — settlements are
  correlated external observations (evidence only).

### 9. Common failures and remedies

| Failure | Code | Remedy |
|---|---|---|
| Intent rejected at admission | `POLICY_DENIED` / `BUDGET_EXCEEDED` / `CAPABILITY_UNAVAILABLE` | The governed chain spoke — inspect the intent's events for the causal record |
| Unknown execution | `CAPABILITY_UNAVAILABLE` 422 | Bind to an existing (ideally completed) execution |
| Unknown request keys | `CAPABILITY_UNAVAILABLE` 422 | The contract is closed — remove extras |
| Intent past TTL | `EXPIRED` 410 | Create a new intent with a suitable `expiresAt` |
| Settlement null in outcome | — | No external observation yet — null is honest, not an error |

Public contract links: `src/shared/wire.ts` (the economic-action
types), `src/api/routes/economic-actions.ts`,
[machine/openapi.json](machine/openapi.json),
`examples/economic-actions.ts`.
