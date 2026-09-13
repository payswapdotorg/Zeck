# Learning-Discovery Application (VAL-032)

A customer-style discovery application: one pinned discovery corpus
row per run, mining VAL-031's RECORDED replay populations (the
read-only replay-ledger input) for LEARNABLE structure through Zeck's
public SDK boundary, and recording every discovery as a PROPOSAL in
the deterministicization lifecycle's candidate registry — never as an
applied change (discovery proposes; application is VAL-033+'s scope).

Per row, the corpus declares the mined evidence population (the
recorded trajectory digests + replay identities from VAL-031's ledger
vocabulary — digests only, never payload bytes, never a rewritten
recorded fact), the candidate kind the discovery question targets
(reuse / cache / competence / deterministicization) and the expected
proposal the discovery derivation must emit (or the honest refusal it
must report).

## The pinned corpus (`learning-discovery.proposal.v1`)

| Row | VAL-031 populations mined | Question | Expected outcome |
|---|---|---|---|
| cross-workload-reuse-candidate | text-summarize (N=5) + research-digest (N=3) | reuse | REUSE proposal — the same one-round sub-trajectory shape recurs across both workloads; cites the FULL 8-replay population |
| order-settlement-cache-candidate | order-settlement varying (N=4) | cache | CACHE proposal — the input→output transformation is stable across replays even though the trajectories honestly vary |
| tool-loop-competence-candidate | tool-agent loop (N=3) | competence | COMPETENCE proposal — the three-round loop step-pattern recurs across every replay |
| rag-retrieval-deterministicization-candidate | RAG corrected r2 (N=4) | deterministicization | DETERMINISTICIZATION proposal — every replay reproduces the identical trajectory digest (a stable, determinizable segment); cites all 4 replays |
| order-settlement-varying-refusal | order-settlement varying (N=4) | deterministicization | **honest refusal** (`varying-population`) — the population honestly reproduces TWO distinct digests; a varying segment is never proposed |
| oversized-batch-guard-refusal | oversized-batch guard (N=3) | deterministicization | **honest refusal** (`no-dispatched-work`) — a guard-rejected population holds no AI execution subgraph to learn from |
| probe-uncited-proposal | RAG corrected r2 (N=4) | deterministicization | proposal over the honest miner; the `uncited-proposal` hook (the UNCITED miner's empty citation FAILs) |
| probe-partial-population | RAG corrected r2 (N=4) | deterministicization | proposal over the honest miner; the `partial-population` hook (a citation of 3 of 4 replays FAILs) |
| probe-fabricated-citation | RAG corrected r2 (N=4) | deterministicization | proposal over the honest miner; the `fabricated-citation` hook (a phantom digest/identity FAILs) |
| probe-variance-smoothing | order-settlement varying (N=4) | deterministicization | refusal over the honest miner; the `variance-smoothing` hook (a deterministicization proposal over the variance FAILs) |
| probe-state-mutation | text-summarize + research-digest (N=8) | reuse | proposal over the honest registry; the `state-mutation` hook (a recording that mutates frozen state, or a promoted candidate, FAILs) |

## Live rail row (env-gated; driven by the Lead's authorized credentials)

| Row | Gate | REAL demand | Expected |
|---|---|---|---|
| live-discovery-confirmation | `OPENROUTER_API_KEY` | ONE REAL model confirmation round through the REAL platform model gateway before the proposal lands in the REAL candidate registry (measured usage, never estimated, never fabricated) | COMPLETED; a deterministicization proposal citing both recorded live replays; usage measured |

## Pinned policies

- **Propose-only scope**: discovery PROPOSES — every proposal lands
  in the candidate registry at the `proposed` lifecycle stage (the
  deterministicization contract's ladder: observe → characterize →
  propose → … → promotion). A proposal recorded past `proposed`, a
  registry holding applied candidates, or a recording that mutates
  ANY frozen state (the recorded populations, the frozen manifests, a
  workload) FAILs the no-application discipline mechanically.
- **Evidence-citation completeness**: every cited trajectory digest
  and replay identity is a MEMBER of the recorded population, and
  every generalization cites its FULL population — an uncited
  proposal, a partial-population citation and a fabricated citation
  each FAIL mechanically; a single-observation population is not
  evidence for a generalization.
- **Candidate-kind fidelity**: the proposal's kind matches the mined
  structure (repeated sub-trajectory shapes ⇒ reuse, stable
  input→output digests ⇒ cache, recurring competence step-patterns ⇒
  competence, stable-across-replays segments ⇒ deterministicization)
  and the proposal cites the structure the mining actually derived.
- **Conservatism**: a varying segment — VAL-031's honestly-reported
  variance — is NEVER proposed as a deterministicization candidate; a
  variance-smoothing proposal FAILs mechanically. A cache candidate
  over legitimately-varying trajectories is real structure, not
  smoothing.
- **Read-only inputs**: VAL-031's recorded replay populations and
  VAL-030's frozen manifests are read-only inputs — referenced by
  digest, never copied, never rewritten; a discovery run whose served
  population mismatches the pin FAILs.
- **Accounting honesty**: the discovery's own dispatches are zero
  offline (the mining is ledger-level) and ONE measured REAL
  confirmation round on the live rail; usage is measured on the live
  rail and honestly none-reported offline; latency is always measured;
  evidence carries payload DIGESTS, never payload bytes.

## Boundaries

- Integrates ONLY through the public SDK (`sdk/` — the validation
  harness rides the same boundary); never Zeck internals
  (`src/**` is never imported by the application); never selects
  provider/model/rail (the task references the corpus row; the
  platform derives the route).
- The offline rows need NO provider at all — the discovery semantics
  are ledger-level (the read-only population read, the pure mining,
  the registry recording).
- The live row is env-gated on `OPENROUTER_API_KEY` and is skipped
  (recorded NOT RUN) when the operator credential is absent.

## Run entry points

- Unit (offline, deterministic): `bunx vitest run
  tests/unit/validation/val-032-platform.test.ts
  tests/unit/validation/val-032-apps.test.ts`
- App battery over the fake world: the `VAL-032 app over the honest
  fake world` suite drives every offline row end to end through the
  SDK boundary against the deterministic fake transport.
- The exported task slice (`LEARNING_DISCOVERY_TASKS` in
  `application.ts`) mirrors `config.json` — the consistency tests pin
  the pair; the integration harness (phase 3) drives the live row
  over the REAL platform path with the operator-authorized credential.
