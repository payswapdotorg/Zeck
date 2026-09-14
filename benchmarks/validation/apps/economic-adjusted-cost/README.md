# economic-adjusted-cost (VAL-044)

The adjusted-cost synthesis the economic validation exists for: the
three control arms' **RECORDED** results (VAL-041 direct-provider,
VAL-042 optimized non-Zeck baseline, VAL-043 competing stack) composed
with the pinned VAL-040 manifests into the three adjusted-cost
families — **quality-adjusted** cost (measured cost per unit of
VERIFIED quality attainment), **latency-adjusted** cost (cost weighted
by latency-budget compliance) and **failure-adjusted** cost (cost per
successfully resolved outcome with retries and failed attempts fully
amortized; NULL when nothing resolved).

The synthesis is a PURE derivation over the recorded arm corpora: the
inputs are **digest references** (arm label + corpus row id + the
content digest of the recorded outcome) — never copies, never
re-measurements, never re-pricings. The input-integrity oracle
re-derives every input's recorded facts from the imported arm corpora
(the same simulations their own expected-outcome derivations run) and
a bundle that disagrees FAILs as a re-measurement masquerade.

Every comparison carries the Wilson 95% interval (the REAL accounting
module's derivation — imported, never re-implemented), the minimum
sample sizes are enforced (below-minimum comparisons REFUSE honestly —
a comparability claim on a starved sample FAILs), the arm set is
PRE-REGISTERED (a post-hoc arm exclusion FAILs named) and every
input's pinned price revision is verified against the VAL-040
manifest registry.

## The corpus (14 rows: 7 honest + 6 probes + 1 live)

| row | family | arm set | shape | verdict | terminal |
| --- | --- | --- | --- | --- | --- |
| quality-adjusted-three-arm-synthesis | quality | the 3 arms' headline recordings | attainment recomputed; measured × runs / resolved | comparable | COMPLETED |
| latency-adjusted-three-arm-synthesis | latency | the 3 arms' headline recordings | 1000ms pinned budget; every recorded run's own latency weighted | comparable | COMPLETED |
| failure-adjusted-three-arm-synthesis | failure | the 3 arms' headline recordings | retries + failed attempts fully amortized | comparable | COMPLETED |
| quality-adjusted-null-attainment-incomparable | quality | the 3 arms' zero-resolved recordings | attainment 0 → adjusted cost NULL | honestly-incomparable | COMPLETED |
| failure-adjusted-null-resolved-incomparable | failure | the 3 arms' zero-resolved recordings | nothing resolved → NULL, never zero | honestly-incomparable | COMPLETED |
| latency-adjusted-honest-stop-prefix | latency | the 3 arms' honest stop-prefix recordings | the declared prefix stop is data, never an exclusion | comparable | COMPLETED |
| quality-adjusted-below-minimum-honest-refusal | quality | the 3 arms' stop-prefix recordings vs minimum 6 | the samples cannot support a verdict → REFUSE | refused-below-minimum | COMPLETED |
| probe-quality-inflated-denominator | quality | headline (denatured) | a claimed attainment above the recomputed one | adversarial-failed | FAILED |
| probe-latency-omission | latency | headline (denatured) | per-run latencies stripped | adversarial-failed | FAILED |
| probe-failure-hiding | failure | headline (denatured) | retry-overhead + failed-round costs zeroed | adversarial-failed | FAILED |
| probe-estimate-conflation | quality | headline (denatured) | the estimate share absorbed into the measured total | adversarial-failed | FAILED |
| probe-remeasurement-masquerade | quality | headline (denatured) | a re-measured run count masquerading as the recorded result | adversarial-failed | FAILED |
| probe-below-minimum-comparability-claim | quality | stop-prefix vs minimum 6 | claims comparability below the minimums | comparable (claim) | FAILED |
| live-adjusted-synthesis-real-comparison | quality | the 3 arms' LIVE rows | one REAL adjusted comparison (env-gated) | comparable | COMPLETED (live) |

## Pinned policies

- **Digest references** — every arm input is referenced by content
  digest over the recorded outcome (arm label, corpus row id, run/
  resolved counts, measured/estimated totals, cost-per-resolved,
  Wilson bounds); the corpus declares the digests at pin time and the
  driver re-derives them from the imported corpora at verification
  time. Recorded outcomes are never copied into rows or task bodies.
- **Statistical minimums** — `minimumInputs` (the synthesis sample)
  and `minimumSamplesPerInput` (each input's recorded sample) are
  pre-registered; a below-minimum comparison must claim the REFUSED
  verdict (a comparability claim below the minimums FAILs named).
- **Wilson configuration** — 95% on every comparison, the REAL
  accounting module's derivation (imported).
- **Price manifests** — every input's pinned revision verified
  against the VAL-040 `PRICE_MANIFEST` registry (integrity + digest);
  the recorded micro-USD totals are carried as recorded, at each
  arm's own pinned revision — never re-priced.
- **No re-running, no re-pricing** — the synthesis derives over the
  RECORDED arm results; the live row is the only place new
  measurements happen (env-gated, BYOK).

## The verification core (the driver's mechanical oracles)

- `deriveQualityAdjustmentHonesty` — the denominator is the VERIFIED
  attainment (recomputed from the recorded runs); a quality-inflated
  denominator FAILs named.
- `deriveLatencyAdjustmentInclusion` — the cost is weighted by
  latency-budget compliance over every recorded run's own latency; a
  latency-omitting comparison FAILs named.
- `deriveFailureAdjustmentCompleteness` — retries and failed attempts
  fully amortized (the measured total reconstructs from the
  direct+retry shares AND the resolved+failed shares); a
  failure-hiding comparison FAILs named.
- `deriveEstimateMeasureSeparation` — the measured basis is exactly
  the recorded measured total; estimates conflated into it FAIL named.
- `deriveConfidenceAndMinimum` + `deriveBelowMinimumRefusalHonesty` —
  Wilson carried, the pre-registered set held (no post-hoc arm
  exclusion), the minimums enforced with the honest refusal verdict.
- `deriveInputIntegrity` — every input IS the recorded corpus's own
  result (digest + field equality); a re-measurement masquerading as
  synthesis FAILs named.

## The live rail (honest NOT RUN without the credential)

The live row is env-gated on `OPENROUTER_API_KEY`
(operator-authorized, BYOK, measured — never fabricated). Without the
credential the row is honestly **NOT RUN** (never fabricated); with
it, phase 2's integration crown drives one REAL adjusted comparison
over a REAL representative slice with every arm priced at its pinned
manifest revision.

## Boundaries

- This app imports the VAL-040 substrate (`../economic-baseline/**`),
  the three control arms' corpora/drivers
  (`../economic-controls-{direct,optimized,competing}/**`) and the
  validation harness; it never modifies them and never touches
  `src/**` or `platform/**`.
- `config.json` is generated from the exported task slice
  (secret-free, repository-reproducible).
- Evidence carries payload DIGESTS only — never payload bytes.
