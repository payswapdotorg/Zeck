# Economic-Controls-Optimized Application (VAL-042)

A customer-style economics application: one pinned optimized-baseline
corpus row per run, submitted through Zeck's public SDK boundary,
delivering the STRONG OPTIMIZED NON-ZECK baseline arm of the economic
validation wave — the best honest engineering a customer could do
WITHOUT Zeck, so the economic comparison is against the STRONGEST
realistic alternative, not a strawman.

## The optimized stack (the declared optimization inventory)

The baseline's optimization set is EXPLICIT, EXHAUSTIVE and
CONTENT-ADDRESSED (alongside the VAL-040 pinned price manifests):
`optimizations.ts` pins the inventory registry — each optimization
named, bounded and priced through the pinned manifests. `opt-rev-001`
declares:

- **model-routing-by-task-class** — each task class rides its own
  explicitly routed rail (summarize → retry-relay, extract →
  openrouter, transform-batch → batch-relay; every rail priced
  through the pinned manifest rev-001);
- **prompt-compression** — the dispatched payload is a bounded
  compression of the raw payload (ratio within [0.25, 0.75] of
  opt-rev-001; **[0.25, 0.70] of the corrected opt-rev-002** — the
  bound-tightening correction is a NEW revision, append-only);
- **response-cache-semantically-safe** — the cache keys on the
  (task class, content digest) identity; a `fresh-only` task is NEVER
  served from the cache (mechanically); a cache hit contributes ZERO
  new measured cost;
- **batched-throughput** — adjacent same-class rounds coalesce onto
  the batched rail;
- **provider-side-batch-pricing** — the provider-side batched metering
  feature priced through the manifest's own batched entries.

The inventory-conformance oracle FAILs any run where the baseline
applies an optimization the inventory does not name (the
undeclared-optimization masquerade catch); the inventory-integrity
oracle FAILs an in-place bound mutation (the digest disagreement
catch); the cache-safety oracle FAILs an unsafe reuse across a
fresh-only round; the routing-conformance oracle FAILs a misrouted
round; the compression-bound oracle FAILs a dispatched ratio outside
the declared bound; the replay-fidelity oracle FAILs an understated
token count.

## The experiment protocol

Every run executes the FROZEN VAL-040 protocol: the arms declare
their kind (fixed-quality / fixed-cost), the pinned price revision,
the pre-registered corpus slice and the statistical minimums; every
comparison carries the Wilson 95% interval; threshold attainment is
recomputed from the accounted runs; the budget gate decides BEFORE
dispatch (the per-round bound is the worst case over EVERY routed
rail); budget exhaustion is an honest declared prefix stop. The
usage facts price per-fact through the ROUTED rail — the canonical
micro-USD-per-resolved-outcome basis normalizes the mixed-rail
economics exactly.

## The pinned corpus (`economic-controls-optimized.experiment.v1`)

| Row | Arm | Optimization surface | Expected |
|---|---|---|---|
| fixed-quality-optimized-routing-cache-amortized | fq-optimized-routing (0.75, 8) | 3 routed classes + 1 retry-amortized round + 2 cache hits | COMPLETED; 8/8; cpr 69 µ$ (6 dispatches' measured cost amortized over 8 resolved) |
| fixed-quality-optimized-prompt-compression | fq-optimized-compression (0.75, 6) | every round compressed within the corrected opt-rev-002 bound | COMPLETED; 6/6; cpr 22 µ$ |
| fixed-quality-optimized-batch-throughput | fq-optimized-batch (0.75, 6) | the batched rail's ceil-to-batch metering on uneven counts | COMPLETED; 6/6; cpr 207 µ$ |
| fixed-cost-optimized-cache-budget-stretch | fc-optimized-stretch (61 µ$, 8, min 5) | the cache stretches the budget: 5 dispatches + 3 hits complete the FULL slice | COMPLETED; 7/8; cpr 6 µ$ |
| fixed-cost-optimized-budget-exhausted-honest-stop | fc-optimized-stop (70 µ$, 8, min 3) | the pinned round bound (25 µ$) stops after 3 rounds — the declared prefix stop | COMPLETED; 2/3; cpr 30 µ$ |
| zero-resolved-optimized-null-discipline | fc-optimized-zero (200 µ$, 6) | every fresh dispatch fails honestly | COMPLETED; 0/6 resolved; **costPerResolved NULL** |
| fresh-only-optimized-cache-inert | fq-optimized-fresh-only (0.75, 6) | the collision pairs: fresh-only rounds NEVER served from the active cache | COMPLETED; 6/6; 0 cache hits; cpr 9 µ$ |

Every offline row references the FROZEN app portfolio (the VAL-030
baseline revisions) by CONTENT DIGEST (never copied) and replays
DETERMINISTICALLY from the repository (recorded VAL-006-style
accounting rounds + the deterministic cache simulation — zero
credentials, zero network).

## Live rail rows (env-gated; driven by the Lead's authorized credentials)

| Row | Gate | REAL demand | Expected |
|---|---|---|---|
| live-fixed-quality-optimized-real-dispatch | `OPENROUTER_API_KEY` | 3 REAL compressed dispatches through the routed pinned model + 1 REAL cache hit (the duplicate content replays the cached REAL response) + 1 fresh-only collision dispatch | COMPLETED; measured usage; Wilson carried |
| live-fixed-cost-optimized-real-budget | `OPENROUTER_API_KEY` | the 600 µ$ REAL budget gates 4 REAL fresh-only dispatches | COMPLETED; measured usage; quality-attained within budget |

The live rail's pinned model is `meta-llama/llama-3.3-70b-instruct`
(the manifest's openrouter entry — the arm's pricing basis). ONE
dispatch binding (one registered connection) serves ALL live rows of
a run — the VAL-025 live-run lesson.

## Boundaries

- Integrates ONLY through the public SDK; the slice never imports
  `src/**`; the pricing oracle, the accounting rails and the protocol
  derivations are IMPORTED from the VAL-040 delivery (never copied,
  never modified).
- Evidence carries payload DIGESTS, never payload bytes; usage is
  measured on the live rail and honestly source-labeled
  replayed-record offline; latency measured.
- Configuration is repository-reproducible and secret-free
  (`config.json` mirrors the exported task slice); the single secret
  is the environment token (`ZECK_VALIDATION_TOKEN`), and the live
  rows' credential is env-gated (`OPENROUTER_API_KEY`).

## Run

Executed by the validation suites: the unit battery
(`tests/unit/validation/val-042-baseline.test.ts` over the REAL
derivations + the deterministic driver stack, and
`tests/unit/validation/val-042-apps.test.ts` over the fake API world),
the discrimination battery
(`tests/discrimination/optimized-baseline-validation.discrimination.test.ts`),
with the REAL end-to-end integration run in the validation
integration suite (drives the pinned corpus over the REAL platform
path; the live rows env-gated).
