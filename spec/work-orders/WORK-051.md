# WORK-051 — Tool Surface Compiler and Programmatic Execution

Status: AUTHORIZED / PENDING

Owner: Implementation worker; Architect retains review, merge and state-finalization authority

Architecture Version: v1.0 (frozen); Execution Intelligence Architecture E1.0 + Economic Execution Intelligence E1.1 (ADR-0019, ADR-0020)

Assurance Profile: HIGH_ASSURANCE

# Objective

Implement the E1.1 charter wave member 1: the tool-surface compiler that derives the minimal useful tool surface for a governed plan (direct/deferred/CLI/script/code/MCP/competence representations) and the bounded programmatic execution path that lets mechanical fan-out/filter/aggregate work execute outside model context inside the EXISTING sandbox authority — with no new tool authority.

# Dependencies

Requires: WORK-050

Enables: WORK-056 (competence-aware optimization and progressive deterministicization consumes the tool-surface representations).

Parallel-wave context: dispatched in the wave {WORK-051, WORK-052, WORK-053} after live surface/conflict analysis. Declared write surfaces are the new tool-surface plane plus the existing sandbox/programmatic-execution boundary; WORK-052 (executions/context plane) and WORK-053 (planning/model-economics plane) are disjoint. WORK-054 (compute/substrate adapters) is deliberately deferred until a wave slot frees because its sandbox/compute boundary pins overlap this order's footprint.

# Requirement IDs

No existing product requirement IDs are introduced by this Work Order; it defines the tool-surface and programmatic-execution contracts subordinate to ADR-0019/ADR-0020 and frozen v1.0.

# Declared Change Surfaces

Allowed modules/surfaces: the tool-surface compiler plane (tool-surface derivation, representation catalog, capability-conditioned selection); bounded programmatic execution in the existing sandbox authority (no new authority, no sandbox escape); compact structured results; E1.1 tool-surface tests/evidence; operator/developer documentation for this surface.

Forbidden to modify frozen architecture v1.0, authorization/policy/capability/budget/secret/tenant/verification semantics, the planner or plan-selection authority, the execution-compiler engine (`src/platform/execution-compiler/`) beyond additive consumption, or `spec/development-state/*` during active implementation.

# Scope Boundaries

Allowed:

- Tool-surface derivation: from a governed plan's declared tool needs, derive the minimal tool surface that crosses the model boundary — closed representation set (direct call, deferred, CLI, script, code, MCP, competence) with explicit per-representation preconditions.
- Programmatic execution: bounded mechanical work (fan-out, filter, aggregate, projection) executed outside model context in the existing sandbox authority; bounded resources, bounded output, total validation.
- Compact structured results: results returned to the plan as structured, bounded, typed values.
- Capability conditioning: every derived tool/representation is checked against the existing capability/policy seams (read-only consultation).
- Tests: unit, integration over real PostgreSQL when durable semantics are claimed, discrimination/mutation, architecture boundary proofs.
- Evidence: `docs/work-items/WORK-051.md` matching the WORK-048/049/050 pattern.

Forbidden:

- universal MCP dependency (MCP is ONE representation among the closed set, never required);
- a new tool authority or tool registry as an authority (the catalog is data, decisions remain compiler/seam-owned);
- bypass of capability/policy (programmatic execution runs under the existing sandbox authority verbatim);
- autonomous capability expansion (derivation may never widen capabilities);
- modifying the execution-compiler engine or the execution-ir foundation (import/consume only);
- creating a second execution lifecycle or state machine;
- modifying frozen v1.0 public contracts;
- modifying `spec/development-state/*` during active implementation;
- self-approval or self-merge.

# Architecture Invariants

1. The tool surface is DERIVED, never negotiated: the plan's declared needs plus capability/policy facts determine it deterministically.
2. The representation set is closed and typed; invented representations are unrepresentable.
3. Programmatic execution is bounded: resource limits, output size, iteration count and wall-clock budget are explicit and fail closed.
4. Programmatic execution runs under the existing sandbox authority — no new sandbox, no escape, no widened capability.
5. Only the tools and representations required for the task cross the model boundary (minimality is proven, not claimed).
6. Results are compact, structured and typed; unbounded or untyped results are rejected.
7. Determinism: the same plan + capabilities + configuration derive the same tool surface and the same programmatic-execution decisions.
8. No new authority: no tool-routing authority, no cache authority, no execution state machine.

# Acceptance Criteria

1. A governed plan's tool needs are compiled into a minimal tool surface with an explicit representation per need, under recorded preconditions.
2. All seven representations (direct, deferred, CLI, script, code, MCP, competence) are implemented as catalog entries with explicit selection preconditions.
3. Bounded programmatic execution runs mechanical fan-out/filter/aggregate work outside model context, inside the existing sandbox authority, with total output validation.
4. Programmatic-execution bounds (resources, output size, iterations, time) are enforced and fail closed with typed errors.
5. Compact structured results round-trip into the plan's result contract.
6. Capability/policy consultation is read-only and proven (no writes, no widening).
7. Determinism and minimality are proven (identical inputs → identical surface; a superset surface is rejected by discrimination).
8. The plane is fully covered by static, dynamic and discrimination/mutation evidence at exact revisions, with honest NOT RUN boundaries.

# Implementation Requirements

- Build ON the WORK-049/050 foundation (IR, constraints, compiler hooks) — do not re-implement or fork it.
- Model the derivation as pure functions of (plan IR, capability facts, configuration); record preconditions; fail closed when unmet.
- Consume the execution-compiler's hooks import-only (the tool-surface plane is a consumer, not an engine editor).
- Keep the sandbox invocation path at the EXISTING sandbox authority seams; reconcile architecture pins additively.
- Add architecture boundary tests proving the tool-surface plane imports only the declared seams, creates no state machine, and carries no vendor vocabulary.
- Add discrimination/mutation tests: invented representations, capability-widening derivations, unbounded programmatic work, untyped results and non-minimal surfaces must all be rejected.
- Record exact-revision evidence; never claim unexecuted results as PASS.
- Do not modify `spec/development-state/*`; state transitions are Architect-owned after review/merge.

# Required Checkpoint Contracts

- `POLICY-BEFORE-DISPATCH`
- `DEPENDENCY-DIRECTION`
- `IDENTITY-IDEMPOTENCY`
- `EXECUTION-PROVENANCE`
- `SANDBOX-BOUNDARY`
- `CONCURRENCY-CRASH-SAFETY`
- `IMPLEMENTATION-COMPLETENESS`

# Checkpoints

### POLICY-BEFORE-DISPATCH

Prove tool-surface derivation consults capability/policy seams read-only and can never widen, grant or bypass a capability.

### DEPENDENCY-DIRECTION

Prove the tool-surface plane depends only on the declared seams and the WORK-049/050 foundations; no module depends on it for authority.

### IDENTITY-IDEMPOTENCY

Prove re-deriving the same plan under the same capability facts and configuration is idempotent: identical surface, identical decisions, bounded no-op on re-run.

### EXECUTION-PROVENANCE

Prove exact provenance from plan tool-needs through derivation to the emitted surface and any programmatic-execution result, replayable by deterministic audit.

### SANDBOX-BOUNDARY

Prove programmatic execution runs inside the existing sandbox authority with explicit bounds; no second sandbox, no escape path, no capability widening (boundary proof against the sandbox plane's existing pins).

### CONCURRENCY-CRASH-SAFETY

Prove concurrent derivations/programmatic executions converge with no torn or duplicated durable effects (real PostgreSQL evidence when durable semantics are claimed).

### IMPLEMENTATION-COMPLETENESS

Prove all scope, acceptance criteria and Required Verification are implemented/tested, forbidden surfaces are untouched, and the evidence package maps each criterion to exact-revision results.

# Evidence Contract

The worker must publish at minimum:

- exact registered base SHA and final head SHA;
- complete changed-file inventory and ancestry proof;
- architecture/dependency/governance checks;
- derivation results over representative plan corpora;
- per-representation precondition and selection evidence;
- programmatic-execution bound-enforcement evidence (fail-closed violations);
- minimality and determinism proof results;
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

- derivation of real governed-plan tool surfaces through the full path;
- per-representation dynamic evidence over representative plan shapes;
- programmatic-execution runs (fan-out/filter/aggregate) inside the sandbox authority with bound enforcement;
- determinism and idempotence re-runs;
- real PostgreSQL evidence when durable semantics are claimed.

## Discrimination / mutation

- invented representations must be rejected;
- capability-widening or policy-bypassing derivations must be rejected;
- unbounded programmatic work must fail closed;
- untyped or oversized results must be rejected;
- non-minimal surfaces must be rejected;
- deterministic re-derivation mismatches must be detected.

# Completion

WORK-051 is complete only when all acceptance criteria and required checkpoints have exact-revision evidence, the Architect accepts the PR, the Architect merges it, and post-merge program/dependency/frontier/continuation/handoff state is finalized.

Required branch: `work/WORK-051-tool-surface-compiler-programmatic-execution`

One Work Order = one implementation branch = one PR. The worker cannot approve or merge its own PR.
