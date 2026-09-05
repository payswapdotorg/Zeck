# Platform

`src/platform/` owns the shared infrastructure contracts of the modular
monolith: configuration, database, coordination (Redis), object storage,
clock, crypto and the secret store.

Rules (frozen architecture v1.0 / `IMPLEMENTATION.md`):

- Ports (provider-neutral interfaces) are the durable contracts; adapters
  arrive with the Work Orders that own the corresponding authority surface.
  Landed adapters: the node crypto adapter (`crypto/node-crypto.ts`), the
  pg `DatabasePort` adapter with deterministic startup/migrations and
  backup/restore (`db/pg-database-port.ts`, `db/startup.ts`, `db/backup.ts`
  — WORK-043/D-02, managed-PostgreSQL-neutral), the S3-compatible
  (R2) `ObjectStorePort` adapter with SigV4 signing, integrity and
  retention safety (`object-store/` — WORK-043/D-02), and the
  environment-materialization secret store
  (`secret-store/adapters/env-secret-store.ts`). Provider SDK/driver
  imports stay confined to their owning adapter directory (the
  provider-SDK boundary table in `tests/architecture/`).
- `src/platform/**` must never import `src/modules/**`, `src/integrations/**`
  or `src/api/**` — enforced by `tests/architecture/`.
- Domain and application code never imports platform contracts directly; they
  depend on their own module ports, and module adapters bridge to the
  platform (`IMPLEMENTATION.md` §3).
