# VAL-047 — Economic Longitudinal Cost Curve

The longitudinal cost-curve slice: how unit economics IMPROVE (or fail
to) over sustained operation — cost-per-successful-outcome as a
function of accumulated operation per workload class, the
improvement-rate decomposition reconciled EXACTLY against the VAL-045
attribution, and the honest plateau-maturity verdict.

## The curve families

| family | derives |
| --- | --- |
| `cost-per-outcome-trajectory` | the per-generation cost per successful outcome ((recorded model cost + recorded substrate overhead) / recorded successful outcomes) over the declared window, every point carrying its run identity, its pinned price revisions and the Wilson 95% on the pooled outcome rate |
| `improvement-rate-decomposition` | which mechanisms drove which delta: per generation the measured delta decomposes EXACTLY into VAL-045 attributed mechanisms + substrate savings + the honest residual |
| `plateau-maturity-verdict` | the honest classification (improving / plateaued / never-materialized / mixed-cohort-regressing) over the pinned thresholds (last-window rate < 0.02 → plateaued; no positive delta ever → never-materialized; any regressing cohort → mixed) |

## The corpus (13 rows)

| row | class | family | expected verdict |
| --- | --- | --- | --- |
| `invoice-extraction-cost-per-outcome-trajectory` | invoice-extraction | trajectory | trajectory-improving (a MARKED model price-regime change at g2: rev-001 → rev-002) |
| `code-search-plateau-maturity-verdict` | code-search | plateau | trajectory-plateaued (savings through g3, then the campaign honestly ended — g4/g5 flat, empty attribution) |
| `tool-routing-never-materialized` | tool-routing | plateau | never-materialized (no savings ever recorded — the flat curve) |
| `rag-retrieval-improvement-rate-decomposition` | rag-retrieval | decomposition | mixed-cohort-regressing (the deterministicization cohort's attributed savings honestly regressed 120 → 40 at g2 — reported as regressing) |
| `probe-cherry-picked-window` | code-search | plateau | FAILS `window-honesty` (the declared window [3,5] hides the recorded improving generations 0..2) |
| `probe-regime-normalizing` | invoice-extraction | trajectory | FAILS `price-regime-marking` (the post-change points claimed at rev-001; the regime change normalized away) |
| `probe-extrapolating` | invoice-extraction | trajectory | FAILS `no-extrapolation` (a fabricated generation-4 point beyond the recorded evidence) |
| `probe-residual-hiding` | rag-retrieval | decomposition | FAILS `improvement-rate-reconciliation` (claimed residual 0 vs the recorded 30/30/35 — both sides named) |
| `probe-cohort-hiding` | rag-retrieval | decomposition | FAILS `cohort-honesty` (the regressing cohort reported as improving) |
| `probe-post-hoc-exclusion` | code-search | trajectory | FAILS `confidence-and-minimum` (the pre-registered g4 point dropped from the executed set) |
| `probe-sample-size-violation` | text-summarization | trajectory | FAILS `below-minimum-refusal-honesty` (a 2-generation sample claiming a verdict — the honest outcome is the refusal) |
| `probe-remeasurement-masquerade` | invoice-extraction | trajectory | FAILS `curve-input-integrity` (a re-measured model cost field-by-field against the recorded digest) |
| `live-longitudinal-curve-real-slice` | live slice | trajectory | env-gated on `OPENROUTER_API_KEY` — honestly NOT RUN without the credential |

## The mechanical verification core (per row)

`window-honesty` (the declared window matches the recorded ledger's
span — cherry-picking FAILs with the omitted generations named) ·
`price-regime-marking` (every point's pinned revisions verified against
the VAL-040 + VAL-046 manifests; every actual change MARKED —
normalizing one away FAILs named) · `no-extrapolation` (a point beyond
the recorded evidence FAILs and is named) ·
`improvement-rate-reconciliation` (attributed + substrate + residual =
the measured delta, EXACTLY — both sides named on failure) ·
`cohort-honesty` (a regressing cohort reported as regressing) ·
`estimate-measure-separation` (measured basis only; quotes ride
separately) · `confidence-and-minimum` (Wilson 95%, the pinned
minimums, no post-hoc exclusions — the pre-registered window decides) ·
`below-minimum-refusal-honesty` (a starved sample refuses, never
fabricates) · `curve-input-integrity` (digest-verified RECORDED inputs;
a re-measurement masquerade FAILs field by field) · the ledger
discipline + the observed-terminal read-back.

## Boundaries

- Digest-only evidence: recorded results are referenced by content
  digest (never copied, never re-run, never re-priced — pure
  derivation over RECORDED results).
- The live row is honestly NOT RUN without the operator-authorized
  `OPENROUTER_API_KEY` (BYOK, measured usage, max_tokens 32 pinned,
  temperature unset per the provider's documented default).
- Zero credentials in the repository; usage honestly none-reported
  offline (the recorded ledgers' own facts — never freshly measured).
- The app rides the public SDK boundary (`runCurveApp`) with a
  repository-reproducible, secret-free `config.json`.
