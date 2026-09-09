# WORK-053 — Adaptive Model/Reasoning and Multi-Agent Economics

Status: AUTHORIZED / PENDING

Owner: Implementation worker; Architect retains review, merge and state-finalization authority

Architecture Version: v1.0 (frozen); Execution Intelligence Architecture E1.0 + Economic Execution Intelligence E1.1 (ADR-0019, ADR-0020)

Assurance Profile: HIGH_ASSURANCE

# Objective

Implement the E1.1 charter wave member 3: the model-economics plane — quality-aware model selection, reasoning-effort selection, the 0/1/N agent gate, expected quality gain versus cost/latency/verification burden trade-offs, service-class selection where supported, and fresh-escalation decision hooks — so the compiler can select the least expensive model/effort/agent strategy consistent with the required outcome quality, with model routing never becoming a separate authority.

# Dependencies

Requires: WORK-050

Enables: WORK-055 (failure-aware recovery and fresh escalation consume the escalation decision hooks); WORK-056 (competence-aware optimization consumes the economics machinery).

Parallel-wave context: dispatched in the wave {WORK-051, WORK-052, WORK-053} after live surface/conflict analysis. Selected over WORK-054 for this wave slot: WORK-053's planning/model-economics write footprint is disjoint from WORK-051 (tools/sandbox) and WORK-052 (executions/context), while WORK-054's provider-SDK allowlist edit and compute-plane adapter writes overlap WORK-051's sandbox boundary pin family. WORK-054 dispatches when a wave slot frees.

# Requirement IDs

No existing product requirement IDs are introduced by this Work Order; it defines the adaptive model/reasoning economics contracts subordinate to ADR-0019/ADR-0020 and frozen v1.0.

# Declared Change Surfaces

Allowed modules/surfaces: the model-economics plane (quality-aware selection logic, effort selection, the 0/1/N agent gate, expected-gain trade-off machinery, service-class selection hooks, fresh-escalation decision hooks); additive consumption of the execution-compiler's representation-ladder hooks and the WORK-049 decision-record/cost-model seams (read-only); E1.1 model-economics tests/evidence; operator/developer documentation for this surface.

Forbidden to modify frozen architecture v1.0, authorization/policy/capability/budget/secret/tenant/verification semantics, the planner or plan-selection authority, the execution-compiler engine and execution-ir foundation (import/consume only), or `spec/development-state/*` during active implementation.

# Scope Boundaries

Allowed:

- Quality-aware model selection: selection among declared model candidates by expected successful-resolution quality and cost (explicit-basis claims only, the estimation-basis contract is the seam).
- Reasoning-effort selection: effort level selection under the same explicit-basis economics.
- The 0/1/N agent gate: the decision machinery that selects zero-agent (deterministic path), one-agent, or N-agent (deliberate parallelism) execution per step/outcome, with expected quality gain weighed against cost/latency/verification burden.
- Expected-gain trade-offs: bounded, typed computations of expected quality gain versus cost, latency and verification burden; below-threshold selections are inadmissible.
- Service-class selection: hooks only, where the substrate supports declared service classes.
- Fresh-escalation decision hooks: decision hooks that RECORD when escalation-to-fresh-context is economically justified (the recovery behavior itself is WORK-055, out of scope here).
- Tests: unit, integration over real PostgreSQL when durable semantics are claimed, discrimination/mutation, architecture boundary proofs.
- Evidence: `docs/work-items/WORK-053.md` matching the WORK-048/049/050 pattern.

Forbidden:

- always-on multi-agent behavior (N-agent is a deliberate, gated, evidence-backed selection — never a default);
- model choice overriding Work Order assurance requirements (the assurance profile is a hard floor; economics operate above it);
- model routing as a separate authority (selection is decision evidence through the compiler's seams — no router, no registry of authority);
- live provider/model credential use (offline decision logic + explicit-basis claims only; live routing is out of scope);
- modifying the execution-compiler engine or execution-ir foundation (import/consume only);
- creating a new durable state machine beyond the decision-record store;
- modifying frozen v1.0 public contracts;
- modifying `spec/development-state/*` during active implementation;
- self-approval or self-merge.

# Architecture Invariants

1. Selection is the least expensive SUFFICIENT strategy: the required outcome quality (assurance floor) is a hard constraint, cost is minimized above it.
2. The 0/1/N agent gate defaults to the cheapest path; N-agent requires positive expected quality-gain evidence, not enthusiasm.
3. All cost/quality claims carry explicit bases and bounds (the estimation-basis contract); unattributed or unbounded claims are rejected.
4. Model/effort/agent selection is decision evidence (decision records through the existing seams); no runtime authorization path consults it (boundary proof).
5. Determinism: the same inputs (plan IR, candidates, quality facts, constraints) produce the same selection and the same decision record, including tie-breaking.
6. Fresh-escalation hooks RECORD decisions; recovery behavior is WORK-055's.
7. No model routing authority: no second router, no provider registry of authority, no ambient model state.
8. Quality floors are inviolable: below-floor candidates are inadmissible regardless of cost.

# Acceptance Criteria

1. Quality-aware model selection picks the least expensive sufficient model among declared candidates, with explicit-basis claims.
2. Reasoning-effort selection operates under the same economics and floors.
3. The 0/1/N agent gate selects zero/one/N agents per step with recorded expected-gain evidence; always-on N is impossible by construction (discrimination proof).
4. Expected-gain trade-off machinery produces bounded, typed decisions; below-threshold or below-floor selections are inadmissible.
5. Service-class selection hooks exist where declared, as hooks only.
6. Fresh-escalation decision hooks record economically-justified escalation decisions for WORK-055 to consume.
7. Determinism and idempotence of selection are proven (including tie-breaking).
8. The plane is fully covered by static, dynamic and discrimination/mutation evidence at exact revisions, with honest NOT RUN boundaries.

# Implementation Requirements

- Build ON the WORK-049/050 foundation (IR, cost model, decision records, representation-ladder hooks) — do not re-implement or fork it.
- Model selection as pure functions of (plan IR, candidate facts, quality facts, constraints); fail closed on unmet preconditions.
- Consume the compiler's representation-ladder hooks import-only (the model-economics plane is a consumer, not an engine editor).
- Record selection decisions through the existing decision-record store at the caller's seam (append-only, values only).
- Add architecture boundary tests proving the model-economics plane imports only the declared seams, creates no router/state machine, and carries no vendor vocabulary.
- Add discrimination/mutation tests: below-floor selections, always-on N-agent, unattributed claims, non-deterministic tie-breaks and authorization consults must all be rejected.
- Record exact-revision evidence; never claim unexecuted results as PASS.
- Do not modify `spec/development-state/*`; state transitions are Architect-owned after review/merge.

# Required Checkpoint Contracts

- `VERIFICATION-SEPARATION`
- `ECONOMIC-AUTHORITY-BOUNDARY`
- `DEPENDENCY-DIRECTION`
- `IDENTITY-IDEMPOTENCY`
- `EXECUTION-PROVENANCE`
- `COST-QUOTA-GUARDS`
- `IMPLEMENTATION-COMPLETENESS`

# Checkpoints

### VERIFICATION-SEPARATION

Prove the required outcome quality is a hard floor: below-floor candidates are inadmissible regardless of cost (mutation proof).

### ECONOMIC-AUTHORITY-BOUNDARY

Prove model/effort/agent selection is decision evidence only; no runtime authorization path consults it; no routing authority exists (mechanical boundary proof).

### DEPENDENCY-DIRECTION

Prove the model-economics plane depends only on the declared seams and the WORK-049/050 foundations; no module depends on it for authority.

### IDENTITY-IDEMPOTENCY

Prove re-selecting under the same facts is idempotent: identical selection, identical decision records, bounded no-op on re-run.

### EXECUTION-PROVENANCE

Prove exact provenance from candidate facts through selection to the decision record, replayable by deterministic audit.

### COST-QUOTA-GUARDS

Prove every quality/cost/latency claim is explicit-basis and bounded; unattributed or unbounded claims are rejected; expected-gain computations are total and typed.

### IMPLEMENTATION-COMPLETENESS

Prove all scope, acceptance criteria and Required Verification are implemented/tested, forbidden surfaces are untouched, and the evidence package maps each criterion to exact-revision results.

# Evidence Contract

The worker must publish at minimum:

- exact registered base SHA and final head SHA;
- complete changed-file inventory and ancestry proof;
- architecture/dependency/governance checks;
- selection results over representative candidate corpora;
- per-feature precondition and decision evidence (model, effort, agent gate, service class, escalation hooks);
- agent-gate discrimination results (always-on impossible);
- assurance-floor mutation results;
- determinism and idempotence proof results (tie-breaking included);
- real PostgreSQL evidence for any durable semantics claimed;
- discrimination/mutation evidence for every weakened invariant;
- exact CI status;
- exact external-infrastructure limitations, with anything unavailable explicitly NOT RUN rather than claimed PASS.

# Required Verification

## Static

- typecheck;
- lint;
- architecture/dependency boundary tests;
- vendor-vocabulary and secret-flow checks;
- changed-path inspection against this Work Order.

## Dynamic

- selection over real governed-plan candidate sets;
- agent-gate decisions across 0/1/N shapes;
- effort/service-class/escalation-hook round-trips;
- determinism and idempotence re-runs;
- real PostgreSQL evidence when durable semantics are claimed.

## Discrimination / mutation

- below-floor selections must be inadmissible;
- always-on N-agent must be impossible;
- unattributed or unbounded claims must be rejected;
- authorization consults must be impossible (boundary proof);
- non-deterministic tie-breaks must be detected/rejected;
- deterministic re-selection mismatches must be detected.

# Completion

WORK-053 is complete only when all acceptance criteria and required checkpoints have exact-revision evidence, the Architect accepts the PR, the Architect merges it, and post-merge program/dependency/frontier/continuation/handoff state is finalized.

Required branch: `work/WORK-053-adaptive-model-economics`

One Work Order = one implementation branch = one PR. The worker cannot approve or merge its own PR.
