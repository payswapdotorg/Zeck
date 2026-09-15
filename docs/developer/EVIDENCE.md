# Evidence, provenance and cost inspection

**One sentence:** every completed execution carries a **result package**
(route, settled cost, usage, artifacts, verification evidence, honest
warnings) plus the ordered **event ledger** — together the full audit
trail, computed only from authority reads.

## The evidence surfaces

| Surface | Route | What it gives you |
|---|---|---|
| Result package | `GET /executions/:id/results` | The end-state summary (below) |
| Event ledger | `GET /executions/:id/events` | Every lifecycle transition, planning decision and step fact, ordered |
| Verification results | `GET /executions/:id/verification` | The evidence axis: criterion verdicts with provenance |

All three are scoped reads (`X-Zeck-Application`), all payloads are
scrubbed (secret-shaped keys redacted), all are available from the SDK
(`getResult`, `listEvents`, `listVerification`).

## The result package (nine-part treatment)

### 1. One-sentence explanation

`ExecutionResult` is the honest end-state of one execution: what
status it reached, which route executed it, what it cost, what it
produced, what the verification authority recorded, and what the
platform itself wants to warn you about.

### 2. Conceptual model

```text
ExecutionResult
├── status            the terminal (or current) status
├── route             {provider, model, strategyClass, modelCalls} — opaque neutral
│                     strings from the ledger's planning decision, or null
├── cost              {totalMicroUsd, currency:"usd"} — from SETTLED facts, or null
├── usage             {inputTokens, outputTokens} — provider-reported, or null
├── outputArtifacts   [{id, digest(sha256 hex|null), createdAt}]
├── verification      [VerificationResult] — the evidence axis
├── warnings          honest strings (INCONCLUSIVE counts, failure notices)
└── terminalAt        when it became terminal
```

The honesty rules that matter: **cost and usage appear only when the
durable ledger carries settled facts** — `null` otherwise, never a
fabricated number. Route strings are neutral identifiers you can *read*
but never *write*.

### 3. Minimal API example

```bash
curl "$ZECK_API_URL/executions/<executionId>/results" \
  -H "authorization: Bearer $ZECK_TOKEN" \
  -H "x-zeck-application: $ZECK_APPLICATION_ID"
```

### 4. SDK example

```typescript
const result = await client.getResult(executionId);
if (result.cost === null) {
  console.log("cost: not settled — the platform reports null, never a guess");
} else {
  console.log(`cost: ${result.cost.totalMicroUsd} micro-USD`);
}
for (const warning of result.warnings) {
  console.warn(`platform warning: ${warning}`);
}
```

Runnable: `examples/quickstart.ts` (steps 5–6) and every workload
example prints the package via `examples/lib/poll.ts`
(`printExecutionSummary`).

### 5. Request/response schemas

`ExecutionResult` and `VerificationResult` are frozen wire types
(`src/shared/wire.ts`); machine projection:
[machine/openapi.json](machine/openapi.json)
(`ExecutionResult`, `VerificationResult`, `CostSummary`, `UsageSummary`,
`RouteSummary`, `ArtifactReference`).

A `VerificationResult` carries: `id, executionId, criterionId,
strategy, status (PASS|FAIL|INCONCLUSIVE), confidence|null, evaluator
{kind,id,version}, evidenceRefs[], recordedAt`.

### 6. Expected lifecycle

The result package is readable at ANY time — before completion it
reflects the current status with unsettled axes null; after the
terminal event it is the durable end-state. Verification results land
during the `VERIFYING` phase and are bound into completion (a COMPLETED
execution is bound to durable verification evidence).

### 7. Security and policy notes

- Result computation reads only authority surfaces — the API never
  derives facts from client input.
- Event payloads and webhook payloads are scrubbed: secret-shaped keys
  and credential-shaped values never cross.
- Artifacts are references (id + digest) — bytes live in the
  platform's object store; digests let you verify content integrity
  end-to-end.

### 8. Cost/latency considerations

- Cost is integer micro-USD (`"5000"` = $0.005) — display conversion
  is your concern (`microUsdToUsdDisplay` in `examples/lib/poll.ts`).
- `usage.inputTokens/outputTokens` are provider-reported when the rail
  reports them — null otherwise.
- The route summary's `modelCalls` counts the plan's model calls — a
  cheap proxy for execution weight.

### 9. Common failures and remedies

| Observation | Meaning | Remedy |
|---|---|---|
| `cost: null` on a COMPLETED execution | No settled usage facts in the ledger | Expected for deterministic-only strategies (no model spend); not an error |
| `route: null` | No planning decision recorded | Check events for `planning.decision-recorded`; expected for pre-planning failures |
| INCONCLUSIVE verification + warning | A criterion could not decide | Inspect the criterion's strategy/confidence; strengthen the task or evidence |
| `status: FAILED` + warning | The execution failed | Read the events for the failure envelope — see [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |

## The event ledger (provenance)

`GET /executions/:id/events` returns ordered
`{eventId, executionId, type, sequence, occurredAt, payload}` records.
The types you will see in practice include `execution.created`,
lifecycle transitions, `planning.decision-recorded` (the candidates +
selected strategy that feed the route summary), step facts (tool
invocations, agent sessions, sandbox steps) and the completion envelope
with settled cost/usage/artifacts. Sequences are monotonic — use
`lastEventSequence` from the receipt as a resume cursor.

```typescript
const events = await client.listEvents(executionId);
for (const event of events) {
  console.log(`#${event.sequence} ${event.type} @ ${event.occurredAt}`);
}
```

## Beyond executions (the other evidence-bearing surfaces)

- **Economic actions** — settlement and delivery as SEPARATE evidence
  axes: [ECONOMICS.md](ECONOMICS.md).
- **Codebase analysis** — advisory findings with pinned provenance
  (repository, revision, targets): [CODEBASE-ANALYSIS.md](CODEBASE-ANALYSIS.md).
- **Webhooks** — the same events, pushed and signed:
  [WEBHOOKS.md](WEBHOOKS.md).

Public contract links: `src/shared/wire.ts` (`ExecutionResult`,
`VerificationResult`, `ArtifactReference`, `CostSummary`),
`src/api/routes/executions.ts` (the projections over the ledger),
[machine/openapi.json](machine/openapi.json).
