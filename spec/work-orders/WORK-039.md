# WORK-039 — Control, spend, connections and improvement experience

Status: IN-FLIGHT

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Expose Zeck's control plane and improvement loop in human terms: rules, spend, connections, environments, team permissions, evaluations, insights and learning recommendations, without turning the product into an infrastructure or accounting console.

# Context

Policy, budget, connections and environments are essential to safe operation, while learning and deterministicization are essential to making Zeck improve over time. The primary experience must describe these as Controls, Spend and Improve rather than implementation machinery. Authoritative values must always come from existing APIs.

# Dependencies

Requires: WORK-038

# Requirement IDs

N/A — dashboard projection realization; existing domain and authority ownership remains unchanged.

# Declared Change Surfaces

- `apps/dashboard/` Control and Improve routes
- dashboard-local tests and fixtures for policies, spend, connections, team, environments, evaluations, insights and learning
- `docs/work-items/WORK-039.md`

# Scope Boundaries

Allowed:
- policy summary and effective-rule explanations
- budget/spend overview and detailed accounting disclosure
- connections inventory/status/configuration presentation without secret rendering
- environments and team administration presentation where existing APIs support it
- evaluation, insight and learning recommendation views
- deterministicization/improvement recommendation presentation
- consequence/authorization explanations for control changes

Forbidden:
- new policy resolution authority
- frontend financial ledger or reservation authority
- raw provider credentials or API keys
- automatic application of learning recommendations outside existing promotion APIs
- backend domain changes or frozen architecture changes
- merging the worker's own PR

# Architecture Invariants

- Policy remains the authorization boundary.
- Budget/economic accounting remains canonical.
- BYOK and credentials remain secret-mediated.
- Learning produces recommendations/evidence, never authorization.
- User-facing control language may simplify precedence, but must not alter effective policy semantics.

# Acceptance Criteria

1. Policy pages present user-level controls first: quality, spend, latency, data, tools, approvals and autonomy where available.
2. Users can understand why an action is blocked and which effective rule controls it without reading policy-engine internals.
3. Spend shows current usage, limits and major categories in a simple view, with reservations/settlement/ledger available as advanced detail.
4. Connection pages communicate health and setup state without rendering secrets or hidden authorization material.
5. Team/environment controls are organized around safe operational intent rather than backend module topology.
6. Improve surfaces present recommendations with observed evidence, expected impact, confidence, affected work and disposition (advisory/review/applicable) from platform data.
7. Evaluation and learning views distinguish evidence from recommendation and recommendation from authoritative production behavior.
8. Consequential control changes and recommendation application show consequence and authorization before commitment.
9. API-backed tests prove scope isolation, secret safety and no frontend-owned authority.
10. Responsive and accessible behavior preserves the control/improvement hierarchy.

# Implementation Requirements

1. Reuse shared shell, disclosure, trust and consequence-preview primitives.
2. Default policy language should use `Rules`/`Controls`; expose effective-policy composition as advanced detail.
3. Default spend language should use `Spend`/`Limit`; expose reservations and settlement as accounting detail.
4. Recommendations must link to the executions/evaluations that produced the evidence.
5. Any apply/change action must use the existing governed API operation and refresh authoritative state after completion.
6. Add discrimination tests ensuring learning cannot mutate policy/budget authority through the UI.

# Required Checkpoint Contracts

- `SELF-HOSTING-BOUNDARY`
- `EXECUTION-PROVENANCE`

# Checkpoints

- readiness: exact base and WORK-038 completion verified
- policy: effective controlling-rule explanation is accurate
- spend: no second accounting truth or secret leakage
- improvement: recommendations are evidence-backed and non-authoritative until governed application
- accessibility/responsive: control and improvement journeys pass
- review: full gate twice consecutively at exact final head

# Evidence Contract

Evidence must identify exact revisions, affected routes, policy/spend/connection API mappings, secret-safety proofs, recommendation evidence mappings, authorization-path tests, accessibility/responsive evidence and exact final-head verification.

# Required Verification

- governance checker
- typecheck
- lint
- dashboard/unit/integration tests
- policy explanation tests
- spend/limit tests
- secret-exposure discrimination
- learning recommendation authority tests
- responsive browser verification
- keyboard/accessibility verification
- full suite twice consecutively at exact final head

# Completion

Worker opens a PR but does not merge. Completion requires architect acceptance, exact-head verification and post-merge finalization.

# Dispatch Record

- Issue: #69
- Dispatch status: AUTHORIZED / IN-FLIGHT
- Work Order was promoted from PENDING to IN-FLIGHT by the Architect before worker branch creation.
- The binding exact base is the final dispatch-state commit on `main`, recorded in issue #69 immediately before branch creation.
- Required worker branch: `work/WORK-039-control-spend-connections-improvement`
- Worker must not modify `spec/development-state/*` during active work.
- Worker must not merge its own PR.
- Worker may implement only this Work Order and its declared surfaces.