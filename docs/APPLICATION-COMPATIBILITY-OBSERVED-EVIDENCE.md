# Application Compatibility — Observed Evidence (PPR-027)

Status: study record (the program capstone's observed distributions)
Work order: PPR-027 (spec/post-release-work-orders/PPR-027.md)
Evidence record: `deploy/evidence/ppr-027.json`
Raw artifacts: `experiments/ppr-027/results/**` (102 cell results, sweep state, portability probes, adapter audit, portfolio aggregation, observed distributions)
Companion simulation document: `docs/APPLICATION-COMPATIBILITY-ADOPTION-SIMULATION.md` (its percentages remain hypotheses — see "What this study does NOT establish")

## What this document is

PPR-027 ran a 102-cell longitudinal study over the nine certified applications inside a single sandbox: the real Zeck public API composed in-process with the shared PPR-018A harness (`runCorpus`, `captureBaseline`, `measurementSetOf`), an injected deterministic synthetic supply behind the real rails, and this study's provider-blind pinned driver. Every number below is an **observed** value from those runs, or a median over observed per-cell values. Nothing below is a scenario, a projection, or an extrapolation of the simulation document's percentages.

What the study measures honestly, it measures as a **model under declared conditions**: the workloads reproduce each certified record's exact corpus shape (request counts and token totals reconcile to the records, asserted by hermetic tests), and the provider axis is a declared deterministic behavior profile. Cost figures are **synthetic micro-USD** under a declared price schedule — never provider invoices.

## The ten Completion questions (observed answers)

### 1. Which applications became AI_EXECUTION_COMPLETE?

Eight of nine. Aider (018), Cline (019), OpenHands (020), Hermes-Agent (022), OpenClaw (023), Browser Use (024), Open WebUI (025), AnythingLLM (026). Continue (021) derived **PARTIAL** by its own record: corpus 5/7, delegated 6/7 edges — the subagent child-session edge failed honestly (the main-agent shortcut) and the embeddings edge sat at the disclosed operator-provider supply boundary.

*Evidence: `results/portfolio-aggregation.json` — tallies aiExecutionComplete=8, partial=1, blocked=0, bypassDetected=0.*

### 2. Which material edges remain blocked or bypassed?

**Zero bypassed** across the portfolio. The open edges are Continue's two (above). Every other declared material edge is delegated with Zeck evidence.

### 3. Which gaps were implementation, public-contract, architecture or operator/provider boundaries?

From the nine records' own vocabulary, summed: **25 operator/provider boundary** classifications (the dominant class — disclosed supply-side boundaries the non-Zeck arms also hit), **2 implementation gaps**, **0 public-contract gaps**, **0 architecture-gap candidates**. No gap class escalated into an architecture change request across the entire program.

### 4. How did successful-outcome economics change at comparable quality/reliability/safety/latency?

Observed over 1134 corpus tasks per arm (same corpus, same declared supply, per-exposure draws):

| Arm | Resolution | Failure-adjusted synthetic µUSD / resolved | Median cell latency | p95 (median of cells) |
|---|---|---|---|---|
| Mediated (Zeck) | **1075/1134 (94.8%)** | **23.77** | 18.5 ms | 135.5 ms |
| Direct (un-retried) | 763/1134 (67.3%) | 69.89 | 21.0 ms | 97.5 ms |
| Strong-optimized (app-owned retry+fallback+cache) | 1111/1134 (98.0%) | 22.79 | 16.0 ms | 143.0 ms |

Safety: the egress positive control was **observed blocked in 102/102 cells**; zero bypass anywhere.

The honest reading has two halves. Against the un-instrumented direct stack (the common real-world default), mediation is decisive: **−66% failure-adjusted cost, +27.5 points of resolution, a 2.5 ms LOWER median latency**. Against the *strong-optimized* baseline — a team that owns and maintains a 3-attempt retry ladder, a provider fallback chain, a content-addressed cache and a normalization shim — mediation **matches the economics (+4%) but does not beat the resolution (94.8% vs 98.0%) or the median latency (18.5 vs 16.0 ms)**.

### 5. How did determinism/reuse and feature discovery change developer workload?

Measured longitudinally for the first time: **3353/5950 (56.4%)** of all delegated requests replayed durably with **zero provider exposure** on corpus repetition. The compounding effect is the volume axis — mediated failure-adjusted cost per resolved (median of cells) falls **39 → 19 → 9** synthetic µUSD from small to large volume, while the direct arm's stays 43–51:

| Volume | Mediated resolution | Mediated µ med | Direct µ med | Optimized µ med |
|---|---|---|---|---|
| S (1× corpus) | 88.3% | 39 | 48 | 39 |
| M (2×) | 94.4% | 19 | 51 | 19 |
| L (4×) | 96.6% | **9** | 43 | 9 |

The deterministic substrate plane (Browser Use's actuation edges) executed with `modelCalls 0`, verified by mechanical recomputation. Feature discovery: all eight platform-declared surfaces (text, vision, speech-recognition, speech-generation, image-generation, embeddings, rerank, sandbox-program-execution) were consumed with **zero per-surface driver code** — the driver is surface-parametric over one boundary primitive.

### 6. How much provider/plumbing infrastructure was removed?

In the application: **all of it, and it stayed removed**. The ACR-007 audit over the nine frozen adapters (static, mechanical, file:line evidence, verdicts derived never asserted) finds **zero** provider credentials, provider selection, retry authority, fallback chains, model routing, budget accounting, verification/evidence authority, or second-gateway growth across 425–1443 adapter lines each; every provider-facing outcome flows through 1–6 `createExecution` delegation sites. Each adapter carries exactly its two disclosed stateful translation concerns (the terminal-polling loop, the idempotency-key cache) — mechanisms, not authorities.

The counterfactual is measured too: the strong-optimized baseline's ladder/fallback/cache/shim is precisely the engineering the application otherwise owns.

### 7. How useful was central telemetry/evidence for diagnosis and reproduction?

**5950/5950** delegated executions correlated through the public SDK wire reads (ledger events + verification results); **5881/5950 (98.8%)** reconstructible end-to-end — route, cost and usage projectable from the public surface alone (the 69-execution residue is the substrate plane's usage-free facts, by design). Failures are diagnosable at terminal through public cause records (per-cell `diagnosis-recovery` entries: mean time-to-terminal-cause and mean failover-recovery latency). The sweep is reproducible by hash-draw construction, and the resumable runner re-verified all 102 checkpoints. The portfolio aggregation itself was assembled from the records' public fields alone.

### 8. How much customization remained available?

The full declared surface: provider/model/rail selection via platform connections (the portability probes switched single→multi with **zero application-side changes, 0 changed files, 24–245 ms**, all 9/9), per-execution constraints and metadata, and the applications' own tuned optimization axes (reproduced in the strong-optimized arms). No axis the certified records disclosed was removed or blocked by mediation in any cell.

### 9. How did developer preference change with sustained use and application scale?

**NOT RUN — honestly.** Preference requires real developer teams exposed to both stacks over sustained time. This sandbox study has no developers and no sustained exposure, and the work order's law forbids extrapolating the simulation document's central-case percentages (55/66/78% by maturity) as observations. What is observed are the *inputs* a preference decision would feed on: mediated cost-per-resolved falling with scale while the direct arm's rises, portability at zero app-side change, near-total telemetry, and a strong-optimized counterfactual that matches cost while retaining the engineering burden.

*Owner: Lead. Required track: the simulation doc's own 17-point "better empirical test" protocol (direct-baseline period, Zeck-exposure period, comparable corpus, final choice).*

### 10. Does the observed evidence strengthen or weaken the Stripe-of-AI-execution thesis?

**Both — and the honest net is conditional.**

**Strengthens** (against the un-instrumented direct stack — the common default): +27.5 points resolution, −66% failure-adjusted cost, a 2.5 ms lower median latency, total portability, near-total telemetry, compounding reuse, zero bypass, and a thin-adapter invariant that held across nine diverse applications and eight execution surfaces with zero authority leakage. No architecture-gap candidate emerged anywhere in the program.

**Weakens** (the parts a one-sided capstone would hide):

- The **strong-optimized baseline beats the mediated arm on raw resolution** (98.0% vs 94.8%; 36-task gap; **33/102 cells where a baseline resolved more**) at 4% lower failure-adjusted cost and a 2.5 ms lower median latency. An app team that owns real reliability engineering achieves comparable-or-better economics in this study's model.
- **Multi-provider cells drop the mediated resolution to 92.4%** (vs 97.2% single): the platform-side policy as configured here — round-robin selection across supplies with *one* failover retry — is weaker than the optimized arm's 3-attempt ladder. This is a named, actionable platform gap, not a mystery.
- **Preference itself remains unmeasured** (Q9).

**Net:** the thesis survives as a conditional. Zeck's measured value is not "beats the best engineering on every number" — it is **"matches strong-engineering economics while removing that engineering from the application, and decisively beats not having it."** The falsifiable gaps are named with owners: the failover-policy gap (platform) and the preference measurement (Lead). A capstone that only confirmed strengths would not be credible; this one reports where the thesis is weakest.

## Cross-reference to the simulation document

The simulation document (`docs/APPLICATION-COMPATIBILITY-ADOPTION-SIMULATION.md`) modeled per-application preference rising 48–86% from early to mature, with sensitivity bands (45–90%) keyed to exactly the mechanisms this study measured. Status of each modeled mechanism, as observed:

| Simulation mechanism | Observed status |
|---|---|
| "Performance — latency preserved" | **Partially confirmed**: the mediated median sits 2.5 ms BELOW the direct arm (18.5 vs 21.0 ms) and 2.5 ms above the optimized arm (16.0 ms); the mediated tail (p95 median 135.5 ms vs direct 97.5) carries the failover path and compressed poll quantization |
| "Cost over time — reuse compounds" | **Confirmed in structure**: 56.4% durable replays; mediated µ-per-resolved 39→9 with volume; direct arm flat-to-rising |
| "Determinism and reuse" | **Confirmed**: 56.4% replay rate; substrate plane verified by recomputation |
| "Telemetry and execution explainability" | **Confirmed**: 100% correlation, 98.8% end-to-end reconstructibility |
| "Provider portability" | **Confirmed**: 9/9 zero-application-change switches |
| "Reliability and incident recovery" | **Confirmed vs direct (94.8% vs 67.3%); NOT confirmed vs strong-optimized (98.0%)** — the single-policy-retry gap is the platform's to close |
| "Sensitivity band 'Zeck is roughly cost-neutral with strong telemetry/portability' (60–72%)" | The *economics* precondition of this band is observed (mediated ≈ optimized cost); the *preference* percentage itself remains a hypothesis |
| Central preference percentages (55/66/78%) | **NOT observed — explicitly not extrapolated**; Q9 NOT RUN with owner and track |

## The study's own defects, found and fixed

The study's verification loop caught two instrument defects mid-study; the full sweep was re-run from zero after the fixes, and the committed results are from the corrected instrument only:

1. **Substrate completion-fact detection** — the driver initially accepted only `model-completion` facts, mis-scoring Browser Use's deterministic substrate plane (12 requests) as failures. Fixed to accept the substrate plane's `substrate-result` facts with the deterministic route projected into the trace source.
2. **A reconstructibility criterion that never discriminated** — `usage !== undefined` was always true. Fixed to `usage !== null`; end-to-end reconstructibility is now honestly 98.8%, not a vacuous 100%.

Additionally, the workload provenance was reconciled exactly: every subject's per-request token volumes now sum to its certified record's totals, asserted by hermetic tests against each record's declared anchor (disposition execution ids, battery `railUsage` sums, measurements `usage-cost` entries, or the recorded narrative — the nine records predate and straddle the measurement schemas).

## Honest NOT RUNs and limitations

- **Developer preference after sustained exposure** — NOT RUN, owner: Lead, required track: the 17-point cohort protocol.
- **Live external-provider baselines** — NOT RUN (no external credentials; owner: Lead, the PPR-018..026 precedent). The same-supply direct arm is the measured substitute.
- **Re-run of the pinned application runtimes** — NOT RUN (absent from this sandbox; a re-run here would be a different experiment mislabeled). The certified records remain the application-level facts.
- **Real-USD economics** — all costs are synthetic micro-USD under the declared schedule.
- **Migration effort / time-to-certification distribution** — the nine migrations were recorded heterogeneously across PPR-018..026; a uniform re-measurement would require replaying each migration (owner: Lead).
- The provider axis is a declared deterministic profile set; latency includes the injected profile and compressed poll intervals; the maturity axis is three named operational points over the same factorial, not a time series; aider's modality axis is degenerate (text-only declared graph — 6 cells, labeled everywhere).

## Verification battery (exact numbers)

| Gate | Result |
|---|---|
| `bun install` | no changes (143 installs / 192 packages) |
| `bun run typecheck` | **0 errors** |
| `bun run lint` | 7 errors / 68 warnings — **all pre-existing** in `tests/unit/validation/val-047..049` and `benchmarks/validation` files untouched by this branch (`git diff 86e7106..HEAD -- tests/ benchmarks/` is empty); `experiments/ppr-027` checks clean |
| `bun run test:unit` | **380 files / 6572 tests passed**, 0 failed, 0 skipped |
| `bun run test:architecture` | 139 files passed / 1 skipped; **2230 tests passed / 4 skipped** |
| `bun run test:integration` | 31 files passed / 148 skipped (179); **334 tests passed / 205 skipped** — PG suite skips cleanly without `ZECK_PG_TEST_URL` (skip count recorded) |
| `bun run test` (full) | **558 files passed / 151 skipped (709); 9228 tests passed / 241 skipped (9469)** |
| Hermetic study tests | `experiments/ppr-027/tests/` — **5 files / 65 tests**, all passing, transport-injected, no live network |

## Reproduce

```
bun run experiments/ppr-027/run.ts all        # sweep (resumable) + portability + audit + aggregate + analyze
bun run experiments/ppr-027/run.ts sweep      # re-verifies: planned=102, skipped=102, failed=0
bunx vitest run experiments/ppr-027/tests     # the 65 hermetic tests
```

The sweep is deterministic by hash-draw construction; re-running regenerates the committed cell results. The study survived two platform stream deaths mid-run with zero lost work (the checkpoint law: 102 atomic cell checkpoints).
