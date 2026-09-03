# WORK-035 — Zeck experience foundation and interaction system

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Establish the reusable presentation and interaction foundation required to realize Zeck Experience Architecture v2 without changing the frozen execution architecture. This order creates the visual hierarchy, navigation model, responsive shell, command surface, disclosure primitives and accessibility foundation that all later UX work consumes.

# Context

`docs/UX-EXPERIENCE-ARCHITECTURE-V2.md` and `docs/UX-SCREEN-SPEC-V2.md` replace feature-by-feature dashboard thinking with one coherent interaction grammar: Intent -> Work -> Plan -> Authorization -> Execution -> Result -> Trust -> Improve. WORK-033 realized the prior UX contract but intentionally preceded this sharper product model. WORK-035 must establish the common foundation only; downstream work orders realize individual product journeys.

# Dependencies

Requires: WORK-033, WORK-034

# Requirement IDs

N/A — presentation-layer realization of accepted UX architecture; frozen technical requirement ownership remains unchanged.

# Declared Change Surfaces

- `apps/dashboard/` shared shell, tokens, layout, navigation, command and interaction primitives
- dashboard-local tests and fixtures required for the above
- `docs/work-items/WORK-035.md`

Do not modify `src/modules/`, public domain contracts, or `spec/development-state/` from this Work Order.

# Scope Boundaries

Allowed:
- semantic design tokens and global typography/spacing hierarchy
- desktop/tablet/mobile shell
- navigation hierarchy and contextual breadcrumbs/title treatment
- Simple/Professional/Expert visibility model
- global command/search surface and action proposal presentation
- Attention primitive
- loading, empty, error, permission-denied and confirmation primitives
- disclosure/sheet/panel primitives
- focus management and accessibility foundations
- dashboard-local visual regression/unit tests

Forbidden:
- feature-specific domain workflow implementation
- new execution/policy/budget/verification authority
- frontend-owned caches or registries
- raw credentials or secrets
- direct backend calls outside the established dashboard API/SDK boundary
- changing frozen technical architecture or requirement ownership
- implementing downstream Home, Build, Trust, Control or modality-specific journeys
- merging the worker's own PR

# Architecture Invariants

- The dashboard remains a projection over public API/SDK authorities.
- Execution remains the primary public AI-work abstraction.
- UX modes change visibility/density, never semantics.
- Advanced detail is progressively disclosed.
- Consequential actions visibly expose consequence and authorization before commitment.
- No visual primitive manufactures trust or policy facts.

# Acceptance Criteria

1. A responsive application shell exists for desktop, tablet and mobile with stable hierarchy and no dashboard-wide loading spinner replacing the shell.
2. The navigation reflects the v2 information architecture while remaining contextual and permission-aware.
3. Global `Cmd/Ctrl+K` supports object search, navigation and proposed actions through the existing dashboard dispatch path.
4. Simple, Professional and Expert visibility rules can be applied without changing underlying data semantics.
5. Attention can represent decisions, approvals, failed work and consequential recommendations without becoming a routine notification center.
6. Reusable states exist for loading, empty, error, permission denied, confirmation and advanced disclosure.
7. Keyboard traversal, visible focus, semantic headings/landmarks, non-color status communication, scalable text and reduced-motion behavior are implemented in shared primitives.
8. No new backend authority, raw secret, tenant registry or direct customer-domain mutation is introduced.
9. Automated dashboard tests prove navigation, command invocation, disclosure, accessibility primitives and responsive layout rules.
10. The implementation is consumable by WORK-036 onward without re-defining shell semantics.

# Implementation Requirements

1. Establish semantic tokens and a small component vocabulary; avoid component-specific one-off styling that creates competing hierarchy.
2. Build a quiet persistent desktop navigation, collapsed tablet navigation and mobile priority model centered on Home/Work/Attention/Result/Review/Command.
3. Implement a command surface with search and proposed action states; mutations must remain API-authorized and user-confirmed where consequential.
4. Implement mode-aware rendering as presentation state, not duplicated route trees or object models.
5. Make focus ownership explicit for dialogs/sheets/command surfaces and restore focus after dismissal.
6. Add deterministic tests for all shared primitives and key keyboard paths.
7. Keep changes inside declared dashboard surfaces and preserve existing tenant-safe transport behavior.

# Required Checkpoint Contracts

- `SELF-HOSTING-BOUNDARY`
- `EXECUTION-PROVENANCE`

# Checkpoints

- readiness: exact main base, WORK-033/034 completion and baseline gate verified
- boundary: no new dashboard authority, direct transport bypass or secret exposure
- interaction: command/search and disclosure operate through shared primitives
- accessibility: keyboard/focus/semantics/reduced-motion evidence
- responsive: desktop/tablet/mobile evidence
- review: complete gate twice consecutively at exact final head

# Evidence Contract

Evidence must identify exact base/final revisions, changed-file inventory, token/component inventory, navigation and mode behavior, command/action path, accessibility evidence, responsive evidence and proof that downstream flows can consume the foundation without redefining platform semantics.

# Required Verification

- governance checker
- typecheck
- lint
- dashboard unit/component tests
- keyboard/accessibility verification
- responsive browser verification
- command/action authorization-path tests
- secret-exposure discrimination
- full suite twice consecutively at exact final head

# Completion

Worker opens a PR but does not merge. Completion requires architect acceptance, exact-head verification and post-merge finalization.