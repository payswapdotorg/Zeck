# economic-competitive-benchmark (VAL-048)

The cross-workload competitive benchmark: the synthesis comparing Zeck's RECORDED economics against the alternatives across the complete recorded workload portfolio — per-workload-class win/loss/tie verdicts on the ADJUSTED basis (never mixed bases), with statistical confidence carried honestly.

**Every arm fact is PURE derivation over RECORDED results** — the VAL-040 Zeck rows (`sdk` surface), the VAL-041 direct controls, the VAL-042 optimized baseline, the VAL-043 competing stack — imported (never copied), referenced by content digest, verified field-by-field against each arm's own corpus extractor. The composed context (the VAL-044 adjusted-cost records, the VAL-045 attribution + VAL-047 curves, the VAL-046 substrate windows) is digest-referenced and disclosed, never mixed into the paired verdict basis.

## The comparison families

| Family | Adjusted basis (per successfully resolved outcome) |
|---|---|
| `quality-adjusted-ranking` | `(measured / resolved) / attainment` — the verified-attainment-normalized cost (attainment RECOMPUTED from the recorded runs, never a claim) |
| `latency-adjusted-ranking` | `measured / (resolved × compliance)` — every recorded round's OWN latency weighed against the pinned budget (an overage block carries its overage-weighted cost; a latency-omitting comparison FAILs) |
| `failure-adjusted-ranking` | `measured / resolved` — every failed attempt's cost and every failed round's cost amortized IN (a dropped failure cost FAILs the failure-completeness oracle) |
| `portfolio-weighted-aggregate` | the EXPLICIT weighted aggregate over the recorded classes (weights declared, sum-checked to 1, never buried — an omitted class FAILs portfolio honesty) |

## The recorded competitive cohorts (the pre-registered workload portfolio)

| Class | Window | Arms (the pre-registered sets) |
|---|---|---|
| `fixed-quality-confirmation` | 8 rounds, threshold 0.75, openrouter/rev-001 | zeck `fixed-quality-openrouter-usd-metered` + direct `fixed-quality-direct-default-rail` + optimized `fixed-quality-optimized-routing-cache-amortized` + competing `fixed-quality-competitor-default-routing` |
| `zero-resolved-honest` | 6 rounds, 0 resolved everywhere | the four arms' zero-resolved rows (the honest incomparability class) |
| `budget-stop-prefix` | 8 pre-registered → 3 executed | the four arms' honest budget-stop prefix rows (reported UNDER-POWERED, never silently dropped) |
| `live-real-dispatch` | 4 rounds (env-gated) | zeck + direct LIVE windows (the primary pair; the optimized/competing live windows remain declared in their own corpora for the operator's live review) |

## The corpus (14 rows)

| Row | Family / class | Expected verdict |
|---|---|---|
| `confirmation-fixed-quality-quality-adjusted-ranking` | quality / headline | **COMPLETED** statistical-tie (zeck cheapest on the point estimate: 22 < 24 < 26 < 69 µ$/resolved) |
| `confirmation-fixed-quality-latency-adjusted-ranking` | latency / headline | **COMPLETED** statistical-tie |
| `confirmation-fixed-quality-failure-adjusted-ranking` | failure / headline | **COMPLETED** statistical-tie |
| `zero-resolved-quality-adjusted-null-basis` | quality / zero | **COMPLETED** incomparable-null-basis (NULL everywhere — never a zero-denominator fabrication) |
| `zero-resolved-failure-adjusted-null-basis` | failure / zero | **COMPLETED** incomparable-null-basis |
| `budget-stop-prefix-quality-adjusted-underpowered` | quality / stop | **COMPLETED** under-powered (3 blocks < the pre-registered minimum 5) |
| `cross-workload-portfolio-weighted-aggregate` | aggregate / portfolio | **COMPLETED** statistical-tie (weights 0.5 / 0.25 / 0.25 explicit, sum-checked; per-class verdicts disclosed) |
| `probe-subset-cherry-picking` | aggregate | **FAILED** (portfolio-honesty — the omitted classes named) |
| `probe-unit-pooling` | quality / headline | **FAILED** (unit-comparability — the pooled blocks named) |
| `probe-cost-basis-switching` | quality / headline | **FAILED** (cost-basis-integrity — both sides named) |
| `probe-unpaired-statistics` | quality / headline | **FAILED** (paired-statistics — the unpaired claim refused) |
| `probe-confidence-inflation` | quality / headline | **FAILED** (multiple-comparison-honesty — the claimed p not derived) |
| `probe-sample-starvation` | quality / stop | **FAILED** (minimum-sample-enforcement — the starved-sample verdict claim refused) |
| `live-competitive-real-dispatch-slice` | quality / live | **COMPLETED** statistical-tie (env-gated on `OPENROUTER_API_KEY`; 4 blocks cannot reach the corrected level — the honest a-priori disclosure) |

## The mechanical verification core (per row)

The exact paired sign test over the round-for-round blocks (both-resolved blocks carry the cost signs; one-resolved blocks are disclosed as outcome-dominant; both-unresolved blocks excluded) + the Wilson 95% interval (the imported accounting rail) + the declared Bonferroni family-wise policy (per-comparison level verified arithmetically) + the enforced minimum paired blocks (a below-minimum verdict claim FAILs named — the honest verdict is under-powered). The oracles: input integrity (digest + field equality + the arm's own corpus extractor cross-check), portfolio honesty, unit comparability, cost-basis integrity, paired-statistics correctness, multiple-comparison honesty, minimum-sample enforcement, weighting disclosure, failure-cost completeness, estimate/measure separation.

## Boundaries

- The offline corpus is deterministic: zero credentials, zero network, zero re-measurement — every arm bundle re-derives from the imported recorded corpora through the imported pricing oracle.
- The live row is env-gated on `OPENROUTER_API_KEY` (BYOK, measured usage, `max_tokens` 32 pinned, temperature unset per the provider's documented default, the empty-completion 200 counted as honest success per the VAL-014 rule, the provider envelope's usage tokens winning over raw HTTP observations). Without the credential the row is honestly NOT RUN.
- Evidence carries payload DIGESTS only — never payload bytes. No credentials in the repository, logs or reports.
