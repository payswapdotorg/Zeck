# Idempotency-and-Continuation Application (VAL-021)

A customer-style idempotency-and-continuation application: one pinned
corpus row per run, submitted through Zeck's public SDK boundary,
exercising the platform's submission-level exactly-once semantics —
duplicates replay, conflicting replays get the typed
`IDEMPOTENCY_KEY_REUSED` rejection, retry storms converge (ledger
level) and retry boundedly (dispatch level), escalations route to the
declared authority with the full causal chain, and continuations
resume exactly once (with the stale-worker denial and the no-op resume
replay).

## The pinned corpus (`idempotency-continuation.settlement.v1`)

| Row | Pattern | Submission contract | Effect multiplicity | Terminal |
|---|---|---|---|---|
| duplicate-submission-replay | duplicate | 2 creates (same key + fingerprint) → 1 created + 1 replayed | settle:INV-101 ×1 | COMPLETED |
| conflicting-replay-rejected | conflict | same key + MUTATED task → 409 IDEMPOTENCY_KEY_REUSED (typed); the original completes | settle:INV-102 ×1; INV-999 never settled | COMPLETED |
| retry-storm-converged | retry | 5 rapid same-key creates → 1 created + 4 replayed (ledger convergence) | settle:INV-103 ×1 | COMPLETED |
| retry-storm-bounded-dispatch | retry | 1 create; dispatch: transport-failure ×2 then success → 3 attempts journaled exactly once each | settle:INV-104 ×1, notify:INV-104 ×1 | COMPLETED |
| retry-storm-exhausted | retry | 1 create; dispatch: transport-failure on every attempt → bounded at 1+2 attempts, zero effects | (none) | **FAILED** (honest) |
| escalation-routed-once | escalate | 1 create; the gated refund REF-201 escalates → routed to settlement-ops-oncall with the causal chain; the re-escalation (same key) REPLAYS (authority receives it exactly once); the refund NEVER executes | settle:INV-106 ×1; refund:REF-201 ×0 | COMPLETED |
| continuation-resume-once | continue | 1 create; segment 1 → wait-user → resume (exactly once) → segment 2 | settle:INV-107 ×1, settle:INV-108 ×1, notify:INV-108 ×1 | COMPLETED |
| continuation-stale-worker-denied | continue | 1 create; resume by the successor; the STALE worker's second resume is DENIED by the real state machine and journaled (`resume-denied`) | settle:INV-109 ×1, settle:INV-110 ×1 | COMPLETED |
| continuation-noop-resume-replay | continue | 1 create; after COMPLETED the exact completion transition is re-issued under the same key → REPLAYED (zero state change) | settle:INV-111 ×1 | COMPLETED |

## Live rail rows (env-gated; driven by the Lead's authorized credentials)

| Row | Gate | REAL demand | Expected |
|---|---|---|---|
| live-continuation-supervised | `OPENROUTER_API_KEY` | a REAL continuation-supervisor confirmation round per segment (2 REAL dispatches around the genuine wait-user → resume pair) | COMPLETED; effects ×1 each; usage measured |
| live-duplicate-after-real-dispatch | `OPENROUTER_API_KEY` | a REAL supervisor round; the duplicate create then REPLAYS the durable receipt (zero new REAL dispatches) | COMPLETED; replayed flag surfaced; effects ×1 |

The continuation supervisor's default model is
`meta-llama/llama-3.3-70b-instruct` (env-overridable via
`ZECK_VAL_021_MODEL` — the VAL-019-proven rail posture).

## Boundaries

- Integrates ONLY through the public SDK (the validation harness) —
  never Zeck internals; never selects provider/model/rail (the task
  references the corpus row; the platform derives the route).
- The duplicate/conflict/storm rows need NO provider at all — their
  semantics are ledger-level (the idempotency ledger, the executions
  state machine and the journal are the system under test).
- The dispatch-level retry rows replay injected transient transport
  faults through deterministic fault-injected dispatch fixtures —
  zero network dependence, zero credentials.
- Evidence carries payload DIGESTS, never payload bytes; usage, cost
  and latency are measured, never estimated.
- Configuration is repository-reproducible and secret-free; the single
  secret is the environment token (`ZECK_VALIDATION_TOKEN`).

## Run

Executed by the validation integration suite
(`tests/integration/validation/val-021-idempotency-continuation.test.ts`).
