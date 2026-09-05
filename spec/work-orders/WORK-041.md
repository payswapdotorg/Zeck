# WORK-041 — UX integration hardening, usability and release gate

Status: IN-FLIGHT

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Consolidate the complete Zeck UX v2 realization into a coherent, production-quality experience and prove that the individual Work Order increments behave as one product across navigation, Work, trust, controls, improvement and advanced modality surfaces.

# Context

WORK-035 through WORK-040 deliberately sequence the implementation to keep shared dashboard changes safe. The final order is not a feature bucket; it is the product-level integration gate. It addresses cross-route consistency, visual hierarchy, usability defects, responsive transitions, accessibility, performance, error recovery and end-to-end journeys that can only be proven once the full surface exists.

# Dependencies

Requires: WORK-040

# Requirement IDs

N/A — final presentation/integration gate for the accepted UX architecture.

# Declared Change Surfaces

- `apps/dashboard/` integration, polish and shared behavior necessary to close UX v2
- dashboard-local tests, browser fixtures and verification artifacts
- `docs/work-items/WORK-041.md`

# Scope Boundaries

Allowed:
- cross-route consistency fixes
- navigation/context restoration fixes
- loading/empty/error/permission state consistency
- responsive breakpoint refinements
- keyboard/screen-reader/focus refinements
- visual hierarchy and density corrections
- performance improvements that do not alter domain semantics
- end-to-end journey stabilization
- browser and visual verification harnesses

Forbidden:
- new product domains or major feature surfaces
- backend module changes
- new execution/policy/budget/verification authority
- new client-side registries or caches as truth
- raw credential/secret exposure
- frozen architecture changes
- changing requirement ownership
- merging the worker's own PR

# Architecture Invariants

- The dashboard remains a projection over public API/SDK authorities.
- The same Execution/Work semantics apply across every modality.
- UX v2's outcome-first and progressive-disclosure rules remain intact.
- Trust claims remain evidence-backed.
- Consequential actions remain governed and consequence-aware.
- Expert depth is available without polluting the default experience.

# Acceptance Criteria

1. The completed dashboard presents one coherent information architecture from Home through Work, Build, Library, Trust, Control and Improve.
2. All primary journeys from `docs/UX-SCREEN-SPEC-V2.md` are executable and internally consistent.
3. No route introduces a second execution semantics, policy model, financial truth, verification model or tenant authority.
4. Global search/command, contextual object navigation and back/forward behavior preserve user intent and context.
5. Desktop, tablet and mobile layouts preserve the same task hierarchy and do not expose unsafe compressed expert controls.
6. Keyboard-only and screen-reader journeys cover Home, execution, approval/review, Build and primary object detail flows.
7. Reduced-motion, scalable text, non-color status and focus restoration behavior are verified.
8. Visual hierarchy consistently favors outcome -> explanation -> control -> internals across the entire product.
9. Error, empty, loading and permission states use a consistent recovery language and never leak internal secrets or stack traces by default.
10. Browser verification demonstrates no material console/page errors on the primary journeys and captures evidence for desktop/tablet/mobile.
11. Performance remains acceptable for primary dashboard journeys without introducing authoritative browser persistence.
12. The final evidence package identifies exact implementation heads and demonstrates the dashboard as a single coherent product.

# Implementation Requirements

1. Audit all previous UX work against the v2 doctrine and remove accidental provider-first, graph-first, dashboard-heavy or infrastructure-first patterns.
2. Prefer local fixes over new abstractions unless a shared inconsistency demonstrably warrants one.
3. Keep all presentation state ephemeral/non-authoritative.
4. Add end-to-end browser checks for first run, failure recovery, approval, agent build, deployment inspection, result/evidence inspection and improvement review.
5. Add accessibility regression checks and representative visual snapshots at agreed viewport classes.
6. Verify that advanced information is discoverable but not present by default where v2 requires progressive disclosure.

# Required Checkpoint Contracts

- `SELF-HOSTING-BOUNDARY`
- `EXECUTION-PROVENANCE`

# Checkpoints

- integration: all Work Order surfaces compose without semantic seams
- authority: no new frontend authority or transport bypass
- trust: result/evidence/activity and modality-specific trust states remain correct
- accessibility: primary keyboard/screen-reader journeys verified
- responsive: desktop/tablet/mobile evidence verified
- usability: consequence, recovery and progressive disclosure pass inspection
- release: full gate twice consecutively at exact final head

# Evidence Contract

Evidence must identify exact base/final revisions, all primary journey routes, browser verification matrix, accessibility checks, representative visual evidence, console/page error results, performance observations, authority-boundary checks and the final changed-file inventory.

# Required Verification

- governance checker
- typecheck
- lint
- dashboard/unit/integration tests
- complete primary-journey browser verification
- responsive desktop/tablet/mobile verification
- keyboard/accessibility verification
- trust-state regression verification
- command/action authorization-path tests
- secret-exposure discrimination
- performance sanity checks
- full suite twice consecutively at exact final head

# Completion

Worker opens a PR but does not merge. Completion requires architect acceptance, exact-head verification and post-merge finalization.

# Dispatch Record

- Issue: #73
- Dispatch status: AUTHORIZED / IN-FLIGHT
- Work Order was promoted from PENDING to IN-FLIGHT by the Architect before worker branch creation.
- Binding exact base: `76d1ea5a14de21b74c3fb495eb119fd85e864505`
- Required worker branch: `work/WORK-041-ux-integration-hardening-release-gate`
- Worker must not modify `spec/development-state/*` during active work.
- Worker must not merge its own PR.
- Worker may implement only this Work Order and its declared surfaces.
