# Savings-Attribution Application (VAL-045)

A customer-style attribution application: one pinned attribution
corpus row per run, attributing the measured savings of the
determinization lifecycle to their MECHANISMS — per workload family,
per promotion generation: which savings came from REUSE (the
cross-workload shape candidates), which from CACHE (the stable
input→output transforms), which from COMPETENCE (the recurring
step-pattern tools), which from DETERMINISTICIZATION (the displaced
model rounds) — over the RECORDED ECONOMICS (VAL-044's
quality/latency/failure-adjusted cost model — the recorded incumbent
baselines the mechanisms displaced) and the RECORDED LIFECYCLE
HISTORY (VAL-030..036's lifecycle records, promotion generations,
accounting ledgers and maturity reports — the READ-ONLY input), with
the UNATTRIBUTED RESIDUAL reported honestly (never forced into a
mechanism), through Zeck's public SDK boundary.

## The oracle (the PURE derivations)

Every attribution claim must pass the mechanical attribution oracle
(`benchmarks/validation/platform/savings-attribution.ts`):

- **evidence citation** — every claim cites its FULL evidence
  population (the exact ledger entries, lifecycle records and cost
  measurements it attributes from); an uncited claim, a phantom
  citation or a partial population FAILs named;
- **no double count** — each ledger entry attributed to AT MOST ONE
  mechanism; a double-count FAILs with both claims named;
- **residual honesty** — the unattributed residual REPORTED, never
  forced into a mechanism (a claim exceeding its cited evidence FAILs
  with the excess named; a hidden or inflated residual FAILs named);
- **reconciliation** — attributed (per mechanism, summed) + the honest
  residual EQUAL the recorded total savings per family per generation
  (a non-reconciling attribution FAILs with both sides named);
- **counterfactual fidelity** — each mechanism's savings measured
  against the RECORDED incumbent baseline per VAL-044's adjusted
  model (an unstated, swapped or hypothetical baseline FAILs named);
- **generation-series integrity** — the attribution's generation
  series matches VAL-036's recorded maturity curves (a gapped or
  mismatched series FAILs named).

## The pinned corpus (`savings-attribution.mechanism-split.v1`)

| Row | Workload family | Expected attribution |
|---|---|---|
| rag-retrieval-all-mechanisms-attributed | rag-retrieval (3 generations) | **all four mechanisms + a residual (COMPLETED)** — reuse 80 / cache 100 / competence 60 / deterministicization 160 micro-USD attributed, 95 residual |
| text-summarization-large-honest-residual | text-summarization (2 generations) | **large honest residual (COMPLETED)** — 90 attributed vs 320 residual (78% honestly unattributed, never forced) |
| code-search-cache-dominant | code-search (3 generations) | **cache-dominant (COMPLETED)** — cache 330 of 375 attributed micro-USD |
| invoice-extraction-reuse-dominant | invoice-extraction (3 generations) | **reuse-dominant (COMPLETED)** — reuse 280 of 325 attributed micro-USD |
| translation-glossary-deterministicization-dominant | translation-glossary (3 generations) | **deterministicization-dominant (COMPLETED)** — 315 of 350 attributed micro-USD from the displaced model rounds |
| probe-uncited-claim | rag-retrieval | the honest row cites its FULL population; the phase-2 adversarial variant drops a recorded member (or cites a phantom) and FAILs |
| probe-double-count | code-search | the honest row attributes each entry to exactly one mechanism; the phase-2 adversarial variant double-counts an entry and FAILs with both claims named |
| probe-forced-residual | text-summarization | the honest row reports its large residual; the phase-2 adversarial variant forces the residual into a mechanism and FAILs |
| probe-swapped-baseline | invoice-extraction | the honest row measures each claim against its OWN recorded incumbent baseline; the phase-2 adversarial variant swaps the baseline and FAILs with both sides named |
| probe-gapped-series | translation-glossary | the honest row's series matches VAL-036's curves; the phase-2 adversarial variant drops a generation and FAILs |
| unrecorded-family-attribution-refusal | phantom-family | **honest refusal** (`family-unrecorded`) — nothing recorded, nothing attributed, nothing landed |
| no-savings-family-attribution-refusal | tool-routing | **honest refusal** (`no-savings-recorded`) — lifecycle + generations recorded, savings never recorded; never a fabricated split |
| rag-retrieval-attribution-live | rag-retrieval | the env-gated LIVE row (OPENROUTER_API_KEY) — the REAL measured round; honestly NOT RUN when the credential is absent |

## Running

The offline rows are deterministic (digest-only evidence, no
credentials, no network): the fixtures pre-seed the recorded
economics + history read-only and the report ledger is append-only.
The live row runs only when `OPENROUTER_API_KEY` is present (measured
usage; honest NOT RUN boundary otherwise — never fabricated).

The application rides the PUBLIC SDK boundary exclusively
(`import { createZeckClient } from "../../../../sdk"` — never
`src/**`), re-deriving the attribution contract at the boundary
through the platform slice's PURE
`verifySavingsAttributionAppContract`: the attributed-split read-back,
the boundary re-derivation of the reconciliation identity over the
read-back numbers, the residual read-back honesty, the report
landing, the own dispatches and the refusal read-back.
