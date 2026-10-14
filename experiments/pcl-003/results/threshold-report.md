# PCL-003 — Latency-Tail Evaluation: Threshold Report

The P3 program's evidence (ACR-010 §5, work order PCL-003): the per-failure-class percentiles, the cost truth, the resolution honesty, and the mechanical promotion gate over the honest replay of the PPR-027 capstone's latency cells under the typed-facts configuration.

**Every number this evaluation emits is a fresh synthetic measurement** — synthetic-supply (the capstone's declared deterministic fault/latency profiles, drawn by the transport's own pure hash functions), synthetic-cost (the declared price schedule), synthetic-latency (the drawn profile plus the declared pacing delays — never wall-clock). No live/credentialed provider runs, no SLA or production-latency claims; live latency validation under real load is the operator-era obligation, never backfilled.

## Run identity (wall-clock — excluded from every digest)

- run revision: `eadf77cb85efb4d84d98aa2499b4c4b34271090b`
- run started at: 2026-10-14T15:37:04.247Z
- corpus digest: `30116e24efe6db1973068ab8cd0fcbd3d0343bcd28de66edc1f83413fe5cac04`
- declared-thresholds digest: `67168b2aa30d53b4d3df4990dcd1ce5ff43684334fa1a459ebc5d36d685ed93d`
- evaluation digest: `23a6deb86c11eee5df0a09670670fae4340ccc757f0aceb233bdbb9b3a52594b`

## The declared thresholds and their honest verdicts

The declarations were committed BEFORE the run (`experiments/pcl-003/declared-thresholds.json` — the declared-before/verdict-after discipline). The verdicts below are DERIVED from the measured aggregates against those declarations — never asserted; a miss carries its attribution.

### T1 — tail percentile improvement (p95 AND p99 of the successful-outcome latency, strictly — the capstone's own latency-tail pool): **MET**

```json
{
  "rule": "p95-and-p99-strictly-improved",
  "pool": "successful-outcome end-to-end latency (the capstone's latency-tail definition, quoted)",
  "baseline": {
    "p50Ms": 18,
    "p95Ms": 52,
    "p99Ms": 65
  },
  "tuned": {
    "p50Ms": 18,
    "p95Ms": 47,
    "p99Ms": 61
  }
}
```

### T2 — resolution honesty (the tuned arm's resolution rate not below the baseline's): **MET**

```json
{
  "rule": "resolution-rate-not-below-baseline",
  "baseline": {
    "executions": 5950,
    "resolved": 5769,
    "resolutionRate": 0.9695798319327731
  },
  "tuned": {
    "executions": 5950,
    "resolved": 5773,
    "resolutionRate": 0.9702521008403361
  }
}
```

### T3 — cost truth (total cost including duplicates within the declared budget delta): **MET**

```json
{
  "rule": "total-cost-within-budget-delta",
  "budgetDeltaFraction": 0.25,
  "baseline": {
    "totalCostMicroUsd": 57749,
    "basis": "synthetic-price-schedule:transport-charges-per-physical-dispatch (nano-USD summed over every attempt of every execution, rounded once to integer micro-USD)",
    "verificationCostMicroUsd": 0,
    "verificationBasis": "synthetic-price-schedule:no-verification-charge (internal verification draws no provider charge under the declared schedule)"
  },
  "tuned": {
    "totalCostMicroUsd": 57515,
    "basis": "synthetic-price-schedule:transport-charges-per-physical-dispatch (nano-USD summed over every attempt of every execution, rounded once to integer micro-USD)",
    "verificationCostMicroUsd": 0,
    "verificationBasis": "synthetic-price-schedule:no-verification-charge (internal verification draws no provider charge under the declared schedule)"
  },
  "allowedBudgetMicroUsd": 72186
}
```

### T4 — timeout/terminal-failure preservation (zero masked terminals, zero budget violations, the census reconciles): **MET**

```json
{
  "rule": "timeout-and-terminal-preservation",
  "baseline": {
    "terminalFailures": 181,
    "maskedTerminalFailures": 0,
    "dispatchBudgetViolations": 0,
    "censusReconciles": true
  },
  "tuned": {
    "terminalFailures": 177,
    "maskedTerminalFailures": 0,
    "dispatchBudgetViolations": 0,
    "censusReconciles": true
  }
}
```

### THE PROMOTION GATE: **PROMOTED**

Every leg passed (T1–T4): the tail-tuned configuration is promoted by the mechanical gate — basis: the mechanical derivation over the measured aggregates against the declared thresholds (experiments/pcl-003/declared-thresholds.json — declared before the run); median improvement alone promotes nothing (ACR-010 §5, verbatim)

## The measured evidence per configuration

### The baseline arm (the capstone's recorded posture) (`baseline-today`)

- basis: quoted read-only from the PPR-027 machinery's own defaults (experiments/ppr-027/compose.ts: maxRetryAttempts 1, retry-once-next-supply, retryCooldownMs 5; experiments/ppr-027/driver.ts: pollIntervalMs 10)
- executions: 5950 — resolved 5769 (96.96%), failed 181 (terminal 181); verification outcomes: 5769 pass / 181 not-run

**The overall outcome-latency tail** (every execution, resolved and terminal — synthetic-latency: the ladder's drawn latencies plus the paced waits; never wall-clock):

| population | samples | p50 | p95 | p99 | mean | max |
|---|---|---|---|---|---|---|
| overall | 5950 | 19 ms | 55 ms | 66 ms | 24 ms | 105 ms |

**The successful-outcome tail** (the resolved outcomes only — the capstone's own latency-tail pool; the T1 pool, guarded against failure-hiding by the T2 resolution leg):

| population | samples | p50 | p95 | p99 | mean | max |
|---|---|---|---|---|---|---|
| resolved-overall | 5769 | 18 ms | 52 ms | 65 ms | 23 ms | 105 ms |

**The per-failure-class outcome tail** (the end-to-end outcome latency of the executions whose legs encountered each class — every member of the closed taxonomy present; zero-sample classes render the honest no-samples spelling):

| failure class | samples | p50 | p95 | p99 | mean | max |
|---|---|---|---|---|---|---|
| provider-5xx | 45 | 19 ms | 55 ms | 78 ms | 26 ms | 78 ms |
| provider-timeout | 200 | 44 ms | 63 ms | 67 ms | 46 ms | 78 ms |
| provider-throttle | 732 | 47 ms | 67 ms | 72 ms | 49 ms | 105 ms |
| connection-error | 0 | — | — | — | — | — |
| verification-retry | 0 | — | — | — | — | — |
| budget-exhausted | 0 | — | — | — | — | — |
| policy-denied | 0 | — | — | — | — | — |

**The per-outcome-class tail** (the closed outcome classification):

| outcome class | samples | p50 | p95 | p99 | mean | max |
|---|---|---|---|---|---|---|
| succeeded-first-attempt | 5024 | 18 ms | 35 ms | 39 ms | 20 ms | 84 ms |
| succeeded-after-retry | 269 | 37 ms | 42 ms | 44 ms | 37 ms | 45 ms |
| succeeded-on-fallback | 476 | 55 ms | 67 ms | 75 ms | 54 ms | 105 ms |
| failed-terminal | 181 | 46 ms | 66 ms | 78 ms | 44 ms | 80 ms |

**The per-failure-class/ROUTE leg table** (the completion-latency percentiles of the legs carrying each class on each route — the ACR-010 §5 decomposition, never aggregate-only):

| class@route | samples | p50 | p95 | p99 | mean | max |
|---|---|---|---|---|---|---|
| provider-5xx@supply-a/embeddings | 1 | 19 ms | 19 ms | 19 ms | 19 ms | 19 ms |
| provider-5xx@supply-a/local-text | 1 | 17 ms | 17 ms | 17 ms | 17 ms | 17 ms |
| provider-5xx@supply-a/speech-recognition | 1 | 12 ms | 12 ms | 12 ms | 12 ms | 12 ms |
| provider-5xx@supply-a/text | 22 | 16 ms | 19 ms | 20 ms | 16 ms | 20 ms |
| provider-5xx@supply-b/embeddings | 1 | 28 ms | 28 ms | 28 ms | 28 ms | 28 ms |
| provider-5xx@supply-b/rerank | 1 | 28 ms | 28 ms | 28 ms | 28 ms | 28 ms |
| provider-5xx@supply-b/speech-generation | 2 | 34 ms | 34 ms | 34 ms | 30 ms | 34 ms |
| provider-5xx@supply-b/substrate | 1 | 35 ms | 35 ms | 35 ms | 35 ms | 35 ms |
| provider-5xx@supply-b/text | 9 | 31 ms | 38 ms | 38 ms | 30 ms | 38 ms |
| provider-5xx@supply-c/image-generation | 1 | 78 ms | 78 ms | 78 ms | 78 ms | 78 ms |
| provider-5xx@supply-c/text | 5 | 26 ms | 27 ms | 27 ms | 23 ms | 27 ms |
| provider-timeout@supply-a/embeddings | 3 | 16 ms | 17 ms | 17 ms | 16 ms | 17 ms |
| provider-timeout@supply-a/image-generation | 1 | 15 ms | 15 ms | 15 ms | 15 ms | 15 ms |
| provider-timeout@supply-a/rerank | 1 | 15 ms | 15 ms | 15 ms | 15 ms | 15 ms |
| provider-timeout@supply-a/speech-recognition | 2 | 18 ms | 18 ms | 18 ms | 18 ms | 18 ms |
| provider-timeout@supply-a/substrate | 5 | 19 ms | 20 ms | 20 ms | 17 ms | 20 ms |
| provider-timeout@supply-a/text | 67 | 15 ms | 19 ms | 20 ms | 15 ms | 20 ms |
| provider-timeout@supply-a/vision | 2 | 18 ms | 18 ms | 18 ms | 16 ms | 18 ms |
| provider-timeout@supply-b/embeddings | 2 | 31 ms | 31 ms | 31 ms | 28 ms | 31 ms |
| provider-timeout@supply-b/local-text | 1 | 38 ms | 38 ms | 38 ms | 38 ms | 38 ms |
| provider-timeout@supply-b/substrate | 1 | 27 ms | 27 ms | 27 ms | 27 ms | 27 ms |
| provider-timeout@supply-b/text | 25 | 32 ms | 39 ms | 39 ms | 32 ms | 39 ms |
| provider-timeout@supply-c/embeddings | 2 | 23 ms | 23 ms | 23 ms | 21 ms | 23 ms |
| provider-timeout@supply-c/local-text | 2 | 26 ms | 26 ms | 26 ms | 25 ms | 26 ms |
| provider-timeout@supply-c/speech-generation | 1 | 44 ms | 44 ms | 44 ms | 44 ms | 44 ms |
| provider-timeout@supply-c/substrate | 3 | 22 ms | 26 ms | 26 ms | 23 ms | 26 ms |
| provider-timeout@supply-c/text | 86 | 23 ms | 27 ms | 28 ms | 23 ms | 28 ms |
| provider-throttle@supply-a/embeddings | 8 | 17 ms | 19 ms | 19 ms | 16 ms | 19 ms |
| provider-throttle@supply-a/image-generation | 2 | 14 ms | 14 ms | 14 ms | 14 ms | 14 ms |
| provider-throttle@supply-a/local-text | 3 | 17 ms | 18 ms | 18 ms | 16 ms | 18 ms |
| provider-throttle@supply-a/speech-generation | 3 | 16 ms | 17 ms | 17 ms | 15 ms | 17 ms |
| provider-throttle@supply-a/speech-recognition | 2 | 12 ms | 12 ms | 12 ms | 12 ms | 12 ms |
| provider-throttle@supply-a/substrate | 12 | 16 ms | 20 ms | 20 ms | 17 ms | 20 ms |
| provider-throttle@supply-a/text | 358 | 16 ms | 20 ms | 20 ms | 16 ms | 20 ms |
| provider-throttle@supply-a/vision | 2 | 19 ms | 19 ms | 19 ms | 16 ms | 19 ms |
| provider-throttle@supply-b/embeddings | 15 | 30 ms | 39 ms | 39 ms | 30 ms | 39 ms |
| provider-throttle@supply-b/local-text | 1 | 32 ms | 32 ms | 32 ms | 32 ms | 32 ms |
| provider-throttle@supply-b/speech-generation | 4 | 38 ms | 39 ms | 39 ms | 33 ms | 39 ms |
| provider-throttle@supply-b/speech-recognition | 1 | 31 ms | 31 ms | 31 ms | 31 ms | 31 ms |
| provider-throttle@supply-b/substrate | 13 | 30 ms | 37 ms | 37 ms | 30 ms | 37 ms |
| provider-throttle@supply-b/text | 238 | 32 ms | 39 ms | 40 ms | 33 ms | 40 ms |
| provider-throttle@supply-c/embeddings | 7 | 22 ms | 25 ms | 25 ms | 22 ms | 25 ms |
| provider-throttle@supply-c/image-generation | 2 | 84 ms | 84 ms | 84 ms | 71 ms | 84 ms |
| provider-throttle@supply-c/local-text | 1 | 23 ms | 23 ms | 23 ms | 23 ms | 23 ms |
| provider-throttle@supply-c/speech-generation | 1 | 48 ms | 48 ms | 48 ms | 48 ms | 48 ms |
| provider-throttle@supply-c/speech-recognition | 1 | 40 ms | 40 ms | 40 ms | 40 ms | 40 ms |
| provider-throttle@supply-c/substrate | 6 | 21 ms | 23 ms | 23 ms | 20 ms | 23 ms |
| provider-throttle@supply-c/text | 139 | 23 ms | 27 ms | 28 ms | 23 ms | 28 ms |
| connection-error@(none) | 0 | — | — | — | — | — |
| verification-retry@(none) | 0 | — | — | — | — | — |
| budget-exhausted@(none) | 0 | — | — | — | — | — |
| policy-denied@(none) | 0 | — | — | — | — | — |
| no-failure@supply-a/embeddings | 118 | 16 ms | 20 ms | 20 ms | 16 ms | 20 ms |
| no-failure@supply-a/image-generation | 26 | 16 ms | 19 ms | 20 ms | 16 ms | 20 ms |
| no-failure@supply-a/local-text | 34 | 17 ms | 20 ms | 20 ms | 17 ms | 20 ms |
| no-failure@supply-a/rerank | 8 | 16 ms | 19 ms | 19 ms | 15 ms | 19 ms |
| no-failure@supply-a/speech-generation | 35 | 16 ms | 20 ms | 20 ms | 16 ms | 20 ms |
| no-failure@supply-a/speech-recognition | 42 | 17 ms | 20 ms | 20 ms | 17 ms | 20 ms |
| no-failure@supply-a/substrate | 110 | 16 ms | 19 ms | 20 ms | 16 ms | 20 ms |
| no-failure@supply-a/text | 3583 | 16 ms | 20 ms | 20 ms | 16 ms | 20 ms |
| no-failure@supply-a/vision | 33 | 16 ms | 19 ms | 19 ms | 16 ms | 19 ms |
| no-failure@supply-b/embeddings | 27 | 30 ms | 40 ms | 40 ms | 32 ms | 40 ms |
| no-failure@supply-b/image-generation | 3 | 38 ms | 39 ms | 39 ms | 37 ms | 39 ms |
| no-failure@supply-b/local-text | 4 | 29 ms | 38 ms | 38 ms | 31 ms | 38 ms |
| no-failure@supply-b/rerank | 4 | 32 ms | 37 ms | 37 ms | 31 ms | 37 ms |
| no-failure@supply-b/speech-generation | 13 | 31 ms | 39 ms | 39 ms | 32 ms | 39 ms |
| no-failure@supply-b/substrate | 20 | 35 ms | 39 ms | 39 ms | 34 ms | 39 ms |
| no-failure@supply-b/text | 706 | 33 ms | 39 ms | 40 ms | 33 ms | 40 ms |
| no-failure@supply-b/vision | 4 | 34 ms | 34 ms | 34 ms | 31 ms | 34 ms |
| no-failure@supply-c/embeddings | 29 | 23 ms | 28 ms | 28 ms | 23 ms | 28 ms |
| no-failure@supply-c/image-generation | 12 | 69 ms | 84 ms | 84 ms | 68 ms | 84 ms |
| no-failure@supply-c/local-text | 15 | 24 ms | 27 ms | 27 ms | 24 ms | 27 ms |
| no-failure@supply-c/rerank | 1 | 18 ms | 18 ms | 18 ms | 18 ms | 18 ms |
| no-failure@supply-c/speech-generation | 4 | 46 ms | 46 ms | 46 ms | 45 ms | 46 ms |
| no-failure@supply-c/speech-recognition | 11 | 48 ms | 54 ms | 54 ms | 46 ms | 54 ms |
| no-failure@supply-c/substrate | 29 | 24 ms | 28 ms | 28 ms | 24 ms | 28 ms |
| no-failure@supply-c/text | 879 | 23 ms | 27 ms | 28 ms | 23 ms | 28 ms |
| no-failure@supply-c/vision | 19 | 22 ms | 28 ms | 28 ms | 23 ms | 28 ms |

**The cost truth** (synthetic-price-schedule basis, every line explicit):

- total including duplicate attempts: **57749 micro-USD** over 6837 physical dispatches — basis: synthetic-price-schedule:transport-charges-per-physical-dispatch (nano-USD summed over every attempt of every execution, rounded once to integer micro-USD)
- the duplicates component (every attempt beyond the first): **7225 micro-USD** — basis: synthetic-price-schedule:transport-charges-per-duplicate-attempt (every attempt beyond the first of each execution — the duplicate-attempt truth)
- verification cost (its own line): **0 micro-USD** — basis: synthetic-price-schedule:no-verification-charge (internal verification draws no provider charge under the declared schedule)

**The attempt-census proof** (the exact reconciliation — no failure hiding):

- original 5950 + retry 310 + fallback 577 + verification 5769 = 12606 attempts = 12606 (legs 6837) — **RECONCILES EXACTLY**
- masked terminal failures: 0; dispatch-budget violations: 0; max execution elapsed: 105 ms

### The tuned arm (the PCL-002 configuration armed) (`tail-tuned-v1`)

- basis: the PCL-002 declarative configuration (src/modules/executions/domain/tail-pacing-configuration.ts — the typed, closed, versioned pacing DATA), consumed through the app-local projection pinned in-suite against the real plane
- executions: 5950 — resolved 5773 (97.03%), failed 177 (terminal 177); verification outcomes: 5773 pass / 177 not-run

**The overall outcome-latency tail** (every execution, resolved and terminal — synthetic-latency: the ladder's drawn latencies plus the paced waits; never wall-clock):

| population | samples | p50 | p95 | p99 | mean | max |
|---|---|---|---|---|---|---|
| overall | 5950 | 18 ms | 51 ms | 62 ms | 23 ms | 102 ms |

**The successful-outcome tail** (the resolved outcomes only — the capstone's own latency-tail pool; the T1 pool, guarded against failure-hiding by the T2 resolution leg):

| population | samples | p50 | p95 | p99 | mean | max |
|---|---|---|---|---|---|---|
| resolved-overall | 5773 | 18 ms | 47 ms | 61 ms | 22 ms | 102 ms |

**The per-failure-class outcome tail** (the end-to-end outcome latency of the executions whose legs encountered each class — every member of the closed taxonomy present; zero-sample classes render the honest no-samples spelling):

| failure class | samples | p50 | p95 | p99 | mean | max |
|---|---|---|---|---|---|---|
| provider-5xx | 43 | 19 ms | 45 ms | 78 ms | 24 ms | 78 ms |
| provider-timeout | 196 | 41 ms | 59 ms | 67 ms | 42 ms | 75 ms |
| provider-throttle | 712 | 43 ms | 63 ms | 68 ms | 45 ms | 102 ms |
| connection-error | 0 | — | — | — | — | — |
| verification-retry | 0 | — | — | — | — | — |
| budget-exhausted | 0 | — | — | — | — | — |
| policy-denied | 0 | — | — | — | — | — |

**The per-outcome-class tail** (the closed outcome classification):

| outcome class | samples | p50 | p95 | p99 | mean | max |
|---|---|---|---|---|---|---|
| succeeded-first-attempt | 5047 | 18 ms | 35 ms | 39 ms | 19 ms | 84 ms |
| succeeded-after-retry | 269 | 34 ms | 39 ms | 41 ms | 34 ms | 42 ms |
| succeeded-on-fallback | 457 | 51 ms | 64 ms | 72 ms | 50 ms | 102 ms |
| failed-terminal | 177 | 42 ms | 64 ms | 77 ms | 42 ms | 78 ms |

**The per-failure-class/ROUTE leg table** (the completion-latency percentiles of the legs carrying each class on each route — the ACR-010 §5 decomposition, never aggregate-only):

| class@route | samples | p50 | p95 | p99 | mean | max |
|---|---|---|---|---|---|---|
| provider-5xx@supply-a/embeddings | 1 | 19 ms | 19 ms | 19 ms | 19 ms | 19 ms |
| provider-5xx@supply-a/local-text | 1 | 17 ms | 17 ms | 17 ms | 17 ms | 17 ms |
| provider-5xx@supply-a/speech-recognition | 1 | 12 ms | 12 ms | 12 ms | 12 ms | 12 ms |
| provider-5xx@supply-a/text | 23 | 16 ms | 19 ms | 20 ms | 16 ms | 20 ms |
| provider-5xx@supply-b/rerank | 1 | 28 ms | 28 ms | 28 ms | 28 ms | 28 ms |
| provider-5xx@supply-b/speech-generation | 2 | 34 ms | 34 ms | 34 ms | 30 ms | 34 ms |
| provider-5xx@supply-b/text | 9 | 31 ms | 38 ms | 38 ms | 30 ms | 38 ms |
| provider-5xx@supply-c/image-generation | 1 | 78 ms | 78 ms | 78 ms | 78 ms | 78 ms |
| provider-5xx@supply-c/text | 4 | 27 ms | 27 ms | 27 ms | 25 ms | 27 ms |
| provider-timeout@supply-a/embeddings | 3 | 16 ms | 17 ms | 17 ms | 16 ms | 17 ms |
| provider-timeout@supply-a/image-generation | 2 | 15 ms | 15 ms | 15 ms | 14 ms | 15 ms |
| provider-timeout@supply-a/rerank | 1 | 15 ms | 15 ms | 15 ms | 15 ms | 15 ms |
| provider-timeout@supply-a/speech-recognition | 2 | 18 ms | 18 ms | 18 ms | 18 ms | 18 ms |
| provider-timeout@supply-a/substrate | 5 | 19 ms | 20 ms | 20 ms | 17 ms | 20 ms |
| provider-timeout@supply-a/text | 69 | 15 ms | 19 ms | 20 ms | 15 ms | 20 ms |
| provider-timeout@supply-a/vision | 2 | 18 ms | 18 ms | 18 ms | 16 ms | 18 ms |
| provider-timeout@supply-b/local-text | 1 | 38 ms | 38 ms | 38 ms | 38 ms | 38 ms |
| provider-timeout@supply-b/substrate | 1 | 27 ms | 27 ms | 27 ms | 27 ms | 27 ms |
| provider-timeout@supply-b/text | 18 | 30 ms | 39 ms | 39 ms | 31 ms | 39 ms |
| provider-timeout@supply-c/embeddings | 2 | 23 ms | 23 ms | 23 ms | 21 ms | 23 ms |
| provider-timeout@supply-c/local-text | 2 | 26 ms | 26 ms | 26 ms | 25 ms | 26 ms |
| provider-timeout@supply-c/speech-generation | 1 | 44 ms | 44 ms | 44 ms | 44 ms | 44 ms |
| provider-timeout@supply-c/speech-recognition | 1 | 36 ms | 36 ms | 36 ms | 36 ms | 36 ms |
| provider-timeout@supply-c/substrate | 3 | 22 ms | 26 ms | 26 ms | 23 ms | 26 ms |
| provider-timeout@supply-c/text | 86 | 23 ms | 27 ms | 28 ms | 23 ms | 28 ms |
| provider-throttle@supply-a/embeddings | 8 | 17 ms | 19 ms | 19 ms | 16 ms | 19 ms |
| provider-throttle@supply-a/image-generation | 2 | 14 ms | 14 ms | 14 ms | 14 ms | 14 ms |
| provider-throttle@supply-a/local-text | 3 | 17 ms | 18 ms | 18 ms | 16 ms | 18 ms |
| provider-throttle@supply-a/speech-generation | 3 | 16 ms | 17 ms | 17 ms | 15 ms | 17 ms |
| provider-throttle@supply-a/speech-recognition | 3 | 12 ms | 12 ms | 12 ms | 12 ms | 12 ms |
| provider-throttle@supply-a/substrate | 12 | 16 ms | 20 ms | 20 ms | 17 ms | 20 ms |
| provider-throttle@supply-a/text | 367 | 16 ms | 20 ms | 20 ms | 16 ms | 20 ms |
| provider-throttle@supply-a/vision | 2 | 19 ms | 19 ms | 19 ms | 16 ms | 19 ms |
| provider-throttle@supply-b/embeddings | 14 | 30 ms | 39 ms | 39 ms | 31 ms | 39 ms |
| provider-throttle@supply-b/image-generation | 1 | 38 ms | 38 ms | 38 ms | 38 ms | 38 ms |
| provider-throttle@supply-b/local-text | 1 | 32 ms | 32 ms | 32 ms | 32 ms | 32 ms |
| provider-throttle@supply-b/speech-generation | 4 | 38 ms | 39 ms | 39 ms | 33 ms | 39 ms |
| provider-throttle@supply-b/speech-recognition | 1 | 31 ms | 31 ms | 31 ms | 31 ms | 31 ms |
| provider-throttle@supply-b/substrate | 14 | 30 ms | 37 ms | 37 ms | 30 ms | 37 ms |
| provider-throttle@supply-b/text | 216 | 32 ms | 39 ms | 40 ms | 33 ms | 40 ms |
| provider-throttle@supply-c/embeddings | 7 | 22 ms | 26 ms | 26 ms | 22 ms | 26 ms |
| provider-throttle@supply-c/image-generation | 2 | 84 ms | 84 ms | 84 ms | 71 ms | 84 ms |
| provider-throttle@supply-c/local-text | 1 | 23 ms | 23 ms | 23 ms | 23 ms | 23 ms |
| provider-throttle@supply-c/speech-generation | 1 | 48 ms | 48 ms | 48 ms | 48 ms | 48 ms |
| provider-throttle@supply-c/speech-recognition | 1 | 40 ms | 40 ms | 40 ms | 40 ms | 40 ms |
| provider-throttle@supply-c/substrate | 7 | 21 ms | 25 ms | 25 ms | 21 ms | 25 ms |
| provider-throttle@supply-c/text | 129 | 23 ms | 27 ms | 28 ms | 23 ms | 28 ms |
| connection-error@(none) | 0 | — | — | — | — | — |
| verification-retry@(none) | 0 | — | — | — | — | — |
| budget-exhausted@(none) | 0 | — | — | — | — | — |
| policy-denied@(none) | 0 | — | — | — | — | — |
| no-failure@supply-a/embeddings | 120 | 16 ms | 20 ms | 20 ms | 16 ms | 20 ms |
| no-failure@supply-a/image-generation | 26 | 16 ms | 19 ms | 20 ms | 16 ms | 20 ms |
| no-failure@supply-a/local-text | 34 | 17 ms | 20 ms | 20 ms | 17 ms | 20 ms |
| no-failure@supply-a/rerank | 9 | 16 ms | 19 ms | 19 ms | 15 ms | 19 ms |
| no-failure@supply-a/speech-generation | 33 | 16 ms | 20 ms | 20 ms | 16 ms | 20 ms |
| no-failure@supply-a/speech-recognition | 42 | 17 ms | 20 ms | 20 ms | 17 ms | 20 ms |
| no-failure@supply-a/substrate | 108 | 16 ms | 19 ms | 20 ms | 16 ms | 20 ms |
| no-failure@supply-a/text | 3626 | 16 ms | 20 ms | 20 ms | 16 ms | 20 ms |
| no-failure@supply-a/vision | 35 | 16 ms | 19 ms | 19 ms | 16 ms | 19 ms |
| no-failure@supply-b/embeddings | 26 | 31 ms | 40 ms | 40 ms | 32 ms | 40 ms |
| no-failure@supply-b/image-generation | 3 | 38 ms | 39 ms | 39 ms | 37 ms | 39 ms |
| no-failure@supply-b/local-text | 4 | 34 ms | 38 ms | 38 ms | 32 ms | 38 ms |
| no-failure@supply-b/rerank | 3 | 27 ms | 32 ms | 32 ms | 28 ms | 32 ms |
| no-failure@supply-b/speech-generation | 14 | 30 ms | 39 ms | 39 ms | 31 ms | 39 ms |
| no-failure@supply-b/speech-recognition | 2 | 38 ms | 38 ms | 38 ms | 38 ms | 38 ms |
| no-failure@supply-b/substrate | 20 | 35 ms | 39 ms | 39 ms | 34 ms | 39 ms |
| no-failure@supply-b/text | 650 | 33 ms | 39 ms | 40 ms | 33 ms | 40 ms |
| no-failure@supply-b/vision | 4 | 34 ms | 34 ms | 34 ms | 31 ms | 34 ms |
| no-failure@supply-c/embeddings | 30 | 23 ms | 28 ms | 28 ms | 23 ms | 28 ms |
| no-failure@supply-c/image-generation | 11 | 69 ms | 84 ms | 84 ms | 68 ms | 84 ms |
| no-failure@supply-c/local-text | 15 | 24 ms | 27 ms | 27 ms | 24 ms | 27 ms |
| no-failure@supply-c/rerank | 1 | 18 ms | 18 ms | 18 ms | 18 ms | 18 ms |
| no-failure@supply-c/speech-generation | 5 | 46 ms | 50 ms | 50 ms | 46 ms | 50 ms |
| no-failure@supply-c/speech-recognition | 9 | 44 ms | 54 ms | 54 ms | 46 ms | 54 ms |
| no-failure@supply-c/substrate | 32 | 24 ms | 28 ms | 28 ms | 24 ms | 28 ms |
| no-failure@supply-c/text | 894 | 23 ms | 27 ms | 28 ms | 23 ms | 28 ms |
| no-failure@supply-c/vision | 17 | 22 ms | 28 ms | 28 ms | 23 ms | 28 ms |

**The cost truth** (synthetic-price-schedule basis, every line explicit):

- total including duplicate attempts: **57515 micro-USD** over 6814 physical dispatches — basis: synthetic-price-schedule:transport-charges-per-physical-dispatch (nano-USD summed over every attempt of every execution, rounded once to integer micro-USD)
- the duplicates component (every attempt beyond the first): **7069 micro-USD** — basis: synthetic-price-schedule:transport-charges-per-duplicate-attempt (every attempt beyond the first of each execution — the duplicate-attempt truth)
- verification cost (its own line): **0 micro-USD** — basis: synthetic-price-schedule:no-verification-charge (internal verification draws no provider charge under the declared schedule)

**The attempt-census proof** (the exact reconciliation — no failure hiding):

- original 5950 + retry 310 + fallback 554 + verification 5773 = 12587 attempts = 12587 (legs 6814) — **RECONCILES EXACTLY**
- masked terminal failures: 0; dispatch-budget violations: 0; max execution elapsed: 102 ms

## The honest disclosures (the explicit-basis discipline)

- the latency model: the outcome latency is the ladder's arithmetic (the drawn per-attempt latencies plus the paced inter-attempt waits) — synthetic-latency, never wall-clock; the recorded capstone numbers (quoted below, verbatim) carry their OWN basis (wall-clock end-to-end under the synthetic supply) and are never relabeled or compared like-for-like;
- the per-leg first-byte point renders the honest NOT RUN on every leg (owner: the synthetic supply declares no first-byte profile — the transport draws completion latency only);
- the progress-delivery dimension is RECORDED (the mode and the applied interval ride every fact block), never latency-differentiated: the synthetic supplies are synchronous request/response draws — they model no progress-observation delay, and they declare no event-stream capability (the transport's own typed capability truth — the ACR-009 pattern). The event-stream and poll-quantization effects are operator-era live questions, never backfilled;
- the replay is the re-dispatching posture (one fresh exposure per logical request occurrence): the capstone's durable-replay reuse axis is its own determinism-reuse dimension, out of this evaluation's scope (disclosed);
- the zero-sample failure classes (connection-error, verification-retry, budget-exhausted, policy-denied) never appear in this synthetic world's draws — their rows render the honest no-samples spelling in every table above;
- the synthetic supplies' fault vocabulary maps to the closed PCL-001 taxonomy by the declared mapping (rate-limit → provider-throttle, timeout → provider-timeout, provider-unavailable → provider-5xx).

## The PPR-027 cell replay (102 cells, per-cell honest verdicts)

Both arms re-ran FRESH over each cell's corpus (the exact-revision rule; the capstone's recorded numbers are NEVER reused as evaluation inputs). The recorded columns quote the capstone's committed results VERBATIM (their own wall-clock basis, synthetic-supply label preserved, never relabeled); the re-run columns are this evaluation's fresh typed-facts measurements (synthetic-latency basis).

| cell | recorded (verbatim: median/p95/p99 ms, wall-clock) | re-run baseline (p95/p99 ms, drawn) | re-run tuned (p95/p99 ms, drawn) | recorded mediated attempts/successes | re-run resolved b/t | cell verdict | failing legs |
|---|---|---|---|---|---|---|---|
| aider-S-single-mono | 70/166/166 | 37/40 | 34/37 | 5/4 | 20/20 | cell-passed | — |
| aider-S-multi-mono | 113/138/138 | 46/59 | 39/43 | 5/3 | 19/19 | cell-passed | — |
| aider-M-single-mono | 31/146/146 | 40/42 | 37/39 | 10/10 | 36/36 | cell-passed | — |
| aider-M-multi-mono | 41.5/306/306 | 48/66 | 54/63 | 10/10 | 39/39 | cell-passed | — |
| aider-L-single-mono | 3/87/87 | 35/44 | 32/41 | 20/19 | 80/80 | cell-passed | — |
| aider-L-multi-mono | 2/117/256 | 59/67 | 45/59 | 20/20 | 76/77 | cell-passed | — |
| cline-S-single-mono | 61/89/89 | 37/39 | 34/36 | 4/3 | 46/46 | cell-passed | — |
| cline-S-single-full | 47/690/690 | 30/36 | 27/33 | 5/5 | 48/48 | cell-passed | — |
| cline-S-multi-mono | 125/129/129 | 63/65 | 52/62 | 4/3 | 46/46 | cell-passed | — |
| cline-S-multi-full | 21/133/133 | 60/63 | 33/50 | 5/3 | 46/47 | cell-passed | — |
| cline-M-single-mono | 18.5/747/747 | 38/43 | 35/40 | 8/8 | 91/91 | cell-passed | — |
| cline-M-single-full | 14.5/762/762 | 35/40 | 32/37 | 10/10 | 96/96 | cell-passed | — |
| cline-M-multi-mono | 32/116/116 | 60/70 | 58/67 | 8/6 | 89/88 | cell-missed | T2 |
| cline-M-multi-full | 23/129/129 | 61/70 | 58/67 | 10/7 | 93/93 | cell-passed | — |
| cline-L-single-mono | 2/83/83 | 37/42 | 34/39 | 16/15 | 185/185 | cell-passed | — |
| cline-L-single-full | 2/100/100 | 38/42 | 35/39 | 20/19 | 189/189 | cell-passed | — |
| cline-L-multi-mono | 2.5/81/81 | 64/68 | 61/65 | 16/14 | 182/182 | cell-passed | — |
| cline-L-multi-full | 2/128/128 | 57/65 | 54/62 | 20/19 | 186/186 | cell-passed | — |
| openhands-S-single-mono | 121.5/664/664 | 38/43 | 35/40 | 4/4 | 47/47 | cell-passed | — |
| openhands-S-single-full | 127/651/651 | 37/40 | 34/37 | 5/5 | 47/47 | cell-passed | — |
| openhands-S-multi-mono | 149.5/159/159 | 62/67 | 59/64 | 4/2 | 46/45 | cell-missed | T2 |
| openhands-S-multi-full | 139.5/212/212 | 61/62 | 58/59 | 5/4 | 48/48 | cell-passed | — |
| openhands-M-single-mono | 53/144/144 | 37/43 | 34/40 | 8/7 | 94/94 | cell-passed | — |
| openhands-M-single-full | 15.5/633/633 | 39/40 | 36/37 | 10/10 | 97/97 | cell-passed | — |
| openhands-M-multi-mono | 34/218/218 | 57/69 | 53/64 | 8/7 | 94/94 | cell-passed | — |
| openhands-M-multi-full | 27.5/171/171 | 54/63 | 51/60 | 10/8 | 97/97 | cell-passed | — |
| openhands-L-single-mono | 4/128/128 | 36/40 | 33/37 | 16/14 | 187/187 | cell-passed | — |
| openhands-L-single-full | 2/139/139 | 37/42 | 34/39 | 20/19 | 193/193 | cell-passed | — |
| openhands-L-multi-mono | 3/180/180 | 60/66 | 57/63 | 16/15 | 182/182 | cell-passed | — |
| openhands-L-multi-full | 2/186/186 | 60/67 | 57/64 | 20/19 | 191/191 | cell-passed | — |
| continue-S-single-mono | 20/146/146 | 39/39 | 36/36 | 5/5 | 15/15 | cell-passed | — |
| continue-S-single-full | 39/174/174 | 18/40 | 18/37 | 7/7 | 20/20 | cell-missed | T1 |
| continue-S-multi-mono | 29.5/200/200 | 63/63 | 54/54 | 5/4 | 16/15 | cell-missed | T2 |
| continue-S-multi-full | 40/79/79 | 57/64 | 54/61 | 7/5 | 19/18 | cell-missed | T2 |
| continue-M-single-mono | 9.5/182/182 | 39/44 | 36/41 | 10/10 | 30/30 | cell-passed | — |
| continue-M-single-full | 10.5/144/144 | 37/43 | 34/40 | 14/14 | 40/40 | cell-passed | — |
| continue-M-multi-mono | 8.5/288/288 | 63/63 | 60/60 | 10/10 | 32/32 | cell-passed | — |
| continue-M-multi-full | 9.5/198/198 | 60/65 | 57/62 | 14/14 | 36/36 | cell-passed | — |
| continue-L-single-mono | 2.5/88/168 | 34/42 | 31/39 | 20/20 | 61/61 | cell-passed | — |
| continue-L-single-full | 1/93/155 | 35/43 | 32/40 | 28/28 | 80/80 | cell-passed | — |
| continue-L-multi-mono | 2/210/267 | 63/69 | 60/66 | 20/20 | 57/59 | cell-passed | — |
| continue-L-multi-full | 1/118/233 | 53/68 | 50/55 | 28/27 | 77/77 | cell-passed | — |
| hermes-agent-S-single-mono | 114/377/377 | 39/40 | 36/37 | 5/5 | 42/42 | cell-passed | — |
| hermes-agent-S-single-full | 148.5/354/354 | 20/38 | 20/35 | 6/6 | 49/49 | cell-missed | T1 |
| hermes-agent-S-multi-mono | 196/542/542 | 62/66 | 51/60 | 5/3 | 44/43 | cell-missed | T2 |
| hermes-agent-S-multi-full | 219/254/254 | 58/70 | 55/67 | 6/5 | 49/48 | cell-missed | T2 |
| hermes-agent-M-single-mono | 29/178/178 | 37/39 | 34/36 | 10/9 | 88/88 | cell-passed | — |
| hermes-agent-M-single-full | 15/379/379 | 36/41 | 33/38 | 12/11 | 95/95 | cell-passed | — |
| hermes-agent-M-multi-mono | 76/577/577 | 64/72 | 57/65 | 10/9 | 88/89 | cell-passed | — |
| hermes-agent-M-multi-full | 35.5/277/277 | 61/68 | 51/65 | 12/8 | 95/97 | cell-passed | — |
| hermes-agent-L-single-mono | 5/189/424 | 37/41 | 34/38 | 20/20 | 176/176 | cell-passed | — |
| hermes-agent-L-single-full | 3/169/181 | 37/40 | 34/37 | 24/23 | 192/192 | cell-passed | — |
| hermes-agent-L-multi-mono | 4/250/250 | 62/67 | 59/64 | 20/17 | 171/171 | cell-passed | — |
| hermes-agent-L-multi-full | 5/201/271 | 63/70 | 57/69 | 24/21 | 190/191 | cell-passed | — |
| openclaw-S-single-mono | 138/190/190 | 31/31 | 28/28 | 2/2 | 14/14 | cell-passed | — |
| openclaw-S-single-full | 31/187/187 | 41/41 | 38/38 | 6/5 | 18/18 | cell-passed | — |
| openclaw-S-multi-mono | 174/217/217 | 70/70 | 67/67 | 2/2 | 13/14 | cell-passed | — |
| openclaw-S-multi-full | 74.5/287/287 | 78/78 | 78/78 | 6/6 | 16/15 | cell-missed | T1,T2 |
| openclaw-M-single-mono | 19/90/90 | 39/41 | 36/38 | 4/3 | 27/27 | cell-passed | — |
| openclaw-M-single-full | 10.5/156/156 | 41/41 | 38/38 | 12/12 | 35/35 | cell-passed | — |
| openclaw-M-multi-mono | 82.5/285/285 | 63/64 | 45/61 | 4/4 | 28/28 | cell-passed | — |
| openclaw-M-multi-full | 13/389/389 | 62/75 | 59/72 | 12/12 | 34/34 | cell-passed | — |
| openclaw-L-single-mono | 3.5/179/179 | 36/42 | 33/39 | 8/8 | 55/55 | cell-passed | — |
| openclaw-L-single-full | 1/112/176 | 35/43 | 32/40 | 24/24 | 72/72 | cell-passed | — |
| openclaw-L-multi-mono | 2.5/287/287 | 59/62 | 56/59 | 8/8 | 53/52 | cell-missed | T2 |
| openclaw-L-multi-full | 1/80/310 | 78/89 | 75/86 | 24/23 | 66/66 | cell-missed | T1 |
| browser-use-S-single-mono | 26/33/33 | 19/19 | 19/19 | 2/2 | 3/3 | cell-missed | T1 |
| browser-use-S-single-full | 19/64/64 | 39/39 | 36/36 | 3/3 | 15/15 | cell-passed | — |
| browser-use-S-multi-mono | 64.5/106/106 | 59/59 | 56/56 | 2/2 | 2/2 | cell-passed | — |
| browser-use-S-multi-full | 18/76/76 | 60/60 | 57/57 | 3/3 | 15/15 | cell-passed | — |
| browser-use-M-single-mono | 20/61/61 | 41/41 | 38/38 | 4/4 | 6/6 | cell-passed | — |
| browser-use-M-single-full | 5.5/66/66 | 40/40 | 37/37 | 6/6 | 29/29 | cell-passed | — |
| browser-use-M-multi-mono | 16/61/61 | 42/42 | 39/39 | 4/4 | 6/6 | cell-passed | — |
| browser-use-M-multi-full | 6/79/79 | 56/57 | 54/57 | 6/6 | 24/24 | cell-missed | T1 |
| browser-use-L-single-mono | 2/33/33 | 35/35 | 32/32 | 8/8 | 12/12 | cell-passed | — |
| browser-use-L-single-full | 3/86/86 | 36/40 | 33/37 | 12/12 | 60/60 | cell-passed | — |
| browser-use-L-multi-mono | 1/89/89 | 39/39 | 39/39 | 8/8 | 12/12 | cell-missed | T1 |
| browser-use-L-multi-full | 3/107/107 | 58/68 | 55/65 | 12/12 | 58/59 | cell-passed | — |
| openwebui-S-single-mono | 22/43/43 | 20/20 | 20/20 | 4/4 | 5/5 | cell-missed | T1 |
| openwebui-S-single-full | 20.5/160/160 | 41/41 | 38/38 | 8/8 | 15/15 | cell-passed | — |
| openwebui-S-multi-mono | 39/57/57 | 47/47 | 44/44 | 4/4 | 5/5 | cell-passed | — |
| openwebui-S-multi-full | 45/260/260 | 81/81 | 81/81 | 8/8 | 15/15 | cell-missed | T1 |
| openwebui-M-single-mono | 10.5/36/36 | 20/20 | 20/20 | 8/8 | 10/10 | cell-missed | T1 |
| openwebui-M-single-full | 9.5/141/141 | 20/37 | 20/34 | 16/16 | 30/30 | cell-missed | T1 |
| openwebui-M-multi-mono | 9.5/79/79 | 56/56 | 53/53 | 8/8 | 10/10 | cell-passed | — |
| openwebui-M-multi-full | 11.5/288/288 | 88/105 | 85/102 | 16/16 | 28/29 | cell-passed | — |
| openwebui-L-single-mono | 1/40/40 | 20/20 | 20/20 | 16/16 | 20/20 | cell-missed | T1 |
| openwebui-L-single-full | 1/21/174 | 35/42 | 32/39 | 32/32 | 59/59 | cell-passed | — |
| openwebui-L-multi-mono | 1/62/62 | 61/67 | 58/64 | 16/16 | 17/18 | cell-passed | — |
| openwebui-L-multi-full | 1/64/218 | 62/69 | 59/69 | 32/32 | 55/55 | cell-missed | T1 |
| anythingllm-S-single-mono | 19.5/40/40 | 19/19 | 19/19 | 4/4 | 4/4 | cell-missed | T1 |
| anythingllm-S-single-full | 18.5/41/41 | 19/19 | 19/19 | 6/4 | 9/9 | cell-missed | T1 |
| anythingllm-S-multi-mono | 23/31/31 | 29/29 | 29/29 | 4/4 | 4/4 | cell-missed | T1 |
| anythingllm-S-multi-full | 37.5/103/103 | 60/60 | 57/57 | 6/6 | 9/9 | cell-passed | — |
| anythingllm-M-single-mono | 8/20/20 | 18/18 | 18/18 | 8/8 | 8/8 | cell-missed | T1 |
| anythingllm-M-single-full | 7.5/75/75 | 37/37 | 34/34 | 12/12 | 15/15 | cell-missed | T1 |
| anythingllm-M-multi-mono | 17/64/64 | 66/66 | 63/63 | 8/7 | 8/8 | cell-passed | — |
| anythingllm-M-multi-full | 12/84/84 | 59/59 | 56/56 | 12/12 | 18/18 | cell-passed | — |
| anythingllm-L-single-mono | 1/24/24 | 42/42 | 39/39 | 16/16 | 15/15 | cell-passed | — |
| anythingllm-L-single-full | 1/36/58 | 20/40 | 20/37 | 24/24 | 36/36 | cell-missed | T1 |
| anythingllm-L-multi-mono | 0.5/41/41 | 70/70 | 67/67 | 16/16 | 16/16 | cell-passed | — |
| anythingllm-L-multi-full | 1/49/63 | 57/63 | 54/60 | 24/22 | 33/33 | cell-passed | — |

Per-cell verdict tally: **76 cells passed** / 26 missed; failing-leg tallies: T1×19, T2×8, T3×0, T4×0.

## T5 — the reproducibility proof

The complete evaluation re-ran and reproduced the evaluation digest **byte-for-byte** (identical) — the deterministic replay discipline (wall-clock and run identities excluded from every digest projection).

## NOT RUN boundaries (the honest spelling, with owners)

- live/credentialed provider latency validation under real load: NOT RUN (the operator-era obligation — owner: the operator; never backfilled by synthetic evidence);
- SLA or production-latency claims: NOT MADE (this evaluation's numbers are synthetic-supply/synthetic-cost/synthetic-latency only);
- the per-leg first-byte latency point: NOT RUN on every leg (owner: the synthetic supply declares no first-byte profile — owner within this program: PCL-003 evaluation);
- the event-stream progress-delivery leg and the poll-quantization effect: NOT RUN (the synthetic supplies declare no event-stream capability and model no progress-observation delay — owner: the operator-era live validation).
