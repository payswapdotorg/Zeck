# WORK-047 — Production delivery, observability and release control

Status: AUTHORIZED / IN-FLIGHT

Owner: Implementation worker; Architect retains review, merge and state-finalization authority

Architecture Version: v1.0 (frozen); Deployment & Runtime Architecture D1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Implement D-06 so Zeck deployments can be promoted, inspected, rolled back and audited safely without moving domain authority into CI/CD, observability, dashboards or hosting providers.

# Dependencies

Requires: WORK-046

Enables: D-07 resilience, disaster recovery and provider exit

# Requirement IDs

No existing product requirement IDs are introduced by D-06; this Work Order defines deployment/runtime governance contracts subordinate to D1.0 and the frozen v1.0 architecture.

# Declared Change Surfaces

Allowed modules/surfaces: deployment workflows and manifests, operator/release tooling, bounded observability instrumentation and adapters, health/smoke gates, migration/release gates, rollback controls, cost/quota alerting, D-06 tests/evidence, this Work Order, and only the minimum existing module seam consumption required to attach stable correlation identity.

Forbidden to modify frozen architecture v1.0, authoritative execution/policy/capability/budget/secret/tenant/verification semantics, or `spec/development-state/*` during active implementation.

# Scope Boundaries

Allowed:

- GitHub-to-provider CI/CD for repository-defined deployment surfaces.
- Explicit local → CI → preview → staging → production promotion controls.
- Exact commit/deployment identity and immutable release attribution.
- Migration ordering and production migration gates.
- Health and smoke gates before promotion.
- OpenTelemetry-compatible traces, metrics and bounded structured logs.
- Error monitoring and actionable alert thresholds.
- Deployment rollback controls that do not mutate durable Zeck domain state.
- Cost/quota/exhaustion alerts and operational guardrails.
- Operator inspection of release identity, gate results and rollback state.
- D-06 evidence, regression coverage, and repository-resident CI/self-hosting documentation.

Forbidden:

- changing frozen architecture v1.0;
- moving durable domain authority into CI/CD, observability, dashboards, queues or hosting/provider control planes;
- allowing provider state, telemetry state or deployment state to declare execution/business success;
- introducing uncontrolled paid overage or unbounded log, metric, trace, alert, retry or retention volume;
- implementing D-07 disaster recovery/provider-exit scope;
- replacing execution, policy, capability, budget, secret, tenant or verification authority;
- modifying `spec/development-state/*` during active implementation;
- self-approval or self-merge.

# Architecture Invariants

1. Every deployment remains attributable to an exact Git commit and environment.
2. CI/CD and provider control planes are operational mechanisms, never Zeck domain authorities.
3. Failed deployment rollback must not rewrite durable execution or business state.
4. Telemetry preserves stable execution/release correlation without transporting secrets.
5. Preview, staging and production state/credentials remain isolated.
6. Logs, metrics and traces are bounded and redact secret material.
7. Migration gates are ordered and fail closed; application/domain compatibility is verified before promotion.
8. Health and smoke gates are evidence gates, not success authority.
9. Cost and provider quotas are observable before exhaustion and do not permit uncontrolled paid overage by default.
10. D-06 does not implement D-07 disaster recovery/provider-exit scope.

# Acceptance Criteria

1. Every production deployment maps to one exact Git commit and environment.
2. Promotion is gated by required validation, migration, health and smoke evidence appropriate to the target environment.
3. Failed releases can be rolled back without changing durable Zeck domain state.
4. Operational telemetry can reconstruct an execution/deployment chain end-to-end using stable correlation identifiers while redacting secrets.
5. Critical provider/resource quota exhaustion and deployment/runtime failures have actionable alert thresholds before material availability degradation.
6. Preview/staging/production secrets and mutable state cannot cross environment boundaries.
7. Release controls are deterministic, bounded and auditable.

# Implementation Requirements

- Implement the release ledger and operator control surface using the existing authoritative PostgreSQL boundary; do not create a second release/deployment authority.
- Bind every release and deployment record to an exact immutable Git revision plus environment and the existing D-01 deployment identity.
- Make release evidence append-only and distinguish attempts from the effective latest gate result without allowing evidence fabrication by CI or workers.
- Cross-check the release ladder and environment definitions fail closed; promotion must require the target phase's defined gates.
- Make migration readiness detect unapplied shipped migrations, applied-but-unshipped migrations and checksum drift before promotion.
- Make rollback a governed release-control transaction that changes only release-control state and never durable execution/business authority.
- Implement a provider-neutral, write-blind, bounded telemetry sink with stable correlation identifiers and deterministic trace identity; it must have no path to declare domain success.
- Reject secret-shaped telemetry fields and redact credential-shaped values before buffering/export.
- Implement bounded OTLP/HTTP export without introducing a provider-specific observability authority; unconfigured export must remain the documented degraded mode.
- Derive quota/operational alerts from authoritative Zeck stores, warn before exhaustion, and block promotion on active critical conditions.
- Keep preview, staging and production credentials/state isolated and never place provider credentials into repository artifacts or workflow logs.
- Keep CI/CD as a mechanism over repository-defined commands and preserve the self-hosting boundary.
- Add exact-revision static, dynamic and discrimination coverage for all acceptance criteria and checkpoint contracts.
- Do not modify `spec/development-state/*`; state transitions are Architect-owned after review/merge.

# Required Checkpoint Contracts

- `RELEASE-IDENTITY`
- `PROMOTION-GATES`
- `MIGRATION-SAFETY`
- `OBSERVABILITY-BOUNDARY`
- `ROLLBACK-SAFETY`
- `COST-QUOTA-GUARDS`
- `SELF-HOSTING-BOUNDARY`
- `IMPLEMENTATION-COMPLETENESS`

# Checkpoints

### RELEASE-IDENTITY

Prove every release/deployment is bound to one exact 40-hex Git revision, immutable environment identity and the existing D-01 deployment identity, with deterministic idempotency and no provider-owned authoritative identity.

### PROMOTION-GATES

Prove each environment transition requires the repository-defined gate set for that phase; missing or stale evidence and critical operational alerts fail closed, and refusal itself is journaled.

### MIGRATION-SAFETY

Prove production promotion refuses unapplied shipped migrations, applied-but-unshipped migrations and checksum drift, with deterministic ordered migration evidence recorded against the exact release revision.

### OBSERVABILITY-BOUNDARY

Prove telemetry is a write-blind bounded sink carrying stable correlation without secrets, can reconstruct execution/deployment chains, and cannot mutate or declare domain authority.

### ROLLBACK-SAFETY

Prove rollback changes only release-control state/pointers in one governed transaction, preserves append-only journal evidence, and leaves every non-release-control domain row unchanged.

### COST-QUOTA-GUARDS

Prove authoritative resource exhaustion is detected before material impact, thresholds are bounded/actionable, critical conditions block promotion, and no unbounded paid overage is introduced by default.

### SELF-HOSTING-BOUNDARY

Prove CI/CD, observability export and provider integrations remain repository-defined mechanisms with equivalent self-hosted execution paths and no hidden provider control-plane authority.

### IMPLEMENTATION-COMPLETENESS

Prove all declared D-06 scope, acceptance criteria and Required Verification are implemented/tested, forbidden surfaces are untouched, and the evidence package maps each checkpoint and criterion to exact-revision implementation and tests.

# Evidence Contract

The worker must publish at minimum:

- exact registered base SHA and final head SHA;
- complete changed-file inventory and ancestry proof;
- architecture/dependency/governance checks;
- typecheck/lint/build results;
- deployment configuration validation;
- migration gate and ordering tests;
- promotion sequencing tests;
- health/smoke gate execution;
- telemetry correlation and secret-redaction tests;
- rollback safety tests;
- quota/cost alert tests;
- exact CI status;
- exact external-infrastructure limitations, with unavailable live providers explicitly NOT RUN rather than claimed PASS.

# Required Verification

## Static

- typecheck;
- lint;
- architecture/dependency boundary tests;
- forbidden provider-authority and secret-flow checks;
- deployment/config validation;
- changed-path inspection against this Work Order.

## Dynamic

- promotion-gate integration tests;
- migration gate/order tests against real PostgreSQL where applicable;
- health/smoke gate execution;
- release identity attribution checks;
- rollback execution tests;
- telemetry emission/correlation and boundedness tests;
- cost/quota alert threshold tests;
- environment-isolation tests.

## Discrimination / mutation

- a deployment not tied to an exact commit must be rejected;
- bypassing migration, health or smoke gates must fail;
- telemetry containing secret material must be rejected/redacted;
- provider/dashboard state must not be able to declare domain success;
- rollback must not mutate durable execution/business authority;
- unbounded log/metric/trace volume or uncontrolled quota overage must be detected;
- preview credentials must not satisfy staging/production bindings.

# Completion

WORK-047 is complete only when all acceptance criteria and required checkpoints have exact-revision evidence, the Architect accepts the PR, the Architect merges it, and post-merge program/dependency/frontier/continuation/handoff state is finalized.

Required branch: `work/WORK-047-production-delivery-observability-release-control`

One Work Order = one implementation branch = one PR. The worker cannot approve or merge its own PR.