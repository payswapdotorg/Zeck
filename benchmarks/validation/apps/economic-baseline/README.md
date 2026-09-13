# Economic-Baseline Application (VAL-040)

A customer-style economics application: one pinned experiment row per
run, submitted through Zeck's public SDK boundary, opening the
economic-validation wave — heterogeneous provider pricing converges
onto the program's canonical basis (micro-USD cost per SUCCESSFULLY
resolved outcome, measured facts only, estimates reported separately
and never conflated), under the FROZEN fixed-quality / fixed-cost
experiment protocol every later economics work order (VAL-041
direct-provider controls, VAL-042 optimized non-Zeck baseline, VAL-043
competing stacks) must execute.

## The canonical basis (the normalization core)

Every arm's heterogeneous pricing — per-token list prices in mixed
currencies (USD/EUR/JPY) and units (per-1M/per-1K/per-token), metered
vs. batched metering (ceil-to-batch), retry amortization
(retry-overhead facts of the same run) — converges onto **micro-USD
cost per successfully resolved outcome** through exact BigInt
arithmetic. A usage fact whose currency mismatches the pinned price's
denomination (or sits outside the pinned FX table) FAILS to normalize
(the mixed-currency conflation catch); nothing-resolved arms hold a
NULL cost-per-resolved (never zero, never estimate-backed — the
VAL-006 discipline).

## The pinned price manifest (content-addressed, append-only)

`pricing.ts` pins the manifest registry: provider PUBLIC LIST-PRICE
tables (negotiated/bulk/undocumented pricing is forbidden and
rejected mechanically) + the pinned FX conversion table, each
revision content-addressed (SHA-256 over the canonical tables+fx).
A price correction is a NEW revision (`rev-002` supersedes `rev-001`
— the openrouter input price correction); an in-place price mutation
breaks digest agreement and FAILS manifest integrity mechanically.
Arms declare WHICH revision priced their runs — prices are never
copied inline into rows or arm declarations.

## The frozen experiment protocol

- **fixed-quality arms** pin a declared resolution threshold and
  measure the cost to attain it — the full pre-registered slice runs,
  the threshold attainment is RECOMPUTED from the accounted runs (an
  arm's own claim never decides — the threshold-gaming catch), and
  the comparison carries the Wilson 95% interval;
- **fixed-cost arms** pin a micro-USD budget and measure the quality
  attained within it — the per-round worst-case bound (priced from
  the pinned manifest) gates dispatch BEFORE it happens, budget
  exhaustion is an honest declared prefix stop (never a post-hoc
  exclusion), and the measured total must respect the budget;
- both kinds declare the pre-registered corpus slice, the statistical
  minimum sample size (enforced mechanically) and the pinned price
  revision; the declaration is digest-frozen at pin time.

## The pinned corpus (`economic-baseline.experiment.v1`)

| Row | Arm | Pricing shape | Expected |
|---|---|---|---|
| fixed-quality-openrouter-usd-metered | fq-openrouter (threshold 0.75, 8 rounds) | USD, per-1M, metered; the first round carries a planner estimate quote (reported separately) | COMPLETED; 8/8 resolved; cpr 22 µ$ |
| fixed-quality-euro-relay-eur | fq-euro (0.75, 8) | EUR, per-1M, metered (FX 1.03); 2 honest failures | COMPLETED; 6/8; cpr 162 µ$ |
| fixed-quality-tokyo-relay-jpy-per-1k | fq-tokyo (0.75, 8) | JPY, per-1K, metered (FX 6250 µ$/JPY); 1 honest failure | COMPLETED; 7/8; cpr 3716 µ$ |
| fixed-quality-batch-relay-batched | fq-batch (0.75, 8) | USD, per-1M, batched @500 (ceil-to-batch on uneven counts) | COMPLETED; 8/8; cpr 235 µ$ |
| fixed-quality-retry-amortization | fq-retry (0.75, 8) | USD, per-1M, metered; 3 rounds amortize a rate-limited retry | COMPLETED; 8/8; cpr 33 µ$ |
| fixed-cost-openrouter-within-budget | fc-openrouter (budget 400 µ$, 6) | USD metered; 1 honest failure | COMPLETED; 5/6; cpr 25 µ$ |
| fixed-cost-budget-exhausted-honest-stop | fc-budget-stop (budget 70 µ$, 8, min 3) | the pinned round bound (24 µ$) stops after 3 rounds — the declared prefix stop | COMPLETED; 2/3; cpr 30 µ$ |
| zero-resolved-null-cost-per-resolved | fc-zero-resolved (budget 1200 µ$, 6) | every round fails honestly | COMPLETED; 0/6 resolved; **costPerResolved NULL** |

Every offline row's economics replay DETERMINISTICALLY from the
repository (recorded VAL-006-style accounting rounds + the pinned
manifest) — zero credentials, zero network.

## Live rail rows (env-gated; driven by the Lead's authorized credentials)

| Row | Gate | REAL demand | Expected |
|---|---|---|---|
| live-fixed-quality-openrouter-real-dispatch | `OPENROUTER_API_KEY` | 4 REAL model dispatches through the REAL model gateway (BYOK, 64-token completion budget, threshold 0.5 recomputed from REAL verdicts) | COMPLETED; measured usage; Wilson carried |
| live-fixed-cost-openrouter-real-budget | `OPENROUTER_API_KEY` | the 600 µ$ REAL budget gates 4 REAL dispatches (the pinned round bound decides BEFORE dispatch) | COMPLETED; measured usage; quality-attained within budget |

The live rail's pinned model is `meta-llama/llama-3.3-70b-instruct`
(the manifest's openrouter entry — the arm's pricing basis). ONE
dispatch binding (one registered connection) serves ALL live rows of
a run — the VAL-025 live-run lesson (a per-row binding mints fresh
master keys while the connection label converges re-registrations,
and the cross-cipher materialize fails the envelope integrity check).

## Boundaries

- Integrates ONLY through the public SDK (the validation harness) —
  never Zeck internals; the task body carries REFERENCES ONLY (the
  arm identity, the pinned price revision, the slice shape) — never
  an inline price.
- The offline rows need NO provider — the economics are replayed
  record facts (honestly source-labeled), never presented as live
  measurements; the live rows' usage is measured (BYOK).
- The REAL accounting rails (the recorder, the evaluation oracle, the
  accounting aggregate with the Wilson interval) are IMPORTED
  modules — never copied, never modified.
- Evidence carries payload DIGESTS, never payload bytes.
- Configuration is repository-reproducible and secret-free; the
  single secret is the environment token (`ZECK_VALIDATION_TOKEN`).

## Run

Executed by the validation integration suite
(`tests/integration/validation/val-040-economic-baseline.test.ts`).
