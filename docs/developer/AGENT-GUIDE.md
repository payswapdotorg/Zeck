# The agent integration guide — discovering Zeck without a maintainer

**Audience: coding agents.** This page plus the machine-readable layer
is the complete integration path from files alone. The deterministic
recipe: [machine/integration-recipe.json](machine/integration-recipe.json)
(validated by the battery — every referenced artifact exists).

## The 30-second orientation

1. **The contract**: `src/shared/wire.ts` is the ONE canonical wire
   contract; `sdk/index.ts` re-exports it and adds the client. Import
   from `../sdk` (in-repo). There is no published package — the
   repository is the distribution surface.
2. **The primitive**: Execution. No model calls, no provider calls.
   Create with `{applicationId, task, constraints?}`, poll
   `GET /executions/:id` to terminal, read
   `GET /executions/:id/results`.
3. **The rules**: bearer `ZECK_TOKEN` (a Zeck credential — never a
   provider key); `X-Zeck-Application` on scoped reads (the SDK sends
   it from `applicationId`); `Idempotency-Key` on every POST (same key
   + same request replays; different request → 409); money is integer
   micro-USD strings; unknown request keys are rejected (closed
   contracts).

## The machine-readable layer (read these as files, not prose)

| Artifact | Use it for |
|---|---|
| [machine/openapi.json](machine/openapi.json) | Every route, header and schema — validated against the LIVE route table |
| [machine/error-codes.json](machine/error-codes.json) | The full taxonomy: code → status → retry guidance → remedy |
| [machine/env-vars.json](machine/env-vars.json) | Exactly which environment variables to read (names only) |
| [machine/capability-manifest.json](machine/capability-manifest.json) | The 22 workload families, their task shapes, capability requirements and honest availability |
| [machine/examples-manifest.json](machine/examples-manifest.json) | Every example with its classification and env vars |
| [machine/integration-recipe.json](machine/integration-recipe.json) | The 9-step deterministic recipe with per-step artifacts |

## The recipe (deterministic)

```text
1. discover-contract      read src/shared/wire.ts + sdk/index.ts
2. understand-model       read docs/developer/CONCEPTS.md
3. obtain-credentials     ZECK_API_URL, ZECK_TOKEN, ZECK_APPLICATION_ID (environment only)
4. first-execution        run examples/quickstart.ts (create → poll → result/evidence/cost)
5. select-workload-example pick your family: docs/developer/WORKLOADS.md + examples/
6. apply-error-discipline adopt examples/error-handling.ts + machine/error-codes.json
7. receive-webhooks (opt) deploy examples/webhook-receiver.ts (verify → dedupe → apply)
8. verify-examples        bun run typecheck && bun run test:unit -- tests/unit/developer-docs
9. production-path        docs/developer/PRODUCTION.md (promotion/secrets/quotas — cross-linked)
```

## The shortest possible integration (copy this)

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
  "agent-run-1",
);

let status = receipt.status;
while (!TERMINAL_STATUSES.includes(status)) {
  await new Promise((r) => setTimeout(r, 1000));
  status = (await client.getExecution(receipt.executionId)).status;
}

const result = await client.getResult(receipt.executionId);
// result.status / result.route / result.cost / result.verification / result.warnings
```

(For the canonical task shape see `examples/quickstart.ts` — the
snippet above is deliberately minimal.)

## The invariants an agent must not violate

- **Never embed secrets.** Credentials are environment variables;
  names only in code.
- **Never select providers.** The create contract rejects
  provider/model/rail/connection/agent keys — do not try to inject
  them; route selection is platform authority.
- **Never send floats for money.** Integer micro-USD strings only.
- **Never skip the idempotency key on POST.** Never reuse a key across
  semantically different requests.
- **Never trust an unsigned webhook.** Verify with
  `verifyWebhookSignature`, dedupe on `webhookDedupeKey`.
- **Never treat a provider-gated example as runnable.** The
  classifications in the manifests are recorded facts
  ([AVAILABILITY.md](AVAILABILITY.md)).

## How to verify your work (the same battery this kit uses)

```bash
bun install
bun run typecheck                                    # examples typecheck too
bun run test:unit -- tests/unit/developer-docs       # links, schemas, end-to-end, secret scan
```

The end-to-end test composes the REAL API server (in-memory variant)
and runs example `main()` functions through the REAL SDK over HTTP —
you can read `tests/unit/developer-docs/examples-end-to-end.test.ts`
as the executable specification of a correct integration.

## Where humans read the same truth

[README.md](README.md) is the human index; every page there and here
cross-links the same frozen contracts — there is exactly one truth
(the repository), two reading surfaces.
