# Shadow-Execution Application (VAL-034)

A customer-style shadow application: one pinned shadow corpus row per
run, shadowing VAL-033's DIFFERENTIALLY-EVALUATED candidates (the
lifecycle identities whose recorded walk already ends at
`differentially-evaluated` — the read-only input) through Zeck's
public SDK boundary — the deterministic replacement executed IN THE
SHADOW beside the incumbent over the recorded traffic mix (VAL-031's
recorded replay populations plus the pinned injected traffic probes),
the customer ALWAYS served the incumbent's outcome (the served-source
pin — the shadow is observation-only), the regression comparison
recorded PER CASE with both sides' digests (never smoothed, never
aggregated away), the shadow's measured cost booked to the shadow
ledger APART from the served accounting (the customer is never billed
for the shadow), and the verified shadow appending its SINGLE
`shadow-executed` transition to the candidate lifecycle (canary and
promotion are VAL-035's acts, never this app's).

Per row, the corpus declares the shadowed candidate (the VAL-033
differentially-evaluated lifecycle identity), the replacement shape
carried over from the differential evaluation (with its granted
isolation surface — the containment carry-over), the traffic
population (the workload mix the shadow replays), the explicit
comparison criterion (the regression agreement basis) and the expected
shadow comparison (the shadow agreement, the honest divergence with
its divergent cases pinned case-by-case, the honest refusal — or the
probe rows whose adversarial variants FAIL in the later
discrimination phases).

## The pinned corpus (`shadow-execution.regression.v1`)

| Row | Shadowed candidate (VAL-033 landing) | Shadow shape | Criterion | Expected shadow comparison |
|---|---|---|---|---|
| rag-deterministic-function-shadow-agreement | RAG deterministicization (N=4) | deterministic-function (pure-computation) | exact-digest-equality | **shadow-agreement** — the shadow reproduces the incumbent digest on every case (4 recorded + 2 injected probes); the customer is served the incumbent's outcome throughout |
| text-summarize-split-preprocessing-shadow-agreement | text-summarize deterministicization (N=5) | split-preprocessing-residual | digest-class-equality | **shadow-agreement** — the shadow digest is a member of each case's pinned class |
| order-settlement-retrieval-shadow-agreement | order-settlement cache (N=4, honestly varying) | retrieval-pipeline | digest-class-equality | **shadow-agreement** — equality is NOT required for semantic outputs: the retrieval's answer is a class member even where it is not the incumbent's own member |
| tool-loop-reusable-tool-shadow-tolerance | tool-agent competence (N=3) | reusable-tool | per-case-tolerance | **shadow-agreement** — historical cases demand digest identity; the injected probes are the explicitly tolerated divergence set |
| reuse-removed-call-shadow-honest-divergence | cross-workload reuse (N=8) | removed-call (granted surface EMPTY) | exact-digest-equality | **honest divergence (FAILED)** — the removal diverges on every case BY CONSTRUCTION; all 10 divergences recorded case-by-case with both digests, never smoothed; the shadow still lands its stage transition |
| unregistered-candidate-shadow-refusal | a PHANTOM identity (never a registry member) | deterministic-function | exact-digest-equality | **honest refusal** (`candidate-unregistered`) — no candidate, no traffic, nothing lands |
| premature-candidate-shadow-refusal | the single-replay degenerate entry (walk NEVER started) | deterministic-function | exact-digest-equality | **honest refusal** (`candidate-not-differentially-evaluated`) — a premature shadow refuses honestly |
| probe-leaked-outcome | RAG deterministicization (N=4) | deterministic-function | exact-digest-equality | pass over the honest world; the `leaked-outcome` hook (the LEAKY serving path serves the replacement's outcome — FAILs with the leak named) |
| probe-dropped-case | RAG deterministicization (N=4) | deterministic-function | exact-digest-equality | pass over the honest world; the `dropped-case` hook (the DROPPED/DUPLICATED/MIXED-UP traffic sources — FAILs) |
| probe-smoothed-aggregate | RAG deterministicization (N=4) | deterministic-function | exact-digest-equality | pass over the honest world; the `smoothed-aggregate` hook (AGGREGATE-ONLY / SUBSET-COMPARED / SMOOTHING runtimes — FAILs) |
| probe-billed-shadow | RAG deterministicization (N=4) | deterministic-function | exact-digest-equality | pass over the honest world; the `billed-shadow` hook (the DOUBLE-BOOKING cost ledger bills the served rails — FAILs) |
| probe-skipped-stage | RAG deterministicization (N=4) | deterministic-function | exact-digest-equality | pass over the honest world; the `skipped-stage` hook (SKIP-TO-CANARIED / WRONG-STAGE / EVIDENCE-LESS / REWRITE-REGISTRY ledgers — FAILs) |
| probe-mid-shadow-escape | RAG deterministicization (N=4) | deterministic-function | exact-digest-equality | pass over the honest world; the `mid-shadow-escape` hook (the ESCAPING runtime exercises network access DURING the shadow — FAILs) |

## Live rail row (env-gated; driven by the operator-authorized credentials)

| Row | Gate | REAL demand | Expected |
|---|---|---|---|
| live-split-preprocessing-shadow-confirmation | `OPENROUTER_API_KEY` | ONE REAL residual-AI model round through the REAL platform model gateway before the shadow transition appends to the candidate lifecycle (measured usage, never estimated, never fabricated) | COMPLETED; a digest-class-equality shadow agreement over the two cited live replay inputs + the injected probes; usage measured; the shadow cost booked to the shadow ledger |

## Pinned policies

- **Serving isolation (the served-source pin)**: the customer-facing
  outcome is ALWAYS the incumbent's. A served outcome sourced from the
  replacement (an explicit leak) or a served digest that is the
  shadow's own under a claimed incumbent source (a disguised leak)
  FAILs mechanically with the leak named — the shadow is
  observation-only, never a serving source.
- **Population completeness**: the shadow comparison covers the FULL
  recorded traffic population — the workload mix the row replays. A
  dropped case, a duplicated case, a foreign case or a mix whose
  per-class counts differ from the recorded mix each FAIL
  mechanically.
- **Regression honesty**: the evidence is PER-CASE — every traffic
  case holds a comparison record with both sides' digests. An asserted
  aggregate without the per-case records FAILs; an asserted agreement
  from a subset FAILs; a divergent case claimed agreeing (a smoothed
  divergence) FAILs; an agreeing case claimed diverging (a false
  divergence) FAILs. An honest divergence FAILs the row honestly —
  recorded case-by-case, never smoothed — while the shadow still lands
  its stage transition (the comparison IS the record).
- **Cost separation**: the shadow's measured cost is booked to the
  SHADOW cost ledger, never the served accounting — the customer is
  never billed for the shadow. A served total inflated by the shadow
  cost FAILs with the billed delta named; an unmeasured or unbooked
  shadow cost FAILs.
- **Stage discipline**: the shadow run APPENDS the SINGLE
  `shadow-executed` transition to the candidate's recorded walk — each
  transition evidenced, NEVER a stage past shadow-executed
  (canary/promotion are VAL-035's scope; a skipped-stage advance FAILs
  mechanically), never a wrong-stage landing, never evidence-less. A
  candidate not yet differentially-evaluated refuses honestly.
- **Containment carry-over**: the replacement still runs inside its
  granted isolation surface DURING the shadow — an escape mid-shadow
  is a containment violation that FAILs and is recorded (network
  access, platform state mutation, credential access and
  tenant-boundary crossing are the pinned escape directions).
- **Read-only inputs**: the candidate registry's EXISTING entries
  (VAL-032's proposals) and the lifecycle's RECORDED VAL-033 walk are
  read-only inputs — the shadow run APPENDS its transition, it never
  rewrites history; a registry whose digest changes over a run FAILs
  mechanically.
- **Accounting honesty**: the offline rows dispatch no model at all
  (usage honestly none-reported offline); the live row's residual-AI
  round is REAL and measured; latency is always measured (the shadow's
  latency measured separately from the served accounting's); evidence
  carries payload DIGESTS, never payload bytes.

## Boundaries

- Integrates ONLY through the public SDK (`sdk/` — the validation
  harness rides the same boundary); never Zeck internals (`src/**` is
  never imported by the application); never selects
  provider/model/rail (the task references the corpus row; the
  platform derives the route).
- The offline rows need NO provider at all — the shadow comparison
  semantics are digest-level over the recorded populations.
- The live row is env-gated on `OPENROUTER_API_KEY` and is skipped
  (recorded NOT RUN) when the operator credential is absent.

## Run entry points

- Unit (offline, deterministic): `bunx vitest run
  tests/unit/validation/val-034-platform.test.ts`
- The exported task slice (`SHADOW_EXECUTION_TASKS` in
  `application.ts`) mirrors `config.json` — the consistency tests pin
  the pair; the integration harness (phase 3) drives the live row
  over the REAL platform path with the operator-authorized credential.
