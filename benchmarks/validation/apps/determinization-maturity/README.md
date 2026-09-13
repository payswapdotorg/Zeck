# Determinization-Maturity Application (VAL-036)

A customer-style longitudinal-maturity application: one pinned
maturity corpus row per run, analyzing the workload portfolio's
determinization MATURITY over the RECORDED lifecycle history
(VAL-032..035's promoted candidate walks, per-generation measured
facts and accounting ledgers — the READ-ONLY input) through Zeck's
public SDK boundary — the learning-curve analysis across the PROMOTION
GENERATIONS (per-generation model-call reduction, MEASURED
cost/latency deltas, per-mechanism displacement counts over the
CANDIDATE_KINDS vocabulary: reuse / cache / competence /
deterministicization), the per-mechanism savings RECONCILED against
the recorded accounting ledgers, and the honest MATURITY
CLASSIFICATION per workload family: determinized-stable /
determinizing-trending / variable-resilient /
immature-insufficient-evidence — a trend claim from insufficient
evidence FAILs mechanically (the family is classified immature,
never stretched).

## The pinned corpus (`determinization-maturity.learning-curve.v1`)

| Row | Workload family | Expected maturity classification |
|---|---|---|
| rag-retrieval-determinized-stable | rag-retrieval (4 generations) | **determinized-stable (COMPLETED)** — full displacement + zero model-call variance across the stability window |
| text-summarization-determinizing-trending | text-summarization (4 generations) | **determinizing-trending (COMPLETED)** — monotone displacement growth (2→4→6→8) |
| order-settlement-variable-resilient | order-settlement (4 generations) | **variable-resilient (COMPLETED)** — recurring variance (5→3→6→2), reported honestly |
| support-triage-immature-insufficient-evidence | support-triage (2 generations) | **immature-insufficient-evidence (COMPLETED)** — below the pinned minimum; never stretched into a trend |
| probe-uncited-claim | rag-retrieval | the honest row cites its FULL population; the phase-2 adversarial variant drops a recorded member and FAILs |
| probe-gapped-series | text-summarization | the honest row's series is gapless; the phase-2 adversarial variants (a dropped generation; an extrapolated point) FAIL |
| probe-misclassified-family | order-settlement | the honest row claims variable-resilient (the observed data); the phase-2 adversarial variant claims determinized-stable and FAILs |
| probe-unreconciled-savings | rag-retrieval | the honest row's per-mechanism savings match the ledgers; the phase-2 adversarial variants (aggregate-only; a mismatched number) FAIL |
| probe-insufficient-evidence-trend | support-triage | the honest row claims immature; the phase-2 adversarial variant claims a trend and FAILs |
| unrecorded-family-maturity-refusal | phantom-family | **honest refusal** (`family-unrecorded`) — nothing recorded, nothing analyzed, nothing landed |
| no-generations-family-maturity-refusal | tool-routing | **honest refusal** (`no-generations-recorded`) — promoted candidates recorded, generations never measured |
| rag-retrieval-maturity-live | rag-retrieval | the env-gated LIVE row (OPENROUTER_API_KEY) — the REAL measured round; honestly NOT RUN when the credential is absent |

## Running

The offline rows are deterministic (digest-only evidence, no
credentials, no network): the fixtures pre-seed the recorded history
read-only and the report ledger is append-only. The live row runs
only when `OPENROUTER_API_KEY` is present (measured usage; honest
NOT RUN boundary otherwise — never fabricated).

The application rides the PUBLIC SDK boundary exclusively
(`import { createZeckClient } from "../../../../sdk"` — never
`src/**`), re-deriving the maturity contract at the boundary through
the platform slice's PURE `verifyDeterminizationMaturityAppContract`:
the classification read-back + the boundary re-derivation of the
classification fidelity, the curve-series integrity, the savings
reconciliation, the report landing, the own dispatches and the
refusal read-back.
