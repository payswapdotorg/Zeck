# WORK-045 — Durable orchestration

Status: AUTHORIZED / IN-FLIGHT

Owner: Architect-assigned implementation worker

Architecture Version: D1.0 (deployment/runtime architecture), subordinate to frozen v1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Implement D-04 of the approved Deployment & Runtime Architecture roadmap: add durable orchestration for waits, callbacks, approvals, retries and deployment operations while keeping orchestration state subordinate to Zeck's authoritative PostgreSQL state.

This order follows WORK-044 / D-03 and must remain strictly within the D-04 scope defined by `docs/DEPLOYMENT-ROADMAP.md`.

# Dependencies

Requires: WORK-044

# Requirement IDs

N/A — deployment/runtime durable-orchestration phase; acceptance is governed by the deployment architecture and checkpoint contracts below.

# Declared Change Surfaces

- `src/platform/workflow/**` workflow/orchestration port implementation and directly-required adapter seams
- existing execution/workflow integration points only where directly required for durable correlation and governed resume
- provider configuration and secret references directly required for workflow orchestration
- deployment tooling directly required to inspect, validate or recover workflow orchestration
- tests for workflow correlation, waits, callbacks, approvals, retries, timeouts, expiration and restart recovery
- CI/deployment configuration directly required for D-04 verification
- `docs/work-items/WORK-045.md`
- directly-required runtime/operations documentation

# Scope Boundaries

Allowed:
- a provider-neutral workflow/orchestration port behind the existing architecture boundary
- Cloudflare Workflows adapter or equivalent reference provider implementation
- execution/workflow durable correlation using existing PostgreSQL authority
- durable waits, callbacks, approvals and resumable workflow progress
- bounded orchestration retries and provider-limit-aware controls
- timeout and expiration handling
- orchestration state compaction where required for bounded provider state
- restart/resume recovery tests
- workflow backlog/failure inspection needed to operate orchestration
- exact-revision workflow verification

Forbidden:
- changing frozen architecture v1.0
- making workflow/provider state authoritative domain state
- replacing PostgreSQL authority with workflow state
- implementing D-05 worker deployment fabric or execution worker lifecycle
- implementing D-06 broad production observability/release control
- changing execution lifecycle semantics into a second state machine
- bypassing policy, capability, budget, secret or verification gates
- duplicating the execution journal or creating a second durable authority
- storing large artifact bytes in workflow state
- storing secret values or credentials in workflow state
- unbounded workflow retries or uncontrolled replay/resumption
- plaintext secrets in Git, logs, workflow state, artifacts or API responses
- modifying unrelated product/domain semantics
- modifying `spec/development-state/*` during active implementation
- worker self-merge

# Architecture Invariants

- PostgreSQL remains the sole durable Zeck authority.
- Workflow state is orchestration/progress evidence only; it never establishes execution success or authoritative status.
- Every long-lived workflow is durably correlated to authoritative Zeck state before relying on provider workflow state for continuation.
- Resume/retry operations re-enter the existing governed execution and admission paths rather than bypassing them.
- Waiting executions survive process and provider-worker restarts without creating a second authority.
- Human approval/callback state remains bounded, tenant-scoped and attributable to the authoritative execution/workflow identity.
- Provider-specific SDKs and workflow types remain isolated behind the owning platform adapter.
- Large artifacts and secret values remain outside workflow state; workflow payloads carry references only.
- Provider limits are explicit, bounded and operationally inspectable.
- Workflow/provider outage degrades orchestration without fabricating authoritative execution progress.

# Acceptance Criteria

1. A long-lived orchestration can be durably correlated to authoritative PostgreSQL execution state before provider workflow state is relied upon for continuation.
2. The workflow boundary is provider-neutral and provider-specific workflow implementation remains isolated in the platform adapter.
3. Waiting executions resume correctly after application/provider process restart without creating duplicate authoritative effects.
4. Callbacks and human approvals are durable, tenant-scoped, attributable and cannot bypass governed admission or execution transitions.
5. Retry behavior is bounded and deterministic, with explicit failure/expiration outcomes and no infinite orchestration loop.
6. Timeout/expiration handling is durable, observable and cannot silently change authoritative execution state outside the governed path.
7. Workflow/provider outage never becomes a second authority and never reports execution success that PostgreSQL does not establish.
8. Orchestration state remains bounded/compactable; large artifact bytes and secret values never enter workflow state.
9. Provider limits and degradation behavior are explicit, inspectable and testable at the exact revision.
10. Evidence identifies the exact revision, workflow configuration, execution/workflow correlation model, wait/callback/approval semantics, retry/expiration rules, recovery proof, and final changed-file inventory.

# Implementation Requirements

1. Reuse the existing execution authority, policy/admission, capability, budget, secret and verification contracts rather than introducing parallel authorization semantics.
2. Persist the authoritative workflow/execution correlation before relying on external workflow continuation state whenever a durable handoff is required.
3. Make wait, callback, approval, retry, timeout and resume semantics explicit under duplicate notifications, provider retries, process crash and provider outage.
4. Use bounded retry, timeout and expiration controls defined in repository configuration; no infinite workflow loops.
5. Ensure every resume path re-enters the existing governed execution path and cannot bypass admission or verification.
6. Keep provider identifiers, SDKs and provider workflow state types confined to the workflow adapter.
7. Keep workflow payloads reference-only for artifacts and secrets; values and large bytes stay outside workflow state.
8. Record provider-specific assumptions only when verified; unavailable provider evidence must remain NOT RUN with the exact reason.

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

Evidence must distinguish repository-defined workflow configuration from external provider account state. Provider credentials may be used only through connected secret-mediated environments. Any unavailable provider evidence must be recorded as NOT RUN with the exact reason.

Evidence must prove authoritative correlation before durable workflow continuation, duplicate/retry convergence, wait/callback/approval durability, bounded retry/expiration behavior, restart recovery, provider outage degradation, provider-limit handling and exclusion of large artifacts and secret values from workflow state.

# Required Verification

- `python3 scripts/governance-check.py`
- typecheck
- lint
- relevant unit/architecture/discrimination suites
- workflow adapter contract tests
- durable execution/workflow correlation tests against real PostgreSQL
- wait/callback/approval durability tests
- duplicate notification/idempotency tests
- retry/expiration/timeout tests
- restart/resume/crash recovery tests
- provider outage/failure negative paths
- provider-limit and bounded-state tests
- secret-exposure and tenant-isolation tests
- artifact-reference/large-payload safety tests
- exact-revision workflow verification
- full suite twice consecutively at exact final head

# Completion

The worker opens exactly one PR against `main` and does not merge it. Architect review, merge, exact-head verification and post-merge state finalization are mandatory.

# Dispatch Record

- Work Order: WORK-045
- Status: AUTHORIZED / IN-FLIGHT
- Roadmap phase: D-04 — Durable orchestration
- Canonical remote: `payswapdotorg/Zeck`
- Required worker branch: `work/WORK-045-durable-orchestration`
- Canonical issue: #7
- Binding exact base: `6cfbd936475a457886a174adeb457faf9b974ce9`
- Worker must not modify `spec/development-state/*` during active implementation.
- Worker must not merge its own PR.
