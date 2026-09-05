# WORK-043 — Database and artifact production path

Status: AUTHORIZED / IN-FLIGHT

Owner: Architect-assigned implementation worker

Architecture Version: D1.0 (deployment/runtime architecture), subordinate to frozen v1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Implement D-02 of the approved Deployment & Runtime Architecture roadmap: connect Zeck's authoritative PostgreSQL state and artifact bytes to managed production-grade infrastructure without moving domain authority into a provider.

This order follows WORK-042 / D-01 and must remain strictly within the D-02 scope defined by `docs/DEPLOYMENT-ROADMAP.md`.

# Dependencies

Requires: WORK-042

# Requirement IDs

N/A — deployment/runtime production-path phase; acceptance is governed by the deployment architecture and checkpoint contracts below.

# Declared Change Surfaces

- `src/platform/db/**` production database adapter/configuration and directly-required migration/startup seams
- `src/platform/object-store/**` production object-store adapter/configuration and directly-required integrity/retention seams
- `src/platform/secret-store/adapters/**` directly-required environment secret materialization
- `deploy/` production-path migration/backup/restore/smoke tooling directly required by D-02
- `deploy/manifests/variables.json` and directly-required deployment configuration
- package/toolchain registration directly required by D-02
- tests and evidence required by the acceptance criteria
- `docs/work-items/WORK-043.md`
- directly-required runtime documentation

# Scope Boundaries

Allowed:
- Neon PostgreSQL adapter/configuration and repository-owned connection contract
- migration/startup validation against managed PostgreSQL
- transaction and connection-pool validation
- Cloudflare R2 `ObjectStore` adapter/configuration behind the existing port
- signed upload/download flows where required by existing artifact contracts
- artifact hash/content-integrity verification
- retention and cleanup job contract/tooling
- backup/restore procedures and an executed restore proof
- provider/resource configuration and secret references directly required for the above
- integration, discrimination and recovery tests
- exact-revision deployment and restore evidence
- `docs/work-items/WORK-043.md`

Forbidden:
- changing frozen architecture v1.0
- replacing PostgreSQL authority with Neon-specific state semantics
- storing authoritative artifact metadata only in R2
- moving large artifact bytes through PostgreSQL as an unnecessary fallback
- implementing D-03 queues/dispatch transport
- implementing D-04 durable workflows/orchestration
- implementing D-05 worker deployment fabric
- implementing D-06 production CI/CD or observability expansion beyond directly-required evidence
- introducing a second deployment or execution authority
- plaintext secrets in Git, logs, tests, artifacts or API responses
- modifying unrelated product/domain semantics
- modifying `spec/development-state/*` during active implementation
- worker self-merge

# Architecture Invariants

- PostgreSQL remains the sole durable Zeck authority.
- Neon is an infrastructure implementation of the existing database port.
- Artifact metadata, provenance, hashes and lifecycle authority remain in Zeck state.
- R2 contains artifact bytes and is non-authoritative.
- Provider-specific SDK/types remain isolated behind the owning platform adapter.
- Artifact integrity is verified against the authoritative content hash.
- Database migrations are deterministic, repeatable and startup-safe.
- Connection-pool behavior is bounded and validated under realistic concurrency.
- Backup/restore is tested against an actual recoverable database artifact or managed-provider restore mechanism available through the authorized environment.
- Secret references remain environment-scoped and values remain externally materialized.

# Acceptance Criteria

1. Zeck can start against a managed PostgreSQL instance using repository-defined configuration and the existing database port.
2. All required migrations apply deterministically; startup fails closed on incompatible or unavailable authoritative state.
3. Transaction boundaries and connection-pool behavior are validated against the managed PostgreSQL path.
4. The existing `ObjectStore` contract has a production R2 adapter/configuration without exposing R2 concepts in domain modules.
5. Artifact upload/download uses the appropriate signed or delegated flow where required and does not proxy large artifact bytes through PostgreSQL.
6. Stored artifact content is hash-verified and integrity mismatches fail closed without corrupting authoritative metadata.
7. Retention/cleanup behavior is explicit, bounded and unable to delete authoritative metadata accidentally.
8. A real backup/restore procedure is executed and demonstrates recovery of authoritative database state; documentation alone is insufficient.
9. Failure/retry/recovery tests prove provider outages do not create a second authority or silently report success.
10. Evidence identifies the exact repository revision, managed resources where non-secret, secret-reference validation, migration/pool results, artifact integrity results, restore proof, and final changed-file inventory.

# Implementation Requirements

1. Use repository-resident configuration as the canonical declaration; console-created values that are required for correctness must be captured as code/config or explicitly classified as provider-account metadata that cannot be reproduced.
2. Prefer environment variables and secret references over hard-coded provider identifiers.
3. Keep provider-specific behavior behind the owning platform adapters and preserve the existing public contracts.
4. Ensure lifecycle operations used by the production-path tooling are idempotent or converge safely where provider semantics permit.
5. Preserve environment separation and prevent non-production credentials from addressing production resources.
6. Record verified provider assumptions in evidence only when actually tested; never convert an unverified provider claim into PASS evidence.

# Required Verification

- `python3 scripts/governance-check.py`
- typecheck
- lint
- relevant unit/architecture/discrimination suites
- managed Neon PostgreSQL integration tests where credentials/access exist
- migration/startup compatibility tests
- connection-pool/transaction validation
- real R2 adapter integration tests where credentials/access exist
- signed artifact flow tests
- artifact hash/integrity discrimination tests
- retention/cleanup safety tests
- executed backup/restore drill
- provider outage/failure negative paths
- secret-exposure scans
- exact-revision deployment identity verification
- full suite twice consecutively at exact final head

# Checkpoint Contracts

- `SELF-HOSTING-BOUNDARY`
- `IDENTITY-IDEMPOTENCY`
- `CONCURRENCY-CRASH-SAFETY`
- `EXECUTION-PROVENANCE`
- `IMPLEMENTATION-COMPLETENESS`

# Evidence Contract

Evidence must distinguish repository-defined configuration from external provider account state. Provider credentials may be used only through the connected secret-mediated environment. Any unavailable provider evidence must be recorded as NOT RUN with the exact reason; it must never be converted into a PASS claim.

The restore proof must identify the exact source backup/snapshot class, target environment, recovered revision/state checks, validation query or equivalent evidence, cleanup of disposable recovery resources, and whether authoritative state was preserved.

# Completion

The worker opens exactly one PR against `main` and does not merge it. Architect review, merge, exact-head verification and post-merge state finalization are mandatory.

# Dispatch record

- Work Order: WORK-043
- Status: AUTHORIZED / IN-FLIGHT
- Canonical remote: `payswapdotorg/Zeck`
- Canonical issue: #3
- Required worker branch: `work/WORK-043-database-artifact-production-path`
- Binding exact base: `c13aaa0924e12152487d38a36c3ef3c4f31fa58`
- Worker must not modify `spec/development-state/*` during active implementation.
- Worker must not merge its own PR.
