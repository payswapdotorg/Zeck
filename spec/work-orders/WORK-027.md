# WORK-027 — Computer-use and GUI execution

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: CRITICAL

# Objective

Provide a governed computer-use capability for browser, desktop and terminal-style interaction without turning GUI execution into an unrestricted side-effect channel.

# Context

Computer-use agents increasingly operate applications through user interfaces rather than structured APIs. Zeck must mediate those actions through the same execution, policy, capability, budget, tenant, secret and verification authorities used by other tools.

# Dependencies

Requires: WORK-010, WORK-012, WORK-013, WORK-031

# Requirement IDs

- `CUI-001`
- `CUI-002`
- `CUI-003`

# Declared Change Surfaces

- `src/modules/tools/`
- `src/modules/sandbox/`
- `src/modules/deployments/` (directly-required computer-use deployment seams only)

# Scope Boundaries

Allowed:
- provider-neutral browser/desktop/terminal capability contracts
- isolated computer-use sessions
- policy-mediated credentials, network and filesystem access
- screenshots, DOM/accessibility-tree observations and structured interaction evidence

Forbidden:
- unrestricted host desktop access
- hidden network access
- raw credential embedding
- bypass of policy/capability/budget/tenant authorities
- creating a second execution state machine
- merging the worker's own PR

# Architecture Invariants

- Computer use is a governed capability, not an authority.
- Side effects occur only after policy, capability, tenant and budget admission.
- Sensitive UI observations and actions retain execution provenance.
- Host access is isolated through the approved compute-environment boundary.
- Deterministic alternatives are considered before model-driven interaction.

# Acceptance Criteria

1. Define provider-neutral computer-use contracts for browser, desktop and terminal interaction.
2. Execute computer-use sessions in an isolated environment with explicit network, filesystem and credential policy.
3. Record actionable observations and side effects as execution evidence.
4. Prove policy and tenant denial occur before any external side effect.
5. Prove unregistered or fabricated computer-use capabilities cannot dispatch.
6. Support deterministic browser/API alternatives when they satisfy the task before GUI inference is used.

# Implementation Requirements

- Every action must identify target execution/session context.
- Credentials are injected through the existing mediated secret path.
- External side effects must be typed and auditable.
- Screenshots/accessibility observations must carry provenance and retention metadata.

# Required Checkpoint Contracts

- `SELF-HOSTING-BOUNDARY`
- `EXECUTION-PROVENANCE`

# Required Verification

- governance checker
- typecheck
- lint
- computer-use adapter contract tests
- isolation/security tests
- policy-before-side-effect discrimination
- tenant isolation tests
- credential mediation tests
- deterministic-alternative routing tests
- concurrency/crash tests for session retries where applicable

# Completion

Worker opens a PR but does not merge. Completion requires architect acceptance and post-merge finalization.
