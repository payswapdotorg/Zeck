# WORK-022 — Codebase AI opportunity analysis and selective human evaluation

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Provide a developer-facing analysis capability that can inspect selected codebase functions, traces or execution subgraphs and recommend where AI should be added, removed, replaced with deterministic computation, or restructured as a hybrid plan. Provide selective human rating when automated evaluation is uncertain.

# Context

This Work Order turns Zeck's execution learning into an advisory product for existing customer codebases. The capability is read-only by default and does not mutate customer code.

# Dependencies

Requires: WORK-014, WORK-016, WORK-018

# Requirement IDs

Primary requirements owned by this Work Order:
- `DTR-005`
- `HUM-001`
- `HUM-002`
- `HUM-003`

# Declared Change Surfaces

- `src/modules/learning/`
- `src/modules/planning/`
- `src/modules/context/`
- `src/modules/verification/`
- `src/modules/api/`

# Scope Boundaries

Allowed:
- selected customer repositories/functions/traces explicitly supplied to the analysis
- advisory reports and evidence artifacts
- rating workflows needed to resolve uncertainty

Forbidden:
- unrequested code mutation
- execution outside authorized sandbox/network scope
- treating user ratings as authorization to bypass policy/security
- creating duplicate workflow authority
- merging the worker's own PR

# Architecture Invariants

- Analysis is an Execution.
- Policy and tenant scope are evaluated before codebase access.
- Findings are evidence-backed and confidence-qualified.
- Read-only advisory behavior is the default.
- Human ratings are selective evidence, not policy authority.

# Acceptance Criteria

1. Analyze a customer-selected codebase subgraph and produce an execution graph representation with AI/model calls, deterministic code, data access and external effects identified.
2. Recommend candidate subgraphs for AI addition, AI removal, deterministic replacement, hybrid decomposition or improved context/tooling.
3. Provide evidence, expected cost/latency impact, confidence and reason codes for each recommendation.
4. Support user ratings/comparisons for uncertain findings and record them as explicit evaluation evidence.
5. Prove cross-tenant access and unapproved code mutation are denied before side effects.
6. Prove a low-confidence recommendation cannot be automatically promoted as a production replacement.

# Implementation Requirements

- Code analysis must preserve source/function provenance.
- Recommendations must distinguish observation from verified equivalence.
- Human rating prompts must be minimal and only emitted when information value exceeds the configured user-friction threshold.
- Ratings must be attributable to the analyzed execution and candidate pair.

# Required Checkpoint Contracts

- `IMPLEMENTATION-COMPLETENESS`
- `SELF-HOSTING-BOUNDARY`
- `EXECUTION-PROVENANCE`

# Checkpoints

Required assurance profile: **HIGH_ASSURANCE**.

The applicable blocking contracts are enumerated in `spec/governance/checkpoint-contract.json`. Checkpoint results are evidence, not completion authority.

# Evidence Contract

The worker must update `docs/work-items/WORK-NNN.md` with exact revision, changed files, requirement IDs, test commands/results, checkpoint evidence, discrimination evidence where required, known limitations and PR binding. Claims without objective evidence do not satisfy completion.

# Required Verification

- governance checker
- typecheck
- lint
- codebase-analysis integration tests
- tenant/security discrimination tests
- human-rating uncertainty tests
- provenance tests
- mutation/discrimination tests for unsafe promotion

# Completion

Worker opens a PR but does not merge. Completion requires architect acceptance and post-merge finalization.
