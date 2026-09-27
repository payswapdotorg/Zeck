# PPR-018A — Cross-Application Real Runner, Baseline, and Demo Mirror Activation Harness

Status: AUTHORIZED / READY FOR TECH-LEAD DISPATCH
Program: zeck-application-compatibility-proof
Authorization date: 2026-09-27
Preferred concurrency: 1 worker
Architecture authority: ACR-006 + ACR-007
Depends: PPR-017

## Objective

Turn the PPR-017 compatibility foundation into a reusable real-runner and comparison harness that can certify actual external applications and expose the same certified runs through the website Demo Mirror.

This is cross-application infrastructure, not an application-specific integration. Keep it independent of Aider/Cline source surfaces so it can run concurrently with PPR-018 and PPR-019.

## Scope

Implement only the reusable surfaces needed by PPR-018 through PPR-027:

1. A pinned-application integration runtime contract that starts one exact application revision plus one exact Zeck integration revision.
2. Provider-credential erasure checks for the certified application runtime.
3. Runtime direct-provider egress deny/observation controls with explicit allowlists for Zeck only.
4. A reusable corpus runner that records application result plus Zeck execution/evidence correlation.
5. Direct-baseline and strong-optimized-non-Zeck baseline capture hooks. Baselines must be labeled as baselines, never as Zeck evidence.
6. A reusable measurement schema covering:
   - outcome success;
   - quality/verification result;
   - latency and tail latency;
   - usage and cost;
   - failure/retry counts;
   - deterministic/reuse/verified-computation opportunities;
   - provider portability/change effort;
   - customization coverage;
   - engineering surface removed;
   - capability-discovery-driven avoided implementation;
   - telemetry/explainability completeness;
   - diagnosis/recovery time;
   - reproducibility.
7. Demo Mirror runtime binding so a certified entry can run the exact pinned application integration rather than a synthetic response.
8. Public UI projections for run controls and evidence links, while keeping status derived from the compatibility record.
9. Negative tests that make impossible:
   - a demo run without AI_EXECUTION_COMPLETE;
   - a direct provider edge hidden by a proxy;
   - missing Zeck trace correlation;
   - unpinned application execution;
   - baseline facts being presented as Zeck facts.
10. Documentation and runbook showing exactly how future application Work Orders plug into the harness.

## External delegation contract

Use the ACR-007 public boundary. The harness must not teach application integrations to call Zeck internals.

The application adapter should translate:

application task/context
  → Zeck task + constraints + references
  → Zeck execution
  → result/evidence
  → application result

Do not add provider selection, retry routing, budget accounting, verification logic or optimization logic to the harness.

## Completeness rules

AI_EXECUTION_COMPLETE remains unchanged and strict.

The runner must distinguish:
- PASS: real external execution with exact revision/evidence;
- NOT-RUN: infrastructure/credential/access unavailable;
- BLOCKED: known required external capability unavailable;
- FAIL: the certified application path did not preserve required behavior;
- BYPASS_DETECTED: a material AI edge escaped Zeck.

Fixtures may exercise the harness, but they cannot produce AI_EXECUTION_COMPLETE.

## Demo Mirror requirements

For an eligible certified runtime, expose:
- application name and exact revisions;
- representative task;
- live progress;
- final result;
- execution timeline;
- plan/route facts;
- cost/latency/usage;
- verification/evidence;
- direct-baseline comparison;
- reproducibility metadata.

For incomplete entries, show the honest derived status and reason, with no run action that would execute an uncertified path.

## Required verification

Run the exact Lead battery required by the compatibility handoff, plus:
- no-bypass regression;
- exact revision binding;
- baseline-vs-Zeck labeling;
- demo-run authorization;
- public Demo Mirror route/run regression.

## Evidence

Create deploy/evidence/ppr-018a.json containing:
- exact Zeck revision;
- harness revision;
- test corpus identifiers;
- proof control configuration;
- measured sample facts;
- known limitations;
- explicit non-certification of fixture-only runs.

## Boundaries

No new authority.
No new optimizer.
No second execution lifecycle.
No capability-manifest rewriting.
No provider SDKs in domain/public compatibility contracts.
No application source fork required by the harness.
No hidden credential fallback.
No marketing claim derived from scenario data.

## Completion

PPR-018A is complete when a future application Work Order can plug a pinned integration into the harness without adding its own proof framework, and the website can execute the same certified runtime and expose the resulting Zeck evidence without status drift.
