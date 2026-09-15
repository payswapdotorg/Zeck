# The sandbox — usage and limits

**One sentence:** Zeck sandboxes are governed, disposable execution
environments with hard limits (spend, latency, concurrency, artifact
size, provider allowlists, expiry) where real customer-path executions
run against isolated synthetic data and consequential real-world side
effects are impossible unless you explicitly provision a governed test
connection.

## What "sandbox" means in Zeck

Two related but distinct things — both governed:

1. **Sandbox environments** (the environment axis): disposable
   environments your executions can target (`environmentId` on
   create). Environment classes, data policies and teardown rules are
   repository truth (`deploy/manifests/environments.json`): `local`
   and `preview` are disposable/synthetic-only; `staging` and
   `production` are persistent with isolated credentials.
2. **Sandbox execution** (the compute axis): executions that need
   compute run inside governed sandbox environments — admission
   validates the task, rejects secret-shaped values BEFORE anything
   durable, and every step is journaled into the execution's ledger.

## Using a sandbox environment

```typescript
const { receipt } = await client.createExecution(
  {
    applicationId,
    environmentId: process.env.ZECK_ENVIRONMENT_ID, // the disposable sandbox
    task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
    constraints: { maxCostMicroUsd: "5000" },
  },
  "sandbox-run-1",
);
```

The `ZECK_ENVIRONMENT_ID` variable is optional — omit it and the
platform uses the deployment's default environment; set it and your
executions (and their spend) are scoped to that environment.

## The limits model

Per the developer-platform roadmap's sandbox requirements, sandbox
usage supports:

- **Hard per-run and per-application spend limits** — your
  `constraints.maxCostMicroUsd` is the per-run bound; application and
  environment budgets bound the aggregate (`BUDGET_EXCEEDED` 402 when
  exceeded — before spend, not after).
- **Timeouts** — `constraints.maxLatencyMs` bounds the run; sandbox
  runtime timeouts surface as sandbox-axis failures (`SANDBOX_ERROR`
  502 with the failure class recorded).
- **Concurrency limits** — governed platform-side; sustained excess
  surfaces as policy/budget denials, never as silent queueing without
  bound.
- **Artifact size limits** — bounded output artifacts (the result
  package carries references + digests; oversized outputs fail
  honestly).
- **Provider allowlists** — the environment's authorized provider set;
  a family needing an unlisted rail fails with `NO_ELIGIBLE_ROUTE`,
  never a fallback to an unauthorized provider.
- **Automatic expiry and reset** — disposable environments expire;
  synthetic state resets. Durable production data NEVER lives in a
  sandbox class.

## The safety model (why side effects can't leak)

- **Isolation profiles** — sandbox environments run under declared
  isolation classes (the seeded runtime capability is `process-sandbox`
  with `networkEgress: false`); egress-controlled by construction.
- **Secret-shaped values are rejected at admission** — before anything
  durable, before any dispatch (the sandbox axis's own rule, mirroring
  the wire's secret-safety).
- **Write-once runtime metadata** — the dispatched work is ALWAYS the
  admitted work; the admitted snapshot is immutable.
- **Synthetic data policy** — disposable classes are synthetic-only
  (`deploy/manifests/environments.json`, `dataPolicy`); the validation
  corpus's fixtures are synthetic by contract.
- **Governed test connections** — consequential real-world side
  effects require an EXPLICITLY provisioned governed connection
  (platform-side BYOK surface), never a sandbox default.

## Crash and resume behavior

Sandbox participants journal progress into the execution ledger; crash
recovery resumes from journaled checkpoints (proven over REAL
PostgreSQL in the integration suites). You observe this as: a
long-running execution that survives a worker crash continues from its
last journaled step — the events tell you exactly where.

## What the sandbox is NOT

- Not a mock: executions are REAL platform executions (real policy,
  real budgets, real ledgers, real verification) — only the environment
  class is disposable.
- Not a place for production data: synthetic-only by policy.
- Not a bypass: policy admission, capability resolution and budget
  reservation apply identically.

## Common sandbox failures

| Failure | Code | Remedy |
|---|---|---|
| Spend refused before dispatch | `BUDGET_EXCEEDED` 402 | Lower the task's cost expectations or raise the bound (within the environment's limits) |
| Sandbox runtime failure | `SANDBOX_ERROR` 502 | Check the failure class in the events (sandbox-execution / timeout / adapter-error / runtime-unavailable); retry only when retryable |
| Environment expired | `EXPIRED` 410 / environment admission denial | Obtain a fresh sandbox environment; disposable classes are not resurrectable |
| Capability absent in the environment | `NO_ELIGIBLE_ROUTE` 422 | The environment's provider allowlist lacks the family's rails — see [AVAILABILITY.md](AVAILABILITY.md) |

Public contract links: `src/modules/sandbox/domain/sandbox.ts` (the
sandbox axis vocabulary — admission denial classes
`policy|budget|capability`, outcome/failure classes),
`deploy/manifests/environments.json` (the environment matrix —
repository truth), [SANDBOX limits in the roadmap](../DEVELOPER-PLATFORM-DEPLOYMENT-ROADMAP.md).
