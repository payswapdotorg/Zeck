# economic-recovery-plan-evaluation (PCR-003)

The P1 program's three-arm replay evaluation with explicit outcome thresholds — the evidence work order (PCR-003, ACR-008 §7; this app extends the VAL-048 cross-workload competitive-benchmark evidence line): the un-retried direct, strong-optimized and **mediated-with-plan** arms re-run FRESH at ONE exact revision, targeting the multi-provider cell family where the PPR-027 capstone measured the mediated-resolution gap (92.4% multi vs 97.2% single-provider), with honest verdicts per threshold and the PCR-004 eligibility statement.

**Every number this evaluation emits is a fresh synthetic measurement** — synthetic-supply (the declared deterministic fault/latency profiles), synthetic-cost (the declared price schedule), synthetic-latency (the drawn deterministic profile, never wall-clock). No live/credentialed provider runs, no market or production claims; a threshold miss with honest attribution is a VALID delivery (the program's truth discipline).

## The three arms (the pre-registered configurations)

| Arm | Mechanics | Owner |
|---|---|---|
| `un-retried-direct` | the same corpus-derived request stream dispatched straight to the primary synthetic supply — one attempt, no retry, no cache (BASELINE facts — never Zeck evidence) | the capstone's own direct-baseline executor (`experiments/ppr-027/driver.ts`, imported read-only) |
| `strong-optimized` | the app-owned reliability machinery: 3-attempt retry ladder, provider fallback chain, content-addressed response cache, response-shape normalization shim (BASELINE facts — never Zeck evidence; never a strawman) | the capstone's own optimized-baseline executor |
| `mediated-with-plan` | the real Zeck public API stack (the PPR-027 composed experiment world: real gateway, rails, executions authority, ledger, idempotency) with **plan mode ON through the PCR-002 evaluation configuration** (`ComposeExperimentOptions.recovery` → `RecoveryConfiguration.planMode: "on"` with the mandatory `maxPlanSteps` bound — an evaluation/tenant configuration ONLY; the wired seam's default is OFF everywhere) | the PCR-001 plan composer + the PCR-002 wired seam, composed through `composeExperimentStack` |

The mediated arm's bounded ladder (the recovery ladder the strong baseline exercises, bounded by the same attempt economics): **step 1 = same-provider retry** (the retry claim is the cheapest admissible candidate — the plane's deterministic order), **step 2 = alternate-provider failover** (the retry is retry-attempt-bound at the second frame; supply-c is the cheapest declared alternate the seam's frame projection admits), terminal `bound-reached`, **3 total attempts** — the strong baseline's own attempt bound. The wiring is pinned in `corpus.ts` and verified against the REAL composer in the test suites.

## The targeted cells

The complete multi-provider family of the capstone's sweep matrix — **51 cells** (9 subjects × volumes S/M/L × modality slices, the multi provider configuration), derived from the capstone's OWN cell enumeration (`allSweepCells`, imported read-only; never a hand-picked subset). The capstone's recorded numbers are NEVER reused: all three arms re-run FRESH at ONE exact revision in ONE process (the exact-revision rule), over the same corpus and the same arm-agnostic deterministic synthetic supply.

## The explicit outcome thresholds (ACR-008 §7)

| Threshold | Rule |
|---|---|
| T1 Resolution | mediated-with-plan **equal-or-better** than the FRESH strong-optimized arm in the targeted multi-provider cells (task-level primary; request-level disclosed) |
| T2 Failure-adjusted cost per resolved outcome | **improved** vs strong-optimized, or a **documented tradeoff** with attribution (the synthetic supply's charge for every physical dispatch, divided by the resolved tasks) |
| T3 Policy/budget violations | **ZERO** — the hard gate (attempt bounds, the per-execution budget ceiling, the plan step bound, the plan-artifact validation, the route policy, the task↔request outcome coherence — verified mechanically over every attempt of every arm in every cell) |
| T4 Latency tails | p95/p99 by failure class and route + per-occurrence end-to-end — **explicit tradeoff accounting**, no silent regressions |
| PCR-004 eligibility | whether sequential plans reached the resolution threshold on the side-effect-safe idempotent cells (the hedged-mode gate; ACR-008 §5 admits hedging only on evidence that sequential plans CANNOT reach the threshold) |

## The per-attempt evidence (the deterministic replay discipline)

Every physical dispatch of every arm is recorded with its draw identity (the transport stream key), route, outcome, fault class, retryability, DRAWN synthetic latency, measured synthetic cost, usage — and, for the mediated-with-plan arm, the failure attribution and the strategy verdict of the plan step that drove the attempt. Every record is **verified against the transport's own pure draw functions** (`outcomeOf`) during the run — the evidence is self-verifying; re-runs reproduce the evaluation digest byte-for-byte (the full-evaluation re-run comparison is recorded in `results/threshold-report.md`; the in-suite determinism proof re-runs a hermetic slice). Wall-clock values and run identities are excluded from every digest projection.

## The artifacts (`results/`)

- `threshold-report.md` — the durable evidence document: every threshold with its verdict (met / missed / documented-tradeoff / accounted), every number labeled, attribution on every miss, the PCR-004 eligibility statement, the reproducibility proof.
- `evaluation-aggregate.json` — the aggregate + verdicts + per-cell summaries + the reproducibility record.
- `cells/<cellId>.json` — per-cell results with the complete per-attempt evidence, occurrence rollups, composed-plan projections and violations.

## Run

The suites: `tests/unit/validation/pcr-003-recovery-plan-evaluation.test.ts` (the oracles) and `tests/unit/validation/pcr-003-apps.test.ts` (the app boundary).

```bash
bun run benchmarks/validation/apps/economic-recovery-plan-evaluation/run.ts          # the full evaluation + the reproducibility re-run
bun run benchmarks/validation/apps/economic-recovery-plan-evaluation/run.ts single   # the full evaluation once
```

The test suites live at `tests/unit/validation/pcr-003-recovery-plan-evaluation.test.ts` (the oracles: config pinning, corpus digest stability, arm-configuration integrity, verdict-derivation honesty, violations-scan discriminations, per-attempt verification) and `tests/unit/validation/pcr-003-apps.test.ts` (the app over the real composed stack: the hermetic three-arm cell, plan-mode-ON ladder verification, evidence completeness, determinism/reproducibility digest equality, honest-label presence in the rendered report).

## Boundaries

- Synthetic replay only — no live/credentialed provider runs, ever; live validation is the operator-era obligation and is never backfilled.
- Evaluation only — no changes to the failure-recovery plane's semantics (`src/platform/failure-recovery/**` is read-only for this work order); no hedged execution (PCR-004, gated on this evidence); no promotion of plan mode to any default.
- The failure-recovery plane, the wired seam and the capstone's machinery are imported and invoked, never modified or duplicated (reuse, do not rebuild).
- Baseline arms are labeled BASELINE facts — structurally never Zeck evidence.

## The customer-boundary disciplines (VAL-002 AC7 — never `src/**` from the application tree)

The evaluation composes the recovery seam's plan inputs without importing the platform's internals — each need follows the repository's OWN established answer to a boundary that forbids the import:

- **the canonical serializer** (`canonical.ts`): the WORK-008 canonicalization discipline implemented locally, byte-for-byte pinned in-suite against the platform's serializer — the exact precedent of the planning module's serializer vs the execution-ir plane's serializer (the platform's own canonical.ts states the discipline: a boundary that forbids importing the serializer implements it locally over neutral values, with boundary tests pinning the serializers byte-for-byte);
- **the digest port** (`canonical.ts`): the recovery seam's own injection contract (a one-method port, injected never ambient — the WORK-008 node-digest adapter precedent), byte-identical to the platform's `createNodeDigest()`, pinned in-suite;
- **the governed IR** (`governed-ir.ts`): a PINNED CAPTURED CONSTANT — the byte-exact output of the platform's own planning construction, with the capture's exactness (deep equality AND content-addressed `irId` identity) proven in-suite against a LIVE platform construction (drift-visible, never silent);
- **the plan-artifact validation** (the hard gate's plan-artifact leg): the recovery plane's own total validation (validateRecoveryPlan), INJECTED IN-SUITE over every composed plan of the full evaluation — never reimplemented in the app tree (the deterministic-replay identity makes the in-suite injection a validation of the committed evidence);
- **every platform type the app mentions** derives from the LAB's exported interface (`ExperimentRecoveryPlanInputs[...]`), never from `src/**`.
