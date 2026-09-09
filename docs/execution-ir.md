# Execution IR — operator and developer guide (WORK-049 / E1.1 foundation)

The Execution IR (`src/platform/execution-ir/`) is the machine-readable, optimizable
**representation** of a governed execution plan, together with the optimization-constraint,
outcome-economics and decision-evidence contracts of ADR-0019 §3 and ADR-0020. It is the
stage-1 foundation of the E1.1 program: **representation and evidence only**. There is no
optimizer engine here (WORK-050), no runtime optimization, no new authority and no state
machine.

## What it is — and what it is not

| It IS | It is NOT |
|---|---|
| A lossless, content-addressed view of a governed plan | A second plan authority |
| Deterministic, total validation (typed, bounded errors) | A planner or execution lifecycle |
| Hard/soft constraint representation + hard enforcement at validation time | A policy/capability/budget authority |
| A bounded, attributed expected-cost model over candidate representations | A provider registry or pricing source |
| Append-only optimization decision records (evidence) | An authorization surface — no execution path consults them |
| A deterministic provenance audit (plan → IR → decision) | A reconciliation or repair tool |

The plan stays the planner's authority; the executions ledger stays the durable
plan-decision authority; budgets stay the budget authority. PostgreSQL is the sole durable
authority for the decision evidence itself.

## The pipeline

```
governed plan (planning)
      │  PlanDerivationSeam (module-side adapter, pure)
      ▼
GovernedPlanSnapshot ──deriveExecutionIr(snapshot, digest)──▶ ExecutionIr
      │                                                         │
      │   constraints (policy · capability · budget ·           │  candidates + cost claims
      │   quality · latency · verification · side-effect)       │  (observed/estimated/defaulted)
      ▼                                                         ▼
enforceHardConstraints(ir, candidates, constraints) ──▶ selectCandidate(candidates, qualityThreshold)
      │                                                         │
      └───────────────▶ buildOptimizationDecision({...}) ──▶ OptimizationDecisionRecord
                                        │
                     SqlOptimizationDecisionStore.append() (idempotent, append-only)
                                        │
                     auditDurableExecutionProvenance(store, snapshot) (replayable proof)
```

## Identity model (content-addressed, idempotent)

All identities are sha256 digests over **canonical JSON** (sorted keys, closed universe,
no whitespace, non-finite numbers rejected — `canonical.ts`):

- `planId` — the planning authority's own content digest of the governed plan;
- `irId` — digest of the IR's canonical form. Same snapshot ⇒ same `irId`, always;
- `decisionId` — digest of the decision's content (excludes `recordedAt`/`recordDigest`);
- `recordDigest` — digest of the full record including `recordedAt`.

**The anti-second-authority proof:** `deriveExecutionIr` verifies the snapshot content
digests to the claimed `planId` before deriving anything. A snapshot claiming an identity
its content does not have is rejected (`plan-identity-mismatch`). **Losslessness:**
`planFormOfIr(ir)` reconstructs the canonical plan form; its digest MUST equal `planId`
(`ir-identity-mismatch` otherwise). An IR that drifted from the governed plan is
therefore unrepresentable, not merely detectable later.

## Validation

`validateExecutionIr(value, digest)` is deterministic and total: every rejection is an
`IrValidationError` with a code from the closed `IR_INVARIANT_CODES` vocabulary
(`snapshot-shape`, `step-vocabulary`, `step-identity`, `edge-structure`,
`plan-identity-mismatch`, `route-binding`, `strategy-consistency`, `ir-shape`,
`ir-identity-mismatch`, `provenance-missing`, `provenance-vocabulary`,
`canonical-universe`).

Derived step facts come from frozen tables over the architecture step classes
(`PLAN_STEP_CLASSES`, `STRATEGY_CLASSES`, `GENERATIVE_STEP_CLASSES`,
`SIDE_EFFECT_CLASSES`): `computationType` (deterministic / probabilistic / human) and
`sideEffectClass`. Model/provider route references are legal only on generative steps and
stay provider-neutral opaque strings — no vendor vocabulary exists in the plane
(boundary-proven).

## Constraints (`constraints.ts`)

Seven kinds, five sourcing authorities:

| kind | payload (mirrors the owning authority's own fields) | source authority |
|---|---|---|
| `policy` | route allow/deny, tool allowlist, egress, secret access, autonomy, isolation | policy |
| `capability` | required capabilities satisfied | capability |
| `budget` | `maxCostMicroUsd` ceiling | budget |
| `quality` | quality floor | policy/planning |
| `latency` | latency ceiling | policy |
| `verification` | requires a verification anchor | verification |
| `side-effect` | egress/secret/autonomy/isolation dimensions | policy |

**Hard by construction:** an authority-sourced restriction (`source.authority` of
policy/capability/budget/verification) can never carry `enforcement: "soft"` — the shape
is unrepresentable and validation rejects it. Soft constraints (e.g. advisory planning
preferences) are **recorded, never enforced** — `enforceHardConstraints` ignores them by
construction, and the discrimination suite proves a soft constraint cannot silently
become an enforced one.

`enforceHardConstraints(ir, candidates, constraints)` returns typed
`ConstraintViolation[]` (closed 8-code vocabulary) for: policy route violations, tool
violations, budget ceiling exceedance, quality floor violations, latency ceiling
violations, unsatisfied capabilities, missing verification anchors, and side-effect
(egress) violations. Route evaluation mirrors the planner's own `routeAllowedByPolicy`
semantics; the verification anchor requirement mirrors the frozen completion binding.

## Cost model (`cost-model.ts`)

A `CostClaim` is bounded and attributed or it does not exist:

- cost/latency/quality/reliability expectations with an explicit `basis`:
  `observed` | `estimated` | `defaulted` + a provenance source string;
- rejected: unattributed claims, unbounded claims (above `MAX_IR_COST_MICRO_USD` /
  latency bounds), zero-reliability claims (infinite successful-resolution cost).

**Expected successful-resolution cost** (ADR-0020): `ceil(cost / reliability)` over
BigInt — the amortized cost of getting ONE successful resolution. Selection:

1. a candidate whose expected quality is below the threshold is **invalid** regardless of
   price (quality-preserving economics — the cheaper-but-insufficient candidate can never
   win);
2. among valid candidates, lowest expected successful-resolution cost wins;
3. ties break on the neutral representation ladder (`REPRESENTATION_CLASSES`, 9 classes,
   cache-reuse first), then `candidateId` — fully deterministic, auditable ordering.

The selection carries its `selectionBasis` (e.g.
`lowest-expected-successful-resolution-cost; qualityThreshold=…`) as evidence.

## Decision records (`decision-record.ts`, `decision-store.ts`)

`buildOptimizationDecision` validates everything fail-closed before a record exists:
non-empty governing constraints, every candidate a validated claim, the selection
coherent, and the selected representation compliant with all hard constraints. The
record is the ADR-0020 evidence contract: input constraints, candidate representations,
selected representation, cost/latency expectations, quality expectation, transformation
basis (`identity` | `representation-substitution` — closed vocabulary) and provenance.

`SqlOptimizationDecisionStore` (over the standard `DatabasePort`, migration
`0030_execution_ir_decision_records`, schema `execution_ir`):

- **append-only** — a database trigger physically rejects UPDATE/DELETE;
- **idempotent** — appending the same `decisionId` with the same `recordDigest` is a
  bounded no-op (`appended: false`, replayed);
- **conflict-typed** — the same `decisionId` with different content is a
  `DecisionIdentityConflictError`;
- **tenant-scoped** — composite FKs to applications and executions; cross-application
  reads return nothing;
- **read-validated** — every row read back is re-validated; tampered or foreign rows are
  typed errors, never silently surfaced.

The store exposes exactly `append` / `get` / `listByPlan` / `listByExecution`. There is
deliberately **no admission, authorization or status vocabulary** on this surface — no
execution path may consult decision records for authorization (architecture-proven).

## Provenance audit (`audit.ts`)

`auditExecutionProvenance` re-validates the IR, re-derives it from the snapshot,
re-checks losslessness, and verifies each decision's identity, digest and hard-constraint
compliance — deterministic, replayable, zero-violation on a clean chain.
`auditDurableExecutionProvenance` does the same over store-served records only; a record
that did not come from the authoritative store is a `durable-record-foreign` violation.
The 9-code audit vocabulary is closed (`PROVENANCE_AUDIT_CODES`).

## Declared module seams (the only module-side integration points)

The platform plane imports no module. Modules implement neutral seam contracts in their
own adapter layers (the WORK-048 precedent):

- `src/modules/planning/adapters/ir-plan-source.ts` — `PlanDerivationSeam`:
  `toPlanSnapshot(plan)` (pure, lossless) + helpers deriving constraints from the
  planner's own captured `policyInputs` and `capabilityResolution`;
- `src/modules/executions/adapters/ir-execution-binding.ts` — `ExecutionBindingSeam`:
  read-only execution → plan binding from the executions ledger;
- `src/modules/budgets/adapters/ir-cost-constraints.ts` — `BudgetConstraintsSeam`:
  read-only budget ceilings.

No module depends on the IR plane for authority; the three-file seam set is
mechanically asserted (`tests/architecture/e11-ir-boundaries.test.ts` B3).

## Where this goes next

WORK-050 (Deterministic Execution Compiler) consumes this foundation to compile governed
plans into optimized executable forms under the same constraints and records its
decisions through the same evidence contract. Nothing in this plane needs to change for
that: the IR, constraints, cost model and decision record are the compiler's inputs.
