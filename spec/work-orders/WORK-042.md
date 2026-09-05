# WORK-042 — Reproducible deployment infrastructure foundation

Status: IN-FLIGHT

Owner: Architect-assigned implementation worker

Architecture Version: D1.0 (deployment/runtime architecture), subordinate to frozen v1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Implement the first executable deployment phase from `docs/DEPLOYMENT-ROADMAP.md`: a reproducible, environment-separated infrastructure foundation for Zeck that uses provider adapters/configuration without making infrastructure providers domain authorities.

# Context

Deployment & Runtime Architecture D1.0 is approved and authoritative. This Work Order does not change frozen core architecture v1.0. It establishes the concrete infrastructure contracts required to deploy Zeck reproducibly using the reference provider stack while preserving provider substitution.

# Dependencies

Requires: WORK-041

# Requirement IDs

N/A — deployment architecture foundation; acceptance is governed by the deployment architecture and checkpoint contracts below.

# Declared Change Surfaces

- deployment/infrastructure configuration required by D1.0
- `src/platform/` configuration/bootstrap seams only where directly required to consume deployment configuration
- `.github/workflows/` deployment automation where directly required
- deployment tests, smoke tests, and verification fixtures
- `docs/work-items/WORK-042.md`
- directly-required environment/configuration documentation

# Scope Boundaries

Allowed:
- environment configuration manifests and naming conventions
- Vercel project/deployment configuration
- Neon project/branch configuration
- Cloudflare R2 bucket configuration
- Cloudflare Queues and Workflows configuration
- Upstash Redis configuration
- deployment health/readiness probes
- CI deployment gates and promotion metadata
- provider-neutral configuration ports/adapters
- deterministic bootstrap and teardown tooling
- smoke/integration verification for provisioned resources

Forbidden:
- changing frozen architecture v1.0 rules
- changing domain authority or execution semantics
- provider-specific types in domain modules
- storing secrets or provider credentials in Git
- committing `.env` or credential material
- making Redis, queues, workflows, Vercel, R2, Neon branches, or provider dashboards authoritative domain state
- bypassing `/auth`, `/policies`, `/budgets`, `/executions`, `/artifacts`, `/sandbox`, or other existing authorities
- production data migrations unrelated to deployment bootstrap
- inventing a second deployment control plane
- modifying `spec/development-state/*` during active work
- merging the worker's own PR

# Architecture Invariants

- Zeck owns durable application authority; infrastructure providers implement operational ports.
- PostgreSQL is authoritative for durable Zeck state.
- Object storage contains artifact bytes; artifact metadata/provenance remains in Zeck's authority plane.
- Queues and Workflows are transport/orchestration only.
- Redis is ephemeral coordination/cache only.
- Provider SDKs remain isolated behind owning adapters.
- Secrets are references and secret-manager materialization only; plaintext must not enter logs, artifacts or domain state.
- Every environment is explicitly named and isolated.
- Preview resources are disposable and never implicitly promoted to production.
- Deployment identity is explicit and traceable to a Git revision/environment/provider resource set.

# Acceptance Criteria

1. A fresh checkout can reproduce the required development/preview/staging/production resource configuration from repository-resident manifests/instructions without undocumented console steps.
2. Required provider resources have deterministic names/labels and environment ownership: Vercel, Neon, R2, Queues, Workflows and Redis.
3. Environment configuration is separated for local, preview, staging and production; production credentials are never reusable in non-production environments.
4. All provider credentials are represented only through secret references and external secret materialization; no secret plaintext is committed or returned by application APIs/logging.
5. Deployment configuration consumes provider-neutral Zeck ports/contracts rather than moving provider-specific dependencies into domain code.
6. Deployment health/readiness checks distinguish control-plane availability from dependency readiness and expose no secret-bearing diagnostics.
7. CI can validate configuration, run deterministic smoke checks and produce an auditable deployment identity for the exact Git revision.
8. The implementation supports teardown/recreation of disposable preview resources without corrupting authoritative application state.
9. Provider failure/degraded-mode behavior is explicit for each non-authoritative infrastructure dependency; PostgreSQL authority failure fails closed rather than silently switching authority.
10. Evidence demonstrates the exact repository revision, infrastructure configuration, environment matrix, secret-reference checks, smoke tests, and changed-file inventory.

# Implementation Requirements

1. Use repository-resident configuration as the canonical declaration; console-created values that are required for correctness must be captured as code/config or explicitly classified as provider-account metadata that cannot be reproduced.
2. Prefer environment variables and secret references over hard-coded provider identifiers.
3. Make provider resource identifiers discoverable through non-secret configuration and auditable deployment metadata.
4. Add provider adapter contracts only where required; do not introduce a deployment-specific domain model that duplicates `/deployments` authority.
5. Ensure all lifecycle operations used by provisioning tooling are idempotent or create-or-converge where provider semantics permit.
6. Keep preview data synthetic/disposable and establish a mechanism that prevents accidental production resource targeting.
7. Record provider plan/term assumptions in the deployment architecture or evidence only when verified; never encode mutable pricing as application logic.

# Required Checkpoint Contracts

- `SELF-HOSTING-BOUNDARY`
- `IDENTITY-IDEMPOTENCY`
- `CONCURRENCY-CRASH-SAFETY`
- `IMPLEMENTATION-COMPLETENESS`

# Checkpoints

- readiness: exact base, provider account/resource access, environment contract and secret-reference inventory verified before infrastructure mutation
- infrastructure: required resources are reproducible and correctly isolated
- authority: no infrastructure service becomes Zeck domain authority
- security: secrets remain external, least-privileged and environment-scoped
- recovery: disposable preview resources can be recreated; control-plane dependency failure fails closed
- deployment: exact Git revision maps to auditable deployment identity
- release: full gate twice consecutively at exact final head, including deployment smoke verification

# Evidence Contract

Evidence must identify the exact base/final revisions, provider/resource inventory, environment matrix, configuration manifests, resource identifiers where non-secret, secret-reference validation, smoke tests, failure/degraded-mode tests, reproduction/teardown procedure, CI/deployment identity and final changed-file inventory. Evidence must explicitly distinguish repository-truth configuration from external provider account state.

# Required Verification

- `python3 scripts/governance-check.py`
- typecheck
- lint
- relevant unit/architecture/discrimination suites
- deployment configuration validation
- provider adapter contract tests
- environment isolation tests
- secret-exposure discrimination
- idempotent bootstrap/teardown smoke tests
- dependency failure/degraded-mode tests
- exact-revision deployment smoke verification
- full suite twice consecutively at exact final head

# Completion

Worker opens exactly one PR and does not merge. Completion requires Architect acceptance, exact-head verification, merge, and post-merge state finalization against the actual merge commit.

# Dispatch Record

- Work Order: WORK-042
- Status: AUTHORIZED / IN-FLIGHT
- Required worker branch: `work/WORK-042-deployment-infrastructure-foundation`
- Binding exact base: `375aee55c22f7f80c82199cb3baf987f03077d24`
- Worker must not modify `spec/development-state/*` during active work.
- Worker must not merge its own PR.
