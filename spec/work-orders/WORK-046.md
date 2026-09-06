# WORK-046 — Execution worker deployment fabric

Status: AUTHORIZED / IN-FLIGHT

Owner: Implementation worker; Architect retains review, merge and state-finalization authority

Architecture Version: v1.0 (frozen); Deployment & Runtime Architecture D1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Implement the D-05 execution-plane deployment fabric so model, tool, agent and program work can execute independently of request lifetimes while preserving Zeck's existing execution, policy, capability, budget, secret, tenant and verification authorities.

The worker runtime must be a replaceable execution-plane implementation, not a second source of execution truth. Durable execution identity, lifecycle and authoritative effects remain in Zeck PostgreSQL and the existing execution authority.

# Dependencies

Requires: WORK-045

Enables: D-06 production delivery, observability and release control

# Requirement IDs

- `ENV-001`
- `ENV-002`
- `ENV-003`
- `LNG-001`
- `LNG-002`
- `LNG-003`
- `AGT-005`
- `AGT-008`
- `CSX-001`
- `CSX-002`
- `CSX-003`
- `CSX-004`

# Declared Change Surfaces

Modules: `src/platform/compute/**`, `src/modules/sandbox/**`, `src/modules/executions/**` only where required to consume the established worker/lease boundary; D-05 deployment manifests and operator tooling; D-05 tests and evidence; `spec/work-orders/WORK-046.md`.

Schema: allowed only for the minimum worker-lease/heartbeat/runtime-correlation persistence required to make stale-worker recovery authoritative and idempotent; existing execution authority remains the source of truth.

Public contracts: only the provider-neutral worker/compute/lease contracts required by this Work Order; no replacement of existing execution, policy, budget, secret or verification APIs.

External side effects: worker process/container lifecycle, execution dispatch consumption, model/tool/agent/program provider calls through existing governed adapters, cancellation and drain signals, and optional customer-runner registration metadata without granting customer runners independent authority.

Authority/security/tenant impact: high; every worker action must retain application/environment/execution identity, tenant isolation, policy-before-dispatch, capability/budget admission, secret mediation, provenance and verification boundaries.

# Scope Boundaries

Allowed:

- provider-neutral execution-worker service boundary;
- worker runtime adapters for the existing ComputeEnvironment abstraction;
- container-backed ComputeEnvironment implementation for v1.0;
- durable execution lease ownership, heartbeats, expiration and stale-worker fencing;
- cancellation and cooperative interruption through the existing execution authority;
- worker drain, shutdown and bounded in-flight completion behavior;
- bounded worker concurrency and per-environment quotas;
- idempotent dispatch consumption and correlation to existing execution identity;
- recovery behavior for crashed, terminated or stale workers;
- optional customer-runner registration contract and lifecycle metadata, without independent execution authority;
- operator inspection needed to verify worker health, leases, drain state and boundedness;
- exact-revision static, dynamic, discrimination and crash-safety evidence.

Forbidden:

- changing frozen architecture v1.0;
- changing the execution state vocabulary or creating a second execution state machine;
- moving durable execution authority into workers, containers, queues, Redis or provider runtimes;
- bypassing policy, capability, budget, secret, tenant or verification controls;
- embedding raw secrets or ambient host credentials into untrusted execution environments;
- unrestricted host/network/filesystem access for untrusted code;
- implementing D-06 observability/release-control expansion;
- implementing multi-region/DR/provider-exit work belonging to D-07;
- introducing a new model/tool/agent registry or provider federation authority;
- replacing the existing execution journal or creating a second ledger;
- allowing stale workers to authoritatively mutate execution state;
- unbounded worker retries, leases, concurrency, logs, payloads or retained execution state;
- modifying `spec/development-state/*` during active implementation;
- self-approval or self-merge.

# Architecture Invariants

1. PostgreSQL remains the durable Zeck authority for execution identity and lifecycle.
2. A worker is an executor, never the owner of authoritative execution state.
3. Every dispatch is bound to a stable execution identity and tenant/application/environment scope.
4. Worker acquisition, heartbeat, cancellation and completion are idempotent and stale-worker safe.
5. A crashed or disconnected worker cannot create an authoritative success merely by finishing after lease expiration.
6. Worker execution re-enters existing policy, capability, budget, secret and verification controls; the worker cannot mint bypass credentials or authorization.
7. Untrusted code executes only inside the governed `ComputeEnvironment` isolation boundary and receives no ambient host credentials.
8. Provider-specific model/tool/runtime details stay behind replaceable adapters; domain semantics remain provider-neutral.
9. Long-running execution never depends on an HTTP request remaining open.
10. Queue/transport delivery, worker-local state, container state and provider runtime status are evidence or coordination only until the existing execution authority records the outcome.
11. Cancellation and shutdown are bounded; a drained worker stops accepting new work and safely converges in-flight executions through the durable authority.
12. Per-environment quotas and worker concurrency are deterministic, bounded and observable without becoming a new authority.
13. Optional customer runners remain governed executors with scoped registration metadata; they cannot redefine execution, policy, budget, verification or tenant authority.

# Acceptance Criteria

1. A submitted execution can be consumed by a worker and executed without requiring the originating HTTP request to remain open, while the authoritative lifecycle remains in PostgreSQL.
2. Worker leases and heartbeats are durable, tenant-scoped and idempotent; a stale worker is fenced so its late completion cannot become authoritative.
3. Worker crash, process restart and worker re-selection converge to exactly one authoritative execution outcome without duplicate governed side effects.
4. Cancellation interrupts or terminates eligible work through the governed execution path and converges to a durable cancellation state; cancellation cannot silently widen permissions or bypass verification.
5. Worker drain/shutdown stops new acquisition, bounds in-flight completion, and leaves recoverable executions for fresh workers rather than losing or duplicating work.
6. Concurrency limits and per-environment quotas are enforced before resource admission, are bounded, and cannot be bypassed by another worker instance.
7. Model, tool, agent and program provider/runtime calls receive only scoped mediated secrets and policy-authorized capabilities; untrusted code has no unrestricted host access or ambient credentials.
8. Worker-produced observations, artifacts and failures retain execution/tenant/environment provenance and are committed through existing domain authorities; worker-local or provider-local status cannot declare execution success by itself.
9. The worker boundary is provider-neutral and supports the existing container `ComputeEnvironment` implementation without creating a competing substrate or execution authority.
10. Any optional customer-runner registration is attributable, revocable and non-authoritative, and customer runners use the same execution/lease/provenance controls as first-party workers.

# Implementation Requirements

- Start from the exact registered base revision recorded in `spec/development-state/program-state.json` and the canonical WORK-046 Issue.
- Keep the worker service independently runnable and independently deployable from the request-facing control plane.
- Reuse the established execution adapter and `ComputeEnvironment` contracts wherever possible; do not duplicate domain semantics.
- Bind every worker claim to a durable execution identity plus tenant/application/environment identity and a deterministic lease token/version.
- Fence stale workers at the authoritative persistence boundary. Worker-local clocks may inform expiry decisions only through bounded, persisted timestamps and cannot create success authority.
- Implement heartbeats with bounded cadence/expiration and deterministic stale detection.
- Make completion, failure, cancellation and retry idempotent against the execution authority.
- Preserve existing admission ordering: policy and capability checks before paid/provider dispatch; budget controls before billable work; secret resolution only immediately before authorized adapter use.
- Ensure process/container execution has explicit network, filesystem and credential boundaries consistent with `ComputeEnvironment` v1.0.
- Make worker drain and shutdown safe under concurrent dispatch and lease renewal races.
- Keep payloads and worker-retained state bounded; large artifacts remain in the existing artifact store.
- Document provider limits and resource bounds discovered at the exact revision, without changing D1.0.
- Do not modify `spec/development-state/*`; state transitions are Architect-owned after review/merge.

# Required Checkpoint Contracts

- `AUTH-PRESERVATION`
- `TENANT-ISOLATION`
- `IDENTITY-IDEMPOTENCY`
- `CONCURRENCY-CRASH-SAFETY`
- `EXTERNAL-SIDE-EFFECTS`
- `POLICY-BEFORE-DISPATCH`
- `BUDGET-INTEGRITY`
- `EXECUTION-PROVENANCE`
- `SANDBOX-BOUNDARY`
- `IMPLEMENTATION-COMPLETENESS`
- `SELF-HOSTING-BOUNDARY`

# Checkpoints

### SELF-HOSTING-BOUNDARY

Prove the branch is one WORK-046 implementation branch from the exact authorized base, has no worker-owned governance-state mutation, no self-merge, and only declared D-05 surfaces.

### IDENTITY-IDEMPOTENCY

Prove every worker claim, heartbeat, completion, failure and cancellation is tied to stable execution identity and idempotent authoritative transitions; duplicate delivery and duplicate completion must converge.

### CONCURRENCY-CRASH-SAFETY

Prove the race matrix for two workers, lease expiry, heartbeat loss, cancellation during execution, process crash before/after provider call, restart and re-acquisition. Show stale-worker effects cannot become authoritative.

### EXECUTION-PROVENANCE

Prove model/tool/agent/program work retains tenant/application/environment/execution identity and records worker/runtime attribution through the existing evidence path.

### IMPLEMENTATION-COMPLETENESS

Prove all declared D-05 scope items and Required Verification are implemented/tested, forbidden surfaces are untouched, and the evidence package maps each acceptance criterion to implementation and exact-revision tests.

# Evidence Contract

The worker must publish, at minimum:

- exact base SHA and final head SHA;
- branch name and complete changed-file inventory;
- architecture/static boundary results;
- typecheck/lint/build results;
- worker/unit/integration tests;
- real PostgreSQL tests for lease/concurrency/recovery behavior;
- container isolation/security tests for untrusted execution;
- duplicate dispatch/idempotency tests;
- lease-expiry and stale-worker discrimination tests;
- cancellation and drain/shutdown tests;
- quota/concurrency tests;
- provider-adapter protocol tests without claiming unavailable live provider credentials as PASS;
- full relevant regression suite, with inherited failures compared against the exact base;
- exact CI status and any external infrastructure limitations honestly classified.

# Required Verification

## Static

- typecheck;
- lint;
- architecture/dependency boundary tests;
- no-forbidden-import checks for worker/provider leakage;
- deploy/config validation for the D-05 worker runtime;
- inspect changed paths against this Work Order's declared surfaces.

## Dynamic

- worker acquisition/execution/completion integration tests over real PostgreSQL;
- container `ComputeEnvironment` execution tests;
- cancellation and graceful drain tests;
- worker restart/re-acquisition tests;
- customer-runner registration contract tests when the optional registration surface is implemented;
- provider-adapter HTTP/protocol tests over a real in-process protocol server where applicable.

## Discrimination / mutation

- late stale-worker completion must be rejected by the authoritative boundary;
- duplicate claim/completion/cancellation must converge without duplicate authoritative effects;
- removing or weakening policy/capability/budget admission must fail the boundary tests;
- ambient secret or host-credential injection must be detected and rejected;
- unbounded concurrency/quota weakening must be detected;
- a provider/runtime success signal without authoritative execution transition must not produce completion;
- customer-runner authority inflation must be rejected.

## Concurrency / crash safety

Run a deterministic crash matrix covering at least:

1. crash before lease persistence;
2. crash after lease persistence but before provider dispatch;
3. crash during provider call;
4. provider call succeeds then worker crashes before completion write;
5. completion write races lease expiry;
6. heartbeat loss and stale-worker replacement;
7. cancellation racing provider completion;
8. two workers racing the same execution;
9. worker drain racing new dispatch;
10. restart after partial in-flight execution.

The expected property is durable convergence to one authoritative outcome with no stale-worker authority and no duplicate governed side effect.

## Transformation completeness

Demonstrate that an execution can move from request admission to asynchronous worker execution and back into the existing durable execution/verification path without changing execution identity, duplicating the journal, or requiring a live request.

## Quality attributes

Prove bounded worker concurrency, bounded lease/heartbeat state, bounded retry/re-acquisition, bounded shutdown time, bounded retained worker metadata and explicit provider/runtime resource limits. Prove that provider outage or worker loss degrades to recoverable durable state rather than authority loss.

# Completion

WORK-046 is complete only when the implementation satisfies all acceptance criteria, all Required Checkpoint Contracts have exact-revision evidence, the Architect accepts the PR, the Architect merges it, and post-merge program/dependency/frontier/continuation/handoff state is finalized.
