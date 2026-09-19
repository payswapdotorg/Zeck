# Quickstart — your first five minutes on Zeck

**Goal:** go from zero to a completed sandbox execution whose result,
evidence and cost you have retrieved — through the public SDK, with no
provider selection and no embedded secrets.

The whole path is one runnable file: `examples/quickstart.ts`. This page
walks it step by step.

## 0. What you need (60 seconds)

| Need | Where it comes from |
|---|---|
| A Zeck API endpoint (`ZECK_API_URL`) | Your sandbox deployment's base URL (the console/deployment surfaces expose it). For local verification the repository boots the bootstrap public API plane at `http://127.0.0.1:8787` — [SELF-HOSTING.md](SELF-HOSTING.md) states exactly what that plane serves and how to run a full-journey local composition. The CLI's default (`http://127.0.0.1:3000`) applies only where YOU have composed a control plane to serve there: the repository ships no server on that port. |
| A Zeck transport credential (`ZECK_TOKEN`) | The platform's credential surface for your application — a **Zeck** credential, **never a provider API key** (see [AUTH.md](AUTH.md)). |
| An application id (`ZECK_APPLICATION_ID`) | The application your executions belong to (see [AUTH.md](AUTH.md)). |

Optional: `ZECK_ENVIRONMENT_ID` — the disposable sandbox environment
executions are created in (see [SANDBOX.md](SANDBOX.md)).

Export them (environment only — the CLI and examples never accept
credentials on the command line; shell history is a leak surface):

```bash
export ZECK_API_URL="http://127.0.0.1:3000"
export ZECK_TOKEN="<your-zeck-credential>"
export ZECK_APPLICATION_ID="<your-application-id>"
```

> **Secret discipline:** these three values live in your environment.
> Nothing in the example files — and nothing anywhere in this kit —
> contains a credential value. The documentation battery enforces this
> with a secret scan.

## 1. Create the SDK client (30 seconds)

```typescript
import { createZeckClient } from "../sdk"; // in-repo; see SDK.md for consumption

const client = createZeckClient({
  baseUrl: process.env.ZECK_API_URL!,
  token: process.env.ZECK_TOKEN!,
  applicationId: process.env.ZECK_APPLICATION_ID!,
});
```

Three things this one call pins down:

- **Execution-centric**: the client has execution methods, not model
  methods. There is no `client.chat()`, and there never will be.
- **Provider-neutral**: there is no provider parameter anywhere. You
  express a *task + constraints*; Zeck owns routing (see [CONCEPTS.md](CONCEPTS.md)).
- **App-scoped**: every scoped method sends the canonical
  `X-Zeck-Application` header from `applicationId`. A scoped call on a
  client without an application scope fails fast client-side.

## 2. Submit your first Execution (60 seconds)

```typescript
const { receipt } = await client.createExecution(
  {
    applicationId: process.env.ZECK_APPLICATION_ID!,
    task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
    constraints: {
      maxCostMicroUsd: "5000",  // $0.005 — integer micro-USD string, never a float
      maxLatencyMs: 30_000,
    },
    metadata: { origin: "docs/developer/QUICKSTART.md" },
  },
  "quickstart-2026-01-01", // idempotency key — YOUR stable choice
);
console.log(receipt.executionId, receipt.status, receipt.replayed);
```

The create contract is **closed**: exactly
`applicationId, environmentId?, task, inputArtifactRefs?, constraints?,
metadata?, userId?`. Provider/model/rail/connection/agent keys are
**rejected fail-closed** (the SDK rejects them before the wire; the API
rejects them again). The `Idempotency-Key` header is mandatory on every
POST: same key + same request replays the durable outcome; same key +
different request → `409 IDEMPOTENCY_KEY_REUSED` (see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md)).

## 3. Poll the lifecycle to a terminal status (60 seconds)

The wire exposes no push channel for execution state (webhooks are the
push surface — see [WEBHOOKS.md](WEBHOOKS.md)). Poll the public read:

```typescript
import { TERMINAL_STATUSES } from "../sdk";

let status = receipt.status;
while (!TERMINAL_STATUSES.includes(status)) {
  await new Promise((r) => setTimeout(r, 1000));
  status = (await client.getExecution(receipt.executionId)).status;
}
```

The full lifecycle vocabulary — `CREATED → AUTHORIZED → PLANNING →
QUEUED → RUNNING → (WAITING_TOOL | WAITING_USER | WAITING_HUMAN |
REPLANNING)* → VERIFYING → COMPLETED | FAILED | CANCELLED | EXPIRED` —
is documented in [EXECUTIONS.md](EXECUTIONS.md).

## 4. Retrieve the result package — route, cost, evidence (60 seconds)

```typescript
const result = await client.getResult(receipt.executionId);
console.log(result.status);              // COMPLETED
console.log(result.route);               // {provider, model, strategyClass, modelCalls} — opaque neutral strings
console.log(result.cost);                // {totalMicroUsd: "…", currency: "usd"} — or null (never fabricated)
console.log(result.usage);               // {inputTokens, outputTokens} — or null
console.log(result.outputArtifacts);     // [{id, digest, createdAt}]
console.log(result.verification);        // [{criterionId, status, strategy, confidence, …}]
console.log(result.warnings);            // honest warnings (INCONCLUSIVE counts, failure notices)
```

**Honesty rules baked into this package**: cost and usage appear only
when the durable ledger carries settled facts — `null` otherwise, never
a fabricated number. Verification results carry the criterion, the
strategy that evaluated it, the evaluator provenance and evidence
references (see [EVIDENCE.md](EVIDENCE.md)).

## 5. Inspect the evidence trail (30 seconds)

```typescript
const events = await client.listEvents(receipt.executionId);        // the ordered ledger
const verification = await client.listVerification(receipt.executionId); // the evidence axis
```

Every lifecycle transition, planning decision and step fact is an
ordered event; every verification verdict is an evidence record with
provenance. Together they are the full audit trail of your execution.

## 6. Confirm the idempotency discipline (30 seconds)

```typescript
const replay = await client.createExecution(sameRequest, sameKey);
console.log(replay.receipt.replayed); // true — the durable outcome, not a second spend
```

## Run the whole thing

```bash
bun run examples/quickstart.ts
```

The quickstart is one of the examples exercised **end-to-end** by the
documentation battery: the battery composes the REAL public API server
(in-memory variant of the real composition), points the REAL SDK at it
over HTTP, and runs this exact `main()` — so the code path you just
read is executed, not merely compiled. See
`tests/unit/developer-docs/examples-end-to-end.test.ts`.

## Where to go next

- **Your workload family** — [WORKLOADS.md](WORKLOADS.md) and the
  example inventory (`examples/README.md`,
  [machine/examples-manifest.json](machine/examples-manifest.json)).
- **Errors and retries** — [TROUBLESHOOTING.md](TROUBLESHOOTING.md) +
  `examples/error-handling.ts`.
- **Push delivery** — [WEBHOOKS.md](WEBHOOKS.md) +
  `examples/webhook-receiver.ts`.
- **Production** — [PRODUCTION.md](PRODUCTION.md).
- **As a coding agent** — [AGENT-GUIDE.md](AGENT-GUIDE.md) +
  [machine/integration-recipe.json](machine/integration-recipe.json).
