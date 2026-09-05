# Zeck — LLM Architect Handoff

**Purpose:** Durable, repository-resident handoff for a fresh LLM Architect. Conversation history is never authoritative.

## Current state

- Repository: `pectoraux/Zeck`
- Core architecture: **v1.0**, frozen after approval.
- UX v2 implementation wave: **complete through WORK-041**.
- Last UX Work Order: **WORK-041 — UX integration hardening, usability and release gate**.
- PR: **#74**, merged.
- Merge commit: `153b5f1c4de6180e5e56c421f5fdfcea7b855cf2`.
- Issue #73: closed as completed.
- Previous UX frontier: `eligible=[]`, `inFlight=[]`, `blocked=[]`.
- No UX successor Work Order is authorized by this handoff.

## New authoritative architecture stream

The next engineering concern is deployment/runtime infrastructure, not a new customer feature wave.

- Architecture Change Record: `docs/architecture-changes/ACR-002-deployment-runtime-architecture.md`
- Deployment Architecture: `docs/DEPLOYMENT-ARCHITECTURE.md`
- Deployment Roadmap: `docs/DEPLOYMENT-ROADMAP.md`
- Deployment architecture version: **D1.0**
- D1.0 is subordinate to core architecture v1.0 and does not rewrite the frozen core.
- The repository is the only source of truth for deployment design and implementation sequencing.

The reference low-cost topology is Vercel for experience/preview delivery, Neon PostgreSQL for durable authority, Cloudflare R2 for object bytes, Cloudflare Queues for transport, Cloudflare Workflows for durable orchestration, and Upstash Redis for non-authoritative coordination, with external identity/email and provider-neutral execution adapters. Commercial production must use commercially permitted plans; Vercel Hobby is not the commercial production tier.

## W041 identity and ancestry

- Dispatch pin: `017e44f41eab9ce7a458843d39a38c895ba79800`
- Binding exact base: `bcc46ee402da33ca478d7cb860352c28b97b1080`
- Worker final head: `3fbb9db212376275ca50858a296234c25d15d46d`
- PR #74 merge commit: `153b5f1c4de6180e5e56c421f5fdfcea7b855cf2`

The ancestry nuance is intentional. `017e44f…` is the final W041 dispatch-state commit; its parent `bcc46ee…` is the Work Order's binding base. Architect-owned documentation commits after dispatch are not worker implementation history and must not be rewritten away.

## W041 acceptance record

W041 stayed within its declared dashboard/evidence surfaces. PR #74 had exactly six changed files. The worker evidence reported 421/421 driven-browser checks, zero script-level console/page errors, responsive desktop/tablet/mobile coverage, accessibility and authorization/error regressions, performance evidence, and two consecutive full-suite passes of 284 files / 4179 tests at the exact final head `3fbb9db`.

The Architect verified the PR base/head, merge-base, changed-file inventory, CI, and boundary constraints before merging. W041 was then finalized in `spec/development-state/program-state.json` with the actual PR and merge commit, and the frontier was re-derived to empty.

## Deployment architecture rule

Deployment work must not silently alter `spec/architecture.md` v1.0 or `spec/architecture-lock.md`. Material changes to the frozen architecture require the existing architecture-versioning/change protocol.

The deployment architecture is deliberately provider-neutral. Vendor products are implementation choices behind explicit ports. PostgreSQL remains authority; R2 contains durable bytes while metadata remains in PostgreSQL; queues/workflows orchestrate but do not own execution truth; Redis is ephemeral coordination only.

## Fresh-session recovery order

1. Read `AGENTS.md`.
2. Read `AI_CONTINUATION.md`.
3. Read this file.
4. Read `README.md` and `IMPLEMENTATION.md`.
5. Read `spec/worker-runbook.md` and `docs/ARCHITECT-RUNBOOK.md`.
6. Read `spec/architecture.md` and `spec/architecture-lock.md`.
7. Read all files under `spec/development-state/`.
8. Read `spec/requirement-traceability.md` and relevant ADRs.
9. Read `docs/architecture-changes/ACR-002-deployment-runtime-architecture.md`, `docs/DEPLOYMENT-ARCHITECTURE.md`, and `docs/DEPLOYMENT-ROADMAP.md`.
10. Inspect live GitHub refs, PRs, issues, checks, and exact ancestry.
11. Run `python3 scripts/governance-check.py` before changing state or implementation.

## Repository truth hierarchy

1. Actual Git refs and commit ancestry.
2. Repository-resident development-state JSON.
3. Frozen architecture and architecture lock.
4. Approved architecture-change records and current Deployment Architecture.
5. Active/approved Work Orders and Deployment Roadmap.
6. Exact-revision CI/test/browser/deployment evidence.
7. Other repository documentation.
8. Conversation history — never authoritative.

## Completion boundary

W041 is complete and remains the final completed UX v2 Work Order. A deployment work stream may now proceed under D1.0, but deployment implementation still requires explicit repository Work Orders. Do not invent implementation tasks from chat.

## Fresh-session invariant

A fresh LLM Architect must be able to recover Zeck from these repository artifacts and live GitHub state without any prior conversation transcript.
