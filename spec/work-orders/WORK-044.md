# WORK-044 — Asynchronous execution transport

Status: AUTHORIZED / IN-FLIGHT

Owner: Architect-assigned implementation worker

Architecture Version: D1.0 (deployment/runtime architecture), subordinate to frozen v1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Implement D-03 of the approved Deployment & Runtime Architecture roadmap: make execution dispatch durable, restartable and idempotent without allowing queue state to become Zeck authority.

This order follows WORK-043 / D-02 and must remain strictly within the D-03 scope defined by `docs/DEPLOYMENT-ROADMAP.md`.

# Dependencies

Requires: WORK-043

# Requirement IDs

N/A — asynchronous execution transport phase; acceptance is governed by the deployment architecture and checkpoint contracts below.

# Declared Change Surfaces

- `src/platform/queue/**` queue/transport port implementation and directly-required adapter seams
- existing execution dispatch/journal integration points only where directly required for durable message correlation and idempotent consumption
- provider configuration and secret references directly required for queue transport
- deployment tooling directly required to inspect, replay or validate queue transport
- tests for transport, idempotency, retries, dead-letter behavior, replay, backlog and failure recovery
- CI/deployment configuration directly required for D-03 verification
- `docs/work-items/WORK-044.md`
- directly-required runtime/operations documentation

# Scope Boundaries

Allowed:
- Cloudflare Queues adapter behind an existing/new provider-neutral queue port
- durable dispatch record/message correlation using existing PostgreSQL authority
- idempotent queue consumers
- retry and dead-letter behavior
- bounded delivery/retry budgets
- queue backlog inspection/metrics needed to operate the transport
- replay tooling that re-enters the existing governed execution path
- execution-to-message correlation and provenance
- failure/restart/crash recovery tests
- provider outage/degraded-mode tests
- exact-revision transport verification

Forbidden:
- changing frozen architecture v1.0
- making a queue, message, queue dashboard or broker metadata authoritative domain state
- replacing PostgreSQL authority with queue state
- implementing D-04 durable orchestration/workflows
- implementing D-05 worker deployment fabric or execution worker lifecycle
- implementing D-06 broad production observability/release control
- changing execution lifecycle semantics into a second state machine
- bypassing policy, capability, budget, secret or verification gates
- duplicating existing execution journal authority
- unbounded retry loops or uncontrolled replay
- plaintext secrets in Git, logs, messages, artifacts or API responses
- modifying unrelated product/domain semantics
- modifying `spec/development-state/*` during active implementation
- worker self-merge

# Architecture Invariants

- PostgreSQL remains the sole durable Zeck authority.
- Queue state is transport/progress evidence only; it never establishes execution success or authoritative status.
- Every dispatch has a durable authoritative correlation identity before queue publication.
- Consumer handling is idempotent against the existing authoritative execution semantics.
- Duplicate delivery cannot duplicate authoritative effects.
- A queued message is never equivalent to execution success.
- Retry exhaustion produces an explicit bounded failure/dead-letter state without silently changing domain authority.
- Replay re-enters the existing governed path and cannot bypass admission, budget, capability, secret or verification gates.
- Provider-specific SDKs remain isolated behind the owning transport adapter.
- Queue outage degrades dispatch while preserving authoritative execution state.
- Secrets remain environment-scoped and externally materialized.

# Acceptance Criteria

1. An execution dispatch can be durably recorded in PostgreSQL before asynchronous publication and correlated one-to-one with the transport message.
2. The queue adapter is provider-neutral at the application/domain boundary and the Cloudflare Queues implementation remains isolated in the platform layer.
3. Consumers are idempotent: duplicate delivery of the same message cannot duplicate authoritative execution effects.
4. Retry behavior is bounded, deterministic and observable, with explicit dead-letter behavior after exhaustion.
5. Queue backlog/failure state is inspectable without treating queue state as domain authority.
6. Replay tooling can safely re-enter the governed execution path with explicit bounded controls and full provenance.
7. Queue/provider failure does not silently report execution success and does not create a second authority.
8. Crash/restart recovery proves that interrupted consumption converges to the correct authoritative execution state.
9. Secret and tenant boundaries are preserved across publication, consumption, retry, dead-letter and replay paths.
10. Evidence identifies the exact revision, transport configuration, correlation model, retry/dead-letter rules, replay proof, failure recovery, and final changed-file inventory.

# Implementation Requirements

1. Reuse the existing execution dispatch/journal and authority contracts rather than introducing a second execution state machine.
2. Persist the authoritative dispatch/correlation record before enqueueing any external message whenever the execution path requires a durable handoff.
3. Make publication and consumption semantics explicit under duplicate delivery, timeout, worker crash and provider outage.
4. Use bounded retry/dead-letter controls defined in repository configuration; no infinite automatic retry.
5. Ensure replay cannot bypass policy, capability, budget, secret or verification gates.
6. Keep queue provider identifiers and SDK/types confined to the transport adapter.
7. Record provider-specific assumptions only when verified; unavailable provider evidence must remain NOT RUN with the exact reason.

# Required Checkpoint Contracts

- `SELF-HOSTING-BOUNDARY`
- `IDENTITY-IDEMPOTENCY`
- `CONCURRENCY-CRASH-SAFETY`
- `EXECUTION-PROVENANCE`
- `IMPLEMENTATION-COMPLETENESS`

# Checkpoints

- `SELF-HOSTING-BOUNDARY`
- `IDENTITY-IDEMPOTENCY`
- `CONCURRENCY-CRASH-SAFETY`
- `EXECUTION-PROVENANCE`
- `IMPLEMENTATION-COMPLETENESS`

# Evidence Contract

Evidence must distinguish repository-defined transport configuration from external provider account state. Provider credentials may be used only through connected secret-mediated environments. Any unavailable provider evidence must be recorded as NOT RUN with the exact reason.

Evidence must prove durable correlation before publication, duplicate-delivery convergence, bounded retry/dead-letter behavior, safe replay through the governed execution path, restart recovery and explicit queue-outage behavior.

# Required Verification

- `python3 scripts/governance-check.py`
- typecheck
- lint
- relevant unit/architecture/discrimination suites
- queue adapter contract tests
- durable dispatch/correlation tests against real PostgreSQL
- duplicate-delivery/idempotency tests
- retry/dead-letter tests
- backlog/inspection tests
- replay safety and provenance tests
- crash/restart recovery tests
- provider outage/failure negative paths
- secret-exposure and tenant-isolation tests
- exact-revision transport verification
- full suite twice consecutively at exact final head

# Completion

The worker opens exactly one PR against `main` and does not merge it. Architect review, merge, exact-head verification and post-merge state finalization are mandatory.

# Dispatch Record

- Work Order: WORK-044
- Status: AUTHORIZED / IN-FLIGHT
- Roadmap phase: D-03 — Asynchronous execution transport
- Canonical remote: `payswapdotorg/Zeck`
- Required worker branch: `work/WORK-044-asynchronous-execution-transport`
- Canonical issue: #5
- Binding exact base: `44eaceca4de2af7d531fd1b9bad5a14b14d3b69e`
- Worker must not modify `spec/development-state/*` during active implementation.
- Worker must not merge its own PR.
