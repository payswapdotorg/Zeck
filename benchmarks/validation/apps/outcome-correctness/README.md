# Outcome-Correctness Application (VAL-026)

A customer-style outcome-state application: one pinned corpus row per
run, submitted through Zeck's public SDK boundary, exercising the
platform's outcome-correctness semantics — declared effect sets
verified mechanically against the fixture state after completion
(workspace trees, order placements, ticket routings, citations), the
atomicity of the verification boundary (a FAILED execution's declared
effects are staged-then-discarded — the fixture-state delta is EMPTY),
effect idempotency (a replayed execution applies zero new effects),
and the outcome-state reconciliation (terminal ↔ criteria ↔ journal ↔
fixture-state agreement asserted per row, with the anyFail→FAILED
invariant probed adversarially: a fabricated pass-with-fail is
unrepresentable).

## The pinned corpus (`outcome-correctness.effect.v1`)

| Row | Shape | Declared effect set | Expected terminal | Expected fixture delta |
|---|---|---|---|---|
| workspace-tree-completed | healthy | create-dir + write-file + set-perm (quota 10_000 ≥ 4_000) | COMPLETED | 3 effects ×1 |
| order-placement-completed | healthy | reserve + charge + notify (quota 30_000 ≥ 25_000) | COMPLETED | 3 effects ×1 |
| ticket-routing-completed | healthy | route + close (quota 10_000 ≥ 4_400) | COMPLETED | 2 effects ×1 |
| citation-attachment-completed | healthy | attach + index (quota 5_000 ≥ 1_500) | COMPLETED | 2 effects ×1 |
| guard-rejected-zero-effects | FAILED (precondition) | reserve + charge + notify, quota 4_400 < 17_600 — the budget guard rejects BEFORE any effect stages | FAILED | **EMPTY** |
| mid-work-rollback-zero-effects | FAILED (partial failure) | reserve + charge(frozen) + notify — the fixture world rejects the 2nd effect mid-sequence, the staged set is discarded atomically | FAILED | **EMPTY** |
| criterion-fail-any-fail-failed | FAILED (anyFail→FAILED) | attach + index stage cleanly, but the DECLARED expected fixture digest disagrees — ONE criterion FAILs → verdict fail → discard | FAILED | **EMPTY** |
| replay-idempotent-zero-new-effects | replay (after completion) | create-dir + write-file; the submission key re-issued after completion — replayed, identity preserved, ZERO new executions/records/effects | COMPLETED | 2 effects ×1 |
| replay-after-failure-zero-new-effects | replay (after failure) | reserve + charge with a rejecting quota; the key re-issued after failure — the DURABLE FAILED receipt replays, ZERO new effects | FAILED | **EMPTY** |

Every FAILED row's expected fixture-state delta is the literal EMPTY
record — a failed execution's declared effects must NOT have been
applied (the atomicity of the verification boundary is a first-class
oracle expectation).

## Live rail row (env-gated; driven by the Lead's authorized credentials)

| Row | Gate | REAL demand | Expected |
|---|---|---|---|
| live-confirmation-then-effects | `OPENROUTER_API_KEY` | ONE REAL model confirmation round through the REAL model gateway BEFORE any effect is staged | COMPLETED; effects ×1 each; usage measured |

The confirmation round's default model is
`meta-llama/llama-3.3-70b-instruct` (env-overridable via
`ZECK_VAL_026_MODEL` — the VAL-019/021/025-proven rail posture).

## Boundaries

- Integrates ONLY through the public SDK (the validation harness) —
  never Zeck internals; never selects provider/model/rail (the task
  references the corpus row; the platform derives the route).
- The offline rows need NO provider at all — the outcome semantics are
  ledger-level (the state machine, the verification boundary, the
  idempotency ledger and the step-event journal are the system under
  test; the fixture effects are the oracle).
- Evidence carries payload DIGESTS, never payload bytes; usage, cost
  and latency are measured, never estimated.
- Configuration is repository-reproducible and secret-free; the single
  secret is the environment token (`ZECK_VALIDATION_TOKEN`).

## Run

Executed by the validation integration suite
(`tests/integration/validation/val-026-outcome-correctness.test.ts`).
