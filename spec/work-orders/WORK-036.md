# WORK-036 — Home, Work creation and execution experience

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Deliver Zeck's primary end-to-end user journey: describe an outcome, inspect the proposed approach and consequence envelope, execute governed work, follow progress, receive a result and understand its trust/evidence state.

# Context

WORK-035 supplies the shared experience foundation. This order turns the universal interaction grammar into the canonical Work and Execution experience. It must preserve one execution semantics across deterministic, model, agent, batch, training, computer-use, long-running, realtime, edge and economic work.

# Dependencies

Requires: WORK-035

# Requirement IDs

N/A — dashboard projection realization; no frozen requirement ownership changes.

# Declared Change Surfaces

- `apps/dashboard/` Home, Work creation, execution detail, result and activity presentation
- dashboard-local tests/fixtures for these journeys
- `docs/work-items/WORK-036.md`

Do not modify platform modules, public contracts or development-state files.

# Scope Boundaries

Allowed:
- Home / Now surface
- outcome composer and proposed-approach review
- execution creation through existing API/SDK
- execution detail and status header
- Result, Evidence and Activity tab structure where evidence data already exists
- progress timeline and advanced Graph/Events/Raw disclosure
- human/user waiting and approval presentation
- cancellation through existing governed API command
- `How Zeck did it` explanation surface
- recoverable failure and retry/remediation presentation

Forbidden:
- new execution lifecycle logic
- frontend verification or confidence calculation
- customer workflow mutations
- local authoritative execution state machine
- provider/model-first creation as the default
- graph-first status presentation
- raw credentials/secrets
- changes to backend modules or frozen architecture
- merging the worker's own PR

# Architecture Invariants

- Execution remains the primary public primitive.
- The dashboard is projection-only and API/SDK-backed.
- Provider success, execution success, quality success and policy success remain distinct.
- Verification facts come from platform evidence.
- All mutations use governed APIs and existing idempotency.
- Consequence, authorization and cost appear before consequential commitment.

# Acceptance Criteria

1. Home makes outcome entry the dominant action and prioritizes Attention, active work and recent results over analytics.
2. An outcome can be composed with optional attachments, saved competences or templates without requiring provider/model selection.
3. Before execution, the user can understand purpose, estimated cost/time, permission/risk envelope and proposed verification approach.
4. Execution detail opens on Result and exposes Evidence and Activity as peer views.
5. The execution header presents status, duration, cost and trust state using platform facts.
6. Progress uses a chronological timeline by default; Graph/Events/Raw are advanced views.
7. `How Zeck did it` explains task interpretation, capabilities, plan, route, compute and rationale without making infrastructure the default mental model.
8. WAITING_USER/WAITING_HUMAN states provide clear decisions, consequence and return-to-work behavior.
9. Consequential actions expose consequence, affected resource, authorization requirement, estimated cost and reversibility before commitment.
10. Failure states distinguish recoverable provider/infrastructure failure from task/quality failure and offer safe next actions.
11. Result -> Evidence -> Activity navigation preserves the current execution context and remains tenant-safe.
12. End-to-end API-backed tests prove Home -> proposed work -> execution -> Result -> Evidence, including denial/failed/waiting paths.

# Implementation Requirements

1. Use WORK-035 primitives; do not introduce parallel buttons, state indicators or modal patterns.
2. Treat Home as a decision surface, not a metrics dashboard.
3. Keep the user-facing language outcome/capability-oriented; provider/model details appear only in advanced disclosure.
4. Never infer correctness from HTTP success or client-side timing.
5. Keep optimistic presentation strictly non-authoritative and reversible; authoritative state is refreshed from the API.
6. Preserve application scope on all scoped SDK operations established by WORK-034.
7. Add deterministic discrimination tests for trust-state confusion, cross-scope access, unsafe command paths and accidental customer-domain mutation.

# Required Checkpoint Contracts

- `SELF-HOSTING-BOUNDARY`
- `EXECUTION-PROVENANCE`

# Checkpoints

- readiness: exact base and WORK-035 completion verified
- journey: first successful execution is fully API-backed
- authority: no frontend lifecycle/policy/verification authority
- trust: four success dimensions remain discriminated
- consequence: high-impact action preview is explicit
- accessibility: primary Home/execution journeys keyboard and screen-reader usable
- responsive: desktop/tablet/mobile retains result hierarchy
- review: full gate twice consecutively at exact final head

# Evidence Contract

Evidence must identify exact revisions, changed surfaces, Home/execution routes, API/SDK calls, trust-state test inventory, waiting/failure/approval proofs, accessibility and responsive evidence, and exact end-to-end smoke revisions.

# Required Verification

- governance checker
- typecheck
- lint
- dashboard/unit/integration tests
- API-backed Home -> Execution -> Result -> Evidence smoke
- trust-state discrimination
- command authorization-path tests
- responsive browser verification
- keyboard/accessibility verification
- secret-exposure discrimination
- full suite twice consecutively at exact final head

# Completion

Worker opens a PR but does not merge. Completion requires architect acceptance, exact-head verification and post-merge finalization.