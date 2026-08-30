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
| AGT-003 | WORK-011 | governed agent identity and inventory/catalog | agent inventory integration test |
| AGT-004 | WORK-011 | immutable versioned agent artifacts with validation/rollback metadata | agent version lifecycle test |
| AGT-005 | WORK-011 | mediated scoped credentials with no long-lived raw secrets in agent runtime | credential mediation/security discrimination test |
| AGT-006 | WORK-011 | policy-designated risky agent actions require explicit human approval | approval-gate discrimination test |
| AGT-007 | WORK-016 | external/BYOA agents governed through provider-neutral adapters | BYOA adapter boundary test |
| AGT-008 | WORK-011 | agent session action provenance is durable execution evidence | session audit/provenance integration test |
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
| DTR-001 | WORK-021 | identify recurring AI subgraphs that can be deterministicized | recurring-subgraph discovery test |
| DTR-002 | WORK-021 | validate replacements before promotion | replay/differential/property/mutation test |
| DTR-003 | WORK-021 | progressive shadow/canary replacement with rollback | rollout/rollback integration test |
| DTR-004 | WORK-021 | evidence/confidence/rationale for deterministicization | provenance/evaluation record test |
| DTR-005 | WORK-022 | codebase subgraph AI/deterministic/hybrid advisory analysis | codebase-analysis integration test |
| HUM-001 | WORK-022 | selective human rating when automated uncertainty is material | rating-trigger discrimination test |
| HUM-002 | WORK-022 | human ratings are immutable candidate-linked evidence | rating persistence/provenance test |
| HUM-003 | WORK-022 | low-confidence ratings cannot auto-promote production behavior | promotion-gate discrimination test |
| ACP-001 | WORK-011 | stable governed agent identity and inventory/catalog | agent inventory integration test |
| ACP-002 | WORK-011 | versioned immutable agent artifacts with validation/rollback metadata | agent lifecycle/rollback integration test |
| ACP-003 | WORK-011 | scoped revocable mediated credentials and no long-lived raw secrets in agent code | credential mediation + secret exposure discrimination test |
| ACP-004 | WORK-011 | human approval required for policy-designated risky agent actions | approval-gate integration/discrimination test |
| ACP-005 | WORK-016 | external/BYOA agent frameworks can be registered and governed without duplicate authorities | BYOA interoperability + authority-boundary test |
| ACP-006 | WORK-011 | session actions are execution evidence with who/what/when/why provenance | agent session audit integration test |

Total requirements: **59**.
