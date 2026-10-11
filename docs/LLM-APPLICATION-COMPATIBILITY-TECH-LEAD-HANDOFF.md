# Zeck — Application Compatibility Program Tech Lead Handoff

**Date:** 2026-09-27
**Role:** LLM Tech Lead / Orchestrator / Reviewer / Deployment Verifier
**Repository:** payswapdotorg/Zeck
**Architecture:** v1.0 + D1.0 + E1.0 + E1.1 + ACR-006 + ACR-007
**Program:** Zeck Application Compatibility Proof Program

## Current closure directive — PPR-028 (2026-10-11)

The original application-compatibility delivery sequence PPR-018A and PPR-018 through PPR-027 is delivered as a Work Order portfolio. Before treating the portfolio as formally closed, execute the authorized post-capstone closure Work Order:

- `spec/post-release-work-orders/PPR-028.md` — canonical closure order and three-worker dispatch plan (Worker A: Aider binding; Worker B: PPR-019–026 evidence reconciliation; Worker C: PPR-027 capstone audit; Tech Lead retains final certification and state authority).
- Current global frontier: `spec/post-release-state/frontier-state.json`
- Evidence-driven architecture proposal: `docs/architecture-proposals/ZECK-COMPETITIVENESS-ROADMAP.md`

Initial audit findings that PPR-028 must reconcile against exact merged `main`:

1. `compat/aider/demo/demo-entry.json` still says NOT ACTIVATED and `apps/dashboard/pages.ts` has no Aider pinned-runtime executor registration. Do not mark PPR-018 COMPLETE/BOUND until a real, fail-closed binding and the required checks exist.
2. Evidence records PPR-022 through PPR-026 derive `AI_EXECUTION_COMPLETE`, but currently have `finalCertification.status=PENDING` even though their PRs describe merge-time bindings. Verify code, evidence and exact revisions before resolving each status.
3. PPR-021 must remain derived `PARTIAL` unless new valid evidence resolves the child-session and embeddings gaps. A formal acceptance of PARTIAL is not an `AI_EXECUTION_COMPLETE` pass.
4. PPR-027's record currently says `STUDY-COMPLETE (self-assessed)` with final certification pending. Any acceptance must explicitly preserve synthetic-supply/synthetic-price caveats, no external provider baseline, no pinned-app rerun inside the capstone, and developer preference NOT RUN.
5. Do not change statuses just to match the portfolio aggregate. If the real pinned runtime or a credentialed check cannot run, record NOT RUN/BLOCKED, owner, and next action.

PPR-028 is a bounded reconciliation order; it does not reopen the completed application sequence or authorize a new execution/capability/verification/evidence authority. PPR-016 remains operator-bound separately.

## 1. Mission

The north star is an empirical demonstration that independent applications in materially different AI categories can erase their direct AI-provider execution infrastructure and delegate their material AI execution to Zeck through one stable provider-neutral boundary, while retaining their own domain logic and UX.

This is not a marketing slogan and it is not satisfied by putting a proxy in front of a model API.

The program must determine, with real application code and real runtime evidence, whether Zeck can become the application's execution authority.

Do not redefine Zeck completeness to make a demonstration pass.

## 2. Governing authority chain

The only execution authority remains:

Tenant/Application Identity
→ Policy
→ Capabilities
→ Budget/Economics
→ Planning
→ Execution Compiler
→ Execution
→ Sandbox/Substrate
→ Verification
→ Evidence
→ Learning

ACR-006 adds a non-authoritative compatibility/evidence layer.

ACR-007 adds the stable external Application Delegation Boundary.

Neither extension creates a second execution, capability, policy, budget, verification, evidence or optimization authority.

## 3. Stable external delegation boundary

A certified application adapter may supply:

- application/environment identity;
- outcome/task;
- application-owned context or artifact references;
- application-owned constraints and quality/latency/cost requirements;
- idempotency key;
- correlation metadata.

Zeck owns the delegated execution:

- execution identity/lifecycle;
- policy admission;
- capability resolution;
- budget/economic control;
- planning;
- Execution Compiler optimization;
- provider/model/tool/agent/substrate selection;
- policy-permitted retry/escalation/continuation;
- verification/evidence;
- usage/cost/latency/provenance/telemetry.

Application-side integration is a translation boundary. It must not become a shadow provider registry, model router, retry authority, budget ledger, execution state machine, verification authority, evidence authority or optimizer.

Transport profiles may be:
- request/receipt;
- asynchronous status + webhook/event;
- progressive execution events;
- artifact references;
- the existing RealtimeRail for persistent bidirectional realtime sessions.

These are transport profiles over the same execution authority, not separate execution authorities.

## 4. Strict AI_EXECUTION_COMPLETE contract

For a pinned application, AI_EXECUTION_COMPLETE is valid only when all five conditions hold:

1. every declared material AI execution edge terminates in Zeck execution;
2. direct AI-provider egress is absent or provably blocked during the proof;
3. the application remains functionally usable for the declared representative corpus;
4. every delegated edge correlates to Zeck execution identity and evidence;
5. fixtures, mocks, simulated providers, toy responses and partial workflows cannot upgrade status.

A reverse proxy is not sufficient if the application still owns provider credentials, provider choice, provider-specific fallback or provider-specific execution semantics.

The application may retain UI, business/domain state, repositories, editor/Git operations, ordinary database state and non-AI integrations.

Completeness is about material AI execution edges, not ownership of the entire application runtime.

## 5. Architecture-gap and drift detector

For each compatibility finding, classify exactly one primary cause:

### Implementation gap
The existing Zeck architecture and public contract can represent the edge, but the required adapter/runtime/provider/tool/substrate implementation is missing.

### Public-contract gap
The architecture can represent the edge, but the application must understand Zeck internals or reproduce Zeck authority to integrate. Escalate as a public integration problem.

### Architecture-gap candidate
The execution surface cannot be represented through the governing chain without a second authority, frozen-invariant violation, provider semantics leaking into Zeck domain modules, or weakened execution/evidence semantics.

### Operator/provider boundary
Credentials, region, quota, DNS, unavailable infrastructure, licensing or commercial-plan limits prevent proof. This is not architecture evidence unless it exposes a representational defect.

This classification is the primary mechanism for detecting implementation drift versus architectural insufficiency.

## 6. First executable wave — three workers

Maximum concurrent workers: 3.

### Worker A — PPR-018A
Cross-application real runner, baseline measurement and Demo Mirror activation harness.

Owns:
- exact pinned application/runtime contract;
- credential-erasure checks;
- provider-egress deny/observation;
- corpus runner;
- Zeck trace correlation;
- direct and strong optimized non-Zeck baseline capture;
- common measurement schema;
- certified Demo Mirror runtime binding;
- no-upgrade/no-bypass negative tests.

This worker owns reusable proof infrastructure only.

### Worker B — PPR-018
Aider Zeck-complete application proof.

Owns only Aider integration and evidence.

Use Aider's existing clean model boundary/LiteLLM seam where useful. Cover every actual AI call in the pinned corpus, including auxiliary/summarization/weak-model/cache-warming paths that are actually active.

### Worker C — PPR-019
Cline Zeck-complete application proof.

Owns only Cline integration and evidence.

Use the existing @cline/llms/provider seam where useful. Cover plan/act/vision/reasoning/edit/apply/autocomplete/auxiliary model paths actually active in the pinned corpus.

### Parallelism rule

PPR-018A, PPR-018 and PPR-019 may be developed concurrently because their primary source surfaces are separated.

PPR-018 and PPR-019 consume only the approved ACR-006/ACR-007 compatibility contracts and must not duplicate PPR-018A.

Final certification and runnable Demo Mirror activation for Aider/Cline are gated on the merged PPR-018A harness.

Before dispatch:
- fetch exact current main;
- verify dependencies and ancestry;
- compare source surfaces;
- compare test/fixture ownership;
- compare provider/deployment/configuration surfaces;
- confirm no semantic reconciliation is required.

## 7. Application progression

The complete pre-authorized sequence is:

PPR-017
→ PPR-018A + PPR-018 + PPR-019
→ PPR-020 OpenHands
→ PPR-021 Continue
→ PPR-022 Hermes-Agent
→ PPR-023 OpenClaw
→ PPR-024 Browser Use
→ PPR-025 Open WebUI
→ PPR-026 AnythingLLM
→ PPR-027 longitudinal economics + developer-adoption evidence

The order moves from cleaner AI-provider boundaries toward increasingly fragmented AI execution graphs.

It is not a quality ranking.

PPR-020 starts only after both Aider and Cline certification plus the reusable runner are complete.

## 8. Per-application certification protocol

For every target:

1. pin exact upstream revision;
2. pin exact Zeck integration revision;
3. inventory the entire material AI execution graph;
4. classify every edge by the ACR-006 execution-surface vocabulary;
5. map each edge to actual Zeck capabilities;
6. preserve the authoritative 22-family capability truth;
7. replace provider execution with the ACR-007 delegation boundary;
8. remove direct provider credentials from the certified application runtime;
9. block or prove absence of direct provider egress;
10. run representative real application tasks;
11. correlate every delegated edge to Zeck executions and evidence;
12. test duplicate, timeout, provider failure, retry and recovery behavior;
13. measure quality, reliability, cost, successful-outcome latency and tail latency;
14. compare against direct and strong optimized non-Zeck baselines;
15. measure deterministic/reuse/verified-computation opportunities;
16. measure customization and provider-portability coverage;
17. measure engineering surface removed;
18. measure capability-discovery-driven avoided bespoke implementation;
19. inspect Zeck telemetry and explainability;
20. run static and runtime no-bypass checks;
21. reproduce the certified path in the Demo Mirror;
22. record exact evidence and all limitations.

## 9. Baseline methodology

Never compare an optimized Zeck path against a deliberately weak direct baseline.

At minimum maintain:
- direct application baseline;
- strong optimized non-Zeck baseline;
- Zeck path.

Compare only at comparable:
- required quality;
- reliability;
- safety;
- latency constraints;
- task success definition.

Relevant economics are economics of a successfully resolved outcome, not merely model-token cost.

Include engineering/operational burden when measurable:
- provider SDK maintenance;
- provider migration effort;
- credential management;
- retry/failure handling;
- observability;
- bespoke verification;
- bespoke caching/reuse;
- feature-specific provider plumbing.

## 10. Metrics

Every certified application should expose evidence for as many of these as applicable:

### Performance
- end-to-end successful-outcome latency;
- median latency;
- p95/p99 latency;
- provider failure/retry incidence.

### Economics
- provider cost per successful outcome;
- total execution cost;
- verification cost;
- failure-adjusted cost;
- estimated engineering/operational overhead.

### Determinism and reuse
- deterministic execution rate;
- cache/reuse rate;
- duplicate-work coalescing;
- verified-computation substitution.

### Customization
- task/context customization retained;
- model/capability constraints retained;
- tool choices retained;
- policy/budget constraints retained;
- BYOK/local endpoint support where applicable.

### Portability
- provider switch time;
- provider-add time;
- changed application code surface;
- regression count.

### Capability discovery
- capabilities adopted from Zeck;
- bespoke provider infrastructure avoided;
- feature ideas discovered through Zeck catalog;
- time-to-first-use of a discovered capability.

### Telemetry and explainability
- execution records with reconstructible plan/route/usage/cost/verification/outcome;
- percentage of governed executions reconstructible end-to-end;
- diagnosis time;
- recovery time;
- reproducibility success.

### Developer choice
- migration effort;
- sustained preference after direct vs Zeck exposure;
- stated reasons for preference;
- preference as workload volume, model count and modality count grow.

Do not convert any of these into a ranking or pre-declared winner.

## 11. Demo Mirror

The website Demo Mirror is a proof surface into the same certified application integration/runtime.

For a certified application it must provide:

application selection
→ representative task
→ real pinned runtime
→ live progress
→ application result
→ Zeck execution timeline
→ plan/route facts
→ usage/cost/latency
→ verification/evidence
→ limitations
→ direct-baseline comparison
→ reproducibility metadata

The Demo Mirror may display:
- UNASSESSED;
- PARTIAL;
- BLOCKED;
- BYPASS_DETECTED.

Only an evidence record that independently satisfies AI_EXECUTION_COMPLETE can make a demo runnable.

The demo may never:
- assert a status not derived from the compatibility evidence;
- synthesize a success;
- substitute a fixture for an external run;
- hide an omitted edge;
- use baseline facts as Zeck facts.

The website proof must execute the same pinned integration/runtime used by certification.

## 12. Portfolio targets and current GitHub-derived rationale

### Aider
Clean model/LiteLLM boundary; first candidate for a small integration.

### Cline
Clean @cline/llms/provider boundary, but terminal/browser/MCP/computer-use surfaces require careful graph classification.

### OpenHands
Good LLM abstraction; strong test of the boundary between Zeck-owned AI execution and application-owned coding workspace/runtime.

### Continue
Multiple model roles such as chat, edit/apply, autocomplete, embedding and reranking make capability granularity testable.

### Hermes-Agent
Provider registry and auxiliary call paths make it a strong test of hidden specialist/auxiliary model edges.

### OpenClaw
Generic streaming/model provider abstraction coexists with a broad provider-specific web/search/media/tool plane, making it an important fragmented-graph test.

### Browser Use
Tests whether Zeck can govern both intelligence and browser actuation, not only model selection.

### Open WebUI
Tests chat, RAG, embeddings, image generation, STT/TTS and local-vs-remote execution.

### AnythingLLM
Tests generation, retrieval, embeddings, transcription and local-vs-remote model execution.

The repository target matrix remains the starting map; every target must be re-inventoried against its pinned revision.

## 13. Future interoperability candidate — TradRL

TradRL is a future compatibility candidate for a later proof stage. It is intentionally outside the current pre-authorized PPR-018A through PPR-027 sequence.

See docs/TRADRL-ZECK-INTEGRATION-BOUNDARY.md for the approved authority split. In particular:

- TradRL remains the authority for Organization Compiler decisions, Agent Bodies/BodyVersions, logical Possessions, Agent OS semantics, Market World and trading-domain state.
- Zeck remains the authority for material AI execution realization after delegation, including capability resolution, execution optimization, provider/model/tool/agent execution-strategy selection, computational-substrate selection, retry/escalation, verification and evidence.
- TradRL's CognitiveSubstrate and Zeck's ComputationalSubstrate are separate concepts and must not be conflated.
- Capability evidence discovered by TradRL may eventually be ingested through a governed adapter into Zeck's existing capability registry; this does not authorize a second capability authority.
- Naming TradRL here does not authorize a new PPR work order.

## 13. Future successor rules

The Tech Lead may advance any dependency-complete pre-authorized PPR-018A/PPR-018/PPR-019/PPR-020…PPR-027 successor after exact merge/evidence/governance finalization.

Do not create new work orders merely because a known target is difficult.

Create/escalate a new architecture request only when the architecture-gap rules above are actually met.

If a target is blocked by credentials, region, quota, DNS or absent provider infrastructure:
- record BLOCKED or NOT-RUN;
- name the owner;
- name the next action;
- continue independent dependency-complete work.

## 14. Relationship to GAP-002 / GAP-005

PPR-016 remains an operator-bound program and is separate from the application-compatibility certification sequence.

### GAP-002
Model-family credentials and external provider rails.

Current owner action:
- OpenRouter credential available to the TL through the existing secret mechanism;
- Qwen/Model Studio access provisioned in the supported Singapore/International configuration;
- LiveKit project/API keypair available for the transport proof;
- actual realtime-model access must still be proven separately from LiveKit transport.

Never put secret values in Git, issue comments, Work Orders or chat.

### GAP-005
Staging/production environments and custom domains.

A lowest-cost proof topology may use:
- Neon Free for PostgreSQL staging;
- Cloudflare Workers Free where CPU/request limits fit;
- Cloudflare Queues/Workflows Free allowances for low-volume transport/orchestration;
- Cloudflare R2 Free for artifact bytes;
- Upstash Redis Free for non-authoritative cache/coordination;
- Cloud Run's free request/compute allowances for a governed container runner;
- Vercel Hobby only for personal/non-commercial preview, not commercial production.

The owner should create provider accounts/projects and domain/DNS control, then provide only the minimum environment credentials through the existing secret mechanism.

### Optional socket.io 4.8.4
The current autonomy level does not permit unilateral dependency promotion.

Do not make this change part of the application-compatibility wave unless it is separately authorized using the governed dependency-advance procedure.

## 15. Operator free-tier playbook

Use the following as the practical low-cost starting sequence.

### OpenRouter

Create/maintain the API key and expose it only to the TL runtime through the existing secret mechanism.

Use free models for targeted proof work. The currently documented free plan is rate-limited to 50 requests/day, so budget these calls around the decisive tests rather than spending quota on redundant probes.

Official reference:
https://openrouter.ai/pricing/

### Qwen / Alibaba Cloud Model Studio

Activate Model Studio in the Singapore region with International deployment scope.

Complete the account information required for free quota eligibility.

Enable the Free Quota Only safeguard before experiments so quota exhaustion fails closed.

Do not assume a free quota applies to every model; verify the exact model allocation in the console before running.

Official references:
https://www.alibabacloud.com/help/en/model-studio/getting-started/qwen-api-free-quota
https://www.alibabacloud.com/help/en/model-studio/developer-reference/api-key

### LiveKit

Create a managed LiveKit project with the lowest plan that supports the proof.

Provide the project URL and server/API keypair through the existing secret path.

The Build plan is hard-capped rather than automatically overage-billed, but its deployment limits must be checked against the intended environment. Transport availability does not prove a realtime voice model rail.

Official reference:
https://livekit.io/pricing/

### Staging / production

Preferred low-cost starting choices:
- Neon Free;
- Cloudflare Workers/Queues/Workflows/R2 Free allowances;
- Upstash Redis Free;
- Google Cloud Run free request/compute allowance for container execution.

Use Vercel Hobby only where the intended use is personal/non-commercial.

Official references:
https://neon.com/docs/introduction/free-tier
https://developers.cloudflare.com/workers/platform/pricing/
https://developers.cloudflare.com/queues/platform/pricing/
https://developers.cloudflare.com/r2/pricing/
https://cloud.google.com/run/pricing
https://vercel.com/docs/plans/hobby

Free-tier resources are a cost-control mechanism for proof/staging. They are not evidence of production readiness and must not become an unreviewed critical authority.

## 16. Automatic continuation

After each completed Work Order:

1. verify the actual merged main commit;
2. reconcile exact evidence;
3. finalize Work Order/program state;
4. run governance;
5. recompute dependency-complete successors;
6. update the live frontier;
7. dispatch up to three conflict-safe workers;
8. repeat.

The Tech Lead must never treat an older handoff paragraph, stale branch, or chat instruction as more authoritative than current repository state.

## 17. Final portfolio outcome

PPR-027 must answer from evidence:

1. Which applications became AI_EXECUTION_COMPLETE?
2. Which material AI edges remain blocked or bypassed?
3. Which findings were implementation, public-contract, architecture or operator/provider boundaries?
4. What happened to cost per successfully resolved outcome?
5. What happened to performance and tail latency?
6. How much deterministic/reuse execution increased?
7. How much application provider/plumbing code disappeared?
8. How much customization remained?
9. How often developers discovered reusable Zeck capabilities instead of building feature-specific infrastructure?
10. How complete and useful was Zeck execution telemetry?
11. How did diagnosis and recovery change?
12. How reproducible were executions?
13. How did developer preference change with application scale?
14. Does the evidence strengthen or weaken the Stripe-of-AI-execution thesis?

The result must follow the measurements, including evidence that weakens the thesis.

## 18. Fresh-session acceptance

A fresh Tech Lead can recover the entire program from:

- this document;
- docs/architecture-changes/ACR-006-application-execution-compatibility.md;
- docs/architecture-changes/ACR-007-universal-application-delegation-boundary.md;
- docs/APPLICATION-COMPATIBILITY-PROOF-PROGRAM.md;
- docs/APPLICATION-COMPATIBILITY-ADOPTION-SIMULATION.md;
- docs/APPLICATION-COMPATIBILITY-TARGET-MATRIX.md;
- spec/application-compatibility/program-state.json;
- spec/post-release-state/frontier-state.json;
- PPR-018A/PPR-018/PPR-019 and successor Work Orders;
- existing Tech Lead/worker governance contracts.

No conversation history is required.
