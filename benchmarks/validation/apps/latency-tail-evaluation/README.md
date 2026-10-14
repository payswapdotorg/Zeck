# latency-tail-evaluation (PCL-003)

The P3 program's tail-economics evaluation (ACR-010 §5, work order PCL-003): the evidence that the tail mechanics do what the architecture requires — **per-failure-class p50/p95/p99**, **total cost including duplicate attempts** (verification cost its own line), **resolution rate and verification outcomes per configuration**, and **the promotion gate applied mechanically** (tail percentile improvement AND no resolution regression AND cost within the declared budget delta AND timeout/terminal-failure behavior preserved — median improvement alone promotes nothing), over the honest replay of the PPR-027 capstone's latency cells under the typed-facts configuration.

**Every number this evaluation emits is a fresh synthetic measurement** — synthetic-supply (the capstone's declared deterministic fault/latency profiles, drawn by the transport's own pure hash functions), synthetic-cost (the declared price schedule), synthetic-latency (the drawn deterministic profile plus the declared pacing delays and progress-observation quantization — never wall-clock). No live/credentialed provider runs, no SLA or production-latency claims (live latency validation under real load is the operator-era obligation, never backfilled); a threshold miss with honest attribution is a VALID delivery (the program's truth discipline).

## The two configurations (the pre-registered comparison)

| Arm | Mechanics | Owner |
|---|---|---|
| `baseline-today` | the capstone's own recorded posture, quoted from the PPR-027 machinery (compose.ts's traced defaults): ONE policy retry failing over to the next supply in the round-robin, 5 ms inter-attempt wait, progress polled at the sweep driver's declared compressed 10 ms interval. NO pacing configuration is authored — the PCL-002 plane is absent, exactly the capstone's wired state. | the quoted capstone posture (`experiments/ppr-027/compose.ts` + `driver.ts` defaults, read-only) |
| `tail-tuned-v1` | the PCL-002 declarative tail-pacing configuration ARMED through the pacing seam: bounded jittered exponential retry backoff (max 2 retries), failure-class-aware provider cooldowns with explicit re-entry (a throttle cools differently than a 5xx), event-stream-else-polled progress delivery (the synthetic supplies declare no event-stream support — polled is the honest fallback at the declared interval), under the declared timeout contract (the fail-closed preservation gate runs at construction). | the PCL-002 configuration (`src/modules/executions/domain/tail-pacing-configuration.ts`), consumed through the app-local projection pinned against the real plane in-suite |

Both arms replay the SAME corpus over the SAME arm-agnostic deterministic draws (the transport's draws key on stream key, attempt and provider — never on the arm): the comparison is fair by construction, and only the PACING differs.

## The replayed cells

The capstone's OWN complete sweep enumeration — **102 cells** (9 subjects × volumes S/M/L × single/multi provider configuration × mono/full modality slices, the modality-degenerate subjects collapsed exactly as the capstone collapsed them), derived from `allSweepCells` (imported read-only through the lab's shared seam; never a hand-picked subset). The capstone's recorded results are NEVER reused as evaluation inputs: both arms re-run FRESH over each cell's corpus (the exact-revision rule), and the recorded capstone-era numbers are quoted VERBATIM per cell (their own basis — wall-clock end-to-end under the synthetic supply — preserved, never relabeled).

## The replay discipline (deterministic, self-verifying)

Per cell, per arm: every logical request occurrence (the capstone's `buildCellCorpus` enumeration, one occurrence per repetition) is one execution driven through the arm's paced ladder — per-attempt draws re-derived from the transport's own pure `outcomeOf`/`drawnFault` functions (imported through the lab's shared seam), retry admissibility and delay resolved through the pacing seam, provider cooldown state carried on a declared virtual clock (the cell's request stream in corpus order), every outcome recorded as a **PCL-001 typed outcome-latency fact** (closed vocabularies, explicit basis, attempt census, cost lines, mechanics record). Every attempt's evidence is verifiable against the transport's pure draws, and the re-run reproduces the evaluation digest byte-for-byte (wall-clock and run identities excluded from every digest projection).

## The explicit outcome thresholds (ACR-010 §5 — declared BEFORE the run)

| Threshold | Rule |
|---|---|
| T1 Tail percentile improvement | p50/p95/p99 of the re-run outcome latency (typed facts only): `tail-tuned-v1` strictly better than `baseline-today` at p95 AND p99; the per-failure-class/route decomposition discloses every class and route (never aggregate-only) |
| T2 Resolution honesty | resolution rate of `tail-tuned-v1` NOT BELOW `baseline-today` (a tail improvement that costs resolution is a MISS); verification outcomes per configuration disclosed |
| T3 Cost truth | total cost including duplicate attempts within the declared budget delta (+25% of the baseline total, synthetic-schedule basis); verification cost carried as its own line with its explicit basis |
| T4 Timeout/terminal preservation | the preservation gate passes at construction (fail-closed), ZERO terminal failures masked (every failed-terminal outcome records resolved=false), ZERO dispatch-budget violations, and the attempt census reconciles EXACTLY on every cell (attempts = original + retry + fallback + verification — dropped or reclassified failures are an automatic void) |
| T5 Reproducibility | the re-run digest is byte-identical (the deterministic replay discipline) |

The promotion gate's verdict is DERIVED from T1–T4 (all legs must pass; any failing leg is named with attribution); the declarations live in `experiments/pcl-003/declared-thresholds.json`, committed before the run, and the honest verdicts in `experiments/pcl-003/results/threshold-report.md`.

## The customer-boundary disciplines (VAL-002 AC7 — never `src/**` from the application tree)

The PCL-001 facts plane and the PCL-002 pacing plane live in `src/modules/executions/domain/**` (domain files with no public-barrel re-export — the module's own convention, pinned by the PCL-001/PCL-002 architecture tests), and are therefore NOT importable from the application tree (the VAL-002 AC7 discipline + the benchmarks import law: benchmarks import only `src/modules/<module>/public` barrels). The evaluation therefore consumes them the established way — the PCS-004 semantic-fidelity-evaluation pattern (the mirror-pinned projection):

- **the closed vocabularies and typed shapes** (`facts.ts`, `pacing.ts`): mirrored BY VALUE locally (the same discipline the PCL-001 domain file itself uses for the CostClaim discipline and the platform failure vocabularies — "alignment by value, never by import"), pinned EXACTLY against the real planes in-suite (every vocabulary, every bound);
- **the canonical serializer + content addressing** (`facts.ts`): the local canonical form is byte-for-byte pinned in-suite against the REAL `canonicalOutcomeLatencyFacts` serialization over every emitted fact and the edge fixtures;
- **the pacing resolutions** (`pacing.ts`): the local projection the standalone run uses is pinned verdict-for-verdict in-suite against the REAL `retryBackoffDelayMs` / `cooldownReentryAdmission` / `resolveProgressDelivery` / `progressDeliveryFactsOf` / `resolveTailPacing` — and the FULL evaluation re-runs in-suite with the REAL plane injected, required to reproduce the evaluation digest byte-identically (the PCR-003 plan-artifact injection precedent);
- **every emitted fact** validates on the REAL `validateOutcomeLatencyFacts` in-suite (driven over the committed per-cell evidence — the deterministic-replay identity makes the in-suite validation a validation of the committed evidence);
- **the seam helpers** (the cell enumeration, the corpus builder, the transport's pure draw functions) are imported through the lab's shared re-export (`../shared/seam`), never re-implemented.

The PCL-001/PCL-002 implementation files are consumed READ-ONLY everywhere; a defect would be REPORTED to the Lead with an owner, never patched here.

## The artifacts (`experiments/pcl-003/`)

- `declared-thresholds.json` — the thresholds declared BEFORE the run (the declared-before discipline).
- `results/threshold-report.md` — the durable evidence document: every threshold with its verdict, every number labeled with its basis, attribution on every miss, the promotion gate's mechanical verdict, the reproducibility proof.
- `results/evaluation-aggregate.json` — the aggregate + verdicts + per-cell summaries + the reproducibility record.
- `results/cells/<cellId>.json` — per-cell results: both arms' typed-fact evidence (the complete fact blocks with their content addresses), the per-failure-class/route percentile tables, the census reconciliation proof, the cost-truth lines, the recorded capstone-era numbers quoted verbatim, and the per-cell honest verdicts.

## Run

The suites: `tests/unit/validation/pcl-003-latency-tail-evaluation.test.ts` (the engine oracles), `tests/unit/validation/pcl-003-mirror-pins.test.ts` (the mirror pins against the real planes), `tests/unit/validation/pcl-003-committed-evidence.test.ts` (the committed evidence).

```bash
bun run benchmarks/validation/apps/latency-tail-evaluation/run.ts          # the full evaluation + the reproducibility re-run
bun run benchmarks/validation/apps/latency-tail-evaluation/run.ts single   # the full evaluation once
```

## Boundaries

- Synthetic replay only — no live/credentialed provider runs, ever; no SLA or production-latency claims; live validation is the operator-era obligation and is never backfilled.
- Evaluation only — NO changes to the PCL-001/PCL-002 implementation files (consumed read-only through the projections pinned in-suite); NO new engine, NO second pacing authority, NO ambient configuration (the ACR-010 §6 laws bind the evaluation too — this app is an evaluation consumer, never a mechanics authority; the replay's ladder is declared evaluation configuration, and the paced decisions are resolved through the pacing plane's own functions).
- NO hedged-request evaluation (out of scope per ACR-010 §6; the PCR-004 void stands).
- The capstone's machinery (`experiments/ppr-027/**`) is imported and quoted, never modified (the recorded results are frozen evidence).
- The outcome census reconciles exactly on every cell of every arm, mechanically — a dropped or reclassified failure is an automatic void.
