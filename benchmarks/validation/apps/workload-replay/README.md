# Workload-Replay Application (VAL-031)

A customer-style replay application: one pinned replay-population
corpus row per run, driving VAL-030's frozen baseline corpus N times
through Zeck's public SDK boundary with learning still INERT (the
CONTROL arm declaration rides the task semantics). This is the
repeated-replay slice of the longitudinal learning wave: every
replay's full trajectory is captured, and the trajectory POPULATION is
analyzed for the pre-learning facts every later learning claim must
account for — per-workload step-count stability, the
trajectory-digest distribution across identical replays, the measured
latency distribution and the accounting totals per replay.

Per row, the corpus declares the pinned baseline manifest entry
(imported from VAL-030's frozen registry — the READ-ONLY input; the
replays never rewrite the manifests), the replay count N, the expected
trajectory-class membership (VAL-030's pinned equivalence class) and
the expected population statistics (the stability pin the analysis
derivation must reproduce).

## The pinned corpus (`workload-replay.population.v1`)

| Row | VAL-030 baseline | N | Population statistics | Expected |
|---|---|---|---|---|
| text-summarize-replay-population | text-summarize-baseline (1 round, 1 effect) | 5 | deterministic — ONE identical digest × 5 | COMPLETED |
| rag-retrieval-replay-population | rag-retrieval-corrected-baseline r2 (2 rounds, 2 effects) | 4 | deterministic — the corrected revision's digest × 4 | COMPLETED |
| tool-agent-loop-replay-population | tool-agent-loop-baseline (3 rounds, 1 effect) | 3 | deterministic — the loop trajectory × 3; 9 own dispatches total | COMPLETED |
| order-settlement-varying-replay-population | order-settlement-equivalence-class (1 round, 2 INDEPENDENT effects) | 4 | **varying** — the world's scheduler alternates the two equivalent orderings; distribution = 2 replays per class member, REPORTED varying | COMPLETED |
| oversized-batch-guard-replay-population | oversized-batch-guard-rejected (demand 6_500 > quota 3_000) | 3 | deterministic — the guard-rejection digest × 3; zero dispatches | **FAILED** (every replay honestly) |
| probe-duplicate-replay | research-digest-rerun-equivalence | 3 | deterministic — the `duplicate-replay` hook (pinned now; the LEAKY ledger's shoulder-in FAILs the population) | COMPLETED |
| probe-dropped-replay | text-summarize-baseline | 3 | deterministic — the `dropped-replay` hook (the DROPPED ledger's lost observation FAILs the population) | COMPLETED |
| probe-drifted-trajectory | coding-fix-baseline | 3 | deterministic — the `drifted-trajectory` hook (the DRIFT recorder's mutated capture FAILs the class membership) | COMPLETED |
| probe-partial-population | rag-retrieval-corrected-baseline | 4 | deterministic — the `partial-population` hook (a stability claim from 3 of 4 observations FAILs) | COMPLETED |
| probe-fabricated-determinism | order-settlement-equivalence-class (varying schedule) | 4 | **varying** — the `fabricated-determinism` hook (a determinism claim over this observed variance, or a world that smooths it, FAILs) | COMPLETED |

## Live rail row (env-gated; driven by the Lead's authorized credentials)

| Row | Gate | REAL demand | Expected |
|---|---|---|---|
| live-replay-dispatch-population | `OPENROUTER_API_KEY` | TWO replays × ONE REAL model confirmation round each through the REAL platform model gateway (measured usage per replay, never estimated, never fabricated) | COMPLETED; deterministic population; usage measured per replay |

## Pinned policies

- **Replay semantics**: learning stays explicitly INERT across the
  whole population (`control.learning = "inert"` rides every replay's
  task body — task semantics, never provider selection). Each replay
  makes its OWN dispatches; the population dispatch total is N × the
  row's per-replay demand (an under-dispatching population FAILs
  mechanically).
- **Population completeness**: exactly N replays per row — no
  duplicates, no gaps. Each replay lands its OWN durable execution
  under its OWN idempotency key and records ONE immutable ledger
  identity (the VAL-007/030 discipline): a replay that shoulders into
  an existing identity, a dropped observation or a rejected submission
  FAILs the population.
- **Stability honesty**: the analysis derives its report from the
  OBSERVED population and is judged against the corpus pin —
  deterministic rows show identical digests across the N replays;
  varying rows are REPORTED varying with their observed distribution;
  a smoothed variance, a fabricated determinism claim or a stability
  claim from a partial replay set each FAIL mechanically.
- **Accounting honesty**: latency is always measured (the distribution
  is min/max/median over the measured per-replay latencies — never
  estimated); usage is measured per replay on the live rail and
  honestly none-reported offline; population totals are sums of
  MEASURED per-replay values.
- **Frozen-baseline discipline**: VAL-030's registry is the read-only
  input — the pinned manifests are referenced by digest, never copied,
  never rewritten; a replay population whose pin is not committed
  FAILs.

## Boundaries

- Integrates ONLY through the public SDK (`sdk/` — the validation
  harness rides the same boundary); never Zeck internals
  (`src/**` is never imported by the application); never selects
  provider/model/rail (the task references the corpus row; the
  platform derives the route).
- The offline rows need NO provider at all — the replay-population
  semantics are ledger-level (the admission guard, the inert dispatch
  rounds, the recorder's trajectory capture and the replay ledger are
  the system under test; the deterministic digests are the oracle).
- Evidence carries payload DIGESTS, never payload bytes; usage, cost
  and latency are measured, never estimated.
- Configuration is repository-reproducible and secret-free
  (`config.json` mirrors the exported task slice); the single secret
  is the environment token (`ZECK_VALIDATION_TOKEN`), and the live
  row's credential is env-gated (`OPENROUTER_API_KEY`).

## Run

Executed by the validation suites: the unit battery
(`tests/unit/validation/val-031-apps.test.ts` over the deterministic
fake world and `tests/unit/validation/val-031-platform.test.ts` over
the platform slice's pure derivations + the replay driver over every
offline row), with the REAL end-to-end integration run env-gated in
the validation integration suite (drives the pinned replay corpus N
times over the REAL platform path with the accounting totals measured
by the REAL accounting rails).
