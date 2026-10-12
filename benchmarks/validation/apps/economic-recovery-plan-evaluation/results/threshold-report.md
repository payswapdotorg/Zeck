# PCR-003 Threshold Report — economic-recovery-plan-evaluation

The P1 program's three-arm replay evaluation (un-retried direct / strong-optimized / mediated-with-plan) at ONE exact revision, targeting the multi-provider cell family where the PPR-027 capstone measured the mediated-resolution gap (92.4% multi vs 97.2% single-provider — the observed-distributions `byProviderConfig` territory). All numbers below are FRESH measurements of THIS evaluation at base revision `ef86cf49972faf8ce102d2d9f5f53ce13e0d5d9a` (run revision `59ee7c726ad482f11072358ff21f7dbdc117533d`); the capstone's recorded numbers are never reused (the exact-revision rule).

## Honest labels (carried on every number)

- supply: synthetic-supply (the declared deterministic fault/latency profiles — never a live provider)
- cost: synthetic-cost (the declared price schedule — never a provider invoice)
- latency: synthetic-latency (the drawn deterministic supply profile — never wall-clock, never live latency)
- no market or production claims; a threshold miss with honest attribution is a valid delivery (the program's truth discipline); live/credentialed validation is the operator-era obligation and is never backfilled from synthetic runs

## The arms (the pre-registered configurations)

- **un-retried-direct** — the un-retried direct arm — the same corpus-derived request stream dispatched straight to the primary synthetic supply, single attempt, no retry, no cache (BASELINE facts — never Zeck evidence)
- **strong-optimized** — the strong-optimized non-Zeck baseline — the app-owned reliability machinery: a 3-attempt retry ladder, an app-owned provider fallback chain, an app-owned content-addressed response cache and a response-shape normalization shim (BASELINE facts — never Zeck evidence; never a strawman)
- **mediated-with-plan** — the mediated-with-plan arm — the real Zeck public API stack (the PPR-027 composed experiment world: real gateway, rails, executions authority, ledger, idempotency) with plan mode ON through the PCR-002 evaluation configuration (ComposeExperimentOptions.recovery), composing the bounded recovery ladder [same-provider retry, alternate-provider failover] through the PCR-001 plan composer

The mediated-with-plan arm turns plan mode ON through the PCR-002 evaluation configuration (`ComposeExperimentOptions.recovery` → `RecoveryConfiguration.planMode: "on"` with the mandatory `maxPlanSteps` bound) — an evaluation/tenant configuration ONLY; the wired seam's default is OFF everywhere else (byte-preserved traced posture). The composed bounded ladder (verified in-suite against the real composer): step 1 = same-provider retry (the retry claim is the cheapest admissible candidate); step 2 = alternate-provider failover to supply-c (the retry is retry-attempt-bound at the second frame; supply-c is the cheapest declared alternate the seam's frame projection admits); terminal bound-reached; 3 total attempts — the strong baseline's own attempt bound.

## The measured arms (the targeted multi-provider cells)

| arm | cells | task occurrences | resolved | task resolution | request occurrences | resolved | request resolution | supply dispatches | durable replays / cache hits | deterministic substrate | nano-USD charged (synthetic-cost) | µ$/resolved task (synthetic-cost) | µ$/resolved request (synthetic-cost) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| un-retried-direct | 51 | 567 | 381 | 67.20% | 2975 | 2653 | 89.18% | 2975 | 0 | 0 | 26428134 | 69.365 | 9.962 |
| strong-optimized | 51 | 567 | 550 | 97.00% | 2975 | 2956 | 99.36% | 1477 | 1686 | 0 | 12606029 | 22.920 | 4.265 |
| mediated-with-plan | 51 | 567 | 554 | 97.71% | 2975 | 2961 | 99.53% | 1556 | 1691 | 36 | 12814627 | 23.131 | 4.328 |

Cost basis: cost figures are the synthetic supply's charge for every physical dispatch the arm made (the declared price schedule: full price on success, input-only partial on timeout, zero on rate-limit/unavailable; the mediated arm's deterministic substrate executions make zero supply dispatches — the PPR-024 plane, a disclosed structural difference; the baselines route substrate requests through the supply at the per-call schedule price) — experiment configuration, never provider invoices. Faults drawn (synthetic-supply): rate-limit 247+164+250 (mediated+optimized+direct), timeout 65+34+56, provider-unavailable 10+9+16.

## T1 — Resolution (threshold: equal-or-better vs the fresh strong baseline)

- mediated-with-plan task resolution: **97.71%** (554/567 task occurrences, synthetic-supply)
- strong-optimized task resolution (the FRESH baseline): **97.00%** (550/567)
- un-retried-direct task resolution (context): 67.20% (381/567)
- delta (mediated-with-plan − strong-optimized): **0.71 percentage points**
- request-level: mediated-with-plan 99.53% vs strong-optimized 99.36%
- per-cell parity: mediated-with-plan resolved at least as many tasks as strong-optimized in **46/51** targeted cells
- **VERDICT: MET** (threshold: equal-or-better-vs-fresh-strong-optimized)

## T2 — Failure-adjusted cost per resolved outcome (improved-or-documented)

- mediated-with-plan: **23.131 µ$/resolved task** (synthetic-cost; 12814627 nano-USD over 554 resolved task occurrences)
- strong-optimized: **22.920 µ$/resolved task** (synthetic-cost; 12606029 nano-USD over 550)
- un-retried-direct (context): 69.365 µ$/resolved task
- measured supply exposures per resolved request: mediated-with-plan 0.5255 vs strong-optimized 0.4997
- **VERDICT: DOCUMENTED-TRADEOFF** (threshold: improved-or-documented-tradeoff)
- attribution: the mediated-with-plan arm paid a higher failure-adjusted synthetic cost per resolved task (23.131 vs 22.920 micro-USD, synthetic-cost); attribution: the composed ladder re-exposes the incumbent supply on its retry step before failing over (measured supply exposures per resolved request 0.5255 vs 0.4997) and the mediated arm re-exposes every unresolved logical request on its next corpus occurrence while the optimized arm's cache absorbs repeats of resolved ones — a documented tradeoff under the improved-or-documented threshold, never a silent regression

## T3 — Policy/budget violations (the hard gate: ZERO)

- violations observed: **0** — the hard gate holds (attempt bounds, the per-execution budget ceiling, the plan step bound, the route policy and the task↔request outcome coherence verified mechanically over every attempt of every arm in every targeted cell at run time; the plan-artifact leg carried IN-SUITE — the recovery plane's own total validation (validateRecoveryPlan) injected by the test suites over every composed plan of the full evaluation, the deterministic-replay identity making it a validation of this committed evidence; see the test suites and the README's boundary disciplines)
- **VERDICT: MET**

## T4 — Latency tails (explicit tradeoff accounting)

Basis: latency figures are the drawn deterministic supply latencies summed over each logical request's physical attempts (the declared profiles; cross-arm deltas are the mediation structure, not live provider latency).

### Per-occurrence end-to-end tails (the user-experienced tradeoff)

| group | samples | p50 ms | p95 ms | p99 ms | mean ms |
|---|---:|---:|---:|---:|---:|
| mediated-with-plan:failed | 14 | 85 | 103 | 103 | 84 |
| mediated-with-plan:resolved-after-recovery | 242 | 56 | 92 | 113 | 58 |
| mediated-with-plan:resolved-first-attempt | 992 | 21 | 38 | 40 | 23 |
| strong-optimized:failed | 19 | 63 | 100 | 100 | 48 |
| strong-optimized:resolved-after-recovery | 127 | 52 | 75 | 80 | 56 |
| strong-optimized:resolved-first-attempt | 1143 | 16 | 20 | 20 | 16 |
| un-retried-direct:failed | 322 | 16 | 20 | 20 | 16 |
| un-retried-direct:resolved-first-attempt | 2653 | 16 | 20 | 20 | 16 |

- recovered-request p95 (resolved-after-recovery): mediated-with-plan **92 ms** vs strong-optimized 75 ms (synthetic-latency) — the recovery ladder's added attempts are the explicit, disclosed tail tradeoff

### Per-attempt tails by failure class

| group | samples | p50 ms | p95 ms | p99 ms | mean ms |
|---|---:|---:|---:|---:|---:|
| mediated-with-plan:provider-unavailable | 10 | 30 | 32 | 32 | 27 |
| mediated-with-plan:rate-limit | 247 | 28 | 39 | 50 | 28 |
| mediated-with-plan:success | 1234 | 23 | 38 | 40 | 24 |
| mediated-with-plan:timeout | 65 | 24 | 35 | 52 | 25 |
| strong-optimized:provider-unavailable | 9 | 17 | 35 | 35 | 18 |
| strong-optimized:rate-limit | 164 | 17 | 36 | 39 | 20 |
| strong-optimized:success | 1270 | 16 | 29 | 39 | 17 |
| strong-optimized:timeout | 34 | 18 | 37 | 46 | 20 |
| un-retried-direct:provider-unavailable | 16 | 17 | 20 | 20 | 16 |
| un-retried-direct:rate-limit | 250 | 16 | 20 | 20 | 16 |
| un-retried-direct:success | 2653 | 16 | 20 | 20 | 16 |
| un-retried-direct:timeout | 56 | 16 | 20 | 20 | 16 |

### Per-attempt tails by route

| group | samples | p50 ms | p95 ms | p99 ms | mean ms |
|---|---:|---:|---:|---:|---:|
| mediated-with-plan:supply-a | 472 | 16 | 20 | 20 | 16 |
| mediated-with-plan:supply-b | 543 | 33 | 39 | 40 | 32 |
| mediated-with-plan:supply-c | 541 | 23 | 28 | 63 | 24 |
| strong-optimized:supply-a | 1289 | 16 | 20 | 20 | 16 |
| strong-optimized:supply-b | 138 | 32 | 40 | 40 | 32 |
| strong-optimized:supply-c | 50 | 23 | 28 | 69 | 24 |
| un-retried-direct:supply-a | 2975 | 16 | 20 | 20 | 16 |

- **VERDICT: ACCOUNTED** (threshold: explicit-p95-p99-tradeoff-accounting; no silent tail regressions — every group is disclosed above)

## PCR-004 eligibility statement (the hedged-mode gate)

The targeted cells are side-effect-safe idempotent workload replays by construction (the certified adapters' content-addressed idempotency discipline — every logical request is a read-style completion over the deterministic synthetic supply; the deterministic substrate plane recomputes rather than re-dispatches). On this evidence:

- sequential plans reached the resolution threshold: **true**
- hedged execution (PCR-004) eligible: **false**
- PCR-004 (hedged execution) is NOT eligible on this evidence: sequential plans REACHED the resolution threshold on the side-effect-safe idempotent targeted cells (mediated-with-plan task resolution 97.71% >= strong-optimized 97.00%, measured fresh over 51 multi-provider cells; ACR-008 §5 admits hedging only on evidence that sequential plans CANNOT reach the threshold)

## The per-cell table (fresh measurements)

| cell | direct | strong-optimized | mediated-with-plan |
|---|---|---|---|
| pcr003-aider-S-multi-mono | 3/5 | 5/5 | 5/5 |
| pcr003-aider-M-multi-mono | 4/10 | 9/10 | 10/10 |
| pcr003-aider-L-multi-mono | 13/20 | 19/20 | 20/20 |
| pcr003-cline-S-multi-mono | 3/4 | 4/4 | 2/4 |
| pcr003-cline-S-multi-full | 3/5 | 4/5 | 5/5 |
| pcr003-cline-M-multi-mono | 3/8 | 8/8 | 8/8 |
| pcr003-cline-M-multi-full | 5/10 | 9/10 | 9/10 |
| pcr003-cline-L-multi-mono | 10/16 | 15/16 | 15/16 |
| pcr003-cline-L-multi-full | 14/20 | 20/20 | 20/20 |
| pcr003-openhands-S-multi-mono | 2/4 | 4/4 | 4/4 |
| pcr003-openhands-S-multi-full | 2/5 | 4/5 | 5/5 |
| pcr003-openhands-M-multi-mono | 2/8 | 8/8 | 8/8 |
| pcr003-openhands-M-multi-full | 6/10 | 10/10 | 9/10 |
| pcr003-openhands-L-multi-mono | 8/16 | 15/16 | 16/16 |
| pcr003-openhands-L-multi-full | 8/20 | 19/20 | 20/20 |
| pcr003-continue-S-multi-mono | 3/5 | 5/5 | 5/5 |
| pcr003-continue-S-multi-full | 5/7 | 6/7 | 6/7 |
| pcr003-continue-M-multi-mono | 10/10 | 10/10 | 10/10 |
| pcr003-continue-M-multi-full | 11/14 | 13/14 | 13/14 |
| pcr003-continue-L-multi-mono | 12/20 | 19/20 | 20/20 |
| pcr003-continue-L-multi-full | 21/28 | 28/28 | 28/28 |
| pcr003-hermes-agent-S-multi-mono | 3/5 | 4/5 | 3/5 |
| pcr003-hermes-agent-S-multi-full | 1/6 | 6/6 | 6/6 |
| pcr003-hermes-agent-M-multi-mono | 4/10 | 10/10 | 10/10 |
| pcr003-hermes-agent-M-multi-full | 6/12 | 12/12 | 10/12 |
| pcr003-hermes-agent-L-multi-mono | 6/20 | 19/20 | 19/20 |
| pcr003-hermes-agent-L-multi-full | 11/24 | 24/24 | 24/24 |
| pcr003-openclaw-S-multi-mono | 1/2 | 2/2 | 2/2 |
| pcr003-openclaw-S-multi-full | 3/6 | 6/6 | 6/6 |
| pcr003-openclaw-M-multi-mono | 2/4 | 4/4 | 4/4 |
| pcr003-openclaw-M-multi-full | 7/12 | 12/12 | 12/12 |
| pcr003-openclaw-L-multi-mono | 5/8 | 7/8 | 8/8 |
| pcr003-openclaw-L-multi-full | 21/24 | 24/24 | 23/24 |
| pcr003-browser-use-S-multi-mono | 2/2 | 2/2 | 2/2 |
| pcr003-browser-use-S-multi-full | 2/3 | 3/3 | 3/3 |
| pcr003-browser-use-M-multi-mono | 4/4 | 4/4 | 4/4 |
| pcr003-browser-use-M-multi-full | 6/6 | 6/6 | 6/6 |
| pcr003-browser-use-L-multi-mono | 8/8 | 8/8 | 8/8 |
| pcr003-browser-use-L-multi-full | 8/12 | 12/12 | 12/12 |
| pcr003-openwebui-S-multi-mono | 3/4 | 4/4 | 4/4 |
| pcr003-openwebui-S-multi-full | 8/8 | 8/8 | 8/8 |
| pcr003-openwebui-M-multi-mono | 7/8 | 8/8 | 8/8 |
| pcr003-openwebui-M-multi-full | 14/16 | 16/16 | 16/16 |
| pcr003-openwebui-L-multi-mono | 15/16 | 16/16 | 16/16 |
| pcr003-openwebui-L-multi-full | 26/32 | 30/32 | 32/32 |
| pcr003-anythingllm-S-multi-mono | 4/4 | 4/4 | 4/4 |
| pcr003-anythingllm-S-multi-full | 4/6 | 5/6 | 6/6 |
| pcr003-anythingllm-M-multi-mono | 7/8 | 8/8 | 8/8 |
| pcr003-anythingllm-M-multi-full | 12/12 | 12/12 | 12/12 |
| pcr003-anythingllm-L-multi-mono | 13/16 | 16/16 | 16/16 |
| pcr003-anythingllm-L-multi-full | 20/24 | 24/24 | 24/24 |

## Reproducibility (the deterministic replay discipline)

- corpus digest (pinned): `10b048c27f7cbcadbe81d45e885ca4861f8abeaba2d64bdc415f8707f4ba6a78`
- evaluation digest (this run): `816fed3721b864a89ec810d018b4fb3ab678c2b79f22f9fb04c80d9199415d11`
- re-run digest comparison: `816fed3721b864a89ec810d018b4fb3ab678c2b79f22f9fb04c80d9199415d11` — IDENTICAL (the full evaluation re-run reproduced the evaluation digest byte-for-byte)
- every per-attempt evidence record was verified against the synthetic transport's own pure draw functions during the run (self-verifying evidence); wall-clock values and run identities are excluded from every digest projection

## Honest boundaries

- synthetic replay only: no live/credentialed provider runs, no market or production claims; live validation is the operator-era obligation
- the mediated-with-plan arm's plan mode retries provider-capacity (provider-unavailable) failures the traced default-off posture would not retry — the recovery plane's class-based retryability discipline (provider is a retryable class) governs plan-mode composition, while the traced posture consumes the transport's non-retryable flag; this divergence is the wired seam's delivered PCR-002 semantics and is disclosed here as an observation, not modified (evaluation only)
- the deterministic substrate plane (the browseruse subject's substrate edges) makes zero supply dispatches for the mediated arm while the baselines route those requests through the supply at the per-call schedule price — a disclosed structural difference in the measured cost basis
- run started 2026-10-12T18:04:18.614Z; base revision `ef86cf49972faf8ce102d2d9f5f53ce13e0d5d9a`; run revision `59ee7c726ad482f11072358ff21f7dbdc117533d`
