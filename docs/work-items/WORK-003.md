# WORK-003 Evidence — Connections, BYOK and provider federation

Work Order: `spec/work-orders/WORK-003.md` (GitHub issue #5)
Assurance: `HIGH_ASSURANCE` · Architecture: `v1.0` (frozen)
Branch: `work/WORK-003-connections-federation` · Base: `8d9b9936fe79f1ab972137c0f1732c729461a41b`
Implementation revision (this file binds, round 2): `d8f40cd7c00b16a7c83b6381bd87373ec899e962`

> Round-1 binding `36ea0dd9129a4b8079de3eef6b8988c9bc87fb91` is SUPERSEDED by the
> round-2 remediation (architect review on PR #6 — transport failures
> escaping the gateway). Round-1 verification output below is retained as
> the historical record; the current verification of record is the round-2
> table.

## Requirement mapping

| Requirement | Acceptance criterion | Implementation | Proof |
|---|---|---|---|
| CON-001 | 1. Provider-neutral Connection and ModelProvider ports, no provider SDK types in public contracts | `src/modules/connections/domain+ports+application`, `src/modules/models/domain+ports`; rails appear only as slugs in `connections/domain/rails.ts` (the sanctioned vocabulary); adapters never cross the public barrels | `tests/architecture/provider-neutrality.test.ts`, `tests/discrimination/provider-isolation.discrimination.test.ts` |
| CON-002 | 3. BYOK persisted as a secret reference; never return or log plaintext | `connections.credentials` vault (AES-256-GCM envelope, AAD-bound to the row reference); `CredentialVault` port (plaintext write-only inward, materialization only post-admission); public records strip `credentialRef` via `toPublicConnection` | `tests/unit/crypto/crypto.test.ts`, `tests/integration/postgres/connections-persistence.test.ts` (ciphertext-at-rest + ledger/outcome material-free), `tests/discrimination/byok-secret-boundary.discrimination.test.ts` |
| CON-003 | 2. OpenRouter as one upstream rail | `src/modules/models/adapters/openrouter.ts` — aggregation rail behind the neutral `ModelProvider`; bearer auth, native `json_schema` structured output, SSE streaming with terminal usage, rail-reported USD cost, full error-category mapping | `tests/unit/models/openrouter-normalization.test.ts`, `tests/integration/postgres/model-dispatch.test.ts` (vault → gateway → bearer header → journal) |
| CON-004 | 2/4. Direct provider adapter coexisting with the aggregation rail | `src/modules/models/adapters/anthropic.ts` — direct rail with materially different wire discipline (`x-api-key` + version header, forced-tool structured output, split streaming usage, typed `error.type` taxonomy); one gateway serves both rails keyed by the connection's durable rail slug | `tests/unit/models/anthropic-normalization.test.ts`, `tests/unit/models/model-gateway.test.ts` (coexistence), `tests/integration/postgres/model-dispatch.test.ts` (both rails end-to-end) |
| CON-005 | 4/5. Normalized usage/streaming/structured output/provider errors; provider failure vs quality failure as distinct durable outcomes | Neutral `NormalizedUsage` / `StreamEvent` / `NormalizedStructuredOutput` / `ProviderFailure` contracts; canonical mapping always `PROVIDER_ERROR`; `models.dispatch_attempts` CHECK constrains `outcome->>'outcomeClass'` to `('provider-success','provider-failure')` — quality/verification classes are physically unrepresentable | `tests/unit/models/provider-vs-quality.test.ts`, `tests/integration/postgres/dispatch-journal.test.ts` (CHECK rejections incl. `verification-failed`), `tests/discrimination/provider-quality-distinction.discrimination.test.ts` |

## Implementation

Surfaces (declared): `src/modules/connections/` (domain/rails + connection aggregate, ports, connection service, SQL store + encrypted vault + idempotency arbitration, public barrel), `src/modules/models/` (neutral request/response/stream/failure/outcome domain, ModelProvider + HttpTransport + DispatchAdmission + DispatchJournal ports, model gateway + rail registry, OpenRouter + Anthropic + fetch-transport + SSE + SQL-journal adapters, public barrel), `src/platform/crypto/` (node-crypto adapter, AES-256-GCM envelope cipher).

Surfaces (directly required, disclosed): `src/platform/db/migrations/0002_connections_providers.sql` — durable connections/vault/journal state is impossible without schema; migrations are the frozen mechanism (`IMPLEMENTATION.md` §1) and WORK-002 set the precedent (its migration lived under the same platform home). `tests/**` per the "directly-required tests" allowance. `spec/development-state/*.json` per the worker protocol (in-flight transition + checkpoint outcomes — WORK-002 precedent). `tests/integration/postgres/migration-runner.test.ts` was made state-independent (its assertions hardcoded a one-migration era; WORK-003 ships migration 2) — same repair class as the WORK-002-era governance fixtures.

Key mechanics:
- **Policy-before-dispatch by construction**: `createModelGateway` REQUIRES a `DispatchAdmission` port; the module ships NO default/allow-all implementation (proven statically). Sequence: scope → connection facts (tenant-guarded read) → admission → rail resolution → durable intent → credential materialization → adapter call → observation. The exact order is asserted dynamically (`tests/discrimination/policy-before-dispatch.discrimination.test.ts`, `tests/unit/models/model-gateway.test.ts`).
- **Secrets-last**: BYOK plaintext exists only inside the adapter invocation scope; materialized immediately pre-dispatch; never persisted, journaled or returned (PG suite walks ledger outcomes + raw rows for material markers).
- **Provider fabric underneath Execution**: the public `complete/stream` surface addresses a *connection* (the caller's own policy-gated resource); the rail is derived from durable state. No provider selection appears in any public contract; provider identifiers/rail slugs are confined to the sanctioned vocabulary + adapters (static gate, discriminated).
- **Idempotent mutations**: register/updateStatus/rotate/remove arbitrate over `platform.idempotency_records` (application-scoped keys) with the WORK-002 transactional contract; state-derived decisions (status, rotation, removal) run under `SELECT ... FOR UPDATE` per connection (WORK-002 lock discipline).
- **Durable-then-observe dispatch**: `models.dispatch_attempts` rows are written BEFORE transport (`recordIntent`) and resolved after observation; a crash leaves honest `dispatching` evidence of an unknown external outcome; late resolution converges.
- **No SDKs at all**: both rails speak JSON/SSE over the neutral `HttpTransport` port (production: global `fetch` adapter); runtime dependencies remain `[]` (frozen install unchanged).

## Design decisions (architect-review pointers)

1. **Connections permission = `applications:write`/`applications:read`.** The frozen `PERMISSIONS` vocabulary lives in `auth` (outside this Work Order's surfaces). Connections are application-scoped resources administered by app owners/admins; dedicated `connections:*` permissions are an auth-surface change for a future Work Order.
2. **Migration 0002 under `src/platform/db/migrations/`** — directly required by acceptance criterion 3 (persist BYOK) and the mandated real-PostgreSQL schema verification; disclosed here for explicit review.
3. **Dispatch journal is evidence, not authority** — append-only observations that cannot drive execution state (`/executions` owns that, WORK-006); the `request_hash` column carries one-way provenance without payload retention.
4. **`CredentialMaterializer` crosses the connections public barrel** as a structural pick of the vault port — dispatch needs post-admission materialization; plaintext remains typed to the port contract that documents its admissibility (`IMPLEMENTATION.md` §9).
5. **Platform-credential connections are registrable but dispatch against them requires a rail adapter composed with a platform credential**; with none composed, dispatch fails closed as `authentication` provider failure (no silent fallback).
6. **Quality/verification outcomes have no code path into the fabric** — the journal CHECK plus the taxonomy mapping make conflation unrepresentable; `VERIFICATION_*` remains owned by the future `/verification` authority.
7. **Anthropic structured output rides a forced single tool** (that rail's native mechanism) — extracted into the same neutral `NormalizedStructuredOutput`; schema *conformance validation* is deliberately NOT done here (verification concern, `spec/architecture.md` §18).

## Verification (round 1 — at implementation head `36ea0dd9129a4b8079de3eef6b8988c9bc87fb91`; superseded by round 2)

Toolchain: Bun 1.3.4 (CI-pinned), real PostgreSQL 16.4 at 127.0.0.1:55432 (`ZECK_PG_TEST_URL`).

| Command | Result |
|---|---|
| `bun install --frozen-lockfile` | clean, no changes (runtime deps `[]` unchanged) |
| `python3 scripts/governance-check.py` | `Governance OK: 20 Work Orders, 45 requirements, frontier=[]` |
| `bun run typecheck` | 0 errors (212 files) |
| `bun run lint` | 0 errors, 0 warnings (212 files) |
| `bun run test` (full, twice consecutively) | **261/261 passed, 38 files** — includes real-PG suites |

Test census ( deltas vs WORK-002's 156): unit 74→113 (crypto 10, connections 11, models: openrouter 13, anthropic 8, gateway 6, provider-vs-quality 5), integration PG 30→51 (connections-persistence 7, connections-isolation 3, dispatch-journal 6, model-dispatch 5 end-to-end), architecture 67→71 (provider-neutrality 4), discrimination 10→15+16 assertions (provider-isolation 5, byok-secret-boundary 4, policy-before-dispatch 3, connections-tenant-isolation 3, provider-quality-distinction 5).

## Remediation (round 2 — architect review on PR #6)

**Finding (blocking)**: known network/timeout failures escaped the gateway as exceptions instead of becoming durable provider-failure outcomes — `postJson()` threw the `ProviderFailure` produced by `transportFailure()`, neither direct adapter caught it, `ModelGateway.complete()` had no catch, and in `stream()` a `transport.send()` rejection escaped the async generator without a normalized `stream-error` or a durable observation. The already-recorded attempt remained `dispatching` indefinitely despite a KNOWN provider-side classification.

**Required flow restored** (both dispatch modes):

```text
transport failure -> provider-failure normalization -> DispatchJournal.recordOutcome(...)
```

**Fix** (implementation head `d8f40cd7c00b16a7c83b6381bd87373ec899e962`):

1. **Shared adapter boundary** (`src/modules/models/adapters/http.ts`): `postJson()` no longer throws transport failures — it returns a discriminated result whose failure is RAIL-STAMPED at the boundary (the adapter supplies its rail; the round-1 latent gap of `rail: ""` never reaching a stamp is closed). Coverage: send rejections, timeouts (`TimeoutError`/`AbortError` names, as produced by `AbortSignal.timeout`) AND mid-body read failures. New `sendForStream()` normalizes the streaming handshake the same way; new `guardedBody()` types mid-stream body rejections so adapters convert them into terminal events.
2. **Adapters** (`openrouter.ts`, `anthropic.ts`): one-shot paths map boundary failures to `provider-failure` OUTCOMES (the call resolves — never escapes); streaming paths terminate with normalized `stream-error` events carrying the same failure taxonomy; the error-status body read is guarded too. Unknown rejections still propagate unchanged.
3. **Gateway** (`model-gateway.ts`) defense-in-depth: a contract-violating adapter whose normalized `ProviderFailure` escapes as a THROW still gets a durable `provider-failed` record — one-shot surfaces the canonical `PROVIDER_ERROR` after journaling; streaming synthesizes the normalized terminal `stream-error` and records in the terminal-event path. UNKNOWN crashes (not structurally a `ProviderFailure`) rethrow and honestly remain `dispatching` — exactly the crash/unknown-vs-known distinction in the architect's finding and the journal contract.
4. **Domain**: `isProviderFailure()` structural guard (exported via the domain barrel) identifies normalized failures among unknown thrown values without widening the public surface.

**Red → green record** (the new discrimination suite run against the round-1 code, then the fix):

- RED at `36ea0dd` (`git checkout 36ea0dd -- src/modules/models`, tests of round 2 unchanged): `transport-failure-durability.discrimination.test.ts` **0/6 — every test T1–T6 failed** exactly as the finding describes (gateway rejection, no durable outcome, attempt stuck `dispatching`); `model-gateway.test.ts` defense-in-depth cases 2/8 failed. The passing 10 (incl. "adapter-normalized provider-failure outcome is journaled") confirm the defect class precisely: RETURNED outcomes were always durable; ESCAPING transport failures were not.
- GREEN at `d8f40cd`: 18/18 across both files; full gate below.

## Verification (round 2 — at implementation head `d8f40cd7c00b16a7c83b6381bd87373ec899e962`; current)

Toolchain: Bun 1.3.4 (CI-pinned), real PostgreSQL 16.4 at 127.0.0.1:55432 (`ZECK_PG_TEST_URL`).

| Command | Result |
|---|---|
| `bun install --frozen-lockfile` | clean, no changes (runtime deps `[]` unchanged) |
| `python3 scripts/governance-check.py` | `Governance OK: 20 Work Orders, 45 requirements, frontier=[]` |
| `bun run typecheck` | 0 errors (213 files) |
| `bun run lint` | 0 errors, 0 warnings (213 files) |
| `bun run test` (full, twice consecutively) | **286/286 passed, 39 files** — includes 54 real-PG tests |

Test census (delta vs round 1's 261): unit 113→129 (openrouter +5, anthropic +5, gateway +6 transport/durability cases), discrimination 15→21 (`transport-failure-durability` 6: T1/T2 real-fabric one-shot through BOTH adapters + gateway; T3 timeout-vs-network classification; T4 provider axis never verification/quality + status leaves `dispatching`; T5 streaming terminal event + durable record, escape mutation fails; T6 known-durable vs unknown-stays-dispatching), real-PG 51→54 (model-dispatch 5→8: network rejection, timeout rejection on the direct rail, streaming rejection — each asserting the durable `provider-failed` row, `resolved_at`, `outcomeClass='provider-failure'`, category, and material-free payloads against real PostgreSQL).

## Checkpoint evidence

- `IMPLEMENTATION-COMPLETENESS` — all 5 acceptance criteria mapped (table above); evidence-recorded in `spec/development-state/checkpoint-state.json`.
- `IDENTITY-IDEMPOTENCY` — replay / key-reuse / concurrent convergence / crash-atomicity over real PG (`tests/integration/postgres/connections-persistence.test.ts`); service-level idempotency incl. material-digest fingerprints (`tests/unit/connections/connection-service.test.ts`).
- `CONCURRENCY-CRASH-SAFETY` — concurrent identical registrations converge to one durable identity (one connection, one vault row); mid-work failure rolls back ledger+connection+vault atomically; journal intent/outcome crash semantics (`dispatch-journal.test.ts`: `dispatching` stays honest; late resolution converges; exactly-once resolution fails closed).
- `SELF-HOSTING-BOUNDARY` — frozen install unchanged (no new packages); governance green; provider neutrality statically gated; the suite runs entirely on the shipped toolchain.

## Discrimination evidence (HIGH_ASSURANCE boundaries named by this Work Order)

Every named boundary has a mutation proof that a weakened protection is rejected:

| Boundary | Mutation proven rejected |
|---|---|
| Provider isolation (lock 2) | provider SDK import outside its adapter area → `provider-sdk-outside-adapter`; provider identifier in a neutral contract source → neutrality scanner; rail slug outside vocabulary/adapters → scanner; `fetch(` outside the transport adapter → scanner (`tests/discrimination/provider-isolation.discrimination.test.ts`) |
| BYOK secret boundary (lock 9) | `ConnectionRecord` mutated with a plaintext/ciphertext field → redaction scan fails; every durable outcome walked for material markers; materialization-before-admission → order proof fails (`byok-secret-boundary.discrimination.test.ts`) |
| Policy before dispatch (lock 3) | denying gate: zero materialization, zero transport, `POLICY_DENIED`, journaled denial; allow path asserts admission < intent < materialize < transport; no default-allow admission exists (`policy-before-dispatch.discrimination.test.ts`) |
| Tenant authority | foreign-tenant connection mutations rejected with ZERO downstream writes (journaled store proof); lists never surface foreign rows; no-membership callers denied pre-write (`connections-tenant-isolation.discrimination.test.ts`; PG schema proof: composite FK makes cross-tenant rows unrepresentable in `connections-isolation.test.ts`) |
| Provider ≠ quality (CON-005) | broken mapper emitting `VERIFICATION_FAILED` fails the never-verification property; quality outcome classes rejected on the provider axis (TS mirror + real-PG CHECK); response shape mutated with a quality field fails the exact-shape guard (`provider-quality-distinction.discrimination.test.ts`, `dispatch-journal.test.ts`) |
| Transport-failure durability (PR #6 remediation) | pre-remediation escape (boundary throws, gateway has no catch) fails every T1–T6 assertion — rejection instead of outcome, `dispatching` instead of `provider-failed`, no outcome class; streaming escape mutation yields a rejection with NO normalized terminal event and no durable record; classification-collapse (`timeout`→`network`) mutation fails; axis-conflation mutation (`network`→`VERIFICATION_INCONCLUSIVE`) fails; a gateway that durably recorded UNKNOWN crashes as provider-failed would fail the T6 honesty assertions (`transport-failure-durability.discrimination.test.ts`, red→green recorded in the Remediation section) |

## Known limitations

1. **CI has no PostgreSQL service** (carried over from WORK-002, flagged there): the 54 real-PG tests skip with an explicit reason in CI; local verification output above is the recorded proof. Governance-owned follow-up.
2. **Tool-call, multimodal and async-job normalization** (architecture §12 fabric duties) are not yet represented in the neutral contracts — no current Work Order requires them; they belong to the fabric Work Order that first needs them (executions/tools).
3. **Stream schema-conformance validation** of structured-output fragments is a verification concern (`/verification`, WORK-013); adapters normalize transport only.
4. **Dispatch retries are not provider-idempotent by contract**: each `complete()` is a fresh journaled attempt; execution-level idempotency/create-or-converge over external effects belongs to the executions/external-effects Work Orders (`IMPLEMENTATION.md` §14).
5. **Master key management** is composition-root concern (32-byte key injected into the vault); rotation of master keys (key_version column reserved) is future ops work.
6. Pre-existing main defect (found at pickup, repaired incidentally by the protocol-required in-flight transition): commit `3e107f6` set WORK-003's program-state status to `"eligible"`, a value outside the checker's `pending|complete` vocabulary, so `governance-check.py` FAILED on main at `8d9b993` until this branch's in-flight transition restored consistency. Disclosed for the architect; the checker itself (governance-owned) was not modified.

## PR / merge

- PR: see completion report (worker opens; architect merges).
- **Round-2 binding (current)**: this evidence file binds the implementation head `d8f40cd7c00b16a7c83b6381bd87373ec899e962`. The final branch head (this evidence commit) cannot contain its own SHA and is bound in the PR body + remediation comment (two-part binding, WORK-001/WORK-002 protocol). Round-1 bindings (`36ea0dd` implementation / `666d014` final) are superseded by the remediation.
- `program-state.json` becomes `complete` only at post-merge finalization with the actual PR number + merge commit.
