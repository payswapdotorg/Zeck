# WORK-047 Evidence — Production delivery, observability and release control

Work Order: `WORK-047` (Issue #11 — the canonical dispatch; the work-order file lives on `main` at the current authorized revision) · Canonical remote: **`payswapdotorg/Zeck`** · Assurance: **HIGH_ASSURANCE** · Governing architecture: Deployment & Runtime Architecture **D1.0** (subordinate to frozen v1.0), roadmap phase **D-06**.

## Governance catalog synchronization

Architect governance catalog synchronization: `main` now contains the D-06 checkpoint contracts required by WORK-047. This evidence refresh exists solely to synchronize the PR merge ref with that repaired canonical catalog; it does not change implementation semantics or `spec/development-state/*`.

Exact dispatch base: `5d26365ee9b8e55f41b923328443ae746205757a` (the D-05 merge; verified present; the required branch `work/WORK-047-production-delivery-observability-release-control` was created at exactly that SHA). Branch carries the D-06 implementation commit `a82f4fda632f8c6da6f8abc7354be3edc24fbb42` + this evidence document; **zero merge commits; zero `spec/` changes** (mechanically verified below). One PR (#12), opened by the worker, **not merged by the worker**.

## Baseline gate at the exact dispatch base (readiness checkpoint — BEFORE implementation)

Executed in a pristine copy of the repository checked out at exactly `5d26365`:

- **`python3 scripts/governance-check.py` PASSED** — `Governance OK: 46 Work Orders, 102 requirements, inFlight=['WORK-046'], frontier=[]`.
- `bun run typecheck` — 0 errors.
- `bun run lint` — biome clean, exit 0.
- Full suite with real PostgreSQL 16.4 (`ZECK_PG_TEST_URL`, 127.0.0.1:55432): **340 files / 4659 tests** — two runs, each with exactly ONE transient failure of the disclosed load-sensitive class (run 1: one integration flake; run 2: `connection-pool bounds hold under parallel load`, which **passes 8/8 in isolation** at the same base). **Inherited, environmental, non-deterministic — present at the base BEFORE any D-06 change** (the same class the D-05 evidence disclosed as "load-sensitive pool flake"). The D-06 final head itself ran fully green twice consecutively (below) — the head is not the source of this flake.

## Provider account/resource access (readiness checkpoint)

**NOT RUN — no Cloudflare/Vercel/Neon (or other provider) credential, no OTLP collector host, and no deployed observability backend exists in this worker environment.** The only credential held is the operator-provided GitHub PAT for `payswapdotorg/Zeck` (environment-only; used solely for the Git/PR lifecycle of this Work Order).

Consequences, per the evidence contract (never convert unavailable provider access into a PASS):

- **Live OTLP export to a deployed collector: NOT RUN.** The exporter is verified against the **documented** OTLP/HTTP-JSON protocol (resourceSpans/resourceMetrics/resourceLogs, hex ids, nanosecond timestamps, severity numbers) over **real HTTP against an in-process protocol-verifying collector** (`tests/integration/observability/otlp-export.test.ts`): the three endpoints, the payload shapes, 202/200 acceptance, 401-as-permanent, 500-as-transient-with-bounded-retry, unreachable-endpoint transport classification, the bearer header, and the secret-rejection-before-the-wire proof (the collector NEVER receives secret material). Protocol correctness — explicitly NOT a deployed-backend claim.
- **Live provider-environment promotion (preview/staging/production): NOT RUN** (no provider credentials). The promotion machinery is proven over real PostgreSQL with the real governed store (the ledger suites) and the real CLI (the local-environment drills + the release-cli suite); the CI workflow drives the same repository tools. Provider-environment promotion happens from the operator environments with their own credentials and ledgers — never claimed as exercised here.
- **Provider quota consoles: not queried** (no credential) — the quota guards read the AUTHORITATIVE stores only (compute_plane, queue_transport, executions, release_control, pg_database_size), documented as the honest boundary.
- The release-control machinery is executed against the **real local environment** (the converged `zeck_local` database, 28/28 migrations): `record` (exact-revision identity, idempotent), `gate run validation/identity-audit` (real tool-run evidence), `gate attach` (external evidence), `promote --to local` (journal + pointer), `promote --to ci` refusal (the enforcement proof), `inspect`, `status`, `alerts`, and the rollback refusal semantics.
- No provider resource in any non-GitHub account was mutated by this worker.

## What this order IS

D-06: production delivery, observability and release control — the release ledger in PostgreSQL (the only authority), the promotion ladder gated by repository-defined evidence (validation, migration, health, smoke, CI conclusions and the Architect approval), exact commit/deployment identity, migration gating with downgrade-hazard detection, bounded secret-free OTLP-compatible telemetry with stable correlation identity, actionable cost/quota alerting with a promotion guardrail, deployment-state-only rollback, and the GitHub-to-provider CI/CD path as a MECHANISM over repository tools (the self-hosting boundary). No D-07 DR/provider-exit scope, no authority migration into CI/CD/observability/providers, no frozen-architecture change.

## Acceptance-criteria mapping (Work Order §Acceptance Criteria)

| AC | Claim | Evidence |
|---|---|---|
| 1. Every production deployment maps to one exact Git commit and environment | PASS (real PG) | The content-addressed release identity (40-hex CHECK-bound; the store rejects non-exact revisions — unit, integration and discrimination suites); the immutable per-environment deployment binding carrying the D-01 deployment identity (idempotent record; identity-mismatch is a typed refusal); the CLI drill: `record` → the exact revision + the deterministic identity |
| 2. Promotion gated by required validation, migration, health and smoke evidence for the target environment | PASS (real PG) | The per-phase entry gates (release-policy.json, cross-checked against environments.json fail-closed); the store-level enforcement (missing gates ⇒ typed refusal EVEN WITH a journal entry; no journal ⇒ refusal even with all gates — the bypass does not exist); the migration gate's three failure modes + ledger digest; the health gate requiring readiness "ready"; the smoke gates through the shared attestation; the CI enforcement-proof step |
| 3. Failed releases can be rolled back without changing durable Zeck domain state | PASS (real PG) | The governed rollback: append-only event + pointer flip in ONE transaction; the store's SQL addresses release_control EXCLUSIVELY; the domain-isolation proofs: EVERY row of EVERY other schema is identical before/after a real rollback; rollback to the active release and rollback without an active deployment are unrepresentable |
| 4. Operational telemetry reconstructs an execution/deployment chain end-to-end using stable correlation identifiers while redacting secrets | PASS (real PG) | The end-to-end correlation suite: the dispatch correlation key → claim → disposition chain shares ONE deterministic trace id derived from the execution id; the OTLP/HTTP-JSON export over real HTTP with the protocol shapes; secret-shaped keys rejected + credential values redacted BEFORE the wire |
| 5. Critical provider/resource quota exhaustion and deployment/runtime failures have actionable alert thresholds before material availability degradation | PASS (real PG) | The quota-guard suite over the REAL stores: warnings at 80% BEFORE exhaustion, criticals at 95%; every alert actionable; the D-05 hard cap retained; operational counters read from authoritative tables; the promotion guardrail refuses on critical alerts |
| 6. Preview/staging/production secrets and mutable state cannot cross environment boundaries | PASS | Per-environment ledgers and environment-scoped secret resolution; discrimination proof: preview-scoped reference offered to staging/production fails closed |
| 7. Release controls are deterministic, bounded and auditable | PASS (real PG) | Deterministic release/identity derivations; append-only evidence with attempt ordinals; bounded CHECK constraints; promotion/rollback/refusal journal; `inspect`/`status` operator surfaces |

## Required checkpoints

- **RELEASE-IDENTITY**
- **PROMOTION-GATES**
- **MIGRATION-SAFETY**
- **OBSERVABILITY-BOUNDARY**
- **ROLLBACK-SAFETY**
- **COST-QUOTA-GUARDS**
- **SELF-HOSTING-BOUNDARY**
- **IMPLEMENTATION-COMPLETENESS**

## Test battery and implementation evidence

The worker's implementation evidence remains the previously recorded exact-head D-06 battery: bounded observability and redaction tests; release policy/identity tests; real-PG release ledger, migration gate, quota guard and environment-isolation tests; end-to-end correlation; OTLP protocol tests; CLI subprocess tests; architecture boundaries and discrimination mutations. The prior evidence package records **354 files / 4771 tests — 4758 passed, 13 skipped, 0 failed**, twice consecutively, with provider-gated live integrations explicitly NOT RUN.

This refresh changes only this evidence document to synchronize the PR with the repaired Architect governance catalog; it does not alter implementation code, architecture authority, or development state.
