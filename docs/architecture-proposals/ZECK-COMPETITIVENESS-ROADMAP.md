# Zeck Competitiveness Roadmap — Evidence-Driven Architecture Proposals

Status: PROPOSAL / NOT AN APPROVED ARCHITECTURE CHANGE  
Date: 2026-10-11  
Source evidence: PPR-025 through PPR-027, especially `docs/APPLICATION-COMPATIBILITY-OBSERVED-EVIDENCE.md`  
Compatibility boundary: ACR-006 + ACR-007  
Rule: preserve the frozen v1.0 authority chain; improve the existing authorities rather than add shadow routers, ledgers or optimizers.

## Executive recommendation

Yes. Zeck should improve a few specific areas to make full delegation a better choice than in-house orchestration. The capstone suggests Zeck already wins against an unoptimized direct stack and removes substantial application-owned infrastructure, but it does not yet beat a strong in-house retry/fallback/cache stack on all outcome metrics.

Prioritize **outcome reliability and policy-aware failover**, then **capability semantic fidelity and measurement quality**, and then **developer migration/adoption evidence**. These are evidence-based follow-ups, not reasons to redesign the whole platform.

## P0 — Complete evidence closure before optimizing

PPR-028 is the immediate prerequisite. Aider's demo entry still declares itself NOT ACTIVATED and its executor is absent from the shared Demo Mirror registry; PPR-022–PPR-026 and PPR-027 still contain pending final-certification fields, while PPR-021 is correctly PARTIAL. Reconcile the facts before taking portfolio completeness as settled.

## P1 — Close the measured reliability/failover gap

### Evidence

The capstone's synthetic-supply 102-cell study reports:

- Zeck-mediated resolution: 94.8%.
- Un-retried direct resolution: 67.3%.
- Strong-optimized in-house baseline resolution: 98.0%.
- Failure-adjusted synthetic cost per resolved outcome: 23.77 micro-USD mediated vs 22.79 strong-optimized.
- The strong-optimized arm uses a three-attempt retry ladder, fallback, content-addressed cache and normalization shim; the tested Zeck policy has one failover retry.
- Multi-provider mediated cells resolve 92.4%, below the single-provider cells at 97.2%.

These figures are observations under the study's deterministic profile and synthetic prices; they are not live supplier invoices or a real-provider benchmark. Even with that limitation, they identify what to test next.

### Proposed direction

Evolve the existing Execution Compiler / governed retry authority to choose a **policy-bounded recovery plan**, based on classified failure cause and available capability:

1. Distinguish retryable transport/rate-limit faults from authentication, quota, region, malformed-request, capability-mismatch and semantic-quality failures. Avoid retrying failures that cannot improve.
2. Select the next attempt using declared capability fit, measured provider/route reliability, latency distribution, cooldowns, remaining budget, task idempotency and required verification.
3. Support a bounded sequence of same-provider retry, alternate-provider failover, context repair, model escalation, verifier escalation and honest terminal failure. Preserve tenant policy, budget ceilings and audit records.
4. Consider parallel/hedged execution only for side-effect-safe, idempotent tasks where the expected successful-outcome benefit justifies duplicated spend and verification. Never hedge arbitrary tool/actuation tasks.
5. Learn from observed success and failure evidence, but keep policy admission, budget authorization, planning and final plan selection inside existing Zeck authorities.

### Success gates

Compare against both direct and strong-optimized baselines at comparable outcome requirements. Required outcomes: equal-or-better task resolution than the three-attempt strong baseline in targeted multi-provider cells, improved failure-adjusted cost, no policy/budget violations, explicit latency-tail tradeoffs and reproducible per-attempt evidence. Run offline/replay evaluation first; promote only after real provider-backed validation where credentials permit.

## P2 — Preserve capability semantics: real capability vs deterministic substitute

### Evidence

PPR-025 and PPR-026 disclosed missing authorized `/embeddings` supply endpoints and used deterministic Zeck-side execution. This proves that Zeck can execute a deterministic path and return a result; it does **not**, by itself, prove semantic-embedding quality equivalent to a model-backed embedding service.

### Proposed direction

Represent output semantics and quality requirements precisely in the existing capability/evidence model:

- distinguish semantic embeddings from deterministic lexical/hash vectorization or other deterministic retrieval features;
- carry modality, dimensionality, normalization, similarity semantics, quality/evaluation contract, and compatibility constraints as typed capability facts where relevant;
- make the planner select deterministic substitutes only when the task's declared quality contract permits them;
- show the user which requirement is met and what remains unavailable.

No new capability registry. Extend the existing registry/contracts only through a reviewed ACR and migration plan. Existing 22-family capability truth must not be silently broadened by a similarly named substitute.

### Success gates

A task requiring semantic retrieval must not pass merely because a deterministic vector is produced. Tests must include quality fixtures and negative controls; evidence must differentiate `semantic-embeddings` from `deterministic-vectorization`.

## P3 — Improve latency-tail and recovery economics

### Evidence

The capstone reports median latency 18.5 ms mediated, 21.0 ms direct, 16.0 ms strong-optimized; reported p95 median-of-cell values are 135.5, 97.5 and 143.0 ms respectively. The profile includes retries and compressed polling. This is a mixed result: better median than direct, slower tail than direct.

### Proposed direction

- Tune retry delays, provider cooldowns, event delivery and polling so a successful fallback does not dominate tail latency.
- Prefer event/stream-driven progress over tight status polling when the transport supports it.
- Track successful-outcome latency and p95/p99 by failure class and route, not just aggregate model latency.
- Consider hedged requests only under P1's idempotency, policy and spend controls.
- Preserve explicit timeout and terminal-failure behavior; do not improve percentiles by hiding failed or unfinished executions.

### Success gates

Report p50/p95/p99 for each failure class, total cost including duplicate attempts, resolution rate and verification cost. No promotion on median latency alone.

## P4 — Make decision scoring pluggable, not authoritative

### Proposal

An optional System One / learned-ranking capability (e.g. interchangeable Jev, Laya, CLM-style scorers or a Zeck-trained scorer) could estimate candidate success, failure class, verifier value or route suitability for the existing Execution Compiler.

The call flow should remain:

```
Zeck creates admissible candidates
    → optional scorer returns typed scores/probabilities
    → Execution Compiler applies policy, capability, budget, latency and verification constraints
    → governed execution
    → outcome evidence feeds evaluation
```

Never make a System One model the router or authority. Its output is a prediction, not proof. Keep deterministic scoring available, permit the scorer to be absent, and require measured lift net of scorer cost/latency. Compare calibration, top-k decision quality, worst-case regressions and policy-constraint preservation against the deterministic/current baseline before enabling it in production.

## P5 — Make Zeck-complete the lower-friction choice for developers

The value proposition is not only lower token cost. The capstone's strongest result is the measured removal of application-owned provider routing, retry/fallback, credential management and evidence plumbing, with portability probes reporting zero application-file changes across nine integrations.

Proposed product investments:

1. **Migration compiler / integration preflight:** scan an application's active material AI edges, generate an inventory and adapter checklist, detect unsupported edges, and report exact gaps before code changes.
2. **Contract-first SDK examples:** stable, idiomatic adapters for popular app seams; clear support matrix for model, tools, embeddings, media and substrate actuation; executable template tests.
3. **Evidence-backed ROI report:** compare per-success cost, reliability, tail latency, avoided infrastructure and portability against direct and strong-optimized arms. Label synthetic, inferred and NOT RUN results.
4. **First-class local/private execution:** keep Ollama/local routes under the same policy/evidence contract, with the local model provider pluggable and zero raw secret transfer into the application.
5. **Predictable tenant control:** explicit quality/cost/latency/policy constraints and observable why-not explanations, without exposing internal provider-specific semantics as application contract.
6. **A real adoption experiment:** recruit actual developer teams for counterbalanced direct-baseline and Zeck-exposure periods using comparable tasks. Measure migration time, operational burden, durable use and final preference. Do not reuse scenario simulation percentages as adoption evidence.

### Success gates

Reduce time-to-first-certified-task and app-side changed lines; preserve customization; capture developer preference from real cohorts; report confidence and attrition; provide evidence that could falsify the preference hypothesis.

## Decision sequence

1. Complete PPR-028 closure and certification reconciliation.
2. Write a separate implementation work order for P1 adaptive failover/reliability, with isolated replay harness and explicit outcome thresholds.
3. Specify P2's capability-semantic extension with a compatibility migration and negative tests.
4. Profile latency tails and prioritize the bottleneck revealed by P1 replay runs.
5. Evaluate optional learned/System One scoring in shadow/offline mode.
6. Run the real developer-adoption cohort before making market-preference claims.

## Non-goals / guardrails

- Do not fork every application or require applications to reimplement Zeck.
- Do not add a second router, capability registry, budget, execution state machine, verification service or evidence authority.
- Do not change the frozen public contract or v1.0 authority chain without a separately approved ACR.
- Do not label a deterministic substitute as semantically equivalent without quality evidence.
- Do not claim Zeck universally beats strong in-house engineering; the current observed evidence does not support that.
