# WORK-021 — Deterministicization discovery and progressive AI-call elimination

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: CRITICAL

# Objective

Learn to identify AI execution subgraphs that can be replaced, simplified or supplemented by deterministic computation, then validate and progressively promote those replacements without weakening execution authority.

# Context

This Work Order implements the runtime deterministicization lifecycle defined by `spec/deterministicization-contract.md` and ADR-0008.

# Dependencies

Requires: WORK-013, WORK-014, WORK-017, WORK-018

# Requirement IDs

Primary requirements owned by this Work Order:
- `DTR-001`
- `DTR-002`
- `DTR-003`
- `DTR-004`

# Declared Change Surfaces

- `src/modules/learning/`
- `src/modules/planning/`
- `src/modules/tools/`
- `src/modules/sandbox/`

# Scope Boundaries

Allowed:
- declared modules and directly-required tests
- deterministicization contract/evidence artifacts

Forbidden:
- bypassing policy, budget, verification or sandbox authority
- directly mutating customer production code without an explicit authorized workflow
- promoting synthesized programs without validation
- introducing a second execution/state authority
- merging the worker's own PR

# Architecture Invariants

- Deterministic-first planning is mandatory.
- Execution remains the primary abstraction.
- Synthesized computation is untrusted until validated.
- Learning cannot weaken authority boundaries.
- Production replacement is reversible.

# Acceptance Criteria

1. Detect recurring execution subgraphs containing AI work that are strong candidates for deterministicization.
2. Generate or propose deterministic/hybrid replacement candidates with explicit contracts.
3. Validate candidates using replay, differential evaluation, property/metamorphic testing and mutation evidence.
4. Support shadow/canary rollout with rollback and measurable cost/quality deltas.
5. Record why a candidate was promoted, rejected or deferred.
6. Prove a mutant that silently replaces uncertain AI work without validation cannot pass the promotion gate.

# Implementation Requirements

- Candidate identity must include provenance to source executions and evaluation corpus.
- Deterministic replacements must execute in an appropriate sandbox.
- Promotion must require configurable statistical/evaluation thresholds.
- Unknown or insufficient evidence must fail closed to non-promotion.

# Required Checkpoint Contracts

- `IMPLEMENTATION-COMPLETENESS`
- `CONCURRENCY-CRASH-SAFETY`
- `SELF-HOSTING-BOUNDARY`
- `EXECUTION-PROVENANCE`

# Required Verification

- governance checker
- typecheck
- lint
- deterministicization unit/integration tests
- historical replay/differential tests
- mutation/discrimination tests
- real sandbox proof for synthesized computation

# Completion

Worker opens a PR but does not merge. Completion requires architect acceptance and post-merge finalization.
