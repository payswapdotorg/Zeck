# Execution Compiler — operator and developer guide (WORK-050 / E1.1 stage 2)

The deterministic Execution Compiler (`src/platform/execution-compiler/`) is
the E1.1 charter's stage-2 engine: the SINGLE optimization mechanism
ADR-0020 designates. It transforms a governed, validated Execution IR
(WORK-049) into an optimized IR **variant** using only
semantics-preserving transformations under explicit, recorded
preconditions — and it records every material representation decision
through the WORK-049 evidence contract.

## What it is — and what it is not

| It IS | It is NOT |
|---|---|
| A pure, deterministic compiler over the WORK-049 IR foundation | A planner or plan-selection authority |
| Semantics-preserving transformations with per-site typed preconditions | A re-implementation or fork of the foundation |
| A total validator of every output (the closed 12-code IR invariant vocabulary) | A new state machine or durable store |
| The legitimate decision-record AUTHOR (records built as values) | An authorization surface — nothing consults records |
| Representation-ladder hooks recording decisions | Live model/provider/effort selection (later E1.1 stages) |

The governed plan stays the planner's authority; the executions ledger
stays the durable plan-decision authority; budgets, policy,
capabilities and verification stay the constraint authorities; the
WORK-049 decision-record store stays the ONLY durable evidence surface
(the compiler appends through it at the caller's seam).

## The pipeline

```
governed, validated Execution IR (WORK-049)
      │
      │  constraints (policy · capability · budget · quality · latency ·
      │  verification · side-effect) + config (ordered passes, round
      │  bound, ladder claims, threshold)
      ▼
compileExecutionIr(input) ──────────────────────────────────────▶ CompilationResult
      │   bounded rounds (fail-closed on non-convergence)              │
      │   per-pass total validation + semantic-core proof              ├─ output: ExecutionIrVariant
      │   digest-chained pass trace                                     ├─ trace + traceDigest
      │                                                                  ├─ decisionRecord (WORK-049 format)
      └─ ladder selection (WORK-049 cost model)                          └─ semanticCore digests (equal)
                                        │
                     SqlOptimizationDecisionStore.append() (the caller's seam)
                                        │
                     auditDurableExecutionProvenance(...) (replayable proof)
```

## The output: `ExecutionIrVariant`

A compiled variant is the transformed representation of the governed
plan, with honest, content-addressed identity discipline:

- `variantIrId` — sha256 over the canonical variant form;
- `variantPlanId` — sha256 over the variant's OWN canonical plan form
  (self-consistency: a variant never claims the governed plan's
  identity for content the governed plan does not have);
- `sourceIrId` / `sourcePlanId` — the EXACT preserved chain to the
  governed inputs (plan → IR → variant, replayable by deterministic
  re-compilation).

The IDENTITY variant (the untransformed starting state of every
compilation) has a plan form byte-identical to the input IR's — its
`variantPlanId` IS the governed `planId`: the faithful-container proof.

`validateExecutionIrVariant` enforces exactly the WORK-049 IR invariant
rules — rejections are typed `IrValidationError`s naming codes from the
closed `IR_INVARIANT_CODES` 12-code vocabulary, plus the variant's own
two content identities.

## The transformation catalog (closed, 11 passes)

| pass | kind | preconditions (fail-closed per site) |
|---|---|---|
| `constant-folding` | structural | pure-deterministic class, no capability/route/strategy, config an exact closed fold expression inside the bounded universe |
| `dead-step-elimination` | structural | pure + deterministic + unanchored + non-observable under the governing observability contract (constraint-conditioned: pure unanchored terminals are eliminable only while the verification-anchor binding is active) |
| `common-subexpression-reuse` | structural | structurally identical deterministic value-pure steps, identical predecessor sets, NO shared successor (arity-preserving re-pointing) |
| `verification-insertion` | structural | TERMINAL step-level verification anchors materialize into explicit verify steps carrying the strategy VERBATIM (never invented, never redefined) |
| `retry-normalization` | annotation | retry config inside the canonical bounded {retries ∈ [0,16], backoffMs ∈ [0,600000]} universe (verbatim projection; unbounded configs are rejected, never blessed) |
| `safe-parallelization` | annotation | mutually independent same-shape groups (pairwise unreachable, eligible classes) — the compiler proves independence and records it; the runtime decides |
| `batching` | annotation | homogeneous independent deterministic groups (generative steps excluded — batched model calls change per-item context) |
| `memoization-hooks` | annotation | deterministic, non-verification, non-human steps — content-addressed memo keys (decision points for the WORK-052 cache planner) |
| `subgraph-decomposition` | annotation | deterministic-closure vs probabilistic-reachable membership + region key (evidence for later representation selection) |
| `result-shaping` | annotation | terminal outputs with statically derivable shape (folded object constants or closed projections) — field lists recorded, values never changed |
| `representation-ladder-hooks` | annotation | generative steps annotated with the SELECTION FACTS (selected candidate, representation class, ladder rank, threshold) — hooks only, the routeRef is never changed |

Annotations ride under the reserved step-config key
`execution-compiler` (pass-keyed, stacking; plan-authored content under
the reserved key is never touched). Folded constants ride under
`compiler-folded` (semantic content, never stripped).

## Semantics preservation — the proof standard

Every pass output is validated (the WORK-049 invariant rules + both
identities) and PROVEN equivalent before it can become pipeline state:
the **semantic core digest** — a canonical form of the observable
semantics (evaluated contributions of observable steps, verification
anchor bindings carried verbatim, compiler annotations stripped) — must
be EQUAL on both sides. The core is parameterized by the governing
observability contract (the verification-anchor binding), applied
identically to both sides. A transformation that cannot be proven
preserving fails the compilation closed (`equivalence-violation`) —
never emitted, never assumed.

## Determinism, idempotence, bounds

- **Determinism**: the same (IR, constraints, configuration, digest)
  produce the identical output variant, trace and decision records —
  byte-identical, including tie-breaking (all orderings are
  content-canonical; `recordedAt` is an explicit input).
- **Idempotence**: re-compiling the same input is a bounded no-op
  (identical result; the re-round proves the fixpoint); durable
  re-appends replay (`replayed: true`).
- **Bounds**: at most `maxRounds` (default 4, hard cap 16) re-rounds;
  a budget exhausted while transformations still apply fails closed
  (`pipeline-unbounded`) — no unbounded fixpoints, no silent truncation.

## Decision records and the ladder

When the configuration carries representation claims (bounded,
attributed — the estimation-basis contract is the seam later stages
wire to real telemetry), the compiler builds exactly one material
decision record through the WORK-049 evidence contract:
`buildOptimizationDecision` over the base IR with the base and compiled
candidates (the compiled candidate's `variantIrId` references the exact
output variant), selection through `selectCandidate`
(quality-preserving: a cheaper claim below the threshold is invalid,
never merely more expensive; no admissible candidate ⇒ no record). The
transformation basis uses the closed WORK-049 vocabulary — `identity`
when nothing changed, else `representation-substitution` — with a
bounded detail carrying the compilation provenance (input IR, output
variant, trace digest, pass list).

The records are evidence only: the compiler plane holds no store, no
SQL, no admission vocabulary (architecture-proven); appends happen
through the existing WORK-049 store at the caller's seam, where the
unique (application_id, decision_id) index makes concurrent identical
compilations converge to exactly one durable row.

## The engine surface (6 files)

- `catalog.ts` — the closed pass/invariant/rejection vocabularies, the
  pipeline configuration and its total validation;
- `variant.ts` — the variant type, canonical forms, construction and
  total validation (the WORK-049 invariant rules);
- `semantics.ts` — the closed constant evaluator, the observability
  contract and the semantic-core equivalence machinery;
- `passes.ts` — the eleven pure transformations;
- `decisions.ts` — the representation-ladder decision construction;
- `pipeline.ts` — `compileExecutionIr` (the engine entry point).

## Where this goes next

WORK-051–WORK-054 (tool surfaces, context/cache/reuse economics,
adaptive model/reasoning, substrate economics) consume the compiled
variants, annotations and decision evidence this plane produces; live
model/provider/effort selection, cache planning and substrate choice
are those stages — the hooks recorded here are their decision points.
Nothing in this plane needs to change for that.
