# The SDK and CLI reference

**One sentence:** the SDK (`sdk/index.ts`) is the execution-centric,
provider-neutral, app-scoped TypeScript client over the frozen wire
contract (`src/shared/wire.ts`), plus the webhook signature verifier
and receiver idempotency helpers; the CLI (`cli/index.ts`) wraps the
same SDK for shell workflows.

## The SDK surface

### Client construction

```typescript
import { createZeckClient } from "../sdk";

const client = createZeckClient({
  baseUrl: string,             // the deployment's public API base URL
  token: string,               // a Zeck transport credential — never a provider key
  applicationId: string,       // the application scope (required for scoped methods)
  fetchImpl?: typeof fetch,    // transport seam (tests inject; defaults to fetch)
  generateIdempotencyKey?: () => string,  // default: `sdk-<uuid>`
});
```

Construction rules:

- An empty/whitespace `applicationId` throws (a scope is a non-empty
  string).
- A scoped method called on a client **without** an application scope
  fails fast client-side — the wire contract is pinned, never
  discovered.
- Provider-selection attempts in a create request are rejected
  client-side (the `FORBIDDEN_REQUEST_KEYS` rule) — the request is not
  issued.

### Client methods

| Method | Wire call | Scope header |
|---|---|---|
| `createExecution(request, idempotencyKey?)` | `POST /executions` | body `applicationId` (no header — the split contract) |
| `getExecution(executionId)` | `GET /executions/:id` | `X-Zeck-Application` |
| `cancelExecution(executionId, idempotencyKey?)` | `POST /executions/:id/cancel` | `X-Zeck-Application` |
| `getResult(executionId)` | `GET /executions/:id/results` | `X-Zeck-Application` |
| `listEvents(executionId)` | `GET /executions/:id/events` | `X-Zeck-Application` |
| `listVerification(executionId)` | `GET /executions/:id/verification` | `X-Zeck-Application` |
| `listAgents()` | `GET /agents` | `X-Zeck-Application` |
| `getAgentStatus(agentId)` | `GET /agents/:id/status` | `X-Zeck-Application` |

An omitted idempotency key is generated (`sdk-<uuid>` via Web Crypto).
Create returns `{ receipt }` — the durable `ExecutionReceipt`.

### Errors

```typescript
class ZeckApiError extends Error {
  readonly status: number;     // HTTP status
  readonly body: PublicError;  // {code, message, retryable, details?, requestId?}
}
```

A non-2xx response parses the canonical body when possible and fails
closed to `{code: "PROVIDER_ERROR", retryable: status >= 500}` when
not. See [machine/error-codes.json](machine/error-codes.json) and
[TROUBLESHOOTING.md](TROUBLESHOOTING.md); the resilient-retry pattern
is `examples/error-handling.ts`.

### Webhook helpers

```typescript
verifyWebhookSignature(event, signatureHex, secret, cryptoImpl?): Promise<boolean>
webhookSignatureBasis(event): string   // the canonical signed bytes
webhookDedupeKey(event): string        // === event.eventId
```

`verifyWebhookSignature` uses the Web Crypto API — portable to
browsers, edge runtimes and Bun/Node 18+. See [WEBHOOKS.md](WEBHOOKS.md).

### The re-exported wire contract

The SDK re-exports **everything** from `src/shared/wire.ts`: the
lifecycle vocabularies (`EXECUTION_STATUSES`, `TERMINAL_STATUSES`,
`VERIFICATION_STATUSES`, `ECONOMIC_ACTION_STATUSES`, …), the money
convention types (`MicroUsd`, `CostSummary`), every request/response
type (`ExecutionRequest`, `ExecutionReceipt`, `Execution`,
`ExecutionResult`, `VerificationResult`, `AgentSummary`,
`EconomicAction*`, `Codebase*`, `WebhookEvent`, `PublicError`), the
error taxonomy (`ERROR_CODES`), the forbidden-key vocabulary
(`FORBIDDEN_REQUEST_KEYS`) and the application header constant
(`ZECK_APPLICATION_HEADER`). One import surface, zero drift — the wire
contract is the SDK's contract.

### Consumption

In-repo: `import { … } from "../sdk"` (directory import of
`sdk/index.ts`; every example does this). The repository is the
distribution surface today — a published package would be a later
delivery decision, and nothing in this kit assumes it.

## The CLI surface

`cli/index.ts` — execution-centric developer primitives; **no provider
commands exist**. Credentials NEVER cross command-line flags (shell
history is a leak surface): the token comes from `ZECK_TOKEN`, the
base URL from `ZECK_API_URL` (default `http://127.0.0.1:3000`).

```text
zeck submit  <applicationId> <taskJson> [--key <idempotencyKey>]
zeck inspect <applicationId> <executionId>
zeck result  <applicationId> <executionId>
zeck events  <applicationId> <executionId>
zeck cost    <applicationId> <executionId>
zeck verify  <applicationId> <executionId>
zeck cancel  <applicationId> <executionId> [--key <idempotencyKey>]
zeck agents  <applicationId>
zeck agent   <applicationId> <agentId>
```

The CLI prints receipts, statuses, events, verification evidence,
costs and agent inventory — never secret material.

## What the SDK deliberately does NOT have

- No provider/model/rail concept — no vendor types, no connection
  handles (provider-neutrality, M17).
- No secret-bearing type or field — credentials are BYOK references
  handled server-side (secret-safety, M5).
- No webhook sending — the platform signs and delivers; the SDK
  verifies (receiver side).
- No second state machine — the lifecycle vocabulary is the wire's
  own.

Public contract links: `sdk/index.ts`, `src/shared/wire.ts`,
`cli/index.ts`, `tests/unit/sdk/client.test.ts` (the SDK contract
tests), `examples/quickstart.ts`.
