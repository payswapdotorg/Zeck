# WORK-054 — Economic Substrate Selection and Runtime Adapters

Status: AUTHORIZED / PENDING

Owner: Implementation worker; Architect retains review, merge and state-finalization authority

Architecture Version: v1.0 (frozen); Execution Intelligence Architecture E1.0 + Economic Execution Intelligence E1.1 (ADR-0019, ADR-0020)

Assurance Profile: HIGH_ASSURANCE

# Objective

Implement the E1.1 charter wave member 4: the substrate-economics plane — neutral substrate facts and selection, readiness/startup lifecycle measurement, warm/snapshot-aware execution, and provider adapters for E2B, Daytona and Modal plus customer/self-hosted adapters where already supported — so Zeck can compare compute substrates by expected quality, readiness, latency, reliability and cost, then choose the least expensive sufficient substrate, with no provider control-plane authority in domain modules.

# Dependencies

Requires: WORK-050

Enables: WORK-055 (failure-aware recovery needs substrate attribution and re-route facts).

Parallel-wave context: dispatched into the wave slot freed by WORK-052's merge (PR #22). Live surface analysis at dispatch: WORK-051 builds in its own new tool-surface plane and WORK-053 in its own new model-economics plane; this order's compute-plane/substrate and provider-SDK-allowlist footprints are disjoint from both. Do not edit files in `src/platform/tool-surface/` or `src/platform/model-economics/` (sibling planes, in flight).

# Requirement IDs

No existing product requirement IDs are introduced by this Work Order; it defines the substrate-economics and runtime-adapter contracts subordinate to ADR-0019/ADR-0020 and frozen v1.0.

# Declared Change Surfaces

Allowed modules/surfaces: the substrate-economics plane (neutral substrate facts, selection logic, readiness/lifecycle measurement models, warm/snapshot-aware execution decision inputs); runtime provider adapters (E2B, Daytona, Modal; customer/self-hosted where already supported) as neutral mechanisms; the provider-SDK boundary allowlist reconciliation for the adapters' SDKs; E1.1 substrate tests/evidence; operator/developer documentation for this surface.

Forbidden to modify frozen architecture v1.0, authorization/policy/capability/budget/secret/tenant/verification semantics, the planner or plan-selection authority, the execution-compiler engine and execution-ir foundation (import/consume only), the sibling planes in flight (`src/platform/tool-surface/`, `src/platform/model-economics/`), or `spec/development-state/*` during active implementation.

# Scope Boundaries

Allowed:

- Neutral substrate facts: declared substrate descriptors (expected quality, readiness, latency, reliability, cost; warm/cold/snapshot states) as explicit-basis values — never provider-marketing truth.
- Substrate selection: the least-expense-sufficient-sufficient selection consistent with required outcome quality, as decision evidence through the existing seams.
- Readiness/startup lifecycle measurement: models of substrate startup, readiness probes and warm-pool/snapshot states — measurement contracts and their decision inputs.
- Warm/snapshot-aware execution: decision inputs that let the compiler/execution layer prefer warm or snapshot-state substrates when economics justify it.
- Provider adapters: E2B, Daytona and Modal adapters implementing the existing compute/sandbox seams; customer/self-hosted adapters where the repository already supports them. Adapters are MECHANISMS: they translate the neutral contracts to provider APIs.
- Provider-SDK allowlist reconciliation: adding the adapter SDKs to the provider-sdk boundary table (the only shared test file this order may touch).
- Tests: unit, integration over real PostgreSQL when durable semantics are claimed, discrimination/mutation, architecture boundary proofs.
- Evidence: `docs/work-items/WORK-054.md` matching the WORK-048/049/050/052 pattern.

Forbidden:

- provider control-plane authority in domain modules (provider specifics live behind adapter seams; domain logic sees neutral facts only);
- hard-coded provider semantics (no `if provider === "e2b"` in domain code; the closed descriptor set carries the semantics);
- mandatory provider adoption (every provider is optional; the neutral path works with zero providers);
- provider credentials as a source of authority (live provider APIs are NOT RUN boundaries in this environment; adapters are exercised against contract doubles with honest disclosure);
- modifying frozen v1.0 public contracts;
- modifying the sibling planes in flight;
- modifying `spec/development-state/*` during active implementation;
- self-approval or self-merge.

# Architecture Invariants

1. Provider specifics never leak past adapter seams: domain/plane code consumes only neutral substrate facts.
2. Adapters are mechanisms, never authorities: no adapter grants capabilities, authorizes work, or defines budgets.
3. Selection is the least expensive SUFFICIENT substrate: required quality is a hard floor; economics minimize above it.
4. Every substrate fact carries an explicit basis and bounds; unattributed or unbounded claims are rejected.
5. Determinism: the same substrate facts + constraints + configuration produce the same selection and decision record, including tie-breaking.
6. Warm/snapshot-awareness is decision INPUT, not hidden state: the execution layer decides; adapters report.
7. Zero-provider operation is representable and tested (the neutral path works with no adapters registered).
8. No new durable state machine beyond the decision-record store.

# Acceptance Criteria

1. Neutral substrate descriptors are closed, typed and explicit-basis; invented or unattributed descriptors are rejected.
2. Substrate selection picks the least expensive sufficient substrate among declared candidates, with recorded evidence.
3. Readiness/startup lifecycle measurement models exist with warm/cold/snapshot states and bounded, typed computations.
4. Warm/snapshot-aware decision inputs are consumed through the existing seams (read-only).
5. E2B, Daytona and Modal adapters implement the declared compute/sandbox seams as neutral mechanisms; customer/self-hosted adapters where already supported.
6. The provider-SDK allowlist is reconciled additively for the adapters' SDKs; no other shared file is edited.
7. Zero-provider operation is proven (neutral path with no adapters).
8. The plane is fully covered by static, dynamic and discrimination/mutation evidence at exact revisions, with honest NOT RUN boundaries (live provider APIs are NOT RUN in this environment).

# Implementation Requirements

- Build ON the WORK-049/050 foundation (IR, cost model, decision records, compiler hooks) — import/consume only.
- Model selection as pure functions of (substrate facts, constraints, configuration); fail closed on unmet preconditions.
- Place adapters behind the existing compute/sandbox seams; the plane's own logic lives in a new directory (e.g. `src/platform/substrate-economics/`).
- Exercise adapters against contract doubles (typed fake provider surfaces); mark live provider APIs NOT RUN with exact disclosure.
- Add architecture boundary tests proving provider specifics stay behind seams, domain code carries no vendor vocabulary, and no adapter is an authority.
- Add discrimination/mutation tests: vendor-vocabulary leakage, below-floor selections, unattributed facts, mandatory-adoption paths and non-deterministic tie-breaks must all be rejected.
- Record exact-revision evidence; never claim unexecuted results as PASS.
- Do not modify `spec/development-state/*`; state transitions are Architect-owned after review/merge.

# Required Checkpoint Contracts

- `EXTERNAL-SIDE-EFFECTS`
- `ECONOMIC-AUTHORITY-BOUNDARY`
- `DEPENDENCY-DIRECTION`
- `IDENTITY-IDEMPOTENCY`
- `EXECUTION-PROVENANCE`
- `VERIFICATION-SEPARATION`
- `IMPLEMENTATION-COMPLETENESS`

# Checkpoints

### EXTERNAL-SIDE-EFFECTS

Prove adapters isolate provider side effects behind seams; the plane's decisions have no external side effects; live provider calls are NOT RUN and disclosed exactly.

### ECONOMIC-AUTHORITY-BOUNDARY

Prove substrate decisions and cost claims stay bounded evidence with explicit bases; budgets/policy/capabilities remain the authorities; no runtime authorization consults them.

### DEPENDENCY-DIRECTION

Prove the substrate-economics plane depends only on the declared seams and the WORK-049/050 foundations; domain modules never depend on adapters for authority; vendor vocabulary never crosses the seam.

### IDENTITY-IDEMPOTENCY

Prove re-selecting under the same facts is idempotent: identical selection, identical decision records, bounded no-op on re-run.

### EXECUTION-PROVENANCE

Prove exact provenance from substrate facts through selection to the decision record, replayable by deterministic audit.

### VERIFICATION-SEPARATION

Prove quality floors come from the verification authority's contracts; this plane never redefines quality gates.

### IMPLEMENTATION-COMPLETENESS

Prove all scope, acceptance criteria and Required Verification are implemented/tested, forbidden surfaces are untouched, and the evidence package maps each criterion to exact-revision results.

# Evidence Contract

The worker must publish at minimum:

- exact registered base SHA and final head SHA;
- complete changed-file inventory and ancestry proof;
- architecture/dependency/governance checks;
- selection results over representative substrate-fact corpora;
- per-adapter contract-double evidence and the exact NOT RUN disclosure for live provider APIs;
- warm/snapshot lifecycle measurement evidence;
- zero-provider operation evidence;
- determinism and idempotence proof results;
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

- selection over real substrate-fact candidate sets;
- adapter contract-double round-trips (E2B, Daytona, Modal, self-host where supported);
- warm/snapshot lifecycle computations;
- determinism and idempotence re-runs;
- real PostgreSQL evidence when durable semantics are claimed.

## Discrimination / mutation

- vendor-vocabulary leakage past seams must be rejected;
- below-floor selections must be inadmissible;
- unattributed or unbounded facts must be rejected;
- mandatory-adoption paths must be impossible (zero-provider proof);
- non-deterministic tie-breaks must be detected/rejected;
- authorization consults of substrate decisions must be impossible (boundary proof).

# Completion

WORK-054 is complete only when all acceptance criteria and required checkpoints have exact-revision evidence, the Architect accepts the PR, the Architect merges it, and post-merge program/dependency/frontier/continuation/handoff state is finalized.

Required branch: `work/WORK-054-substrate-economics-runtime-adapters`

One Work Order = one implementation branch = one PR. The worker cannot approve or merge its own PR.
