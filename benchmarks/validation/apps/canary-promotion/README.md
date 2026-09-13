# Canary-Promotion Application (VAL-035)

A customer-style canary application: one pinned canary corpus row per
run, promoting VAL-034's SHADOW-EXECUTED candidates (the lifecycle
identities whose recorded walk already ends at `shadow-executed` —
the read-only input) through Zeck's public SDK boundary — the
GOVERNED RAMP of pinned traffic fractions (5% → 25% → 50% → 100%)
under the EXPLICIT admission policy (every canary decision cites its
policy: the ramp schedule, the failure budget and the divergence
tolerance — stated AND checked), the customer served the INCUMBENT's
outcome outside the slice and the REPLACEMENT's outcome inside it (an
unpromoted candidate serves ONLY its canary slice; after promotion
the full traffic may serve the replacement), an observed divergence
count beyond the pinned budget FAILing the step and triggering the
COMPLETE mechanical rollback (the served traffic reverts to the
incumbent across the whole slice — the plan recorded and EXERCISED,
never partial), the canary's measured cost booked to the canary
ledger APART under its canary marker (the customer is never billed
for the canary), and the verified canary appending its lifecycle
rungs one evidenced step at a time — `shadow-executed → canaried →
promoted` (the FINAL stage; a jump FAILs).

Per row, the corpus declares the canaried candidate (the VAL-034
shadow-executed lifecycle identity with its prior walk), the pinned
policy (ramp / budget / tolerance), the traffic population and the
expected outcome (clean promotion through the full ramp / honest
budget-breach rollback mid-ramp / honest refusal).

## The pinned corpus (`canary-promotion.governed-ramp.v1`)

| Row | Canaried candidate (VAL-034 landing) | Pinned policy | Expected outcome |
|---|---|---|---|
| rag-deterministic-function-clean-promotion | RAG deterministicization (N=4) | ramp 5%→25%→50%→100%, budget 1/step, exact-digest-equality | **clean-promotion (COMPLETED)** — zero divergences at every step; the canaried + promoted rungs land one evidenced step at a time |
| text-summarize-split-preprocessing-clean-promotion | text-summarize deterministicization (N=5) | default ramp, budget 1/step, digest-class-equality | **clean-promotion (COMPLETED)** — semantic-output equality; every step within budget |
| order-settlement-retrieval-clean-promotion | order-settlement cache (N=4, honestly varying) | default ramp, budget 0/step, digest-class-equality | **clean-promotion (COMPLETED)** — the retrieval's answer is a class member on every case (equality not required for semantic outputs) |
| tool-loop-reusable-tool-clean-promotion-tolerance | tool-agent competence (N=3) | default ramp, budget 1/step, per-case-tolerance | **clean-promotion (COMPLETED)** — historical cases demand digest identity; the injected probes are the tolerated set |
| reuse-removed-call-budget-breach-rollback | cross-workload reuse (N=8) | default ramp, budget 0/step, exact-digest-equality | **honest-rollback (FAILED)** — the removal diverges on every case by construction; step 1 observes 1 divergence beyond the 0-budget: the step FAILs honestly, the decision is breach-rollback, the revert is complete and exercised, and only the `canaried` rung lands (never `promoted`) |
| unregistered-candidate-canary-refusal | a PHANTOM identity (never a registry member) | default ramp, budget 1/step | **honest refusal** (`candidate-unregistered`) — no candidate, no slice, nothing lands |
| not-yet-shadow-executed-canary-refusal | the not-yet-shadow-executed entry (walk ends at differentially-evaluated) | default ramp, budget 1/step | **honest refusal** (`candidate-not-shadow-executed`) — a premature canary refuses honestly (a skipped lifecycle never promotes) |
| probe-skipped-lifecycle | RAG deterministicization (N=4) | default ramp, budget 1/step | pass over the honest world; the `skipped-lifecycle` hook (the BROKEN-WALK pre-seed drops the shadow rung → the honest refusal vs the pinned promotion; the JUMP-TO-PROMOTED append skips the canaried rung — each FAILs) |
| probe-unchecked-policy | RAG deterministicization (N=4) | default ramp, budget 1/step | pass over the honest world; the `unchecked-policy` hook (POLICY-BLIND / DECISIONLESS ledgers — an unstated or stated-but-unchecked policy item FAILs, named) |
| probe-smoothed-breach | cross-workload reuse (N=8) | default ramp, budget 0/step | pass over the honest world (the honest rollback); the `smoothed-breach` hook (the SMOOTHING ledger rewrites the beyond-budget decision to an advance — FAILs) |
| probe-over-slice | RAG deterministicization (N=4) | default ramp, budget 1/step | pass over the honest world; the `over-slice` hook (the OVER-SLICE serving path serves beyond the pinned fraction — FAILs; the out-of-slice tenant FAILs just the same) |
| probe-partial-rollback | cross-workload reuse (N=8) | default ramp, budget 0/step | pass over the honest world; the `partial-rollback` hook (the PARTIAL-ROLLBACK revert leaves a residual case serving the replacement — FAILs, the residual named; the unexercised plan FAILs just the same) |
| probe-mid-canary-escape | RAG deterministicization (N=4) | default ramp, budget 1/step | pass over the honest world; the `mid-canary-escape` hook (the ESCAPING runtime exercises network access DURING the canary — a containment violation — FAILs) |

## Live rail row (env-gated; driven by the operator-authorized credentials)

| Row | Gate | REAL demand | Expected |
|---|---|---|---|
| live-split-preprocessing-canary-confirmation | `OPENROUTER_API_KEY` | ONE REAL residual-AI model round through the REAL platform model gateway before the promoted rung appends to the candidate lifecycle (measured usage, never estimated, never fabricated) | COMPLETED; a digest-class-equality clean promotion over the two cited live replay inputs + the injected probes; usage measured; the canary cost booked apart under its canary marker |

## Pinned policies

- **Policy explicitness**: every canary step's decision cites its
  policy — the ramp schedule, the failure budget and the divergence
  tolerance stated AND checked. An UNSTATED item, a stated-but-UNCHECKED
  item, a malformed ramp (fractions not strictly increasing in (0, 1],
  or not ending at the full-traffic step) or an executed step without
  its decision each FAILs mechanically with the item named.
- **Promotion lifecycle completeness**: the candidate's recorded walk
  must be the FULL evidenced chain (`offline-replayed →
  differentially-evaluated → shadow-executed`) before the canary — a
  skipped stage, a broken walk or an unevidenced transition FAILs; the
  canary advances `shadow-executed → canaried → promoted` ONE
  evidenced rung at a time (a jump — a promoted append without the
  canaried rung — FAILs; nothing lands past `promoted`, the FINAL
  stage).
- **Breach honesty**: a step whose observed divergence count is WITHIN
  its pinned budget advances honestly (an unjustified rollback FAILs);
  a count BEYOND the budget FAILs the step and the decision MUST be
  breach-rollback — a smoothed breach that advances FAILs, a
  breach-rollback decision without the rollback trigger FAILs, and an
  asserted count that contradicts the per-case record FAILs. Every
  divergence is recorded case-by-case with both sides' digests.
- **Rollback completeness**: the rollback is COMPLETE and mechanical —
  the served traffic reverts to the incumbent across the WHOLE slice
  (a partial rollback that leaves any fraction serving the replacement
  FAILs, naming the residual), and the rollback plan is recorded on
  every run (the reversibility contract: production promotion must be
  reversible to the previous execution plan) and EXERCISED on every
  breach (an unevidenced rollback plan FAILs).
- **Slice isolation**: an unpromoted candidate serves ONLY its canary
  slice — the deterministic membership of the step's pinned fraction
  (an over-slice serve FAILs with the case named; a ramp-adherence
  break FAILs just the same); a tenant outside the granted slice
  served the replacement FAILs with the tenant named; after promotion
  the full traffic may serve the replacement.
- **Canary cost separation**: the canary slice's cost is measured
  APART and booked to the canary ledger under its CANARY marker — a
  canary cost billed as ordinary served traffic without its marker
  FAILs, and an unmeasured or unbooked canary cost FAILs.
- **Containment carry-over**: the replacement still runs inside its
  granted isolation surface DURING the canary — an escape mid-canary
  is a containment violation that FAILs and is recorded.
- **Read-only inputs**: the candidate registry's EXISTING entries
  (VAL-032's proposals) and the lifecycle's RECORDED VAL-033 + VAL-034
  walk are read-only inputs — the canary run APPENDS its rungs, it
  never rewrites history; a registry whose digest changes over a run
  FAILs mechanically.
- **Accounting honesty**: the offline rows dispatch no model at all
  (usage honestly none-reported offline); the live row's residual-AI
  round is REAL and measured; latency is always measured; evidence
  carries payload DIGESTS, never payload bytes.

## Boundaries

- Integrates ONLY through the public SDK (`sdk/` — the validation
  harness rides the same boundary); never Zeck internals (`src/**` is
  never imported by the application); never selects
  provider/model/rail (the task references the corpus row; the
  platform derives the route).
- The offline rows need NO provider at all — the canary comparison
  semantics are digest-level over the recorded populations.
- The live row is env-gated on `OPENROUTER_API_KEY` and is skipped
  (recorded NOT RUN) when the operator credential is absent.

## Run entry points

- Unit (offline, deterministic): `bunx vitest run
  tests/unit/validation/val-035-platform.test.ts`
- The exported task slice (`CANARY_PROMOTION_TASKS` in
  `application.ts`) mirrors `config.json` — the consistency tests pin
  the pair; the integration harness (phase 3) drives the live row
  over the REAL platform path with the operator-authorized credential.
