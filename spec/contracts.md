# Core Contracts and Semantics

This is the normative implementation-level contract subordinate to `spec/architecture.md`.

## Execution creation

```ts
createExecution(input, idempotencyKey, actor): Promise<ExecutionReceipt>
```

Input must identify application/environment, task, optional input artifact references, desired
quality/cost/latency constraints, and optional user metadata. Provider selection is forbidden in
the public create contract.

## Core transition commands

| Current | Command | Next |
|---|---|---|
| CREATED | authorize | AUTHORIZED |
| AUTHORIZED | plan | PLANNING |
| PLANNING | queue | QUEUED |
| QUEUED | start | RUNNING |
| RUNNING | wait-tool | WAITING_TOOL |
| WAITING_TOOL | resume | RUNNING |
| RUNNING | wait-user | WAITING_USER |
| WAITING_USER | resume | RUNNING |
| RUNNING | wait-human | WAITING_HUMAN |
| WAITING_HUMAN | resume | RUNNING |
| RUNNING | verify | VERIFYING |
| VERIFYING | pass | COMPLETED |
| VERIFYING | replan | REPLANNING |
| REPLANNING | queue | QUEUED |
| RUNNING | fail | FAILED |
| VERIFYING | fail | FAILED |
| CREATED/AUTHORIZED/PLANNING/QUEUED/RUNNING/WAITING_* /VERIFYING/REPLANNING | cancel | CANCELLED |
| CREATED/AUTHORIZED/PLANNING/QUEUED/RUNNING/WAITING_* /VERIFYING/REPLANNING | expire | EXPIRED |
```

Every transition to `COMPLETED` is produced by `/verification` and is bound to at least one durable verification result. There is no provider-success or planner-success shortcut to completion.

## Error taxonomy

Errors are typed and machine-readable:

- `AUTHENTICATION_FAILED`
- `AUTHORIZATION_DENIED`
- `TENANT_SCOPE_VIOLATION`
- `POLICY_DENIED`
- `BUDGET_EXCEEDED`
- `IDEMPOTENCY_KEY_REUSED`
- `CAPABILITY_UNAVAILABLE`
- `NO_ELIGIBLE_ROUTE`
- `PROVIDER_ERROR`
- `TOOL_ERROR`
- `AGENT_ERROR`
- `SANDBOX_ERROR`
- `VERIFICATION_FAILED`
- `VERIFICATION_INCONCLUSIVE`
- `NON_CONVERGENT_EXTERNAL_EFFECT`
- `INVALID_STATE_TRANSITION`
- `EXPIRED`

Provider-specific errors are normalized into the appropriate provider-neutral class and retained
as adapter details in evidence, never as domain control flow.

## Public module rule

Every module must expose one `public.ts` barrel containing only stable interfaces, input/output
schemas, and commands intended for other modules. Internal files are not public API.

## Idempotency response rule

The same `(applicationId, operationName, idempotencyKey, requestFingerprint)` returns the same
logical durable outcome. Same key + different fingerprint fails. Concurrent identical requests
converge to one durable identity using PostgreSQL uniqueness/transactional arbitration.


## Application Delegation Boundary (ACR-007)

The supported external delegation shape is outcome/task + application/environment identity + application-owned context/artifact references + constraints + idempotency + correlation metadata. Provider/model selection is not part of the application contract.

A customer-facing SDK or HTTP adapter MAY expose convenience types, but it MUST compile to the same public execution contract and MUST NOT replicate policy, capability resolution, budget authorization, routing, retry policy, execution lifecycle, verification, evidence or optimization.

Short work may use a receipt-oriented request. Durable work may use asynchronous status retrieval and webhooks/events. Large inputs/outputs use artifact references. Persistent bidirectional realtime work uses the existing RealtimeRail rather than creating a parallel execution lifecycle.

For compatibility certification, the declared application execution graph, observed runtime egress, and Zeck execution/evidence correlation are three independent proof sources. A mismatch is a certification finding. A reverse proxy is not sufficient evidence of Zeck execution authority when the application still owns provider credentials, provider choice, provider fallback or provider-specific semantics.

