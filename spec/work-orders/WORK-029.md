# WORK-029 — Edge, real-time and embodied execution integration

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: CRITICAL

# Objective

Provide governed integration for edge, hard-latency and physical/embodied computational substrates without placing unsafe real-time control loops inside Zeck's cloud control plane.

# Context

Robotics, industrial control, vehicles, medical devices and other physical systems may require local inference, deterministic controllers, sensor fusion and hard real-time guarantees. Zeck should govern and orchestrate these systems while respecting their safety boundaries.

# Dependencies

Requires: WORK-012, WORK-016, WORK-019, WORK-031

# Requirement IDs

- `EDGE-001`
- `EDGE-002`
- `EDGE-003`

# Declared Change Surfaces

- `src/modules/sandbox/`
- `src/modules/integrations/`
- `src/modules/deployments/` (directly-required edge/embodied deployment seams only)

# Scope Boundaries

Allowed:
- provider-neutral edge/real-time workload contracts
- device/substrate registration and health metadata
- governed command submission to external controllers
- sensor/output provenance
- safe delegation of hard-real-time control to local substrate

Forbidden:
- pretending a cloud request/response path is a hard-real-time safety loop
- direct unrestricted actuator control
- bypass of policy, tenant, capability, budget or human-approval boundaries
- making a device vendor a core dependency
- merging the worker's own PR

# Architecture Invariants

- Zeck is the governance/orchestration plane, not the safety-critical control loop.
- Physical side effects require explicit authorization and provenance.
- Edge execution may continue when disconnected from Zeck only within an explicitly pre-authorized safety envelope.
- Local controllers remain responsible for hard real-time guarantees.
- Reconciliation after reconnect is deterministic and conflict-safe.

# Acceptance Criteria

1. Define provider-neutral contracts for edge and embodied execution targets.
2. Support local execution envelopes for latency-sensitive workloads without making Zeck's cloud round trip part of the control loop.
3. Record sensor, command and actuation provenance against Zeck Execution identity.
4. Require explicit policy/capability/human approval for governed physical side effects.
5. Prove stale or unauthorized commands cannot reach the actuator path.
6. Support disconnect/reconnect reconciliation without duplicate or out-of-order authoritative commands.

# Implementation Requirements

- Safety envelopes must be immutable once an execution is admitted unless a new authorized execution/reconfiguration supersedes them.
- Edge adapters expose capabilities and evidence, not authority.
- Device identities are tenant-scoped and revocable.
- Hard real-time scheduling remains outside the cloud control plane.

# Required Checkpoint Contracts

- `SELF-HOSTING-BOUNDARY`
- `CONCURRENCY-CRASH-SAFETY`
- `EXECUTION-PROVENANCE`

# Required Verification

- governance checker
- typecheck
- lint
- edge adapter contract tests
- actuator authorization discrimination
- stale-command and replay tests
- reconnect/concurrency tests
- physical-side-effect provenance tests
- safety-envelope boundary tests

# Completion

Worker opens a PR but does not merge. Completion requires architect acceptance and post-merge finalization.
