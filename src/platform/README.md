# Platform

`src/platform/` owns the shared infrastructure contracts of the modular
monolith: configuration, database, coordination (Redis), object storage,
clock, crypto and the secret store.

Rules (frozen architecture v1.0 / `IMPLEMENTATION.md`):

- This directory contains **ports** (provider-neutral interfaces) only for
  now. Adapters are introduced by the Work Orders that own the corresponding
  durable authority (for example the database adapter lands with the first
  Work Order that owns durable schema).
- `src/platform/**` must never import `src/modules/**`, `src/integrations/**`
  or `src/api/**` — enforced by `tests/architecture/`.
- Domain and application code never imports platform contracts directly; they
  depend on their own module ports, and module adapters bridge to the
  platform (`IMPLEMENTATION.md` §3).
