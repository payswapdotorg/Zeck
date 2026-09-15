# Provider, model and tool configuration

**One sentence:** you configure NOTHING about providers in your
integration — provider connections are **BYOK references** held
server-side by the platform, capabilities are expressed as neutral
requirements, and routing is the platform's compiler decision; your
levers are the task shape, the constraints and (platform-side) the
policy documents.

## Why there is no provider configuration in the SDK

The create contract is closed and provider-selection-free BY
CONSTRUCTION: the keys `provider, providerId, model, modelId, rail,
connectionId, connection, agent, agentId` are rejected fail-closed
(API-001) — a client tenant/provider injection is unrepresentable, not
merely ignored. This is the platform's core neutrality guarantee, and
it means:

- your integration code never changes when providers change;
- you never hold provider credentials (attack surface: zero);
- the compiler optimizes across the whole authorized provider set on
  your behalf.

## What you CAN express (your actual levers)

| Lever | Where | Vocabulary |
|---|---|---|
| Task shape | `task` on create | Open, family-specific (`{kind: "summarize", …}`) — see [WORKLOADS.md](WORKLOADS.md) |
| Cost bound | `constraints.maxCostMicroUsd` | Integer micro-USD string |
| Latency bound | `constraints.maxLatencyMs` | Milliseconds |
| Quality floor | `constraints.minQuality` | Number |
| Input artifacts | `inputArtifactRefs` | Platform artifact references |
| End-user attribution | `userId` | Your user identity |
| Environment | `environmentId` | e.g. a sandbox environment ([SANDBOX.md](SANDBOX.md)) |

## What the PLATFORM configures (operator-side, cross-linked)

These surfaces are owned by the deployment delivery (DEP-001/D-01) —
cross-linked here, never duplicated:

- **Provider connections** — BYOK references in the platform's secret
  store (`deploy/manifests/secret-references.json`,
  `zeck-secret://<environment>/…` URIs; the reference is non-secret,
  the materialized value never is).
- **Provider topology** — the concern → provider map with owning ports
  and degradation modes (`deploy/manifests/providers.json`).
- **Policy documents** — scope selectors and restriction vocabularies
  admitted before dispatch (the policies authority; a restriction can
  narrow what your application may do — surfaced as `POLICY_DENIED`).
- **Capability catalog** — provider-neutral claims, evidence- and
  version-bound, arbitrated by the registry
  ([machine/capability-manifest.json](machine/capability-manifest.json)
  is the public projection of the seeded set).

## Capability requirements (the neutral "I need" vocabulary)

When a surface accepts explicit requirements (economic actions'
`requiredCapabilities`), you name capabilities neutrally:

```json
{ "kind": "tool", "name": "human-review", "minVersion": "1.0.0" }
```

- `kind`: `model | tool | algorithm | data | runtime | human`.
- `name`: a capability id from the neutral vocabulary (seeded set:
  `text-generation, document-retrieval, json-schema-validation,
  structured-dataset-read, process-sandbox, human-review`).
- `minVersion`: optional floor (`major[.minor[.patch]]`).

Unmet requirements fail closed with `CAPABILITY_UNAVAILABLE` /
`NO_ELIGIBLE_ROUTE` — never a silent degradation.

## Tools

Tools are platform-governed participants of an executed plan. As an
integrator you name tools neutrally inside the task shape
(`{kind: "use-tool", goal, tools: ["calculator"]}`) and read their
invocations as step events. Tool registration, synthesis and runtime
are authority surfaces — there is no public tool-configuration route,
by design.

## Agents

Agent inventory is read-only projection ([AGENTS.md](AGENTS.md)).
Agent identity, versions and promotions are governed authority
surfaces — again by design, no public mutation route.

## Rate and usage semantics (the honest model)

The public wire contract has no HTTP-level rate-limit headers today —
usage is bounded by the platform's governed economic model, which is
what you actually integrate against:

| Bound | Surface | Behavior when exceeded |
|---|---|---|
| Per-run cost | `constraints.maxCostMicroUsd` (your request) | `BUDGET_EXCEEDED` 402 — BEFORE spend, not after |
| Per-run latency | `constraints.maxLatencyMs` | No eligible route under the bound → `NO_ELIGIBLE_ROUTE` 422 |
| Aggregate spend | Application/environment budgets (platform-side) | `BUDGET_EXCEEDED` 402 on admission |
| Concurrency | Sandbox/environment limits (platform-side) | Honest admission denial — never unbounded silent queueing |
| Provider quota | The provider's own quota (recorded availability) | `PROVIDER_ERROR` 502 with the recorded boundary (e.g. the video free-tier `AllocationQuota.FreeTierOnly` fact) |
| Usage reporting | `ExecutionResult.usage` (`inputTokens`/`outputTokens`) | Provider-reported when the rail reports it; `null` otherwise — never fabricated |

Retry behavior for exhausted bounds is deterministic: budget denials
are NOT retryable unchanged (raise the bound or change the request);
provider-quota boundaries are recorded availability facts (see
[AVAILABILITY.md](AVAILABILITY.md)) — retrying reproduces the same
boundary. Operator-side quota alert thresholds live in
`deploy/manifests/quota-guards.json` (DEP-001/D-06 — cross-linked).

## Provider availability (the honest part)

The authorized provider set and its RECORDED availability (live-proven
rails, region blocks, quota boundaries, DNS failures, absent
capabilities) is documented in [AVAILABILITY.md](AVAILABILITY.md) with
its machine projection in
[machine/capability-manifest.json](machine/capability-manifest.json)
(`providerAccess`). If your workload family is provider-gated, no
request-shape change on your side will complete it — the gate is a
capability/credential fact, disclosed honestly.

## Common configuration failures

| Symptom | Root cause | Remedy |
|---|---|---|
| `NO_ELIGIBLE_ROUTE` on a media task | The deployment lacks the family's rails | See [AVAILABILITY.md](AVAILABILITY.md); resolve with the operator |
| `POLICY_DENIED` on a task shape | A published restriction narrows the vocabulary | Request a policy amendment (platform-side) — never a workaround |
| `BUDGET_EXCEEDED` with a generous bound | No eligible route under the bound | Relax `maxLatencyMs`/`minQuality` or raise the cost bound |
| Provider key in `ZECK_TOKEN` | Credential confusion | `ZECK_TOKEN` is a Zeck credential only — provider keys never appear client-side |

Public contract links: `src/shared/wire.ts` (`FORBIDDEN_REQUEST_KEYS`),
`src/modules/capabilities/domain/capability.ts` (the capability
vocabulary), `deploy/manifests/secret-references.json` and
`deploy/manifests/providers.json` (operator-side, owned by DEP-001).
