# WORK-056 — Competence-aware Optimization and Progressive Deterministicization

Status: AUTHORIZED / PENDING

Owner: Implementation worker; Architect retains review, merge and state-finalization authority

Architecture Version: v1.0 (frozen); Execution Intelligence Architecture E1.0 + Economic Execution Intelligence E1.1 (ADR-0019, ADR-0020)

Assurance Profile: HIGH_ASSURANCE

# Objective

Implement the E1.1 charter member WORK-056: the competence-economics plane — competence as a selectable representation, progressive retrieval, successful-trajectory mining, deterministic replacement candidates with differential/property/replay equivalence evidence, governed shadow/canary promotion, and rollback — so repeated successful probabilistic work can become governed reusable competence or deterministic execution when evidence supports equivalence, with no self-promotion by agents, no deterministic replacement without equivalence evidence, and no learning silently changing authority.

# Dependencies

Requires: WORK-051, WORK-052, WORK-053, WORK-055

Dispatch context: dispatched as the FINAL E1.1 charter member after the entire preceding program merged (WORK-048 through WORK-055). No sibling workers are in flight. The tool-surface plane (`src/platform/tool-surface/`), context-economics plane (`src/platform/context-economics/`), model-economics plane (`src/platform/model-economics/`), substrate-economics plane (`src/platform/substrate-economics/`), and failure-recovery plane (`src/platform/failure-recovery/`) are merged foundations at your dispatch base — import/consume only, never modify them.

# Requirement IDs

No existing product requirement IDs are introduced by this Work Order; it defines the competence-representation, mining, equivalence, promotion and rollback contracts subordinate to ADR-0019/ADR-0020 and frozen v1.0.

# Declared Change Surfaces

Allowed modules/surfaces: the competence-economics plane (competence representations as selectable candidates, progressive retrieval models, successful-trajectory mining, deterministic replacement candidates, equivalence evaluation evidence, shadow/canary promotion rules, rollback); promotion integration through the existing seams (decision-record store evidence, execution-layer consumption); E1.1 competence tests/evidence; operator/developer documentation for this surface.

Forbidden to modify frozen architecture v1.0, authorization/policy/capability/budget/secret/tenant/verification semantics, the planner or plan-selection authority, the execution-compiler engine and execution-ir foundation (import/consume only), the merged sibling planes (`src/platform/tool-surface/`, `src/platform/model-economics/`, `src/platform/context-economics/`, `src/platform/substrate-economics/`, `src/platform/failure-recovery/`), or `spec/development-state/*` during active implementation.

# Scope Boundaries

Allowed:

- Competence as a selectable representation: typed, content-addressed competence records carrying the trajectory digest, applicability bounds, expected-outcome evidence and cost — selectable as decision evidence through existing seams, never self-asserting.
- Progressive retrieval: bounded, typed retrieval of competence candidates by applicability match, ranked by evidence quality and economics.
- Successful-trajectory mining: attribution of successful executions (through the merged failure-recovery/decision-record evidence) into candidate competence records — mining is observation, never authority.
- Deterministic replacement candidates: typed candidates for replacing repeated probabilistic work with deterministic execution, admitted ONLY with equivalence evidence (differential, property, and replay evaluation).
- Differential/property/replay evaluation: typed evidence suites proving behavioral equivalence within declared bounds before any replacement is promotable.
- Shadow/canary promotion: governed promotion paths (shadow evaluation alongside the probabilistic path, canary exposure under explicit policy/budget bounds) — promotion decisions are evidence through existing seams, executed by the existing authorities.
- Rollback: bounded rollback of a promotion to the prior representation when evidence degrades — data + rules, executed through existing seams.
- Tests: unit, integration over real PostgreSQL when durable semantics are claimed, discrimination/mutation, architecture boundary proofs.
- Evidence: `docs/work-items/WORK-056.md` matching the WORK-048/049/050/052/054/055 pattern.

Forbidden:

- self-promotion by agents (an agent NEVER marks its own output as competence; promotion requires independent evidence and governing policy);
- deterministic replacement without equivalence evidence (no candidate is promotable without the full differential/property/replay suite);
- learning silently changing authority (competence records are selectable EVIDENCE; authorization, policy, budgets and verification never consult them for permission);
- modifying frozen v1.0 public contracts;
- modifying the merged sibling planes;
- modifying `spec/development-state/*` during active implementation;
- self-approval or self-merge.

# Architecture Invariants

1. Competence is evidence, never authority: records carry expected-outcome and cost evidence with explicit bases; no permission semantics ride on them.
2. Promotion is gated: shadow → canary → deterministic replacement, each step bounded by policy/budget inputs and equivalence evidence; no skipping gates.
3. Equivalence is proven, not assumed: every deterministic replacement carries differential, property and replay evidence within declared bounds; unproven candidates are inadmissible.
4. Mining observes, never decides: successful trajectories become CANDIDATES through the failure-recovery/decision-record evidence; selection and promotion remain separate governed steps.
5. Determinism: the same competence corpus + applicability query + configuration produce the same retrieval ranking and promotion verdicts, including tie-breaking.
6. Rollback is bounded and typed: a degraded promotion reverts to the prior representation with recorded evidence; no silent rollback.
7. Zero-competence operation is representable and tested (the probabilistic path works with an empty corpus).
8. No new durable state machine beyond the decision-record store.

# Acceptance Criteria

1. Typed competence records (trajectory digest, applicability bounds, expected-outcome evidence, cost) that are content-addressed and explicit-basis; self-asserted or unattributed records are rejected.
2. Progressive retrieval ranks candidates by applicability match, evidence quality and economics; deterministic including tie-breaking; bounded result sets.
3. Successful-trajectory mining produces candidate records from failure-recovery/decision-record evidence — observation only, never a promotion.
4. Deterministic replacement candidates are admitted only with full differential/property/replay equivalence evidence within declared bounds; candidates lacking evidence are inadmissible.
5. Shadow/canary promotion follows the gated path with policy/budget bounds; promotion decisions are recorded evidence executed by existing authorities; agents cannot self-promote.
6. Rollback reverts a degraded promotion to the prior representation with typed evidence, bounded and recorded.
7. Zero-competence operation is proven (the probabilistic path with an empty corpus).
8. The plane is fully covered by static, dynamic and discrimination/mutation evidence at exact revisions, with honest NOT RUN boundaries.

# Implementation Requirements

- Build ON the merged foundations (execution-ir/cost model/decision records from WORK-049/050; tool-surface 051; context-economics 052; model-economics 053; substrate-economics 054; failure-recovery 055) — import/consume only.
- The plane's own logic lives in a new directory (e.g. `src/platform/competence-economics/`).
- Model retrieval and promotion verdicts as pure functions of (corpus, query, configuration); fail closed on unmet preconditions.
- Competence records and promotion evidence ride the EXISTING decision-record store pattern (no new durable store).
- Add architecture boundary tests proving competence never becomes authority, no agent self-promotion path exists, and no learning silently changes authorization/policy/budget/verification behavior.
- Add discrimination/mutation tests: self-promotion, ungated promotion (shadow→deterministic skipping canary), evidence-less replacement, silent rollback, non-deterministic rankings must all be rejected.
- Record exact-revision evidence; never claim unexecuted results as PASS.
- Do not modify `spec/development-state/*`; state transitions are Architect-owned after review/merge.

# Required Checkpoint Contracts

- `LEARNING-NONAUTHORITY`
- `PROMOTION-GATES`
- `ROLLBACK-SAFETY`
- `DEPENDENCY-DIRECTION`
- `IDENTITY-IDEMPOTENCY`
- `EXECUTION-PROVENANCE`
- `VERIFICATION-SEPARATION`
- `IMPLEMENTATION-COMPLETENESS`

# Checkpoints

### LEARNING-NONAUTHORITY

Prove competence records and learning evidence never grant capabilities, authorize work, define budgets or alter verification; agents cannot self-promote; authority surfaces are untouched by the corpus.

### PROMOTION-GATES

Prove the shadow → canary → deterministic path is the only promotion route, each gate bounded by policy/budget inputs and equivalence evidence; gate-skipping is structurally impossible.

### ROLLBACK-SAFETY

Prove rollback reverts to the prior representation with bounded, typed, recorded evidence; no partial states; no silent degradation.

### DEPENDENCY-DIRECTION

Prove the competence-economics plane depends only on the declared seams and the merged foundations; sibling planes are import-only; no authority consults competence records.

### IDENTITY-IDEMPOTENCE

Prove identical (corpus, query, configuration) produce identical rankings and promotion verdicts; record application and rollback are idempotent on re-run.

### EXECUTION-PROVENANCE

Prove exact provenance from trajectory observation through mining to competence record to promotion verdict, replayable by deterministic audit.

### VERIFICATION-SEPARATION

Prove equivalence evidence never redefines quality gates; the verification authority's contracts remain the only quality authority.

### IMPLEMENTATION-COMPLETENESS

Prove all scope, acceptance criteria and Required Verification are implemented/tested, forbidden surfaces are untouched, and the evidence package maps each criterion to exact-revision results.

# Evidence Contract

The worker must publish at minimum:

- exact registered base SHA and final head SHA;
- complete changed-file inventory and ancestry proof;
- architecture/dependency/governance checks;
- retrieval ranking results over representative corpora;
- mining round-trip evidence (trajectory → candidate record);
- equivalence-evidence suite results (differential/property/replay) over representative candidates;
- promotion gate traversal evidence (shadow → canary → deterministic) with policy/budget bounds;
- rollback round-trip evidence;
- zero-competence fail-safe evidence;
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
- competence-record closedness and secret-flow checks;
- changed-path inspection against this Work Order.

## Dynamic

- retrieval over real competence corpora;
- mining round-trips;
- differential/property/replay equivalence suites;
- promotion gate traversals with bounded exposure;
- rollback round-trips;
- determinism and idempotence re-runs;
- real PostgreSQL evidence when durable semantics are claimed.

## Discrimination / mutation

- agent self-promotion must be inadmissible;
- ungated promotion (skipping shadow or canary) must be impossible;
- replacement without full equivalence evidence must be rejected;
- silent rollback or silent authority change must be impossible;
- non-deterministic rankings/verdicts must be detected/rejected;
- authorization/policy/budget consults of competence records must be impossible (boundary proof).

# Completion

WORK-056 is complete only when all acceptance criteria and required checkpoints have exact-revision evidence, the Architect accepts the PR, the Architect merges it, and post-merge program/dependency/frontier/continuation/handoff state is finalized.

Required branch: `work/WORK-056-competence-aware-optimization`

One Work Order = one implementation branch = one PR. The worker cannot approve or merge its own PR.
