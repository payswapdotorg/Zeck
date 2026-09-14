# economic-substrate-runtime (VAL-046)

The substrate/runtime economics: the cost of the substrate itself,
composed into the economic comparisons as an **explicit substrate-cost
family**. The RECORDED substrate telemetry (the platform-side lifecycle
provenance — readiness probes, cold starts, sustained usage, standing
reservations, restarts and evictions) is composed with the RECORDED arm
results (VAL-041/042/43 — the run provenance and the model-cost side)
into the three families — **substrate cost per run** (the pooled
substrate total divided by the RECORDED served run count),
**substrate cost amortized per resolved outcome** (divided by the
recorded resolved count; NULL when nothing resolved — never zero,
never estimate-backed) and the **readiness-adjusted comparison** (the
effective cost per resolved = the model cost per resolved from the
recorded arm facts PLUS the substrate cost per resolved, with the
readiness wait share — startup + restart — carried EXPLICITLY).

**A comparison that silently absorbs substrate cost into a provider
price FAILs mechanically** — an effective cost equal to the model-only
number while the recorded substrate total is nonzero is the silent
absorption the readiness-adjusted family's oracle catches.

The synthesis is a PURE derivation over the RECORDED telemetry: the
inputs are **digest references** (window id + the content digest of the
derived facts), never copies, never re-measurements, never re-pricings.
The served workload counts RE-DERIVE from the arm corpora through the
imported VAL-044 extractor; the reliability shapes cite the VAL-022
substrate records (digest-referenced provenance — readiness refusals,
sandbox losses, fresh-sandbox restarts).

Every comparison carries the Wilson 95% interval (the REAL accounting
module's derivation — imported, never re-implemented), the minimum
sample sizes are enforced (below-minimum comparisons REFUSE honestly),
the window set is PRE-REGISTERED (a post-hoc window exclusion FAILs
named) and every priced input's pinned revision is verified — the
substrate prices against the SUBSTRATE manifest (content-addressed,
append-only, public-list-only, currency through the VAL-040 pinned FX
table), the model prices against the VAL-040 manifests.

## The corpus (14 rows: 6 honest + 7 probes + 1 live)

| row | family | window set | shape | verdict | terminal |
| --- | --- | --- | --- | --- | --- |
| substrate-cost-per-run-three-fleet-synthesis | per-run | the 3 fleets' headline windows | pooled total / 24 recorded runs | comparable | COMPLETED |
| substrate-cost-amortized-per-resolved-synthesis | amortized | the 3 fleets' headline windows | pooled total / 24 resolved; readiness wait explicit | comparable | COMPLETED |
| readiness-adjusted-effective-comparison-synthesis | readiness-adjusted | the 3 fleets' headline windows | model (40µ$/resolved recorded) + substrate, explicit | comparable | COMPLETED |
| substrate-reliability-failure-amortization-synthesis | amortized | the failure-heavy windows | restarts + evictions fully priced (the VAL-022 shapes) | comparable | COMPLETED |
| substrate-amortized-null-resolved-incomparable | amortized | the zero-resolved windows | 18 runs, 0 resolved → NULL, never zero | honestly-incomparable | COMPLETED |
| readiness-adjusted-below-minimum-honest-refusal | readiness-adjusted | the stop-prefix windows vs minimum 6 | the samples cannot support a verdict → REFUSE | refused-below-minimum | COMPLETED |
| probe-startup-hiding | per-run | headline (denatured claim) | a claimed zero startup share vs a 1400ms warm-up | adversarial-failed | FAILED |
| probe-readiness-inflation | readiness-adjusted | headline (denatured claim) | first-usable claimed at the first REFUSED probe | adversarial-failed | FAILED |
| probe-reserved-measured-conflation | per-run | headline (denatured claim) | the 120s standing reservation folded into measured | adversarial-failed | FAILED |
| probe-failure-amortization-away | amortized | reliability (denatured claim) | claimed-away restart/eviction shares vs counted failures | adversarial-failed | FAILED |
| probe-post-hoc-exclusion | per-run | headline (a window dropped) | a pre-registered window absent from the executed set | adversarial-failed | FAILED |
| probe-sample-size-violation | readiness-adjusted | stop-prefix vs minimum 6 | claims comparability below the minimums | comparable (claim) | FAILED |
| probe-remeasurement-masquerade | amortized | headline (re-measured facts) | a re-measured served run count, recorded digest declared | adversarial-failed | FAILED |
| live-substrate-lifecycle-real-measurement | readiness-adjusted | ONE measured live window | one REAL lifecycle (cold start → ready → sustained → teardown) | comparable | COMPLETED (live) |

## Pinned policies

- **Digest references** — every window input is referenced by the
  content digest of its DERIVED facts (lifecycle, usage, the five-share
  cost decomposition, the re-derived served workload digests); the
  corpus declares the digests at pin time and the driver re-derives
  them from the telemetry corpus at verification time. Recorded
  telemetry is never copied into rows or task bodies.
- **First-usable, not first-dispatched** — the readiness point is
  DERIVED from the probe telemetry (the first PASSING probe's
  timestamp); a claimed first-usable earlier than the first passing
  probe (readiness inflation) or a startup duration using the
  first-dispatched point FAILs named.
- **Reserved/measured separation** — the standing reservation bills by
  the ceil-to-interval count at the pinned per-interval price; the
  measured usage bills per compute-second at the pinned usage price;
  conflating them FAILs named.
- **Statistical minimums** — `minimumWindows` (the synthesis sample)
  and `minimumRunsPerWindow` (each window's served sample) are
  pre-registered; a below-minimum comparison must claim the REFUSED
  verdict (a comparability claim below the minimums FAILs named).
- **Wilson configuration** — 95% on every comparison, the REAL
  accounting module's derivation (imported).
- **Price manifests** — the substrate prices verify against the
  SUBSTRATE manifest (sub-rev-001, content-addressed; sub-rev-002 is
  the append-only correction demonstration); the model prices verify
  against the VAL-040 `PRICE_MANIFEST` registry; currency conversion
  rides the VAL-040 pinned FX table (the substrate manifest's
  `fxBasis`).
- **No re-running, no re-pricing** — the synthesis derives over the
  RECORDED telemetry; the live row is the only place new measurements
  happen (env-gated, BYOK).

## The verification core (the driver's mechanical oracles)

- `deriveStartupCostInclusion` — a recorded warm-up with a zero (or
  disagreeing) claimed startup share FAILs named; the five-share
  decomposition must RECONSTRUCT (measured = startup + sustained +
  restart + eviction; total = measured + reserved).
- `deriveReadinessProbeHonesty` — first-usable derived from the first
  PASSING probe; inflation, first-dispatched misattribution,
  unbacked readiness and dispatch-before-usable each FAIL named.
- `deriveReservedMeasuredSeparation` — the reserved/measured split
  must be the recorded one; a zeroed reserved share with an absorbed
  measured total (or the reverse) FAILs named.
- `deriveFailureAmortizationCompleteness` — restarts > 0 ⇒ restart
  share > 0; evictions > 0 ⇒ eviction share > 0; claimed-away or
  phantom shares FAIL named.
- `deriveEstimateMeasureSeparation` — the measured basis is exactly
  the recorded one; the planner quote rides separately.
- `deriveConfidenceAndMinimum` + `deriveBelowMinimumRefusalHonesty` —
  Wilson carried, the pre-registered set held (no post-hoc window
  exclusion, no undeclared window), the minimums enforced with the
  honest refusal verdict.
- `deriveSubstrateInputIntegrity` — every window IS the recorded
  telemetry's own derivation (digest + field equality); a
  re-measurement masquerading as derivation FAILs named, field by
  field.
- `deriveSubstrateFamilySynthesis` — the family headline (per-run /
  per-resolved / effective) with the silent-absorption catch on the
  readiness-adjusted family.

## The live lane (honest NOT RUN without the credential)

The live row is env-gated on `OPENROUTER_API_KEY`
(operator-authorized, BYOK, measured — never fabricated). Without the
credential the row is honestly **NOT RUN**; with it, the crown drives
one REAL substrate lifecycle over the REAL process substrate — cold
start, readiness probes to FIRST-USABLE, three REAL workload units
(each a real substrate execution riding ONE REAL model dispatch on the
pinned OpenRouter rail at the pinned manifest revision, max_tokens 32
pinned explicitly, temperature unset per the provider's documented
default; the empty-completion 200 is honest SUCCESS — the VAL-014
rule; the provider envelope's code token wins over the raw HTTP
status), teardown — with the families computed over MEASURED facts and
the verdict recorded through the REAL recorder.

## Boundaries

- This app imports the VAL-040 substrate (`../economic-baseline/**`),
  the VAL-044 adjusted-cost derivations and corpora
  (`../economic-adjusted-cost/**`), the VAL-022 substrate records
  (`../substrate-failure/**` — the reliability provenance) and the
  validation harness; it never modifies them and never touches `src/**`
  or `platform/**`.
- `config.json` is generated from the exported task slice
  (secret-free, repository-reproducible).
- Evidence carries payload DIGESTS only — never payload bytes.
