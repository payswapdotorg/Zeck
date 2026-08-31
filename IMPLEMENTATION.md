# AI Execution OS — Implementation Contract

This document is subordinate to `spec/architecture.md` and `spec/architecture-lock.md`.
It makes the frozen architecture concrete enough for a fresh implementation worker to build
without conversational context. Changes must remain consistent with the frozen architecture
and be authorized through the Work Order protocol.

## 1. Initial stack

- Language: TypeScript, strict mode.
- Runtime/toolchain: Bun 1.x for package management, scripts and local development.
- HTTP/API: Fastify.
- Database: PostgreSQL 16+.
- Cache/coordination: Redis 7+ only where a durable DB transaction is not the authority.
- Object storage: S3-compatible storage behind an `ObjectStore` port.
- Validation/contracts: Zod at transport/adapter boundaries; domain types remain provider-neutral.
- Tests: Vitest + Testcontainers (or equivalent real PostgreSQL/Redis containers in CI).
- Formatting/linting: Biome.
- IDs: UUIDv7 for sortable durable identifiers; idempotency keys are caller-provided opaque strings.
- Migrations: SQL migrations committed under `src/platform/db/migrations/` and never edited after merge.

No provider SDK may be imported outside its owning adapter package/module.

## 2. Repository layout

```text
src/
  api/                         # transport only
  platform/                    # config, db, redis, object-store, clocks, crypto
  modules/
    auth/
    applications/
    connections/
    policies/
    budgets/
    capabilities/
    executions/
    planning/
    models/
    tools/
    agents/
    deployments/
    context/
    sandbox/
    verification/
    learning/
    artifacts/
    webhooks/
    audit/
  integrations/
    workflowos/
  shared/                      # truly cross-cutting, dependency-light primitives

tests/
  unit/
  integration/
  architecture/
  discrimination/
  fixtures/

docs/work-items/               # implementation evidence, one file per Work Order
spec/                          # governing architecture and development state
scripts/                       # deterministic repository checks
```

Each module is split conceptually into:

```text
module/
  public.ts                    # only supported cross-module imports
  domain/                       # entities, invariants, value objects
  application/                  # use cases / orchestration local to module
  ports/                        # outbound/inbound interfaces
  adapters/                     # infrastructure/provider implementations
  internal/                     # never imported by another module
```

## 3. Dependency rule

Allowed direction:

```text
api -> module public contract -> module application/domain -> module ports -> adapters/platform
```

Forbidden:

- `api` importing `internal` implementation files.
- module A importing module B's `internal` directory.
- domain code importing Fastify, Redis, PostgreSQL clients, provider SDKs or HTTP libraries.
- platform importing domain modules.
- provider adapters becoming the source of truth for domain state.

Cross-module interaction uses explicit public ports/contracts and is covered by architecture tests.

## 4. Core identifiers and envelopes

### ExecutionId

A UUIDv7 created exactly once for an accepted logical execution.

### Idempotency

Every mutating external API operation requires an idempotency key. The server derives a scope:

```text
(application_id, operation_name, idempotency_key)
```

The first successful admission stores the request fingerprint and durable outcome. A retry with
the same key and different fingerprint is rejected with `IDEMPOTENCY_KEY_REUSED`.

### EventEnvelope

Every persisted execution event contains at least:

```json
{
  "eventId": "uuidv7",
  "executionId": "uuidv7",
  "applicationId": "uuidv7",
  "type": "string",
  "sequence": 1,
  "occurredAt": "RFC3339 timestamp",
  "producerModule": "executions",
  "schemaVersion": 1,
  "payload": {}
}
```

`sequence` is monotonically increasing per execution. Events are append-only.

## 5. Execution state authority

`/executions` alone owns the execution state machine. The authoritative states are:

`CREATED, AUTHORIZED, PLANNING, QUEUED, RUNNING, WAITING_TOOL, WAITING_USER,
WAITING_HUMAN, VERIFYING, REPLANNING, COMPLETED, FAILED, CANCELLED, EXPIRED`.

A transition is valid only if the current state and command match the transition table in
`spec/architecture.md §8` plus the detailed table in `spec/contracts.md`. No other module may
write execution status directly.

## 6. Result and evidence model

A completed execution produces an immutable result package:

```text
ExecutionReceipt
  executionId
  finalStatus
  outputArtifactIds[]
  verificationIds[]
  provenanceGraphId
  routeSummary
  usageSummary
  costSummary
  warnings[]
  timestamps
```

Provider success, execution success, policy success and quality success are distinct signals.

## 7. Policy-before-dispatch rule

The dispatch sequence is always:

```text
request -> identity/tenant resolution -> effective policy -> budget reservation (when needed)
-> capability resolution -> plan -> dispatch authorization -> adapter call
```

A provider/tool/agent/sandbox adapter must not receive executable work before the dispatch gate
returns an allow decision. Secret resolution also occurs after policy approval and immediately
before the authorized adapter call.

## 8. Budget and ledger semantics

Reservations and settlement are transactional at PostgreSQL authority boundaries.

- Reserve before an operation that can incur billable usage.
- Reuse the same reservation on retry of the same logical operation.
- Settle actual usage once.
- Release the unspent remainder once.
- Append-only ledger rows cannot be updated or deleted; corrections are compensating entries.
- Negative balances are never silently created by retry races.

## 9. Secrets / BYOK

BYOK credentials are represented by a secret reference, not ordinary domain fields. A
`SecretStore` adapter owns encryption/decryption and provider credential materialization.
Application APIs never return secret plaintext. Logs, execution artifacts and model/tool context
must reject secret-bearing payloads unless explicitly classified and authorized.

## 10. Provider federation

Provider-neutral contracts cover:

- model metadata/capabilities
- request normalization
- streaming chunks
- structured output
- tool calls
- asynchronous jobs
- usage/cost reporting
- provider errors

OpenRouter is one adapter/rail. A direct provider adapter may coexist with it. Routing decisions
must reference capability/quality/cost/latency facts, never provider-specific types.

## 11. Sandboxing

The initial implementation supports `no-execution`, `process`, and `container` environments.
The `ComputeEnvironment` port has an explicit capability for stronger isolation so microVM/VM
implementations can be added without changing the execution abstraction.

Untrusted code receives no ambient host credentials, unrestricted host filesystem access, or
unbounded network access. Network and secret access are explicit capabilities evaluated by policy.

## 12. Verification

Every verifier returns an evidence record, not merely a boolean:

```text
verificationId
executionId
criterionId
strategy
status: PASS | FAIL | INCONCLUSIVE
confidence
observations[]
artifactIds[]
verifierIdentity
revision/context binding
createdAt
```

`PASS` from a provider adapter is never converted automatically into verification `PASS`.

## 13. Learning safety

Learning consumes immutable historical outcomes and emits recommendations/scorecards. Learned
weights, rankings or policies are never an authorization primitive. A learned recommendation
is re-evaluated through the current policy engine before dispatch.

## 14. External side effects

External side effects are implemented with:

```text
intent persisted -> gate approved -> adapter dispatch -> observation persisted -> reconcile
```

The side-effect boundary must provide create-or-converge behavior where the external API permits
it. If convergence cannot be proven, the operation fails closed as non-convergent rather than
silently guessing.

## 15. Work Order implementation rule

A worker must be able to answer these questions from the repository before coding:

1. What architecture version governs me?
2. Is my Work Order eligible?
3. What exact requirements do I own?
4. What exact files/modules may I touch?
5. Which invariants and checkpoint contracts apply?
6. What tests must pass, including discrimination tests?
7. What evidence must be recorded before opening the PR?
8. What facts remain authoritative after merge?

`spec/work-orders/WORK-NNN.md` supplies the item-specific answers; this file supplies the shared
implementation rules.
