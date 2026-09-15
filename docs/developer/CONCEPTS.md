# The Zeck conceptual model — the authority chain in developer terms

**One sentence:** Zeck is an *AI Execution OS* — you submit a **task
with constraints**, and the platform owns everything between the task
and a **verified, evidenced, costed outcome**: policy admission,
capability resolution, planning, provider-neutral routing, budgeted
execution, sandboxed isolation and verification.

This page teaches the conceptual model using the platform's own
vocabulary (source: `spec/architecture.md`), written for outsiders.

## The one primitive: the Execution

**Execution is THE primitive.** There is no "model call" and no
"provider call" in the public surface. An Execution is:

```text
task (what you want, provider-neutral)
+ constraints (maxCostMicroUsd · maxLatencyMs · minQuality)
+ application/environment scope (who/where)
+ input artifacts (optional references)
  → a governed lifecycle → a result package:
     {status, route, cost, usage, artifacts, verification, warnings}
```

Why this shape? Because the stable thing you integrate against is the
*outcome you need*, not the vendor that happens to serve it today.
Provider/model identifiers cross the wire **only as opaque neutral
strings inside route summaries** — you can read which route ran, but
you can never *select* one (the create contract rejects
provider/model/rail/connection/agent keys fail-closed).

Consequences you will feel as an integrator:

- You never pay vendor-switching costs in your integration code.
- You never hold provider credentials client-side (see
  [CONFIGURATION.md](CONFIGURATION.md)).
- Every execution is durable, idempotent and fully evented from the
  first moment.

## Policy before dispatch

Every governed operation is admitted by the **policy authority BEFORE
anything dispatches**. As an integrator you experience this as: a
create either succeeds (policy admitted) or fails with `POLICY_DENIED`
(403) — *before* any spend, any provider call, any side effect. Policy
documents are published artifacts with scope selectors and
restriction vocabularies; the API never accepts client-asserted scope —
the effective tenant/application scope is always derived server-side
from durable membership rows.

## Capabilities — the provider-neutral requirement vocabulary

A task profile declares **what it needs** ("structured-output",
"human-review", "process-sandbox"), never who supplies it. Capability
kinds (the frozen vocabulary, `src/modules/capabilities/domain/capability.ts`):

| Kind | Meaning | Seeded example |
|---|---|---|
| `model` | a model capability | `text-generation` v1.0.0 |
| `tool` | a tool capability | `document-retrieval` v1.0.0 (deterministic) |
| `algorithm` | an algorithmic capability | `json-schema-validation` v1.0.0 |
| `data` | a data capability | `structured-dataset-read` v1.0.0 (read-only) |
| `runtime` | a runtime capability | `process-sandbox` v1.0.0 (no egress) |
| `human` | a human capability | `human-review` v1.0.0 |

Claims are **evidence- and version-bound** (adapter-declared,
catalog-seeded or verified-observation) and arbitrated by the registry
BEFORE any route is selected. Unmet capabilities surface as
`CAPABILITY_UNAVAILABLE` / `NO_ELIGIBLE_ROUTE` — never as a silent
degradation. The machine-readable catalog:
[machine/capability-manifest.json](machine/capability-manifest.json).

## Budgets and economics — the money discipline

- **Money is integer micro-USD strings** (`"5000"` = $0.005). Floats
  never cross the wire — anywhere.
- Your request can bound an execution: `maxCostMicroUsd`,
  `maxLatencyMs`, `minQuality`.
- The **budgets authority** owns reservations and settlement; the
  result package reports cost only from **settled ledger facts** —
  `null` when unsettled, never a fabricated number.
- Spend is attributed to your `userId` when you pass one.
- For agentic payment intents there is a governed surface with a
  hard rule: **proposing an intent is never an authorization** — see
  [ECONOMICS.md](ECONOMICS.md).

## Sandbox isolation

Executions that need compute run inside governed **sandbox
environments** — disposable, isolated, egress-controlled. The sandbox
axis is a *participant* of an execution, never a second execution
system: the execution lifecycle authority stays the single state
machine, and every sandbox step is journaled into the execution's event
ledger. Admission validates the task and rejects secret-shaped values
**before** anything durable. See [SANDBOX.md](SANDBOX.md).

## Verification and evidence — how outcomes become trustworthy

A COMPLETED execution is bound to **durable verification evidence**:
one or more criterion verdicts (`PASS | FAIL | INCONCLUSIVE`), each
with the strategy that evaluated it, the evaluator provenance
(kind/id/version), a confidence when meaningful, and evidence
references. INCONCLUSIVE verdicts surface as honest warnings in the
result package — never as silent passes. The full story:
[EVIDENCE.md](EVIDENCE.md).

## The governance chain, end to end

```text
your request
  → authentication (bearer Zeck credential)
  → server-side scope derivation (durable membership rows)
  → policy admission            [POLICY_DENIED is possible HERE, before any spend]
  → capability resolution       [CAPABILITY_UNAVAILABLE / NO_ELIGIBLE_ROUTE HERE]
  → budget reservation          [BUDGET_EXCEEDED HERE]
  → planning + route selection  [the platform's compiler decision — never yours]
  → governed execution          [sandbox isolation, tools, agents as participants]
  → verification                [evidence recorded; completion binds to it]
  → result package              [route, cost, usage, artifacts, verification, warnings]
```

Every arrow is an event in the ledger you can read
(`GET /executions/:id/events`), and every failure mode has a stable
code you can branch on ([machine/error-codes.json](machine/error-codes.json)).

## What Zeck is NOT (the honest boundaries)

- Not a thin model gateway — there is no per-model endpoint.
- Not a client-side routing library — routing is server authority.
- Not a place where your provider keys live — BYOK references are held
  server-side ([CONFIGURATION.md](CONFIGURATION.md)).
- Not a silent-degradation platform — unmet capabilities, unsettlement
  and inconclusive verification are *surfaced*, not hidden.

## Source-of-truth pointers

- The wire contract you integrate against: `src/shared/wire.ts`.
- The SDK: `sdk/index.ts`.
- The architecture vocabulary (internal but readable):
  `spec/architecture.md`.
- The API surface: [machine/openapi.json](machine/openapi.json).
