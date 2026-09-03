# Zeck UX Implementation Plan

**Status:** Architect-directed implementation handoff
**Governing UX contract:** `docs/UX-ARCHITECTURE.md`
**Governing technical architecture:** `spec/architecture.md` v1.0

## Goal

Transform the existing dashboard projection into the calm, outcome-first Zeck experience without creating a second authority for executions, policy, budgets, verification, identity, credentials, or customer-domain state.

The existing dashboard is a thin projection over the public API. Preserve that boundary while replacing the minimal developer presentation with a production-quality web experience.

## Recommended implementation shape

Use a React-based web application with TypeScript, while keeping the current SDK/API as the only source for platform facts. The frontend owns presentation state only: navigation, disclosure, temporary form state, optimistic visual state where safe, and view preferences. It must never become an authoritative cache or registry.

Keep the existing `apps/dashboard` package as the product surface rather than creating a second dashboard application.

## Route map

```text
/
/home
/build
/build/execution
/build/agent
/build/workload
/runs
/runs/active
/runs/history
/runs/scheduled
/runs/:executionId
/assets/artifacts
/assets/artifacts/:artifactId
/assets/competences
/assets/competences/:competenceId
/assets/connections
/improve/evaluations
/improve/insights
/improve/learning
/admin/policies
/admin/budgets
/admin/team
/admin/environments
/admin/audit
```

All routes are projections of existing API/domain objects. No route introduces a new lifecycle authority.

## Phase 1 — Experience shell

Deliver:

- persistent desktop sidebar
- responsive tablet/mobile navigation
- top command/search surface
- global page frame
- `Attention` area
- keyboard navigation and focus management
- light/dark/system appearance support
- accessible typography, states and hit targets
- loading, empty, error and permission-denied primitives

The shell must work with real API data and remain useful when some modules return no data.

## Phase 2 — Home and execution experience

Home becomes the default entry point:

```text
Describe outcome
→ proposed execution
→ cost/time/permission summary
→ execute
→ result
→ evidence
```

Execution detail becomes the canonical work surface:

```text
Result | Evidence | Activity
```

Add:

- status/header facts
- result rendering
- verification/confidence strip
- artifact links
- chronological activity
- human/user decision surfaces
- cancellation through the existing governed API command
- `How Zeck did it` progressive disclosure
- advanced timeline/graph/events/raw views

The UI must distinguish provider success, execution success, quality success and policy success.

## Phase 3 — Build surfaces

Implement outcome-first creation for:

- executions
- agents
- workloads
- deployments
- training/batch jobs

Start every flow with purpose/outcome. Present a proposed plan before detailed controls. Advanced graph editing is secondary.

## Phase 4 — Operational surfaces

Implement:

- Active / History / Scheduled runs
- agent inventory and details
- deployments and version/health views
- artifacts and lineage
- connections
- workload/training status

The UI should preserve the distinction between a persistent deployment and an individual execution.

## Phase 5 — Trust, control and improvement

Implement:

- Evidence and provenance views
- confidence/check explanations
- policy/rules summaries
- budget/spend summaries
- approval/review experiences
- Improve recommendations
- learning/evaluation detail
- advanced route/provider/compute disclosures

Consequential actions must display consequence, authorization requirements and cost/risk before commitment.

## Phase 6 — Expert mode

Expose advanced internals without changing the default experience:

```text
Plans
Capabilities
Effective policies
Providers
Model strategy
Compute substrate
Execution events
Artifact lineage
Audit
Raw execution graph
```

These are inspection/authoring surfaces, not alternative authorities.

## Core component contracts

### `ExecutionHeader`

Displays identity, status, duration, cost and trust state.

### `VerificationSummary`

Displays human-readable checks and links to evidence. Never invents a confidence score independently of platform verification facts.

### `ProgressTimeline`

Chronological execution stages. Must remain useful without a graph library.

### `WhyPanel`

Explains task understanding, plan, capabilities, route, compute and routing rationale using data returned by the platform.

### `AttentionCard`

Represents a user decision, failed execution requiring action, approval request or other consequential attention item.

### `CommandPalette`

Searches and proposes actions across executions, agents, deployments, workloads, artifacts, competences, connections and settings. Mutations require the normal API authorization path.

### `ResultSurface`

Primary result presentation. Must make next action and trust state obvious.

### `AdvancedDisclosure`

Reusable progressive-disclosure pattern. Advanced technical fields never appear by default solely because they are available in API responses.

## Data and state rules

1. Platform facts always come from the public API/SDK.
2. No browser-side registry may become source of truth.
3. Never store raw secrets, provider credentials or hidden authorization material in UI state.
4. Never perform customer-domain workflow mutations directly from the dashboard.
5. Never infer verification success from HTTP success.
6. Never expose provider/model choice as the primary user mental model.
7. Mutating commands use existing idempotent API operations.

## Visual system

Start from semantic design tokens rather than component-specific styling:

```text
spacing
radius
surface
text
border
focus
status
attention
success
warning
error
shadow
motion
```

Typography and spacing carry hierarchy. Color primarily communicates state or attention. Decorative gradients, dense dashboards and persistent graph canvases are not default UI primitives.

## Accessibility gate

Every major surface must support:

- keyboard-only operation
- visible focus
- semantic headings/landmarks
- screen-reader labels
- non-color state communication
- scalable text
- reduced motion
- adequate hit targets
- confirmation for destructive/high-impact actions
- understandable asynchronous state

## Verification gates

Frontend acceptance is not visual-only. For every phase, verify:

- governance checker remains green
- typecheck remains green
- lint remains green
- existing API/dashboard tests remain green
- architecture dependency direction remains unchanged
- no secret material crosses the presentation boundary
- no frontend-owned authority/state machine appears
- responsive behavior is verified at desktop/tablet/mobile breakpoints
- keyboard and accessibility behavior is verified on every primary journey
- real API-backed smoke journeys cover Home → Execution → Result → Evidence

## Primary acceptance journeys

### First successful execution

```text
Home → describe outcome → review plan → Execute → Result → Evidence
```

### Failed execution

```text
Runs → failed execution → explanation → Why → Activity → remediation
```

### Build agent

```text
Build → describe purpose → proposed design → accept → guardrails → deploy
```

### Approve risky action

```text
Attention → consequence → policy → review → approve/reject → verification
```

### Improve workflow

```text
Improve → recommendation → evidence → projected impact → review → apply → verify
```

## Non-goals

This plan does not change the frozen v1.0 architecture, reopen completed technical Work Orders, or create new requirement authority. Technical implementation work must be issued through the repository's normal Work Order protocol.
