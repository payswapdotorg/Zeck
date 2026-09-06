# Zeck — Stateless AI Continuation Contract

This repository is designed to be recoverable by a fresh LLM Architect or implementation session without conversation history. Repository artifacts, Git history, and live GitHub state are authoritative.

## Canonical remote

`payswapdotorg/Zeck` is the canonical remote for Zeck product development. `pectoraux/Zeck` is historical upstream/reference only and its issues, pull requests, account permissions and infrastructure state are not authoritative for this repository.

See `docs/FORK-CANONICAL-REMOTE.md`.

## Current authoritative handoff

Read `docs/LLM-ARCHITECT-HANDOFF.md` immediately after `AGENTS.md`.

## Current continuation pointer

The UX v2 sequence is complete through **WORK-041**. The deployment/runtime roadmap is active under approved **Deployment & Runtime Architecture D1.0**.

**D-00 complete. D-01 complete through WORK-042. D-02 complete through WORK-043. D-03 complete through WORK-044. D-04 complete through WORK-045. D-05 complete through WORK-046 / PR #10. D-06 is authorized and in-flight through WORK-047 / Issue #11.**

Current frontier: `eligible=[]`, `inFlight=["WORK-047"]`, `blocked=[]`.

## Authoritative deployment sequence

`D-00 → D-01 → D-02 → D-03 → D-04 → D-05 → D-06 → D-07 → D-08`

No deployment phase may be skipped, reordered or inferred from chat. Each phase becomes executable only through an approved repository Work Order with explicit surfaces, dependencies, acceptance criteria and evidence requirements.

## Deployment authority

- `docs/DEPLOYMENT-ARCHITECTURE.md` — authoritative Deployment & Runtime Architecture D1.0.
- `docs/DEPLOYMENT-ROADMAP.md` — authoritative deployment sequence.
- `docs/architecture-changes/ACR-002-deployment-runtime-architecture.md` — D1.0 approval record.
- `spec/work-orders/WORK-047.md` — authoritative current implementation scope.
- GitHub Issue #11 — canonical WORK-047 dispatch record on this remote.

The reference topology is Vercel for experience/delivery, Neon PostgreSQL for authoritative relational state, Cloudflare R2 for artifact bytes, Cloudflare Queues for transport, Cloudflare Workflows for durable orchestration, and Upstash Redis for non-authoritative coordination/cache.

## D-01 completion

- Work Order: `WORK-042`
- Canonical issue: #1
- PR: #2
- Merge commit: `b75e23bacf9a9ace76e88e643ea2a272f588a0f`
- Worker final head: `c61392260024244db7bab723e9f018d7c582a9e8`
- Post-merge governance state: finalized

## D-02 completion

- Work Order: `WORK-043`
- Canonical issue: #3
- PR: #4
- Implementation head: `0a99e6c65a21742672dc4e6ce4fbe5dd8e5db5cc`
- Final implementation-branch head: `84e6ef9cf32f514537bfdfbf59c0a84968d488d0`
- Merge commit: `2175bc6c73ad0a8d4b5ab2efb6a8930cfdb01b17`
- Provider-specific live Neon/R2 verification: NOT RUN in worker environment due unavailable provider credentials; protocol and real-PostgreSQL evidence retained.
- Post-merge governance state: finalized

## D-03 completion

- Work Order: `WORK-044`
- Canonical issue: #5
- Required branch: `work/WORK-044-asynchronous-execution-transport`
- Dependency: `WORK-043`
- Status: COMPLETE
- Exact dispatch base: `44eaceca4de2af7d531fd1b9bad5a14b14d3b69e`
- Corrected implementation head: `785605777ab590577cd8df8173cdb1ab64866116`
- PR: #6
- Merge commit: `985ca850faaa620cf3df05675f7af74e2073f188`
- Live Cloudflare successful round-trip: NOT RUN due unavailable provider credentials; fail-closed provider reachability evidence retained.
- Post-merge governance state: finalized and governance check passing on main.

## D-04 completion

- Work Order: `WORK-045`
- Canonical issue: #7
- Required branch: `work/WORK-045-durable-orchestration`
- Dependency: `WORK-044`
- Status: COMPLETE
- Exact dispatch base: `6cfbd936475a457886a174adeb457faf9b974ce9`
- Implementation head: `b8a9536d662e9195c3044304fb61829360856048`
- PR: #8
- Merge commit: `0067c72c8179a6f880f5477789958370376b8de9`
- Full regression at exact implementation head: 330 files / 4573 tests, 4562 passed, 11 skipped, 0 failed, twice consecutively.
- Governance and deployment validation: PASS at exact implementation head; Issue #7 closed as completed.
- Live Cloudflare Workflows successful round-trip: NOT RUN due unavailable provider credentials; documented real-HTTP protocol and invalid-token 401 reachability/classification evidence retained.
- Post-merge program/frontier state: finalized.

## D-05 completion

- Work Order: `WORK-046`
- Canonical issue: #9
- Required branch: `work/WORK-046-execution-worker-deployment-fabric`
- Dependency: `WORK-045`
- Assurance: HIGH_ASSURANCE
- Status: COMPLETE
- Exact dispatch base: `e6b417fd5c9dfaf6fb00135a62d529cc9ccc6db9`
- Corrected final implementation head: `d5e7a25a51aba4d4664348209bfb6393c7dc15d0`
- PR: #10
- Merge commit: `5d26365ee9b8e55f41b923328443ae746205757a`
- Architect blocking finding corrected in Revision 1: external container runner identity is now execution/sandbox scoped and deterministic; distinct identical executions cannot collapse while same-run replay converges.
- Exact corrected-head verification: governance/deployment checks PASS; full PostgreSQL-backed suite passed twice consecutively at the final head; live container-runner and Cloudflare success remained NOT RUN where credentials were unavailable and were not claimed as PASS.
- Post-merge program/frontier state: finalized.

## D-06 dispatch

- Work Order: `WORK-047`
- Canonical issue: #11
- Required branch: `work/WORK-047-production-delivery-observability-release-control`
- Dependency: `WORK-046`
- Assurance: HIGH_ASSURANCE
- Status: AUTHORIZED / IN-FLIGHT
- Exact authorization base: `5d26365ee9b8e55f41b923328443ae746205757a`

D-06 is limited to production delivery, observability and release control: exact commit/deployment identity, environment promotion gates, migration gating, health/smoke gates, bounded telemetry, error monitoring, rollback controls and cost/quota alerts. D-07 and unrelated product/runtime work remain forbidden.

## Recovery sequence

1. Read `AGENTS.md`.
2. Read this file.
3. Read `docs/LLM-ARCHITECT-HANDOFF.md`.
4. Read `README.md` and `IMPLEMENTATION.md`.
5. Read `spec/worker-runbook.md` and `docs/ARCHITECT-RUNBOOK.md`.
6. Read `spec/architecture.md` and `spec/architecture-lock.md`.
7. Read all files under `spec/development-state/`.
8. Read `spec/requirement-traceability.md`, relevant ADRs, `docs/DEPLOYMENT-ARCHITECTURE.md`, `docs/DEPLOYMENT-ROADMAP.md`, ACR-002, and `docs/FORK-CANONICAL-REMOTE.md`.
9. Inspect complete Work Orders and live GitHub refs on `payswapdotorg/Zeck`.
10. Run `python3 scripts/governance-check.py` before changing state or implementation.

## Non-negotiables

- One Work Order = one implementation branch = one PR.
- Implementers do not merge their own PRs.
- Workers do not modify `spec/development-state/*` during active implementation.
- Frozen architecture v1.0 cannot be silently rewritten.
- Deployment Architecture D1.0 is subordinate to frozen v1.0.
- Providers implement ports and operational concerns; they do not become Zeck domain authorities.
- Secrets remain secret-mediated and never enter Git, logs, artifacts or public domain state.
- Evidence is valid only for the exact revision on which it was produced.
- Governance-state changes are Architect-owned and minimal.

## Fresh-session invariant

A fresh LLM Architect must recover current Zeck state from this repository and live GitHub state, never from conversation history or provider dashboards.
