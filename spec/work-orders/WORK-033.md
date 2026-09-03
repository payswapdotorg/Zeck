# WORK-033 — Zeck UX experience shell and dashboard realization

Status: COMPLETE

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Realize the accepted Zeck experience architecture in the existing `apps/dashboard` projection surface so the product presents a calm, outcome-first user experience without creating any new platform authority.

# Context

`docs/UX-ARCHITECTURE.md` is the accepted UX contract. `docs/UX-IMPLEMENTATION-PLAN.md` is the implementation handoff. The existing dashboard is a minimal read/compose projection over the public API. The worker must evolve that surface rather than introducing a competing dashboard or local source of truth.

# Dependencies

Requires: WORK-015, WORK-023, WORK-027, WORK-028, WORK-029, WORK-030, WORK-032, WORK-034

# Requirement IDs

N/A — presentation/interaction realization of the accepted UX architecture; frozen technical requirement ownership remains unchanged.

# Declared Change Surfaces

- `apps/dashboard/`
- dashboard-local tests and fixtures required for the above

Do not modify `src/modules/` or `spec/development-state/` from this Work Order.

# Scope Boundaries

Allowed:
- dashboard frontend architecture and components
- responsive information architecture
- Home / Attention / Runs / Build / Assets / Improve / Admin presentation
- execution result, evidence, activity and explanation views
- command/search experience
- progressive disclosure and expert inspection views
- accessibility and responsive behavior
- dashboard API/SDK projection integration

Forbidden:
- new execution lifecycle authority
- frontend-owned policy, budget, verification or identity authority
- frontend-owned authoritative cache/registry
- direct customer-domain mutation
- secret or raw credential rendering
- provider-centric primary information architecture
- graph-first default execution experience
- changing frozen technical architecture
- changing frozen requirement ownership
- merging the worker's own PR

# Architecture Invariants

- The dashboard remains a projection over existing public API/SDK authorities.
- Execution remains the primary AI-work abstraction.
- All mutations continue through governed API paths and existing idempotency rules.
- Verification facts come from the platform; UI never manufactures correctness/confidence.
- Policy remains the authorization boundary.
- Budget/economic accounting remains canonical.
- Customer-domain workflow authority remains outside Zeck.
- Advanced technical information is progressively disclosed rather than made the default mental model.

# Acceptance Criteria

1. Home presents outcome-first execution as the primary action and surfaces Attention, active work and recent outcomes without becoming an analytics dashboard.
2. Execution detail provides Result, Evidence and Activity views with status, duration, cost, verification state and a progressive `How Zeck did it` explanation.
3. Runs provide active/history/scheduled discovery and recoverable failure/waiting states.
4. Build provides outcome-first entry points for execution, agent, workload/training and deployment creation, with proposed-plan review before detailed configuration where applicable.
5. Agents, deployments, workloads, artifacts, competences, connections, improve and admin surfaces map to existing API/domain objects without creating parallel state machines.
6. A global command/search surface supports navigation and proposed actions while all mutations use existing governed API paths.
7. Responsive behavior works at desktop, tablet and mobile widths while preserving the execution/result hierarchy.
8. Primary journeys are keyboard accessible, screen-reader usable and do not rely on color alone for state.
9. No raw credential, secret, or authoritative backend state is introduced into the frontend.
10. Existing developer dashboard behavior remains API-backed and tenant-safe.
11. Expert views can expose plans, capabilities, provider/model route, compute, events, lineage and audit without polluting the default experience.
12. The dashboard preserves the existing public API mental model and does not create a second execution semantics.

# Implementation Requirements

The implementation follows the phase shape of `docs/UX-IMPLEMENTATION-PLAN.md` within this Work Order's declared surfaces:

1. Experience shell: persistent desktop sidebar, responsive tablet/mobile navigation, global command/search surface, global page frame, `Attention` area, keyboard navigation and focus management, light/dark/system appearance support, accessible typography/states/hit targets, and loading/empty/error/permission-denied primitives — working with real API data and remaining useful when some modules return no data.
2. Home and execution experience: Home becomes the default outcome-first entry point (describe outcome → proposed execution → cost/time/permission summary → execute → result → evidence); execution detail becomes the canonical work surface with `Result | Evidence | Activity` tabs, status/header facts, result rendering, verification/confidence strip, artifact links, chronological activity, human/user decision surfaces, cancellation through the existing governed API command, `How Zeck did it` progressive disclosure, and advanced timeline/graph/events/raw views; provider success, execution success, quality success and policy success remain distinguished.
3. Build surfaces: outcome-first creation flows for executions, agents, workloads, deployments and training/batch jobs, each starting with purpose/outcome and presenting the proposed plan before detailed controls; advanced graph editing remains secondary.
4. Operational surfaces: active/history/scheduled runs, agent inventory and details, deployment and version/health views, artifacts and lineage, connections, and workload/training status, preserving the distinction between a persistent deployment and an individual execution.
5. Trust, control and improvement: evidence and provenance views, confidence/check explanations, policy/rules summaries, budget/spend summaries, approval/review experiences, Improve recommendations, learning/evaluation detail, and advanced route/provider/compute disclosures; consequential actions display consequence, authorization requirements and cost/risk before commitment.
6. Expert mode: plans, capabilities, effective policies, providers, model strategy, compute substrate, execution events, artifact lineage, audit and raw execution graph exposed as inspection/authoring surfaces without changing the default experience.

The implementation plan's core component contracts, data and state rules, accessibility gate and verification gates apply to every phase.

# Required Checkpoint Contracts

- `SELF-HOSTING-BOUNDARY`
- `EXECUTION-PROVENANCE`

# Checkpoints

- readiness: confirm exact main base, accepted UX documents, dependency completion and declared-surface isolation before implementation
- authority: prove frontend is projection-only and all mutations use existing API authorities
- trust: prove Result/Evidence/Activity presentation distinguishes provider success, execution success, quality success and policy success
- accessibility: keyboard, focus, semantics, scalable text, reduced motion and non-color status evidence
- responsive: desktop/tablet/mobile journey coverage
- integration: real API-backed Home → Execution → Result → Evidence journey

# Evidence Contract

Evidence must identify the exact implementation and final branch heads, changed dashboard surfaces, API/SDK integration points, responsive/accessibility verification, authority-boundary proofs, secret-safety checks and exact smoke-test revisions. No visual claim is accepted without executable evidence where the property is testable.

# Required Verification

- governance checker
- typecheck
- lint
- existing dashboard tests
- frontend/unit component tests
- API projection/integration tests for primary journeys
- authority-boundary discrimination
- secret-exposure discrimination
- responsive browser verification
- keyboard/accessibility verification
- Result/Evidence/Activity trust-state tests
- command/action authorization-path tests
- full suite

# Completion

Worker opens a PR but does not merge. Completion requires architect acceptance, exact-head verification and post-merge finalization.
