# Requirement Traceability

Every frozen requirement has exactly one primary owning Work Order and an objective proof target.
Secondary implementations must not create a second authority for a requirement.

| Requirement | Owner | Requirement | Proof target |
|---|---|---|---|
| API-001 | WORK-015 | API create execution without provider selection | integration/API + contract test |
| API-002 | WORK-015 | SDKs expose execution abstraction | SDK contract tests |
| API-003 | WORK-006 | mutating execution requests support idempotency | concurrency/idempotency integration test |
| API-004 | WORK-015 | execution lifecycle webhooks | webhook delivery integration test |
| API-005 | WORK-015 | receipt/provenance/cost/quality inspection | API receipt contract test |
| CON-001 | WORK-003 | provider-independent connection contracts | adapter contract tests |
| CON-002 | WORK-003 | BYOK first-class | secret-reference + adapter integration test |
| CON-003 | WORK-003 | OpenRouter rail | OpenRouter adapter integration/contract test |
| CON-004 | WORK-003 | direct adapters coexist with aggregation rail | multi-adapter routing test |
| CON-005 | WORK-003 | provider vs quality failure distinction | error taxonomy integration test |
| BUD-001 | WORK-004 | per-execution/monthly budgets | budget integration tests |
| BUD-002 | WORK-004 | user spending limits | policy/budget integration test |
| BUD-003 | WORK-004 | funding modes | funding-mode matrix test |
| BUD-004 | WORK-004 | concurrency-safe reservations | two-connection PostgreSQL race test |
| BUD-005 | WORK-004 | append-only settlement ledger | ledger immutability + settlement test |
| POL-001 | WORK-007 | effective policy resolution | policy precedence integration test |
| POL-002 | WORK-007 | policy restrictions | admission boundary integration test |
| POL-003 | WORK-007 | lower-level policy cannot weaken prohibition | discrimination test |
| INT-001 | WORK-009 | structured task profile | planner unit/contract test |
| INT-002 | WORK-005 | capability requirements before provider selection | capability-order discrimination test |
| INT-003 | WORK-009 | composable execution plans | plan graph integration test |
| INT-004 | WORK-009 | cheap-first/cascade planning | route selection test |
| INT-005 | WORK-013 | escalation after unmet verification thresholds | verification-to-replan test |
| INT-006 | WORK-014 | historical performance influences plans safely | shadow-learning integration test |
| CTX-001 | WORK-008 | task-specific context artifacts | context compiler integration test |
| CTX-002 | WORK-008 | lineage preservation | artifact lineage test |
| TOL-001 | WORK-010 | policy-gated tool invocation | pre-dispatch discrimination test |
| TOL-002 | WORK-010 | tool results as evidence | tool evidence integration test |
| TOL-003 | WORK-014 | tool outcome learning | tool scorecard test |
| TOL-004 | WORK-018 | future tool synthesis under same execution abstraction | synthesis contract test |
| AGT-001 | WORK-011 | agents distinct from models | agent/model boundary test |
| AGT-002 | WORK-011 | session/workspace bound to execution | tenant/session integration test |
| ENV-001 | WORK-012 | provider-independent ComputeEnvironment | environment contract tests |
| ENV-002 | WORK-012 | isolated containers | sandbox integration/discrimination test |
| ENV-003 | WORK-019 | microVM/VM evolution path | fleet adapter contract test |
| VER-001 | WORK-013 | verification distinct from provider success | discrimination integration test |
| VER-002 | WORK-013 | evidence attached to execution | verification persistence test |
| VER-003 | WORK-013 | human/user escalation as execution step | state machine integration test |
| VER-004 | WORK-013 | candidate comparison gated | policy/planner discrimination test |
| LRN-001 | WORK-014 | outcomes recorded for routing/tool/context/etc. | learning telemetry integration test |
| LRN-002 | WORK-020 | learning cannot bypass authority | policy/learning discrimination test |
| WOS-001 | WORK-016 | WorkflowOS submits work through provider-neutral contract | adapter contract test |
| WOS-002 | WORK-016 | WorkflowOS owns workflow state | authority-boundary integration test |
| WOS-003 | WORK-016 | Execution OS returns evidence/artifacts without workflow mutation | negative capability test |
| WOS-004 | WORK-016 | concept mapping without duplicate authority | mapping compatibility test |

Total requirements: **45**.
