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

# Declared Change Surfaces

Allowed modules/surfaces: deployment workflows and manifests, operator/release tooling, bounded observability instrumentation and adapters, health/smoke gates, migration/release gates, rollback controls, cost/quota alerting, D-06 tests/evidence, this Work Order, and only the minimum existing module seam consumption required to attach stable correlation identity.

Forbidden to modify frozen architecture v1.0, authoritative execution/policy/capability/budget/secret/tenant/verification semantics, or `spec/development-state/*` during active implementation.

# Scope

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

# Required Checkpoint Contracts

- `RELEASE-IDENTITY`
- `PROMOTION-GATES`
- `MIGRATION-SAFETY`
- `OBSERVABILITY-BOUNDARY`
- `ROLLBACK-SAFETY`
- `COST-QUOTA-GUARDS`
- `SELF-HOSTING-BOUNDARY`
- `IMPLEMENTATION-COMPLETENESS`

# Evidence Contract

The worker must publish at minimum:

- exact registered base SHA and final head SHA;
- complete changed-file inventory and ancestry proof;
- architecture/dependency/governance checks;
- typecheck/lint/build results;
- deployment configuration validation;
- migration gate and ordering tests;
- promotion sequencing tests;
- health/smoke gate tests;
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

## Completion

WORK-047 is complete only when all acceptance criteria and required checkpoints have exact-revision evidence, the Architect accepts the PR, the Architect merges it, and post-merge program/dependency/frontier/continuation/handoff state is finalized.

Required branch: `work/WORK-047-production-delivery-observability-release-control`

One Work Order = one implementation branch = one PR. The worker cannot approve or merge its own PR.