# Zeck — Final Application Compatibility Tech Lead Handoff

**Date:** 2026-09-26
**Role:** LLM Tech Lead / Orchestrator / Reviewer / Deployment Verifier
**Repository:** payswapdotorg/Zeck
**Authority:** Architect-approved ACR-006 + this pre-authorized program

## Purpose

This is the final zero-context handoff for the Application Compatibility Proof Program.

The Tech Lead does **not** need to return to the Architect for routine successor Work Order authorization.

The Architect has pre-authorized the complete sequence PPR-017 through PPR-027. The Tech Lead may advance the next dependency-complete Work Order in the program state without asking for a new authorization message.

The Architect remains the authority for:
- architecture changes;
- acceptance of architecture-gap escalations;
- merge approval;
- exceptional governance/security decisions.

## Canonical artifacts

- `docs/architecture-changes/ACR-006-application-execution-compatibility.md`
- `docs/APPLICATION-COMPATIBILITY-PROOF-PROGRAM.md`
- `docs/APPLICATION-COMPATIBILITY-ADOPTION-SIMULATION.md`
- `spec/application-compatibility/program-state.json`
- `spec/post-release-state/frontier-state.json`
- `spec/post-release-work-orders/PPR-017.md` through `PPR-027.md`

## North star

Demonstrate with real open-source applications that:

> an independent application can remove its direct AI-execution/provider infrastructure and continue operating with Zeck as its AI execution authority through one stable provider-neutral boundary, while retaining its domain logic and UX.

This is an empirical engineering property, not a slogan.

Do not redefine Zeck completeness to make a target application pass.

## Strict completeness contract

`AI_EXECUTION_COMPLETE` is valid only when:

1. every declared material AI execution edge of the pinned application is delegated through Zeck;
2. direct AI-provider egress is absent or provably blocked during the proof;
3. the application remains functionally usable for the declared representative corpus;
4. every delegated AI edge correlates to Zeck execution identity and evidence;
5. fixtures, mocks, simulated providers and partial application workflows never upgrade status.

An application may retain its own:
- UI;
- business/domain state;
- repository/editor/Git operations;
- ordinary database state;
- non-AI integrations;
- domain workflow authority.

A retained operation becomes a Zeck-completeness issue only when it contains or causes a material AI execution edge that bypasses Zeck.

## Application progression

The full pre-authorized sequence is:

PPR-017 → compatibility foundation
PPR-018 → Aider
PPR-019 → Cline
PPR-020 → OpenHands
PPR-021 → Continue
PPR-022 → Hermes-Agent
PPR-023 → OpenClaw
PPR-024 → Browser Use
PPR-025 → Open WebUI
PPR-026 → AnythingLLM
PPR-027 → cross-application longitudinal economics + adoption evidence

The progression deliberately moves from clean model/provider seams toward fragmented multi-surface AI execution graphs.

This is not a quality ranking.

## Parallelism

Current wave:
- Worker 1: PPR-017
- Worker 2: PPR-018
- Worker 3: PPR-019

Maximum: 3 workers.

Before dispatching each wave, perform live conflict analysis over:
- source/module surfaces;
- dependencies;
- migrations;
- public contracts;
- tests/fixtures;
- provider/deployment files;
- architecture/governance files.

When a successor becomes dependency-complete, the Tech Lead may promote it into the executable frontier because the complete program is already Architect-authorized.

Do not create extra Work Orders to continue this program unless a genuine architecture-gap or out-of-program implementation requirement is discovered.

## Per-application proof loop

For every application:

1. pin exact upstream and integration revisions;
2. inventory every material AI execution edge;
3. classify each edge by execution surface;
4. replace provider execution with the Zeck public boundary;
5. remove direct AI-provider credentials from the certified runtime;
6. block direct AI-provider egress;
7. run representative application tasks;
8. correlate every delegated edge to Zeck execution/evidence;
9. execute duplicate, timeout, provider-failure and retry tests;
10. compare direct and strong optimized non-Zeck baselines;
11. measure deterministic/reuse/verified-computation opportunities;
12. test application customization;
13. inspect Zeck telemetry and explainability;
14. run static/runtime no-bypass inspection;
15. expose the same proof through the Demo Mirror;
16. record exact evidence and limitations.

## Demo Mirror rules

A Demo Mirror is a proof surface into the same certified integration.

It must show:
- pinned application revision;
- representative task;
- live progress;
- application result;
- Zeck execution timeline;
- execution representation;
- route/provider/model/substrate facts when available;
- usage/cost/latency;
- verification/evidence;
- warnings and limitations;
- baseline comparison when available;
- reproducibility metadata.

The Demo Mirror must never manufacture or upgrade certification status.

## Architecture-gap decision rule

Do not ask the Architect merely because an application is difficult.

Ask only when evidence shows one of the following:

- the execution surface cannot be represented by the existing execution chain;
- satisfying the application requires a second execution/policy/capability/budget/verification/evidence/optimization authority;
- a frozen invariant must change;
- provider semantics would have to leak into Zeck domain modules;
- the public integration boundary requires Zeck internals;
- strict completeness would have to be weakened to pass.

Provider credential, region, quota, DNS, unavailable infrastructure or commercial-plan limitations are not architecture gaps.

## Economics and adoption evidence

The earlier 72% simulated preference is not a claim.

PPR-027 replaces it with measured evidence.

Use:
- cost per successfully resolved outcome;
- quality-adjusted and failure-adjusted cost;
- latency and tail latency;
- portability/provider-change effort;
- customization coverage;
- deterministic/reuse rate;
- engineering surface removed;
- feature-discovery-driven avoided implementation;
- telemetry coverage;
- incident diagnosis/recovery time;
- reproducibility;
- developer/user preference after sustained exposure.

Do not choose a winning stack in advance. Report observed distributions and uncertainty.

## Automatic continuation rule

After a Work Order completes:

1. verify exact merged main;
2. finalize its evidence and program state;
3. run governance;
4. compute the dependency-complete successors from `spec/application-compatibility/program-state.json`;
5. activate the next dependency-complete Work Order(s) in `spec/post-release-state/frontier-state.json`;
6. dispatch up to three conflict-safe workers;
7. repeat.

No Architect re-authorization is required for PPR-017 through PPR-027 because this entire sequence is already pre-authorized.

If a successor is provider-blocked, record BLOCKED/NOT-RUN with owner and move to any independent dependency-complete successor. Do not stall the entire program unnecessarily.

## Relationship to PPR-016 / operator frontier

PPR-016 remains separate and operator-bound.

Known operator gaps:
- GAP-002 — model-family credentials/provider access;
- GAP-005 — staging/production environments and custom domains;
- optional socket.io/socket.io-client 4.8.4 governed dependency advance.

The application compatibility program may proceed on capabilities that are already available without waiting for those gaps, while recording any dependency that genuinely blocks a target application's proof.

## Final program outcome

At PPR-027, produce a portfolio-level evidence package answering:

1. Which representative applications became AI_EXECUTION_COMPLETE?
2. Which material execution edges still remain blocked?
3. Which failures were implementation gaps versus architecture gaps versus operator/provider limits?
4. Did Zeck reduce successful-outcome cost at comparable quality/reliability/safety/latency?
5. Did Zeck improve deterministic/reuse execution over repeated workloads?
6. Did applications remove meaningful provider/plumbing infrastructure?
7. Did central telemetry and evidence improve diagnosis and reproducibility?
8. Did capability discovery eliminate bespoke feature implementation?
9. Did developer preference change as applications scaled?
10. Does the evidence support or weaken the Stripe-of-AI-execution thesis?

The answer must follow evidence. Do not protect the thesis.

## Operator access playbook

The owner can unblock the program immediately by supplying or provisioning only the minimum required access, without putting secrets in Git:

### GAP-002 — model-family access

**OpenRouter**
- Provide an `OPENROUTER_API_KEY` to the Tech Lead execution environment through the existing secret mechanism.
- Prefer the free model collection for low-cost proof work where its quality satisfies the corpus.
- OpenRouter currently lists a free tier with free-model/API access but a 50-request/day rate limit, so use it for targeted validation rather than assuming unlimited capacity. 

**Qwen / Alibaba Cloud Model Studio**
- Activate Model Studio in the Singapore region and create/use the general-purpose API key already supported by the existing adapter.
- Complete account information.
- Enable the platform's Free Quota Only safeguard before experiments so exhausted quota fails closed rather than converting unexpectedly to paid usage.
- New-user free quota is currently limited to eligible Singapore/International models and is valid for 90 days; exact model-specific allocations must be checked in the console before each live run.

**LiveKit**
- For realtime transport, supply the managed project's URL and the server/API keypair through the existing secret path.
- Use the free Build plan for the proof phase where its hard caps are sufficient; LiveKit's current documentation says Build-plan usage is hard-capped rather than automatically overage-billed.

### GAP-005 — staging/production and custom domain

Start with the lowest-cost environment that preserves the required semantics.

- Neon Free for staging/early proof databases.
- Cloudflare Workers Free where workload limits fit.
- Cloudflare Queues Free allowance for low-volume async transport.
- Upstash Redis Free for non-authoritative coordination/cache.
- Vercel Hobby only for personal/non-commercial preview; it must not be treated as the commercial production platform.

The owner should create the provider accounts/projects, then hand the Tech Lead only the minimum environment credentials/connection material through the existing secret mechanism. The Tech Lead should record provider names, resource identifiers and limits, never secret values.

### Optional socket.io 4.8.4

Do not hand-edit this dependency casually.

The owner does not need to do anything unless the next eligibility review authorizes it. If authorized, the Tech Lead should run the same governed dependency-advance pattern used by PPR-012, including exact lockfile diff, full battery and regression proof.

## Provider-cost posture

Free-tier-first remains the default for development and proof work.

Commercial production is a separate question: upgrade or move providers when terms, reliability, security, support or throughput require it. Never use a free-tier contractual boundary as evidence of production readiness.

## Fresh-session acceptance

A fresh Tech Lead can execute this entire program from this document plus the canonical artifacts above, without chat history.

The first executable wave is PPR-017/PPR-018/PPR-019.
The final pre-authorized successor is PPR-027.
