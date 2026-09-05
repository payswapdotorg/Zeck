# WORK-043 — Product runtime foundation and first end-to-end execution

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0 (frozen) + Deployment Architecture D1.0

Assurance Profile: CRITICAL

# Objective

Take the existing Zeck product implementation from repository-complete architecture surfaces to a working end-to-end product runtime on the canonical `payswapdotorg/Zeck` remote.

This Work Order is the first product-runtime increment after the UX v2 realization. It must prove the real public API, dashboard, authoritative PostgreSQL state, authentication/application scope, governed execution admission, model/provider adapter path, artifact handling and durable result/evidence flow compose into one usable product journey.

# Context

The canonical remote is `payswapdotorg/Zeck`. It is a fork of the completed W041 state and is now the only authoritative remote for Zeck product development. Deployment Architecture D1.0 remains the approved infrastructure direction, but this order prioritizes a thin end-to-end product slice over broad infrastructure expansion.

The objective is not to add speculative product domains. It is to make the already-designed product real.

# Dependencies

Requires: WORK-041

# Requirement IDs

N/A — vertical integration / product-runtime gate over already-owned capabilities.

# Declared Change Surfaces

- `apps/dashboard/` only where required to connect the existing UX to real API behavior
- `src/api/` and relevant module PUBLIC/application seams required for one end-to-end execution path
- `src/platform/` configuration/runtime wiring required for the canonical deployment environment
- provider adapter implementation required for the selected execution path
- database/migration files only where a directly-required missing runtime invariant is proven
- `tests/` for end-to-end, integration, architecture and discrimination coverage
- deployment configuration directly required to run the slice
- `docs/work-items/WORK-043.md`
- directly-required runtime/product documentation

# Scope Boundaries

Allowed:
- wiring existing public contracts into a real deployed execution journey
- runtime configuration and environment bootstrap
- one production-representative model/provider path behind existing provider-neutral contracts
- authenticated tenant/application resolution
- governed execution submission, dispatch, observation and completion
- result/evidence persistence using existing authorities
- dashboard replacement of fake/fixture data only where the corresponding real public authority already exists
- deployment smoke tests for the end-to-end slice

Forbidden:
- changing frozen architecture v1.0
- replacing an existing authority with provider state
- creating a second execution state machine
- bypassing policy, budget, capability, secret or verification gates
- exposing raw credentials
- creating a parallel API/SDK authority
- broad redesign of UX v2
- speculative new product domains
- modifying `spec/development-state/*` during active implementation
- self-merging

# Architecture Invariants

- `Execution` remains the primary public AI-work abstraction.
- PostgreSQL remains durable application authority.
- Provider SDKs remain behind adapters.
- Policy admission precedes provider/tool/secret dispatch.
- Capability selection precedes provider selection.
- Budget reservation/settlement remains transactional and idempotent.
- Verification remains distinct from provider success.
- Artifacts are persisted through the object-store port; metadata remains authoritative in Zeck state.
- Secrets remain secret-mediated.
- Dashboard state remains a projection over public authorities.
- Long-running behavior is not coupled to an HTTP request lifecycle.

# Acceptance Criteria

1. A real authenticated user can enter the deployed dashboard, resolve an application/tenant and submit one governed execution through the public product path.
2. The submitted execution receives one durable Execution identity and follows the existing authoritative lifecycle without a second state machine.
3. Effective policy, capability resolution and required budget/secret gates execute in the required order before the external provider call.
4. One real provider/model adapter successfully receives the authorized operation and returns a normalized result through the existing provider-neutral contract.
5. The execution result, usage/cost summary and evidence/provenance references are durably persisted through existing authorities.
6. The dashboard can observe the live execution and render its authoritative status/result without fixture-only truth.
7. Retries of the same mutating request converge through existing idempotency semantics and do not duplicate authoritative effects.
8. Provider failure, policy denial and insufficient-budget paths fail closed and are visible through the product without secret leakage.
9. The deployment can be reproduced from repository-defined configuration plus externally-held secrets/provider account state, with no undocumented product-critical console mutation.
10. The exact implementation revision has end-to-end smoke evidence and the complete verification gate passes twice consecutively.

# Implementation Requirements

1. Prefer the smallest vertical slice that proves the complete product path.
2. Reuse existing public contracts; do not introduce internal cross-module imports to make the slice work.
3. Select a provider/model path that is available through the canonical connected provider configuration; record the exact provider adapter and capability exercised.
4. Keep provider credentials external and secret-mediated; logs and evidence must contain references/metadata, never plaintext.
5. Replace fixtures only where the corresponding real API/public authority exists and can be verified.
6. Make all runtime configuration explicit through repository-resident manifests/examples and environment contracts.
7. Add discrimination tests for policy-before-dispatch, idempotency, tenant scope, provider-neutrality and secret non-disclosure on the real path.
8. Do not expand the roadmap because an implementation detail is inconvenient; raise an architecture finding instead.

# Required Checkpoint Contracts

- `SELF-HOSTING-BOUNDARY`
- `EXECUTION-PROVENANCE`
- `IDENTITY-IDEMPOTENCY`
- `IMPLEMENTATION-COMPLETENESS`
- `CONCURRENCY-CRASH-SAFETY`

# Checkpoints

- readiness: exact base, canonical remote, provider/account availability, runtime env contract and selected vertical slice verified before implementation
- authority: all durable state writes use existing Zeck authorities
- admission: policy/capability/budget/secret gates precede external side effects
- execution: one real provider path completes end-to-end
- product: authenticated dashboard observes authoritative execution state/result
- recovery: retry/failure/denial paths converge and fail closed
- deployment: exact Git revision maps to a reproducible deployed slice
- release: full suite twice consecutively plus exact deployed end-to-end smoke verification

# Evidence Contract

Evidence must identify the exact base/final revisions, canonical remote and issue identity, selected product journey, provider/model adapter, environment/resource identifiers where non-secret, exact API/dashboard routes exercised, authority/admission sequence, real execution result, persistence/evidence references, failure/denial/retry probes, secret-exposure scans, deployment identity and final changed-file inventory.

# Required Verification

- `python3 scripts/governance-check.py`
- typecheck
- lint
- relevant unit/architecture/discrimination suites
- real PostgreSQL integration tests where durable state is exercised
- real deployed end-to-end smoke path
- policy denial and budget denial negative paths
- provider failure negative path
- idempotent retry/concurrency proof
- tenant isolation proof
- secret-exposure discrimination
- exact-revision deployment verification
- full suite twice consecutively at exact final head

# Completion

Worker opens exactly one PR and does not merge. Completion requires Architect acceptance, exact-head verification, merge, and post-merge state finalization against the actual merge commit.

# Dispatch Record

- Work Order: WORK-043
- Status before dispatch: PENDING
- Required worker branch: `work/WORK-043-product-runtime-foundation`
- Canonical remote: `payswapdotorg/Zeck`
- Binding base: to be recorded by the Architect at dispatch.
