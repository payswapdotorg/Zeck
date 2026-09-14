# economic-controls-direct (VAL-041)

The DIRECT-PROVIDER control arm of the economic validation: the
frozen VAL-030 app portfolio replayed with providers called
**directly** — no Zeck agent platform, no gateway middle layer, no
reuse/cache shortcut — so every later Zeck economic claim has the
honest "what it would cost and quality-attain without us" reference.

Every run executes the frozen VAL-040 experiment protocol
(`../economic-baseline/protocol.ts` — imported, never copied):
fixed-quality arms measure cost-to-attain the declared threshold,
fixed-cost arms measure quality-attained-within-budget, all economics
normalized through the VAL-040 rails (micro-USD per successfully
resolved outcome, measured facts only, pinned list-price manifest
revisions), every comparison carrying the Wilson 95% interval,
pre-registered corpus slices with minimum sample sizes.

## The corpus (14 rows: 7 honest controls + 5 probes + 2 live)

| row | arm | rail / revision | shape | terminal |
| --- | --- | --- | --- | --- |
| fixed-quality-direct-default-rail | fq-direct-default | openrouter / llama-3.3-70b, rev-001 | 8 rounds; 7 first-attempt + 1 client-side bounded retry (per-attempt retry-overhead facts) | COMPLETED |
| fixed-quality-direct-euro-rail | fq-direct-eur | euro-relay / euro-small-v1 (EUR per-1M), rev-001 | 6 rounds; 5 confirm + 1 honest content-policy failure; EUR→USD through the pinned FX | COMPLETED |
| fixed-quality-direct-tokyo-rail | fq-direct-jpy | tokyo-relay / tokyo-mini-v1 (JPY per-1K), rev-001 | 6 rounds; 1 bounded retry; per-1K JPY unit conversion | COMPLETED |
| fixed-quality-direct-corrected-price | fq-direct-rev2 | openrouter, rev-002 | 6 rounds priced through the CORRECTED revision (rev-001 stays frozen) | COMPLETED |
| fixed-cost-direct-within-budget | fc-direct-default | openrouter, rev-001 | 400 µ$ budget, 64-token round bound; 5/6 resolve | COMPLETED |
| fixed-cost-direct-budget-exhausted-honest-stop | fc-direct-stop | openrouter, rev-001 | 70 µ$ budget — the declared PREFIX stop after 3 of 8 | COMPLETED |
| zero-resolved-direct-null-discipline | fc-direct-zero | openrouter, rev-001 | every request fails honestly — cost-per-resolved NULL | COMPLETED |
| probe-platform-shortcut-masquerade | fq-direct-probe-shortcut | openrouter, rev-001 | round 3's dispatch observed platform/gateway artifacts | FAILED |
| probe-mixed-currency-conflation | fq-direct-probe-mixed | openrouter, rev-001 | usage denominated GBP against the USD rail | FAILED |
| probe-estimate-backed-cost | fq-direct-probe-estimate | openrouter, rev-001 | rounds report ONLY quotes (no measured usage) | FAILED |
| probe-post-hoc-arm-exclusion | fq-direct-probe-exclusion | openrouter, rev-001 | the executor skips the failed sixth round | FAILED |
| probe-sample-size-violation | fq-direct-probe-starved | openrouter, rev-001 | 8 pre-registered / minimum 8, only 5 recorded | FAILED |
| live-fixed-quality-direct-real-dispatch | fq-direct-live | openrouter, rev-001 | REAL direct requests (env-gated) | COMPLETED (live) |
| live-fixed-cost-direct-real-budget | fc-direct-live | openrouter, rev-001 | REAL direct requests under a 600 µ$ budget (env-gated) | COMPLETED (live) |

## Pinned policies

- **Arm grammar** — the VAL-040 frozen grammar; arms declare the
  `direct:` integration surface, ONE pinned provider rail
  (`provider`/`model`), the pinned price revision from
  `PRICE_MANIFEST`, the pre-registered slice and the statistical
  minimums. Rows never embed list prices.
- **Frozen-portfolio references** — VAL-030 baseline revisions
  referenced BY CONTENT DIGEST (the manifest entry's
  app/workload/manifest digests); never copied. The
  `portfolio-freeze-integrity` criterion re-derives the manifest
  digest through the platform's own derivation.
- **Price manifests** — the VAL-040 pinned revisions only
  (`rev-001`, `rev-002`); `deriveManifestIntegrity` verifies the
  declared revision is known and its recomputed digest agrees (an
  in-place price mutation FAILs mechanically).
- **Direct granularity** — per-attempt usage facts: the client-side
  bounded retry is the row's OWN retry-overhead (never amortized
  inside a gateway boundary); the settling attempt carries
  direct-execution scope.
- **Statistical minimums** — every arm's `minimumSamples` is
  pre-registered; the sample-discipline oracle FAILs a starved
  sample and any post-hoc arm exclusion (the honest budget-stop
  PREFIX is the only declared stop).

## The verification core (the driver's mechanical oracles)

- `deriveDirectPathConformance` — the arm-conformance oracle: the
  provider dispatches carry NO platform/gateway artifacts (no
  reuse/cache shortcut signatures, no platform mediation markers)
  and ride the arm's OWN pinned rail. A shortcut-riding row FAILs
  with the artifact named.
- `deriveDirectCostBasisIntegrity` — the normalization oracle: a
  mixed-currency conflation or an estimate-backed cost FAILs.
- `deriveDirectManifestIntegrity` — the manifest oracle: an unpinned
  or mutated price revision FAILs.
- `deriveDirectSampleDiscipline` — the sample-size oracle: below the
  pre-registered minimum FAILs; a post-hoc arm exclusion FAILs.

## The live rail (honest NOT RUN without the credential)

The two live rows are env-gated on `OPENROUTER_API_KEY`
(operator-authorized, BYOK, measured — never fabricated). Without
the credential the rows are honestly **NOT RUN** (never fabricated);
with it, phase 2's integration crown drives REAL direct requests
through the pinned openrouter rail.

## Boundaries

- This app imports the VAL-040 substrate (`../economic-baseline/**`
  — protocol, normalization, pricing, driver, fixtures), the
  validation harness and the longitudinal-baseline corpus; it never
  modifies them and never touches `src/**` or `platform/**`.
- `config.json` is generated from the exported task slice
  (secret-free, repository-reproducible).
- Evidence carries payload DIGESTS only — never payload bytes.
