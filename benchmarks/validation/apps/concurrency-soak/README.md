# Concurrency/Soak Application (VAL-025)

A customer-style concurrency application: one pinned corpus row per
run, submitted through Zeck's public SDK boundary, exercising the
platform's concurrency semantics — same-key racing submissions
arbitrated to exactly one durable execution per idempotency key
(the racing case of the VAL-018/021 ledger-key discipline),
distinct-key parallelism without head-of-line blocking, bounded
load shaping at the admission seam (the typed `POLICY_DENIED`
rejection with the durable `execution.policy-denied` envelope and
zero effects), and endurance/soak rounds over a declared sustained
window with the durable invariants re-verified after every round.

## The pinned corpus (`concurrency-soak.settlement.v1`)

| Row | Pattern | Submission contract | Durable state after settle | Terminal |
|---|---|---|---|---|
| same-key-race-pair | same-key-race | 2 concurrent creates under ONE key → 1 created + 1 replayed (identity preserved) | 2 executions (the app's pair's 1 + the driver's probe pair's 1), 2 keys, settle:RACE-101-L0/L1 ×1 | COMPLETED |
| same-key-race-storm | same-key-race | 5 concurrent creates under ONE key → 1 created + 4 replayed | 2 executions, 2 keys, settle:RACE-102-L0/L1 ×1 | COMPLETED |
| same-key-race-conflict | same-key-race | 2 concurrent creates under ONE key, the peer's body MUTATED → 1 created + 1 typed 409 IDEMPOTENCY_KEY_REUSED | 2 executions, 2 keys; the loser's effect NEVER lands | COMPLETED |
| distinct-key-fanout-parallel | distinct-key-fanout | 4 concurrent distinct-key creates → 4 distinct identities; overlap ≥ 2 (no head-of-line blocking) | 4 executions, 4 keys, settle/notify:FAN-201-L* ×1 each | COMPLETED |
| over-ceiling-burst-shaped | over-ceiling-burst | 5 concurrent distinct-key creates against the declared ceiling 2 → 2 admitted + 3 typed POLICY_DENIED denials (durable envelopes, status stays CREATED, zero effects) | 5 executions, 5 keys, settle:BURST-301 ×2 (the admitted lanes only) | COMPLETED |
| over-ceiling-burst-slot-release | over-ceiling-burst | waves [3, 1]: 2 admitted + 1 denied, the admitted settle (slots release), wave 2's lane ADMITS the freed slot → 3 admitted + 1 denied | 4 executions, 4 keys, settle:BURST-401 ×3 | COMPLETED |
| soak-rounds-invariants | soak-rounds | 6 rounds × (racing pair + 2 distinct lanes), 25 ms declared inter-round spacing (the elapsed window measured) | 24 executions (18 app lanes + 6 probe lanes), 24 keys; per-round invariants re-verified after every round; the round's probe key re-issued (the replay — never a second transition) | COMPLETED |

The declared admission ceiling is **2** admitted executions in flight;
the soak window is **6 rounds × 25 ms spacing** (a compact,
honestly-sustainable window — never a fabricated elapsed time).

## Live rail rows (env-gated; driven by the Lead's authorized credentials)

| Row | Gate | REAL demand | Expected |
|---|---|---|---|
| live-fanout-real-dispatch | `OPENROUTER_API_KEY` | 3 lanes driven concurrently, each with ONE REAL model confirmation round through the REAL model gateway | COMPLETED; overlap observed; effects ×1 each; usage measured |
| live-race-after-real-dispatch | `OPENROUTER_API_KEY` | the racing winner drives ONE REAL confirmation round; the loser replays (zero extra REAL dispatches) | COMPLETED; replayed flag surfaced; effects ×1 |

The confirmation rounds' default model is
`meta-llama/llama-3.3-70b-instruct` (env-overridable via
`ZECK_VAL_025_MODEL` — the VAL-019/021-proven rail posture).

## Boundaries

- Integrates ONLY through the public SDK (the validation harness) —
  never Zeck internals; never selects provider/model/rail (the task
  references the corpus row; the platform derives the route).
- The offline rows need NO provider at all — the concurrency semantics
  are ledger-level (the idempotency ledger's transactional
  arbitration, the executions state machine, the admission gate and
  the journal are the system under test).
- The over-ceiling denials ride the platform's REAL admission
  vocabulary: the typed `POLICY_DENIED` error, the durable
  `execution.policy-denied` envelope, the execution staying CREATED
  (dispatch remains impossible — zero effects).
- Evidence carries payload DIGESTS, never payload bytes; usage, cost
  and latency are measured, never estimated.
- Configuration is repository-reproducible and secret-free; the single
  secret is the environment token (`ZECK_VALIDATION_TOKEN`).

## Run

Executed by the validation integration suite
(`tests/integration/validation/val-025-concurrency-soak.test.ts`).
