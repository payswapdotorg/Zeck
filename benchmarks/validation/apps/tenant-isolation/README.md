# Tenant-Isolation Application (VAL-024)

A customer-style isolation application: one pinned isolation-probe
corpus row per run, submitted through Zeck's public SDK boundary,
exercising cross-tenant access control over the REAL platform path —
a tenant submitting work that references another tenant's executions,
artifacts, environments or tool surfaces gets the platform's typed
scope violation (`TENANT_SCOPE_VIOLATION` per the execution store's
locked-row checks), never data, never effects; cross-APPLICATION
contamination (one application's fixture state, evidence or ledger
rows leaking into another's) is verified absent mechanically through
row-count invariants on both applications' durable rows.

## The pinned corpus (`tenant-isolation.probe.v1`)

| Row | Probe family | Expected service boundary | Expected wire boundary | Terminal |
|---|---|---|---|---|
| cross-tenant-application-create | cross-tenant:create-application | TENANT_SCOPE_VIOLATION ("application belongs to a different tenant") | — | COMPLETED |
| cross-tenant-environment-create | cross-tenant:create-environment | TENANT_SCOPE_VIOLATION ("environment does not belong to the target application") | 403 TENANT_SCOPE_VIOLATION (the same typed violation, public) | COMPLETED |
| cross-tenant-read | cross-tenant:read | scope-checked miss (zero rows, never data) | 404 CAPABILITY_UNAVAILABLE (indistinguishable from missing) | COMPLETED |
| cross-tenant-transition | cross-tenant:transition | TENANT_SCOPE_VIOLATION (locked-row miss + tenant mismatch) | 404 (the scope-checked miss precedes the command) | COMPLETED |
| cross-tenant-artifact-fetch | cross-tenant:artifact-fetch | scope-checked miss (events + verification, zero rows) | 404 (result package, events, verification — never delivered) | COMPLETED |
| cross-tenant-step-event | cross-tenant:step-event | TENANT_SCOPE_VIOLATION (journal write rejected) | — | COMPLETED |
| cross-tenant-planning-decision | cross-tenant:planning-decision | TENANT_SCOPE_VIOLATION (decision rejected) | — | COMPLETED |
| cross-application-state-probe | cross-application:state-probe | scope-checked miss (forward AND reverse reads) + row-count invariants | 404 | COMPLETED |
| forged-application-scope | cross-tenant:forged-scope | — | 403 AUTHORIZATION_DENIED (the header never authorizes; the scope is derived server-side) | COMPLETED |
| control-tenant-healthy | control:healthy | own-scope data admitted (legitimate access never blocked) | — | COMPLETED |

No live-gated rows: the system under test is the platform's OWN row
scoping (every store query bound by application + tenant), which
needs no provider, no credential and no external rail — the scope
checks are pre-dispatch.

## The probe battery

Per row, the application (the tenant) first performs its own
customer-side access attempts through the public SDK — reading,
cancelling and fetching another tenant's execution; creating work that
references another tenant's application and environment; constructing
a forged-scope client — asserting each typed rejection and scanning
each surfaced boundary for foreign content (planted synthetic
canaries). The carrier submission then rides the standard customer
flow while the platform driver runs the full battery over the REAL
executions service (the locked-row checks) and the REAL public API,
journaling each probe outcome exactly once through the platform's own
`agent-action-recorded` step-event vocabulary.

## Mechanical verification

- probe assertions on the TYPED error codes (never status-only, never
  message-only);
- the foreign-content evidence scan — no planted canary appears in any
  probe outcome, criterion evidence or durable ledger row;
- row-count invariants per application before and after the battery:
  the foreign application's durable rows are identical (zero foreign
  effects) and the own application's delta equals exactly the driver's
  accounted journal writes (an unaccounted write is a mechanical
  isolation failure);
- the isolation journal records each denied probe exactly once
  (ledger-verified).

## Boundaries

- Integrates ONLY through the public SDK (the validation harness + the
  public clients) — never Zeck internals; never selects
  provider/model/rail (and the probes need no provider: the scope
  checks are pre-dispatch).
- The foreign-world content markers are SYNTHETIC canaries — never real
  tenant data; evidence carries marker LABELS and DIGESTS, never the
  material.
- Usage is honestly "none" (no provider contact); per-probe latency is
  measured, never estimated.
