# D-07 runbook — authority loss (PostgreSQL)

**Scenario:** the authoritative PostgreSQL endpoint for an environment
is lost (region loss, provider incident, corruption). Recovery
RESTORES the authority from the repository-defined logical backup; it
never reconstructs state from providers, queues or worker memory.

**Tool:** `bun run deploy:drill authority-loss --env <environment> [--out <backup.json>] [--keep-target]`

## Preconditions

- The environment's PostgreSQL admin URL is materialized:
  - `local`: `ZECK_PG_ADMIN_URL` (the drill restores into a fresh
    disposable database `zeck_drill_restore_*` on that server; the
    live source is never touched);
  - provider environments: `ZECK_DATABASE_URL` (credential-shaped,
    environment-only).
- The environment contract must be satisfied (the CLI verifies it and
  fails closed otherwise).

## The procedure (what the tool runs)

1. **Backup** the live authority through the production port:
   schema convergence check → per-table logical backup with sha256
   content checksums + the migration history (the artifact is a JSON
   file; keep it in durable storage — it IS the recovery point).
2. **Restore** into a FRESH DISPOSABLE target database: deterministic
   migrations (the DDL authority) + one-transaction data restore +
   sequences re-seeded + read-back self-verification (row counts and
   content checksums must match the backup exactly).
3. **Verify** the recovered authority with the D-07 invariant gate:
   migration history, frozen execution state vocabulary, gapless
   event ledgers, the consumed⇒applied transport boundary, the
   single-live-claim invariant, budget non-negativity, adoption-ledger
   digest shape + chain resolution, workflow wait vocabulary.
4. **Cleanup** the disposable target (unless `--keep-target`).

For a REAL loss (not a drill): restore into the replacement endpoint's
database the same way (point the tooling at the new URL), then verify
before declaring the environment recovered.

## Success criteria

- Every phase `ok: true` and `drill.recovered: true` (exit 0).
- `objectives.evaluation.rtoWithinTarget` and `rpoWithinTarget` are
  true against the environment's target in
  `deploy/manifests/recovery-targets.json`.

## Failure handling (fail-closed)

- Checksum drift / incomplete restore → the restore phase FAILS; the
  backup artifact is corrupt or partial — produce a new backup or use
  an earlier consistent backup. **Never** force-complete.
- Invariant violations → the target database is not authoritative
  state; re-run from a consistent backup. A violated gate means the
  environment is NOT recovered, whatever the provider dashboards say.
- RTO/RPO breach → the drill exits 1 with the measured numbers and
  the breach text; investigate the slow phase before claiming the
  objectives.

## Measured evidence

The drill prints its JSON report (phases, timings, RTO/RPO, objective
evaluation) — record it with the exact Git revision it was measured at
(the report carries `revision`). The local/CI evidence is produced by
the integration suite
(`tests/integration/postgres/recovery-authority-restore.test.ts`);
live provider environments are measured by executing this drill there
(NOT RUN until then — never claimed).
