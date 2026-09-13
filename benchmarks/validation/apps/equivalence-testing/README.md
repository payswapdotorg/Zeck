# Equivalence-Testing Application (VAL-033)

A customer-style equivalence application: one pinned equivalence
corpus row per run, testing VAL-032's PROPOSED candidates (the
read-only candidate registry entries) through Zeck's public SDK
boundary — the proposal's deterministic replacement generated as
ISOLATED untrusted code (its granted isolation surface pinned), the
DIFFERENTIAL evaluation driven over the proposal's cited historical
replay inputs (VAL-031's recorded ledger identities) plus the pinned
adversarial cases with both sides' outcomes digest-recorded, and the
equivalence verdict recorded with an EXPLICIT, mechanically verified
acceptance criterion — appending the verdict to the candidate
lifecycle (the equivalence stage ONLY: shadow, canary and promotion
are VAL-034/035's acts, never this app's).

Per row, the corpus declares the source proposal (the VAL-032
registry identity it tests), the replacement shape (with its declared
capabilities and granted isolation surface), the differential
population (the cited historical replay inputs + the pinned
adversarial cases), the explicit acceptance criterion
(exact-digest-equality / digest-class-equality / per-case-tolerance)
and the expected verdict (the equivalence pass, the honest divergence,
the honest refusal — or the probe rows whose adversarial variants
FAIL in the later discrimination phases).

## The pinned corpus (`equivalence-testing.verdict.v1`)

| Row | Source proposal (VAL-032) | Replacement shape | Criterion | Expected verdict |
|---|---|---|---|---|
| rag-deterministic-function-exact | RAG deterministicization (N=4) | deterministic-function (pure-computation) | exact-digest-equality | **equivalence-pass** — the pure function reproduces the incumbent digest on every case (4 historical + 2 adversarial) |
| text-summarize-split-preprocessing-class | text-summarize deterministicization (N=5) | split-preprocessing-residual | digest-class-equality | **equivalence-pass** — the replacement digest is a member of each case's pinned class |
| order-settlement-retrieval-class | order-settlement cache (N=4, honestly varying) | retrieval-pipeline | digest-class-equality | **equivalence-pass** — equality is NOT required for semantic outputs: the retrieval's answer is a class member even where it is not the incumbent's own member |
| tool-loop-reusable-tool-tolerance | tool-agent competence (N=3) | reusable-tool | per-case-tolerance | **equivalence-pass** — historical cases demand digest identity; the adversarial cases are the explicitly tolerated divergence set |
| reuse-removed-call-honest-divergence | cross-workload reuse (N=8) | removed-call (granted surface EMPTY) | exact-digest-equality | **honest divergence (FAILED)** — the removal changes the outcome digest by construction; the divergence is RECORDED case by case, never smoothed |
| unregistered-proposal-refusal | a PHANTOM identity (never a registry member) | deterministic-function | exact-digest-equality | **honest refusal** (`proposal-unregistered`) — the proposal's evidence does not support replacement; nothing executes, nothing lands |
| single-replay-evidence-refusal | the single-replay degenerate registry entry | deterministic-function | exact-digest-equality | **honest refusal** (`proposal-evidence-insufficient`) — one replay is an anecdote, not a population |
| probe-broken-provenance | RAG deterministicization (N=4) | deterministic-function | exact-digest-equality | pass over the honest runtime; the `broken-provenance` hook (the UNCITED runtime's verdict cites no proposal — FAILs) |
| probe-partial-population | RAG deterministicization (N=4) | deterministic-function | exact-digest-equality | pass over the honest runtime; the `partial-population` hook (the PARTIAL runtime drops the pinned adversarial cases — FAILs) |
| probe-unchecked-criterion | RAG deterministicization (N=4) | deterministic-function | exact-digest-equality | pass over the honest runtime; the `unchecked-criterion` hook (the criterion stated but never checked — FAILs) |
| probe-divergence-smoothing | RAG deterministicization (N=4) | deterministic-function | exact-digest-equality | pass over the honest runtime; the `divergence-smoothing` hook (a perturbed case claimed equivalent — FAILs) |
| probe-skipped-stage | RAG deterministicization (N=4) | deterministic-function | exact-digest-equality | pass over the honest runtime; the `skipped-stage` hook (the SKIP-STAGE/LEAKY ledger variants — FAILs) |
| probe-containment-escape | RAG deterministicization (N=4) | deterministic-function | exact-digest-equality | pass over the honest runtime; the `containment-escape` hook (the ESCAPING runtime exercises network access — FAILs) |

## Live rail row (env-gated; driven by the Lead's authorized credentials)

| Row | Gate | REAL demand | Expected |
|---|---|---|---|
| live-split-preprocessing-confirmation | `OPENROUTER_API_KEY` | ONE REAL residual-AI model round through the REAL platform model gateway before the verdict appends to the candidate lifecycle (measured usage, never estimated, never fabricated) | COMPLETED; a digest-class-equality equivalence pass over the two cited live replay inputs + the pinned adversarial cases; usage measured |

## Pinned policies

- **Isolation (the untrusted-code discipline)**: every replacement
  is generated as ISOLATED untrusted code with its granted surface
  pinned — the ALLOWED capability set is pure computation plus
  granted fixture reads, NOTHING else. An undeclared capability
  (network access, platform state mutation, credential access,
  tenant-boundary crossing) is a containment VIOLATION: the escape is
  recorded, never silently forgiven, and the violating verdict never
  lands.
- **Criterion explicitness**: equality is NOT required for semantic
  outputs, but the acceptance criterion must be EXPLICIT and
  mechanically evaluated over EVERY case of the differential
  population. A replacement accepted under an unstated criterion
  FAILs; a criterion stated but never checked (or
  checkable-but-unchecked) FAILs.
- **Divergence honesty**: a differential case where the replacement
  diverges from its stated criterion FAILs and is recorded as an
  honest divergence — case id, incumbent digest, replacement digest —
  never smoothed. A runtime that claims equivalence for a divergent
  case (a smoothed divergence) FAILs on top of the divergence itself.
- **Provenance completeness**: the verdict must cite its source
  proposal (the VAL-032 registry identity) AND the full differential
  population — the historical replay inputs the proposal's own
  citation names PLUS the pinned adversarial cases. An uncited
  verdict, a phantom citation, a missing adversarial case or a subset
  of the cited replay identities each FAIL mechanically.
- **Stage discipline**: the equivalence run APPENDS the walk
  `proposed → offline-replayed → differentially-evaluated` to the
  candidate lifecycle — each transition evidenced, NEVER a stage
  beyond differentially-evaluated (shadow/canary/promotion are
  VAL-034/035's scope; a skipped-stage advance FAILs mechanically).
- **Read-only inputs**: the candidate registry's EXISTING entries
  (VAL-032's proposals) and VAL-031's recorded replay populations are
  read-only inputs — the verdict APPENDS to the lifecycle, it never
  rewrites a proposal; a registry whose digest changes over a run
  FAILs mechanically.
- **Accounting honesty**: the offline rows dispatch no model at all
  (usage honestly none-reported offline); the live row's residual-AI
  round is REAL and measured; latency is always measured; evidence
  carries payload DIGESTS, never payload bytes.

## Boundaries

- Integrates ONLY through the public SDK (`sdk/` — the validation
  harness rides the same boundary); never Zeck internals
  (`src/**` is never imported by the application); never selects
  provider/model/rail (the task references the corpus row; the
  platform derives the route).
- The offline rows need NO provider at all — the differential
  semantics are digest-level over the recorded populations.
- The live row is env-gated on `OPENROUTER_API_KEY` and is skipped
  (recorded NOT RUN) when the operator credential is absent.

## Run entry points

- Unit (offline, deterministic): `bunx vitest run
  tests/unit/validation/val-033-platform.test.ts`
- The exported task slice (`EQUIVALENCE_TESTING_TASKS` in
  `application.ts`) mirrors `config.json` — the consistency tests pin
  the pair; the integration harness (phase 3) drives the live row
  over the REAL platform path with the operator-authorized credential.
