# WORK-055 — Failure-aware Recovery, Fresh Escalation and Continuation

Status: AUTHORIZED / PENDING

Owner: Implementation worker; Architect retains review, merge and state-finalization authority

Architecture Version: v1.0 (frozen); Execution Intelligence Architecture E1.0 + Economic Execution Intelligence E1.1 (ADR-0019, ADR-0020)

Assurance Profile: HIGH_ASSURANCE

# Objective

Implement the E1.1 charter member WORK-055: the failure-recovery plane — unified failure attribution (infrastructure/provider/tool/resource versus intelligence failure), economically appropriate retry/re-route rules, fresh escalation, continuation packages for long-running work, and environment fingerprinting — so failures produce economically appropriate recovery strategies and long-running work can resume without unnecessary reconstruction, with no retry loops driven only by generic failure and no continuation as a second execution state machine.

# Dependencies

Requires: WORK-053, WORK-054

Enables: WORK-056 (competence-aware optimization needs failure attribution and recovery evidence to mine successful trajectories and justify deterministic replacement).

Dispatch context: dispatched after the full third wave merged (WORK-051 PR #24, WORK-052 PR #22, WORK-053 PR #26, WORK-054 PR #27). No sibling workers are in flight. The model-economics plane (`src/platform/model-economics/`) and the substrate-economics plane (`src/platform/substrate-economics/`) are merged foundations at your dispatch base — import/consume only, never modify them.

# Requirement IDs

No existing product requirement IDs are introduced by this Work Order; it defines the failure-attribution, recovery, escalation and continuation contracts subordinate to ADR-0019/ADR-0020 and frozen v1.0.

# Declared Change Surfaces

Allowed modules/surfaces: the failure-recovery plane (failure classification/attribution models, recovery strategy selection, escalation rules, continuation package construction, environment fingerprinting); recovery integration through the existing seams (execution layer hooks, decision-record store evidence); E1.1 failure-recovery tests/evidence; operator/developer documentation for this surface.

Forbidden to modify frozen architecture v1.0, authorization/policy/capability/budget/secret/tenant/verification semantics, the planner or plan-selection authority, the execution-compiler engine and execution-ir foundation (import/consume only), the merged sibling planes (`src/platform/tool-surface/`, `src/platform/model-economics/`, `src/platform/context-economics/`, `src/platform/substrate-economics/`), or `spec/development-state/*` during active implementation.

# Scope Boundaries

Allowed:

- Unified failure attribution: typed failure taxonomies (infrastructure, provider, tool, resource, intelligence) with explicit evidence, attribution as decision input — never a redefinition of quality gates.
- Recovery strategy selection: retry, re-route (model/substrate/tool re-selection through the existing economics planes), fresh escalation, or fail — selected as economically appropriate evidence through existing seams.
- Fresh escalation: bounded, typed escalation packages carrying the attributed failure, accumulated evidence and the continuation payload.
- Continuation package: a typed, fingerprint-verified resume payload for long-running work — content-addressed, idempotent to apply, with environment fingerprinting to detect drift between the original and resumed environments.
- Environment fingerprinting: typed identity of the execution environment (tools, models, substrates, configuration hashes) used to validate continuation applicability.
- Tests: unit, integration over real PostgreSQL when durable semantics are claimed, discrimination/mutation, architecture boundary proofs.
- Evidence: `docs/work-items/WORK-055.md` matching the WORK-048/049/050/052/054 pattern.

Forbidden:

- retry loops driven only by generic failure (every retry must carry attributed cause and economic justification);
- attributing infrastructure failure to model quality (attribution is typed and evidence-bound; cross-classification must be rejected);
- continuation as a second execution state machine (the continuation package is data consumed by the EXISTING execution layer; no new durable state machine beyond the decision-record store);
- recovery that bypasses authorization, policy, capability, budget or verification authorities (recovery decisions are evidence through the existing seams);
- modifying frozen v1.0 public contracts;
- modifying the merged sibling planes;
- modifying `spec/development-state/*` during active implementation;
- self-approval or self-merge.

# Architecture Invariants

1. Attribution before action: no recovery action without a typed, evidence-bound failure attribution.
2. Recovery economics are evidence, not authority: retry/re-route/escalation decisions carry costs and expected outcomes as explicit-basis values; budgets and policy remain the authorities.
3. The continuation package is data, never an engine: applying it twice is a bounded no-op; it never introduces a second durable state machine.
4. Environment fingerprints are honest: drift detection is fail-closed — a changed environment invalidates a continuation rather than silently applying it.
5. Determinism: the same attributed failure + recovery context + configuration produce the same recovery strategy, including tie-breaking.
6. Failure classes are closed and typed; unattributed or cross-classified failures are rejected.
7. Zero-recovery operation is representable and tested (fail-closed when no recovery strategy is economically justified).
8. No new durable state machine beyond the decision-record store.

# Acceptance Criteria

1. Typed failure taxonomy (infrastructure/provider/tool/resource/intelligence) with closed classes and explicit-evidence attribution; unattributed or cross-classified failures are rejected.
2. Recovery strategy selection (retry/re-route/escalation/fail) as economically appropriate pure decision over (attribution, context, economics planes' facts, configuration), deterministic including tie-breaking, idempotent on re-run.
3. Fresh escalation packages are bounded, typed, and carry the attributed failure + accumulated evidence + continuation payload.
4. Continuation packages are content-addressed, idempotent to apply, and validated by environment fingerprinting (drift is fail-closed).
5. Re-route consumes the merged model-economics and substrate-economics planes read-only as decision inputs (import/consume only).
6. Long-running work can resume without unnecessary reconstruction: a representative continuation round-trip is proven.
7. Zero-recovery operation (fail-closed with no economically justified strategy) is representable and tested.
8. The plane is fully covered by static, dynamic and discrimination/mutation evidence at exact revisions, with honest NOT RUN boundaries.

# Implementation Requirements

- Build ON the WORK-049/050 foundation (IR, cost model, decision records) and the merged WORK-053/054 planes (model-economics, substrate-economics) — import/consume only.
- Model recovery selection as pure functions of (attribution, context, facts, configuration); fail closed on unmet preconditions.
- The plane's own logic lives in a new directory (e.g. `src/platform/failure-recovery/`).
- Continuation packages and fingerprints are typed data through existing seams; the execution layer consumes them.
- Record attribution and recovery decisions in the existing decision-record evidence pattern (no new durable store).
- Add architecture boundary tests proving recovery never bypasses authorities, attribution is typed, and no vendor/provider vocabulary crosses seams.
- Add discrimination/mutation tests: generic-failure retries, cross-classified attribution, silent drift application, second-state-machine continuation, non-deterministic tie-breaks must all be rejected.
- Record exact-revision evidence; never claim unexecuted results as PASS.
- Do not modify `spec/development-state/*`; state transitions are Architect-owned after review/merge.

# Required Checkpoint Contracts

- `EXTERNAL-SIDE-EFFECTS`
- `ECONOMIC-AUTHORITY-BOUNDARY`
- `DEPENDENCY-DIRECTION`
- `IDENTITY-IDEMPOTENCY`
- `CONCURRENCY-CRASH-SAFETY`
- `EXECUTION-PROVENANCE`
- `VERIFICATION-SEPARATION`
- `IMPLEMENTATION-COMPLETENESS`

# Checkpoints

### EXTERNAL-SIDE-EFFECTS

Prove recovery actions' side effects stay behind the existing execution seams; the plane's own decisions have no external side effects; live provider recovery APIs are NOT RUN and disclosed exactly.

### ECONOMIC-AUTHORITY-BOUNDARY

Prove recovery economics stay bounded evidence with explicit bases; budgets/policy/capabilities remain the authorities; no retry loop without economic justification.

### DEPENDENCY-DIRECTION

Prove the failure-recovery plane depends only on the declared seams and the WORK-049/050/053/054 foundations; sibling planes are import-only; no authority consults recovery decisions.

### IDENTITY-IDEMPOTENCE

Prove re-selecting under the same attribution is idempotent: identical strategy, identical decision records, bounded no-op on re-run; continuation application is idempotent.

### CONCURRENCY-CRASH-SAFETY

Prove recovery paths behave correctly under concurrent failure and crash-resume: no double-apply, no lost attribution, bounded re-execution.

### EXECUTION-PROVENANCE

Prove exact provenance from failure observation through attribution to recovery decision record, replayable by deterministic audit.

### VERIFICATION-SEPARATION

Prove failure attribution never redefines quality gates; verification authority contracts are the only quality authority.

### IMPLEMENTATION-COMPLETENESS

Prove all scope, acceptance criteria and Required Verification are implemented/tested, forbidden surfaces are untouched, and the evidence package maps each criterion to exact-revision results.

# Evidence Contract

The worker must publish at minimum:

- exact registered base SHA and final head SHA;
- complete changed-file inventory and ancestry proof;
- architecture/dependency/governance checks;
- recovery-strategy results over representative failure corpora;
- attribution accuracy evidence per failure class;
- continuation round-trip evidence (construct → fingerprint → drift-reject → resume);
- zero-recovery fail-closed evidence;
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
- failure-taxonomy closedness and secret-flow checks;
- changed-path inspection against this Work Order.

## Dynamic

- recovery selection over real attributed-failure corpora;
- continuation round-trips (construct, validate, drift-reject, resume);
- escalation package construction and bounding;
- determinism and idempotence re-runs;
- real PostgreSQL evidence when durable semantics are claimed.

## Discrimination / mutation

- generic-failure retry loops must be inadmissible (no attribution → no retry);
- cross-classified attribution must be rejected (infrastructure failure blamed on model quality is inadmissible);
- silent drift application must be rejected (fingerprint mismatch → fail-closed);
- continuation as a second state machine must be impossible (no new durable store);
- non-deterministic tie-breaks must be detected/rejected;
- recovery bypassing authorization/budget/policy must be impossible (boundary proof).

# Completion

WORK-055 is complete only when all acceptance criteria and required checkpoints have exact-revision evidence, the Architect accepts the PR, the Architect merges it, and post-merge program/dependency/frontier/continuation/handoff state is finalized.

Required branch: `work/WORK-055-failure-aware-recovery-continuation`

One Work Order = one implementation branch = one PR. The worker cannot approve or merge its own PR.
