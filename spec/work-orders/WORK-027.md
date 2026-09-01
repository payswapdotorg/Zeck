# WORK-027 — Computer-use and GUI execution

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: CRITICAL

# Objective

Provide a governed computer-use capability for browser, desktop and terminal-style interaction without turning GUI execution into an unrestricted side-effect channel.

# Context

Computer-use agents increasingly operate applications through user interfaces rather than structured APIs. Zeck must mediate those actions through the same execution, policy, capability, budget, tenant, secret and verification authorities used by other tools.

Computer use is also a **fallback computational mode**, not a default. The planner should prefer a deterministic/API capability whenever it can satisfy the task with sufficient confidence, and escalate to browser or desktop interaction only when structured alternatives are insufficient or unavailable.

The architecture must support three distinct interaction modes under one governed capability family:

1. deterministic/API interaction;
2. isolated browser automation;
3. isolated desktop/terminal interaction.

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
- deterministic/API alternative contracts where needed for computer-use planning
- isolated computer-use sessions
- policy-mediated credentials, network and filesystem access
- screenshots, DOM/accessibility-tree observations and structured interaction evidence

Forbidden:
- unrestricted host desktop access
- hidden network access
- raw credential embedding
- bypass of policy/capability/budget/tenant authorities
- creating a second execution state machine
- treating GUI/model interaction as mandatory when a deterministic/API route is sufficient
- merging the worker's own PR

# Architecture Invariants

- Computer use is a governed capability, not an authority.
- Side effects occur only after policy, capability, tenant and budget admission.
- Sensitive UI observations and actions retain execution provenance.
- Host access is isolated through the approved compute-environment boundary.
- Deterministic alternatives are considered before model-driven interaction.
- Browser, desktop and terminal interaction share the same Zeck execution and evidence abstractions.
- Computer-use adapters never become policy, capability, budget, verification or execution authorities.

# Acceptance Criteria

1. Define provider-neutral computer-use contracts for browser, desktop and terminal interaction.
2. Execute computer-use sessions in an isolated environment with explicit network, filesystem and credential policy.
3. Record actionable observations and side effects as execution evidence.
4. Prove policy and tenant denial occur before any external side effect.
5. Prove unregistered or fabricated computer-use capabilities cannot dispatch.
6. Support deterministic browser/API alternatives when they satisfy the task before GUI inference is used.
7. Support an explicit escalation path from deterministic/API → browser automation → desktop interaction when the prior mode is insufficient, while preserving policy/capability/budget/verification gates at every stage.
8. Preserve target/session/execution lineage for each observation and action so a computer-use trajectory can be replayed or independently verified.

# Implementation Requirements

- Every action must identify target execution/session context.
- Credentials are injected through the existing mediated secret path.
- External side effects must be typed and auditable.
- Screenshots/accessibility observations must carry provenance and retention metadata.
- Browser/API automation should be represented as deterministic capabilities when possible rather than requiring a generative model.
- Desktop interaction must expose an explicit capability envelope (input devices, windows/apps, filesystem, network, clipboard, downloads and other side effects) rather than ambient authority.
- Terminal execution must use the approved sandbox boundary and explicit process/filesystem/network capabilities.
- A computer-use session must not silently inherit the user's host credentials, cookies, environment variables, mounted files or unrestricted sockets.
- When an API or deterministic action and a GUI action are both available, the planner-facing result must preserve evidence sufficient for deterministic-first selection.

# Evidence Model

Computer-use execution should emit structured evidence for:

- observation type (DOM, accessibility tree, screenshot, terminal output, etc.)
- action type and target
- timestamp/sequence
- execution/session identity
- capability used
- external side-effect classification
- artifact/reference produced
- verification-relevant evidence

Sensitive observations must carry retention/redaction metadata and must not leak secrets through public serialization.

# Deterministic-first Computer Use

The implementation must make this distinction explicit:

```text
Task
  ↓
Can an API / deterministic capability satisfy it?
  ├─ yes → execute deterministic path
  └─ no  → browser automation candidate
               ↓
            insufficient?
               ↓
            desktop interaction candidate
```

The diagram is a planning policy preference, not an additional authority. Existing Policy, Capability, Budget, Execution and Verification authorities remain decisive.

A high-confidence deterministic/API route must not be displaced solely because a GUI/model route appears historically successful.

# Required Checkpoint Contracts

- `SELF-HOSTING-BOUNDARY`
- `EXECUTION-PROVENANCE`

# Checkpoints

- readiness: Work Order dependencies and declared surfaces verified before implementation
- security: isolation, credential mediation and side-effect ordering proven
- implementation-completeness: required contracts, tests and evidence present before PR
- deterministic-first: sufficient deterministic/API alternatives produce zero GUI/model dispatches
- trajectory-provenance: actions and observations preserve execution/session identity and replayable ordering

# Evidence Contract

Evidence must identify the exact implementation and final branch heads, map every CUI requirement to code and tests, and include security/discrimination, deterministic-first routing, trajectory provenance and side-effect ordering proofs. Workers must not claim CI, execution or external-system results that were not actually observed.

# Required Verification

- governance checker
- typecheck
- lint
- computer-use adapter contract tests
- browser/API-vs-GUI routing tests
- isolation/security tests
- policy-before-side-effect discrimination
- tenant isolation tests
- credential mediation tests
- deterministic-alternative routing tests
- trajectory/evidence provenance tests
- concurrency/crash tests for session retries where applicable
- tests proving host desktop/browser state is not ambiently inherited

# Completion

Worker opens a PR but does not merge. Completion requires architect acceptance and post-merge finalization.
