# WORK-037 — Build, agents, deployments and workloads experience

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Turn reusable system creation and operational management into a coherent outcome-first experience for Agents, Deployments, Workloads, Training and Batch processing while preserving Execution as the underlying public primitive.

# Context

Users should build by describing purpose and reviewing a proposed design, not by configuring infrastructure first. Operationally, an Agent is reusable behavior and a Deployment is persistent availability; a Workload/Training job is governed work. These distinctions already exist in the technical architecture and must become obvious in the product without exposing backend module topology as the primary mental model.

# Dependencies

Requires: WORK-036

# Requirement IDs

N/A — dashboard presentation of existing domain/API objects.

# Declared Change Surfaces

- `apps/dashboard/` Build routes and Agent/Deployment/Workload operational views
- dashboard-local tests and fixtures for those surfaces
- `docs/work-items/WORK-037.md`

# Scope Boundaries

Allowed:
- Build hub and outcome-first creation entry points
- agent proposal/review/build experience
- agent inventory/detail/version/quality/cost views
- deployment inventory/detail/health/version/availability views
- workload, training and batch creation/status/detail views
- checkpoint, resume, retry and release-status presentation
- distinction between persistent Deployment and individual Execution
- advanced configuration disclosures and plan inspection

Forbidden:
- new agent/deployment/workload lifecycle authority
- direct provider/runtime configuration as mandatory default
- frontend-owned rollback/version state machines
- direct customer-domain mutation
- secret rendering
- changes to backend modules or frozen architecture
- merging the worker's own PR

# Architecture Invariants

- Agent, Deployment and Workload surfaces project existing API/domain authorities.
- Every actual unit of governed work remains an Execution.
- Deployment availability must never be represented as an execution status.
- Training completion never implies evaluation or release approval.
- Advanced graph/configuration is optional and progressively disclosed.

# Acceptance Criteria

1. Build presents purpose/outcome before technical configuration for executions, agents, workloads and deployments.
2. Agent creation displays a human-readable proposal covering purpose, capabilities, integrations, guardrails, verification and expected cost before detailed configuration.
3. Agent detail makes purpose, capabilities, tools/integrations, autonomy, approvals, quality, cost, version and current deployment understandable at a glance.
4. Deployment detail clearly communicates availability, version, health, channels/endpoints, activity and operational controls without exposing topology by default.
5. Deployment actions such as pause, rollback and version change route through governed APIs and communicate consequence before commitment.
6. Workload/training/batch flows use outcome-first creation and show budget/cost throughout lifecycle.
7. Training state explicitly distinguishes compute complete, training complete, evaluation passed and release approved.
8. Long-running workload views show progress, checkpoint recency, spend and recovery state without exposing lease/heartbeat mechanics by default.
9. Agent/deployment/workload pages link naturally to their executions and evidence.
10. Responsive and accessibility behavior preserves the same hierarchy and does not compress expert controls into unsafe mobile interactions.

# Implementation Requirements

1. Reuse WORK-035 primitives and WORK-036 Work/Execution patterns.
2. Provide one Build entry surface with clear intent choices rather than separate product silos.
3. Treat proposed plans as readable summaries; advanced graph editing is a disclosure, not a prerequisite.
4. Render operational statistics only when backed by API facts; no client-side invented health or quality metrics.
5. Keep deployment and execution identifiers visibly distinct.
6. Include API-backed tests for authorization, tenancy, version/consequence handling and execution cross-links.

# Required Checkpoint Contracts

- `SELF-HOSTING-BOUNDARY`
- `EXECUTION-PROVENANCE`

# Checkpoints

- readiness: exact base and WORK-036 completion verified
- build: end-to-end agent creation and review journey is API-backed
- deployment: deployment/execution distinction is tested
- workload: training/evaluation/release distinctions are tested
- authority: all mutations use governed API paths
- responsive/accessibility: primary build and operations journeys pass
- review: full gate twice consecutively at exact final head

# Evidence Contract

Evidence must identify exact revisions, routes/surfaces, API projections, proposal/review flow, deployment/execution discrimination, training-state discrimination, mutation authorization, accessibility and responsive evidence, and exact smoke revisions.

# Required Verification

- governance checker
- typecheck
- lint
- dashboard/unit/integration tests
- build agent journey
- deployment state discrimination tests
- training/workload state tests
- authority/tenant isolation tests
- responsive browser verification
- keyboard/accessibility verification
- secret-exposure discrimination
- full suite twice consecutively at exact final head

# Completion

Worker opens a PR but does not merge. Completion requires architect acceptance, exact-head verification and post-merge finalization.