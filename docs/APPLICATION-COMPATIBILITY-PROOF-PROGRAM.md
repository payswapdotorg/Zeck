# Zeck Application Compatibility Proof Program

Status: ARCHITECT-APPROVED / ACR-006 + ACR-007
Date: 2026-09-27
North star: demonstrate with real application code that materially different open-source AI applications can make Zeck their AI execution authority without redefining Zeck completeness.

## Mission

Move from:

Zeck can execute many AI workload types

to:

an independent application can remove its direct AI-execution/provider infrastructure and continue operating with Zeck as its AI execution authority through one stable provider-neutral delegation boundary.

This is an empirical engineering property. It must be proven on real application runtimes, exact revisions, real provider egress and Zeck evidence.

## Architecture invariant

The existing authority chain remains the only authority:

Tenant/Application Identity → Policy → Capabilities → Budget/Economics → Planning → Execution Compiler → Execution → Sandbox/Substrate → Verification → Evidence → Learning

ACR-006 adds the non-authoritative compatibility/evidence layer. ACR-007 makes the external application delegation boundary explicit.

Neither extension creates a second execution, policy, capability, budget, verification, evidence or optimization authority.

## Strict completeness

For a pinned application, AI_EXECUTION_COMPLETE requires:

1. every declared material AI execution edge terminates in Zeck execution;
2. direct AI-provider egress is absent or provably blocked during the proof;
3. the application remains functionally usable for the declared representative corpus;
4. every delegated edge correlates to Zeck execution identity and evidence;
5. fixtures, mocks, toy responses, partial workflows and proxy-only routing cannot upgrade the status.

Do not redefine material, remove difficult edges from scope, downgrade a capability to fit the demo, or accept a model-only result for a multi-surface application.

Application/domain ownership remains outside Zeck for UI, business state, repositories, Git, ordinary database state and non-AI integrations.

## What success proves

A successful certification demonstrates that an independent developer could reasonably erase the application's direct AI-provider execution infrastructure and replace it with one Zeck integration boundary without losing the declared functionality.

It does not prove that Zeck replaces every line of the application runtime.

## Representative portfolio

### Wave 1 — clean execution/provider boundaries

1. Aider — coding assistant
2. Cline — IDE agent
3. OpenHands — software-engineering agent
4. Continue — IDE/model platform

### Wave 2 — fragmented multi-surface agents

5. Hermes-Agent — general/autonomous agent
6. OpenClaw — broad general agent
7. Browser Use — browser agent

### Wave 3 — multimodal / RAG application platforms

8. Open WebUI — general AI UI
9. AnythingLLM — RAG/knowledge application

Ordering is an integration-friction progression, not a quality ranking.

## First executable wave

After PPR-017 foundation delivery, the first three workers are:

- Worker A: PPR-018A — cross-application real runner, baseline and Demo Mirror activation harness.
- Worker B: PPR-018 — Aider Zeck-complete proof.
- Worker C: PPR-019 — Cline Zeck-complete proof.

PPR-018 and PPR-019 may begin against the approved PPR-017/ACR-007 boundary while PPR-018A builds the reusable runner. Their final certification and Demo Mirror run activation are gated on the merged PPR-018A harness.

## Per-application proof loop

1. Pin exact upstream application revision and exact Zeck integration revision.
2. Inventory every material AI execution edge.
3. Classify each edge using the ACR-006 execution-surface vocabulary.
4. Map each edge to actual Zeck capabilities; never rewrite the authoritative 22-family capability manifest to fit the application.
5. Replace provider execution with the ACR-007 public delegation boundary.
6. Remove direct AI-provider credentials from the certified application runtime.
7. Block or provably eliminate direct provider egress.
8. Replay a representative real-application corpus.
9. Correlate every delegated edge to Zeck execution/evidence.
10. Exercise duplicate, timeout, provider-failure, retry and recovery paths.
11. Compare direct and strong optimized non-Zeck baselines at comparable quality/reliability/safety/latency.
12. Measure deterministic/reuse/verified-computation opportunities rather than assuming them.
13. Measure customization and provider-portability coverage.
14. Measure engineering surface removed and features discovered through Zeck capability discovery.
15. Inspect execution telemetry and explainability.
16. Run static/runtime no-bypass inspection.
17. Run the same certified path from the website Demo Mirror.
18. Record exact evidence, limitations and unresolved edges.

## Portfolio-level measures

The program is successful only if it produces measurements for:

- cost per successfully resolved outcome;
- quality-adjusted cost;
- failure-adjusted cost;
- median and tail latency;
- provider failure/retry incidence;
- provider portability and time-to-change/add provider;
- customization coverage;
- deterministic/reuse/verified-computation rate;
- engineering surface removed from applications;
- capability-discovery events that avoided bespoke implementation;
- telemetry/explainability completeness;
- incident diagnosis and recovery time;
- reproducibility;
- developer preference after sustained exposure;
- migration effort and time-to-certification.

## Architecture-gap trigger

Escalate to the Architect when evidence shows:

- the execution surface cannot be represented by the existing governing chain;
- the public boundary forces an application to understand Zeck internals;
- a second execution/policy/capability/budget/verification/evidence/optimization authority would be required;
- provider-specific semantics would have to enter a Zeck domain module;
- frozen invariants must change;
- strict completeness could only be achieved by weakening the certification contract.

Do not escalate merely because an integration is difficult.

Provider credential, region, quota, DNS, unavailable infrastructure, licensing or commercial-plan limitations are external/operator boundaries unless they reveal a representational defect.

## Demo Mirror rule

A certified Demo Mirror entry is a projection of a bound compatibility record plus a pinned executable integration.

The demo must:
- execute the same pinned application runtime used for certification;
- show the actual application result;
- expose the Zeck execution trace;
- expose plan/route, usage, cost and latency facts when present;
- expose verification/evidence and limitations;
- show baseline facts as baselines, not as Zeck evidence;
- remain non-runnable when the bound proof is not AI_EXECUTION_COMPLETE.

The website is therefore a mirror/proof surface into Zeck's actual capability, not a synthetic showcase.

## Adoption simulation

docs/APPLICATION-COMPATIBILITY-ADOPTION-SIMULATION.md is a scenario analysis only. Its values are not market forecasts.

The simulation varies developer preference as application scale, user volume, modality count, provider count and integration maturity increase. It explicitly includes cost, performance, customization, determinism/reuse, capability discovery, telemetry, incident recovery, portability, migration effort and feature-development avoidance.

PPR-027 replaces all scenario percentages with observed evidence.

## Completion

At PPR-027 the portfolio must answer, from evidence:

1. Which applications became AI_EXECUTION_COMPLETE?
2. Which material edges remain blocked or bypassed?
3. Which gaps were implementation, public-contract, architecture or operator/provider boundaries?
4. How did successful-outcome economics change at comparable quality/reliability/safety/latency?
5. How did determinism/reuse and feature discovery change developer workload?
6. How much provider/plumbing infrastructure was removed?
7. How useful was central telemetry/evidence for diagnosis and reproduction?
8. How much customization remained available?
9. How did developer preference change with sustained use and application scale?
10. Does the observed evidence strengthen or weaken the Stripe-of-AI-execution thesis?

The portfolio result must follow the evidence, including evidence that weakens the thesis.
