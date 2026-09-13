# VAL-024 — Tenant Isolation Application

The tenant-isolation validation application: a customer-style
application exercising **cross-tenant access control over the REAL
platform path** — a tenant submitting work that references another
tenant's executions, artifacts, environments or application surfaces
gets the platform's typed scope violation (`TENANT_SCOPE_VIOLATION`
per the execution store's locked-row checks, `AUTHORIZATION_DENIED`
per the scope resolver's membership boundary, or the 404
scope-checked miss that is indistinguishable from missing), **never
data, never effects**. Cross-APPLICATION contamination (one
application's fixture state, evidence or ledger rows leaking into
another's) is verified absent mechanically — the REAL PostgreSQL
row-scoping (every store query bound by application + tenant) is the
system under test.

## Boundary and configuration

- Rides the **public SDK boundary** (`sdk/` execution-centric client;
  no internal Zeck imports — import-scanned by the VAL-002 suite).
- `config.json` is the repository-reproducible, **secret-free**
  configuration (task slice mirrored from the exported
  `TENANT_ISOLATION_TASKS`; consistency unit-tested). The application
  id, base URL and token are run-time bound by the served world.
- The corpus rows declare **target ROLES** (`foreign-execution`,
  `foreign-environment`, `foreign-application`,
  `foreign-artifact-digest`, `own-execution`,
  `own-artifact-digest`), never run-time ids — the served world
  resolves the roles into the actual seeded references.

## The corpus (10 rows — all offline, no provider needed)

| Row | Family | Target role | Platform probes | App (SDK) probe | Expected typed rejection |
|---|---|---|---|---|---|
| cross-tenant-read | cross-tenant-read | foreign-execution | svc-read-foreign-execution | sdk-read-foreign-execution | SCOPE_CHECKED_MISS (null / 404 indistinguishable) |
| cross-tenant-transition | cross-tenant-transition | foreign-execution | svc-transition-foreign-execution | sdk-cancel-foreign-execution | TENANT_SCOPE_VIOLATION (locked-row) / 404 on the wire |
| cross-tenant-planning | cross-tenant-planning | foreign-execution | svc-planning-foreign-execution | — (operator surface) | TENANT_SCOPE_VIOLATION (locked-row) |
| cross-tenant-artifact-fetch | cross-tenant-artifact-fetch | foreign-artifact-digest | svc-artifact-fetch-foreign | — | TENANT_SCOPE_VIOLATION (tenant namespace) |
| cross-tenant-artifact-adoption | cross-tenant-artifact-adoption | foreign-artifact-digest | svc-artifact-adopt-foreign-parent | — | TENANT_SCOPE_VIOLATION (adoption boundary) |
| cross-application-state | cross-application-state | foreign-execution | svc-events-foreign-execution | sdk-events-foreign-execution | SCOPE_CHECKED_MISS (zero rows / 404) |
| cross-tenant-create | cross-tenant-create | foreign-application | svc-create-foreign-application | sdk-create-foreign-application | TENANT_SCOPE_VIOLATION (service) / AUTHORIZATION_DENIED (wire) |
| cross-tenant-environment | cross-tenant-environment | foreign-environment | svc-create-foreign-environment | sdk-create-foreign-environment | TENANT_SCOPE_VIOLATION (both paths) |
| forged-scope-header | forged-scope-header | foreign-application | svc-resolve-forged-scope | sdk-forged-scope-read | AUTHORIZATION_DENIED (membership boundary) |
| own-tenant-control | own-tenant-control | own-execution | svc-read-own-execution, svc-artifact-fetch-own | sdk-read-own-execution | granted (the over-denial control) |

**The honesty inversion:** a correctly-denied boundary **COMPLETES**
the probe execution (the denial IS the verified outcome); a probe
that receives foreign data, foreign rows or a foreign effect is a
**disclosure** — the run FAILS honestly and the app never passes it.

## Safety, evidence and economics constraints

- Zero data disclosure: the other tenant's canary content (labels +
  markers, never secrets) must never appear in any observed rejection
  message, response text or evidence record; findings name **labels
  only** (the redaction policy).
- The isolation journal records each driven probe **exactly once**
  (the `agent-action-recorded` step-event vocabulary; per-probe
  distinct idempotency keys — the VAL-018 lesson).
- Payload **digests** in evidence, never payload bytes (target
  digests and granted-data digests only).
- Latency is measured per probe; this slice dispatches no model (the
  scope checks are pre-dispatch) — usage is recorded honestly as
  `none-reported`.
- Forbidden outcomes: any foreign row, foreign effect, foreign marker
  in evidence, over-denial of the own-tenant control, or an
  unexpected success on a cross-tenant probe.

## Boundaries

- No provider credentials are needed or used by this application.
- The REAL PostgreSQL crown (`tests/integration/validation/val-024-tenant-isolation.test.ts`)
  is the live verification — gated on `ZECK_PG_TEST_URL` (honest NOT
  RUN boundary when absent; workers never receive the operator's PG
  server). The Lead's credentialed re-run drives the full battery.
