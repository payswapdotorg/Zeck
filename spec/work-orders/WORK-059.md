# WORK-059 — Advanced Audit and Compliance Controls (D-08)

Status: AUTHORIZED / PENDING (wave A — parallel with WORK-057, WORK-058; disjoint surfaces)

Owner: Implementation worker; Architect retains review, merge and state-finalization authority

Architecture Version: v1.0 (frozen); D1.0 + ADR-0021/ACR-005 (D-08 extension); binding requirement `SEC-004`

Assurance Profile: HIGH_ASSURANCE

# Objective

Implement the D-08 audit/compliance plane on the audit module: an immutable, complete audit projection of governed actions (who/what/when/why with provenance), compliance evidence export, retention policy, and legal hold. Audit records are append-only evidence; they never become a second ledger or an authorization source.

# Dependencies

Requires: WORK-047

Dispatch context: wave A of D-08. Sibling workers in flight: WORK-057 (platform/db + deploy — import/consume only, never modify), WORK-058 (sandbox/compute — import/consume only).

# Requirement IDs

`SEC-004` (advanced audit and compliance controls) — binding text in docs/DEPLOYMENT-ROADMAP-D08-REQUIREMENTS.md.

# Declared Change Surfaces

Allowed modules/surfaces: `src/modules/audit/**` (projection types, append-only store adapter, export/retention/legal-hold services); audit migrations (next available number); audit integration tests over real PostgreSQL; discrimination + mutation tests; `docs/work-items/WORK-059.md`; operator documentation.

Forbidden to modify: every other module (import/consume only — governed actions are OBSERVED through existing seams, never re-implemented), `src/platform/db/**`, `src/platform/compute/**`, `deploy/**`, `benchmarks/**`, frozen v1.0 public contracts, `spec/development-state/*` during active implementation, the d08-usage measurement surfaces.

# Scope Boundaries

Allowed:

- Append-only audit projection: typed records (actor identity, action kind, target identity, provenance chain, timestamp, environment) written through an audit port; the store rejects mutation and deletion (database-level enforcement).
- Compliance evidence export: governed, bounded export of audit records with integrity digests (hash-chained per record; the export carries a verifiable chain proof).
- Retention policy: policy-driven bounded retention with honest expiry semantics (expired records are purged by a governed procedure, recorded as governance evidence).
- Legal hold: a hold placed on a scope suspends retention expiry for that scope; holds are themselves audited.
- Observation through EXISTING seams: the audit projection records governed actions at existing authority seams (decision records, execution lifecycle transitions, policy decisions) — it never becomes a second source of truth.

Forbidden:

- audit records consulted for authorization (the projection is evidence, never authority);
- mutation/deletion of audit records outside the governed retention/hold procedures;
- a second ledger of governed state (authoritative state stays in the existing module stores);
- unbounded retention;
- secrets/credential-shaped values in audit records (scrubbed at the seam).

# Architecture Invariants

1. Append-only by construction (DB-level: no UPDATE/DELETE path exists; attempts fail closed).
2. Audit is evidence, never authority — no code path consults it for authorization.
3. Hash-chained integrity; tampering is detectable and rejected on verification.
4. Retention and legal hold are governed procedures, themselves audited.
5. Completeness is honest: every governed action kind declared in scope is recorded; anything NOT recorded is listed as an explicit boundary.
6. Provenance: every record carries actor/action/target/when/why with exact revision context.

# Acceptance Criteria

1. Typed append-only audit projection with DB-enforced immutability (mutation attempts rejected, proven by test).
2. Hash-chained integrity verification (tamper detection proven by mutation test).
3. Compliance export with verifiable chain proof (round-trip verification test).
4. Retention policy with governed expiry (expired purge recorded as governance evidence; bounded retention proven).
5. Legal hold suspends expiry for its scope; holds are audited.
6. Discrimination tests: authorization-consulting audit access is non-existent; second-ledger patterns rejected; secret-shaped values scrubbed.
7. Integration over real PostgreSQL at the final head; evidence document `docs/work-items/WORK-059.md`.

# Implementation Requirements

- Build ON the existing audit module and D-06 observability surfaces — extend, never replace.
- Model records, chains, holds and retention as typed data; procedures are governed decisions; fail closed on unmet preconditions.
- The projection subscribes to existing seams (decision records, execution transitions, policy decisions); no re-implementation of governed actions.
- Scrub credential-shaped values at the audit seam; never store secrets.
- Record exact-revision evidence; never claim unexecuted results as PASS.
- Do not modify `spec/development-state/*`; state transitions are Architect-owned after review/merge.
- Migration numbering: take the next available number at your base; a collision with a merged sibling is reconciled by the Architect at merge time.

# Required Checkpoint Contracts

- `IDENTITY-IDEMPOTENCY`
- `CONCURRENCY-CRASH-SAFETY`
- `EXECUTION-PROVENANCE`
- `MIGRATION-SAFETY`
- `DEPENDENCY-DIRECTION`
- `SELF-HOSTING-BOUNDARY`
- `IMPLEMENTATION-COMPLETENESS`

# Checkpoints

### IDENTITY-IDEMPOTENCY

Prove append idempotence: the same governed action recorded twice is a bounded no-op (deduplicated by identity); export verification is deterministic.

### CONCURRENCY-CRASH-SAFETY

Prove concurrent append, chain extension and export under crash-resume: no broken chains, no lost records, no double-purge.

### EXECUTION-PROVENANCE

Prove every record carries actor/action/target/when/why provenance with exact revision context, replayable by deterministic audit.

### MIGRATION-SAFETY

Prove the audit migrations converge cleanly on a fresh database and an existing D-02-converged authority; no destructive migration.

### DEPENDENCY-DIRECTION

Prove the audit projection observes existing seams import-only; no authority consults the audit projection.

### SELF-HOSTING-BOUNDARY

Prove no external compliance SaaS is absorbed; external export targets are NOT RUN and disclosed exactly.

### IMPLEMENTATION-COMPLETENESS

Prove all scope, acceptance criteria and Required Verification are implemented/tested, forbidden surfaces are untouched, and the evidence package maps each criterion to exact-revision results.

# Evidence Contract

The worker must publish at minimum: exact registered base SHA and final head SHA; complete changed-file inventory and ancestry proof; immutability/tamper/export/retention/hold test transcripts; honest NOT RUN boundaries.

# Required Verification

## Static

governance-check, typecheck, lint at the final head.

## Dynamic

Full unit + architecture + integration battery (real PostgreSQL) at the final head.

## Discrimination / mutation

Mutation attempts, tampered chains, authorization-consulting access, secret leakage must all be rejected by test.

# Completion

WORK-059 is complete only when all acceptance criteria and required checkpoints have exact-revision evidence, the Architect accepts the PR, the Architect merges it, and post-merge program/dependency/frontier/continuation state is finalized.

Required branch: `work/WORK-059-audit-compliance-controls`

One Work Order = one implementation branch = one PR. The worker cannot approve or merge its own PR.
